// @ts-check
// Apoio aos testes ponta a ponta: coleta de problemas da página (CSP, erros,
// requisições de outra origem) e um /events simulado com os snapshots de
// test/fixtures/state/, para desenhar sessões sem depender do T9a.

import { readFileSync } from 'node:fs';

/** @typedef {import('@playwright/test').Page} Page */

/**
 * Passa a registrar, desde antes do primeiro script da página, as violações de
 * CSP (evento securitypolicyviolation e mensagens do console), os erros não
 * tratados e as requisições para outra origem.
 * @param {Page} page
 * @param {string} baseURL
 */
export async function watchPage(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const problems = { external: /** @type {string[]} */ ([]), csp: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]) };
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && url !== 'about:blank') problems.external.push(url);
  });
  page.on('console', (message) => {
    if (/content security policy|refused to (load|apply|execute|connect|frame)/i.test(message.text())) problems.csp.push(message.text());
  });
  page.on('pageerror', (error) => problems.errors.push(String(error)));
  await page.addInitScript(() => {
    const store = /** @type {any} */ (window);
    store.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return {
    problems,
    /** Violações vistas pelo próprio documento. */
    violations: () => page.evaluate(() => /** @type {any} */ (window).__cspViolations ?? []),
  };
}

/**
 * Snapshot de test/fixtures/state/<nome>.json.
 * @param {string} name
 */
export function loadSnapshot(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/state/${name}.json`, import.meta.url), 'utf8'));
}

/**
 * Responde /events com hello e snapshot (formato da seção 9 do modelo de
 * eventos) e /api/state com o mesmo snapshot. O `retry` longo evita que o
 * navegador reabra a conexão durante o teste.
 * @param {Page} page
 * @param {any[]} sessions
 */
export async function mockLiveServer(page, sessions) {
  const seq = Math.max(1, ...sessions.flatMap((s) => (s.feed ?? []).map((/** @type {any} */ e) => e.seq)));
  const snapshot = { seq, sessions };
  const body = 'retry: 3600000\n\n'
    + `event: hello\ndata: ${JSON.stringify({ protocol: 1, runId: 'e2e', seq, serverVersion: 'e2e' })}\n\n`
    + `id: e2e:${seq}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  await page.route('**/events', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' }, body }));
  await page.route('**/api/state', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }));
}
