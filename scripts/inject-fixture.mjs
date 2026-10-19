// @ts-check
// `npm run inject -- <arquivo> [--fast] [--speed N]` (T9b; ADR 0010, complemento
// "formato e sanitização dos cenários de hooks"): ferramenta de desenvolvimento
// que injeta um cenário de hooks no servidor local, pelo mesmo caminho da
// captura (POST /hooks, com o token do runtime.json).
//
// - Lê qualquer arquivo no formato do ADR 0010:
//   `{ name, description, events: [{ dt, env, payload }] }`.
// - Para cada evento, monta um envelope v1 com `sentAt` igual à hora do envio
//   (nunca repetida: no mesmo milissegundo, a seguinte ganha +1 ms, para a
//   ordem dos `ts` ser a do cenário), o `env` e o `payload` do cenário.
// - Respeita os intervalos `dt` pela agenda (início + soma dos `dt`), sem
//   acumular o atraso de cada envio. `--fast` não espera; `--speed N` divide os
//   intervalos por N.
// - Só envia para 127.0.0.1, na porta do runtime.json (1024 a 65535), e só
//   com o servidor vivo (pid do runtime.json).
// - O servidor descarta o mesmo payload repetido em até 5 s (duplicatas):
//   injetar o mesmo cenário duas vezes seguidas conta como duplicado.
//
// Também é um módulo: `injectScenario` injeta um cenário já carregado (os E2E
// do painel usam os cenários sintéticos sem gravar arquivo).

import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HOST, resolveDataDir } from '../server/config.js';
import { isPidAlive, readRuntimeFile } from '../server/runtime-file.js';

/** Valor do campo `forwarder` dos envelopes injetados. */
export const INJECTOR_ID = 'inject';

/** Prazo de cada POST. */
export const POST_TIMEOUT_MS = 5000;

const USAGE = 'Uso: npm run inject -- <arquivo.json> [--fast] [--speed N]';

/**
 * @typedef {object} ScenarioEvent
 * @property {number} dt                 ms desde o evento anterior
 * @property {{ projectDir?: string|null, entrypoint?: string|null }|null} [env]
 * @property {Record<string, unknown>} payload
 */

/**
 * @typedef {object} Scenario
 * @property {string} [name]
 * @property {string} [description]
 * @property {ScenarioEvent[]} events
 */

/**
 * @typedef {object} InjectOptions
 * @property {number} port
 * @property {string} token
 * @property {boolean} [fast]            não espera os intervalos
 * @property {number} [speed]            divide os intervalos (padrão 1)
 * @property {() => number} [now]        relógio (ms); os testes trocam
 * @property {(ms: number) => Promise<unknown>} [sleep]   espera; os testes trocam
 * @property {(port: number, token: string, envelope: object) => Promise<number>} [post]   envio; os testes trocam
 * @property {(index: number, status: number) => void} [onSent]
 */

/**
 * @typedef {object} InjectResult
 * @property {number} sent
 * @property {number} accepted           respondidos com 204
 * @property {{ index: number, status: number }[]} refused   outros status (0: sem resposta)
 */

/**
 * Argumentos da linha de comando.
 * @param {string[]} argv
 * @returns {{ ok: true, file: string, fast: boolean, speed: number } | { ok: false, error: string }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const files = [];
  let fast = false;
  let speed = 1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fast') {
      fast = true;
    } else if (arg === '--speed' || arg.startsWith('--speed=')) {
      const text = arg === '--speed' ? argv[++i] : arg.slice('--speed='.length);
      const value = Number(text);
      if (text === undefined || text.trim() === '' || !Number.isFinite(value) || value <= 0) {
        return { ok: false, error: `--speed precisa de um número maior que zero. ${USAGE}` };
      }
      speed = value;
    } else if (arg.startsWith('-')) {
      return { ok: false, error: `Opção desconhecida: ${arg}. ${USAGE}` };
    } else {
      files.push(arg);
    }
  }
  if (files.length !== 1) return { ok: false, error: USAGE };
  return { ok: true, file: files[0], fast, speed };
}

/**
 * Confere a forma do cenário (ADR 0010). O conteúdo dos payloads é problema do
 * servidor, que valida o envelope e normaliza.
 * @param {unknown} value
 * @returns {{ ok: true, scenario: Scenario } | { ok: false, error: string }}
 */
export function validateScenario(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'o cenário precisa ser um objeto' };
  const events = /** @type {any} */ (value).events;
  if (!Array.isArray(events)) return { ok: false, error: 'o cenário precisa de uma lista "events"' };
  for (const [index, event] of events.entries()) {
    if (event === null || typeof event !== 'object') return { ok: false, error: `events[${index}] não é um objeto` };
    if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      return { ok: false, error: `events[${index}].payload não é um objeto` };
    }
    if (event.dt !== undefined && (typeof event.dt !== 'number' || !Number.isFinite(event.dt) || event.dt < 0)) {
      return { ok: false, error: `events[${index}].dt precisa ser um número maior ou igual a zero` };
    }
  }
  return { ok: true, scenario: /** @type {Scenario} */ (value) };
}

/**
 * Envelope v1 de um evento (seção 1 do modelo de eventos).
 * @param {ScenarioEvent} event
 * @param {number} sentAt
 */
export function envelopeFor(event, sentAt) {
  const env = event.env && typeof event.env === 'object' ? event.env : {};
  return {
    v: 1,
    sentAt,
    forwarder: INJECTOR_ID,
    env: { projectDir: env.projectDir ?? null, entrypoint: env.entrypoint ?? null },
    truncated: false,
    payload: event.payload,
  };
}

/**
 * Injeta os eventos em ordem, um POST de cada vez, respeitando os intervalos.
 * @param {Scenario} scenario
 * @param {InjectOptions} options
 * @returns {Promise<InjectResult>}
 */
export async function injectScenario(scenario, {
  port,
  token,
  fast = false,
  speed = 1,
  now = Date.now,
  sleep = (ms) => sleepFor(ms),
  post = postEnvelope,
  onSent = () => {},
}) {
  checkPort(port);
  const start = now();
  let elapsed = 0;
  let lastSentAt = -Infinity;
  /** @type {InjectResult} */
  const result = { sent: 0, accepted: 0, refused: [] };
  for (const [index, event] of scenario.events.entries()) {
    if (index > 0) elapsed += Number.isFinite(event.dt) && event.dt > 0 ? event.dt : 0;
    if (!fast) {
      const wait = start + elapsed / speed - now();
      if (wait > 0) await sleep(wait);
    }
    const sentAt = Math.max(now(), lastSentAt + 1);
    lastSentAt = sentAt;
    const status = await post(port, token, envelopeFor(event, sentAt));
    result.sent++;
    if (status === 204) result.accepted++;
    else result.refused.push({ index, status });
    onSent(index, status);
  }
  return result;
}

/**
 * POST /hooks em 127.0.0.1, como o encaminhador: JSON, token, sem `Origin`.
 * @param {number} port
 * @param {string} token
 * @param {object} envelope
 * @returns {Promise<number>}            status HTTP, ou 0 sem resposta
 */
export function postEnvelope(port, token, envelope) {
  checkPort(port);
  const body = JSON.stringify(envelope);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port,
        method: 'POST',
        path: '/hooks',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Agent-Quest-Token': token,
        },
      },
      (/** @type {any} */ res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(res.statusCode ?? 0));
      },
    );
    req.setTimeout(POST_TIMEOUT_MS, () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

/**
 * Linha de comando. Devolve o código de saída.
 * @param {{ argv: string[], env: Record<string, string|undefined>, platform: string, homedir: string,
 *   log?: (message: string) => void, logError?: (message: string) => void,
 *   sleep?: (ms: number) => Promise<unknown> }} options
 * @returns {Promise<number>}
 */
export async function runInject({ argv, env, platform, homedir, log = console.log, logError = console.error, sleep }) {
  const args = parseArgs(argv);
  if (!args.ok) {
    logError(args.error);
    return 1;
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(args.file, 'utf8'));
  } catch (err) {
    logError(`Não foi possível ler o cenário ${args.file} (${errorKind(err)}).`);
    return 1;
  }
  const checked = validateScenario(parsed);
  if (!checked.ok) {
    logError(`Cenário inválido em ${args.file}: ${checked.error}.`);
    return 1;
  }

  const dataDir = resolveDataDir({ env, platform, homedir });
  const runtime = readRuntimeFile(dataDir);
  if (!runtime || !isPidAlive(runtime.pid)) {
    logError(`O Agent Quest não está rodando (sem runtime.json válido em ${dataDir}). Inicie com npm start e tente de novo.`);
    return 1;
  }
  if (!isValidPort(runtime.port)) {
    logError(`A porta do runtime.json (${runtime.port}) está fora de 1024 a 65535; nada foi enviado.`);
    return 1;
  }

  const { scenario } = checked;
  const mode = args.fast ? 'sem esperar os intervalos' : args.speed === 1 ? 'no ritmo do cenário' : `${args.speed}x mais rápido`;
  log(`Injetando ${scenario.events.length} eventos de ${scenario.name ?? args.file} em http://${HOST}:${runtime.port}/ (${mode}).`);
  const result = await injectScenario(scenario, {
    port: runtime.port,
    token: runtime.token,
    fast: args.fast,
    speed: args.speed,
    ...(sleep ? { sleep } : {}),
  });
  if (result.refused.length === 0) {
    log(`Pronto: ${result.accepted} eventos aceitos.`);
    return 0;
  }
  const sample = result.refused.slice(0, 5).map((item) => `#${item.index} (${item.status || 'sem resposta'})`).join(', ');
  logError(`${result.accepted} de ${result.sent} eventos aceitos; recusados: ${sample}${result.refused.length > 5 ? ', …' : ''}.`);
  return 1;
}

/**
 * @param {unknown} port
 * @returns {boolean}
 */
function isValidPort(port) {
  return Number.isInteger(port) && /** @type {number} */ (port) >= 1024 && /** @type {number} */ (port) <= 65535;
}

/** @param {unknown} port */
function checkPort(port) {
  if (!isValidPort(port)) throw new RangeError('porta fora de 1024 a 65535');
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorKind(err) {
  const e = /** @type {any} */ (err);
  return String(e?.code ?? e?.name ?? 'Error');
}

/** @returns {boolean} */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await runInject({ argv: process.argv.slice(2), env: process.env, platform: process.platform, homedir: os.homedir() });
}
