// @ts-check
// Troca de tema ponta a ponta (tester; T10a e T10b): botões, teclas 1, 2, T e t,
// hash da URL e localStorage, como no mockup. Trocar de tema muda o vocabulário
// de todas as regiões e não toca no estado nem na conexão: a mesma sessão segue
// escolhida, as contagens não mudam e o /events não é reaberto (ADR 0009).

import { expect, test } from '@playwright/test';
import { loadSnapshot, mockLiveServer, watchPage } from './support.js';

const WORDS = {
  escritorio: { party: 'Equipe', feed: 'Atividade', quest: 'Ticket', room: 'Gerência', button: 'Escritório' },
  guilda: { party: 'Party', feed: 'Crônica', quest: 'Quest', room: 'Salão da Guilda', button: 'Guilda' },
};

/**
 * Painel com duas sessões ao vivo (simuladas) e contadores de quantas vezes
 * o navegador pediu /events e /api/state.
 * @param {import('@playwright/test').Page} page
 */
async function openLive(page, hash = '#escritorio') {
  await mockLiveServer(page, [loadSnapshot('ticket-completo').sessions[0], loadSnapshot('primeira-luz').sessions[0]]);
  const hits = { events: 0, state: 0 };
  // Registradas depois do simulador, rodam antes dele e repassam a requisição.
  await page.route('**/events', (route) => { hits.events++; return route.fallback(); });
  await page.route('**/api/state', (route) => { hits.state++; return route.fallback(); });
  await page.goto(`/${hash}`);
  await expect(page.locator('#feed .entry').first()).toBeVisible();
  return hits;
}

/**
 * Estado visível que não pode mudar com o tema.
 * @param {import('@playwright/test').Page} page
 */
async function stateOf(page) {
  return {
    session: await page.locator('#session-select').inputValue(),
    members: await page.locator('#party .member').count(),
    entries: await page.locator('#feed .entry').count(),
    tokens: await page.locator('.rooms .token').count(),
    steps: await page.locator('.stepper .step').count(),
    conn: (await page.locator('#conn').textContent())?.trim(),
  };
}

/** @param {import('@playwright/test').Page} page @param {'escritorio'|'guilda'} id */
async function expectTheme(page, id) {
  const words = WORDS[id];
  await expect(page.locator('html')).toHaveAttribute('data-theme', id);
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
  await expect(page.locator(`#theme-toggle button[data-theme="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#theme-toggle button[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('#party h2')).toHaveText(words.party);
  await expect(page.locator('#feed h2')).toHaveText(words.feed);
  await expect(page.locator('.q-kicker')).toContainText(words.quest);
  await expect(page.locator('.room[data-room="hq"] .room-label')).toContainText(words.room);
  await expect(page).toHaveTitle(`Agent Quest · ${words.button}`);
  expect(await page.evaluate(() => localStorage.getItem('agent-quest-theme'))).toBe(id);
}

test.describe('troca de tema', () => {
  test('botões, teclas 1, 2, T e t: vocabulário muda em todas as regiões e o estado não', async ({ page, baseURL }) => {
    const watch = await watchPage(page, String(baseURL));
    const hits = await openLive(page);
    // O simulador do /events (support.js) devolve um corpo que termina, então o
    // selo fica em "reconectando" depois do snapshot; o que importa é não mudar.
    const before = await stateOf(page);
    const eventsBefore = hits.events;

    await page.locator('#theme-toggle button[data-theme="guilda"]').click();
    await expectTheme(page, 'guilda');
    await page.locator('#theme-toggle button[data-theme="escritorio"]').click();
    await expectTheme(page, 'escritorio');
    await page.locator('body').click({ position: { x: 5, y: 880 } });
    await page.keyboard.press('2');
    await expectTheme(page, 'guilda');
    await page.keyboard.press('1');
    await expectTheme(page, 'escritorio');
    await page.keyboard.press('Shift+T');
    await expectTheme(page, 'guilda');
    await page.keyboard.press('t');
    await expectTheme(page, 'escritorio');

    expect(await stateOf(page)).toEqual(before);
    expect(hits.events).toBe(eventsBefore);
    expect(hits.state).toBe(0);
    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('a sessão escolhida no seletor continua escolhida depois de trocar de tema', async ({ page }) => {
    const hits = await openLive(page);
    await page.locator('#session-select').selectOption({ label: 'Sessão 5f1c0a · agents-quest · ativa' });
    await expect(page.locator('.room[data-room="dev"] .token')).toHaveCount(2);
    const before = await stateOf(page);
    const eventsBefore = hits.events;
    await page.locator('#theme-toggle button[data-theme="guilda"]').click();
    await expectTheme(page, 'guilda');
    expect(await stateOf(page)).toEqual(before);
    expect(hits.events).toBe(eventsBefore);
  });

  test('com o seletor de sessão em foco, as teclas de tema não trocam o tema', async ({ page }) => {
    await openLive(page);
    await page.locator('#session-select').focus();
    await page.keyboard.press('t');
    await page.keyboard.press('2');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'escritorio');
  });

  test('Ctrl, Alt e teclas sem tema não trocam o tema', async ({ page }) => {
    await openLive(page);
    for (const key of ['Control+2', 'Alt+2', '3', '0', 'x']) await page.keyboard.press(key);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'escritorio');
  });

  test('hash da URL troca o tema; hash desconhecido não muda nada', async ({ page }) => {
    await openLive(page);
    await page.evaluate(() => { location.hash = '#guilda'; });
    await expectTheme(page, 'guilda');
    await page.evaluate(() => { location.hash = '#nao-existe'; });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'guilda');
  });

  test('localStorage guarda a escolha; o hash da URL tem prioridade; valor adulterado cai no padrão', async ({ page }) => {
    await openLive(page);
    await page.keyboard.press('2');
    await expectTheme(page, 'guilda');
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'guilda');
    await page.goto('/#escritorio');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'escritorio');
    await page.evaluate(() => localStorage.setItem('agent-quest-theme', '<img src=x onerror=alert(1)>'));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'escritorio');
  });

  test('com movimento reduzido, a troca é imediata e funciona igual', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openLive(page);
    await page.locator('#theme-toggle button[data-theme="guilda"]').click();
    await expectTheme(page, 'guilda');
  });
});
