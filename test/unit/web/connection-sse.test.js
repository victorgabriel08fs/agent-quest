// Conexão ao vivo contra um servidor SSE falso de verdade (node:http em porta
// efêmera), no formato da seção 9 do modelo de eventos: hello, snapshot,
// update, comentário de heartbeat, lacuna resolvida por /api/state, servidor
// que cai e volta (selo "reconectando", recuperação pelo snapshot) e /events
// que ainda não existe (404, antes do T9a).
//
// O teste contra o servidor real fica para quando o T9a existir.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { connect } from '../../../web/js/connection.js';
import { applySnapshot, applyUpdate, createStore } from '../../../web/js/store.js';
import { NodeEventSource } from './node-event-source.js';
import { loadSnapshot, makeEvent } from './support.js';

/** Espera a condição valer, verificando a cada 10 ms. */
async function waitFor(condition, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`tempo esgotado esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Servidor SSE falso. Guarda o estado com o próprio store, para o /api/state
 * devolver o mesmo que o snapshot.
 * @param {{ runId: string, snapshot: any, port?: number, events?: boolean }} options
 */
async function startFakeServer({ runId, snapshot, port = 0, events = true }) {
  const state = createStore();
  applySnapshot(state, snapshot);
  const clients = new Set();
  const lastEventIds = [];
  const current = () => ({ seq: state.seq, sessions: [...state.sessions.values()] });
  const frame = (type, data, id) => `${id ? `id: ${runId}:${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  const server = http.createServer((req, res) => {
    if (req.url === '/events' && events) {
      lastEventIds.push(req.headers['last-event-id'] ?? null);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write('retry: 50\n\n');
      res.write(frame('hello', { protocol: 1, runId, seq: state.seq, serverVersion: 'teste' }));
      res.write(frame('snapshot', current(), state.seq));
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(current()));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"erro":"não encontrado"}');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    lastEventIds,
    clients: () => clients.size,
    /** Aplica o update no estado e o envia (ou não, para provocar uma lacuna). */
    update(message, { send = true } = {}) {
      assert.equal(applyUpdate(state, message), 'ok', 'o servidor falso aplica em ordem');
      if (send) for (const client of clients) client.write(frame('update', message, message.seq));
    },
    ping() {
      for (const client of clients) client.write(': ping\n\n');
    },
    async stop() {
      for (const client of clients) client.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const FIXTURE = loadSnapshot('primeira-luz');
const { feed: _feed, ...SESSION_STATE } = FIXTURE.sessions[0];

/** Update da sessão da Primeira luz. */
function update(seq) {
  return {
    seq,
    event: { ...makeEvent('tool.started', { tool: 'Edit', category: 'edit', target: `web/js/a${seq}.js` }, 'main', seq), sessionId: SESSION_STATE.id, id: `run-a:${seq}` },
    session: { ...SESSION_STATE, label: `passo ${seq}` },
  };
}

describe('conexão contra um servidor SSE falso', () => {
  const cleanups = [];
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it('snapshot, updates, lacuna, queda e volta do servidor', { timeout: 20_000 }, async () => {
    let server = await startFakeServer({ runId: 'run-a', snapshot: FIXTURE });
    const { port } = server;
    const store = createStore();
    const statuses = [];
    let changes = 0;
    const connection = connect({
      store,
      onChange: () => { changes++; },
      onStatus: (state) => statuses.push(state),
      eventsUrl: `http://127.0.0.1:${port}/events`,
      stateUrl: `http://127.0.0.1:${port}/api/state`,
      EventSource: NodeEventSource,
      fetch: globalThis.fetch,
    });
    cleanups.push(() => connection.close());

    // Conexão: hello e snapshot.
    await waitFor(() => store.seq === 121 && statuses.at(-1) === 'live', 'snapshot inicial');
    assert.deepEqual(statuses, ['connecting', 'live']);
    assert.equal(store.runId, 'run-a');
    assert.equal(store.sessions.get(SESSION_STATE.id)?.feed.length, 21);

    // Update em ordem e heartbeat.
    server.update(update(122));
    server.ping();
    await waitFor(() => store.seq === 122, 'update 122');
    assert.equal(store.sessions.get(SESSION_STATE.id)?.label, 'passo 122');

    // Lacuna: o 123 não chega; o 124 dispara a busca de /api/state.
    server.update(update(123), { send: false });
    server.update(update(124));
    await waitFor(() => store.seq === 124, 'recuperação pela busca de /api/state');
    const feed = store.sessions.get(SESSION_STATE.id)?.feed ?? [];
    assert.deepEqual(feed.slice(-3).map((e) => e.seq), [122, 123, 124], 'o feed recebe o que faltou');
    assert.ok(changes >= 3);

    // Servidor cai: selo "reconectando".
    await server.stop();
    await waitFor(() => statuses.at(-1) === 'reconnecting', 'selo reconectando');

    // Servidor volta (outra execução, outro estado): recupera pelo snapshot.
    server = await startFakeServer({ runId: 'run-b', snapshot: loadSnapshot('neutro'), port });
    cleanups.push(() => server.stop());
    await waitFor(() => store.runId === 'run-b' && store.seq === 1 && statuses.at(-1) === 'live', 'volta pelo snapshot');
    assert.deepEqual([...store.sessions.keys()], ['0b1c2d3e-0000-4000-8000-000000000001']);
    assert.deepEqual(server.lastEventIds, ['run-a:124'], 'o navegador manda o último id na reconexão');

    connection.close();
    await waitFor(() => server.clients() === 0, 'conexão fechada no servidor');
    assert.equal(statuses.at(-1), 'offline');
  });

  it('sem /events (antes do T9a): desconectado, sem quebrar', { timeout: 10_000 }, async () => {
    const server = await startFakeServer({ runId: 'run-x', snapshot: FIXTURE, events: false });
    cleanups.push(() => server.stop());
    const store = createStore();
    const statuses = [];
    const connection = connect({
      store,
      onChange: () => {},
      onStatus: (state) => statuses.push(state),
      eventsUrl: `http://127.0.0.1:${server.port}/events`,
      stateUrl: `http://127.0.0.1:${server.port}/api/state`,
      EventSource: NodeEventSource,
      fetch: globalThis.fetch,
    });
    cleanups.push(() => connection.close());
    await waitFor(() => statuses.at(-1) === 'offline', 'selo desconectado');
    assert.equal(store.seq, null);
    connection.close();
  });
});
