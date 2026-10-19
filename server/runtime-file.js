// @ts-check
// runtime.json: como o encaminhador encontra o servidor (ADR 0001, ADR 0005).
//
// Fica no diretório de dados e guarda porta, token, pid, versão e início da
// execução. É gravado de forma atômica (arquivo temporário na mesma pasta e
// depois renomear), para o encaminhador nunca ler um arquivo pela metade, e é
// apagado no encerramento normal, só se ainda pertencer a esta execução.

import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

export const RUNTIME_FILE_NAME = 'runtime.json';

/** No Windows, antivírus e indexadores seguram arquivos novos por instantes. */
// Um encaminhador lendo o runtime.json no mesmo instante também bloqueia o
// rename (EPERM). Tenta por até ~2 s, com espera crescente (10, 20, 40... até 200 ms).
export const RENAME_RETRY_WINDOW_MS = 2000;
const RENAME_FIRST_DELAY_MS = 10;
const RENAME_MAX_DELAY_MS = 200;
const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * @typedef {object} RuntimeInfo
 * @property {number} port
 * @property {string} token              32 bytes aleatórios em base64url
 * @property {number} pid
 * @property {string} version
 * @property {number} startedAt          ms desde a época
 */

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function runtimeFilePath(dataDir) {
  return path.join(dataDir, RUNTIME_FILE_NAME);
}

/**
 * Token da execução: 32 bytes aleatórios em base64url (43 caracteres).
 * @returns {string}
 */
export function createToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Lê o runtime.json. Devolve `null` se não existir, se não for JSON ou se faltar
 * algum campo com o tipo certo (arquivo de sobra ou corrompido).
 * @param {string} dataDir
 * @returns {RuntimeInfo|null}
 */
export function readRuntimeFile(dataDir) {
  let data;
  try {
    data = JSON.parse(readFileSync(runtimeFilePath(dataDir), 'utf8'));
  } catch {
    return null;
  }
  const valid =
    data !== null &&
    typeof data === 'object' &&
    Number.isInteger(data.port) &&
    data.port > 0 &&
    data.port <= 65535 &&
    typeof data.token === 'string' &&
    data.token.length > 0 &&
    Number.isInteger(data.pid) &&
    data.pid > 0 &&
    typeof data.version === 'string' &&
    typeof data.startedAt === 'number';
  if (!valid) return null;
  const { port, token, pid, version, startedAt } = data;
  return { port, token, pid, version, startedAt };
}

/**
 * Grava o runtime.json de forma atômica, substituindo o anterior. Cria o
 * diretório de dados se preciso. No Linux e no macOS, só o dono lê o arquivo.
 * @param {string} dataDir
 * @param {RuntimeInfo} info
 * @returns {Promise<void>}
 */
export async function writeRuntimeFile(dataDir, info) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const target = runtimeFilePath(dataDir);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const { port, token, pid, version, startedAt } = info;
  try {
    await writeFile(temp, `${JSON.stringify({ port, token, pid, version, startedAt }, null, 2)}\n`, {
      mode: 0o600,
    });
    await renameWithRetry(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Apaga o runtime.json se ele ainda for desta execução (mesmo `pid` e `token`).
 * Síncrono, para poder rodar no evento `exit` do processo. Nunca lança.
 * @param {string} dataDir
 * @param {{ pid: number, token: string }} owner
 * @returns {boolean}                    true se apagou
 */
export function removeRuntimeFile(dataDir, owner) {
  const current = readRuntimeFile(dataDir);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return false;
  try {
    unlinkSync(runtimeFilePath(dataDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Diz se existe um processo com esse pid. `EPERM` significa que existe, mas é
 * de outro usuário.
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * @param {string} from
 * @param {string} to
 */
async function renameWithRetry(from, to) {
  const deadline = Date.now() + RENAME_RETRY_WINDOW_MS;
  let delay = RENAME_FIRST_DELAY_MS;
  for (;;) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (!RETRYABLE_RENAME_ERRORS.has(code) || Date.now() + delay > deadline) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, RENAME_MAX_DELAY_MS);
    }
  }
}
