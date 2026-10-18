// @ts-check
// Envelope v1, o que o encaminhador manda em POST /hooks (modelo de eventos, seção 1).
//
// A ingestão confere só o mínimo para aceitar o envelope: JSON válido, `v: 1` e
// um `payload` com `session_id` e `hook_event_name` em texto não vazio. O resto
// (`sentAt`, `forwarder`, `env`, `truncated` e os campos do payload) fica para o
// normalizador (T5), que trata campos ausentes ou com tipo errado.

/** Versão do envelope aceita pelo servidor. */
export const ENVELOPE_VERSION = 1;

/** Tamanho máximo do corpo de POST /hooks: 1 MiB (ADR 0006). */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Payload do hook, como o Claude Code o entrega (com strings longas já cortadas
 * pelo encaminhador).
 * @typedef {{ hook_event_name: string, session_id: string, [key: string]: unknown }} HookPayload
 */

/**
 * @typedef {object} Envelope
 * @property {1} v
 * @property {unknown} [sentAt]          ms desde a época, no início do encaminhador
 * @property {unknown} [forwarder]       versão do encaminhador
 * @property {unknown} [env]             { projectDir, entrypoint }
 * @property {unknown} [truncated]
 * @property {HookPayload} payload
 */

/**
 * Motivo da recusa. Serve para testes e contagens; nunca carrega conteúdo.
 * @typedef {'json'|'not-object'|'version'|'payload'|'session_id'|'hook_event_name'} EnvelopeError
 */

/**
 * Lê o corpo de POST /hooks.
 * @param {string} text
 * @returns {{ ok: true, envelope: Envelope } | { ok: false, error: EnvelopeError }}
 */
export function parseEnvelope(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'json' };
  }
  return validateEnvelope(value);
}

/**
 * Confere a forma mínima do envelope v1.
 * @param {unknown} value
 * @returns {{ ok: true, envelope: Envelope } | { ok: false, error: EnvelopeError }}
 */
export function validateEnvelope(value) {
  if (!isPlainObject(value)) return { ok: false, error: 'not-object' };
  const data = /** @type {Record<string, unknown>} */ (value);
  if (data.v !== ENVELOPE_VERSION) return { ok: false, error: 'version' };
  if (!isPlainObject(data.payload)) return { ok: false, error: 'payload' };
  const payload = /** @type {Record<string, unknown>} */ (data.payload);
  if (!isNonEmptyString(payload.session_id)) return { ok: false, error: 'session_id' };
  if (!isNonEmptyString(payload.hook_event_name)) return { ok: false, error: 'hook_event_name' };
  return { ok: true, envelope: /** @type {Envelope} */ (data) };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
