// @ts-check
// Cena animada (T12b) no Edge, com o servidor real do diretório de trabalho (que
// já tem o T8) e cenários fictícios injetados pelo injetor do T9b. Complementa
// test/e2e/scene-fx.spec.js (do dev) com o que o tester cobre:
// - os efeitos ao vivo, nos dois temas: envelope na delegação, impacto na falha
//   (e nenhum na falha interrompida), caminhada até a copa, fantasma até o "+N",
//   e os estados do T8 (selo "!" e balão de aprovação, bugs até 4 e "+N" com
//   alarme e derrota, cartão final do ticket entregue);
// - CSP: nenhuma escrita de `style` e nenhum atributo style no DOM;
// - nada do evento vira HTML na cena;
// - contraste dos elementos novos; movimento reduzido sem nenhuma chamada a
//   animate(); largura de celular;
// - desempenho por contagem (ADR 0010): numa rajada, as animações por elemento
//   ficam limitadas, a camada .fx esvazia no fim e nada continua sendo criado.
//
// `Element.prototype.animate` é instrumentado antes do primeiro script da
// página: cada chamada conta, com o id do efeito e a chave do token.

import { expect, test } from '@playwright/test';
import escritorio from '../../web/js/themes/escritorio.js';
import guilda from '../../web/js/themes/guilda.js';
import { createHelpers } from '../../web/js/themes/helpers.js';
import { createScenario, inject, measure, startLiveServer, waitFor } from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */
/** @typedef {import('@playwright/test').Page} Page */

const THEMES = { escritorio, guilda };
const FILE = (/** @type {string} */ name) => `C:\\Users\\fulano\\Projetos\\agents-quest\\${name}`;
const TEST_FAIL = (/** @type {number} */ failed, /** @type {number} */ total) =>
  `Exit code 1\nℹ tests ${total}\nℹ suites 0\nℹ pass ${total - failed}\nℹ fail ${failed}\nℹ duration_ms 52.3\n`;
const TEST_PASS = (/** @type {number} */ total) =>
  ({ stdout: `ℹ tests ${total}\nℹ suites 0\nℹ pass ${total}\nℹ fail 0\nℹ duration_ms 40.1\n`, stderr: '', interrupted: false, isImage: false });

/**
 * Instrumenta a página antes do primeiro script: chamadas a animate() (por id e
 * por token), escritas do atributo style, o maior número de animações (no
 * total e num mesmo elemento) e de elementos na camada .fx, a cada quadro.
 * @param {Page} page
 */
async function instrument(page) {
  // A medida de contraste roda na página no instante em que o cartão final é
  // criado (ele sai sozinho em 3,7 s; sob carga, uma asserção depois pode não
  // achá-lo mais). Entra por script injetado: a CSP não permite new Function.
  await page.addInitScript({ content: `window.__measure = ${measure.toString()};` });
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.__scene = { calls: 0, ids: {}, byKey: {}, props: {}, styleWrites: 0, maxAll: 0, maxPerElement: 0, maxFx: 0, fxAdded: [], finales: [] };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const s = w.__scene;
      s.calls++;
      const id = options && typeof options === 'object' ? options.id : undefined;
      if (id) {
        s.ids[id] = (s.ids[id] ?? 0) + 1;
        const key = this.closest?.('.token')?.getAttribute('data-key');
        if (key) s.byKey[`${id}|${key}`] = (s.byKey[`${id}|${key}`] ?? 0) + 1;
      }
      if (Array.isArray(keyframes)) {
        for (const frame of keyframes) for (const prop of Object.keys(frame)) if (!['offset', 'easing', 'composite'].includes(prop)) s.props[prop] = true;
      }
      return animate.call(this, keyframes, options);
    };
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (String(name).toLowerCase() === 'style') w.__scene.styleWrites++;
      return setAttribute.call(this, name, value);
    };
    const tick = () => {
      const s = w.__scene;
      const all = document.getAnimations();
      s.maxAll = Math.max(s.maxAll, all.length);
      const perElement = new Map();
      for (const animation of all) {
        const target = /** @type {KeyframeEffect|null} */ (animation.effect)?.target;
        if (target) perElement.set(target, (perElement.get(target) ?? 0) + 1);
      }
      for (const n of perElement.values()) s.maxPerElement = Math.max(s.maxPerElement, n);
      const fx = document.getElementById('scene-fx');
      if (fx) s.maxFx = Math.max(s.maxFx, fx.querySelectorAll('*').length);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.addEventListener('DOMContentLoaded', () => {
      const fx = document.getElementById('scene-fx');
      if (!fx) return;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            w.__scene.fxAdded.push(node.className);
            // Cartão final: registrado no instante em que aparece (textos,
            // confete, tamanho e contraste), para as asserções não dependerem
            // de ele ainda estar na tela.
            if (node.classList.contains('finale')) {
              const card = /** @type {HTMLElement|null} */ (node.querySelector('.finale-card'));
              const overlay = node.getBoundingClientRect();
              w.__scene.finales.push({
                h3: node.querySelector('h3')?.textContent ?? '',
                p: node.querySelector('p')?.textContent ?? '',
                text: node.textContent ?? '',
                particles: node.querySelectorAll('.particle').length,
                cardWidth: card?.offsetWidth ?? 0,
                overlay: { left: overlay.left, right: overlay.right },
                viewport: document.documentElement.clientWidth,
                contrast: typeof w.__measure === 'function' ? w.__measure(['#scene-fx .finale-card h3', '#scene-fx .finale-card p']) : [],
              });
            }
          }
        }
      }).observe(fx, { childList: true });
    });
  });
}

/** @param {Page} page */
const scene = (page) => page.evaluate(() => /** @type {any} */ (window).__scene);

/**
 * Espera a cena assentar: camada .fx vazia e só animações contínuas (do CSS).
 * @param {Page} page
 */
async function waitSceneIdle(page, timeoutMs = 15_000) {
  await waitFor(() => page.evaluate(() => {
    const fx = document.getElementById('scene-fx');
    const finite = document.getAnimations().filter((a) => /** @type {any} */ (a.effect)?.getTiming().iterations !== Infinity);
    return (fx?.childElementCount ?? 1) === 0 && finite.length === 0;
  }), 'a cena assentar (camada .fx vazia e sem animações finitas)', timeoutMs);
}

/** O que não pode existir no DOM (CSP e escape). */
const domProblems = () => {
  const problems = [];
  if (document.querySelectorAll('xss-marca, [data-xss]').length > 0) problems.push('elemento vindo de dado de evento');
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      if (attr.startsWith('on')) problems.push(`atributo ${attr} em <${el.tagName.toLowerCase()}>`);
      if (attr === 'style') problems.push(`style inline em <${el.tagName.toLowerCase()}.${el.className}>`);
    }
  }
  if (/** @type {any} */ (window).__xss !== undefined) problems.push('código executado');
  return problems;
};

/**
 * Sessão com tester, dois convidados, falhas, testes que falham e passam,
 * aprovação na sessão principal e ticket entregue. Partes para injetar aos poucos.
 * @param {string} label
 * @param {{ hostile?: boolean }} [options]
 */
function liveScenario(label, { hostile = false } = {}) {
  const tag = hostile ? ' "><img src=x data-xss="1" onerror="window.__xss=1"><xss-marca>' : '';
  const s = createScenario({ label });
  const tes = s.agent('tes', 'tester');
  const g1 = s.agent('g1', hostile ? `plugin:<img src=x data-xss="2" onerror="window.__xss=2">` : 'Explore');
  const g2 = s.agent('g2', 'Plan');
  s.start().prompt(`Corrigir os testes${tag}`);
  s.tool('Read', { file_path: FILE('README.md') });
  const marks = [s.mark()];
  const tesCall = s.delegate(tes, `Rodar os testes${tag}`);
  const g1Call = s.delegate(g1, `Procurar exemplos${tag}`);
  const g2Call = s.delegate(g2, 'Planejar');
  s.pre('Grep', { pattern: `filtro${tag}`, path: 'web' }, g1); // g1 trabalhando, com balão
  marks.push(s.mark());
  // Falha comum (impacto) e falha interrompida por Esc (sem impacto).
  s.tool('Bash', { command: `node -e "process.exit(1)"${tag}` }, { agent: g1, error: 'Exit code 1' });
  const interrupted = s.pre('Bash', { command: 'node -e "setTimeout(()=>{},30000)"' }, g2);
  s.raw('PostToolUseFailure', { tool_name: 'Bash', tool_input: interrupted.input, tool_use_id: interrupted.id, error: 'Interrupted by user', is_interrupt: true, duration_ms: 5 }, g2);
  marks.push(s.mark());
  // Testes falham: 6 bugs (4 na sala e "+2").
  s.tool('Bash', { command: 'npm test', description: 'Rodar a suíte' }, { agent: tes, error: TEST_FAIL(6, 8) });
  marks.push(s.mark());
  // Aprovação pendente na sessão principal.
  const ask = s.pre('Bash', { command: `node -e "console.log(1)"${tag}`, description: 'Imprimir 1' });
  s.permission(ask);
  marks.push(s.mark());
  s.post(ask, { stdout: '1\n', stderr: '', interrupted: false, isImage: false });
  // Testes passam: bugs derrotados.
  s.tool('Bash', { command: 'npm test', description: 'Rodar a suíte' }, { agent: tes, response: TEST_PASS(8) });
  marks.push(s.mark());
  // Todos voltam para a copa e o ticket é entregue.
  s.finish(g1, g1Call);
  s.finish(g2, g2Call);
  s.finish(tes, tesCall);
  s.stop();
  marks.push(s.mark());
  const parts = marks.slice(1).map((end, i) => s.part(marks[i], end));
  return {
    s,
    keys: { tes: tes.id, g1: g1.id, g2: g2.id },
    first: s.part(0, marks[0]),
    /** [delegações, falhas, testes falham, aprovação pedida, aprovada e testes passam, fim] */
    parts,
  };
}

/** @param {any} state @param {string} id */
const sessionOf = (state, id) => state.sessions.find((/** @type {any} */ x) => x.id === id);

test.describe('cena animada ao vivo (tester)', () => {
  test.describe.configure({ timeout: 120_000 });
  /** @type {LiveServer|null} */
  let server = null;

  test.beforeEach(async () => {
    server = await startLiveServer();
  });

  test.afterEach(async () => {
    await server?.dispose();
    server = null;
  });

  /** @returns {LiveServer} */
  const srv = () => {
    if (!server) throw new Error('sem servidor');
    return server;
  };

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: envelope, impacto (não no Esc), caminhada até a copa, selo e balão de aprovação, bugs com "+N", alarme e derrota, cartão final`, async ({ page }) => {
      const theme = THEMES[themeId];
      const watch = await watchPage(page, srv().base);
      await instrument(page);
      const { s, keys, first, parts } = liveScenario(`cena-${themeId}`);
      await page.goto(`${srv().base}/#${themeId}`);
      await expect(page.locator('#conn')).toHaveText('ao vivo');
      await inject(srv(), first);
      await expect(page.locator('.token[data-key="main"]')).toHaveCount(1);
      // A cena não tem partes clicáveis: a regra de foco e clique não se aplica.
      await expect(page.locator('#scene button, #scene a, #scene [tabindex], #scene [role="button"]')).toHaveCount(0);

      // Delegações: um envelope por delegação, que sai da camada no fim.
      let state = await inject(srv(), parts[0]);
      for (const key of Object.values(keys)) await expect(page.locator(`.token[data-key="${key}"]`)).toHaveCount(1);
      await expect.poll(async () => (await scene(page)).ids['fx-envelope'] ?? 0).toBeGreaterThanOrEqual(3);
      expect((await scene(page)).fxAdded.filter((/** @type {string} */ c) => c === 'flyer').length).toBe(3);
      await expect(page.locator('#scene-fx .flyer')).toHaveCount(0, { timeout: 5_000 });

      // Falha comum: impacto no retrato do g1; falha interrompida (g2): nenhum.
      state = await inject(srv(), parts[1]);
      await expect.poll(async () => (await scene(page)).byKey[`fx-hit|${keys.g1}`] ?? 0).toBeGreaterThan(0);
      expect((await scene(page)).byKey[`fx-hit|${keys.g2}`] ?? 0).toBe(0);

      // Testes falham: bugs.open = 6 → 4 bugs, "+2", alarme, aparecimento animado.
      state = await inject(srv(), parts[2]);
      let session = sessionOf(state, s.sessionId);
      expect(session.bugs.open, '[T8] bugs.open depois de 6 falhas').toBe(6);
      const testRoom = page.locator('.room[data-room="test"]');
      await expect(testRoom.locator('.bug')).toHaveCount(4);
      await expect(testRoom.locator('.bug-more')).toHaveText('+2');
      await expect(testRoom).toHaveClass(/alarm/);
      await expect(page.locator('.rooms')).toHaveAttribute('aria-label', /6 falhas de teste em aberto/);
      await expect.poll(async () => (await scene(page)).ids['fx-bug-spawn'] ?? 0).toBeGreaterThanOrEqual(4);

      // Aprovação pendente na sessão principal: selo "!" e o balão do tema.
      state = await inject(srv(), parts[3]);
      session = sessionOf(state, s.sessionId);
      const main = session.agents.find((/** @type {any} */ a) => a.key === 'main');
      expect(main.status, '[T8] main aguardando').toBe('waiting');
      const mainToken = page.locator('.token[data-key="main"]');
      await expect(mainToken).toHaveClass(/waiting/);
      await expect(mainToken.locator('.tok-alert')).toHaveText('!');
      await expect(mainToken.locator('.bubble-text')).toHaveText(theme.actionText(main, createHelpers(theme, session.agents)));

      // Aprovada e testes passam: selo some, bugs derrotados (fantasmas que saem), sem alarme.
      state = await inject(srv(), parts[4]);
      await expect(mainToken.locator('.tok-alert')).toHaveCount(0);
      await expect(testRoom.locator('.bug')).toHaveCount(0);
      await expect(testRoom).not.toHaveClass(/alarm/);
      await expect.poll(async () => (await scene(page)).ids['fx-defeat'] ?? 0).toBe(4);
      await expect(page.locator('#scene-fx .bug')).toHaveCount(0, { timeout: 5_000 });

      // Fim: os três caminham até a copa; ticket entregue com o cartão final do tema.
      state = await inject(srv(), parts[5]);
      session = sessionOf(state, s.sessionId);
      for (const key of Object.values(keys)) {
        await expect(page.locator(`.room[data-room="idle"] .token[data-key="${key}"]`)).toHaveCount(1);
        expect((await scene(page)).byKey[`fx-move|${key}`] ?? 0, `${key} caminhou`).toBeGreaterThan(0);
      }
      expect(session.quest?.status, '[T8] ticket entregue').toBe('done');
      // O cartão final é conferido pelo registro feito quando ele apareceu (ele
      // sai sozinho em 3,7 s; sob carga, sumia entre duas asserções).
      await expect.poll(async () => (await scene(page)).finales.length).toBe(1);
      const [shownFinale] = (await scene(page)).finales;
      const card = theme.finale({ n: 0, title: '', actions: 0, agents: 0, durationMs: 0 });
      expect(shownFinale.h3).toBe(card.title);
      expect(shownFinale.p).toContain(`${session.quest.actions} `);
      expect(shownFinale.text).not.toMatch(/XP/);
      expect(shownFinale.particles).toBeGreaterThan(0);
      expect((await scene(page)).ids['fx-burst'] ?? 0).toBeGreaterThan(0);

      // Tudo assenta: camada .fx vazia (o cartão sai sozinho) e só animações contínuas.
      await waitSceneIdle(page);
      const calls = (await scene(page)).calls;
      await page.waitForTimeout(1_500);
      expect((await scene(page)).calls, 'nenhuma animação nova sem evento novo').toBe(calls);

      const record = await scene(page);
      test.info().annotations.push({ type: 'propriedades animadas', description: Object.keys(record.props).sort().join(', ') });
      console.log(`[cena ${themeId}] chamadas a animate()=${record.calls} máx. por elemento=${record.maxPerElement} máx. na .fx=${record.maxFx} propriedades=${Object.keys(record.props).sort().join(',')}`);
      expect(record.styleWrites).toBe(0);
      expect(await page.evaluate(domProblems)).toEqual([]);
      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.csp).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
    });
  }

  test('copa lotada: o token que sai das 3 vagas vira um fantasma que vai até o "+N" e sai da camada', async ({ page }) => {
    await instrument(page);
    const s = createScenario({ label: 'copa' });
    const guests = [1, 2, 3, 4, 5].map((n) => s.agent(`g${n}`, 'Explore'));
    s.start().prompt('Cinco buscas');
    const first = s.mark();
    for (const [i, guest] of guests.slice(0, 3).entries()) {
      const call = s.delegate(guest, `Busca ${i + 1}`);
      s.tool('Glob', { pattern: `p${i}/**` }, { agent: guest });
      s.finish(guest, call);
    }
    const second = s.mark();
    for (const [i, guest] of guests.slice(3).entries()) {
      const call = s.delegate(guest, `Busca ${i + 4}`);
      s.tool('Glob', { pattern: `q${i}/**` }, { agent: guest });
      s.finish(guest, call);
    }
    await page.goto(`${srv().base}/#guilda`);
    await inject(srv(), s.part(0, first));
    await inject(srv(), s.part(first, second));
    const idle = page.locator('.room[data-room="idle"]');
    await expect(idle.locator('.token')).toHaveCount(3);
    await waitSceneIdle(page);
    await page.evaluate(() => { /** @type {any} */ (window).__scene.fxAdded = []; });
    await inject(srv(), s.part(second));
    await expect(idle.locator('.token')).toHaveCount(3);
    await expect(idle.locator('.room-more')).toHaveText('+2');
    expect((await scene(page)).fxAdded.filter((/** @type {string} */ c) => c === 'ghost').length).toBeGreaterThanOrEqual(2);
    await waitSceneIdle(page);
    await expect(page.locator('#scene-fx .ghost')).toHaveCount(0);
  });

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: dados hostis na cena (tipo do convidado, rótulos, comandos e o pedido de aprovação) viram texto`, async ({ page }) => {
      const watch = await watchPage(page, srv().base);
      /** @type {string[]} */
      const dialogs = [];
      page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
      await instrument(page);
      const { s, first, parts } = liveScenario(`hostil-${themeId}`, { hostile: true });
      await page.goto(`${srv().base}/#${themeId}`);
      await inject(srv(), first);
      await inject(srv(), parts[0]);
      // Convidado trabalhando: tipo, rótulo e ação (balão) com o texto hostil.
      const sceneText = String(await page.locator('#scene-stage').textContent());
      const titles = await page.locator('#scene-stage [title]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('title')).join('\n'));
      expect(`${sceneText}\n${titles}`).toContain('<img src=x');
      expect(await page.evaluate(domProblems)).toEqual([]);
      for (const part of parts.slice(1)) {
        await inject(srv(), part);
        expect(await page.evaluate(domProblems)).toEqual([]);
        await page.keyboard.press('t');
        expect(await page.evaluate(domProblems)).toEqual([]);
      }
      expect(dialogs).toEqual([]);
      expect((await scene(page)).styleWrites).toBe(0);
      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.csp).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
      void s;
    });
  }

  test('movimento reduzido: nenhuma chamada a animate() no cenário inteiro; estados aparecem parados; cartão final sem confete', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await instrument(page);
    const { s, keys, first, parts } = liveScenario('reduzido');
    await page.goto(`${srv().base}/#guilda`);
    await inject(srv(), first);
    await inject(srv(), parts[0]);
    await inject(srv(), parts[1]);
    await inject(srv(), parts[2]);
    await expect(page.locator('.room[data-room="test"] .bug')).toHaveCount(4);
    await inject(srv(), parts[3]);
    await expect(page.locator('.token[data-key="main"] .tok-alert')).toHaveText('!');
    await page.keyboard.press('1');
    await inject(srv(), parts[4]);
    await inject(srv(), parts[5]);
    for (const key of Object.values(keys)) await expect(page.locator(`.room[data-room="idle"] .token[data-key="${key}"]`)).toHaveCount(1);
    // Cartão final pelo registro de quando apareceu: parado, sem confete.
    await expect.poll(async () => (await scene(page)).finales.length).toBe(1);
    expect((await scene(page)).finales[0].particles).toBe(0);
    const record = await scene(page);
    expect(record.calls, 'chamadas a animate()').toBe(0);
    expect(record.maxAll, 'animações em algum quadro').toBe(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(record.fxAdded.filter((/** @type {string} */ c) => c !== 'finale')).toEqual([]);
    void s;
  });

  test('rajada: animações por elemento limitadas, camada .fx vazia no fim e nada continua sendo criado', async ({ page }) => {
    await instrument(page);
    const s = createScenario({ label: 'rajada-cena' });
    const tes = s.agent('tes', 'tester');
    const guests = Array.from({ length: 10 }, (_, n) => s.agent(`g${n}`, 'Explore'));
    for (const round of [1, 2]) {
      s.prompt(`Rodada ${round}`);
      const tesCall = s.delegate(tes, `Testes da rodada ${round}`);
      const calls = guests.map((guest, n) => s.delegate(guest, `Busca ${round}-${n}`));
      for (let i = 0; i < 3; i++) {
        for (const [n, guest] of guests.entries()) {
          if ((n + i) % 3 === 0) s.tool('Bash', { command: `node -e "process.exit(${n})"` }, { agent: guest, error: `Exit code ${n}` });
          else s.tool('Read', { file_path: FILE(`r${round}-${i}-${n}.md`) }, { agent: guest });
        }
        s.tool('Bash', { command: 'npm test', description: 'Rodar a suíte' }, { agent: tes, error: TEST_FAIL(2 + i * 2, 10) });
        s.tool('Bash', { command: 'npm test', description: 'Rodar a suíte' }, { agent: tes, response: TEST_PASS(10 + i) });
      }
      const ask = s.pre('Bash', { command: `node -e "console.log(${round})"` });
      s.permission(ask);
      s.post(ask, { stdout: `${round}\n`, stderr: '', interrupted: false, isImage: false });
      for (const [n, guest] of guests.entries()) s.finish(guest, calls[n]);
      s.finish(tes, tesCall);
      s.stop();
    }
    await page.goto(`${srv().base}/#escritorio`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');
    const state = await inject(srv(), { events: [s.events[0]] });
    expect(sessionOf(state, s.sessionId)).toBeTruthy();
    await inject(srv(), { events: s.events.slice(1) }, { fast: true });
    await waitSceneIdle(page, 20_000);
    const calls = (await scene(page)).calls;
    await page.waitForTimeout(1_500);
    const record = await scene(page);
    console.log(`[rajada da cena] eventos=${s.events.length} chamadas a animate()=${record.calls} máx. total=${record.maxAll} máx. por elemento=${record.maxPerElement} máx. na .fx=${record.maxFx}`);
    test.info().annotations.push({ type: 'rajada da cena', description: `eventos=${s.events.length} animate()=${record.calls} máx. total=${record.maxAll} máx. por elemento=${record.maxPerElement} máx. na .fx=${record.maxFx}` });
    expect(record.calls, 'nenhuma animação nova depois da rajada').toBe(calls);
    // Num mesmo elemento: no máximo as do CSS (1) e as do fx.js de um token ou retrato (movimento, tamanho, passo e impacto).
    expect(record.maxPerElement).toBeLessThanOrEqual(5);
    // Camada .fx: o pico (registrado acima) soma o que pode coexistir de verdade
    // (cartão final com 18 partículas, envelopes, fantasmas e bugs derrotados);
    // o que importa é que tudo sai no fim.
    expect(await page.locator('#scene-fx > *').count()).toBe(0);
    const finite = await page.evaluate(() => document.getAnimations().filter((a) => /** @type {any} */ (a.effect)?.getTiming().iterations !== Infinity).length);
    expect(finite).toBe(0);
    // As contínuas que sobram são as dos elementos que existem (nenhuma de elemento solto).
    expect(await page.evaluate(() => document.getAnimations().every((a) => /** @type {any} */ (a.effect)?.target?.isConnected))).toBe(true);
  });

  for (const width of [360, 820]) {
    test(`${width} px: salas, bugs, selo e cartão final cabem, sem rolagem horizontal`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 360, hasTouch: width === 360 });
      const page = await context.newPage();
      await instrument(page);
      try {
        const { first, parts } = liveScenario(`largura-${width}`);
        await page.goto(`${srv().base}/#escritorio`);
        await inject(srv(), first);
        for (const part of parts.slice(0, 4)) await inject(srv(), part);
        await expect(page.locator('.room[data-room="test"] .bug')).toHaveCount(4);
        await expect(page.locator('.token[data-key="main"] .tok-alert')).toHaveCount(1);
        const check = () => page.evaluate((viewport) => {
          const problems = [];
          if (document.documentElement.scrollWidth > document.documentElement.clientWidth) problems.push('rolagem horizontal');
          const sceneBox = document.getElementById('scene')?.getBoundingClientRect();
          if (!sceneBox) return ['sem cena'];
          for (const room of document.querySelectorAll('.room')) {
            const r = room.getBoundingClientRect();
            if (r.left < sceneBox.left - 1 || r.right > sceneBox.right + 1) problems.push(`sala ${room.getAttribute('data-room')} fora da cena`);
            for (const item of room.querySelectorAll('.bug, .bug-more, .tok-alert')) {
              const b = item.getBoundingClientRect();
              if (b.left < r.left - 10 || b.right > r.right + 10 || b.top < r.top - 10 || b.bottom > r.bottom + 10) problems.push(`${item.className} fora da sala ${room.getAttribute('data-room')}`);
            }
          }
          const card = document.querySelector('#scene-fx .finale-card')?.getBoundingClientRect();
          if (card && (card.left < 0 || card.right > viewport)) problems.push('cartão final fora da tela');
          return problems;
        }, width);
        expect(await check()).toEqual([]);
        await inject(srv(), parts[4]);
        await inject(srv(), parts[5]);
        // Cartão final pelo registro de quando apareceu (sai sozinho em 3,7 s).
        await expect.poll(async () => (await scene(page)).finales.length).toBe(1);
        const [shown] = (await scene(page)).finales;
        expect(shown.overlay.left, 'camada do cartão final começa dentro da tela').toBeGreaterThanOrEqual(0);
        expect(shown.overlay.right, 'camada do cartão final termina dentro da tela').toBeLessThanOrEqual(shown.viewport + 1);
        expect(shown.cardWidth, 'cartão final cabe na camada').toBeLessThanOrEqual(shown.overlay.right - shown.overlay.left + 1);
        expect(await check()).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: contraste do balão e do selo de aprovação, do "+N" dos bugs, da sala em alarme e do cartão final`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await instrument(page);
      const { first, parts } = liveScenario(`contraste-cena-${themeId}`);
      await page.goto(`${srv().base}/#${themeId}`);
      await inject(srv(), first);
      for (const part of parts.slice(0, 4)) await inject(srv(), part);
      await expect(page.locator('.token[data-key="main"] .tok-alert')).toHaveCount(1);
      const results = await page.evaluate(measure, ['.token.waiting .bubble-text', '.token.waiting .tok-alert', '.room[data-room="test"] .bug-more', '.room.alarm .room-label']);
      await inject(srv(), parts[4]);
      await inject(srv(), parts[5]);
      // Contraste do cartão final medido na página no instante em que ele apareceu.
      await expect.poll(async () => (await scene(page)).finales.length).toBe(1);
      results.push(...(await scene(page)).finales[0].contrast);
      console.log(`[contraste da cena ${themeId}] ${JSON.stringify(results)}`);
      expect(new Set(results.map((/** @type {any} */ r) => r.selector)).size).toBe(6);
      for (const r of results) {
        // O título do cartão final é texto grande (24 px, negrito): 3:1.
        const min = r.selector.endsWith('h3') ? 3 : 4.5;
        expect(r.ratio, `${r.selector} (${r.text})`).toBeGreaterThanOrEqual(min);
      }
    });
  }
});
