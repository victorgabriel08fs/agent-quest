// @ts-check
// Detecção de testes (modelo de eventos, seção 6, "Bug na cena"; plano, T6).
//
// - `testCommandInfo(command)` (e os atalhos `detectTestCommand` e
//   `testCommandKind`): o comando do Bash ou do PowerShell é um comando de
//   teste? Depois de tirar prefixos como `cd <pasta> &&` e atribuições de
//   variáveis, ele precisa ser um dos padrões de TEST_COMMANDS, sozinho ou no
//   fim de uma cadeia `&&`, e pode identificar o framework. A lista fica só
//   aqui, com testes por tabela.
// - `parseTestSummary(text, framework)`: `passed`, `failed`, `total` e
//   `framework` lidos do resumo no fim da saída crua (com o framework do
//   comando, só os padrões dele). Os padrões são testados no texto limpo pelas
//   etapas 1 e 7 da redação, sem redigir (`plainText`, seção 10), porque resumos
//   coloridos são comuns. Só números e o nome do framework saem daqui: nada da
//   saída entra no fato.
// - `testOk(kind)`: o `ok` do resultado, isolado porque depende do V3 [T0].
//
// Puro e linear: o comando e a saída são lidos só num trecho limitado, e cada
// expressão é ancorada no início de um trecho ou de uma linha.

import { plainText } from './redact.js';

/** Quantos caracteres do começo do comando são examinados. */
export const COMMAND_SCAN_CHARS = 4096;

/** Quantos caracteres do fim da saída são examinados (o resumo fica no fim). */
export const SUMMARY_SCAN_CHARS = 8192;

// Executor antes do runner de JavaScript (seção 6, ajustes do T6): npx (com
// opções), pnpm, pnpm exec, pnpm dlx, yarn, bunx e bun x.
const RUNNER = String.raw`(?:npx(?:\s+-\S+)*\s+|pnpm\s+(?:(?:exec|dlx)\s+)?|yarn\s+|bunx\s+|bun\s+x\s+)?`;
// Nome de script de teste: `test` e, depois, só o fim do nome ou um separador
// (`:`, `-`, `.` ou `_`) com o resto: `test:unit` e `test-e2e` contam; `testing` não.
const SCRIPT = String.raw`test(?:[:._-]\S*)?(?=\s|$)`;

/**
 * Padrões de comando de teste (seção 6), testados no começo do último trecho
 * depois de tirar os prefixos. Sem diferença de caixa, como no Windows.
 * `framework`: o framework que o comando identifica, para restringir os padrões
 * de resumo (seção 6, "texto lido"); null quando o comando não diz (`npm test`).
 * @type {readonly { pattern: RegExp, framework: string|null }[]}
 */
export const TEST_COMMANDS = Object.freeze([
  // npm, pnpm, yarn e bun: o script `test…` direto ou com `run`; `npm t` é o atalho do npm.
  { pattern: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?${SCRIPT}`, 'i'), framework: null },
  { pattern: /^npm\s+t(?=\s|$)/i, framework: null },
  { pattern: new RegExp(String.raw`^composer\s+${SCRIPT}`, 'i'), framework: null },
  { pattern: /^node\s+(?:--\S+\s+)*--test(?=[\s=]|$)/i, framework: 'node:test' },
  { pattern: new RegExp(String.raw`^${RUNNER}vitest(?=\s|$)`, 'i'), framework: 'vitest' },
  { pattern: new RegExp(String.raw`^${RUNNER}jest(?=\s|$)`, 'i'), framework: 'jest' },
  { pattern: new RegExp(String.raw`^${RUNNER}(?:mocha|ava)(?=\s|$)`, 'i'), framework: null },
  { pattern: new RegExp(String.raw`^${RUNNER}playwright\s+test(?=\s|$)`, 'i'), framework: 'playwright' },
  { pattern: /^(?:(?:uv|poetry|pipenv)\s+run\s+)?pytest(?=\s|$)/i, framework: 'pytest' },
  { pattern: /^(?:python3?|py)\s+-m\s+pytest(?=\s|$)/i, framework: 'pytest' },
  { pattern: /^(?:python3?|py)\s+-m\s+unittest(?=\s|$)/i, framework: null },
  { pattern: /^php\s+artisan\s+test(?=\s|$)/i, framework: null },
  { pattern: /^(?:php\s+)?(?:\.[\\/])?(?:vendor[\\/]bin[\\/])?phpunit(?=\s|$)/i, framework: 'phpunit' },
  { pattern: /^(?:php\s+)?(?:\.[\\/])?(?:vendor[\\/]bin[\\/])?pest(?=\s|$)/i, framework: 'pest' },
  { pattern: /^go\s+test(?=\s|$)/i, framework: 'go' },
  { pattern: /^cargo\s+test(?=\s|$)/i, framework: null },
  { pattern: /^dotnet\s+test(?=\s|$)/i, framework: null },
  { pattern: /^(?:\.[\\/])?mvnw?\s+test(?=\s|$)/i, framework: null },
  { pattern: /^(?:\.[\\/])?gradlew?(?:\.bat)?\s+test(?=\s|$)/i, framework: null },
]);

// Prefixos que não decidem: troca de pasta e atribuição de variável (bash,
// cmd e PowerShell), separados do resto por `&&`, `;` ou quebra de linha.
const PREFIX_SEGMENT = /^(?:(?:cd|pushd|chdir|set-location)(?:\s|$)|(?:export|set)\s+[A-Za-z_][A-Za-z0-9_]*=|\$env:[A-Za-z_][A-Za-z0-9_]*\s*=|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)$)/i;
// Atribuições no começo do trecho, antes do comando (`CI=true npm test`).
const LEADING_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
// `env [VAR=valor…]` e `cross-env [VAR=valor…]`, este também depois de `npx`.
const ENV_PREFIX = /^(?:(?:npx(?:\s+-\S+)*\s+)?cross-env|env)(?:\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*))*\s+/i;

/**
 * @typedef {object} TestCommand
 * @property {'plain'|'chained'} kind
 * @property {string|null} framework     o framework que o comando identifica, ou null
 */

/**
 * Comando de teste (seção 6), depois dos prefixos:
 * - `kind: 'plain'`: um trecho só, que é comando de teste (`cd app && npm test`);
 * - `kind: 'chained'`: cadeia `&&` cujo último trecho é comando de teste
 *   (`npm run build && npm test`), marcada no fato com `testResult.chained`,
 *   porque a falha pode ter vindo de um trecho anterior;
 * - `null`: não é teste, inclusive cadeias com `;`, `||` ou quebra de linha
 *   depois dos prefixos e o teste no meio da cadeia.
 * Separadores dentro de aspas simples ou duplas não dividem trechos. Comando
 * maior que COMMAND_SCAN_CHARS também é `null`: o trecho lido não diz se o teste
 * é o último. Não olha o `run_in_background` (tools.js decide).
 * @param {unknown} command               tool_input.command
 * @returns {TestCommand|null}
 */
export function testCommandInfo(command) {
  if (typeof command !== 'string' || command.length > COMMAND_SCAN_CHARS) return null;
  /** @type {string[]} */
  const chain = [];
  for (const { separator, text } of splitSegments(plainText(command))) {
    const segment = text.trim();
    if (segment === '') continue;
    if (chain.length === 0) {
      if (separator === '||') return null;
      if (PREFIX_SEGMENT.test(segment)) continue;
    } else if (separator !== '&&') {
      return null;
    }
    chain.push(segment);
  }
  if (chain.length === 0) return null;
  const last = chain[chain.length - 1].replace(LEADING_ASSIGNMENTS, '').replace(ENV_PREFIX, '');
  const match = TEST_COMMANDS.find(({ pattern }) => pattern.test(last));
  if (match === undefined) return null;
  return { kind: chain.length > 1 ? 'chained' : 'plain', framework: match.framework };
}

/**
 * Forma do comando de teste: `'plain'`, `'chained'` ou null (testCommandInfo).
 * @param {unknown} command               tool_input.command
 * @returns {'plain'|'chained'|null}
 */
export function testCommandKind(command) {
  return testCommandInfo(command)?.kind ?? null;
}

/**
 * É comando de teste (seção 6), sozinho ou no fim de uma cadeia `&&`?
 * @param {unknown} command               tool_input.command
 * @returns {boolean}
 */
export function detectTestCommand(command) {
  return testCommandInfo(command) !== null;
}

/**
 * Trechos do comando com o separador antes de cada um (`&&`, `||`, `;` ou
 * quebra de linha; null no primeiro). Separadores dentro de aspas simples ou
 * duplas não contam; aspa sem fechamento vai até o fim. Uma passada só.
 * @param {string} text
 * @returns {{ separator: string|null, text: string }[]}
 */
function splitSegments(text) {
  /** @type {{ separator: string|null, text: string }[]} */
  const parts = [];
  /** @type {string|null} */
  let separator = null;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote !== '') {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const pair = text.slice(i, i + 2);
    const found = pair === '&&' || pair === '||' || pair === '\r\n' ? pair : char === ';' || char === '\n' || char === '\r' ? char : null;
    if (found === null) continue;
    parts.push({ separator, text: text.slice(start, i) });
    separator = found;
    i += found.length - 1;
    start = i + 1;
  }
  parts.push({ separator, text: text.slice(start) });
  return parts;
}

/**
 * @typedef {object} TestSummary
 * @property {number|null} passed
 * @property {number|null} failed
 * @property {number|null} total
 * @property {string|null} framework     'node:test', 'jest', 'vitest', 'pytest', 'phpunit', 'pest', 'go' ou 'playwright'
 * @property {true} [partial]             só na contagem mínima da lista de falhas do node:test (B13)
 */

/** @type {TestSummary} */
const UNKNOWN = Object.freeze({ passed: null, failed: null, total: null, framework: null });

/** Números de um resumo: até 9 dígitos, para não virar notação científica. */
const COUNT = '(\\d{1,9})';

// node:test, repórter spec (`ℹ tests 5`) e TAP (`# tests 5`).
const NODE_TEST_LINE = new RegExp(`^\\s*(?:ℹ|#)\\s+(tests|pass|fail)\\s+${COUNT}\\s*$`);
// Jest (`Tests: 1 failed, 2 passed, 3 total`) e Pest (`Tests: 1 failed, 2 passed (3 assertions)`).
const TESTS_COLON_LINE = /^\s*Tests:\s+(\d{1,9} [a-z]+(?:, \d{1,9} [a-z]+)*)(?: \(\d{1,9} assertions?\))?\s*$/;
// Vitest (`Tests  1 failed | 2 passed (3)`).
const VITEST_LINE = /^\s*Tests\s+(\d{1,9} [a-z]+(?: [a-z]+)?(?: \| \d{1,9} [a-z]+(?: [a-z]+)?)*) \((\d{1,9})\)\s*$/;
// pytest, última linha (`=== 1 failed, 2 passed in 0.12s ===`, ou sem os `=` com -q).
const PYTEST_LINE = /^=*\s*(\d{1,9} [a-z]+(?:, \d{1,9} [a-z]+)*|no tests ran) in \d{1,9}(?:\.\d+)?s(?: \([\d:]+\))?\s*=*\s*$/;
// PHPUnit: sucesso (`OK (3 tests, 5 assertions)`) e falha (`Tests: 3, Assertions: 5, Failures: 1.`).
const PHPUNIT_OK_LINE = /^\s*OK \((\d{1,9}) tests?, \d{1,9} assertions?\)\s*$/;
const PHPUNIT_COUNTS_LINE = /^\s*Tests: (\d{1,9}), Assertions: \d{1,9}((?:, [A-Za-z ]+: \d{1,9})*)\.\s*$/;
// go test: `--- FAIL:` e `--- PASS:` sem recuo (os recuados são subtestes) e as linhas de pacote.
const GO_RESULT_LINE = /^--- (FAIL|PASS): /;
const GO_PACKAGE_LINE = /^(ok|FAIL)\s+\S+\s+(?:\d{1,9}(?:\.\d+)?s|\(cached\))(?:\s|$)|^(PASS|FAIL)$/;
// Playwright, uma contagem por linha (seção 6): só números, unidades e um vocabulário fechado.
const PLAYWRIGHT_LINE = /^\s*(\d{1,9}) (passed|failed|flaky|skipped|did not run|interrupted)( \((\d+(\.\d)?(ms|s|m|h|d)|-)\))?\s*$/;

// Lista de falhas do node:test (repórter spec): o cabeçalho e, em cada item, a
// linha `test at <arquivo>:<linha>:<coluna>` seguida de `✖ <nome>` (B13).
const NODE_FAILING_HEADER = /^\s*✖ failing tests:\s*$/;
const NODE_FAILING_ITEM = /^\s*test at \S/;
const CUT_MARKER = /…\[cortado \d+ caracteres\]…/;

/**
 * Resumo de testes no fim da saída (seção 6, "Contagem"). Vale o framework cujo
 * resumo aparece por último no trecho lido. Com `framework` (identificado pelo
 * comando), só os padrões dele são tentados. Sem resumo, a lista de falhas do
 * node:test dá uma contagem mínima, com `partial: true` (B13). Texto
 * desconhecido: tudo null.
 * @param {unknown} text                 saída crua (stdout, stderr ou o `error`)
 * @param {string|null} [framework]      framework identificado pelo comando, ou null
 * @returns {TestSummary}
 */
export function parseTestSummary(text, framework = null) {
  if (typeof text !== 'string' || text === '') return { ...UNKNOWN };
  try {
    const lines = plainText(text.slice(-SUMMARY_SCAN_CHARS)).split(/\r\n|\r|\n/);
    let best = { at: -1, summary: UNKNOWN };
    for (const read of READERS) {
      const found = read(lines);
      if (found === null || (framework !== null && found.summary.framework !== framework)) continue;
      if (found.at > best.at) best = found;
    }
    if (best.summary === UNKNOWN && (framework === null || framework === 'node:test')) {
      const failed = nodeTestFailures(lines);
      if (failed > 0) return { passed: null, failed, total: null, framework: 'node:test', partial: true };
    }
    return { ...best.summary };
  } catch {
    return { ...UNKNOWN };
  }
}

/**
 * B13: no repórter spec do node:test, o resumo sai antes da lista de falhas e
 * some no corte do encaminhador. Sem resumo, conta os itens visíveis da lista
 * (`✖ failing tests:`, ou o marcador de corte seguido de itens): a linha
 * `test at …` seguida de uma que começa com `✖` e não tem `# TODO`. É um
 * mínimo: com muitas falhas, só as visíveis contam.
 * @param {string[]} lines
 * @returns {number}                     0 se não há lista
 */
function nodeTestFailures(lines) {
  let start = -1;
  for (let index = lines.length - 1; index >= 0 && start < 0; index--) {
    if (NODE_FAILING_HEADER.test(lines[index])) start = index;
  }
  for (let index = lines.length - 1; index >= 0 && start < 0; index--) {
    if (CUT_MARKER.test(lines[index])) start = index;
  }
  if (start < 0) return 0;
  let failed = 0;
  for (let index = start + 1; index < lines.length - 1; index++) {
    if (!NODE_FAILING_ITEM.test(lines[index])) continue;
    const next = lines[index + 1].trimStart();
    if (next.startsWith('✖') && !next.includes('# TODO')) failed++;
  }
  return failed;
}

/**
 * [T0] V3: o `ok` vem do hook. PostToolUse (`tool.post`) é `true` e
 * PostToolUseFailure (`tool.fail`) é `false`: segundo a documentação, Bash que
 * termina com código diferente de zero gera PostToolUseFailure com `error`
 * começando por `Exit code N`. Se o T0 refutar o V3, só esta função muda: o
 * resultado passa a vir só do resumo (`summary.failed`).
 * @param {'tool.post'|'tool.fail'} kind
 * @param {TestSummary} [summary]        usado só se o V3 for refutado
 * @returns {boolean}
 */
export function testOk(kind, summary) {
  return kind === 'tool.post';
}

/**
 * @typedef {{ at: number, summary: TestSummary }} Found
 * @typedef {(lines: string[]) => Found|null} SummaryReader
 */

/** @type {SummaryReader[]} */
const READERS = [readNodeTest, readTestsColon, readVitest, readPytest, readPhpunit, readGo, readPlaywright];

/** @type {SummaryReader} */
function readNodeTest(lines) {
  /** @type {Record<string, number>} */
  const counts = {};
  let at = -1;
  lines.forEach((line, index) => {
    const match = NODE_TEST_LINE.exec(line);
    if (!match) return;
    counts[match[1]] = Number(match[2]);
    at = index;
  });
  if (at < 0 || counts.tests === undefined) return null;
  return { at, summary: { passed: counts.pass ?? null, failed: counts.fail ?? null, total: counts.tests, framework: 'node:test' } };
}

/** Jest e Pest: a mesma linha `Tests:`; só o Jest tem `N total`. @type {SummaryReader} */
function readTestsColon(lines) {
  const found = lastMatch(lines, TESTS_COLON_LINE);
  if (found === null) return null;
  const counts = labeledCounts(found.match[1], ', ');
  if (counts === null) return null;
  if (counts.has('total')) {
    return { at: found.at, summary: { passed: counts.get('passed') ?? 0, failed: counts.get('failed') ?? 0, total: counts.get('total') ?? 0, framework: 'jest' } };
  }
  return { at: found.at, summary: { passed: counts.get('passed') ?? 0, failed: counts.get('failed') ?? 0, total: sum(counts), framework: 'pest' } };
}

/** @type {SummaryReader} */
function readVitest(lines) {
  const found = lastMatch(lines, VITEST_LINE);
  if (found === null) return null;
  const counts = labeledCounts(found.match[1], ' | ');
  if (counts === null) return null;
  return { at: found.at, summary: { passed: counts.get('passed') ?? 0, failed: counts.get('failed') ?? 0, total: Number(found.match[2]), framework: 'vitest' } };
}

/** Falhas e erros contam como falhas; o total soma o que rodou ou foi pulado. @type {SummaryReader} */
function readPytest(lines) {
  const found = lastMatch(lines, PYTEST_LINE);
  if (found === null) return null;
  if (found.match[1] === 'no tests ran') return { at: found.at, summary: { passed: 0, failed: 0, total: 0, framework: 'pytest' } };
  const counts = labeledCounts(found.match[1], ', ');
  if (counts === null) return null;
  const get = (/** @type {string} */ label) => counts.get(label) ?? 0;
  const failed = get('failed') + get('error') + get('errors');
  const passed = get('passed');
  const total = failed + passed + get('skipped') + get('xfailed') + get('xpassed');
  return { at: found.at, summary: { passed, failed, total, framework: 'pytest' } };
}

/** Falhas e erros contam como falhas; aprovados são o resto, menos pulados e incompletos. @type {SummaryReader} */
function readPhpunit(lines) {
  let at = -1;
  /** @type {TestSummary} */
  let summary = UNKNOWN;
  lines.forEach((line, index) => {
    const ok = PHPUNIT_OK_LINE.exec(line);
    if (ok) {
      const total = Number(ok[1]);
      at = index;
      summary = { passed: total, failed: 0, total, framework: 'phpunit' };
      return;
    }
    const match = PHPUNIT_COUNTS_LINE.exec(line);
    if (!match) return;
    /** @type {Map<string, number>} */
    const extra = new Map();
    for (const item of match[2].split(', ').slice(1)) {
      const [label, value] = item.split(': ');
      extra.set(label.trim().toLowerCase(), Number(value));
    }
    const get = (/** @type {string} */ label) => extra.get(label) ?? 0;
    const total = Number(match[1]);
    const failed = get('failures') + get('errors');
    at = index;
    summary = { passed: Math.max(0, total - failed - get('skipped') - get('incomplete')), failed, total, framework: 'phpunit' };
  });
  return at < 0 ? null : { at, summary };
}

/** Falhas: quantidade de `--- FAIL:` (seção 6). Pacote que falhou sem nenhum: desconhecido. @type {SummaryReader} */
function readGo(lines) {
  let at = -1;
  let failed = 0;
  let passed = 0;
  let packageFailed = false;
  lines.forEach((line, index) => {
    const result = GO_RESULT_LINE.exec(line);
    if (result) {
      if (result[1] === 'FAIL') failed++;
      else passed++;
      at = index;
      return;
    }
    const pkg = GO_PACKAGE_LINE.exec(line);
    if (!pkg) return;
    if ((pkg[1] ?? pkg[2]) === 'FAIL') packageFailed = true;
    at = index;
  });
  if (at < 0) return null;
  const failedCount = failed > 0 ? failed : packageFailed ? null : 0;
  const passedCount = passed > 0 ? passed : null;
  const total = passedCount !== null && failedCount !== null ? passedCount + failedCount : null;
  return { at, summary: { passed: passedCount, failed: failedCount, total, framework: 'go' } };
}

/** Total: a soma das seis contagens (seção 6, formato conferido no código-fonte). @type {SummaryReader} */
function readPlaywright(lines) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  let at = -1;
  lines.forEach((line, index) => {
    const match = PLAYWRIGHT_LINE.exec(line);
    if (!match) return;
    counts.set(match[2], Number(match[1]));
    at = index;
  });
  if (at < 0) return null;
  return { at, summary: { passed: counts.get('passed') ?? 0, failed: counts.get('failed') ?? 0, total: sum(counts), framework: 'playwright' } };
}

/**
 * Última linha que casa com `pattern`.
 * @param {string[]} lines
 * @param {RegExp} pattern
 * @returns {{ at: number, match: RegExpExecArray }|null}
 */
function lastMatch(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = pattern.exec(lines[index]);
    if (match) return { at: index, match };
  }
  return null;
}

/**
 * `1 failed, 2 passed` → { failed: 1, passed: 2 }. Rótulo repetido: null.
 * @param {string} text
 * @param {string} separator
 * @returns {Map<string, number>|null}
 */
function labeledCounts(text, separator) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of text.split(separator)) {
    const space = item.indexOf(' ');
    const label = item.slice(space + 1);
    if (counts.has(label)) return null;
    counts.set(label, Number(item.slice(0, space)));
  }
  return counts;
}

/**
 * @param {Map<string, number>} counts
 * @returns {number}
 */
function sum(counts) {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}
