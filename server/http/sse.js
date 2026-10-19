// @ts-check
// Hub de tempo real: GET /events em Server-Sent Events (ADR 0004; modelo de
// eventos, seção 9).
//
// Na conexão: `retry: 2000`, `hello` (sem id) e, depois, ou as mensagens que
// faltaram (retomada por `Last-Event-ID`) ou um `snapshot` (com id). Depois, o
// que for publicado: `update` e `session-removed`, cada um com
// `id: <runId>:<seq>`, e o heartbeat `: ping` a cada 15 s. Até 8 clientes; o
// nono recebe 503.
//
// Retomada (T9b): o hub guarda as últimas BUFFER_SIZE mensagens publicadas, até
// MAX_PENDING_BYTES no total (as mais antigas saem primeiro): uma falta maior
// recebe snapshot de qualquer jeito, então guardar mais nunca serviria. Uma
// conexão com `Last-Event-ID` desta execução recebe só o que veio depois dele,
// se a mensagem seguinte ainda estiver no buffer e o que falta couber em
// MAX_PENDING_BYTES. Id de outra execução, fora do buffer, inválido ou com
// mais do que isso a reenviar recebe `snapshot`.
//
// Cliente lento (T9b): quem acumula mais de MAX_PENDING_BYTES sem ler é
// desconectado. O EventSource volta sozinho e, como o que falta passa do mesmo
// limite, recebe `snapshot` (ADR 0004). O envio inicial (snapshot ou retomada)
// não conta, até o primeiro esvaziamento do buffer de escrita.
//
// Fronteira (T9a, adiantamento do hub): este módulo não importa nada de
// `server/domain/` e não numera eventos. Quem publica (a ligação de ponta a
// ponta, server/pipeline.js) entrega mensagens já numeradas, `getSnapshot()`
// devolve `{ seq, sessions }` com as sessões já com `feed`, e `getSeq()`, o
// `seq` atual.
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

/** Mensagens guardadas para a retomada por `Last-Event-ID` (ADR 0004). */
export const BUFFER_SIZE = 1000;

/** Acumulado sem ler acima disto: cliente lento, desconectado (ADR 0004). */
export const MAX_PENDING_BYTES = 1024 * 1024;

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
 * @property {() => number} [getSeq]           `seq` atual (padrão: o do snapshot)
 * @property {number} [maxClients]
 * @property {number} [heartbeatMs]
 * @property {number} [bufferSize]
 * @property {number} [maxPendingBytes]
 * @property {HubTimers} [timers]
 */

/**
 * @typedef {object} SseHub
 * @property {(req: IncomingMessage, res: ServerResponse) => void} handle   atende GET /events
 * @property {(message: UpdateMessage) => void} publishUpdate
 * @property {(message: SessionRemovedMessage) => void} publishRemoved
 * @property {() => number} clientCount
 * @property {() => number} bufferedBytes      bytes guardados para a retomada (testes e diagnóstico)
 * @property {() => void} close                encerra os fluxos abertos e recusa novos
 */

/**
 * Mensagem guardada para a retomada.
 * @typedef {{ seq: number, chunk: string, bytes: number }} Buffered
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
 * `seq` de um `Last-Event-ID` desta execução, ou null (ausente, de outra
 * execução ou fora do formato `<runId>:<seq>`).
 * @param {unknown} header
 * @param {string} runId
 * @returns {number|null}
 */
export function lastSeqFrom(header, runId) {
  if (typeof header !== 'string') return null;
  const match = /^([A-Za-z0-9_-]+):(\d{1,15})$/.exec(header.trim());
  if (!match || match[1] !== runId) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) ? seq : null;
}

/**
 * @param {HubOptions} options
 * @returns {SseHub}
 */
export function createSseHub({
  runId,
  serverVersion,
  getSnapshot,
  getSeq = () => getSnapshot().seq,
  maxClients = MAX_CLIENTS,
  heartbeatMs = HEARTBEAT_MS,
  bufferSize = BUFFER_SIZE,
  maxPendingBytes = MAX_PENDING_BYTES,
  timers = { setInterval, clearInterval },
}) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new TypeError('runId precisa ser texto base64url, sem ":" nem quebra de linha');
  }

  /**
   * Clientes abertos e, para cada um, quanto do buffer de escrita é do envio
   * inicial (não conta como acumulado até o primeiro esvaziamento).
   * @type {Map<ServerResponse, { initial: number }>}
   */
  const clients = new Map();
  /** Últimas mensagens publicadas, em ordem de seq. @type {Buffered[]} */
  const buffer = [];
  /** Soma dos bytes das mensagens do buffer. */
  let bufferBytes = 0;
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
   * Escreve para um cliente e desconecta quem acumulou demais sem ler.
   * @param {ServerResponse} res
   * @param {string} chunk
   */
  function send(res, chunk) {
    if (res.writableEnded || res.destroyed) return;
    res.write(chunk);
    const client = clients.get(res);
    const pending = (res.writableLength ?? 0) - (client?.initial ?? 0);
    if (pending > maxPendingBytes) {
      // Cliente lento: sai, e o EventSource volta com snapshot.
      drop(res);
      res.destroy();
    }
  }

  /** @param {string} chunk */
  function broadcast(chunk) {
    for (const res of [...clients.keys()]) send(res, chunk);
  }

  /**
   * Guarda a mensagem para a retomada e a entrega a quem está conectado.
   * @param {number} seq
   * @param {string} chunk
   */
  function publish(seq, chunk) {
    const bytes = Buffer.byteLength(chunk);
    buffer.push({ seq, chunk, bytes });
    bufferBytes += bytes;
    // Até BUFFER_SIZE mensagens e MAX_PENDING_BYTES no total: saem as mais antigas.
    while (buffer.length > 0 && (buffer.length > bufferSize || bufferBytes > maxPendingBytes)) {
      bufferBytes -= /** @type {Buffered} */ (buffer.shift()).bytes;
    }
    broadcast(chunk);
  }

  /**
   * O que reenviar para quem voltou com `Last-Event-ID`, ou null quando o
   * caminho é o snapshot.
   * @param {unknown} header
   * @returns {{ seq: number, chunks: string[] }|null}
   */
  function resumeFor(header) {
    const last = lastSeqFrom(header, runId);
    if (last === null) return null;
    const current = getSeq();
    checkSeq(current);
    if (last > current) return null;
    if (last === current) return { seq: current, chunks: [] };
    const first = buffer.findIndex((item) => item.seq > last);
    // A mensagem seguinte precisa estar no buffer; senão, falta algo.
    if (first < 0 || buffer[first].seq !== last + 1) return null;
    const missed = buffer.slice(first);
    let bytes = 0;
    for (const item of missed) bytes += item.bytes;
    // Reenviar mais que o limite derrubaria o cliente de novo: snapshot.
    if (bytes > maxPendingBytes) return null;
    return { seq: current, chunks: missed.map((item) => item.chunk) };
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

      // O que mandar é decidido antes de responder: se falhar, quem chamou responde 500.
      const resume = resumeFor(req.headers?.['last-event-id']);
      const snapshot = resume ? null : getSnapshot();
      if (snapshot) checkSeq(snapshot?.seq);
      const seq = resume ? resume.seq : /** @type {SnapshotMessage} */ (snapshot).seq;
      /** @type {HelloMessage} */
      const hello = { protocol: SSE_PROTOCOL, runId, seq, serverVersion };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.on('error', () => drop(res));
      res.on('close', () => drop(res));
      req.on('error', () => {});

      // Tudo de uma vez: nenhuma publicação se intromete entre o envio inicial e o registro do cliente.
      const opening =
        `retry: ${RETRY_MS}\n\n` +
        formatMessage('hello', hello, null) +
        (resume ? resume.chunks.join('') : formatMessage('snapshot', snapshot, idFor(seq)));
      res.write(opening);
      const client = { initial: res.writableLength ?? 0 };
      // O envio inicial deixa de ser descontado quando o buffer de escrita esvazia.
      res.on('drain', () => {
        client.initial = 0;
      });
      clients.set(res, client);
      startHeartbeat();
    },

    publishUpdate(message) {
      checkSeq(message?.seq);
      publish(message.seq, formatMessage('update', message, idFor(message.seq)));
    },

    publishRemoved(message) {
      checkSeq(message?.seq);
      publish(message.seq, formatMessage('session-removed', message, idFor(message.seq)));
    },

    clientCount: () => clients.size,

    bufferedBytes: () => bufferBytes,

    close() {
      closed = true;
      stopHeartbeat();
      for (const res of [...clients.keys()]) {
        clients.delete(res);
        if (!res.writableEnded) res.end();
      }
    },
  };
}
