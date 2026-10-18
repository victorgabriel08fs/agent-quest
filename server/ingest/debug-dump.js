// @ts-check
// `--debug-dump` (ADR 0005): só para depuração, grava os envelopes aceitos em
// `<dados>/dumps/AAAA-MM-DD.jsonl` (data local de chegada), um por linha.
//
// Desligado por padrão. Sem a opção, este módulo nem é usado e a pasta não é
// criada. Com a opção, a pasta só é criada no primeiro envelope gravado. O aviso
// de dados sensíveis sai no início do servidor (server/config.js).
//
// Grava o que vai para a fila: envelopes válidos e não duplicados, exatamente
// como chegaram. Falha de disco nunca afeta a ingestão: o erro é registrado uma
// vez (só o tipo) e a gravação para. Um envelope que não dá para serializar é
// só pulado.

import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Nome da pasta dos dumps dentro do diretório de dados. */
export const DUMPS_DIR_NAME = 'dumps';

/**
 * @typedef {object} DebugDump
 * @property {(envelope: unknown, receivedAt: number) => void} write
 * @property {() => Promise<void>} close   grava o que falta e fecha o arquivo
 */

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function dumpsDir(dataDir) {
  return path.join(dataDir, DUMPS_DIR_NAME);
}

/**
 * Nome do arquivo do dia, pela data local: `AAAA-MM-DD.jsonl`.
 * @param {number} ts                    ms desde a época
 * @returns {string}
 */
export function dumpFileName(ts) {
  const date = new Date(ts);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`;
}

/**
 * @param {{ dir: string, onError?: (err: unknown) => void }} options
 * @returns {DebugDump}
 */
export function createDebugDump({ dir, onError = () => {} }) {
  /** @type {any} */
  let stream = null;
  let fileName = '';
  let failed = false;
  /** @type {Promise<void>[]} */
  const closing = [];

  /** @param {unknown} err */
  function fail(err) {
    if (failed) return;
    failed = true;
    onError(err);
  }

  /** Fecha o arquivo atual e guarda a promessa do fechamento. */
  function closeStream() {
    if (!stream) return;
    const current = stream;
    stream = null;
    closing.push(
      new Promise((resolve) => {
        if (current.closed) return resolve();
        current.once('close', () => resolve());
        current.end();
      }),
    );
  }

  return {
    write(envelope, receivedAt) {
      if (failed) return;
      // Envelope que não dá para serializar (aninhamento extremo) é só pulado:
      // não é falha de disco e não desliga o dump.
      let line;
      try {
        line = `${JSON.stringify(envelope)}\n`;
      } catch {
        return;
      }
      try {
        const name = dumpFileName(receivedAt);
        if (name !== fileName) {
          closeStream();
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          stream = createWriteStream(path.join(dir, name), { flags: 'a', mode: 0o600 });
          stream.on('error', (/** @type {unknown} */ err) => fail(err));
          fileName = name;
        }
        stream.write(line);
      } catch (err) {
        fail(err);
      }
    },
    async close() {
      closeStream();
      await Promise.all(closing);
    },
  };
}
