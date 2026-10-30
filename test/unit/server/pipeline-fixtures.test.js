// Fechamento do T9a com os cenários reais do T0 (test/fixtures/hooks/*.json;
// plano, passo 3 do "Caminho até a Primeira luz"): injeção ponta a ponta.
//
// Para cada um dos 16 cenários, um servidor real no mesmo processo
// (startServer: HTTP, ingestão, fila, normalizador, reducer e hub SSE reais),
// com AGENT_QUEST_HOME e pasta pessoal temporários e porta 0. Os eventos entram
// por POST /hooks com o token, pelo injetor (scripts/inject-fixture.mjs, o
// mesmo caminho da captura), e um cliente SSE acompanha tudo. Confere:
// - `hello` e `snapshot` na conexão; depois um `update` por evento canônico,
//   cada mensagem com o `seq` anterior + 1, e o `id` do evento igual ao do
//   `update` (seção 9, "Numeração");
// - os eventos canônicos do SSE são os mesmos, na mesma ordem, que o reducer dá
//   com os mesmos envelopes (o `sentAt` de cada um, gravado no envio);
// - o /api/state é igual ao estado do reducer e ao que o store do painel monta
//   com o SSE (web/js/store.js);
// - /api/health: `accepted` e `deduped` pela regra de duplicatas, `ignored`
//   igual aos que o normalizador descarta (PostToolBatch), `sessions` e
//   `clients` reais.
//
// O leitor de .claude/agents/ é trocado por um que devolve [] (os cenários
// apontam para C:\Users\usuario, que não é desta máquina), e a sonda de
// contexto só lê dentro da pasta pessoal temporária: nada fora dela é lido.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { injectScenario, postEnvelope } from '../../../scripts/inject-fixture.mjs';
import { startServer } from '../../../server/main.js';
import { normalize } from '../../../server/domain/normalize.js';
import { apply, createState, getSessionStates } from '../../../server/domain/state/index.js';
import { applyHello, applySessionRemoved, applySnapshot, applyUpdate, createStore } from '../../../web/js/store.js';
import { loadFixtureScenarios } from './domain/scenarios.js';
import { request, tempDir } from './helpers.js';

/** Cliente SSE que guarda as mensagens e alimenta o store do painel. */
function openPanel(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
      const panel = { status: res.statusCode, messages: [], results: [], store: createStore(), close: () => req.destroy() };
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
          message.data = JSON.parse(message.data);
          panel.messages.push(message);
          if (message.event === 'hello') applyHello(panel.store, message.data);
          else if (message.event === 'snapshot') applySnapshot(panel.store, message.data);
          else if (message.event === 'update') panel.results.push(applyUpdate(panel.store, message.data));
          else if (message.event === 'session-removed') panel.results.push(applySessionRemoved(panel.store, message.data));
        }
      });
      resolve(panel);
    });
    req.on('error', reject);
  });
}

/** Espera `check()` dar verdadeiro, conferindo a cada 10 ms. */
async function until(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`tempo esgotado: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Duplicatas (seção 8): o mesmo payload em até 5 s da ocorrência aceita, menos o PermissionRequest. */
const DEDUPE_MS = 5000;

/**
 * O reducer com os mesmos envelopes, na mesma ordem, e a regra de duplicatas
 * da ingestão (a chegada é o próprio `sentAt`). Com a injeção rápida, payloads
 * idênticos que no T0 vieram com mais de 5 s de distância caem na janela: os
 * avisos de permissão repetidos de teste-falha-depois-passa e o SubagentStart
 * da retomada do aninhado, igual ao primeiro.
 */
function reference(envelopes, homeDir) {
  const state = createState({ homeDir });
  const events = [];
  const accepted = new Map();
  let ignored = 0;
  let deduped = 0;
  for (const envelope of envelopes) {
    const key = JSON.stringify(envelope.payload);
    if (envelope.payload.hook_event_name !== 'PermissionRequest' && accepted.has(key) && envelope.sentAt - accepted.get(key) <= DEDUPE_MS) {
      deduped++;
      continue;
    }
    accepted.set(key, envelope.sentAt);
    const fact = normalize(envelope, { receivedAt: envelope.sentAt, homeDir });
    if (!fact) {
      ignored++;
      continue;
    }
    events.push(...apply(state, fact, envelope.sentAt).events);
  }
  return { sessions: getSessionStates(state), events, ignored, deduped };
}

/** Evento sem o que depende da execução (`id` e `seq`). */
const portable = ({ id, seq, ...event }) => event;
/** Sessões sem os `id` e `seq` dos eventos do feed. */
const portableSessions = (sessions) => sessions.map((session) => ({ ...session, feed: session.feed.map(portable) }));

describe('T9a, fechamento: injeção ponta a ponta dos 16 cenários reais', () => {
  const homes = [];
  after(() => homes.forEach((home) => home.cleanup()));
  const scenarios = loadFixtureScenarios();

  it('são os 16 cenários do T0', () => {
    assert.equal(scenarios.length, 16);
  });

  for (const { file, scenario } of scenarios) {
    it(file, async () => {
      const home = tempDir('aq-t9a-real-');
      homes.push(home);
      const server = await startServer({
        argv: ['--port', '0'],
        env: { AGENT_QUEST_HOME: home.dir },
        homedir: home.dir,
        logError: () => {},
        pipeline: { reader: { read: async () => [] } },
      });
      assert.equal(server.status, 'started');
      const panel = await openPanel(server.port);
      try {
        assert.equal(panel.status, 200);
        await until(() => panel.messages.some((message) => message.event === 'snapshot'), 'snapshot');

        const envelopes = [];
        const injected = await injectScenario(scenario, {
          port: server.port,
          token: server.runtime.token,
          fast: true,
          post: (port, token, envelope) => {
            envelopes.push(envelope);
            return postEnvelope(port, token, envelope);
          },
        });
        assert.deepEqual([injected.sent, injected.accepted, injected.refused], [scenario.events.length, scenario.events.length, []]);
        await until(() => panel.store.seq === server.pipeline.currentSeq() && server.pipeline.currentSeq() > 0, 'painel em dia');

        // hello e snapshot na conexão (sem nenhum evento ainda: seq 0).
        const [hello, snapshot, ...rest] = panel.messages;
        assert.equal(hello.event, 'hello');
        assert.equal(snapshot.event, 'snapshot');
        assert.deepEqual([hello.data.seq, snapshot.data.seq, snapshot.data.sessions], [0, 0, []]);
        assert.equal(snapshot.id, `${hello.data.runId}:0`);

        // Numeração: cada update (com ou sem evento) e cada session-removed é o anterior + 1.
        let previous = 0;
        for (const message of rest) {
          assert.ok(['update', 'session-removed'].includes(message.event), message.event);
          assert.equal(message.data.seq, previous + 1, `${file}: seq contínuo`);
          assert.equal(message.id, `${hello.data.runId}:${message.data.seq}`);
          if (message.data.event) {
            assert.equal(message.data.event.id, message.id);
            assert.equal(message.data.event.seq, message.data.seq);
            assert.equal(message.data.event.sessionId, message.data.session.id);
          }
          previous = message.data.seq;
        }
        assert.ok(panel.results.every((result) => result === 'ok'), `store sem lacuna: ${panel.results.join(',')}`);

        // Os mesmos eventos canônicos, na mesma ordem, que o reducer com os mesmos envelopes.
        const expected = reference(envelopes, home.dir);
        const streamed = rest.filter((message) => message.event === 'update' && message.data.event).map((message) => portable(message.data.event));
        assert.deepEqual(streamed, expected.events.map(portable));
        assert.ok(streamed.length > 0);

        // /api/state: igual ao reducer e ao store do painel.
        const state = JSON.parse((await request(server.port, { path: '/api/state' })).body);
        assert.equal(state.seq, server.pipeline.currentSeq());
        assert.deepEqual(portableSessions(state.sessions), portableSessions(expected.sessions));
        assert.deepEqual([...panel.store.sessions.values()], state.sessions);

        // /api/health com os valores reais.
        const health = JSON.parse((await request(server.port, { path: '/api/health' })).body);
        assert.deepEqual(
          [health.events.accepted, health.events.deduped, health.events.ignored, health.sessions, health.clients],
          [scenario.events.length - expected.deduped, expected.deduped, expected.ignored, expected.sessions.length, 1],
        );
      } finally {
        panel.close();
        await server.close();
      }
    });
  }
});
