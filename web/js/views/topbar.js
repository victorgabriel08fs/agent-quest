// @ts-check
// Barra superior: indicadores (ADR 0008, pelo `theme.stats`), selo de conexão,
// alternância de tema e o aviso de aprovação pendente em outra sessão (T13). O
// seletor de sessão fica em views/sessions.js. Cada função devolve HTML com todo
// texto dinâmico escapado (ADR 0006).

import { maskSession } from '../discreet.js';
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

/** @param {unknown} value */
const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/**
 * Sessão com aprovação pendente fora da mostrada (T13): a de evento mais
 * recente, e quantas outras também têm. Null se nenhuma.
 * @param {readonly SessionState[]} list   já ordenada por `sessionList`
 * @param {string|null} selectedId
 * @returns {{ session: SessionState, more: number }|null}
 */
export function pendingElsewhere(list, selectedId) {
  const others = list.filter((session) => session.id !== selectedId && count(session.counters?.pendingApprovals) > 0);
  return others.length > 0 ? { session: others[0], more: others.length - 1 } : null;
}

/**
 * Aviso de aprovação pendente em outra sessão, com o ícone e a palavra do tema
 * (o indicador "pending" de `theme.stats`) e o atalho para a sessão. O botão
 * tem chave estável (`data-focus-key`, a mesma para qualquer sessão, porque o
 * aviso só tem um atalho): o foco volta para ele depois do redesenho, mesmo
 * que o aviso passe a apontar outra sessão. Sem aprovação pendente fora da
 * sessão mostrada, vazio.
 *
 * O aviso visível não é região viva (tem um botão dentro e fica escondido
 * quando vazio): o anúncio para leitores de tela vai por `pendingAnnouncement`,
 * numa região `aria-live` educada que existe sempre (T14).
 * @param {{ list: readonly SessionState[], selectedId: string|null, theme: Theme, now: number, discreet?: boolean }} params
 *   discreet: modo discreto (T14), sem o rótulo da sessão, que vem do título do pedido
 * @returns {string}
 */
export function renderPendingAlert({ list, selectedId, theme, now, discreet = false }) {
  const parts = alertParts({ list, selectedId, theme, now, discreet });
  if (!parts) return '';
  const { session, pending, where, others } = parts;
  return `<span class="alert-icon" aria-hidden="true">${esc(pending?.icon ?? '!')}</span>` +
    `<span class="alert-text"><b>${count(session.counters?.pendingApprovals)}</b> ${esc(pending?.label ?? '')} em ` +
    `<span class="alert-where">${esc(where)}</span>${esc(others)}</span>` +
    `<button type="button" class="alert-go" data-focus-key="session-alert" data-goto="${esc(session.id)}">Ir para a sessão</button>`;
}

/**
 * Texto puro do anúncio do aviso de aprovação pendente em outra sessão, para a
 * região `aria-live` educada (T14). Vazio sem aviso.
 * @param {{ list: readonly SessionState[], selectedId: string|null, theme: Theme, now: number, discreet?: boolean }} params
 * @returns {string}
 */
export function pendingAnnouncement({ list, selectedId, theme, now, discreet = false }) {
  const parts = alertParts({ list, selectedId, theme, now, discreet });
  if (!parts) return '';
  const { session, pending, where, others } = parts;
  return `${count(session.counters?.pendingApprovals)} ${pending?.label ?? ''} em ${where}${others}`;
}

/**
 * Partes do aviso: a sessão (mascarada no modo discreto), o indicador "pending"
 * do tema, onde está e quantas outras sessões também têm aprovação pendente.
 * @param {{ list: readonly SessionState[], selectedId: string|null, theme: Theme, now: number, discreet: boolean }} params
 */
function alertParts({ list, selectedId, theme, now, discreet }) {
  const found = pendingElsewhere(list, selectedId);
  if (!found) return null;
  const session = discreet ? maskSession(found.session) : found.session;
  const pending = theme.stats(statsView(session, now)).find((item) => item.id === 'pending');
  const where = [session.label || session.id, session.project?.name].filter(Boolean).join(' · ');
  const others = found.more > 0 ? ` (e mais ${found.more} ${found.more === 1 ? 'sessão' : 'sessões'})` : '';
  return { session, pending, where, others };
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
