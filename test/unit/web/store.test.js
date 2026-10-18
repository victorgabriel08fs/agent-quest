// Store do painel (web/js/store.js): snapshot, update, session-removed e as
// regras de seq (repetido ou menor é ignorado; lacuna devolve 'gap').

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEED_LIMIT, applyHello, applySessionRemoved, applySnapshot, applyUpdate, createStore, removeSession,
} from '../../../web/js/store.js';
import { deepFreeze, loadSnapshot, makeEvent } from './support.js';

/** Store já com o snapshot da Primeira luz (seq 121). */
function loaded(name = 'primeira-luz') {
  const store = createStore();
  assert.equal(applySnapshot(store, deepFreeze(loadSnapshot(name))), true);
  return store;
}

/**
 * Update da sessão de um snapshot, com um campo trocado e, se pedido, um evento.
 * @param {any} base   SessionState
 * @param {number} seq
 * @param {object} [changes]
 * @param {string|null} [kind]
 */
function updateOf(base, seq, changes = {}, kind = 'tool.started') {
  const { feed, ...session } = base;
  const event = kind ? { ...makeEvent(kind, { tool: 'Read', category: 'read', target: `arquivo-${seq}.js` }, 'main', seq), sessionId: base.id, id: `k3f9q:${seq}` } : null;
  return { seq, event, session: { ...session, lastEventAt: base.lastEventAt + seq, ...changes } };
}

describe('snapshot', () => {
  it('substitui tudo e guarda o seq', () => {
    const store = loaded();
    assert.equal(store.seq, 121);
    assert.equal(store.sessions.size, 1);
    const [session] = store.sessions.values();
    assert.equal(session.feed.length, 21);
    applySnapshot(store, deepFreeze(loadSnapshot('neutro')));
    assert.equal(store.seq, 1);
    assert.deepEqual([...store.sessions.keys()], ['0b1c2d3e-0000-4000-8000-000000000001']);
  });

  it('snapshot de outra execução, com seq menor, também substitui (é a verdade do servidor)', () => {
    const store = loaded();
    assert.equal(applySnapshot(store, { seq: 0, sessions: [] }), true);
    assert.equal(store.seq, 0);
    assert.equal(store.sessions.size, 0);
  });

  it('feed do snapshot: só FEED_KINDS, em ordem de seq, sem repetir, até 200', () => {
    const base = loadSnapshot('neutro').sessions[0];
    const events = [];
    for (let seq = 250; seq >= 1; seq--) events.push(makeEvent('tool.started', {}, 'main', seq));
    events.push(makeEvent('tool.started', {}, 'main', 250), makeEvent('tool.finished', {}, 'main', 999), null);
    const store = createStore();
    applySnapshot(store, /** @type {any} */ ({ seq: 999, sessions: [{ ...base, feed: events }] }));
    const feed = store.sessions.get(base.id)?.feed ?? [];
    assert.equal(feed.length, FEED_LIMIT);
    assert.equal(feed[0].seq, 51);
    assert.equal(feed.at(-1)?.seq, 250);
  });

  it('sessão sem feed ganha feed vazio; snapshot malformado é ignorado', () => {
    const base = loadSnapshot('neutro').sessions[0];
    const store = createStore();
    applySnapshot(store, /** @type {any} */ ({ seq: 5, sessions: [{ ...base, feed: undefined }, { semId: true }] }));
    assert.deepEqual(store.sessions.get(base.id)?.feed, []);
    assert.equal(store.sessions.size, 1);
    for (const bad of [null, {}, { seq: -1, sessions: [] }, { seq: 1.5, sessions: [] }, { seq: 3, sessions: 'x' }]) {
      assert.equal(applySnapshot(store, /** @type {any} */ (bad)), false);
    }
    assert.equal(store.seq, 5);
  });
});

describe('update', () => {
  it('em ordem: troca o estado da sessão e acrescenta o evento ao feed', () => {
    const store = loaded();
    const base = loadSnapshot('primeira-luz').sessions[0];
    const before = store.sessions.get(base.id);
    assert.equal(applyUpdate(store, deepFreeze(updateOf(base, 122, { status: 'idle' }))), 'ok');
    const after = store.sessions.get(base.id);
    assert.equal(store.seq, 122);
    assert.equal(after?.status, 'idle');
    assert.equal(after?.feed.length, 22);
    assert.equal(after?.feed.at(-1)?.seq, 122);
    assert.notEqual(after, before, 'troca o objeto da sessão');
    assert.equal(before?.feed.length, 21, 'não altera o feed anterior');
  });

  it('evento fora de FEED_KINDS ou nulo muda só o estado', () => {
    const store = loaded();
    const base = loadSnapshot('primeira-luz').sessions[0];
    assert.equal(applyUpdate(store, updateOf(base, 122, { label: 'novo' }, 'tool.finished')), 'ok');
    assert.equal(applyUpdate(store, updateOf(base, 123, { label: 'outro' }, null)), 'ok');
    const session = store.sessions.get(base.id);
    assert.equal(session?.label, 'outro');
    assert.equal(session?.feed.length, 21);
  });

  it('seq repetido ou menor é ignorado, sem mudar nada', () => {
    const store = loaded();
    const base = loadSnapshot('primeira-luz').sessions[0];
    assert.equal(applyUpdate(store, updateOf(base, 122, { label: 'a' })), 'ok');
    const snapshotOf = () => JSON.stringify({ seq: store.seq, sessions: [...store.sessions.values()] });
    const before = snapshotOf();
    assert.equal(applyUpdate(store, updateOf(base, 122, { label: 'repetido' })), 'ignored');
    assert.equal(applyUpdate(store, updateOf(base, 100, { label: 'velho' })), 'ignored');
    assert.equal(snapshotOf(), before);
  });

  it('lacuna devolve gap e não aplica', () => {
    const store = loaded();
    const base = loadSnapshot('primeira-luz').sessions[0];
    assert.equal(applyUpdate(store, updateOf(base, 124, { label: 'adiantado' })), 'gap');
    assert.equal(store.seq, 121);
    assert.notEqual(store.sessions.get(base.id)?.label, 'adiantado');
  });

  it('antes do primeiro snapshot, todo update é lacuna', () => {
    const base = loadSnapshot('neutro').sessions[0];
    assert.equal(applyUpdate(createStore(), updateOf(base, 1)), 'gap');
  });

  it('update malformado é ignorado', () => {
    const store = loaded();
    for (const bad of [null, {}, { seq: 122 }, { seq: 122, session: {} }, { seq: '122', session: { id: 'x' } }]) {
      assert.equal(applyUpdate(store, /** @type {any} */ (bad)), 'ignored');
    }
    assert.equal(store.seq, 121);
  });

  it('sessão nova chega por update', () => {
    const store = loaded();
    const novo = loadSnapshot('neutro').sessions[0];
    assert.equal(applyUpdate(store, updateOf(novo, 122)), 'ok');
    assert.equal(store.sessions.size, 2);
    assert.equal(store.sessions.get(novo.id)?.feed.length, 1);
  });

  it('feed de cada sessão fica em até 200 eventos, os mais recentes', () => {
    const store = loaded();
    const base = loadSnapshot('primeira-luz').sessions[0];
    for (let seq = 122; seq < 122 + FEED_LIMIT + 30; seq++) assert.equal(applyUpdate(store, updateOf(base, seq)), 'ok');
    const feed = store.sessions.get(base.id)?.feed ?? [];
    assert.equal(feed.length, FEED_LIMIT);
    assert.equal(feed.at(-1)?.seq, 122 + FEED_LIMIT + 29);
  });
});

describe('sequências fora de ordem, repetidas e com lacuna', () => {
  /**
   * Entrega as mensagens na ordem dada, como a conexão faz: o que dá lacuna
   * fica guardado e é reaplicado em ordem de seq quando a lacuna fecha.
   */
  function deliver(store, messages) {
    let held = [];
    const results = [];
    for (const message of messages) {
      results.push(applyUpdate(store, message));
      if (results.at(-1) === 'gap') held.push(message);
      held.sort((a, b) => a.seq - b.seq);
      const rest = [];
      for (const pending of held) if (applyUpdate(store, pending) === 'gap') rest.push(pending);
      held = rest;
    }
    return { results, held };
  }

  const base = loadSnapshot('primeira-luz').sessions[0];
  const ordered = Array.from({ length: 12 }, (_, i) => updateOf(base, 122 + i, { label: `passo ${i}`, status: i % 2 ? 'idle' : 'working' }));

  /** Estado final em ordem, para comparar. */
  function finalOf(messages) {
    const store = loaded();
    deliver(store, messages);
    return { seq: store.seq, session: store.sessions.get(base.id) };
  }
  const expected = finalOf(ordered);

  it('embaralhadas: o resultado final é igual ao da ordem certa', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let round = 0; round < 20; round++) {
      const shuffled = [...ordered].sort(() => random() - 0.5);
      assert.deepEqual(finalOf(shuffled), expected, `rodada ${round}`);
    }
  });

  it('repetidas: cada seq vale uma vez só, e o feed não duplica', () => {
    const doubled = ordered.flatMap((message) => [message, message]);
    const store = loaded();
    const { results } = deliver(store, doubled);
    assert.equal(results.filter((r) => r === 'ignored').length, ordered.length);
    assert.deepEqual({ seq: store.seq, session: store.sessions.get(base.id) }, expected);
  });

  it('com lacuna que não fecha: para no último seq contínuo e guarda o resto', () => {
    const store = loaded();
    const { held } = deliver(store, ordered.filter((m) => m.seq !== 127));
    assert.equal(store.seq, 126);
    assert.deepEqual(held.map((m) => m.seq), [128, 129, 130, 131, 132, 133]);
  });
});

describe('session-removed e hello', () => {
  it('removeSession tira a sessão e diz se ela existia', () => {
    const store = loaded();
    const id = [...store.sessions.keys()][0];
    assert.equal(removeSession(store, id), true);
    assert.equal(removeSession(store, id), false);
    assert.equal(store.sessions.size, 0);
  });

  it('session-removed segue as mesmas regras de seq', () => {
    const store = loaded();
    const id = [...store.sessions.keys()][0];
    assert.equal(applySessionRemoved(store, { seq: 123, sessionId: id }), 'gap');
    assert.equal(store.sessions.size, 1);
    assert.equal(applySessionRemoved(store, { seq: 121, sessionId: id }), 'ignored');
    assert.equal(applySessionRemoved(store, { seq: 122, sessionId: id }), 'ok');
    assert.equal(store.sessions.size, 0);
    assert.equal(store.seq, 122);
    assert.equal(applySessionRemoved(store, { seq: 123, sessionId: 'nao-existe' }), 'ok', 'remover o que não existe só avança o seq');
    assert.equal(applySessionRemoved(store, /** @type {any} */ ({ seq: 124 })), 'ignored');
  });

  it('applyHello registra a execução e avisa quando ela muda', () => {
    const store = createStore();
    assert.equal(applyHello(store, { protocol: 1, runId: 'a', seq: 0, serverVersion: '0.1.0' }), false);
    assert.equal(applyHello(store, { protocol: 1, runId: 'a', seq: 5, serverVersion: '0.1.0' }), false);
    assert.equal(applyHello(store, { protocol: 1, runId: 'b', seq: 0, serverVersion: '0.1.0' }), true);
    assert.equal(store.runId, 'b');
  });
});
