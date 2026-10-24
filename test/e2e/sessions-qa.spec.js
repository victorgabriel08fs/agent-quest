// @ts-check
// Várias sessões (T13) no Edge, com o servidor real e cenários fictícios.
// Complementa test/e2e/sessions-live.spec.js (do dev) com o que o tester cobre:
// - muitas sessões, projetos com o mesmo nome em pastas diferentes e sessões
//   sem projeto, nos dois temas;
// - rótulos e nomes de projeto hostis no seletor e no aviso (escape e CSP);
// - localStorage indisponível (acesso negado, cota cheia, valor adulterado);
// - foco no seletor quando a lista é refeita; clique segurado no "Seguir
//   atividade" com o seletor esperando;
// - sessão fixada que some (servidor reiniciado) e volta;
// - aviso com "(e mais N sessões)";
// - contraste do mouse em cima e do foco; 360 px com rótulos longos.
// Cada teste sobe o próprio servidor (porta livre, pasta temporária).

import { expect, test } from '@playwright/test';
import { injectScenario } from '../../scripts/inject-fixture.mjs';
import escritorio from '../../web/js/themes/escritorio.js';
import guilda from '../../web/js/themes/guilda.js';
import { PROJECT_DIR, createScenario, inject, measure, measureIndicator, settledState, startLiveServer, waitFor, waitPanelFeed } from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */
/** @typedef {import('@playwright/test').Page} Page */

const THEMES = { escritorio, guilda };
const STORAGE_KEY = 'agent-quest-session';
const ROOT = 'C:\\Users\\fulano';

/** @param {any} state @param {string} id */
const sessionOf = (state, id) => state.sessions.find((/** @type {any} */ x) => x.id === id);

/**
 * Sessão curta: início, pedido (vira o rótulo) e uma leitura.
 * @param {string} label
 * @param {string|null} projectDir   null: sem projeto conhecido
 * @param {string} [title]
 */
function shortSession(label, projectDir, title = `Pedido ${label}`) {
  const s = createScenario({ label, projectDir: projectDir ?? `${ROOT}\\sem-projeto` });
  s.start().prompt(title);
  s.tool('Read', { file_path: `${projectDir ?? ROOT}\\${label}.md` });
  if (projectDir === null) {
    for (const event of s.events) {
      event.env = { projectDir: /** @type {any} */ (null), entrypoint: 'cli' };
      delete event.payload.cwd;
    }
  }
  return s;
}

/**
 * Grupos esperados do seletor, calculados aqui a partir do /api/state (sem usar
 * o código do painel): sessões da mais recente para a mais antiga, um grupo por
 * projeto na ordem da primeira aparição, nome repetido com a pasta e sem
 * projeto com o texto do tema.
 * @param {any[]} sessions
 * @param {import('../../web/js/themes/contract.js').Theme} theme
 */
function expectedGroups(sessions, theme) {
  const sorted = [...sessions].sort((a, b) => b.lastEventAt - a.lastEventAt || b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
  /** @type {Map<string, { name: string, dir: string, options: string[] }>} */
  const groups = new Map();
  for (const s of sorted) {
    const key = s.project?.key ?? '';
    if (!groups.has(key)) groups.set(key, { name: key ? s.project.name : theme.words.unknownProject, dir: s.project?.dir ?? '', options: [] });
    groups.get(key)?.options.push(s.id);
  }
  const names = [...groups.values()].map((g) => g.name);
  return [...groups.entries()].map(([key, g]) => [key && names.filter((n) => n === g.name).length > 1 ? `${g.name} (${g.dir})` : g.name, g.options]);
}

/** Grupos do seletor: [rótulo, [ids]]. */
const selectGroups = (/** @type {Page} */ page) => page.locator('#session-select optgroup').evaluateAll((groups) =>
  groups.map((g) => [/** @type {HTMLOptGroupElement} */ (g).label, [...g.querySelectorAll('option')].map((o) => o.value)]));

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

test.describe('várias sessões (tester)', () => {
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

  test('muitas sessões: projetos com o mesmo nome levam a pasta, sem projeto vai para o grupo do tema, ordem pela mais recente', async ({ page }) => {
    const watch = await watchPage(page, srv().base);
    const sessions = [
      shortSession('m1', `${ROOT}\\Projetos\\agents-quest`),
      shortSession('m2', `${ROOT}\\Projetos\\outro-projeto`),
      shortSession('m3', null),
      shortSession('m4', `${ROOT}\\Outros\\agents-quest`),
      shortSession('m5', `${ROOT}\\Projetos\\quarto`),
      shortSession('m6', `${ROOT}\\Projetos\\agents-quest`),
      shortSession('m7', null),
      shortSession('m8', `${ROOT}\\Projetos\\quinto`),
      shortSession('m9', `${ROOT}\\Projetos\\outro-projeto`),
      shortSession('m10', `${ROOT}\\Projetos\\sexto`),
      shortSession('m11', `${ROOT}\\Projetos\\setimo`),
      shortSession('m12', `${ROOT}\\Projetos\\quarto`),
    ];
    await page.goto(`${srv().base}/#escritorio`);
    /** @type {any} */
    let state;
    for (const s of sessions) state = await inject(srv(), s);
    expect(state.sessions).toHaveLength(12);
    await expect(page.locator('#session-select option')).toHaveCount(12);

    for (const theme of [escritorio, guilda]) {
      if (theme === guilda) await page.keyboard.press('2');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
      await expect.poll(() => selectGroups(page)).toEqual(expectedGroups(state.sessions, theme));
    }
    const groups = await selectGroups(page);
    expect(groups.filter(([label]) => String(label).startsWith('agents-quest (')).length).toBe(2);
    expect(groups.some(([label]) => label === guilda.words.unknownProject)).toBe(true);
    // Seguindo, com o painel aberto desde o início, a mostrada é a primeira que
    // apareceu: as outras chegaram com ela ainda ativa (não parada há 30 s).
    // Cada opção traz rótulo, projeto e status.
    await expect(page.locator('#session-select')).toHaveValue(sessions[0].sessionId);
    const texts = await page.locator('#session-select option').allTextContents();
    for (const s of state.sessions) {
      const text = s.project.key ? `${s.label} · ${s.project.name} · ativa` : `${s.label} · ativa`;
      expect(texts).toContain(text);
    }
    // Escolher uma sessão sem projeto mostra só ela.
    await page.locator('#session-select').selectOption(sessions[6].sessionId);
    await waitPanelFeed(page, sessionOf(state, sessions[6].sessionId));
    await expect(page.locator('.q-title')).toHaveText('Pedido m7');
    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
  });

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: rótulo e nome de projeto hostis no seletor, no tooltip e no aviso viram texto`, async ({ page }) => {
      const watch = await watchPage(page, srv().base);
      /** @type {string[]} */
      const dialogs = [];
      page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
      const hostileDir = `${ROOT}\\Projetos\\<img src=x data-xss="1" onerror="window.__xss=1">`;
      const hostileTitle = '<script>window.__xss=2</script> "aspas" <xss-marca data-xss="3">';
      const quiet = shortSession(`calma-${themeId}`, PROJECT_DIR, 'Sessão calma');
      const hostile = shortSession(`hostil-${themeId}`, hostileDir, hostileTitle);
      await page.goto(`${srv().base}/#${themeId}`);
      await inject(srv(), quiet);
      await inject(srv(), hostile);
      // Pedido de aprovação na sessão hostil, com a calma fixada: aviso com o nome hostil.
      await page.locator('#session-select').selectOption(quiet.sessionId);
      const mark = hostile.mark();
      hostile.permission(hostile.pre('Bash', { command: 'node -e "x" <xss-marca>' }));
      const state = await inject(srv(), hostile.part(mark));
      const session = sessionOf(state, hostile.sessionId);
      expect(session.counters.pendingApprovals).toBe(1);
      await expect(page.locator('#session-alert')).toBeVisible();
      await expect(page.locator('#session-alert .alert-where')).toHaveText(`${session.label} · ${session.project.name}`);
      expect(session.project.name).toContain('<img');
      const groups = await selectGroups(page);
      expect(groups.map(([label]) => label)).toContain(session.project.name);
      await expect(page.locator(`#session-select option[value="${hostile.sessionId}"]`)).toContainText(session.label);
      // Tooltip do seletor com a pasta hostil, na sessão hostil.
      await page.locator('#session-alert .alert-go').click();
      await expect(page.locator('#session-select')).toHaveAttribute('title', session.project.dir);
      await expect(page.locator('#session-select')).toHaveValue(hostile.sessionId);
      await page.keyboard.press('t');
      expect(await page.evaluate(domProblems)).toEqual([]);
      expect(dialogs).toEqual([]);
      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.csp).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
    });
  }

  const STORAGE_CASES = {
    'acesso negado (modo privado)': () => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('acesso negado', 'SecurityError'); } });
    },
    'cota cheia e valor adulterado': () => {
      try { window.localStorage.setItem('agent-quest-session', '{"follow":false,"pinnedId":12345}'); } catch { /* sem armazenamento */ }
      try { window.localStorage.setItem('agent-quest-theme', '<img src=x>'); } catch { /* sem armazenamento */ }
      Storage.prototype.setItem = function () { throw new DOMException('cota cheia', 'QuotaExceededError'); };
    },
  };
  for (const [name, setup] of Object.entries(STORAGE_CASES)) {
    test(`localStorage indisponível (${name}): o painel funciona, fixa e segue nesta aba`, async ({ page }) => {
      const watch = await watchPage(page, srv().base);
      await page.addInitScript(setup);
      const a = shortSession(`ls-a-${name.length}`, PROJECT_DIR, 'Sessão A');
      const b = shortSession(`ls-b-${name.length}`, `${ROOT}\\Projetos\\outro-projeto`, 'Sessão B');
      await page.goto(`${srv().base}/#guilda`);
      await expect(page.locator('#conn')).toHaveText('ao vivo');
      await inject(srv(), a);
      const state = await inject(srv(), b);
      // Seguindo: fica na primeira (A), que ainda não está parada.
      await expect(page.locator('#session-select')).toHaveValue(a.sessionId);
      await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => { try { return typeof window.localStorage.setItem('x', '1'); } catch (err) { return String(/** @type {any} */ (err)?.name); } })).not.toBe('undefined');
      await page.locator('#session-select').selectOption(b.sessionId);
      await waitPanelFeed(page, sessionOf(state, b.sessionId));
      await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'false');
      await page.locator('#session-follow').click();
      await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('1');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'escritorio');
      expect(watch.problems.errors).toEqual([]);
      expect(await watch.violations()).toEqual([]);
    });
  }

  test('seletor em foco quando a lista é refeita (sessão nova): o foco e a sessão fixada ficam', async ({ page }) => {
    const a = shortSession('foco-a', PROJECT_DIR, 'Sessão A');
    const b = shortSession('foco-b', `${ROOT}\\Projetos\\outro-projeto`, 'Sessão B');
    await page.goto(`${srv().base}/#escritorio`);
    await inject(srv(), a);
    await inject(srv(), b);
    await page.locator('#session-select').selectOption(a.sessionId);
    await page.locator('#session-select').focus();
    const c = shortSession('foco-c', `${ROOT}\\Projetos\\terceiro`, 'Sessão C');
    await inject(srv(), c);
    await expect(page.locator('#session-select option')).toHaveCount(3);
    await expect(page.locator('#session-select')).toBeFocused();
    await expect(page.locator('#session-select')).toHaveValue(a.sessionId);
    // Tab: seletor → "Seguir atividade", com foco visível.
    await page.keyboard.press('Tab');
    await expect(page.locator('#session-follow')).toBeFocused();
    const outline = await page.locator('#session-follow').evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });

  test('"Seguir atividade" apertado com uma sessão nova chegando: o seletor espera e o clique vale', async ({ page }) => {
    const a = createScenario({ label: 'segurar-seguir-a', projectDir: PROJECT_DIR });
    a.start().prompt('Sessão A');
    a.tool('Read', { file_path: `${PROJECT_DIR}\\a.md` });
    const b = shortSession('segurar-seguir-b', `${ROOT}\\Projetos\\outro-projeto`, 'Sessão B');
    await page.goto(`${srv().base}/#escritorio`);
    await inject(srv(), a);
    let state = await inject(srv(), b);
    await page.locator('#session-select').selectOption(a.sessionId);
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'false');
    const HOLD_BUDGET_MS = 1_200;
    /** @type {number[]} */
    const slow = [];
    let verified = false;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      await waitPanelFeed(page, sessionOf(state, a.sessionId));
      if ((await page.locator('#session-follow').getAttribute('aria-pressed')) === 'true') await page.locator('#session-follow').click();
      await page.locator('#session-select').selectOption(a.sessionId);
      await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur());
      const options = await page.locator('#session-select option').count();
      const rows = await page.locator('#feed-entries li.entry').count();
      const fresh = shortSession(`segurar-seguir-n${attempt}`, `${ROOT}\\Projetos\\novo-${attempt}`, `Nova ${attempt}`);
      const more = a.mark();
      a.tool('Grep', { pattern: `x${attempt}`, path: 'web' });
      const box = await page.locator('#session-follow').boundingBox();
      if (!box) throw new Error('botão sem caixa');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      const started = Date.now();
      await injectScenario(/** @type {any} */ ({ events: [...fresh.events, ...a.part(more).events] }), { port: srv().port, token: srv().token, fast: true });
      await waitFor(async () => (await page.locator('#feed-entries li.entry').count()) > rows, 'a linha nova de A');
      const elapsed = Date.now() - started;
      const optionsWhileHeld = await page.locator('#session-select option').count();
      await page.mouse.up();
      state = await settledState(srv().port);
      if (elapsed > HOLD_BUDGET_MS) {
        slow.push(elapsed);
        continue;
      }
      expect(optionsWhileHeld, 'seletor redesenhado com o botão apertado').toBe(options);
      await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#session-select option')).toHaveCount(options + 1);
      verified = true;
    }
    expect(verified, `update depois de ${HOLD_BUDGET_MS} ms nas duas tentativas (${slow.join(', ')} ms)`).toBe(true);
  });

  test('sessão fixada que some (servidor reiniciado) mantém o seguir desligado e volta quando reaparece', async ({ page }) => {
    const a = shortSession('some-a', PROJECT_DIR, 'Sessão A');
    const b = shortSession('some-b', `${ROOT}\\Projetos\\outro-projeto`, 'Sessão B');
    await page.goto(`${srv().base}/#escritorio`);
    await inject(srv(), a);
    await inject(srv(), b);
    await page.locator('#session-select').selectOption(b.sessionId);
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'false');
    // Servidor reiniciado: o estado recomeça vazio (ADR 0005); A volta primeiro.
    const { port, home } = srv();
    await srv().stop();
    await expect(page.locator('#conn')).toHaveText('reconectando');
    server = await startLiveServer({ port, home });
    await expect(page.locator('#conn')).toHaveText('ao vivo', { timeout: 15_000 });
    const aMore = a.mark();
    a.tool('Read', { file_path: `${PROJECT_DIR}\\depois.md` });
    await inject(srv(), a.part(aMore));
    // T14: o seletor avisa que a fixada sumiu e diz qual sessão está na tela (A).
    await expect(page.locator('#session-select')).toHaveValue('');
    // Depois do reinício, A volta sem o pedido: o rótulo é o padrão do servidor.
    await expect(page.locator('#session-select option:checked')).toHaveText(`Sessão fixada indisponível · mostrando Sessão ${a.sessionId.slice(0, 6)} · agents-quest · ativa`);
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'false');
    expect(JSON.parse(String(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)))).toEqual({ follow: false, pinnedId: b.sessionId });
    // B reaparece: o painel volta para a fixada.
    const bMore = b.mark();
    b.tool('Read', { file_path: `${ROOT}\\Projetos\\outro-projeto\\depois.md` });
    await inject(srv(), b.part(bMore));
    await expect(page.locator('#session-select')).toHaveValue(b.sessionId);
  });

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: aviso com três sessões aguardando: "(e mais 2 sessões)", a mais recente primeiro; aprovada, passa para a seguinte`, async ({ page }) => {
      const theme = THEMES[themeId];
      const shown = shortSession(`mais-${themeId}-0`, PROJECT_DIR, 'Sessão mostrada');
      const others = [1, 2, 3].map((n) => shortSession(`mais-${themeId}-${n}`, `${ROOT}\\Projetos\\p${n}`, `Sessão ${n}`));
      await page.goto(`${srv().base}/#${themeId}`);
      await inject(srv(), shown);
      for (const s of others) await inject(srv(), s);
      await page.locator('#session-select').selectOption(shown.sessionId);
      const asks = [];
      for (const s of others) {
        const mark = s.mark();
        const ask = s.pre('Bash', { command: `node -e "console.log('${s.sessionId.slice(0, 4)}')"` });
        s.permission(ask);
        asks.push({ s, ask });
        await inject(srv(), s.part(mark));
      }
      const alert = page.locator('#session-alert');
      const pending = theme.stats({ durationMs: 0, bugsCrushed: 0, questsDone: 0, pendingApprovals: 1 }).find((x) => x.id === 'pending');
      await expect(alert).toContainText(`1 ${pending?.label} em Sessão 3 · p3 (e mais 2 sessões)`);
      await expect(alert.locator('.alert-go')).toHaveAttribute('data-goto', others[2].sessionId);
      // A mais recente aprovada: o aviso aponta a seguinte.
      const last = asks[2];
      const mark = last.s.mark();
      last.s.post(last.ask, { stdout: 'ok\n', stderr: '', interrupted: false, isImage: false });
      await inject(srv(), last.s.part(mark));
      await expect(alert.locator('.alert-go')).toHaveAttribute('data-goto', others[1].sessionId);
      await expect(alert).toContainText('(e mais 1 sessão)');
      await expect(page.locator('#session-select')).toHaveValue(shown.sessionId);
      // Textos neutros (iguais nos dois temas): botões e status.
      await expect(alert.locator('.alert-go')).toHaveText('Ir para a sessão');
      await expect(page.locator('#session-follow .l')).toHaveText('Seguir atividade');
    });
  }

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: contraste com o mouse em cima e foco visível do "Seguir atividade" e do atalho`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const a = shortSession(`ct-a-${themeId}`, PROJECT_DIR, 'Sessão A');
      const b = shortSession(`ct-b-${themeId}`, `${ROOT}\\Projetos\\outro-projeto`, 'Sessão B');
      await page.goto(`${srv().base}/#${themeId}`);
      await inject(srv(), a);
      await inject(srv(), b);
      await page.locator('#session-select').selectOption(a.sessionId);
      const mark = b.mark();
      b.permission(b.pre('Bash', { command: 'node -e "1"' }));
      await inject(srv(), b.part(mark));
      await expect(page.locator('#session-alert')).toBeVisible();
      /** @type {any[]} */
      const results = [];
      await page.locator('#session-follow').hover();
      results.push(...(await page.evaluate(measure, ['#session-follow'])).map((r) => ({ ...r, state: 'mouse em cima' })));
      await page.locator('#session-alert .alert-go').hover();
      results.push(...(await page.evaluate(measure, ['#session-alert .alert-go', '#session-alert b'])).map((r) => ({ ...r, state: 'mouse em cima' })));
      for (const r of results) expect(r.ratio, `${r.selector} (${r.state})`).toBeGreaterThanOrEqual(4.5);
      /** @type {Record<string, number|null>} */
      const focus = {};
      for (const selector of ['#session-follow', '#session-alert .alert-go', '#session-select']) {
        await page.locator(selector).focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(page.locator(selector)).toBeFocused();
        focus[selector] = await page.evaluate(measureIndicator, { selector, property: /** @type {const} */ ('outlineColor') });
        expect(focus[selector], `foco em ${selector}`).toBeGreaterThanOrEqual(3);
      }
      console.log(`[contraste T13 ${themeId}] ${JSON.stringify(results.map((r) => [r.selector, r.ratio]))} foco=${JSON.stringify(focus)}`);
    });
  }

  test('360 px: muitas sessões e rótulos longos, aviso que quebra linha, sem rolagem lateral', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      const long = 'Revisar a ingestão, o normalizador, a redação de segredos e o hub SSE com retomada por Last-Event-ID';
      const sessions = [1, 2, 3, 4, 5, 6].map((n) => shortSession(`estreita-${n}`, `${ROOT}\\Projetos\\projeto-com-um-nome-bem-comprido-${n}`, `${long} ${n}`));
      await page.goto(`${srv().base}/#guilda`);
      for (const s of sessions) await inject(srv(), s);
      await page.locator('#session-select').selectOption(sessions[0].sessionId);
      for (const s of sessions.slice(1, 4)) {
        const mark = s.mark();
        s.permission(s.pre('Bash', { command: 'node -e "1"' }));
        await inject(srv(), s.part(mark));
      }
      await expect(page.locator('#session-alert')).toContainText('(e mais 2 sessões)');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      for (const selector of ['#session-select', '#session-follow', '#session-alert', '#session-alert .alert-go']) {
        const box = await page.locator(selector).boundingBox();
        expect(box, selector).not.toBeNull();
        expect(box?.x ?? -1, `${selector} começa dentro da tela`).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), `${selector} termina dentro da tela`).toBeLessThanOrEqual(360);
      }
      await page.locator('#session-alert .alert-go').tap();
      await expect(page.locator('#session-select')).toHaveValue(sessions[3].sessionId);
    } finally {
      await context.close();
    }
  });
});
