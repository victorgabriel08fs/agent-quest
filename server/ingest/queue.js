// @ts-check
// Fila entre a resposta 204 e o processamento (visão geral, passo 3: "O servidor
// responde 204 antes de processar").
//
// - Limitada a 10 000 itens; acima disso descarta os mais antigos e conta em
//   `dropped` (visão geral, "Falhas e como o sistema reage").
// - O processamento roda depois, fora do ciclo da requisição, em lotes, para não
//   segurar o laço de eventos por muito tempo.
// - Um item que faz o processador lançar exceção não para a fila: o erro vai
//   para `onError` e a fila segue.
//
// Até o T9a, o processador é vazio (o servidor só conta e descarta). O T9a liga
// aqui a normalização e o estado.

import { setImmediate } from 'node:timers';

/** Itens no máximo (visão geral, "Limites e valores padrão"). */
export const QUEUE_LIMIT = 10_000;

/** Itens processados por volta do laço de eventos. */
export const QUEUE_BATCH_SIZE = 256;

/**
 * @template T
 * @typedef {object} QueueOptions
 * @property {(item: T) => void} handle                  processa um item
 * @property {(err: unknown, item: T) => void} [onError] o processador lançou exceção
 * @property {number} [limit]
 * @property {number} [batchSize]
 * @property {(run: () => void) => unknown} [schedule]   padrão: setImmediate (os testes trocam)
 */

/**
 * @template T
 * @typedef {object} Queue
 * @property {(item: T) => void} push    enfileira; se a fila estiver cheia, descarta o mais antigo
 * @property {() => number} size         itens esperando
 * @property {() => number} dropped      itens descartados por falta de espaço desde o início
 */

/**
 * @template T
 * @param {QueueOptions<T>} options
 * @returns {Queue<T>}
 */
export function createQueue({
  handle,
  onError = () => {},
  limit = QUEUE_LIMIT,
  batchSize = QUEUE_BATCH_SIZE,
  schedule = setImmediate,
}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit precisa ser um inteiro positivo');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize precisa ser um inteiro positivo');

  // Buffer circular de tamanho fixo: enfileirar e descartar custam O(1).
  /** @type {(T|undefined)[]} */
  const items = new Array(limit);
  let head = 0;
  let size = 0;
  let dropped = 0;
  let scheduled = false;

  /** @returns {T} */
  function shift() {
    const item = /** @type {T} */ (items[head]);
    items[head] = undefined;
    head = (head + 1) % limit;
    size--;
    return item;
  }

  function scheduleDrain() {
    if (scheduled || size === 0) return;
    scheduled = true;
    schedule(drain);
  }

  function drain() {
    scheduled = false;
    for (let i = 0; i < batchSize && size > 0; i++) {
      const item = shift();
      try {
        handle(item);
      } catch (err) {
        try {
          onError(err, item);
        } catch {
          // um erro ao registrar o erro também não para a fila
        }
      }
    }
    scheduleDrain();
  }

  return {
    push(item) {
      if (size === limit) {
        shift();
        dropped++;
      }
      items[(head + size) % limit] = item;
      size++;
      scheduleDrain();
    },
    size: () => size,
    dropped: () => dropped,
  };
}
