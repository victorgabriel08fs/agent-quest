// Integração do T2 (tester): createApp com raízes temporárias de web/ e shared/,
// servidor HTTP real em 127.0.0.1 e porta livre.
//
// Cobre o que o web/ do repositório ainda não tem (o painel chega no T10a):
// tipos MIME de cada extensão, módulo em web/js/ importando o contrato por
// caminho relativo, e link de diretório (junction, que no Windows não exige
// permissão especial) apontando para fora da raiz.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../../server/http/app.js';
import { ADR_HEADERS, request, tempDir } from './server-helpers.js';

describe('T2 integração: estáticos com raízes temporárias', () => {
  const tmp = tempDir('aq-int-static-');
  const webDir = path.join(tmp.dir, 'web');
  const sharedDir = path.join(tmp.dir, 'shared');
  const outside = path.join(tmp.dir, 'fora');
  let server;
  let port;
  const errors = [];

  const files = {
    'index.html': '<!doctype html><title>t</title>',
    'css/base.css': 'body{}',
    'js/main.js': "import { X } from '../../shared/contract.js';\nexport const Y = X;\n",
    'js/themes/guilda.js': "import { X } from '../../../shared/contract.js';\nexport const Z = X;\n",
    'dados.json': '{"a":1}',
    'img/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'img/b.png': 'png',
    'img/c.GIF': 'gif',
    'img/d.jpg': 'jpg',
    'img/e.webp': 'webp',
    'favicon.ico': 'ico',
    'fonts/f.woff2': 'woff2',
    'leia.txt': 'texto',
    'mod.mjs': 'export {};',
    'pasta com espaço/ação.css': 'p{}',
    'segredo.env': 'NAO=SERVIR',
    'mapa.js.map': '{}',
  };

  before(async () => {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(webDir, ...name.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(path.join(sharedDir, 'contract.js'), 'export const X = 42;\n');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'segredo.js'), 'SEGREDO-FORA-DA-RAIZ');
    // Link de diretório para fora da raiz. No Windows vira junction (sem privilégio).
    symlinkSync(outside, path.join(webDir, 'atalho'), 'junction');
    symlinkSync(outside, path.join(sharedDir, 'atalho'), 'junction');

    ({ server } = createApp({ version: '0.0.0-teste', startedAt: 1, webDir, sharedDir, logError: (m) => errors.push(m) }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    tmp.cleanup();
  });

  it('cada extensão sai com o tipo MIME certo, com no-cache e os cabeçalhos do ADR 0006', async () => {
    const expected = {
      '/': 'text/html; charset=utf-8',
      '/css/base.css': 'text/css; charset=utf-8',
      '/js/main.js': 'text/javascript; charset=utf-8',
      '/mod.mjs': 'text/javascript; charset=utf-8',
      '/dados.json': 'application/json; charset=utf-8',
      '/leia.txt': 'text/plain; charset=utf-8',
      '/img/a.svg': 'image/svg+xml',
      '/img/b.png': 'image/png',
      '/img/c.GIF': 'image/gif',
      '/img/d.jpg': 'image/jpeg',
      '/img/e.webp': 'image/webp',
      '/favicon.ico': 'image/x-icon',
      '/fonts/f.woff2': 'font/woff2',
      '/pasta%20com%20espa%C3%A7o/a%C3%A7%C3%A3o.css': 'text/css; charset=utf-8',
      '/shared/contract.js': 'text/javascript; charset=utf-8',
    };
    for (const [p, type] of Object.entries(expected)) {
      const res = await request(port, { path: p });
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['content-type'], type, p);
      assert.equal(res.headers['cache-control'], 'no-cache', p);
      for (const [name, value] of Object.entries(ADR_HEADERS)) assert.equal(res.headers[name], value, `${p}: ${name}`);
    }
  });

  it('extensões fora da lista recebem 404', async () => {
    for (const p of ['/segredo.env', '/mapa.js.map']) {
      assert.equal((await request(port, { path: p })).status, 404, p);
    }
  });

  it('módulo em web/js/ e em web/js/themes/: o import relativo do contrato chega em /shared/contract.js', async () => {
    for (const [modulePath, specifier] of [
      ['/js/main.js', '../../shared/contract.js'],
      ['/js/themes/guilda.js', '../../../shared/contract.js'],
    ]) {
      const mod = await request(port, { path: modulePath });
      assert.equal(mod.status, 200, modulePath);
      assert.ok(mod.text.includes(specifier), modulePath);
      const target = new URL(specifier, `http://127.0.0.1:${port}${modulePath}`).pathname;
      assert.equal(target, '/shared/contract.js', modulePath);
      // Como o navegador pede um módulo: Origin da própria origem e Sec-Fetch-Site same-origin.
      const dep = await request(port, {
        path: target,
        headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' },
      });
      assert.equal(dep.status, 200);
      assert.equal(dep.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal(dep.text, 'export const X = 42;\n');
    }
  });

  it('link de diretório (junction) para fora da raiz não vaza o arquivo', async () => {
    for (const p of ['/atalho/segredo.js', '/shared/atalho/segredo.js']) {
      const res = await request(port, { path: p });
      assert.ok([403, 404].includes(res.status), `${p}: ${res.status}`);
      assert.doesNotMatch(res.text, /SEGREDO-FORA-DA-RAIZ/, p);
    }
  });

  it('nenhum erro inesperado registrado', () => {
    assert.deepEqual(errors, []);
  });
});
