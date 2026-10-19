// @ts-check
// Sessões: chave, projeto, rótulo, status, equipe (roster), feed, chamadas em
// andamento e limpeza (modelo de eventos, seções 7 e 9).
//
// Este módulo só muda o modelo em memória; quem emite eventos é o index.js.
// Não lê o disco: os nomes de `.claude/agents/` para o roster chegam pela
// função `readAgentNames` do `createState` (T7, ponto 10; a leitura em disco
// fica em server/agent-names.js).
//
// Adiantado antes do G0a (plano, T7, condição 1): a chave da sessão fica em
// `sessionKeyOf` (V9).

import { FEED_KINDS, ROLES } from '../../../shared/contract.js';
import { redact, redactAndCut } from '../redact.js';
import { resolveRole } from '../roles.js';
import { LIMITS, normalizeSlashes } from '../tools.js';
import { MAIN_KEY, createMainAgent, toAgentState } from './agents.js';

/** Feed por sessão (visão geral, "Limites e valores padrão"). */
export const FEED_LIMIT = 200;

/** Sessão com evento há menos de 2 min é `active` (seção 7). */
export const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

/** Sessão encerrada sai da memória depois de 30 min (seção 7; ADR 0005). */
export const ENDED_TTL_MS = 30 * 60 * 1000;

/** Sessão sem eventos sai da memória depois de 6 h (seção 7; ADR 0005). */
export const IDLE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Chamadas lembradas por sessão (as em execução e as já encerradas, para a
 * regra 2 da seção 8). Acima disso, sai a mais antiga.
 */
export const MAX_CALLS = 1000;

/** Quantos caracteres do id entram no rótulo padrão (`Sessão a1b2c3`). */
const LABEL_ID_CHARS = 6;

/** @type {ReadonlySet<string>} */
const FEED_KIND_SET = new Set(FEED_KINDS);

/**
 * @typedef {import('../../../shared/contract.js').RoleId} RoleId
 * @typedef {import('../../../shared/contract.js').SessionState} SessionState
 * @typedef {import('../../../shared/contract.js').SessionStatus} SessionStatus
 * @typedef {import('../normalize.js').Fact} Fact
 * @typedef {import('./agents.js').Agent} Agent
 * @typedef {import('./agents.js').Delegation} Delegation
 */

/**
 * @typedef {import('../../../shared/contract.js').CanonicalEvent} CanonicalEvent
 */

/**
 * Chamada de ferramenta vista na sessão (Pre, Post ou Failure).
 * @typedef {object} CallRecord
 * @property {string} agentKey           agente do primeiro evento da chamada
 * @property {boolean} open              ainda sem Post nem Failure
 * @property {boolean} delegation        Agent ou Task: os eventos seguintes da chamada seguem o primeiro
 * @property {string|null} tool          nome, categoria e alvo do primeiro evento, usados
 * @property {import('../../../shared/contract.js').ToolCategory|null} category   nos eventos seguintes
 * @property {string|null} target
 */

/**
 * Sessão em memória.
 * @typedef {object} Session
 * @property {string} id
 * @property {{ key: string, name: string, dir: string }|null} project
 * @property {string|null} title         session_title de maior ts
 * @property {number} titleAt
 * @property {'terminal'|'vscode'|null} client
 * @property {SessionStatus} status
 * @property {boolean} ended
 * @property {number|null} endedAt
 * @property {number} startedAt
 * @property {number} lastEventAt
 * @property {Map<string, Agent>} agents  na ordem de criação (a saída ordena: `orderedAgents`)
 * @property {Set<RoleId>} fileRoles      papéis do time com arquivo em .claude/agents/
 * @property {Map<string, Delegation>} delegations
 * @property {Map<string, CallRecord>} calls
 * @property {CanonicalEvent[]} feed
 * @property {number} internalIds
 */

/**
 * Lê os nomes dos agentes disponíveis para o roster (seção 7).
 * @typedef {(projectDir: string) => string[]} ReadAgentNames
 */

// ---------------------------------------------------------------------------
// Item a confirmar no T0 (G0a)
// ---------------------------------------------------------------------------

/**
 * V9: chave da sessão. Os eventos dos subagentes chegam com o `session_id` da
 * sessão principal. Se o V9 for refutado, a sessão passa a ser resolvida pelo
 * caminho do transcript (`…/<sessão>/subagents/agent-<id>.jsonl`), e muda só
 * esta função.
 * @param {Fact} fact
 * @returns {string}
 */
export function sessionKeyOf(fact) {
  return fact.sessionId;
}

// ---------------------------------------------------------------------------
// Criação e atualização
// ---------------------------------------------------------------------------

/**
 * Sessão nova, criada pelo primeiro evento dela, seja ele qual for (servidor
 * iniciado no meio, seção 8). A sessão principal começa ociosa; o pedido e as
 * ferramentas dela é que a deixam trabalhando.
 * @param {string} id
 * @param {Fact} fact
 * @returns {Session}
 */
export function createSession(id, fact) {
  return {
    id,
    project: null,
    title: null,
    titleAt: -Infinity,
    client: null,
    status: 'idle',
    ended: false,
    endedAt: null,
    startedAt: fact.ts,
    lastEventAt: fact.ts,
    agents: new Map([[MAIN_KEY, createMainAgent(fact.ts)]]),
    fileRoles: new Set(),
    delegations: new Map(),
    calls: new Map(),
    feed: [],
    internalIds: 0,
  };
}

/**
 * Campos da sessão que todo fato pode trazer: horas, projeto (o primeiro
 * conhecido; o normalizador já cai para o `cwd` quando falta `env.projectDir`),
 * cliente e título. Quando o projeto fica conhecido, os nomes de
 * `.claude/agents/` são lidos, uma vez por sessão.
 * @param {Session} session
 * @param {Fact} fact
 * @param {{ readAgentNames: ReadAgentNames, roleOverrides: unknown }} options
 */
export function touchSession(session, fact, { readAgentNames, roleOverrides }) {
  if (fact.ts < session.startedAt) session.startedAt = fact.ts;
  if (fact.ts > session.lastEventAt) session.lastEventAt = fact.ts;
  if (session.client === null && fact.client) session.client = fact.client;
  if ((fact.kind === 'session.start' || fact.kind === 'prompt.submit') && fact.sessionTitle && fact.ts >= session.titleAt) {
    session.title = fact.sessionTitle;
    session.titleAt = fact.ts;
  }
  if (session.project === null && fact.projectDir) {
    session.project = projectOf(fact.projectDir);
    session.fileRoles = rolesFromNames(safeRead(readAgentNames, fact.projectDir), roleOverrides);
  }
}

/**
 * Projeto (seção 7): `key` é o caminho normalizado (barras `/`, letra da
 * unidade minúscula, sem barra no fim), `name` a última parte e `dir` o
 * caminho como veio.
 * @param {string} dir
 * @returns {{ key: string, name: string, dir: string }}
 */
export function projectOf(dir) {
  const normalized = normalizeSlashes(dir);
  const key = normalized.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  const parts = normalized.split('/').filter((part) => part !== '');
  const last = parts.length > 0 ? parts[parts.length - 1] : normalized;
  // `dir` já é ponto fixo de redact (normalizador); um pedaço dele também precisa ser.
  const name = redact(last) === last ? last : redactAndCut(last, LIMITS.name);
  return { key, name, dir };
}

/**
 * Papéis do time a partir dos nomes de arquivo (sem `.md`). Nomes que viram
 * `aux` não entram: o convidado só aparece quando há um na sessão.
 * @param {readonly unknown[]} names
 * @param {unknown} overrides
 * @returns {Set<RoleId>}
 */
export function rolesFromNames(names, overrides) {
  /** @type {Set<RoleId>} */
  const roles = new Set();
  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue;
    const role = resolveRole(name, overrides);
    if (role !== 'aux' && role !== 'orq') roles.add(role);
  }
  return roles;
}

/**
 * @param {ReadAgentNames} read
 * @param {string} projectDir
 * @returns {unknown[]}
 */
function safeRead(read, projectDir) {
  try {
    const names = read(projectDir);
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Chamadas de ferramenta (seção 8, regras 1 e 2)
// ---------------------------------------------------------------------------

/**
 * Registra uma chamada aberta pelo agente.
 * @param {Session} session
 * @param {Agent} agent
 * @param {string} callId
 * @param {{ tool: string|null, category: CallRecord['category'], target: string|null }} first   o primeiro evento da chamada
 */
export function openCall(session, agent, callId, { tool, category, target }) {
  session.calls.set(callId, { agentKey: agent.key, open: true, delegation: category === null, tool, category, target });
  agent.openCalls.add(callId);
  if (session.calls.size <= MAX_CALLS) return;
  const oldest = session.calls.entries().next().value;
  if (!oldest) return;
  const [oldId, record] = oldest;
  session.calls.delete(oldId);
  if (record.open) session.agents.get(record.agentKey)?.openCalls.delete(oldId);
}

/**
 * Post ou Failure: a chamada continua lembrada, mas encerrada, para um Pre
 * atrasado ser ignorado (regra 2).
 * @param {Session} session
 * @param {string} callId
 */
export function closeCall(session, callId) {
  const record = session.calls.get(callId);
  if (!record || !record.open) return;
  record.open = false;
  session.agents.get(record.agentKey)?.openCalls.delete(callId);
}

// ---------------------------------------------------------------------------
// Feed, status, rótulo, roster e limpeza
// ---------------------------------------------------------------------------

/**
 * Evento do feed? Os tipos de FEED_KINDS; `quest.phase` só com `state: done`
 * (seção 3).
 * @param {CanonicalEvent} event
 * @returns {boolean}
 */
export function isFeedEvent(event) {
  if (!FEED_KIND_SET.has(event.kind)) return false;
  return event.kind !== 'quest.phase' || /** @type {Record<string, unknown>} */ (event.data).state === 'done';
}

/**
 * Guarda o evento no feed da sessão, que fica com os FEED_LIMIT mais recentes.
 * @param {Session} session
 * @param {CanonicalEvent} event
 */
export function pushFeed(session, event) {
  if (!isFeedEvent(event)) return;
  session.feed.push(event);
  if (session.feed.length > FEED_LIMIT) session.feed.splice(0, session.feed.length - FEED_LIMIT);
}

/**
 * Status (seção 7): `ended` depois do SessionEnd; `active` com algum agente
 * trabalhando ou evento há menos de 2 min; senão `idle`. O `waiting` entra
 * com o T8.
 * @param {Session} session
 * @param {number} now
 * @returns {SessionStatus}
 */
export function sessionStatus(session, now) {
  if (session.ended) return 'ended';
  for (const agent of session.agents.values()) {
    if (agent.status === 'working') return 'active';
  }
  return now - session.lastEventAt < ACTIVE_WINDOW_MS ? 'active' : 'idle';
}

/**
 * Rótulo (seção 7): `session_title`, senão "Sessão" com os 6 primeiros
 * caracteres do id. O título do primeiro ticket entra no T8.
 * @param {Session} session
 * @returns {string}
 */
export function sessionLabel(session) {
  return session.title ?? `Sessão ${session.id.slice(0, LABEL_ID_CHARS)}`;
}

/**
 * Equipe (seção 7): `orq`, mais os papéis do time com arquivo em
 * `.claude/agents/`, mais os papéis das instâncias da sessão, mais `aux` se
 * houver convidado. Na ordem de ROLES.
 * @param {Session} session
 * @returns {RoleId[]}
 */
export function rosterOf(session) {
  /** @type {Set<RoleId>} */
  const present = new Set(session.fileRoles);
  present.add('orq');
  for (const agent of session.agents.values()) present.add(agent.role);
  return ROLES.filter((role) => present.has(role));
}

/**
 * Sai da memória? Encerrada há 30 min, ou sem eventos há 6 h.
 * @param {Session} session
 * @param {number} now
 * @returns {boolean}
 */
export function isExpired(session, now) {
  if (session.ended && session.endedAt !== null && now - session.endedAt >= ENDED_TTL_MS) return true;
  return now - session.lastEventAt >= IDLE_TTL_MS;
}

/**
 * Agentes na ordem da saída: `main` primeiro, depois por `startedAt` (o menor
 * `ts` visto) e pela chave, para a ordem de chegada não mudar o estado.
 * @param {Session} session
 * @returns {Agent[]}
 */
export function orderedAgents(session) {
  return [...session.agents.values()].sort((a, b) => {
    if (a.key === MAIN_KEY || b.key === MAIN_KEY) return a.key === MAIN_KEY ? -1 : 1;
    return a.startedAt - b.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

/**
 * SessionState do contrato (seção 9), com as chaves na ordem do contrato e os
 * valores neutros do recorte (plano, regra 2): `quest: null`, contadores
 * zerados e `bugs: { open: 0, lastRun: null }`. Sem projeto conhecido, os três
 * campos de `project` vão vazios.
 * @param {Session} session
 * @param {{ feed?: boolean }} [options]   `feed: true` só no snapshot
 * @returns {SessionState}
 */
export function toSessionState(session, { feed = false } = {}) {
  /** @type {SessionState} */
  const state = {
    id: session.id,
    project: session.project ? { ...session.project } : { key: '', name: '', dir: '' },
    label: sessionLabel(session),
    client: session.client,
    status: session.status,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    agents: orderedAgents(session).map(toAgentState),
    roster: rosterOf(session),
    quest: null,
    counters: { questsDone: 0, bugsCrushed: 0, pendingApprovals: 0 },
    bugs: { open: 0, lastRun: null },
  };
  if (feed) state.feed = session.feed.slice();
  return state;
}
