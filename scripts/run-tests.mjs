// Executa os testes de unidade e integração com node:test (`npm test`).
//
// Os arquivos *.test.js são encontrados aqui, e não por um glob no package.json,
// porque cmd, PowerShell e Git Bash tratam globs de jeitos diferentes no Windows,
// e porque um glob sem resultado faria o `node --test` passar sem rodar nada.
//
// Uso (sempre a partir da raiz do repositório, que é onde o npm roda os scripts):
//   npm test                                    test/unit e test/integration
//   npm test -- test/unit/shared                só as pastas ou arquivos indicados
//   npm test -- --test-name-pattern=contrato    opções do node --test, na forma --opção=valor

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ROOTS = ['test/unit', 'test/integration'];
const TEST_SUFFIX = '.test.js';

const root = process.cwd();
const options = [];
const paths = [];
for (const arg of process.argv.slice(2)) {
  (arg.startsWith('-') ? options : paths).push(arg);
}

const missing = paths.filter((p) => !statSync(path.resolve(root, p), { throwIfNoEntry: false }));
if (missing.length > 0) {
  console.error(`Caminho não encontrado: ${missing.join(', ')}`);
  process.exit(1);
}

const roots = paths.length > 0 ? paths : DEFAULT_ROOTS;
const files = findTestFiles(roots);
if (files.length === 0) {
  console.error(`Nenhum arquivo *${TEST_SUFFIX} encontrado em: ${roots.join(', ')}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...options, ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`Não foi possível iniciar o node --test: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

/**
 * Lista os arquivos *.test.js das raízes (pastas, incluindo subpastas, ou
 * arquivos), sem repetir e em ordem, com caminhos relativos à raiz do
 * repositório separados por "/". Raiz inexistente é ignorada.
 * @param {string[]} roots
 * @returns {string[]}
 */
function findTestFiles(roots) {
  const found = new Set();
  for (const entryRoot of roots) {
    const absolute = path.resolve(root, entryRoot);
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      if (absolute.endsWith(TEST_SUFFIX)) found.add(absolute);
    } else if (stat?.isDirectory()) {
      for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
          found.add(path.join(entry.parentPath, entry.name));
        }
      }
    }
  }
  return [...found].map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
}
