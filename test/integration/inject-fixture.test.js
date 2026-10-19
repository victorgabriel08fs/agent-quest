// T9b: injetor de cenários e retomada do SSE com processos e HTTP reais.
//
// - `npm run inject` (o npm de verdade) de um cenário SINTÉTICO leva ao mesmo
//   /api/state final que o reducer dá no teste unitário com o mesmo cenário
//   (plano, T9b; [T0]: o mesmo com o cenário básico real).
// - Um cliente que cai no meio da injeção volta com `Last-Event-ID`, recebe só o
//   que faltou, sem lacuna, e o store do painel (web/js/store.js) termina igual
//   ao /api/state.
//
// Nada usa o diretório de dados real nem a porta padrão: AGENT_QUEST_HOME e
// pasta pessoal temporários, porta 0.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { injectScenario } from '../../scripts/inject-fixture.mjs';
import { startServer } from '../../server/main.js';
import { getSessionStates } from '../../server/domain/state/index.js';
import { applyHello, applySessionRemoved, applySnapshot, applyUpdate, createStore } from '../../web/js/store.js';
import { syntheticScenario } from '../unit/server/domain/scenarios.js';
import { newState, run } from '../unit/server/domain/state/scenarios.js';
import { cleanupTemps, newTemp, readJson } from './capture-helpers.js';
import { killTree, launchNpm, launchServer, minimalEnv, request, waitFor } from './server-helpers.js';

/** Estado sem o que depende da hora ou da execução: horas, ids e seq. */
function comparable(sessions) {
  return sessions.map((session) => ({
    ...session,
    startedAt: 0,
    lastEventAt: 0,
    agents: session.agents.map((agent) => ({
      ...agent,
      startedAt: 0,
      lastEventAt: 0,
      activity: agent.activity ? { ...agent.activity, at: 0 } : null,
    })),
    feed: (session.feed ?? []).map(({ id, seq, ts, ...event }) => event),
  }));
}

describe('T9b integração: npm run inject de um cenário sintético', () => {
  let home;
  let server;
  let runtime;

  before(async () => {
    home = newTemp('aq int injetor ção-');
    // A pasta pessoal do servidor aponta para a temporária: nada lê a real.
    server = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: home, USERPROFILE: home, HOME: home }));
    assert.equal(await server.started, true, server.output());
    runtime = await waitFor(() => readJson(path.join(home, 'runtime.json')), { label: 'runtime.json do servidor real' });
  });

  after(async () => {
    if (server) await killTree(server.child);
    cleanupTemps();
  });

  it('leva ao mesmo /api/state final do reducer com o mesmo cenário', async () => {
    const scenario = syntheticScenario();
    const file = path.join(home, 'cenario-sintetico.json');
    writeFileSync(file, JSON.stringify(scenario));
    const inject = launchNpm(['run', 'inject', '--', file, '--fast'], minimalEnv({ AGENT_QUEST_HOME: home }), { ready: /$^/, timeoutMs: 60_000 });
    const code = await inject.exit;
    assert.equal(code, 0, inject.output());
    assert.match(inject.output(), new RegExp(`Pronto: ${scenario.events.length} eventos aceitos`));

    const expected = comparable(getSessionStates(run(scenario, { state: newState({ homeDir: home }), homeDir: home }).state));
    let actual = null;
    await waitFor(async () => {
      const state = JSON.parse((await request(runtime.port, { path: '/api/state' })).text);
      actual = comparable(state.sessions);
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, { timeoutMs: 10_000, label: '/api/state igual ao do reducer' }).catch(() => {});
    assert.deepEqual(actual, expected);
  });
});

/** Cliente SSE que alimenta o store do painel, com o `Last-Event-ID` dado. */
function panelClient(port, store, lastEventId) {
  return new Promise((resolve, reject) => {
    const headers = lastEventId ? { 'Last-Event-ID': lastEventId } : {};
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers, agent: false }, (res) => {
      const client = { events: [], results: [], lastId: null, close: () => req.destroy() };
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const message = {};
          for (const line of block.split('\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) message[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          if (!message.event) continue;
          const data = JSON.parse(message.data);
          if (message.id) client.lastId = message.id;
          client.events.push(message.event);
          if (message.event === 'hello') applyHello(store, data);
          else if (message.event === 'snapshot') applySnapshot(store, data);
          else if (message.event === 'update') client.results.push(applyUpdate(store, data));
          else if (message.event === 'session-removed') client.results.push(applySessionRemoved(store, data));
        }
      });
      resolve(client);
    });
    req.on('error', reject);
  });
}

describe('T9b integração: retomada por Last-Event-ID com o servidor real e o store do painel', () => {
  it('o cliente que cai no meio da injeção volta só com o que faltou e termina igual ao /api/state', async () => {
    const home = newTemp('aq int retomada-');
    const server = await startServer({ argv: ['--port', '0'], env: { AGENT_QUEST_HOME: home }, homedir: home, logError: () => {} });
    try {
      const scenario = syntheticScenario();
      const half = Math.floor(scenario.events.length / 2);
      const store = createStore();
      const first = await panelClient(server.port, store);
      await waitFor(() => first.events.includes('snapshot'), { label: 'snapshot' });

      const options = { port: server.port, token: server.runtime.token, fast: true };
      await injectScenario({ events: scenario.events.slice(0, half) }, options);
      await waitFor(() => store.seq === server.pipeline.currentSeq(), { label: 'cliente em dia' });
      first.close();
      const lastId = first.lastId;
      assert.match(lastId, /^[A-Za-z0-9_-]+:\d+$/);

      await injectScenario({ events: scenario.events.slice(half) }, options);
      const second = await panelClient(server.port, store, lastId);
      await waitFor(() => store.seq === server.pipeline.currentSeq(), { label: 'cliente retomado em dia' });
      assert.equal(second.events[0], 'hello');
      assert.ok(!second.events.includes('snapshot'), 'retomada sem snapshot');
      assert.ok(second.results.length > 0);
      assert.ok(second.results.every((result) => result === 'ok'), `sem lacuna: ${second.results.join(',')}`);

      const state = JSON.parse((await request(server.port, { path: '/api/state' })).text);
      assert.deepEqual([...store.sessions.values()], state.sessions);
      second.close();
    } finally {
      await server.close();
    }
  });
});
