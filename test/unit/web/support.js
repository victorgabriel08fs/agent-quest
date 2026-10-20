// Apoio aos testes do painel: snapshots escritos à mão (test/fixtures/state/),
// congelamento profundo e troca de textos para os testes de escape.

import { readFileSync } from 'node:fs';

/** Snapshots escritos à mão a partir da seção 9 do modelo de eventos (T10a; ticket-entregue no T12b). */
export const SNAPSHOT_NAMES = Object.freeze(['neutro', 'primeira-luz', 'ticket-completo', 'ticket-entregue']);

/** Vetor de XSS usado em todos os testes de escape. */
export const XSS = '<img src=x onerror=alert(1)>';

/**
 * @param {string} name
 * @returns {any} SnapshotMessage: { seq, sessions }
 */
export function loadSnapshot(name) {
  return JSON.parse(readFileSync(new URL(`../../fixtures/state/${name}.json`, import.meta.url), 'utf8'));
}

/**
 * Primeira sessão de um snapshot.
 * @param {string} name
 */
export function loadSession(name) {
  return loadSnapshot(name).sessions[0];
}

/**
 * Congela o objeto e tudo dentro dele. Num módulo ESM (modo estrito), qualquer
 * tentativa de alteração lança TypeError.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Cópia do valor com cada string trocada por `fn(string, chave)`. Os itens de
 * listas recebem a chave da lista.
 * @param {any} value
 * @param {(text: string, key: string|null) => string} fn
 * @param {string|null} [key]
 * @returns {any}
 */
export function mapStrings(value, fn, key = null) {
  if (typeof value === 'string') return fn(value, key);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, k)]));
  }
  return value;
}

/**
 * Evento canônico mínimo para os testes dos temas.
 * @param {string} kind
 * @param {object} data
 * @param {string|null} [agentKey]
 * @param {number} [seq]
 */
export function makeEvent(kind, data, agentKey = 'main', seq = 1) {
  return { id: `teste:${seq}`, seq, ts: Date.UTC(2026, 9, 18, 17, 0, seq), sessionId: 'sessao-teste', agentKey, kind, data };
}

/**
 * Agente mínimo com os campos do contrato (seção 9).
 * @param {Partial<Record<string, any>>} fields
 */
export function makeAgent(fields) {
  return {
    key: 'main',
    agentId: null,
    agentType: null,
    role: 'orq',
    label: '',
    status: 'idle',
    finished: false,
    background: false,
    parentKey: null,
    activity: null,
    waitingFor: null,
    health: { ok: 0, total: 0 },
    context: null,
    startedAt: 0,
    lastEventAt: 0,
    ...fields,
  };
}
