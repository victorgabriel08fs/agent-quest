// @ts-check
// Várias sessões (T13) no Edge, com o servidor real e cenários sintéticos
// injetados pelo injetor do T9b (scripts/inject-fixture.mjs, pelo apoio
// test/e2e/qa-live.js):
// - duas sessões em projetos diferentes aparecem agrupadas no seletor, com
//   status; equipe, cena, ticket e feed mostram só a sessão escolhida;
// - escolher uma sessão a fixa (e desliga o "seguir atividade"); a escolha fica
//   no localStorage; o botão volta a seguir;
// - "seguir atividade" com o relógio da página adiantado (page.clock): troca
//   quando a atual fica parada 30 s, no máximo uma vez a cada 10 s;
// - aprovação pendente em outra sessão: aviso no topo com atalho, por mouse e
//   teclado; o foco volta ao atalho no redesenho; com o atalho apertado, o
//   seletor e o aviso não são redesenhados (uma nova tentativa em caso de ruído
//   da máquina, ADR 0010);
// - contraste do botão e do aviso nos dois temas; 360 px sem rolagem lateral.
//
// Cada teste sobe o próprio servidor (porta livre, pasta temporária, nunca a
// 47821 nem o diretório real).

import { expect, test } from '@playwright/test';
import { injectScenario } from '../../scripts/inject-fixture.mjs';
import escritorio from '../../web/js/themes/escritorio.js';
import guilda from '../../web/js/themes/guilda.js';
import {
  OTHER_PROJECT_DIR, PROJECT_DIR, createScenario, inject, measure, settledState, startLiveServer, waitFor, waitPanelFeed,
} from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */

const THIRD_PROJECT_DIR = 'C:\\Users\\fulano\\Projetos\\terceiro';
const STORAGE_KEY = 'agent-quest-session';

/** @param {any} state @param {string} id */
const sessionOf = (state, id) => state.sessions.find((/** @type {any} */ x) => x.id === id);

/**
 * Duas sessões em projetos diferentes, cada uma com um subagente trabalhando:
 * A (agents-quest, tester) e B (outro-projeto, arquiteto).
 * @param {string} tag   para os ids não se repetirem entre testes
 */
function twoSessions(tag) {
  const a = createScenario({ label: `t13-a-${tag}`, projectDir: PROJECT_DIR });
  const b = createScenario({ label: `t13-b-${tag}`, projectDir: OTHER_PROJECT_DIR, entrypoint: 'claude-vscode' });
  const aTes = a.agent('tes', 'tester');
  const bArq = b.agent('arq', 'arquiteto');
  a.start().prompt('Ticket da sessão A');
  b.start().prompt('Ticket da sessão B');
  a.delegate(aTes, 'Testar a sessão A');
  b.delegate(bArq, 'Desenhar a sessão B');
  a.tool('Read', { file_path: `${PROJECT_DIR}\\a.md` }, { agent: aTes });
  b.tool('Read', { file_path: `${OTHER_PROJECT_DIR}\\b.md` }, { agent: bArq });
  return {
    a: { scenario: a, title: 'Ticket da sessão A', agent: aTes, role: 'tes', project: 'agents-quest' },
    b: { scenario: b, title: 'Ticket da sessão B', agent: bArq, role: 'arq', project: 'outro-projeto' },
  };
}

/**
 * Confere que equipe, cena, ticket e feed mostram só a sessão `shown`.
 * @param {import('@playwright/test').Page} page
 * @param {any} state
 * @param {ReturnType<typeof twoSessions>['a']} shown
 * @param {ReturnType<typeof twoSessions>['a']} hidden
 */
async function expectShowing(page, state, shown, hidden) {
  const session = sessionOf(state, shown.scenario.sessionId);
  await expect(page.locator('#session-select')).toHaveValue(shown.scenario.sessionId);
  await expect(page.locator('.q-title')).toHaveText(shown.title);
  await waitPanelFeed(page, session);
  // Equipe: os papéis do roster da sessão, sem o papel só da outra.
  const members = await page.locator('#party .member').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-agent')));
  expect(members).toEqual(session.roster);
  expect(members).toContain(shown.role);
  expect(members).not.toContain(hidden.role);
  // Cena: o subagente desta sessão, nenhum da outra.
  await expect(page.locator(`#scene-stage .token[data-key="${shown.agent.id}"]`)).toHaveCount(1);
  await expect(page.locator(`#scene-stage .token[data-key="${hidden.agent.id}"]`)).toHaveCount(0);
  // Nenhum texto da outra sessão no centro, na equipe ou no feed.
  for (const region of ['#quest-slot', '#party', '#feed']) {
    await expect(page.locator(region)).not.toContainText(hidden.title);
  }
  await expect(page.locator('#feed')).not.toContainText(`${hidden.role === 'arq' ? 'b' : 'a'}.md`);
}

/** Grupos do seletor: [rótulo, [[valor, texto]...]]. */
const selectGroups = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#session-select optgroup').evaluateAll((groups) =>
  groups.map((g) => [/** @type {HTMLOptGroupElement} */ (g).label, [...g.querySelectorAll('option')].map((o) => [o.value, o.textContent])]));

test.describe('várias sessões (T13)', () => {
  // Cada teste sobe o próprio servidor e tem muitos passos; o E2E roda com vários workers.
  test.describe.configure({ timeout: 90_000 });
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

  test('duas sessões em projetos diferentes aparecem agrupadas; equipe, cena, ticket e feed mostram só a escolhida', async ({ page }) => {
    const watch = await watchPage(page, srv().base);
    const { a, b } = twoSessions('grupos');
    // As duas já existem quando o painel abre: ele começa na mais recente. (Com
    // o painel aberto, ele ficaria na primeira que aparecesse até ela parar.)
    let state = await inject(srv(), { events: [...a.scenario.events, ...b.scenario.events] });
    await page.goto(`${srv().base}/#escritorio`);

    // Agrupadas por projeto, a mais recente primeiro (B), com rótulo, projeto e status.
    await expect(page.locator('#session-select optgroup')).toHaveCount(2);
    expect(await selectGroups(page)).toEqual([
      ['outro-projeto', [[b.scenario.sessionId, `${sessionOf(state, b.scenario.sessionId).label} · outro-projeto · ativa`]]],
      ['agents-quest', [[a.scenario.sessionId, `${sessionOf(state, a.scenario.sessionId).label} · agents-quest · ativa`]]],
    ]);

    // Seguindo atividade, começa na mais recente.
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'true');
    await expectShowing(page, state, b, a);

    // Escolher A no seletor: só A, e o seguir desliga.
    await page.locator('#session-select').selectOption(a.scenario.sessionId);
    await expectShowing(page, state, a, b);
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'false');

    // B continua ativa: A fica (fixada), e as linhas novas de B não entram no feed.
    const more = b.scenario.mark();
    b.scenario.tool('Grep', { pattern: 'sessao-b', path: OTHER_PROJECT_DIR }, { agent: b.agent });
    state = await inject(srv(), b.scenario.part(more));
    await expectShowing(page, state, a, b);

    // Teclado: com o seletor em foco, as setas trocam de sessão, e o foco fica no seletor.
    await page.locator('#session-select').focus();
    await page.keyboard.press('ArrowUp');
    await expectShowing(page, state, b, a);
    await expect(page.locator('#session-select')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expectShowing(page, state, a, b);
    await expect(page.locator('#session-select')).toBeFocused();

    // Tema: o vocabulário muda, a sessão escolhida não.
    await page.keyboard.press('Escape');
    await page.locator('#theme-toggle button[data-theme="guilda"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'guilda');
    await expectShowing(page, state, a, b);

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.csp).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('a escolha fica no localStorage; "Seguir atividade" volta a seguir', async ({ page }) => {
    const { a, b } = twoSessions('guardar');
    let state = await inject(srv(), { events: [...a.scenario.events, ...b.scenario.events] });
    await page.goto(`${srv().base}/#escritorio`);
    await expectShowing(page, state, b, a);
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

    await page.locator('#session-select').selectOption(a.scenario.sessionId);
    await expectShowing(page, state, a, b);
    expect(JSON.parse(String(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)))).toEqual({ follow: false, pinnedId: a.scenario.sessionId });

    // Recarregando, a fixada vale, mesmo com B mais recente.
    await page.reload();
    await expectShowing(page, state, a, b);
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'false');

    // O botão volta a seguir (sem trocar de sessão na hora: A não está parada).
    await page.locator('#session-follow').click();
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(String(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)))).toEqual({ follow: true });
    await expectShowing(page, state, a, b);

    // Seguindo, recarregar começa na mais recente.
    await page.reload();
    await expectShowing(page, state, b, a);

    // Desligar pelo teclado fixa a sessão mostrada.
    await page.locator('#session-follow').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#session-follow')).toBeFocused();
    expect(JSON.parse(String(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)))).toEqual({ follow: false, pinnedId: b.scenario.sessionId });
    state = await settledState(srv().port);
    await expectShowing(page, state, b, a);
  });

  test('seguir atividade: troca quando a atual fica parada 30 s, no máximo uma vez a cada 10 s', async ({ page }) => {
    const { a, b } = twoSessions('seguir');
    // Relógio da página controlado pelo teste; o tempo corre normalmente até ser adiantado.
    await page.clock.install();
    await page.goto(`${srv().base}/#escritorio`);
    let state = await inject(srv(), a.scenario);
    await expectShowing(page, state, a, b);

    // B começa depois, mais recente, mas A ainda não está parada: fica em A.
    state = await inject(srv(), b.scenario);
    await page.clock.runFor(2_000);
    await expect(page.locator('#session-select')).toHaveValue(a.scenario.sessionId);

    // 31 s depois do último evento de A (relógio da página): troca para B.
    await page.clock.fastForward('00:31');
    await expectShowing(page, state, b, a);

    // A volta a ter evento (mais recente que B, que está parada pelo relógio da
    // página), mas a última troca foi há menos de 10 s: fica em B.
    const more = a.scenario.mark();
    a.scenario.tool('Grep', { pattern: 'sessao-a', path: PROJECT_DIR }, { agent: a.agent });
    state = await inject(srv(), a.scenario.part(more));
    await page.clock.runFor(2_000);
    await expect(page.locator('#session-select')).toHaveValue(b.scenario.sessionId);

    // Passados os 10 s, troca para A.
    await page.clock.fastForward('00:10');
    await expectShowing(page, state, a, b);
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'true');
  });

  test('aprovação pendente em outra sessão: aviso no topo, no vocabulário do tema, com atalho pelo teclado', async ({ page }) => {
    const { a, b } = twoSessions('aviso');
    await page.goto(`${srv().base}/#escritorio`);
    let state = await inject(srv(), { events: [...a.scenario.events, ...b.scenario.events] });
    await page.locator('#session-select').selectOption(a.scenario.sessionId);
    await expectShowing(page, state, a, b);
    await expect(page.locator('#session-alert')).toBeEmpty();
    await expect(page.locator('#session-alert')).toBeHidden();

    // B pede aprovação.
    const mark = b.scenario.mark();
    const ask = b.scenario.pre('Bash', { command: 'node -e "console.log(1)"', description: 'Imprimir 1' });
    b.scenario.permission(ask);
    state = await inject(srv(), b.scenario.part(mark));
    expect(sessionOf(state, b.scenario.sessionId).counters.pendingApprovals).toBe(1);

    const alert = page.locator('#session-alert');
    const label = sessionOf(state, b.scenario.sessionId).label;
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'status');
    await expect(alert).toContainText(`1 aprovação pendente em ${label} · outro-projeto`);
    await expect(alert.locator('.alert-icon')).toHaveText('✋');
    await expect(page.locator(`#session-select option[value="${b.scenario.sessionId}"]`)).toHaveText(`${label} · outro-projeto · 1 aprovação pendente`);
    // A sessão mostrada não muda sozinha.
    await expectShowing(page, state, a, b);

    // Guilda: palavra e ícone do tema.
    await page.locator('#theme-toggle button[data-theme="guilda"]').click();
    await expect(alert).toContainText(`1 pedido de permissão em ${label} · outro-projeto`);
    await expect(alert.locator('.alert-icon')).toHaveText(String(guilda.stats({ durationMs: 0, bugsCrushed: 0, questsDone: 0, pendingApprovals: 1 }).find((s) => s.id === 'pending')?.icon));

    // Teclado: Tab do botão "Seguir atividade" chega ao atalho; Enter vai para B.
    await page.locator('#session-follow').focus();
    await page.keyboard.press('Tab');
    const go = alert.getByRole('button', { name: 'Ir para a sessão' });
    await expect(go).toBeFocused();
    await page.keyboard.press('Enter');
    await expectShowing(page, state, b, a);
    await expect(alert).toBeHidden();
    await expect(page.locator('#session-select')).toBeFocused();
    await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'false');
    expect(JSON.parse(String(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)))).toEqual({ follow: false, pinnedId: b.scenario.sessionId });

    // Aprovada: B deixa de ter pendência; em A, nenhum aviso.
    const after = b.scenario.mark();
    b.scenario.post(ask, { stdout: '1\n', stderr: '', interrupted: false, isImage: false });
    state = await inject(srv(), b.scenario.part(after));
    expect(sessionOf(state, b.scenario.sessionId).counters.pendingApprovals).toBe(0);
    await page.locator('#session-select').selectOption(a.scenario.sessionId);
    await expectShowing(page, state, a, b);
    await expect(alert).toBeHidden();
  });

  test('o foco volta ao atalho do aviso no redesenho; com o atalho apertado, seletor e aviso esperam e o clique não se perde', async ({ page }) => {
    const { a, b } = twoSessions('segurar');
    await page.goto(`${srv().base}/#escritorio`);
    await inject(srv(), { events: [...a.scenario.events, ...b.scenario.events] });
    await page.locator('#session-select').selectOption(a.scenario.sessionId);
    const ask = b.scenario.pre('Bash', { command: 'node -e "console.log(2)"' });
    b.scenario.permission(ask);
    let state = await inject(srv(), b.scenario.part(b.scenario.events.length - 2));
    await expectShowing(page, state, a, b);
    const alert = page.locator('#session-alert');
    const go = alert.locator('button.alert-go');
    await expect(go).toHaveAttribute('data-goto', b.scenario.sessionId);

    // Foco no atalho e uma terceira sessão, mais recente, pede aprovação: o
    // aviso passa a apontar para ela, e o foco continua no atalho.
    const c = createScenario({ label: 't13-c-segurar', projectDir: THIRD_PROJECT_DIR });
    c.start().prompt('Ticket da sessão C');
    c.permission(c.pre('Bash', { command: 'node -e "console.log(3)"' }));
    await go.focus();
    state = await inject(srv(), c);
    await expect(go).toHaveAttribute('data-goto', c.sessionId);
    await expect(alert).toContainText('(e mais 1 sessão)');
    await expect(go).toBeFocused();
    await expect(page.locator('#session-select optgroup')).toHaveCount(3);

    // Atalho apertado (mouse) e updates chegando: o feed de A é redesenhado,
    // mas o seletor e o aviso esperam o botão ser solto (no máximo 1,5 s).
    // Sob carga, o update pode chegar depois disso; a tentativa é descartada e
    // refeita uma vez (falhar duas vezes seguidas é bug).
    const HOLD_BUDGET_MS = 1_200;
    /** @type {number[]} */
    const slow = [];
    let verified = false;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      // Painel em dia com o servidor antes de apertar.
      await expect(page.locator('#session-select option')).toHaveCount(state.sessions.length);
      await waitPanelFeed(page, sessionOf(state, a.scenario.sessionId));
      const box = await go.boundingBox();
      if (!box) throw new Error('atalho sem caixa');
      const target = String(await go.getAttribute('data-goto'));
      const rows = await page.locator('#feed-entries li.entry').count();
      const options = await page.locator('#session-select option').count();
      await go.evaluate((el, n) => { /** @type {any} */ (el).__attempt = n; }, attempt);
      // Uma sessão nova com aprovação (muda o seletor e o aviso) e uma linha nova em A.
      const d = createScenario({ label: `t13-d-segurar-${attempt}`, projectDir: THIRD_PROJECT_DIR });
      d.start().prompt(`Ticket D ${attempt}`);
      d.permission(d.pre('Bash', { command: `node -e "console.log(${attempt})"` }));
      const more = a.scenario.mark();
      a.scenario.tool('Read', { file_path: `${PROJECT_DIR}\\segurar-${attempt}.md` }, { agent: a.agent });

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      const started = Date.now();
      // Injeção direta, sem esperar o servidor estabilizar: o tempo medido é só
      // o do update chegar ao painel.
      const sent = await injectScenario(/** @type {any} */ ({ events: [...d.events, ...a.scenario.part(more).events] }), { port: srv().port, token: srv().token, fast: true });
      expect(sent.refused).toEqual([]);
      await waitFor(async () => (await page.locator('#feed-entries li.entry').count()) > rows, 'a linha nova de A');
      const elapsed = Date.now() - started;
      if (elapsed > HOLD_BUDGET_MS) {
        // Solta longe do botão, para o clique não valer, e tenta de novo.
        slow.push(elapsed);
        await page.mouse.move(2, 2);
        await page.mouse.up();
        state = await settledState(srv().port);
        continue;
      }
      expect(await go.evaluate((el) => /** @type {any} */ (el).__attempt), 'o atalho não foi trocado com o botão apertado').toBe(attempt);
      expect(await go.getAttribute('data-goto')).toBe(target);
      expect(await page.locator('#session-select option').count()).toBe(options);
      await page.mouse.up();
      state = await settledState(srv().port);
      // O clique chegou ao atalho apertado, e o seletor e o aviso foram redesenhados.
      await expect(page.locator('#session-select')).toHaveValue(target);
      await expect(page.locator('#session-select option')).toHaveCount(options + 1);
      await expect(go).toHaveAttribute('data-goto', d.sessionId);
      verified = true;
    }
    expect(verified, `o update demorou mais que ${HOLD_BUDGET_MS} ms nas duas tentativas (${slow.join(', ')} ms)`).toBe(true);
  });

  for (const theme of [escritorio, guilda]) {
    test(`${theme.id}: contraste AA do "Seguir atividade" e do aviso`, async ({ page }) => {
      const { a, b } = twoSessions(`contraste-${theme.id}`);
      await page.goto(`${srv().base}/#${theme.id}`);
      await inject(srv(), { events: [...a.scenario.events, ...b.scenario.events] });
      await page.locator('#session-select').selectOption(a.scenario.sessionId);
      b.scenario.permission(b.scenario.pre('Bash', { command: 'node -e "console.log(4)"' }));
      await inject(srv(), b.scenario.part(b.scenario.events.length - 2));
      await expect(page.locator('#session-alert')).toBeVisible();
      /** @type {{ selector: string, text: string, ratio: number }[]} */
      const all = [];
      // Desligado (fixada) e ligado (A não está parada: a sessão não muda).
      await page.mouse.move(2, 2);
      all.push(...await page.evaluate(measure, ['#session-follow', '#session-alert .alert-text', '#session-alert .alert-where', '#session-alert .alert-go']));
      await page.locator('#session-follow').click();
      await page.mouse.move(2, 2);
      await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#session-alert')).toBeVisible();
      all.push(...(await page.evaluate(measure, ['#session-follow'])).map((r) => ({ ...r, selector: '#session-follow[aria-pressed=true]' })));
      expect(all.length).toBeGreaterThanOrEqual(4);
      for (const r of all) expect(r.ratio, `${r.selector} "${r.text}"`).toBeGreaterThanOrEqual(4.5);
    });
  }

  test('360 px: seletor, "Seguir atividade" e aviso cabem, sem rolagem lateral, e funcionam com toque', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      const { a, b } = twoSessions('estreita');
      await page.goto(`${srv().base}/#escritorio`);
      await inject(srv(), { events: [...a.scenario.events, ...b.scenario.events] });
      await page.locator('#session-select').selectOption(a.scenario.sessionId);
      b.scenario.permission(b.scenario.pre('Bash', { command: 'node -e "console.log(5)"' }));
      let state = await inject(srv(), b.scenario.part(b.scenario.events.length - 2));
      await expect(page.locator('#session-alert')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      // O texto do botão sai da tela, mas continua sendo o nome acessível.
      await expect(page.getByRole('button', { name: 'Seguir atividade' })).toBeVisible();
      const follow = await page.locator('#session-follow').boundingBox();
      expect(follow?.width ?? 0).toBeLessThan(60);
      for (const selector of ['#session-select', '#session-follow', '#session-alert', '#session-alert .alert-go']) {
        const box = await page.locator(selector).boundingBox();
        expect(box, selector).not.toBeNull();
        expect((box?.x ?? 0) + (box?.width ?? 0), `${selector} dentro da tela`).toBeLessThanOrEqual(360);
      }
      await page.locator('#session-alert .alert-go').tap();
      state = await settledState(srv().port);
      await expectShowing(page, state, b, a);
      await page.locator('#session-follow').tap();
      await expect(page.locator('#session-follow')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await context.close();
    }
  });
});
