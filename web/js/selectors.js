// @ts-check
// Seletores do painel: funções puras que derivam, do `SessionState` recebido do
// servidor (modelo de eventos, seção 9), os modelos de visão das telas. Não
// guardam estado, não dependem do tema nem do DOM e nunca alteram a sessão.

import { FEED_KINDS, PHASES, ROLES } from '../../shared/contract.js';

/** @typedef {import('../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../shared/contract.js').AgentState} AgentState */
/** @typedef {import('../../shared/contract.js').CanonicalEvent} CanonicalEvent */
/** @typedef {import('../../shared/contract.js').RoleId} RoleId */
/** @typedef {import('../../shared/contract.js').PhaseId} PhaseId */
/** @typedef {import('../../shared/contract.js').Phase} Phase */
/** @typedef {import('../../shared/contract.js').QuestStatus} QuestStatus */
/** @typedef {import('./themes/contract.js').SessionStatsView} SessionStatsView */

/** Papel dono de cada etapa (modelo de eventos, seção 6, "Etapa"). */
export const PHASE_OWNER = Object.freeze(/** @type {Record<PhaseId, RoleId>} */ ({
  design: 'arq',
  code: 'dev',
  test: 'tes',
  docs: 'doc',
}));

/** Papel real de cada papel do time, igual nos dois temas (mockup, `REAL_ROLE`). */
export const ROLE_TITLES = Object.freeze(/** @type {Record<RoleId, string>} */ ({
  orq: 'Orquestrador',
  arq: 'System Design',
  dev: 'Dev',
  tes: 'Tester',
  doc: 'Documentação',
  aux: 'Convidado',
}));

/** Nome real de cada etapa, para o tooltip do stepper (mockup, `PHASE_REAL`). */
export const PHASE_TITLES = Object.freeze(/** @type {Record<PhaseId, string>} */ ({
  design: 'design',
  code: 'código',
  test: 'testes',
  docs: 'documentação',
}));

/**
 * Quantas instâncias encerradas aparecem por papel no cartão da equipe. As mais
 * antigas viram só uma contagem ("+N encerradas").
 */
export const MAX_FINISHED_SHOWN = 3;

/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Sessões do seletor, da mais recente para a mais antiga por `lastEventAt`
 * (empate: a que começou depois; depois, o id).
 * @param {Iterable<SessionState>} sessions
 * @returns {SessionState[]}
 */
export function sessionList(sessions) {
  return [...sessions].sort((a, b) =>
    num(b.lastEventAt) - num(a.lastEventAt) || num(b.startedAt) - num(a.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Sessão mostrada (T11a): a escolhida enquanto ela existir; senão, a mais
 * recente da lista; sem sessões, null.
 * @param {readonly SessionState[]} list   já ordenada por `sessionList`
 * @param {string|null} chosenId
 * @returns {string|null}
 */
export function resolveSelectedId(list, chosenId) {
  if (chosenId !== null && list.some((session) => session.id === chosenId)) return chosenId;
  return list[0]?.id ?? null;
}

/**
 * Duração da sessão: até agora, ou até o último evento se ela foi encerrada.
 * @param {SessionState} session
 * @param {number} now
 * @returns {number}
 */
export function sessionDurationMs(session, now) {
  const end = session.status === 'ended' ? num(session.lastEventAt) : now;
  return Math.max(0, end - num(session.startedAt));
}

/**
 * Valores dos indicadores do topo (ADR 0008). Contadores ausentes valem zero.
 * @param {SessionState} session
 * @param {number} now
 * @returns {SessionStatsView}
 */
export function statsView(session, now) {
  return {
    durationMs: sessionDurationMs(session, now),
    bugsCrushed: num(session.counters?.bugsCrushed),
    questsDone: num(session.counters?.questsDone),
    pendingApprovals: num(session.counters?.pendingApprovals),
  };
}

/**
 * @typedef {object} RoleGroup
 * @property {RoleId} role
 * @property {'working'|'waiting'|'idle'} status   'waiting' se alguma instância em andamento aguarda; senão 'working' se alguma trabalha
 * @property {number} activeCount                  instâncias não encerradas (o "×N" do cartão)
 * @property {AgentState[]} instances              em andamento (mais antigas primeiro) e depois as encerradas exibidas (mais recentes primeiro)
 * @property {number} hiddenFinished               encerradas do ticket atual que não aparecem (o "+N")
 */

/**
 * @param {string} role
 * @returns {role is RoleId}
 */
const isRole = (role) => /** @type {readonly string[]} */ (ROLES).includes(role);

/**
 * Papéis do cartão da equipe: os do `roster`, em ordem, mais qualquer papel que
 * apareça nos agentes e falte no `roster` (defensivo), na ordem do contrato.
 * @param {SessionState} session
 * @returns {RoleId[]}
 */
export function rosterRoles(session) {
  /** @type {RoleId[]} */
  const roles = [];
  for (const role of session.roster ?? []) {
    if (isRole(role) && !roles.includes(role)) roles.push(role);
  }
  const extra = new Set((session.agents ?? []).map((agent) => agent.role).filter((role) => isRole(role) && !roles.includes(role)));
  for (const role of ROLES) {
    if (extra.has(role)) roles.push(role);
  }
  return roles;
}

/**
 * Cartão da equipe: um grupo por papel, com as instâncias (modelo de eventos,
 * seção 6, "Voltou para a copa", "No cartão da equipe"):
 * - as em andamento aparecem todas, e o "×N" conta só essas;
 * - das encerradas do ticket atual (`lastEventAt` >= `quest.startedAt`; sem
 *   ticket, todas), aparecem as `MAX_FINISHED_SHOWN` mais recentes, e as demais
 *   viram o "+N";
 * - encerradas antes do ticket atual não aparecem nem entram no "+N".
 * @param {SessionState} session
 * @returns {RoleGroup[]}
 */
export function teamView(session) {
  const agents = session.agents ?? [];
  const questStart = session.quest ? num(session.quest.startedAt) : null;
  return rosterRoles(session).map((role) => {
    const all = agents.filter((agent) => (isRole(agent.role) ? agent.role : 'aux') === role);
    const active = all.filter((agent) => !agent.finished).sort((a, b) => num(a.startedAt) - num(b.startedAt));
    const finished = all
      .filter((agent) => agent.finished && (questStart === null || num(agent.lastEventAt) >= questStart))
      .sort((a, b) => num(b.lastEventAt) - num(a.lastEventAt));
    const shown = finished.slice(0, MAX_FINISHED_SHOWN);
    const status = active.some((agent) => agent.status === 'waiting')
      ? 'waiting'
      : active.some((agent) => agent.status === 'working') ? 'working' : 'idle';
    return {
      role,
      status,
      activeCount: active.length,
      instances: [...active, ...shown],
      hiddenFinished: finished.length - shown.length,
    };
  });
}

/**
 * Contagem do cabeçalho da equipe: agentes em andamento que estão trabalhando ou
 * aguardando, entre os que não encerraram.
 * @param {SessionState} session
 * @returns {{ active: number, present: number }}
 */
export function partySummary(session) {
  const present = (session.agents ?? []).filter((agent) => !agent.finished);
  return { active: present.filter((agent) => agent.status !== 'idle').length, present: present.length };
}

/**
 * Saúde de um agente em fração e em décimos (para a barra). Sem ações, 100%
 * (modelo de eventos, seção 6, "Saúde").
 * @param {AgentState} agent
 * @returns {{ ok: number, total: number, tenths: number }}
 */
export function healthOf(agent) {
  const total = Math.max(0, num(agent.health?.total));
  const ok = Math.min(total, Math.max(0, num(agent.health?.ok)));
  const tenths = total === 0 ? 10 : Math.round((ok / total) * 10);
  return { ok, total, tenths };
}

/**
 * @typedef {object} ContextView
 * @property {number} pct          uso da janela, 0 a 100 (inteiro)
 * @property {number} freePct      o que ainda cabe na janela: 100 - pct
 * @property {number} usedTokens
 * @property {number} windowTokens
 * @property {number} tenths       décimos de `freePct`, para a barra (0 a 10)
 */

/**
 * Contexto aproximado de um agente para a barra (Foco ou Mana; T16; modelo de
 * eventos, seções 6 e 9). Como no mockup, a barra mostra o contexto que ainda
 * cabe na janela, e ela some (`null`) quando não há leitura: `context` nulo ou
 * fora da forma do contrato (ADR 0008: o indicador some em vez de mostrar zero).
 * @param {AgentState} agent
 * @returns {ContextView|null}
 */
export function contextOf(agent) {
  const context = agent?.context;
  if (!context || typeof context !== 'object') return null;
  const { pct, usedTokens, windowTokens } = context;
  const finite = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isFinite(value);
  if (!finite(pct) || !finite(usedTokens) || !finite(windowTokens) || windowTokens <= 0 || usedTokens < 0) return null;
  const used = Math.min(100, Math.max(0, Math.round(pct)));
  const freePct = 100 - used;
  return { pct: used, freePct, usedTokens, windowTokens, tenths: Math.round(freePct / 10) };
}

/**
 * @typedef {object} PhaseView
 * @property {PhaseId} id
 * @property {Phase} state
 * @property {RoleId} owner
 */

/**
 * @typedef {object} QuestView
 * @property {number} n
 * @property {string} title
 * @property {boolean} implicit
 * @property {QuestStatus} status
 * @property {number} durationMs
 * @property {number} actions
 * @property {string|null} error
 * @property {PhaseView[]} phases
 * @property {boolean} showStepper   só quando alguma etapa sai de 'pending' (seção 6)
 * @property {number} phasesDone
 */

/**
 * Cartão do ticket. Sem ticket (`quest: null`), devolve null.
 * @param {SessionState} session
 * @param {number} now
 * @returns {QuestView|null}
 */
export function questView(session, now) {
  const quest = session.quest;
  if (!quest) return null;
  const end = typeof quest.endedAt === 'number' ? quest.endedAt : now;
  /** @type {PhaseView[]} */
  const phases = PHASES.map((id) => {
    const state = quest.phases?.[id];
    return { id, state: state === 'active' || state === 'done' ? state : 'pending', owner: PHASE_OWNER[id] };
  });
  return {
    n: num(quest.n),
    title: quest.title ?? '',
    implicit: Boolean(quest.implicit),
    status: quest.status,
    durationMs: Math.max(0, end - num(quest.startedAt)),
    actions: num(quest.actions),
    error: quest.error ?? null,
    phases,
    showStepper: phases.some((phase) => phase.state !== 'pending'),
    phasesDone: phases.filter((phase) => phase.state === 'done').length,
  };
}

/**
 * Diz se um evento aparece no feed: tipos de `FEED_KINDS`, e `quest.phase` só
 * quando a etapa termina (contrato, seção 3).
 * @param {CanonicalEvent} event
 * @returns {boolean}
 */
export function isFeedEvent(event) {
  if (!/** @type {readonly string[]} */ (FEED_KINDS).includes(event.kind)) return false;
  if (event.kind === 'quest.phase') return /** @type {{ state?: string }} */ (event.data ?? {}).state === 'done';
  return true;
}

/**
 * Eventos do feed da sessão, mais recentes no topo (por `seq`).
 * @param {SessionState} session
 * @returns {CanonicalEvent[]}
 */
export function feedView(session) {
  return (session.feed ?? []).filter(isFeedEvent).sort((a, b) => num(b.seq) - num(a.seq) || num(b.ts) - num(a.ts));
}
