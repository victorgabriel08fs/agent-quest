// @ts-check
// Encaminhador da captura do Agent Quest (ADR 0001; modelo de eventos, seção 1).
//
// Roda como hook `command` assíncrono do plugin agent-quest, um processo por
// evento. Recebe o JSON do hook no stdin e faz POST de um envelope v1 para o
// servidor local em 127.0.0.1, na porta do runtime.json.
//
// Regras que nunca podem ser quebradas (o Claude Code não pode ser atrapalhado):
// - nunca escreve em stdout nem em stderr (em hook assíncrono, o stdout chega ao
//   modelo no turno seguinte);
// - sempre sai com código 0, em qualquer caso;
// - se encerra sozinho em no máximo 2 s; o POST desiste em 1 s;
// - só envia para 127.0.0.1, na porta do runtime.json, de 1024 a 65535;
// - sem dependências, só com APIs do Node 18 ou mais novo (o PATH do Claude Code
//   pode apontar para outra versão do Node). Por isso não usa `fetch`, que no
//   Node 18 imprime um aviso de recurso experimental.
//
// Ordem (ADR 0001): lê o stdin até o fim, depois o runtime.json; sem servidor
// no ar, sai sem nem interpretar o JSON. Tudo fica num arquivo só, para um
// deploy feito com sessões rodando nunca juntar versões diferentes de dois módulos.
//
// As funções são exportadas para os testes; o encaminhamento só roda quando o
// arquivo é o ponto de entrada (`node forward.mjs`).

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

/** `Date.now()` no início do processo: vira o `sentAt` do envelope. */
const startedAt = Date.now();

/** Versão do encaminhador (igual à do plugin.json; um teste confere). */
export const FORWARDER_VERSION = '0.1.0';

/** Único destino possível (ADR 0006). */
export const HOST = '127.0.0.1';
export const HOOKS_PATH = '/hooks';
export const TOKEN_HEADER = 'X-Agent-Quest-Token';
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/** Mesmos nomes do servidor (server/config.js e server/runtime-file.js). */
export const DATA_DIR_NAME = 'agent-quest';
export const RUNTIME_FILE_NAME = 'runtime.json';

/** Limites (visão geral, "Limites e valores padrão"). */
export const MAX_STDIN_BYTES = 16 * 1024 * 1024;
export const DEADLINE_MS = 2000;
export const POST_TIMEOUT_MS = 1000;

/** Strings acima de 4 KiB viram 1 KiB do início + 3 KiB do fim (em caracteres). */
export const MAX_STRING_CHARS = 4 * 1024;
export const HEAD_CHARS = 1024;
export const TAIL_CHARS = 3 * 1024;

/**
 * @typedef {object} Runtime
 * @property {number} port
 * @property {string} token
 * @property {number} pid
 */

/**
 * Diretório de dados, com a mesma regra do servidor (`resolveDataDir` em
 * server/config.js; um teste compara as duas): `AGENT_QUEST_HOME`, se definido;
 * no Windows, `%LOCALAPPDATA%\agent-quest`; nos outros sistemas,
 * `$XDG_STATE_HOME/agent-quest` ou `~/.local/state/agent-quest`.
 * @param {{ env: Record<string, string|undefined>, platform: string, homedir: string }} options
 * @returns {string}
 */
export function resolveDataDir({ env, platform, homedir }) {
  if (env.AGENT_QUEST_HOME) return env.AGENT_QUEST_HOME;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(localAppData, DATA_DIR_NAME);
  }
  const stateHome = env.XDG_STATE_HOME || path.posix.join(homedir, '.local', 'state');
  return path.posix.join(stateHome, DATA_DIR_NAME);
}

/**
 * @param {unknown} port
 * @returns {port is number}
 */
export function isValidPort(port) {
  return Number.isInteger(port) && /** @type {number} */ (port) >= MIN_PORT && /** @type {number} */ (port) <= MAX_PORT;
}

/**
 * Lê porta, token e pid do runtime.json. Devolve `null` se o arquivo não existir,
 * não for JSON ou tiver algum campo fora do esperado (porta fora de 1024 a 65535,
 * por exemplo).
 * @param {string} dataDir
 * @returns {Runtime|null}
 */
export function readRuntime(dataDir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dataDir, RUNTIME_FILE_NAME), 'utf8'));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const { port, token, pid } = data;
  if (!isValidPort(port)) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { port, token, pid };
}

/**
 * Diz se existe um processo com esse pid. `EPERM` significa que existe, mas é
 * de outro usuário.
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * Lê o stdin inteiro, guardando até `limit` bytes. Acima disso, continua lendo
 * e descartando até o fim (para quem escreve não receber erro de pipe) e
 * devolve `null`.
 * @param {any} stream
 * @param {number} limit
 * @returns {Promise<Uint8Array|null>}
 */
export function readStdin(stream, limit) {
  return new Promise((resolve) => {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let overflow = false;
    stream.on('data', (/** @type {Uint8Array} */ chunk) => {
      total += chunk.length;
      if (overflow) return;
      if (total > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(overflow ? null : Buffer.concat(chunks, total)));
    stream.on('error', () => resolve(null));
  });
}

/**
 * Interpreta o stdin do hook. Só um objeto JSON é aceito.
 * @param {Uint8Array} bytes
 * @returns {Record<string, unknown>|null}
 */
export function parsePayload(bytes) {
  try {
    const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Corta uma string longa: 1 KiB do início + 3 KiB do fim, separados por
 * `…[cortado N caracteres]…`. O fim é preservado porque o resumo dos testes fica
 * no fim da saída. Não parte pares substitutos (emoji e afins).
 * @param {string} text
 * @returns {string}
 */
export function cutString(text) {
  let head = HEAD_CHARS;
  let tail = text.length - TAIL_CHARS;
  if (isHighSurrogate(text.charCodeAt(head - 1))) head -= 1;
  if (isLowSurrogate(text.charCodeAt(tail))) tail += 1;
  return `${text.slice(0, head)}…[cortado ${tail - head} caracteres]…${text.slice(tail)}`;
}

/**
 * Corta, no próprio objeto, toda string acima de 4 KiB, em qualquer nível.
 * @param {unknown} root
 * @returns {{ value: unknown, truncated: boolean }}
 */
export function truncateStrings(root) {
  let truncated = false;

  /**
   * @param {unknown} value
   * @returns {unknown}
   */
  function visit(value) {
    if (typeof value === 'string') {
      if (value.length <= MAX_STRING_CHARS) return value;
      truncated = true;
      return cutString(value);
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = visit(value[i]);
      return value;
    }
    if (value !== null && typeof value === 'object') {
      const object = /** @type {Record<string, unknown>} */ (value);
      for (const key of Object.keys(object)) {
        const next = visit(object[key]);
        // defineProperty, e não atribuição, para uma chave "__proto__" vinda do JSON continuar sendo só uma chave.
        if (next !== object[key]) {
          Object.defineProperty(object, key, { value: next, writable: true, enumerable: true, configurable: true });
        }
      }
      return value;
    }
    return value;
  }

  const value = visit(root);
  return { value, truncated };
}

/**
 * Monta o envelope v1 (modelo de eventos, seção 1). Das variáveis de ambiente,
 * só vai `CLAUDE_PROJECT_DIR`. `entrypoint` fica `null` até o T0 confirmar qual
 * variável diz se a sessão é do terminal ou do VS Code.
 * @param {Record<string, unknown>} payload
 * @param {{ sentAt: number, env: Record<string, string|undefined> }} options
 */
export function buildEnvelope(payload, { sentAt, env }) {
  const { value, truncated } = truncateStrings(payload);
  const projectDir = env.CLAUDE_PROJECT_DIR;
  return {
    v: 1,
    sentAt,
    forwarder: FORWARDER_VERSION,
    env: { projectDir: typeof projectDir === 'string' && projectDir !== '' ? projectDir : null, entrypoint: null },
    truncated,
    payload: value,
  };
}

/**
 * POST /hooks em 127.0.0.1. Nunca rejeita: termina na resposta (qualquer
 * status), no erro ou no prazo, o que vier primeiro.
 * @param {Runtime} runtime
 * @param {string} body
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function postEnvelope(runtime, body, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {any} */
    let req = null;
    /** @type {any} */
    let timer = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    try {
      req = http.request(
        {
          host: HOST,
          port: runtime.port,
          method: 'POST',
          path: HOOKS_PATH,
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            [TOKEN_HEADER]: runtime.token,
          },
        },
        (/** @type {any} */ res) => {
          res.resume();
          finish();
        },
      );
      req.on('error', finish);
      req.end(body);
    } catch {
      finish();
    }
  });
}

/**
 * Encaminha um evento. Nunca lança.
 * @param {{ stdin: any, env: Record<string, string|undefined>, platform: string, homedir: string, sentAt: number }} options
 * @returns {Promise<void>}
 */
export async function forward({ stdin, env, platform, homedir, sentAt }) {
  try {
    // O stdin é lido até o fim antes de tudo (ADR 0001), para quem escreve
    // nunca encontrar o pipe fechado. Interpretar e cortar o JSON só se houver servidor.
    const bytes = await readStdin(stdin, MAX_STDIN_BYTES);
    const runtime = readRuntime(resolveDataDir({ env, platform, homedir }));
    if (!runtime || !isPidAlive(runtime.pid)) return;
    const payload = bytes && parsePayload(bytes);
    if (!payload) return;
    const body = JSON.stringify(buildEnvelope(payload, { sentAt, env }));
    await postEnvelope(runtime, body, POST_TIMEOUT_MS);
  } catch {
    // Falha silenciosa: a captura nunca atrapalha o Claude Code.
  }
}

/** Ponto de entrada: tudo termina em `process.exit(0)`, sem imprimir nada. */
function main() {
  const quit = () => process.exit(0);
  // Nada vai para o terminal, nem avisos internos do Node.
  try {
    process.stdout.write = () => true;
    process.stderr.write = () => true;
  } catch {
    // segue sem a proteção extra
  }
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);
  // O prazo conta do início do processo, inclusive a partida do Node.
  const elapsedMs = Math.round(process.uptime() * 1000);
  setTimeout(quit, Math.max(0, DEADLINE_MS - elapsedMs)).unref();

  let homedir = '';
  try {
    homedir = os.homedir();
  } catch {
    // sem pasta pessoal: vale só AGENT_QUEST_HOME ou LOCALAPPDATA
  }
  forward({ stdin: process.stdin, env: process.env, platform: process.platform, homedir, sentAt: startedAt }).then(quit, quit);
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** @returns {boolean} */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync.native(entry) === fs.realpathSync.native(self);
  } catch {
    const fold = (/** @type {string} */ p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    return fold(entry) === fold(self);
  }
}

if (isEntryPoint()) main();
