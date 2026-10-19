// @ts-check
// Reducer de estado: fatos do normalizador → estado das sessões em memória e
// eventos canônicos (modelo de eventos, seções 3 a 9; ADR 0005; T7 do plano).
//
// Recorte da Primeira luz (plano, regras 2 e 3):
// - emite só `session.started`, `session.ended`, `agent.delegated`,
//   `agent.started`, `agent.finished`, `tool.started`, `tool.finished` e
//   `tool.failed`. Tickets, etapas, aprovações, bugs, compactação e
//   `session.idle` chegam com o T8;
// - o SessionState sai completo, com os valores neutros do que ainda não
//   existe. Os status `waiting` só aparecem com o T8.
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

import {
  MAIN_KEY,
  agentKeyOf,
  anonymousCallKey,
  beginCall,
  callActivity,
  closeDelegation,
  confirmDelegation,
  correctCallStart,
  createSubagent,
  endAnonymousCall,
  endCall,
  finishAgent,
  isBackgroundLaunch,
  isStale,
  learnType,
  linkAgent,
  linkedAgentOf,
  listedInBackground,
  markBackground,
  markWorking,
  openDelegation,
  recordOutcome,
  reviveAgent,
  runsInBackground,
  touchAgent,
} from './agents.js';
import {
  closeCall,
  createSession,
  isExpired,
  openCall,
  pushFeed,
  sessionKeyOf,
  sessionStatus,
  toSessionState,
  touchSession,
} from './sessions.js';

/** `runId` do contador local, padrão do `createState` (testes). */
export const LOCAL_RUN_ID = 'local';

/**
 * @typedef {import('../../../shared/contract.js').SessionState} SessionState
 * @typedef {import('../../../shared/contract.js').CanonicalEvent} CanonicalEvent
 * @typedef {import('../../../shared/contract.js').EventKind} EventKind
 * @typedef {import('../normalize.js').Fact} Fact
 * @typedef {import('./agents.js').Agent} Agent
 * @typedef {import('./agents.js').ToolFact} ToolFact
 * @typedef {import('./sessions.js').Session} Session
 * @typedef {import('./sessions.js').CallRecord} CallRecord
 * @typedef {import('./sessions.js').ReadAgentNames} ReadAgentNames
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
 * @property {ReadAgentNames} readAgentNames
 * @property {Sequence} sequence
 */

/**
 * @typedef {object} ApplyResult
 * @property {CanonicalEvent[]} events    na ordem em que aconteceram, já numerados
 * @property {string[]} changed           sessões cujo estado mudou
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
 * @param {{ roleOverrides?: unknown, readAgentNames?: ReadAgentNames, sequence?: Sequence }} [options]
 *   `roleOverrides`: "roles" do config.json. `readAgentNames(projectDir)`: nomes
 *   dos agentes de `.claude/agents/` (padrão: nenhum; a leitura em disco fica em
 *   server/agent-names.js e é ligada no T9a). `sequence`: a numeração da
 *   execução (padrão: contador local, com o runId LOCAL_RUN_ID).
 * @returns {State}
 */
export function createState({ roleOverrides = {}, readAgentNames = () => [], sequence = createSequence(LOCAL_RUN_ID) } = {}) {
  return { sessions: new Map(), roleOverrides, readAgentNames, sequence };
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
  if (!isFact(fact)) return { events, changed: [] };
  const id = sessionKeyOf(fact);
  const existing = state.sessions.get(id);
  if (isNoise(fact, existing)) return { events, changed: [] };

  let session = existing;
  if (!session) {
    session = createSession(id, fact);
    state.sessions.set(id, session);
  }
  touchSession(session, fact, state);
  /** @type {Context} */
  const ctx = { state, session, events };
  (HANDLERS[fact.kind] ?? onOther)(ctx, fact);
  session.status = sessionStatus(session, now);
  return { events, changed: [id] };
}

/**
 * Passagem do relógio (seção 6, "Voltou para a copa"; seção 7, "Limpeza"):
 * - agente trabalhando, sem ferramenta em execução e sem eventos há 15 min:
 *   subagente recebe `agent.finished(unknown)` (e pode voltar com um `tool.pre`
 *   novo); a sessão principal só fica ociosa;
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
    const ctx = { state, session, events };
    let dirty = false;
    for (const agent of session.agents.values()) {
      if (!isStale(agent, now)) continue;
      dirty = true;
      if (agent.key === MAIN_KEY) agent.status = 'idle';
      else finish(ctx, agent, 'unknown', now, { revivable: true });
    }
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
  'subagent.start': onSubagentStart,
  'subagent.stop': onSubagentStop,
  'turn.stop': onTurnEnd,
  'turn.fail': onTurnEnd,
  // permission.request, permission.denied, notice, compact.pre e compact.post
  // ganham regras no T8. Até lá, só criam a sessão e o agente (onOther).
};

/**
 * Fatos sem regra no recorte: criam o agente sob demanda e atualizam as horas.
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
 * @param {Context} ctx
 * @param {import('../normalize.js').SessionStartFact} fact
 */
function onSessionStart(ctx, fact) {
  const { session } = ctx;
  session.ended = false;
  session.endedAt = null;
  actor(ctx, fact);
  emit(ctx, null, 'session.started', { source: fact.source, projectName: session.project?.name ?? null }, fact.ts);
}

/**
 * SessionEnd (seção 4; T7, ponto 7): libera os agentes ainda trabalhando ou
 * aguardando (subagentes com `agent.finished(unknown)`, o `main` ocioso),
 * depois `session.ended`. A sessão sai da memória 30 min depois. Eventos
 * atrasados não devolvem ninguém a "trabalhando".
 * @param {Context} ctx
 * @param {import('../normalize.js').SessionEndFact} fact
 */
function onSessionEnd(ctx, fact) {
  const { session } = ctx;
  const main = actor(ctx, fact);
  if (session.ended) return;
  main.status = 'idle';
  main.turnEnded = true;
  for (const agent of session.agents.values()) {
    if (agent.key === MAIN_KEY) continue;
    if (agent.status !== 'idle') finish(ctx, agent, 'unknown', fact.ts);
    agent.revivable = false;
  }
  session.ended = true;
  session.endedAt = fact.ts;
  emit(ctx, null, 'session.ended', { reason: fact.reason }, fact.ts);
}

/**
 * UserPromptSubmit deixa a sessão principal trabalhando e libera a regra 4
 * da seção 8 (turno encerrado pelo Stop). O ticket entra no T8.
 * @param {Context} ctx
 * @param {import('../normalize.js').PromptFact} fact
 */
function onPrompt(ctx, fact) {
  const agent = actor(ctx, fact);
  if (agent.key !== MAIN_KEY) return;
  agent.turnEnded = false;
  markWorking(agent);
}

/**
 * PreToolUse, PostToolUse e PostToolUseFailure (seções 4 e 8).
 * - O primeiro evento de um `toolUseId` abre a chamada; os seguintes só a
 *   atualizam e ficam com o agente dela (regra 1).
 * - Pre de uma chamada já vista é ignorado (regra 2), assim como um Post ou
 *   Failure de uma chamada já encerrada.
 * - Um Pre com `toolUseId` novo traz de volta o subagente encerrado só pela
 *   inferência dos 15 min (seção 6).
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
  const agent = record ? agentFor(ctx, fact, record.agentKey) : actor(ctx, fact);
  if (!record && fact.kind === 'tool.pre' && fact.toolUseId !== null) reviveAgent(agent);
  // O tipo da chamada é o do primeiro evento dela (regra 1): um Post ou Failure
  // com outro tool_name e o mesmo toolUseId não muda delegação em ferramenta.
  const delegation = record ? record.delegation : fact.category === null;
  if (delegation) delegationCall(ctx, fact, agent, record);
  else toolCall(ctx, fact, agent, record);
}

/**
 * Ferramenta comum: `tool.started` no primeiro evento; `tool.finished` ou
 * `tool.failed` no Post ou no Failure, que contam na saúde.
 * @param {Context} ctx
 * @param {ToolFact} fact
 * @param {Agent} agent
 * @param {CallRecord|undefined} record
 */
function toolCall(ctx, fact, agent, record) {
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
    beginCall(agent, callId ?? anonymousCallKey(fact.ts), callActivity(fact, pre ? 'running' : ok ? 'done' : 'failed'));
    if (callId !== null) openCall(session, agent, callId, fact);
  }
  touchAgent(agent, fact.ts);
  markWorking(agent);
  if (pre) return;

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
  } else if (fact.kind === 'tool.fail') {
    emit(ctx, agent.key, 'tool.failed', {
      toolUseId: callId,
      tool: first.tool,
      category: first.category,
      target: first.target,
      error: fact.error,
      interrupted: fact.interrupted,
    }, fact.ts);
  }
  recordOutcome(agent, ok, fact.ts);
  settle(agent, callId, ok ? 'done' : 'failed');
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
 */
function delegationCall(ctx, fact, agent, record) {
  const { session, state } = ctx;
  const callId = fact.toolUseId;
  const pre = fact.kind === 'tool.pre';
  let delegation = callId === null ? undefined : session.delegations.get(callId);
  if (!record && (pre || callId !== null)) {
    delegation = openDelegation(session, fact, agent.key, state.roleOverrides);
    emit(ctx, agent.key, 'agent.delegated', {
      toolUseId: callId,
      toType: delegation.toType,
      toRole: delegation.toRole,
      description: delegation.description,
      background: delegation.background,
    }, fact.ts);
    beginCall(agent, callId ?? anonymousCallKey(fact.ts), callActivity(fact, pre ? 'running' : fact.kind === 'tool.post' ? 'done' : 'failed'));
    if (callId !== null) openCall(session, agent, callId, fact);
  }
  touchAgent(agent, fact.ts);
  markWorking(agent);
  if (pre) return;

  if (callId !== null) closeCall(session, callId);
  settle(agent, callId, fact.kind === 'tool.post' ? 'done' : 'failed');
  if (!delegation) return;
  if (fact.kind === 'tool.post') {
    if (isBackgroundLaunch(fact)) markBackground(session, delegation);
    const linked = linkedAgentOf(fact);
    if (linked !== null) confirmDelegation(session, delegation, linked);
  }
  closeDelegation(session, delegation, { failed: fact.kind === 'tool.fail' });
}

/**
 * SubagentStart: cria a instância e emite `agent.started`. Se ela já existe
 * (criada antes por outro evento, ou retomada), só completa o elo (seção 8,
 * regra 3), sem evento.
 * @param {Context} ctx
 * @param {import('../normalize.js').SubagentStartFact} fact
 */
function onSubagentStart(ctx, fact) {
  const agent = actor(ctx, fact);
  linkAgent(ctx.session, agent);
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
 * Stop e StopFailure: a sessão principal fica ociosa até o próximo pedido, e
 * os subagentes em primeiro plano que ainda constam como trabalhando recebem
 * `agent.finished(unknown)`, haja ou não tarefa em segundo plano (seção 6;
 * T7, ponto 5). Os de segundo plano continuam.
 * @param {Context} ctx
 * @param {import('../normalize.js').TurnStopFact|import('../normalize.js').TurnFailFact} fact
 */
function onTurnEnd(ctx, fact) {
  const main = actor(ctx, fact);
  if (main.key !== MAIN_KEY) return;
  main.status = 'idle';
  main.turnEnded = true;
  const tasks = fact.kind === 'turn.stop' ? fact.backgroundTasks : [];
  for (const agent of ctx.session.agents.values()) {
    if (agent.key === MAIN_KEY || agent.status !== 'working') continue;
    if (listedInBackground(agent, tasks)) agent.background = true;
    if (runsInBackground(ctx.session, agent, tasks)) continue;
    finish(ctx, agent, 'unknown', fact.ts);
  }
}

// ---------------------------------------------------------------------------
// Agentes e eventos
// ---------------------------------------------------------------------------

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
 * tipo e, com ele, o elo.
 * @param {Context} ctx
 * @param {Fact} fact
 * @param {string} key
 * @returns {Agent}
 */
function agentFor(ctx, fact, key) {
  const { session, state } = ctx;
  let agent = session.agents.get(key);
  if (agent) {
    if (learnType(agent, fact, state.roleOverrides)) linkAgent(session, agent);
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
 * @param {Context} ctx
 * @param {Agent} agent
 * @param {'done'|'unknown'} outcome
 * @param {number} ts
 * @param {{ revivable?: boolean }} [options]
 */
function finish(ctx, agent, outcome, ts, options) {
  finishAgent(agent, options);
  emit(ctx, agent.key, 'agent.finished', { outcome }, ts);
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
