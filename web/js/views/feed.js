// @ts-check
// Feed de atividade: uma linha de `theme.feedLine` por evento de `FEED_KINDS`,
// mais recentes no topo. Comandos, caminhos e títulos aparecem como chegam do
// servidor, já redigidos (decisão 3 do plano), e passam pelos helpers de escape.
// Filtros e animação de entrada chegam no T11b.

import { feedView } from '../selectors.js';
import { createHelpers, esc, formatClock, plural } from '../themes/helpers.js';

/** @typedef {import('../../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../../shared/contract.js').CanonicalEvent} CanonicalEvent */
/** @typedef {import('../themes/contract.js').Theme} Theme */
/** @typedef {import('../themes/contract.js').ThemeHelpers} ThemeHelpers */

/**
 * Tom da linha (fundo colorido), igual nos dois temas.
 * @param {CanonicalEvent} event
 * @returns {''|'bad'|'good'|'warn'}
 */
export function feedTone(event) {
  const d = /** @type {Record<string, any>} */ (event.data ?? {});
  switch (event.kind) {
    case 'tool.failed': return d.interrupted ? 'warn' : 'bad';
    case 'test.finished': return d.ok ? 'good' : 'bad';
    case 'quest.phase': return 'good';
    case 'quest.finished': return d.outcome === 'done' ? 'good' : d.outcome === 'failed' ? 'bad' : '';
    case 'permission.requested': return 'warn';
    default: return '';
  }
}

/**
 * Ícone de sistema das linhas de sessão, ticket e etapa; null para as linhas
 * de agente, que mostram o retrato do papel.
 * @param {CanonicalEvent} event
 * @param {Theme} theme
 * @returns {string|null}
 */
export function systemIcon(event, theme) {
  const d = /** @type {Record<string, any>} */ (event.data ?? {});
  switch (event.kind) {
    case 'session.started':
    case 'session.ended': return theme.icons.session;
    case 'quest.started': return theme.icons.questStarted;
    case 'quest.phase': return theme.icons.phaseDone;
    case 'quest.finished':
      return d.outcome === 'done' ? theme.icons.questDone : d.outcome === 'failed' ? theme.icons.questFailed : theme.icons.questInterrupted;
    default: return null;
  }
}

/**
 * Conteúdo do cartão de atividade (cabeçalho e lista).
 * @param {{ session: SessionState|null, theme: Theme }} params
 * @returns {string}
 */
export function renderFeed({ session, theme }) {
  const title = `<h2 id="feed-title">${esc(theme.words.feed)}</h2>`;
  const empty = (count = '') => `<div class="card-head">${title}${count}</div><p class="card-empty">${esc(theme.words.noFeed)}</p>`;
  if (!session) return empty();

  const h = createHelpers(theme, session.agents ?? []);
  const entries = [];
  for (const event of feedView(session)) {
    const line = theme.feedLine(event, h);
    if (line) entries.push(entryHTML(event, line, theme, h));
  }
  if (entries.length === 0) return empty();
  const count = `<span class="muted">${entries.length} ${plural(entries.length, 'evento', 'eventos')}</span>`;
  return `<div class="card-head">${title}${count}</div><ol class="entries">${entries.join('')}</ol>`;
}

/**
 * @param {CanonicalEvent} event
 * @param {string} line   HTML seguro do tema
 * @param {Theme} theme
 * @param {ThemeHelpers} h
 * @returns {string}
 */
function entryHTML(event, line, theme, h) {
  const tone = feedTone(event);
  const sys = systemIcon(event, theme);
  let avatar;
  if (sys) {
    avatar = `<span class="e-av sys" aria-hidden="true">${esc(sys)}</span>`;
  } else {
    const role = h.roleOf(event.agentKey);
    avatar = `<span class="e-av" data-agent="${esc(role)}" aria-hidden="true">${esc(theme.roles[role].icon)}</span>`;
  }
  // Número finito pode estar fora do intervalo de datas (±8,64e15 ms), e aí
  // toISOString() lança: a linha sai sem horário, e o feed continua.
  const ts = Number(event.ts);
  const date = new Date(ts);
  const time = Number.isFinite(date.getTime())
    ? `<time datetime="${date.toISOString()}">${formatClock(ts)}</time>`
    : '';
  return `<li class="entry${tone ? ` ${tone}` : ''}" data-id="${esc(event.id)}" data-kind="${esc(event.kind)}">` +
    `${avatar}<div class="e-body"><div class="e-text">${line}</div>${time}</div></li>`;
}
