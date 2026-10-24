// @ts-check
// Feed ao vivo (T11b): servidor real, cenário sintético injetado pelo injetor
// do T9b (scripts/inject-fixture.mjs) e o painel no Edge.
//
// - As linhas entram em ordem, no topo, com a animação do mockup, e os status
//   da equipe mudam (instância trabalhando que depois encerra).
// - Filtros por papel e por instância, pelos chips e pelos cartões da equipe,
//   com mouse e teclado, inclusive com linhas chegando com o filtro ligado.
// - Parando o servidor, o selo vai para "reconectando"; religando, o painel se
//   recupera sem recarregar a página.
// - Com movimento reduzido, nenhuma animação.
//
// Cada teste sobe o próprio servidor (porta livre e AGENT_QUEST_HOME
// temporário, nunca a 47821 nem o diretório real), porque precisa pará-lo e
// religá-lo sem afetar os outros arquivos de teste, que rodam em paralelo.
// [T0]: depois, o mesmo com o cenário básico real (test/fixtures/hooks/).

import { expect, test } from '@playwright/test';
import { injectScenario } from '../../scripts/inject-fixture.mjs';
import { syntheticScenario } from '../unit/server/domain/scenarios.js';
import { freePort, removeHome, serverState, startServer, tempHome } from './live-server.js';
import { watchPage } from './support.js';

/** Sessão principal do cenário sintético (a primeira a aparecer, que o painel escolhe). */
const MAIN_SESSION = 'a8cf05fb-e263-4334-ae84-6d04a7151a8d';

/**
 * Cenário sintético dividido: até os dois subagentes em paralelo começarem
 * (`first`), até antes do primeiro deles terminar (`middle`) e o resto (`last`).
 * `rest` é `middle` mais `last`.
 */
function scenarioParts() {
  const scenario = syntheticScenario();
  const hooks = scenario.events.map((event) => /** @type {any} */ (event.payload).hook_event_name);
  const starts = hooks.flatMap((name, index) => (name === 'SubagentStart' ? [index] : []));
  const cut = starts[1] + 1;
  const stop = hooks.indexOf('SubagentStop', cut);
  return {
    whole: scenario,
    first: { ...scenario, events: scenario.events.slice(0, cut) },
    middle: { ...scenario, events: scenario.events.slice(cut, stop) },
    last: { ...scenario, events: scenario.events.slice(stop) },
    rest: { ...scenario, events: scenario.events.slice(cut) },
  };
}

/**
 * Passa a registrar, na página, as linhas que entram no feed (em lotes, um por
 * redesenho), os estados das instâncias e as animações que começam.
 * @param {import('@playwright/test').Page} page
 */
async function recordPanel(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    if (w.__aq) {
      // Já está gravando: só recomeça os registros.
      w.__aq.batches = [];
      w.__aq.states = [];
      w.__aq.animations = [];
      return;
    }
    w.__aq = { batches: [], states: [], animations: [] };
    const list = document.getElementById('feed-entries');
    const party = document.getElementById('party');
    if (!list || !party) throw new Error('feed ou equipe ausentes');
    new MutationObserver((records) => {
      const added = [];
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches('li.entry')) {
            added.push({ id: node.dataset.id, isNew: node.classList.contains('is-new'), hidden: node.hidden, index: [...list.children].indexOf(node) });
          }
        }
      }
      if (added.length) w.__aq.batches.push(added);
    }).observe(list, { childList: true });
    new MutationObserver(() => {
      for (const li of party.querySelectorAll('li.inst')) w.__aq.states.push(`${li.getAttribute('data-key')} ${li.className}`);
    }).observe(party, { childList: true, subtree: true });
    document.addEventListener('animationstart', (event) => w.__aq.animations.push(/** @type {AnimationEvent} */ (event).animationName));
  });
}

/** @param {import('@playwright/test').Page} page */
const recorded = (page) => page.evaluate(() => /** @type {any} */ (window).__aq);

/** @param {string} id */
const seqOf = (id) => Number(id.split(':').at(-1));

/** Ids das linhas visíveis do feed, de cima para baixo. */
/** Ids de todas as linhas do feed (visíveis ou não). */
const shownIds = async (/** @type {import('@playwright/test').Page} */ page) =>
  new Set(await page.locator('#feed-entries li.entry').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id'))));

const visibleIds = (/** @type {import('@playwright/test').Page} */ page) =>
  page.locator('#feed-entries li.entry:not([hidden])').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id')));

/**
 * Ids do feed de uma sessão no servidor que passam no filtro, mais recentes primeiro.
 * @param {any} session
 * @param {(event: any) => boolean} [keep]
 */
const expectedIds = (session, keep = () => true) =>
  session.feed.filter(keep).sort((/** @type {any} */ a, /** @type {any} */ b) => b.seq - a.seq).map((/** @type {any} */ e) => e.id);

test.describe('feed ao vivo com o injetor', () => {
  // Servidor próprio e injeção em tempo real: sob carga (vários processos do
  // Playwright em paralelo), 30 s não bastam.
  test.describe.configure({ timeout: 90_000 });
  /** @type {string} */
  let home;
  /** @type {number} */
  let port;
  /** @type {Awaited<ReturnType<typeof startServer>>|null} */
  let server = null;

  test.beforeEach(async () => {
    home = tempHome();
    port = await freePort();
    server = await startServer(port, home);
  });

  test.afterEach(async () => {
    await server?.stop();
    server = null;
    removeHome(home);
  });

  /**
   * @param {import('@playwright/test').Page} page
   * @param {{ events: any[] }} scenario
   * @param {{ fast?: boolean, speed?: number }} [options]
   */
  async function inject(page, scenario, options = { speed: 4 }) {
    if (!server) throw new Error('servidor parado');
    const result = await injectScenario(/** @type {any} */ (scenario), { port, token: server.token, ...options });
    expect(result.refused).toEqual([]);
    // O servidor responde 204 antes de processar (fila): espera o seq parar de
    // mudar entre duas leituras, com a sessão já no estado.
    /** @type {any} */
    let session;
    let previous = -1;
    await expect.poll(async () => {
      const state = await serverState(port);
      const stable = state.seq === previous;
      previous = state.seq;
      session = state.sessions.find((s) => s.id === MAIN_SESSION);
      return stable && session !== undefined;
    }, { intervals: [150, 250, 250, 400] }).toBe(true);
    // O painel já recebeu tudo quando o feed mostra o mesmo que o servidor.
    await expect.poll(async () => (await page.locator('#feed-entries li.entry').count())).toBe(session.feed.length);
    return session;
  }

  test('as linhas entram em ordem no topo, com a animação do mockup, e os status mudam', async ({ page }) => {
    const base = `http://127.0.0.1:${port}`;
    const watch = await watchPage(page, base);
    await page.goto(`${base}/#escritorio`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');
    await expect(page.locator('.onboarding')).toBeVisible();
    await recordPanel(page);

    // O cenário entra em três partes, com pontos de sincronização (ADR 0010,
    // "contador antes de relógio"): com os tickets (T8), um subagente encerrado
    // só fica no cartão até o próximo pedido, de 25 a 125 ms com `speed: 4`. Em
    // uma injeção só, sob carga, nenhum quadro pode cair nessa janela, e o teste
    // falhava sem defeito do painel (relatório do tester, T13).
    const { whole } = scenarioParts();
    const hooks = whole.events.map((event) => /** @type {any} */ (event.payload).hook_event_name);
    const firstStart = hooks.indexOf('SubagentStart');
    const worker = /** @type {any} */ (whole.events[firstStart].payload).agent_id;
    const workerStop = hooks.findIndex((name, index) => name === 'SubagentStop' && /** @type {any} */ (whole.events[index].payload).agent_id === worker);
    const nextPrompt = hooks.indexOf('UserPromptSubmit', workerStop);
    const workerRow = page.locator(`#party li.inst[data-key="${worker}"]`);
    await inject(page, { ...whole, events: whole.events.slice(0, firstStart + 1) });
    await expect(workerRow).toHaveClass(/\bworking\b/);
    await inject(page, { ...whole, events: whole.events.slice(firstStart + 1, nextPrompt) });
    await expect(workerRow).toHaveClass(/\bfinished\b/);
    const session = await inject(page, { ...whole, events: whole.events.slice(nextPrompt) });

    // O feed mostra o mesmo que o servidor, na mesma ordem (mais recentes no topo).
    await expect(page.locator('#session-select')).toHaveValue(MAIN_SESSION);
    expect(await visibleIds(page)).toEqual(expectedIds(session));
    await expect(page.locator('#feed-head')).toContainText(`${session.feed.length} eventos`);

    // Em ordem: nenhuma linha nova é mais antiga que uma que já tinha aparecido,
    // e as que chegam com o painel aberto entram no topo com a animação.
    // Linhas trocadas no lugar (texto que mudou) não contam como novas.
    const { batches: raw, states, animations } = await recorded(page);
    const seen = new Set();
    const batches = raw.map((/** @type {any[]} */ batch) => batch.filter((item) => !seen.has(item.id) && seen.add(item.id))).filter((batch) => batch.length > 0);
    expect(batches.length).toBeGreaterThan(3);
    let newest = 0;
    let live = 0;
    for (const [n, batch] of batches.entries()) {
      const seqs = batch.map((/** @type {any} */ item) => seqOf(item.id));
      expect(Math.min(...seqs), `lote ${n}`).toBeGreaterThan(newest);
      newest = Math.max(newest, ...seqs);
      if (n === 0) continue; // primeiro desenho da sessão: sem animação
      for (const item of batch) {
        expect(item.isNew, `${item.id} anima`).toBe(true);
        expect(item.index, `${item.id} no topo`).toBeLessThan(batch.length);
        live++;
      }
    }
    expect(live).toBeGreaterThan(20);
    expect(animations).toContain('slidein');

    // Os status mudam: um subagente aparece trabalhando e depois encerrado. Vale
    // olhar ao longo do tempo, porque com os tickets (T8) as encerradas de um
    // ticket anterior saem do cartão.
    const changed = [...new Set(states.map((/** @type {string} */ s) => s.split(' ')[0]))].filter((key) => {
      const working = states.findIndex((/** @type {string} */ s) => s.startsWith(`${key} inst working`));
      const finished = states.findLastIndex((/** @type {string} */ s) => s.startsWith(`${key} inst finished`));
      return working >= 0 && finished > working;
    });
    expect(changed.length, 'alguma instância passou de "trabalhando" a "encerrada"').toBeGreaterThan(0);
    await expect(page.locator('#party .member[data-agent="aux"]')).toBeVisible();
    await expect(page.locator('#session-select option:checked')).toContainText('encerrada');

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.csp).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('filtros por papel e por instância, pelos chips e pela equipe, com linhas chegando', async ({ page }) => {
    const base = `http://127.0.0.1:${port}`;
    const watch = await watchPage(page, base);
    await page.goto(`${base}/#guilda`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');
    const parts = scenarioParts();

    // Primeira parte: o orquestrador trabalha e chama dois subagentes (convidados).
    await inject(page, parts.first);
    const chips = page.locator('#feed-filters .chip');
    await expect(chips.first()).toHaveText('Todos');
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');

    // Chip do convidado: só as delegações a ele, por enquanto.
    await page.locator('#feed-filters [data-filter="role:aux"]').click();
    await expect(page.locator('#feed-filters [data-filter="role:aux"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
    let state = (await serverState(port)).sessions.find((s) => s.id === MAIN_SESSION);
    const auxKeys = () => new Set(state.agents.filter((/** @type {any} */ a) => a.role === 'aux').map((/** @type {any} */ a) => a.key));
    const isAux = (/** @type {any} */ e) => auxKeys().has(e.agentKey) || (e.kind === 'agent.delegated' && e.data?.toRole === 'aux');
    expect(await visibleIds(page)).toEqual(expectedIds(state, isAux));

    // Segunda parte com o filtro ligado (os dois convidados trabalhando): as
    // linhas deles entram visíveis e animadas no topo.
    let before = await shownIds(page);
    await recordPanel(page);
    state = await inject(page, parts.middle);
    expect(await visibleIds(page)).toEqual(expectedIds(state, isAux));
    await expect(page.locator('#feed-head')).toContainText(`${expectedIds(state, isAux).length} de ${state.feed.length} eventos`);
    let added = (await recorded(page)).batches.flat().filter((/** @type {any} */ item) => !before.has(item.id));
    expect(added.length).toBeGreaterThan(3);
    for (const item of added) expect(item.isNew, item.id).toBe(!item.hidden);

    // Teclado: Enter no "Todos" mostra tudo.
    await page.locator('#feed-filters [data-filter=""]').focus();
    await page.keyboard.press('Enter');
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
    expect(await visibleIds(page)).toEqual(expectedIds(state));

    // Instância (os convidados ainda trabalham): só as linhas dela; nenhum chip
    // apertado; de novo (Espaço) desfaz, e o foco fica no botão.
    const instance = page.locator('#party .member[data-agent="aux"] .inst-pick').first();
    const value = await instance.getAttribute('data-filter');
    const key = String(value).slice('agent:'.length);
    await instance.click();
    await expect(instance).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#feed-filters [aria-pressed="true"]')).toHaveCount(0);
    expect(await visibleIds(page)).toEqual(expectedIds(state, (e) => e.agentKey === key));
    await page.locator(`#party [data-filter="${value}"]`).focus();
    await page.keyboard.press('Space');
    await expect(page.locator(`#party [data-filter="${value}"]`)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(`#party [data-filter="${value}"]`)).toBeFocused();
    expect(await visibleIds(page)).toEqual(expectedIds(state));

    // Cartão da equipe: o bloco do papel alterna o filtro (clique no retrato).
    await page.locator('#party .member[data-agent="aux"] .avatar').click();
    await expect(page.locator('#party .member[data-agent="aux"]')).toHaveClass(/is-filter/);
    await expect(page.locator('#feed-filters [data-filter="role:aux"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await visibleIds(page)).toEqual(expectedIds(state, isAux));

    // O resto do cenário com o filtro ligado: as linhas do convidado entram
    // animadas; as outras, escondidas e sem animação. O foco num botão da
    // equipe, que é redesenhado a cada update, não se perde.
    await page.locator('#party [data-filter="role:orq"]').focus();
    before = await shownIds(page);
    await recordPanel(page);
    state = await inject(page, parts.last);
    expect(await visibleIds(page)).toEqual(expectedIds(state, isAux));
    added = (await recorded(page)).batches.flat().filter((/** @type {any} */ item) => !before.has(item.id));
    for (const item of added) expect(item.isNew, item.id).toBe(!item.hidden);
    expect(added.some((/** @type {any} */ item) => item.hidden), 'linhas fora do filtro').toBe(true);
    expect(added.some((/** @type {any} */ item) => !item.hidden), 'linhas do filtro').toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-filter'))).toBe('role:orq');
    await page.locator('#party [data-filter="role:aux"]').click();
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');

    // Chip do documentador: a delegação a ele, as linhas dele e a etapa dele.
    await page.locator('#feed-filters [data-filter="role:doc"]').click();
    const docLines = expectedIds(state, (e) => state.agents.some((/** @type {any} */ a) => a.key === e.agentKey && a.role === 'doc')
      || (e.kind === 'agent.delegated' && e.data?.toRole === 'doc') || (e.kind === 'quest.phase' && e.data?.phase === 'docs'));
    expect(await visibleIds(page)).toEqual(docLines);

    // Sem rolagem horizontal com os chips, em tela estreita.
    await page.setViewportSize({ width: 360, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('clique na equipe não se perde quando um update redesenha o cartão no meio do clique', async ({ page }) => {
    const base = `http://127.0.0.1:${port}`;
    await page.goto(`${base}/#escritorio`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');
    const parts = scenarioParts();
    await inject(page, parts.first, { fast: true });

    const button = page.locator('#party [data-filter="role:orq"]');
    // O main.js segura a região por no máximo 1,5 s (HOLD_MAX_MS). Sob carga, o
    // update pode chegar depois disso, e aí o teste não mede o que promete: a
    // tentativa é descartada e refeita com os eventos seguintes (ADR 0010,
    // "uma nova tentativa em caso de ruído da máquina": falhar duas vezes
    // seguidas é bug).
    const HOLD_BUDGET_MS = 1_200;
    /** @type {number[]} */
    const slow = [];
    let verified = false;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      const box = await button.boundingBox();
      if (!box) throw new Error('botão do orquestrador sem caixa');
      const partyBefore = await page.locator('#party').innerHTML();
      const count = await page.locator('#feed-entries li.entry').count();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      const pressedAt = Date.now();
      // Com o botão apertado chegam eventos que mudam a equipe (o feed cresce).
      const events = parts.rest.events.slice(attempt * 6, attempt * 6 + 6);
      await injectScenario(/** @type {any} */ ({ events }), { port, token: server?.token ?? '', fast: true });
      await expect.poll(async () => page.locator('#feed-entries li.entry').count(), { intervals: [20, 40, 80] }).toBeGreaterThan(count);
      const held = Date.now() - pressedAt;
      await page.mouse.up();
      if (held > HOLD_BUDGET_MS) {
        slow.push(held);
        // Limpa o que a tentativa possa ter ligado e tenta de novo.
        await page.locator('#feed-filters [data-filter=""]').click();
        await expect(button).toHaveAttribute('aria-pressed', 'false');
        continue;
      }
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#feed-filters [data-filter="role:orq"]')).toHaveAttribute('aria-pressed', 'true');
      // Solto o botão, o cartão volta a acompanhar os updates.
      expect(await page.locator('#party').innerHTML()).not.toBe(partyBefore);
      verified = true;
    }
    expect(verified, `o update demorou mais que ${HOLD_BUDGET_MS} ms nas duas tentativas (${slow.join(', ')} ms)`).toBe(true);
  });

  test('parando o servidor, o selo vai para "reconectando"; religando, o painel se recupera', async ({ page }) => {
    const base = `http://127.0.0.1:${port}`;
    const watch = await watchPage(page, base);
    await page.goto(`${base}/#escritorio`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');
    await page.evaluate(() => { /** @type {any} */ (window).__sameDocument = true; });
    const parts = scenarioParts();
    await inject(page, parts.first, { fast: true });
    await expect(page.locator('#party .member[data-agent="aux"]')).toBeVisible();

    await server?.stop();
    await expect(page.locator('#conn')).toHaveText('reconectando');
    await expect(page.locator('#conn .conn')).toHaveClass(/conn-reconnecting/);

    // Mesmo endereço, servidor novo: o estado recomeça vazio (ADR 0005) e volta
    // pelo snapshot; os eventos seguintes aparecem.
    server = await startServer(port, home);
    await expect(page.locator('#conn')).toHaveText('ao vivo', { timeout: 15_000 });
    await expect(page.locator('.onboarding')).toBeVisible();
    await expect(page.locator('#feed-entries li.entry')).toHaveCount(0);
    await inject(page, parts.first, { fast: true });
    await expect(page.locator('#session-select')).toHaveValue(MAIN_SESSION);
    await expect(page.locator('#party .member[data-agent="aux"]')).toBeVisible();
    expect(await page.evaluate(() => /** @type {any} */ (window).__sameDocument)).toBe(true);

    expect(await watch.violations()).toEqual([]);
    expect(watch.problems.errors).toEqual([]);
    expect(watch.problems.external).toEqual([]);
  });

  test('com movimento reduzido, as linhas novas entram sem animação', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const base = `http://127.0.0.1:${port}`;
    await page.goto(`${base}/#escritorio`);
    await expect(page.locator('#conn')).toHaveText('ao vivo');
    await recordPanel(page);
    await inject(page, scenarioParts().first, { speed: 4 });
    const { batches, animations } = await recorded(page);
    expect(batches.flat().length).toBeGreaterThan(5);
    expect(animations).toEqual([]);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});
