// @ts-check
// Fumaça (T10b): o painel abre no Edge, servido pelo servidor real, sem
// violação de CSP, sem erro de script e sem requisição para outra origem
// (ADR 0006; CLAUDE.md, "100% local").

import { expect, test } from '@playwright/test';
import { loadSnapshot, mockLiveServer, watchPage } from './support.js';

test.describe('fumaça do painel', () => {
  test('roda no Microsoft Edge instalado', async ({ page, browserName }) => {
    expect(browserName).toBe('chromium');
    expect(await page.evaluate(() => navigator.userAgent)).toContain('Edg/');
  });

  test('sem sessões: abre, explica como ligar a captura e troca de tema', async ({ page, baseURL }) => {
    const watch = await watchPage(page, String(baseURL));
    await page.goto('/');
    await expect(page.locator('#theme-toggle button')).toHaveCount(2);
    await expect(page.locator('.onboarding .q-title')).toHaveText('Nenhuma sessão por aqui ainda');
    await expect(page.locator('.onboarding')).toContainText('npm run capture:deploy');
    await expect(page.locator('.onboarding .health')).toContainText(/evento recebido/);
    await expect(page.locator('.rooms .room')).toHaveCount(6);

    await page.keyboard.press('2');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'guilda');
    await expect(page.locator('.onboarding .q-title')).toHaveText('O salão da guilda está vazio');
    await expect(page).toHaveURL(/#guilda$/);

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.csp).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('com sessões ao vivo: equipe, ticket, cena e feed, sem CSP violada', async ({ page, baseURL }) => {
    const watch = await watchPage(page, String(baseURL));
    await mockLiveServer(page, [loadSnapshot('ticket-completo').sessions[0], loadSnapshot('primeira-luz').sessions[0]]);
    await page.goto('/#escritorio');
    await expect(page.locator('#session-select option')).toHaveCount(2);
    await expect(page.locator('.q-title')).toHaveText('Implementar a ingestão');
    await expect(page.locator('.stepper .step')).toHaveCount(4);
    await expect(page.locator('#party .member')).toHaveCount(5);
    await expect(page.locator('#feed .entry')).toHaveCount(22);
    await expect(page.locator('.rooms .token')).toHaveCount(4);

    await page.locator('#session-select').selectOption({ label: 'Sessão 5f1c0a · agents-quest' });
    await expect(page.locator('#party .member')).toHaveCount(6);
    await expect(page.locator('#feed .entry')).toHaveCount(21);
    await expect(page.locator('.room[data-room="dev"] .token')).toHaveCount(2);

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.csp).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });
});
