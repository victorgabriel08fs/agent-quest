// Página do painel (web/): nenhum script ou estilo inline (CSP do ADR 0006),
// nada carregado de outra origem (CLAUDE.md, "100% local"), imports que
// resolvem dentro de web/ e shared/, e só arquivos que o servidor sabe servir.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIME_TYPES } from '../../../server/http/static.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = path.join(REPO, 'web');
const SHARED = path.join(REPO, 'shared');
const INDEX = readFileSync(path.join(WEB, 'index.html'), 'utf8');

/** Arquivos de uma pasta, com subpastas. */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Caminho de URL do painel → arquivo no disco (visão geral, "Rotas e mapeamento de URL"). */
function fileForUrl(url) {
  if (url === '/') return path.join(WEB, 'index.html');
  if (url.startsWith('/shared/')) return path.join(SHARED, ...url.slice('/shared/'.length).split('/'));
  return path.join(WEB, ...url.slice(1).split('/'));
}

const WEB_FILES = listFiles(WEB);
const JS_FILES = WEB_FILES.filter((file) => file.endsWith('.js'));
const CSS_FILES = WEB_FILES.filter((file) => file.endsWith('.css'));

describe('web/index.html', () => {
  it('não tem script nem estilo inline, nem manipuladores de evento', () => {
    const scripts = [...INDEX.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    for (const [, attributes, body] of scripts) {
      assert.match(attributes, /\bsrc="\/[^"]+"/, 'todo script vem de arquivo');
      assert.equal(body.trim(), '', 'script com conteúdo inline');
    }
    assert.doesNotMatch(INDEX, /<style\b/i);
    assert.doesNotMatch(INDEX, /\sstyle=/i);
    assert.doesNotMatch(INDEX, /\son[a-z]+=/i);
    assert.doesNotMatch(INDEX, /javascript:/i);
  });

  it('não referencia nada de outra origem', () => {
    assert.doesNotMatch(INDEX, /https?:\/\//i);
    assert.doesNotMatch(INDEX, /(src|href)="\/\//i);
  });

  it('todo recurso referenciado existe e é servido com tipo conhecido', () => {
    const urls = [...INDEX.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(urls.includes('/js/main.js'));
    for (const url of urls) {
      assert.ok(url.startsWith('/'), `${url} deveria ser caminho absoluto do próprio servidor`);
      assert.ok(existsSync(fileForUrl(url)), `${url} não existe`);
      assert.ok(MIME_TYPES[path.extname(url).toLowerCase()], `${url} tem extensão que o servidor não serve`);
    }
  });

  it('é a página do painel em português, com viewport e tema inicial', () => {
    assert.match(INDEX, /<html lang="pt-BR" data-theme="escritorio">/);
    assert.match(INDEX, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(INDEX, /<script type="module" src="\/js\/main.js"><\/script>/);
  });

  it('tem os elementos que o main.js procura', () => {
    const main = readFileSync(path.join(WEB, 'js', 'main.js'), 'utf8');
    const ids = [...main.matchAll(/byId\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 7);
    for (const id of ids) assert.match(INDEX, new RegExp(`id="${id}"`), id);
  });

  it('não tem os elementos que saíram do mockup (ADR 0008)', () => {
    for (const removed of ['class="sim"', 'id="toasts"', 'id="badges"', 'Conquistas', 'btn-pause', 'data-speed', 'mockup']) {
      assert.ok(!INDEX.includes(removed), removed);
    }
  });
});

describe('arquivos de web/', () => {
  it('não existe web/shared/ (ficaria escondida pela rota /shared/)', () => {
    assert.ok(!existsSync(path.join(WEB, 'shared')));
  });

  it('todo arquivo tem uma extensão que o servidor serve', () => {
    for (const file of WEB_FILES) {
      assert.ok(MIME_TYPES[path.extname(file).toLowerCase()], path.relative(REPO, file));
    }
  });

  it('nenhum arquivo aponta para outra origem', () => {
    for (const file of WEB_FILES) {
      const text = readFileSync(file, 'utf8').replaceAll('http://www.w3.org/2000/svg', '');
      assert.doesNotMatch(text, /https?:\/\//i, path.relative(REPO, file));
    }
  });

  it('CSS: sem @import nem url() externo; com prefers-reduced-motion', () => {
    for (const file of CSS_FILES) {
      const css = readFileSync(file, 'utf8');
      assert.doesNotMatch(css, /@import/i, file);
      for (const [, target] of css.matchAll(/url\(\s*['"]?([^'")]+)/gi)) {
        assert.ok(target.startsWith('data:') || target.startsWith('/'), `${file}: url(${target})`);
      }
    }
    const all = CSS_FILES.map((file) => readFileSync(file, 'utf8')).join('\n');
    assert.match(all, /@media \(prefers-reduced-motion: reduce\)/);
    for (const role of ['orq', 'arq', 'dev', 'tes', 'doc', 'aux']) assert.match(all, new RegExp(`\\[data-agent="${role}"\\]`), role);
    for (let n = 1; n <= 10; n++) assert.ok(all.includes(`[data-fill="${n}"]`), `data-fill ${n}`);
  });

  it('JS: módulos com @ts-check, sem eval, sem estilo por atributo', () => {
    for (const file of JS_FILES) {
      const js = readFileSync(file, 'utf8');
      const name = path.relative(REPO, file);
      assert.match(js, /^\/\/ @ts-check/, `${name} sem // @ts-check`);
      assert.doesNotMatch(js, /\beval\(|new Function\(|setAttribute\(\s*['"]style|\sstyle=/, name);
      assert.doesNotMatch(js, /\bfrom ['"](?!\.\.?\/)/, `${name}: import que não é relativo`);
    }
  });

  it('JS: innerHTML só no main.js, pelo setHTML, com HTML gerado pelas views', () => {
    for (const file of JS_FILES) {
      const js = readFileSync(file, 'utf8');
      const uses = js.match(/\.innerHTML\s*=/g) ?? [];
      if (file.endsWith(`${path.sep}main.js`)) assert.equal(uses.length, 1, 'main.js: só o setHTML escreve innerHTML');
      else assert.equal(uses.length, 0, path.relative(REPO, file));
    }
  });

  it('JS: todo import resolve para um arquivo dentro de web/ ou shared/', () => {
    for (const file of JS_FILES) {
      const js = readFileSync(file, 'utf8');
      for (const [, specifier] of js.matchAll(/\bfrom ['"]([^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(file), specifier);
        assert.ok(statSync(target, { throwIfNoEntry: false })?.isFile(), `${path.relative(REPO, file)} → ${specifier}`);
        const inside = [WEB, SHARED].some((root) => !path.relative(root, target).startsWith('..'));
        assert.ok(inside, `${specifier} sai de web/ e shared/`);
      }
    }
  });
});
