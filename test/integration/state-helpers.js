// Ajudantes dos testes de integração do estado (tester, T7). Não é arquivo de
// teste (não termina em .test.js).
//
// Independentes dos ajudantes do dev (test/unit/server/domain/state/scenarios.js):
// os cenários são montados aqui, a partir da documentação dos hooks
// (docs/pesquisa/hooks-claude-code.md) e do modelo de eventos (seções 2 a 9),
// e cada evento passa pelo normalizador real (envelope v1 → fato) antes do
// reducer. Todos os cenários são SINTÉTICOS: quando as fixtures do T0 chegarem,
// as conferências genéricas (`checkSession`, `Tracker`) valem para elas também.
//
// Nomes, pastas e ids são fictícios (o repositório é público).

import assert from 'node:assert/strict';
import { AGENT_STATUS, EVENT_KINDS, FEED_KINDS, PHASES, QUEST_STATUS, ROLES, SESSION_STATUS, TOOL_CATEGORIES } from '../../shared/contract.js';
import { normalize } from '../../server/domain/normalize.js';
import { redact } from '../../server/domain/redact.js';
import { apply, createState, getSessionState, getSessionStates, setAgentNames, tick } from '../../server/domain/state/index.js';

export const HOME = 'C:\\Users\\beltrana';
export const PROJECT = `${HOME}\\Codigo\\agents-quest`;
export const OTHER_PROJECT = 'E:\\Clientes\\Padaria-Exemplo';

/** Instante zero dos cenários (ms desde a época). */
export const T0 = 1_790_000_000_000;

export const MIN = 60_000;

// ---------------------------------------------------------------------------
// Ids fictícios, na forma dos reais
// ---------------------------------------------------------------------------

/** session_id: UUID v4 fictício. */
export const sessionId = (n) => `5e5a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Subagente: `{ id, type }`, com o id como os reais (`a` + 16 hexadecimais). */
export const agent = (n, type) => ({ id: `a${(0xa9e00000 + n).toString(16).padStart(16, '0')}`, type });

/** tool_use_id na forma dos reais (`toolu_01` + 22 caracteres). */
export const toolUseId = (n) => `toolu_01Tst${String(n).padStart(19, '0')}`;

// ---------------------------------------------------------------------------
// Cenários: lista de { at, env, payload }, com `at` em ms desde T0
// ---------------------------------------------------------------------------

/** prompt_id fictícios, únicos no processo (V8: diferente a cada pedido). */
let promptSeq = 0;
export const promptUuid = () => `9a0e0000-0000-4000-8000-${String(++promptSeq).padStart(12, '0')}`;

/**
 * Monta um cenário. Cada método acrescenta um evento no instante `at`.
 * Com `promptIds` (padrão), cada pedido ganha um `prompt_id` novo, que vai em
 * todos os eventos seguintes da mesma sessão, inclusive dos subagentes (V8).
 * @param {{ session?: string, projectDir?: string|null, entrypoint?: string|null, promptIds?: boolean }} [options]
 */
export function script({ session = sessionId(1), projectDir = PROJECT, entrypoint = 'cli', promptIds = true } = {}) {
  const events = [];
  let calls = 0;
  let current = { session, projectDir, entrypoint };
  const promptOf = new Map();

  const s = {
    events,
    /** Troca a sessão (e o projeto) dos próximos eventos. */
    use(options) {
      current = { ...current, ...options };
      return s;
    },
    /** prompt_id atual da sessão corrente (ou null). */
    promptId() {
      return promptOf.get(current.session) ?? null;
    },
    hook(at, name, fields = {}, who = null) {
      const payload = {
        session_id: current.session,
        transcript_path: `${HOME}\\.claude\\projects\\C--Users-beltrana-Codigo\\${current.session}.jsonl`,
        cwd: current.projectDir,
        permission_mode: 'default',
        hook_event_name: name,
        ...(promptIds && promptOf.has(current.session) ? { prompt_id: promptOf.get(current.session) } : {}),
        ...fields,
      };
      if (payload.prompt_id === undefined) delete payload.prompt_id;
      if (who) {
        if (who.id !== undefined) payload.agent_id = who.id;
        if (who.type !== undefined) payload.agent_type = who.type;
      }
      events.push({ at, env: { projectDir: current.projectDir, entrypoint: current.entrypoint }, payload });
      return s;
    },
    sessionStart(at, source = 'startup', extra = {}) {
      return s.hook(at, 'SessionStart', { source, model: 'claude-opus-5-5', ...extra });
    },
    sessionEnd(at, reason = 'prompt_input_exit') {
      return s.hook(at, 'SessionEnd', { reason });
    },
    /** Pedido. `extra.prompt_id` fixa o id (ou `undefined` para não mandar nenhum). */
    prompt(at, text = 'Pedido fictício', extra = {}) {
      if (promptIds) {
        const id = 'prompt_id' in extra ? extra.prompt_id : promptUuid();
        if (id === undefined || id === null) promptOf.delete(current.session);
        else promptOf.set(current.session, id);
      }
      return s.hook(at, 'UserPromptSubmit', { prompt: text, ...extra });
    },
    /** Chamada de ferramenta, ainda sem evento. */
    call(tool, input, who = null) {
      return { id: toolUseId(++calls + (current.callBase ?? 0)), tool, input, who };
    },
    /** Chamada `Agent`, ainda sem evento. */
    delegation(type, description, { who = null, background = false, tool = 'Agent' } = {}) {
      const input = { description, prompt: `PEDIDO-COMPLETO-DO-AGENTE ${description}`, subagent_type: type };
      if (background) input.run_in_background = true;
      return s.call(tool, input, who);
    },
    pre(at, call) {
      return s.hook(at, 'PreToolUse', { tool_name: call.tool, tool_input: call.input, tool_use_id: call.id }, call.who);
    },
    post(at, call, response = { stdout: 'SAIDA-DO-COMANDO', stderr: '' }) {
      return s.hook(at, 'PostToolUse', { tool_name: call.tool, tool_input: call.input, tool_response: response, tool_use_id: call.id, duration_ms: 12 }, call.who);
    },
    fail(at, call, error = 'Exit code 1', { interrupt = false } = {}) {
      const fields = { tool_name: call.tool, tool_input: call.input, tool_use_id: call.id, error, duration_ms: 12 };
      if (interrupt) fields.is_interrupt = true;
      return s.hook(at, 'PostToolUseFailure', fields, call.who);
    },
    /** Pre e Post de uma ferramenta comum, `gap` ms depois. */
    tool(at, tool, input, who = null, gap = 15) {
      const c = s.call(tool, input, who);
      s.pre(at, c);
      s.post(at + gap, c);
      return c;
    },
    /** Post do `Agent` em primeiro plano, quando o subagente devolve. */
    returned(at, call, sub, { withAgentId = true } = {}) {
      const response = { status: 'completed', content: [{ type: 'text', text: 'RESPOSTA-DO-SUBAGENTE' }], totalToolUseCount: 3 };
      if (withAgentId) response.agentId = sub.id;
      return s.post(at, call, response);
    },
    /** Post do `Agent` em segundo plano, logo no lançamento. */
    launched(at, call, sub) {
      return s.post(at, call, { status: 'async_launched', agentId: sub.id, description: call.input.description, prompt: 'PEDIDO-COMPLETO-DO-AGENTE' });
    },
    start(at, who) {
      return s.hook(at, 'SubagentStart', {}, who);
    },
    stopAgent(at, who) {
      return s.hook(at, 'SubagentStop', {
        stop_hook_active: false,
        agent_transcript_path: `${HOME}\\.claude\\projects\\C--Users-beltrana-Codigo\\${current.session}\\subagents\\agent-${who.id}.jsonl`,
        last_assistant_message: 'TEXTO-DO-ASSISTENTE',
      }, who);
    },
    /** PermissionRequest (sem tool_use_id, como o hook real) para uma chamada. */
    permissionRequest(at, call, who = call.who) {
      return s.hook(at, 'PermissionRequest', { tool_name: call.tool, tool_input: call.input, permission_suggestions: [] }, who);
    },
    /** PermissionDenied (modo automático) de uma chamada. */
    permissionDenied(at, call) {
      return s.hook(at, 'PermissionDenied', { tool_name: call.tool, tool_input: call.input, tool_use_id: call.id }, call.who);
    },
    notice(at, type, who = null) {
      return s.hook(at, 'Notification', { message: 'MENSAGEM-DO-AVISO', notification_type: type }, who);
    },
    preCompact(at, trigger = 'auto', who = null) {
      return s.hook(at, 'PreCompact', { trigger, custom_instructions: 'INSTRUCOES-PRIVADAS' }, who);
    },
    postCompact(at, trigger = 'auto', who = null) {
      return s.hook(at, 'PostCompact', { trigger, compact_summary: 'RESUMO-PRIVADO' }, who);
    },
    /** Comando de teste que passa (Post) ou falha (Failure), com o texto de saída dado. */
    testRun(at, command, { who = null, ok = true, output = '', interrupt = false } = {}) {
      const c = s.call('Bash', { command, description: 'Rodar os testes' }, who);
      s.pre(at, c);
      if (ok) s.post(at + 50, c, { stdout: output, stderr: '', interrupted: false });
      else s.fail(at + 50, c, `Exit code 1\n${output}`, { interrupt });
      return c;
    },
    stop(at, backgroundTasks = []) {
      return s.hook(at, 'Stop', { stop_hook_active: false, last_assistant_message: 'TEXTO-DO-ASSISTENTE', background_tasks: backgroundTasks });
    },
    stopFailure(at, error = 'rate_limit') {
      return s.hook(at, 'StopFailure', { error, error_details: 'DETALHE-DO-ERRO', last_assistant_message: 'TEXTO-DO-ASSISTENTE' });
    },
  };
  return s;
}

/** Cenário no formato do ADR 0010 (`dt` desde o evento anterior), para o injetor. */
export function toFixture(name, description, events) {
  let previous = null;
  return {
    name,
    description: `SINTÉTICO: ${description}`,
    events: events.map(({ at, env, payload }) => {
      const dt = previous === null ? 0 : Math.max(0, at - previous);
      previous = at;
      return { dt, env, payload };
    }),
  };
}

// ---------------------------------------------------------------------------
// Execução: envelope v1 → normalize → apply
// ---------------------------------------------------------------------------

/** Nomes de `.claude/agents/` que `play` entrega a cada estado (simula a ligação do T9a). */
const agentNamesOf = new WeakMap();

/**
 * Estado novo. `agentNames`: o que o leitor de `.claude/agents/` devolveria;
 * `play` os entrega por `setAgentNames` a cada projeto novo (`newProjects`),
 * como a ligação faz depois do `read` assíncrono. Os testes nunca leem o disco.
 */
export function newState({ agentNames = null, ...options } = {}) {
  const state = createState(options);
  if (agentNames !== null) agentNamesOf.set(state, agentNames);
  return state;
}

/** Envelope v1 de um evento do cenário (sentAt = instante do evento). */
export function envelopeOf(item) {
  return { v: 1, sentAt: T0 + item.at, forwarder: '0.1.0', env: item.env, truncated: false, payload: item.payload };
}

/**
 * Passa os eventos pelo normalizador real e pelo reducer, na ordem da lista.
 * O `sentAt` é o instante do evento (`at`); a chegada (`now`) é `arrive`, se
 * houver, senão `at`.
 */
export function play(list, { state = newState(), tracker = null } = {}) {
  const steps = [];
  const events = [];
  let last = null;
  for (const item of list) {
    const receivedAt = T0 + (item.arrive ?? item.at);
    const fact = normalize(envelopeOf(item), { receivedAt, homeDir: HOME });
    const result = fact ? apply(state, fact, receivedAt) : { events: [], changed: [], newProjects: [] };
    tracker?.consume(result.events, fact);
    const names = agentNamesOf.get(state);
    const rosterChanged = [];
    if (names !== undefined) for (const project of result.newProjects ?? []) rosterChanged.push(...setAgentNames(state, project, names).changed);
    steps.push({ item, fact, events: result.events, changed: result.changed, newProjects: result.newProjects, rosterChanged });
    events.push(...result.events);
    last = receivedAt;
  }
  return { state, steps, events, last };
}

/** Sessão com feed (snapshot). */
export function view(state, id = sessionId(1)) {
  return getSessionState(state, id, { feed: true });
}

/** Sessão sem o feed, para comparar estados. */
export function withoutFeed(session) {
  if (!session) return session;
  const { feed, ...rest } = session;
  return rest;
}

export function agentIn(session, key) {
  const found = session.agents.find((item) => item.key === key);
  assert.ok(found, `agente ${key} não está na sessão`);
  return found;
}

export const pickActivity = (activity) => {
  if (!activity) return activity;
  const { kind, category, tool, target, detail, state } = activity;
  return { kind, category, tool, target, detail, state };
};

/** `[kind, agentKey]` de cada evento. */
export const kinds = (events) => events.map((event) => [event.kind, event.agentKey]);

// ---------------------------------------------------------------------------
// Contrato (seções 3 e 9), com o T8: tickets, etapas, aprovações, bugs e compactação
// ---------------------------------------------------------------------------

/**
 * Tipos que o servidor emite a partir do T15: todos os da seção 3. O
 * `context.usage` sai só de `setContextUsage` (leitura da sonda de contexto,
 * fora do `apply`); o `apply` e o `tick` emitem os de REDUCER_KINDS.
 */
export const EMITTED_KINDS = Object.freeze([...EVENT_KINDS]);

/** Tipos que o `apply` e o `tick` emitem: todos, menos o `context.usage` (T15). */
export const REDUCER_KINDS = Object.freeze(EVENT_KINDS.filter((kind) => kind !== 'context.usage'));

/** Os 8 tipos do recorte da Primeira luz (T7). Usado para filtrar listas exatas do T7. */
export const SLICE_KINDS = Object.freeze([
  'session.started', 'session.ended', 'agent.delegated', 'agent.started',
  'agent.finished', 'tool.started', 'tool.finished', 'tool.failed',
]);

/** Tipos do T8, que não existiam no recorte. */
export const T8_KINDS = Object.freeze(REDUCER_KINDS.filter((kind) => !SLICE_KINDS.includes(kind)));

/** Só os tipos do recorte do T7 (para as listas exatas dos testes do T7). */
export const sliceOnly = (events) => events.filter((event) => SLICE_KINDS.includes(event.kind));

/** Chaves de `data` por tipo (seção 3). */
export const DATA_KEYS = Object.freeze({
  'session.started': ['source', 'projectName'],
  'session.ended': ['reason'],
  'session.idle': [],
  'quest.started': ['questId', 'n', 'title', 'implicit'],
  'quest.finished': ['questId', 'n', 'outcome', 'error', 'durationMs', 'actions'],
  'quest.phase': ['questId', 'phase', 'state'],
  'agent.delegated': ['toolUseId', 'toType', 'toRole', 'description', 'background'],
  'agent.started': ['agentType', 'role', 'label', 'parentKey'],
  'agent.finished': ['outcome'],
  'tool.started': ['toolUseId', 'tool', 'category', 'target', 'detail'],
  'tool.finished': ['toolUseId', 'tool', 'category', 'durationMs'],
  'tool.failed': ['toolUseId', 'tool', 'category', 'target', 'error', 'interrupted'],
  'test.finished': ['toolUseId', 'ok', 'passed', 'failed', 'total', 'framework'],
  'permission.requested': ['tool', 'category', 'target'],
  'permission.resolved': ['outcome', 'by'],
  'context.compacted': ['trigger'],
  'context.usage': ['pct', 'usedTokens', 'windowTokens'],
});

/** Janelas de contexto da seção 6 (T15): 200 mil, ou 1 milhão. */
export const CONTEXT_WINDOWS = Object.freeze([200_000, 1_000_000]);

/** Uso de contexto (seção 6): `pct` inteiro de 0 a 100, coerente com `usedTokens` e a janela. */
export function checkContextValue(value, label = 'context') {
  assert.ok(Number.isSafeInteger(value.usedTokens) && value.usedTokens > 0, `${label}: usedTokens ${value.usedTokens}`);
  assert.ok(CONTEXT_WINDOWS.includes(value.windowTokens), `${label}: windowTokens ${value.windowTokens}`);
  assert.ok(Number.isInteger(value.pct) && value.pct >= 0 && value.pct <= 100, `${label}: pct ${value.pct}`);
  assert.equal(value.pct, Math.min(100, Math.round((value.usedTokens / value.windowTokens) * 100)), `${label}: pct incoerente`);
  // Acima de 200 mil, a janela é sempre a de 1 milhão.
  if (value.usedTokens > 200_000) assert.equal(value.windowTokens, 1_000_000, `${label}: uso acima de 200 mil com janela de 200 mil`);
}

/** CanonicalEvent da seção 3, na ordem do typedef. */
export const EVENT_KEYS = Object.freeze(['id', 'seq', 'ts', 'sessionId', 'agentKey', 'kind', 'data']);
export const SESSION_KEYS = Object.freeze(['id', 'project', 'label', 'client', 'status', 'startedAt', 'lastEventAt', 'agents', 'roster', 'quest', 'counters', 'bugs']);
export const AGENT_KEYS = Object.freeze(['key', 'agentId', 'agentType', 'role', 'label', 'status', 'finished', 'background', 'parentKey', 'activity', 'waitingFor', 'health', 'context', 'startedAt', 'lastEventAt']);
export const ACTIVITY_KEYS = Object.freeze(['kind', 'category', 'tool', 'target', 'detail', 'state', 'at']);
export const QUEST_KEYS = Object.freeze(['id', 'n', 'title', 'implicit', 'status', 'startedAt', 'endedAt', 'phases', 'actions', 'error']);
export const TEST_RUN_KEYS = Object.freeze(['ok', 'passed', 'failed', 'total', 'framework', 'at']);

/** Eventos da sessão, sem agente (seção 3). */
const SESSION_EVENT_KINDS = new Set(['session.started', 'session.ended', 'session.idle']);

/** Campos que são ids (opacos, não passam por redact no normalizador). */
const ID_FIELDS = new Set(['id', 'key', 'sessionId', 'agentKey', 'agentId', 'parentKey', 'toolUseId', 'questId']);

const isTime = (value) => typeof value === 'number' && Number.isFinite(value);
const isText = (value) => typeof value === 'string';
const isTextOrNull = (value) => value === null || typeof value === 'string';
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isCountOrNull = (value) => value === null || isCount(value);
const sameSet = (actual, expected, label) => assert.deepEqual([...actual].sort(), [...expected].sort(), label);

/** Nenhuma chave terminada em `Key` além de `agentKey` e `parentKey` (valor cru, seção 2). */
export function checkNoRawKeys(value, where = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkNoRawKeys(item, `${where}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!/key$/i.test(key) || key === 'key' || key === 'agentKey' || key === 'parentKey', `${where}.${key}: chave interna fora do servidor`);
      assert.ok(key !== 'chained' && key !== 'partial', `${where}.${key}: campo interno do testResult fora do servidor`);
      checkNoRawKeys(item, `${where}.${key}`);
    }
  }
}

/** Todo texto exibido é ponto fixo de `redact` (seção 10). Ids ficam de fora: são opacos. */
export function checkFixedPoints(value, where = '$', field = null) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkFixedPoints(item, `${where}[${i}]`, field));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) checkFixedPoints(item, `${where}.${key}`, key);
  } else if (typeof value === 'string' && !ID_FIELDS.has(field)) {
    assert.equal(redact(value), value, `${where}: texto exibido não é ponto fixo de redact`);
  }
}

/**
 * Forma de um evento canônico (seção 3). `numbered`: exige `id` e `seq`.
 */
export function checkEvent(event, { numbered = false } = {}) {
  const keys = Object.keys(event);
  assert.deepEqual(keys, EVENT_KEYS.filter((key) => keys.includes(key)), 'chaves do evento fora da ordem da seção 3');
  for (const key of ['ts', 'sessionId', 'agentKey', 'kind', 'data']) assert.ok(keys.includes(key), `evento sem ${key}`);
  if (numbered) {
    assert.ok(Number.isInteger(event.seq), 'evento sem seq');
    assert.ok(isText(event.id) && event.id.endsWith(`:${event.seq}`), `id ${event.id} não termina com :${event.seq}`);
  }
  assert.ok(EMITTED_KINDS.includes(event.kind), `tipo fora do contrato: ${event.kind}`);
  assert.ok(isTime(event.ts), 'ts');
  assert.ok(isText(event.sessionId), 'sessionId');
  assert.equal(event.agentKey === null, SESSION_EVENT_KINDS.has(event.kind), `${event.kind}: agentKey ${event.agentKey}`);
  sameSet(Object.keys(event.data), DATA_KEYS[event.kind], `${event.kind}: chaves de data`);
  const { data } = event;
  switch (event.kind) {
    case 'agent.delegated':
      assert.ok(ROLES.includes(data.toRole) && data.toRole !== 'orq', `toRole ${data.toRole}`);
      assert.equal(typeof data.background, 'boolean');
      assert.ok(isTextOrNull(data.toType) && isTextOrNull(data.description));
      break;
    case 'agent.started':
      assert.notEqual(event.agentKey, 'main', 'agent.started do main');
      assert.ok(ROLES.includes(data.role) && data.role !== 'orq', `role ${data.role}`);
      assert.ok(isText(data.label));
      assert.ok(isTextOrNull(data.agentType) && isTextOrNull(data.parentKey));
      break;
    case 'agent.finished':
      assert.notEqual(event.agentKey, 'main', 'agent.finished do main (o orquestrador nunca termina)');
      assert.ok(['done', 'unknown'].includes(data.outcome), `outcome ${data.outcome}`);
      break;
    case 'tool.started':
    case 'tool.finished':
    case 'tool.failed':
      assert.ok(TOOL_CATEGORIES.includes(data.category), `categoria ${data.category}`);
      if (event.kind === 'tool.failed') assert.equal(typeof data.interrupted, 'boolean');
      break;
    case 'quest.started':
      assert.equal(event.agentKey, 'main');
      assert.ok(isText(data.questId) && data.questId !== '');
      assert.ok(Number.isInteger(data.n) && data.n >= 1, `n ${data.n}`);
      assert.ok(isText(data.title), 'title');
      assert.equal(typeof data.implicit, 'boolean');
      break;
    case 'quest.finished':
      assert.equal(event.agentKey, 'main');
      assert.ok(['done', 'failed', 'interrupted'].includes(data.outcome), `outcome ${data.outcome}`);
      assert.ok(isTextOrNull(data.error));
      if (data.outcome !== 'failed') assert.equal(data.error, null, 'error só em failed');
      assert.ok(isCount(data.durationMs) && isCount(data.actions) && Number.isInteger(data.n) && data.n >= 1);
      break;
    case 'quest.phase':
      assert.ok(PHASES.includes(data.phase), `phase ${data.phase}`);
      assert.ok(['active', 'done'].includes(data.state), `state ${data.state}`);
      assert.notEqual(event.agentKey, 'main', 'a etapa é do agente do papel, nunca do main');
      break;
    case 'test.finished':
      assert.equal(typeof data.ok, 'boolean');
      for (const field of ['passed', 'failed', 'total']) assert.ok(isCountOrNull(data[field]), `${field} ${data[field]}`);
      assert.ok(isTextOrNull(data.framework));
      break;
    case 'permission.requested':
      assert.ok(isText(data.tool) && TOOL_CATEGORIES.includes(data.category) && isTextOrNull(data.target));
      break;
    case 'permission.resolved':
      assert.ok(['approved', 'denied', 'unknown'].includes(data.outcome), `outcome ${data.outcome}`);
      assert.ok(['user', 'auto', 'inferred'].includes(data.by), `by ${data.by}`);
      assert.deepEqual([data.outcome, data.by], { approved: ['approved', 'user'], denied: ['denied', 'auto'], unknown: ['unknown', 'inferred'] }[data.outcome]);
      break;
    case 'context.compacted':
      assert.ok([null, 'manual', 'auto'].includes(data.trigger), `trigger ${data.trigger}`);
      break;
    case 'context.usage':
      checkContextValue(data, 'context.usage');
      assert.ok(!FEED_KINDS.includes('context.usage'), 'context.usage não vai ao feed');
      break;
    default:
  }
  checkNoRawKeys(event);
  checkFixedPoints(event.data, `${event.kind}.data`);
}

/** Papéis cujo pai se pode seguir até o fim, sem ciclo. */
function checkParents(session) {
  const byKey = new Map(session.agents.map((item) => [item.key, item]));
  for (const item of session.agents) {
    if (item.parentKey === null) continue;
    assert.notEqual(item.parentKey, item.key, `${item.key}: parentKey aponta para ele mesmo`);
    // Com o limite de agentes (T7), o pai pode ter saído do `agents`.
    if (!byKey.has(item.parentKey)) continue;
    const seen = new Set([item.key]);
    let current = byKey.get(item.parentKey);
    while (current && current.parentKey !== null) {
      assert.ok(!seen.has(current.key), `${item.key}: ciclo de parentKey em ${current.key}`);
      seen.add(current.key);
      current = byKey.get(current.parentKey);
    }
  }
}

/** QuestState da seção 9. */
function checkQuest(quest) {
  sameSet(Object.keys(quest), QUEST_KEYS, 'chaves do quest');
  assert.ok(isText(quest.id) && quest.id !== '');
  assert.ok(Number.isInteger(quest.n) && quest.n >= 1);
  assert.ok(isText(quest.title));
  assert.equal(typeof quest.implicit, 'boolean');
  assert.ok(QUEST_STATUS.includes(quest.status), `status do quest ${quest.status}`);
  assert.ok(isTime(quest.startedAt));
  const ended = ['done', 'failed', 'interrupted'].includes(quest.status);
  assert.equal(quest.endedAt !== null, ended, `endedAt ${quest.endedAt} com status ${quest.status}`);
  if (ended) assert.ok(quest.endedAt >= quest.startedAt, 'endedAt antes do startedAt');
  sameSet(Object.keys(quest.phases), PHASES, 'etapas');
  for (const value of Object.values(quest.phases)) assert.ok(['pending', 'active', 'done'].includes(value), `etapa ${value}`);
  assert.ok(isCount(quest.actions));
  assert.ok(isTextOrNull(quest.error));
  if (quest.status !== 'failed') assert.equal(quest.error, null, 'error só em failed');
}

/**
 * Forma do SessionState (seção 9) e invariantes do estado, com o T8:
 * `pendingApprovals` nunca negativo e coerente com os agentes `waiting`;
 * `bugs.open` coerente com o `lastRun`.
 */
export function checkSession(session, { feed = null } = {}) {
  const keys = Object.keys(session);
  sameSet(keys.filter((key) => key !== 'feed'), SESSION_KEYS, 'chaves da sessão');
  if (feed === true) assert.ok(keys.includes('feed'), 'snapshot sem feed');
  if (feed === false) assert.ok(!keys.includes('feed'), 'update com feed');
  assert.ok(isText(session.id));
  sameSet(Object.keys(session.project), ['key', 'name', 'dir'], 'chaves de project');
  for (const value of Object.values(session.project)) assert.ok(isText(value), 'project com valor que não é texto');
  assert.ok(isText(session.label) && session.label !== '', 'label vazio');
  assert.ok([null, 'terminal', 'vscode'].includes(session.client), `client ${session.client}`);
  assert.ok(SESSION_STATUS.includes(session.status), `status ${session.status}`);
  assert.ok(isTime(session.startedAt) && isTime(session.lastEventAt) && session.startedAt <= session.lastEventAt, 'horas da sessão');
  if (session.quest !== null) checkQuest(session.quest);

  sameSet(Object.keys(session.counters), ['questsDone', 'bugsCrushed', 'pendingApprovals'], 'chaves de counters');
  for (const value of Object.values(session.counters)) assert.ok(isCount(value), `contador ${value}`);
  const waiting = session.agents.filter((item) => item.status === 'waiting');
  assert.ok(session.counters.pendingApprovals >= waiting.length, 'pendingApprovals menor que os agentes aguardando');
  assert.equal(session.counters.pendingApprovals > 0, waiting.length > 0, 'pendingApprovals sem agente aguardando, ou o contrário');
  if (session.status !== 'ended') assert.equal(session.status === 'waiting', session.counters.pendingApprovals > 0, 'status waiting só com aprovação pendente');

  sameSet(Object.keys(session.bugs), ['open', 'lastRun'], 'chaves de bugs');
  assert.ok(isCount(session.bugs.open), `bugs.open ${session.bugs.open}`);
  const run = session.bugs.lastRun;
  if (run === null) {
    assert.equal(session.bugs.open, 0, 'bugs sem nenhum run');
  } else {
    sameSet(Object.keys(run), TEST_RUN_KEYS, 'chaves do lastRun');
    assert.equal(typeof run.ok, 'boolean');
    for (const field of ['passed', 'failed', 'total']) assert.ok(isCountOrNull(run[field]));
    assert.ok(isTextOrNull(run.framework) && isTime(run.at));
    assert.equal(session.bugs.open, run.ok ? 0 : run.failed ?? 1, 'bugs.open incoerente com o lastRun');
  }

  assert.ok(Array.isArray(session.roster) && session.roster[0] === 'orq', 'roster começa com orq');
  assert.deepEqual(session.roster, ROLES.filter((role) => session.roster.includes(role)), 'roster na ordem de ROLES, sem repetição');
  const roles = new Set(session.agents.map((item) => item.role));
  for (const role of roles) assert.ok(session.roster.includes(role), `papel ${role} fora do roster`);
  assert.equal(session.roster.includes('aux'), roles.has('aux'), 'aux no roster só com convidado');

  assert.equal(session.agents[0]?.key, 'main', 'main primeiro');
  const seen = new Set();
  for (const item of session.agents) {
    sameSet(Object.keys(item), AGENT_KEYS, `chaves do agente ${item.key}`);
    assert.ok(!seen.has(item.key), `agente repetido ${item.key}`);
    seen.add(item.key);
    const main = item.key === 'main';
    assert.equal(item.agentId, main ? null : item.key, `agentId de ${item.key}`);
    assert.equal(item.role === 'orq', main, `papel de ${item.key}: ${item.role}`);
    assert.ok(ROLES.includes(item.role));
    assert.ok(isTextOrNull(item.agentType) && isText(item.label));
    assert.ok(AGENT_STATUS.includes(item.status), `status ${item.status}`);
    assert.equal(typeof item.finished, 'boolean');
    assert.equal(typeof item.background, 'boolean');
    if (main) assert.equal(item.finished, false, 'main encerrado');
    if (item.finished) assert.equal(item.status, 'idle', `${item.key} encerrado e ${item.status}`);
    assert.ok(isTextOrNull(item.parentKey));
    if (main) assert.equal(item.parentKey, null);
    assert.equal(item.waitingFor !== null, item.status === 'waiting', `${item.key}: waitingFor e status`);
    if (item.waitingFor !== null) {
      sameSet(Object.keys(item.waitingFor), ['tool', 'category', 'target'], 'chaves de waitingFor');
      assert.ok(isText(item.waitingFor.tool) && TOOL_CATEGORIES.includes(item.waitingFor.category) && isTextOrNull(item.waitingFor.target));
    }
    if (item.context !== null) {
      sameSet(Object.keys(item.context), ['pct', 'usedTokens', 'windowTokens', 'at'], `${item.key}: chaves de context`);
      checkContextValue(item.context, `${item.key}.context`);
      assert.ok(isTime(item.context.at), `${item.key}: context.at`);
    }
    sameSet(Object.keys(item.health), ['ok', 'total'], 'chaves de health');
    assert.ok(Number.isInteger(item.health.ok) && Number.isInteger(item.health.total));
    assert.ok(item.health.ok >= 0 && item.health.ok <= item.health.total && item.health.total <= 10, `health ${JSON.stringify(item.health)}`);
    assert.ok(isTime(item.startedAt) && isTime(item.lastEventAt) && item.startedAt <= item.lastEventAt, `horas de ${item.key}`);
    const { activity } = item;
    if (activity !== null) {
      sameSet(Object.keys(activity), ACTIVITY_KEYS, 'chaves de activity');
      assert.ok(['tool', 'delegate', 'start', 'compact'].includes(activity.kind), `atividade ${activity.kind}`);
      assert.ok(['running', 'done', 'failed'].includes(activity.state));
      assert.ok(isTime(activity.at));
      assert.equal(activity.category === null, activity.kind !== 'tool', `categoria da atividade ${activity.kind}`);
      if (activity.category !== null) assert.ok(TOOL_CATEGORIES.includes(activity.category));
      if (activity.kind === 'delegate') assert.ok(['Agent', 'Task'].includes(activity.tool), `delegate com tool ${activity.tool}`);
      if (activity.kind === 'start') assert.deepEqual(pickActivity(activity), { kind: 'start', category: null, tool: null, target: null, detail: null, state: 'running' });
      if (activity.kind === 'compact') {
        assert.equal(activity.tool, null);
        assert.equal(activity.target, null);
        assert.ok([null, 'manual', 'auto'].includes(activity.detail), `compact com detail ${activity.detail}`);
      }
      for (const field of ['tool', 'target', 'detail']) assert.ok(isTextOrNull(activity[field]));
    }
  }
  checkParents(session);
  if (keys.includes('feed')) {
    assert.ok(Array.isArray(session.feed) && session.feed.length <= 200, `feed com ${session.feed?.length}`);
    for (const event of session.feed) {
      assert.ok(FEED_KINDS.includes(event.kind), `${event.kind} no feed`);
      if (event.kind === 'quest.phase') assert.equal(event.data.state, 'done', 'quest.phase active no feed');
      assert.equal(event.sessionId, session.id);
    }
  }
  checkNoRawKeys(session);
  checkFixedPoints(session);
  // `key` é pulado acima por ser o nome dos ids dos agentes; o do projeto é um caminho exibido.
  assert.equal(redact(session.project.key), session.project.key, 'project.key não é ponto fixo de redact');
}

/** Todas as sessões do estado. */
export function checkState(state) {
  for (const session of getSessionStates(state, { feed: true })) checkSession(session, { feed: true });
}

// ---------------------------------------------------------------------------
// Invariantes do fluxo de eventos (acompanham vários `apply` e `tick`)
// ---------------------------------------------------------------------------

/**
 * Confere, evento a evento:
 * - `agent.started` uma vez por instância, antes de qualquer outro evento dela;
 * - entre dois `agent.finished` da mesma instância há um `tool.started` ou um
 *   `agent.delegated` dela (volta depois da inferência de 15 min, ponto 8);
 * - `tool.started` no máximo uma vez por `toolUseId`, e `tool.finished` ou
 *   `tool.failed` no máximo uma vez, depois do `tool.started` da mesma chamada
 *   e do mesmo agente;
 * - `agent.delegated` no máximo uma vez por `toolUseId`, que nunca é também
 *   de um `tool.started`;
 * - `session.ended` não se repete sem um `session.started` no meio, e
 *   `session.idle` não sai depois dele;
 * - T8: `quest.started` com `n` crescente de 1 em 1 por sessão; `quest.finished`
 *   e `quest.phase` só de ticket que começou; `test.finished` no máximo uma
 *   vez por chamada, depois do `tool.started` dela, no mesmo agente;
 *   `permission.resolved` que não é `denied` só com pedido pendente do agente
 *   (o número de pendentes nunca fica negativo);
 * - o evento é da sessão do fato que o gerou.
 */
export class Tracker {
  constructor({ numbered = false } = {}) {
    this.numbered = numbered;
    this.sessions = new Map();
    this.count = 0;
  }

  #session(id) {
    let entry = this.sessions.get(id);
    if (!entry) {
      entry = { started: new Set(), finished: new Map(), tools: new Map(), delegated: new Set(), ended: false, questN: 0, quests: new Set(), tests: new Set(), pending: new Map() };
      this.sessions.set(id, entry);
    }
    return entry;
  }

  /** `source`: `reducer` (apply e tick) ou `context` (setContextUsage, T15). */
  consume(events, fact = null, { source = 'reducer' } = {}) {
    for (const event of events) {
      checkEvent(event, { numbered: this.numbered });
      assert.equal(event.kind === 'context.usage', source === 'context', `${event.kind} saiu de ${source}: context.usage só sai de setContextUsage`);
      if (fact) assert.equal(event.sessionId, fact.sessionId, 'evento em outra sessão que a do fato');
      const s = this.#session(event.sessionId);
      const who = event.agentKey;
      if (who !== null && who !== 'main' && event.kind !== 'agent.started' && !s.started.has(who)) {
        // Agente removido pelo limite e depois esquecido pelas lápides pode reaparecer só com eventos de permissão.
        assert.fail(`${event.kind} de ${who} antes do agent.started`);
      }
      const id = event.data.toolUseId;
      switch (event.kind) {
        case 'agent.started':
          assert.ok(!s.started.has(who), `agent.started repetido para ${who}`);
          s.started.add(who);
          break;
        case 'agent.finished':
          assert.notEqual(s.finished.get(who), true, `agent.finished repetido para ${who} sem voltar a trabalhar`);
          s.finished.set(who, true);
          break;
        case 'tool.started':
          if (id !== null) {
            assert.ok(!s.tools.has(id), `tool.started repetido para ${id}`);
            assert.ok(!s.delegated.has(id), `${id} já era uma delegação`);
            s.tools.set(id, { agentKey: who, closed: false, category: event.data.category });
          }
          s.finished.set(who, false);
          break;
        case 'tool.finished':
        case 'tool.failed':
          if (id !== null) {
            const call = s.tools.get(id);
            assert.ok(call, `${event.kind} de ${id} sem tool.started`);
            assert.equal(call.agentKey, who, `${event.kind} de ${id} em outro agente`);
            assert.ok(!call.closed, `${event.kind} repetido para ${id}`);
            call.closed = true;
          }
          break;
        case 'test.finished':
          if (id !== null) {
            const call = s.tools.get(id);
            assert.ok(call, `test.finished de ${id} sem tool.started`);
            assert.equal(call.agentKey, who, `test.finished de ${id} em outro agente`);
            assert.equal(call.category, 'test', `test.finished de ${id} numa chamada ${call.category}`);
            assert.ok(!s.tests.has(id), `test.finished repetido para ${id}`);
            s.tests.add(id);
          }
          break;
        case 'agent.delegated':
          if (id !== null) {
            assert.ok(!s.delegated.has(id), `agent.delegated repetido para ${id}`);
            assert.ok(!s.tools.has(id), `${id} já era uma ferramenta`);
            s.delegated.add(id);
          }
          s.finished.set(who, false);
          break;
        case 'quest.started':
          assert.equal(event.data.n, s.questN + 1, `quest.started com n ${event.data.n} depois de ${s.questN}`);
          s.questN = event.data.n;
          s.quests.add(event.data.questId);
          break;
        case 'quest.finished':
        case 'quest.phase':
          assert.ok(s.quests.has(event.data.questId), `${event.kind} de um ticket que não começou: ${event.data.questId}`);
          break;
        case 'permission.requested': {
          const [lo, hi] = s.pending.get(who) ?? [0, 0];
          s.pending.set(who, [lo + 1, hi + 1]);
          break;
        }
        case 'permission.resolved': {
          // Pendentes possíveis do agente, entre um mínimo e um máximo: o `denied`
          // sai mesmo sem pedido pendente (seção 4), e pode ou não resolver um.
          const [lo, hi] = s.pending.get(who) ?? [0, 0];
          if (event.data.outcome === 'denied') {
            s.pending.set(who, [Math.max(0, lo - 1), hi]);
          } else {
            assert.ok(hi > 0, `permission.resolved(${event.data.outcome}) de ${who} sem pedido pendente`);
            s.pending.set(who, [Math.max(0, lo - 1), hi - 1]);
          }
          break;
        }
        case 'session.started':
          s.ended = false;
          break;
        case 'session.ended':
          assert.ok(!s.ended, 'session.ended repetido');
          s.ended = true;
          break;
        case 'session.idle':
          assert.ok(!s.ended, 'session.idle depois do session.ended');
          break;
        default:
      }
      this.count++;
    }
  }

  /** Sessões que saíram da memória começam do zero se voltarem. */
  removed(ids) {
    for (const id of ids) this.sessions.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Aleatoriedade determinística
// ---------------------------------------------------------------------------

/** Gerador mulberry32: mesma semente, mesma sequência. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (random, list) => list[Math.floor(random() * list.length)];

/** Fisher-Yates com o gerador dado. */
export function shuffle(random, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Chegada com atraso aleatório de até `windowMs` por evento: dois eventos a
 * menos de `windowMs` um do outro podem trocar de ordem; a mais disso, nunca.
 * O `sentAt` continua o instante do evento; a chegada vira o `now`.
 */
export function jitterOrder(list, random, windowMs = 200) {
  return list
    .map((item, i) => ({ ...item, arrive: item.at + random() * windowMs, i }))
    .sort((a, b) => a.arrive - b.arrive || a.i - b.i);
}

/**
 * Janelas fixas de `windowMs` (com a grade deslocada ao acaso) e ordem
 * embaralhada dentro de cada janela. A chegada é o fim da janela.
 */
export function windowOrder(list, random, windowMs = 200) {
  const offset = random() * windowMs;
  const groups = new Map();
  for (const item of list) {
    const w = Math.floor((item.at + offset) / windowMs);
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(item);
  }
  const out = [];
  for (const [w, items] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const arrive = (w + 1) * windowMs - offset;
    for (const item of shuffle(random, items)) out.push({ ...item, arrive: Math.max(arrive, item.at) });
  }
  return out;
}

/** Caminhos (com valores) em que dois valores JSON diferem. */
export function diffPaths(a, b, where = '$', out = []) {
  if (Object.is(a, b)) return out;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${where}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) diffPaths(a[key], b[key], Array.isArray(a) ? `${where}[${key}]` : `${where}.${key}`, out);
  return out;
}

// ---------------------------------------------------------------------------
// Gerador de envelopes aleatórios (fuzz)
// ---------------------------------------------------------------------------

const HOOKS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact'];
const SECRET = `ghp_${'Q'.repeat(36)}`;
const TYPES = ['tester', 'dev-backend', 'arquiteto', 'documentador', 'Explore', 'general-purpose', 'plugin:tester', 'auth:tester', 'revisor', '', '   ', null, 42, SECRET, `\x1b[ghp_${'Q'.repeat(36)}`, 'tes\x1b[0mter', 'password=hunter2', 'x'.repeat(200), 'tes\u200Bter', '<b>tester</b>'];
const TOOLS = ['Read', 'Bash', 'Agent', 'Task', 'Edit', 'Grep', 'Write', 'WebFetch', 'TodoWrite', 'Skill', 'PowerShell', 'mcp__srv__tool', `mcp__${SECRET}__x`, 'Desconhecida', '', null, 7];
const PATHS = [`${PROJECT}\\a.js`, 'c:/users/BELTRANA/codigo/agents-quest/b.js', '\\\\?\\C:\\x.js', '/c/Users/beltrana/y', '\\\\srv\\share\\z', 'relativo/w.js', '', null, `${PROJECT}\\${'x'.repeat(400)}`, `${HOME}\\.ssh\\id_rsa`];
const DIRS = [PROJECT, OTHER_PROJECT, 'c:\\users\\beltrana\\codigo\\agents-quest\\', '\\\\?\\C:\\Users\\beltrana', '\\\\srv\\share\\p', '/c/Users/beltrana/p', '/home/beltrana/p', '', null, 42, 'C:\\', 'D:', `C:\\proj\\${SECRET}`, `C:\\${'p'.repeat(1100)}`];
const TEXTS = ['Testar a ingestão', `token=${SECRET}`, 'curl -u admin:hunter2 http://x', 'PEDIDO-COMPLETO', '', null, 'a\nb', 'x'.repeat(5000), '/review agora', '<task-notification>fim</task-notification>'];
/** Ids inválidos: ids são opacos (não passam por redact), então nunca carregam o segredo de teste. */
const BAD_IDS = [null, 42, '', '   ', 'x y', {}, [], 'a\u0000b', 'x'.repeat(200), 'main'];
/** Comandos de teste (T6), inclusive cadeias && e teste no meio, e resumos do node:test. */
const COMMANDS = ['npm test', 'node --test', 'npm run build && npm test', 'npm test; echo fim', 'npx vitest run', 'git status'];
const SUMMARIES = ['ℹ tests 5\nℹ pass 3\nℹ fail 2', 'ℹ tests 4\nℹ pass 4\nℹ fail 0', 'Tests:  1 failed, 2 passed, 3 total', 'nada reconhecido'];
const FUZZ_PROMPTS = ['9a0e0000-0000-4000-8000-0000000fa001', '9a0e0000-0000-4000-8000-0000000fa002', '9a0e0000-0000-4000-8000-0000000fa003', '9a0e0000-0000-4000-8000-0000000fa004'];
export const FORBIDDEN = ['QQQQQQQQQQQQ', 'hunter2', 'PEDIDO-SECRETO', 'SAIDA-SECRETA', 'TEXTO-DO-ASSISTENTE', 'CONTEUDO-SECRETO', '\x1b'];

function randomValue(random, depth = 0) {
  const r = random();
  if (depth > 3 || r < 0.2) return pick(random, [null, true, false, 0, -1, 1.5, 1e308, '', 'x', SECRET]);
  if (r < 0.4) return Math.floor(random() * 1e6) - 1000;
  if (r < 0.6) return pick(random, TEXTS);
  if (r < 0.8) return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
  const out = {};
  for (let i = Math.floor(random() * 4); i > 0; i--) out[pick(random, ['a', 'id', 'agentId', 'status', 'content', 'stdout', '__proto__', 'constructor'])] = randomValue(random, depth + 1);
  return out;
}

/** tool_use_id do fuzz (poucos, para as chamadas se repetirem entre Pre, Post e Failure). */
export const FUZZ_CALLS = Object.freeze(Array.from({ length: 10 }, (_, i) => `toolu_01Fz${String(i).padStart(18, '0')}`));

/** Nome de ferramenta fixo por chamada, como no Claude Code: Pre, Post e Failure da mesma chamada têm o mesmo `tool_name`. */
export function fuzzTools(random) {
  return new Map(FUZZ_CALLS.map((id) => [id, pick(random, TOOLS)]));
}

/**
 * Envelope aleatório. Com `toolFor` (de `fuzzTools`), o `tool_name` de uma
 * chamada do conjunto FUZZ_CALLS é sempre o mesmo; sem ele, cada evento sorteia
 * o nome (incoerente, para o teste do achado A4).
 */
export function randomEnvelope(random, now, { toolFor = null } = {}) {
  const sessions = [sessionId(701), sessionId(702), sessionId(703)];
  const agents = [agent(701).id, agent(702).id, agent(703).id, agent(704).id, agent(705).id, agent(706).id];
  const payload = {};
  const maybe = (p, fn) => { if (random() < p) fn(); };
  maybe(0.98, () => { payload.hook_event_name = random() < 0.97 ? pick(random, HOOKS) : randomValue(random); });
  maybe(0.98, () => { payload.session_id = random() < 0.97 ? pick(random, sessions) : pick(random, BAD_IDS); });
  maybe(0.55, () => { payload.agent_id = random() < 0.95 ? pick(random, agents) : pick(random, BAD_IDS); });
  maybe(0.7, () => { payload.agent_type = pick(random, TYPES); });
  maybe(0.8, () => { payload.tool_name = pick(random, TOOLS); });
  maybe(0.9, () => { payload.tool_use_id = random() < 0.9 ? pick(random, FUZZ_CALLS) : pick(random, BAD_IDS); });
  if (toolFor?.has(payload.tool_use_id)) payload.tool_name = toolFor.get(payload.tool_use_id);
  maybe(0.8, () => {
    payload.tool_input = random() < 0.85
      ? {
        file_path: pick(random, PATHS), command: random() < 0.5 ? pick(random, COMMANDS) : pick(random, TEXTS), description: pick(random, TEXTS), subagent_type: pick(random, TYPES),
        run_in_background: random() < 0.25, pattern: pick(random, TEXTS), url: pick(random, ['https://u:p@h.example/x', 'nada', null]),
        prompt: 'PEDIDO-SECRETO', content: 'CONTEUDO-SECRETO', old_string: 'CONTEUDO-SECRETO',
      }
      : randomValue(random);
  });
  maybe(0.6, () => {
    payload.tool_response = random() < 0.8
      ? { agentId: pick(random, [...agents, null, 42, 'main']), status: pick(random, ['completed', 'async_launched', 'x', null]), stdout: `SAIDA-SECRETA
${pick(random, SUMMARIES)}` }
      : randomValue(random);
  });
  maybe(0.4, () => {
    payload.background_tasks = random() < 0.8
      ? Array.from({ length: Math.floor(random() * 4) }, () => ({ id: pick(random, [...agents, 'bash_1', null]), type: 'local_agent', status: pick(random, ['running', 'completed', 'failed', 'killed', null, 'x']), agent_type: pick(random, TYPES) }))
      : randomValue(random);
  });
  maybe(0.3, () => { payload.source = pick(random, ['startup', 'resume', 'clear', 'compact', 'fork', 'x', null]); });
  maybe(0.3, () => { payload.reason = pick(random, ['clear', 'logout', 'other', 'x']); });
  maybe(0.3, () => { payload.prompt = pick(random, TEXTS); });
  maybe(0.6, () => { payload.prompt_id = random() < 0.9 ? pick(random, FUZZ_PROMPTS) : pick(random, BAD_IDS); });
  maybe(0.15, () => { payload.trigger = pick(random, ['manual', 'auto', 'x', null]); });
  maybe(0.2, () => { payload.session_title = pick(random, TEXTS); });
  maybe(0.3, () => { payload.error = pick(random, TEXTS); });
  maybe(0.2, () => { payload.is_interrupt = random() < 0.5; });
  maybe(0.3, () => { payload.duration_ms = pick(random, [0, 12, -5, 1e12, 'x', null]); });
  maybe(0.2, () => { payload.notification_type = pick(random, ['permission_prompt', 'idle_prompt', 'auth_success', null]); });
  maybe(0.2, () => { payload.last_assistant_message = 'TEXTO-DO-ASSISTENTE'; });
  maybe(0.5, () => { payload.cwd = pick(random, DIRS); });
  maybe(0.1, () => { payload[pick(random, ['extra', 'stdout', 'content', 'agent_transcript_path'])] = randomValue(random); });
  const sentAt = random() < 0.9 ? now + Math.floor(random() * 300) - 150 : pick(random, [0, -1, Number.NaN, 1, 1e15, '123', null, now + 6 * 60 * MIN]);
  return {
    v: 1,
    sentAt,
    forwarder: '0.1.0',
    env: random() < 0.95 ? { projectDir: pick(random, DIRS), entrypoint: pick(random, ['cli', 'claude-vscode', null, 42, 'x']) } : randomValue(random),
    truncated: random() < 0.1,
    payload: random() < 0.98 ? payload : randomValue(random),
  };
}

export { apply, createState, getSessionState, getSessionStates, normalize, setAgentNames, tick };
