// Conexão ao vivo (web/js/connection.js) com EventSource, fetch e
// temporizadores falsos: selo, snapshot, updates, lacuna com /api/state,
// troca de execução do servidor e reabertura.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PENDING_LIMIT, RESYNC_RETRY_MS, RETRY_FIRST_MS, RETRY_MAX_MS, connect, frameBatcher } from '../../../web/js/connection.js';
import { createStore } from '../../../web/js/store.js';
import { loadSnapshot, makeEvent } from './support.js';

/** Classe de EventSource falsa, com as instâncias criadas. */
function fakeEventSourceClass() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.listeners = new Map();
      instances.push(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    close() {
      this.readyState = 2;
      this.closed = true;
    }
    emit(type, data) {
      const event = data === undefined ? {} : { data: typeof data === 'string' ? data : JSON.stringify(data) };
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    /** Conexão aberta. */
    open() {
      this.readyState = 1;
      this.emit('open');
    }
    /** Conexão caiu; o navegador vai tentar de novo sozinho. */
    drop() {
      this.readyState = 0;
      this.emit('error');
    }
    /** Conexão fechada de vez (resposta que não é SSE, 503...). */
    fail() {
      this.readyState = 2;
      this.emit('error');
    }
  }
  return { FakeEventSource, instances };
}

/** Temporizadores falsos: guardam as chamadas e rodam sob comando. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    delays: () => [...pending.values()].map((t) => t.ms),
    runAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, timer] of due) timer.fn();
    },
  };
}

/** fetch falso: cada chamada fica pendente até o teste responder. */
function fakeFetch() {
  const calls = [];
  const fetch = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, resolve, reject });
  });
  const respond = async (index, body, status = 200) => {
    calls[index].resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
    await flush();
  };
  const fail = async (index) => {
    calls[index].reject(new Error('fetch failed'));
    await flush();
  };
  return { fetch, calls, respond, fail };
}

/** Deixa as promessas pendentes andarem. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Monta a conexão com todos os falsos. */
function setup() {
  const { FakeEventSource, instances } = fakeEventSourceClass();
  const timers = fakeTimers();
  const http = fakeFetch();
  const store = createStore();
  const statuses = [];
  let changes = 0;
  const connection = connect({
    store,
    onChange: () => { changes++; },
    onStatus: (state) => statuses.push(state),
    EventSource: FakeEventSource,
    fetch: http.fetch,
    timers,
  });
  return { connection, store, statuses, timers, http, instances, source: () => instances.at(-1), changes: () => changes };
}

const SNAPSHOT = loadSnapshot('primeira-luz');
const SESSION = SNAPSHOT.sessions[0];
const { feed: _feed, ...SESSION_STATE } = SESSION;

/** Update com seq e rótulo próprios. */
function update(seq, label = `passo ${seq}`) {
  return { seq, event: { ...makeEvent('tool.started', { tool: 'Read', category: 'read', target: `a${seq}.js` }, 'main', seq), sessionId: SESSION.id }, session: { ...SESSION_STATE, label } };
}

/** Conexão aberta, com hello e snapshot (seq 121). */
function live(runId = 'run-a') {
  const ctx = setup();
  ctx.source().open();
  ctx.source().emit('hello', { protocol: 1, runId, seq: 121, serverVersion: '0.1.0' });
  ctx.source().emit('snapshot', SNAPSHOT);
  return ctx;
}

describe('connect: selo de conexão', () => {
  it('abre EventSource("/events") e começa em "conectando"', () => {
    const { instances, statuses } = setup();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].url, '/events');
    assert.deepEqual(statuses, ['connecting']);
  });

  it('aberta: ao vivo; caiu: reconectando; voltou: ao vivo', () => {
    const { source, statuses } = setup();
    source().open();
    source().drop();
    source().open();
    assert.deepEqual(statuses, ['connecting', 'live', 'reconnecting', 'live']);
  });

  it('fechada de vez: desconectado, e reabre com espera crescente até 30 s', () => {
    const { source, statuses, timers, instances } = setup();
    source().fail();
    assert.deepEqual(statuses, ['connecting', 'offline']);
    assert.ok(instances[0].closed);
    const delays = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      delays.push(...timers.delays());
      timers.runAll();
      source().fail();
    }
    assert.deepEqual(delays, [RETRY_FIRST_MS, 4_000, 8_000, 16_000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
    assert.equal(instances.length, 8);
    instances[6].open();
    assert.equal(statuses.at(-1), 'offline', 'instância já descartada não muda o selo');
    assert.deepEqual(statuses.slice(-1), ['offline'], 'continua desconectado durante as tentativas');
    timers.runAll();
    source().open();
    assert.equal(statuses.at(-1), 'live');
    source().fail();
    assert.deepEqual(timers.delays(), [RETRY_FIRST_MS], 'abrir de novo zera a espera');
  });

  it('eventos de uma conexão substituída são ignorados', () => {
    const { source, timers, store, instances, statuses } = setup();
    const first = source();
    first.fail();
    timers.runAll();
    first.emit('snapshot', SNAPSHOT);
    first.open();
    assert.equal(store.seq, null);
    assert.equal(statuses.at(-1), 'offline');
    assert.equal(instances.length, 2);
  });

  it('close(): fecha a conexão, cancela tentativas e ignora o resto', () => {
    const { connection, source, timers, statuses, store } = setup();
    const current = source();
    current.fail();
    connection.close();
    assert.equal(timers.pending.size, 0);
    assert.equal(connection.state(), 'offline');
    current.emit('snapshot', SNAPSHOT);
    assert.equal(store.seq, null);
    assert.equal(statuses.at(-1), 'offline');
  });
});

describe('connect: mensagens', () => {
  it('hello e snapshot preenchem o store e pedem redesenho', () => {
    const { store, changes } = live();
    assert.equal(store.runId, 'run-a');
    assert.equal(store.seq, 121);
    assert.equal(store.sessions.size, 1);
    assert.equal(changes(), 1);
  });

  it('update em ordem pede redesenho; repetido ou velho, não', () => {
    const ctx = live();
    ctx.source().emit('update', update(122));
    assert.equal(ctx.changes(), 2);
    ctx.source().emit('update', update(122, 'repetido'));
    ctx.source().emit('update', update(50, 'velho'));
    assert.equal(ctx.changes(), 2);
    assert.equal(ctx.store.sessions.get(SESSION.id)?.label, 'passo 122');
    assert.equal(ctx.http.calls.length, 0);
  });

  it('session-removed em ordem tira a sessão', () => {
    const ctx = live();
    ctx.source().emit('session-removed', { seq: 122, sessionId: SESSION.id });
    assert.equal(ctx.store.sessions.size, 0);
    assert.equal(ctx.changes(), 2);
  });

  it('JSON inválido e mensagem vazia são ignorados sem erro', () => {
    const ctx = live();
    ctx.source().emit('update', '{quebrado');
    ctx.source().emit('snapshot', 'null');
    ctx.source().emit('hello', '[');
    ctx.source().emit('session-removed', '');
    assert.equal(ctx.store.seq, 121);
    assert.equal(ctx.changes(), 1);
  });
});

describe('connect: lacuna e /api/state', () => {
  it('lacuna busca /api/state; o que chega durante a busca é reaplicado em ordem', async () => {
    const ctx = live();
    ctx.source().emit('update', update(123));
    assert.equal(ctx.http.calls.length, 1);
    assert.equal(ctx.http.calls[0].url, '/api/state');
    assert.equal(ctx.http.calls[0].init.cache, 'no-store');
    ctx.source().emit('update', update(125));
    ctx.source().emit('update', update(124));
    assert.equal(ctx.store.seq, 121, 'nada é aplicado durante a busca');
    const state = { seq: 123, sessions: [{ ...SESSION, label: 'do /api/state' }] };
    await ctx.http.respond(0, state);
    assert.equal(ctx.store.seq, 125);
    assert.equal(ctx.store.sessions.get(SESSION.id)?.label, 'passo 125');
    assert.equal(ctx.http.calls.length, 1, 'uma busca só');
    assert.ok(ctx.changes() >= 2);
  });

  it('busca que falha tenta de novo depois de um tempo', async () => {
    const ctx = live();
    ctx.source().emit('update', update(123));
    await ctx.http.fail(0);
    assert.deepEqual(ctx.timers.delays(), [RESYNC_RETRY_MS]);
    ctx.timers.runAll();
    assert.equal(ctx.http.calls.length, 2);
    await ctx.http.respond(1, { seq: 123, sessions: [SESSION] });
    assert.equal(ctx.store.seq, 123);
    assert.equal(ctx.timers.pending.size, 0);
  });

  it('resposta de erro (404 antes do T9a) também tenta de novo', async () => {
    const ctx = live();
    ctx.source().emit('session-removed', { seq: 130, sessionId: SESSION.id });
    await ctx.http.respond(0, { erro: true }, 404);
    assert.equal(ctx.store.seq, 121);
    assert.deepEqual(ctx.timers.delays(), [RESYNC_RETRY_MS]);
  });

  it('snapshot do SSE durante a busca vale mais que a resposta da busca', async () => {
    const ctx = live();
    ctx.source().emit('update', update(130));
    ctx.source().emit('snapshot', { seq: 131, sessions: [{ ...SESSION, label: 'snapshot novo' }] });
    await ctx.http.respond(0, { seq: 129, sessions: [] });
    assert.equal(ctx.store.seq, 131);
    assert.equal(ctx.store.sessions.get(SESSION.id)?.label, 'snapshot novo');
  });

  it('servidor reiniciado (outro runId): o pendente da execução anterior é descartado', async () => {
    const ctx = live('run-a');
    ctx.source().emit('update', update(140));
    ctx.source().drop();
    ctx.source().open();
    ctx.source().emit('hello', { protocol: 1, runId: 'run-b', seq: 2, serverVersion: '0.1.0' });
    const fresh = loadSnapshot('neutro');
    ctx.source().emit('snapshot', fresh);
    await ctx.http.respond(0, { seq: 200, sessions: [SESSION] });
    assert.equal(ctx.store.runId, 'run-b');
    assert.equal(ctx.store.seq, 1);
    assert.deepEqual([...ctx.store.sessions.keys()], [fresh.sessions[0].id]);
    ctx.source().emit('update', { seq: 2, event: null, session: { ...fresh.sessions[0], label: 'run-b' } });
    assert.equal(ctx.store.sessions.get(fresh.sessions[0].id)?.label, 'run-b');
  });

  it(`pendente acima de ${PENDING_LIMIT} mensagens é descartado e a busca resolve`, async () => {
    const ctx = live();
    for (let seq = 123; seq <= 123 + PENDING_LIMIT + 5; seq++) ctx.source().emit('update', update(seq));
    await ctx.http.respond(0, { seq: 123 + PENDING_LIMIT + 5, sessions: [SESSION] });
    assert.equal(ctx.store.seq, 123 + PENDING_LIMIT + 5);
  });
});

describe('frameBatcher', () => {
  it('várias mudanças no mesmo quadro viram um redesenho', () => {
    const frames = [];
    let renders = 0;
    const schedule = frameBatcher((callback) => frames.push(callback), () => { renders++; });
    schedule();
    schedule();
    schedule();
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(renders, 1);
    schedule();
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(renders, 2);
  });
});
