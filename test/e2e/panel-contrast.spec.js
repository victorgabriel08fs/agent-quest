// @ts-check
// Contraste WCAG 2.2 AA dos elementos novos do T11b, medido no Edge com as
// cores que o navegador calculou (color-mix, translúcidos e a cascata real),
// nos dois temas (complemento do ADR 0009):
// - texto: 4,5:1 contra o fundo composto em que aparece (chips, contagem,
//   mensagem de vazio, nome do papel, papel real, ação e rótulo da instância),
//   em repouso, com o mouse em cima e apertado;
// - indicador de foco (contorno): 3:1 contra o fundo ao redor.
// O estado "apertado" do chip de papel (borda e anel na cor do papel) é medido
// e anotado: é um desvio declarado pelo dev, que o arquiteto ainda confere.

import { expect, test } from '@playwright/test';
import { createScenario, inject, measure, measureIndicator, startLiveServer, waitPanelFeed } from './qa-live.js';

/** @typedef {import('./qa-live.js').LiveServer} LiveServer */

const FILE = (/** @type {string} */ name) => `C:\\Users\\fulano\\Projetos\\agents-quest\\${name}`;

/** Sessão com todos os papéis (inclusive convidado) e um agente aguardando não é possível sem o T8; ficam os demais estados. */
function allRolesScenario() {
  const s = createScenario({ label: 'contraste' });
  const agents = {
    arq: s.agent('arq', 'arquiteto'),
    dev: s.agent('dev', 'dev-backend'),
    tes: s.agent('tes', 'tester'),
    doc: s.agent('doc', 'documentador'),
    aux: s.agent('aux', 'Explore'),
  };
  s.start().prompt('Contraste');
  s.tool('Read', { file_path: FILE('README.md') });
  for (const agent of Object.values(agents)) {
    s.delegate(agent, `Tarefa do ${agent.type}`);
    s.tool('Read', { file_path: FILE(`${agent.type}.md`) }, { agent });
  }
  // Instância sem linha própria, para a mensagem de vazio.
  const idle = s.agent('aux2', 'Plan');
  s.delegate(idle, 'Sem ação ainda');
  return { s, agents, idle };
}

test.describe('contraste dos elementos novos (tester)', () => {
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

  for (const themeId of ['escritorio', 'guilda']) {
    test(`${themeId}: texto dos chips, contagem, vazio e botões da equipe com pelo menos 4,5:1; foco com pelo menos 3:1`, async ({ page }) => {
      if (!server) throw new Error('sem servidor');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const { s, agents, idle } = allRolesScenario();
      await page.goto(`${server.base}/#${themeId}`);
      const state = await inject(server, s);
      await waitPanelFeed(page, state.sessions.find((x) => x.id === s.sessionId));

      const TEXT = ['#feed-filters .chip:not(.chip-ag)', '#feed-head .muted', '#feed-empty', '#party .m-pick', '#party .m-role', '#party .inst-pick .m-action', '#party .inst-pick .i-label', '#party .inst-pick .i-type'];
      /** @type {{ state: string, selector: string, text: string, ratio: number }[]} */
      const all = [];
      const take = async (/** @type {string} */ label) => {
        for (const r of await page.evaluate(measure, TEXT)) all.push({ state: label, ...r });
      };

      await take('repouso');
      await page.locator('#feed-filters .chip:not(.chip-ag)').hover();
      await take('chip "Todos" com o mouse em cima');
      for (const [role, agent] of Object.entries(agents)) {
        // Papel apertado (bloco tingido) e o mouse em cima de outro bloco.
        await page.locator(`#party [data-filter="role:${role}"]`).click();
        await take(`papel ${role} apertado`);
        await page.locator('#party .member[data-agent="orq"]').hover();
        await take(`papel ${role} apertado, mouse no orquestrador`);
        // Instância apertada e com o mouse em cima.
        await page.locator(`#party [data-filter="agent:${agent.id}"]`).click();
        await page.locator(`#party [data-filter="agent:${agent.id}"]`).hover();
        await take(`instância ${role} apertada, mouse em cima`);
        await page.locator(`#party [data-filter="agent:${agent.id}"]`).click();
      }
      // Instância sem linha própria: mensagem de vazio e "0 de N".
      await page.locator(`#party [data-filter="agent:${idle.id}"]`).click();
      await expect(page.locator('#feed-empty')).toBeVisible();
      await take('instância sem linha (vazio)');
      await page.locator('#feed-filters [data-filter=""]').click();

      expect(all.length).toBeGreaterThan(40);
      expect(new Set(all.map((r) => r.selector)).size).toBe(TEXT.length);
      const failing = all.filter((r) => r.ratio < 4.5);
      const lowest = all.reduce((min, r) => (r.ratio < min.ratio ? r : min));
      console.log(`[contraste ${themeId}] menor texto: ${JSON.stringify(lowest)}`);
      test.info().annotations.push({ type: 'menor contraste de texto', description: JSON.stringify(lowest) });
      expect(failing).toEqual([]);

      // Foco visível (contorno) nos botões novos.
      for (const selector of ['#feed-filters .chip:not(.chip-ag)', '#feed-filters .chip-ag[data-filter="role:doc"]', '#party [data-filter="role:dev"]', `#party [data-filter="agent:${agents.tes.id}"]`]) {
        await page.locator(selector).focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        const focusRatio = await page.evaluate(measureIndicator, { selector, property: /** @type {const} */ ('outlineColor') });
        console.log(`[contraste ${themeId}] foco em ${selector}: ${focusRatio}`);
        expect(focusRatio, `foco em ${selector}`).toBeGreaterThanOrEqual(3);
      }

      // Borda do chip de papel apertado (desvio declarado): só medida e anotada.
      /** @type {Record<string, number|null>} */
      const borders = {};
      for (const role of Object.keys(agents).concat('orq')) {
        await page.locator(`#feed-filters [data-filter="role:${role}"]`).click();
        await page.mouse.move(0, 0);
        borders[role] = await page.evaluate(measureIndicator, { selector: `#feed-filters [data-filter="role:${role}"]`, property: /** @type {const} */ ('borderTopColor') });
      }
      console.log(`[contraste ${themeId}] borda do chip apertado: ${JSON.stringify(borders)}`);
      test.info().annotations.push({ type: `borda do chip apertado (${themeId})`, description: JSON.stringify(borders) });
    });
  }
});
