// @ts-check
// Cartão da equipe: um bloco por papel do `roster`, com as instâncias de cada
// papel (rótulo, status, linha de ação de `theme.actionText` e barra de saúde).
// "×N" conta só as instâncias não encerradas; convidados (`aux`) mostram o
// `agent_type` real (ADR 0007). Devolve HTML com todo texto dinâmico escapado.

import { ROLE_TITLES, healthOf, partySummary, teamView } from '../selectors.js';
import { createHelpers, esc, plural } from '../themes/helpers.js';

/** @typedef {import('../../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../../shared/contract.js').AgentState} AgentState */
/** @typedef {import('../themes/contract.js').Theme} Theme */
/** @typedef {import('../themes/contract.js').ThemeHelpers} ThemeHelpers */
/** @typedef {import('../selectors.js').RoleGroup} RoleGroup */

/** Status para leitores de tela (igual nos dois temas). */
const STATUS_TEXT = Object.freeze({
  working: 'Trabalhando',
  waiting: 'Aguardando aprovação',
  idle: 'Ocioso',
  finished: 'Encerrado',
});

/**
 * Conteúdo do cartão da equipe (cabeçalho, lista e legenda da barra).
 * @param {{ session: SessionState|null, theme: Theme }} params
 * @returns {string}
 */
export function renderParty({ session, theme }) {
  const title = `<h2 id="party-title">${esc(theme.words.party)}</h2>`;
  if (!session) {
    return `<div class="card-head">${title}</div><p class="card-empty">${esc(theme.words.noAgents)}</p>`;
  }
  const h = createHelpers(theme, session.agents ?? []);
  const { active, present } = partySummary(session);
  const count = `<span class="muted" id="party-count">${active}/${present} ${plural(active, 'ativo', 'ativos')}</span>`;
  const members = teamView(session).map((group) => memberHTML(group, theme, h)).join('');
  return `<div class="card-head">${title}${count}</div>` +
    `<ul class="roster">${members}</ul>` +
    `<div class="mini-legend"><span><i class="sw hp" aria-hidden="true"></i>${esc(theme.bars.health)}: ≈ fração das últimas 10 ações sem erro</span></div>`;
}

/**
 * @param {RoleGroup} group
 * @param {Theme} theme
 * @param {ThemeHelpers} h
 * @returns {string}
 */
function memberHTML(group, theme, h) {
  const words = theme.roles[group.role];
  const count = group.activeCount > 1
    ? `<span class="m-count" title="${group.activeCount} instâncias em andamento">×${group.activeCount}</span>`
    : '';
  const body = group.instances.length === 0
    ? `<div class="m-action">${esc(theme.actionText(null, h))}</div>`
    : `<ul class="instances${group.instances.length > 1 ? ' multi' : ''}">${group.instances.map((agent) => instanceHTML(agent, theme, h)).join('')}</ul>`;
  const more = group.hiddenFinished > 0
    ? `<div class="m-more">+${group.hiddenFinished} ${plural(group.hiddenFinished, 'instância encerrada', 'instâncias encerradas')}</div>`
    : '';
  return `<li class="member ${esc(group.status)}" data-agent="${esc(group.role)}">` +
    `<span class="avatar"><span aria-hidden="true">${esc(words.icon)}</span><i class="status-dot" aria-hidden="true"></i></span>` +
    `<div class="m-body">` +
    `<div class="m-head"><span class="m-name">${esc(words.name)}</span>${count}</div>` +
    `<div class="m-sub"><span class="m-role">${esc(ROLE_TITLES[group.role])}</span></div>` +
    body + more +
    `</div></li>`;
}

/**
 * Uma instância: rótulo (se houver), linha de ação e saúde.
 * @param {AgentState} agent
 * @param {Theme} theme
 * @param {ThemeHelpers} h
 * @returns {string}
 */
function instanceHTML(agent, theme, h) {
  const state = agent.finished ? 'finished' : agent.status;
  const statusText = Object.hasOwn(STATUS_TEXT, state) ? STATUS_TEXT[/** @type {keyof typeof STATUS_TEXT} */ (state)] : '';
  const isGuest = agent.role === 'aux' || !Object.hasOwn(theme.roles, agent.role);
  const type = isGuest && agent.agentType ? `<span class="i-type">${esc(agent.agentType)}</span>` : '';
  const label = agent.label && !(isGuest && agent.label === agent.agentType) ? `<span class="i-text">${esc(agent.label)}</span>` : '';
  // A sessão principal com label vazio mostra só o nome do papel orq; com label
  // (sessão iniciada com --agent), ele aparece como detalhe (seção 9).
  const labelLine = type || label
    ? `<div class="i-label" title="${esc([agent.agentType, agent.label].filter(Boolean).join(' · '))}"><i class="i-dot" aria-hidden="true"></i>${type}${label}</div>`
    : '';
  const health = healthOf(agent);
  const healthText = health.total === 0
    ? `${theme.bars.health}: nenhuma ação ainda`
    : `${theme.bars.health} ≈ ${health.ok} de ${health.total} ${plural(health.total, 'ação', 'ações')} sem erro (últimas 10)`;
  return `<li class="inst ${esc(state)}" data-key="${esc(agent.key)}">` +
    labelLine +
    `<div class="m-action"><span class="sr-only">${statusText}: </span>${esc(theme.actionText(agent, h))}</div>` +
    `<div class="m-bars"><div class="mb" title="${esc(healthText)}"><span class="mb-l" aria-hidden="true">${esc(theme.bars.health)}</span>` +
    `<span class="mbar hp" role="img" aria-label="${esc(healthText)}"><i data-fill="${health.tenths}"></i></span></div></div>` +
    `</li>`;
}
