// Utilitários dos testes de integração da captura (T4, tester). Não é arquivo de teste.
//
// Regras do ADR 0010 seguidas aqui:
// - o diretório de dados é sempre temporário (AGENT_QUEST_HOME ou LOCALAPPDATA
//   apontando para uma pasta criada pelo teste), nunca o real;
// - o servidor real do T3 sobe com --port 0, e os servidores falsos escutam em
//   portas livres sorteadas, nunca na 47821;
// - o encaminhador roda como o Claude Code o roda: processo filho, `node` com o
//   caminho do forward.mjs, JSON no stdin, ambiente mínimo e sem console.

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { REPO, launchServer, killTree, minimalEnv, request, tempDir, waitFor } from './server-helpers.js';

export const PLUGIN_DIR = path.join(REPO, 'capture', 'plugins', 'agent-quest');
export const FORWARDER = path.join(PLUGIN_DIR, 'scripts', 'forward.mjs');
export const PLUGIN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')).version;

/** Limites do T4 (plano, critérios de aceite). */
export const FAST_LIMIT_MS = 300;
export const STUCK_LIMIT_MS = 2200;

/** Folga para a partida do Node com os módulos do encaminhador (ADR 0001 mediu cerca de 60 ms). */
const STARTUP_ALLOWANCE_MS = 150;
/** Referência acima disto em todas as rodadas indica máquina sobrecarregada. */
const OVERLOADED_REFERENCE_MS = 150;
/** Rodadas de medição por caso. */
const TIMING_ROUNDS = 5;

const temps = [];
/** Pasta temporária apagada por `cleanupTemps()`. */
export function newTemp(prefix = 'aq-int-cap-') {
  const tmp = tempDir(prefix);
  temps.push(tmp);
  return tmp.dir;
}
export function cleanupTemps() {
  for (const tmp of temps.splice(0)) tmp.cleanup();
}

// --- medição de tempo -------------------------------------------------------

/**
 * Preload só de teste (`node --import`): grava em AQ_TIMING_FILE, na saída, o
 * tempo de vida do processo (`performance.now()` conta do início do Node).
 * Não imprime nada.
 */
// Fora da lista de `cleanupTemps()`: o preload precisa existir até o fim do arquivo de teste.
const timingTemp = tempDir('aq-int-cap-timing-');
process.once('exit', () => timingTemp.cleanup());
const TIMING_DIR = timingTemp.dir;
const TIMER = path.join(TIMING_DIR, 'lifetime.mjs');
writeFileSync(
  TIMER,
  [
    "import { writeFileSync } from 'node:fs';",
    "import process from 'node:process';",
    "process.on('exit', () => {",
    '  try { writeFileSync(process.env.AQ_TIMING_FILE, String(performance.now())); } catch {}',
    '});',
    '',
  ].join('\n'),
);
const TIMER_URL = pathToFileURL(TIMER).href;

/** Referência: só importa os mesmos módulos node:* do encaminhador e sai. */
const REFERENCE = path.join(TIMING_DIR, 'reference.mjs');
writeFileSync(
  REFERENCE,
  [...readFileSync(FORWARDER, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+['"](node:[^'"]+)['"]/gm)]
    .map((m) => `import '${m[1]}';`)
    .join('\n'),
);
let timingSeq = 0;

/**
 * Roda `node <script>` e devolve código, sinal, saídas, erro de escrita no stdin
 * (EPIPE se o filho fechou o pipe antes de ler tudo), tempo de parede e tempo de
 * vida do próprio processo. Um guarda encerra o filho que passar de `guardMs`,
 * para uma regressão que trave virar falha, e não um teste que nunca termina.
 * @param {string} script
 * @param {{ env: Record<string,string>, stdin?: string|Buffer, keepStdinOpen?: boolean, cwd?: string, guardMs?: number, timed?: boolean }} options
 */
export function runNode(script, { env, stdin = '', keepStdinOpen = false, cwd, guardMs = 10_000, timed = true }) {
  const timingFile = path.join(TIMING_DIR, `t${timingSeq++}.txt`);
  const args = timed ? ['--import', TIMER_URL, script] : [script];
  return new Promise((resolve, reject) => {
    const begin = performance.now();
    const beginEpoch = Date.now();
    const child = spawn(process.execPath, args, {
      cwd,
      env: timed ? { ...env, AQ_TIMING_FILE: timingFile } : env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let guardKilled = false;
    const guard = setTimeout(() => {
      guardKilled = true;
      child.kill();
    }, guardMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', (err) => (stdinError = err.code ?? 'erro'));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      const wallMs = performance.now() - begin;
      let ownMs = Infinity;
      if (timed) {
        try {
          ownMs = Number(readFileSync(timingFile, 'utf8'));
        } catch {
          // sem arquivo: o processo não saiu pelo caminho normal
        }
      }
      resolve({ code, signal, stdout, stderr, stdinError, wallMs, ownMs, guardKilled, beginEpoch, endEpoch: Date.now() });
    });
    if (keepStdinOpen) child.stdin.write(stdin);
    else child.stdin.end(stdin);
  });
}

/** Ambiente do encaminhador: mínimo, com o diretório de dados temporário. */
export function forwarderEnv(extra = {}) {
  return minimalEnv({ CLAUDE_PROJECT_DIR: 'C:\\Users\\usuario\\Projetos\\exemplo', ...extra });
}

/** `node forward.mjs` como o Claude Code roda. */
export function runForwarder({ forwarder = FORWARDER, env, stdin = '', keepStdinOpen = false, cwd, guardMs, timed = true }) {
  return runNode(forwarder, { env, stdin, keepStdinOpen, cwd, guardMs, timed });
}

/** Código 0, sem sinal, sem guarda e nada em stdout nem em stderr. */
export function assertSilentExit(result, label = '') {
  assert.equal(result.guardKilled, false, `${label}: o processo travou e foi encerrado pelo guarda do teste`);
  assert.equal(result.code, 0, `${label}: código de saída`);
  assert.equal(result.signal, null, `${label}: sinal`);
  assert.equal(result.stdout, '', `${label}: stdout`);
  assert.equal(result.stderr, '', `${label}: stderr`);
}

/**
 * Confere o tempo do critério sem depender da carga da máquina por acaso:
 * - mede o tempo de vida do próprio processo, não o do spawn;
 * - até 5 rodadas; em cada uma, a referência (Node com os mesmos módulos) logo antes;
 * - passa na primeira rodada dentro do limite literal;
 * - se nenhuma passar, aceita quando a mediana do encaminhador ficou, além da
 *   mediana da referência, dentro do limite menos a folga de partida (máquina
 *   lenta, encaminhador rápido);
 * - se nem isso e a mediana da referência estiver acima do normal, pula com as
 *   medidas (o pulo aparece no resumo e impede a aprovação da tarefa);
 * - senão, falha com as medidas.
 * Toda rodada precisa sair em silêncio com 0.
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @param {(round: number) => Promise<any>} runOnce
 * @param {number} limitMs
 */
export async function assertWithinLimit(t, label, runOnce, limitMs) {
  const rows = [];
  let last;
  for (let round = 0; round < TIMING_ROUNDS; round++) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    const reference = await runNode(REFERENCE, { env: minimalEnv() });
    last = await runOnce(round);
    assertSilentExit(last, label);
    rows.push({ own: last.ownMs, wall: last.wallMs, ref: reference.ownMs });
    // As medidas da referência servem também para julgar a carga (regra de entrega abaixo).
    last.references = rows.map((r) => r.ref);
    if (last.ownMs <= limitMs) {
      t.diagnostic(`${label}: ${last.ownMs.toFixed(0)} ms de vida (parede ${last.wallMs.toFixed(0)} ms; referência ${reference.ownMs.toFixed(0)} ms), rodada ${round + 1}`);
      return last;
    }
  }
  const text = rows.map((r) => `${r.own.toFixed(0)} ms (parede ${r.wall.toFixed(0)}, referência ${r.ref.toFixed(0)})`).join('; ');
  // Mediana contra mediana: um pico isolado da referência numa rodada não pode
  // esconder uma regressão (a menor diferença por rodada esconderia).
  const excess = median(rows.map((r) => r.own)) - median(rows.map((r) => r.ref));
  if (excess <= limitMs - STARTUP_ALLOWANCE_MS) {
    t.diagnostic(`${label}: acima de ${limitMs} ms com a máquina lenta, mas a mediana ficou só ${excess.toFixed(0)} ms além da da referência: ${text}`);
    return last;
  }
  // Sobrecarga pela mediana da referência, como o critério relativo acima: uma
  // rodada rápida isolada não decide (com a suíte inteira em paralelo, a mediana
  // passa de 300 ms mesmo com uma ou outra rodada abaixo de 150).
  const load = loadFrom(rows.map((r) => r.ref));
  if (!load.normal) {
    t.skip(`tempo não avaliado: máquina sobrecarregada (${load.text}). ${label}: ${text}`);
    return last;
  }
  assert.fail(`${label}: acima de ${limitMs} ms em todas as rodadas: ${text}`);
}

// --- entrega sob carga ---------------------------------------------------------
//
// O ADR 0001 manda o encaminhador desistir (POST de 1 s, processo de 2 s) para
// nunca atrasar o Claude Code. Sob sobrecarga extrema (por exemplo, a suíte
// inteira rodando em paralelo), um evento pode se perder por isso, e esse é o
// comportamento exigido. A regra dos testes, sem afrouxar o resto:
// - saída 0 e silêncio valem sempre, com ou sem entrega;
// - um evento só pode se perder se o processo dele esperou um dos prazos (viveu
//   pelo menos DEADLINE_HIT_MS); saiu rápido sem entregar é falha, sempre;
// - com a máquina normal (referência de partida do Node dentro do normal), nenhum
//   evento pode se perder.

/** Vida mínima de um processo que esperou o prazo do POST (1 s) ou o do processo (2 s). */
export const DEADLINE_HIT_MS = 950;

/** O encaminhador esperou um dos prazos do ADR 0001. */
export function hitDeadline(result) {
  // Sem medição (timed: false) não há como provar que o prazo foi atingido.
  return Number.isFinite(result.ownMs) && result.ownMs >= DEADLINE_HIT_MS;
}

/** Tempo de vida da referência (Node com os módulos do encaminhador), uma vez. */
export async function referenceMs() {
  return (await runNode(REFERENCE, { env: minimalEnv() })).ownMs;
}

/**
 * Roda `work` medindo a referência em paralelo, sem parar, enquanto ele dura: a
 * carga é a do momento em que os encaminhadores rodaram, não a de depois.
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<{ value: T, samples: number[] }>}
 */
export async function withLoadSamples(work) {
  const samples = [];
  let done = false;
  const sampler = (async () => {
    do samples.push(await referenceMs());
    while (!done);
  })();
  try {
    return { value: await work(), samples };
  } finally {
    done = true;
    await sampler;
  }
}

/** A máquina está normal se a mediana da referência ficou até o limite de sobrecarga. */
export function loadFrom(samples) {
  const ms = median(samples);
  return { ms, normal: ms <= OVERLOADED_REFERENCE_MS, text: `referência mediana ${ms.toFixed(0)} ms em ${samples.length} medida(s)` };
}

/**
 * Exige a entrega de um evento, com a regra acima. `attempt` roda o encaminhador
 * (com medição de tempo) e devolve o resultado e uma função que diz se o evento
 * chegou. Até 3 tentativas: sem entrega e sem prazo atingido, falha; sem entrega
 * em todas, sempre por prazo e com a máquina sobrecarregada (medida durante as
 * tentativas), pula com as medidas; com a máquina normal, falha.
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @param {(n: number) => Promise<{ result: any, delivered: () => any }>} attempt
 * @param {{ attempts?: number, waitMs?: number, samplesOut?: number[]|null }} [options]  `samplesOut` recebe as medidas de carga
 * @returns {Promise<any>} o valor devolvido por `delivered`, ou null se pulou
 */
export async function assertDelivered(t, label, attempt, { attempts = 3, waitMs = 3000, samplesOut = null } = {}) {
  const misses = [];
  const samples = [];
  for (let n = 0; n < attempts; n++) {
    const { value: run, samples: during } = await withLoadSamples(() => attempt(n));
    samples.push(...during);
    samplesOut?.push(...during);
    const { result, delivered } = run;
    assertSilentExit(result, label);
    const value = await waitFor(delivered, { timeoutMs: waitMs, label }).catch(() => null);
    if (value) {
      if (misses.length) t.diagnostic(`${label}: entregue na tentativa ${n + 1}; antes, prazo esgotado em ${misses.join('; ')}`);
      return value;
    }
    assert.ok(
      hitDeadline(result),
      `${label}: o encaminhador saiu em ${result.ownMs.toFixed(0)} ms sem entregar, sem ter esperado nenhum prazo do ADR 0001`,
    );
    misses.push(`${result.ownMs.toFixed(0)} ms de vida (parede ${result.wallMs.toFixed(0)} ms)`);
  }
  const load = loadFrom(samples);
  assert.ok(!load.normal, `${label}: nenhuma entrega com a máquina normal (${load.text}): ${misses.join('; ')}`);
  t.skip(`entrega não avaliada: máquina sobrecarregada (${load.text}); nas ${attempts} tentativas o encaminhador esgotou o prazo do ADR 0001 sem entregar: ${misses.join('; ')}`);
  return null;
}

/**
 * Muitos encaminhadores de uma vez: confere a regra das perdas.
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @param {{ result: any, delivered: boolean }[]} runs
 * @param {number[]} samples  medidas da referência feitas durante os envios
 */
export function assertLossesOnlyByDeadline(t, label, runs, samples) {
  const lost = runs.filter((r) => !r.delivered);
  const fast = lost.filter((r) => !hitDeadline(r.result));
  assert.deepEqual(
    fast.map((r) => `${r.result.ownMs.toFixed(0)} ms`),
    [],
    `${label}: encaminhador(es) que saíram rápido sem entregar, sem esperar prazo nenhum`,
  );
  if (lost.length === 0) return;
  const load = loadFrom(samples);
  assert.ok(!load.normal, `${label}: ${lost.length} de ${runs.length} eventos perdidos com a máquina normal (${load.text})`);
  t.diagnostic(
    `${label}: máquina sobrecarregada (${load.text}); ${lost.length} de ${runs.length} eventos perdidos, todos por prazo do ADR 0001 ` +
      `(${lost.map((r) => `${r.result.ownMs.toFixed(0)} ms`).join(', ')})`,
  );
}

/**
 * Tempo de vida dentro do prazo do processo (ADR 0001, 2 s), com a regra de
 * carga: acima do limite com a máquina normal (medida durante os envios) é falha;
 * com a máquina sobrecarregada, o timer do próprio processo dispara atrasado, e o
 * excesso vira diagnóstico com as medidas.
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @param {any[]} results
 * @param {number[]} samples
 * @param {number} limitMs
 */
export function assertLifetimeWithin(t, label, results, samples, limitMs) {
  const late = results.filter((r) => !(r.ownMs <= limitMs)).map((r) => `${r.ownMs.toFixed(0)} ms`);
  if (late.length === 0) return;
  const load = loadFrom(samples);
  assert.ok(!load.normal, `${label}: acima de ${limitMs} ms com a máquina normal (${load.text}): ${late.join(', ')}`);
  t.diagnostic(`${label}: máquina sobrecarregada (${load.text}); ${late.length} processo(s) acima de ${limitMs} ms (${late.join(', ')})`);
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- servidor real do T3 ----------------------------------------------------

/**
 * Sobe `node server/main.js --port 0 --debug-dump` com o diretório de dados
 * temporário. O --debug-dump grava cada envelope aceito exatamente como chegou,
 * o que permite conferir o envelope sem mexer no servidor.
 * @param {{ dataDir: string, env: Record<string,string> }} options  `env` define AGENT_QUEST_HOME ou LOCALAPPDATA
 */
export async function startRealServer({ dataDir, env }) {
  const run = launchServer(['--port', '0', '--debug-dump'], minimalEnv(env));
  const started = await run.started;
  if (!started) throw new Error(`o servidor real não subiu:\n${run.output()}`);
  let runtime;
  try {
    runtime = await waitFor(() => readJson(path.join(dataDir, 'runtime.json')), { label: 'runtime.json do servidor real' });
  } catch (err) {
    await killTree(run.child); // sem runtime.json, o servidor não pode ficar sobrando
    throw err;
  }
  return {
    run,
    runtime,
    dataDir,
    port: runtime.port,
    async health() {
      const res = await request(runtime.port, { path: '/api/health' });
      assert.equal(res.status, 200);
      return JSON.parse(res.text).events;
    },
    /** Envelopes gravados pelo --debug-dump até agora (só linhas completas). */
    dumped() {
      const dir = path.join(dataDir, 'dumps');
      if (!existsSync(dir)) return [];
      const envelopes = [];
      for (const file of readdirSync(dir).sort()) {
        const text = readFileSync(path.join(dir, file), 'utf8');
        for (const line of text.split('\n').slice(0, -1)) envelopes.push(JSON.parse(line));
      }
      return envelopes;
    },
    /** Espera o envelope cujo payload satisfaz `predicate`. */
    async waitDumped(predicate, label = 'envelope no dump') {
      return waitFor(() => this.dumped().find((e) => predicate(e.payload)), { timeoutMs: 5000, label });
    },
    stop: () => killTree(run.child),
  };
}

/** runtime.json num diretório de dados (texto cru ou objeto). */
export function writeRuntime(dataDir, data) {
  writeFileSync(path.join(dataDir, 'runtime.json'), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// --- servidores falsos --------------------------------------------------------

/** HTTP que registra os pedidos e responde 204. `hang`: lê o corpo e nunca responde. */
export async function recordingHttpServer({ hang = false, host = '127.0.0.1', port = 0 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw.toString('utf8'), bytes: raw.length });
      if (!hang) {
        res.writeHead(204);
        res.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** TCP que aceita a conexão e nunca lê nem escreve (servidor travado de verdade). */
export async function tcpBlackHole({ host = '127.0.0.1', port = 0 } = {}) {
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.pause();
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    connections: () => sockets.length,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

/** Porta livre de 127.0.0.1 em que ninguém escuta (nunca a 47821). */
export async function closedPort() {
  for (;;) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (port !== 47821) return port;
  }
}

/** Pid de um processo que já terminou. */
export async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

let payloadSeq = 0;
/** Payload de hook realista, com ids únicos (para não cair na deduplicação). */
export function hookPayload(extra = {}) {
  const n = `${process.pid}-${Date.now()}-${payloadSeq++}`;
  return {
    session_id: `sessao-${n}`,
    transcript_path: 'C:\\Users\\usuario\\.claude\\projects\\exemplo\\sessao.jsonl',
    cwd: 'C:\\Users\\usuario\\Projetos\\exemplo',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'C:\\Users\\usuario\\Projetos\\exemplo\\CLAUDE.md' },
    tool_use_id: `toolu_${n}`,
    ...extra,
  };
}
