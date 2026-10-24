// @ts-check
// T14 no Edge, com o servidor real e cenários sintéticos injetados pelo injetor
// do T9b (scripts/inject-fixture.mjs, pelo apoio test/e2e/qa-live.js):
// - modo discreto (botão e tecla D, guardado no localStorage): nenhum caminho,
//   comando, descrição, título ou erro no DOM, nos dois temas;
// - XSS em caminho, comando, descrição, título e erro aparece escapado, nos dois
//   temas, e some no modo discreto;
// - trocar de tema e ligar o modo discreto não reabrem o /events;
// - legenda: botão e tecla ?, foco no diálogo, Esc e clique fora fecham;
// - chip da instância filtrada: aparece apertado e se desfaz no próprio chip;
// - cartão final redesenhado no tema novo, pelo tempo que faltava;
// - abaixo de 640 px, botões só com ícone com nome acessível e foco visível;
// - estado apertado dos chips com um traço que não depende da cor;
// - sessão fixada que sumiu: escolher a sessão que aparece passa a fixá-la.
//
// Cada teste sobe o próprio servidor (porta livre, pasta temporária, nunca a
// 47821 nem o diretório real).

import { expect, test } from '@playwright/test';
import escritorio from '../../web/js/themes/escritorio.js';
import guilda from '../../web/js/themes/guilda.js';
import { FINALE_MS, FINALE_OUT_MS } from '../../web/js/fx.js';
import { PROJECT_DIR, createScenario, inject, measureIndicator, settledState, startLiveServer, waitPanelFeed } from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */

const THEMES = { escritorio, guilda };
const XSS = '<img src=x onerror=alert(1)>';
const SECRET = 'SEGREDO';

/** @param {any} state @param {string} id */
const sessionOf = (state, id) => state.sessions.find((/** @type {any} */ x) => x.id === id);

/**
 * Sessão com um texto em cada campo livre: título (pedido), descrição da
 * delegação, caminho, comando, descrição do comando, erro e alvo do pedido de
 * aprovação. O dev fica aguardando aprovação.
 * @param {string} tag
 * @param {(field: string) => string} text
 */
function freeTextSession(tag, text) {
  const s = createScenario({ label: `t14-${tag}` });
  const dev = s.agent('dev', 'dev-frontend');
  s.start().prompt(text('titulo'));
  s.delegate(dev, text('descricao'));
  s.tool('Read', { file_path: `${PROJECT_DIR}\\${text('caminho')}.md` }, { agent: dev });
  s.tool('Bash', { command: `echo ${text('comando')}`, description: text('descricao-comando') }, { agent: dev, error: text('erro') });
  s.permission(s.pre('Bash', { command: `npm install ${text('aprovacao')}` }, dev));
  return { s, dev };
}

test.describe('T14: modo discreto, legenda e endurecimento', () => {
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

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: modo discreto esconde caminhos, comandos, descrições, títulos e erros; botão, tecla D e localStorage`, async ({ page }) => {
      const theme = THEMES[themeId];
      const watch = await watchPage(page, srv().base);
      /** @type {string[]} */
      const events = [];
      page.on('request', (request) => { if (new URL(request.url()).pathname === '/events') events.push(request.url()); });
      await page.goto(`${srv().base}/#${themeId}`);
      const { s } = freeTextSession(`discreto-${themeId}`, (field) => `${SECRET}-${field}`);
      const state = await inject(srv(), s);
      await waitPanelFeed(page, sessionOf(state, s.sessionId));
      const html = () => page.evaluate(() => document.documentElement.outerHTML);
      // Sem o modo discreto, os textos aparecem (inclusive o título e o erro).
      const before = await html();
      for (const field of ['titulo', 'descricao', 'caminho', 'comando', 'erro', 'aprovacao']) expect(before, field).toContain(`${SECRET}-${field}`);
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'false');
      const opened = events.length;

      // Botão: liga. Nada de texto livre no DOM, em texto nem em atributo.
      await page.locator('#btn-discreet').click();
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await html()).match(/SEGREDO-[a-z-]+/g) ?? []).toEqual([]);
      await expect(page.locator('.q-title')).toHaveText(theme.words.hiddenTitle);
      const bash = theme === escritorio ? 'roda um comando no terminal' : 'conjura um feitiço';
      await expect(page.locator('#feed-entries')).toContainText(bash);
      await expect(page.locator('#feed-entries')).toContainText(theme === escritorio ? 'pede sua aprovação para rodar um comando' : 'pede sua permissão para conjurar um feitiço');
      expect(await page.evaluate((key) => localStorage.getItem(key), 'agent-quest-discreet')).toBe('1');

      // Trocar de tema com o modo ligado: continua discreto, sem reabrir o /events.
      await page.locator(`#theme-toggle button[data-theme="${themeId === 'escritorio' ? 'guilda' : 'escritorio'}"]`).click();
      await expect.poll(async () => (await html()).match(/SEGREDO-[a-z-]+/g) ?? []).toEqual([]);
      await page.locator(`#theme-toggle button[data-theme="${themeId}"]`).click();

      // Recarregar: continua ligado (localStorage).
      await page.reload();
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#feed-entries li.entry').first()).toBeVisible();
      expect((await html()).match(/SEGREDO-[a-z-]+/g) ?? []).toEqual([]);

      // Tecla D desliga; os textos voltam.
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('d');
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.q-title')).toHaveText(`${SECRET}-titulo`);
      expect(await page.evaluate((key) => localStorage.getItem(key), 'agent-quest-discreet')).toBe('0');
      await page.keyboard.press('D');
      await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'true');

      // Ligar o modo e trocar de tema não reabriram o /events (o reload abre um novo, e só ele).
      expect(events.length).toBe(opened + 1);
      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
    });

    test(`${themeId}: XSS em caminho, comando, descrição, título e erro aparece escapado; some no modo discreto`, async ({ page }) => {
      /** @type {string[]} */
      const dialogs = [];
      page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
      await page.goto(`${srv().base}/#${themeId}`);
      const { s, dev } = freeTextSession(`xss-${themeId}`, () => XSS);
      const state = await inject(srv(), s);
      const session = sessionOf(state, s.sessionId);
      await waitPanelFeed(page, session);
      // O servidor guarda os textos como chegaram (cortados e redigidos); o painel não os interpreta.
      expect(JSON.stringify(session)).toContain(XSS);
      await expect(page.locator('.q-title')).toHaveText(XSS);
      await expect(page.locator('#feed-entries')).toContainText(XSS);
      await expect(page.locator('#party')).toContainText(XSS);
      const scan = () => page.evaluate(() => ({
        images: document.querySelectorAll('img').length,
        handlers: [...document.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length,
      }));
      expect(await scan()).toEqual({ images: 0, handlers: 0 });
      // Com o filtro da instância (chip com o rótulo, que vem da descrição) e a legenda aberta.
      await page.locator(`#party [data-filter="agent:${dev.id}"]`).click();
      await expect(page.locator('#feed-filters .chip-inst')).toContainText(XSS);
      await page.locator('#btn-legend').click();
      expect(await scan()).toEqual({ images: 0, handlers: 0 });
      await page.keyboard.press('Escape');
      // Modo discreto: os vetores somem.
      await page.locator('#btn-discreet').click();
      await expect.poll(() => page.evaluate(() => document.documentElement.outerHTML.includes('img src=x'))).toBe(false);
      expect(dialogs).toEqual([]);
    });
  }

  test('legenda: botão e tecla ?, gerada pelo tema, foco no diálogo; Esc e clique fora fecham; atalhos de tema não valem com ela aberta', async ({ page }) => {
    await page.goto(`${srv().base}/#escritorio`);
    const { s } = freeTextSession('legenda', (field) => `texto-${field}`);
    await inject(srv(), s);
    const legend = page.locator('#legend');
    await expect(legend).toBeHidden();

    await page.locator('#btn-legend').click();
    await expect(legend).toBeVisible();
    await expect(page.locator('#legend-title')).toHaveText('Como ler o painel · Escritório');
    await expect(page.locator('#legend-close')).toBeFocused();
    await expect(page.locator('#legend-body')).toContainText('De onde vem cada dado');
    await expect(page.locator('#legend-body')).toContainText('lê README.md');
    await expect(page.locator('#legend-body')).toContainText('Aproximado (≈)');
    // Com a legenda aberta, 2 e T não trocam o tema.
    await page.keyboard.press('2');
    await page.keyboard.press('t');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'escritorio');
    await page.keyboard.press('Escape');
    await expect(legend).toBeHidden();
    await expect(page.locator('#btn-legend')).toBeFocused();

    // Tecla ? no tema Guilda: o conteúdo é do tema.
    await page.keyboard.press('2');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'guilda');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    await expect(legend).toBeVisible();
    await expect(page.locator('#legend-title')).toHaveText('Como ler o painel · Guilda');
    await expect(page.locator('#legend-body')).toContainText('Arquimago explora README.md');
    // Clique fora da caixa fecha.
    await page.mouse.click(4, 4);
    await expect(legend).toBeHidden();
    // Fechar pelo botão.
    await page.locator('#btn-legend').click();
    await page.locator('#legend-close').click();
    await expect(legend).toBeHidden();
  });

  test('chip da instância: aparece apertado ao filtrar pela equipe e se desfaz no próprio chip (mouse e teclado)', async ({ page }) => {
    await page.goto(`${srv().base}/#escritorio`);
    const { s, dev } = freeTextSession('chip', (field) => `texto-${field}`);
    const state = await inject(srv(), s);
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    const pick = page.locator(`#party [data-filter="agent:${dev.id}"]`);
    const chip = page.locator(`#feed-filters .chip-inst[data-filter="agent:${dev.id}"]`);
    await expect(chip).toHaveCount(0);
    await pick.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toContainText('texto-descricao');
    await expect(page.locator('#feed-filters [aria-pressed="true"]')).toHaveCount(1);
    // Mouse no chip: desfaz, e o "Todos" fica apertado.
    await chip.click();
    await expect(chip).toHaveCount(0);
    await expect(page.locator('#feed-filters [data-filter=""]')).toHaveAttribute('aria-pressed', 'true');
    await expect(pick).toHaveAttribute('aria-pressed', 'false');
    // Teclado: Enter no chip desfaz, e o foco vai para "Todos" (o chip sumiu).
    await pick.click();
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(chip).toHaveCount(0);
    await expect(page.locator('#feed-filters [data-filter=""]')).toBeFocused();
    // "Todos" também desfaz.
    await pick.click();
    await page.locator('#feed-filters [data-filter=""]').click();
    await expect(chip).toHaveCount(0);
  });

  test('cartão final: trocar de tema o redesenha no tema novo, pelo tempo que faltava (relógio da página controlado)', async ({ page }) => {
    // Movimento reduzido: sem View Transition na troca de tema e sem confete, e o
    // cartão aparece parado; os tempos do cartão são os mesmos. O relógio da
    // página fica parado e só anda quando o teste manda, para a carga da máquina
    // não mexer na conta.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    await page.goto(`${srv().base}/#escritorio`);
    const s = createScenario({ label: 't14-final' });
    s.start().prompt('Entregar o cartão').tool('Read', { file_path: `${PROJECT_DIR}\\a.md` });
    const mark = s.mark();
    s.stop();
    const state = await inject(srv(), s.part(0, mark));
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    await page.clock.pauseAt(Date.now() + 60_000);
    await inject(srv(), s.part(mark));
    const card = page.locator('#scene-fx .finale-card');
    // Com o relógio parado, o redesenho (por quadro de animação) anda com runFor.
    await expect.poll(async () => {
      await page.clock.runFor(20);
      return card.count();
    }).toBe(1);
    await expect(card.locator('h3')).toHaveText('Ticket entregue!');

    // 2 s depois, troca de tema: o cartão continua, no tema novo.
    await page.clock.runFor(2_000);
    await expect(card).toHaveCount(1);
    await page.locator('#theme-toggle button[data-theme="guilda"]').click();
    await expect(card.locator('h3')).toHaveText('Quest concluída!');
    await expect(card.locator('p')).toHaveText(/ação|ações/);

    // Faltavam cerca de 1,3 s: pouco antes, ainda na tela; depois da saída, fora.
    const left = FINALE_MS - 2_000;
    await page.clock.runFor(left - 200);
    await expect(card).toHaveCount(1);
    await page.clock.runFor(200 + FINALE_OUT_MS + 100);
    await expect(page.locator('#scene-fx .finale')).toHaveCount(0);
    // Se a troca recomeçasse a conta, o cartão ainda estaria na tela aqui (2 s + 3,3 s).
  });

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}, 600 px: botões só com ícone com nome acessível e foco visível; o estado apertado tem um traço independente da cor`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 600, height: 900 } });
      const page = await context.newPage();
      try {
        await page.goto(`${srv().base}/#${themeId}`);
        const { s, dev } = freeTextSession(`icones-${themeId}`, (field) => `texto-${field}`);
        await inject(srv(), s);
        await expect(page.locator('#session-info')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        for (const [selector, name] of [['#session-follow', 'Seguir atividade'], ['#btn-discreet', 'Modo discreto'], ['#btn-legend', 'Abrir a legenda']]) {
          await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
          // Só o ícone na tela: o texto fica para leitores de tela.
          const box = await page.locator(selector).boundingBox();
          expect(box?.width ?? 0, selector).toBeLessThan(60);
          // Foco pelo teclado: contorno de 2 px, com contraste de pelo menos 3:1 contra o fundo.
          await page.locator(selector).focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(page.locator(selector)).toBeFocused();
          const outline = await page.locator(selector).evaluate((el) => [getComputedStyle(el).outlineStyle, parseFloat(getComputedStyle(el).outlineWidth)]);
          expect(outline[0], selector).not.toBe('none');
          expect(outline[1], selector).toBeGreaterThanOrEqual(2);
          const ratio = await page.evaluate(measureIndicator, { selector, property: /** @type {const} */ ('outlineColor') });
          expect(ratio ?? 0, `${selector}: contraste do foco`).toBeGreaterThanOrEqual(3);
        }
        // Traço do estado apertado: existe só no apertado, na cor do texto, nos chips e nos botões.
        await page.locator(`#party [data-filter="agent:${dev.id}"]`).click();
        await page.locator('#btn-discreet').click();
        /** @param {string} selector */
        const bar = (selector) => page.locator(selector).evaluate((el) => {
          const after = getComputedStyle(el, '::after');
          return { content: after.content, height: after.height, color: after.backgroundColor, text: getComputedStyle(document.body).color };
        });
        for (const selector of ['#feed-filters .chip-inst', '#btn-discreet', '#session-follow[aria-pressed="false"], #session-follow']) {
          const pressed = await page.locator(selector).first().getAttribute('aria-pressed');
          const value = await bar(selector);
          if (pressed === 'true') {
            expect(value.content, selector).toBe('""');
            expect(value.height, selector).toBe('2px');
            expect(value.color, selector).toBe(value.text);
          } else {
            expect(value.content, selector).toBe('none');
          }
        }
        expect((await bar('#feed-filters [data-filter=""]')).content, '"Todos" solto não tem traço').toBe('none');
      } finally {
        await context.close();
      }
    });
  }

  test('sessão fixada que sumiu: o seletor avisa, e escolher a sessão que aparece passa a fixá-la', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('t14-pronto')) {
        localStorage.setItem('agent-quest-session', JSON.stringify({ follow: false, pinnedId: 'sessao-que-sumiu' }));
        sessionStorage.setItem('t14-pronto', '1');
      }
    });
    await page.goto(`${srv().base}/#escritorio`);
    const { s } = freeTextSession('fixada', (field) => `texto-${field}`);
    const state = await inject(srv(), s);
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    const select = page.locator('#session-select');
    await expect(select).toHaveValue('');
    await expect(page.locator('#session-select option:checked')).toHaveText(/^Sessão fixada indisponível · mostrando texto-titulo · agents-quest · /);
    await expect(page.locator('#session-select option[value=""]')).toBeDisabled();
    await select.selectOption(s.sessionId);
    await expect(select).toHaveValue(s.sessionId);
    await expect(page.locator('#session-select option[value=""]')).toHaveCount(0);
    expect(JSON.parse(String(await page.evaluate(() => localStorage.getItem('agent-quest-session'))))).toEqual({ follow: false, pinnedId: s.sessionId });
    // A escolha continua depois de recarregar.
    await page.reload();
    await expect(select).toHaveValue(s.sessionId);
    expect((await settledState(srv().port)).sessions.length).toBe(1);
  });
});
