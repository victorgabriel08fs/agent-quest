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
  MAX_READ_BYTES,
  MAX_TRACKED_AGENTS,
  READ_INTERVAL_MS,
  SMALL_WINDOW_TOKENS,
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

describe('contextUsage: janela (seção 6, "Janela"; decisão do usuário de 26/10/2026)', () => {
  const M = DEFAULT_WINDOW_TOKENS;
  const K200 = SMALL_WINDOW_TOKENS;

  it('as constantes: padrão de 1 milhão, 200 mil para as famílias sem 1M nativo', () => {
    assert.equal(DEFAULT_WINDOW_TOKENS, 1_000_000);
    assert.equal(SMALL_WINDOW_TOKENS, 200_000);
  });

  // [modelo da resposta (observed), janela esperada], com o modelo pedido ausente.
  const byObserved = [
    // Exemplos da seção 6 com 1M nativo ou desconhecidos.
    ['claude-opus-5-5', M],
    ['claude-opus-4-7', M],
    ['claude-haiku-5-5', M],
    ['claude-sonnet-5', M],
    ['claude-modelo-desconhecido', M],
    ['claude-fable-1', M],
    ['gpt-qualquer', M],
    ['<synthetic>', M],
    // Famílias de 200 mil (padrão de referência da seção 6).
    ['claude-opus-4-6', K200],
    ['claude-opus-4', K200],
    ['claude-opus-4-1-20250805', K200],
    ['claude-sonnet-4-5-20250929', K200],
    ['claude-sonnet-4-6', K200],
    ['claude-sonnet-4-20250514', K200],
    ['claude-haiku-4-5', K200],
    ['claude-haiku-4-5-20251001', K200],
    ['claude-3-5-sonnet-20241022', K200],
    ['claude-3-opus-20240229', K200],
    ['claude-3-7-sonnet-20250219', K200],
    ['CLAUDE-OPUS-4-6', K200],
    ['  claude-opus-4-6  ', K200],
    // Parecidos, mas fora do padrão: 1M.
    ['claude-opus-4-7-20260101', M],
    ['claude-sonnet-4-6-extra', M],
    ['claude-opus-4-6[1m]', M],
    ['opus', M],
    ['sonnet', M],
  ];
  for (const [observed, windowTokens] of byObserved) {
    it(`resposta em ${JSON.stringify(observed)}: janela de ${windowTokens}`, () => {
      assert.equal(contextUsage(10_000, { observed }).windowTokens, windowTokens);
      assert.equal(contextUsage(10_000, { observed, requested: null }).windowTokens, windowTokens);
    });
  }

  it('[1m] no fim do modelo pedido dá 1M mesmo com a resposta numa família de 200 mil (sem diferenciar maiúsculas)', () => {
    assert.deepEqual(contextUsage(10_000, { requested: 'claude-opus-4-6[1m]', observed: 'claude-opus-4-6' }), { pct: 1, usedTokens: 10_000, windowTokens: M });
    assert.equal(contextUsage(10_000, { requested: 'claude-sonnet-4-5[1M]', observed: 'claude-sonnet-4-5-20250929' }).windowTokens, M);
    assert.equal(contextUsage(10_000, { requested: 'sonnet[1m]', observed: 'claude-sonnet-4-6' }).windowTokens, M);
    // [1m] fora do fim não conta.
    assert.equal(contextUsage(10_000, { requested: '[1m]-no-meio', observed: 'claude-opus-4-6' }).windowTokens, K200);
    // Pedido sem [1m] não muda a regra do modelo da resposta.
    assert.equal(contextUsage(10_000, { requested: 'claude-opus-4-6', observed: 'claude-opus-4-6' }).windowTokens, K200);
    assert.equal(contextUsage(10_000, { requested: 'claude-opus-4-6', observed: 'claude-opus-5-5' }).windowTokens, M);
  });

  it('uso acima de 200 mil dá 1M sempre; exatamente 200 mil numa família de 200 mil dá 100%', () => {
    assert.deepEqual(contextUsage(200_001, { observed: 'claude-opus-4-6' }), { pct: 20, usedTokens: 200_001, windowTokens: M });
    assert.deepEqual(contextUsage(200_000, { observed: 'claude-opus-4-6' }), { pct: 100, usedTokens: 200_000, windowTokens: K200 });
    assert.deepEqual(contextUsage(250_000, { requested: 'claude-3-5-sonnet-20241022' }), { pct: 25, usedTokens: 250_000, windowTokens: M });
    assert.equal(contextUsage(1_500_000).pct, 100);
  });

  it('resposta sem message.model (ou que não é texto): vale o modelo pedido sem o [1m]; sem os dois, o padrão', () => {
    for (const observed of [null, undefined, '', '   ', 42, { name: 'claude-opus-4-6' }, ['claude-opus-4-6']]) {
      assert.equal(contextUsage(10_000, { observed, requested: 'claude-opus-4-6' }).windowTokens, K200, String(observed));
      assert.equal(contextUsage(10_000, { observed, requested: 'claude-opus-5-5' }).windowTokens, M, String(observed));
      assert.equal(contextUsage(10_000, { observed, requested: null }).windowTokens, M, String(observed));
      assert.equal(contextUsage(10_000, { observed }).windowTokens, M, String(observed));
    }
    assert.equal(contextUsage(10_000, { requested: '[1m]' }).windowTokens, M);
    assert.equal(contextUsage(10_000, { requested: 42 }).windowTokens, M);
    assert.equal(contextUsage(10_000).windowTokens, M);
  });

  it('o modelo da resposta ganha do modelo pedido', () => {
    assert.equal(contextUsage(10_000, { requested: 'claude-opus-5-5', observed: 'claude-haiku-4-5' }).windowTokens, K200);
    assert.equal(contextUsage(10_000, { requested: 'claude-opus-4-6', observed: 'claude-haiku-5-5' }).windowTokens, M);
  });

  it('pct inteiro de 0 a 100', () => {
    assert.deepEqual(contextUsage(80_000, { observed: 'claude-sonnet-4-5' }), { pct: 40, usedTokens: 80_000, windowTokens: K200 });
    assert.deepEqual(contextUsage(80_000, { observed: 'claude-opus-5-5' }), { pct: 8, usedTokens: 80_000, windowTokens: M });
    assert.deepEqual(contextUsage(1), { pct: 0, usedTokens: 1, windowTokens: M });
    assert.deepEqual(contextUsage(1_000_000), { pct: 100, usedTokens: 1_000_000, windowTokens: M });
  });
});

describe('readContextUsage: janela pelo message.model da resposta lida', () => {
  /** Resposta SINTÉTICA com 100 mil tokens e o modelo dado (sem a chave, se `undefined`). */
  const answer = (model, { sidechain = false } = {}) => JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    isSidechain: sidechain,
    message: { role: 'assistant', ...(model === undefined ? {} : { model }), content: [{ type: 'text', text: 'RESPOSTA-SINTETICA' }], usage: { input_tokens: 1000, cache_creation_input_tokens: 9000, cache_read_input_tokens: 90_000, output_tokens: 1 } },
  });

  // [modelo da resposta, opções da leitura, janela esperada]
  const cases = [
    ['claude-opus-5-5', { main: true, model: 'claude-opus-5-5' }, DEFAULT_WINDOW_TOKENS],
    ['claude-opus-4-7', { main: true }, DEFAULT_WINDOW_TOKENS],
    ['claude-haiku-5-5', { main: false }, DEFAULT_WINDOW_TOKENS],
    ['claude-modelo-desconhecido', { main: true }, DEFAULT_WINDOW_TOKENS],
    ['claude-opus-4-6', { main: true }, SMALL_WINDOW_TOKENS],
    ['claude-sonnet-4-5-20250929', { main: false }, SMALL_WINDOW_TOKENS],
    ['claude-haiku-4-5', { main: false }, SMALL_WINDOW_TOKENS],
    ['claude-3-5-sonnet-20241022', { main: true }, SMALL_WINDOW_TOKENS],
    ['claude-opus-4-6', { main: true, model: 'claude-opus-4-6[1m]' }, DEFAULT_WINDOW_TOKENS],
    // O modelo pedido só vale na sessão principal: um subagente não herda o [1m].
    ['claude-opus-4-6', { main: false, model: 'claude-opus-4-6[1m]' }, SMALL_WINDOW_TOKENS],
    // Sem message.model: o modelo pedido (só main), depois o padrão.
    [undefined, { main: true, model: 'claude-sonnet-4-6' }, SMALL_WINDOW_TOKENS],
    [undefined, { main: true, model: 'claude-sonnet-4-6[1m]' }, DEFAULT_WINDOW_TOKENS],
    [undefined, { main: false, model: 'claude-sonnet-4-6' }, DEFAULT_WINDOW_TOKENS],
    [undefined, { main: true }, DEFAULT_WINDOW_TOKENS],
    [42, { main: true, model: 'claude-haiku-4-5' }, SMALL_WINDOW_TOKENS],
  ];
  for (const [model, options, windowTokens] of cases) {
    it(`resposta ${JSON.stringify(model) ?? 'sem modelo'}, ${JSON.stringify(options)}: janela de ${windowTokens}`, async () => {
      const file = writeTranscript(`${answer(model, { sidechain: !options.main })}\n`);
      const usage = await readContextUsage(file, { root: ROOT, ...options });
      assert.deepEqual(usage, { pct: Math.round((100_000 / windowTokens) * 100), usedTokens: 100_000, windowTokens });
    });
  }

  it('vale o modelo da última resposta com usage, não o de uma anterior', async () => {
    const file = writeTranscript(`${answer('claude-opus-5-5')}\n${answer('claude-haiku-4-5')}\n`);
    assert.equal((await readContextUsage(file, { root: ROOT, main: true }))?.windowTokens, SMALL_WINDOW_TOKENS);
    const back = writeTranscript(`${answer('claude-haiku-4-5')}\n${answer('claude-opus-5-5')}\n`);
    assert.equal((await readContextUsage(back, { root: ROOT, main: true }))?.windowTokens, DEFAULT_WINDOW_TOKENS);
  });
});

describe('readContextUsage: marca de compactação (compact_boundary)', () => {
  const answer = (input, { sidechain = false } = {}) => JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'RESPOSTA-SINTETICA' }], usage: { input_tokens: input, output_tokens: 1 } },
  });
  const mark = ({ sidechain = false, ...extra } = {}) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: sidechain, content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 1 }, ...extra });

  it('no transcript de subagente (main: false), a marca conta mesmo com isSidechain: true', async () => {
    const file = writeTranscript(`${answer(5000, { sidechain: true })}\n${mark({ sidechain: true })}\n`);
    assert.equal(await readContextUsage(file, { root: ROOT, main: false }), null);
    const after = writeTranscript(`${answer(5000, { sidechain: true })}\n${mark({ sidechain: true })}\n${answer(7000, { sidechain: true })}\n`);
    assert.equal((await readContextUsage(after, { root: ROOT, main: false }))?.usedTokens, 7000);
  });

  it('a resposta de subagente depois da marca, no principal, também é ignorada: continua null', async () => {
    const file = writeTranscript(`${answer(5000)}\n${mark()}\n${answer(9000, { sidechain: true })}\n`);
    assert.equal(await readContextUsage(file, { root: ROOT, main: true }), null);
  });

  it('só type "system" com subtype "compact_boundary" é marca; texto parecido não para a leitura', async () => {
    const lookalikes = [
      mark({ type: 'user' }),
      mark({ subtype: 'compact_boundary_x' }),
      JSON.stringify({ type: 'system', subtype: 'informational', content: 'compact_boundary' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '"compact_boundary"' } }),
      '{"type":"system","subtype":"compact_boundary"', // linha partida
    ];
    const file = writeTranscript(`${answer(5000)}\n${lookalikes.join('\n')}\n`);
    assert.equal((await readContextUsage(file, { root: ROOT, main: true }))?.usedTokens, 5000);
  });
});

describe('readContextUsage: só os últimos 64 KiB', () => {
  it('uma resposta antes dos últimos 64 KiB não é vista; logo dentro deles, é', async () => {
    const usage = assistantLine(1000, 0, 49_000);
    const far = writeTranscript(`${usage}\n${fillerLine(MAX_READ_BYTES)}\n`);
    assert.equal(await readContextUsage(far, { root: ROOT }), null);
    const near = writeTranscript(`${fillerLine(MAX_READ_BYTES)}\n${usage}\n${fillerLine(MAX_READ_BYTES - usage.length - 200)}\n`);
    assert.deepEqual(await readContextUsage(near, { root: ROOT }), { pct: 5, usedTokens: 50_000, windowTokens: DEFAULT_WINDOW_TOKENS });
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
  const expected = { pct: 5, usedTokens: 50_000, windowTokens: DEFAULT_WINDOW_TOKENS };

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
    assert.deepEqual(results[0].usage, { pct: 5, usedTokens: 50_000, windowTokens: DEFAULT_WINDOW_TOKENS });
  });
});

describe('createContextProbe: limite de agentes acompanhados (B1 do tester)', () => {
  /** Temporizadores falsos que guardam a hora de disparo, para soltar só os vencidos. */
  function dueTimers(clock) {
    const pending = new Set();
    return {
      timers: {
        setTimeout(run, ms) {
          const handle = { run, at: clock() + ms, unref() { return this; } };
          pending.add(handle);
          return handle;
        },
        clearTimeout: (handle) => pending.delete(handle),
      },
      size: () => pending.size,
      fireDue() {
        for (const handle of [...pending]) {
          if (handle.at > clock()) continue;
          pending.delete(handle);
          handle.run();
        }
      },
    };
  }

  it(`${MAX_TRACKED_AGENTS + 1} agentes com pedidos repetidos: nenhum agente é lido duas vezes em menos de 5 s`, async () => {
    let now = 1_000_000;
    const clock = () => now;
    const timers = dueTimers(clock);
    /** Horas de leitura de cada agente (pelo caminho, que é único por agente). @type {Map<string, number[]>} */
    const readsAt = new Map();
    const probe = createContextProbe({
      root: ROOT,
      clock,
      timers: timers.timers,
      read: async (file) => {
        readsAt.set(file, [...(readsAt.get(file) ?? []), now]);
        return USAGE;
      },
      onResult: () => {},
    });
    const total = MAX_TRACKED_AGENTS + 1;
    const ask = (i) => probe.request({ sessionId: `sessao-${i % 7}`, agentKey: `a${i}`, path: `/agente-${i}.jsonl` });

    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < total; i++) {
        ask(i);
        await probe.settled();
        now += 1;
        if (i % 100 === 0) {
          timers.fireDue();
          await probe.settled();
        }
      }
      now += 1000;
      timers.fireDue();
      await probe.settled();
    }
    // Os pedidos que ficaram para o fim do intervalo saem.
    now += READ_INTERVAL_MS;
    timers.fireDue();
    await probe.settled();
    assert.equal(timers.size(), 0);

    assert.equal(readsAt.size, total, 'todo agente foi lido');
    const tooSoon = [];
    for (const [file, times] of readsAt) {
      assert.ok(times.length >= 2, `${file}: só ${times.length} leitura(s)`);
      for (let k = 1; k < times.length; k++) {
        if (times[k] - times[k - 1] < READ_INTERVAL_MS) tooSoon.push(`${file}: ${times[k] - times[k - 1]} ms`);
      }
    }
    assert.deepEqual(tooSoon, [], 'leituras do mesmo agente com menos de 5 s');

    // Sessão esquecida: o registro dos despejados também é esquecido.
    for (let s = 0; s < 7; s++) probe.forgetSession(`sessao-${s}`);
    const before = readsAt.get('/agente-0.jsonl').length;
    ask(0);
    await probe.settled();
    assert.equal(readsAt.get('/agente-0.jsonl').length, before + 1, 'agente de sessão esquecida volta como novo');
  });

  it('o despejado é o de leitura mais antiga sem leitura pendente, e o intervalo continua valendo para ele', async () => {
    const { probe, timers, reads, advance } = setupProbe();
    // Enche a sonda; o agente 0 é lido primeiro, o 1 por último.
    const ask = (key) => probe.request({ sessionId: SID, agentKey: key, path: `/${key}.jsonl` });
    ask('primeiro');
    reads.calls.at(-1).resolve(USAGE);
    await probe.settled();
    for (let i = 1; i < MAX_TRACKED_AGENTS; i++) {
      advance(1);
      ask(`a${i}`);
      reads.calls.at(-1).resolve(USAGE);
      await probe.settled();
    }
    // O primeiro é pedido de novo (fica agendado) e não pode ser despejado.
    ask('primeiro');
    assert.equal(timers.pending().length, 1);
    const count = reads.calls.length;
    // Agente novo: despeja o de leitura mais antiga sem pendência (a1).
    ask('novo');
    assert.equal(reads.calls.length, count + 1);
    reads.calls.at(-1).resolve(USAGE);
    await probe.settled();
    // a1, pedido de novo antes de 5 s, não é lido na hora.
    ask('a1');
    assert.equal(reads.calls.length, count + 1, 'a1 foi lido de novo antes de 5 s');
    assert.equal(timers.pending().length, 2);
  });

  it('despejo que esvazia a sessão do próprio pedido: o agente novo continua ligado à sessão (forgetSession o alcança)', async () => {
    const { probe, timers, reads, advance } = setupProbe();
    // A única entrada de SID é a leitura mais antiga; as demais ficam em outra sessão.
    probe.request({ sessionId: SID, agentKey: 'antigo', path: '/antigo.jsonl' });
    reads.calls.at(-1).resolve(USAGE);
    await probe.settled();
    for (let i = 1; i < MAX_TRACKED_AGENTS; i++) {
      advance(1);
      probe.request({ sessionId: 'outra', agentKey: `a${i}`, path: `/a${i}.jsonl` });
      reads.calls.at(-1).resolve(USAGE);
      await probe.settled();
    }
    // Agente novo em SID: despeja o 'antigo', a última entrada de SID.
    probe.request({ sessionId: SID, agentKey: 'novo', path: '/novo.jsonl' });
    reads.calls.at(-1).resolve(USAGE);
    await probe.settled();
    // Pedido de novo dentro de 5 s: fica agendado.
    probe.request({ sessionId: SID, agentKey: 'novo', path: '/novo.jsonl' });
    assert.equal(timers.pending().length, 1);
    probe.forgetSession(SID);
    assert.equal(timers.pending().length, 0, 'o agendamento do agente novo ficou fora do alcance do forgetSession');
  });
});
