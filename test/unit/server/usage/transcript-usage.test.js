// Sonda de contexto (T15; modelo de eventos, seção 6, "Contexto"). Transcripts
// SINTÉTICOS de test/fixtures/transcripts/*.json, gravados como .jsonl numa
// pasta temporária que faz o papel de `~/.claude/projects`. Nenhum teste lê a
// pasta real: a raiz é sempre injetada.

import { Buffer } from 'node:buffer';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WINDOW_TOKENS,
  EXTENDED_WINDOW_TOKENS,
  MAX_READ_BYTES,
  READ_INTERVAL_MS,
  contextUsage,
  createContextProbe,
  readContextUsage,
  transcriptPathFor,
} from '../../../../server/usage/transcript-usage.js';
import { tempDir } from '../helpers.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/transcripts/', import.meta.url));
const SID = '00000000-0000-4000-8000-000000000001';
const AID = 'a0000000000000001';

const temp = tempDir('agent-quest-transcripts-');
after(() => temp.cleanup());
/** Faz o papel de ~/.claude/projects. */
const ROOT = path.join(temp.dir, 'home', '.claude', 'projects');
const PROJECT_DIR = path.join(ROOT, 'c--Projetos-projeto-ficticio');
/** Fora da raiz permitida. */
const OUTSIDE = path.join(temp.dir, 'fora');
mkdirSync(PROJECT_DIR, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

/** Linhas de uma fixture em texto JSONL. */
function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + (lines.length ? '\n' : '');
}

function loadFixtures() {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')));
}

let files = 0;
/** Grava um transcript na pasta de projeto fictícia e devolve o caminho. */
function writeTranscript(content, { dir = PROJECT_DIR, name = `${SID}-${++files}.jsonl` } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

const assistantLine = (input, creation = 0, read = 0) => JSON.stringify({
  type: 'assistant',
  sessionId: SID,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'RESPOSTA-SINTETICA' }], usage: { input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: 1 } },
});
const fillerLine = (size) => JSON.stringify({ type: 'user', sessionId: SID, message: { role: 'user', content: 'x'.repeat(size) } });

describe('readContextUsage: transcripts sintéticos (test/fixtures/transcripts)', () => {
  const fixtures = loadFixtures();

  it('há fixtures, todas marcadas como sintéticas e no formato esperado', () => {
    assert.ok(fixtures.length >= 8);
    for (const fixture of fixtures) {
      assert.equal(fixture.synthetic, true, fixture.name);
      assert.match(fixture.description, /^SINTÉTICO: /, fixture.name);
      assert.ok(Array.isArray(fixture.lines), fixture.name);
      assert.ok(fixture.expected === null || typeof fixture.expected === 'object', fixture.name);
    }
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: ${fixture.description}`, async () => {
      const file = writeTranscript(jsonl(fixture.lines));
      const usage = await readContextUsage(file, { root: ROOT, ...fixture.options });
      assert.deepEqual(usage, fixture.expected);
    });
  }

  it('as fixtures não têm caminhos da pasta pessoal nem ids reais', () => {
    for (const name of readdirSync(FIXTURES).filter((item) => item.endsWith('.json'))) {
      const text = readFileSync(path.join(FIXTURES, name), 'utf8');
      assert.doesNotMatch(text, /[A-Za-z]:\\\\Users|\/Users\/|\/home\/|\.claude/i, name);
      for (const id of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) {
        assert.match(id, /^00000000-0000-4000-8000-\d{12}$/, `${name}: id ${id}`);
      }
    }
  });
});

describe('readContextUsage: cálculo (seção 6)', () => {
  it('usedTokens = input + cache_creation + cache_read; janela de 200 mil; pct inteiro de 0 a 100', () => {
    assert.deepEqual(contextUsage(80_000), { pct: 40, usedTokens: 80_000, windowTokens: DEFAULT_WINDOW_TOKENS });
    assert.deepEqual(contextUsage(200_000), { pct: 100, usedTokens: 200_000, windowTokens: DEFAULT_WINDOW_TOKENS });
    assert.deepEqual(contextUsage(1), { pct: 0, usedTokens: 1, windowTokens: DEFAULT_WINDOW_TOKENS });
  });

  it('acima de 200 mil, ou com o modelo pedido terminando em [1m], a janela é de 1 milhão; acima de 1 milhão, pct fica em 100', () => {
    assert.deepEqual(contextUsage(200_001), { pct: 20, usedTokens: 200_001, windowTokens: EXTENDED_WINDOW_TOKENS });
    assert.deepEqual(contextUsage(10_000, 'claude-opus-5-5[1m]'), { pct: 1, usedTokens: 10_000, windowTokens: EXTENDED_WINDOW_TOKENS });
    assert.deepEqual(contextUsage(10_000, 'claude-opus-5-5[1M]'), { pct: 1, usedTokens: 10_000, windowTokens: EXTENDED_WINDOW_TOKENS });
    assert.equal(contextUsage(10_000, 'claude-opus-5-5').windowTokens, DEFAULT_WINDOW_TOKENS);
    assert.equal(contextUsage(10_000, '[1m]-no-meio').windowTokens, DEFAULT_WINDOW_TOKENS);
    assert.equal(contextUsage(1_500_000).pct, 100);
  });
});

describe('readContextUsage: só os últimos 64 KiB', () => {
  it('uma resposta antes dos últimos 64 KiB não é vista; logo dentro deles, é', async () => {
    const usage = assistantLine(1000, 0, 49_000);
    const far = writeTranscript(`${usage}\n${fillerLine(MAX_READ_BYTES)}\n`);
    assert.equal(await readContextUsage(far, { root: ROOT }), null);
    const near = writeTranscript(`${fillerLine(MAX_READ_BYTES)}\n${usage}\n${fillerLine(MAX_READ_BYTES - usage.length - 200)}\n`);
    assert.deepEqual(await readContextUsage(near, { root: ROOT }), { pct: 25, usedTokens: 50_000, windowTokens: DEFAULT_WINDOW_TOKENS });
  });

  it('a linha partida no começo do trecho lido é descartada, mesmo que pareça ter usage', async () => {
    // A linha de usage começa antes da borda dos 64 KiB; o trecho lido pega só o fim dela.
    const tail = `"usage":{"input_tokens":7,"cache_read_input_tokens":0}}}`;
    const partial = `{"type":"assistant","message":{"role":"assistant","content":"${'y'.repeat(200)}",${tail}`;
    const fillerSize = MAX_READ_BYTES + 20 - partial.length - 2 - fillerLine(0).length;
    const content = `${partial}\n${fillerLine(fillerSize)}\n`;
    const start = Buffer.byteLength(content) - MAX_READ_BYTES;
    assert.ok(start > 0 && start < partial.indexOf('"usage"'), 'a borda dos 64 KiB cai antes do usage, dentro da linha');
    const file = writeTranscript(content);
    assert.equal(await readContextUsage(file, { root: ROOT }), null);
    // Controle: a mesma linha, lida inteira, conta.
    const whole = writeTranscript(`${partial}\n`);
    assert.deepEqual(await readContextUsage(whole, { root: ROOT }), contextUsage(7));
  });

  it('maxBytes nunca passa de 64 KiB', async () => {
    const file = writeTranscript(`${assistantLine(1000, 0, 49_000)}\n${fillerLine(MAX_READ_BYTES)}\n`);
    assert.equal(await readContextUsage(file, { root: ROOT, maxBytes: 10 * MAX_READ_BYTES }), null);
  });
});

describe('readContextUsage: só .jsonl dentro da raiz (caminho resolvido)', () => {
  const content = `${assistantLine(1000, 0, 49_000)}\n`;
  const expected = { pct: 25, usedTokens: 50_000, windowTokens: DEFAULT_WINDOW_TOKENS };

  it('dentro da raiz, em qualquer profundidade: lê', async () => {
    const nested = writeTranscript(content, { dir: path.join(PROJECT_DIR, SID, 'subagents'), name: `agent-${AID}.jsonl` });
    assert.deepEqual(await readContextUsage(nested, { root: ROOT }), expected);
  });

  it('fora da raiz: não lê, mesmo sendo um .jsonl válido', async () => {
    const outside = writeTranscript(content, { dir: OUTSIDE, name: 'fora.jsonl' });
    assert.equal(await readContextUsage(outside, { root: ROOT }), null);
    // A própria pasta acima da raiz também é fora.
    const above = writeTranscript(content, { dir: path.dirname(ROOT), name: 'acima.jsonl' });
    assert.equal(await readContextUsage(above, { root: ROOT }), null);
  });

  it('com .. que escapa da raiz: não lê', async () => {
    writeTranscript(content, { dir: OUTSIDE, name: 'escapa.jsonl' });
    const sneaky = path.join(PROJECT_DIR, '..', '..', '..', '..', 'fora', 'escapa.jsonl');
    assert.equal(await readContextUsage(sneaky, { root: ROOT }), null);
    const raw = `${PROJECT_DIR}${path.sep}..${path.sep}..${path.sep}..${path.sep}..${path.sep}fora${path.sep}escapa.jsonl`;
    assert.equal(await readContextUsage(raw, { root: ROOT }), null);
  });

  it('com .. que continua dentro da raiz: lê', async () => {
    const file = writeTranscript(content, { name: 'dentro.jsonl' });
    const winding = path.join(PROJECT_DIR, SID, '..', 'dentro.jsonl');
    assert.deepEqual(await readContextUsage(`${PROJECT_DIR}${path.sep}${SID}${path.sep}..${path.sep}dentro.jsonl`, { root: ROOT }), expected);
    assert.equal(path.resolve(winding), file);
  });

  it('junção ou link simbólico dentro da raiz que aponta para fora: não lê', async (t) => {
    const target = path.join(OUTSIDE, 'alvo');
    writeTranscript(content, { dir: target, name: 'alvo.jsonl' });
    const link = path.join(PROJECT_DIR, 'atalho');
    try {
      symlinkSync(target, link, 'junction');
    } catch {
      t.skip('sem permissão para criar junção nesta máquina');
      return;
    }
    assert.equal(await readContextUsage(path.join(link, 'alvo.jsonl'), { root: ROOT }), null);
  });

  it('outra extensão, pasta com nome .jsonl, caminho relativo, raiz ausente ou valores que não são texto: null, sem exceção', async () => {
    const json = writeTranscript(content, { name: 'transcript.json' });
    const txt = writeTranscript(content, { name: 'transcript.jsonl.txt' });
    const folder = path.join(PROJECT_DIR, 'pasta.jsonl');
    mkdirSync(folder, { recursive: true });
    const valid = writeTranscript(content, { name: 'valido.jsonl' });
    const cases = [
      [json, { root: ROOT }],
      [txt, { root: ROOT }],
      [folder, { root: ROOT }],
      [path.relative(process.cwd(), valid), { root: ROOT }],
      ['projeto/x.jsonl', { root: ROOT }],
      [valid, { root: null }],
      [valid, { root: path.relative(process.cwd(), ROOT) }],
      [valid, { root: path.join(temp.dir, 'nao-existe') }],
      [`${valid}\0.jsonl`, { root: ROOT }],
      [null, { root: ROOT }],
      [undefined, { root: ROOT }],
      [42, { root: ROOT }],
      [{ path: valid }, { root: ROOT }],
      ['', { root: ROOT }],
      [ROOT, { root: ROOT }],
    ];
    for (const [file, options] of cases) {
      await assert.doesNotReject(readContextUsage(/** @type {any} */ (file), /** @type {any} */ (options)));
      assert.equal(await readContextUsage(/** @type {any} */ (file), /** @type {any} */ (options)), null, String(file));
    }
    // Controle: o mesmo arquivo, com a raiz certa, é lido.
    assert.deepEqual(await readContextUsage(valid, { root: ROOT }), expected);
  });

  it('arquivo ausente: null, sem exceção', async () => {
    const missing = path.join(PROJECT_DIR, 'nao-existe.jsonl');
    await assert.doesNotReject(readContextUsage(missing, { root: ROOT }));
    assert.equal(await readContextUsage(missing, { root: ROOT }), null);
  });
});

describe('transcriptPathFor (seção 6)', () => {
  const main = path.join(PROJECT_DIR, `${SID}.jsonl`);

  it('sessão principal: o transcript_path', () => {
    assert.equal(transcriptPathFor({ agentKey: 'main', sessionId: SID, transcriptPath: main }), main);
    assert.equal(transcriptPathFor({ agentKey: 'main', sessionId: SID, transcriptPath: null }), null);
    // Um transcript de subagente não é o da sessão principal.
    const sub = path.join(PROJECT_DIR, SID, 'subagents', `agent-${AID}.jsonl`);
    assert.equal(transcriptPathFor({ agentKey: 'main', sessionId: SID, transcriptPath: sub }), null);
  });

  it('subagente: <pasta do transcript>/<session_id>/subagents/agent-<agent_id>.jsonl', () => {
    assert.equal(
      transcriptPathFor({ agentKey: AID, sessionId: SID, transcriptPath: main }),
      path.join(PROJECT_DIR, SID, 'subagents', `agent-${AID}.jsonl`),
    );
  });

  it('subagente: o agent_transcript_path do SubagentStop tem prioridade; o transcript_path que já é o do subagente serve', () => {
    const exact = path.join(PROJECT_DIR, 'outra', `agent-${AID}.jsonl`);
    assert.equal(transcriptPathFor({ agentKey: AID, sessionId: SID, transcriptPath: main, agentTranscriptPath: exact }), exact);
    const own = path.join(PROJECT_DIR, SID, 'subagents', `agent-${AID}.jsonl`);
    assert.equal(transcriptPathFor({ agentKey: AID, sessionId: SID, transcriptPath: own }), own);
  });

  it('ids que mudariam a pasta (.., :, barras) dão null', () => {
    for (const sessionId of ['..', '.', 'a:b', 'a/b', 'a\\b', '']) {
      assert.equal(transcriptPathFor({ agentKey: AID, sessionId, transcriptPath: main }), null, sessionId);
    }
    for (const agentKey of ['..', 'a:b', 'a/b', '']) {
      assert.equal(transcriptPathFor({ agentKey, sessionId: SID, transcriptPath: main }), null, agentKey);
    }
    assert.equal(transcriptPathFor({ agentKey: AID, sessionId: SID, transcriptPath: null }), null);
  });
});

// ---------------------------------------------------------------------------
// Agendamento
// ---------------------------------------------------------------------------

/** Temporizadores falsos: guardam os agendamentos e os disparam quando o teste manda. */
function fakeTimers() {
  const pending = new Set();
  return {
    timers: {
      setTimeout(run, ms) {
        const handle = { run, ms, unref() { return this; } };
        pending.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        pending.delete(handle);
      },
    },
    pending: () => [...pending],
    fire() {
      const all = [...pending];
      pending.clear();
      for (const handle of all) handle.run();
    },
  };
}

/** Leitura falsa: cada chamada espera o teste responder. */
function manualRead() {
  const calls = [];
  return {
    calls,
    read: (file, options) => new Promise((resolve, reject) => calls.push({ file, options, resolve, reject })),
  };
}

function setupProbe(options = {}) {
  let now = 1_000_000;
  const results = [];
  const logs = [];
  const timers = fakeTimers();
  const reads = manualRead();
  const probe = createContextProbe({
    root: ROOT,
    read: reads.read,
    clock: () => now,
    timers: timers.timers,
    onResult: (sessionId, agentKey, usage, at) => results.push({ sessionId, agentKey, usage, at }),
    logError: (message) => logs.push(message),
    ...options,
  });
  return { probe, results, logs, timers, reads, advance: (ms) => (now += ms), now: () => now };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const USAGE = { pct: 10, usedTokens: 20_000, windowTokens: 200_000 };

describe('createContextProbe: no máximo uma leitura por agente a cada 5 s', () => {
  it('o primeiro pedido lê na hora; os seguintes dentro de 5 s viram uma única leitura no fim do intervalo, com o caminho mais recente', async () => {
    const { probe, results, timers, reads, advance } = setupProbe();
    probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl', model: 'm[1m]' });
    assert.equal(reads.calls.length, 1);
    assert.deepEqual(reads.calls[0].options, { root: ROOT, model: 'm[1m]', main: true });
    reads.calls[0].resolve(USAGE);
    await probe.settled();
    assert.equal(results.length, 1);

    advance(1000);
    probe.request({ sessionId: SID, agentKey: 'main', path: '/b.jsonl' });
    advance(1000);
    probe.request({ sessionId: SID, agentKey: 'main', path: '/c.jsonl' });
    assert.equal(reads.calls.length, 1, 'nenhuma leitura antes de 5 s');
    assert.equal(timers.pending().length, 1, 'um único agendamento');
    assert.equal(timers.pending()[0].ms, READ_INTERVAL_MS - 1000);

    advance(3000);
    timers.fire();
    assert.equal(reads.calls.length, 2);
    assert.equal(reads.calls[1].file, '/c.jsonl');
    reads.calls[1].resolve(null);
    await probe.settled();
    assert.deepEqual(results.map((item) => item.usage), [USAGE, null]);
  });

  it('pedido depois de 5 s lê na hora', async () => {
    const { probe, timers, reads, advance } = setupProbe();
    probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl' });
    reads.calls[0].resolve(USAGE);
    await probe.settled();
    advance(READ_INTERVAL_MS);
    probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl' });
    assert.equal(reads.calls.length, 2);
    assert.equal(timers.pending().length, 0);
  });

  it('pedido durante uma leitura: uma nova leitura depois, respeitando o intervalo desde o início da anterior', async () => {
    const { probe, timers, reads, advance } = setupProbe();
    probe.request({ sessionId: SID, agentKey: AID, path: '/s.jsonl' });
    assert.deepEqual(reads.calls[0].options.main, false);
    advance(100);
    probe.request({ sessionId: SID, agentKey: AID, path: '/s2.jsonl' });
    probe.request({ sessionId: SID, agentKey: AID, path: '/s3.jsonl' });
    assert.equal(reads.calls.length, 1);
    reads.calls[0].resolve(USAGE);
    await probe.settled();
    assert.equal(timers.pending().length, 1);
    assert.equal(timers.pending()[0].ms, READ_INTERVAL_MS - 100);
    timers.fire();
    assert.equal(reads.calls.length, 2);
    assert.equal(reads.calls[1].file, '/s3.jsonl');
  });

  it('agentes diferentes não dividem o intervalo; as leituras saem uma de cada vez', async () => {
    const { probe, results, reads } = setupProbe();
    probe.request({ sessionId: SID, agentKey: 'main', path: '/m.jsonl' });
    probe.request({ sessionId: SID, agentKey: AID, path: '/s.jsonl' });
    probe.request({ sessionId: 'outra', agentKey: 'main', path: '/o.jsonl' });
    assert.equal(reads.calls.length, 1, 'uma leitura em andamento por vez');
    reads.calls[0].resolve(USAGE);
    await flush();
    assert.equal(reads.calls.length, 2);
    reads.calls[1].resolve(USAGE);
    await flush();
    reads.calls[2].resolve(USAGE);
    await probe.settled();
    assert.deepEqual(results.map((item) => `${item.sessionId}/${item.agentKey}`), [`${SID}/main`, `${SID}/${AID}`, 'outra/main']);
  });

  it('leitura que rejeita vira null; erro de quem recebe vai ao log só com o tipo; nada lança', async () => {
    const { probe, results, logs, reads, advance } = setupProbe();
    probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl' });
    reads.calls[0].reject(new Error('EACCES com CONTEUDO'));
    await probe.settled();
    assert.equal(results[0].usage, null);

    const failing = setupProbe({ onResult: () => { throw new TypeError('falha com CONTEUDO-SECRETO'); } });
    failing.probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl' });
    failing.reads.calls[0].resolve(USAGE);
    await failing.probe.settled();
    assert.deepEqual(failing.logs, ['Erro ao aplicar o uso de contexto: TypeError']);
    advance(0);
    assert.deepEqual(logs, []);
  });

  it('forgetSession cancela o agendamento e descarta a leitura em andamento', async () => {
    const { probe, results, timers, reads, advance } = setupProbe();
    probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl' });
    probe.request({ sessionId: 'outra', agentKey: 'main', path: '/b.jsonl' });
    reads.calls[0].resolve(USAGE);
    await flush();
    advance(10);
    probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl' });
    assert.equal(timers.pending().length, 1);
    probe.forgetSession(SID);
    probe.forgetSession('outra');
    assert.equal(timers.pending().length, 0);
    reads.calls[1].resolve(USAGE);
    await probe.settled();
    assert.deepEqual(results.map((item) => item.sessionId), [SID]);
  });

  it('stop cancela os agendamentos', async () => {
    const { probe, timers, reads } = setupProbe();
    probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl' });
    reads.calls[0].resolve(USAGE);
    await probe.settled();
    probe.request({ sessionId: SID, agentKey: 'main', path: '/a.jsonl' });
    assert.equal(timers.pending().length, 1);
    probe.stop();
    assert.equal(timers.pending().length, 0);
  });

  it('com a leitura real e um arquivo sintético: resultado no formato do contrato', async () => {
    const file = writeTranscript(`${assistantLine(1000, 0, 49_000)}\n`);
    const { probe, results } = setupProbe({ read: readContextUsage });
    probe.request({ sessionId: SID, agentKey: 'main', path: file });
    await probe.settled();
    assert.deepEqual(results[0].usage, { pct: 25, usedTokens: 50_000, windowTokens: DEFAULT_WINDOW_TOKENS });
  });
});
