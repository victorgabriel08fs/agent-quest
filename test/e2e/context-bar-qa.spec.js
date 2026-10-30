// @ts-check
// T16 (tester): barra de contexto com valores fora do contrato da seção 9 do
// modelo de eventos, vindos pelo /events simulado. O painel não pode quebrar,
// mostrar zero no lugar de "sem leitura" (ADR 0008), vazar texto nem violar a
// CSP. pct fora de 0..100 é limitado; forma inválida faz a barra sumir.

import { expect, test } from '@playwright/test';
import { loadSnapshot, mockLiveServer, watchPage } from './support.js';

const MAIN = 'main';
const TESTER = 'a9a4b5c6d7e8f9a03';
const DEV = 'a8a3b4c5d6e7f8a92';
const DOC = 'a7a2b3c4d5e6f7a81';

/** @param {import('@playwright/test').Page} page @param {string} key */
const inst = (page, key) => page.locator(`#party li.inst[data-key="${key}"]`);

/** ticket-completo com `context` nos agentes indicados (o resto fica null). */
function sessionWith(/** @type {Record<string, any>} */ contexts) {
  const session = structuredClone(loadSnapshot('ticket-completo').sessions[0]);
  for (const agent of session.agents) agent.context = Object.hasOwn(contexts, agent.key) ? contexts[agent.key] : null;
  return session;
}

test.describe('T16 (QA): contexto fora do contrato', () => {
  // Primeira leva da suíte, com a máquina carregada: o corpo terminou em 18 s,
  // mas o fechamento do contexto passou dos 30 s padrão. Mesmo prazo dos
  // outros arquivos pesados.
  test.describe.configure({ timeout: 90_000 });

  test('pct negativo e acima de 100 são limitados; forma inválida some; tokens enormes não quebram o layout', async ({ page, baseURL }) => {
    const watch = await watchPage(page, /** @type {string} */ (baseURL));
    const dialogs = /** @type {string[]} */ ([]);
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.setViewportSize({ width: 360, height: 800 });
    await mockLiveServer(page, [sessionWith({
      [MAIN]: { pct: -40, usedTokens: 10, windowTokens: 200_000, at: 1 },
      [TESTER]: { pct: 250, usedTokens: Number.MAX_SAFE_INTEGER, windowTokens: 2e15, at: 1 },
      // String, booleano, janela zero: a barra some (não vira 0%).
      [DEV]: { pct: '30', usedTokens: '<img src=x onerror=alert(1)>', windowTokens: 200_000, at: 1 },
      [DOC]: { pct: true, usedTokens: 1, windowTokens: 0, at: '<script>' },
    })]);
    await page.goto('/#escritorio');
    await expect(page.locator('#party .member').first()).toBeVisible();

    await expect(page.locator('#party .mbar.mana')).toHaveCount(2);
    await expect(inst(page, MAIN).locator('.mbar.mana i')).toHaveAttribute('data-fill', '10');
    await expect(inst(page, MAIN).locator('.mb-context')).toHaveAttribute('title', /^Foco ≈ 100% livre · .*\(0%\) · fonte: /);
    await expect(inst(page, TESTER).locator('.mbar.mana i')).toHaveAttribute('data-fill', '0');
    await expect(inst(page, TESTER).locator('.mb-context')).toHaveAttribute('title', /^Foco ≈ 0% livre · .*\(100%\) · fonte: /);
    await expect(inst(page, DEV).locator('.mbar.mana')).toHaveCount(0);
    await expect(inst(page, DOC).locator('.mbar.mana')).toHaveCount(0);
    await expect(inst(page, DEV).locator('.mbar.hp')).toHaveCount(1);
    await expect(page.locator('#party img, #party script')).toHaveCount(0);

    // Barra cheia não passa da trilha; a vazia tem largura zero.
    const widths = await page.evaluate(() => [...document.querySelectorAll('#party .mbar.mana')].map((bar) => ({
      bar: bar.getBoundingClientRect().width,
      fill: /** @type {HTMLElement} */ (bar.querySelector('i')).getBoundingClientRect().width,
    })));
    expect(widths.every((w) => w.fill <= w.bar + 0.5)).toBe(true);
    expect(widths.some((w) => w.fill === 0)).toBe(true);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(dialogs).toEqual([]);
    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.csp).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('teclado: a instância com barra é focável com foco visível, e o nome acessível traz "≈" e a fonte', async ({ page }) => {
    await mockLiveServer(page, [sessionWith({ [MAIN]: { pct: 42, usedTokens: 420_000, windowTokens: 1_000_000, at: 1 } })]);
    await page.goto('/#guilda');
    const bar = inst(page, MAIN).getByRole('img', { name: /^Mana ≈ 58% livre · 420 mil de 1 milhão de tokens usados \(42%\) · fonte: uso da última resposta no transcript do agente$/ });
    await expect(bar).toBeVisible();
    // A instância é um botão focável (filtro), com foco visível.
    const pick = inst(page, MAIN).locator('button.inst-pick');
    await pick.focus();
    await expect(pick).toBeFocused();
    expect(await pick.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  });
});
