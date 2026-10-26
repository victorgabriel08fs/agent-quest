// Ligação da sonda de contexto (T15; modelo de eventos, seção 6, "Contexto"):
// `tool.finished`, Stop, SubagentStop e PostCompact pedem a leitura do
// transcript do agente; o resultado chega como `update` com `context.usage`.
// Cenários SINTÉTICOS (formato do ADR 0010). Nenhum teste lê a pasta real
// ~/.claude/projects: a raiz e a leitura são injetadas, ou a pasta pessoal é
// temporária.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers';
import { createPipeline } from '../../../server/pipeline.js';
import { IDLE_TTL_MS } from '../../../server/domain/state/sessions.js';
import { READ_INTERVAL_MS } from '../../../server/usage/transcript-usage.js';
import { scenarioEnvelopes } from './domain/scenarios.js';
import { HOME, PROJECT, START, agent, scenario, sessionId } from './domain/state/scenarios.js';
import { tempDir } from './helpers.js';

const SID = sessionId('principal');
const T = agent('contexto-ligacao', 'tester');
const PROJECTS = `${HOME}\\.claude\\projects\\c--Users-fulana-Projetos`;
const MAIN_TRANSCRIPT = `${PROJECTS}\\${SID}.jsonl`;
const USAGE = { pct: 40, usedTokens: 80_000, windowTokens: 200_000 };

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Temporizadores falsos da sonda. */
function fakeTimers() {
  const pending = new Set();
  return {
    timers: {
      setTimeout(run, ms) {
        const handle = { run, ms, unref() { return this; } };
        pending.add(handle);
        return handle;
      },
      clearTimeout: (handle) => pending.delete(handle),
    },
    pending: () => [...pending],
    fire() {
      const all = [...pending];
      pending.clear();
      for (const handle of all) handle.run();
    },
  };
}

/** Pipeline com leitura falsa (responde `USAGE`, ou o que o teste mandar) e publicador que guarda as mensagens. */
function setup({ answer = () => USAGE, usageOptions = {}, ...options } = {}) {
  let now = START;
  const messages = [];
  const errors = [];
  const reads = [];
  const probeTimers = fakeTimers();
  const pipeline = createPipeline({
    runId: 'run15',
    homeDir: HOME,
    reader: { read: async () => [] },
    clock: () => now,
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    logError: (message) => errors.push(message),
    usageOptions: {
      root: `${HOME}\\.claude\\projects`,
      read: async (file, opts) => {
        reads.push({ file, ...opts });
        return answer(file, opts);
      },
      timers: probeTimers.timers,
      ...usageOptions,
    },
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
    reads,
    probeTimers,
    setClock: (value) => (now = value),
    feed(scn, { start = START } = {}) {
      return scenarioEnvelopes(scn, { start }).map(({ envelope, receivedAt }) => pipeline.handleEnvelope(envelope, { receivedAt }));
    },
  };
}

describe('ligação da sonda de contexto: quando lê', () => {
  it('tool.finished da sessão principal lê o transcript_path, com o modelo pedido no SessionStart; Pre e Failure não leem', async () => {
    const { feed, pipeline, reads } = setup();
    feed(scenario('ctx-main', 'ferramentas da sessão principal', (b) => {
      b.sessionStart('startup', { model: 'claude-opus-5-5[1m]' });
      b.prompt('Rode os testes');
      const read = b.call('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
      b.pre(read);
      b.tool('Bash', { command: 'node -e "process.exit(3)"' }, { error: 'Exit code 3' });
    }));
    await pipeline.settled();
    assert.deepEqual(reads, [], 'Pre e Failure não pedem leitura');
    feed(scenario('ctx-main-post', 'Post', (b) => b.post(b.call('Read', { file_path: 'x' }))), { start: START + 100 });
    await pipeline.settled();
    assert.deepEqual(reads, [{ file: MAIN_TRANSCRIPT, root: `${HOME}\\.claude\\projects`, model: 'claude-opus-5-5[1m]', main: true }]);
  });

  it('tool.finished de subagente lê <pasta do transcript>/<session_id>/subagents/agent-<agent_id>.jsonl, sem o modelo da sessão', async () => {
    const { feed, pipeline, reads } = setup();
    feed(scenario('ctx-sub', 'ferramenta do subagente', (b) => {
      b.sessionStart();
      b.start(T);
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: T });
    }));
    await pipeline.settled();
    assert.deepEqual(reads, [{ file: `${PROJECTS}\\${SID}\\subagents\\agent-${T.id}.jsonl`, root: `${HOME}\\.claude\\projects`, model: null, main: false }]);
  });

  it('SubagentStop lê o agent_transcript_path; Stop e PostCompact leem o da sessão principal', async () => {
    const { feed, pipeline, reads, probeTimers } = setup();
    feed(scenario('ctx-fim', 'fim de subagente, de turno e compactação', (b) => {
      b.sessionStart();
      b.prompt('Peça ao tester');
      b.start(T);
      b.stopAgent(T);
    }));
    await pipeline.settled();
    assert.deepEqual(reads.map((item) => [item.file, item.main]), [[`${PROJECTS}\\${SID}\\subagents\\agent-${T.id}.jsonl`, false]]);
    feed(scenario('ctx-stop', 'Stop', (b) => b.stop()), { start: START + 100 });
    await pipeline.settled();
    assert.deepEqual(reads.at(-1), { file: MAIN_TRANSCRIPT, root: `${HOME}\\.claude\\projects`, model: 'claude-opus-5-5', main: true });
    // PostCompact dentro de 5 s: fica para o fim do intervalo.
    feed(scenario('ctx-compact', 'PostCompact', (b) => b.raw('PostCompact', { trigger: 'manual' })), { start: START + 200 });
    await pipeline.settled();
    assert.equal(reads.length, 2);
    assert.equal(probeTimers.pending().length, 1);
    probeTimers.fire();
    await pipeline.settled();
    assert.equal(reads.length, 3);
    assert.equal(reads[2].file, MAIN_TRANSCRIPT);
  });

  it('no máximo uma leitura por agente a cada 5 s: várias ferramentas seguidas viram uma leitura agora e uma no fim do intervalo', async () => {
    const { feed, pipeline, reads, probeTimers, setClock } = setup();
    feed(scenario('ctx-rajada', 'rajada de ferramentas', (b) => {
      b.sessionStart();
      for (let i = 0; i < 10; i++) b.tool('Read', { file_path: `f${i}.js` });
    }));
    await pipeline.settled();
    assert.equal(reads.length, 1);
    assert.equal(probeTimers.pending().length, 1);
    assert.equal(probeTimers.pending()[0].ms, READ_INTERVAL_MS);
    setClock(START + READ_INTERVAL_MS);
    probeTimers.fire();
    await pipeline.settled();
    assert.equal(reads.length, 2);
    assert.equal(probeTimers.pending().length, 0);
  });

  it('agente que o estado descarta (interno, sem tipo) não gera leitura; transcript_path ausente também não', async () => {
    const { pipeline, reads } = setup();
    const internal = { id: 'ainterno0000000001', type: '' };
    const scn = scenario('ctx-interno', 'agente interno e evento sem transcript', (b) => {
      b.stopAgent(internal);
      b.sessionStart();
    });
    for (const { envelope, receivedAt } of scenarioEnvelopes(scn, { start: START })) {
      delete envelope.payload.transcript_path;
      delete envelope.payload.agent_transcript_path;
      pipeline.handleEnvelope(envelope, { receivedAt });
    }
    const [stop] = scenarioEnvelopes(scenario('ctx-sem-caminho', 'Stop sem caminho', (b) => b.stop()), { start: START + 10 });
    delete stop.envelope.payload.transcript_path;
    pipeline.handleEnvelope(stop.envelope, { receivedAt: stop.receivedAt });
    await pipeline.settled();
    assert.deepEqual(reads, []);
  });

  it('com a raiz null, a sonda fica desligada', async () => {
    const { feed, pipeline, reads } = setup({ usageOptions: { root: null } });
    feed(scenario('ctx-off', 'Stop', (b) => {
      b.sessionStart();
      b.stop();
    }));
    await pipeline.settled();
    assert.deepEqual(reads, []);
  });

  it('sem pasta pessoal, a sonda padrão fica desligada', async () => {
    const pipeline = createPipeline({ runId: 'r', homeDir: null, reader: { read: async () => [] }, timers: { setInterval: () => ({}), clearInterval: () => {} } });
    for (const { envelope, receivedAt } of scenarioEnvelopes(scenario('ctx-sem-home', 'Stop', (b) => {
      b.sessionStart();
      b.stop();
    }), { start: START })) {
      assert.equal(pipeline.handleEnvelope(envelope, { receivedAt }), true);
    }
    await pipeline.settled();
    assert.ok(pipeline.snapshot().sessions[0].agents.every((item) => item.context === null));
  });
});

describe('ligação da sonda de contexto: o resultado', () => {
  it('chega num update com context.usage e o context do agente, com o seq seguinte', async () => {
    const { feed, pipeline, messages } = setup();
    feed(scenario('ctx-update', 'Stop', (b) => {
      b.sessionStart();
      b.stop();
    }));
    const before = messages.at(-1).seq;
    await pipeline.settled();
    const last = messages.at(-1);
    assert.equal(last.seq, before + 1);
    assert.equal(last.event.kind, 'context.usage');
    assert.equal(last.event.agentKey, 'main');
    assert.deepEqual(last.event.data, USAGE);
    assert.equal(last.event.id, `run15:${last.seq}`);
    const main = last.session.agents.find((item) => item.key === 'main');
    assert.deepEqual(main.context, { ...USAGE, at: START });
    assert.ok(!('feed' in last.session));
    // Fora do feed do snapshot.
    assert.ok(pipeline.snapshot().sessions[0].feed.every((event) => event.kind !== 'context.usage'));
    assert.equal(pipeline.snapshot().seq, last.seq);
  });

  it('leitura null com context já null não publica nada; depois de um valor, publica update sem evento', async () => {
    let answer = null;
    const { feed, pipeline, messages, probeTimers, setClock } = setup({ answer: () => answer });
    feed(scenario('ctx-null', 'Stop', (b) => {
      b.sessionStart();
      b.stop();
    }));
    const count = messages.length;
    await pipeline.settled();
    assert.equal(messages.length, count, 'null sobre null: nada');

    answer = USAGE;
    setClock(START + READ_INTERVAL_MS);
    feed(scenario('ctx-valor', 'Stop', (b) => b.stop()), { start: START + READ_INTERVAL_MS });
    await pipeline.settled();
    assert.equal(messages.at(-1).event?.kind, 'context.usage');

    answer = null;
    setClock(START + 2 * READ_INTERVAL_MS);
    feed(scenario('ctx-some', 'Stop', (b) => b.stop()), { start: START + 2 * READ_INTERVAL_MS });
    await pipeline.settled();
    assert.equal(probeTimers.pending().length, 0);
    const last = messages.at(-1);
    assert.equal(last.event, null);
    assert.equal(last.session.agents.find((item) => item.key === 'main').context, null);
  });

  it('a leitura nunca trava nem derruba o envelope: leitura pendurada não segura o handleEnvelope; erro vira null', async () => {
    const { feed } = setup({ usageOptions: { read: () => new Promise(() => {}) } });
    const accepted = feed(scenario('ctx-pendurada', 'Stop', (b) => {
      b.sessionStart();
      b.stop();
      b.prompt('Outro pedido');
    }));
    assert.deepEqual(accepted, [true, true, true]);

    const failing = setup({ usageOptions: { read: () => { throw new Error('falha com CONTEUDO'); } } });
    assert.deepEqual(failing.feed(scenario('ctx-erro', 'Stop', (b) => {
      b.sessionStart();
      b.stop();
    })), [true, true]);
    await failing.pipeline.settled();
    assert.deepEqual(failing.errors, []);
  });

  it('erro ao aplicar o resultado vai ao log só com o tipo, e o pipeline segue', async () => {
    const { feed, pipeline, errors } = setup({ answer: () => { throw new TypeError('CONTEUDO'); } });
    feed(scenario('ctx-log', 'Stop', (b) => {
      b.sessionStart();
      b.stop();
    }));
    await pipeline.settled();
    // A leitura que lança vira null (nada a aplicar), sem log de conteúdo.
    assert.ok(errors.every((message) => !message.includes('CONTEUDO')));
  });

  it('sessão que sai da memória: a sonda esquece o agente e cancela a leitura agendada', async () => {
    const { feed, pipeline, messages, probeTimers, setClock } = setup();
    feed(scenario('ctx-limpeza', 'Stop duas vezes', (b) => {
      b.sessionStart();
      b.stop();
      b.stop();
    }));
    await pipeline.settled();
    assert.equal(probeTimers.pending().length, 1);
    setClock(START + IDLE_TTL_MS + 60_000);
    pipeline.runTick();
    assert.equal(messages.at(-1).type, 'session-removed');
    assert.equal(probeTimers.pending().length, 0);
  });
});

describe('ligação da sonda de contexto com a leitura real (pasta pessoal temporária)', () => {
  const temp = tempDir('agent-quest-ctx-');
  after(() => temp.cleanup());
  const home = temp.dir;
  const projectDir = path.join(home, '.claude', 'projects', 'c--Projetos-projeto-ficticio');
  mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, `${SID}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'RESPOSTA-SINTETICA' }], usage: { input_tokens: 500, cache_creation_input_tokens: 4500, cache_read_input_tokens: 95_000, output_tokens: 10 } },
  })}\n`);
  const outside = path.join(home, 'fora', `${SID}.jsonl`);
  mkdirSync(path.dirname(outside), { recursive: true });
  writeFileSync(outside, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 123 } } })}\n`);

  /** Envelope de Stop com o transcript_path dado. */
  const stop = (file, sentAt) => ({
    v: 1, sentAt, forwarder: '0.1.2', env: { projectDir: PROJECT, entrypoint: 'cli' }, truncated: false,
    payload: { hook_event_name: 'Stop', session_id: SID, transcript_path: file, cwd: PROJECT, stop_hook_active: false, background_tasks: [] },
  });

  function realPipeline() {
    const messages = [];
    const pipeline = createPipeline({ runId: 'real15', homeDir: home, reader: { read: async () => [] }, clock: () => START, timers: { setInterval: () => ({}), clearInterval: () => {} } });
    pipeline.attach({ publishUpdate: (message) => messages.push(message), publishRemoved: (message) => messages.push(message) });
    return { pipeline, messages };
  }

  it('transcript dentro de <home>/.claude/projects: o update leva o uso calculado', async () => {
    const { pipeline, messages } = realPipeline();
    pipeline.handleEnvelope(stop(transcript, START), { receivedAt: START });
    await pipeline.settled();
    const last = messages.at(-1);
    assert.equal(last.event.kind, 'context.usage');
    // Resposta em claude-opus-5-5, com 1M nativo (seção 6, "Janela").
    assert.deepEqual(last.event.data, { pct: 10, usedTokens: 100_000, windowTokens: 1_000_000 });
  });

  it('transcript fora de <home>/.claude/projects: não é lido, e o context fica null', async () => {
    const { pipeline, messages } = realPipeline();
    pipeline.handleEnvelope(stop(outside, START), { receivedAt: START });
    await pipeline.settled();
    await flush();
    assert.ok(messages.every((message) => message.event?.kind !== 'context.usage'));
    assert.equal(pipeline.snapshot().sessions[0].agents[0].context, null);
  });
});
