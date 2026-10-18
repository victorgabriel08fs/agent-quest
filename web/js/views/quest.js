// @ts-check
// Cartão do ticket: número, título, status, duração, ações e o stepper das
// etapas (só quando alguma etapa sai de 'pending'). Com `quest: null`, mostra o
// estado vazio do tema (regra 6 do recorte). Devolve HTML escapado.

import { PHASE_TITLES, questView } from '../selectors.js';
import { esc, formatDuration, plural } from '../themes/helpers.js';

/** @typedef {import('../../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../themes/contract.js').Theme} Theme */
/** @typedef {import('../selectors.js').PhaseView} PhaseView */

/** Estado de cada etapa para leitores de tela. */
const PHASE_STATE_TEXT = Object.freeze({ pending: 'pendente', active: 'em andamento', done: 'concluída' });

/**
 * O cartão inteiro (`<div class="card quest">`).
 * @param {{ session: SessionState, theme: Theme, now: number }} params
 * @returns {string}
 */
export function renderQuest({ session, theme, now }) {
  const words = theme.words;
  const view = questView(session, now);
  if (!view) {
    return `<div class="card quest is-empty"><div class="q-info">` +
      `<div class="q-kicker">${esc(words.quest)}</div>` +
      `<h1 class="q-title">${esc(words.noQuest)}</h1>` +
      `<div class="q-meta">${esc(words.noQuestHint)}</div>` +
      `</div></div>`;
  }

  const status = Object.hasOwn(words.questStatus, view.status) ? words.questStatus[view.status] : String(view.status);
  const meta = [
    `<span class="q-time" title="Duração">⏱ ${esc(formatDuration(view.durationMs))}</span>`,
    `<span>${view.actions} ${plural(view.actions, 'ação', 'ações')}</span>`,
  ];
  if (view.showStepper) meta.push(`<span>${view.phasesDone} de ${view.phases.length} etapas</span>`);
  if (view.error) meta.push(`<span class="q-error">erro: <code>${esc(view.error)}</code></span>`);

  const stepper = view.showStepper
    ? `<ol class="stepper" aria-label="Etapas">${view.phases.map((phase, index) => stepHTML(phase, index, theme)).join('')}</ol>`
    : '';

  return `<div class="card quest" data-status="${esc(view.status)}"><div class="q-info">` +
    `<div class="q-kicker">${esc(`${words.quest} #${view.n}`)} · ${esc(status)}</div>` +
    `<h1 class="q-title">${esc(view.title)}</h1>` +
    `<div class="q-meta">${meta.join(' · ')}</div>` +
    `</div>${stepper}</div>`;
}

/**
 * @param {PhaseView} phase
 * @param {number} index
 * @param {Theme} theme
 * @returns {string}
 */
function stepHTML(phase, index, theme) {
  const cls = phase.state === 'pending' ? 'step' : `step ${phase.state}`;
  const mark = phase.state === 'done' ? '✓' : String(index + 1);
  return `<li class="${cls}" data-agent="${esc(phase.owner)}" title="Etapa de ${esc(PHASE_TITLES[phase.id])}">` +
    `<span class="sd" aria-hidden="true">${mark}</span><span class="sl">${esc(theme.phases[phase.id])}</span>` +
    `<span class="sr-only">: ${PHASE_STATE_TEXT[phase.state]}</span></li>`;
}
