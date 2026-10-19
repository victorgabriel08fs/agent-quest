// Desempenho do reducer (T7, critério do tester): 1 000 fatos em menos de
// 50 ms, com o feed limitado a 200. Os fatos são normalizados antes da
// medição: o tempo é só o do `apply`. Cenário SINTÉTICO.
//
// Como no teste de tempo da redação (ADR 0010), vale o melhor de algumas
// execuções, depois de uma de aquecimento, para o ruído da máquina não decidir.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { normalize } from '../../../../../server/domain/normalize.js';
import { apply, getSessionState } from '../../../../../server/domain/state/index.js';
import { FEED_LIMIT } from '../../../../../server/domain/state/sessions.js';
import { scenarioEnvelopes } from '../scenarios.js';
import { HOME, PROJECT, agent, newState, scenario, sessionId } from './scenarios.js';

const RUNS = 5;
const LIMIT_MS = 50;

/** Cenário com exatamente 1 000 eventos: 5 subagentes em paralelo, cada um lendo e rodando comandos. */
function busyScenario() {
  const workers = ['dev-backend', 'dev-frontend', 'tester', 'documentador', 'Explore'].map((type, i) => agent(`carga-${i}`, type));
  return scenario('carga', '1000 eventos com 5 subagentes', (b) => {
    b.sessionStart();
    b.prompt('Trabalhem em paralelo');
    const delegations = workers.map((who, i) => b.delegation(who.type, `Tarefa ${i}`));
    for (const call of delegations) b.pre(call);
    for (const who of workers) b.start(who);
    let n = 0;
    while (b.events.length < 990) {
      const who = workers[n % workers.length];
      const call = n % 3 === 0
        ? b.call('Bash', { command: `npm run tarefa-${n}`, description: `Passo ${n}` }, who)
        : b.call('Read', { file_path: `${PROJECT}\\src\\modulo-${n}.js` }, who);
      b.pre(call);
      if (n % 7 === 0) b.fail(call, `Exit code ${n % 5 + 1}`);
      else b.post(call, { stdout: 'ok' });
      n++;
    }
    workers.forEach((who, i) => {
      b.stopAgent(who);
      b.returned(delegations[i], who);
    });
    while (b.events.length < 1000) b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
    b.events.length = 1000;
  });
}

function facts() {
  return scenarioEnvelopes(busyScenario()).map(({ envelope, receivedAt }) => ({
    fact: normalize(envelope, { receivedAt, homeDir: HOME }),
    at: receivedAt,
  }));
}

describe('desempenho do reducer', () => {
  const input = facts();

  it('o cenário tem 1 000 fatos válidos', () => {
    assert.equal(input.length, 1000);
    assert.ok(input.every(({ fact }) => fact !== null));
  });

  it(`1 000 fatos em menos de ${LIMIT_MS} ms`, () => {
    let best = Infinity;
    let state;
    for (let i = 0; i <= RUNS; i++) {
      state = newState();
      const begin = performance.now();
      for (const { fact, at } of input) apply(state, fact, at);
      const elapsed = performance.now() - begin;
      if (i > 0) best = Math.min(best, elapsed); // a primeira é aquecimento
    }
    assert.ok(best < LIMIT_MS, `melhor tempo: ${best.toFixed(1)} ms`);
    const session = getSessionState(state, sessionId('principal'), { feed: true });
    assert.equal(session.agents.length, 6);
    assert.ok(session.agents.slice(1).every((item) => item.finished));
  });

  it(`o feed fica com os ${FEED_LIMIT} eventos mais recentes`, () => {
    const state = newState();
    let lastFeedEvent = null;
    for (const { fact, at } of input) {
      for (const event of apply(state, fact, at).events) {
        if (event.kind !== 'tool.finished' && event.kind !== 'agent.started') lastFeedEvent = event;
      }
    }
    const { feed } = getSessionState(state, sessionId('principal'), { feed: true });
    assert.equal(feed.length, FEED_LIMIT);
    assert.equal(feed.at(-1), lastFeedEvent);
    for (let i = 1; i < feed.length; i++) assert.ok(feed[i].ts >= feed[i - 1].ts, 'feed em ordem');
  });
});
