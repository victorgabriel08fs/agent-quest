// Detecção de testes do T6 contra saídas reais (tester).
//
// As saídas são geradas nesta máquina, na hora, com o `node --test` (repórteres
// spec, com e sem cor, e TAP) e com o Playwright sem navegador (`@playwright/test`,
// a devDependency aprovada), em pastas temporárias. Assim o repositório não
// guarda nenhuma saída com caminhos pessoais. Confere:
// - `parseTestSummary` nas saídas reais e nelas cortadas pelo encaminhador;
// - o `testResult` do fato (PostToolUse e PostToolUseFailure), sem nenhum texto
//   da saída no fato e sem segredo da saída em lugar nenhum;
// - a detecção de comandos com formas de vários shells e falsos positivos;
// - o `ts` com relógio fora, dos dois lados (seção 1).
//
// Sem testes `todo` abertos: o B13 foi corrigido pela regra do mínimo (seção 6).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { charLength, redact } from '../../server/domain/redact.js';
import { normalize } from '../../server/domain/normalize.js';
import { parseTestSummary, testCommandInfo, testCommandKind } from '../../server/domain/tests-detect.js';
import { cutString } from '../../capture/plugins/agent-quest/scripts/forward.mjs';
import { REPO, minimalEnv, tempDir } from './server-helpers.js';

const SECRET = `sk-ant-${'S'.repeat(40)}`;
const LEAK = /soma|subtrai|falha|segredo|SSSS|YYYY|linha de log|Error Context|instavel|a\.spec|ghp_|sk-ant|API_KEY|token=/;

let tmp;
/** Saídas geradas: nome → texto. */
const out = {};

function run(args, { cwd, color = false } = {}) {
  const env = minimalEnv(color ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' });
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return `${result.stdout}${result.stderr}`;
}

before(() => {
  tmp = tempDir('aq-int-t6-');
  const nt = path.join(tmp.dir, 'nt');
  mkdirSync(nt);
  writeFileSync(path.join(nt, 'ok.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('soma', () => assert.equal(1 + 1, 2));\ntest('subtrai', () => assert.equal(2 - 1, 1));\n");
  writeFileSync(path.join(nt, 'fail.test.mjs'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('falha com segredo', () => assert.equal('API_KEY=${SECRET}', 'x'));\ntest('passa', () => assert.ok(true));\ntest.skip('pulado', () => {});\n`);
  writeFileSync(path.join(nt, 'many.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nfor (let i = 0; i < 40; i++) test(`falha ${i}`, () => assert.equal(i, -1));\nfor (let i = 0; i < 10; i++) test(`passa ${i}`, () => assert.ok(true));\n");
  writeFileSync(path.join(nt, 'big.test.mjs'), `import { test } from 'node:test';\ntest('saida enorme', () => { for (let i = 0; i < 5000; i++) console.log('linha de log ' + i + ' token=segredo' + i); });\n`);
  out.specPlain = run(['--test', '--test-reporter=spec', 'ok.test.mjs', 'fail.test.mjs'], { cwd: nt });
  out.specColor = run(['--test', '--test-reporter=spec', 'ok.test.mjs', 'fail.test.mjs'], { cwd: nt, color: true });
  out.tap = run(['--test', '--test-reporter=tap', 'ok.test.mjs', 'fail.test.mjs'], { cwd: nt });
  out.big = run(['--test', 'big.test.mjs', 'ok.test.mjs'], { cwd: nt, color: true });
  out.many = run(['--test', 'many.test.mjs'], { cwd: nt });
  // Réplicas do `npm test` deste repositório com 1 falha e `todo` com diferença longa:
  // a lista de falhas vem depois do resumo, e o resumo sai do trecho final do corte.
  const todos = "for (let i = 0; i < 5; i++) test(`pendente ${i}`, { todo: 'bug aberto' }, () => assert.deepEqual({ lista: Array.from({ length: 30 }, (_, j) => `item ${j}`) }, { lista: [] }));\n";
  const header = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nfor (let i = 0; i < 60; i++) test(`passa ${i}`, () => assert.ok(true));\n";
  const shortFailure = "test('falha curta', () => assert.equal(1, 2));\n";
  writeFileSync(path.join(nt, 'todo-first.test.mjs'), header + todos + shortFailure);
  writeFileSync(path.join(nt, 'failure-first.test.mjs'), header + shortFailure + todos);
  out.todoFirst = run(['--test', 'todo-first.test.mjs'], { cwd: nt });
  out.failureFirst = run(['--test', 'failure-first.test.mjs'], { cwd: nt });

  // Playwright sem navegador: testes puros, com uma falha, um instável (passa no retry) e um pulado.
  const pw = path.join(tmp.dir, 'pw');
  mkdirSync(path.join(pw, 'tests'), { recursive: true });
  const index = pathToFileURL(path.join(REPO, 'node_modules', '@playwright', 'test', 'index.mjs')).href;
  writeFileSync(path.join(pw, 'pw.config.mjs'), `import { defineConfig } from '${index}';\nexport default defineConfig({ testDir: './tests', reporter: 'list', workers: 2, retries: 1, outputDir: './results' });\n`);
  writeFileSync(path.join(pw, 'tests', 'a.spec.mjs'), `import { test, expect } from '${index}';\ntest('passa 1', () => expect(1).toBe(1));\ntest('passa 2', () => expect(2).toBe(2));\ntest('falha com segredo', () => expect('token=ghp_${'Y'.repeat(36)}').toBe('x'));\ntest('instavel', ({}, info) => expect(info.retry).toBe(1));\ntest.skip('pulado', () => {});\n`);
  const cli = path.join(REPO, 'node_modules', '@playwright', 'test', 'cli.js');
  // Uma execução só (cerca de 9 s), com cor; a versão sem cor tira só os SGR,
  // para não pesar nos testes de tempo de outros arquivos.
  out.pwColor = run([cli, 'test', '--config', 'pw.config.mjs'], { cwd: pw, color: true });
  out.pwPlain = out.pwColor.replace(/\x1B\[[0-9;]*m/g, '');
});

after(() => tmp?.cleanup());

const NODE_OK_FAIL = { passed: 3, failed: 1, total: 5, framework: 'node:test' };
const PLAYWRIGHT = { passed: 2, failed: 1, total: 5, framework: 'playwright' };

describe('parseTestSummary com saídas reais desta máquina', () => {
  it('node --test: spec sem e com cor, TAP, saída grande, e as mesmas cortadas pelo encaminhador', () => {
    assert.deepEqual(parseTestSummary(out.specPlain), NODE_OK_FAIL);
    assert.deepEqual(parseTestSummary(out.specColor), NODE_OK_FAIL);
    assert.match(out.specColor, /\x1B\[/, 'a saída com cor tem ANSI');
    assert.deepEqual(parseTestSummary(out.tap), NODE_OK_FAIL);
    assert.ok(out.big.length > 100_000);
    const big = { passed: 3, failed: 0, total: 3, framework: 'node:test' };
    assert.deepEqual(parseTestSummary(out.big), big);
    assert.deepEqual(parseTestSummary(cutString(out.big)), big);
    assert.deepEqual(parseTestSummary(out.big.slice(0, 20_000)), { passed: null, failed: null, total: null, framework: null }, 'interrompida antes do resumo');
  });

  it('Playwright (lista), sem e com cor, com falha, instável e pulado', () => {
    assert.deepEqual(parseTestSummary(out.pwPlain), PLAYWRIGHT);
    assert.deepEqual(parseTestSummary(out.pwColor), PLAYWRIGHT);
    assert.match(out.pwPlain, /1 flaky/);
  });

  // B13 (decidido em 19/10/2026, seção 6): no repórter spec, o resumo vem antes da
  // lista `✖ failing tests:`. Sem resumo no texto lido, a lista dá um mínimo de
  // falhas visíveis, com `passed` e `total` null e `partial: true`.
  it('node --test spec com 40 falhas, cortada pelo encaminhador: mínimo entre 1 e 40, sempre o mesmo', () => {
    const cut = parseTestSummary(cutString(out.many));
    assert.equal(cut.framework, 'node:test');
    assert.equal(cut.partial, true);
    assert.equal(cut.passed, null);
    assert.equal(cut.total, null);
    assert.ok(Number.isInteger(cut.failed) && cut.failed >= 1 && cut.failed <= 40, String(cut.failed));
    assert.deepEqual(parseTestSummary(cutString(out.many)), cut, 'determinístico');
    // Inteira (só chamando a função direto: o encaminhador sempre corta acima de 4 KiB),
    // o cabeçalho da lista fica fora dos últimos 8192 caracteres: desconhecido.
    assert.deepEqual(parseTestSummary(out.many), { passed: null, failed: null, total: null, framework: null });
  });

  it('réplica do npm test daqui com 1 falha depois dos todo: cortada, dá failed 1 e deixa os todo de fora', () => {
    assert.ok(out.todoFirst.length > 8192 && out.todoFirst.indexOf('ℹ tests') < out.todoFirst.length - 4096, 'o resumo sai do trecho final do corte');
    assert.deepEqual(parseTestSummary(cutString(out.todoFirst)), { passed: null, failed: 1, total: null, framework: 'node:test', partial: true });
  });

  it('réplica com a falha antes dos todo (diferenças longas depois dela): sem item visível, desconhecido', () => {
    // Limite aceito da regra: nenhum item `✖` no trecho final de 3 KiB. O T8 aplica `failed ?? 1`.
    assert.deepEqual(parseTestSummary(cutString(out.failureFirst)), { passed: null, failed: null, total: null, framework: null });
  });
});

describe('testResult no fato: só números, nada da saída', () => {
  const at = 1_760_000_000_000;
  const fact = (hook, fields) => normalize({ v: 1, sentAt: at, env: { projectDir: 'C:\\p' }, payload: { session_id: 's1', hook_event_name: hook, tool_use_id: 'toolu_1', ...fields } }, { receivedAt: at });
  function* strings(value, where = 'fato') {
    if (typeof value === 'string') yield [where, value];
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* strings(v, `${where}.${k}`);
  }
  const check = (f, label) => {
    for (const [where, value] of strings(f)) {
      assert.doesNotMatch(value, LEAK, `${label}: ${where}`);
      assert.ok(charLength(value) <= 1024, `${label}: ${where}`);
    }
    for (const key of ['tool', 'target', 'detail', 'error']) if (typeof f[key] === 'string') assert.equal(redact(f[key]), f[key]);
  };

  it('PostToolUse (stdout), PostToolUseFailure (error), PowerShell, cadeia && e segundo plano', () => {
    const cases = [
      ['node, stdout', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'node --test' }, tool_response: { stdout: out.specColor, stderr: '' } }, { ok: true, ...NODE_OK_FAIL, chained: false }],
      ['playwright, stdout', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npx playwright test' }, tool_response: { stdout: out.pwColor, stderr: '' } }, { ok: true, ...PLAYWRIGHT, chained: false }],
      ['node, error', 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: `Exit code 1\n${out.specPlain}` }, { ok: false, ...NODE_OK_FAIL, chained: false }],
      ['PowerShell, TAP', 'PostToolUse', { tool_name: 'PowerShell', tool_input: { command: 'npm test' }, tool_response: { stdout: out.tap } }, { ok: true, ...NODE_OK_FAIL, chained: false }],
      ['cadeia &&', 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm run build && npm test' }, error: `Exit code 1\n${out.specPlain}` }, { ok: false, ...NODE_OK_FAIL, chained: true }],
    ];
    for (const [label, hook, fields, expected] of cases) {
      const f = fact(hook, fields);
      assert.equal(f.category, 'test', label);
      assert.deepEqual(f.testResult, expected, label);
      check(f, label);
    }
    const background = fact('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true }, tool_response: { stdout: out.specColor } });
    assert.deepEqual([background.category, background.testResult], ['bash', null]);
    const notTest = fact('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'cat log.txt' }, tool_response: { stdout: out.tap } });
    assert.deepEqual([notTest.category, notTest.testResult], ['bash', null]);
  });

  it('Esc no meio do teste: tool.fail interrompido, sem contagem', () => {
    const f = fact('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Interrupted by user', is_interrupt: true });
    assert.equal(f.interrupted, true);
    assert.deepEqual(f.testResult, { ok: false, passed: null, failed: null, total: null, framework: null, chained: false });
  });
});

describe('detecção de comandos (seção 6)', () => {
  it('formas de vários shells contam; a cadeia && só com o teste por último', () => {
    const plain = [
      'npm test', 'npm run test:unit', 'pnpm test', 'yarn test', 'bun test', 'cd app && npm test', 'Set-Location C:\\x; npm test',
      'pushd x && npm test', 'cd /d C:\\x && npm test', 'CI=1 npm test', '$env:CI="1"; npm test', 'set CI=1&& npm test',
      'node --test', 'node --experimental-test-coverage --test', 'npx vitest run', 'npx --yes playwright test', 'pytest -q', 'py -m pytest',
      'php vendor/bin/phpunit', 'vendor\\bin\\pest', 'go test ./...', 'cargo test', 'dotnet test', './mvnw test', '.\\gradlew test',
      'npm test 2>&1 | tail -20',
    ];
    for (const command of plain) assert.equal(testCommandKind(command), 'plain', command);
    for (const command of ['npm run build && npm test', 'npm ci && npm run lint && npm test', 'composer install && php artisan test', 'cd x; npm ci && npm test']) {
      assert.equal(testCommandKind(command), 'chained', command);
    }
  });

  it('falsos positivos: comando que só menciona "test" num caminho ou numa string', () => {
    const negatives = [
      'echo test', 'echo "npm test"', 'cat test.txt', 'git commit -m "test"', 'git commit -m "npm test"', 'ls test/', 'mkdir test',
      'grep -r "npm test" .', 'node test.js', 'node scripts/run-tests.mjs', 'npm run lint:test', 'cat package.json | grep test',
      'Get-Content test.txt', 'type tests\\x.txt', 'python test.py', 'npm test; echo fim', 'npm test || true', 'echo inicio; npm test',
      'npm test && npm run build', 'npm test -- test/unit\nsegunda', 'docker run node npm test', 'pytest-watch', 'cargo testx',
    ];
    for (const command of negatives) assert.equal(testCommandKind(command), null, command);
  });

  it('ajustes do T6: comandos novos, nome de script, aspas, env e cross-env, com o framework do comando', () => {
    const BS = String.fromCharCode(92);
    const counted = [
      ['npm t', null], ['pnpm vitest', 'vitest'], ['pnpm exec vitest run', 'vitest'], ['pnpm dlx vitest', 'vitest'], ['yarn jest', 'jest'],
      ['bunx vitest', 'vitest'], ['bun x vitest', 'vitest'], ['pnpm exec playwright test', 'playwright'], ['uv run pytest', 'pytest'],
      ['poetry run pytest -q', 'pytest'], ['pipenv run pytest', 'pytest'], ['composer test', null], ['gradlew.bat test', null],
      [`.${BS}gradlew.bat test`, null], ['env CI=1 npm test', null], ['env npm test', null], ['cross-env CI=1 npm test', null],
      ['npx cross-env CI=1 jest', 'jest'], ['npm run test:unit', null], ['npm run test-e2e', null], ['npm run test.ci', null],
      ['cd "a;b" && npm test', null], ["cd 'a&&b' && npm test", null], ['node --test', 'node:test'], ['go test ./...', 'go'],
    ];
    for (const [command, framework] of counted) assert.deepEqual(testCommandInfo(command), { kind: 'plain', framework }, command);
    const notCounted = [
      'npm run testing', 'npm testing', 'npm t2', 'env | grep test', 'environment npm test', 'env CI=1 echo test', 'cross-env echo npm test',
      'cross-envy npm test', 'npx cross-env', 'echo "a && npm test"', "echo 'npm test'", 'npm test "a; b"; echo', 'echo "sem fecho && npm test',
      'composer install', 'composer testing', 'uv run python x.py', 'pnpm install', 'yarn add vitest', 'bun x tsc', 'gradlew.bat build',
    ];
    for (const command of notCounted) assert.equal(testCommandInfo(command), null, command);
  });

  it('framework do comando restringe os padrões: npx jest com linha do Playwright no stdout usa o resumo do Jest', () => {
    const fact = (command, response) => normalize({ v: 1, sentAt: 1, env: {}, payload: { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: { command }, tool_response: response } }, { receivedAt: 1 });
    const jest = 'Tests:       1 failed, 2 passed, 3 total';
    assert.deepEqual(fact('npx jest', { stdout: '  2 passed (1.2s)', stderr: jest }).testResult, { ok: true, passed: 2, failed: 1, total: 3, framework: 'jest', chained: false });
    assert.equal(fact('npx playwright test', { stdout: `${jest}\n  2 passed (1.2s)` }).testResult.framework, 'playwright');
  });
});

describe('ts com relógio fora (seção 1)', () => {
  it('até 5 min da chegada fica o sentAt; acima disso, para mais ou para menos, a chegada', () => {
    const arrival = 1_760_000_000_000;
    const ts = (sentAt) => normalize({ v: 1, sentAt, env: {}, payload: { session_id: 's1', hook_event_name: 'Stop' } }, { receivedAt: arrival }).ts;
    for (const delta of [0, 1, -1, 300_000, -300_000]) assert.equal(ts(arrival + delta), arrival + delta, String(delta));
    for (const delta of [300_001, -300_001, 86_400_000, -2_592_000_000]) assert.equal(ts(arrival + delta), arrival, String(delta));
  });
});
