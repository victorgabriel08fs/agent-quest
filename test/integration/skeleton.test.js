// Integração do esqueleto do repositório (T1 do plano da v1).
//
// - O package.json segue o design (ADRs 0003 e 0010): ESM, privado, Node 24,
//   sem dependências de runtime e, no máximo, @playwright/test em desenvolvimento.
// - O `npm test` de verdade (o script do package.json, passando pelo npm) roda
//   test/unit e test/integration, inclusive subpastas e nomes com espaço e acento,
//   ignora o resto e devolve código diferente de zero quando um teste falha.
// - shared/contract.js carrega num contexto sem nada do Node, como no navegador.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));

const CONTRACT_LISTS = [
  'AGENT_STATUS',
  'EVENT_KINDS',
  'FEED_KINDS',
  'PHASES',
  'QUEST_STATUS',
  'ROLES',
  'SESSION_STATUS',
  'TOOL_CATEGORIES',
];

describe('package.json segue o design', () => {
  it('é ESM, privado e exige Node 24', () => {
    assert.equal(PACKAGE.type, 'module');
    assert.equal(PACKAGE.private, true);
    assert.equal(PACKAGE.engines?.node, '>=24');
  });

  it('não tem dependências de runtime', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      const value = PACKAGE[field];
      const empty = value === undefined || (typeof value === 'object' && Object.keys(value).length === 0);
      assert.ok(empty, `${field} deveria estar ausente ou vazio: ${JSON.stringify(value)}`);
    }
  });

  it('só aceita @playwright/test como dependência de desenvolvimento', () => {
    const extra = Object.keys(PACKAGE.devDependencies ?? {}).filter((name) => name !== '@playwright/test');
    assert.deepEqual(extra, [], 'dependência de desenvolvimento fora do design (ADR 0010)');
  });

  it('tem os scripts start e test', () => {
    assert.equal(typeof PACKAGE.scripts?.start, 'string');
    assert.equal(typeof PACKAGE.scripts?.test, 'string');
  });
});

describe('pastas de teste do ADR 0010', () => {
  const folders = [
    'test/unit/server',
    'test/unit/web',
    'test/unit/capture',
    'test/integration',
    'test/e2e',
    'test/fixtures/hooks',
    'test/fixtures/state',
    'test/fixtures/transcripts',
  ];
  for (const folder of folders) {
    it(`${folder} existe`, () => {
      assert.ok(statSync(path.join(REPO, folder), { throwIfNoEntry: false })?.isDirectory(), `${folder} não existe`);
    });
  }
});

describe('npm test de ponta a ponta', () => {
  const passing = (name) => `import { test } from 'node:test';\ntest('${name}', () => {});\n`;
  const failing = (name) =>
    `import { test } from 'node:test';\ntest('${name}', () => { throw new Error('${name} falhou'); });\n`;

  let repo;

  /** Repositório de mentira com o executor real e o script `test` real do package.json. */
  function createRepo(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-quest-npm-test-'));
    const pkg = { name: 'fake', private: true, type: 'module', scripts: { test: PACKAGE.scripts.test } };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    copyFileSync(path.join(REPO, 'scripts/run-tests.mjs'), path.join(dir, 'scripts/run-tests.mjs'));
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(dir, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  /** Roda `npm test` como o usuário roda, pelo shell do sistema. */
  function npmTest(cwd) {
    const env = { ...process.env, npm_config_update_notifier: 'false' };
    // Sem isso, o node --test do repositório de mentira se comportaria como subprocesso deste teste.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync('npm test', { cwd, env, encoding: 'utf8', shell: true, timeout: 60_000 });
    assert.equal(result.error, undefined, `npm não iniciou: ${result.error?.message}`);
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  before(() => {
    repo = createRepo({
      'test/unit/a.test.js': passing('npm-unit-a'),
      'test/unit/pasta com espaço e acentuação/configuração.test.js': passing('npm-unit-acentuado'),
      'test/unit/.gitkeep': '',
      'test/integration/sub/c.test.js': passing('npm-integration-c'),
      'test/integration/helper.js': failing('npm-helper-nao-e-teste'),
      'test/e2e/d.test.js': failing('npm-e2e-d'),
      'test/fixtures/hooks/e.test.js': failing('npm-fixture-e'),
    });
  });

  after(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('roda test/unit e test/integration, inclusive subpastas, e nada mais', () => {
    const { status, output } = npmTest(repo);
    assert.equal(status, 0, output);
    for (const name of ['npm-unit-a', 'npm-unit-acentuado', 'npm-integration-c']) {
      assert.match(output, new RegExp(name), `${name} deveria rodar`);
    }
    for (const name of ['npm-helper-nao-e-teste', 'npm-e2e-d', 'npm-fixture-e']) {
      assert.doesNotMatch(output, new RegExp(name), `${name} não deveria rodar`);
    }
  });

  it('sai com código diferente de zero quando um teste de integração falha', () => {
    const file = path.join(repo, 'test/integration/sub/falha.test.js');
    writeFileSync(file, failing('npm-integration-falha'));
    try {
      const { status, output } = npmTest(repo);
      assert.notEqual(status, 0, output);
      assert.match(output, /npm-integration-falha/);
    } finally {
      rmSync(file, { force: true });
    }
    assert.ok(!existsSync(file));
  });
});

describe('shared/contract.js fora do Node', () => {
  it('carrega num contexto vazio, sem globais do Node e sem importar nada', () => {
    // vm.SourceTextModule ainda pede --experimental-vm-modules no Node 24, por isso o processo filho.
    const script = `
      import vm from 'node:vm';
      import { readFileSync } from 'node:fs';
      const context = vm.createContext({});
      const globals = ['process', 'Buffer', 'require', 'global', 'setImmediate']
        .filter((name) => vm.runInContext('typeof ' + name, context) !== 'undefined');
      const mod = new vm.SourceTextModule(readFileSync(process.argv[1], 'utf8'), { context, identifier: 'contract.js' });
      let imports = 0;
      await mod.link(() => { imports++; throw new Error('o contrato importou algo'); });
      await mod.evaluate();
      const ns = mod.namespace;
      const lists = Object.fromEntries(Object.keys(ns).map((key) => [key, { length: ns[key].length, frozen: Object.isFrozen(ns[key]) }]));
      console.log(JSON.stringify({ globals, imports, lists }));
    `;
    const contractPath = path.join(REPO, 'shared/contract.js');
    const result = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', script, contractPath],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const { globals, imports, lists } = JSON.parse(result.stdout);

    assert.deepEqual(globals, [], 'o contexto de teste deveria estar livre de globais do Node');
    assert.equal(imports, 0);
    assert.deepEqual(Object.keys(lists).sort(), CONTRACT_LISTS);
    for (const [name, { frozen }] of Object.entries(lists)) {
      assert.ok(frozen, `${name} deveria estar congelada`);
    }
    assert.equal(lists.EVENT_KINDS.length, 17);
    assert.equal(lists.ROLES.length, 6);
    assert.equal(lists.TOOL_CATEGORIES.length, 11);
    assert.equal(lists.PHASES.length, 4);
  });
});
