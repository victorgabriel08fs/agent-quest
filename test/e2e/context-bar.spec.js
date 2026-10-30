// @ts-check
// T16: barra de contexto (Foco no Escritório, Mana na Guilda) no Edge.
//
// 1. Snapshots escritos à mão (ticket-completo com e sem `context`), pelo
//    /events simulado: a barra aparece só nos agentes com leitura, com o valor
//    e "≈" e a fonte no tooltip e no nome acessível; some com `context` null;
//    troca de nome com o tema; continua no modo discreto; a legenda traz a
//    barra e a fonte; sem rolagem horizontal em 360 px; nada de CSP violada
//    nem requisição para fora.
// 2. Ponta a ponta com o servidor real (porta livre, pasta pessoal temporária,
//    nunca a 47821 nem o diretório real): um transcript sintético dentro de
//    `<home temporária>/.claude/projects` e o cenário injetado pelo injetor do
//    T9b. A barra aparece depois do `tool.finished`, some depois da
//    compactação (marca `compact_boundary` + PostCompact) e volta com a
//    próxima resposta (Stop).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createScenario, inject, startLiveServer, waitPanelFeed } from './qa-live.js';
import { loadSnapshot, mockLiveServer, watchPage } from './support.js';

const MAIN = 'main';
const TESTER = 'a9a4b5c6d7e8f9a03';
const DEV = 'a8a3b4c5d6e7f8a92';
const SOURCE = 'fonte: uso da última resposta no transcript do agente';

/** ticket-completo com `context` nos agentes indicados (o resto fica null). */
function sessionWith(/** @type {Record<string, any>} */ contexts) {
  const session = structuredClone(loadSnapshot('ticket-completo').sessions[0]);
  for (const agent of session.agents) agent.context = contexts[agent.key] ?? null;
  return session;
}

const WITH_CONTEXT = {
  [MAIN]: { pct: 15, usedTokens: 150_000, windowTokens: 1_000_000, at: 1_760_731_200_000 },
  [TESTER]: { pct: 30, usedTokens: 60_000, windowTokens: 200_000, at: 1_760_731_200_000 },
};

/** @param {import('@playwright/test').Page} page @param {string} key */
const inst = (page, key) => page.locator(`#party li.inst[data-key="${key}"]`);

test.describe('T16: barra de contexto com snapshots escritos à mão', () => {
  // Este arquivo cai na primeira leva da suíte, junto com as rajadas do feed e
  // do modo discreto. Com a máquina carregada, o primeiro teste (cerca de 25
  // passos) passou dos 30 s padrão, inclusive o fechamento do contexto, com
  // todas as conferências certas. Mesmo prazo dos outros arquivos pesados.
  test.describe.configure({ timeout: 90_000 });

  test('com contexto: valor, "≈" e fonte; some com null; tema, modo discreto e legenda', async ({ page, baseURL }) => {
    const watch = await watchPage(page, /** @type {string} */ (baseURL));
    await mockLiveServer(page, [sessionWith(WITH_CONTEXT)]);
    await page.goto('/#escritorio');
    await expect(page.locator('#party .member').first()).toBeVisible();

    // Só os agentes com leitura têm a barra.
    await expect(page.locator('#party .mbar.mana')).toHaveCount(2);
    await expect(inst(page, DEV).locator('.mbar.mana')).toHaveCount(0);
    await expect(inst(page, DEV).locator('.mbar.hp')).toHaveCount(1);

    // Valor com "≈" e a fonte: tooltip, nome acessível e rótulo visível do tema.
    const mainText = `Foco ≈ 85% livre · 150 mil de 1 milhão de tokens usados (15%) · ${SOURCE}`;
    await expect(inst(page, MAIN).locator('.mb-context')).toHaveAttribute('title', mainText);
    await expect(inst(page, MAIN).getByRole('img', { name: mainText })).toBeVisible();
    await expect(inst(page, MAIN).locator('.mb-context .mb-l')).toHaveText('Foco');
    await expect(inst(page, TESTER).getByRole('img', { name: `Foco ≈ 70% livre · 60 mil de 200 mil tokens usados (30%) · ${SOURCE}` })).toBeVisible();
    await expect(page.locator('#party .mini-legend')).toContainText('Foco: ≈ contexto que ainda cabe na janela do agente');

    // A barra enche com o que ainda cabe (9 décimos para 85% livre) e usa a cor do tema.
    const fill = await inst(page, MAIN).locator('.mbar.mana i').evaluate((el) => {
      const bar = /** @type {HTMLElement} */ (el.parentElement);
      return { ratio: el.getBoundingClientRect().width / bar.getBoundingClientRect().width, color: getComputedStyle(el).backgroundColor };
    });
    expect(fill.ratio).toBeGreaterThan(0.85);
    expect(fill.ratio).toBeLessThan(0.95);
    expect(fill.color).toBe('rgb(99, 102, 241)');

    // Guilda: Mana, os mesmos números.
    await page.locator('#theme-toggle button[data-theme="guilda"]').click();
    await expect(inst(page, MAIN).locator('.mb-context .mb-l')).toHaveText('Mana');
    await expect(inst(page, MAIN).locator('.mb-context')).toHaveAttribute('title', mainText.replace('Foco', 'Mana'));
    await expect(page.locator('#party .mini-legend')).toContainText('Mana: ≈ contexto que ainda cabe na janela do agente');

    // Modo discreto: a barra continua (só números).
    await page.keyboard.press('d');
    await expect(page.locator('#btn-discreet')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#party .mbar.mana')).toHaveCount(2);
    await expect(inst(page, MAIN).locator('.mb-context')).toHaveAttribute('title', mainText.replace('Foco', 'Mana'));
    await page.keyboard.press('d');

    // Legenda: a barra e a fonte em "De onde vem cada dado", no nome do tema.
    await page.keyboard.press('?');
    const row = page.locator('#legend-body .lg-sources tr', { has: page.locator('th', { hasText: /^Mana$/ }) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('message.usage');
    await expect(row).toContainText('~/.claude/projects');
    await expect(row).toContainText('Aproximado (≈)');
    await page.keyboard.press('Escape');

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.csp).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('sem contexto: nenhuma barra nem linha na mini-legenda', async ({ page }) => {
    await mockLiveServer(page, [sessionWith({})]);
    await page.goto('/#escritorio');
    await expect(page.locator('#party .mbar.hp').first()).toBeVisible();
    await expect(page.locator('#party .mbar.mana')).toHaveCount(0);
    await expect(page.locator('#party .sw.mana')).toHaveCount(0);
    await expect(page.locator('#party')).not.toContainText('Foco');
  });

  test('360 px: sem rolagem horizontal, com as duas barras', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await mockLiveServer(page, [sessionWith(WITH_CONTEXT)]);
    await page.goto('/#guilda');
    await expect(page.locator('#party .mbar.mana')).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await inst(page, MAIN).locator('.mb-context').boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(40);
  });
});

/** Linha de resposta do transcript (formato da seção 6), com o uso indicado. */
const response = (/** @type {string} */ sessionId, /** @type {number} */ cacheRead, /** @type {number} */ n) => JSON.stringify({
  type: 'assistant', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, sessionId, isSidechain: false,
  timestamp: new Date().toISOString(),
  message: {
    id: `msg_01SINTETICO${n}`, type: 'message', role: 'assistant', model: 'claude-opus-4-6',
    content: [{ type: 'text', text: 'RESPOSTA-SINTETICA' }],
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: 50 },
  },
}) + '\n';

/** Marca de compactação do transcript. */
const boundary = (/** @type {string} */ sessionId) => JSON.stringify({
  type: 'system', subtype: 'compact_boundary', uuid: '00000000-0000-4000-8000-0000000000cb', parentUuid: null,
  sessionId, isSidechain: false, timestamp: new Date().toISOString(), content: 'Conversation compacted', isMeta: false,
  compactMetadata: { trigger: 'manual', preTokens: 59_990 },
}) + '\n';

test.describe('T16: barra de contexto ao vivo (servidor real, transcript sintético)', () => {
  test.describe.configure({ timeout: 90_000 });

  test('aparece com a leitura, some na compactação e volta na resposta seguinte', async ({ page }) => {
    const server = await startLiveServer();
    try {
      const watch = await watchPage(page, server.base);
      const dir = path.join(server.home, '.claude', 'projects', 'C--Users-fulano-Projetos-agents-quest');
      mkdirSync(dir, { recursive: true });
      const s = createScenario({ label: 't16-contexto', transcriptDir: dir });
      // 59 990 + 10 = 60 mil tokens de 200 mil (Opus 4.6): 30% usado, 70% livre.
      writeFileSync(s.transcriptPath, response(s.sessionId, 59_990, 1));

      await page.goto(`${server.base}/#escritorio`);
      s.start().prompt('Pedido fictício').tool('Read', { file_path: 'C:\\Users\\fulano\\Projetos\\agents-quest\\README.md' });
      let mark = s.mark();
      const state = await inject(server, s.part(0, mark));
      await waitPanelFeed(page, state.sessions.find((/** @type {any} */ x) => x.id === s.sessionId));

      const bar = inst(page, MAIN).locator('.mb-context');
      await expect(bar).toHaveAttribute('title', `Foco ≈ 70% livre · 60 mil de 200 mil tokens usados (30%) · ${SOURCE}`, { timeout: 15_000 });
      await expect(inst(page, MAIN).locator('.mbar.mana i')).toHaveAttribute('data-fill', '7');

      // Compactação: a marca no transcript e o PreCompact/PostCompact. A barra some.
      appendFileSync(s.transcriptPath, boundary(s.sessionId));
      s.raw('PreCompact', { trigger: 'manual', custom_instructions: '' }).raw('PostCompact', { trigger: 'manual', compact_summary: 'RESUMO-FICTICIO' });
      await inject(server, s.part(mark));
      mark = s.mark();
      await expect(inst(page, MAIN).locator('.mbar.mana')).toHaveCount(0, { timeout: 15_000 });
      await expect(inst(page, MAIN).locator('.mbar.hp')).toHaveCount(1);

      // Resposta seguinte (20 mil tokens: 10%) e Stop: a barra volta.
      appendFileSync(s.transcriptPath, response(s.sessionId, 19_990, 2));
      s.stop();
      await inject(server, s.part(mark));
      await expect(bar).toHaveAttribute('title', `Foco ≈ 90% livre · 20 mil de 200 mil tokens usados (10%) · ${SOURCE}`, { timeout: 15_000 });

      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
    } finally {
      await server.dispose();
    }
  });
});
