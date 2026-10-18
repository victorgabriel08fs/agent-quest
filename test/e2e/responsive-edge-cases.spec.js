// @ts-check
// Responsividade ponta a ponta, casos que o teste de layout não cobre (tester;
// T10b): o painel sem sessões e uma sessão com textos muito longos (rótulo,
// projeto, alvos e descrições), nos dois temas, em 360, 820 e 1280 px. Nada
// pode criar rolagem horizontal, e em 1280 px (três colunas) a barra superior
// fixa fica em até duas linhas.

import { expect, test } from '@playwright/test';
import { loadSnapshot, mockLiveServer, watchPage } from './support.js';

const LONG = 'muito-comprido-'.repeat(20);

/** Sessão com textos longos em todos os campos de texto exibidos. */
function longSession() {
  const session = structuredClone(loadSnapshot('ticket-completo').sessions[0]);
  session.label = `Rótulo ${LONG}`;
  session.project = { ...session.project, name: `projeto-${LONG}`, dir: `D:\\${LONG}\\${LONG}` };
  session.quest.title = `Título ${LONG}`;
  for (const agent of session.agents) {
    if (agent.key !== 'main') agent.label = `descrição ${LONG}`;
    if (agent.activity) agent.activity.target = `src/${LONG}/${LONG}.js`;
  }
  for (const event of session.feed) {
    for (const field of ['target', 'description', 'title', 'error', 'projectName']) {
      if (typeof event.data?.[field] === 'string') event.data[field] = `${event.data[field]}-${LONG}`;
    }
  }
  return session;
}

/**
 * Elementos que passam da largura da janela e ficam visíveis (deveriam ser
 * nenhum). Texto cortado com reticências por um ancestral com overflow
 * escondido, dentro da janela, não conta: não aparece nem cria rolagem.
 * @param {import('@playwright/test').Page} page
 */
async function overflowOf(page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 0.5;
    /** @param {Element} el */
    const clipped = (el) => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).overflowX !== 'visible' && node.getBoundingClientRect().right <= limit) return true;
      }
      return false;
    };
    return {
      scroll: document.documentElement.scrollWidth,
      inner: document.documentElement.clientWidth,
      wide: [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > limit && !clipped(el))
        .map((el) => `${el.parentElement?.className} > ${el.tagName}.${el.className}`)
        .slice(0, 5),
    };
  });
}

for (const theme of ['escritorio', 'guilda']) {
  for (const width of [360, 820, 1280]) {
    test.describe(`${theme}, ${width} px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
      });

      test('sem sessões: os comandos de ligar a captura cabem, sem rolagem horizontal', async ({ page, baseURL }) => {
        const watch = await watchPage(page, String(baseURL));
        await page.route('**/events', (route) => route.fulfill({ status: 404, body: '' }));
        await page.goto(`/#${theme}`);
        await expect(page.locator('.onboarding .cmd')).toHaveCount(3);
        const overflow = await overflowOf(page);
        expect(overflow.wide).toEqual([]);
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
        for (const cmd of await page.locator('.onboarding .cmd').all()) {
          const fits = await cmd.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
          expect(fits).toBe(true);
        }
        expect(watch.problems.external).toEqual([]);
        expect(await watch.violations()).toEqual([]);
      });

      test('textos muito longos: sem rolagem horizontal (em 1280 px, barra superior em até duas linhas)', async ({ page, baseURL }) => {
        const watch = await watchPage(page, String(baseURL));
        await mockLiveServer(page, [longSession()]);
        await page.goto(`/#${theme}`);
        await expect(page.locator('#feed .entry').first()).toBeVisible();
        const overflow = await overflowOf(page);
        expect(overflow.wide).toEqual([]);
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
        if (width >= 1280) {
          // Duas linhas de controles de 32 px (indicadores e ações), com folgas e bordas.
          const height = await page.locator('.topbar').evaluate((el) => el.getBoundingClientRect().height);
          expect(height).toBeLessThanOrEqual(130);
        }
        expect(watch.problems.errors).toEqual([]);
        expect(await watch.violations()).toEqual([]);
      });

      test('cena: as seis salas cabem dentro da área da cena', async ({ page }) => {
        await mockLiveServer(page, [loadSnapshot('primeira-luz').sessions[0]]);
        await page.goto(`/#${theme}`);
        await expect(page.locator('.rooms .token').first()).toBeVisible();
        const outside = await page.evaluate(() => {
          const sceneElement = document.querySelector('#scene');
          if (!sceneElement) return ['#scene ausente'];
          const scene = sceneElement.getBoundingClientRect();
          return [...document.querySelectorAll('.room')].filter((room) => {
            const r = room.getBoundingClientRect();
            return r.left < scene.left - 0.5 || r.right > scene.right + 0.5 || r.top < scene.top - 0.5 || r.bottom > scene.bottom + 0.5 || r.width < 40 || r.height < 40;
          }).map((room) => room.getAttribute('data-room'));
        });
        expect(outside).toEqual([]);
      });
    });
  }
}
