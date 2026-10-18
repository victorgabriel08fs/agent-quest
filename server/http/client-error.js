// @ts-check
// Respostas que o próprio Node gera, fora do tratador de requisições, também
// levam os cabeçalhos do ADR 0006.
//
// - `clientError`: requisição que o parser recusa (sintaxe inválida, byte nulo
//   em cabeçalho, cabeçalhos acima de 16 KiB, prazo de recebimento esgotado).
//   Sem tratador, o Node responde 400, 408, 413 ou 431 sem esses cabeçalhos.
// - `checkExpectation`: `Expect` diferente de `100-continue`. Sem tratador, o
//   Node responde 417 sem esses cabeçalhos.
//
// A requisição sem `Host` não passa por aqui: o servidor é criado com
// `requireHostHeader: false` (server/http/app.js) para ela chegar à regra de
// `Host` e receber 403.
//
// Nada do conteúdo da requisição é registrado.

import { Buffer } from 'node:buffer';
import { SECURITY_HEADERS, applySecurityHeaders } from './security.js';

/**
 * @typedef {import('../node-types.js').HttpServer} HttpServer
 * @typedef {import('../node-types.js').Socket} Socket
 * @typedef {import('../node-types.js').IncomingMessage} IncomingMessage
 * @typedef {import('../node-types.js').ServerResponse} ServerResponse
 */

/** Status por código de erro do parser, como no Node; o resto vira 400. */
const STATUS_BY_ERROR_CODE = Object.freeze({
  HPE_HEADER_OVERFLOW: 431,
  HPE_CHUNK_EXTENSIONS_OVERFLOW: 413,
  ERR_HTTP_REQUEST_TIMEOUT: 408,
});

const REASONS = Object.freeze({
  400: ['Bad Request', 'Requisição inválida.'],
  408: ['Request Timeout', 'Tempo esgotado ao receber a requisição.'],
  413: ['Payload Too Large', 'Requisição grande demais.'],
  417: ['Expectation Failed', 'Expectativa não suportada.'],
  431: ['Request Header Fields Too Large', 'Cabeçalhos grandes demais.'],
});

/**
 * Liga os tratadores ao servidor.
 * @param {HttpServer} server
 */
export function installProtocolErrorHandlers(server) {
  server.on('clientError', handleClientError);
  server.on('checkExpectation', handleUnmetExpectation);
}

/**
 * Responde a um erro do parser com os cabeçalhos de segurança e fecha a conexão.
 * Se já houver uma resposta em andamento nesse socket, só fecha, para não
 * misturar bytes com ela (mesma regra do tratador padrão do Node).
 * @param {any} err
 * @param {Socket} socket
 */
export function handleClientError(err, socket) {
  const inFlight = socket._httpMessage;
  if (err?.code === 'ECONNRESET' || !socket.writable || (inFlight && inFlight.headersSent)) {
    socket.destroy();
    return;
  }
  const code = /** @type {keyof typeof STATUS_BY_ERROR_CODE} */ (err?.code);
  socket.end(rawResponse(STATUS_BY_ERROR_CODE[code] ?? 400), () => socket.destroy());
}

/**
 * Resposta HTTP completa, em texto, para um status de erro.
 * @param {keyof typeof REASONS} status
 * @returns {string}
 */
export function rawResponse(status) {
  const [reason, message] = REASONS[status];
  const body = `${message}\n`;
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    Connection: 'close',
  };
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `HTTP/1.1 ${status} ${reason}\r\n${lines.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * `Expect` não suportado: 417 com os cabeçalhos de segurança.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
function handleUnmetExpectation(req, res) {
  const [, message] = REASONS[417];
  const body = `${message}\n`;
  applySecurityHeaders(res);
  res.writeHead(417, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
