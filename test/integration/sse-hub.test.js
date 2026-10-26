// Integração do T9a, parte adiantada do hub SSE (tester): GET /events e GET /api/state.
//
// Fontes: plano da v1 (T9a, "Adiantamento da parte do hub"), modelo de eventos
// (seção 9), ADR 0004 (SSE) e ADR 0006 (Host, Origin, cabeçalhos).
//
// - Servidor real (`node server/main.js --port 0`, AGENT_QUEST_HOME temporário)
//   com clientes SSE crus por socket: formato no fio (inclusive o chunked do
//   HTTP/1.1), heartbeat com o relógio real, limite de 8 clientes, desconexões,
//   403, 405, cabeçalhos e /api/state.
// - createApp na mesma máquina, com os snapshots de test/fixtures/state/*.json e
//   mensagens numeradas à mão (o hub não numera): publicação para vários clientes,
//   conteúdo hostil, getSnapshot que falha e close().
//
// Fora daqui (T9b e fechamento do T9a): retomada por Last-Event-ID, cliente
// lento, sessions real, seq por evento canônico e latência.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createApp } from '../../server/http/app.js';
import { startServer } from '../../server/main.js';
import { ADR_HEADERS, REPO, killTree, launchServer, minimalEnv, request, tempDir, waitFor } from './server-helpers.js';

const VERSION = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const FIXTURES = ['neutro', 'primeira-luz', 'ticket-completo'];
const loadFixture = (name) => JSON.parse(readFileSync(path.join(REPO, 'test', 'fixtures', 'state', `${name}.json`), 'utf8'));

const sockets = new Set();

/**
 * Cliente SSE cru: socket TCP, requisição escrita à mão, resposta lida byte a
 * byte (cabeçalhos, corpo chunked ou com Content-Length) e mensagens SSE
 * separadas por linha em branco, com a hora de chegada de cada uma.
 */
function openSse(port, { path: urlPath = '/events', method = 'GET', host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    sockets.add(socket);
    const decoder = new StringDecoder('utf8');
    let buffer = Buffer.alloc(0);
    let head = null;
    let bodyLeft = null; // bytes que faltam com Content-Length
    let text = '';
    let parsed = 0;
    const listeners = new Set();
    const client = {
      socket,
      status: 0,
      headers: {},
      rawHead: '',
      text: () => text,
      messages: [],
      ended: false,
      closed: new Promise((done) => socket.on('close', done)),
      destroy: () => socket.destroy(),
      halfClose: () => socket.end(),
      /** Espera uma mensagem que satisfaça `predicate`, a partir da posição `from`. */
      waitMessage(predicate, { from = 0, timeoutMs = 3000 } = {}) {
        return new Promise((resolveWait, rejectWait) => {
          const check = () => {
            for (let i = from; i < client.messages.length; i++) {
              if (predicate(client.messages[i])) {
                listeners.delete(check);
                clearTimeout(timer);
                resolveWait({ message: client.messages[i], index: i });
                return true;
              }
            }
            return false;
          };
          const timer = setTimeout(() => {
            listeners.delete(check);
            rejectWait(new Error(`mensagem não chegou em ${timeoutMs} ms; recebido:\n${text.slice(0, 2000)}`));
          }, timeoutMs);
          if (!check()) listeners.add(check);
        });
      },
    };

    const append = (bytes) => {
      text += decoder.write(bytes);
      let index;
      while ((index = text.indexOf('\n\n', parsed)) >= 0) {
        const block = text.slice(parsed, index);
        parsed = index + 2;
        client.messages.push({ ...parseBlock(block), raw: block, at: performance.now() });
      }
      for (const check of [...listeners]) check();
    };

    const process = () => {
      if (!head) {
        const index = buffer.indexOf('\r\n\r\n');
        if (index < 0) return;
        client.rawHead = buffer.subarray(0, index).toString('latin1');
        buffer = buffer.subarray(index + 4);
        const [statusLine, ...lines] = client.rawHead.split('\r\n');
        client.status = Number(statusLine.split(' ')[1]);
        for (const line of lines) {
          const colon = line.indexOf(':');
          client.headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }
        head = true;
        if (client.headers['content-length'] !== undefined) bodyLeft = Number(client.headers['content-length']);
        resolve(client);
      }
      if (client.headers['transfer-encoding'] === 'chunked') {
        for (;;) {
          const lineEnd = buffer.indexOf('\r\n');
          if (lineEnd < 0) return;
          const size = Number.parseInt(buffer.subarray(0, lineEnd).toString('latin1'), 16);
          if (buffer.length < lineEnd + 2 + size + 2) return;
          append(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
          buffer = buffer.subarray(lineEnd + 2 + size + 2);
          if (size === 0) {
            client.ended = true;
            return;
          }
        }
      }
      if (bodyLeft !== null) {
        const take = buffer.subarray(0, bodyLeft);
        bodyLeft -= take.length;
        buffer = buffer.subarray(take.length);
        append(take);
        if (bodyLeft === 0) client.ended = true;
        return;
      }
      append(buffer);
      buffer = Buffer.alloc(0);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      process();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      if (!head) reject(new Error(`conexão fechada sem resposta: ${buffer.toString('latin1')}`));
    });
    const lines = [
      `${method} ${urlPath} HTTP/1.1`,
      `Host: ${host ?? `127.0.0.1:${port}`}`,
      'Accept: text/event-stream',
      'Cache-Control: no-cache',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ];
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
}

/** Lê um bloco SSE (texto entre linhas em branco). */
function parseBlock(block) {
  const message = { comments: [], fields: [] };
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      message.comments.push(line.slice(1).trim());
      continue;
    }
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    message.fields.push(name);
    if (name === 'retry') message.retry = Number(value);
    else if (name === 'id') message.id = value;
    else if (name === 'event') message.event = value;
    else if (name === 'data') data.push(value);
  }
  if (data.length) {
    message.dataText = data.join('\n');
    message.data = JSON.parse(message.dataText);
  }
  return message;
}

/** Confere os cabeçalhos do ADR 0006, no-store e a ausência de CORS. */
function assertPanelHeaders(headers, label) {
  for (const [name, value] of Object.entries(ADR_HEADERS)) assert.equal(headers[name], value, `${label}: ${name}`);
  assert.equal(headers['cache-control'], 'no-store', `${label}: cache-control`);
  assert.deepEqual(
    Object.keys(headers).filter((h) => h.startsWith('access-control-')),
    [],
    `${label}: sem CORS`,
  );
}

/** As 3 primeiras mensagens de uma conexão: retry, hello e snapshot. */
async function opening(client) {
  await client.waitMessage((m) => m.event === 'snapshot');
  return client.messages.slice(0, 3);
}

after(() => {
  for (const socket of sockets) socket.destroy();
});

describe('T9a hub: servidor real (node server/main.js --port 0)', () => {
  const home = tempDir('aq-int-sse-');
  let run;
  let port;
  const health = async () => JSON.parse((await request(port, { path: '/api/health' })).text);

  before(async () => {
    run = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: home.dir }));
    assert.equal(await run.started, true, run.output());
    port = JSON.parse(readFileSync(path.join(home.dir, 'runtime.json'), 'utf8')).port;
    assert.notEqual(port, 47821);
  });
  after(async () => {
    for (const socket of sockets) socket.destroy();
    if (run) await killTree(run.child);
    home.cleanup();
  });

  it('no fio: 200 text/event-stream, retry: 2000, hello sem id e snapshot com id runId:seq, nessa ordem', async () => {
    const client = await openSse(port);
    assert.equal(client.status, 200, client.rawHead);
    assert.equal(client.headers['content-type'], 'text/event-stream');
    assertPanelHeaders(client.headers, '/events');
    const [retry, hello, snapshot] = await opening(client);

    assert.deepEqual(retry.fields, ['retry']);
    assert.equal(retry.retry, 2000);

    assert.deepEqual(hello.fields, ['event', 'data'], 'hello sem id');
    assert.equal(hello.event, 'hello');
    assert.deepEqual(Object.keys(hello.data).sort(), ['protocol', 'runId', 'seq', 'serverVersion']);
    assert.equal(hello.data.protocol, 1);
    assert.match(hello.data.runId, /^[A-Za-z0-9_-]+$/, 'runId sem ":" nem quebra de linha');
    assert.equal(hello.data.serverVersion, VERSION);

    assert.deepEqual(snapshot.fields, ['id', 'event', 'data']);
    assert.equal(snapshot.event, 'snapshot');
    assert.equal(snapshot.id, `${hello.data.runId}:${hello.data.seq}`);
    assert.deepEqual(snapshot.data, { seq: hello.data.seq, sessions: [] }, 'sem estado ligado até o T7');

    // Os bytes exatos do início do fluxo, depois de tirar o chunked.
    const expected =
      'retry: 2000\n\n' +
      `event: hello\ndata: ${hello.dataText}\n\n` +
      `id: ${hello.data.runId}:${hello.data.seq}\nevent: snapshot\ndata: ${snapshot.dataText}\n\n`;
    assert.equal(client.text().slice(0, expected.length), expected);
    assert.equal(client.headers['transfer-encoding'], 'chunked');
    client.destroy();
  });

  // Atualizado no T9b (retomada por Last-Event-ID; seção 9, "Retomada"): só o id desta execução que
  // ainda dá para retomar dispensa o snapshot. No T9a, toda conexão recebia snapshot.
  it('hello em toda conexão, com o mesmo runId; snapshot sem Last-Event-ID ou com id de outra execução, inválido ou futuro; id igual ao seq atual recebe só o hello', async () => {
    const opened = [];
    try {
      const first = await openSse(port);
      opened.push(first);
      const [, hello] = await opening(first);
      const runId = hello.data.runId;
      for (const lastId of [`${runId}:999999`, 'outraExec:5', 'lixo', '', `${runId}:-1`, `${runId}:1.5`]) {
        const client = await openSse(port, { headers: { 'Last-Event-ID': lastId } });
        opened.push(client);
        const [retry, h, snapshot] = await opening(client);
        assert.equal(retry.retry, 2000, lastId);
        assert.equal(h.data.runId, runId, lastId);
        assert.equal(snapshot.event, 'snapshot', lastId);
        assert.equal(snapshot.id, `${runId}:${h.data.seq}`, lastId);
      }
      // Id igual ao seq atual: só retry e hello; o que vier depois já é o fluxo ao vivo (sem snapshot).
      const current = await openSse(port, { headers: { 'Last-Event-ID': `${runId}:${hello.data.seq}` } });
      opened.push(current);
      const { message: resumedHello } = await current.waitMessage((m) => m.event === 'hello');
      assert.equal(resumedHello.data.runId, runId);
      assert.equal(resumedHello.data.seq, hello.data.seq);
      const { token } = JSON.parse(readFileSync(path.join(home.dir, 'runtime.json'), 'utf8'));
      const body = JSON.stringify({ v: 1, sentAt: Date.now(), forwarder: 'teste', env: { projectDir: null, entrypoint: null }, truncated: false, payload: { hook_event_name: 'SessionStart', session_id: 'sessao-hub-retomada', source: 'startup' } });
      const res = await request(port, { method: 'POST', path: '/hooks', headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': token }, body });
      assert.equal(res.status, 204);
      const { index } = await current.waitMessage((m) => m.event === 'update');
      assert.deepEqual(current.messages.slice(0, index + 1).map((m) => m.event ?? 'retry'), ['retry', 'hello', 'update'], 'sem snapshot entre o hello e o primeiro update');
      assert.equal(current.messages[index].data.seq, hello.data.seq + 1);
    } finally {
      for (const client of opened) client.destroy();
      await waitFor(async () => (await health()).clients === 0, { label: 'clientes fechados' }).catch(() => {});
    }
  });

  it('GET /api/state: o mesmo conteúdo do snapshot, JSON, no-store e cabeçalhos do ADR 0006', async () => {
    const client = await openSse(port);
    const [, , snapshot] = await opening(client);
    const res = await request(port, { path: '/api/state' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assertPanelHeaders(res.headers, '/api/state');
    assert.equal(res.text, snapshot.dataText, 'mesmos bytes do data do snapshot');
    assert.deepEqual(JSON.parse(res.text), snapshot.data);
    const head = await request(port, { method: 'HEAD', path: '/api/state' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    client.destroy();
  });

  it('heartbeat ": ping" em até 16 s, com o relógio real, para cada cliente conectado', { timeout: 40_000 }, async (t) => {
    const a = await openSse(port);
    const startA = performance.now();
    await opening(a);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const b = await openSse(port);
    const startB = performance.now();
    await opening(b);

    const pingA = await a.waitMessage((m) => m.comments.includes('ping'), { timeoutMs: 16_500 });
    const pingB = await b.waitMessage((m) => m.comments.includes('ping'), { timeoutMs: 16_500 });
    const delayA = pingA.message.at - startA;
    const delayB = pingB.message.at - startB;
    t.diagnostic(`primeiro ping: cliente A em ${delayA.toFixed(0)} ms, cliente B (entrou 3 s depois) em ${delayB.toFixed(0)} ms`);
    assert.ok(delayA <= 16_000, `cliente A: primeiro ping em ${delayA.toFixed(0)} ms`);
    assert.ok(delayB <= 16_000, `cliente B: primeiro ping em ${delayB.toFixed(0)} ms`);
    assert.equal(pingA.message.raw, ': ping', 'linha de comentário, sem campos');
    assert.deepEqual(pingA.message.fields, []);
    a.destroy();
    b.destroy();
  });

  it('até 8 clientes; o nono recebe 503 (no-store, ADR 0006); quem sai, por qualquer jeito, libera a vaga', async () => {
    await waitFor(async () => (await health()).clients === 0, { label: 'zero clientes antes do teste' });
    const clients = [];
    for (let i = 0; i < 8; i++) {
      const client = await openSse(port);
      assert.equal(client.status, 200, `cliente ${i + 1}`);
      await opening(client);
      clients.push(client);
    }
    assert.equal((await health()).clients, 8);

    const ninth = await openSse(port);
    assert.equal(ninth.status, 503, ninth.rawHead);
    assertPanelHeaders(ninth.headers, '503');
    assert.match(ninth.headers['content-type'], /^text\/plain/);
    await waitFor(() => ninth.ended, { label: 'corpo do 503' });
    assert.doesNotMatch(ninth.text(), /event:|data:/);
    assert.equal((await health()).clients, 8, 'o 503 não entra na contagem');

    // Três jeitos de sair: socket destruído, conexão derrubada com RST e
    // meio-fechamento (o cliente para de escrever e espera o servidor).
    clients[0].destroy();
    clients[1].socket.resetAndDestroy();
    clients[2].halfClose();
    await waitFor(async () => (await health()).clients === 5, { label: 'contagem cair para 5' });

    for (let i = 0; i < 3; i++) {
      const client = await openSse(port);
      assert.equal(client.status, 200, `vaga liberada ${i + 1}`);
      clients.push(client);
    }
    assert.equal((await health()).clients, 8);
    assert.equal((await openSse(port)).status, 503, 'cheio de novo');

    for (const client of clients) client.destroy();
    await waitFor(async () => (await health()).clients === 0, { label: 'contagem voltar a 0' });
    // Desde a ligação do T9a, `sessions` é o número real de sessões em memória.
    assert.equal((await health()).sessions, JSON.parse((await request(port, { path: '/api/state' })).text).sessions.length);
  });

  it('Host, Origin e Sec-Fetch-Site de outra origem: 403 nas duas rotas, sem entrar na contagem', async () => {
    const refused = [
      { host: `evil.example:${port}` },
      { host: `127.0.0.1:${port + 1}` },
      { host: `[::1]:${port}` },
      { headers: { Origin: 'http://evil.example' } },
      { headers: { Origin: `http://localhost:${port}` } }, // a outra forma do loopback é outra origem
      { headers: { Origin: 'null' } },
      { headers: { Origin: `https://127.0.0.1:${port}` } },
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
      { headers: { 'Sec-Fetch-Site': 'same-site' } },
      { headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site' } },
    ];
    for (const route of ['/events', '/api/state']) {
      for (const variant of refused) {
        const client = await openSse(port, { path: route, ...variant });
        const label = `${route} ${JSON.stringify(variant)}`;
        assert.equal(client.status, 403, label);
        assertPanelHeaders(client.headers, label);
        await waitFor(() => client.ended, { label: `corpo do 403 ${label}` });
        assert.doesNotMatch(client.text(), /event:|"sessions"/, label);
        client.destroy();
      }
    }
    assert.equal((await health()).clients, 0);

    const accepted = [
      { headers: { Origin: `http://127.0.0.1:${port}` } },
      { host: `localhost:${port}`, headers: { Origin: `http://localhost:${port}` } },
      { headers: { 'Sec-Fetch-Site': 'same-origin' } },
      { headers: { 'Sec-Fetch-Site': 'none' } },
    ];
    for (const route of ['/events', '/api/state']) {
      for (const variant of accepted) {
        const client = await openSse(port, { path: route, ...variant });
        assert.equal(client.status, 200, `${route} ${JSON.stringify(variant)}`);
        client.destroy();
      }
    }
  });

  it('outros métodos: /events responde 405 com Allow: GET; /api/state, 405 com Allow: GET, HEAD', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const res = await request(port, { method, path: '/events', body: method === 'HEAD' ? undefined : '' });
      assert.equal(res.status, 405, `/events ${method}`);
      assert.equal(res.headers.allow, 'GET', `/events ${method}`);
      assertPanelHeaders(res.headers, `/events ${method}`);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await request(port, { method, path: '/api/state', body: '' });
      assert.equal(res.status, 405, `/api/state ${method}`);
      assert.equal(res.headers.allow, 'GET, HEAD', `/api/state ${method}`);
    }
    assert.equal((await health()).clients, 0);
  });

  it('200 conexões que entram e caem (algumas antes do snapshot chegar): a contagem volta a 0 e as vagas não vazam', async () => {
    await waitFor(async () => (await health()).clients === 0, { label: 'zero clientes antes do teste' });
    for (let round = 0; round < 25; round++) {
      const batch = await Promise.all(Array.from({ length: 8 }, () => openSse(port)));
      batch.forEach((client, i) => {
        assert.equal(client.status, 200, `rodada ${round}, cliente ${i}`);
        if (i % 3 === 0) client.socket.resetAndDestroy();
        else client.destroy();
      });
      // O servidor só libera a vaga quando processa o fechamento do socket; a
      // rodada seguinte espera isso (sem a espera, um 503 aqui seria correto).
      await waitFor(async () => (await health()).clients === 0, { label: `contagem voltar a 0 na rodada ${round}` });
    }
    const full = [];
    for (let i = 0; i < 8; i++) full.push(await openSse(port));
    assert.ok(full.every((client) => client.status === 200), 'as 8 vagas continuam disponíveis');
    assert.equal((await openSse(port)).status, 503);
    for (const client of full) client.destroy();
    await waitFor(async () => (await health()).clients === 0, { label: 'contagem voltar a 0' });
  });

  it('o terminal do servidor não registrou nada das conexões', () => {
    const lines = run.output().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      assert.match(line, /^(Agent Quest \S+ rodando em |Diretório de dados: |Ctrl\+C para parar\.|Aviso: AGENT_QUEST_HOME está definida \()/, line);
    }
  });
});

describe('T9a hub: createApp com estado falso (fixtures) e mensagens numeradas à mão', () => {
  const RUN_ID = 'runInt9a';
  const apps = [];
  after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const app of apps) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
  });

  async function start(options = {}) {
    const errors = [];
    const app = createApp({ version: '9.9.9', startedAt: 0, runId: RUN_ID, logError: (m) => errors.push(m), ...options });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    apps.push(app);
    return { ...app, port: app.server.address().port, errors };
  }

  it('para cada fixture: snapshot com id runId:seq e /api/state com os mesmos bytes', async () => {
    for (const name of FIXTURES) {
      const fixture = loadFixture(name);
      const app = await start({ getSnapshot: () => fixture });
      const client = await openSse(app.port);
      const [, hello, snapshot] = await opening(client);
      assert.equal(hello.data.seq, fixture.seq, name);
      assert.equal(snapshot.id, `${RUN_ID}:${fixture.seq}`, name);
      assert.equal(snapshot.dataText, JSON.stringify(fixture), name);
      const state = await request(app.port, { path: '/api/state' });
      assert.equal(state.text, snapshot.dataText, `${name}: /api/state igual ao snapshot`);
      client.destroy();
    }
  });

  it('8 clientes recebem os mesmos update e session-removed, em ordem, com id runId:seq; quem entra depois só vê o que vem depois', async () => {
    const fixture = loadFixture('primeira-luz');
    let current = fixture;
    const app = await start({ getSnapshot: () => current });
    const clients = [];
    for (let i = 0; i < 7; i++) {
      const client = await openSse(app.port);
      await opening(client);
      clients.push(client);
    }
    const session = fixture.sessions[0];
    const { feed, ...withoutFeed } = session;
    let seq = fixture.seq;
    const published = [];
    const publish = (kind) => {
      seq++;
      if (kind === 'removed') {
        const message = { seq, sessionId: `sessao-removida-${seq}` };
        app.hub.publishRemoved(message);
        published.push({ event: 'session-removed', message });
      } else {
        const event =
          kind === 'null'
            ? null
            : { id: `${RUN_ID}:${seq}`, seq, ts: 1_760_731_240_000 + seq, sessionId: session.id, agentKey: 'main', kind: 'tool.started', data: { toolUseId: `toolu_${seq}`, tool: 'Read', category: 'read', target: `docs/a${seq}.md`, detail: null } };
        const message = { seq, event, session: withoutFeed };
        app.hub.publishUpdate(message);
        published.push({ event: 'update', message });
      }
    };
    for (let i = 0; i < 20; i++) publish(i % 7 === 3 ? 'removed' : i % 5 === 4 ? 'null' : 'update');

    // Um oitavo cliente entra no meio: snapshot da hora e só o que vier depois.
    current = { ...fixture, seq };
    const late = await openSse(app.port);
    const [, lateHello, lateSnapshot] = await opening(late);
    assert.equal(lateHello.data.seq, seq);
    assert.equal(lateSnapshot.id, `${RUN_ID}:${seq}`);
    const lateFrom = published.length;
    for (let i = 0; i < 10; i++) publish(i % 4 === 1 ? 'removed' : 'update');
    assert.equal(app.health().clients, 8);

    const expectFrom = async (client, from, label) => {
      const want = published.slice(from);
      const last = want.at(-1).message.seq;
      await client.waitMessage((m) => m.id === `${RUN_ID}:${last}`, { timeoutMs: 5000 });
      const got = client.messages.slice(3).filter((m) => m.event);
      assert.equal(got.length, want.length, label);
      got.forEach((m, i) => {
        assert.equal(m.event, want[i].event, `${label} #${i}`);
        assert.equal(m.id, `${RUN_ID}:${want[i].message.seq}`, `${label} #${i}`);
        assert.deepEqual(m.fields, ['id', 'event', 'data'], `${label} #${i}`);
        assert.deepEqual(m.data, want[i].message, `${label} #${i}`);
      });
      const seqs = got.map((m) => m.data.seq);
      assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `${label}: seq crescente`);
    };
    for (const [i, client] of clients.entries()) await expectFrom(client, 0, `cliente ${i + 1}`);
    await expectFrom(late, lateFrom, 'cliente que entrou depois');
    for (const client of [...clients, late]) client.destroy();
  });

  it('conteúdo hostil (quebras de linha, CR, U+2028, "event:" embutido) não cria mensagens nem campos extras', async () => {
    const hostile = 'a\n\nevent: session-removed\ndata: {"seq":1}\n\nb\r\nid: x:1\rc d e';
    const fixture = loadFixture('neutro');
    const snapshot = structuredClone(fixture);
    if (snapshot.sessions[0]) snapshot.sessions[0].title = hostile;
    else snapshot.sessions.push({ id: hostile, title: hostile });
    const app = await start({ getSnapshot: () => snapshot });
    const client = await openSse(app.port);
    const [, , snap] = await opening(client);
    assert.deepEqual(snap.data, snapshot);
    app.hub.publishUpdate({ seq: snapshot.seq + 1, event: null, session: { id: hostile, title: hostile } });
    app.hub.publishRemoved({ seq: snapshot.seq + 2, sessionId: hostile });
    const { message } = await client.waitMessage((m) => m.event === 'session-removed');
    assert.equal(message.data.sessionId, hostile);
    const events = client.messages.filter((m) => m.event).map((m) => m.event);
    assert.deepEqual(events, ['hello', 'snapshot', 'update', 'session-removed']);
    for (const m of client.messages) {
      assert.equal(new Set(m.fields).size, m.fields.length, `campo repetido em: ${m.raw.slice(0, 80)}`);
    }
    client.destroy();
  });

  it('getSnapshot que lança: 500 nas duas rotas, sem entrar na contagem, log só com o tipo e o servidor segue', async () => {
    let fail = true;
    const fixture = loadFixture('neutro');
    const app = await start({
      getSnapshot: () => {
        if (fail) throw new TypeError('MARCADOR-SEGREDO-9a1');
        return fixture;
      },
    });
    const events = await openSse(app.port);
    assert.equal(events.status, 500);
    assertPanelHeaders(events.headers, '/events 500');
    const state = await request(app.port, { path: '/api/state' });
    assert.equal(state.status, 500);
    assert.equal(app.health().clients, 0);
    assert.ok(app.errors.length >= 2);
    for (const line of app.errors) assert.equal(line, 'Erro ao responder uma requisição: TypeError');
    fail = false;
    const ok = await openSse(app.port);
    assert.equal(ok.status, 200);
    await opening(ok);
    assert.equal(app.health().clients, 1);
    ok.destroy();
  });

  it('hub.close(): fluxos abertos terminam, a contagem zera e novas conexões recebem 503', async () => {
    const app = await start({ getSnapshot: () => loadFixture('neutro') });
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const client = await openSse(app.port);
      await opening(client);
      clients.push(client);
    }
    app.hub.close();
    for (const client of clients) await waitFor(() => client.ended, { label: 'fim do fluxo (chunk final)' });
    assert.equal(app.health().clients, 0);
    const after = await openSse(app.port);
    assert.equal(after.status, 503);
    assertPanelHeaders(after.headers, '503 depois do close');
    assert.equal(app.health().clients, 0);
    assert.throws(() => app.hub.publishUpdate({ event: null }), TypeError, 'o hub não numera: seq é obrigatório');
  });
});

describe('T9a hub: encerramento do servidor (startServer) com painéis abertos', () => {
  it('close() termina em pouco tempo e fecha os fluxos; o heartbeat não segura nada', async () => {
    const home = tempDir('aq-int-sse-close-');
    try {
      const result = await startServer({ argv: ['--port', '0'], env: { AGENT_QUEST_HOME: home.dir }, homedir: home.dir, logError: () => {} });
      assert.equal(result.status, 'started');
      const clients = [];
      for (let i = 0; i < 4; i++) {
        const client = await openSse(result.port);
        await opening(client);
        clients.push(client);
      }
      const begin = performance.now();
      await result.close();
      const ms = performance.now() - begin;
      assert.ok(ms < 2000, `close() levou ${ms.toFixed(0)} ms`);
      await Promise.all(clients.map((client) => client.closed));
      await assert.rejects(openSse(result.port), 'não escuta mais');
    } finally {
      home.cleanup();
    }
  });
});

describe('T9a hub: fronteira', () => {
  it('server/http/sse.js só importa módulos do Node: nada de server/domain/', () => {
    const source = readFileSync(path.join(REPO, 'server', 'http', 'sse.js'), 'utf8');
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const dynamic = [...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    for (const spec of imports) assert.match(spec, /^node:/, `import inesperado: ${spec}`);
    for (const spec of dynamic) assert.doesNotMatch(spec, /domain/, `import dinâmico do domínio: ${spec}`);
    assert.doesNotMatch(source, /seq\s*(\+\+|\+=|=\s*seq\s*\+)/, 'o hub não incrementa seq');
  });
});
