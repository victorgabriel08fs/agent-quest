// Ligação de ponta a ponta (T9a, condições 5 e 6): envelope → normalize →
// apply → update; tick → update e session-removed; leitor de .claude/agents/
// assíncrono. Relógio e temporizadores injetados (ADR 0010, complemento "testes
// de tempo estáveis"). Cenários SINTÉTICOS no formato do ADR 0010.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2, pbkdf2Sync } from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { apply, tick } from '../../../server/domain/state/index.js';
import { STALE_AGENT_MS } from '../../../server/domain/state/agents.js';
import { IDLE_TTL_MS } from '../../../server/domain/state/sessions.js';
import { TICK_MS, createPipeline } from '../../../server/pipeline.js';
import { startServer } from '../../../server/main.js';
import { scenarioEnvelopes } from './domain/scenarios.js';
import { HOME, PROJECT, START, agent, scenario, sessionId } from './domain/state/scenarios.js';
import { request, tempDir } from './helpers.js';

const RUN_ID = 'run9a';
const SID = sessionId('principal');

/** Temporizadores falsos do tick: guardam o intervalo e o disparam quando o teste manda. */
function fakeIntervals() {
  const intervals = new Set();
  const cleared = [];
  return {
    timers: {
      setInterval(run, ms) {
        const handle = { run, ms, unref() { this.unrefed = true; return this; } };
        intervals.add(handle);
        return handle;
      },
      clearInterval(handle) {
        intervals.delete(handle);
        cleared.push(handle);
      },
    },
    fire() {
      for (const handle of intervals) handle.run();
    },
    active: () => [...intervals],
    cleared,
  };
}

/** Leitor falso de .claude/agents/: cada leitura espera o teste responder. */
function manualReader() {
  const calls = [];
  return {
    calls,
    reader: {
      read(dir) {
        return new Promise((resolve) => calls.push({ dir, resolve }));
      },
    },
  };
}

/** Pipeline com publicador que guarda as mensagens. */
function setup(options = {}) {
  const messages = [];
  const errors = [];
  let now = START;
  const intervals = fakeIntervals();
  const pipeline = createPipeline({
    runId: RUN_ID,
    homeDir: HOME,
    reader: { read: async () => [] },
    clock: () => now,
    timers: intervals.timers,
    logError: (message) => errors.push(message),
    ...options,
  });
  pipeline.attach({
    publishUpdate: (message) => messages.push({ type: 'update', ...message }),
    publishRemoved: (message) => messages.push({ type: 'session-removed', ...message }),
  });
  return {
    pipeline,
    messages,
    errors,
    intervals,
    setClock: (value) => (now = value),
    /** Passa um cenário, envelope por envelope, como a fila da ingestão. */
    feed(scn, { start = START } = {}) {
      return scenarioEnvelopes(scn, { start }).map(({ envelope, receivedAt }) => pipeline.handleEnvelope(envelope, { receivedAt }));
    },
  };
}

/** Cada mensagem recebe o seq anterior + 1; o seq e o id do evento são os do update. */
function assertNumbering(messages, first = 1) {
  messages.forEach((message, i) => {
    assert.equal(message.seq, first + i, `mensagem ${i} (${message.type})`);
    if (message.type === 'update' && message.event) {
      assert.equal(message.event.seq, message.seq);
      assert.equal(message.event.id, `${RUN_ID}:${message.seq}`);
      assert.equal(message.event.sessionId, message.session.id);
    }
    if (message.type === 'update') assert.ok(!('feed' in message.session), 'update sem feed');
  });
}

const T = agent('ligacao', 'tester');
const delegation = scenario('ligacao', 'delegação com ferramenta', (b) => {
  b.sessionStart();
  b.prompt('Peça ao tester');
  const call = b.delegation('tester', 'Testar');
  b.pre(call);
  b.start(T);
  b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: T });
  b.stopAgent(T);
  b.returned(call, T);
  b.stop();
});

describe('ligação de ponta a ponta: envelope → normalize → apply → update', () => {
  it('um update por evento, na ordem, com seq contínuo; o seq e o id do evento são os do update', () => {
    const { feed, messages, pipeline } = setup();
    assert.ok(feed(delegation).every((accepted) => accepted === true));
    const withEvent = messages.filter((message) => message.event);
    assert.deepEqual(withEvent.map((message) => message.event.kind), [
      'session.started', 'agent.delegated', 'agent.started', 'tool.started', 'tool.finished', 'agent.finished',
    ]);
    assertNumbering(messages);
    // O estado de cada update é o da sessão depois do fato.
    const started = messages.find((message) => message.event?.kind === 'tool.started');
    assert.equal(started.session.agents.find((item) => item.key === T.id).activity.state, 'running');
    assert.equal(pipeline.snapshot().seq, messages.at(-1).seq);
  });

  it('sessão alterada sem evento recebe update com event: null, pelo mesmo sequence', () => {
    const { feed, messages } = setup();
    feed(scenario('sem-evento', 'Notification e prompt', (b) => {
      b.notice('idle_prompt');
      b.prompt('Pedido');
      b.sessionStart();
    }));
    assert.deepEqual(messages.map((message) => [message.seq, message.event?.kind ?? null]), [
      [1, null],
      [2, null],
      [3, 'session.started'],
    ]);
    assertNumbering(messages);
  });

  it('fato descartado pelo normalizador: devolve false (ignored), sem publicar nem gastar seq', () => {
    const { pipeline, messages } = setup();
    const bad = [
      { v: 1, payload: { hook_event_name: 'Desconhecido', session_id: SID } },
      { v: 1, payload: { hook_event_name: 'PreToolUse', session_id: SID, agent_id: 'main' } },
      { v: 1, payload: { hook_event_name: 'PreToolUse', session_id: 'com espaço' } },
    ];
    for (const envelope of bad) assert.equal(pipeline.handleEnvelope(/** @type {any} */ (envelope), { receivedAt: START }), false);
    assert.deepEqual(messages, []);
    assert.equal(pipeline.snapshot().seq, 0);
    assert.equal(pipeline.sessionCount(), 0);
  });

  it('erro do reducer: relança para a fila contar como ignored, e a sessão recebe update sem evento', () => {
    let fail = false;
    const { feed, messages, pipeline } = setup({
      reducer: {
        apply: (state, fact, now) => {
          const result = apply(state, fact, now);
          if (fail) throw new TypeError('falha com CONTEUDO-SECRETO');
          return result;
        },
        tick,
      },
    });
    feed(scenario('erro-antes', 'sessão', (b) => b.sessionStart()));
    fail = true;
    const [envelope] = scenarioEnvelopes(scenario('erro', 'prompt', (b) => b.prompt('x')), { start: START + 10 });
    assert.throws(() => pipeline.handleEnvelope(envelope.envelope, { receivedAt: envelope.receivedAt }), TypeError);
    assert.deepEqual(messages.map((message) => [message.seq, message.event?.kind ?? null]), [[1, 'session.started'], [2, null]]);
    // O próximo evento segue numerado.
    fail = false;
    feed(scenario('erro-depois', 'outro', (b) => b.sessionEnd()), { start: START + 20 });
    assertNumbering(messages);
  });
});

describe('erro do reducer no primeiro evento de um projeto novo (B1 do tester)', () => {
  it('a pasta do projeto ainda é lida, uma vez, e o roster chega num update sem evento', async () => {
    let first = true;
    const reads = [];
    const { pipeline, messages } = setup({
      reader: { read: async (dir) => (reads.push(dir), ['arquiteto']) },
      reducer: {
        apply: (state, fact, now) => {
          const result = apply(state, fact, now);
          if (first) {
            first = false;
            throw new TypeError('falha no primeiro evento');
          }
          return result;
        },
        tick,
      },
    });
    const [one, two] = scenarioEnvelopes(scenario('b1', 'dois eventos do mesmo projeto', (b) => {
      b.sessionStart();
      b.prompt('x');
    }));
    assert.throws(() => pipeline.handleEnvelope(one.envelope, { receivedAt: one.receivedAt }), TypeError);
    pipeline.handleEnvelope(two.envelope, { receivedAt: two.receivedAt });
    await pipeline.settled();
    assert.deepEqual(reads, ['c:/Users/fulana/Projetos/agents-quest']);
    assert.deepEqual(messages.at(-1).session.roster, ['orq', 'arq']);
    // O session.started numerado (seq 1) se perdeu com o erro: o salto leva o painel ao /api/state.
    assertNumbering(messages, 2);
  });
});

describe('tick periódico', () => {
  it(`roda a cada ${TICK_MS} ms pelo timer injetado, com unref; start não duplica; stop desliga`, () => {
    const { pipeline, intervals } = setup();
    pipeline.start();
    pipeline.start();
    assert.equal(intervals.active().length, 1);
    assert.equal(intervals.active()[0].ms, TICK_MS);
    assert.equal(intervals.active()[0].unrefed, true);
    pipeline.stop();
    assert.equal(intervals.active().length, 0);
    assert.equal(intervals.cleared.length, 1);
    pipeline.stop();
    assert.equal(intervals.cleared.length, 1);
  });

  it('agent.finished, update sem evento e session-removed: o seq segue contínuo misturando os três', () => {
    const W = agent('parado-9a', 'tester');
    const { feed, messages, pipeline, intervals, setClock } = setup();
    const results = feed(scenario('tick', 'subagente que para', (b) => {
      b.prompt('x');
      b.tool('Read', { file_path: `${PROJECT}\\a.md` }, { who: W });
    }));
    assert.ok(results.every(Boolean));
    const last = START + 20;
    pipeline.start();
    const before = messages.length;
    setClock(last + STALE_AGENT_MS);
    intervals.fire();
    const afterStale = messages.slice(before);
    assert.deepEqual(afterStale.map((message) => [message.type, message.event?.kind ?? null]), [['update', 'agent.finished']]);
    setClock(last + IDLE_TTL_MS);
    intervals.fire();
    assert.deepEqual(messages.slice(before + 1).map((message) => [message.type, message.sessionId ?? message.session?.id]), [['session-removed', SID]]);
    assertNumbering(messages);
    assert.equal(pipeline.sessionCount(), 0);
    assert.deepEqual(pipeline.snapshot(), { seq: messages.at(-1).seq, sessions: [] });
  });

  it('active vira idle depois de 2 min: update sem evento', () => {
    const { feed, messages, pipeline, setClock } = setup();
    feed(scenario('idle', 'sessão parada', (b) => b.sessionStart()));
    setClock(START + 2 * 60_000);
    pipeline.runTick();
    assert.equal(messages.at(-1).event, null);
    assert.equal(messages.at(-1).session.status, 'idle');
    assertNumbering(messages);
  });

  it('erro no tick não lança: o log mostra só o tipo', () => {
    const { pipeline, errors } = setup({
      reducer: { apply, tick: () => { throw new RangeError('CONTEUDO-SECRETO'); } },
    });
    assert.doesNotThrow(() => pipeline.runTick());
    assert.deepEqual(errors, ['Erro no tick do estado: RangeError']);
  });
});

describe('snapshot', () => {
  it('é getSessionStates com o seq atual: sessões com feed, numeradas', () => {
    const { feed, messages, pipeline } = setup();
    feed(delegation);
    const snapshot = pipeline.snapshot();
    assert.equal(snapshot.seq, messages.at(-1).seq);
    assert.equal(snapshot.sessions.length, 1);
    assert.ok(Array.isArray(snapshot.sessions[0].feed));
    assert.ok(snapshot.sessions[0].feed.every((event) => event.id === `${RUN_ID}:${event.seq}` && event.seq <= snapshot.seq));
  });
});

describe('leitura de .claude/agents/ fora do apply (seção 7; T7, ponto 10)', () => {
  it('projeto novo: lê depois, e o roster novo chega num update sem evento, numerado em sequência', async () => {
    const manual = manualReader();
    const { feed, messages, pipeline } = setup({ reader: manual.reader });
    const R = agent('roster-9a', 'documentador');
    feed(scenario('roster', 'sessão com documentador', (b) => {
      b.sessionStart();
      b.tool('Read', { file_path: `${PROJECT}\\a.md` }, { who: R });
    }));
    assert.deepEqual(manual.calls.map((call) => call.dir), ['c:/Users/fulana/Projetos/agents-quest'], 'uma leitura por projeto');
    assert.deepEqual(messages.at(-1).session.roster, ['orq', 'doc'], 'até a leitura, só os papéis vistos');
    const before = messages.length;
    manual.calls[0].resolve(['arquiteto', 'tester']);
    await pipeline.settled();
    assert.equal(messages.length, before + 1);
    assert.equal(messages.at(-1).event, null);
    assert.deepEqual(messages.at(-1).session.roster, ['orq', 'arq', 'tes', 'doc']);
    assertNumbering(messages);
    // A mesma pasta não é lida de novo.
    feed(scenario('roster-2', 'outra sessão do projeto', (b) => {
      b.use('outra');
      b.sessionStart();
    }), { start: START + 1000 });
    assert.equal(manual.calls.length, 1);
    assert.deepEqual(messages.at(-1).session.roster, ['orq', 'arq', 'tes']);
  });

  it('leitura lenta não segura nada: o apply responde na hora, e o prazo vencido deixa só os papéis vistos', async () => {
    const pending = new Set();
    const timers = {
      setTimeout(run) {
        const handle = { run };
        pending.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        pending.delete(handle);
      },
    };
    const { createAgentNamesReader } = await import('../../../server/agent-names.js');
    const reader = createAgentNamesReader({ homeDir: null, timers, list: () => new Promise(() => {}) });
    const { feed, messages, pipeline } = setup({ reader });
    const results = feed(delegation);
    assert.ok(results.every(Boolean), 'todos os envelopes processados sem esperar a leitura');
    const before = messages.length;
    for (const handle of [...pending]) handle.run();
    await pipeline.settled();
    assert.equal(messages.length, before, 'nada mudou no roster: nenhum update');
    assert.deepEqual(pipeline.snapshot().sessions[0].roster, ['orq', 'tes']);
  });
});

describe('leitura atrasada: onLate do leitor em disco (ajuste de 19/10/2026)', () => {
  it('a listagem que termina depois do prazo atualiza o roster num update sem evento', async () => {
    const deadlines = new Set();
    const timers = {
      setTimeout(run) {
        const handle = { run };
        deadlines.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        deadlines.delete(handle);
      },
    };
    const held = [];
    const list = (folder) => new Promise((resolve) => held.push({ folder, resolve }));
    const { feed, messages, pipeline } = setup({ reader: undefined, readerOptions: { list, timers } });
    feed(scenario('atrasada', 'sessão', (b) => b.sessionStart()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(held.length, 1, 'uma listagem por vez: a pasta do projeto primeiro');
    for (const handle of [...deadlines]) handle.run();
    await pipeline.settled();
    const before = messages.length;
    assert.deepEqual(pipeline.snapshot().sessions[0].roster, ['orq'], 'prazo vencido: só os papéis vistos');
    held[0].resolve(['tester.md']);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(held.length, 2, 'a pasta pessoal sai da fila depois');
    assert.equal(messages.length, before, 'nada parcial antes da pasta pessoal');
    held[1].resolve(['arquiteto.md']);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages.length, before + 1);
    assert.equal(messages.at(-1).event, null);
    assert.deepEqual(messages.at(-1).session.roster, ['orq', 'arq', 'tes']);
    assertNumbering(messages);
  });
});

// ---------------------------------------------------------------------------
// startServer no mesmo processo: HTTP real, SSE real, estado real
// ---------------------------------------------------------------------------

/** Cliente SSE mínimo: guarda as mensagens (`event`, `id`, `data`) conforme chegam. */
function openEvents(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
      const messages = [];
      const waiters = [];
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
            if (colon <= 0) continue;
            message[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          if (message.data) message.data = JSON.parse(message.data);
          if (message.event) messages.push(message);
        }
        for (const waiter of [...waiters]) waiter();
      });
      resolve({
        status: res.statusCode,
        messages,
        close: () => req.destroy(),
        waitFor(predicate, timeoutMs = 3000) {
          return new Promise((done, fail) => {
            const check = () => {
              const found = messages.find(predicate);
              if (!found) return;
              clearTimeout(timer);
              waiters.splice(waiters.indexOf(check), 1);
              done(found);
            };
            const timer = setTimeout(() => fail(new Error(`mensagem não chegou: ${JSON.stringify(messages).slice(0, 500)}`)), timeoutMs);
            waiters.push(check);
            check();
          });
        },
      });
    });
    req.on('error', reject);
  });
}

describe('servidor real no mesmo processo (startServer)', () => {
  const homes = [];
  after(() => homes.forEach((home) => home.cleanup()));

  async function start() {
    const home = tempDir('aq-t9a-');
    homes.push(home);
    const intervals = fakeIntervals();
    let now = Date.now();
    const result = await startServer({
      argv: ['--port', '0'],
      env: { AGENT_QUEST_HOME: home.dir },
      logError: () => {},
      pipeline: { timers: intervals.timers, clock: () => now, reader: { read: async () => ['tester'] } },
    });
    assert.equal(result.status, 'started');
    return { ...result, intervals, setClock: (value) => (now = value) };
  }

  /** POST /hooks com o token, como o encaminhador. */
  function post(server, payload) {
    const body = JSON.stringify({ v: 1, sentAt: Date.now(), forwarder: 'teste', env: { projectDir: PROJECT, entrypoint: 'cli' }, truncated: false, payload });
    return request(server.port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': server.runtime.token },
      body,
    });
  }

  it('POST /hooks → update no SSE com o tool.started; /api/state igual ao snapshot; /api/health com sessions e clients', async () => {
    const server = await start();
    try {
      const sse = await openEvents(server.port);
      assert.equal(sse.status, 200);
      await sse.waitFor((message) => message.event === 'snapshot');
      const hello = sse.messages.find((message) => message.event === 'hello');
      const toolUseId = 'toolu_01ligacao9a';
      const res = await post(server, {
        hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Read', tool_use_id: toolUseId,
        tool_input: { file_path: `${PROJECT}\\CLAUDE.md` },
      });
      assert.equal(res.status, 204);
      const update = await sse.waitFor((message) => message.event === 'update' && message.data.event?.kind === 'tool.started');
      assert.equal(update.data.event.data.toolUseId, toolUseId);
      assert.equal(update.data.event.data.target, 'CLAUDE.md');
      assert.equal(update.id, `${hello.data.runId}:${update.data.seq}`);
      assert.equal(update.data.event.id, update.id);
      assert.equal(update.data.seq, hello.data.seq + 1);
      // O roster com o leitor injetado chega num update sem evento, logo depois.
      const roster = await sse.waitFor((message) => message.event === 'update' && message.data.event === null);
      assert.equal(roster.data.seq, update.data.seq + 1);
      assert.deepEqual(roster.data.session.roster, ['orq', 'tes']);

      const state = JSON.parse((await request(server.port, { path: '/api/state' })).body);
      assert.equal(state.seq, roster.data.seq);
      assert.deepEqual(state, server.pipeline.snapshot());
      assert.deepEqual(state.sessions.map((session) => session.id), [SID]);
      assert.ok(Array.isArray(state.sessions[0].feed), 'o /api/state leva o feed, como o snapshot');
      const health = JSON.parse((await request(server.port, { path: '/api/health' })).body);
      assert.equal(health.sessions, 1);
      assert.equal(health.clients, 1);
      assert.equal(health.events.ignored, 0);

      // Envelope que o normalizador descarta: 204, e conta como ignored.
      assert.equal((await post(server, { hook_event_name: 'Desconhecido', session_id: SID })).status, 204);
      await waitUntil(async () => JSON.parse((await request(server.port, { path: '/api/health' })).body).events.ignored === 1);
      sse.close();
    } finally {
      await server.close();
    }
  });

  it('o tick injetado publica session-removed com o seq seguinte; close desliga o tick', async () => {
    const server = await start();
    try {
      const sse = await openEvents(server.port);
      await sse.waitFor((message) => message.event === 'snapshot');
      assert.equal(server.intervals.active().length, 1, 'tick ligado no início');
      await post(server, { hook_event_name: 'SessionStart', session_id: SID, source: 'startup' });
      const started = await sse.waitFor((message) => message.data.event?.kind === 'session.started');
      await sse.waitFor((message) => message.event === 'update' && message.data.event === null);
      server.setClock(Date.now() + IDLE_TTL_MS + 60_000);
      server.intervals.fire();
      const removed = await sse.waitFor((message) => message.event === 'session-removed');
      assert.equal(removed.data.sessionId, SID);
      assert.equal(removed.data.seq, started.data.seq + 2);
      sse.close();
    } finally {
      await server.close();
    }
    assert.equal(server.intervals.active().length, 0, 'close desligou o tick');
  });
});

describe('pastas de rede presas não travam o servidor (ajuste de 19/10/2026)', () => {
  it('quatro projetos com a listagem presa numa thread do libuv: no máximo uma listagem, e os estáticos seguem saindo', async (t) => {
    // Calibração no próprio teste (ADR 0010): um pbkdf2 ocupa uma thread do
    // libuv como um readdir preso numa pasta de rede, por cerca de 1 s nesta máquina.
    const base = 2000;
    const begin = performance.now();
    pbkdf2Sync('agente', 'sal', base, 32, 'sha512');
    const iterations = Math.max(base, Math.round((base * 1000) / Math.max(performance.now() - begin, 0.5)));
    let active = 0;
    let maxActive = 0;
    let finished = 0;
    let released = false;
    const list = () => {
      if (released) return [];
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        pbkdf2('agente', 'sal', iterations, 32, 'sha512', () => {
          active--;
          finished++;
          resolve([]);
        });
      });
    };
    const home = tempDir('aq-t9a-presa-');
    const server = await startServer({
      argv: ['--port', '0'],
      env: { AGENT_QUEST_HOME: home.dir },
      homedir: home.dir,
      logError: () => {},
      pipeline: { readerOptions: { list, timeoutMs: 100 } },
    });
    try {
      for (let i = 1; i <= 4; i++) {
        const body = JSON.stringify({
          v: 1, sentAt: Date.now(), env: { projectDir: `D:\\Rede\\projeto-${i}` },
          payload: { hook_event_name: 'SessionStart', session_id: `sessao-presa-${i}`, source: 'startup' },
        });
        const res = await request(server.port, {
          method: 'POST', path: '/hooks', body,
          headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': server.runtime.token },
        });
        assert.equal(res.status, 204);
      }
      await waitUntil(async () => active === 1);
      const page = await request(server.port, { path: '/' });
      assert.equal(page.status, 200);
      assert.match(page.body, /<html/i);
      t.diagnostic(`pbkdf2 com ${iterations} iterações; listagens terminadas quando a página chegou: ${finished}`);
      assert.equal(finished, 0, 'a página saiu enquanto a primeira listagem presa ainda ocupava a thread');
      assert.equal(maxActive, 1, 'no máximo uma listagem em andamento');
      assert.equal(JSON.parse((await request(server.port, { path: '/api/health' })).body).sessions, 4);
    } finally {
      released = true;
      await server.close();
      await waitUntil(async () => active === 0, { timeoutMs: 15_000 });
      home.cleanup();
    }
  });
});

/** Espera uma condição assíncrona (sem relógio de teste: só repete a consulta). */
async function waitUntil(predicate, { timeoutMs = 3000 } = {}) {
  const limit = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > limit) throw new Error('condição não atendida a tempo');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
