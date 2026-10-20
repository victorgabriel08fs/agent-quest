// @ts-check
// Cartão da equipe: um bloco por papel do `roster`, com as instâncias de cada
// papel (rótulo, status, linha de ação de `theme.actionText` e barra de saúde).
// "×N" conta só as instâncias não encerradas; convidados (`aux`) mostram o
// `agent_type` real (ADR 0007). Devolve HTML com todo texto dinâmico escapado.
//
// Filtros do feed (T11b), como no mockup: o nome do papel é um botão que
// filtra a atividade pelo papel, e cada instância é um botão que filtra pela
// instância. Clicar de novo no mesmo desfaz o filtro (o main.js liga os
// cliques; o clique no resto do bloco vale como clique no papel). O botão
// apertado tem aria-pressed="true", e o bloco ou a linha ganham `is-filter`.

import { ROLE_TITLES, healthOf, partySummary, teamView } from '../selectors.js';
import { createHelpers, esc, plural } from '../themes/helpers.js';
import { ALL, agentFilter, roleFilter } from './feed.js';

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
 * @param {{ session: SessionState|null, theme: Theme, filter?: string }} params
 *   filter: o filtro do feed em vigor (`resolveFilter`), para marcar o botão apertado
 * @returns {string}
 */
export function renderParty({ session, theme, filter = ALL }) {
  const title = `<h2 id="party-title">${esc(theme.words.party)}</h2>`;
  if (!session) {
    return `<div class="card-head">${title}</div><p class="card-empty">${esc(theme.words.noAgents)}</p>`;
  }
  const h = createHelpers(theme, session.agents ?? []);
  const { active, present } = partySummary(session);
  const count = `<span class="muted" id="party-count">${active}/${present} ${plural(active, 'ativo', 'ativos')}</span>`;
  const members = teamView(session).map((group) => memberHTML(group, theme, h, filter)).join('');
  return `<div class="card-head">${title}${count}</div>` +
    `<ul class="roster">${members}</ul>` +
    `<div class="mini-legend"><span><i class="sw hp" aria-hidden="true"></i>${esc(theme.bars.health)}: ≈ fração das últimas 10 ações sem erro</span></div>`;
}

/**
 * @param {RoleGroup} group
 * @param {Theme} theme
 * @param {ThemeHelpers} h
 * @param {string} filter
 * @returns {string}
 */
function memberHTML(group, theme, h, filter) {
  const words = theme.roles[group.role];
  const value = roleFilter(group.role);
  const pressed = filter === value;
  const count = group.activeCount > 1
    ? `<span class="m-count" title="${group.activeCount} instâncias em andamento">×${group.activeCount}</span>`
    : '';
  const body = group.instances.length === 0
    ? `<div class="m-action">${esc(theme.actionText(null, h))}</div>`
    : `<ul class="instances${group.instances.length > 1 ? ' multi' : ''}">${group.instances.map((agent) => instanceHTML(agent, theme, h, filter)).join('')}</ul>`;
  const more = group.hiddenFinished > 0
    ? `<div class="m-more">+${group.hiddenFinished} ${plural(group.hiddenFinished, 'instância encerrada', 'instâncias encerradas')}</div>`
    : '';
  return `<li class="member ${esc(group.status)}${pressed ? ' is-filter' : ''}" data-agent="${esc(group.role)}">` +
    `<span class="avatar"><span aria-hidden="true">${esc(words.icon)}</span><i class="status-dot" aria-hidden="true"></i></span>` +
    `<div class="m-body">` +
    `<div class="m-head"><button type="button" class="m-name m-pick" data-filter="${esc(value)}" aria-pressed="${pressed}" ` +
    `title="${esc(`Filtrar a atividade: só ${words.name}`)}">${esc(words.name)}</button>${count}</div>` +
    `<div class="m-sub"><span class="m-role">${esc(ROLE_TITLES[group.role])}</span></div>` +
    body + more +
    `</div></li>`;
}

/**
 * Uma instância: rótulo (se houver), linha de ação e saúde, dentro do botão
 * que filtra a atividade pela instância (por isso só elementos de frase).
 * @param {AgentState} agent
 * @param {Theme} theme
 * @param {ThemeHelpers} h
 * @param {string} filter
 * @returns {string}
 */
function instanceHTML(agent, theme, h, filter) {
  const state = agent.finished ? 'finished' : agent.status;
  const statusText = Object.hasOwn(STATUS_TEXT, state) ? STATUS_TEXT[/** @type {keyof typeof STATUS_TEXT} */ (state)] : '';
  const isGuest = agent.role === 'aux' || !Object.hasOwn(theme.roles, agent.role);
  const type = isGuest && agent.agentType ? `<span class="i-type">${esc(agent.agentType)}</span>` : '';
  const label = agent.label && !(isGuest && agent.label === agent.agentType) ? `<span class="i-text">${esc(agent.label)}</span>` : '';
  // A sessão principal com label vazio mostra só o nome do papel orq; com label
  // (sessão iniciada com --agent), ele aparece como detalhe (seção 9).
  const labelLine = type || label
    ? `<span class="i-label" title="${esc([agent.agentType, agent.label].filter(Boolean).join(' · '))}"><i class="i-dot" aria-hidden="true"></i>${type}${label}</span>`
    : '';
  const health = healthOf(agent);
  const healthText = health.total === 0
    ? `${theme.bars.health}: nenhuma ação ainda`
    : `${theme.bars.health} ≈ ${health.ok} de ${health.total} ${plural(health.total, 'ação', 'ações')} sem erro (últimas 10)`;
  const key = typeof agent.key === 'string' ? agent.key : '';
  const value = agentFilter(key);
  const pressed = key !== '' && filter === value;
  const content = labelLine +
    `<span class="m-action"><span class="sr-only">${statusText}: </span>${esc(theme.actionText(agent, h))}</span>` +
    `<span class="m-bars"><span class="mb" title="${esc(healthText)}"><span class="mb-l" aria-hidden="true">${esc(theme.bars.health)}</span>` +
    `<span class="mbar hp" role="img" aria-label="${esc(healthText)}"><i data-fill="${health.tenths}"></i></span></span></span>`;
  // Sem chave não há como filtrar: a linha aparece, sem botão.
  const row = key === ''
    ? `<span class="inst-pick is-static">${content}</span>`
    : `<button type="button" class="inst-pick" data-filter="${esc(value)}" aria-pressed="${pressed}" title="Filtrar a atividade por esta instância">${content}</button>`;
  return `<li class="inst ${esc(state)}${pressed ? ' is-filter' : ''}" data-key="${esc(key)}">${row}</li>`;
}
