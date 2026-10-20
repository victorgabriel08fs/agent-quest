// @ts-check
// Retomada real por Last-Event-ID (T9b e T11b; modelo de eventos, seção 9,
// "Retomada"), no Edge, com o servidor real.
//
// O painel abre por um proxy HTTP local (test/e2e/qa-live.js) que deixa cortar
// só a conexão SSE, sem parar o servidor e sem recarregar a página. Enquanto a
// conexão está cortada, chegam eventos novos. O EventSource reconecta sozinho,
// mandando o Last-Event-ID, e o servidor reenvia só o que faltou.
//
// Confere:
// - o selo vai para "reconectando" e volta para "ao vivo";
// - a reconexão é do mesmo EventSource (manda Last-Event-ID = runId:último seq);
// - a resposta tem o hello e só os updates que faltaram, em sequência, sem
//   snapshot; o painel não busca /api/state (sem lacuna) e não recarrega;
// - o feed termina igual ao do servidor, com o filtro ligado respeitado e só as
//   linhas novas visíveis animadas; as linhas antigas não são recriadas;
// - a falta acima do buffer (mais de 1 000 mensagens) volta por snapshot, também
//   sem recarregar.

import { expect, test } from '@playwright/test';
import {
  createScenario, expectedIds, inject, parseSse, recordFeed, recorded, startLiveServer, startSseProxy, visibleIds, waitFor, waitPanelFeed,
} from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */

/** Cenário: o orquestrador trabalha, chama um tester e um convidado; parte 2 continua. */
function resumeScenario() {
  const s = createScenario({ label: 'retomada' });
  const tester = s.agent('t1', 'tester');
  const guest = s.agent('g1', 'Explore');
  s.start().prompt('Revisar a ingestão');
  s.tool('Read', { file_path: 'C:\\Users\\fulano\\Projetos\\agents-quest\\README.md' });
  const call = s.delegate(tester, 'Testar a ingestão');
  s.tool('Bash', { command: 'npm test -- test/unit/shared', description: 'Rodar os testes' }, { agent: tester });
  const cut = s.mark();
  // Parte 2, enquanto o SSE está cortado.
  s.tool('Grep', { pattern: 'token', path: 'server' }, { agent: tester });
  s.tool('Bash', { command: 'node -e "process.exit(2)"' }, { agent: tester, error: 'Exit code 2' });
  const guestCall = s.delegate(guest, 'Procurar exemplos');
  s.tool('Glob', { pattern: '**/*.md' }, { agent: guest });
  s.finish(guest, guestCall);
  s.tool('Edit', { file_path: 'C:\\Users\\fulano\\Projetos\\agents-quest\\server\\x.js', old_string: 'a', new_string: 'b' }, { agent: tester });
  s.finish(tester, call);
  s.tool('Read', { file_path: 'C:\\Users\\fulano\\Projetos\\agents-quest\\CLAUDE.md' });
  return { s, first: s.part(0, cut), second: s.part(cut), testerKey: tester.id };
}

test.describe('retomada por Last-Event-ID com o servidor real', () => {
  // Prazo maior que o padrão de 30 s: cada teste sobe o próprio servidor e tem muitos passos, e o E2E roda com vários workers.
  test.describe.configure({ timeout: 90_000 });
  /** @type {LiveServer|null} */
  let server = null;
  /** @type {Awaited<ReturnType<typeof startSseProxy>>|null} */
  let proxy = null;

  test.beforeEach(async () => {
    server = await startLiveServer();
    proxy = await startSseProxy(server.port);
  });

  test.afterEach(async () => {
    await proxy?.close();
    await server?.dispose();
    proxy = null;
    server = null;
  });

  for (const themeId of ['escritorio', 'guilda']) {
    test(`${themeId}: só a conexão SSE cai; a reconexão recebe só o que faltou, sem snapshot, sem /api/state e sem recarregar`, async ({ page }) => {
      if (!server || !proxy) throw new Error('sem servidor');
      const watch = await watchPage(page, proxy.base);
      const { s, first, second } = resumeScenario();
      await page.goto(`${proxy.base}/#${themeId}`);
      await expect(page.locator('#conn')).toHaveText('ao vivo');

      // Parte 1 ao vivo.
      let state = await inject(server, first);
      let session = state.sessions.find((x) => x.id === s.sessionId);
      await waitPanelFeed(page, session);
      await expect(page.locator('#session-select')).toHaveValue(s.sessionId);

      // Filtro ligado no papel do tester (chip), antes do corte.
      await page.locator('#feed-filters [data-filter="role:tes"]').click();
      await expect(page.locator('#feed-filters [data-filter="role:tes"]')).toHaveAttribute('aria-pressed', 'true');

      // Marcas: mesmo documento e mesmos nós de linha.
      await page.evaluate(() => {
        /** @type {any} */ (window).__sameDocument = true;
        for (const li of document.querySelectorAll('#feed-entries li.entry')) /** @type {any} */ (li).__kept = true;
      });
      const keptBefore = await page.locator('#feed-entries li.entry').count();
      await recordFeed(page);

      // Conexão 1: hello, snapshot e os updates da parte 1.
      const eventsRequests = () => proxy?.requests.filter((r) => r.url.startsWith('/events')) ?? [];
      expect(eventsRequests()).toHaveLength(1);
      const firstStream = parseSse(eventsRequests()[0].body);
      const hello1 = firstStream.find((m) => m.event === 'hello');
      expect(hello1).toBeTruthy();
      const runId = hello1?.data.runId;
      await waitFor(() => {
        const last = parseSse(eventsRequests()[0].body).filter((m) => m.id).at(-1);
        return last?.id === `${runId}:${state.seq}`;
      }, 'o painel receber o último update antes do corte');
      const seqBefore = state.seq;

      // Corte só do SSE: o servidor continua no ar.
      proxy.cut();
      await expect(page.locator('#conn')).toHaveText('reconectando');
      state = await inject(server, second);
      expect(state.seq).toBeGreaterThan(seqBefore + 5);
      // O EventSource tenta de novo sozinho (retry: 2000); o proxy segura a tentativa.
      await waitFor(() => (proxy?.heldCount() ?? 0) > 0, 'o EventSource tentar reconectar', 20_000);
      await expect(page.locator('#conn')).toHaveText('reconectando');
      proxy.release();
      await expect(page.locator('#conn')).toHaveText('ao vivo', { timeout: 15_000 });

      session = state.sessions.find((x) => x.id === s.sessionId);
      await waitPanelFeed(page, session);

      // A reconexão mandou o Last-Event-ID do último update aplicado e recebeu
      // o hello e só os updates que faltaram, em sequência, sem snapshot.
      const requests = eventsRequests();
      expect(requests).toHaveLength(2);
      expect(requests[1].lastEventId).toBe(`${runId}:${seqBefore}`);
      const resumed = parseSse(requests[1].body);
      expect(resumed[0].event).toBe('hello');
      expect(resumed[0].data.runId).toBe(runId);
      expect(resumed.map((m) => m.event)).not.toContain('snapshot');
      const seqs = resumed.filter((m) => m.event === 'update' || m.event === 'session-removed').map((m) => m.data.seq);
      expect(seqs).toEqual(Array.from({ length: state.seq - seqBefore }, (_, i) => seqBefore + 1 + i));
      for (const m of resumed.filter((x) => x.event === 'update')) expect(m.id).toBe(`${runId}:${m.data.seq}`);

      // Sem lacuna: o painel nunca buscou /api/state; e não recarregou.
      expect(proxy.requests.filter((r) => r.url.startsWith('/api/state'))).toEqual([]);
      expect(proxy.requests.filter((r) => r.url === '/' || r.url.startsWith('/#'))).toHaveLength(1);
      expect(await page.evaluate(() => /** @type {any} */ (window).__sameDocument)).toBe(true);

      // O feed é o do servidor; o filtro continua; só as linhas do tester aparecem.
      await expect(page.locator('#feed-filters [data-filter="role:tes"]')).toHaveAttribute('aria-pressed', 'true');
      const testerKeys = new Set(session.agents.filter((/** @type {any} */ a) => a.role === 'tes').map((/** @type {any} */ a) => a.key));
      const isTester = (/** @type {any} */ e) => testerKeys.has(e.agentKey) || (e.kind === 'agent.delegated' && e.data?.toRole === 'tes');
      expect(await visibleIds(page)).toEqual(expectedIds(session, isTester));
      await expect(page.locator('#feed-head')).toContainText(`${expectedIds(session, isTester).length} de ${session.feed.length} eventos`);

      // As linhas antigas são os mesmos nós; as novas entram uma vez cada, e só
      // as visíveis animam.
      const keptAfter = await page.locator('#feed-entries li.entry').evaluateAll((nodes) => nodes.filter((n) => /** @type {any} */ (n).__kept).length);
      expect(keptAfter).toBe(keptBefore);
      const { added, removed } = await recorded(page);
      expect(removed).toEqual([]);
      expect(new Set(added.map((/** @type {any} */ a) => a.id)).size).toBe(added.length);
      expect(added.length).toBe(session.feed.length - keptBefore);
      for (const item of added) expect(item.isNew, item.id).toBe(!item.hidden);
      expect(added.some((/** @type {any} */ a) => !a.hidden)).toBe(true);
      expect(added.some((/** @type {any} */ a) => a.hidden)).toBe(true);

      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.csp).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
    });
  }

  test('a falta acima do buffer de retomada (mais de 1 000 mensagens) volta por snapshot, sem recarregar', async ({ page }) => {
    test.setTimeout(120_000);
    if (!server || !proxy) throw new Error('sem servidor');
    const s = createScenario({ label: 'retomada-grande' });
    s.start().prompt('Muitas leituras');
    const cut = s.mark();
    for (let i = 0; i < 560; i++) s.tool('Read', { file_path: `C:\\Users\\fulano\\Projetos\\agents-quest\\docs\\arquivo-${i}.md` });
    await page.goto(`${proxy.base}/#escritorio`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');
    let state = await inject(server, s.part(0, cut));
    await waitPanelFeed(page, state.sessions.find((x) => x.id === s.sessionId));
    await page.evaluate(() => { /** @type {any} */ (window).__sameDocument = true; });

    proxy.cut();
    await expect(page.locator('#conn')).toHaveText('reconectando');
    const seqBefore = state.seq;
    state = await inject(server, s.part(cut));
    expect(state.seq - seqBefore).toBeGreaterThan(1000);
    await waitFor(() => (proxy?.heldCount() ?? 0) > 0, 'o EventSource tentar reconectar', 20_000);
    proxy.release();
    await expect(page.locator('#conn')).toHaveText('ao vivo', { timeout: 15_000 });

    const session = state.sessions.find((x) => x.id === s.sessionId);
    await waitPanelFeed(page, session);
    expect(session.feed.length).toBe(200);
    const requests = proxy.requests.filter((r) => r.url.startsWith('/events'));
    expect(requests).toHaveLength(2);
    expect(requests[1].lastEventId).toMatch(new RegExp(`:${seqBefore}$`));
    const resumed = parseSse(requests[1].body);
    expect(resumed.map((m) => m.event).slice(0, 2)).toEqual(['hello', 'snapshot']);
    expect(await page.evaluate(() => /** @type {any} */ (window).__sameDocument)).toBe(true);
    await expect(page.locator('#feed-entries li.entry')).toHaveCount(200);
  });
});
