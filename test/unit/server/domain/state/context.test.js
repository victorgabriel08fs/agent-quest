// Contexto aproximado no reducer (T15; modelo de eventos, seções 3, 6 e 9):
// `setContextUsage` recebe a leitura da sonda, muda o `context` do agente e
// emite `context.usage` (fora do feed). Cenários SINTÉTICOS (formato do ADR 0010).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_KINDS } from '../../../../../shared/contract.js';
import { createSequence, getSessionState, setContextUsage } from '../../../../../server/domain/state/index.js';
import { START, agent, agentOf, newState, run, scenario, sessionId, view } from './scenarios.js';

const SID = sessionId('principal');
const T = agent('contexto', 'tester');
const USAGE = { pct: 40, usedTokens: 80_000, windowTokens: 200_000 };

/** Sessão com o `main` e um subagente. */
function withAgents(options = {}) {
  const state = newState(options);
  run(scenario('contexto', 'sessão com subagente', (b) => {
    b.sessionStart();
    b.prompt('Peça ao tester');
    const call = b.delegation('tester', 'Testar');
    b.pre(call);
    b.start(T);
    b.tool('Read', { file_path: 'CLAUDE.md' }, { who: T });
  }), { state });
  return state;
}

/** Forma do `context` do AgentState (seção 9). */
function assertContextShape(context) {
  assert.deepEqual(Object.keys(context), ['pct', 'usedTokens', 'windowTokens', 'at']);
  assert.ok(Number.isFinite(context.pct) && context.pct >= 0 && context.pct <= 100);
  assert.ok(Number.isSafeInteger(context.usedTokens) && context.usedTokens >= 0);
  assert.ok(Number.isSafeInteger(context.windowTokens) && context.windowTokens > 0);
  assert.ok(Number.isFinite(context.at) && context.at > 0);
}

describe('setContextUsage', () => {
  it('valor novo: o context do agente muda e sai context.usage, numerado, com ts da leitura, fora do feed', () => {
    const state = withAgents({ sequence: createSequence('run15') });
    const before = state.sequence.current();
    const feedBefore = view(state).feed.length;
    const at = START + 60_000;
    const { events, changed } = setContextUsage(state, SID, T.id, USAGE, at);
    assert.deepEqual(changed, [SID]);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.deepEqual(Object.keys(event), ['id', 'seq', 'ts', 'sessionId', 'agentKey', 'kind', 'data']);
    assert.equal(event.kind, 'context.usage');
    assert.equal(event.agentKey, T.id);
    assert.equal(event.sessionId, SID);
    assert.equal(event.ts, at);
    assert.equal(event.seq, before + 1);
    assert.equal(event.id, `run15:${before + 1}`);
    assert.deepEqual(event.data, USAGE);
    assert.deepEqual(Object.keys(event.data), ['pct', 'usedTokens', 'windowTokens']);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.data));
    assert.ok(!FEED_KINDS.includes('context.usage'));

    const session = view(state);
    assert.equal(session.feed.length, feedBefore, 'context.usage não entra no feed');
    const context = agentOf(session, T.id).context;
    assertContextShape(context);
    assert.deepEqual(context, { ...USAGE, at });
    assert.equal(agentOf(session, 'main').context, null, 'só o agente lido muda');
    // O update leva a cópia: mexer nela não muda o estado.
    context.pct = 99;
    assert.equal(agentOf(view(state), T.id).context.pct, 40);
  });

  it('a sessão principal também recebe o context', () => {
    const state = withAgents();
    const { events } = setContextUsage(state, SID, 'main', { pct: 5, usedTokens: 50_000, windowTokens: 1_000_000 }, START + 1);
    assert.deepEqual(events.map((event) => [event.kind, event.agentKey]), [['context.usage', 'main']]);
    assert.deepEqual(agentOf(view(state), 'main').context, { pct: 5, usedTokens: 50_000, windowTokens: 1_000_000, at: START + 1 });
  });

  it('mesmo valor da leitura anterior: nada muda, nem o at', () => {
    const state = withAgents();
    setContextUsage(state, SID, T.id, USAGE, START + 1000);
    const again = setContextUsage(state, SID, T.id, { ...USAGE }, START + 6000);
    assert.deepEqual(again, { events: [], changed: [] });
    assert.equal(agentOf(view(state), T.id).context.at, START + 1000);
    // Valor diferente volta a emitir.
    const next = setContextUsage(state, SID, T.id, { ...USAGE, usedTokens: 81_000 }, START + 11_000);
    assert.equal(next.events.length, 1);
    assert.equal(agentOf(view(state), T.id).context.at, START + 11_000);
  });

  it('null (falha na leitura): context vira null, com update sem evento; de novo null, nada', () => {
    const state = withAgents();
    setContextUsage(state, SID, T.id, USAGE, START + 1000);
    assert.deepEqual(setContextUsage(state, SID, T.id, null, START + 6000), { events: [], changed: [SID] });
    assert.equal(agentOf(view(state), T.id).context, null);
    assert.deepEqual(setContextUsage(state, SID, T.id, null, START + 11_000), { events: [], changed: [] });
  });

  it('leitura fora do formato do contrato conta como null', () => {
    for (const bad of [
      { pct: 101, usedTokens: 1, windowTokens: 200_000 },
      { pct: -1, usedTokens: 1, windowTokens: 200_000 },
      { pct: Number.NaN, usedTokens: 1, windowTokens: 200_000 },
      { pct: 1, usedTokens: 1.5, windowTokens: 200_000 },
      { pct: 1, usedTokens: -1, windowTokens: 200_000 },
      { pct: 1, usedTokens: 1, windowTokens: 0 },
      { pct: '1', usedTokens: 1, windowTokens: 200_000 },
      'texto',
      undefined,
    ]) {
      const state = withAgents();
      setContextUsage(state, SID, T.id, USAGE, START + 1000);
      const result = setContextUsage(state, SID, T.id, /** @type {any} */ (bad), START + 6000);
      assert.deepEqual(result, { events: [], changed: [SID] }, JSON.stringify(bad));
      assert.equal(agentOf(view(state), T.id).context, null);
    }
  });

  it('sessão ou agente que não está na memória, ou hora inválida: nada muda e nenhum seq é gasto', () => {
    const state = withAgents();
    const before = state.sequence.current();
    for (const [sid, key, at] of [
      [sessionId('outra'), 'main', START],
      [SID, 'a-desconhecido', START],
      [SID, T.id, Number.NaN],
    ]) {
      assert.deepEqual(setContextUsage(state, sid, key, USAGE, at), { events: [], changed: [] });
    }
    assert.equal(state.sequence.current(), before);
    assert.equal(getSessionState(state, sessionId('outra')), null, 'não cria sessão');
    assert.ok(view(state).agents.every((item) => item.context === null));
  });

  it('agente encerrado (copa) ainda recebe a leitura do SubagentStop', () => {
    const state = withAgents();
    run(scenario('contexto-fim', 'fim do subagente', (b) => b.stopAgent(T)), { state, start: START + 1000 });
    assert.equal(agentOf(view(state), T.id).finished, true);
    const { events } = setContextUsage(state, SID, T.id, USAGE, START + 2000);
    assert.equal(events.length, 1);
    assert.equal(agentOf(view(state), T.id).finished, true, 'continua na copa');
  });
});
