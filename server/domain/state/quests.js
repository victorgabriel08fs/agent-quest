// @ts-check
// Tickets (quests), etapas, bugs e compactação (modelo de eventos, seções 4 e 6;
// ADR 0008; T8 do plano).
//
// - Ticket: começa no pedido do usuário e termina em `done` (Stop sem tarefa em
//   segundo plano), `failed` (StopFailure) ou `interrupted` (novo pedido,
//   `idle_prompt`, SessionEnd). Stop com tarefa em segundo plano ativa deixa o
//   ticket em `waiting_background`. Atividade sem ticket aberto cria um ticket
//   implícito. Fato com `promptId` de ticket encerrado não reabre o ticket.
// - Etapa: `active` quando um agente do papel começa no ticket; `done` quando
//   termina o último agente do papel em execução; uma nova delegação reativa.
// - Bugs: o `testResult` dos fatos de ferramenta (T6) decide `bugs.open` e
//   `bugsCrushed`.
// - Compactação: PreCompact deixa a atividade em "compactando"; PostCompact,
//   ou o SessionStart com `source: compact` quando o PostCompact não chegou,
//   emite `context.compacted`, uma vez por compactação.
//
// Este módulo muda o modelo em memória e emite pelos `emit` recebidos; não
// importa o index.js.
//
// Adiantado antes do G0b (plano, T8): o que depende de veredito do T0 fica nas
// funções da seção "Itens a confirmar no T0", com o item V no comentário:
// `questKeyOf` (V8), `isSystemPrompt` (V7), `hasActiveBackgroundTasks` (V13) e
// `turnEndedWithoutStop` (V12).

/**
 * @typedef {import('../../../shared/contract.js').QuestState} QuestState
 * @typedef {import('../../../shared/contract.js').QuestStatus} QuestStatus
 * @typedef {import('../../../shared/contract.js').Phase} Phase
 * @typedef {import('../../../shared/contract.js').PhaseId} PhaseId
 * @typedef {import('../../../shared/contract.js').RoleId} RoleId
 * @typedef {import('../../../shared/contract.js').TestRun} TestRun
 * @typedef {import('../../../shared/contract.js').EventKind} EventKind
 * @typedef {import('../normalize.js').Fact} Fact
 * @typedef {import('../normalize.js').BackgroundTask} BackgroundTask
 * @typedef {import('../normalize.js').TestResult} TestResult
 */

/**
 * Emite um evento canônico da sessão (index.js numera e guarda no feed).
 * @typedef {(agentKey: string|null, kind: EventKind, data: Record<string, unknown>, ts: number) => void} Emit
 */

/** Título do ticket implícito criado por atividade sem ticket aberto (seção 6). */
export const IMPLICIT_TITLE = 'Tarefa em andamento';

/** Título do ticket implícito aberto por um retorno do sistema sem ticket para reabrir (seção 6). */
export const SYSTEM_RETURN_TITLE = 'Retorno de tarefa em segundo plano';

/** Um pedido do sistema reabre o último ticket encerrado há menos disto (seção 6). */
export const REOPEN_WINDOW_MS = 30 * 60 * 1000;

/** Tamanho do título do primeiro ticket no rótulo da sessão (seção 7). */
export const LABEL_TITLE_CHARS = 48;

/**
 * Prazo do ticket em fechamento (A-T8-1, seção 6, "Stop atrasado"), pela hora
 * de chegada: um Stop atrasado do turno anterior que chegue nesse prazo fecha o
 * ticket como `done` (ou `failed`); senão, ele termina `interrupted`.
 */
export const CLOSING_GRACE_MS = 2000;

/** Ids de tickets encerrados lembrados por sessão (seção 8, regra 5). */
export const MAX_CLOSED_QUESTS = 200;

/** Papel do time → etapa (seção 6, "Etapa"). */
export const PHASE_BY_ROLE = Object.freeze(/** @type {Partial<Record<RoleId, PhaseId>>} */ ({
  arq: 'design',
  dev: 'code',
  tes: 'test',
  doc: 'docs',
}));

/**
 * Status de uma tarefa de `background_tasks` que já terminou. Qualquer outro,
 * inclusive desconhecido, conta como ativa (V13).
 */
const FINISHED_TASK_STATUS = new Set(['completed', 'complete', 'done', 'failed', 'error', 'killed', 'cancelled', 'canceled', 'stopped']);

/**
 * Ticket em memória: os campos do contrato (QuestState) mais o interno
 * `counted` (já contou em `questsDone`).
 * @typedef {object} Quest
 * @property {string} id
 * @property {number} n
 * @property {string} title
 * @property {boolean} implicit
 * @property {QuestStatus} status
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {Record<PhaseId, Phase>} phases
 * @property {number} actions
 * @property {string|null} error
 * @property {boolean} counted
 */

/**
 * O que este módulo usa da sessão.
 * @typedef {object} QuestTable
 * @property {Quest|null} quest           atual ou último
 * @property {number} questCount
 * @property {number} questsDone
 * @property {Set<string>} closedQuests   ids de tickets encerrados
 * @property {string|null} firstQuestTitle
 * @property {{ open: number, lastRun: TestRun|null }} bugs
 * @property {number} bugsCrushed
 * @property {Compaction|null} compaction
 * @property {Closing|null} closing      ticket anterior em fechamento (A-T8-1)
 */

/**
 * Ticket que um pedido novo do usuário deixou em fechamento (A-T8-1).
 * @typedef {object} Closing
 * @property {Quest} quest
 * @property {number} ts                  `ts` do pedido novo: o fim do ticket se ele terminar `interrupted`
 * @property {number} until               hora de chegada (relógio do servidor) em que o prazo vence
 */

/**
 * Compactação em curso ou a última anunciada.
 * @typedef {object} Compaction
 * @property {string|null} trigger
 * @property {boolean} pending            PreCompact visto, ainda sem anúncio
 * @property {number|null} emittedAt      ts do sinal que emitiu `context.compacted`
 */

// ---------------------------------------------------------------------------
// Itens a confirmar no T0 (G0b)
// ---------------------------------------------------------------------------

/**
 * V8: chave do ticket. `prompt_id` presente nos eventos (inclusive dos
 * subagentes) e diferente a cada pedido. Se o V8 for refutado, os tickets
 * passam a ser delimitados só por tempo, e muda esta função.
 * @param {Fact} fact
 * @returns {string|null}
 */
export function questKeyOf(fact) {
  return fact.promptId ?? null;
}

/**
 * V8: o pedido já tem ticket (o atual ou um encerrado): é o mesmo pedido de
 * novo (duplicata) ou um atraso, e não abre outro ticket (seção 8, regra 5).
 * Depende de o `prompt_id` ser diferente a cada pedido.
 * @param {QuestTable} table
 * @param {Fact} fact
 * @returns {boolean}
 */
export function isKnownPrompt(table, fact) {
  const key = questKeyOf(fact);
  return key !== null && (table.quest?.id === key || table.closing?.quest.id === key || table.closedQuests.has(key));
}

/**
 * V7: pedido de origem do sistema (retorno de subagente em segundo plano,
 * tarefa agendada). O normalizador decide pela marca no começo do pedido;
 * `origin: null` (pedido que não é texto) conta como do usuário (seção 2).
 * @param {import('../normalize.js').PromptFact} fact
 * @returns {boolean}
 */
export function isSystemPrompt(fact) {
  return fact.origin === 'system';
}

/**
 * V13: alguma tarefa de `background_tasks` do Stop ainda está ativa? Só um
 * status de fim conhecido conta como encerrada; status ausente ou desconhecido
 * conta como ativa.
 * @param {readonly BackgroundTask[]} tasks
 * @returns {boolean}
 */
export function hasActiveBackgroundTasks(tasks) {
  return tasks.some((task) => !FINISHED_TASK_STATUS.has(String(task.status ?? '').toLowerCase()));
}

/**
 * V12: o turno acabou sem Stop (o Claude Code não dispara Stop no Esc). O sinal
 * é chegar um novo pedido do usuário, ou o `idle_prompt`, com o ticket ainda
 * aberto (não em `waiting_background`, que já teve o Stop dele). Um sinal com
 * `ts` anterior ao começo do ticket é atraso de antes dele e não conta.
 * @param {Quest|null} quest
 * @param {number} ts                    ts do sinal
 * @returns {boolean}
 */
export function turnEndedWithoutStop(quest, ts) {
  return quest !== null && quest.status === 'open' && ts >= quest.startedAt;
}

/**
 * A-T8-1 (seção 6, "Stop atrasado"): Stop ou StopFailure com `ts` anterior ao
 * início do ticket aberto é do turno anterior, que chegou depois do pedido
 * seguinte por corrida entre processos. A mesma comparação de `ts` do
 * `turnEndedWithoutStop`.
 * @param {Quest|null} quest             o ticket atual
 * @param {number} ts                    ts do Stop
 * @returns {boolean}
 */
export function isLateStop(quest, ts) {
  return quest !== null && isQuestOpen(quest) && ts < quest.startedAt;
}

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

/**
 * Ticket ainda não encerrado (aberto ou esperando o segundo plano)?
 * @param {Quest|null} quest
 * @returns {boolean}
 */
export function isQuestOpen(quest) {
  return quest !== null && (quest.status === 'open' || quest.status === 'waiting_background');
}

/**
 * O ticket atual, se ainda não encerrado; senão null.
 * @param {QuestTable} table
 * @returns {Quest|null}
 */
function openQuestOf(table) {
  return isQuestOpen(table.quest) ? table.quest : null;
}

/**
 * Abre um ticket e emite `quest.started`.
 * @param {QuestTable} table
 * @param {{ id: string|null, title: string|null, implicit: boolean, ts: number }} start
 * @param {Emit} emit
 * @returns {Quest}
 */
export function startQuest(table, { id, title, implicit, ts }, emit) {
  const n = ++table.questCount;
  /** @type {Quest} */
  const quest = {
    id: id ?? `ticket-${n}`,
    n,
    title: title ?? '',
    implicit,
    status: 'open',
    startedAt: ts,
    endedAt: null,
    phases: { design: 'pending', code: 'pending', test: 'pending', docs: 'pending' },
    actions: 0,
    error: null,
    counted: false,
  };
  table.quest = quest;
  table.closedQuests.delete(quest.id);
  if (!implicit && table.firstQuestTitle === null && quest.title !== '') table.firstQuestTitle = quest.title;
  emit('main', 'quest.started', { questId: quest.id, n, title: quest.title, implicit }, ts);
  return quest;
}

/**
 * Encerra o ticket aberto (se houver) e emite `quest.finished`. `done` conta em
 * `questsDone`, uma vez por ticket.
 * @param {QuestTable} table
 * @param {'done'|'failed'|'interrupted'} outcome
 * @param {number} ts
 * @param {Emit} emit
 * @param {string|null} [error]
 * @returns {boolean}                   true se havia ticket aberto
 */
export function finishQuest(table, outcome, ts, emit, error = null) {
  const quest = openQuestOf(table);
  if (!quest) return false;
  closeQuest(table, quest, outcome, ts, emit, error);
  return true;
}

/**
 * Encerra um ticket (o atual ou o que está em fechamento) e emite
 * `quest.finished`.
 * @param {QuestTable} table
 * @param {Quest} quest
 * @param {'done'|'failed'|'interrupted'} outcome
 * @param {number} ts
 * @param {Emit} emit
 * @param {string|null} error
 */
function closeQuest(table, quest, outcome, ts, emit, error) {
  quest.status = outcome;
  quest.endedAt = Math.max(ts, quest.startedAt);
  quest.error = outcome === 'failed' ? error : null;
  table.closedQuests.add(quest.id);
  if (table.closedQuests.size > MAX_CLOSED_QUESTS) {
    const oldest = table.closedQuests.values().next().value;
    if (oldest !== undefined) table.closedQuests.delete(oldest);
  }
  if (outcome === 'done' && !quest.counted) {
    quest.counted = true;
    table.questsDone++;
  }
  emit('main', 'quest.finished', {
    questId: quest.id,
    n: quest.n,
    outcome,
    error: quest.error,
    durationMs: quest.endedAt - quest.startedAt,
    actions: quest.actions,
  }, ts);
}

// ---------------------------------------------------------------------------
// Ticket em fechamento (A-T8-1, seção 6, "Stop atrasado")
// ---------------------------------------------------------------------------

/**
 * Pedido novo do usuário com o ticket `open`: em vez de fechar na hora, o
 * ticket fica em fechamento por CLOSING_GRACE_MS (pela hora de chegada),
 * enquanto o ticket novo já começa. Um que já estava em fechamento termina
 * `interrupted` antes. Ticket em `waiting_background` já teve o Stop dele e
 * fecha na hora (`finishQuest`).
 * @param {QuestTable} table
 * @param {number} ts                    ts do pedido novo
 * @param {number} now                   hora de chegada do pedido
 * @param {Emit} emit
 * @returns {boolean}                    true se o ticket ficou em fechamento
 */
export function deferQuestClose(table, ts, now, emit) {
  const quest = table.quest;
  if (quest === null || quest.status !== 'open') return false;
  settleClosing(table, Infinity, emit);
  table.closing = { quest, ts, until: now + CLOSING_GRACE_MS };
  return true;
}

/**
 * Prazo vencido (no próximo fato ou no `tick`): o ticket em fechamento
 * termina `interrupted`, com o fim na hora do pedido que o substituiu.
 * @param {QuestTable} table
 * @param {number} now                   hora de chegada (ou do `tick`); Infinity encerra já
 * @param {Emit} emit
 * @returns {boolean}                    true se encerrou
 */
export function settleClosing(table, now, emit) {
  const closing = table.closing;
  if (closing === null || now < closing.until) return false;
  table.closing = null;
  closeQuest(table, closing.quest, 'interrupted', closing.ts, emit, null);
  return true;
}

/**
 * Stop atrasado (`isLateStop`) dentro do prazo e com `ts` entre o início do
 * ticket em fechamento e o do novo: o ticket em fechamento termina `done`, ou
 * `failed` no StopFailure. Sempre um único `quest.finished` por ticket.
 * @param {QuestTable} table
 * @param {'done'|'failed'} outcome
 * @param {number} ts                    ts do Stop
 * @param {Emit} emit
 * @param {string|null} [error]
 * @returns {boolean}                    true se encerrou
 */
export function closeWithLateStop(table, outcome, ts, emit, error = null) {
  const closing = table.closing;
  if (closing === null || ts < closing.quest.startedAt || ts >= closing.ts) return false;
  table.closing = null;
  closeQuest(table, closing.quest, outcome, ts, emit, outcome === 'failed' ? error : null);
  return true;
}

/**
 * Stop: sem tarefa em segundo plano ativa, `done`; com tarefa ativa, o ticket
 * espera o segundo plano, sem evento (seção 6).
 * @param {QuestTable} table
 * @param {readonly BackgroundTask[]} tasks
 * @param {number} ts
 * @param {Emit} emit
 */
export function stopQuest(table, tasks, ts, emit) {
  const quest = openQuestOf(table);
  if (!quest) return;
  if (hasActiveBackgroundTasks(tasks)) {
    quest.status = 'waiting_background';
    return;
  }
  finishQuest(table, 'done', ts, emit);
}

/**
 * Pedido do sistema (seção 6): reabre o ticket em espera ou o último encerrado
 * há menos de 30 min, sem evento. Devolve o ticket reaberto, ou null quando é
 * preciso abrir um implícito.
 * @param {QuestTable} table
 * @param {number} ts
 * @returns {Quest|null}
 */
export function reopenForSystem(table, ts) {
  const quest = table.quest;
  if (quest === null) return null;
  if (quest.status === 'open') return quest;
  if (quest.status === 'waiting_background' || (quest.endedAt !== null && ts - quest.endedAt < REOPEN_WINDOW_MS)) {
    quest.status = 'open';
    quest.endedAt = null;
    quest.error = null;
    table.closedQuests.delete(quest.id);
    return quest;
  }
  return null;
}

/**
 * O ticket de uma atividade (seção 6): o aberto; sem ticket aberto, um
 * implícito. Null quando o fato é de um ticket já encerrado ou em fechamento,
 * que não reabre (seção 8, regra 5): pelo `promptId` dele ou, sem `promptId`,
 * pelo `ts` até o fim do último ticket (a atividade aconteceu durante ele e
 * chegou atrasada). Evento atrasado de agente que não volta a trabalhar
 * (`implicit: false`; seção 8, regra 4) nunca abre implícito (A-T8-1).
 * @param {QuestTable} table
 * @param {Fact} fact
 * @param {Emit} emit
 * @param {{ implicit?: boolean }} [options]   `implicit: false`: sem ticket aberto, não abre um
 * @returns {Quest|null}
 */
export function questForActivity(table, fact, emit, { implicit = true } = {}) {
  const key = questKeyOf(fact);
  if (key !== null && (table.closedQuests.has(key) || table.closing?.quest.id === key)) return null;
  const open = openQuestOf(table);
  if (open) return open;
  if (!implicit) return null;
  const last = table.quest;
  if (last !== null && last.endedAt !== null && fact.ts <= last.endedAt) return null;
  return startQuest(table, { id: key, title: IMPLICIT_TITLE, implicit: true, ts: fact.ts }, emit);
}

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------

/**
 * Um agente do papel começou no ticket: a etapa fica `active` (de novo, se já
 * tinha terminado) e emite `quest.phase(active)`.
 * @param {QuestTable} table
 * @param {RoleId} role
 * @param {string} agentKey
 * @param {number} ts
 * @param {Emit} emit
 */
export function activatePhase(table, role, agentKey, ts, emit) {
  const phase = PHASE_BY_ROLE[role];
  const quest = openQuestOf(table);
  if (!phase || !quest || quest.phases[phase] === 'active') return;
  quest.phases[phase] = 'active';
  emit(agentKey, 'quest.phase', { questId: quest.id, phase, state: 'active' }, ts);
}

/**
 * Terminou um agente do papel: se nenhum outro do mesmo papel segue em
 * execução, a etapa fica `done` e emite `quest.phase(done)`.
 * @param {QuestTable} table
 * @param {RoleId} role
 * @param {string} agentKey
 * @param {boolean} othersRunning       ainda há agente do papel em execução
 * @param {number} ts
 * @param {Emit} emit
 */
export function completePhase(table, role, agentKey, othersRunning, ts, emit) {
  const phase = PHASE_BY_ROLE[role];
  const quest = openQuestOf(table);
  if (!phase || !quest || quest.phases[phase] !== 'active' || othersRunning) return;
  quest.phases[phase] = 'done';
  emit(agentKey, 'quest.phase', { questId: quest.id, phase, state: 'done' }, ts);
}

// ---------------------------------------------------------------------------
// Bugs (seção 6, "Bug na cena")
// ---------------------------------------------------------------------------

/**
 * `testResult` do fato (seção 2), com o `chained` interno do T6: o teste é o
 * último trecho de uma cadeia `&&`. `chained` nunca sai do servidor.
 * @typedef {TestResult & { chained: boolean }} TestResultFact
 */

/**
 * O `testResult` do fato (T6), lido de forma defensiva: só um objeto com `ok`
 * booleano conta; números que não forem inteiros não negativos viram null;
 * `chained` só com `true`.
 * @param {Fact} fact
 * @returns {TestResultFact|null}
 */
export function testResultOf(fact) {
  const value = /** @type {any} */ (fact).testResult;
  if (value === null || typeof value !== 'object' || typeof value.ok !== 'boolean') return null;
  /** @param {unknown} n */
  const count = (n) => (Number.isInteger(n) && /** @type {number} */ (n) >= 0 ? /** @type {number} */ (n) : null);
  return {
    ok: value.ok,
    passed: count(value.passed),
    failed: count(value.failed),
    total: count(value.total),
    framework: typeof value.framework === 'string' ? value.framework : null,
    chained: value.chained === true,
  };
}

/**
 * Efeito de um run de testes (seção 6, "Bug na cena"; decisões de 19/10/2026):
 * - teste interrompido pelo usuário (`interrupted`, V12): não gera run. Sem
 *   `test.finished`, sem contar na saúde e sem mudar `bugs`: um Esc não é bug;
 * - passou: `bugs.open = 0` (os abertos viram esmagados);
 * - falhou numa cadeia `&&` sem contagem reconhecida (`chained`, `failed`
 *   null): não se sabe se os testes chegaram a rodar (a falha pode ter vindo
 *   do build). Não gera run: sem `test.finished`, e `bugs` e `lastRun` não
 *   mudam. Vale como comando comum: o `tool.failed` conta na saúde;
 * - falhou: `bugs.open = failed ?? 1`, ao pé da letra (com `failed: 0`, 0 bugs).
 * Cadeia que passou é run aprovado como os outros.
 * @param {TestResultFact} result
 * @param {{ interrupted: boolean }} context   o Failure veio de interrupção
 * @returns {{ counts: boolean, open: number|null }}
 *   `counts`: sai `test.finished`, e a saúde conta pelo resultado do teste;
 *   `open`: `bugs.open` depois do run, ou null quando não muda `bugs` (nem o
 *   `lastRun`). Sem run e sem interrupção, a saúde conta o `tool.failed`.
 */
export function testRunEffect(result, { interrupted }) {
  if (interrupted) return { counts: false, open: null };
  if (result.ok) return { counts: true, open: 0 };
  if (result.chained && result.failed === null) return { counts: false, open: null };
  return { counts: true, open: result.failed ?? 1 };
}

/**
 * Aplica o run aos bugs da sessão, pelo `open` de `testRunEffect`: com 0
 * depois de um run aprovado, os abertos viram esmagados; `lastRun` guarda só
 * os campos do contrato (TestRun), sem o `chained`.
 * @param {QuestTable} table
 * @param {TestResultFact} result
 * @param {number} open                  `bugs.open` depois do run
 * @param {number} ts
 */
export function recordTestRun(table, result, open, ts) {
  if (result.ok) table.bugsCrushed += table.bugs.open;
  table.bugs.open = open;
  table.bugs.lastRun = { ok: result.ok, passed: result.passed, failed: result.failed, total: result.total, framework: result.framework, at: ts };
}

// ---------------------------------------------------------------------------
// Compactação
// ---------------------------------------------------------------------------

/**
 * O PostCompact e o SessionStart com `source: compact` da mesma compactação
 * (e as duplicatas deles) chegam a menos disto um do outro.
 */
export const COMPACT_PAIR_MS = 60_000;

/**
 * PreCompact: começa uma compactação.
 * @param {QuestTable} table
 * @param {string|null} trigger
 */
export function beginCompaction(table, trigger) {
  table.compaction = { trigger, pending: true, emittedAt: null };
}

/**
 * PostCompact ou SessionStart com `source: compact`: `context.compacted` uma
 * vez por compactação. Um sinal que chega até COMPACT_PAIR_MS depois do
 * anúncio, sem PreCompact novo no meio, é o par dele (ou uma duplicata) e não
 * repete o evento. A janela conta do anúncio, não do PreCompact: uma
 * compactação longa não vira duas. Sem `trigger` no sinal, vale o do PreCompact.
 * @param {QuestTable} table
 * @param {string|null} trigger
 * @param {number} ts
 * @returns {{ trigger: string|null }|null}   o que emitir, ou null
 */
export function completeCompaction(table, trigger, ts) {
  const current = table.compaction;
  if (current && !current.pending && current.emittedAt !== null && Math.abs(ts - current.emittedAt) < COMPACT_PAIR_MS) return null;
  const effective = trigger ?? (current && current.pending ? current.trigger : null);
  table.compaction = { trigger: effective, pending: false, emittedAt: ts };
  return { trigger: effective };
}

// ---------------------------------------------------------------------------
// Saída para o painel
// ---------------------------------------------------------------------------

/**
 * QuestState do contrato (seção 9), sem os campos internos.
 * @param {Quest|null} quest
 * @returns {QuestState|null}
 */
export function toQuestState(quest) {
  if (quest === null) return null;
  return {
    id: quest.id,
    n: quest.n,
    title: quest.title,
    implicit: quest.implicit,
    status: quest.status,
    startedAt: quest.startedAt,
    endedAt: quest.endedAt,
    phases: { ...quest.phases },
    actions: quest.actions,
    error: quest.error,
  };
}
