// @ts-check
// Responsividade (T10b): três colunas a partir de 1280 px, duas de 820 a
// 1279 px e uma abaixo de 820 px, sem rolagem horizontal; barra superior fixa
// só quando cabe numa ou duas linhas (a partir de 820 px).

import { expect, test } from '@playwright/test';
import { loadSnapshot, mockLiveServer } from './support.js';

/** @param {import('@playwright/test').Page} page @param {string} selector */
async function box(page, selector) {
  const rect = await page.locator(selector).boundingBox();
  if (!rect) throw new Error(`${selector} sem caixa`);
  return rect;
}

/** @param {number} a @param {number} b */
const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

const WIDTHS = [
  { width: 360, columns: 1 },
  { width: 819, columns: 1 },
  { width: 820, columns: 2 },
  { width: 1024, columns: 2 },
  { width: 1279, columns: 2 },
  { width: 1280, columns: 3 },
  { width: 1920, columns: 3 },
];

for (const theme of ['escritorio', 'guilda']) {
  test.describe(`layout (${theme})`, () => {
    for (const { width, columns } of WIDTHS) {
      test(`${width} px: ${columns} ${columns === 1 ? 'coluna' : 'colunas'}, sem rolagem horizontal`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mockLiveServer(page, [loadSnapshot('primeira-luz').sessions[0], loadSnapshot('ticket-completo').sessions[0]]);
        await page.goto(`/#${theme}`);
        await expect(page.locator('#feed .entry').first()).toBeVisible();

        const party = await box(page, '#party');
        const center = await box(page, '.center');
        const feed = await box(page, '#feed');
        if (columns === 3) {
          expect(party.x + party.width).toBeLessThanOrEqual(center.x);
          expect(center.x + center.width).toBeLessThanOrEqual(feed.x);
          expect(near(party.y, center.y) && near(center.y, feed.y)).toBe(true);
        } else if (columns === 2) {
          expect(center.y + center.height).toBeLessThanOrEqual(party.y);
          expect(near(party.y, feed.y)).toBe(true);
          expect(party.x + party.width).toBeLessThanOrEqual(feed.x);
          expect(near(center.x, party.x) && near(center.x + center.width, feed.x + feed.width)).toBe(true);
        } else {
          expect(center.y + center.height).toBeLessThanOrEqual(party.y);
          expect(party.y + party.height).toBeLessThanOrEqual(feed.y);
          expect(near(center.x, party.x) && near(party.x, feed.x) && near(center.width, feed.width)).toBe(true);
        }

        const overflow = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          inner: document.documentElement.clientWidth,
          wide: [...document.querySelectorAll('body *')]
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
            .map((el) => `${el.tagName}.${el.className}`)
            .slice(0, 5),
        }));
        expect(overflow.wide).toEqual([]);
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);

        const position = await page.locator('.topbar').evaluate((el) => getComputedStyle(el).position);
        expect(position).toBe(width < 820 ? 'static' : 'sticky');
        if (width >= 820) {
          // Fixa, a barra tem no máximo duas linhas (cerca de 110 px; com três, passava de 160 px).
          expect((await box(page, '.topbar')).height).toBeLessThanOrEqual(125);
        }
      });
    }
  });
}
