// Integração do T9b, parte independente (tester): retomada por Last-Event-ID,
// cliente lento, memória do buffer e injetor de cenários.
//
// Fontes: plano da v1 (T9b e "Adiantamento do pós-marco"), modelo de eventos
// (seção 9, "Retomada"), ADR 0004 (SSE) e ADR 0010 (testes; nenhum número
// absoluto de tempo: contadores, bytes e eventos observáveis).
//
// - Servidor no mesmo processo (startServer, porta 0, AGENT_QUEST_HOME e pasta
//   pessoal temporários) e HTTP real.
// - O "painel" dos testes é o store de verdade (web/js/store.js), com a mesma
//   regra de lacuna do connection.js: 'gap' busca /api/state.
// - O injetor roda como processo filho (node scripts/inject-fixture.mjs).
// - Guardas contra travamento: cada teste tem `timeout`, cada espera tem prazo
//   com `unref`, e tudo o que o arquivo abre é fechado no `after` final.
//
// Ids, nomes e caminhos são fictícios.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../server/main.js';
import { createApp } from '../../server/http/app.js';
import { BUFFER_SIZE, MAX_PENDING_BYTES } from '../../server/http/sse.js';
import { applyHello, applySessionRemoved, applySnapshot, applyUpdate, createStore } from '../../web/js/store.js';
import { syntheticScenario } from '../unit/server/domain/scenarios.js';
import { REPO, minimalEnv, request, tempDir, waitFor } from './server-helpers.js';

/** Teto de bytes do buffer de retomada (critério acrescentado pelo arquiteto em 19/10/2026, commit c4a7ab1). */
const BUFFER_MAX_BYTES = 1024 * 1024;

const TEST = { timeout: 180_000 };
const FAKE_PROJECT = 'C:\\Users\\fulana\\Projetos\\exemplo-9b';

// ---------------------------------------------------------------------------
// Guardas e limpeza
// ---------------------------------------------------------------------------

/** Corrida contra um prazo com temporizador `unref`: detecta travamento, não mede tempo. */
function guard(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: sem resposta em ${ms} ms (travou)`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);

after(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await guard(Promise.resolve().then(fn), 20_000, 'limpeza').catch(() => {});
  }
}, TEST);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Servidor, envelopes e ids
// ---------------------------------------------------------------------------

const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const aid = (n) => `a${n.toString(16).padStart(16, '0')}`;
const tid = (label) => `toolu_01T9B${label}`;

function hook(name, sessionId, fields = {}, who = null) {
  return {
    session_id: sessionId,
    cwd: FAKE_PROJECT,
    hook_event_name: name,
    ...(who ? { agent_id: who.id, agent_type: who.type } : {}),
    ...fields,
  };
}
const pre = (sessionId, id, who = null) => hook('PreToolUse', sessionId, { tool_name: 'Read', tool_input: { file_path: `${FAKE_PROJECT}\\a.md` }, tool_use_id: id }, who);
const post = (sessionId, id, who = null) => hook('PostToolUse', sessionId, { tool_name: 'Read', tool_input: { file_path: `${FAKE_PROJECT}\\a.md` }, tool_use_id: id, tool_response: {} }, who);
const envelope = (payload) => ({ v: 1, sentAt: Date.now(), forwarder: 'teste-9b', env: { projectDir: FAKE_PROJECT, entrypoint: null }, truncated: false, payload });

/** startServer no mesmo processo, fechado no fim do teste (ou do arquivo). */
async function startLocal(t) {
  const data = tempDir('aq-int-9b-');
  const home = tempDir('aq-int-9b-home-');
  const server = await guard(
    startServer({
      argv: ['--port', '0'],
      env: { AGENT_QUEST_HOME: data.dir },
      homedir: home.dir,
      logError: () => {},
      pipeline: { reader: { read: async () => [] } },
    }),
    60_000,
    'startServer',
  );
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    try {
      await guard(server.close(), 20_000, 'close()');
    } catch {
      server.pipeline.stop();
      server.server.closeAllConnections();
      server.server.unref();
    }
    for (const dir of [data, home]) {
      try {
        dir.cleanup();
      } catch {
        // pasta temporária; não trava o arquivo
      }
    }
  };
  onCleanup(shutdown);
  t.after(shutdown);
  const { port } = server;
  const { token } = server.runtime;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  onCleanup(() => agent.destroy());
  t.after(() => agent.destroy());
  return {
    server,
    port,
    send: async (payload) => {
      const res = await request(port, {
        method: 'POST',
        path: '/hooks',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': token },
        body: JSON.stringify(envelope(payload)),
        agent,
      });
      assert.equal(res.status, 204);
    },
    state: async () => JSON.parse((await request(port, { path: '/api/state' })).text),
    health: async () => JSON.parse((await request(port, { path: '/api/health' })).text),
    seq: () => server.pipeline.currentSeq(),
  };
}

// ---------------------------------------------------------------------------
// Cliente SSE e painel (store de verdade)
// ---------------------------------------------------------------------------

const openClients = new Set();
onCleanup(() => {
  for (const client of [...openClients]) client.close();
});

/**
 * Cliente SSE: mensagens (`event`, `id`, `data`, `bytes` do bloco como saiu do
 * servidor), `pause()`/`resume()` para simular quem não lê.
 */
function openSse(port, { headers = {}, onMessage } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false, headers }, (res) => {
      clearTimeout(noResponse);
      const waiters = new Set();
      const notify = () => {
        for (const check of [...waiters]) check();
      };
      let buffer = '';
      const client = {
        status: res.statusCode,
        messages: [],
        ended: false,
        close() {
          req.destroy();
        },
        pause: () => res.pause(),
        resume: () => res.resume(),
        lastId() {
          return client.messages.findLast((m) => m.id !== undefined)?.id ?? null;
        },
        waitFor(predicate, { timeoutMs = 20_000, label = 'mensagem SSE' } = {}) {
          return new Promise((done, fail) => {
            let next = 0;
            const cleanup = () => {
              clearTimeout(timer);
              waiters.delete(check);
            };
            const check = () => {
              for (; next < client.messages.length; next++) {
                if (predicate(client.messages[next])) {
                  cleanup();
                  done(client.messages[next]);
                  return;
                }
              }
              if (client.ended) {
                cleanup();
                fail(new Error(`${label}: a conexão fechou antes`));
              }
            };
            const timer = setTimeout(() => {
              cleanup();
              fail(new Error(`${label}: não chegou em ${timeoutMs} ms (${client.messages.length} mensagens)`));
            }, timeoutMs);
            timer.unref();
            waiters.add(check);
            check();
          });
        },
      };
      client.closed = new Promise((done) =>
        res.on('close', () => {
          client.ended = true;
          openClients.delete(client);
          notify();
          done();
        }),
      );
      res.on('error', () => {});
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const message = { bytes: Buffer.byteLength(block) + 2 };
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            message[line.slice(0, colon)] = line.slice(colon + 1).replace(/^ /, '');
          }
          if (message.event === undefined) continue;
          if (message.data !== undefined) message.data = JSON.parse(message.data);
          client.messages.push(message);
          onMessage?.(message);
        }
        notify();
      });
      openClients.add(client);
      resolve(client);
    });
    const noResponse = setTimeout(() => req.destroy(new Error('GET /events sem resposta em 20 s')), 20_000);
    noResponse.unref();
    req.on('error', (err) => {
      clearTimeout(noResponse);
      reject(err);
    });
  });
}

/**
 * Uma conexão do painel ligada a um store, com as regras do connection.js:
 * `hello` → applyHello; `snapshot` → applySnapshot; `update` e `session-removed`
 * pelo store; 'gap' busca /api/state e reaplica o que chegou durante a busca.
 */
async function panel(port, store, { lastEventId = null } = {}) {
  const stats = { snapshots: 0, ok: 0, ignored: 0, gaps: 0, events: [] };
  let resyncing = false;
  let pending = [];
  const apply = (message) => (message.event === 'update' ? applyUpdate(store, message.data) : applySessionRemoved(store, message.data));
  const resync = async () => {
    resyncing = true;
    const state = JSON.parse((await request(port, { path: '/api/state' })).text);
    applySnapshot(store, state);
    const queued = pending;
    pending = [];
    resyncing = false;
    for (const message of queued) apply(message);
  };
  const client = await openSse(port, {
    headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {},
    onMessage(message) {
      stats.events.push(message.event);
      if (message.event === 'hello') applyHello(store, message.data);
      else if (message.event === 'snapshot') {
        stats.snapshots++;
        applySnapshot(store, message.data);
      } else if (message.event === 'update' || message.event === 'session-removed') {
        if (resyncing) {
          pending.push(message);
          return;
        }
        const result = apply(message);
        stats[result === 'gap' ? 'gaps' : result]++;
        if (result === 'gap') {
          pending.push(message);
          resync().catch(() => {});
        }
      }
    },
  });
  assert.equal(client.status, 200);
  return Object.assign(client, { stats });
}

/** O store tem exatamente as sessões do /api/state. */
function assertStoreEqualsState(store, state, label = 'store') {
  assert.equal(store.seq, state.seq, `${label}: seq`);
  const byId = (list) => Object.fromEntries([...list].map((s) => [s.id, s]));
  assert.deepEqual(byId(store.sessions.values()), byId(state.sessions), `${label}: sessões = /api/state`);
}

/**
 * Mensagens guardadas para a retomada, como a seção 9 define: o maior sufixo
 * com no máximo BUFFER_SIZE mensagens e BUFFER_MAX_BYTES bytes. Devolve o seq
 * da mais antiga guardada.
 */
function expectedOldest(numbered) {
  let bytes = 0;
  let oldest = numbered.at(-1).data.seq + 1;
  for (let i = numbered.length - 1, count = 0; i >= 0; i--, count++) {
    bytes += numbered[i].bytes;
    if (count + 1 > BUFFER_SIZE || bytes > BUFFER_MAX_BYTES) break;
    oldest = numbered[i].data.seq;
  }
  return oldest;
}

/** Abre com `Last-Event-ID` e diz o que veio: 'snapshot' ou a lista de seq retomados. */
async function probe(port, lastEventId, currentSeq) {
  const client = await openSse(port, { headers: { 'Last-Event-ID': lastEventId } });
  try {
    await client.waitFor((m) => m.event === 'snapshot' || (m.event !== 'hello' && m.data?.seq === currentSeq), { label: `probe ${lastEventId}` });
    if (client.messages.some((m) => m.event === 'snapshot')) return 'snapshot';
    return client.messages.filter((m) => m.event !== 'hello').map((m) => m.data.seq);
  } finally {
    client.close();
    await guard(client.closed, 20_000, 'fechar o probe').catch(() => {});
  }
}

/** Sessão com muitos subagentes trabalhando: cada `update` dela passa de 40 KB. */
async function bigSession(local, n, agents = 100) {
  const S = sid(n);
  for (let i = 0; i < agents; i++) await local.send(pre(S, tid(`G${n}x${i}`), { id: aid(n * 1000 + i), type: 'tester' }));
  return S;
}

// ===========================================================================
// 1. Retomada
// ===========================================================================

describe('T9b retomada por Last-Event-ID (HTTP real, store do painel)', () => {
  it('reconexão com id válido: hello e só o que faltou, sem snapshot; o fluxo segue ao vivo; o store termina igual ao /api/state', TEST, async (t) => {
    const local = await startLocal(t);
    const store = createStore();
    const first = await panel(local.port, store);
    const S = sid(1);
    for (let i = 0; i < 5; i++) await local.send(pre(S, tid(`A${i}`)));
    await waitFor(() => store.seq === local.seq(), { label: 'primeira conexão em dia' });
    const lastId = first.lastId();
    first.close();
    await guard(first.closed, 20_000, 'fechar');
    const before = local.seq();
    for (let i = 5; i < 12; i++) await local.send(pre(S, tid(`A${i}`)));
    await local.send(hook('SessionStart', sid(2), { source: 'startup' }));
    const missed = local.seq() - before;

    const second = await panel(local.port, store, { lastEventId: lastId });
    await waitFor(() => store.seq === local.seq(), { label: 'retomada em dia' });
    assert.equal(second.stats.events[0], 'hello');
    assert.equal(second.stats.snapshots, 0, 'retomada sem snapshot');
    assert.equal(second.stats.ok, missed, 'exatamente o que faltou');
    assert.deepEqual([second.stats.gaps, second.stats.ignored], [0, 0], 'sem lacuna nem duplicata');
    // Ao vivo depois da retomada.
    await local.send(post(S, tid('A11')));
    await waitFor(() => store.seq === local.seq(), { label: 'ao vivo depois da retomada' });
    assertStoreEqualsState(store, await local.state());
    second.close();
  });

  it(`borda por quantidade (${BUFFER_SIZE} mensagens): a mais antiga guardada retoma, a anterior a ela recebe snapshot; outra execução, inválido e futuro recebem snapshot`, TEST, async (t) => {
    // createApp com o hub de verdade e mensagens pequenas, numeradas à mão (o hub não numera):
    // 1 150 mensagens de menos de 100 bytes ficam bem abaixo do teto de bytes, então manda a quantidade.
    let current = 0;
    const runId = 'borda9b';
    const { server, hub } = createApp({ version: '0.0.0-teste', startedAt: Date.now(), runId, logError: () => {}, getSnapshot: () => ({ seq: current, sessions: [] }), getSeq: () => current });
    await guard(new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)), 20_000, 'listen');
    const closeServer = () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
    onCleanup(closeServer);
    t.after(closeServer);
    const { port } = server.address();
    const all = await openSse(port);
    await all.waitFor((m) => m.event === 'snapshot');
    for (let i = 0; i < BUFFER_SIZE + 150; i++) {
      current++;
      hub.publishUpdate({ seq: current, event: null, session: { id: 's' } });
    }
    await all.waitFor((m) => m.data?.seq === current && m.event !== 'hello');
    const numbered = all.messages.filter((m) => m.event === 'update');
    const oldest = expectedOldest(numbered);
    const bytes = numbered.slice(-BUFFER_SIZE).reduce((sum, m) => sum + m.bytes, 0);
    t.diagnostic(`${numbered.length} mensagens, as últimas ${BUFFER_SIZE} somam ${bytes} bytes; a mais antiga guardada é a ${oldest}`);
    assert.equal(oldest, current - BUFFER_SIZE + 1, 'nesta rodada o limite é a quantidade');
    all.close();
    const local = { port };

    const resumed = await probe(local.port, `${runId}:${oldest - 1}`, current);
    assert.deepEqual(resumed, Array.from({ length: current - oldest + 1 }, (_, i) => oldest + i), 'retoma desde a mais antiga guardada');
    assert.equal(await probe(local.port, `${runId}:${oldest - 2}`, current), 'snapshot', 'a mensagem seguinte já saiu do buffer');
    assert.equal(await probe(local.port, `${runId}:0`, current), 'snapshot');
    for (const lastId of [`${runId}:${current + 1}`, 'outraExecucao:5', `${runId}:x`, `${runId}`, ` ${runId}:${current - 3}x`]) {
      assert.equal(await probe(local.port, lastId, current), 'snapshot', lastId);
    }
  });

  it(`borda por bytes (${BUFFER_MAX_BYTES} bytes): com mensagens grandes, retoma só o que cabe no teto; antes disso, snapshot`, TEST, async (t) => {
    const local = await startLocal(t);
    const all = await openSse(local.port);
    await all.waitFor((m) => m.event === 'snapshot');
    const S = await bigSession(local, 20);
    for (let i = 0; i < 60; i++) await local.send(pre(S, tid(`C${i}`)));
    const current = local.seq();
    await all.waitFor((m) => m.data?.seq === current && m.event !== 'hello');
    const numbered = all.messages.filter((m) => m.event === 'update' || m.event === 'session-removed');
    const oldest = expectedOldest(numbered);
    t.diagnostic(`última mensagem com ${numbered.at(-1).bytes} bytes; ${current - oldest + 1} mensagens cabem em ${BUFFER_MAX_BYTES} bytes; a mais antiga guardada é a ${oldest}`);
    assert.ok(current - oldest + 1 < BUFFER_SIZE, 'nesta rodada o limite é o de bytes');
    const runId = all.messages[0].data.runId;
    all.close();
    const resumed = await probe(local.port, `${runId}:${oldest - 1}`, current);
    assert.deepEqual(resumed, Array.from({ length: current - oldest + 1 }, (_, i) => oldest + i));
    assert.equal(await probe(local.port, `${runId}:${oldest - 2}`, current), 'snapshot');
  });

  it('vários clientes retomando ao mesmo tempo no meio de uma rajada: nenhuma lacuna nem duplicata, e cada store igual ao /api/state', TEST, async (t) => {
    const local = await startLocal(t);
    const CLIENTS = 6;
    const stores = Array.from({ length: CLIENTS }, () => createStore());
    const stats = [];
    let bursting = true;
    t.after(() => {
      bursting = false;
    });
    const cycle = async (k) => {
      let client = await panel(local.port, stores[k]);
      stats.push(client.stats);
      await client.waitFor((m) => m.event === 'snapshot');
      let lastId = client.lastId();
      while (bursting) {
        await sleep(10 + Math.floor(Math.random() * 60));
        // Uma conexão retomada que ainda não recebeu nada guarda o id da anterior (como o EventSource).
        lastId = client.lastId() ?? lastId;
        client.close();
        await guard(client.closed, 20_000, 'fechar');
        await sleep(Math.floor(Math.random() * 40));
        client = await panel(local.port, stores[k], { lastEventId: lastId });
        stats.push(client.stats);
      }
      return client;
    };
    const cycles = stores.map((_, k) => cycle(k));
    const lane = async (n) => {
      for (let i = 0; i < 150; i++) {
        await local.send(i % 4 === 3 ? post(sid(30 + n), tid(`D${n}x${i - 1}`)) : pre(sid(30 + n), tid(`D${n}x${i}`)));
      }
    };
    try {
      await Promise.all([0, 1, 2, 3].map(lane));
    } finally {
      bursting = false;
    }
    const finals = await guard(Promise.all(cycles), 60_000, 'clientes');
    await waitFor(() => stores.every((store) => store.seq === local.seq()), { label: 'todos em dia', timeoutMs: 30_000 });
    const state = await local.state();
    stores.forEach((store, k) => assertStoreEqualsState(store, state, `cliente ${k}`));
    const resumes = stats.length - CLIENTS;
    const total = stats.reduce((acc, s) => ({ snapshots: acc.snapshots + s.snapshots, gaps: acc.gaps + s.gaps, ignored: acc.ignored + s.ignored, ok: acc.ok + s.ok }), { snapshots: 0, gaps: 0, ignored: 0, ok: 0 });
    t.diagnostic(`${resumes} retomadas em ${CLIENTS} clientes; ${JSON.stringify(total)}`);
    assert.ok(resumes >= CLIENTS, 'cada cliente caiu e voltou pelo menos uma vez');
    assert.equal(total.snapshots, CLIENTS, 'só a primeira conexão de cada um recebeu snapshot');
    assert.deepEqual([total.gaps, total.ignored], [0, 0], 'sem lacuna nem duplicata');
    for (const client of finals) client.close();
  });
});

// ===========================================================================
// 2. Cliente lento e memória
// ===========================================================================

describe('T9b cliente lento e memória do buffer', () => {
  it('cliente que para de ler (socket de verdade): desconectado só depois de mais de 1 MiB acumulado, sem afetar os outros; volta com snapshot', TEST, async (t) => {
    const local = await startLocal(t);
    const S = await bigSession(local, 40);
    const store = createStore();
    const fast = await panel(local.port, store);
    const slow = await openSse(local.port);
    await slow.waitFor((m) => m.event === 'snapshot');
    slow.pause();
    assert.equal((await local.health()).clients, 2);
    let published = 0;
    let posts = 0;
    while ((await local.health()).clients === 2) {
      assert.ok(posts < 2000, 'o cliente lento nunca foi desconectado');
      const before = fast.messages.length;
      await local.send(pre(S, tid(`L${posts}`)));
      posts++;
      await waitFor(() => fast.messages.length > before, { label: 'update no cliente que lê', timeoutMs: 20_000 });
      published += fast.messages.at(-1).bytes;
    }
    t.diagnostic(`cliente lento desconectado depois de ${posts} updates (${published} bytes publicados desde a pausa)`);
    assert.ok(published > MAX_PENDING_BYTES, 'só depois de mais de 1 MiB');
    // Os outros seguem: o cliente que lê recebeu tudo, em ordem, e o servidor continua processando.
    await local.send(post(S, tid('Lfim')));
    await waitFor(() => store.seq === local.seq(), { label: 'cliente que lê em dia' });
    assert.deepEqual([fast.stats.gaps, fast.stats.ignored, fast.stats.snapshots], [0, 0, 1]);
    assertStoreEqualsState(store, await local.state(), 'cliente que lê');
    assert.equal((await local.health()).clients, 1);
    // O lento volta com o último id que chegou até ele: o que falta passa do limite, então snapshot.
    slow.resume();
    await guard(slow.closed, 20_000, 'o lento perceber a queda');
    const lastId = slow.lastId();
    const again = await openSse(local.port, { headers: { 'Last-Event-ID': lastId } });
    await again.waitFor((m) => m.event === 'snapshot', { label: 'snapshot na volta do lento' });
    again.close();
    fast.close();
  });

  it('envio inicial grande não conta como acumulado: quem demora a ler um snapshot grande não é derrubado e recebe tudo', TEST, async (t) => {
    const local = await startLocal(t);
    // Bem acima de 1 MiB e dos buffers do sistema, para o envio inicial ficar em boa parte no servidor.
    for (let n = 0; n < 40; n++) await bigSession(local, 50 + n);
    const snapshotBytes = (await request(local.port, { path: '/api/state' })).body.length;
    t.diagnostic(`snapshot com ${snapshotBytes} bytes`);
    assert.ok(snapshotBytes > 2 * MAX_PENDING_BYTES, 'o snapshot passa de 2 MiB');
    const store = createStore();
    const client = await panel(local.port, store);
    client.pause();
    for (let i = 0; i < 5; i++) await local.send(pre(sid(99), tid(`I${i}`)));
    assert.equal((await local.health()).clients, 1, 'não foi derrubado pelo snapshot');
    client.resume();
    await waitFor(() => store.seq === local.seq(), { label: 'em dia depois de ler o snapshot' });
    assert.deepEqual([client.stats.gaps, client.stats.ignored], [0, 0]);
    assertStoreEqualsState(store, await local.state());
    client.close();
  });

  it(`memória do buffer sem clientes: fica perto do teto de ${BUFFER_MAX_BYTES} bytes, mesmo com mensagens grandes`, TEST, async (t) => {
    // Processo à parte com --expose-gc: o hub de verdade, 3 000 updates de ~40 KB sem nenhum cliente.
    const dir = tempDir('aq-int-9b-mem-');
    onCleanup(() => dir.cleanup());
    const script = path.join(dir.dir, 'mem.mjs');
    writeFileSync(
      script,
      [
        `import { createSseHub } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'server', 'http', 'sse.js')).href)};`,
        'let seq = 0;',
        "const hub = createSseHub({ runId: 'mem9b', serverVersion: 't', getSnapshot: () => ({ seq, sessions: [] }), getSeq: () => seq });",
        "const pad = 'x'.repeat(40_000);",
        'globalThis.gc(); globalThis.gc();',
        'const before = process.memoryUsage().heapUsed;',
        'for (let i = 0; i < 3000; i++) { seq++; hub.publishUpdate({ seq, event: null, session: { id: `s${i % 10}`, pad: `${pad}${i}` } }); }',
        'globalThis.gc(); globalThis.gc();',
        'const after = process.memoryUsage().heapUsed;',
        'process.stdout.write(`${hub.clientCount()} ${after - before}\\n`);',
      ].join('\n'),
    );
    const child = spawn(process.execPath, ['--expose-gc', script], { env: minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    onCleanup(() => child.kill());
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c) => (err += c));
    const code = await guard(new Promise((resolve) => child.on('exit', resolve)), 60_000, 'processo de memória');
    assert.equal(code, 0, err);
    const growth = Number(out.trim().split(' ').at(-1));
    t.diagnostic(`heap a mais com o buffer cheio: ${(growth / 1024 / 1024).toFixed(2)} MiB (sem teto seriam ~${((BUFFER_SIZE * 40_000) / 1024 / 1024).toFixed(0)} MiB)`);
    assert.ok(growth < 4 * BUFFER_MAX_BYTES, `o buffer passou de 4 MiB: ${growth} bytes`);
  });
});

// ===========================================================================
// 3. Injetor
// ===========================================================================

describe('T9b injetor (node scripts/inject-fixture.mjs, processo filho)', () => {
  const INJECTOR = path.join(REPO, 'scripts', 'inject-fixture.mjs');

  /** Servidor que grava os pedidos e responde 204. */
  async function recordingServer(host = '127.0.0.1') {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(204);
        res.end();
      });
    });
    await guard(new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    }), 20_000, 'listen');
    const close = () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
    onCleanup(close);
    return { port: server.address().port, requests, close };
  }

  /** Pasta de dados com um runtime.json e um cenário pequeno. */
  function setup(runtime) {
    const dir = tempDir('aq-int-9b-inj-');
    onCleanup(() => dir.cleanup());
    writeFileSync(path.join(dir.dir, 'runtime.json'), JSON.stringify(runtime));
    const scenario = {
      name: 'cenario-9b',
      description: 'SINTÉTICO: três eventos',
      events: [
        { dt: 0, env: { projectDir: FAKE_PROJECT, entrypoint: 'cli' }, payload: hook('SessionStart', sid(200), { source: 'startup' }) },
        { dt: 5, env: { projectDir: FAKE_PROJECT, entrypoint: 'cli' }, payload: pre(sid(200), tid('Inj1')) },
        { dt: 5, env: { projectDir: FAKE_PROJECT, entrypoint: 'cli' }, payload: post(sid(200), tid('Inj1')) },
      ],
    };
    const file = path.join(dir.dir, 'cenario.json');
    writeFileSync(file, JSON.stringify(scenario));
    return { dataDir: dir.dir, file, scenario };
  }

  function runInjector(dataDir, args) {
    const child = spawn(process.execPath, [INJECTOR, ...args], { cwd: REPO, env: minimalEnv({ AGENT_QUEST_HOME: dataDir }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    onCleanup(() => child.kill());
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
    return guard(new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr }))), 60_000, 'injetor');
  }

  const runtimeFor = (port, extra = {}) => ({ port, token: 'token-ficticio-9b', pid: process.pid, version: '0.1.0', startedAt: Date.now(), ...extra });

  it('envia só para 127.0.0.1, no caminho /hooks, com o token, JSON e sem Origin; envelopes v1 na ordem, com sentAt sempre crescente', TEST, async () => {
    const target = await recordingServer();
    const { dataDir, file, scenario } = setup(runtimeFor(target.port));
    const result = await runInjector(dataDir, [file, '--fast']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(target.requests.length, scenario.events.length);
    const sentAts = [];
    target.requests.forEach((req, i) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/hooks');
      assert.equal(req.headers.host, `127.0.0.1:${target.port}`);
      assert.equal(req.headers['x-agent-quest-token'], 'token-ficticio-9b');
      assert.match(req.headers['content-type'], /^application\/json/);
      assert.equal(req.headers.origin, undefined);
      const body = JSON.parse(req.body);
      assert.equal(body.v, 1);
      assert.equal(body.forwarder, 'inject');
      assert.deepEqual(body.payload, scenario.events[i].payload);
      assert.deepEqual(body.env, scenario.events[i].env);
      sentAts.push(body.sentAt);
    });
    for (let i = 1; i < sentAts.length; i++) assert.ok(sentAts[i] > sentAts[i - 1], `sentAt crescente: ${sentAts}`);
    await target.close();
  });

  it('sem token, com token vazio ou com o servidor morto (pid): sai com 1 e não envia nada', TEST, async () => {
    const target = await recordingServer();
    const dead = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
      child.on('exit', () => resolve(child.pid));
    });
    for (const [label, runtime] of [
      ['sem token', (({ token, ...rest }) => rest)(runtimeFor(target.port))],
      ['token vazio', runtimeFor(target.port, { token: '' })],
      ['pid morto', runtimeFor(target.port, { pid: dead })],
      ['porta fora da faixa', runtimeFor(80)],
    ]) {
      const { dataDir, file } = setup(runtime);
      const result = await runInjector(dataDir, [file, '--fast']);
      assert.equal(result.code, 1, label);
      assert.notEqual(result.stderr, '', `${label}: diz o motivo`);
    }
    assert.equal(target.requests.length, 0, 'nada chegou');
    await target.close();
  });

  it('nunca envia para fora de 127.0.0.1: com o único servidor escutando num IP da rede, na porta do runtime.json, nada chega a ele', TEST, async (t) => {
    const external = Object.values(os.networkInterfaces()).flat().find((item) => item && !item.internal && item.family === 'IPv4');
    if (!external) {
      t.diagnostic('sem IPv4 externo nesta máquina: o caso fica coberto pelo cabeçalho Host do teste anterior');
      return;
    }
    const target = await recordingServer(external.address);
    const { dataDir, file } = setup(runtimeFor(target.port));
    const result = await runInjector(dataDir, [file, '--fast']);
    assert.equal(result.code, 1, 'a conexão com 127.0.0.1 é recusada');
    assert.equal(target.requests.length, 0, 'nada chegou ao IP da rede');
    await target.close();
  });

  it('o injetor de um cenário sintético contra o servidor real, em duas metades: todos aceitos, e o store retomado entre elas termina igual ao /api/state', TEST, async (t) => {
    const local = await startLocal(t);
    const store = createStore();
    const first = await panel(local.port, store);
    const scenario = syntheticScenario();
    const half = Math.floor(scenario.events.length / 2);
    const dir = tempDir('aq-int-9b-sint-');
    onCleanup(() => dir.cleanup());
    const files = [scenario.events.slice(0, half), scenario.events.slice(half)].map((events, i) => {
      const file = path.join(dir.dir, `parte-${i}.json`);
      writeFileSync(file, JSON.stringify({ name: `sintetico-${i}`, description: 'SINTÉTICO', events }));
      return file;
    });
    const run1 = await runInjector(local.server.dataDir, [files[0], '--fast']);
    assert.equal(run1.code, 0, run1.stderr);
    await waitFor(() => store.seq === local.seq(), { label: 'primeira metade' });
    const lastId = first.lastId();
    first.close();
    await guard(first.closed, 20_000, 'fechar');
    const run2 = await runInjector(local.server.dataDir, [files[1], '--fast']);
    assert.equal(run2.code, 0, run2.stderr);
    const second = await panel(local.port, store, { lastEventId: lastId });
    await waitFor(() => store.seq === local.seq(), { label: 'retomada' });
    assert.equal(second.stats.snapshots, 0);
    assert.deepEqual([second.stats.gaps, second.stats.ignored], [0, 0]);
    const health = await local.health();
    assert.equal(health.events.accepted + health.events.deduped, scenario.events.length);
    assert.equal(health.events.rejected, 0);
    assertStoreEqualsState(store, await local.state());
    second.close();
  });
});
