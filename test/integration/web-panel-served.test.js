// Integração do T10a (tester): o painel servido pelo servidor real
// (`node server/main.js --port 0`, AGENT_QUEST_HOME temporário).
//
// Percorre, pelo HTTP de verdade, tudo o que o navegador pede ao abrir o painel:
// os recursos do index.html e o grafo de módulos a partir de /js/main.js,
// resolvendo cada import como o navegador resolve (URL relativa ao módulo).
// Cada resposta precisa vir com 200, o tipo MIME certo (o nosniff do ADR 0006
// recusa módulo com tipo errado), a CSP e os cabeçalhos do ADR 0006 e o
// Cache-Control: no-cache dos estáticos, e nada pode apontar para outra origem.
// Também confere a forma do /api/health que o painel sem sessões usa.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ADR_HEADERS, REPO, killTree, launchServer, minimalEnv, request, tempDir } from './server-helpers.js';

/** Tipo esperado por extensão (independente da tabela do servidor). */
const EXPECTED_TYPE = {
  '.html': /^text\/html\b/,
  '.js': /^text\/javascript\b/,
  '.css': /^text\/css\b/,
  '.svg': /^image\/svg\+xml\b/,
};

/** Entregas do T10a que precisam estar no grafo do painel. */
const T10A_URLS = [
  '/',
  '/favicon.svg',
  '/css/base.css',
  '/css/themes.css',
  '/css/layout.css',
  '/css/scene.css',
  '/js/main.js',
  '/js/selectors.js',
  '/js/views/topbar.js',
  '/js/views/party.js',
  '/js/views/quest.js',
  '/js/views/feed.js',
  '/js/views/empty.js',
  '/js/themes/contract.js',
  '/js/themes/helpers.js',
  '/js/themes/escritorio.js',
  '/js/themes/guilda.js',
  '/shared/contract.js',
];

/** Especificadores de import estático, reexportação e import() literal. */
function importSpecifiers(js) {
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = new Set();
  for (const m of code.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  return [...specs];
}

/** Arquivo no disco para uma URL do painel (visão geral, "Rotas e mapeamento de URL"). */
function fileFor(urlPath) {
  if (urlPath === '/') return path.join(REPO, 'web', 'index.html');
  if (urlPath.startsWith('/shared/')) return path.join(REPO, 'shared', ...urlPath.slice('/shared/'.length).split('/'));
  return path.join(REPO, 'web', ...urlPath.slice(1).split('/'));
}

describe('T10a integração: painel servido pelo servidor real', () => {
  const home = tempDir('aq-int-panel-');
  let run;
  let port;
  let origin;
  /** url → { status, headers, text, body, from } */
  const crawled = new Map();
  const foreign = [];

  before(async () => {
    run = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: home.dir }));
    assert.equal(await run.started, true, run.output());
    port = JSON.parse(readFileSync(path.join(home.dir, 'runtime.json'), 'utf8')).port;
    origin = `http://127.0.0.1:${port}`;

    // Percorre a página como o navegador: index.html → link/script → imports.
    const queue = [{ url: '/', from: '(navegação)' }];
    while (queue.length) {
      const { url, from } = queue.shift();
      if (crawled.has(url)) continue;
      const res = await request(port, { path: url, headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': url === '/' ? 'none' : 'same-origin' } });
      crawled.set(url, { ...res, from });
      if (res.status !== 200) continue;
      const refs = [];
      if (url === '/') {
        for (const m of res.text.matchAll(/\s(?:src|href)="([^"]+)"/g)) refs.push(m[1]);
      } else if (url.endsWith('.js')) {
        refs.push(...importSpecifiers(res.text));
      } else if (url.endsWith('.css')) {
        for (const m of res.text.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g)) refs.push(m[1]);
        for (const m of res.text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) if (!m[1].startsWith('data:')) refs.push(m[1]);
      }
      for (const ref of refs) {
        const resolved = new URL(ref, `${origin}${url}`);
        if (resolved.origin !== origin) {
          foreign.push(`${url} → ${ref}`);
          continue;
        }
        queue.push({ url: resolved.pathname, from: url });
      }
    }
  });

  after(async () => {
    if (run) await killTree(run.child);
    home.cleanup();
  });

  it('nenhum recurso da página nem import aponta para outra origem', () => {
    assert.deepEqual(foreign, []);
  });

  it('o grafo da página inclui todas as entregas do T10a, inclusive /shared/contract.js pelo import relativo', () => {
    const urls = [...crawled.keys()];
    for (const url of T10A_URLS) assert.ok(urls.includes(url), `${url} não é pedido pela página (pedidos: ${urls.join(' ')})`);
  });

  it('todo recurso do grafo responde 200, com o tipo MIME certo e igual ao arquivo do disco', () => {
    for (const [url, res] of crawled) {
      assert.equal(res.status, 200, `${url} (pedido por ${res.from}) respondeu ${res.status}`);
      const ext = url === '/' ? '.html' : path.extname(url);
      const expected = EXPECTED_TYPE[ext];
      assert.ok(expected, `${url}: extensão ${ext} inesperada no painel`);
      assert.match(String(res.headers['content-type']), expected, url);
      assert.ok(res.body.equals(readFileSync(fileFor(url))), `${url}: corpo diferente do arquivo`);
    }
  });

  it('todo recurso do grafo tem a CSP e os cabeçalhos do ADR 0006, com no-cache', () => {
    for (const [url, res] of crawled) {
      for (const [name, value] of Object.entries(ADR_HEADERS)) assert.equal(res.headers[name], value, `${url}: ${name}`);
      assert.equal(res.headers['cache-control'], 'no-cache', url);
      assert.ok(!Object.keys(res.headers).some((h) => h.startsWith('access-control-')), `${url}: cabeçalho CORS`);
    }
  });

  it('a CSP não abre exceção para script ou estilo inline (o painel não precisa)', () => {
    const csp = crawled.get('/').headers['content-security-policy'];
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|nonce-|sha256-/);
  });

  it('o index.html não carrega nada além de arquivos do próprio servidor', () => {
    const html = crawled.get('/').text;
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, 'script inline');
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i);
  });

  it('/api/health tem o que o painel sem sessões mostra (startedAt e lastEventAt null antes do primeiro evento)', async () => {
    const res = await request(port, { path: '/api/health', headers: { 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json' } });
    assert.equal(res.status, 200);
    const health = JSON.parse(res.text);
    assert.equal(health.ok, true);
    assert.equal(typeof health.startedAt, 'number');
    assert.equal(health.lastEventAt, null);
  });

  it('o painel por localhost:<porta> também é servido', async () => {
    const res = await request(port, { path: '/js/main.js', headers: { Host: `localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(res.status, 200);
  });
});
