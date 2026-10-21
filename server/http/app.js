// @ts-check
// Servidor HTTP do Agent Quest: segurança, ingestão, rotas da API e arquivos estáticos.
//
// Ordem de cada requisição:
//   1. cabeçalhos de segurança (ADR 0006) em toda resposta, inclusive erros;
//   2. `Host` fora da lista: 403;
//   3. `OPTIONS`: 405 (sem CORS);
//   4. `/hooks`: ingestão, com as regras próprias (sem `Origin`, token, JSON, 1 MiB);
//   5. rotas do painel: `Origin` ou `Sec-Fetch-Site` de outra origem: 403;
//   6. `/events` (SSE, server/http/sse.js) e `/api/*`, com `Cache-Control: no-store`;
//      o resto, estáticos de `web/` e `shared/`.
//
// Os logs nunca mostram corpo, cabeçalhos nem caminho de requisição: só o tipo
// de um erro inesperado.

import http from 'node:http';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { createDedupe, payloadHash, skipsDedupe } from '../ingest/dedupe.js';
import { MAX_BODY_BYTES, parseEnvelope } from '../ingest/envelope.js';
import { QUEUE_LIMIT, createQueue } from '../ingest/queue.js';
import { applySecurityHeaders, checkHookRequest, checkPanelRequest, isAllowedHost } from './security.js';
import { createRunId, createSseHub } from './sse.js';
import { SHARED_DIR, WEB_DIR, readStaticFile, resolveStaticPath } from './static.js';

/** @typedef {import('../../shared/contract.js').HealthResponse} HealthResponse */
/** @typedef {import('../ingest/envelope.js').Envelope} Envelope */
/** @typedef {import('../../shared/contract.js').SnapshotMessage} SnapshotMessage */
/** @typedef {import('./sse.js').SseHub} SseHub */

/**
 * Tipos do node:http. No editor valem `any` (types/node.d.ts, ADR 0003).
 * @typedef {any} IncomingMessage
 * @typedef {any} ServerResponse
 * @typedef {any} HttpServer
 */

/**
 * Item da fila de ingestão.
 * @typedef {object} IngestItem
 * @property {Envelope} envelope
 * @property {number} receivedAt         hora de chegada (relógio do servidor, ms)
 */

/**
 * @typedef {object} AppOptions
 * @property {string} version
 * @property {number} startedAt          ms desde a época
 * @property {string|null} [token]       token da execução; sem ele, todo POST /hooks recebe 401
 * @property {string} [webDir]           padrão: web/ do repositório
 * @property {string} [sharedDir]        padrão: shared/ do repositório
 * @property {(message: string) => void} [logError]
 * @property {() => number} [clock]      relógio (ms); os testes trocam
 * @property {(envelope: Envelope, meta: { receivedAt: number }) => boolean|void} [onEnvelope]
 *   processa cada envelope aceito, fora do ciclo da requisição; devolver `false`
 *   conta o evento como `ignored`, e uma exceção também (o log mostra só o tipo).
 *   No servidor, é a ligação de ponta a ponta (server/pipeline.js); padrão: não faz nada.
 * @property {{ write(envelope: Envelope, receivedAt: number): void }|null} [dump]   --debug-dump
 * @property {number} [queueLimit]       padrão: 10 000
 * @property {(run: () => void) => unknown} [schedule]   agenda o processamento da fila (padrão: setImmediate)
 * @property {string} [runId]            identifica esta execução no SSE (padrão: aleatório)
 * @property {() => SnapshotMessage} [getSnapshot]
 *   estado para o `snapshot` do SSE e para GET /api/state; no servidor, vem da
 *   ligação de ponta a ponta; padrão: um snapshot vazio
 * @property {() => number} [sessionCount]   `sessions` do /api/health; padrão: 0
 * @property {() => number} [getSeq]         `seq` atual, para a retomada do SSE sem montar o snapshot; padrão: o do snapshot
 * @property {{ maxClients?: number, heartbeatMs?: number, timers?: import('./sse.js').HubTimers }} [sse]
 */

const READ_METHODS = 'GET, HEAD';

/** Rota de ingestão (modelo de eventos, seção 1). */
const HOOKS_PATH = '/hooks';

/** Rotas do tempo real (modelo de eventos, seção 9). */
const EVENTS_PATH = '/events';
const STATE_PATH = '/api/state';

/** Snapshot sem estado ligado (testes do HTTP e do hub). */
const EMPTY_SNAPSHOT = () => ({ seq: 0, sessions: [] });

/**
 * Corpo acima de 1 MiB numa requisição com token válido: o servidor lê e
 * descarta o excesso até este teto antes de responder 413, para o cliente
 * receber o status em vez de uma conexão derrubada no meio do envio. Acima do
 * teto, a conexão é encerrada. Igual ao limite de stdin do encaminhador (visão
 * geral, "Limites e valores padrão"). Recusas pelos cabeçalhos (401, 403, 415)
 * não leem o corpo.
 */
const MAX_DISCARD_BYTES = 16 * 1024 * 1024;

const STATUS_TEXT = Object.freeze({
  400: 'Requisição inválida.',
  401: 'Token ausente ou inválido.',
  403: 'Acesso negado.',
  404: 'Não encontrado.',
  405: 'Método não permitido.',
  413: 'Corpo maior que 1 MiB.',
  415: 'Use Content-Type: application/json.',
  500: 'Erro interno.',
});

/**
 * Cria o servidor HTTP, ainda sem escutar. Quem chama decide porta e endereço
 * (sempre 127.0.0.1; ver server/main.js).
 * @param {AppOptions} options
 * @returns {{ server: HttpServer, health: () => HealthResponse, hub: SseHub }}
 */
export function createApp({
  version,
  startedAt,
  token = null,
  webDir = WEB_DIR,
  sharedDir = SHARED_DIR,
  logError = console.error,
  clock = Date.now,
  onEnvelope = () => {},
  dump = null,
  queueLimit = QUEUE_LIMIT,
  schedule = setImmediate,
  runId = createRunId(),
  getSnapshot = EMPTY_SNAPSHOT,
  sessionCount = () => 0,
  getSeq,
  sse = {},
}) {
  const roots = { webDir, sharedDir };
  const hub = createSseHub({ runId, serverVersion: version, getSnapshot, ...(getSeq ? { getSeq } : {}), ...sse });

  // Contadores do /api/health. received = accepted + deduped + rejected;
  // dropped (fila cheia) e ignored (processamento) são subconjuntos de accepted.
  const counters = { received: 0, accepted: 0, rejected: 0, deduped: 0, ignored: 0 };
  /** @type {number|null} */
  let lastEventAt = null;

  const dedupe = createDedupe();
  /** @type {import('../ingest/queue.js').Queue<IngestItem>} */
  const queue = createQueue({
    limit: queueLimit,
    schedule,
    handle: (item) => {
      if (onEnvelope(item.envelope, { receivedAt: item.receivedAt }) === false) counters.ignored++;
    },
    onError: (err) => {
      counters.ignored++;
      logError(`Erro ao processar um evento: ${errorKind(err)}`);
    },
  });

  /** @returns {HealthResponse} */
  function health() {
    return {
      ok: true,
      version,
      startedAt,
      events: {
        received: counters.received,
        accepted: counters.accepted,
        rejected: counters.rejected,
        deduped: counters.deduped,
        dropped: queue.dropped(),
        ignored: counters.ignored,
      },
      lastEventAt,
      sessions: sessionCount(),
      clients: hub.clientCount(),
    };
  }

  /**
   * POST /hooks. Recusas: 403 com `Origin`, 401 sem o token certo, 415 sem JSON,
   * 413 acima de 1 MiB, 400 com envelope inválido. Aceito: 204, e só depois a
   * deduplicação, a fila e o dump.
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async function handleHook(req, res) {
    if (req.method !== 'POST') return sendError(req, res, 405, { Allow: 'POST' });
    counters.received++;

    // Recusa pelos cabeçalhos: responde na hora, sem esperar nem ler o corpo.
    const refusal = checkHookRequest(req.headers, token);
    if (refusal !== null) {
      counters.rejected++;
      return sendError(req, res, refusal);
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body.status === 'aborted') {
      counters.rejected++;
      return;
    }
    if (body.status !== 'ok') {
      counters.rejected++;
      return sendError(req, res, 413, body.status === 'unread' ? { Connection: 'close' } : {});
    }
    const parsed = parseEnvelope(body.text);
    if (!parsed.ok) {
      counters.rejected++;
      return sendError(req, res, 400);
    }
    const { envelope } = parsed;
    // O hash vem antes da resposta: um payload que nem dá para serializar de novo
    // (aninhamento extremo estoura a pilha do JSON.stringify) é envelope inválido.
    let hash;
    try {
      hash = payloadHash(envelope.payload);
    } catch {
      counters.rejected++;
      return sendError(req, res, 400);
    }

    const receivedAt = clock();
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();

    lastEventAt = receivedAt;
    // O PermissionRequest não passa pela deduplicação (seção 8, "Duplicatas").
    if (!skipsDedupe(envelope.payload) && dedupe.isDuplicate(hash, receivedAt)) {
      counters.deduped++;
      return;
    }
    counters.accepted++;
    queue.push({ envelope, receivedAt });
    dump?.write(envelope, receivedAt);
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async function handle(req, res) {
    applySecurityHeaders(res);

    if (!isAllowedHost(req.headers.host, req.socket.localPort)) return sendError(req, res, 403);

    const pathname = (req.url ?? '/').split(/[?#]/, 1)[0];
    const isHooks = pathname === HOOKS_PATH;

    if (req.method === 'OPTIONS') {
      const allow = isHooks ? 'POST' : pathname === EVENTS_PATH ? 'GET' : READ_METHODS;
      return sendError(req, res, 405, { Allow: allow });
    }
    if (isHooks) return handleHook(req, res);
    if (checkPanelRequest(req.headers) !== null) return sendError(req, res, 403);

    if (pathname === EVENTS_PATH) {
      if (req.method !== 'GET') return sendError(req, res, 405, { Allow: 'GET' });
      return hub.handle(req, res);
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (pathname !== '/api/health' && pathname !== STATE_PATH) return sendError(req, res, 404);
      if (!isReadMethod(req)) return sendError(req, res, 405, { Allow: READ_METHODS });
      // GET /api/state: o mesmo conteúdo do snapshot do SSE (seção 9).
      return sendJson(req, res, 200, pathname === STATE_PATH ? getSnapshot() : health());
    }

    if (!isReadMethod(req)) return sendError(req, res, 405, { Allow: READ_METHODS });

    const target = resolveStaticPath(pathname, roots);
    if (target.status !== 200) return sendError(req, res, target.status);
    const body = await readStaticFile(target);
    if (!body) return sendError(req, res, 404);
    res.writeHead(200, {
      'Content-Type': target.type,
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  function onRequest(req, res) {
    handle(req, res).catch((err) => {
      logError(`Erro ao responder uma requisição: ${errorKind(err)}`);
      if (!res.headersSent) sendError(req, res, 500);
      else res.destroy();
    });
  }

  // Sem Host, o Node responderia 400 sozinho, sem os cabeçalhos do ADR 0006;
  // assim a requisição chega à regra de Host e recebe 403.
  const server = http.createServer({ requireHostHeader: false }, onRequest);
  return { server, health, hub };
}

/**
 * Resultado da leitura do corpo:
 * - `ok`: corpo inteiro, até o limite, em texto;
 * - `too-large`: passou do limite; o resto foi lido e descartado;
 * - `unread`: o tamanho declarado passa do teto de descarte, nada foi lido;
 * - `aborted`: a conexão caiu ou passou do teto de descarte (não há a quem responder).
 * @typedef {{ status: 'ok', text: string } | { status: 'too-large'|'unread'|'aborted' }} BodyResult
 */

/**
 * Lê o corpo guardando no máximo `limit` bytes. O que passar do limite é lido e
 * descartado até o fim (ou até o teto de descarte, quando a conexão é encerrada).
 * @param {IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<BodyResult>}
 */
function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_DISCARD_BYTES) return Promise.resolve({ status: 'unread' });

  return new Promise((resolve) => {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let settled = false;

    /** @param {BodyResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolve(result);
    };

    req.on('data', (/** @type {Uint8Array} */ chunk) => {
      total += chunk.length;
      if (total > MAX_DISCARD_BYTES) {
        req.destroy();
        finish({ status: 'aborted' });
      } else if (total <= limit) {
        chunks.push(chunk);
      } else {
        chunks.length = 0;
      }
    });
    req.on('end', () => {
      if (total > limit) return finish({ status: 'too-large' });
      finish({ status: 'ok', text: Buffer.concat(chunks, total).toString('utf8') });
    });
    req.on('error', () => finish({ status: 'aborted' }));
    req.on('close', () => finish({ status: 'aborted' }));
  });
}

/**
 * @param {IncomingMessage} req
 * @returns {boolean}
 */
function isReadMethod(req) {
  return req.method === 'GET' || req.method === 'HEAD';
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
function sendJson(req, res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {keyof typeof STATUS_TEXT} status
 * @param {Record<string, string>} [headers]
 */
function sendError(req, res, status, headers = {}) {
  const body = `${STATUS_TEXT[status]}\n`;
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Tipo do erro, sem a mensagem (que pode carregar caminhos ou conteúdo).
 * @param {unknown} err
 * @returns {string}
 */
function errorKind(err) {
  const e = /** @type {any} */ (err);
  return String(e?.code ?? e?.name ?? 'Error');
}
