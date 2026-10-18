// @ts-check
// Arquivos estáticos do painel (ADR 0006): só de `web/` e `shared/`.
//
// Mapeamento de URLs:
//   /                    → web/index.html
//   /shared/<caminho>    → shared/<caminho>
//   /<caminho>           → web/<caminho>
// Assim, `import '../../shared/contract.js'` em `web/js/main.js` funciona igual
// no navegador e nos testes do Node.
//
// Recusa com 403 qualquer travessia de caminho (`..`, `.`, barra invertida,
// `:` ou byte nulo, inclusive codificados) e com 404 arquivos ocultos, pastas
// (sem listagem) e extensões fora da lista de tipos MIME. Os arquivos saem com
// `Cache-Control: no-cache`, para o F5 trazer a versão nova durante o desenvolvimento.

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_DIR = fileURLToPath(new URL('../../web', import.meta.url));
export const SHARED_DIR = fileURLToPath(new URL('../../shared', import.meta.url));

/** Tipos MIME servidos. Extensão fora desta lista recebe 404. */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
});

const SHARED_PREFIX = '/shared/';

/**
 * @typedef {object} StaticRoots
 * @property {string} webDir
 * @property {string} sharedDir
 */

/**
 * @typedef {{ status: 200, root: string, file: string, type: string } | { status: 400|403|404 }} StaticResolution
 */

/**
 * Traduz o caminho da URL (ainda codificado, sem `?`) para um arquivo dentro de
 * uma das raízes. Não toca no disco.
 * @param {string} rawPath
 * @param {StaticRoots} roots
 * @returns {StaticResolution}
 */
export function resolveStaticPath(rawPath, { webDir, sharedDir }) {
  if (!rawPath.startsWith('/')) return { status: 400 };

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 };
  }
  if (/[\\:\0]/.test(decoded)) return { status: 403 };

  const segments = decoded.split('/').slice(1);
  if (segments.some((segment) => segment === '..' || segment === '.')) return { status: 403 };

  let root = webDir;
  let relative = segments;
  if (decoded === '/') {
    relative = ['index.html'];
  } else if (decoded.startsWith(SHARED_PREFIX)) {
    root = sharedDir;
    relative = segments.slice(1);
  }
  // Pasta (termina em "/"), segmento vazio ou arquivo oculto: nada a servir.
  if (relative.length === 0 || relative.some((segment) => segment === '' || segment.startsWith('.'))) {
    return { status: 404 };
  }

  const type = MIME_TYPES[/** @type {keyof typeof MIME_TYPES} */ (path.extname(relative.at(-1) ?? '').toLowerCase())];
  if (!type) return { status: 404 };

  const base = path.resolve(root);
  const file = path.resolve(base, ...relative);
  if (!isInside(file, base)) return { status: 403 };
  return { status: 200, root: base, file, type };
}

/**
 * Lê o arquivo resolvido, conferindo de novo, já com links simbólicos
 * resolvidos, que ele está dentro da raiz e que é um arquivo comum.
 * @param {{ root: string, file: string }} target
 * @returns {Promise<Uint8Array|null>}   null se não existir ou não puder ser servido
 */
export async function readStaticFile({ root, file }) {
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!isInside(realFile, realRoot)) return null;
    const info = await stat(realFile);
    if (!info.isFile()) return null;
    return await readFile(realFile);
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {string} root
 * @returns {boolean}
 */
function isInside(file, root) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
