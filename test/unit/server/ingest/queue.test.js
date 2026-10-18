import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_LIMIT, createQueue } from '../../../../server/ingest/queue.js';

/** Agendador manual: o teste decide quando o processamento roda. */
function manualScheduler() {
  const pending = [];
  return {
    schedule: (run) => pending.push(run),
    pending,
    runAll() {
      while (pending.length) pending.shift()();
    },
  };
}

describe('createQueue', () => {
  it('limite padrão de 10 000 itens', () => {
    assert.equal(QUEUE_LIMIT, 10_000);
  });

  it('processa fora da chamada de push, na ordem de chegada', () => {
    const scheduler = manualScheduler();
    const handled = [];
    const queue = createQueue({ handle: (item) => handled.push(item), schedule: scheduler.schedule });
    queue.push(1);
    queue.push(2);
    queue.push(3);
    assert.deepEqual(handled, [], 'nada processado durante o push');
    assert.equal(scheduler.pending.length, 1, 'um único processamento agendado');
    assert.equal(queue.size(), 3);
    scheduler.runAll();
    assert.deepEqual(handled, [1, 2, 3]);
    assert.equal(queue.size(), 0);
  });

  it('acima de 10 000 descarta os mais antigos e conta dropped', () => {
    const scheduler = manualScheduler();
    const handled = [];
    const queue = createQueue({ handle: (item) => handled.push(item), schedule: scheduler.schedule });
    for (let i = 1; i <= QUEUE_LIMIT + 3; i++) queue.push(i);
    assert.equal(queue.size(), QUEUE_LIMIT);
    assert.equal(queue.dropped(), 3);
    scheduler.runAll();
    assert.equal(handled.length, QUEUE_LIMIT);
    assert.equal(handled[0], 4, 'os três mais antigos saíram');
    assert.equal(handled.at(-1), QUEUE_LIMIT + 3);
    assert.equal(queue.dropped(), 3);
  });

  it('continua em ordem depois de dar a volta no buffer circular', () => {
    const scheduler = manualScheduler();
    const handled = [];
    const queue = createQueue({ handle: (item) => handled.push(item), schedule: scheduler.schedule, limit: 3 });
    for (const item of [1, 2, 3, 4, 5]) queue.push(item);
    scheduler.runAll();
    for (const item of [6, 7]) queue.push(item);
    scheduler.runAll();
    assert.deepEqual(handled, [3, 4, 5, 6, 7]);
    assert.equal(queue.dropped(), 2);
  });

  it('processa em lotes e reagenda até esvaziar', () => {
    const scheduler = manualScheduler();
    const handled = [];
    const queue = createQueue({ handle: (item) => handled.push(item), schedule: scheduler.schedule, batchSize: 2 });
    for (const item of [1, 2, 3, 4, 5]) queue.push(item);
    scheduler.pending.shift()();
    assert.deepEqual(handled, [1, 2]);
    assert.equal(scheduler.pending.length, 1, 'reagendou o resto');
    scheduler.runAll();
    assert.deepEqual(handled, [1, 2, 3, 4, 5]);
  });

  it('exceção no processador não para a fila e vai para onError', () => {
    const scheduler = manualScheduler();
    const handled = [];
    const errors = [];
    const queue = createQueue({
      handle: (item) => {
        if (item === 2) throw new TypeError('quebrou');
        handled.push(item);
      },
      onError: (err, item) => errors.push([err.name, item]),
      schedule: scheduler.schedule,
    });
    for (const item of [1, 2, 3]) queue.push(item);
    scheduler.runAll();
    assert.deepEqual(handled, [1, 3]);
    assert.deepEqual(errors, [['TypeError', 2]]);
  });

  it('nem um onError que lança para a fila', () => {
    const scheduler = manualScheduler();
    const handled = [];
    const queue = createQueue({
      handle: (item) => {
        if (item === 1) throw new Error('x');
        handled.push(item);
      },
      onError: () => {
        throw new Error('y');
      },
      schedule: scheduler.schedule,
    });
    queue.push(1);
    queue.push(2);
    scheduler.runAll();
    assert.deepEqual(handled, [2]);
  });

  it('com o agendador padrão (setImmediate), processa logo depois', async () => {
    const handled = [];
    const queue = createQueue({ handle: (item) => handled.push(item) });
    queue.push('a');
    assert.deepEqual(handled, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(handled, ['a']);
  });

  it('recusa limite ou lote inválidos', () => {
    for (const limit of [0, -1, 1.5, NaN]) {
      assert.throws(() => createQueue({ handle: () => {}, limit }), RangeError, String(limit));
    }
    assert.throws(() => createQueue({ handle: () => {}, batchSize: 0 }), RangeError);
  });
});
