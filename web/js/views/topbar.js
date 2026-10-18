// @ts-check
// Barra superior: indicadores (ADR 0008, pelo `theme.stats`), selo de conexão e
// alternância de tema. O seletor de sessão fica em views/sessions.js. Cada
// função devolve HTML com todo texto dinâmico escapado (ADR 0006).

import { statsView } from '../selectors.js';
import { esc } from '../themes/helpers.js';

/** @typedef {import('../../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../themes/contract.js').Theme} Theme */
/** @typedef {import('../connection.js').ConnectionState} ConnectionState */

/** Texto e tooltip do selo de conexão (iguais nos dois temas). */
export const CONNECTION_LABELS = Object.freeze({
  connecting: { label: 'conectando', title: 'Abrindo a conexão com o servidor local' },
  live: { label: 'ao vivo', title: 'Recebendo os eventos do servidor local' },
  reconnecting: { label: 'reconectando', title: 'A conexão caiu; tentando de novo' },
  offline: { label: 'desconectado', title: 'Sem conexão ao vivo com o servidor local' },
});

/**
 * Indicadores do topo, na ordem do tema. Sem sessão, vazio.
 * @param {SessionState|null} session
 * @param {Theme} theme
 * @param {number} now
 * @returns {string}
 */
export function renderStats(session, theme, now) {
  if (!session) return '';
  return theme.stats(statsView(session, now)).map((stat) =>
    `<span class="stat${stat.highlight ? ' pending' : ''}" data-stat="${esc(stat.id)}" title="${esc(stat.title)}">` +
    `<span aria-hidden="true">${esc(stat.icon)}</span><b>${esc(stat.value)}</b><span class="l">${esc(stat.label)}</span></span>`).join('');
}

/**
 * Selo de conexão.
 * @param {ConnectionState} state
 * @returns {string}
 */
export function renderConnection(state) {
  const key = Object.hasOwn(CONNECTION_LABELS, state) ? state : 'offline';
  const { label, title } = CONNECTION_LABELS[key];
  return `<span class="conn conn-${key}" title="${esc(title)}"><i aria-hidden="true"></i>${esc(label)}</span>`;
}

/**
 * Botões da alternância de tema, com o atalho de cada um (1, 2...).
 * @param {readonly Theme[]} themes
 * @param {string} currentId
 * @returns {string}
 */
export function renderThemeToggle(themes, currentId) {
  return themes.map((theme, index) =>
    `<button type="button" data-theme="${esc(theme.id)}" aria-pressed="${theme.id === currentId}" title="${esc(theme.name)} (${index + 1})">` +
    `<span aria-hidden="true">${esc(theme.icon)}</span>${esc(theme.name)}</button>`).join('');
}
