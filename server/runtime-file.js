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

/** Erros de arquivo preso por outro processo: vale tentar de novo daqui a pouco. */
const RETRYABLE_LOCK_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** No Windows, antivírus e indexadores seguram arquivos novos por instantes. */
// Um encaminhador lendo o runtime.json no mesmo instante também bloqueia o
// rename (EPERM). Tenta por até ~2 s, com espera crescente (10, 20, 40... até 200 ms).
export const RENAME_RETRY_WINDOW_MS = 2000;
const RENAME_FIRST_DELAY_MS = 10;
const RENAME_MAX_DELAY_MS = 200;

/** Na remoção, o mesmo: um processo que abriu o arquivo sem compartilhar exclusão a impede (EBUSY). */
// A espera aqui é síncrona, porque a remoção roda no encerramento: o `close()` a
// chama sem esperar, e o evento `exit` só aceita código síncrono. Por isso a
// janela é curta: até ~0,5 s por chamada, com espera crescente (10, 20, 40, 80 e
// depois 100 ms). No encerramento normal a remoção é chamada duas vezes (no
// `close()` e no evento `exit`), então, com o arquivo preso o tempo todo, o
// processo sai cerca de 1 s depois de "Encerrando o Agent Quest...". Se a janela
// acabar, o arquivo fica, e a próxima partida o trata como sobra (pid morto).
export const REMOVE_RETRY_WINDOW_MS = 500;
const REMOVE_FIRST_DELAY_MS = 10;
const REMOVE_MAX_DELAY_MS = 100;

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
  let text;
  try {
    text = readFileSync(runtimeFilePath(dataDir), 'utf8');
  } catch {
    return null;
  }
  return parseRuntimeInfo(text);
}

/**
 * Valida o conteúdo do runtime.json. `null` se não for JSON ou se faltar algum
 * campo com o tipo certo.
 * @param {string} text
 * @returns {RuntimeInfo|null}
 */
function parseRuntimeInfo(text) {
  let data;
  try {
    data = JSON.parse(text);
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
 * @param {{ rename?: (from: string, to: string) => Promise<void> }} [deps]   trocado só nos testes
 * @returns {Promise<void>}
 */
export async function writeRuntimeFile(dataDir, info, { rename: renameFile = rename } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const target = runtimeFilePath(dataDir);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const { port, token, pid, version, startedAt } = info;
  try {
    await writeFile(temp, `${JSON.stringify({ port, token, pid, version, startedAt }, null, 2)}\n`, {
      mode: 0o600,
    });
    await renameWithRetry(temp, target, renameFile);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Dependências da remoção, trocadas só nos testes.
 * @typedef {object} RemoveDeps
 * @property {(file: string) => string} [read]     lê o arquivo como texto
 * @property {(file: string) => void} [unlink]
 * @property {(ms: number) => void} [sleep]        espera síncrona
 * @property {() => number} [now]                  relógio em ms
 */

/**
 * Apaga o runtime.json se ele ainda for desta execução (mesmo `pid` e `token`).
 * Síncrono, para poder rodar no evento `exit` do processo. Nunca lança.
 *
 * Se outro processo segura o arquivo (EPERM, EACCES ou EBUSY, na leitura ou na
 * remoção), tenta de novo por até `REMOVE_RETRY_WINDOW_MS`, conferindo o dono a
 * cada tentativa: se outra execução gravou o seu runtime.json no meio, não apaga.
 * Acabou a janela: desiste em silêncio e devolve false.
 * @param {string} dataDir
 * @param {{ pid: number, token: string }} owner
 * @param {RemoveDeps} [deps]
 * @returns {boolean}                    true se apagou
 */
export function removeRuntimeFile(
  dataDir,
  owner,
  { read = readText, unlink = unlinkSync, sleep = sleepSync, now = Date.now } = {},
) {
  const file = runtimeFilePath(dataDir);
  const deadline = now() + REMOVE_RETRY_WINDOW_MS;
  let delay = REMOVE_FIRST_DELAY_MS;
  for (;;) {
    let code;
    try {
      const current = parseRuntimeInfo(read(file));
      if (!current || current.pid !== owner.pid || current.token !== owner.token) return false;
      unlink(file);
      return true;
    } catch (err) {
      code = /** @type {any} */ (err)?.code;
    }
    if (!RETRYABLE_LOCK_ERRORS.has(code) || now() + delay > deadline) return false;
    sleep(delay);
    delay = Math.min(delay * 2, REMOVE_MAX_DELAY_MS);
  }
}

/**
 * @param {string} file
 * @returns {string}
 */
function readText(file) {
  return readFileSync(file, 'utf8');
}

/** Célula para a espera síncrona (`Atomics.wait` sem ninguém para acordar). */
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Bloqueia a thread por `ms`. Só para as esperas curtas do encerramento, que
 * precisam ser síncronas (evento `exit`).
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
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
 * @param {(from: string, to: string) => Promise<void>} renameFile
 */
async function renameWithRetry(from, to, renameFile) {
  const deadline = Date.now() + RENAME_RETRY_WINDOW_MS;
  let delay = RENAME_FIRST_DELAY_MS;
  for (;;) {
    try {
      await renameFile(from, to);
      return;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (!RETRYABLE_LOCK_ERRORS.has(code) || Date.now() + delay > deadline) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, RENAME_MAX_DELAY_MS);
    }
  }
}
