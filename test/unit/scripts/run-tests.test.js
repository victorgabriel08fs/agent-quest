import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('../../../scripts/run-tests.mjs', import.meta.url));

const passing = (name) => `import { test } from 'node:test';\ntest('${name}', () => {});\n`;
const failing = (name) =>
  `import { test } from 'node:test';\ntest('${name}', () => { throw new Error('não deveria rodar'); });\n`;

/** Cria um repositório de mentira num diretório temporário. */
function createRepo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-quest-run-tests-'));
  const all = { 'package.json': '{ "type": "module" }\n', ...files };
  for (const [relative, content] of Object.entries(all)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/** Roda o executor como o npm roda: com o diretório atual na raiz do repositório. */
function runTests(cwd, args = []) {
  const env = { ...process.env };
  // Sem isso, o node --test filho se comportaria como subprocesso deste teste.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [RUNNER, '--test-reporter=spec', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('scripts/run-tests.mjs', () => {
  let repo;
  let failingRepo;
  let emptyRepo;

  before(() => {
    repo = createRepo({
      'test/unit/a.test.js': passing('unit-a'),
      'test/unit/deep/nested/b.test.js': passing('unit-b-nested'),
      'test/unit/helper.js': failing('helper-nao-e-teste'),
      'test/integration/c.test.js': passing('integration-c'),
      'test/e2e/d.test.js': failing('e2e-d'),
      'test/fixtures/hooks/e.test.js': failing('fixture-e'),
      'other.test.js': failing('raiz-other'),
    });
    failingRepo = createRepo({ 'test/unit/fail.test.js': failing('falha-de-verdade') });
    emptyRepo = createRepo({ 'test/unit/.gitkeep': '' });
  });

  after(() => {
    for (const dir of [repo, failingRepo, emptyRepo]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('roda só os *.test.js de test/unit e test/integration, inclusive em subpastas', () => {
    const { status, output } = runTests(repo);
    assert.equal(status, 0, output);
    for (const name of ['unit-a', 'unit-b-nested', 'integration-c']) {
      assert.match(output, new RegExp(name), `${name} deveria rodar`);
    }
    for (const name of ['helper-nao-e-teste', 'e2e-d', 'fixture-e', 'raiz-other']) {
      assert.doesNotMatch(output, new RegExp(name), `${name} não deveria rodar`);
    }
  });

  it('aceita pastas e arquivos no lugar das raízes padrão', () => {
    const { status, output } = runTests(repo, ['test/integration', 'test/unit/a.test.js']);
    assert.equal(status, 0, output);
    assert.match(output, /integration-c/);
    assert.match(output, /unit-a/);
    assert.doesNotMatch(output, /unit-b-nested/);
  });

  it('repassa as opções ao node --test', () => {
    const { status, output } = runTests(repo, ['--test-name-pattern=unit-a']);
    assert.equal(status, 0, output);
    assert.match(output, /unit-a/);
    assert.doesNotMatch(output, /unit-b-nested/);
    assert.doesNotMatch(output, /integration-c/);
  });

  it('sai com erro quando um teste falha', () => {
    const { status, output } = runTests(failingRepo);
    assert.notEqual(status, 0, output);
    assert.match(output, /falha-de-verdade/);
  });

  it('sai com erro quando não encontra nenhum arquivo de teste', () => {
    const { status, output } = runTests(emptyRepo);
    assert.equal(status, 1, output);
    assert.match(output, /Nenhum arquivo \*\.test\.js encontrado/);
  });

  it('sai com erro quando um caminho indicado não existe', () => {
    const { status, output } = runTests(repo, ['test/nada']);
    assert.equal(status, 1, output);
    assert.match(output, /Caminho não encontrado: test\/nada/);
  });
});
