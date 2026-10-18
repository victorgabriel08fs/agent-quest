// @ts-check
// Hub de tempo real: GET /events em Server-Sent Events (ADR 0004; modelo de
// eventos, seção 9).
//
// Na conexão: `retry: 2000`, `hello` (sem id) e `snapshot` (com id). Depois, o
// que for publicado: `update` e `session-removed`, cada um com
// `id: <runId>:<seq>`, e o heartbeat `: ping` a cada 15 s. Até 8 clientes; o
// nono recebe 503.
//
// Fronteira (T9a, adiantamento do hub): este módulo não importa nada de
// `server/domain/` e não numera eventos. Quem publica (a ligação de ponta a
// ponta, depois do T7) entrega mensagens já numeradas, e `getSnapshot()` devolve
// `{ seq, sessions }` com as sessões já com `feed`.
//
// Toda conexão recebe `snapshot`, com ou sem `Last-Event-ID`. A retomada pelo
// buffer e a desconexão de cliente lento ficam para o T9b.
//
// Quem chama `handle` (server/http/app.js) já conferiu `Host`, `Origin` e
// `Sec-Fetch-Site` e já aplicou os cabeçalhos de segurança.

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { clearInterval, setInterval } from 'node:timers';

/** Versão do protocolo do `hello`. */
export const SSE_PROTOCOL = 1;

/** Limites (visão geral, "Limites e valores padrão"). */
export const MAX_CLIENTS = 8;
export const HEARTBEAT_MS = 15_000;

/** Espera de reconexão sugerida ao EventSource (linha `retry:`). */
export const RETRY_MS = 2000;

const FULL_TEXT = 'Muitos painéis conectados. Feche uma aba do painel e tente de novo.\n';

/** @typedef {import('../../shared/contract.js').SnapshotMessage} SnapshotMessage */
/** @typedef {import('../../shared/contract.js').UpdateMessage} UpdateMessage */
/** @typedef {import('../../shared/contract.js').SessionRemovedMessage} SessionRemovedMessage */
/** @typedef {import('../../shared/contract.js').HelloMessage} HelloMessage */

/**
 * Tipos do node:http. No editor valem `any` (types/node.d.ts, ADR 0003).
 * @typedef {any} IncomingMessage
 * @typedef {any} ServerResponse
 */

/**
 * Temporizadores do heartbeat (os testes trocam por um relógio falso).
 * @typedef {object} HubTimers
 * @property {(run: () => void, ms: number) => any} setInterval
 * @property {(handle: any) => void} clearInterval
 */

/**
 * @typedef {object} HubOptions
 * @property {string} runId                    identifica esta execução do servidor
 * @property {string} serverVersion
 * @property {() => SnapshotMessage} getSnapshot   `{ seq, sessions }`, sessões com `feed`
 * @property {number} [maxClients]
 * @property {number} [heartbeatMs]
 * @property {HubTimers} [timers]
 */

/**
 * @typedef {object} SseHub
 * @property {(req: IncomingMessage, res: ServerResponse) => void} handle   atende GET /events
 * @property {(message: UpdateMessage) => void} publishUpdate
 * @property {(message: SessionRemovedMessage) => void} publishRemoved
 * @property {() => number} clientCount
 * @property {() => void} close                encerra os fluxos abertos e recusa novos
 */

/**
 * Identificador da execução: 8 caracteres base64url (sem `:` nem quebra de linha,
 * para caber em `id: <runId>:<seq>` e no `Last-Event-ID`).
 * @returns {string}
 */
export function createRunId() {
  return randomBytes(6).toString('base64url');
}

/**
 * Monta uma mensagem SSE. `JSON.stringify` escapa as quebras de linha, então o
 * `data:` ocupa sempre uma linha só.
 * @param {string} event
 * @param {unknown} data
 * @param {string|null} id
 * @returns {string}
 */
export function formatMessage(event, data, id) {
  return `${id === null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * @param {HubOptions} options
 * @returns {SseHub}
 */
export function createSseHub({
  runId,
  serverVersion,
  getSnapshot,
  maxClients = MAX_CLIENTS,
  heartbeatMs = HEARTBEAT_MS,
  timers = { setInterval, clearInterval },
}) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new TypeError('runId precisa ser texto base64url, sem ":" nem quebra de linha');
  }

  /** @type {Set<ServerResponse>} */
  const clients = new Set();
  /** @type {any} */
  let heartbeat = null;
  let closed = false;

  /** @param {number} seq */
  const idFor = (seq) => `${runId}:${seq}`;

  /** @param {unknown} seq */
  function checkSeq(seq) {
    if (!Number.isInteger(seq) || /** @type {number} */ (seq) < 0) {
      throw new TypeError('seq precisa ser um inteiro não negativo (quem publica numera)');
    }
  }

  /**
   * @param {ServerResponse} res
   * @param {string} chunk
   */
  function send(res, chunk) {
    if (res.writableEnded || res.destroyed) return;
    res.write(chunk);
  }

  /** @param {string} chunk */
  function broadcast(chunk) {
    for (const res of clients) send(res, chunk);
  }

  function startHeartbeat() {
    if (heartbeat !== null) return;
    heartbeat = timers.setInterval(() => broadcast(': ping\n\n'), heartbeatMs);
    // Com o relógio real, o heartbeat sozinho não segura o processo.
    heartbeat?.unref?.();
  }

  function stopHeartbeat() {
    if (heartbeat === null) return;
    timers.clearInterval(heartbeat);
    heartbeat = null;
  }

  /** @param {ServerResponse} res */
  function drop(res) {
    if (!clients.delete(res)) return;
    if (clients.size === 0) stopHeartbeat();
  }

  return {
    handle(req, res) {
      if (closed || clients.size >= maxClients) {
        res.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(FULL_TEXT),
          'Cache-Control': 'no-store',
        });
        res.end(FULL_TEXT);
        return;
      }

      // O snapshot é lido antes de responder: se falhar, quem chamou responde 500.
      const snapshot = getSnapshot();
      checkSeq(snapshot?.seq);
      /** @type {HelloMessage} */
      const hello = { protocol: SSE_PROTOCOL, runId, seq: snapshot.seq, serverVersion };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.on('error', () => drop(res));
      res.on('close', () => drop(res));
      req.on('error', () => {});

      // Tudo de uma vez: nenhuma publicação se intromete entre o snapshot e o registro do cliente.
      res.write(
        `retry: ${RETRY_MS}\n\n` +
          formatMessage('hello', hello, null) +
          formatMessage('snapshot', snapshot, idFor(snapshot.seq)),
      );
      clients.add(res);
      startHeartbeat();
    },

    publishUpdate(message) {
      checkSeq(message?.seq);
      if (clients.size === 0) return;
      broadcast(formatMessage('update', message, idFor(message.seq)));
    },

    publishRemoved(message) {
      checkSeq(message?.seq);
      if (clients.size === 0) return;
      broadcast(formatMessage('session-removed', message, idFor(message.seq)));
    },

    clientCount: () => clients.size,

    close() {
      closed = true;
      stopHeartbeat();
      for (const res of [...clients]) {
        clients.delete(res);
        if (!res.writableEnded) res.end();
      }
    },
  };
}
