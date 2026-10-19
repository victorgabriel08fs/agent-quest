// Integração do T9a, fechamento da ligação de ponta a ponta (tester).
//
// Fontes: plano da v1 (T9a: condições 5 e 6, critérios de aceite e linha
// "Tester"), modelo de eventos (seções 7, 9 e 10), ADRs 0004 (SSE), 0006
// (segurança) e 0010 (testes, inclusive o complemento "testes de tempo
// estáveis": contador ou relógio injetado; relógio real só com referência do
// mesmo teste).
//
// Três montagens:
// - servidor real (`node server/main.js --port 0`, outro processo, com
//   AGENT_QUEST_HOME e pasta pessoal temporários) e HTTP real: conexão SSE,
//   numeração, limite de clientes, Host e Origin, segurança;
// - "Primeira luz": o mesmo servidor real numa porta livre, o encaminhador real
//   (capture/.../forward.mjs) como processo filho, uma sessão realista com
//   delegação a um subagente, o SessionState final contra a seção 9, a
//   deduplicação, a latência e a queda e volta do servidor;
// - startServer no mesmo processo, com a opção `pipeline` (relógio, temporizadores,
//   reducer e leitor de .claude/agents/ injetados): erro do reducer, tick, rajada,
//   fila cheia, segredos e fuzz.
//
// Ids, nomes e caminhos são fictícios. Nada usa o diretório de dados real, a
// pasta pessoal real nem a porta 47821.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { FEED_KINDS } from '../../shared/contract.js';
import { startServer } from '../../server/main.js';
import { createApp } from '../../server/http/app.js';
import { TICK_MS, createPipeline } from '../../server/pipeline.js';
import { redact } from '../../server/domain/redact.js';
import { apply, tick } from '../../server/domain/state/index.js';
import { ADR_HEADERS, REPO, fixedPort, killTree, launchServer, minimalEnv, request, tempDir, waitFor } from './server-helpers.js';
import {
  assertSilentExit,
  assertWithinLimit,
  forwarderEnv,
  hitDeadline,
  loadFrom,
  readJson,
  runForwarder,
  withLoadSamples,
} from './capture-helpers.js';

/** Prazo generoso para "o processo subiu": detecta travamento, não mede tempo (ADR 0010). */
const START_GUARD_MS = 60_000;

// ---------------------------------------------------------------------------
// Guardas contra travamento: o arquivo termina sozinho mesmo se o código de
// produção travar. Cada teste e cada gancho tem `timeout`; cada espera tem
// prazo; tudo o que o arquivo abre (servidores, processos, clientes SSE,
// pipes, laços) se registra aqui e é fechado no `after` final, também quando
// uma asserção falha. Os temporizadores das guardas usam `unref`.
// ---------------------------------------------------------------------------

/** Prazo de cada teste e gancho (node:test `timeout`). */
const TEST = { timeout: 180_000 };
const LONG_TEST = { timeout: 420_000 };
/** Prazo de cada passo de limpeza. */
const CLEANUP_GUARD_MS = 20_000;

/**
 * Corrida contra um prazo, com temporizador `unref`. Detecta travamento; não mede tempo.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function guard(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: sem resposta em ${ms} ms (travou)`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Limpezas pendentes do arquivo, na ordem em que foram registradas. */
const cleanups = new Map();
let cleanupSeq = 0;

/** Registra uma limpeza; devolve a função que a tira do registro (já foi feita). */
function onCleanup(fn) {
  const id = cleanupSeq++;
  cleanups.set(id, fn);
  return () => cleanups.delete(id);
}

/** Roda as limpezas pendentes, da mais nova para a mais antiga, cada uma com prazo. */
async function runCleanups() {
  for (const [id, fn] of [...cleanups].reverse()) {
    cleanups.delete(id);
    await guard(Promise.resolve().then(fn), CLEANUP_GUARD_MS, 'limpeza').catch(() => {});
  }
}

/** `launchServer` com o processo registrado para ser encerrado no fim, aconteça o que acontecer. */
function launchTracked(args, env) {
  const run = launchServer(args, env, { timeoutMs: START_GUARD_MS });
  onCleanup(() => killTree(run.child));
  return run;
}

/** Encerra um processo filho com prazo. */
function stopProcess(run) {
  return guard(killTree(run.child), CLEANUP_GUARD_MS, 'encerrar o servidor');
}

const VERSION = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

/** Projeto e pasta pessoal fictícios (montagens no mesmo processo; nada é lido do disco com eles). */
const FAKE_HOME = 'C:\\Users\\fulana';
const FAKE_PROJECT = `${FAKE_HOME}\\Projetos\\exemplo-9a`;

// ---------------------------------------------------------------------------
// Ids fictícios
// ---------------------------------------------------------------------------

/** session_id fictício, no formato UUID. */
const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** agent_id fictício: `a` + 16 hexadecimais, como os reais. */
const aid = (n) => `a${n.toString(16).padStart(16, '0')}`;
/** tool_use_id fictício. */
const tid = (label) => `toolu_01T9A${label}`;

// ---------------------------------------------------------------------------
// Envelopes e HTTP
// ---------------------------------------------------------------------------

/**
 * Payload de hook com os campos comuns.
 * @param {string} hook
 * @param {string} sessionId
 * @param {Record<string, unknown>} [fields]
 * @param {{ id: string, type?: string }|null} [who]   subagente (agent_id e agent_type)
 */
function hook(hook, sessionId, fields = {}, who = null) {
  return {
    session_id: sessionId,
    transcript_path: `${FAKE_HOME}\\.claude\\projects\\exemplo\\${sessionId}.jsonl`,
    cwd: FAKE_PROJECT,
    permission_mode: 'default',
    hook_event_name: hook,
    ...(who ? { agent_id: who.id, ...(who.type !== undefined ? { agent_type: who.type } : {}) } : {}),
    ...fields,
  };
}

/** PreToolUse de uma ferramenta comum. */
const pre = (sessionId, id, who = null, tool = 'Read', input = { file_path: `${FAKE_PROJECT}\\CLAUDE.md` }) =>
  hook('PreToolUse', sessionId, { tool_name: tool, tool_input: input, tool_use_id: id }, who);
/** PostToolUse de uma ferramenta comum. */
const post = (sessionId, id, who = null, tool = 'Read', input = { file_path: `${FAKE_PROJECT}\\CLAUDE.md` }) =>
  hook('PostToolUse', sessionId, { tool_name: tool, tool_input: input, tool_use_id: id, tool_response: { stdout: 'SAIDA-REAL-9A' }, duration_ms: 5 }, who);

/** Envelope v1 (modelo de eventos, seção 1). */
function envelope(payload, { projectDir = FAKE_PROJECT, sentAt = Date.now(), entrypoint = null } = {}) {
  return { v: 1, sentAt, forwarder: 'teste-9a', env: { projectDir, entrypoint }, truncated: false, payload };
}

/** POST /hooks como o encaminhador (token, JSON, sem Origin). */
function postHook(port, token, body, { agent = false, headers = {} } = {}) {
  return request(port, {
    method: 'POST',
    path: '/hooks',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': token, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    agent,
  });
}

/** GET de uma rota JSON. */
async function getJson(port, urlPath) {
  const res = await request(port, { path: urlPath });
  assert.equal(res.status, 200, `${urlPath}: ${res.text}`);
  return JSON.parse(res.text);
}

/** Nenhum cabeçalho de CORS. */
function assertNoCors(headers, label) {
  assert.deepEqual(Object.keys(headers).filter((name) => name.startsWith('access-control-')), [], `${label}: CORS`);
}

/** Cabeçalhos de segurança do ADR 0006. */
function assertAdrHeaders(headers, label) {
  for (const [name, value] of Object.entries(ADR_HEADERS)) assert.equal(headers[name], value, `${label}: ${name}`);
}

// ---------------------------------------------------------------------------
// Cliente SSE de teste
// ---------------------------------------------------------------------------

const openClients = new Set();
/** Pedidos a /events ainda sem resposta. */
const pendingRequests = new Set();

/**
 * Cliente SSE: guarda cada mensagem (`event`, `id`, `data` já em JSON, hora de
 * chegada), os pings, a linha `retry:` e o texto cru recebido.
 * @param {number} port
 * @param {{ headers?: Record<string,string>, onMessage?: (message: any) => void }} [options]
 */
function openSse(port, { headers = {}, onMessage } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false, headers }, (res) => {
      clearTimeout(noResponse);
      pendingRequests.delete(req);
      const waiters = new Set();
      const notify = () => {
        for (const check of [...waiters]) check();
      };
      let buffer = '';
      const client = {
        status: res.statusCode,
        headers: res.headers,
        raw: '',
        messages: [],
        pings: 0,
        retry: null,
        ended: false,
        closed: null,
        close() {
          req.destroy();
        },
        /** Espera a conexão fechar, com prazo (detecta travamento). */
        closedWithin(ms = 20_000) {
          return guard(client.closed, ms, 'a conexão SSE fechar');
        },
        /** Mensagens que mudam estado (update e session-removed). */
        numbered() {
          return client.messages.filter((m) => m.event === 'update' || m.event === 'session-removed');
        },
        lastSeq() {
          const last = client.messages.findLast((m) => m.data && typeof m.data.seq === 'number');
          return last ? last.data.seq : null;
        },
        /** Espera a primeira mensagem (a partir de `from`) que satisfaz `predicate`. O prazo só detecta travamento. */
        waitFor(predicate, { timeoutMs = 20_000, label = 'mensagem SSE', from = 0 } = {}) {
          return new Promise((done, fail) => {
            let next = from;
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
                fail(new Error(`${label}: a conexão fechou antes (${client.messages.length} mensagens)`));
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
        client.raw += chunk;
        if (res.statusCode !== 200) return;
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const message = { at: Date.now() };
          let comment = false;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) {
              comment = true;
              continue;
            }
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            message[field] = message[field] === undefined ? value : `${message[field]}\n${value}`;
          }
          if (message.event === undefined) {
            if (message.retry !== undefined) client.retry = Number(message.retry);
            else if (comment) client.pings++;
            continue;
          }
          if (message.data !== undefined) message.data = JSON.parse(message.data);
          client.messages.push(message);
          onMessage?.(message);
        }
        notify();
      });
      openClients.add(client);
      resolve(client);
    });
    // Sem os cabeçalhos da resposta em 20 s, desiste: um servidor travado não segura o teste.
    const noResponse = setTimeout(() => req.destroy(new Error('GET /events sem resposta em 20 s (travou)')), 20_000);
    noResponse.unref();
    pendingRequests.add(req);
    req.on('error', (err) => {
      clearTimeout(noResponse);
      pendingRequests.delete(req);
      reject(err);
    });
  });
}

/** Abre e espera o snapshot. */
async function connected(port, options) {
  const client = await openSse(port, options);
  assert.equal(client.status, 200, client.raw);
  await client.waitFor((m) => m.event === 'snapshot', { label: 'snapshot na conexão' });
  return client;
}

/**
 * Cliente que reconecta sozinho, como o EventSource: depois de cair, tenta de
 * novo a cada `retryMs`, mandando o `Last-Event-ID` do último id recebido.
 */
function reconnectingSse(port, { retryMs = 100 } = {}) {
  const rc = { messages: [], sentLastEventIds: [], connections: 0, disconnects: 0, stopped: false, current: null };
  const waiters = new Set();
  let lastId = null;
  const notify = () => {
    for (const check of [...waiters]) check();
  };
  const retry = () => {
    if (!rc.stopped) setTimeout(connect, retryMs).unref();
  };
  function connect() {
    if (rc.stopped) return;
    const headers = lastId ? { 'Last-Event-ID': lastId } : {};
    openSse(port, {
      headers,
      onMessage(message) {
        rc.messages.push(message);
        if (message.id) lastId = message.id;
        notify();
      },
    }).then(
      (client) => {
        if (rc.stopped || client.status !== 200) {
          client.close();
          retry();
          return;
        }
        rc.sentLastEventIds.push(headers['Last-Event-ID'] ?? null);
        rc.connections++;
        rc.current = client;
        client.closed.then(() => {
          rc.disconnects++;
          notify();
          retry();
        });
      },
      () => retry(),
    );
  }
  rc.waitFor = (predicate, { timeoutMs = 10_000, label = 'mensagem', from = 0 } = {}) =>
    new Promise((done, fail) => {
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(check);
      };
      const check = () => {
        const found = rc.messages.slice(from).find(predicate);
        if (found) {
          cleanup();
          done(found);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        fail(new Error(`${label}: não chegou em ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      waiters.add(check);
      check();
    });
  rc.waitDisconnects = (n, timeoutMs = 10_000) => waitFor(() => rc.disconnects >= n, { timeoutMs, label: 'queda da conexão' });
  const forget = onCleanup(() => rc.stop());
  rc.stop = () => {
    rc.stopped = true;
    rc.current?.close();
    forget();
  };
  connect();
  return rc;
}

// ---------------------------------------------------------------------------
// O painel em miniatura: snapshot + updates (modelo de eventos, seção 9)
// ---------------------------------------------------------------------------

const FEED_SET = new Set(FEED_KINDS);
const isFeed = (event) => FEED_SET.has(event.kind) && (event.kind !== 'quest.phase' || event.data.state === 'done');

/**
 * Monta o estado a partir do último snapshot e das mensagens seguintes, como o
 * store do painel, conferindo a numeração: cada update e session-removed tem o
 * seq anterior + 1; o id da mensagem é runId:seq; o seq e o id do evento são
 * os do update; update sem feed.
 * @returns {{ seq: number, sessions: Map<string, any>, runId: string }}
 */
function replay(messages, label = 'cliente') {
  const at = messages.findLastIndex((m) => m.event === 'snapshot');
  assert.ok(at >= 0, `${label}: sem snapshot`);
  const hello = messages.slice(0, at).findLast((m) => m.event === 'hello');
  assert.ok(hello, `${label}: sem hello antes do snapshot`);
  const { runId } = hello.data;
  const snapshot = messages[at];
  assert.equal(hello.data.seq, snapshot.data.seq, `${label}: seq do hello = seq do snapshot`);
  assert.equal(snapshot.id, `${runId}:${snapshot.data.seq}`, `${label}: id do snapshot`);
  const sessions = new Map(snapshot.data.sessions.map((s) => [s.id, structuredClone(s)]));
  let seq = snapshot.data.seq;
  for (const m of messages.slice(at + 1)) {
    if (m.event !== 'update' && m.event !== 'session-removed') continue;
    assert.equal(m.data.seq, seq + 1, `${label}: seq contínuo depois de ${seq} (${m.event})`);
    assert.equal(m.id, `${runId}:${m.data.seq}`, `${label}: id da mensagem`);
    seq = m.data.seq;
    if (m.event === 'session-removed') {
      sessions.delete(m.data.sessionId);
      continue;
    }
    const { event, session } = m.data;
    assert.ok(!('feed' in session), `${label}: update sem feed`);
    if (event) {
      assert.equal(event.seq, m.data.seq, `${label}: seq do evento = seq do update`);
      assert.equal(event.id, m.id, `${label}: id do evento = id do update`);
      assert.equal(event.sessionId, session.id, `${label}: o evento é da sessão do update`);
    }
    const feed = sessions.get(session.id)?.feed ?? [];
    if (event && isFeed(event)) {
      feed.push(event);
      if (feed.length > 200) feed.splice(0, feed.length - 200);
    }
    sessions.set(session.id, { ...session, feed });
  }
  return { seq, sessions, runId };
}

/** Espera o cliente receber tudo até o seq do estado (outro socket, pode chegar depois). */
function caughtUp(client, state) {
  return waitFor(() => (client.lastSeq() ?? -1) >= state.seq, { timeoutMs: 30_000, label: `cliente até o seq ${state.seq}` });
}

/** O que o cliente montou é exatamente o /api/state. */
function assertSameAsState(replayed, state, label = 'cliente') {
  assert.equal(replayed.seq, state.seq, `${label}: seq final`);
  const byId = (list) => Object.fromEntries([...list].map((s) => [s.id, s]));
  assert.deepEqual(byId(replayed.sessions.values()), byId(state.sessions), `${label}: sessões montadas = /api/state`);
}

/** Espera o /api/state parar de mudar (fila processada). */
async function settledState(port, { quietMs = 150, timeoutMs = 10_000 } = {}) {
  let last = await getJson(port, '/api/state');
  let since = Date.now();
  const limit = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 30));
    const current = await getJson(port, '/api/state');
    if (current.seq !== last.seq) {
      last = current;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return current;
    }
    if (Date.now() > limit) throw new Error('o /api/state não estabilizou');
  }
}

/** Temporizadores falsos do tick (pipeline.timers): o teste dispara. */
function fakeIntervals() {
  const active = new Set();
  const cleared = [];
  return {
    timers: {
      setInterval(run, ms) {
        const handle = { run, ms, unref() { return this; } };
        active.add(handle);
        return handle;
      },
      clearInterval(handle) {
        active.delete(handle);
        cleared.push(handle);
      },
    },
    fire() {
      for (const handle of active) handle.run();
    },
    active: () => [...active],
    cleared,
  };
}

/** Leitor falso de .claude/agents/ (interface `read(projectDir) → Promise<string[]>`). */
const fixedReader = (names) => ({ read: async () => [...names] });

/**
 * startServer no mesmo processo, com AGENT_QUEST_HOME e pasta pessoal temporários.
 * @param {import('node:test').TestContext} t
 */
async function startLocal(t, { pipeline = {}, reader = fixedReader([]) } = {}) {
  const data = tempDir('aq-int-9a-local-');
  const home = tempDir('aq-int-9a-home-');
  const removeDirs = () => {
    for (const dir of [data, home]) {
      try {
        dir.cleanup();
      } catch {
        // pasta temporária do sistema; não vale travar nem derrubar o arquivo por ela
      }
    }
  };
  const forgetDirs = onCleanup(removeDirs);
  const logs = [];
  const server = await guard(
    startServer({
      argv: ['--port', '0'],
      env: { AGENT_QUEST_HOME: data.dir },
      homedir: home.dir,
      logError: (message) => logs.push(message),
      // reader: null usa o leitor de disco da ligação (com onLate), ajustável por pipeline.readerOptions.
      pipeline: { ...(reader ? { reader } : {}), ...pipeline },
    }),
    START_GUARD_MS,
    'startServer',
  );
  assert.equal(server.status, 'started');
  let done = false;
  const shutdown = async () => {
    if (done) return;
    done = true;
    try {
      await guard(server.close(), CLEANUP_GUARD_MS, 'close() do servidor');
    } catch {
      // close() travou: derruba as conexões e solta o servidor, para o arquivo terminar.
      server.pipeline.stop();
      server.server.closeAllConnections();
      server.server.unref();
    }
    removeDirs();
  };
  const forget = onCleanup(shutdown);
  forgetDirs();
  t.after(async () => {
    forget();
    await shutdown();
  });
  const { port } = server;
  const { token } = server.runtime;
  return {
    server,
    port,
    token,
    logs,
    send: (payload, options) => postHook(port, token, envelope(payload, options)),
    state: () => getJson(port, '/api/state'),
    health: () => getJson(port, '/api/health'),
  };
}

// Limpeza final do arquivo: roda depois de todos os testes, também quando algum falhou ou estourou o prazo.
after(async () => {
  for (const req of [...pendingRequests]) req.destroy();
  for (const client of [...openClients]) client.close();
  await runCleanups();
}, TEST);

// ===========================================================================
// 1. Servidor real (outro processo) e HTTP real
// ===========================================================================

describe('T9a ligação: servidor real (node server/main.js --port 0) e HTTP real', () => {
  let data;
  let home;
  let run;
  let port;
  let token;

  before(async () => {
    data = tempDir('aq-int-9a-spec-');
    home = tempDir('aq-int-9a-spec-home-');
    run = launchTracked(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: data.dir, USERPROFILE: home.dir, HOME: home.dir }));
    assert.equal(await run.started, true, run.output());
    const runtime = await waitFor(() => readJson(path.join(data.dir, 'runtime.json')), { label: 'runtime.json', timeoutMs: START_GUARD_MS });
    ({ port, token } = runtime);
  }, TEST);

  after(async () => {
    for (const client of [...openClients]) client.close();
    if (run) await stopProcess(run).catch(() => {});
    for (const dir of [data, home]) {
      try {
        dir?.cleanup();
      } catch {
        // pasta temporária; não trava o arquivo
      }
    }
  }, TEST);

  it('toda conexão recebe hello e snapshot, com e sem Last-Event-ID; snapshot = /api/state; no-store', TEST, async () => {
    const S = sid(101);
    for (const payload of [hook('SessionStart', S, { source: 'startup', model: 'claude-opus-5-5' }), pre(S, tid('A1')), post(S, tid('A1'))]) {
      assert.equal((await postHook(port, token, envelope(payload))).status, 204);
    }
    const state = await settledState(port);
    assert.ok(state.seq >= 3, `seq ${state.seq}`);
    const runId = state.sessions.find((s) => s.id === S).feed[0].id.split(':')[0];
    const variants = [
      {},
      { 'Last-Event-ID': `${runId}:${state.seq}` },
      { 'Last-Event-ID': `${runId}:1` },
      { 'Last-Event-ID': `${runId}:${state.seq + 1000}` },
      { 'Last-Event-ID': 'outraExecucao:5' },
      { 'Last-Event-ID': 'lixo sem formato' },
      { 'Last-Event-ID': '' },
    ];
    for (const headers of variants) {
      const label = JSON.stringify(headers);
      const client = await connected(port, { headers });
      assert.match(client.headers['content-type'], /^text\/event-stream/, label);
      assert.equal(client.headers['cache-control'], 'no-store', label);
      assertAdrHeaders(client.headers, label);
      assertNoCors(client.headers, label);
      assert.equal(client.retry, 2000, label);
      assert.deepEqual(client.messages.slice(0, 2).map((m) => m.event), ['hello', 'snapshot'], label);
      const [hello, snapshot] = client.messages;
      assert.equal(hello.id, undefined, `${label}: hello sem id`);
      assert.deepEqual(hello.data, { protocol: 1, runId, seq: state.seq, serverVersion: VERSION }, label);
      assert.equal(snapshot.id, `${runId}:${state.seq}`, label);
      assert.deepEqual(snapshot.data, state, `${label}: snapshot = /api/state`);
      client.close();
    }
  });

  it('seq contínuo misturando update com evento e sem evento; o cliente monta exatamente o /api/state; health com sessions e clients reais', TEST, async () => {
    const client = await connected(port);
    const S = sid(102);
    const W = { id: aid(102), type: 'tester' };
    const sequence = [
      hook('Notification', S, { message: 'MENSAGEM-9A', notification_type: 'idle_prompt' }), // sessão sob demanda: update sem evento
      hook('UserPromptSubmit', S, { prompt: 'Pedido de teste' }), // main trabalhando: update sem evento
      pre(S, tid('B1')),
      hook('SubagentStart', S, {}, W),
      pre(S, tid('B2'), W, 'Bash', { command: 'npm test', description: 'Rodar' }),
      hook('PostToolUseFailure', S, { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: tid('B2'), error: 'Exit code 1' }, W),
      hook('SubagentStop', S, { last_assistant_message: 'RESPOSTA-9A' }, W),
      post(S, tid('B1')),
      hook('Stop', S, { last_assistant_message: 'RESPOSTA-9A', background_tasks: [] }), // main ocioso: update sem evento
    ];
    for (const payload of sequence) assert.equal((await postHook(port, token, envelope(payload))).status, 204);
    await client.waitFor((m) => m.event === 'update' && m.data.session.id === S && m.data.session.agents[0].status === 'idle' && m.data.session.agents.length === 2 && m.data.session.agents[1].finished);
    const state = await settledState(port);
    const mine = client.numbered().filter((m) => m.data.session?.id === S);
    const kinds = mine.map((m) => m.data.event?.kind ?? null);
    assert.equal(kinds[0], null, 'sessão criada sob demanda chega por update sem evento');
    assert.deepEqual(kinds.filter(Boolean), ['tool.started', 'agent.started', 'tool.started', 'tool.failed', 'agent.finished', 'tool.finished']);
    assert.ok(kinds.filter((k) => k === null).length >= 3, `updates sem evento: ${kinds}`);
    await caughtUp(client, state);
    assertSameAsState(replay(client.messages), state);
    const health = await getJson(port, '/api/health');
    assert.equal(health.sessions, state.sessions.length);
    assert.equal(health.clients, 1);
    assert.equal(health.events.received, health.events.accepted + health.events.deduped + health.events.rejected);
    client.close();
    await client.closedWithin();
    await waitFor(async () => (await getJson(port, '/api/health')).clients === 0, { label: 'clients volta a 0' });
  });

  it('o nono cliente recebe 503 com a ligação ativa; os oito recebem o mesmo update; quem sai libera a vaga', TEST, async () => {
    const clients = [];
    for (let i = 0; i < 8; i++) clients.push(await connected(port));
    assert.equal((await getJson(port, '/api/health')).clients, 8);
    const ninth = await openSse(port);
    assert.equal(ninth.status, 503);
    assert.equal(ninth.headers['cache-control'], 'no-store');
    assertAdrHeaders(ninth.headers, '503');
    await ninth.closedWithin();
    assert.equal((await getJson(port, '/api/health')).clients, 8, 'o 503 não entra na contagem');
    const S = sid(103);
    assert.equal((await postHook(port, token, envelope(pre(S, tid('C1'))))).status, 204);
    const got = await Promise.all(clients.map((c) => c.waitFor((m) => m.data?.event?.data?.toolUseId === tid('C1'))));
    assert.equal(new Set(got.map((m) => `${m.id}|${JSON.stringify(m.data)}`)).size, 1, 'os oito recebem a mesma mensagem');
    clients[0].close();
    await clients[0].closedWithin();
    await waitFor(async () => (await getJson(port, '/api/health')).clients === 7, { label: 'vaga liberada' });
    const again = await connected(port);
    assert.equal((await getJson(port, '/api/health')).clients, 8);
    for (const c of [...clients.slice(1), again]) c.close();
    await waitFor(async () => (await getJson(port, '/api/health')).clients === 0, { label: 'todos saíram' });
  });

  it('Host, Origin e Sec-Fetch-Site inválidos: 403 em /events e /api/state, no-store, sem estado no corpo e sem entrar na contagem', TEST, async () => {
    const S = sid(104);
    assert.equal((await postHook(port, token, envelope(pre(S, tid('D1'))))).status, 204);
    await settledState(port);
    const bad = [
      { Host: `evil.example:${port}` },
      { Host: `127.0.0.1:${port + 1}` },
      { Host: `127.0.0.1.nip.io:${port}` },
      { Origin: 'http://evil.example' },
      { Origin: `http://localhost:${port}` }, // Host 127.0.0.1: outra origem
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const urlPath of ['/events', '/api/state']) {
      for (const headers of bad) {
        const label = `${urlPath} ${JSON.stringify(headers)}`;
        const res = await request(port, { path: urlPath, headers });
        assert.equal(res.status, 403, label);
        assert.equal(res.headers['cache-control'], 'no-store', label);
        assertAdrHeaders(res.headers, label);
        assertNoCors(res.headers, label);
        assert.ok(!res.text.includes(S), `${label}: nada do estado`);
      }
      const options = await request(port, { method: 'OPTIONS', path: urlPath, headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' } });
      assert.equal(options.status, 405, `${urlPath} OPTIONS`);
      assertNoCors(options.headers, `${urlPath} OPTIONS`);
    }
    assert.equal((await getJson(port, '/api/health')).clients, 0);
    // As formas aceitas continuam valendo.
    const viaLocalhost = await connected(port, { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    viaLocalhost.close();
    const state = await request(port, { path: '/api/state', headers: { Host: `localhost:${port}`, 'Sec-Fetch-Site': 'none' } });
    assert.equal(state.status, 200);
    assert.equal(state.headers['cache-control'], 'no-store');
    assertAdrHeaders(state.headers, '/api/state');
  });

  it('segurança da ingestão continua: sem token, token errado, Origin e outro Content-Type são recusados e não mudam o estado', TEST, async () => {
    const before = await settledState(port);
    const S = sid(105);
    const body = envelope(pre(S, tid('E1')));
    const cases = [
      [{ 'X-Agent-Quest-Token': '' }, 401],
      [{ 'X-Agent-Quest-Token': `${token}x` }, 401],
      [{ 'X-Agent-Quest-Token': token.toUpperCase() === token ? `${token}y` : token.toUpperCase() }, 401],
      [{ Origin: `http://127.0.0.1:${port}` }, 403],
      [{ 'Content-Type': 'text/plain' }, 415],
    ];
    for (const [headers, status] of cases) {
      const res = await postHook(port, token, body, { headers });
      assert.equal(res.status, status, JSON.stringify(headers));
      assertNoCors(res.headers, JSON.stringify(headers));
    }
    const noToken = await request(port, { method: 'POST', path: '/hooks', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(noToken.status, 401);
    const after = await settledState(port);
    assert.equal(after.seq, before.seq, 'nenhuma recusa gera mensagem');
    assert.ok(!after.sessions.some((s) => s.id === S));
  });

  it('a ligação passa a pasta pessoal (os.homedir()) ao estado: /c/Users/… (Git Bash) e C:\\Users\\… caem no mesmo project.key', TEST, async () => {
    // Um projectDir no formato MSYS não tem letra de unidade; só vira c:/… pelo contexto da pasta pessoal
    // (seção 2, "Formas de caminho"; seção 7). Sem o homeDir na ligação, as duas sessões ficariam em projetos diferentes.
    const windowsForm = 'C:\\Users\\fulana\\Projetos\\juncao-9a';
    const msysForm = '/c/Users/fulana/Projetos/juncao-9a';
    const [A, B] = [sid(106), sid(107)];
    assert.equal((await postHook(port, token, envelope(pre(A, tid('J1')), { projectDir: windowsForm }))).status, 204);
    assert.equal((await postHook(port, token, envelope(pre(B, tid('J2')), { projectDir: msysForm }))).status, 204);
    await waitFor(async () => {
      const state = await getJson(port, '/api/state');
      return state.sessions.some((s) => s.id === A) && state.sessions.some((s) => s.id === B);
    }, { label: 'as duas sessões', timeoutMs: 20_000 });
    const state = await getJson(port, '/api/state');
    const [pa, pb] = [A, B].map((id) => state.sessions.find((s) => s.id === id).project);
    assert.equal(pa.key, 'c:/Users/fulana/Projetos/juncao-9a');
    assert.equal(pb.key, pa.key, 'o caminho MSYS cai no mesmo projeto');
    assert.equal(pb.name, 'juncao-9a');
    assert.equal(pb.dir, msysForm, 'dir fica como veio');
  });

  it('escuta só em 127.0.0.1: ::1 e os endereços não internos da máquina recusam a conexão', TEST, async (t) => {
    const refused = (host) =>
      new Promise((resolve) => {
        const socket = net.connect({ host, port });
        socket.setTimeout(2000, () => {
          socket.destroy();
          resolve('timeout');
        });
        socket.on('connect', () => {
          socket.destroy();
          resolve('conectou');
        });
        socket.on('error', (err) => resolve(err.code ?? 'erro'));
      });
    assert.notEqual(await refused('::1'), 'conectou', '::1');
    const external = Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item && !item.internal && item.family === 'IPv4')
      .map((item) => item.address);
    if (external.length === 0) t.diagnostic('sem endereço IPv4 externo nesta máquina; só o ::1 foi conferido');
    for (const address of external) assert.notEqual(await refused(address), 'conectou', address);
    // E pelo loopback funciona.
    assert.equal((await request(port, { path: '/api/health' })).status, 200);
  });
});

// ===========================================================================
// 2. Primeira luz: servidor real, encaminhador real, sessão realista
// ===========================================================================

describe('Primeira luz: node server/main.js + encaminhador real (processo filho), sessão com delegação', () => {
  let data;
  let home;
  let projectRoot;
  let projectDir;
  let port;
  let run;
  let runtime;
  let sse;
  let env;
  const SID = '7f3c2a10-5b6d-4e8f-9a01-23456789abcd';
  const PROMPT_ID = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const TESTER = { id: 'a0f1e2d3c4b5a6978', type: 'tester' };
  const T_AGENT = 'toolu_01PrimeiraLuzAgente9A';
  const T_READ = 'toolu_01PrimeiraLuzLeitura9A';
  const T_BASH = 'toolu_01PrimeiraLuzBash9A';
  let retries = 0;

  /** Identifica um payload no dump: sessão, hook, chamada e agente. */
  const keyOf = (p) => [p.session_id, p.hook_event_name, p.tool_use_id ?? '', p.agent_id ?? ''].join('|');

  /**
   * Payloads aceitos pelo servidor, lidos do --debug-dump (só linhas completas).
   * O dump grava o envelope logo depois do 204, sem as duplicatas.
   */
  function dumpedKeys() {
    const dir = path.join(data.dir, 'dumps');
    const keys = new Set();
    if (!existsSync(dir)) return keys;
    for (const file of readdirSync(dir)) {
      for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n').slice(0, -1)) {
        try {
          keys.add(keyOf(JSON.parse(line).payload));
        } catch {
          // linha que ainda está sendo gravada
        }
      }
    }
    return keys;
  }

  /**
   * Entrega pelo encaminhador real (um processo por payload, todos ao mesmo
   * tempo, como os hooks async), com a regra de carga dos testes da captura
   * (capture-helpers.js, "entrega sob carga"):
   * - saída 0 e silêncio sempre;
   * - payload que não chegou é reenviado (até 3 tentativas); uma cópia que
   *   tenha chegado tarde cai na deduplicação, e uma repetição tardia não muda
   *   o estado (Pre repetido, Post de chamada fechada, SubagentStart de agente
   *   conhecido e Stop não geram evento);
   * - perder só vale se o encaminhador esperou um prazo do ADR 0001 e a
   *   máquina estava sobrecarregada (medida durante os envios): aí o teste é
   *   pulado com as medidas. Com a máquina normal, é falha.
   * @returns {Promise<Map<string, [number, number]>|null>} janela [início, fim] dos processos de cada payload; null se pulou
   */
  async function deliver(t, payloads, label, { attempts = 3, waitMs = 5000 } = {}) {
    const windows = new Map();
    const samples = [];
    const misses = [];
    let pending = [...payloads];
    for (let n = 0; n < attempts && pending.length > 0; n++) {
      if (n > 0) retries++;
      const batch = pending;
      const { value: results, samples: during } = await withLoadSamples(() =>
        Promise.all(batch.map((payload) => runForwarder({ env, stdin: JSON.stringify(payload) }))),
      );
      samples.push(...during);
      results.forEach((result, i) => {
        assertSilentExit(result, `${label} [${i}]`);
        const key = keyOf(batch[i]);
        const w = windows.get(key);
        windows.set(key, w ? [Math.min(w[0], result.beginEpoch), Math.max(w[1], result.endEpoch)] : [result.beginEpoch, result.endEpoch]);
      });
      await waitFor(() => batch.every((p) => dumpedKeys().has(keyOf(p))), { timeoutMs: waitMs, label }).catch(() => null);
      const arrived = dumpedKeys();
      const lost = batch.map((payload, i) => ({ payload, result: results[i] })).filter(({ payload }) => !arrived.has(keyOf(payload)));
      for (const { result } of lost) {
        assert.ok(hitDeadline(result), `${label}: o encaminhador saiu em ${result.ownMs.toFixed(0)} ms sem entregar, sem ter esperado nenhum prazo do ADR 0001`);
      }
      misses.push(...lost.map(({ result }) => `${result.ownMs.toFixed(0)} ms de vida`));
      pending = lost.map(({ payload }) => payload);
    }
    if (pending.length === 0) {
      if (misses.length > 0) t.diagnostic(`${label}: entregue depois de ${misses.length} perda(s) por prazo: ${misses.join('; ')}`);
      return windows;
    }
    const load = loadFrom(samples);
    assert.ok(!load.normal, `${label}: ${pending.length} evento(s) perdido(s) com a máquina normal (${load.text}): ${misses.join('; ')}`);
    t.skip(`entrega não avaliada: máquina sobrecarregada (${load.text}); ${label}: perdas por prazo do ADR 0001 em ${misses.join('; ')}`);
    return null;
  }

  before(async () => {
    data = tempDir('aq-int-9a-luz-');
    home = tempDir('aq-int-9a-luz-home-');
    projectRoot = tempDir('aq-int-9a-luz-proj-');
    projectDir = path.join(projectRoot.dir, 'projeto-ficticio');
    const agentsDir = path.join(projectDir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    for (const name of ['arquiteto', 'dev-backend', 'dev-frontend', 'tester', 'documentador']) {
      writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nFictício.\n`);
    }
    writeFileSync(path.join(agentsDir, 'LEIA-ME.txt'), 'não é agente');
    port = await fixedPort();
    // --debug-dump só como instrumento do teste: diz quais payloads o servidor aceitou (regra de carga).
    run = launchTracked(['--port', String(port), '--debug-dump'], minimalEnv({ AGENT_QUEST_HOME: data.dir, USERPROFILE: home.dir, HOME: home.dir }));
    assert.equal(await run.started, true, run.output());
    runtime = await waitFor(() => readJson(path.join(data.dir, 'runtime.json')), { label: 'runtime.json', timeoutMs: START_GUARD_MS });
    assert.equal(runtime.port, port);
    env = forwarderEnv({ AGENT_QUEST_HOME: data.dir, CLAUDE_PROJECT_DIR: projectDir });
    sse = await connected(port);
  }, TEST);

  after(async () => {
    for (const client of [...openClients]) client.close();
    if (run) await stopProcess(run).catch(() => {});
    for (const dir of [data, home, projectRoot]) {
      try {
        dir?.cleanup();
      } catch {
        // pasta temporária; não trava o arquivo
      }
    }
  }, TEST);

  const common = (hookName, fields = {}, who = null) => ({
    session_id: SID,
    transcript_path: `C:\\Users\\usuario\\.claude\\projects\\exemplo\\${SID}.jsonl`,
    cwd: projectDir,
    permission_mode: 'default',
    hook_event_name: hookName,
    ...(who ? { agent_id: who.id, agent_type: who.type } : {}),
    ...fields,
  });

  it('a sequência realista de hooks, pelo encaminhador real, chega ao SessionState esperado da seção 9', LONG_TEST, async (t) => {
    const agentInput = { description: 'Rodar a suíte', prompt: 'PROMPT-DO-AGENTE-9A', subagent_type: 'tester' };
    const readInput = { file_path: path.join(projectDir, 'CLAUDE.md') };
    const bashInput = { command: 'npm test', description: 'Rodar os testes' };
    const steps = [
      ['SessionStart', common('SessionStart', { source: 'startup', model: 'claude-opus-5-5' })],
      ['UserPromptSubmit', common('UserPromptSubmit', { prompt: 'Peça ao tester para rodar a suíte\nDETALHE-DO-PEDIDO-9A', prompt_id: PROMPT_ID })],
      ['PreToolUse Agent', common('PreToolUse', { tool_name: 'Agent', tool_input: agentInput, tool_use_id: T_AGENT, prompt_id: PROMPT_ID })],
      ['SubagentStart', common('SubagentStart', {}, TESTER)],
      ['PreToolUse Read', common('PreToolUse', { tool_name: 'Read', tool_input: readInput, tool_use_id: T_READ }, TESTER)],
      ['PostToolUse Read', common('PostToolUse', { tool_name: 'Read', tool_input: readInput, tool_response: { type: 'text', file: { filePath: readInput.file_path, content: 'CONTEUDO-DO-ARQUIVO-9A' } }, tool_use_id: T_READ, duration_ms: 12 }, TESTER)],
      ['PreToolUse Bash', common('PreToolUse', { tool_name: 'Bash', tool_input: bashInput, tool_use_id: T_BASH }, TESTER)],
      ['PostToolUseFailure Bash', common('PostToolUseFailure', { tool_name: 'Bash', tool_input: bashInput, tool_use_id: T_BASH, error: 'Exit code 1\nSAIDA-DO-ERRO-9A', is_interrupt: false, duration_ms: 900 }, TESTER)],
      ['SubagentStop', common('SubagentStop', { stop_hook_active: false, agent_transcript_path: `C:\\Users\\usuario\\.claude\\projects\\exemplo\\${SID}\\subagents\\agent-${TESTER.id}.jsonl`, last_assistant_message: 'RESPOSTA-DO-SUBAGENTE-9A', background_tasks: [] }, TESTER)],
      ['PostToolUse Agent', common('PostToolUse', { tool_name: 'Agent', tool_input: agentInput, tool_response: { status: 'completed', agentId: TESTER.id, content: [{ type: 'text', text: 'RESULTADO-DO-AGENTE-9A' }], totalToolUseCount: 2 }, tool_use_id: T_AGENT, duration_ms: 3000, prompt_id: PROMPT_ID })],
      ['Stop', common('Stop', { stop_hook_active: false, last_assistant_message: 'RESPOSTA-FINAL-9A', background_tasks: [] })],
    ];
    const retriesBefore = retries;
    const window = {};
    for (const [label, payload] of steps) {
      const delivered = await deliver(t, [payload], label);
      if (!delivered) return; // pulado pela regra de carga, com as medidas
      window[label] = delivered.get(keyOf(payload));
    }
    const within = (value, label) => assert.ok(value >= window[label][0] && value <= window[label][1], `${label}: ts ${value} fora de ${window[label]}`);

    // Fila processada e roster lido: o main fica ocioso depois do Stop e o roster ganha os papéis de .claude/agents/.
    await waitFor(async () => {
      const state = await getJson(port, '/api/state');
      const session = state.sessions.find((s) => s.id === SID);
      return session && session.agents[0].status === 'idle' && session.roster.length === 5;
    }, { label: 'estado final da sessão', timeoutMs: 30_000 });
    const state = await settledState(port);
    const health = await getJson(port, '/api/health');
    if (retries === retriesBefore) {
      assert.deepEqual(health.events, { received: 11, accepted: 11, rejected: 0, deduped: 0, dropped: 0, ignored: 0 });
    } else {
      // Houve reenvio: a cópia que chegou tarde é duplicata (ou, depois de 5 s, um aceito a mais que não muda o estado).
      t.diagnostic(`reenvios pela regra de carga: ${retries - retriesBefore}; contadores ${JSON.stringify(health.events)}`);
      assert.ok(health.events.accepted >= 11);
      assert.equal(health.events.received, health.events.accepted + health.events.deduped);
      assert.deepEqual([health.events.rejected, health.events.dropped, health.events.ignored], [0, 0, 0]);
    }
    assert.equal(health.sessions, 1);
    assert.equal(health.clients, 1);

    // O que chegou pelo SSE: um update por evento canônico, na ordem, e os sem evento.
    await caughtUp(sse, state);
    const updates = sse.numbered();
    const events = updates.map((m) => m.data.event).filter(Boolean);
    assert.deepEqual(events.map((e) => [e.kind, e.agentKey]), [
      ['session.started', null],
      ['agent.delegated', 'main'],
      ['agent.started', TESTER.id],
      ['tool.started', TESTER.id],
      ['tool.finished', TESTER.id],
      ['tool.started', TESTER.id],
      ['tool.failed', TESTER.id],
      ['agent.finished', TESTER.id],
    ]);
    const byKind = (kind, n = 0) => events.filter((e) => e.kind === kind)[n];
    const projectName = path.basename(projectDir);
    assert.deepEqual(byKind('session.started').data, { source: 'startup', projectName });
    assert.deepEqual(byKind('agent.delegated').data, { toolUseId: T_AGENT, toType: 'tester', toRole: 'tes', description: 'Rodar a suíte', background: false });
    assert.deepEqual(byKind('agent.started').data, { agentType: 'tester', role: 'tes', label: 'Rodar a suíte', parentKey: 'main' });
    assert.deepEqual(byKind('tool.started', 0).data, { toolUseId: T_READ, tool: 'Read', category: 'read', target: 'CLAUDE.md', detail: null });
    assert.deepEqual(byKind('tool.finished').data, { toolUseId: T_READ, tool: 'Read', category: 'read', durationMs: 12 });
    assert.deepEqual(byKind('tool.started', 1).data, { toolUseId: T_BASH, tool: 'Bash', category: 'bash', target: 'npm test', detail: 'Rodar os testes' });
    assert.deepEqual(byKind('tool.failed').data, { toolUseId: T_BASH, tool: 'Bash', category: 'bash', target: 'npm test', error: 'Exit code 1', interrupted: false });
    assert.deepEqual(byKind('agent.finished').data, { outcome: 'done' });
    within(byKind('session.started').ts, 'SessionStart');
    within(byKind('agent.delegated').ts, 'PreToolUse Agent');
    within(byKind('agent.started').ts, 'SubagentStart');
    within(byKind('tool.started', 1).ts, 'PreToolUse Bash');
    within(byKind('tool.failed').ts, 'PostToolUseFailure Bash');
    within(byKind('agent.finished').ts, 'SubagentStop');
    assert.ok(updates.some((m) => m.data.event === null), 'há updates sem evento (pedido, Post do Agent, Stop, roster)');
    await caughtUp(sse, state);
    assertSameAsState(replay(sse.messages), state);

    // O SessionState final contra a seção 9 (valores neutros da regra 2 do recorte).
    assert.equal(state.sessions.length, 1);
    const session = state.sessions[0];
    const expectedKey = projectDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
    const delegated = byKind('agent.delegated');
    const bash = byKind('tool.started', 1);
    const { feed, ...rest } = session;
    assert.deepEqual(rest, {
      id: SID,
      project: { key: expectedKey, name: projectName, dir: projectDir },
      label: `Sessão ${SID.slice(0, 6)}`,
      client: null,
      status: 'active',
      startedAt: byKind('session.started').ts,
      lastEventAt: rest.lastEventAt,
      agents: [
        {
          key: 'main', agentId: null, agentType: null, role: 'orq', label: '', status: 'idle', finished: false, background: false, parentKey: null,
          activity: { kind: 'delegate', category: null, tool: 'Agent', target: 'tester', detail: 'Rodar a suíte', state: 'done', at: delegated.ts },
          waitingFor: null, health: { ok: 0, total: 0 }, context: null, startedAt: byKind('session.started').ts, lastEventAt: rest.agents[0].lastEventAt,
        },
        {
          key: TESTER.id, agentId: TESTER.id, agentType: 'tester', role: 'tes', label: 'Rodar a suíte', status: 'idle', finished: true, background: false, parentKey: 'main',
          activity: { kind: 'tool', category: 'bash', tool: 'Bash', target: 'npm test', detail: 'Rodar os testes', state: 'failed', at: bash.ts },
          waitingFor: null, health: { ok: 1, total: 2 }, context: null, startedAt: byKind('agent.started').ts, lastEventAt: byKind('agent.finished').ts,
        },
      ],
      roster: ['orq', 'arq', 'dev', 'tes', 'doc'],
      quest: null,
      counters: { questsDone: 0, bugsCrushed: 0, pendingApprovals: 0 },
      bugs: { open: 0, lastRun: null },
    });
    within(rest.lastEventAt, 'Stop');
    within(rest.agents[0].lastEventAt, 'Stop');
    // Feed: só FEED_KINDS, na ordem, com os eventos numerados de antes.
    assert.deepEqual(feed.map((e) => e.kind), ['session.started', 'agent.delegated', 'tool.started', 'tool.started', 'tool.failed', 'agent.finished']);
    assert.deepEqual(feed, events.filter(isFeed));
    for (const event of feed) assert.equal(event.id, `${replay(sse.messages).runId}:${event.seq}`);
    // Minimização: nada de pedido completo, conteúdo, saída, resposta do assistente nem transcript.
    const text = JSON.stringify(state) + sse.raw;
    for (const marker of ['DETALHE-DO-PEDIDO-9A', 'PROMPT-DO-AGENTE-9A', 'CONTEUDO-DO-ARQUIVO-9A', 'SAIDA-DO-ERRO-9A', 'RESPOSTA-DO-SUBAGENTE-9A', 'RESULTADO-DO-AGENTE-9A', 'RESPOSTA-FINAL-9A', 'transcript', 'subagents']) {
      assert.ok(!text.includes(marker), `vazou ${marker}`);
    }
  });

  it('dedupe: o mesmo hook entregue por dois encaminhadores ao mesmo tempo (plugin carregado duas vezes) vira um único evento', TEST, async (t) => {
    // Regra de carga: as duas cópias precisam chegar para haver o que deduplicar. Uma cópia
    // perdida só vale se o encaminhador dela esperou um prazo do ADR 0001 e a máquina estava
    // sobrecarregada; aí tenta de novo com outro payload (até 3 vezes) e, sem sucesso, pula.
    const S2 = '7f3c2a10-5b6d-4e8f-9a01-0000000000d2';
    const samples = [];
    const misses = [];
    for (let n = 0; n < 3; n++) {
      const id = `toolu_01Duplicado9A${n}`;
      const before = (await getJson(port, '/api/health')).events;
      const stdin = JSON.stringify({ ...common('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'TODO' }, tool_use_id: id }), session_id: S2 });
      const { value: results, samples: during } = await withLoadSamples(() => Promise.all([runForwarder({ env, stdin }), runForwarder({ env, stdin })]));
      samples.push(...during);
      results.forEach((r, i) => assertSilentExit(r, `encaminhador ${i + 1}`));
      const delta = async () => {
        const now = (await getJson(port, '/api/health')).events;
        return { accepted: now.accepted - before.accepted, deduped: now.deduped - before.deduped };
      };
      const both = await waitFor(async () => {
        const d = await delta();
        return d.accepted + d.deduped >= 2 ? d : null;
      }, { timeoutMs: 5000, label: 'as duas cópias' }).catch(() => null);
      const got = both ?? (await delta());
      // Duas aceitas só se as chegadas puderam ficar a mais de 5 s uma da outra.
      const span = Math.max(...results.map((r) => r.endEpoch)) - Math.min(...results.map((r) => r.beginEpoch));
      assert.ok(got.accepted <= 1 || span > 5000, `as duas cópias foram aceitas (${JSON.stringify(got)}) com as duas vidas dentro de ${span} ms`);
      if (both && got.accepted === 1 && got.deduped === 1) {
        await sse.waitFor((m) => m.data?.event?.data?.toolUseId === id, { timeoutMs: 20_000 });
        await settledState(port);
        assert.equal(sse.messages.filter((m) => m.data?.event?.data?.toolUseId === id).length, 1, 'um único tool.started');
        if (misses.length > 0) t.diagnostic(`dedupe conferido na tentativa ${n + 1}; antes: ${misses.join('; ')}`);
        return;
      }
      const lostCount = 2 - (got.accepted + got.deduped);
      assert.ok(results.filter(hitDeadline).length >= lostCount, `cópia perdida sem prazo do ADR 0001: ${results.map((r) => `${r.ownMs.toFixed(0)} ms`).join(', ')}`);
      misses.push(`tentativa ${n + 1}: ${JSON.stringify(got)}, vidas ${results.map((r) => `${r.ownMs.toFixed(0)} ms`).join(' e ')}`);
    }
    const load = loadFrom(samples);
    assert.ok(!load.normal, `cópias perdidas com a máquina normal (${load.text}): ${misses.join('; ')}`);
    t.skip(`dedupe não avaliado: máquina sobrecarregada (${load.text}); ${misses.join('; ')}`);
  });

  it('latência: encaminhador real → servidor → cliente SSE recebe o tool.started de um subagente em menos de 500 ms', LONG_TEST, async (t) => {
    const S3 = '7f3c2a10-5b6d-4e8f-9a01-0000000000d3';
    let n = 0;
    await assertWithinLimit(
      t,
      'encaminhador → SSE (subagente)',
      async () => {
        const id = `toolu_01Latencia9A${n++}`;
        const payload = { ...common('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(projectDir, 'a.md') }, tool_use_id: id }, TESTER), session_id: S3 };
        const arrived = sse.waitFor((m) => m.data?.event?.kind === 'tool.started' && m.data.event.data.toolUseId === id, { timeoutMs: 3000 }).catch(() => null);
        const result = await runForwarder({ env, stdin: JSON.stringify(payload) });
        const message = await arrived;
        return { ...result, ownMs: message ? message.at - result.beginEpoch : Infinity };
      },
      500,
    );
  });

  it('dois subagentes do mesmo tipo em paralelo, com os encaminhadores rodando ao mesmo tempo: duas instâncias com as próprias ações e descrições, e o cliente monta o /api/state', LONG_TEST, async (t) => {
    const S4 = '7f3c2a10-5b6d-4e8f-9a01-0000000000d4';
    const A = { id: 'a1111111111111111', type: 'tester' };
    const B = { id: 'a2222222222222222', type: 'tester' };
    const at = (fields, who) => ({ ...common(fields.hook_event_name, fields, who), session_id: S4 });
    const agentCall = (id, description) => ({ tool_name: 'Agent', tool_input: { description, prompt: 'PROMPT-PARALELO-9A', subagent_type: 'tester' }, tool_use_id: id });
    let skipped = false;
    const batch = async (payloads, label) => {
      if (skipped) return;
      if (!(await deliver(t, payloads, label))) skipped = true;
    };
    await batch([at({ hook_event_name: 'UserPromptSubmit', prompt: 'Dois testes em paralelo' })], 'pedido');
    await batch([at({ hook_event_name: 'PreToolUse', ...agentCall('toolu_01ParA9A', 'Testar A') })], 'Pre Agent A');
    await batch([at({ hook_event_name: 'PreToolUse', ...agentCall('toolu_01ParB9A', 'Testar B') })], 'Pre Agent B');
    await batch([at({ hook_event_name: 'SubagentStart' }, B), at({ hook_event_name: 'SubagentStart' }, A)], 'SubagentStart');
    await batch([
      at({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(projectDir, 'a.md') }, tool_use_id: 'toolu_01ParLeA9A' }, A),
      at({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'describe' }, tool_use_id: 'toolu_01ParGrB9A' }, B),
    ], 'ferramentas');
    await batch([
      at({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(projectDir, 'a.md') }, tool_use_id: 'toolu_01ParLeA9A', tool_response: {} }, A),
      at({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'describe' }, tool_use_id: 'toolu_01ParGrB9A', tool_response: {} }, B),
    ], 'fim das ferramentas');
    await batch([at({ hook_event_name: 'SubagentStop' }, A), at({ hook_event_name: 'SubagentStop' }, B)], 'SubagentStop');
    await batch([
      at({ hook_event_name: 'PostToolUse', ...agentCall('toolu_01ParA9A', 'Testar A'), tool_response: { status: 'completed', agentId: A.id } }),
      at({ hook_event_name: 'PostToolUse', ...agentCall('toolu_01ParB9A', 'Testar B'), tool_response: { status: 'completed', agentId: B.id } }),
    ], 'Post Agent');
    await batch([at({ hook_event_name: 'Stop', background_tasks: [] })], 'Stop');
    if (skipped) return; // pulado pela regra de carga, com as medidas
    await waitFor(async () => (await getJson(port, '/api/state')).sessions.find((s) => s.id === S4)?.agents[0].status === 'idle', { label: 'Stop processado', timeoutMs: 30_000 });
    const state = await settledState(port);
    const session = state.sessions.find((s) => s.id === S4);
    const sub = (id) => session.agents.find((a) => a.key === id);
    assert.equal(session.agents.length, 3);
    for (const [who, label, target] of [[A, 'Testar A', 'a.md'], [B, 'Testar B', 'describe']]) {
      const agent = sub(who.id);
      assert.equal(agent.label, label, `${who.id}: descrição certa depois do Post`);
      assert.equal(agent.parentKey, 'main');
      assert.equal(agent.role, 'tes');
      assert.equal(agent.finished, true);
      assert.equal(agent.status, 'idle');
      assert.equal(agent.activity.target, target, `${who.id}: a própria ação`);
      assert.deepEqual(agent.health, { ok: 1, total: 1 });
    }
    const feedTools = session.feed.filter((e) => e.kind === 'tool.started').map((e) => [e.agentKey, e.data.tool]);
    assert.deepEqual(feedTools.sort(), [[A.id, 'Read'], [B.id, 'Grep']].sort());
    await caughtUp(sse, state);
    assertSameAsState(replay(sse.messages), state);
  });

  it('queda e volta do servidor: o cliente reconecta sozinho, recebe hello de outra execução e snapshot, e a sessão volta no evento seguinte', LONG_TEST, async (t) => {
    // Os prazos daqui só detectam travamento (ADR 0010): nada é medido.
    const rc = reconnectingSse(port, { retryMs: 100 });
    try {
      const firstHello = await rc.waitFor((m) => m.event === 'hello', { timeoutMs: 30_000 });
      await rc.waitFor((m) => m.event === 'snapshot', { timeoutMs: 30_000 });
      const oldRunId = firstHello.data.runId;
      const lastSeqBefore = (await getJson(port, '/api/state')).seq;

      await stopProcess(run); // queda: o processo morre sem apagar o runtime.json
      await rc.waitDisconnects(1, 30_000);
      await sse.closedWithin(); // o cliente antigo também percebe a queda

      // Durante a queda, o encaminhador sai em silêncio (pid morto), sem enviar.
      const down = await runForwarder({ env, stdin: JSON.stringify(common('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(projectDir, 'x.md') }, tool_use_id: 'toolu_01Durante9A' })) });
      assertSilentExit(down, 'durante a queda');

      run = launchTracked(['--port', String(port), '--debug-dump'], minimalEnv({ AGENT_QUEST_HOME: data.dir, USERPROFILE: home.dir, HOME: home.dir }));
      assert.equal(await run.started, true, run.output());
      const newRuntime = await waitFor(() => {
        const current = readJson(path.join(data.dir, 'runtime.json'));
        return current && current.pid !== runtime.pid ? current : null;
      }, { label: 'runtime.json novo', timeoutMs: START_GUARD_MS });
      runtime = newRuntime;

      const hello = await rc.waitFor((m) => m.event === 'hello' && m.data.runId !== oldRunId, { label: 'hello da execução nova', timeoutMs: START_GUARD_MS });
      const at = rc.messages.indexOf(hello);
      const snapshot = await rc.waitFor((m) => m.event === 'snapshot', { from: at, label: 'snapshot depois de reconectar', timeoutMs: 30_000 });
      assert.deepEqual(snapshot.data, { seq: 0, sessions: [] }, 'estado em memória: recomeça vazio (ADR 0005)');
      assert.equal(hello.data.seq, 0);
      assert.ok(rc.connections >= 2);
      assert.equal(rc.sentLastEventIds.at(-1), `${oldRunId}:${lastSeqBefore}`, 'a reconexão mandou o Last-Event-ID da execução anterior e mesmo assim recebeu snapshot');

      // A sessão reaparece no evento seguinte (criada sob demanda).
      const payload = common('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(projectDir, 'y.md') }, tool_use_id: 'toolu_01Depois9A' });
      if (!(await deliver(t, [payload], 'depois da volta'))) return; // pulado pela regra de carga
      const update = await rc.waitFor((m) => m.event === 'update' && m.data.event?.data?.toolUseId === 'toolu_01Depois9A', { from: at, timeoutMs: 30_000 });
      assert.equal(update.data.seq, 1);
      assert.equal(update.id, `${hello.data.runId}:1`);
      assert.equal(update.data.session.id, SID);
      assert.deepEqual(update.data.session.agents.map((a) => a.key), ['main'], 'o subagente da execução anterior não volta sozinho');
    } finally {
      rc.stop();
    }
  });
});

// ===========================================================================
// 3. startServer no mesmo processo, com a opção `pipeline`
// ===========================================================================

describe('T9a ligação no mesmo processo (startServer com a opção pipeline)', () => {
  it('reducer que lança: 204, conta como ignored, log só com o tipo, update sem evento da sessão; os eventos válidos seguintes continuam chegando', TEST, async (t) => {
    const SECRET = 'ghp_SEGREDONOERRO0123456789abcdefghijkl';
    const BEFORE = tid('ExplodeAntes');
    const AFTER = tid('ExplodeDepois');
    const nows = [];
    const local = await startLocal(t, {
      pipeline: {
        reducer: {
          apply(state, fact, now) {
            nows.push(now);
            if (fact.toolUseId === BEFORE) throw new TypeError(`falha com ${SECRET}`);
            const result = apply(state, fact, now);
            if (fact.toolUseId === AFTER) throw Object.assign(new RangeError(`falha depois com ${SECRET}`), { detail: SECRET });
            return result;
          },
          tick,
        },
      },
    });
    assert.deepEqual(
      (({ address, family }) => ({ address, family }))(local.server.server.address()),
      { address: '127.0.0.1', family: 'IPv4' },
      'com a ligação, o servidor continua só em 127.0.0.1',
    );
    const client = await connected(local.port);
    const S = sid(301);
    const NEW = sid(302);
    const expectSeq = async (toolUseId, kind) => client.waitFor((m) => m.data?.event?.kind === kind && m.data.event.data.toolUseId === toolUseId);

    assert.equal((await local.send(hook('SessionStart', S, { source: 'startup' }))).status, 204);
    assert.equal((await local.send(pre(S, tid('Ok1')))).status, 204);
    const ok1 = await expectSeq(tid('Ok1'), 'tool.started');

    // 1. Lança antes de mexer no estado: update sem evento, seq contínuo.
    assert.equal((await local.send(pre(S, BEFORE))).status, 204);
    const afterBefore = await client.waitFor((m) => m.event === 'update' && m.data.seq === ok1.data.seq + 1);
    assert.equal(afterBefore.data.event, null);
    assert.equal(afterBefore.data.session.id, S);

    // 2. Primeiro evento de uma sessão nova que lança antes: nada é publicado, nenhuma sessão criada.
    assert.equal((await local.send(pre(NEW, BEFORE))).status, 204);

    // 3. Os válidos seguintes continuam chegando, em ordem.
    assert.equal((await local.send(pre(S, tid('Ok2')))).status, 204);
    const ok2 = await expectSeq(tid('Ok2'), 'tool.started');
    assert.equal(ok2.data.seq, afterBefore.data.seq + 1);

    // 4. Lança depois do apply: o evento já numerado se perde no fio, o update sem evento pula o seq (lacuna), e o /api/state tem tudo.
    assert.equal((await local.send(pre(S, AFTER))).status, 204);
    const gapUpdate = await client.waitFor((m) => m.event === 'update' && m.data.seq > ok2.data.seq + 1);
    assert.equal(gapUpdate.data.event, null);
    assert.equal(gapUpdate.data.seq, ok2.data.seq + 2, 'o seq do evento perdido fica como lacuna para o painel');
    const state = await local.state();
    const lost = state.sessions.find((s) => s.id === S).feed.find((e) => e.data.toolUseId === AFTER);
    assert.equal(lost?.seq, ok2.data.seq + 1, 'o /api/state cobre a lacuna');

    for (const n of [3, 4, 5]) assert.equal((await local.send(pre(S, tid(`Ok${n}`)))).status, 204);
    assert.equal((await local.send(post(S, tid('Ok5')))).status, 204);
    const ok5 = await expectSeq(tid('Ok5'), 'tool.finished');
    const tail = client.numbered().filter((m) => m.data.seq > gapUpdate.data.seq);
    assert.deepEqual(tail.map((m) => m.data.seq), tail.map((_, i) => gapUpdate.data.seq + 1 + i), 'depois do erro, o seq volta a ser contínuo');
    assert.equal(ok5.data.seq, tail.at(-1).data.seq);

    const health = await local.health();
    assert.equal(health.events.ignored, 3);
    assert.equal(health.events.accepted, 10);
    assert.equal(health.sessions, 1, 'a sessão nova que falhou não foi criada');
    assert.deepEqual(local.logs, [
      'Erro ao processar um evento: TypeError',
      'Erro ao processar um evento: TypeError',
      'Erro ao processar um evento: RangeError',
    ]);
    assert.ok(!local.logs.join('\n').includes('SEGREDO'), 'o log não mostra conteúdo');
    assert.equal((await request(local.port, { path: '/' })).status, 200, 'o servidor segue servindo o painel');
    // O `now` do apply é a hora de chegada (desvio confirmado): o último é o lastEventAt do /api/health.
    assert.equal(nows.at(-1), health.lastEventAt);
  });

  // B1 do tester (19/10/2026): a ligação perdia o newProjects quando o reducer lançava, e o projeto nunca era lido.
  it('erro do reducer no primeiro evento de um projeto novo: o roster ainda recebe os papéis de .claude/agents/', TEST, async (t) => {
    let first = true;
    const local = await startLocal(t, {
      reader: fixedReader(['tester', 'arquiteto']),
      pipeline: {
        reducer: {
          apply(state, fact, now) {
            const result = apply(state, fact, now);
            if (first) {
              first = false;
              throw new TypeError('falha no primeiro evento');
            }
            return result;
          },
          tick,
        },
      },
    });
    const S = sid(303);
    assert.equal((await local.send(hook('SessionStart', S, { source: 'startup' }))).status, 204);
    assert.equal((await local.send(pre(S, tid('Roster1')))).status, 204);
    await waitFor(async () => (await local.state()).sessions.find((s) => s.id === S)?.roster.includes('arq'), { timeoutMs: 2000, label: 'roster com os papéis do projeto' });
  });

  it('fatos descartados pelo normalizador: 204, ignored, nenhum seq gasto, nenhuma sessão; o servidor segue', TEST, async (t) => {
    const local = await startLocal(t);
    const client = await connected(local.port);
    const S = sid(304);
    let deep = { fim: true };
    for (let i = 0; i < 3000; i++) deep = { d: deep };
    const discarded = [
      hook('EventoDesconhecido', S),
      hook('PreToolUse', S, { tool_name: 'Read', tool_use_id: tid('Inv1') }, { id: 'main' }),
      hook('PreToolUse', S, { tool_name: 'Read', tool_use_id: tid('Inv2') }, { id: '   ' }),
      hook('PreToolUse', S, { tool_name: 'Read', tool_use_id: tid('Inv3') }, { id: 'a b c' }),
      { ...hook('PreToolUse', S, { tool_name: 'Read', tool_use_id: tid('Inv4') }), agent_id: 12345 },
      { ...hook('PreToolUse', 'sessão com espaço'), tool_name: 'Read' },
      { ...hook('PreToolUse', 'x'.repeat(129)), tool_name: 'Read' },
      { ...hook('SubagentStop', S, {}, { id: aid(304) }), agent_type: '' }, // agente interno: não gera nada, mas não é "ignored"
    ];
    for (const payload of discarded) assert.equal((await local.send(payload)).status, 204, JSON.stringify(payload).slice(0, 80));
    // tool_input aninhado demais: o fato sai (inputHash null), não derruba nada.
    assert.equal((await local.send(pre(S, tid('Fundo'), null, 'Read', deep))).status, 204);
    await client.waitFor((m) => m.data?.event?.data?.toolUseId === tid('Fundo'));
    const health = await local.health();
    assert.equal(health.events.accepted, 9);
    assert.equal(health.events.ignored, 7, 'os sete descartados pelo normalizador');
    assert.equal(health.sessions, 1);
    assert.deepEqual(client.numbered().map((m) => m.data.event?.kind ?? null), ['tool.started'], 'só o válido gerou mensagem, com seq 1');
    assert.equal(client.numbered()[0].data.seq, 1);
    assert.deepEqual(local.logs, []);
  });

  it('tick (relógio e temporizadores injetados): update com evento, update sem evento e session-removed com seq contínuo; sessão removida e recriada', TEST, async (t) => {
    const intervals = fakeIntervals();
    const base = Date.now();
    let now = base;
    const local = await startLocal(t, { reader: fixedReader(['tester', 'arquiteto']), pipeline: { timers: intervals.timers, clock: () => now } });
    assert.equal(TICK_MS, 5000);
    assert.deepEqual(intervals.active().map((h) => h.ms), [5000], 'um tick, a cada 5 s');
    const client = await connected(local.port);
    const [S1, S2, S3] = [sid(311), sid(312), sid(313)];
    const W = { id: aid(311), type: 'dev-backend' };
    const sends = [
      hook('UserPromptSubmit', S1, { prompt: 'Pedido' }),
      pre(S1, tid('T1'), W),
      post(S1, tid('T1'), W),
      hook('SessionStart', S2, { source: 'startup' }),
      hook('SessionEnd', S2, { reason: 'prompt_input_exit' }),
      hook('SessionStart', S3, { source: 'startup' }),
    ];
    for (const payload of sends) assert.equal((await local.send(payload)).status, 204);
    await client.waitFor((m) => m.data?.event?.kind === 'session.started' && m.data.event.sessionId === S3);
    await settledState(local.port);
    const mark = () => client.messages.length;
    const since = (from) => client.messages.slice(from).filter((m) => m.event === 'update' || m.event === 'session-removed');
    const describeMessages = (list) => list.map((m) => [m.event, m.data.event?.kind ?? null, m.data.sessionId ?? m.data.session?.id]);

    // +2,5 min: S3 fica ociosa (update sem evento). S1 tem agentes trabalhando; S2 já está encerrada.
    let from = mark();
    now = base + 150_000;
    intervals.fire();
    await waitFor(() => since(from).length >= 1, { label: 'tick de 2,5 min' });
    assert.deepEqual(describeMessages(since(from)), [['update', null, S3]]);
    assert.equal(since(from)[0].data.session.status, 'idle');

    // +16 min: o subagente parado recebe agent.finished(unknown); o main só fica ocioso.
    from = mark();
    now = base + 16 * 60_000;
    intervals.fire();
    await waitFor(() => since(from).length >= 1, { label: 'tick de 16 min' });
    assert.deepEqual(describeMessages(since(from)), [['update', 'agent.finished', S1]]);
    assert.deepEqual(since(from)[0].data.event.data, { outcome: 'unknown' });

    // +31 min: S2, encerrada há 30 min, sai da memória.
    from = mark();
    now = base + 31 * 60_000;
    intervals.fire();
    await waitFor(() => since(from).length >= 1, { label: 'tick de 31 min' });
    assert.deepEqual(describeMessages(since(from)), [['session-removed', null, S2]]);
    assert.equal((await local.health()).sessions, 2);

    // S2 recriada: o roster já vem com os papéis do projeto (lidos uma vez), sem nova leitura.
    from = mark();
    assert.equal((await local.send(hook('SessionStart', S2, { source: 'resume' }))).status, 204);
    const recreated = await client.waitFor((m) => m.data?.event?.kind === 'session.started' && m.data.event.sessionId === S2, { from });
    assert.deepEqual(recreated.data.session.roster, ['orq', 'arq', 'tes']);
    assert.equal(recreated.data.session.status, 'active');
    assert.equal((await local.health()).sessions, 3);

    // +6 h: todas saem.
    from = mark();
    now = base + 6 * 3_600_000 + 60_000;
    intervals.fire();
    await waitFor(() => since(from).length >= 3, { label: 'tick de 6 h' });
    assert.deepEqual(describeMessages(since(from)).map(([kind, , id]) => [kind, id]), [['session-removed', S1], ['session-removed', S3], ['session-removed', S2]]);

    const state = await local.state();
    assert.deepEqual(state.sessions, []);
    assertSameAsState(replay(client.messages), state);
    const kinds = new Set(client.numbered().map((m) => (m.event === 'session-removed' ? 'removed' : m.data.event ? 'com-evento' : 'sem-evento')));
    assert.deepEqual([...kinds].sort(), ['com-evento', 'removed', 'sem-evento'], 'a sequência mistura os três tipos');
    assert.equal((await local.health()).sessions, 0);
  });

  it('tick com o relógio real: setInterval de 5000 ms com unref; a primeira passada vem depois de ~5 s; close() desliga', TEST, async (t) => {
    const handles = [];
    const cleared = [];
    const ticks = [];
    const spy = {
      setInterval(run, ms) {
        const handle = setInterval(run, ms);
        handles.push({ handle, ms });
        return handle;
      },
      clearInterval(handle) {
        cleared.push(handle);
        clearInterval(handle);
      },
    };
    const started = performance.now();
    const local = await startLocal(t, {
      pipeline: {
        timers: spy,
        clock: () => {
          ticks.push(performance.now() - started);
          return Date.now();
        },
      },
    });
    assert.equal(handles.length, 1);
    assert.equal(handles[0].ms, 5000);
    assert.equal(handles[0].handle.hasRef(), false, 'o tick não segura o processo');
    await waitFor(() => ticks.length >= 1, { timeoutMs: 15_000, intervalMs: 50, label: 'primeira passada do tick' });
    t.diagnostic(`primeira passada do tick em ${ticks[0].toFixed(0)} ms`);
    assert.ok(ticks[0] >= 4900, `o tick rodou cedo demais: ${ticks[0]} ms`);
    await local.server.close();
    assert.deepEqual(cleared, [handles[0].handle], 'close() desligou o tick');
  });

  it('erro no tick vai só ao log, com o tipo; nada é publicado e os eventos seguem', TEST, async (t) => {
    const intervals = fakeIntervals();
    const local = await startLocal(t, {
      pipeline: { timers: intervals.timers, reducer: { apply, tick: () => { throw new RangeError('SEGREDO-NO-TICK ghp_0123456789abcdefghijklmnopqrstuvwxyz'); } } },
    });
    const client = await connected(local.port);
    const S = sid(321);
    assert.equal((await local.send(pre(S, tid('Tk1')))).status, 204);
    await client.waitFor((m) => m.data?.event?.data?.toolUseId === tid('Tk1'));
    const count = client.numbered().length;
    intervals.fire();
    intervals.fire();
    assert.deepEqual(local.logs, ['Erro no tick do estado: RangeError', 'Erro no tick do estado: RangeError']);
    assert.equal((await local.send(pre(S, tid('Tk2')))).status, 204);
    const next = await client.waitFor((m) => m.data?.event?.data?.toolUseId === tid('Tk2'));
    assert.equal(client.numbered().length, count + 1);
    assert.equal(next.data.seq, client.numbered()[count - 1].data.seq + 1);
  });

  it('rajada de 3 200 envelopes de 8 sessões com clientes entrando e saindo: ordem por sessão, seq contínuo, nada perdido e /api/state igual ao que os clientes montaram', LONG_TEST, async (t) => {
    const local = await startLocal(t, { reader: fixedReader(['tester']) });
    const persistent = await connected(local.port);
    const LANES = 8;
    const PER_LANE = 400;
    const agent = new http.Agent({ keepAlive: true, maxSockets: LANES });
    t.after(() => agent.destroy());
    const sent = Array.from({ length: LANES }, () => []);
    let lateJoiner = null;
    let finished = false;
    const churned = [];

    const lane = async (n) => {
      const S = sid(400 + n);
      const subagent = { id: aid(400 + n), type: n % 2 ? 'tester' : 'Explore' };
      for (let i = 0; i < PER_LANE; i++) {
        const id = tid(`R${n}x${i}`);
        const who = i % 3 === 0 ? subagent : null;
        const payload = i % 5 === 4 ? post(S, tid(`R${n}x${i - 1}`), i % 3 === 1 ? subagent : null) : pre(S, id, who);
        if (i % 5 !== 4) sent[n].push(id);
        const res = await postHook(local.port, local.token, envelope(payload), { agent });
        assert.equal(res.status, 204);
        if (n === 0 && i === PER_LANE / 2) lateJoiner = await connected(local.port);
      }
    };
    // O laço de clientes para sempre: no fim, numa falha de uma rajada ou se o servidor sumir.
    t.after(() => {
      finished = true;
    });
    const churn = async () => {
      while (!finished) {
        let client;
        try {
          client = await openSse(local.port);
        } catch {
          return;
        }
        if (client.status === 200) {
          await client.waitFor((m) => m.event === 'snapshot').catch(() => {});
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 30)));
          churned.push(client);
        }
        client.close();
        await client.closedWithin().catch(() => {});
        // Cada snapshot leva as 8 sessões com feed; a pausa só limita o custo do teste (servidor e clientes no mesmo processo).
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    const churners = [churn(), churn(), churn(), churn()];
    try {
      await Promise.all(Array.from({ length: LANES }, (_, n) => lane(n)));
    } finally {
      finished = true;
      await guard(Promise.all(churners), CLEANUP_GUARD_MS, 'clientes que entram e saem').catch(() => {});
    }

    const total = sent.reduce((sum, ids) => sum + ids.length, 0);
    await waitFor(() => persistent.numbered().filter((m) => m.data.event?.kind === 'tool.started').length >= total, { timeoutMs: 20_000, label: 'todos os tool.started' });
    const state = await settledState(local.port);
    const health = await local.health();
    t.diagnostic(`rajada: ${JSON.stringify(health.events)}; ${churned.length} clientes entraram e saíram`);
    assert.equal(health.events.received, LANES * PER_LANE);
    assert.equal(health.events.rejected, 0);
    assert.equal(health.events.deduped, 0);
    assert.equal(health.events.ignored, 0);
    assert.equal(health.events.received, health.events.accepted + health.events.deduped + health.events.rejected);

    const started = persistent.numbered().filter((m) => m.data.event?.kind === 'tool.started').map((m) => m.data.event);
    const missing = total - started.length;
    assert.ok(missing <= health.events.dropped, `perdidos ${missing} além dos ${health.events.dropped} descartados pela fila`);
    assert.equal(new Set(started.map((e) => e.data.toolUseId)).size, started.length, 'nenhum tool.started repetido');
    for (let n = 0; n < LANES; n++) {
      const order = started.filter((e) => e.sessionId === sid(400 + n)).map((e) => e.data.toolUseId);
      const expected = sent[n].filter((id) => order.includes(id));
      assert.deepEqual(order, expected, `ordem da sessão ${n}`);
    }
    await caughtUp(persistent, state);
    await caughtUp(lateJoiner, state);
    assertSameAsState(replay(persistent.messages, 'persistente'), state, 'persistente');
    assertSameAsState(replay(lateJoiner.messages, 'entrou no meio'), state, 'entrou no meio');
    for (const [i, client] of churned.entries()) replay(client.messages, `cliente ${i} que entrou e saiu`);
    for (const session of state.sessions) assert.ok(session.feed.length <= 200, 'feed limitado a 200');
    lateJoiner.close();
    await lateJoiner.closedWithin();
    await waitFor(async () => (await local.health()).clients === 1, { label: 'só o persistente' });
  });

  it('fila cheia (createApp + createPipeline como no main.js, limite 50): descarta os mais antigos, conta dropped, e o SSE recebe exatamente os que ficaram, numerados em sequência', TEST, async (t) => {
    const runId = 'fila9a';
    const TOKEN = 'token-de-teste-9a';
    const intervals = fakeIntervals();
    const logs = [];
    const pipeline = createPipeline({ runId, homeDir: FAKE_HOME, reader: fixedReader([]), timers: intervals.timers, logError: (m) => logs.push(m) });
    const pending = [];
    const { server, hub } = createApp({
      version: VERSION,
      startedAt: Date.now(),
      token: TOKEN,
      runId,
      logError: (m) => logs.push(m),
      queueLimit: 50,
      schedule: (run) => pending.push(run),
      onEnvelope: pipeline.handleEnvelope,
      getSnapshot: pipeline.snapshot,
      sessionCount: pipeline.sessionCount,
    });
    pipeline.attach(hub);
    await guard(new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)), START_GUARD_MS, 'listen');
    const closeServer = () =>
      guard(
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
        CLEANUP_GUARD_MS,
        'fechar o servidor',
      ).catch(() => server.unref());
    const forget = onCleanup(closeServer);
    t.after(() => {
      forget();
      return closeServer();
    });
    const { port } = server.address();
    const client = await connected(port);
    const S = sid(501);
    for (let i = 0; i < 200; i++) assert.equal((await postHook(port, TOKEN, envelope(pre(S, tid(`F${i}`))))).status, 204);
    let health = await getJson(port, '/api/health');
    assert.equal(health.events.accepted, 200);
    assert.equal(health.events.dropped, 150);
    while (pending.length) pending.shift()();
    await client.waitFor((m) => m.data?.event?.data?.toolUseId === tid('F199'));
    health = await getJson(port, '/api/health');
    const ids = client.numbered().map((m) => m.data.event?.data?.toolUseId);
    assert.deepEqual(ids, Array.from({ length: 50 }, (_, i) => tid(`F${150 + i}`)), 'os 50 mais recentes, na ordem');
    assert.deepEqual(client.numbered().map((m) => m.data.seq), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.equal(health.events.ignored, 0);
    assert.equal(health.sessions, 1);
    assertSameAsState(replay(client.messages), await getJson(port, '/api/state'));
    assert.deepEqual(logs, []);
  });

  it('dedupe pela ingestão: o mesmo payload repetido (outro sentAt) vira um evento; outra sessão com o mesmo resto não é duplicata', TEST, async (t) => {
    const local = await startLocal(t);
    const client = await connected(local.port);
    const payload = pre(sid(601), tid('Dup'));
    assert.equal((await local.send(payload, { sentAt: Date.now() })).status, 204);
    assert.equal((await local.send(payload, { sentAt: Date.now() + 7 })).status, 204);
    assert.equal((await local.send({ ...payload, session_id: sid(602) })).status, 204);
    await client.waitFor((m) => m.data?.event?.sessionId === sid(602));
    await settledState(local.port);
    const health = await local.health();
    assert.equal(health.events.deduped, 1);
    assert.equal(health.events.accepted, 2);
    assert.deepEqual(client.numbered().map((m) => [m.data.event?.kind, m.data.event?.sessionId]), [['tool.started', sid(601)], ['tool.started', sid(602)]]);
  });

  it('segredos, ANSI e conteúdo nos envelopes: nada disso, nenhum *Key cru, nenhum campo fora do contrato e nenhum texto que não seja ponto fixo de redact sai pelo SSE ou pelo /api/state', TEST, async (t) => {
    const local = await startLocal(t, { reader: fixedReader(['tester']) });
    const client = await connected(local.port);
    const S = sid(701);
    const ESC = '\u001b';
    const BEL = '\u0007';
    const GHP = `ghp_${'Z9'.repeat(18)}`;
    const SKANT = `sk-ant-api03-${'Q7w'.repeat(12)}`;
    const AKIA = 'AKIAABCDEFGHIJKLMNOP';
    const BEARER = `SegredoBearer${'x'.repeat(20)}`;
    const URLPASS = 'SenhaDaUrl9aXYZ';
    const ANSI_SECRET = 'SegredoColorido9aXYZ';
    const PWD = 'SenhaNoErro9aXYZ';
    const W = { id: aid(701), type: `tes${ESC}[0mter` };
    const B = { id: aid(702), type: GHP };
    const payloads = [
      hook('SessionStart', S, { source: 'startup', model: `claude ${GHP}`, session_title: `Sessão ${GHP}` }),
      hook('UserPromptSubmit', S, { prompt: `Use ${GHP} e ${SKANT}\nSEGUNDA-LINHA-PRIVADA-9A` }),
      pre(S, tid('S1'), null, 'Bash', { command: `export API_KEY=${ESC}[32m${ANSI_SECRET}${ESC}[0m && curl -u admin:${URLPASS} -H "Authorization: Bearer ${BEARER}" https://exemplo.invalid/`, description: `token=${GHP}` }),
      hook('PostToolUse', S, { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: tid('S1'), tool_response: { stdout: `SAIDA-PRIVADA-9A ${GHP}`, stderr: 'ERRO-PADRAO-PRIVADO-9A' } }),
      pre(S, tid('S2'), null, 'Grep', { pattern: AKIA, path: FAKE_PROJECT }),
      pre(S, tid('S3'), null, 'Read', { file_path: `${FAKE_PROJECT}\\segredos\\${GHP}.txt` }),
      pre(S, tid('S4'), null, 'WebFetch', { url: `https://usuario:${URLPASS}@exemplo.invalid/caminho?token=${GHP}`, prompt: 'PROMPT-WEB-PRIVADO-9A' }),
      pre(S, tid('S5'), null, 'Agent', { description: `Testar ${ESC}]0;título${BEL} com ${GHP}`, prompt: `PROMPT-PRIVADO-9A ${SKANT}`, subagent_type: `tes${ESC}[0mter` }),
      hook('SubagentStart', S, {}, W),
      pre(S, tid('S6'), W, 'Edit', { file_path: `${FAKE_PROJECT}\\a.js`, old_string: 'CONTEUDO-ANTIGO-9A', new_string: `CONTEUDO-NOVO-9A ${GHP}` }),
      pre(S, tid('S7'), W, 'Write', { file_path: `${FAKE_PROJECT}\\b.js`, content: 'CONTEUDO-ESCRITO-9A' }),
      hook('PostToolUseFailure', S, { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: tid('S8'), error: `Exit code 1 password=${PWD}\nSEGUNDA-LINHA-DO-ERRO-9A` }, W),
      pre(S, tid('S9'), W, `mcp__${GHP}__ferramenta`, { query: 'x' }),
      pre(S, tid('S10'), W, `Re${ESC}[0mad`, { file_path: `${FAKE_PROJECT}\\c.md` }),
      pre(S, tid('S11'), null, 'Agent', { description: 'Outra', prompt: 'PROMPT-PRIVADO-9A', subagent_type: GHP }),
      hook('SubagentStart', S, {}, B),
      hook('Notification', S, { message: `MENSAGEM-PRIVADA-9A ${GHP}`, notification_type: 'permission_prompt' }),
      hook('PermissionRequest', S, { tool_name: 'Bash', tool_input: { command: `echo ${GHP}` } }),
      hook('PreCompact', S, { trigger: 'manual', custom_instructions: 'INSTRUCOES-PRIVADAS-9A' }),
      hook('PostCompact', S, { trigger: 'manual', compact_summary: 'RESUMO-PRIVADO-9A' }),
      hook('SubagentStop', S, { last_assistant_message: 'RESPOSTA-PRIVADA-9A', agent_transcript_path: 'C:\\TRANSCRIPT-MARCA-9A\\agent.jsonl' }, W),
      hook('Stop', S, { last_assistant_message: 'RESPOSTA-FINAL-PRIVADA-9A', background_tasks: [{ id: B.id, type: 'local_agent', status: 'running', agent_type: GHP, description: `tarefa ${GHP}` }] }),
      hook('StopFailure', S, { error: 'rate_limit', error_details: 'DETALHE-PRIVADO-9A', last_assistant_message: 'ERRO-PRIVADO-9A' }),
      hook('SessionEnd', S, { reason: 'other', transcript_path: 'C:\\TRANSCRIPT-MARCA-9A\\s.jsonl' }),
    ];
    for (const payload of payloads) assert.equal((await local.send(payload)).status, 204);
    await client.waitFor((m) => m.data?.event?.kind === 'session.ended');
    const state = await settledState(local.port);
    const stateText = JSON.stringify(state);
    const all = client.raw + stateText + JSON.stringify(await local.health());
    const forbidden = [
      'Z9Z9Z9Z9', 'Q7wQ7wQ7w', 'ABCDEFGHIJKLMNOP', BEARER, URLPASS, ANSI_SECRET, PWD,
      'SEGUNDA-LINHA-PRIVADA-9A', 'SAIDA-PRIVADA-9A', 'ERRO-PADRAO-PRIVADO-9A', 'PROMPT-WEB-PRIVADO-9A', 'PROMPT-PRIVADO-9A',
      'CONTEUDO-ANTIGO-9A', 'CONTEUDO-NOVO-9A', 'CONTEUDO-ESCRITO-9A', 'SEGUNDA-LINHA-DO-ERRO-9A', 'MENSAGEM-PRIVADA-9A',
      'INSTRUCOES-PRIVADAS-9A', 'RESUMO-PRIVADO-9A', 'RESPOSTA-PRIVADA-9A', 'RESPOSTA-FINAL-PRIVADA-9A', 'DETALHE-PRIVADO-9A',
      'ERRO-PRIVADO-9A', 'TRANSCRIPT-MARCA-9A', 'usuario:', ESC, BEL, '\\u001b', '\\u0007', 'TypeKey', 'inputHash', 'transcript',
    ];
    for (const text of forbidden) assert.ok(!all.includes(text), `vazou ${JSON.stringify(text)}`);

    // Só as chaves do contrato (seções 3 e 9) e textos exibidos que são ponto fixo de redact.
    const ALLOWED_KEYS = new Set([
      'seq', 'sessions', 'event', 'session', 'sessionId', 'protocol', 'runId', 'serverVersion',
      'id', 'project', 'key', 'name', 'dir', 'label', 'client', 'status', 'startedAt', 'lastEventAt', 'agents', 'roster', 'quest',
      'counters', 'questsDone', 'bugsCrushed', 'pendingApprovals', 'bugs', 'open', 'lastRun', 'feed',
      'agentId', 'agentType', 'role', 'finished', 'background', 'parentKey', 'activity', 'waitingFor', 'health', 'ok', 'total', 'context',
      'kind', 'category', 'tool', 'target', 'detail', 'state', 'at',
      'ts', 'agentKey', 'data',
      'source', 'projectName', 'reason', 'toolUseId', 'toType', 'toRole', 'description', 'outcome', 'durationMs', 'error', 'interrupted',
    ]);
    const walk = (value, where) => {
      if (typeof value === 'string') {
        if (!/(project\.(dir|key))$/.test(where)) {
          assert.ok(Array.from(value).length <= 200, `${where}: texto acima de 200`);
          assert.equal(redact(value), value, `${where}: não é ponto fixo de redact: ${JSON.stringify(value)}`);
        }
        return;
      }
      if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${where}[${i}]`));
      if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          assert.ok(ALLOWED_KEYS.has(key), `${where}.${key}: chave fora do contrato`);
          walk(item, `${where}.${key}`);
        }
      }
    };
    walk(state, 'state');
    for (const message of client.messages) walk(message.data, message.event);
  });

  it('fuzz: 20 000 envelopes aleatórios e passadas do tick pela ligação nunca fazem o reducer lançar; o seq segue contínuo e o snapshot é o que o painel monta', LONG_TEST, async () => {
    let seed = 0x9a9a9a;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const maybe = (p, value) => (rand() < p ? value : undefined);
    const HOOKS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact'];
    const SESSIONS = [sid(801), sid(802), sid(803), sid(804)];
    const AGENTS = [undefined, undefined, null, aid(801), aid(802), aid(803), aid(804), 'main', '   ', 7];
    const TYPES = [undefined, 'tester', 'arquiteto', 'dev-backend', 'Explore', '', null, 3, 'plugin:tester'];
    const TOOLS = ['Read', 'Bash', 'Agent', 'Task', 'Edit', 'Grep', 'mcp__srv__x', 'WebFetch', 'TodoWrite', 'Skill', 42, null, ''];
    const IDS = [...Array.from({ length: 40 }, (_, i) => tid(`Fz${i}`)), null, undefined, 'id inválido', 5];
    const DIRS = [FAKE_PROJECT, 'D:\\Outro\\proj', '/c/Users/fulana/Projetos/exemplo-9a', 'C:\\', null, '', 5];
    const junk = () => pick(['x', 1, null, true, [], {}, 'startup', 'compact', 'manual', 'idle_prompt', 'permission_prompt', 'other']);
    const toolInput = () => ({
      file_path: maybe(0.5, pick([`${FAKE_PROJECT}\\a.md`, 7, null, ''])),
      command: maybe(0.4, pick(['npm test', 'ls', 1, null])),
      description: maybe(0.5, pick(['Descrição', '', 9])),
      subagent_type: maybe(0.6, pick(TYPES)),
      run_in_background: maybe(0.3, pick([true, false, 'sim'])),
      prompt: maybe(0.3, 'PROMPT'),
    });
    const randomPayload = () => {
      const name = pick(HOOKS);
      const agentId = pick(AGENTS);
      const payload = { hook_event_name: name, session_id: pick(SESSIONS), cwd: maybe(0.5, pick(DIRS)) };
      if (agentId !== undefined) payload.agent_id = agentId;
      const type = pick(TYPES);
      if (type !== undefined) payload.agent_type = type;
      if (rand() < 0.5) payload.prompt_id = pick(['p1', 'p2', null, 4]);
      if (name.includes('Tool') || name.startsWith('Permission')) {
        payload.tool_name = pick(TOOLS);
        const id = pick(IDS);
        if (id !== undefined) payload.tool_use_id = id;
        payload.tool_input = rand() < 0.9 ? toolInput() : junk();
        if (name === 'PostToolUse') payload.tool_response = rand() < 0.7 ? { status: pick(['completed', 'async_launched', 7]), agentId: pick(AGENTS) } : junk();
        if (name === 'PostToolUseFailure') {
          payload.error = pick(['Exit code 1', 3, null]);
          payload.is_interrupt = pick([true, false, 'x']);
        }
        if (rand() < 0.5) payload.duration_ms = pick([1, -1, 'x', 1e12]);
      }
      if (name === 'Stop' || name === 'SubagentStop') {
        payload.background_tasks = rand() < 0.8 ? Array.from({ length: Math.floor(rand() * 3) }, () => ({ id: pick(AGENTS), type: pick(['local_agent', 'bash', 9]), status: pick(['running', 'completed', null]), agent_type: pick(TYPES) })) : junk();
      }
      for (const field of ['source', 'reason', 'trigger', 'notification_type', 'session_title', 'model', 'prompt']) {
        if (rand() < 0.15) payload[field] = junk();
      }
      return payload;
    };

    const messages = [];
    const logs = [];
    let now = 1_760_000_000_000;
    const pipeline = createPipeline({ runId: 'fuzz9a', homeDir: FAKE_HOME, reader: fixedReader(['tester', 'arquiteto']), clock: () => now, timers: fakeIntervals().timers, logError: (m) => logs.push(m) });
    messages.push({ event: 'hello', data: { runId: 'fuzz9a', seq: 0 } }, { event: 'snapshot', id: 'fuzz9a:0', data: pipeline.snapshot() });
    pipeline.attach({
      publishUpdate: (m) => messages.push({ event: 'update', id: `fuzz9a:${m.seq}`, data: structuredClone(m) }),
      publishRemoved: (m) => messages.push({ event: 'session-removed', id: `fuzz9a:${m.seq}`, data: structuredClone(m) }),
    });
    const thrown = new Map();
    for (let i = 0; i < 20_000; i++) {
      now += Math.floor(rand() * 40);
      const payload = randomPayload();
      const sentAt = rand() < 0.95 ? now - Math.floor(rand() * 3000) : pick([0, -5, 'x', now + 3_600_000]);
      const env = { projectDir: pick(DIRS), entrypoint: pick([null, 'cli', 'claude-vscode', 4]) };
      try {
        pipeline.handleEnvelope({ v: 1, sentAt, forwarder: 'fuzz', env, truncated: false, payload }, { receivedAt: now });
      } catch (err) {
        const key = `${err?.name}: ${String(err?.message).slice(0, 120)} @ ${payload.hook_event_name}`;
        if (!thrown.has(key)) thrown.set(key, JSON.stringify(payload).slice(0, 400));
      }
      if (i % 700 === 699) {
        now += pick([1000, 150_000, 16 * 60_000, 31 * 60_000, 7 * 3_600_000]);
        pipeline.runTick();
        await pipeline.settled();
      }
    }
    await pipeline.settled();
    assert.deepEqual([...thrown.entries()], [], 'o reducer lançou exceção (cada tipo com um payload de exemplo)');
    assert.deepEqual(logs, []);
    const replayed = replay(messages, 'fuzz');
    assertSameAsState(replayed, pipeline.snapshot());
  });
});

// ===========================================================================
// 4. Leitor de .claude/agents/ lento ou travado (ajuste de 19/10/2026)
// ===========================================================================

let pipeSeq = 0;

/**
 * Prende uma thread do libuv sem gastar CPU, como um `readdir` numa pasta de
 * rede morta: um `read` num pipe nomeado do Windows que não recebe dados.
 * Conferido antes no Node 24: com 4 desses presos, um `readFile` não termina;
 * com 1, termina na hora. `release()` manda um byte e solta a thread.
 */
async function stuckThread() {
  const slash = String.fromCharCode(92);
  const name = `${slash}${slash}.${slash}pipe${slash}aq-int-9a-${process.pid}-${pipeSeq++}`;
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    forget();
    for (const socket of sockets) socket.end('x');
    server.close(); // um `open` ainda pendente falha, e um `read` pendente termina
  };
  // Registrado antes do `open`: se o teste acabar no meio, o pipe é solto e a thread volta.
  const forget = onCleanup(release);
  await guard(
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(name, resolve);
    }),
    CLEANUP_GUARD_MS,
    'pipe nomeado',
  );
  const handle = await guard(open(name, 'r'), CLEANUP_GUARD_MS, 'abrir o pipe nomeado');
  const reading = handle
    .read(Buffer.alloc(1), 0, 1, null)
    .catch(() => {})
    .finally(() => handle.close().catch(() => {}));
  return { reading, release };
}

describe('Leitor de .claude/agents/ lento ou travado (leitor de disco da ligação, com onLate)', () => {
  const windowsOnly = process.platform !== 'win32' && 'usa pipe nomeado do Windows para prender uma thread do libuv';

  it('dez pastas com listagem presa: uma listagem por vez; o servidor segue servindo arquivos e processando eventos; cada pasta que termina atualiza o roster por update sem evento', { skip: windowsOnly, ...TEST }, async (t) => {
    const blockers = new Map();
    const calls = [];
    let running = 0;
    let maxRunning = 0;
    // Depois do fim do teste, o leitor ainda pode começar a próxima pasta da fila: ela não prende nada.
    let stopped = false;
    const list = async (folder) => {
      calls.push(folder);
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        const match = /preso-\d+/.exec(folder);
        if (!match) return ['documentador.md', 'LEIA-ME.txt']; // pasta pessoal: responde na hora
        if (stopped) return [];
        const blocker = await stuckThread();
        blockers.set(match[0], blocker);
        if (stopped) blocker.release();
        await blocker.reading;
        return ['tester.md', 'arquiteto.md', 'notas.txt'];
      } finally {
        running--;
      }
    };
    t.after(() => {
      stopped = true;
      for (const blocker of blockers.values()) blocker.release();
    });
    const local = await startLocal(t, { reader: null, pipeline: { readerOptions: { list, timeoutMs: 100 } } });
    const client = await connected(local.port);
    const N = 10;
    const project = (n) => `${FAKE_HOME}\\Projetos\\preso-${n}`;
    for (let n = 1; n <= N; n++) {
      assert.equal((await local.send(hook('SessionStart', sid(900 + n), { source: 'startup' }), { projectDir: project(n) })).status, 204);
    }
    for (let n = 1; n <= N; n++) {
      await client.waitFor((m) => m.data?.event?.kind === 'session.started' && m.data.event.sessionId === sid(900 + n), { label: `sessão ${n}` });
    }
    await waitFor(() => blockers.has('preso-1'), { label: 'primeira listagem presa' });

    // Com a listagem presa: arquivos estáticos (fs nas threads do libuv), API e novos eventos seguem.
    for (const urlPath of ['/', '/js/main.js', '/shared/contract.js', '/api/health']) {
      assert.equal((await request(local.port, { path: urlPath })).status, 200, urlPath);
    }
    assert.equal((await local.send(pre(sid(901), tid('Preso1')), { projectDir: project(1) })).status, 204);
    await client.waitFor((m) => m.data?.event?.data?.toolUseId === tid('Preso1'));
    // Seção 7 (19/10/2026): no máximo 2 listagens não terminadas (a em andamento e as perdidas depois de 10 s).
    assert.ok(maxRunning <= 2, `listagens não terminadas ao mesmo tempo: ${maxRunning}`);
    assert.ok(blockers.size <= 2, `pastas presas ao mesmo tempo: ${blockers.size}`);
    t.diagnostic(`listagens simultâneas: no máximo ${maxRunning}`);
    // Até a pasta do projeto ser listada, o roster tem só os papéis vistos, mais os da pasta pessoal se ela já foi lida.
    for (const session of (await local.state()).sessions) {
      assert.ok([JSON.stringify(['orq']), JSON.stringify(['orq', 'doc'])].includes(JSON.stringify(session.roster)), `roster antes da listagem: ${session.roster}`);
    }

    // Cada pasta liberada termina (em geral depois do prazo): o roster completo da sessão dela chega num
    // update sem evento, e a próxima começa. Se a pasta pessoal já estava listada quando o prazo do read
    // venceu, pode chegar antes um update só com os papéis dela (['orq', 'doc']): o read resolve com o que
    // havia no prazo, e o onLate completa depois.
    const FULL = ['orq', 'arq', 'tes', 'doc'];
    for (let n = 1; n <= N; n++) {
      await waitFor(() => blockers.has(`preso-${n}`), { label: `listagem de preso-${n}` });
      const from = client.messages.length;
      blockers.get(`preso-${n}`).release();
      const update = await client.waitFor(
        (m) => m.event === 'update' && m.data.event === null && m.data.session.id === sid(900 + n) && m.data.session.roster.includes('arq'),
        { from, label: `roster de preso-${n}` },
      );
      assert.deepEqual(update.data.session.roster, FULL, `roster de preso-${n}`);
    }
    for (const session of (await local.state()).sessions) assert.deepEqual(session.roster, FULL, `roster final de ${session.id}`);
    assert.ok(maxRunning <= 2, `listagens não terminadas ao mesmo tempo: ${maxRunning}`);
    assert.equal(calls.length, N + 1, 'cada pasta (as dez e a pessoal) listada uma vez');
    assert.equal(new Set(calls).size, N + 1);
    assertSameAsState(replay(client.messages), await local.state());

    // Sessão nova de um projeto já lido: o roster vem completo no primeiro update, sem nova listagem.
    assert.equal((await local.send(hook('SessionStart', sid(950), { source: 'startup' }), { projectDir: project(3) })).status, 204);
    const again = await client.waitFor((m) => m.data?.event?.sessionId === sid(950));
    assert.deepEqual(again.data.session.roster, ['orq', 'arq', 'tes', 'doc']);
    assert.equal(calls.length, N + 1);
    assert.deepEqual(local.logs, []);
  });

  it('listagem lenta que termina depois do prazo (temporizadores injetados): o roster sai com os papéis vistos e se atualiza quando a listagem termina', TEST, async (t) => {
    const deadlines = [];
    const timers = {
      setTimeout(run) {
        const handle = { run, unref() { return this; } };
        deadlines.push(handle);
        return handle;
      },
      clearTimeout(handle) {
        const i = deadlines.indexOf(handle);
        if (i >= 0) deadlines.splice(i, 1);
      },
    };
    const pending = [];
    const list = (folder) => new Promise((resolve) => pending.push({ folder, resolve }));
    const local = await startLocal(t, { reader: null, pipeline: { readerOptions: { list, timers } } });
    const client = await connected(local.port);
    const S = sid(960);
    const W = { id: aid(960), type: 'dev-frontend' };
    assert.equal((await local.send(pre(S, tid('Lento1'), W))).status, 204);
    const first = await client.waitFor((m) => m.data?.event?.kind === 'tool.started');
    assert.deepEqual(first.data.session.roster, ['orq', 'dev'], 'papéis vistos');
    await waitFor(() => pending.length === 1, { label: 'listagem da pasta do projeto' });
    // O prazo vence: o read resolve com [], sem mudar o roster.
    for (const handle of deadlines.splice(0)) handle.run();
    await new Promise((r) => setTimeout(r, 20));
    const before = client.numbered().length;
    // A listagem do projeto termina tarde; depois a da pasta pessoal.
    pending.shift().resolve(['tester.md']);
    await waitFor(() => pending.length === 1, { label: 'listagem da pasta pessoal' });
    pending.shift().resolve(['arquiteto.md']);
    const update = await client.waitFor((m) => m.event === 'update' && m.data.event === null && m.data.session.roster.includes('arq'), { label: 'roster depois da listagem tardia' });
    assert.deepEqual(update.data.session.roster, ['orq', 'arq', 'dev', 'tes']);
    assert.equal(update.data.seq, client.numbered()[before - 1].data.seq + 1, 'numerado em sequência');
    assertSameAsState(replay(client.messages), await local.state());
  });
});
