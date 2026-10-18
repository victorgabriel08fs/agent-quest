// Hub SSE (T9a, adiantamento do hub): GET /events e GET /api/state.
// Estado falso: os snapshots de test/fixtures/state/*.json e mensagens numeradas
// à mão (o hub não numera nada). HTTP real em 127.0.0.1, porta livre (ADR 0010).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../../server/http/app.js';
import { SECURITY_HEADERS } from '../../../../server/http/security.js';
import {
  HEARTBEAT_MS,
  MAX_CLIENTS,
  RETRY_MS,
  SSE_PROTOCOL,
  createRunId,
  createSseHub,
  formatMessage,
} from '../../../../server/http/sse.js';
import { request } from '../helpers.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/state/', import.meta.url));
const loadSnapshot = (name) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

const RUN_ID = 'runTeste';
const SNAPSHOT = loadSnapshot('primeira-luz');

const servers = [];
const openClients = [];
after(async () => {
  for (const client of openClients) client.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Relógio falso para o heartbeat: guarda os intervalos e dispara à mão. */
function fakeTimers() {
  const intervals = new Map();
  let next = 1;
  return {
    intervals,
    setInterval(run, ms) {
      const handle = { id: next++, run, ms };
      intervals.set(handle.id, handle);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle.id);
    },
    tick() {
      for (const { run } of [...intervals.values()]) run();
    },
  };
}

/** Hub num servidor HTTP mínimo (sem o app), para testar só o protocolo. */
async function startHub(options = {}) {
  const hub = createSseHub({ runId: RUN_ID, serverVersion: '9.9.9', getSnapshot: () => SNAPSHOT, ...options });
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { hub, port: server.address().port };
}

/** Lê um bloco SSE (texto entre linhas em branco). */
function parseBlock(block) {
  const message = {};
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) message.comment = line.slice(1).trim();
    else if (line.startsWith('retry: ')) message.retry = Number(line.slice(7));
    else if (line.startsWith('id: ')) message.id = line.slice(4);
    else if (line.startsWith('event: ')) message.event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (data.length) message.data = JSON.parse(data.join('\n'));
  return message;
}

/**
 * Cliente SSE de teste. `next()` devolve a próxima mensagem ainda não lida.
 * Para respostas que não são SSE (403, 503), `body` traz o texto.
 */
function sseClient(port, { path: urlPath = '/events', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      const messages = [];
      const waiters = [];
      let read = 0;
      let buffer = '';
      let body = '';
      let ended = false;
      const flush = () => {
        while (waiters.length && (read < messages.length || ended)) {
          const waiter = waiters.shift();
          if (read < messages.length) waiter.resolve(messages[read++]);
          else waiter.reject(new Error('o fluxo terminou'));
        }
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          messages.push(parseBlock(buffer.slice(0, index)));
          buffer = buffer.slice(index + 2);
        }
        flush();
      });
      const finished = new Promise((done) => res.on('close', done));
      res.on('end', () => {
        ended = true;
        flush();
      });
      res.on('close', () => {
        ended = true;
        flush();
      });
      const client = {
        status: res.statusCode,
        headers: res.headers,
        messages,
        body: () => body,
        finished,
        next(timeoutMs = 3000) {
          return new Promise((resolveNext, rejectNext) => {
            const timer = setTimeout(() => rejectNext(new Error('nenhuma mensagem a tempo')), timeoutMs);
            waiters.push({
              resolve: (m) => (clearTimeout(timer), resolveNext(m)),
              reject: (e) => (clearTimeout(timer), rejectNext(e)),
            });
            flush();
          });
        },
        close() {
          req.destroy();
        },
      };
      openClients.push(client);
      resolve(client);
    });
    req.on('error', reject);
  });
}

/** Espera uma condição (contagem de clientes, por exemplo) com prazo curto. */
async function waitUntil(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`tempo esgotado: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Mensagens numeradas à mão, como a ligação de ponta a ponta fará depois do T7. */
const SESSION = SNAPSHOT.sessions[0];
const { feed, ...SESSION_WITHOUT_FEED } = SESSION;
function updateMessage(seq) {
  return {
    seq,
    event: {
      id: `${RUN_ID}:${seq}`,
      seq,
      ts: 1_760_731_240_000 + seq,
      sessionId: SESSION.id,
      agentKey: 'main',
      kind: 'tool.started',
      data: { toolUseId: `toolu_${seq}`, tool: 'Read', category: 'read', target: `docs/a${seq}.md`, detail: null },
    },
    session: SESSION_WITHOUT_FEED,
  };
}

describe('hub SSE: conexão', () => {
  it('retry, hello e snapshot, nessa ordem, no formato da seção 9', async () => {
    const { port } = await startHub();
    const client = await sseClient(port);
    assert.equal(client.status, 200);
    assert.equal(client.headers['content-type'], 'text/event-stream');
    assert.equal(client.headers['cache-control'], 'no-store');

    assert.deepEqual(await client.next(), { retry: RETRY_MS });
    assert.deepEqual(await client.next(), {
      event: 'hello',
      data: { protocol: SSE_PROTOCOL, runId: RUN_ID, seq: SNAPSHOT.seq, serverVersion: '9.9.9' },
    });
    assert.deepEqual(await client.next(), { id: `${RUN_ID}:${SNAPSHOT.seq}`, event: 'snapshot', data: SNAPSHOT });
    assert.equal(RETRY_MS, 2000);
    assert.equal(SSE_PROTOCOL, 1);
  });

  it('com Last-Event-ID (desta execução, de outra ou inválido), também recebe hello e snapshot', async () => {
    const { port } = await startHub();
    for (const lastEventId of [`${RUN_ID}:${SNAPSHOT.seq - 5}`, 'outraExec:10', 'lixo']) {
      const client = await sseClient(port, { headers: { 'Last-Event-ID': lastEventId } });
      await client.next();
      assert.equal((await client.next()).event, 'hello', lastEventId);
      const snapshot = await client.next();
      assert.equal(snapshot.event, 'snapshot', lastEventId);
      assert.deepEqual(snapshot.data, SNAPSHOT);
      client.close();
    }
  });

  it('cada conexão lê o snapshot da hora (getSnapshot chamado a cada uma)', async () => {
    let current = loadSnapshot('neutro');
    const { port } = await startHub({ getSnapshot: () => current });
    const first = await sseClient(port);
    await first.next();
    assert.equal((await first.next()).data.seq, 1);
    current = loadSnapshot('ticket-completo');
    const second = await sseClient(port);
    await second.next();
    const hello = await second.next();
    const snapshot = await second.next();
    assert.equal(hello.data.seq, 322);
    assert.deepEqual(snapshot, { id: `${RUN_ID}:322`, event: 'snapshot', data: current });
  });
});

describe('hub SSE: publicação', () => {
  it('update e session-removed chegam a todos os clientes, em ordem, com id runId:seq', async () => {
    const { hub, port } = await startHub();
    const clients = [await sseClient(port), await sseClient(port), await sseClient(port)];
    for (const client of clients) for (let i = 0; i < 3; i++) await client.next();
    assert.equal(hub.clientCount(), 3);

    const published = [
      updateMessage(122),
      { seq: 123, event: null, session: SESSION_WITHOUT_FEED },
      updateMessage(124),
    ];
    hub.publishUpdate(published[0]);
    hub.publishUpdate(published[1]);
    hub.publishUpdate(published[2]);
    hub.publishRemoved({ seq: 125, sessionId: SESSION.id });

    for (const client of clients) {
      for (const message of published) {
        assert.deepEqual(await client.next(), { id: `${RUN_ID}:${message.seq}`, event: 'update', data: message });
      }
      assert.deepEqual(await client.next(), {
        id: `${RUN_ID}:125`,
        event: 'session-removed',
        data: { seq: 125, sessionId: SESSION.id },
      });
    }
  });

  it('o hub não numera: recusa seq ausente ou inválido, mesmo sem clientes', async () => {
    const { hub } = await startHub();
    for (const seq of [undefined, null, -1, 1.5, '3']) {
      assert.throws(() => hub.publishUpdate({ seq, event: null, session: SESSION_WITHOUT_FEED }), TypeError, String(seq));
      assert.throws(() => hub.publishRemoved({ seq, sessionId: 's' }), TypeError, String(seq));
    }
  });

  it('formatMessage: o data ocupa uma linha só, mesmo com quebras de linha no conteúdo', () => {
    const text = formatMessage('update', { a: 'linha 1\nlinha 2\r\nlinha 3' }, 'run:1');
    assert.equal(text.split('\n').length, 5);
    assert.ok(text.endsWith('\n\n'));
    assert.equal(parseBlock(text.trimEnd()).data.a, 'linha 1\nlinha 2\r\nlinha 3');
  });

  it('createRunId: base64url, sem ":" (cabe em id: runId:seq)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createRunId()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{8}$/);
    assert.throws(() => createSseHub({ runId: 'a:b', serverVersion: 'x', getSnapshot: () => SNAPSHOT }), TypeError);
  });
});

describe('hub SSE: heartbeat (relógio injetado)', () => {
  it('a cada 15 s (no máximo 16 s), para todos os clientes; para quando não há clientes', async () => {
    const timers = fakeTimers();
    const { hub, port } = await startHub({ timers });
    assert.equal(HEARTBEAT_MS, 15_000);
    assert.equal(timers.intervals.size, 0, 'sem clientes, sem intervalo');

    const a = await sseClient(port);
    const b = await sseClient(port);
    for (const client of [a, b]) for (let i = 0; i < 3; i++) await client.next();
    assert.equal(timers.intervals.size, 1, 'um único intervalo para todos');
    const [interval] = timers.intervals.values();
    assert.ok(interval.ms <= 16_000, `intervalo de ${interval.ms} ms`);

    timers.tick();
    assert.deepEqual(await a.next(), { comment: 'ping' });
    assert.deepEqual(await b.next(), { comment: 'ping' });

    a.close();
    b.close();
    await waitUntil(() => hub.clientCount() === 0, 'clientes saírem');
    assert.equal(timers.intervals.size, 0, 'o intervalo para sem clientes');

    const c = await sseClient(port);
    for (let i = 0; i < 3; i++) await c.next();
    assert.equal(timers.intervals.size, 1, 'volta com um cliente novo');
  });

  it('com o relógio real: o ping chega no intervalo configurado', async () => {
    const { port } = await startHub({ heartbeatMs: 30 });
    const client = await sseClient(port);
    for (let i = 0; i < 3; i++) await client.next();
    assert.deepEqual(await client.next(), { comment: 'ping' });
  });
});

describe('hub SSE: limite de clientes e desconexão', () => {
  it('até 8 clientes; o nono recebe 503; cliente que sai libera a vaga e sai da contagem', async () => {
    const { hub, port } = await startHub();
    assert.equal(MAX_CLIENTS, 8);
    const clients = [];
    for (let i = 0; i < 8; i++) {
      const client = await sseClient(port);
      assert.equal(client.status, 200, `cliente ${i + 1}`);
      clients.push(client);
    }
    assert.equal(hub.clientCount(), 8);

    const ninth = await sseClient(port);
    assert.equal(ninth.status, 503);
    assert.equal(ninth.headers['cache-control'], 'no-store');
    await ninth.finished;
    assert.match(ninth.body(), /Muitos painéis/);
    assert.equal(hub.clientCount(), 8);

    clients[0].close();
    await waitUntil(() => hub.clientCount() === 7, 'cliente sair da contagem');
    const replacement = await sseClient(port);
    assert.equal(replacement.status, 200);
    assert.equal(hub.clientCount(), 8);

    hub.publishRemoved({ seq: 200, sessionId: 'x' });
    for (const client of [...clients.slice(1), replacement]) {
      for (let i = 0; i < 3; i++) await client.next();
      assert.equal((await client.next()).event, 'session-removed');
    }
  });

  it('close(): encerra os fluxos, zera a contagem e recusa novas conexões', async () => {
    const timers = fakeTimers();
    const { hub, port } = await startHub({ timers });
    const client = await sseClient(port);
    for (let i = 0; i < 3; i++) await client.next();
    hub.close();
    await client.finished;
    assert.equal(hub.clientCount(), 0);
    assert.equal(timers.intervals.size, 0);
    assert.equal((await sseClient(port)).status, 503);
    hub.publishUpdate(updateMessage(1)); // sem clientes: não faz nada
  });
});

describe('GET /events e GET /api/state no servidor (createApp)', () => {
  async function startApp(options = {}) {
    const app = createApp({
      version: '9.9.9',
      startedAt: 1,
      runId: RUN_ID,
      getSnapshot: () => SNAPSHOT,
      logError: () => {},
      ...options,
    });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    servers.push(app.server);
    return { ...app, port: app.server.address().port };
  }

  it('GET /api/state devolve o mesmo conteúdo do snapshot', async () => {
    const app = await startApp();
    const state = await request(app.port, { path: '/api/state' });
    assert.equal(state.status, 200);
    assert.equal(state.headers['content-type'], 'application/json; charset=utf-8');
    const client = await sseClient(app.port);
    await client.next();
    await client.next();
    const snapshot = await client.next();
    assert.deepEqual(JSON.parse(state.body), snapshot.data);
    assert.deepEqual(JSON.parse(state.body), SNAPSHOT);
  });

  it('Cache-Control: no-store e os cabeçalhos do ADR 0006 nas duas rotas', async () => {
    const app = await startApp();
    const state = await request(app.port, { path: '/api/state' });
    const client = await sseClient(app.port);
    for (const [label, headers] of [['/api/state', state.headers], ['/events', client.headers]]) {
      assert.equal(headers['cache-control'], 'no-store', label);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(headers[name.toLowerCase()], value, `${label}: ${name}`);
      }
      assert.deepEqual(Object.keys(headers).filter((n) => n.startsWith('access-control-')), [], label);
    }
  });

  it('Host, Origin e Sec-Fetch-Site de outra origem recebem 403 nas duas rotas; a própria origem é aceita', async () => {
    const app = await startApp();
    const refused = [
      { Host: `evil.example:${app.port}` },
      { Origin: 'http://evil.example' },
      { Origin: `http://localhost:${app.port}` },
      { 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of refused) {
      assert.equal((await request(app.port, { path: '/api/state', headers })).status, 403, JSON.stringify(headers));
      const client = await sseClient(app.port, { headers });
      assert.equal(client.status, 403, JSON.stringify(headers));
    }
    assert.equal(app.hub.clientCount(), 0);

    const own = { Origin: `http://127.0.0.1:${app.port}`, 'Sec-Fetch-Site': 'same-origin' };
    assert.equal((await request(app.port, { path: '/api/state', headers: own })).status, 200);
    assert.equal((await sseClient(app.port, { headers: own })).status, 200);
  });

  it('/api/health: clients vem do hub e cai quando um painel fecha; sessions continua 0', async () => {
    const app = await startApp();
    const health = async () => JSON.parse((await request(app.port, { path: '/api/health' })).body);
    assert.equal((await health()).clients, 0);
    const a = await sseClient(app.port);
    const b = await sseClient(app.port);
    assert.equal((await health()).clients, 2);
    a.close();
    await waitUntil(() => app.hub.clientCount() === 1, 'painel fechar');
    const after = await health();
    assert.equal(after.clients, 1);
    assert.equal(after.sessions, 0);
    b.close();
  });

  it('métodos: /events só GET (405 com Allow: GET); /api/state aceita HEAD sem corpo', async () => {
    const app = await startApp();
    for (const method of ['POST', 'HEAD', 'PUT']) {
      const res = await request(app.port, { method, path: '/events' });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'GET', method);
    }
    const options = await request(app.port, { method: 'OPTIONS', path: '/events' });
    assert.equal(options.status, 405);
    assert.equal(options.headers.allow, 'GET');
    const head = await request(app.port, { method: 'HEAD', path: '/api/state' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await request(app.port, { method: 'POST', path: '/api/state' })).status, 405);
  });

  it('sem estado ligado (até o T7): snapshot vazio, seq 0', async () => {
    const app = createApp({ version: '9.9.9', startedAt: 1, logError: () => {} });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    servers.push(app.server);
    const port = app.server.address().port;
    assert.deepEqual(JSON.parse((await request(port, { path: '/api/state' })).body), { seq: 0, sessions: [] });
    const client = await sseClient(port);
    await client.next();
    const hello = await client.next();
    assert.match(hello.data.runId, /^[A-Za-z0-9_-]{8}$/);
    assert.equal(hello.data.seq, 0);
    assert.deepEqual((await client.next()).data, { seq: 0, sessions: [] });
  });

  it('o nono painel recebe 503 com os cabeçalhos do ADR 0006', async () => {
    const app = await startApp({ sse: { maxClients: 1 } });
    const first = await sseClient(app.port);
    assert.equal(first.status, 200);
    const second = await sseClient(app.port);
    assert.equal(second.status, 503);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(second.headers[name.toLowerCase()], value, name);
    }
  });
});
