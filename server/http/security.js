// @ts-check
// Regras de segurança do servidor local (ADR 0006, seção "Rede").
//
// - `Host` precisa ser 127.0.0.1:<porta> ou localhost:<porta> em todas as rotas
//   (proteção contra DNS rebinding).
// - Rotas do painel: `Origin`, se vier, precisa ser a própria origem; `Sec-Fetch-Site`,
//   se vier, precisa ser `same-origin` ou `none`.
// - `POST /hooks`: sem `Origin` (navegadores sempre mandam em POST; o encaminhador
//   não manda), `X-Agent-Quest-Token` igual ao token da execução (comparação em
//   tempo constante) e `Content-Type: application/json`.
// - Sem CORS: nenhuma resposta tem `Access-Control-Allow-*`.
// - Os mesmos cabeçalhos de segurança em toda resposta.
//
// A porta usada nas comparações é a do socket que recebeu a requisição.

import { createHash, timingSafeEqual } from 'node:crypto';

/** Cabeçalho com o token da execução em POST /hooks (modelo de eventos, seção 1). */
export const TOKEN_HEADER = 'x-agent-quest-token';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Cabeçalhos presentes em toda resposta (ADR 0006). */
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

/** Valores de `Sec-Fetch-Site` aceitos nas rotas do painel. */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * @param {{ setHeader(name: string, value: string): unknown }} res
 */
export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

/**
 * Hosts aceitos para a porta, já em minúsculas.
 * @param {number} port
 * @returns {string[]}
 */
export function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/**
 * @param {string|undefined} host       cabeçalho `Host`
 * @param {number} port                 porta local do socket
 * @returns {boolean}
 */
export function isAllowedHost(host, port) {
  if (typeof host !== 'string') return false;
  return allowedHosts(port).includes(host.toLowerCase());
}

/**
 * Confere `Origin` e `Sec-Fetch-Site` de uma requisição às rotas do painel
 * (`/`, estáticos, `/api/*` e, a partir do T9a, `/events`). Supõe que o `Host`
 * já foi aceito por `isAllowedHost`.
 * @param {Record<string, string|string[]|undefined>} headers   req.headers (nomes em minúsculas)
 * @returns {string|null}               motivo da recusa, ou null se aceita
 */
export function checkPanelRequest(headers) {
  const origin = headers.origin;
  if (origin !== undefined) {
    const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : '';
    if (typeof origin !== 'string' || origin.toLowerCase() !== `http://${host}`) return 'origin';
  }
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite !== undefined) {
    if (typeof fetchSite !== 'string' || !ALLOWED_FETCH_SITES.has(fetchSite.toLowerCase())) return 'sec-fetch-site';
  }
  return null;
}

/**
 * Compara o token recebido com o da execução em tempo constante: os dois passam
 * por SHA-256 antes do `timingSafeEqual`, então nem o tamanho do token recebido
 * muda o tempo da comparação. Sem token da execução, nada é aceito.
 * @param {unknown} received             valor do cabeçalho X-Agent-Quest-Token
 * @param {string|null} expected         token da execução
 * @returns {boolean}
 */
export function tokenMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * `Content-Type` é `application/json`, com ou sem parâmetros (`; charset=utf-8`).
 * @param {unknown} contentType
 * @returns {boolean}
 */
export function isJsonContentType(contentType) {
  if (typeof contentType !== 'string') return false;
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

/**
 * Confere os cabeçalhos de `POST /hooks`, antes de ler o corpo. Supõe que o
 * `Host` já foi aceito por `isAllowedHost`. Ordem: `Origin` (403), token (401),
 * `Content-Type` (415).
 * @param {Record<string, string|string[]|undefined>} headers   req.headers (nomes em minúsculas)
 * @param {string|null} token            token da execução
 * @returns {403|401|415|null}           status da recusa, ou null se aceita
 */
export function checkHookRequest(headers, token) {
  if (headers.origin !== undefined) return 403;
  if (!tokenMatches(headers[TOKEN_HEADER], token)) return 401;
  if (!isJsonContentType(headers['content-type'])) return 415;
  return null;
}
