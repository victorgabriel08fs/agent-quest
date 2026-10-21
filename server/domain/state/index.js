// @ts-check
// Reducer de estado: fatos do normalizador → estado das sessões em memória e
// eventos canônicos (modelo de eventos, seções 3 a 9; ADR 0005; T7 e T8 do
// plano).
//
// T7: sessões, agentes, delegação, ordem, saúde, fim de turno e limpeza.
// T8: tickets e etapas (quests.js), aprovações (permissions.js), bugs,
// compactação e interrupção. A partir do T8 o reducer emite todos os tipos da
// seção 3, menos `context.usage` (T15), e o SessionState sai com `quest`,
// `counters`, `bugs` e `waitingFor` reais e com os status `waiting`.
//
// Determinístico (ADR 0010): o relógio `now` vem de quem chama. As horas do
// estado vêm do `ts` do fato (sentAt do encaminhador); `now` decide o status
// e a limpeza. `apply` e `tick` não leem o relógio do sistema.
//
// Numeração (seção 9; T7, ponto 1): um único `sequence`, criado pelo servidor
// com o `runId` e injetado em `createState`, numera cada evento no momento em
// que o reducer o cria. O mesmo objeto, congelado, vai para o `feed` e para o
// retorno de `apply` e `tick`. A ligação (T9a) usa o mesmo `sequence` para os
// `update` sem evento e os `session-removed`. O padrão é um contador local.
//
// Nenhum valor cru (`*Key` do fato) sai daqui: o papel e o elo usam o cru, e
// o estado e os eventos levam o valor exibido (seções 2 e 5).
//
// O reducer não lê o disco (seção 7; T7, ponto 10): `apply` devolve em
// `newProjects` as pastas de projeto vistas pela primeira vez, a ligação (T9a)
// lê `.claude/agents/` de forma assíncrona e entrega os nomes por
// `setAgentNames`.
//
// Adiantado antes do G0b (plano, T8): o que depende de veredito fica nas
// funções isoladas de quests.js (V7, V8, V12, V13) e permissions.js (V2, V4).

import {
  MAIN_KEY,
  agentKeyOf,
  anonymousCallKey,
  beginCall,
  callActivity,
  canWork,
  closeDelegation,
  confirmDelegation,
  correctCallStart,
  createSubagent,
  endAnonymousCall,
  endCall,
  finishAgent,
  isBackgroundLaunch,
  isStale,
  interruptedByUser,
  learnType,
  linkAgent,
  linkedAgentOf,
  linkDelegation,
  listedInBackground,
  markBackground,
  markWorking,
  openDelegation,
  pickInstance,
  recordOutcome,
  reviveAgent,
  runsInBackground,
  touchAgent,
} from './agents.js';
import {
  DENIED,
  INFERRED,
  latestOpenCall,
  noteNewCall,
  outcomeForCallEnd,
  requestApproval,
  requesterOf,
  resolveApprovals,
} from './permissions.js';
import {
  SYSTEM_RETURN_TITLE,
  activatePhase,
  beginCompaction,
  completeCompaction,
  completePhase,
  finishQuest,
  isKnownPrompt,
  isSystemPrompt,
  questForActivity,
  questKeyOf,
  recordTestRun,
  reopenForSystem,
  startQuest,
  stopQuest,
  testResultOf,
  testRunEffect,
  turnEndedWithoutStop,
} from './quests.js';
import {
  closeCall,
  createSession,
  isExpired,
  openCall,
  pruneAgents,
  pushFeed,
  rolesFromNames,
  sameRoles,
  projectOf,
  sessionKeyOf,
  sessionStatus,
  toSessionState,
  touchSession,
} from './sessions.js';

/** `runId` do contador local, padrão do `createState` (testes). */
export const LOCAL_RUN_ID = 'local';

/** Chave da atividade `compact` do agente (não colide com `toolUseId` nem com `#…`). */
const COMPACT_CALL_KEY = '~compact';

/**
 * `waitingFor` do aviso `permission_prompt` quando não se sabe a ferramenta
 * (nenhuma chamada aberta do agente).
 */
const UNKNOWN_WAIT = Object.freeze({ tool: '', category: /** @type {const} */ ('other'), target: null });

/**
 * @typedef {import('../../../shared/contract.js').SessionState} SessionState
 * @typedef {import('../../../shared/contract.js').CanonicalEvent} CanonicalEvent
 * @typedef {import('../../../shared/contract.js').EventKind} EventKind
 * @typedef {import('../normalize.js').Fact} Fact
 * @typedef {import('../normalize.js').BackgroundTask} BackgroundTask
 * @typedef {import('./agents.js').Agent} Agent
 * @typedef {import('./agents.js').ToolFact} ToolFact
 * @typedef {import('./sessions.js').Session} Session
 * @typedef {import('./sessions.js').CallRecord} CallRecord
 * @typedef {import('./quests.js').Quest} Quest
 * @typedef {import('./quests.js').Emit} Emit
 * @typedef {import('../../../shared/contract.js').RoleId} RoleId
 */

/**
 * Numeração da execução (seção 9): `next()` reserva o próximo `seq` e devolve
 * o `id` (`runId:seq`); `current()` é o último reservado (0 no começo).
 * @typedef {object} Sequence
 * @property {() => { seq: number, id: string }} next
 * @property {() => number} current
 */

/**
 * Estado de todas as sessões em memória.
 * @typedef {object} State
 * @property {Map<string, Session>} sessions
 * @property {unknown} roleOverrides       "roles" do config.json (resolveRole)
 * @property {Sequence} sequence
 * @property {string|null} homeDir         contexto da forma canônica do projeto (seção 7)
 * @property {Map<string, Set<RoleId>|null>} projects   papéis de .claude/agents/ por project.key;
 *                                         null enquanto a leitura não terminou
 */

/**
 * @typedef {object} ApplyResult
 * @property {CanonicalEvent[]} events    na ordem em que aconteceram, já numerados
 * @property {string[]} changed           sessões cujo estado mudou
 * @property {string[]} newProjects       pastas de projeto vistas pela primeira vez (forma canônica),
 *                                        para a ligação ler .claude/agents/ (seção 7)
 */

/**
 * @typedef {object} TickResult
 * @property {CanonicalEvent[]} events
 * @property {string[]} changed
 * @property {string[]} removed           sessões que saíram da memória
 */

/**
 * @typedef {object} Context
 * @property {State} state
 * @property {Session} session
 * @property {CanonicalEvent[]} events
 * @property {Emit} out                   emite um evento desta sessão (para quests.js e permissions.js)
 */

/**
 * Contador de `seq` de uma execução do servidor, começando em 1.
 * @param {string} runId
 * @returns {Sequence}
 */
export function createSequence(runId) {
  let seq = 0;
  return {
    next() {
      seq++;
      return { seq, id: `${runId}:${seq}` };
    },
    current: () => seq,
  };
}

/**
 * @param {{ roleOverrides?: unknown, sequence?: Sequence, homeDir?: string|null }} [options]
 *   `roleOverrides`: "roles" do config.json. `sequence`: a numeração da
 *   execução (padrão: contador local, com o runId LOCAL_RUN_ID). `homeDir`:
 *   pasta pessoal, o contexto que decide se `/c/...` é `c:/...` na chave do
 *   projeto, como no normalizador (padrão: nenhum).
 * @returns {State}
 */
export function createState({ roleOverrides = {}, sequence = createSequence(LOCAL_RUN_ID), homeDir = null } = {}) {
  return { sessions: new Map(), roleOverrides, sequence, homeDir, projects: new Map() };
}

/**
 * Nomes de `.claude/agents/` lidos pela ligação para um projeto (seção 7).
 * Atualiza o `roster` das sessões desse projeto e guarda os papéis para as
 * sessões que vierem depois.
 * @param {State} state
 * @param {string} projectDir
 * @param {readonly unknown[]} names
 * @returns {{ changed: string[] }}       sessões cujo roster mudou
 */
export function setAgentNames(state, projectDir, names) {
  /** @type {string[]} */
  const changed = [];
  if (typeof projectDir !== 'string' || projectDir === '') return { changed };
  const { key } = projectOf(projectDir, state.homeDir);
  const roles = rolesFromNames(Array.isArray(names) ? names : [], state.roleOverrides);
  state.projects.set(key, roles);
  for (const session of state.sessions.values()) {
    if (session.project?.key !== key || sameRoles(session.fileRoles, roles)) continue;
    session.fileRoles = new Set(roles);
    changed.push(session.id);
  }
  return { changed };
}

/**
 * Aplica um fato ao estado.
 * @param {State} state
 * @param {Fact} fact
 * @param {number} now                   relógio do servidor (ms)
 * @returns {ApplyResult}
 */
export function apply(state, fact, now) {
  /** @type {CanonicalEvent[]} */
  const events = [];
  /** @type {string[]} */
  const newProjects = [];
  if (!isFact(fact)) return { events, changed: [], newProjects };
  const id = sessionKeyOf(fact);
  const existing = state.sessions.get(id);
  if (isNoise(fact, existing)) return { events, changed: [], newProjects };
  // Agente removido pelo limite (seção 7): o evento atrasado dele é ignorado.
  if (existing && fact.agentId !== null && existing.tombstones.has(fact.agentId)) return { events, changed: [], newProjects };

  let session = existing;
  if (!session) {
    session = createSession(id, fact);
    state.sessions.set(id, session);
  }
  const project = touchSession(session, fact, state.homeDir);
  if (project) {
    const roles = state.projects.get(project.key);
    if (roles) session.fileRoles = new Set(roles);
    if (roles === undefined) {
      state.projects.set(project.key, null);
      newProjects.push(project.key);
    }
  }
  const ctx = contextOf(state, session, events);
  (HANDLERS[fact.kind] ?? onOther)(ctx, fact);
  prune(ctx, fact.ts);
  session.status = sessionStatus(session, now);
  return { events, changed: [id], newProjects };
}

/**
 * Passagem do relógio (seção 6, "Voltou para a copa"; seção 7, "Limpeza"):
 * - agente trabalhando, sem ferramenta em execução e sem eventos há 15 min:
 *   subagente recebe `agent.finished(unknown)` (e pode voltar com um `tool.pre`
 *   novo); a sessão principal só fica ociosa. Agente aguardando aprovação não
 *   entra nessa regra: a espera pelo usuário pode ser longa;
 * - status da sessão recalculado (`active` vira `idle` depois de 2 min);
 * - sessão encerrada há 30 min ou sem eventos há 6 h sai da memória.
 * @param {State} state
 * @param {number} now
 * @returns {TickResult}
 */
export function tick(state, now) {
  /** @type {CanonicalEvent[]} */
  const events = [];
  /** @type {string[]} */
  const changed = [];
  /** @type {string[]} */
  const removed = [];
  for (const [id, session] of state.sessions) {
    if (isExpired(session, now)) {
      state.sessions.delete(id);
      removed.push(id);
      continue;
    }
    const ctx = contextOf(state, session, events);
    let dirty = false;
    for (const agent of session.agents.values()) {
      if (!isStale(agent, now)) continue;
      dirty = true;
      if (agent.key === MAIN_KEY) agent.status = 'idle';
      else finish(ctx, agent, 'unknown', now, { revivable: true });
    }
    if (prune(ctx, now)) dirty = true;
    const status = sessionStatus(session, now);
    if (status !== session.status) {
      session.status = status;
      dirty = true;
    }
    if (dirty) changed.push(id);
  }
  return { events, changed, removed };
}

/**
 * Estado de uma sessão para o painel (seção 9).
 * @param {State} state
 * @param {string} sessionId
 * @param {{ feed?: boolean }} [options]   com `feed` por padrão (snapshot e /api/state);
 *                                         `{ feed: false }` para o `update`
 * @returns {SessionState|null}
 */
export function getSessionState(state, sessionId, { feed = true } = {}) {
  const session = state.sessions.get(sessionId);
  return session ? toSessionState(session, { feed }) : null;
}

/**
 * Todas as sessões, para o snapshot e o `/api/state` (com feed, por padrão).
 * @param {State} state
 * @param {{ feed?: boolean }} [options]
 * @returns {SessionState[]}
 */
export function getSessionStates(state, { feed = true } = {}) {
  return [...state.sessions.values()].map((session) => toSessionState(session, { feed }));
}

/**
 * Sessões em memória, inclusive encerradas ainda não limpas (`/api/health`).
 * @param {State} state
 * @returns {number}
 */
export function sessionCount(state) {
  return state.sessions.size;
}

// ---------------------------------------------------------------------------
// Fatos
// ---------------------------------------------------------------------------

/**
 * @param {unknown} fact
 * @returns {fact is Fact}
 */
function isFact(fact) {
  if (fact === null || typeof fact !== 'object') return false;
  const value = /** @type {Record<string, unknown>} */ (fact);
  return typeof value.kind === 'string' && typeof value.sessionId === 'string' && Number.isFinite(value.ts);
}

/**
 * Fatos que não geram nada, nem criam a sessão (seção 4; V6): SubagentStart
 * ou SubagentStop sem `agent_id`, ou de agente desconhecido com `agent_type`
 * vazio (agentes internos do Claude Code). "Vazio" é o critério do T7: no
 * fato, `agentType: null`. Isso inclui um tipo só com espaços, cujo valor cru
 * não é vazio.
 * @param {Fact} fact
 * @param {Session|undefined} session
 * @returns {boolean}
 */
function isNoise(fact, session) {
  if (fact.kind !== 'subagent.start' && fact.kind !== 'subagent.stop') return false;
  if (fact.agentId === null) return true;
  const known = session?.agents.has(fact.agentId) ?? false;
  return !known && fact.agentType === null;
}

/** @type {Partial<Record<Fact['kind'], (ctx: Context, fact: any) => void>>} */
const HANDLERS = {
  'session.start': onSessionStart,
  'session.end': onSessionEnd,
  'prompt.submit': onPrompt,
  'tool.pre': onTool,
  'tool.post': onTool,
  'tool.fail': onTool,
  'permission.request': onPermissionRequest,
  'permission.denied': onPermissionDenied,
  notice: onNotice,
  'subagent.start': onSubagentStart,
  'subagent.stop': onSubagentStop,
  'turn.stop': onTurnEnd,
  'turn.fail': onTurnEnd,
  'compact.pre': onCompactPre,
  'compact.post': onCompactPost,
};

/**
 * Fato de tipo sem regra (defesa): cria o agente sob demanda e atualiza as horas.
 * @param {Context} ctx
 * @param {Fact} fact
 */
function onOther(ctx, fact) {
  actor(ctx, fact);
}

/**
 * SessionStart: `session.started` (seção 4). É o único que emite esse evento:
 * a sessão criada sob demanda aparece pelo `update` sem evento. Uma sessão
 * encerrada que recebe SessionStart com o mesmo id (retomada) volta a valer.
 * Com `source: compact`, a atividade "compactando" termina e, se o PostCompact
 * não anunciou esta compactação, sai `context.compacted` (T8).
 * @param {Context} ctx
 * @param {import('../normalize.js').SessionStartFact} fact
 */
function onSessionStart(ctx, fact) {
  const { session } = ctx;
  session.ended = false;
  session.endedAt = null;
  const agent = actor(ctx, fact);
  emit(ctx, null, 'session.started', { source: fact.source, projectName: session.project?.name ?? null }, fact.ts);
  if (fact.source !== 'compact') return;
  endCall(agent, COMPACT_CALL_KEY, 'done');
  const compacted = completeCompaction(session, null, fact.ts);
  if (compacted) emit(ctx, agent.key, 'context.compacted', { trigger: compacted.trigger }, fact.ts);
}

/**
 * SessionEnd (seção 4; T7, ponto 7): libera os agentes ainda trabalhando ou
 * aguardando (subagentes com `agent.finished(unknown)`, o `main` ocioso), os
 * pedidos de aprovação que sobrarem viram `unknown`, o ticket ainda aberto ou
 * em espera termina `interrupted` (T8) e sai `session.ended`. A sessão sai da
 * memória 30 min depois. Eventos atrasados não devolvem ninguém a "trabalhando".
 * @param {Context} ctx
 * @param {import('../normalize.js').SessionEndFact} fact
 */
function onSessionEnd(ctx, fact) {
  const { session } = ctx;
  const main = actor(ctx, fact);
  if (session.ended) return;
  for (const agent of session.agents.values()) {
    if (agent.key === MAIN_KEY) continue;
    if (agent.status !== 'idle') finish(ctx, agent, 'unknown', fact.ts);
    agent.revivable = false;
  }
  resolveApprovals(session, () => true, INFERRED, fact.ts, ctx.out);
  main.status = 'idle';
  main.turnEnded = true;
  finishQuest(session, 'interrupted', fact.ts, ctx.out);
  session.ended = true;
  session.endedAt = fact.ts;
  emit(ctx, null, 'session.ended', { reason: fact.reason }, fact.ts);
}

/**
 * UserPromptSubmit (seções 4 e 6). Deixa a sessão principal trabalhando e
 * libera a regra 4 da seção 8 (turno encerrado pelo Stop).
 * - Pedido do sistema (V7): não abre ticket; reabre o ticket em espera ou o
 *   último encerrado há menos de 30 min, sem evento, ou abre um implícito.
 * - Pedido do usuário: os pedidos de aprovação do `main` viram `unknown`; se o
 *   turno anterior acabou sem Stop (Esc, V12), os subagentes em primeiro plano
 *   são liberados; o ticket aberto ou em espera termina `interrupted`; abre o
 *   ticket novo.
 * - Pedido que já tem ticket (duplicata ou atraso, V8): nada muda, nem o status
 *   do `main` (seção 8, regras 4 e 5).
 * @param {Context} ctx
 * @param {import('../normalize.js').PromptFact} fact
 */
function onPrompt(ctx, fact) {
  const { session } = ctx;
  const agent = actor(ctx, fact);
  if (agent.key !== MAIN_KEY || isKnownPrompt(session, fact)) return;
  if (isSystemPrompt(fact)) {
    agent.turnEnded = false;
    markWorking(agent);
    if (!reopenForSystem(session, fact.ts)) {
      startQuest(session, { id: questKeyOf(fact), title: SYSTEM_RETURN_TITLE, implicit: true, ts: fact.ts }, ctx.out);
    }
    return;
  }
  resolveApprovals(session, (approval) => approval.agentKey === MAIN_KEY, INFERRED, fact.ts, ctx.out);
  if (turnEndedWithoutStop(session.quest, fact.ts)) releaseForeground(ctx, [], fact.ts);
  finishQuest(session, 'interrupted', fact.ts, ctx.out);
  agent.turnEnded = false;
  markWorking(agent);
  startQuest(session, { id: questKeyOf(fact), title: fact.title, implicit: false, ts: fact.ts }, ctx.out);
}

/**
 * PreToolUse, PostToolUse e PostToolUseFailure (seções 4 e 8).
 * - O primeiro evento de um `toolUseId` abre a chamada; os seguintes só a
 *   atualizam e ficam com o agente dela (regra 1).
 * - Pre de uma chamada já vista é ignorado (regra 2), assim como um Post ou
 *   Failure de uma chamada já encerrada.
 * - Um Pre com `toolUseId` novo traz de volta o subagente encerrado só pela
 *   inferência dos 15 min (seção 6), e a etapa dele volta a `active`.
 * - O primeiro evento de uma chamada é atividade: vai para o ticket aberto ou
 *   abre um implícito (T8), e resolve como `unknown` os pedidos de aprovação
 *   do agente que não são desta chamada ("outra ação", seção 6).
 * @param {Context} ctx
 * @param {ToolFact} fact
 */
function onTool(ctx, fact) {
  const { session } = ctx;
  const record = fact.toolUseId === null ? undefined : session.calls.get(fact.toolUseId);
  if (record && fact.kind === 'tool.pre') {
    // Regra 2: sem evento. O ts do Pre ainda é o início real da chamada.
    const owner = session.agents.get(record.agentKey);
    if (owner && fact.toolUseId !== null) {
      touchAgent(owner, fact.ts);
      correctCallStart(owner, fact.toolUseId, fact.ts);
    }
    return;
  }
  if (record && !record.open) return;
  // O ticket antes do agente: o `quest.started` implícito vem antes do
  // `agent.started`, e a etapa do agente novo já cai nele. Sessão encerrada
  // não ganha ticket com evento atrasado.
  const quest = record || session.ended ? null : questForActivity(session, fact, ctx.out);
  const agent = record ? agentFor(ctx, fact, record.agentKey) : actor(ctx, fact);
  if (!record && fact.kind === 'tool.pre' && fact.toolUseId !== null && reviveAgent(agent)) {
    activatePhase(session, agent.role, agent.key, fact.ts, ctx.out);
  }
  if (!record) noteNewCall(session, agent, { toolUseId: fact.toolUseId, tool: fact.tool, inputHash: fact.inputHash }, fact.ts, ctx.out);
  // O tipo da chamada é o do primeiro evento dela (regra 1): um Post ou Failure
  // com outro tool_name e o mesmo toolUseId não muda delegação em ferramenta.
  const delegation = record ? record.delegation : fact.category === null;
  if (delegation) delegationCall(ctx, fact, agent, record, quest);
  else toolCall(ctx, fact, agent, record, quest);
}

/**
 * Ferramenta comum: `tool.started` no primeiro evento; no Post ou no Failure,
 * `tool.finished` ou `tool.failed`, `test.finished` se for comando de teste
 * com resultado, e `permission.resolved` se havia pedido pendente para a
 * chamada (seção 4, nessa ordem). Comando de teste conta na saúde uma vez,
 * pelo resultado do teste; `tool.failed` interrompido pelo usuário não conta,
 * e teste interrompido ou cadeia `&&` que falhou sem contagem não geram run
 * (seção 6, "Saúde" e "Bug na cena").
 * @param {Context} ctx
 * @param {ToolFact} fact
 * @param {Agent} agent
 * @param {CallRecord|undefined} record
 * @param {Quest|null} quest             ticket da chamada nova, para `actions`
 */
function toolCall(ctx, fact, agent, record, quest) {
  const { session } = ctx;
  const callId = fact.toolUseId;
  const pre = fact.kind === 'tool.pre';
  const ok = fact.kind === 'tool.post';
  // Sem toolUseId não há como casar o Post com o Pre: só o Pre gera tool.started.
  if (!record && (pre || callId !== null)) {
    emit(ctx, agent.key, 'tool.started', {
      toolUseId: callId,
      tool: fact.tool,
      category: fact.category,
      target: fact.target,
      detail: fact.detail,
    }, fact.ts);
    if (quest) quest.actions++;
    beginCall(agent, callId ?? anonymousCallKey(fact.ts), callActivity(fact, pre ? 'running' : ok ? 'done' : 'failed'));
    if (callId !== null) openCall(session, agent, callId, fact);
  }
  touchAgent(agent, fact.ts);
  markWorking(agent);
  if (fact.kind === 'tool.pre') return;

  if (callId !== null) closeCall(session, callId);
  // Nome, categoria e alvo são os do primeiro evento da chamada (regra 1).
  const first = record ?? fact;
  if (fact.kind === 'tool.post') {
    emit(ctx, agent.key, 'tool.finished', {
      toolUseId: callId,
      tool: first.tool,
      category: first.category,
      durationMs: fact.durationMs,
    }, fact.ts);
  } else {
    emit(ctx, agent.key, 'tool.failed', {
      toolUseId: callId,
      tool: first.tool,
      category: first.category,
      target: first.target,
      error: fact.error,
      interrupted: fact.interrupted,
    }, fact.ts);
  }
  // Interrupção do usuário (V12) não é erro do agente: não conta na saúde nem gera run de testes.
  const interrupted = interruptedByUser(fact);
  const result = testResultOf(fact);
  const run = result ? testRunEffect(result, { interrupted }) : null;
  if (result && run?.counts) {
    emit(ctx, agent.key, 'test.finished', {
      toolUseId: callId,
      ok: result.ok,
      passed: result.passed,
      failed: result.failed,
      total: result.total,
      framework: result.framework,
    }, fact.ts);
  }
  if (result && run && run.open !== null) recordTestRun(session, result, run.open, fact.ts);
  if (!interrupted) recordOutcome(agent, result ? result.ok : ok, fact.ts);
  settle(agent, callId, ok ? 'done' : 'failed');
  if (callId !== null) resolveApprovals(session, (approval) => approval.toolUseId === callId, outcomeForCallEnd(fact), fact.ts, ctx.out);
}

/**
 * Agent ou Task: `agent.delegated` no primeiro evento da chamada (Pre, ou Post
 * e Failure fora de ordem, como na regra 1). O Post confirma ou corrige o elo
 * delegação → instância, sem evento (seção 4). A falha não emite `tool.failed`
 * (delegação nunca tem `tool.started`) e descarta o pedido ainda sem instância.
 * A chamada não conta na saúde.
 * @param {Context} ctx
 * @param {ToolFact} fact
 * @param {Agent} agent                  quem delegou
 * @param {CallRecord|undefined} record
 * @param {Quest|null} quest             ticket da chamada nova, para `actions`
 */
function delegationCall(ctx, fact, agent, record, quest) {
  const { session, state } = ctx;
  const callId = fact.toolUseId;
  const pre = fact.kind === 'tool.pre';
  let delegation = callId === null ? undefined : session.delegations.get(callId);
  if (!record && (pre || callId !== null)) {
    delegation = openDelegation(session, fact, agent.key, state.roleOverrides);
    // Corrida inversa (seção 5, passo 2a): a instância pode ter chegado antes do Pre.
    if (pre) {
      const instance = pickInstance(session, delegation, fact.ts);
      if (instance) linkDelegation(delegation, instance);
    }
    emit(ctx, agent.key, 'agent.delegated', {
      toolUseId: callId,
      toType: delegation.toType,
      toRole: delegation.toRole,
      description: delegation.description,
      background: delegation.background,
    }, fact.ts);
    if (quest) quest.actions++;
    beginCall(agent, callId ?? anonymousCallKey(fact.ts), callActivity(fact, pre ? 'running' : fact.kind === 'tool.post' ? 'done' : 'failed'));
    if (callId !== null) openCall(session, agent, callId, fact);
  }
  touchAgent(agent, fact.ts);
  markWorking(agent);
  if (pre) return;

  if (callId !== null) closeCall(session, callId);
  settle(agent, callId, fact.kind === 'tool.post' ? 'done' : 'failed');
  if (callId !== null) resolveApprovals(session, (approval) => approval.toolUseId === callId, outcomeForCallEnd(fact), fact.ts, ctx.out);
  if (!delegation) return;
  if (fact.kind === 'tool.post') {
    if (isBackgroundLaunch(fact)) markBackground(session, delegation);
    const linked = linkedAgentOf(fact);
    if (linked !== null) confirmDelegation(session, delegation, linked);
  }
  closeDelegation(session, delegation, { failed: fact.kind === 'tool.fail' });
}

/**
 * PermissionRequest (seção 6, "Aguardando aprovação"): quem pediu (V2) fica
 * `waiting`, com `waitingFor`, e sai `permission.requested`. Pedido atrasado
 * de um agente que não pode mais trabalhar (subagente encerrado, `main` depois
 * do Stop ou do SessionEnd) não abre espera: ela nunca seria resolvida.
 * @param {Context} ctx
 * @param {import('../normalize.js').PermissionRequestFact} fact
 */
function onPermissionRequest(ctx, fact) {
  const { session } = ctx;
  const requester = requesterOf(session, { agentId: fact.agentId, tool: fact.tool, inputHash: fact.inputHash });
  const known = session.agents.get(requester.agentKey);
  const agent = requester.agentKey === agentKeyOf(fact) || !known ? actor(ctx, fact) : known;
  touchAgent(agent, fact.ts);
  if (!canWork(agent)) return;
  const tool = fact.tool ?? '';
  // O mesmo pedido de novo (duplicata) não abre outra espera.
  const repeated = session.approvals.some((approval) => (requester.toolUseId !== null && approval.toolUseId === requester.toolUseId)
    || (approval.agentKey === agent.key && approval.toolUseId === requester.toolUseId && approval.tool === tool
      && approval.inputHash !== null && approval.inputHash === fact.inputHash));
  if (repeated) return;
  requestApproval(session, agent, {
    toolUseId: requester.toolUseId,
    tool,
    category: fact.category ?? 'other',
    target: fact.target,
    inputHash: fact.inputHash,
    ts: fact.ts,
  }, ctx.out);
}

/**
 * PermissionDenied (só no modo automático): `permission.resolved(denied,
 * auto)` para o pedido pendente da chamada, ou, sem pedido conhecido, para o
 * agente da chamada. A chamada negada não roda (V4): ela é encerrada, com a
 * atividade em `failed`, sem `tool.failed` e sem contar na saúde.
 * @param {Context} ctx
 * @param {import('../normalize.js').PermissionDeniedFact} fact
 */
function onPermissionDenied(ctx, fact) {
  const { session } = ctx;
  const callId = fact.toolUseId;
  const record = callId === null ? undefined : session.calls.get(callId);
  const agent = record ? agentFor(ctx, fact, record.agentKey) : actor(ctx, fact);
  // Chamada já encerrada (pela própria negação ou pelo Post): duplicata ou atraso.
  if (record && !record.open) return;
  const tool = fact.tool ?? '';
  const resolved = resolveApprovals(
    session,
    (approval) => (callId !== null && approval.toolUseId === callId)
      || (approval.toolUseId === null && approval.agentKey === agent.key && approval.tool === tool),
    DENIED,
    fact.ts,
    ctx.out,
  );
  if (resolved === 0) emit(ctx, agent.key, 'permission.resolved', { outcome: DENIED.outcome, by: DENIED.by }, fact.ts);
  if (!record || callId === null) return;
  closeCall(session, callId);
  settle(agent, callId, 'failed');
  const delegation = record.delegation ? session.delegations.get(callId) : undefined;
  if (delegation) closeDelegation(session, delegation, { failed: true });
}

/**
 * Notification (seção 4):
 * - `permission_prompt` sem pedido pendente na sessão: o agente do aviso (o
 *   `main`, sem `agent_id`) fica `waiting`, para o aviso aparecer mesmo se o
 *   PermissionRequest se perder. `waitingFor` é a chamada aberta mais recente
 *   dele, se houver;
 * - `idle_prompt`: o Claude Code espera o usuário. Se o turno acabou sem Stop
 *   (V12), compensa o Stop perdido (aprovações do `main` viram `unknown`,
 *   subagentes em primeiro plano são liberados, `main` ocioso) e o ticket
 *   aberto termina `interrupted`. Sai `session.idle` (menos em sessão
 *   encerrada);
 * - outro tipo (`null`): só atualiza as horas.
 * @param {Context} ctx
 * @param {import('../normalize.js').NoticeFact} fact
 */
function onNotice(ctx, fact) {
  const { session } = ctx;
  const agent = actor(ctx, fact);
  if (fact.type === 'permission_prompt') {
    if (session.approvals.length > 0 || !canWork(agent)) return;
    const call = latestOpenCall(session, agent.key);
    const wait = call ? { tool: call.tool ?? '', category: call.category ?? 'other', target: call.target } : UNKNOWN_WAIT;
    requestApproval(session, agent, {
      toolUseId: call ? call.toolUseId : null,
      tool: wait.tool,
      category: wait.category,
      target: wait.target,
      inputHash: call ? call.inputHash : null,
      ts: fact.ts,
    }, ctx.out);
    return;
  }
  if (fact.type !== 'idle_prompt' || session.ended) return;
  if (turnEndedWithoutStop(session.quest, fact.ts)) {
    const main = session.agents.get(MAIN_KEY);
    resolveApprovals(session, (approval) => approval.agentKey === MAIN_KEY, INFERRED, fact.ts, ctx.out);
    releaseForeground(ctx, [], fact.ts);
    if (main) {
      main.status = 'idle';
      main.turnEnded = true;
    }
    finishQuest(session, 'interrupted', fact.ts, ctx.out);
  }
  emit(ctx, null, 'session.idle', {}, fact.ts);
}

/**
 * SubagentStart: cria a instância e emite `agent.started`. Se ela já existe
 * (criada antes por outro evento, ou retomada), só completa o elo (seção 8,
 * regra 3), sem evento. Uma instância nova é atividade: vai para o ticket
 * aberto ou abre um implícito, antes do `agent.started`.
 * @param {Context} ctx
 * @param {import('../normalize.js').SubagentStartFact} fact
 */
function onSubagentStart(ctx, fact) {
  const { session } = ctx;
  if (!session.ended && !session.agents.has(agentKeyOf(fact))) questForActivity(session, fact, ctx.out);
  const agent = actor(ctx, fact);
  linkAgent(session, agent);
}

/**
 * SubagentStop: o subagente termina ocioso e na copa, com
 * `agent.finished(done)`. Desconhecido com tipo: `agent.started` e logo
 * `agent.finished`. Eventos atrasados não o devolvem a "trabalhando" (regra 4),
 * nem mesmo se ele já tinha sido encerrado pela inferência dos 15 min.
 * @param {Context} ctx
 * @param {import('../normalize.js').SubagentStopFact} fact
 */
function onSubagentStop(ctx, fact) {
  const agent = actor(ctx, fact);
  if (agent.key === MAIN_KEY) return;
  if (agent.finished) {
    agent.revivable = false;
    return;
  }
  finish(ctx, agent, 'done', fact.ts);
}

/**
 * Stop e StopFailure: os pedidos de aprovação do `main` viram `unknown` (fim do
 * turno), a sessão principal fica ociosa até o próximo pedido, e os subagentes
 * em primeiro plano que ainda constam como trabalhando ou aguardando recebem
 * `agent.finished(unknown)`, haja ou não tarefa em segundo plano (seção 6; T7,
 * ponto 5). Os de segundo plano continuam. Depois, o ticket: Stop sem tarefa
 * em segundo plano ativa → `done`; com tarefa ativa → `waiting_background`,
 * sem evento (V13); StopFailure → `failed`, com o tipo de erro (T8).
 * @param {Context} ctx
 * @param {import('../normalize.js').TurnStopFact|import('../normalize.js').TurnFailFact} fact
 */
function onTurnEnd(ctx, fact) {
  const main = actor(ctx, fact);
  if (main.key !== MAIN_KEY) return;
  resolveApprovals(ctx.session, (approval) => approval.agentKey === MAIN_KEY, INFERRED, fact.ts, ctx.out);
  main.status = 'idle';
  main.turnEnded = true;
  const tasks = fact.kind === 'turn.stop' ? fact.backgroundTasks : [];
  releaseForeground(ctx, tasks, fact.ts);
  if (fact.kind === 'turn.stop') stopQuest(ctx.session, tasks, fact.ts, ctx.out);
  else finishQuest(ctx.session, 'failed', fact.ts, ctx.out, fact.error);
}

/**
 * PreCompact: a atividade do agente vira "compactando" (`compact`, `running`,
 * `detail` = `trigger`), sem evento (seção 4).
 * @param {Context} ctx
 * @param {import('../normalize.js').CompactFact} fact
 */
function onCompactPre(ctx, fact) {
  const agent = actor(ctx, fact);
  beginCompaction(ctx.session, fact.trigger);
  beginCall(agent, COMPACT_CALL_KEY, {
    kind: 'compact',
    category: null,
    tool: null,
    target: null,
    detail: fact.trigger,
    state: 'running',
    at: fact.ts,
  });
}

/**
 * PostCompact: a atividade "compactando" termina e sai `context.compacted`,
 * uma vez por compactação (o SessionStart com `source: compact` pode chegar
 * antes ou depois).
 * @param {Context} ctx
 * @param {import('../normalize.js').CompactFact} fact
 */
function onCompactPost(ctx, fact) {
  const agent = actor(ctx, fact);
  endCall(agent, COMPACT_CALL_KEY, 'done');
  const compacted = completeCompaction(ctx.session, fact.trigger, fact.ts);
  if (compacted) emit(ctx, agent.key, 'context.compacted', { trigger: compacted.trigger }, fact.ts);
}

// ---------------------------------------------------------------------------
// Agentes e eventos
// ---------------------------------------------------------------------------

/**
 * Contexto de um fato ou de um `tick` numa sessão.
 * @param {State} state
 * @param {Session} session
 * @param {CanonicalEvent[]} events
 * @returns {Context}
 */
function contextOf(state, session, events) {
  /** @type {Context} */
  const ctx = { state, session, events, out: (agentKey, kind, data, ts) => emit(ctx, agentKey, kind, data, ts) };
  return ctx;
}

/**
 * O agente do fato, pela chave (V1), criado sob demanda.
 * @param {Context} ctx
 * @param {Fact} fact
 * @returns {Agent}
 */
function actor(ctx, fact) {
  return agentFor(ctx, fact, agentKeyOf(fact));
}

/**
 * Agente da sessão pela chave. Um subagente desconhecido é criado na hora,
 * com o papel do tipo cru (`aux` sem tipo), ligado ao pedido pendente, e emite
 * `agent.started` (seção 8, regra 3). Um agente conhecido pode completar o
 * tipo e, com ele, o elo. Agente do time que começa (ou ganha o papel) com
 * ticket aberto ativa a etapa do papel (T8).
 * @param {Context} ctx
 * @param {Fact} fact
 * @param {string} key
 * @returns {Agent}
 */
function agentFor(ctx, fact, key) {
  const { session, state } = ctx;
  let agent = session.agents.get(key);
  if (agent) {
    if (learnType(agent, fact, state.roleOverrides)) {
      linkAgent(session, agent);
      if (!agent.finished) activatePhase(session, agent.role, agent.key, fact.ts, ctx.out);
    }
    touchAgent(agent, fact.ts);
    return agent;
  }
  agent = createSubagent(key, fact, state.roleOverrides);
  session.agents.set(key, agent);
  linkAgent(session, agent);
  emit(ctx, key, 'agent.started', {
    agentType: agent.agentType,
    role: agent.role,
    label: agent.label,
    parentKey: agent.parentKey,
  }, fact.ts);
  activatePhase(session, agent.role, key, fact.ts, ctx.out);
  return agent;
}

/**
 * Fim de uma chamada na atividade do agente.
 * @param {Agent} agent
 * @param {string|null} callId
 * @param {'done'|'failed'} state
 */
function settle(agent, callId, state) {
  if (callId === null) endAnonymousCall(agent, state);
  else endCall(agent, callId, state);
}

/**
 * Subagentes em primeiro plano ainda trabalhando ou aguardando recebem
 * `agent.finished(unknown)` (fim do turno, com ou sem Stop). Os de segundo
 * plano, pelas flags ou por `background_tasks`, seguem.
 * @param {Context} ctx
 * @param {readonly BackgroundTask[]} tasks
 * @param {number} ts
 */
function releaseForeground(ctx, tasks, ts) {
  for (const agent of ctx.session.agents.values()) {
    if (agent.key === MAIN_KEY || (agent.status !== 'working' && agent.status !== 'waiting')) continue;
    if (listedInBackground(agent, tasks)) agent.background = true;
    if (runsInBackground(ctx.session, agent, tasks)) continue;
    finish(ctx, agent, 'unknown', ts);
  }
}

/**
 * Fim de um subagente: os pedidos de aprovação dele viram `unknown`, sai
 * `agent.finished` e, se era o último do papel em execução, `quest.phase(done)`.
 * @param {Context} ctx
 * @param {Agent} agent
 * @param {'done'|'unknown'} outcome
 * @param {number} ts
 * @param {{ revivable?: boolean }} [options]
 */
function finish(ctx, agent, outcome, ts, options) {
  const { session } = ctx;
  resolveApprovals(session, (approval) => approval.agentKey === agent.key, INFERRED, ts, ctx.out);
  finishAgent(agent, options);
  emit(ctx, agent.key, 'agent.finished', { outcome }, ts);
  let othersRunning = false;
  for (const other of session.agents.values()) {
    if (other !== agent && other.key !== MAIN_KEY && other.role === agent.role && !other.finished) othersRunning = true;
  }
  completePhase(session, agent.role, agent.key, othersRunning, ts, ctx.out);
}

/**
 * Limite de agentes (seção 7). Pedido de aprovação de um agente que saiu da
 * memória vira `unknown`, para a sessão não ficar `waiting` para sempre.
 * @param {Context} ctx
 * @param {number} ts
 * @returns {boolean}                    true se algum agente saiu
 */
function prune(ctx, ts) {
  const { session } = ctx;
  if (!pruneAgents(session)) return false;
  resolveApprovals(session, (approval) => !session.agents.has(approval.agentKey), INFERRED, ts, ctx.out);
  return true;
}

/**
 * Cria o evento canônico já numerado pelo `sequence` e congelado, e o guarda
 * no feed, se for do feed. O mesmo objeto vai para o retorno de `apply` ou
 * `tick` e nunca mais muda.
 * @param {Context} ctx
 * @param {string|null} agentKey
 * @param {EventKind} kind
 * @param {Record<string, unknown>} data
 * @param {number} ts
 */
function emit(ctx, agentKey, kind, data, ts) {
  const { seq, id } = ctx.state.sequence.next();
  /** @type {CanonicalEvent} */
  const event = Object.freeze({ id, seq, ts, sessionId: ctx.session.id, agentKey, kind, data: Object.freeze(data) });
  ctx.events.push(event);
  pushFeed(ctx.session, event);
}
