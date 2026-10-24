// @ts-check
// Filtros e animação do feed (T11b) no Edge, com o servidor real e cenários
// fictícios injetados pelo injetor do T9b. Complementa test/e2e/feed-live.spec.js
// (do dev) com os caminhos que o tester cobre:
// - filtros com linhas chegando ao vivo, nos dois temas, conferidos contra o
//   feed do servidor por uma regra escrita aqui (o "agentsOf" do mockup);
// - troca de tema com filtro ligado;
// - instância que vai para o "+N" com o filtro dela ligado;
// - duas sessões ao mesmo tempo;
// - teclado e foco; clique durante um update (mouse e teclado) e o teto de 1,5 s;
// - movimento reduzido; largura de celular.
//
// Cada teste sobe o próprio servidor (porta livre, pasta temporária).

import { expect, test } from '@playwright/test';
import { injectScenario } from '../../scripts/inject-fixture.mjs';
import escritorio from '../../web/js/themes/escritorio.js';
import guilda from '../../web/js/themes/guilda.js';
import {
  OTHER_PROJECT_DIR, createScenario, expectedIds, inject, interleave, recordFeed, recorded, resetRecord, settledState, startLiveServer, visibleIds, waitFor, waitPanelFeed,
} from './qa-live.js';
import { watchPage } from './support.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */

const THEMES = { escritorio, guilda };
const PHASE_OWNER = { design: 'arq', code: 'dev', test: 'tes', docs: 'doc' };
const FILE = (/** @type {string} */ name) => `C:\\Users\\fulano\\Projetos\\agents-quest\\${name}`;

/**
 * Regra do filtro escrita a partir do plano e do mockup (agentsOf), sem usar o
 * código do painel: delegação conta para quem delegou e para o papel chamado;
 * etapa, para o papel dono; sessão e ticket só em "Todos"; o resto, para o
 * agente do evento.
 * @param {any} session
 * @param {string} filter    'role:<papel>' ou 'agent:<chave>'
 */
function oracle(session, filter) {
  const roles = new Map(session.agents.map((/** @type {any} */ a) => [a.key, a.role]));
  const roleOf = (/** @type {string|null} */ key) => (key == null || key === 'main' ? 'orq' : roles.get(key) ?? 'aux');
  return (/** @type {any} */ e) => {
    if (['session.started', 'session.ended', 'quest.started', 'quest.finished'].includes(e.kind)) return false;
    if (filter.startsWith('agent:')) return e.agentKey === filter.slice('agent:'.length);
    const role = filter.slice('role:'.length);
    if (e.kind === 'quest.phase') return /** @type {any} */ (PHASE_OWNER)[e.data?.phase] === role;
    if (e.kind === 'agent.delegated') return roleOf(e.agentKey) === role || e.data?.toRole === role;
    return roleOf(e.agentKey) === role;
  };
}

/**
 * Sessão com o time inteiro: arquiteto, dev e tester em paralelo, documentador
 * depois. Devolve as partes para injetar aos poucos.
 */
function teamScenario(label = 'time') {
  const s = createScenario({ label });
  const arq = s.agent('arq', 'arquiteto');
  const dev = s.agent('dev', 'dev-frontend');
  const tes = s.agent('tes', 'tester');
  const doc = s.agent('doc', 'documentador');
  s.start().prompt('Implementar os filtros do feed');
  s.tool('Read', { file_path: FILE('docs\\plano\\v1.md') });
  const arqCall = s.delegate(arq, 'Desenhar os filtros');
  s.tool('Read', { file_path: FILE('mockups\\painel.js') }, { agent: arq });
  s.tool('Write', { file_path: FILE('docs\\adr\\0011-filtros.md'), content: 'X' }, { agent: arq });
  s.finish(arq, arqCall);
  const devCall = s.delegate(dev, 'Implementar os filtros');
  const one = s.mark();
  s.tool('Edit', { file_path: FILE('web\\js\\views\\feed.js'), old_string: 'a', new_string: 'b' }, { agent: dev });
  const tesCall = s.delegate(tes, 'Testar os filtros');
  s.tool('Bash', { command: 'npm run test:e2e', description: 'Rodar o E2E' }, { agent: tes });
  s.tool('Edit', { file_path: FILE('web\\js\\views\\party.js'), old_string: 'a', new_string: 'b' }, { agent: dev });
  s.tool('Bash', { command: 'node -e "process.exit(1)"' }, { agent: tes, error: 'Exit code 1' });
  const two = s.mark();
  s.finish(dev, devCall);
  s.tool('Grep', { pattern: 'filter', path: 'web' }, { agent: tes });
  s.finish(tes, tesCall);
  const docCall = s.delegate(doc, 'Documentar os filtros');
  s.tool('Edit', { file_path: FILE('docs\\guias\\painel.md'), old_string: 'a', new_string: 'b' }, { agent: doc });
  s.finish(doc, docCall);
  s.tool('Read', { file_path: FILE('README.md') });
  s.stop();
  return { s, keys: { arq: arq.id, dev: dev.id, tes: tes.id, doc: doc.id }, parts: [s.part(0, one), s.part(one, two), s.part(two)] };
}

/** @param {any} state @param {string} id */
const sessionOf = (state, id) => state.sessions.find((/** @type {any} */ x) => x.id === id);

/**
 * Registra na página, pelo relógio dela (performance.now): aperto e soltura de
 * botão (Espaço ou ponteiro), a primeira linha nova do feed e cada redesenho da
 * equipe e dos chips. Instalado uma vez por página.
 * @param {import('@playwright/test').Page} page
 */
async function installHoldProbe(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    if (w.__hold) return;
    w.__hold = [];
    const log = (/** @type {string} */ what) => w.__hold.push({ what, t: performance.now() });
    document.addEventListener('keydown', (event) => { if (event.key === ' ' && !event.repeat) log('press'); }, true);
    document.addEventListener('keyup', (event) => { if (event.key === ' ') log('release'); }, true);
    document.addEventListener('pointerdown', () => log('press'), true);
    document.addEventListener('pointerup', () => log('release'), true);
    const observe = (/** @type {string} */ id, /** @type {string} */ what) => new MutationObserver(() => log(what)).observe(/** @type {Node} */ (document.getElementById(id)), { childList: true });
    observe('party', 'party');
    observe('feed-filters', 'chips');
    new MutationObserver((records) => { if (records.some((r) => r.addedNodes.length > 0)) log('row'); })
      .observe(/** @type {Node} */ (document.getElementById('feed-entries')), { childList: true });
  });
}

/** @param {import('@playwright/test').Page} page */
const resetHoldProbe = (page) => page.evaluate(() => { /** @type {any} */ (window).__hold.length = 0; });

/**
 * Marcos da tentativa, em ms desde o aperto (relógio da página): primeira linha
 * nova, soltura e quantos redesenhos da região houve entre o aperto e a soltura.
 * @param {import('@playwright/test').Page} page
 * @param {'party'|'chips'} region
 */
const holdTimeline = (page, region) => page.evaluate((name) => {
  const log = /** @type {{ what: string, t: number }[]} */ (/** @type {any} */ (window).__hold);
  const press = log.find((e) => e.what === 'press');
  if (!press) return null;
  const row = log.find((e) => e.what === 'row' && e.t >= press.t);
  const release = log.find((e) => e.what === 'release' && e.t >= press.t);
  const end = release ? release.t : Infinity;
  return {
    rowAfter: row ? Math.round(row.t - press.t) : null,
    releaseAfter: release ? Math.round(release.t - press.t) : null,
    redraws: log.filter((e) => e.what === name && e.t >= press.t && e.t < end).length,
  };
}, region);

/**
 * A tentativa mede o que promete: a linha nova chegou e o botão foi solto antes
 * do teto de 1,5 s (com folga).
 * @param {{ rowAfter: number|null, releaseAfter: number|null }|null} timeline
 */
const validHold = (timeline) => timeline !== null && timeline.rowAfter !== null && timeline.releaseAfter !== null
  && timeline.rowAfter <= 1_400 && timeline.releaseAfter <= 1_400;

test.describe('filtros e animação do feed (tester)', () => {
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

  /** @returns {LiveServer} */
  const srv = () => {
    if (!server) throw new Error('sem servidor');
    return server;
  };

  for (const themeId of /** @type {const} */ (['escritorio', 'guilda'])) {
    test(`${themeId}: chips por papel e cartões por papel e instância, com linhas chegando, iguais à regra do plano`, async ({ page }) => {
      const theme = THEMES[themeId];
      const watch = await watchPage(page, srv().base);
      const { s, keys, parts } = teamScenario();
      await page.goto(`${srv().base}/#${themeId}`);
      await expect(page.locator('#conn')).toHaveText('ao vivo');
      let state = await inject(srv(), parts[0]);
      let session = sessionOf(state, s.sessionId);
      await waitPanelFeed(page, session);

      // Chips: "Todos" e um por papel do cartão da equipe, com "Só <papel>".
      const chips = page.locator('#feed-filters .chip');
      const roster = session.roster;
      await expect(chips).toHaveCount(1 + roster.length);
      await expect(chips.first()).toHaveText('Todos');
      await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
      for (const role of roster) {
        await expect(page.locator(`#feed-filters [data-filter="role:${role}"]`)).toHaveAttribute('aria-label', `Só ${theme.roles[role].name}`);
      }
      await expect(page.locator('#feed-filters')).toHaveAttribute('aria-label', 'Filtrar por agente');
      await expect(page.locator('#feed-head')).toHaveText(new RegExp(`^${theme.words.feed}\\s*${session.feed.length} eventos$`));

      // Chip do arquiteto: a delegação a ele (do orquestrador) e as linhas dele.
      await page.locator('#feed-filters [data-filter="role:arq"]').click();
      expect(await visibleIds(page)).toEqual(expectedIds(session, oracle(session, 'role:arq')));
      const arqLines = expectedIds(session, oracle(session, 'role:arq'));
      expect(arqLines.length).toBeGreaterThanOrEqual(3);
      await expect(page.locator('#feed-head')).toContainText(`${arqLines.length} de ${session.feed.length} eventos`);
      // O bloco da equipe do papel fica marcado; o chip "Todos" solta.
      await expect(page.locator('#party .member[data-agent="arq"]')).toHaveClass(/is-filter/);
      await expect(page.locator('#party [data-filter="role:arq"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');

      // Orquestrador: as linhas dele, inclusive as delegações que fez.
      await page.locator('#feed-filters [data-filter="role:orq"]').click();
      const orqLines = expectedIds(session, oracle(session, 'role:orq'));
      expect(await visibleIds(page)).toEqual(orqLines);
      const delegations = session.feed.filter((/** @type {any} */ e) => e.kind === 'agent.delegated').map((/** @type {any} */ e) => e.id);
      for (const id of delegations) expect(orqLines).toContain(id);
      // Sessão e ticket não aparecem com filtro.
      const systemLines = session.feed.filter((/** @type {any} */ e) => ['session.started', 'quest.started', 'quest.finished'].includes(e.kind)).map((/** @type {any} */ e) => e.id);
      expect(systemLines.length).toBeGreaterThan(0);
      for (const id of systemLines) expect(orqLines).not.toContain(id);

      // Cartão da equipe: o nome do papel do dev filtra pelo papel; linhas
      // chegando com o filtro ligado entram visíveis se forem do dev.
      await page.locator('#party [data-filter="role:dev"]').click();
      await expect(page.locator('#feed-filters [data-filter="role:dev"]')).toHaveAttribute('aria-pressed', 'true');
      await recordFeed(page);
      state = await inject(srv(), parts[1]);
      session = sessionOf(state, s.sessionId);
      await waitPanelFeed(page, session);
      expect(await visibleIds(page)).toEqual(expectedIds(session, oracle(session, 'role:dev')));
      const { added } = await recorded(page);
      expect(added.length).toBeGreaterThan(3);
      for (const item of added) {
        const event = session.feed.find((/** @type {any} */ e) => e.id === item.id);
        expect(item.hidden, item.id).toBe(!oracle(session, 'role:dev')(event));
        expect(item.isNew, item.id).toBe(!item.hidden);
      }

      // Instância do tester pelo cartão: só as linhas dela; só o chip da instância (T14) apertado.
      const tesButton = page.locator(`#party [data-filter="agent:${keys.tes}"]`);
      await tesButton.click();
      await expect(tesButton).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator(`#party li.inst[data-key="${keys.tes}"]`)).toHaveClass(/is-filter/);
      await expect(page.locator('#feed-filters [aria-pressed="true"]')).toHaveCount(1);
      await expect(page.locator(`#feed-filters .chip-inst[data-filter="agent:${keys.tes}"]`)).toHaveAttribute('aria-pressed', 'true');
      expect(await visibleIds(page)).toEqual(expectedIds(session, oracle(session, `agent:${keys.tes}`)));
      // Clicar de novo desfaz.
      await tesButton.click();
      await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#feed-filters .chip-inst')).toHaveCount(0);
      expect(await visibleIds(page)).toEqual(expectedIds(session));
      await expect(page.locator('#feed-head')).toHaveText(new RegExp(`^${theme.words.feed}\\s*${session.feed.length} eventos$`));

      // Parte final: documentador entra; o chip dele aparece ao vivo.
      state = await inject(srv(), parts[2]);
      session = sessionOf(state, s.sessionId);
      await waitPanelFeed(page, session);
      await page.locator('#feed-filters [data-filter="role:doc"]').click();
      expect(await visibleIds(page)).toEqual(expectedIds(session, oracle(session, 'role:doc')));
      // Clique no chip apertado mantém (chips escolhem, como no mockup).
      await page.locator('#feed-filters [data-filter="role:doc"]').click();
      await expect(page.locator('#feed-filters [data-filter="role:doc"]')).toHaveAttribute('aria-pressed', 'true');
      // Etapa concluída conta para o papel dono (quando o servidor emite etapas, T8).
      for (const phase of session.feed.filter((/** @type {any} */ e) => e.kind === 'quest.phase')) {
        const owner = /** @type {any} */ (PHASE_OWNER)[phase.data.phase];
        await page.locator(`#feed-filters [data-filter="role:${owner}"]`).click();
        expect(await visibleIds(page), `etapa ${phase.data.phase}`).toContain(phase.id);
      }

      expect(await watch.violations()).toEqual([]);
      expect(watch.problems.csp).toEqual([]);
      expect(watch.problems.errors).toEqual([]);
      expect(watch.problems.external).toEqual([]);
    });

    test(`${themeId}: instância recém-criada, sem linha própria: "0 de N eventos" e a mensagem de vazio do tema`, async ({ page }) => {
      const theme = THEMES[themeId];
      const s = createScenario({ label: `vazio-${themeId}` });
      const guest = s.agent('g', 'Explore');
      s.start().prompt('Procurar exemplos');
      s.tool('Read', { file_path: FILE('README.md') });
      s.delegate(guest, 'Procurar exemplos de filtro');
      await page.goto(`${srv().base}/#${themeId}`);
      const state = await inject(srv(), s);
      const session = sessionOf(state, s.sessionId);
      await waitPanelFeed(page, session);
      const button = page.locator(`#party [data-filter="agent:${guest.id}"]`);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      // A delegação que criou a instância é do orquestrador: não entra no filtro dela (desvio registrado).
      expect(await visibleIds(page)).toEqual([]);
      await expect(page.locator('#feed-empty')).toBeVisible();
      await expect(page.locator('#feed-empty')).toHaveText(theme.words.noFeed);
      await expect(page.locator('#feed-head')).toContainText(`0 de ${session.feed.length} eventos`);
      await button.click();
      await expect(page.locator('#feed-empty')).toBeHidden();
    });
  }

  test('troca de tema com filtro ligado: o filtro continua, o texto muda, sem animação e sem reabrir o /events', async ({ page }) => {
    const { s, keys, parts } = teamScenario('tema');
    const eventsRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/events') eventsRequests.push(request.url());
    });
    await page.goto(`${srv().base}/#escritorio`);
    await inject(srv(), parts[0]);
    const state = await inject(srv(), parts[1]);
    const session = sessionOf(state, s.sessionId);
    await waitPanelFeed(page, session);

    // Filtro por instância (dev) e depois por papel (tes), trocando o tema em cada um.
    for (const filter of [`agent:${keys.dev}`, 'role:tes']) {
      const source = filter.startsWith('agent:') ? '#party' : '#feed-filters';
      await page.locator(`${source} [data-filter="${filter}"]`).click();
      const visible = await visibleIds(page);
      expect(visible).toEqual(expectedIds(session, oracle(session, filter)));
      const head = String(await page.locator('#feed-head').textContent());
      await recordFeed(page);
      for (const [key, theme] of /** @type {const} */ ([['2', guilda], ['t', escritorio], ['2', guilda], ['1', escritorio]])) {
        await page.keyboard.press(key);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
        await expect(page.locator('#feed-title')).toHaveText(theme.words.feed);
        await expect(page.locator(`[data-filter="${filter}"]`).first()).toHaveAttribute('aria-pressed', 'true');
        expect(await visibleIds(page)).toEqual(visible);
        await expect(page.locator('#feed-head')).toHaveText(head.replace(/^(Atividade|Crônica)/, theme.words.feed));
        for (const role of session.roster) {
          await expect(page.locator(`#feed-filters [data-filter="role:${role}"]`)).toHaveAttribute('aria-label', `Só ${theme.roles[role].name}`);
        }
      }
      const { animations, added, removed } = await recorded(page);
      expect(animations.filter((/** @type {string} */ name) => name === 'slidein')).toEqual([]);
      // Cada troca refaz o texto de cada linha uma vez, no lugar.
      expect(added.length).toBe(4 * session.feed.length);
      expect(removed.length).toBe(4 * session.feed.length);
      expect(await page.locator('#feed-entries li.is-new').count()).toBe(0);
    }
    expect(eventsRequests).toHaveLength(1);
  });

  test('instância que vai para o "+N" com o filtro dela ligado: o filtro volta para "Todos"', async ({ page }) => {
    const s = createScenario({ label: 'mais-n' });
    const guests = [1, 2, 3, 4, 5].map((n) => s.agent(`g${n}`, 'Explore'));
    s.start().prompt('Procurar em cinco pastas');
    const calls = [];
    calls[0] = s.delegate(guests[0], 'Procurar na pasta 1');
    s.tool('Glob', { pattern: 'docs/**' }, { agent: guests[0] });
    const one = s.mark();
    s.tool('Read', { file_path: FILE('docs\\a.md') }, { agent: guests[0] });
    s.finish(guests[0], calls[0]);
    for (const n of [1, 2]) {
      calls[n] = s.delegate(guests[n], `Procurar na pasta ${n + 1}`);
      s.tool('Glob', { pattern: `pasta${n + 1}/**` }, { agent: guests[n] });
      s.finish(guests[n], calls[n]);
    }
    const two = s.mark();
    calls[3] = s.delegate(guests[3], 'Procurar na pasta 4');
    s.tool('Glob', { pattern: 'pasta4/**' }, { agent: guests[3] });
    s.finish(guests[3], calls[3]);
    calls[4] = s.delegate(guests[4], 'Procurar na pasta 5');

    await page.goto(`${srv().base}/#guilda`);
    let state = await inject(srv(), s.part(0, one));
    let session = sessionOf(state, s.sessionId);
    await waitPanelFeed(page, session);
    const first = page.locator(`#party [data-filter="agent:${guests[0].id}"]`);
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    const own = expectedIds(session, oracle(session, `agent:${guests[0].id}`));
    expect(own.length).toBe(1);
    expect(await visibleIds(page)).toEqual(own);

    // Ela termina e outras duas também: continua no cartão (até 3 encerradas), com o filtro.
    state = await inject(srv(), s.part(one, two));
    session = sessionOf(state, s.sessionId);
    await waitPanelFeed(page, session);
    await expect(page.locator('#party .member[data-agent="aux"] li.inst.finished')).toHaveCount(3);
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    const ownNow = expectedIds(session, oracle(session, `agent:${guests[0].id}`));
    expect(ownNow.length).toBe(3);
    expect(await visibleIds(page)).toEqual(ownNow);
    await expect(page.locator('#feed-head')).toContainText(`${ownNow.length} de ${session.feed.length} eventos`);

    // A quarta termina: a primeira vai para o "+N", e o filtro dela volta para "Todos".
    state = await inject(srv(), s.part(two));
    session = sessionOf(state, s.sessionId);
    await waitPanelFeed(page, session);
    await expect(page.locator('#party .member[data-agent="aux"] .m-more')).toHaveText(/\+1 instância encerrada/);
    await expect(first).toHaveCount(0);
    await expect(page.locator('#feed-filters [data-filter=""]')).toHaveAttribute('aria-pressed', 'true');
    expect(await visibleIds(page)).toEqual(expectedIds(session));
    await expect(page.locator('#feed-head')).not.toContainText(' de ');
    // Onde o foco do teclado foi parar (observação de acessibilidade).
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('data-filter') !== null ? `[data-filter="${el.getAttribute('data-filter')}"]` : ''}` : 'nenhum';
    });
    console.log(`[+N] foco depois que o botão filtrado sumiu: ${focus}`);
    test.info().annotations.push({ type: 'foco depois do "+N"', description: focus });
  });

  test('duas sessões ao mesmo tempo: cada uma com o próprio feed e chips; trocar de sessão não anima e volta para "Todos"', async ({ page }) => {
    const a = createScenario({ label: 'sessao-a' });
    const b = createScenario({ label: 'sessao-b', projectDir: OTHER_PROJECT_DIR, entrypoint: 'claude-vscode' });
    const aTes = a.agent('t', 'tester');
    const bArq = b.agent('q', 'arquiteto');
    a.start().prompt('Sessão A');
    b.start().prompt('Sessão B');
    const aCall = a.delegate(aTes, 'Testar A');
    const bCall = b.delegate(bArq, 'Desenhar B');
    for (let i = 0; i < 4; i++) {
      a.tool('Read', { file_path: FILE(`a${i}.md`) }, { agent: aTes });
      b.tool('Read', { file_path: `${OTHER_PROJECT_DIR}\\b${i}.md` }, { agent: bArq });
    }
    const aMark = a.mark();
    const bMark = b.mark();
    a.tool('Bash', { command: 'npm test' }, { agent: aTes });
    a.finish(aTes, aCall);
    b.tool('Write', { file_path: `${OTHER_PROJECT_DIR}\\adr.md`, content: 'x' }, { agent: bArq });
    b.finish(bArq, bCall);

    await page.goto(`${srv().base}/#escritorio`);
    let state = await inject(srv(), interleave(a.part(0, aMark), b.part(0, bMark)));
    await expect(page.locator('#session-select option')).toHaveCount(2);
    await page.locator('#session-select').selectOption(a.sessionId);
    let sa = sessionOf(state, a.sessionId);
    let sb = sessionOf(state, b.sessionId);
    await waitPanelFeed(page, sa);
    await page.locator('#feed-filters [data-filter="role:tes"]').click();
    expect(await visibleIds(page)).toEqual(expectedIds(sa, oracle(sa, 'role:tes')));
    await recordFeed(page);

    // Troca para B: só as linhas de B, chips de B, filtro "Todos", sem animação.
    await page.locator('#session-select').selectOption(b.sessionId);
    await waitPanelFeed(page, sb);
    expect(await visibleIds(page)).toEqual(expectedIds(sb));
    await expect(page.locator('#feed-filters [data-filter=""]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#feed-filters [data-filter="role:tes"]')).toHaveCount(0);
    await expect(page.locator('#feed-filters [data-filter="role:arq"]')).toHaveCount(1);
    let rec = await recorded(page);
    expect(rec.animations.filter((/** @type {string} */ n) => n === 'slidein')).toEqual([]);
    expect(rec.added.every((/** @type {any} */ x) => !x.isNew)).toBe(true);

    // Filtro em B e eventos das duas chegando: só os de B entram, e animam se visíveis.
    await page.locator('#feed-filters [data-filter="role:arq"]').click();
    await resetRecord(page);
    state = await inject(srv(), interleave(a.part(aMark), b.part(bMark)));
    sa = sessionOf(state, a.sessionId);
    sb = sessionOf(state, b.sessionId);
    await waitPanelFeed(page, sb);
    expect(await visibleIds(page)).toEqual(expectedIds(sb, oracle(sb, 'role:arq')));
    rec = await recorded(page);
    const aIds = new Set(sa.feed.map((/** @type {any} */ e) => e.id));
    expect(rec.added.filter((/** @type {any} */ x) => aIds.has(x.id))).toEqual([]);
    expect(rec.added.length).toBeGreaterThan(0);
    for (const item of rec.added) expect(item.isNew).toBe(!item.hidden);

    // Volta para A: feed de A completo, "Todos" (o filtro vale só na sessão em que foi escolhido), sem animação.
    await resetRecord(page);
    await page.locator('#session-select').selectOption(a.sessionId);
    await waitPanelFeed(page, sa);
    await expect(page.locator('#feed-filters [data-filter=""]')).toHaveAttribute('aria-pressed', 'true');
    expect(await visibleIds(page)).toEqual(expectedIds(sa));
    rec = await recorded(page);
    expect(rec.animations.filter((/** @type {string} */ n) => n === 'slidein')).toEqual([]);
    expect(rec.added.every((/** @type {any} */ x) => !x.isNew)).toBe(true);
  });

  test('teclado: Tab chega aos chips e aos cartões, foco visível, Enter e Espaço filtram, e o foco não se perde quando um chip novo aparece', async ({ page }) => {
    const { s, parts, keys } = teamScenario('teclado');
    await page.goto(`${srv().base}/#escritorio`);
    let state = await inject(srv(), parts[0]);
    let session = sessionOf(state, s.sessionId);
    await waitPanelFeed(page, session);

    // Tab a partir do seletor de sessão percorre equipe e chips (ordem do documento).
    await page.locator('#session-select').focus();
    /** @type {string[]} */
    const order = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!(el instanceof HTMLElement)) return null;
        const style = getComputedStyle(el);
        return { filter: el.getAttribute('data-filter'), outline: style.outlineStyle, width: style.outlineWidth };
      });
      if (!info) break;
      if (info.filter !== null) {
        order.push(info.filter);
        expect(info.outline, `foco visível em ${info.filter}`).not.toBe('none');
        expect(parseFloat(info.width)).toBeGreaterThanOrEqual(2);
      }
    }
    expect(order).toContain('role:orq');
    expect(order).toContain(`agent:${keys.arq}`);
    expect(order).toContain('');
    expect(order).toContain('role:dev');
    // Equipe antes dos chips (ordem visual em 3 colunas: equipe à esquerda, feed à direita).
    expect(order.indexOf('role:orq')).toBeLessThan(order.indexOf(''));

    // Espaço no chip do arquiteto; Enter no "Todos".
    await page.locator('#feed-filters [data-filter="role:arq"]').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#feed-filters [data-filter="role:arq"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#feed-filters [data-filter="role:arq"]')).toBeFocused();
    expect(await visibleIds(page)).toEqual(expectedIds(session, oracle(session, 'role:arq')));
    await page.locator('#feed-filters [data-filter=""]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#feed-filters [data-filter=""]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#feed-filters [data-filter=""]')).toBeFocused();

    // Foco no "Todos" e um papel novo chega (os chips são redesenhados): o foco fica no "Todos".
    const chipsBefore = await page.locator('#feed-filters .chip').count();
    state = await inject(srv(), parts[1]);
    session = sessionOf(state, s.sessionId);
    await waitPanelFeed(page, session);
    await expect(page.locator('#feed-filters .chip')).toHaveCount(chipsBefore + 1);
    await expect(page.locator('#feed-filters [data-filter=""]')).toBeFocused();

    // Foco num botão de instância da equipe, com updates que redesenham o cartão: fica nele.
    const devButton = page.locator(`#party [data-filter="agent:${keys.dev}"]`);
    await devButton.focus();
    const partyBefore = await page.locator('#party').innerHTML();
    state = await inject(srv(), parts[2]);
    session = sessionOf(state, s.sessionId);
    await waitPanelFeed(page, session);
    expect(await page.locator('#party').innerHTML()).not.toBe(partyBefore);
    await expect(devButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(devButton).toHaveAttribute('aria-pressed', 'true');
    await expect(devButton).toBeFocused();
    expect(await visibleIds(page)).toEqual(expectedIds(session, oracle(session, `agent:${keys.dev}`)));
  });

  // Clique segurado (regras de interface da visão geral): o main.js segura a
  // região por no máximo 1,5 s. Os marcos de cada tentativa (aperto, primeira
  // linha nova, soltura e redesenhos da região) são medidos pelo relógio da
  // própria página, sem a latência do processo de teste (ADR 0010, "contador
  // antes de relógio"). A tentativa só vale se o update chegou e o botão foi
  // solto antes do teto; senão, é refeita uma vez com outros eventos (ADR 0010,
  // "uma nova tentativa"; falhar duas vezes seguidas é bug).

  test('clique durante um update: Espaço segurado no cartão e mouse segurado no chip não se perdem', async ({ page }) => {
    const { s, parts } = teamScenario('clique');
    await page.goto(`${srv().base}/#escritorio`);
    const state = await inject(srv(), parts[0]);
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    await installHoldProbe(page);
    const send = (/** @type {{ events: any[] }} */ chunk) => injectScenario(/** @type {any} */ (chunk), { port: srv().port, token: srv().token, fast: true });
    const feedCount = () => page.locator('#feed-entries li.entry').count();

    // Teclado: Espaço apertado no nome do papel do arquiteto; chegam eventos que
    // mudam a equipe (a ação do dev; na nova tentativa, a do orquestrador).
    const arqRole = page.locator('#party [data-filter="role:arq"]');
    const extra = s.mark();
    s.pre('Read', { file_path: FILE('extra.md') });
    const keyChunks = [{ events: parts[1].events.slice(0, 2) }, s.part(extra)];
    /** @type {any[]} */
    const slowKeys = [];
    let keyVerified = false;
    for (const chunk of keyChunks) {
      await page.locator('#feed-filters [data-filter=""]').click();
      await arqRole.focus();
      const count = await feedCount();
      await resetHoldProbe(page);
      await page.keyboard.down(' ');
      await send(chunk);
      await expect.poll(feedCount, { intervals: [10, 20, 40] }).toBeGreaterThan(count);
      await page.keyboard.up(' ');
      const timeline = await holdTimeline(page, 'party');
      if (!validHold(timeline)) {
        slowKeys.push(timeline);
        await settledState(srv().port);
        continue;
      }
      // Com a tecla apertada, o cartão da equipe não foi redesenhado, e o clique valeu.
      expect(timeline?.redraws, 'equipe redesenhada com a tecla apertada').toBe(0);
      await expect(arqRole).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#feed-filters [data-filter="role:arq"]')).toHaveAttribute('aria-pressed', 'true');
      keyVerified = true;
      break;
    }
    expect(keyVerified, `teto passado nas duas tentativas: ${JSON.stringify(slowKeys)}`).toBe(true);

    // Mouse: botão apertado num chip enquanto chega um papel novo (os chips
    // mudam): o tester; na nova tentativa, um documentador. Sem foco em outro
    // botão antes (o caso com foco é o teste seguinte).
    const docMark = s.mark();
    s.delegate(s.agent('doc-extra', 'documentador'), 'Documentar o clique');
    const mouseChunks = [{ events: parts[1].events.slice(2) }, s.part(docMark)];
    /** @type {any[]} */
    const slowMouse = [];
    let mouseVerified = false;
    for (const chunk of mouseChunks) {
      await page.locator('#feed-filters [data-filter=""]').click();
      await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur());
      const chip = page.locator('#feed-filters [data-filter="role:dev"]');
      const box = await chip.boundingBox();
      if (!box) throw new Error('chip sem caixa');
      const count = await feedCount();
      const chipsBefore = await page.locator('#feed-filters .chip').count();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await resetHoldProbe(page);
      await page.mouse.down();
      await send(chunk);
      await expect.poll(feedCount, { intervals: [10, 20, 40] }).toBeGreaterThan(count);
      await page.mouse.up();
      const timeline = await holdTimeline(page, 'chips');
      if (!validHold(timeline)) {
        slowMouse.push(timeline);
        await settledState(srv().port);
        continue;
      }
      // Com o botão apertado, os chips não ganharam o papel novo; o clique valeu.
      expect(timeline?.redraws, 'chips redesenhados com o botão apertado').toBe(0);
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      // Solto o botão, os chips acompanham o papel novo.
      await expect(page.locator('#feed-filters .chip:not(.chip-inst)')).toHaveCount(chipsBefore + 1);
      mouseVerified = true;
      break;
    }
    expect(mouseVerified, `teto passado nas duas tentativas: ${JSON.stringify(slowMouse)}`).toBe(true);
  });

  // Regressão do bug 1 do tester no T11b (corrigido em 19/10/2026): o `blur` do
  // botão que tinha o foco chegava ao ouvinte de `blur` em captura na window
  // (main.js) logo depois do pointerdown e soltava a região segurada. Com o foco
  // em outro botão de filtro (o caso comum depois do primeiro clique), o cartão
  // era redesenhado no meio do clique, e o clique se perdia.
  test('clique na equipe com o foco em outro botão de filtro: o cartão continua segurado e o clique vale', async ({ page }) => {
    const { s, parts } = teamScenario('clique-com-foco');
    await page.goto(`${srv().base}/#escritorio`);
    const state = await inject(srv(), parts[0]);
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    await installHoldProbe(page);
    const extra = s.mark();
    s.pre('Read', { file_path: FILE('extra-foco.md') });
    const chunks = [{ events: parts[1].events.slice(0, 2) }, s.part(extra)];
    const button = page.locator('#party [data-filter="role:orq"]');
    /** @type {any[]} */
    const slow = [];
    let verified = false;
    for (const chunk of chunks) {
      // O usuário já usou um filtro: o chip "Todos" fica com o foco depois do clique.
      await page.locator('#feed-filters [data-filter="role:arq"]').click();
      await page.locator('#feed-filters [data-filter=""]').click();
      await expect(page.locator('#feed-filters [data-filter=""]')).toBeFocused();
      const box = await button.boundingBox();
      if (!box) throw new Error('botão sem caixa');
      const count = await page.locator('#feed-entries li.entry').count();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await resetHoldProbe(page);
      await page.mouse.down();
      await injectScenario(/** @type {any} */ (chunk), { port: srv().port, token: srv().token, fast: true });
      await expect.poll(() => page.locator('#feed-entries li.entry').count(), { intervals: [10, 20, 40] }).toBeGreaterThan(count);
      await page.mouse.up();
      const timeline = await holdTimeline(page, 'party');
      if (!validHold(timeline)) {
        slow.push(timeline);
        await settledState(srv().port);
        continue;
      }
      expect(timeline?.redraws, 'a equipe foi redesenhada com o botão apertado').toBe(0);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      verified = true;
      break;
    }
    expect(verified, `teto passado nas duas tentativas: ${JSON.stringify(slow)}`).toBe(true);
  });

  test('botão segurado por mais de 1,5 s não congela a equipe: ela volta a acompanhar os updates com o botão ainda apertado', async ({ page }) => {
    const { s, parts } = teamScenario('segurado');
    await page.goto(`${srv().base}/#escritorio`);
    const state = await inject(srv(), parts[0]);
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    const button = page.locator('#party [data-filter="role:orq"]');
    const box = await button.boundingBox();
    if (!box) throw new Error('botão sem caixa');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const before = await page.locator('#party').innerHTML();
    await inject(srv(), parts[1]);
    // Ainda apertado: o cartão é redesenhado depois do teto.
    await waitFor(async () => (await page.locator('#party').innerHTML()) !== before, 'a equipe ser redesenhada com o botão apertado', 10_000);
    await page.mouse.up();
  });

  test('movimento reduzido: nenhuma animação ao chegar linha, filtrar, trocar de tema ou de sessão; transições da equipe desligadas', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { s, parts } = teamScenario('reduzido');
    const other = createScenario({ label: 'reduzido-b', projectDir: OTHER_PROJECT_DIR });
    other.start().prompt('Outra sessão').tool('Read', { file_path: `${OTHER_PROJECT_DIR}\\x.md` });
    await page.goto(`${srv().base}/#escritorio`);
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__anims = [];
      document.addEventListener('animationstart', (e) => w.__anims.push(/** @type {AnimationEvent} */ (e).animationName), true);
      document.addEventListener('transitionstart', (e) => w.__anims.push(`transition:${/** @type {TransitionEvent} */ (e).propertyName}`), true);
    });
    await inject(srv(), other);
    let state = await inject(srv(), parts[0]);
    await page.locator('#session-select').selectOption(s.sessionId);
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    state = await inject(srv(), parts[1]);
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    await page.locator('#feed-filters [data-filter="role:dev"]').click();
    await page.locator('#party .member[data-agent="arq"]').hover();
    await page.locator('#party [data-filter="role:arq"]').click();
    await page.keyboard.press('2');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'guilda');
    await page.locator('#session-select').selectOption(other.sessionId);
    await page.locator('#session-select').selectOption(s.sessionId);
    state = await inject(srv(), parts[2]);
    await waitPanelFeed(page, sessionOf(state, s.sessionId));
    expect(await page.evaluate(() => /** @type {any} */ (window).__anims)).toEqual([]);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    for (const selector of ['#party .member', '#party .inst-pick', '#feed-entries li.entry']) {
      const durations = await page.locator(selector).first().evaluate((el) => [getComputedStyle(el).transitionDuration, getComputedStyle(el).animationName]);
      expect(durations[0].split(',').every((d) => parseFloat(d) === 0), `${selector} sem transição`).toBe(true);
      expect(durations[1]).toBe('none');
    }
  });

  for (const width of [360, 820]) {
    test(`${width} px: chips e cartões cabem, sem rolagem horizontal, e os filtros funcionam com toque`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: width === 360 });
      const page = await context.newPage();
      try {
        const { s, keys, parts } = teamScenario(`largura-${width}`);
        await page.goto(`${srv().base}/#guilda`);
        await inject(srv(), parts[0]);
        const state = await inject(srv(), parts[1]);
        const session = sessionOf(state, s.sessionId);
        await waitPanelFeed(page, session);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        // Todos os chips dentro da largura da tela, com pelo menos 24 px (WCAG 2.5.8).
        const chipBoxes = await page.locator('#feed-filters .chip').evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, w: r.width, h: r.height })));
        expect(chipBoxes.length).toBe(1 + session.roster.length);
        for (const box of chipBoxes) {
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(width);
          expect(Math.min(box.w, box.h)).toBeGreaterThanOrEqual(24);
        }
        // Botões da equipe dentro da tela.
        const teamBoxes = await page.locator('#party [data-filter]').evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
        for (const box of teamBoxes) {
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(width);
        }
        await page.locator('#feed-filters [data-filter="role:tes"]').tap();
        await expect(page.locator('#feed-filters [data-filter="role:tes"]')).toHaveAttribute('aria-pressed', 'true');
        expect(await visibleIds(page)).toEqual(expectedIds(session, oracle(session, 'role:tes')));
        await page.locator(`#party [data-filter="agent:${keys.dev}"]`).tap();
        await expect(page.locator(`#party [data-filter="agent:${keys.dev}"]`)).toHaveAttribute('aria-pressed', 'true');
        expect(await visibleIds(page)).toEqual(expectedIds(session, oracle(session, `agent:${keys.dev}`)));
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    });
  }
});
