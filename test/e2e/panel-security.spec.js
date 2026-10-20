// @ts-check
// Segurança do painel com os elementos do T11b (filtros, botões da equipe,
// contagem e lista atualizada no lugar), no Edge, com o servidor real:
// - nada de script ou estilo inline (CSP do ADR 0006): cabeçalho da página,
//   index.html e o DOM depois de desenhar tudo;
// - nenhum dado de evento vira HTML: rótulos, descrições, tipos de agente,
//   comandos, caminhos e erros com <script>, <img onerror>, aspas e ANSI
//   aparecem como texto, nos dois temas e com os filtros ligados;
// - nada carregado da internet (nem a URL que vem num comando).

import { expect, test } from '@playwright/test';
import { createScenario, expectedIds, inject, startLiveServer, visibleIds, waitPanelFeed } from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */

const ESC = '\x1b';
const FILE = (/** @type {string} */ name) => `C:\\Users\\fulano\\Projetos\\agents-quest\\${name}`;

/** Sessão com dados hostis em todos os campos de texto que chegam ao painel. */
function hostileScenario() {
  const s = createScenario({ label: 'hostil' });
  const guest = s.agent('g', `plugin:<img src=x data-xss="3" onerror="window.__xss=3">`);
  const tester = s.agent('t', 'tester');
  s.start().prompt(`<script>window.__xss=1</script> "aspas" 'simples' ${ESC}[31mvermelho${ESC}[0m <xss-marca>`);
  s.tool('Read', { file_path: FILE('docs\\<img src=x data-xss="6" onerror="window.__xss=6">.md') });
  const call = s.delegate(guest, `"><img src=x data-xss="2" onerror="window.__xss=2"> & <xss-marca> 'x'`);
  s.tool('Bash', {
    command: `echo "<script>window.__xss=4</script>" && printf '${ESC}[1;31m%s${ESC}[0m' "x' onmouseover='window.__xss=5" && curl https://example.com/<xss-marca>`,
    description: '<b data-xss="8">negrito</b> "aspas"',
  }, { agent: guest });
  s.tool('Grep', { pattern: '"><xss-marca data-xss="9">', path: 'web' }, { agent: guest });
  s.tool('Bash', { command: 'node -e "x"' }, { agent: guest, error: `<svg data-xss="7" onload="window.__xss=7"><xss-marca> falhou "aspas" ${ESC}[31merro${ESC}[0m` });
  s.finish(guest, call);
  const tcall = s.delegate(tester, `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ <xss-marca data-xss="10">`);
  s.tool('Write', { file_path: FILE(`x"><xss-marca data-xss="11">.js`), content: 'CONTEUDO' }, { agent: tester });
  s.finish(tester, tcall);
  return { s, guestKey: guest.id, testerKey: tester.id };
}

/** O que não pode existir no DOM depois de desenhar dados hostis. */
const domProblems = () => {
  const problems = [];
  if (document.querySelectorAll('xss-marca, [data-xss]').length > 0) problems.push('elemento vindo de dado de evento');
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      if (attr.startsWith('on')) problems.push(`atributo ${attr} em <${el.tagName.toLowerCase()}>`);
      if (attr === 'style') problems.push(`style inline em <${el.tagName.toLowerCase()}>`);
    }
  }
  for (const script of document.querySelectorAll('script')) {
    if (!script.getAttribute('src')) problems.push('script inline');
  }
  if (document.querySelectorAll('style').length > 0) problems.push('<style> na página');
  if (/** @type {any} */ (window).__xss !== undefined) problems.push(`código executado: ${String(/** @type {any} */ (window).__xss)}`);
  if ((document.body.textContent ?? '').includes('\x1b')) problems.push('ESC (ANSI) no texto da página');
  return problems;
};

test.describe('segurança do painel com os filtros (tester)', () => {
  // Prazo maior que o padrão de 30 s: cada teste sobe o próprio servidor e tem muitos passos, e o E2E roda com vários workers.
  test.describe.configure({ timeout: 90_000 });
  /** @type {LiveServer|null} */
  let server = null;

  test.beforeEach(async () => {
    server = await startLiveServer();
  });

  test.afterEach(async () => {
    await server?.dispose();
    server = null;
  });

  test('CSP da página sem exceção para inline; index.html sem script nem estilo inline', async ({ request }) => {
    if (!server) throw new Error('sem servidor');
    const response = await request.get(`${server.base}/`);
    expect(response.status()).toBe(200);
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toMatch(/style-src 'self'(;|$)/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|nonce-|sha256-|https?:/);
    const html = await response.text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//i);
    for (const asset of ['/css/layout.css', '/css/base.css', '/js/main.js', '/js/views/feed.js', '/js/views/party.js']) {
      const body = await (await request.get(`${server.base}${asset}`)).text();
      expect(body, asset).not.toMatch(/@import|url\(\s*['"]?https?:|https?:\/\/(?!127\.0\.0\.1)[a-z]/i);
    }
  });

  for (const themeId of ['escritorio', 'guilda']) {
    test(`${themeId}: dados hostis viram texto em todas as regiões, com filtros e troca de tema, sem CSP violada nem requisição externa`, async ({ page }) => {
      if (!server) throw new Error('sem servidor');
      const watch = await watchPage(page, server.base);
      /** @type {string[]} */
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      const { s, guestKey, testerKey } = hostileScenario();
      await page.goto(`${server.base}/#${themeId}`);
      await expect(page.locator('#conn')).toHaveText('ao vivo');
      const state = await inject(server, s);
      const session = state.sessions.find((x) => x.id === s.sessionId);
      await waitPanelFeed(page, session);
      expect(session.feed.length).toBeGreaterThan(8);

      // Os textos hostis aparecem como texto (já redigidos pelo servidor).
      const feedText = await page.locator('#feed-entries').textContent();
      expect(feedText).toContain('<xss-marca>');
      expect(feedText).toContain('onerror=');
      const partyText = await page.locator('#party').textContent();
      expect(partyText).toContain('<img src=x');
      expect(await page.evaluate(domProblems)).toEqual([]);

      // Filtros ligados: convidado (papel e instância), tester; e troca de tema com eles.
      await page.locator('#feed-filters [data-filter="role:aux"]').click();
      expect((await visibleIds(page)).length).toBeGreaterThan(0);
      await page.locator(`#party [data-filter="agent:${guestKey}"]`).click();
      expect(await visibleIds(page)).toEqual(expectedIds(session, (e) => e.agentKey === guestKey));
      await page.keyboard.press('t');
      expect(await page.evaluate(domProblems)).toEqual([]);
      await page.locator(`#party [data-filter="agent:${testerKey}"]`).click();
      await page.locator('#feed-filters [data-filter="role:tes"]').click();
      await page.keyboard.press('t');
      await page.locator('#feed-filters [data-filter=""]').click();
      await page.locator('#party .member[data-agent="aux"]').hover();
      await page.locator('#feed-entries li.entry').first().hover();
      expect(await page.evaluate(domProblems)).toEqual([]);

      // Atributos com texto do evento (title) guardam as aspas sem abrir atributo novo.
      const titles = await page.locator('#party [title]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('title')));
      expect(titles.some((t) => String(t).includes('"><img'))).toBe(true);

      expect(dialogs).toEqual([]);
      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.csp).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
    });
  }
});
