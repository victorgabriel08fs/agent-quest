// @ts-check
// Desempenho do feed (T11b) com 200 linhas e uma rajada de updates, no Edge,
// com o servidor real. Pelo complemento "testes de tempo estáveis" do ADR 0010,
// nada aqui mede tempo absoluto: o teste conta redesenhos, quadros e nós
// criados ou removidos.
// - Linhas que continuam na lista são os mesmos nós (marcados antes da rajada).
// - Cada linha nova é criada uma vez; as que passam do limite de 200 saem uma vez.
// - A equipe é redesenhada no máximo uma vez por quadro de animação, e menos
//   vezes que o número de updates (redesenho agrupado).
// - Um clique num chip no meio da rajada vale.
// - Com 200 linhas, mudar o filtro não cria nem remove nó; trocar de tema troca
//   cada linha uma vez.

import { expect, test } from '@playwright/test';
import { injectScenario } from '../../scripts/inject-fixture.mjs';
import { createScenario, expectedIds, inject, recordFeed, recorded, resetRecord, settledState, startLiveServer, visibleIds, waitFor, waitPanelFeed } from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */

const FILE = (/** @type {string} */ name) => `C:\\Users\\fulano\\Projetos\\agents-quest\\${name}`;

test.describe('feed com 200 linhas e rajada de updates (tester)', () => {
  // Prazo maior que o padrão de 30 s: cada teste sobe o próprio servidor e tem muitos passos, e o E2E roda com vários workers.
  test.describe.configure({ timeout: 90_000 });
  /** @type {LiveServer|null} */
  let server = null;

  test.beforeEach(async () => {
    server = await startLiveServer();
  });

  test.afterEach(async () => {
    await server?.dispose();
    server = null;
  });

  test('rajada sobre 200 linhas: nada é recriado, a equipe redesenha por quadro e o clique no meio vale', async ({ page }) => {
    test.setTimeout(120_000);
    if (!server) throw new Error('sem servidor');
    const watch = await watchPage(page, server.base);
    const s = createScenario({ label: 'rajada' });
    const guest = s.agent('g', 'Explore');
    s.start().prompt('Ler muitos arquivos');
    s.delegate(guest, 'Ler a outra metade');
    for (let i = 0; i < 110; i++) {
      s.tool('Read', { file_path: FILE(`docs\\a-${i}.md`) });
      s.tool('Read', { file_path: FILE(`docs\\b-${i}.md`) }, { agent: guest });
    }
    const cut = s.mark();
    for (let i = 0; i < 40; i++) {
      s.tool('Grep', { pattern: `termo-${i}`, path: 'server' });
      s.tool('Glob', { pattern: `web/**/${i}.js` }, { agent: guest });
    }

    await page.goto(`${server.base}/#escritorio`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');
    let state = await inject(server, s.part(0, cut));
    let session = state.sessions.find((x) => x.id === s.sessionId);
    expect(session.feed.length).toBe(200);
    await waitPanelFeed(page, session);
    await expect(page.locator('#feed-entries li.entry')).toHaveCount(200);

    // Marcas e contadores antes da rajada.
    await recordFeed(page);
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      for (const li of document.querySelectorAll('#feed-entries li.entry')) /** @type {any} */ (li).__kept = true;
      w.__frames = 0;
      const loop = () => {
        w.__frames++;
        w.__raf = requestAnimationFrame(loop);
      };
      w.__raf = requestAnimationFrame(loop);
    });
    const seqBefore = state.seq;

    // Rajada sem esperar os intervalos; no meio, um clique no chip do convidado.
    const burst = injectScenario(/** @type {any} */ (s.part(cut)), { port: server.port, token: server.token, fast: true });
    await waitFor(async () => (await recorded(page)).added.length >= 10, 'a rajada começar a chegar no painel');
    await page.locator('#feed-filters [data-filter="role:aux"]').click();
    const result = await burst;
    expect(result.refused).toEqual([]);
    state = await settledState(server.port);
    session = state.sessions.find((x) => x.id === s.sessionId);
    await waitPanelFeed(page, session);
    const frames = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      cancelAnimationFrame(w.__raf);
      return w.__frames;
    });
    const updates = state.seq - seqBefore;
    const { added, removed, partyRedraws } = await recorded(page);

    // O clique no meio da rajada valeu, e o feed é o do servidor com o filtro.
    await expect(page.locator('#feed-filters [data-filter="role:aux"]')).toHaveAttribute('aria-pressed', 'true');
    const auxKeys = new Set(session.agents.filter((/** @type {any} */ a) => a.role === 'aux').map((/** @type {any} */ a) => a.key));
    expect(await visibleIds(page)).toEqual(expectedIds(session, (e) => auxKeys.has(e.agentKey) || e.data?.toRole === 'aux'));
    await expect(page.locator('#feed-entries li.entry')).toHaveCount(200);

    // Nós: 80 linhas novas, cada uma criada uma vez; 80 antigas saem; 120 continuam.
    const newLines = 80;
    expect(added.length).toBe(newLines);
    expect(new Set(added.map((/** @type {any} */ a) => a.id)).size).toBe(newLines);
    expect(removed.length).toBe(newLines);
    const kept = await page.locator('#feed-entries li.entry').evaluateAll((nodes) => nodes.filter((n) => /** @type {any} */ (n).__kept).length);
    expect(kept).toBe(200 - newLines);

    // Redesenho agrupado: a equipe redesenha no máximo uma vez por quadro (mais
    // o redesenho síncrono do clique) e bem menos vezes que os updates.
    console.log(`[rajada] updates=${updates} quadros=${frames} redesenhos da equipe=${partyRedraws} linhas criadas=${added.length} removidas=${removed.length}`);
    test.info().annotations.push({ type: 'rajada', description: `updates=${updates} quadros=${frames} redesenhos da equipe=${partyRedraws}` });
    expect(updates).toBeGreaterThanOrEqual(160);
    expect(frames).toBeGreaterThan(0);
    expect(partyRedraws).toBeLessThanOrEqual(frames + 2);
    expect(partyRedraws).toBeLessThan(updates);

    // Com 200 linhas: filtro só liga e desliga hidden; tema troca cada linha uma vez.
    await resetRecord(page);
    await page.locator('#feed-filters [data-filter="role:orq"]').click();
    await page.locator('#feed-filters [data-filter=""]').click();
    await page.locator('#feed-filters [data-filter="role:aux"]').click();
    let rec = await recorded(page);
    expect(rec.added).toEqual([]);
    expect(rec.removed).toEqual([]);
    expect(rec.animations.filter((/** @type {string} */ n) => n === 'slidein')).toEqual([]);
    await resetRecord(page);
    await page.keyboard.press('2');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'guilda');
    await expect(page.locator('#feed-title')).toHaveText('Crônica');
    rec = await recorded(page);
    expect(rec.added.length).toBe(200);
    expect(rec.removed.length).toBe(200);
    expect(rec.animations.filter((/** @type {string} */ n) => n === 'slidein')).toEqual([]);

    expect(watch.problems.errors).toEqual([]);
    expect(await watch.violations()).toEqual([]);
  });
});
