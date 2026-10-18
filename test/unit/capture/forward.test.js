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
  MAX_STRING_CHARS,
  MINIMAL_PRIORITY_KEYS,
  MINIMAL_REQUIRED_KEYS,
  POST_TIMEOUT_MS,
  SHORT_HEAD_CHARS,
  SHORT_STRING_CHARS,
  SHORT_TAIL_CHARS,
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
 * - se todas falharem e até a referência estiver muito acima do normal, a máquina
 *   está sobrecarregada e não há como medir: o teste é marcado como pulado, com o
 *   motivo e as medidas (as checagens de saída 0 e silêncio continuam valendo).
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
  const fastestReference = Math.min(...referenceTimes);
  if (fastestReference > OVERLOADED_NODE_MS) {
    t.skip(`tempo não avaliado, máquina sobrecarregada (referência em no mínimo ${fastestReference.toFixed(0)} ms). ${summary}`);
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
  const options = { sentAt: 123, env: { CLAUDE_PROJECT_DIR: 'C:\\projetos\\exemplo' } };
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

  it('teto do corpo com o servidor real: 12 MiB em strings e 50 000 arquivos chegam com 204, truncated e ids intactos, no prazo', async () => {
    const home = newHome();
    const running = await startServer({ argv: ['--port', '0', '--debug-dump'], env: { AGENT_QUEST_HOME: home }, logError: () => {} });
    const ids = { session_id: '5f1c0000-aaaa-bbbb-cccc-1234567890ab', hook_event_name: 'PostToolUse' };
    const s600 = (i) => `${i}-`.padEnd(600, 'x');
    const cases = [
      ['20 000 × 600 numa lista', { ...ids, tool_name: 'Bash', tool_response: { stdout: Array.from({ length: 20_000 }, (_, i) => s600(i)) } }],
      ['20 000 × 600 em tool_input', { ...ids, tool_name: 'X', tool_input: Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, s600(i)])) }],
      ['50 000 arquivos', { ...ids, tool_name: 'Glob', tool_response: { filenames: Array.from({ length: 50_000 }, (_, i) => `src/modulo${i}/arquivo-${i}.js`) } }],
    ];
    const health = () =>
      new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: running.port, path: '/api/health', agent: false }, (r) => {
          let body = '';
          r.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => resolve(JSON.parse(body).events));
        }).on('error', reject);
      });
    try {
      for (const [label, payload] of cases) {
        const stdin = JSON.stringify(payload);
        const before = await health();
        const result = await runForwarder({ home, stdin });
        assertSilentExit(result, label);
        assert.ok(result.ownMs < STUCK_MS, `${label}: ${result.ownMs.toFixed(0)} ms`);
        const after = await health();
        assert.equal(after.accepted - before.accepted, 1, `${label}: o servidor respondeu 204 e aceitou`);
        assert.equal(after.rejected, before.rejected, `${label}: nenhum 413`);
      }
    } finally {
      await running.close();
    }
    const dumps = path.join(home, 'dumps');
    const lines = readdirSync(dumps).flatMap((file) => readFileSync(path.join(dumps, file), 'utf8').trim().split('\n'));
    assert.equal(lines.length, cases.length);
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= MAX_BODY_BYTES);
      const envelope = JSON.parse(line);
      assert.equal(envelope.truncated, true);
      assert.equal(envelope.payload.session_id, ids.session_id);
      assert.equal(envelope.payload.hook_event_name, ids.hook_event_name);
    }
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
