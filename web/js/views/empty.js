// @ts-check
// Painel sem sessões: explica como ligar a captura (ADR 0002 e visão geral,
// "Como rodar localmente") e mostra o `lastEventAt` do /api/health
// ("nenhum evento recebido desde HH:MM"). Devolve HTML escapado.

import { esc, formatClock } from '../themes/helpers.js';

/** @typedef {import('../../../shared/contract.js').HealthResponse} HealthResponse */
/** @typedef {import('../themes/contract.js').Theme} Theme */

/**
 * Situação da consulta ao /api/health.
 * @typedef {'loading'|'ok'|'error'} HealthState
 */

/** Comandos para ligar a captura (PowerShell; o deploy imprime o caminho completo). */
export const CAPTURE_COMMANDS = Object.freeze({
  deploy: 'npm run capture:deploy',
  marketplace: 'claude plugin marketplace add "$env:LOCALAPPDATA\\agent-quest\\marketplace"',
  install: 'claude plugin install agent-quest@agent-quest-local',
  reload: '/reload-plugins',
});

/**
 * Linha sobre o último evento recebido pelo servidor.
 * @param {HealthResponse|null} health
 * @param {HealthState} state
 * @returns {string}   texto puro
 */
export function healthLine(health, state) {
  if (state === 'error') return 'Não foi possível consultar o servidor (/api/health).';
  if (!health) return 'Consultando o servidor…';
  if (typeof health.lastEventAt === 'number') {
    return `Último evento recebido às ${formatClock(health.lastEventAt)}.`;
  }
  return `Nenhum evento recebido desde ${formatClock(health.startedAt, { seconds: false })} (início do servidor).`;
}

/**
 * O cartão inteiro (`<div class="card onboarding">`).
 * @param {{ theme: Theme, health: HealthResponse|null, healthState: HealthState }} params
 * @returns {string}
 */
export function renderEmpty({ theme, health, healthState }) {
  const cmd = (/** @type {string} */ text) => `<pre class="cmd"><code>${esc(text)}</code></pre>`;
  return `<div class="card onboarding">` +
    `<div class="q-kicker">Nenhuma sessão</div>` +
    `<h1 class="q-title">${esc(theme.words.noSessions)}</h1>` +
    `<p>As sessões do Claude Code aparecem aqui quando a captura está ligada e o primeiro evento chega. Para ligar a captura (uma vez só), na raiz do repositório, no PowerShell:</p>` +
    `<ol class="howto">` +
    `<li>Copie o plugin para a pasta de dados. O comando também mostra os próximos com o caminho completo.${cmd(CAPTURE_COMMANDS.deploy)}</li>` +
    `<li>Adicione o marketplace local.${cmd(CAPTURE_COMMANDS.marketplace)}</li>` +
    `<li>Instale o plugin.${cmd(CAPTURE_COMMANDS.install)}</li>` +
    `<li>Numa sessão do Claude Code que já estava aberta, rode ${`<code>${esc(CAPTURE_COMMANDS.reload)}</code>`}. As sessões novas já começam com a captura.</li>` +
    `</ol>` +
    `<p class="health" data-state="${esc(healthState)}">${esc(healthLine(health, healthState))}</p>` +
    `</div>`;
}
