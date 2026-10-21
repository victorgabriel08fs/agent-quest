// @ts-check
// Descarte de duplicatas (modelo de eventos, seção 8): o mesmo payload repetido
// em até 5 s é descartado. Cobre, por exemplo, o plugin carregado duas vezes,
// em que dois encaminhadores recebem o mesmo JSON do Claude Code.
//
// A chave é o hash do `payload`, nunca do envelope inteiro, porque o `sentAt` e o
// `forwarder` mudam de um encaminhador para outro. A janela conta a partir da
// ocorrência aceita: repetições descartadas não a prolongam. O relógio é sempre
// passado por quem chama (ADR 0010).

import { createHash } from 'node:crypto';

/** Janela de duplicatas, em ms. */
export const DEDUPE_WINDOW_MS = 5000;

/**
 * Hooks que não passam pela deduplicação (seção 8, "Duplicatas", decidido em
 * 19/10/2026). O PermissionRequest não tem `tool_use_id`: dois pedidos
 * legítimos e idênticos, como um comando negado e tentado de novo, viravam um
 * só, e o segundo "aguardando" sumia. As duplicatas verdadeiras (o plugin
 * carregado duas vezes) caem na mesma chamada e ficam com a guarda do reducer.
 */
export const NOT_DEDUPED_HOOKS = Object.freeze(['PermissionRequest']);

/**
 * O payload fica fora da deduplicação?
 * @param {unknown} payload
 * @returns {boolean}
 */
export function skipsDedupe(payload) {
  if (payload === null || typeof payload !== 'object') return false;
  const hook = /** @type {Record<string, unknown>} */ (payload).hook_event_name;
  return typeof hook === 'string' && NOT_DEDUPED_HOOKS.includes(hook);
}

/**
 * Hash do payload como chegou (mesma ordem de chaves). Dois encaminhadores com o
 * mesmo stdin produzem o mesmo texto.
 * @param {unknown} payload
 * @returns {string}
 */
export function payloadHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
}

/**
 * @typedef {object} Dedupe
 * @property {(hash: string, now: number) => boolean} isDuplicate
 *   true se o mesmo hash foi aceito há no máximo `windowMs`; senão registra o
 *   hash como aceito em `now` e devolve false
 * @property {() => number} size        hashes guardados (para testes)
 */

/**
 * @param {{ windowMs?: number }} [options]
 * @returns {Dedupe}
 */
export function createDedupe({ windowMs = DEDUPE_WINDOW_MS } = {}) {
  /**
   * hash → hora em que foi aceito. A ordem de inserção é a ordem de aceitação,
   * então as horas estão em ordem crescente e o que saiu da janela fica no início.
   * @type {Map<string, number>}
   */
  const seen = new Map();
  let latest = -Infinity;

  /** @param {number} now */
  function prune(now) {
    if (now < latest) {
      // O relógio do sistema voltou: a ordem do mapa deixou de valer.
      seen.clear();
      latest = -Infinity;
      return;
    }
    for (const [hash, at] of seen) {
      if (now - at <= windowMs) break;
      seen.delete(hash);
    }
  }

  return {
    isDuplicate(hash, now) {
      prune(now);
      if (seen.has(hash)) return true;
      seen.set(hash, now);
      latest = now;
      return false;
    },
    size: () => seen.size,
  };
}
