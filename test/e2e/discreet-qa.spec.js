// @ts-check
// Modo discreto (T14; ADR 0006; modelo de eventos, seção 10) no Edge, com o
// servidor real e cenários fictícios: com o modo ligado, nenhum texto livre
// dos eventos pode aparecer em lugar nenhum do DOM (texto, atributos, title,
// aria-label, opções do seletor, aviso, região viva, legenda, cena, feed e
// cartão final).
//
// Cada campo livre recebe um marcador com "SIGILO" (pedido, título da sessão,
// caminhos, comandos e descrições, padrão de busca, host, consulta, skill,
// erros de ferramenta e de turno, descrições de delegação, alvo do pedido de
// aprovação e a pasta do projeto). A varredura procura "sigilo" (sem
// diferenciar maiúsculas) em todo nó de texto e em todo atributo da página.
// Nomes de ferramenta (MCP e "outra ferramenta") têm marcadores à parte,
// porque o modo discreto não promete escondê-los; o teste registra se aparecem.
//
// Também: ligar o modo no meio de uma rajada (varredura a cada quadro), trocar
// de tema, legenda (foco preso, Esc, atalhos), contraste, 360 px e
// localStorage indisponível.

import { expect, test } from '@playwright/test';
import { injectScenario } from '../../scripts/inject-fixture.mjs';
import escritorio from '../../web/js/themes/escritorio.js';
import guilda from '../../web/js/themes/guilda.js';
import { legendTitle } from '../../web/js/views/legend.js';
import { createScenario, inject, measure, measureIndicator, settledState, startLiveServer, waitFor, waitPanelFeed } from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */
/** @typedef {import('@playwright/test').Page} Page */

const THEMES = { escritorio, guilda };
const DISCREET_KEY = 'agent-quest-discreet';
const ROOT = 'C:\\Users\\fulano';
const TEST_FAIL = 'SIGILOERROTESTE\nℹ tests 3\nℹ suites 0\nℹ pass 1\nℹ fail 2\nℹ duration_ms 52.3\n';

/** @param {any} state @param {string} id */
const sessionOf = (state, id) => state.sessions.find((/** @type {any} */ x) => x.id === id);

/**
 * Varre a página: todo nó de texto e todo atributo com "sigilo", mais o título
 * do documento. Roda na página.
 */
const scan = () => {
  const re = /sigilo/i;
  /** @type {string[]} */
  const hits = [];
  if (re.test(document.title)) hits.push(`document.title: ${document.title}`);
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? '';
      if (re.test(text)) {
        const parent = node.parentElement;
        hits.push(`texto em <${parent?.tagName.toLowerCase()}${parent?.id ? `#${parent.id}` : ''}${parent?.className ? `.${String(parent.className).split(' ')[0]}` : ''}>: ${text.trim().slice(0, 90)}`);
      }
    } else if (node instanceof Element) {
      for (const name of node.getAttributeNames()) {
        const value = node.getAttribute(name) ?? '';
        if (re.test(value)) hits.push(`atributo ${name} em <${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}>: ${value.slice(0, 90)}`);
      }
    }
  }
  // Propriedades de controles que não viram atributo.
  const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('session-select'));
  if (select && re.test(select.title)) hits.push(`select.title: ${select.title}`);
  return hits;
};

/** Marcadores de nome de ferramenta (o modo discreto não promete escondê-los). */
const toolNames = () => {
  const html = document.documentElement.outerHTML;
  return { mcp: /MCPSERVIDOR/i.test(html), other: /NOMEFERRAMENTA/i.test(html) };
};

/** O que não pode existir no DOM (CSP e escape). */
const domProblems = () => {
  const problems = [];
  if (document.querySelectorAll('xss-marca, [data-xss]').length > 0) problems.push('elemento vindo de dado de evento');
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      if (attr.startsWith('on')) problems.push(`atributo ${attr} em <${el.tagName.toLowerCase()}>`);
      if (attr === 'style') problems.push(`style inline em <${el.tagName.toLowerCase()}>`);
    }
  }
  if (/** @type {any} */ (window).__xss !== undefined) problems.push('código executado');
  return problems;
};

/**
 * Sessão A, cheia de textos livres com marcadores, em partes.
 * @param {string} tag
 */
function secretSession(tag) {
  const s = createScenario({ label: `sigilo-a-${tag}`, projectDir: `${ROOT}\\SIGILOPASTA\\projeto-a` });
  const tes = s.agent('tes', 'tester');
  const guest = s.agent('g', 'Explore');
  s.raw('SessionStart', { source: 'startup', model: 'modelo-ficticio', session_title: 'SIGILOSESSAO titulo da sessao' });
  s.prompt('SIGILOTITULO pedido do usuario');
  const file = (/** @type {string} */ name) => `${ROOT}\\SIGILOPASTA\\projeto-a\\${name}`;
  s.tool('Read', { file_path: file('SIGILOCAMINHO.md') });
  s.tool('Grep', { pattern: 'SIGILOPADRAO', path: 'web' });
  s.tool('WebFetch', { url: 'https://sigilohost.example/pagina', prompt: 'x' });
  s.tool('WebSearch', { query: 'SIGILOBUSCA consulta' });
  s.tool('Skill', { skill: 'SIGILOSKILL' });
  s.tool('mcp__MCPSERVIDOR__ferramenta', { x: 1 });
  s.tool('NOMEFERRAMENTA', { x: 1 });
  s.tool('Bash', { command: 'echo SIGILOCMD', description: 'SIGILODESCCMD descricao do comando' });
  s.tool('Bash', { command: 'node -e "process.exit(1)"' }, { error: 'SIGILOERRO falhou na ferramenta' });
  const first = s.mark();
  const tesCall = s.delegate(tes, 'SIGILODESC delegacao ao tester');
  s.tool('Edit', { file_path: file('SIGILOCAMINHO2.js'), old_string: 'a', new_string: 'b' }, { agent: tes });
  s.tool('Bash', { command: 'npm test', description: 'SIGILODESCTESTE' }, { agent: tes, error: TEST_FAIL });
  const guestCall = s.delegate(guest, 'SIGILODESC2 busca do convidado');
  s.pre('Glob', { pattern: 'SIGILOGLOB/**' }, guest); // convidado trabalhando, com balão
  const ask = s.pre('Bash', { command: 'SIGILOAPROVA comando' });
  s.permission(ask); // principal aguardando aprovação
  const second = s.mark();
  s.post(ask, { stdout: 'ok\n', stderr: '', interrupted: false, isImage: false });
  s.finish(guest, guestCall);
  s.finish(tes, tesCall);
  s.stop(); // ticket entregue: cartão final
  return { s, keys: { tes: tes.id, guest: guest.id }, parts: [s.part(0, first), s.part(first, second), s.part(second)] };
}

/**
 * Outras sessões: B aguardando aprovação (para o aviso), C com o ticket que
 * falhou (erro do turno) e D com o mesmo nome de projeto de A em outra pasta.
 * @param {string} tag
 */
function otherSessions(tag) {
  const b = createScenario({ label: `sigilo-b-${tag}`, projectDir: `${ROOT}\\SIGILOPASTAB\\projeto-b` });
  b.raw('SessionStart', { source: 'startup', model: 'modelo-ficticio', session_title: 'SIGILOSESSAOB' });
  b.prompt('SIGILOTITULOB pedido da sessao b');
  b.permission(b.pre('Bash', { command: 'SIGILOAPROVAB' }));
  const c = createScenario({ label: `sigilo-c-${tag}`, projectDir: `${ROOT}\\SIGILOPASTAC\\projeto-c` });
  c.start().prompt('SIGILOTITULOC pedido que falha');
  c.tool('Read', { file_path: `${ROOT}\\SIGILOPASTAC\\projeto-c\\SIGILOCAMINHOC.md` });
  c.raw('StopFailure', { error: 'SIGILOFALHA erro do turno' });
  const d = createScenario({ label: `sigilo-d-${tag}`, projectDir: `${ROOT}\\SIGILOPASTAD\\projeto-a` });
  d.start().prompt('SIGILOTITULOD mesmo nome de projeto');
  return { b, c, d };
}

/**
 * Espera a página assentar com o estado do servidor e varre.
 * @param {Page} page
 * @param {string} where
 */
async function expectNoLeak(page, where) {
  const hits = await page.evaluate(scan);
  expect(hits, `vazamento ${where}`).toEqual([]);
}

test.describe('modo discreto sem vazamento (tester)', () => {
  test.describe.configure({ timeout: 120_000 });
  /** @type {LiveServer|null} */
  let server = null;
  const srv = () => /** @type {LiveServer} */ (server);

  test.beforeEach(async () => {
    server = await startLiveServer();
  });

  test.afterEach(async () => {
    await server?.dispose();
    server = null;
  });

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: ligado desde o início, nada vaza em nenhum estado; desligado, os textos voltam (controle)`, async ({ page }) => {
      const watch = await watchPage(page, srv().base);
      await page.addInitScript((key) => { try { localStorage.setItem(key, '1'); } catch { /* sem armazenamento */ } }, DISCREET_KEY);
      const { s, keys, parts } = secretSession(themeId);
      const { b, c, d } = otherSessions(themeId);
      await page.goto(`${srv().base}/#${themeId}`);
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'true');
      await inject(srv(), parts[0]);
      await expectNoLeak(page, 'depois das ferramentas');
      await inject(srv(), b);
      await inject(srv(), c);
      await inject(srv(), d);
      let state = await inject(srv(), parts[1]);
      await waitPanelFeed(page, sessionOf(state, s.sessionId));
      // Aviso de aprovação (B), região viva, principal aguardando, convidado com balão, bugs.
      await expect(page.locator('#session-alert')).toBeVisible();
      await expect(page.locator('.token[data-key="main"] .tok-alert')).toHaveCount(1);
      await expectNoLeak(page, 'com aviso, aprovação pendente e bugs');
      const names = await page.evaluate(toolNames);
      test.info().annotations.push({ type: 'nomes de ferramenta no modo discreto', description: JSON.stringify(names) });
      console.log(`[discreto ${themeId}] nomes de ferramenta visíveis: ${JSON.stringify(names)}`);

      // Filtro pela instância do tester: chip da instância (T14) sem o rótulo dela.
      await page.locator(`#party [data-filter="agent:${keys.tes}"]`).click();
      await expect(page.locator(`#feed-filters .chip-inst[data-filter="agent:${keys.tes}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expectNoLeak(page, 'com o chip da instância');
      // Legenda aberta.
      await page.keyboard.press('?');
      await expect(page.locator('#legend')).toBeVisible();
      await expectNoLeak(page, 'com a legenda aberta');
      await page.keyboard.press('Escape');
      // Troca de tema.
      await page.keyboard.press('t');
      await expectNoLeak(page, 'depois de trocar de tema');
      // Sessões C (erro do ticket) e D (projeto de mesmo nome).
      await page.locator('#session-select').selectOption(c.sessionId);
      await expect(page.locator('.q-title')).toBeVisible();
      await expectNoLeak(page, 'na sessão com o ticket que falhou');
      await page.locator('#session-select').selectOption(d.sessionId);
      await expectNoLeak(page, 'na sessão com projeto de mesmo nome');
      const groups = await page.locator('#session-select optgroup').evaluateAll((nodes) => nodes.map((n) => /** @type {HTMLOptGroupElement} */ (n).label));
      test.info().annotations.push({ type: 'grupos no modo discreto', description: JSON.stringify(groups) });

      // Ticket entregue em A: cartão final, varrido a cada quadro enquanto aparece.
      await page.locator('#session-select').selectOption(s.sessionId);
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__finaleHits = [];
        const fx = /** @type {HTMLElement} */ (document.getElementById('scene-fx'));
        new MutationObserver(() => {
          if (fx.querySelector('.finale')) w.__finaleSeen = true;
          const text = `${fx.textContent} ${fx.innerHTML}`;
          if (/sigilo/i.test(text)) w.__finaleHits.push(text.slice(0, 120));
        }).observe(fx, { childList: true, subtree: true, characterData: true });
      });
      state = await inject(srv(), parts[2]);
      expect(sessionOf(state, s.sessionId).quest?.status).toBe('done');
      await waitFor(() => page.evaluate(() => Boolean(/** @type {any} */ (window).__finaleSeen)), 'o cartão final aparecer');
      expect(await page.evaluate(() => /** @type {any} */ (window).__finaleHits)).toEqual([]);
      await expectNoLeak(page, 'com o ticket entregue');
      expect(await page.evaluate(domProblems)).toEqual([]);

      // Controle: desligado, os textos livres voltam (a varredura enxerga).
      await page.locator('#btn-discreet').click();
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'false');
      const visible = await page.evaluate(scan);
      expect(visible.length, 'com o modo desligado, a varredura acha os textos').toBeGreaterThan(3);
      expect(visible.join('\n')).toMatch(/SIGILOCAMINHO|SIGILOCMD|SIGILOTITULO|SIGILOSESSAO/);
      expect(await page.evaluate((key) => localStorage.getItem(key), DISCREET_KEY)).toBe('0');

      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.csp).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
    });
  }

  test('ligado no meio de uma rajada (tecla D): a partir do quadro seguinte, nada vaza; trocar de tema depois também não', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // A varredura entra por script injetado (a CSP da página não permite new Function).
    await page.addInitScript({ content: `window.__scan = ${scan.toString()};` });
    const { s, parts } = secretSession('rajada');
    const { b } = otherSessions('rajada');
    // Rajada na mesma sessão A: muitas ferramentas com segredos e falhas.
    const burstMark = s.mark();
    for (let i = 0; i < 40; i++) {
      s.tool('Bash', { command: `echo SIGILOCMD${i}`, description: `SIGILODESCCMD${i}` });
      s.tool('Read', { file_path: `${ROOT}\\SIGILOPASTA\\projeto-a\\SIGILOCAMINHO${i}.md` });
      if (i % 10 === 0) s.tool('Bash', { command: `SIGILOERRO${i}` }, { error: `SIGILOERRO${i} falhou` });
    }
    const burst = s.part(burstMark);
    await page.goto(`${srv().base}/#escritorio`);
    await inject(srv(), parts[0]);
    await inject(srv(), b);
    await page.locator('#session-select').selectOption(s.sessionId);
    await expect.poll(async () => (await page.evaluate(scan)).length, { message: 'desligado, os segredos aparecem (controle)' }).toBeGreaterThan(3);

    // Varredura a cada quadro, ligada logo depois da tecla D.
    const sending = injectScenario(/** @type {any} */ ({ events: [...parts[1].events, ...burst.events, ...parts[2].events] }), { port: srv().port, token: srv().token, speed: 1 });
    await waitFor(async () => (await page.locator('#feed-entries li.entry').count()) > 20, 'a rajada começar');
    await page.keyboard.press('d');
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      const run = w.__scan;
      w.__frameHits = [];
      w.__frames = 0;
      const tick = () => {
        w.__frames++;
        const hits = run();
        if (hits.length) w.__frameHits.push(...hits.map((/** @type {string} */ h) => `quadro ${w.__frames}: ${h}`));
        if (!w.__stopScan) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'true');
    const result = await sending;
    expect(result.refused).toEqual([]);
    await settledState(srv().port);
    await page.keyboard.press('2');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'guilda');
    await page.waitForTimeout(500);
    const { hits, frames } = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__stopScan = true;
      return { hits: w.__frameHits, frames: w.__frames };
    });
    console.log(`[discreto na rajada] quadros varridos=${frames} achados=${hits.length}`);
    expect(frames).toBeGreaterThan(10);
    expect(hits.slice(0, 10)).toEqual([]);
    await expectNoLeak(page, 'depois da rajada e da troca de tema');
  });

  test('sessão fixada que some, no modo discreto: a opção de aviso usa o rótulo neutro', async ({ page }) => {
    await page.addInitScript((key) => { try { localStorage.setItem(key, '1'); } catch { /* sem armazenamento */ } }, DISCREET_KEY);
    const { s, parts } = secretSession('fixada');
    const { c } = otherSessions('fixada');
    await page.goto(`${srv().base}/#escritorio`);
    await inject(srv(), parts[0]);
    await inject(srv(), c);
    await page.locator('#session-select').selectOption(c.sessionId);
    // Servidor reiniciado: C some; A volta no evento seguinte.
    const { port, home } = srv();
    await srv().stop();
    server = await startLiveServer({ port, home });
    await expect(page.locator('#conn')).toHaveText('ao vivo', { timeout: 15_000 });
    const more = s.mark();
    s.raw('SessionStart', { source: 'resume', model: 'modelo-ficticio', session_title: 'SIGILOSESSAO de novo' });
    s.tool('Read', { file_path: `${ROOT}\\SIGILOPASTA\\projeto-a\\SIGILODEPOIS.md` });
    await inject(srv(), s.part(more));
    await expect(page.locator('#session-select option:checked')).toHaveText(/^Sessão fixada indisponível · mostrando Sessão [0-9a-f]{6} · projeto-a/);
    await expectNoLeak(page, 'com a fixada indisponível');
  });

  for (const [name, setup] of Object.entries({
    'acesso negado': () => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('acesso negado', 'SecurityError'); } });
    },
    'valor adulterado e cota cheia': () => {
      try { window.localStorage.setItem('agent-quest-discreet', '<img src=x onerror=alert(1)>'); } catch { /* sem armazenamento */ }
      Storage.prototype.setItem = function () { throw new DOMException('cota cheia', 'QuotaExceededError'); };
    },
  })) {
    test(`localStorage indisponível (${name}): o modo discreto começa desligado, liga e desliga nesta aba, sem vazar`, async ({ page }) => {
      const watch = await watchPage(page, srv().base);
      await page.addInitScript(setup);
      const { parts } = secretSession(`ls-${name.length}`);
      await page.goto(`${srv().base}/#guilda`);
      await inject(srv(), parts[0]);
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('D');
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'true');
      await expectNoLeak(page, 'sem localStorage');
      await page.locator('#btn-discreet').click();
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'false');
      expect(watch.problems.errors).toEqual([]);
    });
  }

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: legenda acessível: nome do diálogo, foco preso, atalhos desligados, Esc e o foco volta ao botão`, async ({ page }) => {
      const theme = THEMES[themeId];
      const { parts } = secretSession(`legenda-${themeId}`);
      await page.goto(`${srv().base}/#${themeId}`);
      await inject(srv(), parts[0]);
      const button = page.locator('#btn-legend');
      await button.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: legendTitle(theme) });
      await expect(dialog).toBeVisible();
      // Foco dentro do diálogo; Tab dá a volta sem sair dele.
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#legend')))).toBe(true);
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        // Fora do diálogo, só o body (o lugar do navegador); nunca um elemento da página atrás dele.
        const where = await page.evaluate(() => (document.activeElement?.closest('#legend') ? 'diálogo' : document.activeElement === document.body ? 'body' : String(document.activeElement?.id || document.activeElement?.tagName)));
        expect(['diálogo', 'body'], `Tab ${i + 1}: foco em ${where}`).toContain(where);
      }
      // O resto da página fica inerte para o leitor de tela (diálogo modal).
      expect(await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('legend')).matches(':modal'))).toBe(true);
      // Atalhos não valem com a legenda aberta.
      for (const key of ['d', '2', 't', '1', '?']) await page.keyboard.press(key);
      await expect(page.locator('html')).toHaveAttribute('data-theme', themeId);
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'false');
      // Esc fecha e o foco volta ao botão.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(button).toBeFocused();
      // Tecla ? abre de onde o foco estiver; o botão de fechar fecha, e o foco
      // volta para onde estava (comportamento do diálogo nativo).
      await page.locator('#session-follow').focus();
      await page.keyboard.press('?');
      await expect(dialog).toBeVisible();
      await page.locator('#legend-close').click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('#session-follow')).toBeFocused();
      // Contraste da legenda, do botão do modo discreto apertado e do chip da instância.
      await page.keyboard.press('?');
      const results = await page.evaluate(measure, ['#legend h2', '#legend th', '#legend td', '#legend p', '#legend code']);
      await page.keyboard.press('Escape');
      await page.keyboard.press('d');
      results.push(...(await page.evaluate(measure, ['#btn-discreet'])).map((r) => ({ ...r, selector: '#btn-discreet[aria-pressed=true]' })));
      const lowest = results.reduce((min, r) => (r.ratio < min.ratio ? r : min));
      console.log(`[legenda ${themeId}] ${results.length} medidas, menor: ${JSON.stringify(lowest)}`);
      for (const r of results) expect(r.ratio, `${r.selector} "${r.text}"`).toBeGreaterThanOrEqual(r.selector === '#legend h2' ? 3 : 4.5);
      for (const selector of ['#btn-discreet', '#btn-legend']) {
        await page.locator(selector).focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(page.locator(selector)).toBeFocused();
        const ratio = await page.evaluate(measureIndicator, { selector, property: /** @type {const} */ ('outlineColor') });
        expect(ratio, `foco em ${selector}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  test('360 px: legenda dentro da tela, botões do topo cabem, sem rolagem lateral da página', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      const { parts } = secretSession('estreita');
      await page.goto(`${srv().base}/#guilda`);
      await inject(srv(), parts[0]);
      for (const selector of ['#btn-discreet', '#btn-legend', '#session-follow']) {
        const box = await page.locator(selector).boundingBox();
        expect(box, selector).not.toBeNull();
        expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 360, `${selector} dentro da tela`).toBe(true);
      }
      await page.locator('#btn-legend').tap();
      const dialog = await page.locator('#legend').boundingBox();
      expect(dialog).not.toBeNull();
      expect((dialog?.x ?? -1) >= 0 && (dialog?.x ?? 0) + (dialog?.width ?? 0) <= 360, 'legenda dentro da tela').toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.locator('#legend-close').tap();
      await page.locator('#btn-discreet').tap();
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'true');
      await expectNoLeak(page, 'em 360 px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
});
