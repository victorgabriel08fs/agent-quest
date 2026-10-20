// Detecção de testes (T6; modelo de eventos, seção 6, "Bug na cena"):
// detectTestCommand por tabela, parseTestSummary com saídas reais (node:test e
// Playwright, geradas nesta máquina) e pelo formato documentado (Jest, Vitest,
// pytest, PHPUnit, Pest e go test), com e sem cores, e o testOk do V3.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_SCAN_CHARS,
  SUMMARY_SCAN_CHARS,
  detectTestCommand,
  testCommandInfo,
  testCommandKind,
  parseTestSummary,
  testOk,
} from '../../../../server/domain/tests-detect.js';
import { cutString } from '../../../../capture/plugins/agent-quest/scripts/forward.mjs';
import { growthWithin } from '../../../integration/timing.js';
import { DOCUMENTED, GENERATED } from './test-outputs.js';

const UNKNOWN = { passed: null, failed: null, total: null, framework: null };

/** [comando, é teste?] */
const COMMANDS = [
  // Ajustes da reprovação do T6 (seção 6): um vetor por comando acrescentado.
  ['npm t', true],
  ['npm tt', false],
  ['pnpm vitest run', true],
  ['pnpm exec jest', true],
  ['pnpm dlx vitest', true],
  ['yarn mocha', true],
  ['bunx ava', true],
  ['bun x playwright test', true],
  ['uv run pytest -q', true],
  ['poetry run pytest', true],
  ['pipenv run pytest', true],
  ['uv run python app.py', false],
  ['composer test', true],
  ['composer install', false],
  ['gradlew.bat test', true],
  ['./gradlew test', true],
  ['env CI=1 npm test', true],
  ['env npm test', true],
  ['cross-env NODE_ENV=test jest', true],
  ['npx cross-env CI=1 FOO="a b" vitest run', true],
  ['env | grep test', false],
  // Nome do script: depois de `test`, só o fim ou um separador.
  ['npm run testing', false],
  ['npm run test-e2e', true],
  ['npm run test.ci', true],
  ['npm run test_x', true],
  // Separadores dentro de aspas não dividem trechos.
  ['cd "a;b" && npm test', true],
  ["cd 'a && b' && npm test", true],
  ['git commit -m "x && npm test"', false],
  // Os do critério do T6.
  ['cd app && npm test', true],
  ['npm run test:unit', true],
  ['npx vitest run', true],
  ['node --test', true],
  ['pytest -q', true],
  ['php artisan test', true],
  ['vendor/bin/phpunit', true],
  ['go test ./...', true],
  ['cargo test', true],
  ['dotnet test', true],
  ['npm install', false],
  ['echo test', false],
  ['cat test.txt', false],
  ['git commit -m "test"', false],
  // Gerenciadores de pacote, com e sem `run`.
  ['npm test', true],
  ['npm test -- --watch=false', true],
  ['yarn test', true],
  ['pnpm run test', true],
  ['bun test', true],
  ['npm run-script test:e2e', true],
  ['npm run build:test', false],
  ['npm run build', false],
  // node --test, com opções antes.
  ['node --test test/unit', true],
  ['node --test-reporter=tap --test', true],
  ['node --testing', false],
  ['node test.js', false],
  // Executores de JavaScript, com e sem npx.
  ['jest --ci', true],
  ['npx --yes jest', true],
  ['npx mocha', true],
  ['ava', true],
  ['npx playwright test --project=chromium', true],
  ['playwright test', true],
  ['npx playwright install', false],
  // Python, PHP, Go, Rust, .NET e JVM.
  ['pytest', true],
  ['pytest-watch', false],
  ['python -m pytest tests', true],
  ['python3 -m unittest discover', true],
  ['./vendor/bin/pest', true],
  [String.raw`.\vendor\bin\phpunit --filter Soma`, true],
  ['php vendor/bin/phpunit', true],
  ['go testdata', false],
  ['go build ./...', false],
  ['cargo build', false],
  ['dotnet build', false],
  ['mvn test', true],
  ['./gradlew test', true],
  ['gradle build', false],
  // Prefixos: troca de pasta e atribuições (bash, cmd e PowerShell).
  [String.raw`cd "C:\Meu Projeto" && npm run test:e2e`, true],
  ['cd app; npm test', true],
  ['cd app\nnpm test', true],
  ['pushd app && pytest', true],
  ['Set-Location app; npm test', true],
  ['CI=true npm test', true],
  ['CI=true FOO="a b" npx vitest run', true],
  ['export CI=1 && npm test', true],
  ['set CI=1 && npm test', true],
  ['$env:CI = 1; npm test', true],
  // Cadeia `&&` com o teste no fim conta (19/10/2026); com `;`, `||` ou o teste no meio, não.
  ['npm run build && npm test', true],
  ['composer install && php artisan test', true],
  ['cdk deploy && npm test', true],
  ['npm test && npm run build', false],
  ['npm test; echo', false],
  ['a || npm test', false],
  ['npm test || true', false],
  ['npm run build; npm test', false],
  ['echo "x; npm test"', false],
  ['cd test && ls', false],
  ['mkdir test', false],
  ['grep -r test .', false],
  ['', false],
  ['   ', false],
];

/** [comando, forma] (testCommandKind). */
const KINDS = [
  ['npm test', 'plain'],
  ['cd app && npm test', 'plain'],
  ['export CI=1; cd app\nnpm test', 'plain'],
  ['npm test;', 'plain'],
  ['npm ci && npm test', 'chained'],
  ['npm run build && npm test', 'chained'],
  ['composer install && php artisan test', 'chained'],
  ['cd app && npm ci && npm test', 'chained'],
  ['cd app; npm ci && CI=1 npm test', 'chained'],
  ['npm ci && cd app && npm test', 'chained'],
  ['npm test && npm run build', null],
  ['npm test; echo', null],
  ['a || npm test', null],
  ['cd app || exit && npm test', null],
  ['npm ci && npm run build; npm test', null],
  ['npm ci\nnpm test', null],
  ['npm install', null],
];

describe('detectTestCommand (seção 6)', () => {
  it(`tabela com ${COMMANDS.length} vetores (o critério pede ao menos 25)`, () => {
    assert.ok(COMMANDS.length >= 25);
    const wrong = COMMANDS.filter(([command, expected]) => detectTestCommand(command) !== expected);
    assert.deepEqual(wrong, []);
  });

  it('sem diferença de caixa, invisíveis e cores não atrapalham', () => {
    assert.equal(detectTestCommand('NPM TEST'), true);
    assert.equal(detectTestCommand(`np${String.fromCharCode(0x200b)}m test`), true);
    assert.equal(detectTestCommand('\x1B[32mnpm\x1B[0m test'), true);
  });

  it('não texto: false, sem lançar', () => {
    for (const value of [undefined, null, 42, {}, ['npm test']]) {
      assert.equal(detectTestCommand(value), false);
      assert.equal(testCommandKind(value), null);
    }
  });

  it(`testCommandKind: plain, chained (cadeia && com o teste no fim) ou null, em ${KINDS.length} vetores`, () => {
    const wrong = KINDS.filter(([command, kind]) => testCommandKind(command) !== kind);
    assert.deepEqual(wrong, []);
  });

  it(`comando com mais de ${COMMAND_SCAN_CHARS} caracteres não é teste (o trecho lido não diz se o teste é o último)`, () => {
    const prefixes = 'cd a && '.repeat((COMMAND_SCAN_CHARS - 8) / 8);
    assert.equal(detectTestCommand(`${prefixes}npm test`), true, 'no limite');
    assert.equal(detectTestCommand(`${prefixes}cd a && npm test`), false);
    assert.equal(detectTestCommand(`npm test ${'x'.repeat(1_000_000)}`), false);
  });
});

describe('parseTestSummary (seção 6, "Contagem")', () => {
  for (const [name, text, expected] of GENERATED) {
    it(`saída real: ${name}`, () => {
      assert.deepEqual(parseTestSummary(text), expected);
    });
  }
  for (const [name, text, expected] of DOCUMENTED) {
    it(`formato documentado: ${name}`, () => {
      assert.deepEqual(parseTestSummary(text), expected);
    });
  }

  it('cada framework tem amostra sem e com cores', () => {
    const all = [...GENERATED, ...DOCUMENTED];
    for (const framework of ['node:test', 'jest', 'vitest', 'pytest', 'phpunit', 'pest', 'go', 'playwright']) {
      const samples = all.filter(([, , expected]) => expected.framework === framework);
      assert.ok(samples.some(([, text]) => !text.includes('\x1B')), `${framework} sem cor`);
      assert.ok(samples.some(([, text]) => text.includes('\x1B')), `${framework} com cor`);
    }
  });

  it('node:test no error do PostToolUseFailure (começa com Exit code N)', () => {
    const error = 'Exit code 1\n✖ soma (1.1ms)\n  AssertionError: x\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ duration_ms 52.3\n';
    assert.deepEqual(parseTestSummary(error), { passed: 0, failed: 1, total: 1, framework: 'node:test' });
  });

  it('Playwright: a duração em cada unidade do msToString e `-`', () => {
    for (const duration of ['0ms', '12ms', '999ms', '1.5s', '59.9s', '2.0m', '1.2h', '1.0d', '-']) {
      assert.deepEqual(parseTestSummary(`  1 failed\n    a.spec.ts:3:1 › falha\n  3 passed (${duration})\n`), {
        passed: 3, failed: 1, total: 4, framework: 'playwright',
      }, duration);
    }
    // Fora do formato do msToString: não é a linha do Playwright.
    for (const duration of ['1.55s', '2 s', '5min', 'ms']) {
      assert.deepEqual(parseTestSummary(`  3 passed (${duration})`), UNKNOWN, duration);
    }
  });

  it('Playwright: flaky, did not run e interrupted entram no total; só `failed` conta como falha', () => {
    const text = '  1 failed\n  2 interrupted\n  1 flaky\n  3 skipped\n  4 did not run\n  5 passed (1.2m)\n';
    assert.deepEqual(parseTestSummary(text), { passed: 5, failed: 1, total: 16, framework: 'playwright' });
    assert.deepEqual(parseTestSummary('  2 interrupted\n  3 did not run\n'), { passed: 0, failed: 0, total: 5, framework: 'playwright' });
  });

  it('vale o resumo que aparece por último (um script que roda dois frameworks)', () => {
    const nodeTest = GENERATED[3][1];
    const playwright = GENERATED[6][1];
    assert.equal(parseTestSummary(`${nodeTest}\n${playwright}`).framework, 'playwright');
    assert.equal(parseTestSummary(`${playwright}\n${nodeTest}`).framework, 'node:test');
  });

  it('texto desconhecido ou de framework fora da lista: null nos números', () => {
    for (const text of [
      'tudo certo',
      'Exit code 1',
      '  2 passing (5ms)\n  1 failing',
      'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
      'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3',
      // Resumo dentro de aspas (uma asserção que imprime o texto) não é resumo.
      "  actual: 'Tests: 1 failed, 2 total'",
      '',
    ]) {
      assert.deepEqual(parseTestSummary(text), UNKNOWN, text);
    }
    for (const value of [undefined, null, 42, {}, ['ℹ tests 1']]) assert.deepEqual(parseTestSummary(value), UNKNOWN);
  });

  it(`lê só os últimos ${SUMMARY_SCAN_CHARS} caracteres, em tempo que não cresce com a saída`, () => {
    const summary = 'ℹ tests 2\nℹ pass 2\nℹ fail 0\n';
    assert.equal(parseTestSummary(`${summary}${'x\n'.repeat(SUMMARY_SCAN_CHARS)}`).framework, null);
    const output = (size) => `${'✔ soma (0.1ms)\n'.repeat(size)}${summary}`;
    assert.deepEqual(parseTestSummary(output(100_000)), { passed: 2, failed: 0, total: 2, framework: 'node:test' });
    // Razão contra 1/16 do tamanho (ADR 0010): só o fim é lido, então fica perto de 1.
    const growth = growthWithin(parseTestSummary, output(6_250), output(100_000), { maxRatio: 4 });
    assert.ok(growth.ok, growth.text);
  });
});

describe('testOk ([T0] V3)', () => {
  it('PostToolUse é ok; PostToolUseFailure não, qualquer que seja o resumo', () => {
    assert.equal(testOk('tool.post'), true);
    assert.equal(testOk('tool.fail'), false);
    assert.equal(testOk('tool.post', { passed: 0, failed: 3, total: 3, framework: 'jest' }), true);
    assert.equal(testOk('tool.fail', { passed: 3, failed: 0, total: 3, framework: 'jest' }), false);
  });
});

describe('framework identificado pelo comando (seção 6, "texto lido")', () => {
  it('testCommandInfo: o framework do comando, ou null quando o comando não diz', () => {
    const cases = [
      ['node --test', 'node:test'], ['npx vitest run', 'vitest'], ['pnpm exec vitest', 'vitest'], ['yarn jest --ci', 'jest'],
      ['cross-env CI=1 jest', 'jest'], ['npx playwright test', 'playwright'], ['bun x playwright test', 'playwright'],
      ['pytest -q', 'pytest'], ['uv run pytest', 'pytest'], ['python -m pytest', 'pytest'], ['go test ./...', 'go'],
      ['vendor/bin/phpunit', 'phpunit'], ['./vendor/bin/pest', 'pest'],
      ['npm test', null], ['npm t', null], ['composer test', null], ['php artisan test', null], ['npx mocha', null],
      ['python -m unittest', null], ['cargo test', null],
    ];
    for (const [command, framework] of cases) assert.equal(testCommandInfo(command)?.framework, framework, command);
    assert.deepEqual(testCommandInfo('npm ci && npx jest'), { kind: 'chained', framework: 'jest' });
    assert.equal(testCommandInfo('npm install'), null);
  });

  it('com o framework, só os padrões dele são tentados; sem ele, a ordem atual', () => {
    const playwrightLine = '  3 passed (1.2s)\n';
    const jest = 'Tests:       1 failed, 2 passed, 3 total\n';
    assert.deepEqual(parseTestSummary(playwrightLine, 'jest'), UNKNOWN);
    assert.equal(parseTestSummary(playwrightLine, null).framework, 'playwright');
    assert.deepEqual(parseTestSummary(`${jest}${playwrightLine}`, 'jest'), { passed: 2, failed: 1, total: 3, framework: 'jest' });
    assert.equal(parseTestSummary(`${jest}${playwrightLine}`).framework, 'playwright');
    // Pest e Jest dividem a linha `Tests:`; o framework do comando escolhe.
    assert.deepEqual(parseTestSummary('  Tests:    1 failed, 2 passed (3 assertions)\n', 'jest'), UNKNOWN);
    assert.equal(parseTestSummary('  Tests:    1 failed, 2 passed (3 assertions)\n', 'pest').framework, 'pest');
  });
});

describe('B13: node:test spec com falhas, sem o resumo (seção 6)', () => {
  // Item da lista de falhas no formato real (Node 24.20, ver GENERATED), com o nome trocado.
  const realItem = GENERATED[0][1].slice(GENERATED[0][1].indexOf('test at'));
  // `diff`: linhas a mais na mensagem, como num deepEqual grande.
  const item = (i, diff = 0) => realItem
    .replace('soma.test.mjs:5:1', `soma.test.mjs:${i + 5}:1`)
    .replace('✖ falha (', `✖ falha ${i} (`)
    .replace('  1 !== 2\n', `  1 !== 2\n${Array.from({ length: diff }, (_, n) => `  +   'linha ${n} do valor'\n`).join('')}`);
  /** Saída do repórter spec: resultados, resumo e, depois, a lista de falhas. */
  const spec = (passes, failures, { extra = '', diff = 0 } = {}) => [
    ...Array.from({ length: passes }, (_, i) => `✔ passa ${i} (0.1ms)`),
    ...Array.from({ length: failures }, (_, i) => `✖ falha ${i} (0.9ms)`),
    `ℹ tests ${passes + failures}`, 'ℹ suites 0', `ℹ pass ${passes}`, `ℹ fail ${failures}`, 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 52.3',
    '', '✖ failing tests:', '',
    ...Array.from({ length: failures }, (_, i) => item(i, diff)),
  ].join('\n') + extra;
  const cut = (text) => cutString(text);
  const partial = (failed) => ({ passed: null, failed, total: null, framework: 'node:test', partial: true });
  /**
   * Saída com 1 falha cortada como pelo encaminhador, com o menor `diff` que tira
   * `ℹ tests` do trecho final e mantém o cabeçalho da lista: o corte cai no meio
   * do resumo, como nas saídas reais do npm test daqui.
   */
  const cutInsideSummary = (extra = '') => {
    for (let diff = 0; diff < 300; diff++) {
      const text = cut(spec(400, 1, { extra, diff }));
      if (!text.includes('ℹ tests') && text.includes('✖ failing tests:')) return text;
    }
    throw new Error('nenhum diff corta o resumo');
  };

  it('a saída inteira continua dando o resumo completo', () => {
    assert.deepEqual(parseTestSummary(spec(120, 1)), { passed: 120, failed: 1, total: 121, framework: 'node:test' });
  });

  it('cortada pelo encaminhador (1 KiB + 3 KiB), com 1 falha: failed 1, parcial', () => {
    const text = cutInsideSummary();
    assert.doesNotMatch(text, /ℹ tests/, 'o resumo caiu no corte');
    assert.deepEqual(parseTestSummary(text), partial(1));
    assert.deepEqual(parseTestSummary(`Exit code 1\n${text}`, 'node:test'), partial(1));
    // Com cores, a mesma contagem.
    const colored = text.replace(/^✖/gm, '\x1B[31m✖').replace(/^test at/gm, '\x1B[0mtest at');
    assert.deepEqual(parseTestSummary(colored), partial(1));
  });

  it('com 40 falhas, cortada: um mínimo entre 1 e 40, e sempre o mesmo', () => {
    const text = cut(spec(100, 40));
    const first = parseTestSummary(text);
    assert.equal(first.partial, true);
    assert.ok(first.failed >= 1 && first.failed <= 40, String(first.failed));
    for (let i = 0; i < 5; i++) assert.deepEqual(parseTestSummary(text), first);
    // Sem o corte e com o cabeçalho fora da janela de leitura, não há lista nem
    // marcador no texto lido (regra do B13): desconhecido. O encaminhador sempre
    // corta textos acima de 4 KiB, então esse caso só aparece chamando direto.
    assert.deepEqual(parseTestSummary(spec(100, 40)), UNKNOWN);
  });

  it('itens de todo ficam de fora (Node 24 marca com ⚠ e # TODO; ✖ com # TODO também sai)', () => {
    const todo = '\ntest at soma.test.mjs:90:1\n⚠ a fazer (0.4ms) # TODO\n  AssertionError: x\n\ntest at soma.test.mjs:91:1\n✖ outro a fazer (0.4ms) # TODO\n  AssertionError: y\n';
    assert.deepEqual(parseTestSummary(cutInsideSummary(todo)), partial(1));
  });

  it('sem a lista nem o marcador, ou com outro framework identificado, nada muda', () => {
    assert.deepEqual(parseTestSummary('test at a.mjs:1:1\n✖ falha\n'), UNKNOWN);
    assert.deepEqual(parseTestSummary(cutInsideSummary(), 'jest'), UNKNOWN);
    // O marcador sem itens depois dele não é lista.
    assert.deepEqual(parseTestSummary(`x…[cortado 10 caracteres]…y\n✖ falha\n`), UNKNOWN);
  });
});
