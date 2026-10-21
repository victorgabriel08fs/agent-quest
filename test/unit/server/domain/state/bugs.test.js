// SINTÉTICO: bugs na cena e saúde do comando de teste (T8; modelo de eventos,
// seção 6, "Bug na cena" e "Saúde", com as decisões de 19/10/2026 sobre teste
// interrompido e cadeia `&&`). Os fatos são montados direto na forma da seção 2
// (`testResult: { ok, passed, failed, total, framework }`, mais o `chained`
// interno do T6), sem passar pelo normalizador: o `testResult` é preparado pelo
// T6, e aqui o reducer é testado contra a forma documentada. Relógio injetado.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply, createState, getSessionState } from '../../../../../server/domain/state/index.js';
import { recordTestRun, testResultOf, testRunEffect } from '../../../../../server/domain/state/quests.js';
import { START, assertEvents, assertRunShape, sessionId } from './scenarios.js';

const SID = sessionId('bugs');
const PROJECT_DIR = 'C:\\Users\\fulana\\Projetos\\agents-quest';

/** Fato com os campos comuns da seção 2. */
function common(kind, hook, ts, fields = {}) {
  return {
    kind, hook, sessionId: SID, agentId: null, agentType: null, agentTypeKey: null, promptId: null,
    projectDir: PROJECT_DIR, client: 'terminal', ts, receivedAt: ts, transcriptPath: null, ...fields,
  };
}

/** Campos de ferramenta de um comando de teste (seção 2, `tool.pre`). */
function testTool(toolUseId, command) {
  return {
    toolUseId, tool: 'Bash', category: 'test', target: command, detail: 'Rodar a suíte', inputHash: `hash-${toolUseId}`,
    background: false, subagentType: null, subagentTypeKey: null, description: null,
  };
}

/**
 * Um run de testes: Pre e Post (ok) ou Failure, com o `testResult` dado.
 * @returns {object[]} os dois fatos
 */
function testRun(toolUseId, ts, testResult, { ok = testResult?.ok ?? true, promptId = null, interrupted = false, command = 'npm test' } = {}) {
  const tool = testTool(toolUseId, command);
  const pre = common('tool.pre', 'PreToolUse', ts, { promptId, ...tool });
  const end = ok
    ? common('tool.post', 'PostToolUse', ts + 5, { promptId, ...tool, durationMs: 5, linkedAgentId: null, launch: null, testResult })
    : common('tool.fail', 'PostToolUseFailure', ts + 5, { promptId, ...tool, durationMs: 5, error: interrupted ? null : 'Exit code 1', interrupted, testResult });
  return [pre, end];
}

/** Aplica os fatos em ordem, com o relógio igual ao ts de cada um. */
function applyAll(state, facts) {
  const events = [];
  for (const fact of facts) events.push(...apply(state, fact, fact.ts).events);
  return events;
}

const failed3 = { ok: false, passed: 7, failed: 3, total: 10, framework: 'node:test' };
const passed10 = { ok: true, passed: 10, failed: 0, total: 10, framework: 'node:test' };

describe('[T0] V3: bugs na cena (o ok vem do T6)', () => {
  it('run com 3 falhas → bugs.open = 3; run seguinte aprovado → bugs.open = 0 e bugsCrushed = 3', () => {
    const state = createState();
    const t0 = START;
    const first = applyAll(state, [common('session.start', 'SessionStart', t0, { source: 'startup', model: null, sessionTitle: null }), ...testRun('toolu_01falha', t0 + 10, failed3)]);
    assertEvents(first, [
      ['session.started', null],
      ['quest.started', 'main'],
      ['tool.started', 'main'],
      ['tool.failed', 'main', { error: 'Exit code 1' }],
      ['test.finished', 'main', { toolUseId: 'toolu_01falha', ok: false, passed: 7, failed: 3, total: 10, framework: 'node:test' }],
    ], { kinds: null });
    let session = getSessionState(state, SID);
    assert.deepEqual(session.bugs, { open: 3, lastRun: { ...failed3, at: t0 + 15 } });
    assert.equal(session.counters.bugsCrushed, 0);

    const second = applyAll(state, testRun('toolu_01passou', t0 + 100, passed10));
    assertEvents(second, [
      ['tool.started', 'main'],
      ['tool.finished', 'main'],
      ['test.finished', 'main', { ok: true, failed: 0 }],
    ], { kinds: null });
    session = getSessionState(state, SID);
    assert.deepEqual(session.bugs, { open: 0, lastRun: { ...passed10, at: t0 + 105 } });
    assert.equal(session.counters.bugsCrushed, 3);
    assertRunShape({ state, events: [...first, ...second] });
  });

  it('falha sem contagem reconhecida → 1 bug', () => {
    const state = createState();
    applyAll(state, testRun('toolu_01semResumo', START, { ok: false, passed: null, failed: null, total: null, framework: null }));
    assert.equal(getSessionState(state, SID).bugs.open, 1);
  });

  it('falha com failed 0 (nenhum teste falhou, outra coisa derrubou o run) segue failed ?? 1: 0 bugs; run que falha de novo substitui, não soma', () => {
    const state = createState();
    applyAll(state, testRun('toolu_01zero', START, { ok: false, passed: 5, failed: 0, total: 5, framework: 'jest' }));
    assert.equal(getSessionState(state, SID).bugs.open, 0);
    applyAll(state, testRun('toolu_01dois', START + 100, { ok: false, passed: 3, failed: 2, total: 5, framework: 'jest' }));
    assert.equal(getSessionState(state, SID).bugs.open, 2);
    applyAll(state, testRun('toolu_01verde', START + 200, { ok: true, passed: 5, failed: 0, total: 5, framework: 'jest' }));
    assert.deepEqual(getSessionState(state, SID).counters.bugsCrushed, 2);
  });

  it('os bugs são da sessão: não zeram no ticket seguinte', () => {
    const state = createState();
    const prompt = (ts, promptId) => common('prompt.submit', 'UserPromptSubmit', ts, { promptId, title: 'Pedido', origin: 'user', sessionTitle: null });
    applyAll(state, [prompt(START, 'p-1'), ...testRun('toolu_01t1', START + 10, failed3, { promptId: 'p-1' })]);
    applyAll(state, [prompt(START + 100, 'p-2')]);
    const session = getSessionState(state, SID);
    assert.equal(session.quest.n, 2);
    assert.equal(session.bugs.open, 3);
  });

  it('comando sem testResult (por exemplo, run_in_background) não mexe nos bugs', () => {
    const state = createState();
    applyAll(state, testRun('toolu_01falha', START, failed3));
    const events = applyAll(state, testRun('toolu_01fundo', START + 100, null, { ok: false }));
    assert.ok(!events.some((event) => event.kind === 'test.finished'));
    assert.equal(getSessionState(state, SID).bugs.open, 3);
  });

  it('testResult malformado é ignorado (leitura defensiva), sem quebrar o reducer', () => {
    const state = createState();
    for (const [i, bad] of [{ ok: 'sim' }, { ok: true, failed: -2, passed: 1.5, total: 'x', framework: 7 }, [], 'texto'].entries()) {
      applyAll(state, testRun(`toolu_01ruim${i}`, START + i * 100, /** @type {any} */ (bad), { ok: true }));
    }
    const session = getSessionState(state, SID);
    assert.deepEqual(session.bugs.lastRun, { ok: true, passed: null, failed: null, total: null, framework: null, at: START + 105 });
  });
});

describe('[T0] V12: teste interrompido e cadeia && (decisões de 19/10/2026)', () => {
  const interruptedRun = { ok: false, passed: null, failed: null, total: null, framework: null };

  it('Esc durante npm test mantém bugs.open: sem test.finished, sem run e fora da saúde', () => {
    const state = createState();
    applyAll(state, testRun('toolu_01antes', START, failed3));
    const events = applyAll(state, testRun('toolu_01esc', START + 100, interruptedRun, { interrupted: true }));
    assertEvents(events, [
      ['tool.started', 'main'],
      ['tool.failed', 'main', { interrupted: true }],
    ], { kinds: null });
    const session = getSessionState(state, SID);
    assert.deepEqual(session.bugs, { open: 3, lastRun: { ...failed3, at: START + 5 } });
    assert.deepEqual(session.agents[0].health, { ok: 0, total: 1 });
  });

  it('npm run build && npm test com o build falhando, sem contagem: sem test.finished, bugs e lastRun iguais, e o tool.failed conta na saúde', () => {
    const state = createState();
    applyAll(state, testRun('toolu_01antes', START, failed3));
    const chainedNoCount = { ok: false, passed: null, failed: null, total: null, framework: null, chained: true };
    const events = applyAll(state, testRun('toolu_01cadeia', START + 100, chainedNoCount, { command: 'npm run build && npm test' }));
    assertEvents(events, [
      ['tool.started', 'main'],
      ['tool.failed', 'main', { error: 'Exit code 1' }],
    ], { kinds: null });
    const session = getSessionState(state, SID);
    assert.deepEqual(session.bugs, { open: 3, lastRun: { ...failed3, at: START + 5 } });
    assert.deepEqual(session.agents[0].health, { ok: 0, total: 2 }, 'o run anterior e o tool.failed da cadeia');
  });

  it('cadeia que passou emite test.finished aprovado, sem o chained no evento', () => {
    const state = createState();
    const events = applyAll(state, testRun('toolu_01cadeiaOk', START, { ...passed10, chained: true }, { command: 'npm ci && npm test' }));
    assertEvents(events.slice(-1), [['test.finished', 'main', { ok: true, passed: 10 }]], { kinds: null });
    assert.deepEqual(Object.keys(events.at(-1).data), ['toolUseId', 'ok', 'passed', 'failed', 'total', 'framework'], 'chained não vai ao evento');
  });

  it('npm run build && npm test com failed: 3 abre 3; o lastRun não leva o chained', () => {
    const state = createState();
    const chained3 = { ...failed3, chained: true };
    const events = applyAll(state, testRun('toolu_01cadeia3', START, chained3, { command: 'npm run build && npm test' }));
    const session = getSessionState(state, SID);
    assert.deepEqual(session.bugs, { open: 3, lastRun: { ...failed3, at: START + 5 } });
    assertRunShape({ state, events });
  });

  it('cadeia que passa esmaga os abertos como qualquer run aprovado', () => {
    const state = createState();
    applyAll(state, testRun('toolu_01c1', START, failed3));
    applyAll(state, testRun('toolu_01c2', START + 100, { ...passed10, chained: true }, { command: 'npm ci && npm test' }));
    const session = getSessionState(state, SID);
    assert.deepEqual([session.bugs.open, session.counters.bugsCrushed], [0, 3]);
  });
});

describe('saúde: comando de teste contado uma vez, pelo test.finished (seção 6, "Saúde")', () => {
  it('tool.failed interrompido pelo usuário não conta na janela (qualquer ferramenta)', () => {
    const state = createState();
    const tool = { ...testTool('toolu_01ler', 'git status'), category: 'bash' };
    applyAll(state, [
      common('tool.pre', 'PreToolUse', START, tool),
      common('tool.fail', 'PostToolUseFailure', START + 5, { ...tool, durationMs: 5, error: null, interrupted: true, testResult: null }),
    ]);
    assert.deepEqual(getSessionState(state, SID).agents[0].health, { ok: 0, total: 0 });
    const other = { ...tool, toolUseId: 'toolu_01erro' };
    applyAll(state, [
      common('tool.pre', 'PreToolUse', START + 10, other),
      common('tool.fail', 'PostToolUseFailure', START + 15, { ...other, durationMs: 5, error: 'Exit code 128', interrupted: false, testResult: null }),
    ]);
    assert.deepEqual(getSessionState(state, SID).agents[0].health, { ok: 0, total: 1 });
  });

  it('um run com falha conta uma ação falha; um aprovado, uma de sucesso', () => {
    const state = createState();
    applyAll(state, testRun('toolu_01h1', START, failed3));
    let main = getSessionState(state, SID).agents[0];
    assert.deepEqual(main.health, { ok: 0, total: 1 });
    applyAll(state, testRun('toolu_01h2', START + 100, passed10));
    main = getSessionState(state, SID).agents[0];
    assert.deepEqual(main.health, { ok: 1, total: 2 });
  });

  it('test.finished vem depois do tool.finished e antes do permission.resolved da mesma chamada (seção 4)', () => {
    const state = createState();
    const [pre, post] = testRun('toolu_01aprov', START + 10, passed10);
    const request = common('permission.request', 'PermissionRequest', START + 12, { tool: 'Bash', category: 'test', target: 'npm test', inputHash: 'hash-toolu_01aprov' });
    const events = applyAll(state, [pre, request, post]);
    assertEvents(events.slice(-3), [
      ['tool.finished', 'main'],
      ['test.finished', 'main'],
      ['permission.resolved', 'main', { outcome: 'approved', by: 'user' }],
    ], { kinds: null });
  });
});

describe('funções de bugs (quests.js)', () => {
  it('testResultOf: só objeto com ok booleano; contagens inválidas viram null; chained só com true', () => {
    assert.equal(testResultOf(/** @type {any} */ ({ testResult: null })), null);
    assert.equal(testResultOf(/** @type {any} */ ({})), null);
    assert.equal(testResultOf(/** @type {any} */ ({ testResult: { ok: 1 } })), null);
    assert.deepEqual(testResultOf(/** @type {any} */ ({ testResult: { ok: false, passed: 2, failed: 1, total: 3, framework: 'pytest' } })), { ok: false, passed: 2, failed: 1, total: 3, framework: 'pytest', chained: false });
    assert.equal(testResultOf(/** @type {any} */ ({ testResult: { ok: false, chained: 'sim' } })).chained, false);
    assert.equal(testResultOf(/** @type {any} */ ({ testResult: { ok: false, chained: true } })).chained, true);
  });

  it('testRunEffect: os vetores da seção 6, isolados', () => {
    const run = (fields) => ({ ok: false, passed: null, failed: null, total: null, framework: null, chained: false, ...fields });
    assert.deepEqual(testRunEffect(run({}), { interrupted: true }), { counts: false, open: null }, 'Esc');
    assert.deepEqual(testRunEffect(run({ failed: 2 }), { interrupted: true }), { counts: false, open: null }, 'Esc com contagem');
    assert.deepEqual(testRunEffect(run({ ok: true, failed: 0 }), { interrupted: false }), { counts: true, open: 0 });
    assert.deepEqual(testRunEffect(run({}), { interrupted: false }), { counts: true, open: 1 }, 'falha sem contagem');
    assert.deepEqual(testRunEffect(run({ failed: 3 }), { interrupted: false }), { counts: true, open: 3 });
    assert.deepEqual(testRunEffect(run({ failed: 0 }), { interrupted: false }), { counts: true, open: 0 }, 'failed ?? 1');
    assert.deepEqual(testRunEffect(run({ chained: true }), { interrupted: false }), { counts: false, open: null }, 'cadeia sem contagem');
    assert.deepEqual(testRunEffect(run({ ok: true, chained: true }), { interrupted: false }), { counts: true, open: 0 }, 'cadeia que passou');
    assert.deepEqual(testRunEffect(run({ chained: true, failed: 3 }), { interrupted: false }), { counts: true, open: 3 }, 'cadeia com contagem');
  });

  it('recordTestRun: aprovado esmaga os abertos; o lastRun leva só os campos do contrato', () => {
    const table = /** @type {any} */ ({ bugs: { open: 4, lastRun: null }, bugsCrushed: 0 });
    recordTestRun(table, { ok: true, passed: 4, failed: 0, total: 4, framework: 'go test', chained: true }, 0, 3);
    assert.deepEqual([table.bugs.open, table.bugsCrushed], [0, 4]);
    assert.deepEqual(table.bugs.lastRun, { ok: true, passed: 4, failed: 0, total: 4, framework: 'go test', at: 3 });
  });
});
