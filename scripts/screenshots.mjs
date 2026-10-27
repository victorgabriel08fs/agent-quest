// @ts-check
// Prints do README (T17): `node scripts/screenshots.mjs`.
//
// Gera as imagens de docs/imagens/ com o Playwright que já é devDependency
// (@playwright/test, Microsoft Edge instalado, channel 'msedge'), sem
// dependência nova e fora do `npm run test:e2e` (é lento e grava arquivos).
//
// Regras (plano, T17):
// - só cenários sintéticos injetados pelo injetor do T9b (o mesmo caminho do
//   `npm run inject`: POST /hooks com o token do runtime.json), montados aqui
//   com o apoio dos E2E (test/e2e/qa-live.js); nunca sessões reais;
// - servidor real só deste script, numa porta livre, com AGENT_QUEST_HOME,
//   USERPROFILE e HOME numa pasta temporária (nunca a 47821 nem o diretório
//   de dados real). A pasta temporária recebe os agentes do time em
//   `.claude/agents/` (só os nomes, para a equipe completa) e transcripts
//   sintéticos em `.claude/projects/`, para a barra de contexto aparecer;
// - pastas de projeto fictícias (D:\projetos\...), sem pasta pessoal;
// - 1280 px de largura, os dois temas, cada imagem até 1 MB (conferido no fim).
//
// As animações ficam desligadas (prefers-reduced-motion e `animations:
// 'disabled'` no print), para o resultado não depender do momento da captura.

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createScenario, inject, startLiveServer, waitFor, waitPanelFeed } from '../test/e2e/qa-live.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(REPO, 'docs', 'imagens');
const WIDTH = 1280;
const HEIGHT = 960;
const MAX_BYTES = 1024 * 1024;

const PROJECT = 'D:\\projetos\\agents-quest';
const OTHER_PROJECT = 'D:\\projetos\\loja-exemplo';
const TEAM = ['arquiteto', 'dev-backend', 'dev-frontend', 'tester', 'documentador'];

/** Saída de `node --test` com falhas (só números). */
const FAILED_RUN = [
  'Exit code 1',
  'ℹ tests 42', 'ℹ suites 0', 'ℹ pass 40', 'ℹ fail 2', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 1834.5',
].join('\n');

/**
 * Resposta sintética de transcript com o uso indicado (formato da seção 6).
 * @param {{ sessionId: string, tokens: number, model: string, n: number, agentId?: string }} params
 */
function transcriptLine({ sessionId, tokens, model, n, agentId }) {
  return JSON.stringify({
    type: 'assistant', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, sessionId,
    isSidechain: Boolean(agentId), timestamp: new Date().toISOString(),
    message: {
      id: `msg_01SINTETICO${n}`, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: 'RESPOSTA-SINTETICA' }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 10, output_tokens: 50 },
    },
    ...(agentId ? { agentId } : {}),
  }) + '\n';
}

/** Pasta pessoal temporária com os agentes do time (só os nomes dos arquivos importam). */
function prepareHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'aq-prints-'));
  const agents = path.join(home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  for (const name of TEAM) writeFileSync(path.join(agents, `${name}.md`), `---\nname: ${name}\ndescription: agente fictício\n---\n`);
  return home;
}

/**
 * Cenário principal: ticket com as etapas, o arquiteto já na copa, dois devs em
 * paralelo e o tester com testes falhando; uma falha de comando no dev.
 * @param {string} transcriptDir
 */
function mainScenario(transcriptDir) {
  const s = createScenario({ label: 'readme-principal', projectDir: PROJECT, transcriptDir });
  const arq = s.agent('arquiteto', 'arquiteto');
  const back = s.agent('dev-backend', 'dev-backend');
  const front = s.agent('dev-frontend', 'dev-frontend');
  const tester = s.agent('tester', 'tester');

  // Transcripts sintéticos: a sessão principal (janela de 1 milhão) e os
  // subagentes ainda em andamento (família com 200 mil).
  const dir = path.join(transcriptDir, s.sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(s.transcriptPath, transcriptLine({ sessionId: s.sessionId, tokens: 312_000, model: 'claude-opus-5-5', n: 1 }));
  const sub = [[back, 84_000, 2], [front, 121_000, 3], [tester, 36_000, 4]];
  for (const [agent, tokens, n] of /** @type {[any, number, number][]} */ (sub)) {
    writeFileSync(path.join(dir, `agent-${agent.id}.jsonl`), transcriptLine({ sessionId: s.sessionId, tokens, model: 'claude-sonnet-4-5', n, agentId: agent.id }));
  }

  s.start().prompt('Exportar o relatório de vendas em CSV');
  s.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
  s.tool('Grep', { pattern: 'relatorio', path: `${PROJECT}\\server` });

  const arqCall = s.delegate(arq, 'Desenhar o formato do CSV');
  s.tool('Read', { file_path: `${PROJECT}\\docs\\arquitetura\\visao-geral.md` }, { agent: arq });
  s.tool('Write', { file_path: `${PROJECT}\\docs\\adr\\0012-exportacao-csv.md`, content: 'CONTEUDO-FICTICIO' }, { agent: arq });
  s.finish(arq, arqCall);

  s.delegate(back, 'Gerar o CSV no servidor');
  s.delegate(front, 'Botão de exportar no painel');
  s.tool('Read', { file_path: `${PROJECT}\\server\\reports\\sales.js` }, { agent: back });
  s.tool('Write', { file_path: `${PROJECT}\\web\\js\\views\\export.js`, content: 'CONTEUDO-FICTICIO' }, { agent: front });
  s.tool('Edit', { file_path: `${PROJECT}\\server\\reports\\csv.js`, old_string: 'A', new_string: 'B' }, { agent: back });
  s.tool('Bash', { command: 'npm run lint', description: 'Confere o estilo do código' }, { agent: back, error: 'Exit code 1\n2 problemas encontrados em server/reports/csv.js' });
  s.tool('Edit', { file_path: `${PROJECT}\\web\\css\\layout.css`, old_string: 'A', new_string: 'B' }, { agent: front });

  s.delegate(tester, 'Testar a exportação');
  s.tool('Read', { file_path: `${PROJECT}\\test\\unit\\reports\\csv.test.js` }, { agent: tester });
  s.tool('Bash', { command: 'npm test', description: 'Roda a suíte de testes' }, { agent: tester, error: FAILED_RUN });
  s.tool('Edit', { file_path: `${PROJECT}\\server\\reports\\csv.js`, old_string: 'C', new_string: 'D' }, { agent: back });

  // Ações em andamento no fim (os balões da cena).
  s.pre('Edit', { file_path: `${PROJECT}\\server\\reports\\csv.js`, old_string: 'E', new_string: 'F' }, back);
  s.pre('Write', { file_path: `${PROJECT}\\web\\js\\views\\export.test.js`, content: 'CONTEUDO-FICTICIO' }, front);
  s.pre('Read', { file_path: `${PROJECT}\\test\\unit\\reports\\csv.test.js` }, tester);

  // Intervalos reais entre os eventos (cerca de 1 min no total), para o ticket
  // e a sessão não aparecerem com duração zero.
  s.events.forEach((event, index) => { event.dt = index === 0 ? 0 : 600 + ((index * 389) % 1100); });
  return s;
}

/** Outra sessão do mesmo projeto, já encerrada. */
function endedScenario() {
  const s = createScenario({ label: 'readme-encerrada', projectDir: PROJECT });
  s.start().prompt('Revisar o guia de instalação');
  s.tool('Read', { file_path: `${PROJECT}\\README.md` });
  s.stop().end();
  return s;
}

/** Sessão de outro projeto, com um pedido de aprovação pendente. */
function waitingScenario() {
  const s = createScenario({ label: 'readme-aprovacao', projectDir: OTHER_PROJECT, entrypoint: 'claude-vscode' });
  const dev = s.agent('dev-backend', 'dev-backend');
  s.start().prompt('Corrigir o cálculo do frete');
  s.delegate(dev, 'Ajustar a regra do frete');
  s.tool('Read', { file_path: `${OTHER_PROJECT}\\src\\frete.js` }, { agent: dev });
  s.permission(s.pre('Bash', { command: 'npm install' }, dev));
  return s;
}

/** @param {any} state @param {string} id */
const sessionOf = (state, id) => state.sessions.find((/** @type {any} */ x) => x.id === id);

/**
 * Grava o print e confere o tamanho.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {{ fullPage?: boolean, clip?: { x: number, y: number, width: number, height: number } }} [options]
 */
async function shot(page, name, { fullPage = false, clip } = {}) {
  const file = path.join(OUT, name);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: file, fullPage, clip, animations: 'disabled', caret: 'hide' });
  return file;
}

/**
 * Espera o painel mostrar a sessão e as barras de contexto.
 * @param {import('@playwright/test').Page} page
 * @param {any} session
 * @param {number} bars
 */
async function waitPanel(page, session, bars) {
  await waitPanelFeed(page, session);
  await waitFor(async () => (await page.locator('#party .mbar.mana').count()) === bars, `${bars} barras de contexto`, 20_000);
  await page.evaluate(() => document.fonts.ready);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const home = prepareHome();
  const server = await startLiveServer({ home });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  /** @type {string[]} */
  const written = [];
  let center = { x: 0, y: 0, width: 0, height: 0 };
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    /** @type {string[]} */
    const external = [];
    page.on('request', (request) => { if (!request.url().startsWith(server.base) && !request.url().startsWith('data:')) external.push(request.url()); });

    // 1. Painel sem sessões, com a linha do último evento.
    await page.goto(`${server.base}/#escritorio`);
    await page.locator('.onboarding .health[data-state="ok"]').waitFor();
    written.push(await shot(page, 'painel-sem-sessoes.png'));

    // 2. Cenário principal nos dois temas.
    const transcriptDir = path.join(home, '.claude', 'projects', 'D--projetos-agents-quest');
    mkdirSync(transcriptDir, { recursive: true });
    const principal = mainScenario(transcriptDir);
    const state = await inject(server, principal, { fast: false });
    const session = sessionOf(state, principal.sessionId);
    await waitPanel(page, session, 4);
    await page.locator('.scene .bug').first().waitFor();
    written.push(await shot(page, 'painel-escritorio.png'));
    // Coluna do meio (ticket e cena), com uma folga, para o lado a lado.
    const top = await page.locator('#quest-slot').boundingBox();
    const bottom = await page.locator('.scene-card').boundingBox();
    if (!top || !bottom) throw new Error('ticket ou cena ausentes');
    center = {
      x: Math.round(top.x) - 8, y: Math.round(top.y) - 8,
      width: Math.round(top.width) + 16, height: Math.round(bottom.y + bottom.height - top.y) + 16,
    };

    await page.locator('#theme-toggle button[data-theme="guilda"]').click();
    await page.locator('html[data-theme="guilda"]').waitFor({ state: 'attached' });
    written.push(await shot(page, 'painel-guilda.png'));

    // 3. Modo discreto (Escritório).
    await page.locator('#theme-toggle button[data-theme="escritorio"]').click();
    await page.locator('#btn-discreet').click();
    await page.locator('#btn-discreet[aria-pressed="true"]').waitFor({ state: 'attached' });
    written.push(await shot(page, 'painel-modo-discreto.png'));
    await page.locator('#btn-discreet').click();
    await page.locator('#btn-discreet[aria-pressed="false"]').waitFor({ state: 'attached' });

    // 4. Seletor: duas sessões em agents-quest e uma em loja-exemplo aguardando aprovação.
    await inject(server, endedScenario());
    const waiting = waitingScenario();
    await inject(server, waiting);
    await page.locator('#session-select').selectOption(principal.sessionId);
    await page.locator('#session-alert').filter({ hasText: /aprova/i }).waitFor();
    // A lista nativa do <select> aberta é uma janela do sistema e não sai no
    // print da página. Só para este print, o <select> ganha `appearance:
    // base-select` (o próprio navegador desenha a lista dentro da página, com
    // as mesmas opções e grupos), por uma folha construída (a CSP do painel
    // não se aplica a ela); o código do painel não muda.
    // A lista abre logo abaixo do aviso, para os dois aparecerem.
    await page.evaluate(() => {
      const select = /** @type {HTMLElement} */ (document.getElementById('session-select'));
      const alert = /** @type {HTMLElement} */ (document.getElementById('session-alert'));
      const gap = Math.max(0, Math.round(alert.getBoundingClientRect().bottom - select.getBoundingClientRect().bottom + 6));
      const width = Math.round(select.getBoundingClientRect().width);
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`
        #session-select, #session-select::picker(select) { appearance: base-select; }
        #session-select { width: ${width}px; padding: 1px 6px; white-space: nowrap; overflow: hidden; }
        #session-select::picker-icon { font-size: 9px; padding-left: 4px; }
        #session-select::picker(select) { margin-top: ${gap}px; padding: 4px 0; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 32px rgb(0 0 0 / .18); }
        #session-select optgroup { padding: 2px 0; font-weight: 700; }
        #session-select option { padding: 4px 14px 4px 18px; font-weight: 500; }
        #session-select option:checked { background: var(--accent-soft); }
        #session-select option::checkmark { display: none; }
      `);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    await page.locator('#session-select').click();
    await page.locator('#session-select:open').waitFor({ state: 'attached' });
    written.push(await shot(page, 'painel-seletor-de-sessoes.png', { clip: { x: 0, y: 0, width: WIDTH, height: 400 } }));
    await context.close();

    // 5. Os dois temas lado a lado: o ticket e a cena de cada um (a coluna do
    // meio do painel, em escala 1:1), montados no próprio navegador.
    const compose = await browser.newPage({ viewport: { width: WIDTH, height: 400 }, deviceScaleFactor: 1 });
    const img = (/** @type {string} */ name) => `data:image/png;base64,${readFileSync(path.join(OUT, name)).toString('base64')}`;
    const crop = (/** @type {string} */ name) =>
      `<div style="width:${center.width}px;height:${center.height}px;overflow:hidden;border-radius:12px;flex:none">` +
      `<img alt="" style="display:block;margin:${-center.y}px 0 0 ${-center.x}px" src="${img(name)}"></div>`;
    await compose.setContent(
      `<!doctype html><html><body style="margin:0;background:#8b8fa3;display:flex;justify-content:center;gap:16px;padding:16px 0;width:${WIDTH}px">` +
      crop('painel-escritorio.png') + crop('painel-guilda.png') +
      `</body></html>`);
    await compose.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    written.push(await shot(compose, 'temas-lado-a-lado.png', { fullPage: true }));

    if (external.length > 0) throw new Error(`requisições para fora: ${external.join(', ')}`);
  } finally {
    await browser.close();
    await server.dispose();
  }

  let ok = true;
  for (const file of written) {
    const size = statSync(file).size;
    const flag = size <= MAX_BYTES ? 'ok' : 'ACIMA DE 1 MB';
    if (size > MAX_BYTES) ok = false;
    console.log(`${path.relative(REPO, file).split(path.sep).join('/')}  ${(size / 1024).toFixed(0)} KB  ${flag}`);
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
