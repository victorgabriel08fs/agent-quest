import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { MIME_TYPES, SHARED_DIR, WEB_DIR, readStaticFile, resolveStaticPath } from '../../../../server/http/static.js';
import { REPO, tempDir } from '../helpers.js';

const roots = { webDir: path.resolve(path.sep, 'raiz', 'web'), sharedDir: path.resolve(path.sep, 'raiz', 'shared') };
const resolve = (rawPath) => resolveStaticPath(rawPath, roots);

describe('raízes padrão', () => {
  it('web/ e shared/ do repositório', () => {
    assert.equal(WEB_DIR, path.join(REPO, 'web'));
    assert.equal(SHARED_DIR, path.join(REPO, 'shared'));
  });
});

describe('resolveStaticPath: mapeamento', () => {
  it('"/" é web/index.html', () => {
    const r = resolve('/');
    assert.equal(r.status, 200);
    assert.equal(r.file, path.resolve(roots.webDir, 'index.html'));
    assert.equal(r.type, 'text/html; charset=utf-8');
  });

  it('/shared/... vem de shared/; o resto, de web/', () => {
    assert.equal(resolve('/shared/contract.js').file, path.resolve(roots.sharedDir, 'contract.js'));
    assert.equal(resolve('/js/main.js').file, path.resolve(roots.webDir, 'js', 'main.js'));
    assert.equal(resolve('/css/base.css').file, path.resolve(roots.webDir, 'css', 'base.css'));
  });

  it('tipos MIME pela extensão, sem diferenciar maiúsculas', () => {
    assert.equal(resolve('/js/main.js').type, 'text/javascript; charset=utf-8');
    assert.equal(resolve('/css/base.css').type, 'text/css; charset=utf-8');
    assert.equal(resolve('/img/a.SVG').type, 'image/svg+xml');
    assert.equal(resolve('/dados.json').type, 'application/json; charset=utf-8');
    for (const type of Object.values(MIME_TYPES)) assert.equal(typeof type, 'string');
  });

  it('caminho com espaço e acento codificados', () => {
    const r = resolve('/pasta%20com%20espa%C3%A7o/arquivo.css');
    assert.equal(r.status, 200);
    assert.equal(r.file, path.resolve(roots.webDir, 'pasta com espaço', 'arquivo.css'));
  });
});

describe('resolveStaticPath: travessia e recusas', () => {
  it('travessia de caminho, em qualquer forma, recebe 403', () => {
    const vectors = [
      '/../package.json',
      '/%2e%2e/package.json',
      '/%2E%2E/package.json',
      '/..%2fpackage.json',
      '/..%5cpackage.json',
      '/..\\package.json',
      '/web/../server/main.js',
      '/shared/../server/main.js',
      '/js/./main.js',
      '/js/%2e/main.js',
      '/C:/Windows/win.ini',
      '/index.html::$DATA',
      '/index.html%00.js',
    ];
    for (const vector of vectors) assert.equal(resolve(vector).status, 403, vector);
  });

  it('duplo código não é decodificado duas vezes (vira nome literal, 404 no disco)', () => {
    const r = resolve('/%252e%252e/package.json');
    assert.equal(r.status, 200);
    assert.equal(r.file, path.resolve(roots.webDir, '%2e%2e', 'package.json'));
  });

  it('pastas, segmentos vazios e arquivos ocultos recebem 404 (sem listagem)', () => {
    for (const vector of ['/js/', '/shared/', '/shared', '/js//main.js', '/.git/config', '/.env.json', '/js/.oculto.js']) {
      assert.equal(resolve(vector).status, 404, vector);
    }
  });

  it('extensão fora da lista recebe 404', () => {
    for (const vector of ['/server.mjs.map', '/main', '/a.exe', '/index.html.', '/index.html%20', '/INDEX~1.HTM']) {
      assert.equal(resolve(vector).status, 404, vector);
    }
  });

  it('caminho malformado ou que não começa com "/" recebe 400', () => {
    for (const vector of ['/%E0%A4%A', '/%', 'index.html', 'http://evil.example/index.html', '*']) {
      assert.equal(resolve(vector).status, 400, vector);
    }
  });
});

describe('readStaticFile', () => {
  const tmp = tempDir();
  let local;
  before(() => {
    local = { webDir: path.join(tmp.dir, 'web'), sharedDir: path.join(tmp.dir, 'shared') };
    mkdirSync(path.join(local.webDir, 'js'), { recursive: true });
    mkdirSync(path.join(local.webDir, 'pasta.js'), { recursive: true });
    mkdirSync(local.sharedDir, { recursive: true });
    writeFileSync(path.join(local.webDir, 'index.html'), '<p>oi</p>');
    writeFileSync(path.join(local.webDir, 'js', 'main.js'), 'export {};');
    writeFileSync(path.join(tmp.dir, 'segredo.js'), 'segredo');
  });
  after(tmp.cleanup);

  it('lê arquivos existentes', async () => {
    const body = await readStaticFile(resolveStaticPath('/js/main.js', local));
    assert.equal(Buffer.from(body).toString('utf8'), 'export {};');
  });

  it('arquivo ausente ou pasta valem null', async () => {
    assert.equal(await readStaticFile(resolveStaticPath('/js/nada.js', local)), null);
    assert.equal(await readStaticFile(resolveStaticPath('/pasta.js', local)), null);
  });

  it('nomes de dispositivo do Windows valem null, sem travar', async () => {
    for (const vector of ['/con.js', '/nul.html', '/aux.css', '/COM1.js', '/LPT1.txt']) {
      assert.equal(await readStaticFile(resolveStaticPath(vector, local)), null, vector);
    }
  });

  // Junção de pasta ('junction'): no Windows não exige privilégio; nos outros
  // sistemas, o tipo é ignorado e vira um link simbólico comum.
  it('link para uma pasta fora da raiz vale null; para dentro da raiz, funciona', async () => {
    const outside = path.join(tmp.dir, 'fora');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'segredo.js'), 'segredo');
    symlinkSync(outside, path.join(local.webDir, 'fora'), 'junction');
    symlinkSync(path.join(local.webDir, 'js'), path.join(local.webDir, 'atalho'), 'junction');

    assert.equal(await readStaticFile(resolveStaticPath('/fora/segredo.js', local)), null);
    const inside = await readStaticFile(resolveStaticPath('/atalho/main.js', local));
    assert.equal(Buffer.from(inside).toString('utf8'), 'export {};');
  });
});
