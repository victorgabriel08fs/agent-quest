// Encaminhador da captura (T4): funções puras e o processo real (`node forward.mjs`)
// em cada caso de falha. Sempre com AGENT_QUEST_HOME temporário e porta efêmera
// (ADR 0010): nada aqui toca no diretório de dados real nem na porta 47821.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
  MAX_STRING_CHARS,
  POST_TIMEOUT_MS,
  TAIL_CHARS,
  buildEnvelope,
  cutString,
  isPidAlive,
  isValidPort,
  parsePayload,
  readRuntime,
  resolveDataDir,
  truncateStrings,
} from '../../../capture/plugins/agent-quest/scripts/forward.mjs';
import { deadPid, tempDir } from '../server/helpers.js';

const FORWARDER = fileURLToPath(new URL('../../../capture/plugins/agent-quest/scripts/forward.mjs', import.meta.url));
const SOURCE = readFileSync(FORWARDER, 'utf8');

/** Limites do T4. */
const FAST_MS = 300;
const STUCK_MS = 2200;

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
function spawnTimed(args, { env, stdin = '', keepStdinOpen = false }) {
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
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', (err) => (stdinError = err.code ?? 'erro'));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const ms = performance.now() - begin;
      let ownMs = Infinity;
      try {
        ownMs = Number(readFileSync(timingFile, 'utf8'));
      } catch {
        // sem arquivo: o processo não saiu normalmente
      }
      resolve({ code, signal, stdout, stderr, stdinError, ms, ownMs });
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

/** Saída 0, sem nada em stdout nem em stderr. */
function assertSilentExit(result, label = '') {
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
 *   jeito, logo antes): passa também se o encaminhador gastar, além dela, no
 *   máximo o limite menos a folga de partida;
 * - se todas falharem e até a referência estiver muito acima do normal, a máquina
 *   está sobrecarregada e não há como medir: o teste é marcado como pulado, com o
 *   motivo e as medidas (as checagens de saída 0 e silêncio continuam valendo).
 * Uma regressão real (uma espera fixa, um trabalho pesado) numa máquina normal
 * reprova. Toda tentativa precisa sair em silêncio.
 */
async function assertFast(t, run, limitMs, label) {
  const attempts = [];
  let fastestReference = Infinity;
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    const reference = await spawnTimed([IMPORTS_ONLY], { env: minimalEnv({}) });
    result = await run();
    assertSilentExit(result, label);
    fastestReference = Math.min(fastestReference, reference.ownMs);
    attempts.push(`${result.ownMs.toFixed(0)} ms (referência ${reference.ownMs.toFixed(0)} ms)`);
    if (result.ownMs < limitMs || result.ownMs - reference.ownMs < limitMs - NODE_STARTUP_ALLOWANCE_MS) return result;
  }
  const summary = `${label}: acima de ${limitMs} ms em todas as tentativas: ${attempts.join('; ')}`;
  if (fastestReference > OVERLOADED_NODE_MS) {
    t.skip(`tempo não avaliado, máquina sobrecarregada (referência em no mínimo ${fastestReference.toFixed(0)} ms). ${summary}`);
    return result;
  }
  assert.fail(summary);
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
