// @ts-check
// Store do painel: o estado das sessões recebido do servidor por SSE
// (modelo de eventos, seção 9; ADR 0004).
//
// "Puro" no sentido do plano (T11a): sem rede, sem DOM e sem relógio. As
// funções só alteram o objeto `store` recebido e devolvem o resultado. Os
// objetos de sessão nunca são alterados no lugar: cada mudança troca o objeto
// da sessão, e o feed é copiado ao crescer.
//
// Regras de sequência:
// - `seq` é contínuo dentro de uma execução do servidor (snapshot, update e
//   session-removed usam a mesma numeração);
// - mensagem com `seq` repetido ou menor que o último aplicado é ignorada;
// - mensagem que pula um ou mais `seq` não é aplicada e devolve 'gap': quem
//   chama busca /api/state e reaplica o que chegou depois (connection.js);
// - o snapshot sempre substitui tudo, porque é a verdade do servidor.

import { FEED_KINDS } from '../../shared/contract.js';

/** @typedef {import('../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../shared/contract.js').CanonicalEvent} CanonicalEvent */
/** @typedef {import('../../shared/contract.js').HelloMessage} HelloMessage */
/** @typedef {import('../../shared/contract.js').SnapshotMessage} SnapshotMessage */
/** @typedef {import('../../shared/contract.js').UpdateMessage} UpdateMessage */
/** @typedef {import('../../shared/contract.js').SessionRemovedMessage} SessionRemovedMessage */

/** Feed guardado por sessão (visão geral, "Limites e valores padrão"). */
export const FEED_LIMIT = 200;

/**
 * @typedef {'ok'|'ignored'|'gap'} ApplyResult
 */

/**
 * @typedef {object} Store
 * @property {number|null} seq                  último `seq` aplicado; null antes do primeiro snapshot
 * @property {string|null} runId                execução do servidor (do `hello`)
 * @property {Map<string, SessionState>} sessions   por id, cada uma com `feed` (até FEED_LIMIT eventos)
 */

/** @returns {Store} */
export function createStore() {
  return { seq: null, runId: null, sessions: new Map() };
}

/** @param {unknown} value */
const isSeq = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** @param {unknown} value @returns {value is { id: string }} */
const hasId = (value) => Boolean(value) && typeof value === 'object' && typeof /** @type {any} */ (value).id === 'string';

/**
 * Feed de uma sessão: só os tipos de FEED_KINDS, em ordem de `seq`, sem
 * repetir e com no máximo FEED_LIMIT eventos (os mais recentes).
 * @param {readonly CanonicalEvent[]} events
 * @returns {CanonicalEvent[]}
 */
function normalizeFeed(events) {
  const bySeq = new Map();
  for (const event of events) {
    if (event && isSeq(event.seq) && /** @type {readonly string[]} */ (FEED_KINDS).includes(event.kind)) {
      bySeq.set(event.seq, event);
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-FEED_LIMIT);
}

/**
 * Registra o `hello` de uma conexão. Devolve true se a execução do servidor
 * mudou (servidor reiniciado): o que veio da execução anterior não vale mais e
 * o snapshot seguinte substitui tudo.
 * @param {Store} store
 * @param {HelloMessage} hello
 * @returns {boolean}
 */
export function applyHello(store, hello) {
  const runId = typeof hello?.runId === 'string' ? hello.runId : null;
  const changed = store.runId !== null && runId !== store.runId;
  store.runId = runId;
  return changed;
}

/**
 * Substitui todo o estado pelo snapshot (evento `snapshot` ou GET /api/state).
 * Snapshot malformado é ignorado.
 * @param {Store} store
 * @param {SnapshotMessage} snapshot
 * @returns {boolean}   true se aplicou
 */
export function applySnapshot(store, snapshot) {
  if (!snapshot || !isSeq(snapshot.seq) || !Array.isArray(snapshot.sessions)) return false;
  /** @type {Map<string, SessionState>} */
  const sessions = new Map();
  for (const session of snapshot.sessions) {
    if (!hasId(session)) continue;
    sessions.set(session.id, { ...session, feed: normalizeFeed(session.feed ?? []) });
  }
  store.sessions = sessions;
  store.seq = snapshot.seq;
  return true;
}

/**
 * Aplica um `update`: troca o estado da sessão (que vem sem feed) e, se o
 * evento for de FEED_KINDS, acrescenta-o ao feed da sessão.
 * @param {Store} store
 * @param {UpdateMessage} update
 * @returns {ApplyResult}
 */
export function applyUpdate(store, update) {
  if (!update || !isSeq(update.seq) || !hasId(update.session)) return 'ignored';
  const order = checkSeq(store, update.seq);
  if (order !== 'ok') return order;

  const previous = store.sessions.get(update.session.id);
  let feed = previous?.feed ?? [];
  const event = update.event;
  if (event && /** @type {readonly string[]} */ (FEED_KINDS).includes(event.kind) && isSeq(event.seq)) {
    feed = normalizeFeed([...feed, event]);
  }
  store.sessions.set(update.session.id, { ...update.session, feed });
  store.seq = update.seq;
  return 'ok';
}

/**
 * Tira uma sessão do store. Devolve true se ela existia.
 * @param {Store} store
 * @param {string} sessionId
 * @returns {boolean}
 */
export function removeSession(store, sessionId) {
  return store.sessions.delete(sessionId);
}

/**
 * Aplica um `session-removed`, com as mesmas regras de `seq` do update.
 * @param {Store} store
 * @param {SessionRemovedMessage} message
 * @returns {ApplyResult}
 */
export function applySessionRemoved(store, message) {
  if (!message || !isSeq(message.seq) || typeof message.sessionId !== 'string') return 'ignored';
  const order = checkSeq(store, message.seq);
  if (order !== 'ok') return order;
  removeSession(store, message.sessionId);
  store.seq = message.seq;
  return 'ok';
}

/**
 * @param {Store} store
 * @param {number} seq
 * @returns {ApplyResult}
 */
function checkSeq(store, seq) {
  if (store.seq === null) return 'gap';
  if (seq <= store.seq) return 'ignored';
  if (seq > store.seq + 1) return 'gap';
  return 'ok';
}
