// SINTÉTICO: cenários de hooks para o reducer de estado (T7), no formato do
// ADR 0010 (complemento "formato e sanitização dos cenários de hooks"):
// { name, description, events: [{ dt, env, payload }] }. Os payloads seguem a
// documentação dos hooks (docs/pesquisa/hooks-claude-code.md); não são
// capturas reais. Nada daqui vai para test/fixtures/hooks/.
// Não é arquivo de teste (não termina em .test.js).
//
// Troca pelas fixtures do T0 (plano, T7, condição 2): os cenários têm os nomes
// dos cenários que o T0 grava (paralelo-mesmo-tipo, aninhado, ...), e as
// conferências genéricas (`assertAttribution`, `assertLinks`, `assertShape`)
// leem ids, tipos e descrições dos próprios payloads. Para usar uma fixture
// real, basta passar o cenário carregado por `loadFixtureScenarios()`
// (../scenarios.js) ao `run`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AGENT_STATUS, FEED_KINDS, ROLES, SESSION_STATUS, TOOL_CATEGORIES } from '../../../../../shared/contract.js';
import { normalize } from '../../../../../server/domain/normalize.js';
import { redact } from '../../../../../server/domain/redact.js';
import { LIMITS, textLine } from '../../../../../server/domain/tools.js';
import { LOCAL_RUN_ID, apply, createState, getSessionState, getSessionStates, setAgentNames } from '../../../../../server/domain/state/index.js';
import { scenarioEnvelopes } from '../scenarios.js';

/** Pasta pessoal e projetos fictícios. */
export const HOME = 'C:\\Users\\fulana';
export const PROJECT = `${HOME}\\Projetos\\agents-quest`;
export const OTHER_PROJECT = 'D:\\Trabalho\\Loja-Ficticia\\';

/** Primeiro instante dos cenários (ms). */
export const START = 1_760_000_000_000;

/** Intervalo padrão entre eventos de um cenário (ms). */
export const STEP_MS = 10;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const hex = (label, length) => createHash('sha256').update(label).digest('hex').slice(0, length);

/** UUID v4 fictício e estável para um rótulo. */
export function uuid(label) {
  const h = hex(`uuid:${label}`, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** session_id fictício. */
export const sessionId = (label) => uuid(`sessao:${label}`);

/** Subagente fictício: `{ id, type }`, com o id na forma dos reais (`a` + 16 hexadecimais). */
export const agent = (label, type) => ({ id: `a${hex(`agente:${label}`, 16)}`, type });

/** tool_use_id fictício na forma dos reais. */
function toolUseId(label) {
  const bytes = [...createHash('sha256').update(`ferramenta:${label}`).digest()].slice(0, 22);
  return `toolu_01${bytes.map((b) => BASE62[b % 62]).join('')}`;
}

/**
 * Monta um cenário. `script(b)` chama os passos na ordem de chegada ao servidor.
 * @param {string} name
 * @param {string} description
 * @param {(b: ReturnType<typeof builder>) => void} script
 * @param {{ projectDir?: string, entrypoint?: string|null, session?: string }} [options]
 */
export function scenario(name, description, script, { projectDir = PROJECT, entrypoint = 'cli', session = 'principal' } = {}) {
  const b = builder({ projectDir, entrypoint, session, prefix: name });
  script(b);
  return { name, description: `SINTÉTICO: ${description}`, synthetic: true, events: b.events };
}

function builder({ projectDir, entrypoint, session, prefix }) {
  const events = [];
  let env = { projectDir, entrypoint };
  let currentSession = sessionId(session);
  let currentPrompt = null;
  let tools = 0;
  let prompts = 0;
  let gap = 0;

  function emit(payload) {
    events.push({ dt: events.length === 0 ? 0 : STEP_MS + gap, env: { ...env }, payload });
    gap = 0;
  }

  function base(hook, who) {
    const payload = {
      session_id: currentSession,
      transcript_path: `${HOME}\\.claude\\projects\\c--Users-fulana-Projetos\\${currentSession}.jsonl`,
      cwd: env.projectDir,
      permission_mode: 'default',
      hook_event_name: hook,
    };
    if (currentPrompt) payload.prompt_id = currentPrompt;
    if (who) {
      payload.agent_id = who.id;
      if (who.type !== undefined) payload.agent_type = who.type;
    }
    return payload;
  }

  const b = {
    events,
    /** Troca a sessão (e, opcionalmente, o projeto) dos próximos eventos. */
    use(label, { projectDir: dir = env.projectDir, entrypoint: entry = env.entrypoint } = {}) {
      currentSession = sessionId(label);
      env = { projectDir: dir, entrypoint: entry };
      return currentSession;
    },
    /** Soma `ms` ao intervalo antes do próximo evento. */
    wait(ms) {
      gap += ms;
    },
    sessionStart(source = 'startup', extra = {}) {
      emit({ ...base('SessionStart'), source, model: 'claude-opus-5-5', ...extra });
    },
    sessionEnd(reason = 'prompt_input_exit') {
      emit({ ...base('SessionEnd'), reason });
    },
    prompt(text, extra = {}) {
      currentPrompt = uuid(`${prefix}:pedido:${++prompts}`);
      emit({ ...base('UserPromptSubmit'), prompt: text, ...extra });
    },
    /** Chamada de ferramenta (ainda sem evento). */
    call(tool, input, who) {
      return { id: toolUseId(`${prefix}:${++tools}`), tool, input, who };
    },
    pre(call) {
      emit({ ...base('PreToolUse', call.who), tool_name: call.tool, tool_input: call.input, tool_use_id: call.id });
    },
    post(call, response = {}) {
      emit({
        ...base('PostToolUse', call.who), tool_name: call.tool, tool_input: call.input,
        tool_response: response, tool_use_id: call.id, duration_ms: 25,
      });
    },
    fail(call, error, { interrupt = false } = {}) {
      emit({
        ...base('PostToolUseFailure', call.who), tool_name: call.tool, tool_input: call.input,
        tool_use_id: call.id, error, ...(interrupt ? { is_interrupt: true } : {}), duration_ms: 25,
      });
    },
    /** Pre e Post (ou Failure, com `error`) de uma ferramenta. */
    tool(tool, input, { who, error } = {}) {
      const call = b.call(tool, input, who);
      b.pre(call);
      if (error === undefined) b.post(call, { stdout: 'SAIDA-REAL', stderr: '' });
      else b.fail(call, error);
      return call;
    },
    /** Chamada `Agent` (ainda sem evento). */
    delegation(type, description, { who, background = false } = {}) {
      const input = { description, prompt: `PROMPT-DO-AGENTE ${description}`, subagent_type: type };
      if (background) input.run_in_background = true;
      return b.call('Agent', input, who);
    },
    /** Post do `Agent` em primeiro plano, com o elo (`tool_response.agentId`). */
    returned(call, sub, { withAgentId = true } = {}) {
      b.post(call, {
        status: 'completed', ...(withAgentId ? { agentId: sub.id } : {}),
        content: [{ type: 'text', text: 'RESULTADO-DO-AGENTE' }], totalToolUseCount: 1,
      });
    },
    /** Post do `Agent` em segundo plano, logo no lançamento. */
    launched(call, sub) {
      b.post(call, { status: 'async_launched', agentId: sub.id, description: call.input.description, prompt: 'PROMPT-DO-AGENTE' });
    },
    start(sub) {
      emit({ ...base('SubagentStart', sub) });
    },
    stopAgent(sub) {
      emit({
        ...base('SubagentStop', sub), stop_hook_active: false,
        agent_transcript_path: `${HOME}\\.claude\\projects\\c--Users-fulana-Projetos\\${currentSession}\\subagents\\agent-${sub.id}.jsonl`,
        last_assistant_message: 'RESPOSTA-DO-ASSISTENTE', background_tasks: [], session_crons: [],
      });
    },
    stop(backgroundTasks = []) {
      emit({ ...base('Stop'), stop_hook_active: false, last_assistant_message: 'RESPOSTA-DO-ASSISTENTE', background_tasks: backgroundTasks, session_crons: [] });
    },
    stopFailure(error = 'rate_limit') {
      emit({ ...base('StopFailure'), error, error_details: 'DETALHE-DO-ERRO', last_assistant_message: 'ERRO-DA-API' });
    },
    notice(type = 'permission_prompt', who) {
      emit({ ...base('Notification', who), message: 'Claude needs your permission to use Bash', notification_type: type });
    },
    /** Payload qualquer (com os campos comuns da sessão atual). */
    raw(hook, fields = {}, who) {
      emit({ ...base(hook, who), ...fields });
    },
  };
  return b;
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/** Nomes de `.claude/agents/` que `run` entrega a cada projeto novo, por estado. */
const AGENT_NAMES = new WeakMap();

/**
 * Estado com o contador local de `seq`, a pasta pessoal fictícia e, se
 * `agentNames` vier, os nomes que `run` entrega por `setAgentNames` a cada
 * projeto novo, como a ligação (T9a) faz depois da leitura assíncrona. Nunca lê
 * o disco.
 */
export function newState({ roleOverrides = {}, agentNames = null, sequence, homeDir = HOME } = {}) {
  const state = createState({ roleOverrides, homeDir, ...(sequence ? { sequence } : {}) });
  if (agentNames) AGENT_NAMES.set(state, agentNames);
  return state;
}

/**
 * Passa o cenário pelo normalizador e pelo reducer, com o relógio igual à
 * chegada de cada evento.
 * @param {{ events: { dt: number, env: object, payload: object }[] }} scn
 * @param {{ state?: object, start?: number, until?: number, homeDir?: string }} [options]
 *   `until`: para antes do evento de índice `until`. `homeDir`: pasta pessoal
 *   do cenário (nas fixtures do T0, `C:\Users\usuario`).
 */
export function run(scn, { state = newState(), start = START, until = Infinity, homeDir = HOME } = {}) {
  const steps = [];
  const events = [];
  let end = start;
  for (const { envelope, receivedAt, event, index } of scenarioEnvelopes(scn, { start })) {
    if (index >= until) break;
    const fact = normalize(envelope, { receivedAt, homeDir });
    const result = fact ? apply(state, fact, receivedAt) : { events: [], changed: [], newProjects: [] };
    steps.push({ index, payload: event.payload, fact, events: result.events, changed: result.changed, newProjects: result.newProjects, at: receivedAt });
    events.push(...result.events);
    const names = AGENT_NAMES.get(state);
    if (names) for (const projectDir of result.newProjects) setAgentNames(state, projectDir, names);
    end = receivedAt;
  }
  return { state, steps, events, end };
}

/** Estado de uma sessão, com feed. */
export function view(state, id = sessionId('principal')) {
  return getSessionState(state, id, { feed: true });
}

/** Agente do estado pela chave. */
export function agentOf(session, key) {
  const found = session.agents.find((item) => item.key === key);
  assert.ok(found, `agente ${key} não está na sessão`);
  return found;
}

/**
 * Confere a sequência de eventos: `[kind, agentKey, dataParcial?]` por item.
 * @param {object[]} actual
 * @param {[string, string|null, object?][]} expected
 */
export function assertEvents(actual, expected) {
  assert.deepEqual(
    actual.map((event) => [event.kind, event.agentKey]),
    expected.map(([kind, key]) => [kind, key]),
    'sequência de eventos',
  );
  expected.forEach(([kind, , data], i) => {
    if (!data) return;
    for (const [field, value] of Object.entries(data)) {
      assert.deepEqual(actual[i].data[field], value, `evento ${i} (${kind}): ${field}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Conferências genéricas (valem também para as fixtures do T0)
// ---------------------------------------------------------------------------

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TOOL_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

/**
 * V1: todo evento de ferramenta (fora Agent e Task) é atribuído pelo
 * `agent_id` do payload; sem ele, à sessão principal. Nunca ao `main` quando
 * há `agent_id`.
 */
export function assertAttribution(steps) {
  let checked = 0;
  for (const { payload, events, index } of steps) {
    if (!TOOL_HOOKS.has(payload.hook_event_name) || AGENT_TOOLS.has(payload.tool_name)) continue;
    for (const event of events.filter((item) => item.kind.startsWith('tool.'))) {
      assert.equal(event.agentKey, payload.agent_id ?? 'main', `evento ${index}: ${event.kind}`);
      assert.equal(event.sessionId, payload.session_id, `evento ${index}: sessão`);
      checked++;
    }
  }
  return checked;
}

/**
 * V5: depois do Post do `Agent` com `tool_response.agentId`, a instância tem
 * a descrição daquela delegação e o `parentKey` de quem delegou.
 */
export function assertLinks(scn, state) {
  const pres = new Map();
  let checked = 0;
  for (const { payload } of scn.events) {
    if (payload.hook_event_name === 'PreToolUse' && AGENT_TOOLS.has(payload.tool_name)) pres.set(payload.tool_use_id, payload);
  }
  for (const { payload } of scn.events) {
    const linked = payload.tool_response?.agentId;
    if (payload.hook_event_name !== 'PostToolUse' || !AGENT_TOOLS.has(payload.tool_name) || !linked) continue;
    const session = getSessionState(state, payload.session_id);
    if (!session) continue;
    const instance = session.agents.find((item) => item.key === linked);
    if (!instance) continue;
    const pre = pres.get(payload.tool_use_id) ?? payload;
    assert.equal(instance.label, textLine(pre.tool_input.description, LIMITS.description) ?? instance.agentType ?? '', `rótulo de ${linked}`);
    assert.equal(instance.parentKey, pre.agent_id ?? 'main', `parentKey de ${linked}`);
    checked++;
  }
  return checked;
}

const SESSION_KEYS = ['id', 'project', 'label', 'client', 'status', 'startedAt', 'lastEventAt', 'agents', 'roster', 'quest', 'counters', 'bugs'];
const AGENT_KEYS = ['key', 'agentId', 'agentType', 'role', 'label', 'status', 'finished', 'background', 'parentKey', 'activity', 'waitingFor', 'health', 'context', 'startedAt', 'lastEventAt'];
const ACTIVITY_KEYS = ['kind', 'category', 'tool', 'target', 'detail', 'state', 'at'];

/** Tipos que o reducer emite no recorte da Primeira luz (plano, regra 3). */
export const SLICE_KINDS = [
  'session.started', 'session.ended', 'agent.delegated', 'agent.started',
  'agent.finished', 'tool.started', 'tool.finished', 'tool.failed',
];

/** Chaves de `data` por tipo (seção 3). */
export const EVENT_DATA_KEYS = {
  'session.started': ['source', 'projectName'],
  'session.ended': ['reason'],
  'agent.delegated': ['toolUseId', 'toType', 'toRole', 'description', 'background'],
  'agent.started': ['agentType', 'role', 'label', 'parentKey'],
  'agent.finished': ['outcome'],
  'tool.started': ['toolUseId', 'tool', 'category', 'target', 'detail'],
  'tool.finished': ['toolUseId', 'tool', 'category', 'durationMs'],
  'tool.failed': ['toolUseId', 'tool', 'category', 'target', 'error', 'interrupted'],
};

const isTime = (value) => Number.isFinite(value) && value > 0;
const isText = (value) => typeof value === 'string';
const isTextOrNull = (value) => value === null || typeof value === 'string';

/** Nenhum valor cru (`*Key` do fato, `typeKey`, `toTypeKey`) aparece; `agentKey` e `parentKey` são do contrato. */
export function assertNoRawKeys(value, where = 'raiz') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoRawKeys(item, `${where}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!/Key$/.test(key) || key === 'agentKey' || key === 'parentKey', `${where}.${key}: valor cru fora do servidor`);
      assertNoRawKeys(item, `${where}.${key}`);
    }
  }
}

/**
 * Forma de um evento canônico do recorte (seção 3): já numerado pelo
 * `sequence` (`id` = `runId:seq`) e congelado.
 */
export function assertEventShape(event, { runId = LOCAL_RUN_ID } = {}) {
  assert.deepEqual(Object.keys(event), ['id', 'seq', 'ts', 'sessionId', 'agentKey', 'kind', 'data'], 'chaves do evento');
  assert.ok(Number.isInteger(event.seq) && event.seq > 0, `seq ${event.seq}`);
  assert.equal(event.id, `${runId}:${event.seq}`);
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.data), 'evento congelado');
  assert.ok(SLICE_KINDS.includes(event.kind), `tipo fora do recorte: ${event.kind}`);
  assert.ok(isTime(event.ts));
  assert.ok(isText(event.sessionId));
  assert.ok(isTextOrNull(event.agentKey));
  assert.equal(event.agentKey === null, event.kind.startsWith('session.'), `${event.kind}: agentKey`);
  assert.deepEqual(Object.keys(event.data), EVENT_DATA_KEYS[event.kind], `${event.kind}: chaves de data`);
  const { data } = event;
  switch (event.kind) {
    case 'agent.delegated':
      assert.ok(ROLES.includes(data.toRole) && data.toRole !== 'orq');
      assert.equal(typeof data.background, 'boolean');
      break;
    case 'agent.started':
      assert.ok(ROLES.includes(data.role) && data.role !== 'orq');
      assert.ok(isText(data.label));
      break;
    case 'agent.finished':
      assert.ok(['done', 'unknown'].includes(data.outcome));
      break;
    case 'tool.started':
    case 'tool.finished':
    case 'tool.failed':
      assert.ok(TOOL_CATEGORIES.includes(data.category), `categoria ${data.category}`);
      if (event.kind === 'tool.failed') assert.equal(typeof data.interrupted, 'boolean');
      break;
    default:
  }
  for (const value of Object.values(data)) {
    if (typeof value === 'string') assert.equal(redact(value), value, `${event.kind}: texto não redigido`);
  }
  assertNoRawKeys(event);
}

/** Forma de um SessionState contra a seção 9, com os valores neutros do recorte (regra 2). */
export function assertSessionShape(session, { feed = false } = {}) {
  assert.deepEqual(Object.keys(session), feed ? [...SESSION_KEYS, 'feed'] : SESSION_KEYS, 'chaves da sessão');
  assert.ok(isText(session.id));
  assert.deepEqual(Object.keys(session.project), ['key', 'name', 'dir']);
  for (const value of Object.values(session.project)) assert.ok(isText(value));
  assert.ok(isText(session.label) && session.label !== '');
  assert.ok([null, 'terminal', 'vscode'].includes(session.client));
  assert.ok(SESSION_STATUS.includes(session.status) && session.status !== 'waiting', `status ${session.status}`);
  assert.ok(isTime(session.startedAt) && isTime(session.lastEventAt));
  assert.ok(session.startedAt <= session.lastEventAt);
  assert.equal(session.quest, null);
  assert.deepEqual(session.counters, { questsDone: 0, bugsCrushed: 0, pendingApprovals: 0 });
  assert.deepEqual(session.bugs, { open: 0, lastRun: null });

  assert.equal(session.roster[0], 'orq');
  assert.deepEqual(session.roster, ROLES.filter((role) => session.roster.includes(role)), 'roster em ordem e sem repetição');

  assert.equal(session.agents[0]?.key, 'main', 'main é o primeiro');
  const keys = new Set();
  for (const agentState of session.agents) {
    assert.deepEqual(Object.keys(agentState), AGENT_KEYS, `chaves do agente ${agentState.key}`);
    assert.ok(!keys.has(agentState.key), 'agente repetido');
    keys.add(agentState.key);
    const main = agentState.key === 'main';
    assert.equal(agentState.agentId, main ? null : agentState.key);
    assert.ok(isTextOrNull(agentState.agentType));
    assert.ok(ROLES.includes(agentState.role));
    assert.equal(agentState.role === 'orq', main, `papel de ${agentState.key}`);
    assert.ok(session.roster.includes(agentState.role), `papel ${agentState.role} fora do roster`);
    assert.ok(isText(agentState.label));
    assert.ok(AGENT_STATUS.includes(agentState.status) && agentState.status !== 'waiting');
    assert.equal(typeof agentState.finished, 'boolean');
    assert.equal(typeof agentState.background, 'boolean');
    if (main) assert.equal(agentState.finished, false);
    if (agentState.finished) assert.equal(agentState.status, 'idle');
    assert.ok(isTextOrNull(agentState.parentKey));
    assert.equal(agentState.waitingFor, null);
    assert.equal(agentState.context, null);
    assert.deepEqual(Object.keys(agentState.health), ['ok', 'total']);
    assert.ok(Number.isInteger(agentState.health.ok) && Number.isInteger(agentState.health.total));
    assert.ok(agentState.health.ok >= 0 && agentState.health.ok <= agentState.health.total && agentState.health.total <= 10);
    assert.ok(isTime(agentState.startedAt) && isTime(agentState.lastEventAt));
    const { activity } = agentState;
    if (activity !== null) {
      assert.deepEqual(Object.keys(activity), ACTIVITY_KEYS);
      assert.ok(['tool', 'delegate', 'start'].includes(activity.kind), `atividade ${activity.kind}`);
      assert.ok(activity.category === null || TOOL_CATEGORIES.includes(activity.category));
      assert.equal(activity.category === null, activity.kind !== 'tool');
      assert.ok(['running', 'done', 'failed'].includes(activity.state));
      assert.ok(isTime(activity.at));
      for (const field of ['tool', 'target', 'detail']) {
        assert.ok(isTextOrNull(activity[field]));
        if (typeof activity[field] === 'string') assert.equal(redact(activity[field]), activity[field]);
      }
    }
    for (const field of ['agentType', 'label']) {
      if (typeof agentState[field] === 'string') assert.equal(redact(agentState[field]), agentState[field]);
    }
  }
  if (feed) {
    assert.ok(Array.isArray(session.feed) && session.feed.length <= 200);
    for (const event of session.feed) {
      assert.ok(FEED_KINDS.includes(event.kind), `${event.kind} no feed`);
      assert.equal(event.sessionId, session.id);
    }
  }
  assertNoRawKeys(session);
}

/** `seq` contínuo, começando no primeiro da lista. */
export function assertSeqContinuous(events) {
  events.forEach((event, i) => assert.equal(event.seq, events[0].seq + i, `seq do evento ${i} (${event.kind})`));
}

/** Forma de todas as sessões e eventos de uma execução, com `seq` contínuo. */
export function assertRunShape({ state, events }, { runId = LOCAL_RUN_ID } = {}) {
  for (const event of events) assertEventShape(event, { runId });
  assertSeqContinuous(events);
  for (const session of getSessionStates(state)) {
    assertSessionShape(session, { feed: true });
    for (const event of session.feed) assertEventShape(event, { runId });
  }
}
