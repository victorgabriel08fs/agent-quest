// Saídas de testes para o parseTestSummary (T6; modelo de eventos, seção 6).
// Não é arquivo de teste.
//
// - GENERATED: saídas reais geradas nesta máquina em 19/10/2026 (Node 24.20,
//   node:test; @playwright/test 1.64.1, repórter list), sem e com cores
//   (FORCE_COLOR=1). Os caminhos da máquina viraram C:\projeto.
// - DOCUMENTED: os outros frameworks, montadas pelo formato documentado de cada
//   um (Jest, Vitest, pytest, PHPUnit, Pest e go test), sem e com cores ANSI.
//
// Cada item: [nome, saída, { passed, failed, total, framework }].

const E = '\x1B';

/** @type {[string, string, { passed: number|null, failed: number|null, total: number|null, framework: string }][]} */
export const GENERATED = [
  ['node:test, spec, sem cor, com falha, pulado e a fazer', "✔ soma (0.729ms)\n✔ subtração (0.1303ms)\n✖ falha (0.9648ms)\n﹣ pulado (0.8603ms) # SKIP\n✔ a fazer (0.1386ms) # TODO\nℹ tests 5\nℹ suites 0\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 1\nℹ duration_ms 110.3863\n\n✖ failing tests:\n\ntest at soma.test.mjs:5:1\n✖ falha (0.9648ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  \n  1 !== 2\n  \n      at TestContext.<anonymous> (file:///C:/projeto/soma.test.mjs:5:28)\n      at Test.runInAsyncScope (node:async_hooks:227:14)\n      at Test.run (node:internal/test_runner/test:1397:25)\n      at Test.processPendingSubtests (node:internal/test_runner/test:969:18)\n      at Test.postRun (node:internal/test_runner/test:1537:19)\n      at Test.run (node:internal/test_runner/test:1462:12)\n      at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) {\n    generatedMessage: true,\n    code: 'ERR_ASSERTION',\n    actual: 1,\n    expected: 2,\n    operator: 'strictEqual',\n    diff: 'simple'\n  }\n", {passed: 2, failed: 1, total: 5, framework: 'node:test'}],
  ['node:test, spec, com cor, com falha, pulado e a fazer', "\u001b[32m✔ soma \u001b[90m(1.2566ms)\u001b[39m\u001b[39m\n\u001b[32m✔ subtração \u001b[90m(0.158ms)\u001b[39m\u001b[39m\n\u001b[31m✖ falha \u001b[90m(1.3662ms)\u001b[39m\u001b[39m\n\u001b[90m﹣ pulado \u001b[90m(2.1927ms)\u001b[39m # SKIP\u001b[39m\n\u001b[32m✔ a fazer \u001b[90m(0.3238ms)\u001b[39m # TODO\u001b[39m\n\u001b[34mℹ tests 5\u001b[39m\n\u001b[34mℹ suites 0\u001b[39m\n\u001b[34mℹ pass 2\u001b[39m\n\u001b[34mℹ fail 1\u001b[39m\n\u001b[34mℹ cancelled 0\u001b[39m\n\u001b[34mℹ skipped 1\u001b[39m\n\u001b[34mℹ todo 1\u001b[39m\n\u001b[34mℹ duration_ms 193.8275\u001b[39m\n\n\u001b[31m✖ failing tests:\u001b[39m\n\ntest at soma.test.mjs:5:1\n\u001b[31m✖ falha \u001b[90m(1.3662ms)\u001b[39m\u001b[39m\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  \n  1 !== 2\n  \n      at TestContext.<anonymous> \u001b[90m(file:///C:/projeto/\u001b[39msoma.test.mjs:5:28\u001b[90m)\u001b[39m\n  \u001b[90m    at Test.runInAsyncScope (node:async_hooks:227:14)\u001b[39m\n  \u001b[90m    at Test.run (node:internal/test_runner/test:1397:25)\u001b[39m\n  \u001b[90m    at Test.processPendingSubtests (node:internal/test_runner/test:969:18)\u001b[39m\n  \u001b[90m    at Test.postRun (node:internal/test_runner/test:1537:19)\u001b[39m\n  \u001b[90m    at Test.run (node:internal/test_runner/test:1462:12)\u001b[39m\n  \u001b[90m    at async Test.processPendingSubtests (node:internal/test_runner/test:969:7)\u001b[39m {\n    generatedMessage: \u001b[33mtrue\u001b[39m,\n    code: \u001b[32m'ERR_ASSERTION'\u001b[39m,\n    actual: \u001b[33m1\u001b[39m,\n    expected: \u001b[33m2\u001b[39m,\n    operator: \u001b[32m'strictEqual'\u001b[39m,\n    diff: \u001b[32m'simple'\u001b[39m\n  }\n", {passed: 2, failed: 1, total: 5, framework: 'node:test'}],
  ['node:test, TAP, com falha, pulado e a fazer', "TAP version 13\n# Subtest: soma\nok 1 - soma\n  ---\n  duration_ms: 0.8464\n  type: 'test'\n  ...\n# Subtest: subtração\nok 2 - subtração\n  ---\n  duration_ms: 0.1613\n  type: 'test'\n  ...\n# Subtest: falha\nnot ok 3 - falha\n  ---\n  duration_ms: 0.9381\n  type: 'test'\n  location: 'C:\\\\projeto\\\\soma.test.mjs:5:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n    \n    1 !== 2\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: 2\n  actual: 1\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///C:/projeto/soma.test.mjs:5:28)\n    Test.runInAsyncScope (node:async_hooks:227:14)\n    Test.run (node:internal/test_runner/test:1397:25)\n    Test.processPendingSubtests (node:internal/test_runner/test:969:18)\n    Test.postRun (node:internal/test_runner/test:1537:19)\n    Test.run (node:internal/test_runner/test:1462:12)\n    async Test.processPendingSubtests (node:internal/test_runner/test:969:7)\n  ...\n# Subtest: pulado\nok 4 - pulado # SKIP\n  ---\n  duration_ms: 0.9871\n  type: 'test'\n  ...\n# Subtest: a fazer\nok 5 - a fazer # TODO\n  ---\n  duration_ms: 0.1401\n  type: 'test'\n  ...\n1..5\n# tests 5\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 1\n# duration_ms 117.3648\n", {passed: 2, failed: 1, total: 5, framework: 'node:test'}],
  ['node:test, spec, com cor, tudo passa', "\u001b[32m✔ passa \u001b[90m(0.6631ms)\u001b[39m\u001b[39m\n\u001b[34mℹ tests 1\u001b[39m\n\u001b[34mℹ suites 0\u001b[39m\n\u001b[34mℹ pass 1\u001b[39m\n\u001b[34mℹ fail 0\u001b[39m\n\u001b[34mℹ cancelled 0\u001b[39m\n\u001b[34mℹ skipped 0\u001b[39m\n\u001b[34mℹ todo 0\u001b[39m\n\u001b[34mℹ duration_ms 110.749\u001b[39m\n", {passed: 1, failed: 0, total: 1, framework: 'node:test'}],
  ['Playwright, sem cor, com falha e pulado', "\nRunning 4 tests using 1 worker\n\n  ✓  1 a.spec.cjs:2:1 › soma (78ms)\n  ✘  2 a.spec.cjs:3:1 › falha (306ms)\n  -  3 a.spec.cjs:4:6 › pulado\n  ✓  4 a.spec.cjs:5:1 › subtração (240ms)\n\n\n  1) a.spec.cjs:3:1 › falha ────────────────────────────────────────────────────────────────────────\n\n    Error: expect(received).toBe(expected) // Object.is equality\n\n    Expected: 2\n    Received: 1\n\n      1 | const { test, expect } = require('@playwright/test');\n      2 | test('soma', () => { expect(1 + 1).toBe(2); });\n    > 3 | test('falha', () => { expect(1).toBe(2); });\n        |                                 ^\n      4 | test.skip('pulado', () => {});\n      5 | test('subtração', () => { expect(2 - 1).toBe(1); });\n      6 |\n        at C:\\projeto\\a.spec.cjs:3:33\n\n    Error Context: test-results\\a-falha\\error-context.md\n\n  1 failed\n    a.spec.cjs:3:1 › falha ─────────────────────────────────────────────────────────────────────────\n  1 skipped\n  2 passed (18.8s)\n", {passed: 2, failed: 1, total: 4, framework: 'playwright'}],
  ['Playwright, com cor, com falha e pulado', "\n\u001b[2mRunning \u001b[22m4\u001b[2m tests using \u001b[22m1\u001b[2m worker\u001b[22m\n\n  \u001b[32m✓\u001b[39m  \u001b[2m1 \u001b[22ma.spec.cjs:2:1 › soma\u001b[2m (8ms)\u001b[22m\n  \u001b[31m✘\u001b[39m  \u001b[2m2 \u001b[22m\u001b[31ma.spec.cjs:3:1 › falha\u001b[39m\u001b[2m (3ms)\u001b[22m\n  \u001b[32m-\u001b[39m  \u001b[2m3 \u001b[22m\u001b[36ma.spec.cjs:4:6 › pulado\u001b[39m\n  \u001b[32m✓\u001b[39m  \u001b[2m4 \u001b[22ma.spec.cjs:5:1 › subtracao\u001b[2m (6ms)\u001b[22m\n\n\n\u001b[31m  1) a.spec.cjs:3:1 › falha \u001b[2m────────────────────────────────────────────────────────────────────────\u001b[22m\u001b[39m\n\n    Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) // Object.is equality\u001b[22m\n\n    Expected: \u001b[32m2\u001b[39m\n    Received: \u001b[31m1\u001b[39m\n\n    \u001b[0m \u001b[90m 1 |\u001b[39m \u001b[36mconst\u001b[39m { test\u001b[33m,\u001b[39m expect } \u001b[33m=\u001b[39m require(\u001b[32m'@playwright/test'\u001b[39m)\u001b[33m;\u001b[39m\n     \u001b[90m 2 |\u001b[39m test(\u001b[32m'soma'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[35m1\u001b[39m \u001b[33m+\u001b[39m \u001b[35m1\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[35m2\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m\n    \u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 3 |\u001b[39m test(\u001b[32m'falha'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[35m1\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[35m2\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m\n     \u001b[90m   |\u001b[39m                                 \u001b[31m\u001b[1m^\u001b[22m\u001b[39m\n     \u001b[90m 4 |\u001b[39m test\u001b[33m.\u001b[39mskip(\u001b[32m'pulado'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m {})\u001b[33m;\u001b[39m\n     \u001b[90m 5 |\u001b[39m test(\u001b[32m'subtracao'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[35m2\u001b[39m \u001b[33m-\u001b[39m \u001b[35m1\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[35m1\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m\n     \u001b[90m 6 |\u001b[39m\u001b[0m\n    \u001b[2m    at C:\\projeto\\a.spec.cjs:3:33\u001b[22m\n\n\u001b[2m    Error Context: test-results\\a-falha\\error-context.md\u001b[22m\n\n\u001b[31m  1 failed\u001b[39m\n\u001b[31m    a.spec.cjs:3:1 › falha \u001b[2m─────────────────────────────────────────────────────────────────────────\u001b[22m\u001b[39m\n\u001b[33m  1 skipped\u001b[39m\n\u001b[32m  2 passed\u001b[39m\u001b[2m (1.3s)\u001b[22m\n", {passed: 2, failed: 1, total: 4, framework: 'playwright'}],
  ['Playwright, sem cor, tudo passa', "\nRunning 3 tests using 1 worker\n\n  ✓  1 ok.spec.cjs:2:1 › um (8ms)\n  ✓  2 ok.spec.cjs:3:1 › dois (1ms)\n  ✓  3 ok.spec.cjs:4:1 › tres (1ms)\n\n  3 passed (612ms)\n", {passed: 3, failed: 0, total: 3, framework: 'playwright'}],
  ['Playwright, com cor, tudo passa', "\n\u001b[2mRunning \u001b[22m3\u001b[2m tests using \u001b[22m1\u001b[2m worker\u001b[22m\n\n  \u001b[32m✓\u001b[39m  \u001b[2m1 \u001b[22mok.spec.cjs:2:1 › um\u001b[2m (8ms)\u001b[22m\n  \u001b[32m✓\u001b[39m  \u001b[2m2 \u001b[22mok.spec.cjs:3:1 › dois\u001b[2m (1ms)\u001b[22m\n  \u001b[32m✓\u001b[39m  \u001b[2m3 \u001b[22mok.spec.cjs:4:1 › tres\u001b[2m (1ms)\u001b[22m\n\n\u001b[32m  3 passed\u001b[39m\u001b[2m (562ms)\u001b[22m\n", {passed: 3, failed: 0, total: 3, framework: 'playwright'}],
  ['Playwright, sem cor, flaky', "\nRunning 2 tests using 1 worker\n\n  ✘  1 f.spec.cjs:2:1 › instavel (9ms)\n  ✓  2 f.spec.cjs:2:1 › instavel (retry #1) (6ms)\n  ✓  3 f.spec.cjs:3:1 › estavel (1ms)\n\n\n  1) f.spec.cjs:2:1 › instavel ─────────────────────────────────────────────────────────────────────\n\n    Error: expect(received).toBe(expected) // Object.is equality\n\n    Expected: 1\n    Received: 0\n\n      1 | const { test, expect } = require('@playwright/test');\n    > 2 | test('instavel', ({}, info) => { expect(info.retry).toBe(1); });\n        |                                                     ^\n      3 | test('estavel', () => { expect(1).toBe(1); });\n      4 |\n        at C:\\projeto\\f.spec.cjs:2:53\n\n    Error Context: test-results\\f-instavel\\error-context.md\n\n  1 flaky\n    f.spec.cjs:2:1 › instavel ──────────────────────────────────────────────────────────────────────\n  1 passed (1.1s)\n", {passed: 1, failed: 0, total: 2, framework: 'playwright'}],
  ['Playwright, com cor, flaky', "\n\u001b[2mRunning \u001b[22m2\u001b[2m tests using \u001b[22m1\u001b[2m worker\u001b[22m\n\n  \u001b[31m✘\u001b[39m  \u001b[2m1 \u001b[22m\u001b[31mf.spec.cjs:2:1 › instavel\u001b[39m\u001b[2m (10ms)\u001b[22m\n  \u001b[32m✓\u001b[39m  \u001b[2m2 \u001b[22mf.spec.cjs:2:1 › instavel\u001b[33m (retry #1)\u001b[39m\u001b[2m (7ms)\u001b[22m\n  \u001b[32m✓\u001b[39m  \u001b[2m3 \u001b[22mf.spec.cjs:3:1 › estavel\u001b[2m (1ms)\u001b[22m\n\n\n\u001b[31m  1) f.spec.cjs:2:1 › instavel \u001b[2m─────────────────────────────────────────────────────────────────────\u001b[22m\u001b[39m\n\n    Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) // Object.is equality\u001b[22m\n\n    Expected: \u001b[32m1\u001b[39m\n    Received: \u001b[31m0\u001b[39m\n\n    \u001b[0m \u001b[90m 1 |\u001b[39m \u001b[36mconst\u001b[39m { test\u001b[33m,\u001b[39m expect } \u001b[33m=\u001b[39m require(\u001b[32m'@playwright/test'\u001b[39m)\u001b[33m;\u001b[39m\n    \u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 2 |\u001b[39m test(\u001b[32m'instavel'\u001b[39m\u001b[33m,\u001b[39m ({}\u001b[33m,\u001b[39m info) \u001b[33m=>\u001b[39m { expect(info\u001b[33m.\u001b[39mretry)\u001b[33m.\u001b[39mtoBe(\u001b[35m1\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m\n     \u001b[90m   |\u001b[39m                                                     \u001b[31m\u001b[1m^\u001b[22m\u001b[39m\n     \u001b[90m 3 |\u001b[39m test(\u001b[32m'estavel'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[35m1\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[35m1\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m\n     \u001b[90m 4 |\u001b[39m\u001b[0m\n    \u001b[2m    at C:\\projeto\\f.spec.cjs:2:53\u001b[22m\n\n\u001b[2m    Error Context: test-results\\f-instavel\\error-context.md\u001b[22m\n\n\u001b[33m  1 flaky\u001b[39m\n\u001b[33m    f.spec.cjs:2:1 › instavel \u001b[2m──────────────────────────────────────────────────────────────────────\u001b[22m\u001b[39m\n\u001b[32m  1 passed\u001b[39m\u001b[2m (1.1s)\u001b[22m\n", {passed: 1, failed: 0, total: 2, framework: 'playwright'}],
  ['Playwright, sem cor, interrupted e did not run (maxFailures)', "\nRunning 5 tests using 2 workers\n\n  ✘  2 m.spec.cjs:2:1 › falha logo (11ms)\nTesting stopped early after 1 maximum allowed failures.\n  ✘  1 m.spec.cjs:3:1 › demora (71ms)\n\n\n  1) m.spec.cjs:2:1 › falha logo ───────────────────────────────────────────────────────────────────\n\n    Error: expect(received).toBe(expected) // Object.is equality\n\n    Expected: 2\n    Received: 1\n\n      1 | const { test, expect } = require('@playwright/test');\n    > 2 | test('falha logo', () => { expect(1).toBe(2); });\n        |                                      ^\n      3 | test('demora', async () => { await new Promise((r) => setTimeout(r, 3000)); });\n      4 | test('depois 1', () => {});\n      5 | test('depois 2', () => {});\n        at C:\\projeto\\m.spec.cjs:2:38\n\n    Error Context: test-results\\m-falha-logo\\error-context.md\n\n  1 failed\n    m.spec.cjs:2:1 › falha logo ────────────────────────────────────────────────────────────────────\n  1 interrupted\n    m.spec.cjs:3:1 › demora ────────────────────────────────────────────────────────────────────────\n  3 did not run\n  1 error was not a part of any test, see above for details\n", {passed: 0, failed: 1, total: 5, framework: 'playwright'}],
  ['Playwright, com cor, interrupted e did not run (maxFailures)', "\n\u001b[2mRunning \u001b[22m5\u001b[2m tests using \u001b[22m2\u001b[2m workers\u001b[22m\n\n  \u001b[31m✘\u001b[39m  \u001b[2m2 \u001b[22m\u001b[31mm.spec.cjs:2:1 › falha logo\u001b[39m\u001b[2m (8ms)\u001b[22m\n\u001b[31mTesting stopped early after 1 maximum allowed failures.\u001b[39m\n  \u001b[31m✘\u001b[39m  \u001b[2m1 \u001b[22m\u001b[31mm.spec.cjs:3:1 › demora\u001b[39m\u001b[2m (25ms)\u001b[22m\n\n\n\u001b[31m  1) m.spec.cjs:2:1 › falha logo \u001b[2m───────────────────────────────────────────────────────────────────\u001b[22m\u001b[39m\n\n    Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) // Object.is equality\u001b[22m\n\n    Expected: \u001b[32m2\u001b[39m\n    Received: \u001b[31m1\u001b[39m\n\n    \u001b[0m \u001b[90m 1 |\u001b[39m \u001b[36mconst\u001b[39m { test\u001b[33m,\u001b[39m expect } \u001b[33m=\u001b[39m require(\u001b[32m'@playwright/test'\u001b[39m)\u001b[33m;\u001b[39m\n    \u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 2 |\u001b[39m test(\u001b[32m'falha logo'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m { expect(\u001b[35m1\u001b[39m)\u001b[33m.\u001b[39mtoBe(\u001b[35m2\u001b[39m)\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m\n     \u001b[90m   |\u001b[39m                                      \u001b[31m\u001b[1m^\u001b[22m\u001b[39m\n     \u001b[90m 3 |\u001b[39m test(\u001b[32m'demora'\u001b[39m\u001b[33m,\u001b[39m \u001b[36masync\u001b[39m () \u001b[33m=>\u001b[39m { \u001b[36mawait\u001b[39m \u001b[36mnew\u001b[39m \u001b[33mPromise\u001b[39m((r) \u001b[33m=>\u001b[39m setTimeout(r\u001b[33m,\u001b[39m \u001b[35m3000\u001b[39m))\u001b[33m;\u001b[39m })\u001b[33m;\u001b[39m\n     \u001b[90m 4 |\u001b[39m test(\u001b[32m'depois 1'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m {})\u001b[33m;\u001b[39m\n     \u001b[90m 5 |\u001b[39m test(\u001b[32m'depois 2'\u001b[39m\u001b[33m,\u001b[39m () \u001b[33m=>\u001b[39m {})\u001b[33m;\u001b[39m\u001b[0m\n    \u001b[2m    at C:\\projeto\\m.spec.cjs:2:38\u001b[22m\n\n\u001b[2m    Error Context: test-results\\m-falha-logo\\error-context.md\u001b[22m\n\n\u001b[31m  1 failed\u001b[39m\n\u001b[31m    m.spec.cjs:2:1 › falha logo \u001b[2m────────────────────────────────────────────────────────────────────\u001b[22m\u001b[39m\n\u001b[33m  1 interrupted\u001b[39m\n\u001b[33m    m.spec.cjs:3:1 › demora \u001b[2m────────────────────────────────────────────────────────────────────────\u001b[22m\u001b[39m\n\u001b[33m  3 did not run\u001b[39m\n\u001b[31m  1 error was not a part of any test, see above for details\u001b[39m\n", {passed: 0, failed: 1, total: 5, framework: 'playwright'}],
];

const lines = (/** @type {string[]} */ ...items) => items.join('\n');
/** Cor do Jest e do Vitest (chalk/tinyrainbow): negrito com cor. */
const bold = (/** @type {number} */ color, /** @type {string} */ text) => `${E}[1m${E}[${color}m${text}${E}[39m${E}[22m`;

/** @type {[string, string, { passed: number|null, failed: number|null, total: number|null, framework: string }][]} */
export const DOCUMENTED = [
  // Jest: o resumo vai para o stderr; `Tests:` termina em `N total`.
  ['Jest, sem cor, com falha e pulado', lines(
    'FAIL src/soma.test.js',
    '  ● soma › falha',
    '',
    '    expect(received).toBe(expected) // Object.is equality',
    '',
    'Test Suites: 1 failed, 1 passed, 2 total',
    'Tests:       1 failed, 1 skipped, 4 passed, 6 total',
    'Snapshots:   0 total',
    'Time:        1.234 s',
    'Ran all test suites.',
  ), { passed: 4, failed: 1, total: 6, framework: 'jest' }],
  ['Jest, com cor, com falha e pulado', lines(
    `${E}[1m${E}[31m FAIL ${E}[39m${E}[22m src/soma.test.js`,
    `${E}[1mTest Suites: ${E}[22m${bold(31, '1 failed')}, ${bold(32, '1 passed')}, 2 total`,
    `${E}[1mTests:       ${E}[22m${bold(31, '1 failed')}, ${bold(33, '1 skipped')}, ${bold(32, '4 passed')}, 6 total`,
    `${E}[1mSnapshots:   ${E}[22m0 total`,
    `${E}[1mTime:${E}[22m        1.234 s`,
    `${E}[2mRan all test suites${E}[22m${E}[2m.${E}[22m`,
  ), { passed: 4, failed: 1, total: 6, framework: 'jest' }],
  ['Jest, sem cor, tudo passa, com todo', lines('Test Suites: 1 passed, 1 total', 'Tests:       1 todo, 2 passed, 3 total', 'Time:        0.5 s'),
    { passed: 2, failed: 0, total: 3, framework: 'jest' }],

  // Vitest: `Tests` sem dois-pontos e o total entre parênteses.
  ['Vitest, sem cor, com falha e pulado', lines(
    ' ❯ src/soma.test.ts (6 tests | 1 failed | 1 skipped) 5ms',
    '   × soma > falha 3ms',
    '',
    ' Test Files  1 failed | 1 passed (2)',
    '      Tests  1 failed | 4 passed | 1 skipped (6)',
    '   Start at  10:00:00',
    '   Duration  612ms (transform 20ms, setup 0ms, collect 30ms, tests 5ms, environment 0ms, prepare 100ms)',
  ), { passed: 4, failed: 1, total: 6, framework: 'vitest' }],
  ['Vitest, com cor, com falha e pulado', lines(
    `${E}[2m Test Files ${E}[22m ${bold(31, '1 failed')}${E}[2m | ${E}[22m${bold(32, '1 passed')}${E}[90m (2)${E}[39m`,
    `${E}[2m      Tests ${E}[22m ${bold(31, '1 failed')}${E}[2m | ${E}[22m${bold(32, '4 passed')}${E}[2m | ${E}[22m${E}[33m1 skipped${E}[39m${E}[90m (6)${E}[39m`,
    `${E}[2m   Start at ${E}[22m 10:00:00`,
    `${E}[2m   Duration ${E}[22m 612ms${E}[2m (transform 20ms, setup 0ms, collect 30ms, tests 5ms, environment 0ms, prepare 100ms)${E}[22m`,
  ), { passed: 4, failed: 1, total: 6, framework: 'vitest' }],
  ['Vitest, sem cor, tudo passa', lines(' Test Files  1 passed (1)', '      Tests  3 passed (3)', '   Duration  300ms'),
    { passed: 3, failed: 0, total: 3, framework: 'vitest' }],

  // pytest: a última linha, com ou sem os `=` (-q); erros contam como falhas.
  ['pytest, sem cor, com falha e pulado', lines(
    'FAILED tests/test_soma.py::test_falha - assert 1 == 2',
    '==================== 1 failed, 2 passed, 1 skipped in 0.12s ====================',
  ), { passed: 2, failed: 1, total: 4, framework: 'pytest' }],
  ['pytest, com cor, com falha e pulado', lines(
    `${E}[31mFAILED${E}[0m tests/test_soma.py::${E}[1mtest_falha${E}[0m - assert 1 == 2`,
    `${E}[31m==================== ${E}[31m${E}[1m1 failed${E}[0m, ${E}[32m2 passed${E}[0m, ${E}[33m1 skipped${E}[0m${E}[31m in 0.12s${E}[0m${E}[31m ====================${E}[0m`,
  ), { passed: 2, failed: 1, total: 4, framework: 'pytest' }],
  ['pytest -q, sem cor, tudo passa', lines('...', '3 passed in 0.01s'), { passed: 3, failed: 0, total: 3, framework: 'pytest' }],
  ['pytest, sem cor, com erro e duração longa', '========= 1 failed, 1 passed, 1 error, 2 warnings in 62.50s (0:01:02) =========',
    { passed: 1, failed: 2, total: 3, framework: 'pytest' }],
  ['pytest, sem cor, nenhum teste', '============================ no tests ran in 0.01s =============================',
    { passed: 0, failed: 0, total: 0, framework: 'pytest' }],

  // PHPUnit: `OK (N tests, …)` ou `Tests: N, Assertions: M, Failures: F.`; erros contam como falhas.
  ['PHPUnit, sem cor, com falha', lines(
    'PHPUnit 11.4.0 by Sebastian Bergmann and contributors.',
    '',
    '..F.                                                                4 / 4 (100%)',
    '',
    'Time: 00:00.010, Memory: 8.00 MB',
    '',
    'There was 1 failure:',
    '',
    '1) SomaTest::testFalha',
    'Failed asserting that 1 is identical to 2.',
    '',
    'FAILURES!',
    'Tests: 4, Assertions: 4, Failures: 1.',
  ), { passed: 3, failed: 1, total: 4, framework: 'phpunit' }],
  ['PHPUnit, com cor, com erro, falha e pulado', lines(
    `${E}[37;41mERRORS!${E}[0m`,
    `${E}[37;41mTests: 5, Assertions: 3, Errors: 1, Failures: 1, Skipped: 1.${E}[0m`,
  ), { passed: 2, failed: 2, total: 5, framework: 'phpunit' }],
  ['PHPUnit, com cor, tudo passa', lines('Time: 00:00.010, Memory: 8.00 MB', '', `${E}[30;42mOK (4 tests, 6 assertions)${E}[0m`),
    { passed: 4, failed: 0, total: 4, framework: 'phpunit' }],

  // Pest: `Tests:` sem `N total`, com `(N assertions)`; o total é a soma.
  ['Pest, sem cor, com falha', lines(
    '   FAIL  Tests\\Unit\\SomaTest',
    '  ✓ soma',
    '  ⨯ falha',
    '',
    '  Tests:    1 failed, 2 passed (3 assertions)',
    '  Duration: 0.12s',
  ), { passed: 2, failed: 1, total: 3, framework: 'pest' }],
  ['Pest, com cor, com pulado e todos', lines(
    `  ${E}[90mTests:${E}[39m    ${E}[33;1m1 skipped${E}[39;22m${E}[90m,${E}[39m ${E}[36;1m2 todos${E}[39;22m${E}[90m,${E}[39m ${E}[32;1m3 passed${E}[39;22m ${E}[90m(3 assertions)${E}[39m`,
    `  ${E}[90mDuration:${E}[39m ${E}[39m0.10s${E}[39m`,
  ), { passed: 3, failed: 0, total: 6, framework: 'pest' }],

  // go test: falhas pela quantidade de `--- FAIL:` sem recuo (seção 6).
  ['go test -v, sem cor, com falha e subteste', lines(
    '=== RUN   TestSoma',
    '--- PASS: TestSoma (0.00s)',
    '=== RUN   TestFalha',
    '    soma_test.go:10: esperado 2, recebido 1',
    '--- FAIL: TestFalha (0.00s)',
    '=== RUN   TestTabela',
    '=== RUN   TestTabela/caso_1',
    '--- PASS: TestTabela (0.00s)',
    '    --- PASS: TestTabela/caso_1 (0.00s)',
    'FAIL',
    'FAIL\texemplo.com/soma\t0.123s',
    'FAIL',
  ), { passed: 2, failed: 1, total: 3, framework: 'go' }],
  ['go test, com cor, com falha', lines(
    `${E}[31m--- FAIL: TestFalha (0.00s)${E}[0m`,
    '    soma_test.go:10: esperado 2, recebido 1',
    `${E}[31mFAIL${E}[0m`,
    `${E}[31mFAIL${E}[0m\texemplo.com/soma\t0.123s`,
    `${E}[31mFAIL${E}[0m`,
  ), { passed: null, failed: 1, total: null, framework: 'go' }],
  ['go test, sem cor, tudo passa', lines('ok  \texemplo.com/soma\t0.123s', '?   \texemplo.com/cmd\t[no test files]', 'ok  \texemplo.com/util\t(cached)'),
    { passed: null, failed: 0, total: null, framework: 'go' }],
  ['go test, sem cor, falha de compilação', lines('# exemplo.com/soma', './soma.go:3:1: syntax error', 'FAIL\texemplo.com/soma [build failed]', 'FAIL'),
    { passed: null, failed: null, total: null, framework: 'go' }],
];
