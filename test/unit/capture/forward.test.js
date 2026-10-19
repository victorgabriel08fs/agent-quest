// Encaminhador da captura (T4): funções puras e o processo real (`node forward.mjs`)
// em cada caso de falha. Sempre com AGENT_QUEST_HOME temporário e porta efêmera
// (ADR 0010): nada aqui toca no diretório de dados real nem na porta 47821.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDataDir as serverResolveDataDir } from '../../../server/config.js';
import { startServer } from '../../../server/main.js';
import {
  DEADLINE_MS,
  FORWARDER_VERSION,
  HEAD_CHARS,
  MAX_BODY_BYTES,
  MAX_LIST_ITEMS,
  BUDGET_CHECK_EVERY,
  MAX_STRING_CHARS,
  MINIMAL_PRIORITY_KEYS,
  POST_RESERVE_MS,
  REDUCTION_BUDGET_MS,
  ReductionTimeout,
  createKeyCache,
  createTimeBudget,
  emergencyPayload,
  MINIMAL_REQUIRED_KEYS,
  POST_TIMEOUT_MS,
  SHORT_HEAD_CHARS,
  SHORT_STRING_CHARS,
  SHORT_TAIL_CHARS,
  SHORTCUT_STDIN_BYTES,
  STEP2_RULES,
  TAIL_CHARS,
  buildBody,
  buildEnvelope,
  cutString,
  isPidAlive,
  isValidPort,
  minimalPayload,
  parsePayload,
  readRuntime,
  reduceValue,
  resolveDataDir,
  truncateStrings,
} from '../../../capture/plugins/agent-quest/scripts/forward.mjs';
import { deadPid, tempDir } from '../server/helpers.js';

const FORWARDER = fileURLToPath(new URL('../../../capture/plugins/agent-quest/scripts/forward.mjs', import.meta.url));
const SOURCE = readFileSync(FORWARDER, 'utf8');

/** Limites do T4. */
const FAST_MS = 300;
const STUCK_MS = 2200;

/** Guarda dos processos filhos: bem acima do maior caso legítimo (cerca de 2,2 s). */
const SPAWN_GUARD_MS = 15_000;

const temps = [];
const servers = [];
after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const tmp of temps) tmp.cleanup();
});

function newHome() {
  const tmp = tempDir('agent-quest-fwd-');
  temps.push(tmp);
  return tmp.dir;
}

function writeRuntime(home, data) {
  writeFileSync(path.join(home, 'runtime.json'), typeof data === 'string' ? data : JSON.stringify(data));
}

/**
 * Servidor que registra os POST recebidos. `hang`: aceita a conexão, lê o corpo e
 * nunca responde (servidor travado).
 */
async function captureServer({ hang = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (!hang) {
        res.writeHead(204);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: server.address().port, requests };
}

/** Porta livre de 127.0.0.1 em que ninguém escuta. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Preload só de teste (`node --import`): na saída do processo, grava em
 * AQ_TEST_TIMING_FILE quanto tempo o próprio processo viveu, do início do Node
 * até a saída (`performance.now()` conta do início do processo). Assim o tempo
 * medido é o do encaminhador, sem o custo do Windows para criar e encerrar o
 * processo, que pesa muito com a máquina carregada. Não imprime nada.
 */
const TIMING_DIR = (() => {
  const tmp = tempDir('agent-quest-fwd-timing-');
  temps.push(tmp);
  return tmp.dir;
})();
const TIMER = path.join(TIMING_DIR, 'own-timer.mjs');
writeFileSync(
  TIMER,
  [
    "import { writeFileSync } from 'node:fs';",
    "import process from 'node:process';",
    "process.on('exit', () => {",
    '  try { writeFileSync(process.env.AQ_TEST_TIMING_FILE, String(performance.now())); } catch {}',
    '});',
    '',
  ].join('\n'),
);
let timingCount = 0;

/**
 * Referência de tempo: um módulo que só importa os mesmos módulos nativos do
 * encaminhador (lidos do próprio forward.mjs) e sai. Mede o custo de carregar o
 * Node com esses módulos nas condições do momento; o que passar disso é trabalho
 * do encaminhador (de 0 a 10 ms numa máquina normal).
 */
const IMPORTS_ONLY = path.join(TIMING_DIR, 'imports-only.mjs');
writeFileSync(
  IMPORTS_ONLY,
  [...SOURCE.matchAll(/^\s*import\s[^;]*?from\s+['"](node:[^'"]+)['"]/gm)].map((m) => `import '${m[1]}';`).join('\n'),
);

/** Ambiente mínimo para o Node rodar. */
function minimalEnv(extra) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

/**
 * Roda `node <args>` com o preload de tempo. Devolve código, sinal, saídas,
 * erro de escrita no stdin, `ms` (do spawn ao fim, visto de fora) e `ownMs`
 * (tempo do próprio processo).
 */
function spawnTimed(args, { env, stdin = '', keepStdinOpen = false, guardMs = SPAWN_GUARD_MS }) {
  const timingFile = path.join(TIMING_DIR, `t${timingCount++}.txt`);
  return new Promise((resolve, reject) => {
    const begin = performance.now();
    const child = spawn(process.execPath, ['--import', pathToFileURL(TIMER).href, ...args], {
      env: { ...env, AQ_TEST_TIMING_FILE: timingFile },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let timedOut = false;
    // Guarda: um processo que não sai sozinho (por exemplo, sem os prazos do
    // forward.mjs) é encerrado, e o teste falha em vez de travar.
    const guard = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, guardMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', (err) => (stdinError = err.code ?? 'erro'));
    child.on('error', (err) => {
      clearTimeout(guard);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      const ms = performance.now() - begin;
      let ownMs = Infinity;
      try {
        ownMs = Number(readFileSync(timingFile, 'utf8'));
      } catch {
        // sem arquivo: o processo não saiu normalmente
      }
      resolve({ code, signal, stdout, stderr, stdinError, ms, ownMs, timedOut });
    });
    if (keepStdinOpen) child.stdin.write(stdin);
    else child.stdin.end(stdin);
  });
}

/**
 * Roda `node forward.mjs` como o Claude Code roda: stdin com o JSON, ambiente
 * mínimo e isolado. `keepStdinOpen` simula um stdin que nunca fecha.
 */
function runForwarder({ home, stdin = '', env = {}, keepStdinOpen = false }) {
  const fullEnv = minimalEnv({ AGENT_QUEST_HOME: home, CLAUDE_PROJECT_DIR: 'C:\\projetos\\exemplo', ...env });
  return spawnTimed([FORWARDER], { env: fullEnv, stdin, keepStdinOpen });
}

/** Saída 0, sozinho e no prazo, sem nada em stdout nem em stderr. */
function assertSilentExit(result, label = '') {
  assert.equal(result.timedOut, false, `${label} não saiu sozinho em ${SPAWN_GUARD_MS} ms; foi encerrado pela guarda do teste`);
  assert.equal(result.code, 0, `${label} código de saída`);
  assert.equal(result.signal, null, `${label} sinal`);
  assert.equal(result.stdout, '', `${label} stdout`);
  assert.equal(result.stderr, '', `${label} stderr`);
}

/** Folga para a partida do Node com os módulos (de 50 a 80 ms numa máquina normal). */
const NODE_STARTUP_ALLOWANCE_MS = 150;

/**
 * Acima disto, a referência (Node com os mesmos módulos, tempo do próprio
 * processo) mostra uma máquina sobrecarregada: o normal é de 50 a 80 ms.
 */
const OVERLOADED_NODE_MS = 150;

/**
 * Tempo medido de forma robusta, sem afrouxar o limite:
 * - mede o tempo do próprio processo (preload acima), não o do spawn;
 * - até 5 tentativas espaçadas, e passa na primeira abaixo do limite;
 * - em cada tentativa, a referência (Node com os mesmos módulos, medida do mesmo
 *   jeito, logo antes); se nenhuma tentativa ficou abaixo do limite, passa também
 *   se a mediana do encaminhador passar da mediana da referência em no máximo o
 *   limite menos a folga de partida (medianas, para um pico isolado da referência
 *   não esconder uma regressão);
 * - se todas falharem e a mediana da referência estiver muito acima do normal, a
 *   máquina está sobrecarregada e não há como medir: o teste é marcado como
 *   pulado, com o motivo e as medidas (as checagens de saída 0 e silêncio
 *   continuam valendo), e o resultado volta com `timingSkipped: true`.
 * Uma regressão real (uma espera fixa, um trabalho pesado) numa máquina normal
 * reprova. Toda tentativa precisa sair em silêncio.
 */
async function assertFast(t, run, limitMs, label) {
  const attempts = [];
  const ownTimes = [];
  const referenceTimes = [];
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    const reference = await spawnTimed([IMPORTS_ONLY], { env: minimalEnv({}) });
    result = await run();
    assertSilentExit(result, label);
    ownTimes.push(result.ownMs);
    referenceTimes.push(reference.ownMs);
    attempts.push(`${result.ownMs.toFixed(0)} ms (referência ${reference.ownMs.toFixed(0)} ms)`);
    // Critério absoluto, tentativa por tentativa.
    if (result.ownMs < limitMs) return result;
  }
  // Critério relativo pelas medianas: um pico isolado da referência não esconde uma regressão.
  const ownMedian = median(ownTimes);
  const referenceMedian = median(referenceTimes);
  if (ownMedian - referenceMedian < limitMs - NODE_STARTUP_ALLOWANCE_MS) return result;

  const summary =
    `${label}: acima de ${limitMs} ms em todas as tentativas, e a mediana (${ownMedian.toFixed(0)} ms) ` +
    `passa da mediana da referência (${referenceMedian.toFixed(0)} ms) em mais de ` +
    `${limitMs - NODE_STARTUP_ALLOWANCE_MS} ms: ${attempts.join('; ')}`;
  // Sobrecarga também pela mediana: uma referência rápida isolada não decide.
  if (referenceMedian > OVERLOADED_NODE_MS) {
    t.skip(`tempo não avaliado, máquina sobrecarregada (mediana da referência ${referenceMedian.toFixed(0)} ms). ${summary}`);
    result.timingSkipped = true;
    return result;
  }
  assert.fail(summary);
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Obrigatórios dos payloads grandes (teto do corpo e orçamento de tempo). */
const BIG_IDS = { session_id: '5f1c0000-aaaa-bbbb-cccc-1234567890ab', hook_event_name: 'PostToolUse' };

const hookPayload = (extra = {}) => ({
  session_id: 'sessao-teste',
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_use_id: 'toolu_teste',
  tool_input: { file_path: 'C:\\projetos\\exemplo\\CLAUDE.md' },
  ...extra,
});

describe('resolveDataDir: igual ao do servidor', () => {
  const cases = [
    { platform: 'win32', homedir: 'C:\\Users\\alguem', env: { LOCALAPPDATA: 'C:\\Users\\alguem\\AppData\\Local' } },
    { platform: 'win32', homedir: 'C:\\Users\\alguem', env: {} },
    { platform: 'win32', homedir: 'C:\\Users\\alguem', env: { LOCALAPPDATA: '' } },
    { platform: 'win32', homedir: 'C:\\Users\\alguem', env: { AGENT_QUEST_HOME: 'D:\\dados\\aq', LOCALAPPDATA: 'C:\\x' } },
    { platform: 'win32', homedir: 'C:\\Users\\alguem', env: { AGENT_QUEST_HOME: '', LOCALAPPDATA: 'C:\\Local' } },
    { platform: 'win32', homedir: 'C:\\Users\\alguem', env: { AGENT_QUEST_HOME: 'C:\\pasta com espaço\\configuração' } },
    { platform: 'linux', homedir: '/home/alguem', env: {} },
    { platform: 'linux', homedir: '/home/alguem', env: { XDG_STATE_HOME: '/var/estado' } },
    { platform: 'darwin', homedir: '/Users/alguem', env: { AGENT_QUEST_HOME: '/tmp/aq' } },
    { platform: process.platform, homedir: 'C:\\Users\\alguem', env: { ...process.env, AGENT_QUEST_HOME: undefined } },
  ];
  for (const options of cases) {
    it(`${options.platform} ${JSON.stringify(Object.fromEntries(Object.entries(options.env).filter(([k]) => /AGENT_QUEST|LOCALAPPDATA|XDG/.test(k))))}`, () => {
      assert.equal(resolveDataDir(options), serverResolveDataDir(options));
    });
  }
});

describe('runtime.json', () => {
  it('porta de 1024 a 65535, inteira', () => {
    for (const port of [1024, 47821, 65535]) assert.equal(isValidPort(port), true, String(port));
    for (const port of [0, 80, 1023, 65536, 1024.5, '47821', NaN, null, undefined, true]) {
      assert.equal(isValidPort(port), false, String(port));
    }
  });

  it('lê porta, token e pid; recusa arquivo ausente, corrompido ou com campo fora do esperado', () => {
    const home = newHome();
    assert.equal(readRuntime(home), null, 'ausente');
    const valid = { port: 50000, token: 'tok', pid: 1234, version: '0.1.0', startedAt: 1 };
    writeRuntime(home, valid);
    assert.deepEqual(readRuntime(home), { port: 50000, token: 'tok', pid: 1234 });
    const broken = [
      '',
      '{',
      'null',
      '[]',
      { ...valid, port: '50000' },
      { ...valid, port: 80 },
      { ...valid, port: 70000 },
      { ...valid, port: 50000.5 },
      { ...valid, token: '' },
      { ...valid, token: 42 },
      { ...valid, pid: 0 },
      { ...valid, pid: '1234' },
    ];
    for (const data of broken) {
      writeRuntime(home, data);
      assert.equal(readRuntime(home), null, JSON.stringify(data));
    }
  });

  it('isPidAlive: o próprio processo sim, um pid encerrado não', async () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(await deadPid()), false);
  });
});

describe('payload e envelope', () => {
  it('parsePayload aceita só objeto JSON (com ou sem BOM)', () => {
    assert.deepEqual(parsePayload(Buffer.from('{"a":1}')), { a: 1 });
    assert.deepEqual(parsePayload(Buffer.from('\uFEFF{"a":1}')), { a: 1 });
    for (const text of ['', 'nada', '[1]', 'null', '42', '"texto"', '{']) {
      assert.equal(parsePayload(Buffer.from(text)), null, text);
    }
  });

  it('cutString: 1 KiB do início + 3 KiB do fim, com a contagem do que saiu', () => {
    assert.equal(MAX_STRING_CHARS, 4096);
    const text = `${'i'.repeat(HEAD_CHARS)}${'m'.repeat(5000)}${'f'.repeat(TAIL_CHARS)}`;
    const cut = cutString(text);
    assert.equal(cut, `${'i'.repeat(1024)}…[cortado 5000 caracteres]…${'f'.repeat(3072)}`);
  });

  it('cutString não parte emoji (par substituto) nas bordas: o emoji da borda sai inteiro', () => {
    const emoji = '😀';
    const text = `${'a'.repeat(HEAD_CHARS - 1)}${emoji}${'b'.repeat(6000)}${emoji}${'c'.repeat(TAIL_CHARS - 1)}`;
    const cut = cutString(text);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), 'nenhum substituto solto');
    const removed = text.length - (HEAD_CHARS - 1) - (TAIL_CHARS - 1);
    assert.equal(cut, `${'a'.repeat(HEAD_CHARS - 1)}…[cortado ${removed} caracteres]…${'c'.repeat(TAIL_CHARS - 1)}`);
  });

  it('truncateStrings corta em qualquer nível e só acima de 4 KiB', () => {
    const big = 'x'.repeat(5000);
    const limit = 'y'.repeat(MAX_STRING_CHARS);
    const data = { a: big, b: { c: [big, 'curta', limit], d: 1, e: null, f: true }, g: limit };
    const { value, truncated } = truncateStrings(data);
    assert.equal(truncated, true);
    assert.equal(value.a, cutString(big));
    assert.equal(value.b.c[0], cutString(big));
    assert.equal(value.b.c[1], 'curta');
    assert.equal(value.b.c[2], limit);
    assert.equal(value.g, limit);
    assert.deepEqual([value.b.d, value.b.e, value.b.f], [1, null, true]);
    assert.equal(truncateStrings({ a: limit, b: ['c'] }).truncated, false);
  });

  it('truncateStrings: uma chave "__proto__" vinda do JSON continua sendo só uma chave', () => {
    const data = JSON.parse(`{"__proto__": "${'x'.repeat(5000)}"}`);
    const { value } = truncateStrings(data);
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.ok(Object.hasOwn(value, '__proto__'));
    assert.equal(JSON.parse(JSON.stringify(value)).__proto__.length, cutString('x'.repeat(5000)).length);
  });

  it('buildEnvelope: envelope v1 da seção 1, só com CLAUDE_PROJECT_DIR do ambiente', () => {
    const payload = hookPayload();
    const env = { CLAUDE_PROJECT_DIR: 'C:\\projetos\\exemplo', SECRET_TOKEN: 'nao', PATH: 'x' };
    assert.deepEqual(buildEnvelope(structuredClone(payload), { sentAt: 123, env }), {
      v: 1,
      sentAt: 123,
      forwarder: FORWARDER_VERSION,
      env: { projectDir: 'C:\\projetos\\exemplo', entrypoint: null },
      truncated: false,
      payload,
    });
    assert.deepEqual(buildEnvelope({}, { sentAt: 1, env: {} }).env, { projectDir: null, entrypoint: null });
  });
});

describe('teto do corpo: 1 000 000 bytes em até três passos (modelo de eventos, seção 1)', () => {
  const ids = { session_id: '5f1c0000-aaaa-bbbb-cccc-1234567890ab', hook_event_name: 'PostToolUse' };
  // Relógio parado no início: aqui se testam os passos, sem o orçamento de tempo
  // (o process.uptime() deste processo de teste já passou de 1 s há muito tempo).
  const options = { sentAt: 123, env: { CLAUDE_PROJECT_DIR: 'C:\\projetos\\exemplo' }, now: () => 0 };
  const s600 = (i) => `${i}-`.padEnd(600, 'x');
  const bytes = (text) => Buffer.byteLength(text, 'utf8');

  /** Corpo dentro do teto, envelope v1, `truncated: true` e os dois campos obrigatórios intactos. */
  function assertCapped(body, label) {
    assert.ok(body !== null, `${label}: deveria enviar`);
    assert.ok(bytes(body) <= MAX_BODY_BYTES, `${label}: ${bytes(body)} bytes`);
    const envelope = JSON.parse(body);
    assert.equal(envelope.v, 1, label);
    assert.equal(envelope.truncated, true, label);
    assert.equal(envelope.payload.session_id, ids.session_id, label);
    assert.equal(envelope.payload.hook_event_name, ids.hook_event_name, label);
    return envelope;
  }

  it('limites da decisão: 1 000 000 bytes; passo 2 com 512 (128 + 384) e 100 itens', () => {
    assert.equal(MAX_BODY_BYTES, 1_000_000);
    assert.deepEqual([SHORT_STRING_CHARS, SHORT_HEAD_CHARS, SHORT_TAIL_CHARS, MAX_LIST_ITEMS], [512, 128, 384, 100]);
  });

  it('cutString com 128 + 384: N conta as unidades UTF-16 retiradas e não parte surrogates', () => {
    const text = `${'i'.repeat(128)}${'m'.repeat(88)}${'f'.repeat(384)}`;
    assert.equal(cutString(text, 128, 384), `${'i'.repeat(128)}…[cortado 88 caracteres]…${'f'.repeat(384)}`);
    const emoji = '😀';
    const edge = `${'a'.repeat(127)}${emoji}${'b'.repeat(1000)}${emoji}${'c'.repeat(383)}`;
    const cut = cutString(edge, 128, 384);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), 'nenhum surrogate solto');
    assert.equal(cut, `${'a'.repeat(127)}…[cortado ${edge.length - 127 - 383} caracteres]…${'c'.repeat(383)}`);
  });

  it('reduceValue não altera o original: cada passo parte do payload como chegou', () => {
    const payload = { a: 'x'.repeat(5000), list: Array.from({ length: 150 }, (_, i) => i), nested: { s: 'y'.repeat(600) } };
    const before = structuredClone(payload);
    const step2 = reduceValue(payload, STEP2_RULES);
    assert.deepEqual(payload, before);
    assert.equal(step2.truncated, true);
    assert.equal(step2.value.list.length, 100);
    assert.deepEqual(step2.value.list, before.list.slice(0, 100));
    assert.equal(step2.value.nested.s, cutString(before.nested.s, 128, 384));
    assert.equal(step2.value.a, cutString(before.a, 128, 384), 'o N conta a partir do texto original');
    assert.equal(reduceValue({ list: [1, 2] }, STEP2_RULES).truncated, false);
  });

  it('passo 1 basta: o corpo é o de sempre, com truncated false', () => {
    const payload = { ...ids, tool_name: 'Read', tool_input: { file_path: 'a.md' } };
    const body = buildBody(payload, options);
    assert.equal(body, JSON.stringify(buildEnvelope(payload, options)));
    assert.equal(JSON.parse(body).truncated, false);
  });

  it('20 000 strings de 600 caracteres numa lista (cerca de 12 MiB): o passo 2 resolve', () => {
    const payload = { ...ids, tool_name: 'Bash', tool_response: { stdout: Array.from({ length: 20_000 }, (_, i) => s600(i)) } };
    assert.ok(bytes(JSON.stringify(payload)) > 11 * 1024 * 1024);
    const envelope = assertCapped(buildBody(payload, options), 'lista');
    assert.equal(envelope.payload.tool_response.stdout.length, 100);
    assert.equal(envelope.payload.tool_response.stdout[0], cutString(s600(0), 128, 384));
  });

  it('lista de 50 000 nomes de arquivo: o passo 2 deixa os 100 primeiros', () => {
    const files = Array.from({ length: 50_000 }, (_, i) => `C:/projetos/exemplo/src/modulo${i}/arquivo-${i}.js`);
    const payload = { ...ids, tool_name: 'Glob', tool_input: { pattern: '**/*' }, tool_response: { filenames: files } };
    const envelope = assertCapped(buildBody(payload, options), '50 000 arquivos');
    assert.deepEqual(envelope.payload.tool_response.filenames, files.slice(0, 100));
    assert.equal(envelope.payload.tool_input.pattern, '**/*');
  });

  it('20 000 strings de 600 como chaves de tool_input ou do primeiro nível: o passo 3 cabe no teto', () => {
    const many = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, s600(i)]));
    for (const [label, payload] of [
      ['tool_input', { ...ids, tool_name: 'X', tool_input: many, tool_response: { a: [1, 2] } }],
      ['primeiro nível', { ...ids, ...many }],
    ]) {
      const envelope = assertCapped(buildBody(payload, options), label);
      for (const value of Object.values(envelope.payload)) {
        if (value !== null && typeof value === 'object' && value !== envelope.payload.tool_input) {
          assert.fail(`${label}: o passo 3 só leva valores simples (e tool_input)`);
        }
      }
      if (label === 'tool_input') {
        assert.equal(envelope.payload.tool_name, 'X');
        assert.equal(envelope.payload.tool_response, undefined, 'objetos aninhados saem');
        assert.equal(envelope.payload.tool_input.k0, cutString(s600(0), 128, 384));
      }
    }
  });

  it('passo 3: obrigatórios, prioritários, demais do primeiro nível e tool_input, nessa ordem, só valores simples', () => {
    const payload = {
      n: 3,
      tool_input: { file_path: 'a.md', limit: 10, nested: { x: 1 }, list: ['a'], long: 'z'.repeat(600) },
      trigger: 'auto',
      ok: true,
      lista: [1, 2],
      tool_name: 'Read',
      agent_id: 'agente-1',
      obj: { a: 1 },
      hook_event_name: 'PostToolUse',
      nada: null,
      session_id: 's'.repeat(700),
      agent_type: 'tester',
      cwd: 'C:/projetos/exemplo',
    };
    const minimal = minimalPayload(payload, 100_000);
    assert.deepEqual(Object.keys(minimal), [
      'hook_event_name', 'session_id', 'agent_id',
      'agent_type', 'tool_name', 'cwd', 'trigger',
      'n', 'ok', 'nada',
      'tool_input',
    ]);
    assert.deepEqual(minimal, {
      hook_event_name: 'PostToolUse',
      session_id: cutString('s'.repeat(700), 128, 384),
      agent_id: 'agente-1',
      agent_type: 'tester',
      tool_name: 'Read',
      cwd: 'C:/projetos/exemplo',
      trigger: 'auto',
      n: 3,
      ok: true,
      nada: null,
      tool_input: { file_path: 'a.md', limit: 10, long: cutString('z'.repeat(600), 128, 384) },
    });
    assert.deepEqual(Object.keys(minimal.tool_input), ['file_path', 'limit', 'long'], 'tool_input na ordem do original');
    assert.deepEqual(MINIMAL_REQUIRED_KEYS, ['hook_event_name', 'session_id', 'agent_id']);
    assert.deepEqual(MINIMAL_PRIORITY_KEYS, ['agent_type', 'tool_name', 'tool_use_id', 'prompt_id', 'cwd', 'notification_type', 'source', 'reason', 'trigger']);
  });

  it('passo 3: com pouco espaço, os prioritários entram antes dos demais; sem agent_id no original, ele não aparece', () => {
    const payload = { extra1: 'e'.repeat(300), hook_event_name: 'Stop', session_id: 's1', tool_use_id: 'toolu_1', extra2: 'f' };
    const tight = minimalPayload(payload, 75);
    assert.deepEqual(tight, { hook_event_name: 'Stop', session_id: 's1', tool_use_id: 'toolu_1' });
    assert.ok(!('agent_id' in tight));
    assert.equal(minimalPayload(payload, 10), null, 'os obrigatórios não cabem: não envia');
    assert.equal(minimalPayload({ ...payload, agent_id: 'a'.repeat(500) }, 60), null, 'agent_id existe e não cabe: não envia');
  });

  it('20 000 chaves de 600 com agent_id: o passo 3 cabe no teto e leva os obrigatórios primeiro', () => {
    const many = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, s600(i)]));
    const payload = { ...many, tool_name: 'X', ...ids, agent_id: 'agente-subagente', agent_type: 'dev-backend', tool_input: many };
    const envelope = assertCapped(buildBody(payload, options), '20 000 chaves com agent_id');
    assert.deepEqual(Object.keys(envelope.payload).slice(0, 5), ['hook_event_name', 'session_id', 'agent_id', 'agent_type', 'tool_name']);
    assert.equal(envelope.payload.agent_id, 'agente-subagente');
    assert.equal(envelope.payload.k0, cutString(s600(0), 128, 384), 'depois, os demais na ordem do original');
  });

  it('com teto apertado: cai para o passo 3; se nem os obrigatórios couberem, não envia', () => {
    const payload = { ...ids, tool_name: 'Read', tool_input: { file_path: 'a.md' }, tool_response: { stdout: 'x'.repeat(3000) } };
    const body = buildBody(payload, { ...options, maxBytes: 500 });
    assert.ok(bytes(body) <= 500);
    const envelope = JSON.parse(body);
    assert.equal(envelope.truncated, true);
    assert.deepEqual(envelope.payload, { ...ids, tool_name: 'Read', tool_input: { file_path: 'a.md' } });
    // session_id absurdo: o passo 2 (genérico) o cortaria, mas não cabe em 400 bytes;
    // o passo 3 o mantém inteiro, e aí também não cabe: não envia.
    assert.equal(buildBody({ ...ids, session_id: 'x'.repeat(2000) }, { ...options, maxBytes: 400 }), null);
  });
});

describe('orçamento de tempo da redução (captura 0.1.2)', () => {
  const ids = { session_id: '5f1c0000-aaaa-bbbb-cccc-1234567890ab', hook_event_name: 'PostToolUse' };
  const env = { CLAUDE_PROJECT_DIR: 'C:\\projetos\\exemplo' };

  it('limites da decisão: 1 s de orçamento, conferido a cada 1 000 itens', () => {
    assert.equal(REDUCTION_BUDGET_MS, 1000);
    assert.equal(BUDGET_CHECK_EVERY, 1000);
  });

  it('createTimeBudget: check confere sempre; tick só consulta o relógio a cada 1 000 itens', () => {
    let reads = 0;
    let time = 0;
    const budget = createTimeBudget(() => (reads++, time), 1000);
    for (let i = 0; i < 2500; i++) budget.tick();
    assert.equal(reads, 2, 'o relógio foi lido no 1 000º e no 2 000º item');
    time = 1000;
    assert.throws(() => budget.check(), ReductionTimeout);
    for (let i = 0; i < 499; i++) budget.tick();
    assert.throws(() => budget.tick(), ReductionTimeout, 'no 3 000º item');
  });

  /** Relógio de teste: começa em `start` e anda `step` ms a cada leitura. */
  const clock = (start, step = 0) => {
    let time = start - step;
    return () => (time += step);
  };
  const bigPayload = (n) => ({ ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i])), ...ids });

  it('atalho: stdin acima de 8 MiB vai direto ao envelope de emergência, sem listar chaves', () => {
    assert.equal(SHORTCUT_STDIN_BYTES, 8 * 1024 * 1024);
    const small = { ...ids, tool_name: 'Read', tool_input: { file_path: 'a.md' } };
    assert.equal(
      buildBody(small, { sentAt: 1, env, now: () => 0, inputBytes: SHORTCUT_STDIN_BYTES }),
      JSON.stringify(buildEnvelope(small, { sentAt: 1, env })),
      'exatamente 8 MiB: passos normais',
    );
    const shortcut = JSON.parse(buildBody(small, { sentAt: 1, env, now: () => 0, inputBytes: SHORTCUT_STDIN_BYTES + 1 }));
    assert.equal(shortcut.truncated, true);
    assert.deepEqual(shortcut.payload, { ...ids, tool_name: 'Read' });
    // Custo constante: com centenas de milhares de chaves, nenhuma listagem.
    const huge = { ...Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [`k${i}`, i])), ...ids };
    const begin = performance.now();
    const body = buildBody(huge, { sentAt: 1, env, now: () => 0, inputBytes: 9 * 1024 * 1024 });
    const elapsed = performance.now() - begin;
    assert.deepEqual(JSON.parse(body).payload, ids);
    assert.ok(elapsed < 50, `${elapsed.toFixed(1)} ms`);
  });

  it('payload pequeno sai sempre completo, mesmo com o orçamento esgotado (máquina lenta)', () => {
    const payload = {
      ...ids,
      tool_name: 'Read',
      tool_input: { file_path: 'docs/a.md' },
      prompt: 'Leia o arquivo',
      tool_response: { stdout: 'x'.repeat(5000) },
    };
    // Relógio muito além do prazo desde a primeira leitura: o passo 1 não olha o tempo.
    for (const now of [clock(1_000_000), clock(0, 10_000)]) {
      const body = buildBody(payload, { sentAt: 1, env, now });
      assert.equal(body, JSON.stringify(buildEnvelope(payload, { sentAt: 1, env })), 'o mesmo corpo do passo 1');
      const envelope = JSON.parse(body);
      assert.equal(envelope.payload.tool_input.file_path, 'docs/a.md');
      assert.equal(envelope.payload.prompt, 'Leia o arquivo');
    }
  });

  it('payload acima do teto com o orçamento esgotado: envelope de emergência, com truncated true', () => {
    const payload = {
      ...bigPayload(200_000),
      tool_input: { file_path: 'a.md' },
      agent_id: 'agente-1',
      tool_name: 'Read',
      tool_use_id: 'toolu_1',
      outro: 'fica de fora',
      cwd: 'c'.repeat(600),
    };
    // Começa em 0 e pula para depois do orçamento na leitura seguinte (antes do passo 2).
    const envelope = JSON.parse(buildBody(payload, { sentAt: 1, env, now: clock(0, 5000) }));
    assert.equal(envelope.truncated, true);
    assert.deepEqual(envelope.payload, {
      hook_event_name: 'PostToolUse',
      session_id: ids.session_id,
      agent_id: 'agente-1',
      tool_name: 'Read',
      tool_use_id: 'toolu_1',
      cwd: cutString('c'.repeat(600), 128, 384),
    });
  });

  it('orçamento que acaba no meio de um passo: interrompe e manda o envelope de emergência', () => {
    const payload = { ...bigPayload(300_000), tool_name: 'X', tool_input: Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [`t${i}`, 'v'])) };
    let reads = 0;
    // A 1ª leitura marca o início; da 5ª em diante, o orçamento acabou (dentro dos laços).
    const now = () => (++reads >= 5 ? 5000 : 0);
    const envelope = JSON.parse(buildBody(payload, { sentAt: 1, env, now }));
    assert.equal(envelope.truncated, true);
    assert.deepEqual(envelope.payload, { ...ids, tool_name: 'X' });
    assert.ok(reads < 20, `parou cedo (${reads} leituras do relógio)`);
  });

  it('o orçamento conta do início da redução, não da partida do processo', () => {
    const payload = { ...bigPayload(200_000), tool_name: 'X' };
    // A redução começa aos 990 ms (o JSON.parse demorou): ainda há orçamento para o passo 3.
    const envelope = JSON.parse(buildBody(payload, { sentAt: 1, env, now: clock(990, 1) }));
    assert.equal(envelope.truncated, true);
    assert.ok(Object.keys(envelope.payload).length > 1000, 'passo 3 (envelope mínimo), não emergência');
    assert.ok(Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_BODY_BYTES);
  });

  it('o orçamento nunca passa do prazo total menos a reserva do POST', () => {
    assert.equal(POST_RESERVE_MS, 250);
    const payload = { ...bigPayload(200_000), tool_name: 'X' };
    // A redução começa aos 1 800 ms: depois de 1 750 ms não há orçamento, sai a emergência.
    const envelope = JSON.parse(buildBody(payload, { sentAt: 1, env, now: clock(1800, 1) }));
    assert.deepEqual(envelope.payload, { ...ids, tool_name: 'X' });
  });

  it('passos que certamente não cabem são abandonados cedo (piso do tamanho), sem visitar tudo', () => {
    const payload = bigPayload(1_000_000);
    let reads = 0;
    const begin = performance.now();
    const envelope = JSON.parse(buildBody(payload, { sentAt: 1, env, now: () => (reads++, 0) }));
    const elapsed = performance.now() - begin;
    assert.equal(envelope.truncated, true);
    assert.equal(envelope.payload.session_id, ids.session_id);
    assert.ok(reads < 400, `${reads} leituras do relógio: o passo 2 parou pelo tamanho, não percorreu 1 milhão de chaves`);
    assert.ok(elapsed < 2000, `${elapsed.toFixed(0)} ms`);
  });

  it('createKeyCache: lista as chaves de um objeto grande uma vez só entre os passos', () => {
    const keysOf = createKeyCache();
    const big = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
    const small = { a: 1 };
    assert.equal(keysOf(big), keysOf(big), 'o mesmo array (cache)');
    assert.deepEqual(keysOf(small), ['a']);
    assert.notEqual(keysOf(small), keysOf(small), 'objetos pequenos não ficam no cache');
  });

  it('emergencyPayload: só obrigatórios e prioritários simples, custo constante', () => {
    const big = Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`k${i}`, i]));
    const payload = { ...big, ...ids, agent_type: 'tester', source: ['lista'], trigger: { a: 1 }, reason: null };
    const begin = performance.now();
    const result = emergencyPayload(payload);
    const elapsed = performance.now() - begin;
    assert.deepEqual(result, { ...ids, agent_type: 'tester', reason: null });
    assert.ok(elapsed < 50, `${elapsed.toFixed(1)} ms com 200 mil chaves`);
  });

  it('surrogates nas duas bordas, nos dois cortes: o par inteiro sai, nada fica solto', () => {
    const emoji = '😀';
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const [head, tail] of [[HEAD_CHARS, TAIL_CHARS], [SHORT_HEAD_CHARS, SHORT_TAIL_CHARS]]) {
      // Borda do início: o par começa na última unidade do trecho inicial.
      const atHead = `${'a'.repeat(head - 1)}${emoji}${'b'.repeat(tail * 3)}`;
      const cutHead = cutString(atHead, head, tail);
      assert.doesNotMatch(cutHead, lone, `início ${head}`);
      assert.ok(cutHead.startsWith(`${'a'.repeat(head - 1)}…`), `início ${head}: o par saiu inteiro`);
      // Borda do fim: o par termina na primeira unidade do trecho final.
      const atTail = `${'b'.repeat(head * 3)}${emoji}${'c'.repeat(tail - 1)}`;
      const cutTail = cutString(atTail, head, tail);
      assert.doesNotMatch(cutTail, lone, `fim ${tail}`);
      assert.ok(cutTail.endsWith(`…${'c'.repeat(tail - 1)}`), `fim ${tail}: o par saiu inteiro`);
      // O N conta as unidades retiradas, com o par incluído.
      assert.match(cutTail, new RegExp(`…\\[cortado ${atTail.length - head - (tail - 1)} caracteres\\]…`));
    }
  });
});

describe('código do encaminhador', () => {
  it('sem dependências: só importa módulos node:*', () => {
    const imports = [...SOURCE.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    assert.deepEqual(imports.filter((name) => !name.startsWith('node:')), []);
    assert.doesNotMatch(SOURCE, /\bimport\(|\brequire\(/);
  });

  it('só APIs do Node 18 ou mais novo (nada de fetch, import.meta.dirname e afins)', () => {
    const newer = [
      /\bfetch\(/,
      /import\.meta\.(dirname|filename|resolve)/,
      /\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(/,
      /\bObject\.groupBy|\bMap\.groupBy|\bPromise\.withResolvers/,
      /\bglobSync\b|\bfs\.glob\b/,
      /\.parentPath\b/,
      /\bnavigator\./,
    ];
    for (const pattern of newer) assert.doesNotMatch(SOURCE, pattern, String(pattern));
  });

  it('nunca escreve em stdout nem em stderr', () => {
    assert.doesNotMatch(SOURCE, /\bconsole\./);
    assert.doesNotMatch(SOURCE, /\.write\(/);
  });

  it('prazos do ADR 0001: POST em 1 s, processo em 2 s', () => {
    assert.equal(POST_TIMEOUT_MS, 1000);
    assert.equal(DEADLINE_MS, 2000);
  });
});

describe('guardas do próprio teste', () => {
  it('processo que não sai sozinho é encerrado pela guarda, e a checagem falha em vez de travar', async () => {
    const result = await spawnTimed(['-e', 'setInterval(() => {}, 1000)'], { env: minimalEnv({}), guardMs: 300 });
    assert.equal(result.timedOut, true);
    assert.throws(() => assertSilentExit(result, 'preso'), /guarda do teste/);
  });

  it('mediana: um pico isolado não decide', () => {
    assert.equal(median([100, 5000, 110, 120, 105]), 110);
    assert.equal(median([1, 3]), 2);
  });
});

describe('encaminhador como processo: sempre sai 0 e em silêncio', () => {
  it('caso normal: o servidor recebe o envelope v1 com token, sem Origin, em até 300 ms', async (t) => {
    const home = newHome();
    const server = await captureServer();
    writeRuntime(home, { port: server.port, token: 'token-de-teste', pid: process.pid, version: '0.1.0', startedAt: 1 });
    const payload = hookPayload();
    const before = Date.now();
    await assertFast(t, () => runForwarder({ home, stdin: JSON.stringify(payload) }), FAST_MS, 'caso normal');

    assert.ok(server.requests.length >= 1);
    const request = server.requests.at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/hooks');
    assert.equal(request.headers.host, `127.0.0.1:${server.port}`);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['x-agent-quest-token'], 'token-de-teste');
    assert.equal(request.headers.origin, undefined);
    const envelope = JSON.parse(request.body);
    assert.equal(typeof envelope.sentAt, 'number');
    assert.ok(envelope.sentAt >= before - 5 && envelope.sentAt <= Date.now());
    assert.deepEqual({ ...envelope, sentAt: 0 }, {
      v: 1,
      sentAt: 0,
      forwarder: FORWARDER_VERSION,
      env: { projectDir: 'C:\\projetos\\exemplo', entrypoint: null },
      truncated: false,
      payload,
    });
  });

  it('strings acima de 4 KiB chegam cortadas (1 KiB + 3 KiB) com truncated: true', async () => {
    const home = newHome();
    const server = await captureServer();
    writeRuntime(home, { port: server.port, token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
    const stdout = `${'a'.repeat(2000)}${'b'.repeat(3000)}ℹ fail 0`;
    assertSilentExit(await runForwarder({ home, stdin: JSON.stringify(hookPayload({ tool_response: { stdout } })) }));
    const envelope = JSON.parse(server.requests.at(-1).body);
    assert.equal(envelope.truncated, true);
    assert.equal(envelope.payload.tool_response.stdout, cutString(stdout));
    assert.ok(envelope.payload.tool_response.stdout.endsWith('ℹ fail 0'), 'o fim (resumo dos testes) é preservado');
  });

  it('sem runtime.json: sai em até 300 ms', async (t) => {
    const home = newHome();
    await assertFast(t, () => runForwarder({ home, stdin: JSON.stringify(hookPayload()) }), FAST_MS, 'sem runtime.json');
  });

  it('sem runtime.json, o stdin ainda é lido até o fim: quem escreve nunca encontra o pipe fechado', async () => {
    const home = newHome();
    const big = JSON.stringify(hookPayload({ tool_response: { stdout: 'z'.repeat(8 * 1024 * 1024) } }));
    for (let i = 0; i < 3; i++) {
      const result = await runForwarder({ home, stdin: big });
      assertSilentExit(result);
      assert.equal(result.stdinError, null, `quem escreve recebeu ${result.stdinError}`);
    }
  });

  it('runtime.json corrompido: sai em até 300 ms', async (t) => {
    const home = newHome();
    writeRuntime(home, '{"port": 5');
    await assertFast(t, () => runForwarder({ home, stdin: JSON.stringify(hookPayload()) }), FAST_MS, 'corrompido');
  });

  it('pid morto: sai sem enviar, em até 300 ms', async (t) => {
    const home = newHome();
    const server = await captureServer();
    let sentWhileDead = 0;
    await assertFast(
      t,
      async () => {
        // Um pid encerrado novo a cada tentativa. No Windows, um pid pode ser
        // reaproveitado por outro processo; nesse caso o envio é o comportamento
        // previsto (visão geral, "Falhas"), e a tentativa não conta.
        const pid = await deadPid();
        writeRuntime(home, { port: server.port, token: 't', pid, version: '0.1.0', startedAt: 1 });
        const before = server.requests.length;
        const result = await runForwarder({ home, stdin: JSON.stringify(hookPayload()) });
        if (server.requests.length > before && !isPidAlive(pid)) sentWhileDead++;
        return result;
      },
      FAST_MS,
      'pid morto',
    );
    assert.equal(sentWhileDead, 0);
  });

  it('porta fechada: sai em até 300 ms', async (t) => {
    const home = newHome();
    writeRuntime(home, { port: await closedPort(), token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
    await assertFast(t, () => runForwarder({ home, stdin: JSON.stringify(hookPayload()) }), FAST_MS, 'porta fechada');
  });

  it('porta que não é um inteiro de 1024 a 65535: sai sem enviar', async () => {
    const home = newHome();
    const server = await captureServer();
    for (const port of [String(server.port), server.port + 0.5, 80, 70000, 0, -1]) {
      writeRuntime(home, { port, token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
      assertSilentExit(await runForwarder({ home, stdin: JSON.stringify(hookPayload()) }), JSON.stringify(port));
    }
    assert.equal(server.requests.length, 0);
  });

  it('servidor que aceita e não responde: desiste e sai em até 2,2 s', async (t) => {
    const home = newHome();
    const server = await captureServer({ hang: true });
    writeRuntime(home, { port: server.port, token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
    const result = await assertFast(t, () => runForwarder({ home, stdin: JSON.stringify(hookPayload()) }), STUCK_MS, 'travado');
    assert.ok(result.ms >= POST_TIMEOUT_MS - 50, `esperou o prazo do POST (${result.ms.toFixed(0)} ms)`);
    assert.ok(server.requests.length >= 1, 'o pedido chegou ao servidor');
  });

  it('stdin inválido ou vazio: sai sem enviar, em até 300 ms', async (t) => {
    const home = newHome();
    const server = await captureServer();
    writeRuntime(home, { port: server.port, token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
    for (const stdin of ['', 'nada', '[1,2]', 'null', '{"session_id":']) {
      await assertFast(t, () => runForwarder({ home, stdin }), FAST_MS, JSON.stringify(stdin));
    }
    assert.equal(server.requests.length, 0);
  });

  it('stdin de 10 MiB: válido chega cortado; inválido não é enviado; em até 300 ms', async (t) => {
    const home = newHome();
    const server = await captureServer();
    writeRuntime(home, { port: server.port, token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
    const valid = JSON.stringify(hookPayload({ tool_response: { stdout: 'z'.repeat(10 * 1024 * 1024) } }));
    await assertFast(t, () => runForwarder({ home, stdin: valid }), FAST_MS, '10 MiB válido');
    const envelope = JSON.parse(server.requests.at(-1).body);
    assert.equal(envelope.truncated, true);
    assert.ok(server.requests.at(-1).body.length < 16 * 1024);

    const sent = server.requests.length;
    await assertFast(t, () => runForwarder({ home, stdin: 'x'.repeat(10 * 1024 * 1024) }), FAST_MS, '10 MiB inválido');
    assert.equal(server.requests.length, sent);
  });

  it('stdin com aninhamento extremo: sai 0 e em silêncio', async () => {
    const home = newHome();
    const server = await captureServer();
    writeRuntime(home, { port: server.port, token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
    const deep = `{"session_id":"s","hook_event_name":"Stop","x":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;
    assertSilentExit(await runForwarder({ home, stdin: deep }));
  });

  it('stdin acima de 16 MiB: lê até o fim, descarta e sai sem enviar', async () => {
    const home = newHome();
    const server = await captureServer();
    writeRuntime(home, { port: server.port, token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
    const huge = JSON.stringify(hookPayload({ tool_response: { stdout: 'z'.repeat(17 * 1024 * 1024) } }));
    assertSilentExit(await runForwarder({ home, stdin: huge }));
    assert.equal(server.requests.length, 0);
  });

  it('stdin que nunca fecha: sai sozinho em até 2,2 s, sem enviar', async (t) => {
    const home = newHome();
    const server = await captureServer();
    writeRuntime(home, { port: server.port, token: 't', pid: process.pid, version: '0.1.0', startedAt: 1 });
    const result = await assertFast(
      t,
      () => runForwarder({ home, stdin: '{"session_id":"s",', keepStdinOpen: true }),
      STUCK_MS,
      'stdin aberto',
    );
    assert.ok(result.ms >= DEADLINE_MS - 100, `esperou o prazo (${result.ms.toFixed(0)} ms)`);
    assert.equal(server.requests.length, 0);
  });

  /**
   * Teto do corpo e orçamento de tempo com o servidor real do T3 (com --debug-dump).
   * Cada tentativa manda um `tool_use_id` próprio, para a deduplicação não esconder
   * nada. Vale a regra de tempo dos outros testes (`assertFast`, até 2,2 s); a
   * entrega é conferida pelas tentativas que terminaram antes do prazo de 2 s, e
   * só pode faltar se o tempo foi marcado como não avaliável (máquina sobrecarregada).
   * @param {any} t
   * @param {string} label
   * @param {(tag: string) => string} makeStdin   stdin com o `tool_use_id` da tentativa
   * @param {{ agentId?: string, check?: (envelope: any) => void }} [expected]
   */
  async function assertDeliveredWithinDeadline(t, label, makeStdin, expected = {}) {
    const home = newHome();
    const running = await startServer({ argv: ['--port', '0', '--debug-dump'], env: { AGENT_QUEST_HOME: home }, logError: () => {} });
    const health = () =>
      new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: running.port, path: '/api/health', agent: false }, (r) => {
          let body = '';
          r.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve(JSON.parse(body).events));
        }).on('error', reject);
      });
    // Até 5 tentativas espaçadas; para na primeira que entrega dentro do limite. Cada
    // uma mede antes a referência (Node com os mesmos módulos), como no assertFast.
    const attempts = [];
    const references = [];
    let passed = false;
    try {
      for (let i = 0; i < 5 && !passed; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 250));
        references.push((await spawnTimed([IMPORTS_ONLY], { env: minimalEnv({}) })).ownMs);
        const tag = `toolu_${i}`;
        const before = await health();
        const run = await runForwarder({ home, stdin: makeStdin(tag) });
        const after = await health();
        assertSilentExit(run, `${label}, tentativa ${i + 1}`);
        const attempt = { tag, run, accepted: after.accepted - before.accepted, rejected: after.rejected - before.rejected };
        attempts.push(attempt);
        passed = attempt.accepted === 1 && run.ownMs < STUCK_MS;
      }
    } finally {
      await running.close();
    }

    const detail = attempts
      .map((a) => `${a.tag}: ${a.run.ownMs.toFixed(0)} ms, accepted +${a.accepted}, rejected +${a.rejected}`)
      .join('; ');
    t.diagnostic(`${label}: ${detail}`);
    for (const attempt of attempts) assert.equal(attempt.rejected, 0, `${label}: nenhum 413 nem 400 (${detail})`);
    for (const attempt of attempts) {
      if (attempt.run.ownMs < DEADLINE_MS - 100) {
        assert.equal(attempt.accepted, 1, `${label}: ${attempt.tag} terminou antes do prazo e não entregou (${detail})`);
      }
    }
    const delivered = attempts.filter((a) => a.accepted === 1);
    if (!passed) {
      // Nenhuma entrega dentro do limite: vale a mesma regra de carga do assertFast.
      const ownMedian = median(attempts.map((a) => a.run.ownMs));
      const referenceMedian = median(references);
      const slowButFine = delivered.length > 0 && ownMedian - referenceMedian < STUCK_MS - NODE_STARTUP_ALLOWANCE_MS;
      if (!slowButFine) {
        if (referenceMedian > OVERLOADED_NODE_MS) {
          t.skip(`entrega no prazo não avaliada, máquina sobrecarregada (mediana da referência ${referenceMedian.toFixed(0)} ms); ${detail}`);
        } else {
          assert.fail(`${label}: nenhuma tentativa entregou dentro de ${STUCK_MS} ms com a máquina normal (${detail})`);
        }
      }
    }

    const dumps = path.join(home, 'dumps');
    const lines = delivered.length ? readdirSync(dumps).flatMap((file) => readFileSync(path.join(dumps, file), 'utf8').trim().split('\n')) : [];
    assert.equal(lines.length, delivered.length, `${label}: um envelope gravado por entrega (${detail})`);
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= MAX_BODY_BYTES, `${label}: ${Buffer.byteLength(line, 'utf8')} bytes`);
      const envelope = JSON.parse(line);
      assert.equal(envelope.truncated, true, label);
      assert.equal(envelope.payload.session_id, BIG_IDS.session_id, `${label}: session_id intacto`);
      assert.equal(envelope.payload.hook_event_name, BIG_IDS.hook_event_name, `${label}: hook_event_name intacto`);
      if (expected.agentId) assert.equal(envelope.payload.agent_id, expected.agentId, `${label}: agent_id intacto`);
      expected.check?.(envelope);
      assert.ok(delivered.some((a) => a.tag === envelope.payload.tool_use_id), `${label}: tool_use_id da tentativa`);
    }
  }

  /** Payload em texto com `n` chaves `"kN":1` no primeiro nível (montado sem objeto intermediário). */
  function manyKeysStdin(n) {
    const head = `{"session_id":"${BIG_IDS.session_id}","hook_event_name":"${BIG_IDS.hook_event_name}","agent_id":"agente-1","tool_name":"X","tool_use_id":"`;
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(`"k${i}":1`);
    const tail = `",${parts.join(',')}}`;
    return (tag) => `${head}${tag}${tail}`;
  }

  const s600 = (i) => `${i}-`.padEnd(600, 'x');

  it('teto do corpo com o servidor real: 20 000 × 600 numa lista (cerca de 12 MiB) chega com 204, no prazo', async (t) => {
    const stdout = Array.from({ length: 20_000 }, (_, i) => s600(i));
    await assertDeliveredWithinDeadline(t, '20 000 × 600 numa lista', (tag) =>
      JSON.stringify({ ...BIG_IDS, tool_name: 'Bash', tool_use_id: tag, tool_response: { stdout } }),
    );
  });

  it('teto do corpo com o servidor real: 20 000 × 600 em tool_input chega com 204, no prazo', async (t) => {
    const toolInput = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, s600(i)]));
    await assertDeliveredWithinDeadline(
      t,
      '20 000 × 600 em tool_input',
      (tag) => JSON.stringify({ ...BIG_IDS, agent_id: 'agente-1', tool_name: 'X', tool_use_id: tag, tool_input: toolInput }),
      { agentId: 'agente-1' },
    );
  });

  it('teto do corpo com o servidor real: 50 000 nomes de arquivo chegam com 204, no prazo', async (t) => {
    const filenames = Array.from({ length: 50_000 }, (_, i) => `src/modulo${i}/arquivo-${i}.js`);
    await assertDeliveredWithinDeadline(t, '50 000 arquivos', (tag) =>
      JSON.stringify({ ...BIG_IDS, tool_name: 'Glob', tool_use_id: tag, tool_response: { filenames } }),
    );
  });

  it('orçamento de tempo com o servidor real: 600 mil chaves no primeiro nível chegam com 204, no prazo', async (t) => {
    await assertDeliveredWithinDeadline(t, '600 mil chaves', manyKeysStdin(600_000), { agentId: 'agente-1' });
  });

  it('orçamento de tempo com o servidor real: 1,15 milhão de chaves no primeiro nível chegam com 204, no prazo', async (t) => {
    await assertDeliveredWithinDeadline(t, '1,15 milhão de chaves', manyKeysStdin(1_150_000), { agentId: 'agente-1' });
  });

  /** Só obrigatórios e prioritários: o envelope de emergência do atalho. */
  const emergencyOnly = (envelope) => {
    const allowed = new Set([...MINIMAL_REQUIRED_KEYS, ...MINIMAL_PRIORITY_KEYS]);
    for (const key of Object.keys(envelope.payload)) assert.ok(allowed.has(key), `chave fora do envelope de emergência: ${key}`);
  };

  /** Stdin com tantas chaves quantas couberem em `bytes` (sem passar de 16 MiB). */
  function stdinWithKeys(bytes) {
    const head = `{"session_id":"${BIG_IDS.session_id}","hook_event_name":"${BIG_IDS.hook_event_name}","agent_id":"agente-1","tool_name":"X","tool_use_id":"`;
    const parts = [];
    let size = head.length + 40;
    for (let i = 0; ; i++) {
      const part = `"k${i}":1`;
      if (size + part.length + 1 > bytes) break;
      parts.push(part);
      size += part.length + 1;
    }
    const tail = `",${parts.join(',')}}`;
    return { keys: parts.length, make: (tag) => `${head}${tag}${tail}` };
  }

  it('atalho de 8 MiB com o servidor real: 9 MiB de chaves vão direto ao envelope de emergência, com 204, no prazo', async (t) => {
    const { keys, make } = stdinWithKeys(9 * 1024 * 1024);
    t.diagnostic(`${keys} chaves`);
    assert.ok(Buffer.byteLength(make('toolu_0')) > SHORTCUT_STDIN_BYTES);
    await assertDeliveredWithinDeadline(t, '9 MiB de chaves', make, { agentId: 'agente-1', check: emergencyOnly });
  });

  it('atalho de 8 MiB com o servidor real: 16 MiB numa string só chegam com 204, sem tool_response (perda aceita)', async (t) => {
    const stdout = 'z'.repeat(16 * 1024 * 1024 - 400);
    await assertDeliveredWithinDeadline(
      t,
      '16 MiB numa string',
      (tag) => JSON.stringify({ ...BIG_IDS, agent_id: 'agente-1', tool_name: 'Bash', tool_use_id: tag, tool_response: { stdout } }),
      {
        agentId: 'agente-1',
        check: (envelope) => {
          assert.equal(envelope.payload.tool_response, undefined, 'sem tool_response');
          assert.equal(envelope.payload.tool_name, 'Bash');
          emergencyOnly(envelope);
        },
      },
    );
  });

  it('atalho de 8 MiB com o servidor real: 16 MiB de chaves chegam com 204 e os obrigatórios; o tempo fica registrado', async (t) => {
    // O JSON.parse de 16 MiB com ~1,4 milhão de chaves não pode ser interrompido (1,3 a 1,8 s
    // medidos): o tempo é registrado, e a perda só é aceita com a máquina sobrecarregada.
    const { keys, make } = stdinWithKeys(16 * 1024 * 1024);
    assert.ok(Buffer.byteLength(make('toolu_0')) <= 16 * 1024 * 1024);
    const home = newHome();
    const running = await startServer({ argv: ['--port', '0', '--debug-dump'], env: { AGENT_QUEST_HOME: home }, logError: () => {} });
    const health = () =>
      new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: running.port, path: '/api/health', agent: false }, (r) => {
          let body = '';
          r.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve(JSON.parse(body).events));
        }).on('error', reject);
      });
    const attempts = [];
    const references = [];
    try {
      for (let i = 0; i < 5; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 250));
        references.push((await spawnTimed([IMPORTS_ONLY], { env: minimalEnv({}) })).ownMs);
        const tag = `toolu_${i}`;
        const before = await health();
        const run = await runForwarder({ home, stdin: make(tag) });
        const after = await health();
        assertSilentExit(run, `16 MiB de chaves, tentativa ${i + 1}`);
        attempts.push({ tag, run, accepted: after.accepted - before.accepted, rejected: after.rejected - before.rejected });
        if (after.accepted - before.accepted === 1) break;
      }
    } finally {
      await running.close();
    }
    const detail = attempts.map((a) => `${a.tag}: ${a.run.ownMs.toFixed(0)} ms, accepted +${a.accepted}`).join('; ');
    t.diagnostic(`16 MiB, ${keys} chaves: ${detail}`);
    for (const attempt of attempts) assert.equal(attempt.rejected, 0, `nenhum 413 nem 400 (${detail})`);
    const delivered = attempts.filter((a) => a.accepted === 1);
    if (delivered.length === 0) {
      if (median(references) > OVERLOADED_NODE_MS) {
        t.skip(`entrega não avaliada, máquina sobrecarregada (mediana da referência ${median(references).toFixed(0)} ms); ${detail}`);
        return;
      }
      assert.fail(`16 MiB de chaves: nenhuma entrega com a máquina normal (${detail})`);
    }
    const dumps = path.join(home, 'dumps');
    const [line] = readdirSync(dumps).flatMap((file) => readFileSync(path.join(dumps, file), 'utf8').trim().split('\n'));
    const envelope = JSON.parse(line);
    assert.equal(envelope.truncated, true);
    assert.equal(envelope.payload.session_id, BIG_IDS.session_id);
    assert.equal(envelope.payload.hook_event_name, BIG_IDS.hook_event_name);
    assert.equal(envelope.payload.agent_id, 'agente-1');
    emergencyOnly(envelope);
  });

  it('com o servidor real (T3): o evento é aceito com o token do runtime.json', async () => {
    const home = newHome();
    const running = await startServer({ argv: ['--port', '0'], env: { AGENT_QUEST_HOME: home }, logError: () => {} });
    try {
      assertSilentExit(await runForwarder({ home, stdin: JSON.stringify(hookPayload()) }));
      const res = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: running.port, path: '/api/health', agent: false }, (r) => {
          let body = '';
          r.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve(JSON.parse(body)));
        }).on('error', reject);
      });
      assert.equal(res.events.received, 1);
      assert.equal(res.events.accepted, 1);
      assert.equal(res.events.rejected, 0);
    } finally {
      await running.close();
    }
  });
});
