// @ts-check
// Helpers de escape e formatação dos temas (ADR 0009) e os despachantes que
// levam cada evento canônico e cada estado de agente à frase certa do tema.
//
// Regra de segurança (ADR 0006): todo texto dinâmico que vira HTML passa por
// `esc`, direto ou por `code`, `b` e `i`. As frases dos temas recebem os dados
// crus e só montam HTML com esses helpers.
//
// Nada aqui depende do DOM: o mesmo código roda no navegador e nos testes do Node.
//
// Modo discreto (T14): com `h.discreet`, os despachantes tiram os textos livres
// dos dados (`maskEventData`) e usam as frases só de categoria de cada tema
// (`hidden`), como "Rodando um comando" ou "Editando um arquivo".

import { maskEventData } from '../discreet.js';

/** @typedef {import('../../../shared/contract.js').RoleId} RoleId */
/** @typedef {import('../../../shared/contract.js').ToolCategory} ToolCategory */
/** @typedef {import('../../../shared/contract.js').CanonicalEvent} CanonicalEvent */
/** @typedef {import('../../../shared/contract.js').AgentState} AgentState */
/** @typedef {import('./contract.js').Theme} Theme */
/** @typedef {import('./contract.js').ThemeHelpers} ThemeHelpers */

/** @type {Record<string, string>} */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapa texto para HTML (conteúdo e atributos entre aspas).
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** @param {unknown} value */
export const code = (value) => `<code>${esc(value)}</code>`;
/** @param {unknown} value */
export const b = (value) => `<b>${esc(value)}</b>`;
/** @param {unknown} value */
export const i = (value) => `<i>${esc(value)}</i>`;

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
export const plural = (n, one, many) => (n === 1 ? one : many);

/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');

/**
 * Duração em "mm:ss", ou "h:mm:ss" a partir de uma hora.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

/**
 * Hora local de um instante, em "HH:MM:SS" (ou "HH:MM" sem os segundos).
 * @param {number} ts   ms desde a época
 * @param {{ seconds?: boolean }} [options]
 * @returns {string}
 */
export function formatClock(ts, { seconds = true } = {}) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '--:--';
  const hm = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return seconds ? `${hm}:${two(date.getSeconds())}` : hm;
}

/**
 * Monta os helpers `h` de um tema para uma sessão: os nomes dos agentes são
 * resolvidos pela lista `agents` do estado da sessão.
 * @param {Theme} theme
 * @param {readonly AgentState[]} [agents]
 * @param {{ discreet?: boolean }} [options]   discreet: modo discreto (T14)
 * @returns {ThemeHelpers}
 */
export function createHelpers(theme, agents = [], { discreet = false } = {}) {
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const roles = /** @type {Record<string, import('./contract.js').RoleWords>} */ (theme.roles);
  const phases = /** @type {Record<string, string>} */ (theme.phases);

  /** @param {string} roleId @returns {import('./contract.js').RoleWords|null} */
  const wordsOf = (roleId) => (Object.hasOwn(roles, roleId) ? roles[roleId] : null);
  /** @param {string} roleId @param {string|null|undefined} agentType */
  const nameOf = (roleId, agentType) => {
    const words = wordsOf(roleId);
    if (roleId === 'aux' || !words) return agentType || theme.roles.aux.name;
    return words.name;
  };
  /** @param {string|null} key @returns {RoleId} */
  const roleOf = (key) => {
    const agent = byKey.get(key ?? 'main');
    if (agent && wordsOf(agent.role)) return agent.role;
    return key == null || key === 'main' ? 'orq' : 'aux';
  };

  return {
    discreet: Boolean(discreet),
    esc,
    code,
    b,
    i,
    plural,
    duration: formatDuration,
    role: (key) => b(nameOf(roleOf(key), byKey.get(key ?? 'main')?.agentType)),
    roleName: (roleId, agentType = null) => b(nameOf(roleId, agentType)),
    roleOf,
    short: (roleId) => (wordsOf(roleId) ?? theme.roles.aux).short,
    phase: (phaseId) => (Object.hasOwn(phases, phaseId) ? phases[phaseId] : String(phaseId)),
  };
}

// ---------------------------------------------------------------------------
// Despachantes: escolhem a frase do tema para cada evento e cada agente.
// ---------------------------------------------------------------------------

/**
 * Frase com dados do evento. Recebe os dados crus e devolve HTML seguro.
 * @typedef {(data: Record<string, any>, h: ThemeHelpers) => string} DataPhrase
 */

/**
 * Frase com o agente do evento: `who` já é HTML seguro (`h.role`).
 * @typedef {(who: string, data: Record<string, any>, h: ThemeHelpers, role: RoleId) => string} AgentPhrase
 */

/**
 * Frases do feed de um tema, uma por situação.
 * @typedef {object} FeedPhrases
 * @property {DataPhrase} sessionStarted
 * @property {DataPhrase} sessionEnded
 * @property {DataPhrase} questStarted
 * @property {{ done: DataPhrase, failed: DataPhrase, interrupted: DataPhrase }} questFinished
 * @property {DataPhrase} phaseDone
 * @property {AgentPhrase} delegated
 * @property {{ done: AgentPhrase, unknown: AgentPhrase }} agentFinished
 * @property {Record<ToolCategory, AgentPhrase>} tool
 * @property {AgentPhrase} toolFailed
 * @property {AgentPhrase} toolInterrupted
 * @property {AgentPhrase} testPassed
 * @property {AgentPhrase} testFailed
 * @property {AgentPhrase} permissionRequested
 * @property {{ approved: AgentPhrase, denied: AgentPhrase, unknown: AgentPhrase }} permissionResolved
 * @property {AgentPhrase} compacted
 * @property {HiddenFeedPhrases} hidden   modo discreto: frases só de categoria (T14)
 */

/**
 * Frases do feed no modo discreto, sem alvo, detalhe, título nem erro.
 * @typedef {object} HiddenFeedPhrases
 * @property {DataPhrase} questStarted
 * @property {Record<ToolCategory, AgentPhrase>} tool
 * @property {AgentPhrase} toolFailed
 * @property {AgentPhrase} toolInterrupted
 * @property {AgentPhrase} permissionRequested   pela categoria da ferramenta (`data.category`)
 */

/**
 * Frases da linha de ação (texto puro, sem HTML).
 * @typedef {object} ActionPhrases
 * @property {string} idle
 * @property {string} orqIdle
 * @property {string} start
 * @property {string} waiting
 * @property {(text: string|null) => string} delegating
 * @property {string} compacting
 * @property {string} failed
 * @property {Record<ToolCategory, (target: string, role: RoleId) => string>} doing
 * @property {Record<ToolCategory, (role: RoleId) => string>} hidden   modo discreto: só a categoria (T14)
 */

/**
 * Valor próprio de uma tabela de frases, ou o padrão. Ignora chaves herdadas
 * (`toString`, `constructor`), que poderiam vir nos dados de um evento.
 * @template T
 * @param {Record<string, T>} table
 * @param {unknown} key
 * @param {string} fallback   chave padrão, que precisa existir na tabela
 * @returns {T}
 */
export function pick(table, key, fallback) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : table[fallback];
}

/**
 * Alvo de uma ferramenta para exibição: o `target` do evento, senão o nome da
 * ferramenta. Nunca devolve vazio.
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function targetOf(data) {
  for (const value of [data.target, data.tool]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '…';
}

/**
 * Linha do feed para um evento canônico. Devolve null para os tipos que não
 * entram no feed (contrato, seção 3) e para `quest.phase` que não seja `done`.
 * @param {FeedPhrases} p
 * @param {CanonicalEvent} event
 * @param {ThemeHelpers} h
 * @returns {string|null}
 */
export function feedLineFrom(p, event, h) {
  if (h.discreet) return hiddenFeedLine(p, event, h);
  const d = /** @type {Record<string, any>} */ (event.data ?? {});
  const role = h.roleOf(event.agentKey);
  const who = h.role(event.agentKey);
  switch (event.kind) {
    case 'session.started': return p.sessionStarted(d, h);
    case 'session.ended': return p.sessionEnded(d, h);
    case 'quest.started': return p.questStarted(d, h);
    case 'quest.finished': return pick(p.questFinished, d.outcome, 'interrupted')(d, h);
    case 'quest.phase': return d.state === 'done' ? p.phaseDone(d, h) : null;
    case 'agent.delegated': return p.delegated(who, d, h, role);
    case 'agent.finished': return (d.outcome === 'done' ? p.agentFinished.done : p.agentFinished.unknown)(who, d, h, role);
    case 'tool.started': return pick(p.tool, d.category, 'other')(who, d, h, role);
    case 'tool.failed': return (d.interrupted ? p.toolInterrupted : p.toolFailed)(who, d, h, role);
    case 'test.finished': return (d.ok ? p.testPassed : p.testFailed)(who, d, h, role);
    case 'permission.requested': return p.permissionRequested(who, d, h, role);
    case 'permission.resolved': return pick(p.permissionResolved, d.outcome, 'unknown')(who, d, h, role);
    case 'context.compacted': return p.compacted(who, d, h, role);
    default: return null;
  }
}

/**
 * Linha do feed no modo discreto: os dados chegam sem os textos livres, e as
 * linhas que mostrariam alvo, título ou erro usam as frases só de categoria.
 * @param {FeedPhrases} p
 * @param {CanonicalEvent} event
 * @param {ThemeHelpers} h
 * @returns {string|null}
 */
function hiddenFeedLine(p, event, h) {
  const d = maskEventData(event.data);
  const role = h.roleOf(event.agentKey);
  const who = h.role(event.agentKey);
  switch (event.kind) {
    case 'quest.started': return p.hidden.questStarted(d, h);
    case 'tool.started': return pick(p.hidden.tool, d.category, 'other')(who, d, h, role);
    case 'tool.failed': return (d.interrupted ? p.hidden.toolInterrupted : p.hidden.toolFailed)(who, d, h, role);
    case 'permission.requested': return p.hidden.permissionRequested(who, d, h, role);
    default: return feedLineFrom(p, { ...event, data: d }, { ...h, discreet: false });
  }
}

/**
 * Linha de ação de um agente (balão e cartão), em texto puro.
 * Sem agente (papel do time sem instância na sessão), o texto de ocioso. No
 * modo discreto, a delegação sai sem a descrição e a ferramenta, só com a
 * categoria.
 * @param {ActionPhrases} p
 * @param {AgentState|null} agent
 * @param {boolean} [discreet]
 * @returns {string}
 */
export function actionTextFrom(p, agent, discreet = false) {
  if (!agent) return p.idle;
  if (agent.status === 'waiting') return p.waiting;
  if (agent.finished) return p.idle;
  if (agent.status === 'idle') return agent.role === 'orq' ? p.orqIdle : p.idle;
  const activity = agent.activity;
  if (!activity || activity.kind === 'start') return p.start;
  if (activity.kind === 'delegate') return p.delegating(discreet ? null : activity.detail || activity.target || null);
  if (activity.kind === 'compact') return p.compacting;
  if (activity.state === 'failed') return p.failed;
  if (discreet) return pick(p.hidden, activity.category, 'other')(agent.role);
  return pick(p.doing, activity.category, 'other')(targetOf(activity), agent.role);
}
