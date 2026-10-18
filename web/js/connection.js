// @ts-check
// Conexão ao vivo com o servidor (ADR 0004; modelo de eventos, seção 9).
//
// - Abre `EventSource('/events')` e leva as mensagens `hello`, `snapshot`,
//   `update` e `session-removed` ao store.
// - Selo de conexão: 'connecting' na primeira tentativa, 'live' com a conexão
//   aberta, 'reconnecting' enquanto o navegador tenta de novo sozinho (servidor
//   caiu) e 'offline' quando a conexão fecha de vez (por exemplo, resposta que
//   não é SSE ou 503 do nono cliente). Fechada de vez, a conexão é reaberta
//   aqui, com espera crescente até 30 s.
// - Quando o store devolve 'gap', busca GET /api/state, aplica como snapshot e
//   reaplica o que chegou durante a busca. Um `hello` de outra execução do
//   servidor descarta o que estava pendente.
//
// Para os testes, EventSource, fetch e os temporizadores são injetáveis.

import { applyHello, applySessionRemoved, applySnapshot, applyUpdate } from './store.js';

/** @typedef {import('./store.js').Store} Store */
/** @typedef {import('./store.js').ApplyResult} ApplyResult */

/**
 * Estado do selo de conexão.
 * @typedef {'connecting'|'live'|'reconnecting'|'offline'} ConnectionState
 */

/**
 * O que a conexão usa de um EventSource.
 * @typedef {object} EventSourceLike
 * @property {number} readyState                    0 conectando, 1 aberta, 2 fechada
 * @property {(type: string, listener: (event: any) => void) => void} addEventListener
 * @property {() => void} close
 */

/**
 * @typedef {object} Timers
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: any) => void} clearTimeout
 */

/**
 * @typedef {object} ConnectOptions
 * @property {Store} store
 * @property {() => void} onChange                  o store mudou (redesenhar)
 * @property {(state: ConnectionState) => void} onStatus
 * @property {string} [eventsUrl]                   padrão: '/events'
 * @property {string} [stateUrl]                    padrão: '/api/state'
 * @property {new (url: string) => EventSourceLike} [EventSource]
 * @property {(url: string, init?: any) => Promise<{ ok: boolean, status: number, json(): Promise<any> }>} [fetch]
 * @property {Timers} [timers]
 */

/** Estado do EventSource fechado de vez (WHATWG HTML, "EventSource"). */
const CLOSED = 2;
/** Espera entre reaberturas quando a conexão fecha de vez: dobra até o teto. */
export const RETRY_FIRST_MS = 2_000;
export const RETRY_MAX_MS = 30_000;
/** Espera para tentar de novo uma busca de /api/state que falhou. */
export const RESYNC_RETRY_MS = 2_000;
/** Mensagens guardadas durante uma busca de /api/state; acima disso, descarta e busca de novo. */
export const PENDING_LIMIT = 1_000;

/**
 * @typedef {{ type: 'update', data: any } | { type: 'removed', data: any }} PendingMessage
 */

/**
 * Liga o store ao servidor.
 * @param {ConnectOptions} options
 * @returns {{ close(): void, state(): ConnectionState }}
 */
export function connect({
  store,
  onChange,
  onStatus,
  eventsUrl = '/events',
  stateUrl = '/api/state',
  EventSource: EventSourceImpl = /** @type {any} */ (globalThis).EventSource,
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (h) => globalThis.clearTimeout(h) },
}) {
  /** @type {ConnectionState} */
  let status = 'connecting';
  /** @type {EventSourceLike|null} */
  let source = null;
  let closed = false;
  let retryMs = RETRY_FIRST_MS;
  /** @type {unknown} */
  let retryTimer = null;
  /** @type {unknown} */
  let resyncTimer = null;
  let resyncing = false;
  /** Cresce a cada snapshot ou troca de execução; busca de /api/state de uma geração anterior é descartada. */
  let generation = 0;
  /** @type {PendingMessage[]} */
  let pending = [];

  /** @param {ConnectionState} next */
  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus(next);
  }

  /**
   * @param {{ data?: unknown }} event
   * @returns {any}
   */
  function parse(event) {
    try {
      return JSON.parse(String(event.data));
    } catch {
      return null;
    }
  }

  function open() {
    if (closed) return;
    const current = new EventSourceImpl(eventsUrl);
    source = current;
    // Eventos de uma conexão já substituída são ignorados.
    /** @param {string} type @param {(event: any) => void} handler */
    const on = (type, handler) => current.addEventListener(type, (event) => {
      if (source === current && !closed) handler(event);
    });

    on('open', () => {
      retryMs = RETRY_FIRST_MS;
      setStatus('live');
    });
    on('error', () => {
      if (current.readyState === CLOSED) {
        setStatus('offline');
        scheduleReopen();
      } else {
        setStatus('reconnecting');
      }
    });
    on('hello', (event) => {
      const hello = parse(event);
      if (hello && applyHello(store, hello)) {
        // Servidor reiniciado: o que estava pendente é da execução anterior.
        generation++;
        pending = [];
      }
    });
    on('snapshot', (event) => {
      const snapshot = parse(event);
      if (!applySnapshot(store, snapshot)) return;
      generation++;
      const { gap } = flushPending();
      onChange();
      if (gap) resync();
    });
    on('update', (event) => handleMessage({ type: 'update', data: parse(event) }));
    on('session-removed', (event) => handleMessage({ type: 'removed', data: parse(event) }));
  }

  function scheduleReopen() {
    source?.close();
    source = null;
    timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      open();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  /**
   * @param {PendingMessage} message
   * @returns {ApplyResult}
   */
  function apply(message) {
    return message.type === 'update' ? applyUpdate(store, message.data) : applySessionRemoved(store, message.data);
  }

  /** @param {PendingMessage} message */
  function handleMessage(message) {
    if (!message.data) return;
    if (resyncing) {
      queue(message);
      return;
    }
    const result = apply(message);
    if (result === 'ok') onChange();
    else if (result === 'gap') {
      queue(message);
      resync();
    }
  }

  /** @param {PendingMessage} message */
  function queue(message) {
    pending.push(message);
    if (pending.length > PENDING_LIMIT) pending = [];
  }

  /**
   * Reaplica o que ficou pendente, em ordem de seq (o já aplicado é ignorado
   * pelo store). Para na primeira lacuna e guarda o resto.
   * @returns {{ changed: boolean, gap: boolean }}
   */
  function flushPending() {
    const queued = pending.sort((a, b) => a.data.seq - b.data.seq);
    pending = [];
    let changed = false;
    for (let index = 0; index < queued.length; index++) {
      const result = apply(queued[index]);
      if (result === 'ok') changed = true;
      if (result === 'gap') {
        pending = queued.slice(index);
        return { changed, gap: true };
      }
    }
    return { changed, gap: false };
  }

  async function resync() {
    if (resyncing || closed) return;
    resyncing = true;
    timers.clearTimeout(resyncTimer);
    resyncTimer = null;
    const started = generation;
    let applied = false;
    try {
      const response = await fetchImpl(stateUrl, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = await response.json();
      if (!closed && started === generation) applied = applySnapshot(store, state);
    } catch {
      // servidor fora do ar ou resposta inválida: tenta de novo abaixo
    }
    resyncing = false;
    if (closed) return;
    if (applied) generation++;
    const { changed, gap } = flushPending();
    if (applied || changed) onChange();
    if (gap) {
      // Ainda falta algo (a busca falhou ou veio velha): tenta de novo daqui a pouco.
      resyncTimer = timers.setTimeout(() => {
        resyncTimer = null;
        resync();
      }, RESYNC_RETRY_MS);
    }
  }

  onStatus(status);
  open();

  return {
    close() {
      closed = true;
      timers.clearTimeout(retryTimer);
      timers.clearTimeout(resyncTimer);
      source?.close();
      source = null;
      pending = [];
      setStatus('offline');
    },
    state: () => status,
  };
}

/**
 * Agrupa pedidos de redesenho por quadro de animação: várias chamadas no mesmo
 * quadro viram um único `render`.
 * @param {(callback: () => void) => unknown} requestFrame   no navegador, requestAnimationFrame
 * @param {() => void} render
 * @returns {() => void}   agenda um redesenho
 */
export function frameBatcher(requestFrame, render) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      render();
    });
  };
}
