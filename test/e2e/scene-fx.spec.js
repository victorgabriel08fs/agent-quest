// @ts-check
// Cena animada (T12b), no Edge:
// - ao vivo, com o injetor do T9b e o cenário sintético: o subagente encerrado
//   caminha até a copa (FLIP), o envelope voa na delegação e a falha tem
//   impacto, sem violação de CSP;
// - estados do T8 contra os snapshots escritos à mão (test/fixtures/state/),
//   por um /events simulado que entrega um passo por vez: selo "!" e balão de
//   aprovação, bugs na sala de testes (até 4 e "+N") com alarme, derrota dos
//   bugs quando zeram e o cartão final do ticket entregue. [T8]: conferir ao
//   vivo depois do T8;
// - com movimento reduzido, nenhuma animação (document.getAnimations() vazio).

import { expect, test } from '@playwright/test';
import { injectScenario } from '../../scripts/inject-fixture.mjs';
import { syntheticScenario } from '../unit/server/domain/scenarios.js';
import { freePort, removeHome, serverState, startServer, tempHome } from './live-server.js';
import { loadSnapshot, watchPage } from './support.js';

/** @typedef {import('@playwright/test').Page} Page */

const MAIN_SESSION = 'a8cf05fb-e263-4334-ae84-6d04a7151a8d';

// Servidor próprio, injeção em tempo real e o cartão final que sai sozinho:
// sob carga (vários processos do Playwright em paralelo), 30 s não bastam.
test.describe.configure({ timeout: 90_000 });

/**
 * Grava, a cada quadro, as animações da página: ids das animações do fx.js,
 * nomes das do CSS, sala de destino de cada movimento e o maior número de
 * animações ao mesmo tempo. Instalado antes do primeiro script da página.
 * @param {Page} page
 */
async function recordAnimations(page) {
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.__fx = { ids: {}, css: {}, moves: {}, max: 0, idleTokens: 0 };
    const tick = () => {
      const all = document.getAnimations();
      w.__fx.max = Math.max(w.__fx.max, all.length);
      for (const animation of all) {
        if (animation.id) w.__fx.ids[animation.id] = (w.__fx.ids[animation.id] ?? 0) + 1;
        const name = /** @type {any} */ (animation).animationName;
        if (name) w.__fx.css[name] = true;
        const target = /** @type {KeyframeEffect|null} */ (animation.effect)?.target;
        if (animation.id === 'fx-move' && target instanceof Element) {
          const room = target.closest('.room')?.getAttribute('data-room') ?? (target.closest('.fx') ? 'fantasma' : '?');
          w.__fx.moves[room] = true;
        }
      }
      w.__fx.idleTokens = Math.max(w.__fx.idleTokens, document.querySelectorAll('.room[data-room="idle"] .token').length);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** @param {Page} page */
const recorded = (page) => page.evaluate(() => /** @type {any} */ (window).__fx);

// ---------------------------------------------------------------------------
// Ao vivo
// ---------------------------------------------------------------------------

test.describe('cena ao vivo com o injetor', () => {
  /** @type {string} */
  let home;
  /** @type {number} */
  let port;
  /** @type {Awaited<ReturnType<typeof startServer>>|null} */
  let server = null;

  test.beforeEach(async () => {
    home = tempHome();
    port = await freePort();
    server = await startServer(port, home);
  });

  test.afterEach(async () => {
    await server?.stop();
    server = null;
    removeHome(home);
  });

  /**
   * Injeta o cenário sintético e espera o servidor terminar de processar e o
   * painel mostrar o mesmo feed.
   * @param {Page} page
   * @param {{ fast?: boolean, speed?: number }} options
   */
  async function injectAll(page, options) {
    const result = await injectScenario(/** @type {any} */ (syntheticScenario()), { port, token: server?.token ?? '', ...options });
    expect(result.refused).toEqual([]);
    /** @type {any} */
    let session;
    let previous = -1;
    await expect.poll(async () => {
      const state = await serverState(port);
      const stable = state.seq === previous;
      previous = state.seq;
      session = state.sessions.find((s) => s.id === MAIN_SESSION);
      return stable && session !== undefined;
    }, { intervals: [150, 250, 250, 400] }).toBe(true);
    await expect.poll(async () => page.locator('#feed-entries li.entry').count()).toBe(session.feed.length);
  }

  test('o subagente encerrado caminha até a copa; envelope na delegação; impacto na falha; sem violar a CSP', async ({ page }) => {
    const base = `http://127.0.0.1:${port}`;
    const watch = await watchPage(page, base);
    await recordAnimations(page);
    await page.goto(`${base}/#escritorio`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');

    await injectAll(page, { speed: 2 });
    const fx = await recorded(page);
    expect(Object.keys(fx.ids)).toEqual(expect.arrayContaining(['fx-move', 'fx-walk', 'fx-envelope', 'fx-hit', 'fx-spawn']));
    expect(fx.moves.idle, 'algum token caminhou até a copa').toBe(true);
    expect(fx.css.bob, 'quem trabalha balança (CSS do mockup)').toBe(true);
    // O que é temporário sai da camada de efeitos.
    await expect(page.locator('#scene-fx .flyer, #scene-fx .ghost')).toHaveCount(0, { timeout: 5_000 });

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.csp).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('com movimento reduzido, os tokens vão direto para a vaga, sem nenhuma animação', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const base = `http://127.0.0.1:${port}`;
    const watch = await watchPage(page, base);
    await recordAnimations(page);
    await page.goto(`${base}/#guilda`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');

    await injectAll(page, { speed: 4 });
    const fx = await recorded(page);
    expect(fx.max, 'nenhuma animação em nenhum quadro').toBe(0);
    expect(fx.ids).toEqual({});
    expect(fx.idleTokens, 'encerrados apareceram na copa').toBeGreaterThan(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await expect(page.locator('#scene-fx > *')).toHaveCount(0);
    expect(watch.problems.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Estados do T8, com snapshots escritos à mão
// ---------------------------------------------------------------------------

/**
 * /events simulado em passos: cada conexão entrega o passo seguinte, só quando
 * o teste libera (`release`). O `retry` curto faz o navegador reconectar logo
 * depois de cada passo; o último usa um `retry` longo.
 * @param {Page} page
 * @param {{ seq: number, messages: [string, any][] }[]} steps
 */
async function scriptedEvents(page, steps) {
  /** @type {(() => void)[]} */
  const opens = [];
  const gates = steps.map(() => new Promise((resolve) => { opens.push(() => resolve(undefined)); }));
  opens[0]();
  let served = 0;
  await page.route('**/events', async (route) => {
    const index = Math.min(served++, steps.length - 1);
    await gates[index];
    const step = steps[index];
    const body = `retry: ${index === steps.length - 1 ? 3_600_000 : 100}\n\n`
      + `event: hello\ndata: ${JSON.stringify({ protocol: 1, runId: 'e2e', seq: step.seq, serverVersion: 'e2e' })}\n\n`
      + step.messages.map(([type, data]) => `id: e2e:${data.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' }, body }).catch(() => {});
  });
  return { release: (/** @type {number} */ index) => opens[index]() };
}

/** Passos: tester aguardando com 2 bugs; 6 bugs; testes passam e o ticket é entregue. */
function t8Steps() {
  const open = loadSnapshot('ticket-completo');
  const done = loadSnapshot('ticket-entregue');
  const { feed: _feed, ...openState } = open.sessions[0];
  const { feed: doneFeed, ...doneState } = done.sessions[0];
  const fresh = doneFeed.filter((/** @type {any} */ event) => event.seq > open.seq + 1);
  return [
    { seq: open.seq, messages: /** @type {[string, any][]} */ ([['snapshot', open]]) },
    { seq: open.seq + 1, messages: /** @type {[string, any][]} */ ([['update', { seq: open.seq + 1, event: null, session: { ...openState, bugs: { ...openState.bugs, open: 6 } } }]]) },
    { seq: done.seq, messages: /** @type {[string, any][]} */ (fresh.map((/** @type {any} */ event) => ['update', { seq: event.seq, event, session: doneState }])) },
  ];
}

const T8_WORDS = {
  escritorio: { waiting: '✋ Aguardando sua aprovação', finale: 'Ticket entregue!', people: '4 pessoas na equipe' },
  guilda: { waiting: '❗ Aguardando sua permissão', finale: 'Quest concluída!', people: '4 membros da party' },
};

for (const theme of /** @type {const} */ (['escritorio', 'guilda'])) {
  test(`[T8] ${theme}: selo e balão de aprovação, bugs com "+N" e alarme, derrota dos bugs e cartão final`, async ({ page, baseURL }) => {
    const words = T8_WORDS[theme];
    const watch = await watchPage(page, String(baseURL));
    await recordAnimations(page);
    const script = await scriptedEvents(page, t8Steps());
    await page.goto(`/#${theme}`);

    // Tester aguardando aprovação: selo "!" e balão de aprovação; 2 bugs; alarme.
    const waiting = page.locator('.token.waiting');
    await expect(waiting).toHaveCount(1);
    await expect(waiting.locator('.tok-alert')).toHaveText('!');
    await expect(waiting.locator('.bubble-text')).toHaveText(words.waiting);
    const testRoom = page.locator('.room[data-room="test"]');
    await expect(testRoom).toHaveClass(/alarm/);
    await expect(testRoom.locator('.bug')).toHaveCount(2);
    await expect(page.locator('.rooms')).toHaveAttribute('aria-label', /2 falhas de teste em aberto/);

    // Seis bugs: quatro na sala e "+2"; os novos aparecem animados.
    script.release(1);
    await expect(testRoom.locator('.bug')).toHaveCount(4);
    await expect(testRoom.locator('.bug-more')).toHaveText('+2');
    await expect.poll(async () => (await recorded(page)).ids['fx-bug-spawn'] ?? 0).toBeGreaterThan(0);

    // Testes passam e o ticket é entregue: bugs derrotados, alarme some, o tester
    // caminha até a copa e aparece o cartão final, sem XP.
    script.release(2);
    await expect(testRoom.locator('.bug')).toHaveCount(0);
    await expect(testRoom).not.toHaveClass(/alarm/);
    const finale = page.locator('#scene-fx .finale');
    await expect(finale).toBeVisible();
    await expect(finale.locator('h3')).toHaveText(words.finale);
    await expect(finale.locator('p')).toHaveText(`47 ações · ${words.people} · 05:31`);
    await expect(finale).not.toContainText(/XP/);
    const fx = await recorded(page);
    expect(Object.keys(fx.ids)).toEqual(expect.arrayContaining(['fx-defeat', 'fx-move', 'fx-burst']));
    expect(fx.moves.idle, 'o tester caminhou até a copa').toBe(true);
    expect(fx.css.ping && fx.css.alarm, 'selo e alarme pulsam (CSS do mockup)').toBe(true);
    await expect(page.locator('.room[data-room="idle"] .token[data-key="a9a4b5c6d7e8f9a03"]')).toHaveCount(1);
    // O cartão sai sozinho.
    await expect(finale).toHaveCount(0, { timeout: 8_000 });

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.csp).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });
}

test('[T8] com movimento reduzido: os mesmos estados, sem nenhuma animação; o cartão final aparece parado', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const watch = await watchPage(page, String(baseURL));
  await recordAnimations(page);
  const script = await scriptedEvents(page, t8Steps());
  await page.goto('/#escritorio');
  await expect(page.locator('.token.waiting .tok-alert')).toHaveText('!');
  await expect(page.locator('.room[data-room="test"] .bug')).toHaveCount(2);
  script.release(1);
  await expect(page.locator('.room[data-room="test"] .bug')).toHaveCount(4);
  script.release(2);
  await expect(page.locator('#scene-fx .finale')).toBeVisible();
  await expect(page.locator('.room[data-room="test"] .bug')).toHaveCount(0);
  await expect(page.locator('#scene-fx .finale .particle')).toHaveCount(0);
  const fx = await recorded(page);
  expect(fx.max).toBe(0);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(watch.problems.errors).toEqual([]);
});
