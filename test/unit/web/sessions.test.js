// Seletor simples de sessão (T11a): ordem por lastEventAt, começa na mais
// recente, a escolha vale enquanto a sessão existir, opções com rótulo e
// projeto, e o <select> atualizado no lugar.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSelectedId, sessionList } from '../../../web/js/selectors.js';
import { applySessionRemoved, applySnapshot, applyUpdate, createStore } from '../../../web/js/store.js';
import { sessionOptions, syncSessionSelect } from '../../../web/js/views/sessions.js';
import { XSS, deepFreeze, loadSnapshot } from './support.js';

/** Sessão mínima com id, rótulo, projeto e horários. */
function session(id, lastEventAt, extra = {}) {
  return { id, label: `Sessão ${id}`, project: { key: `c:/p/${id}`, name: `projeto-${id}`, dir: `C:\\p\\${id}` }, status: 'active', startedAt: 0, lastEventAt, ...extra };
}

/** <select> falso com o que syncSessionSelect usa. */
function fakeSelect() {
  const options = [];
  const select = {
    options,
    created: 0,
    removed: 0,
    get value() {
      return options.find((o) => o.selected)?.value ?? (options[0]?.value ?? '');
    },
    set value(v) {
      for (const option of options) option.selected = option.value === v;
    },
    remove(index) {
      options.splice(index, 1);
      select.removed++;
    },
    add(option) {
      options.push(option);
    },
    ownerDocument: {
      createElement: () => {
        select.created++;
        return { value: '', textContent: '', selected: false };
      },
    },
  };
  return select;
}

describe('ordem e escolha', () => {
  it('sessionList: mais recente primeiro por lastEventAt; empate pela que começou depois', () => {
    const list = sessionList([session('a', 10), session('b', 30), session('c', 20), session('d', 30, { startedAt: 5 })]);
    assert.deepEqual(list.map((s) => s.id), ['d', 'b', 'c', 'a']);
  });

  it('começa na mais recente; a escolha vale enquanto a sessão existir; se sumir, volta para a mais recente', () => {
    const list = sessionList([session('a', 10), session('b', 30)]);
    assert.equal(resolveSelectedId(list, null), 'b');
    assert.equal(resolveSelectedId(list, 'a'), 'a');
    const later = sessionList([session('a', 99), session('b', 30)]);
    assert.equal(resolveSelectedId(later, 'b'), 'b', 'outra sessão mais ativa não troca a escolha');
    assert.equal(resolveSelectedId(sessionList([session('b', 30)]), 'a'), 'b');
    assert.equal(resolveSelectedId([], 'a'), null);
  });

  it('com o store: sessão removida volta para a mais recente', () => {
    const store = createStore();
    const neutro = loadSnapshot('neutro').sessions[0];
    const luz = loadSnapshot('primeira-luz').sessions[0];
    applySnapshot(store, deepFreeze({ seq: 10, sessions: [neutro, luz] }));
    let chosen = resolveSelectedId(sessionList(store.sessions.values()), null);
    assert.equal(chosen, luz.id, 'a mais recente por lastEventAt');
    chosen = neutro.id;
    const { feed: _f, ...neutroState } = neutro;
    applyUpdate(store, { seq: 11, event: null, session: { ...neutroState, lastEventAt: luz.lastEventAt - 1 } });
    assert.equal(resolveSelectedId(sessionList(store.sessions.values()), chosen), neutro.id);
    applySessionRemoved(store, { seq: 12, sessionId: neutro.id });
    assert.equal(resolveSelectedId(sessionList(store.sessions.values()), chosen), luz.id);
  });
});

describe('opções e projeto', () => {
  it('cada opção mostra rótulo e projeto; encerrada é indicada', () => {
    const list = [session('a', 30), session('b', 20, { status: 'ended' }), session('c', 10, { label: '', project: null })];
    assert.deepEqual(sessionOptions(list, 'b'), [
      { value: 'a', text: 'Sessão a · projeto-a', selected: false },
      { value: 'b', text: 'Sessão b · projeto-b · encerrada', selected: true },
      { value: 'c', text: 'c', selected: false },
    ]);
  });

  it('o projeto aparece uma vez só, dentro da opção (sem linha separada acima do seletor)', () => {
    const [option] = sessionOptions([session('x', 1)], 'x');
    assert.equal(option.text.split('projeto-x').length - 1, 1);
  });
});

describe('syncSessionSelect', () => {
  it('cria, atualiza e remove opções no lugar, por texto, e marca a escolhida', () => {
    const select = fakeSelect();
    syncSessionSelect(select, sessionOptions([session('a', 30), session('b', 20)], 'b'));
    assert.deepEqual(select.options.map((o) => [o.value, o.textContent]), [['a', 'Sessão a · projeto-a'], ['b', 'Sessão b · projeto-b']]);
    assert.equal(select.value, 'b');
    assert.equal(select.created, 2);

    const first = select.options[0];
    syncSessionSelect(select, sessionOptions([session('b', 40), session('a', 30), session('c', 5)], 'b'));
    assert.deepEqual(select.options.map((o) => o.value), ['b', 'a', 'c']);
    assert.equal(select.options[0], first, 'reaproveita os elementos (o select e o foco continuam)');
    assert.equal(select.value, 'b');
    assert.equal(select.created, 3);

    syncSessionSelect(select, sessionOptions([session('a', 30)], 'a'));
    assert.deepEqual(select.options.map((o) => o.value), ['a']);
    assert.equal(select.removed, 2);

    syncSessionSelect(select, []);
    assert.equal(select.options.length, 0);
  });

  it('texto com HTML entra como texto (textContent), sem virar marcação', () => {
    const select = fakeSelect();
    syncSessionSelect(select, sessionOptions([session('a', 1, { label: XSS })], 'a'));
    assert.equal(select.options[0].textContent, `${XSS} · projeto-a`);
    assert.equal(select.options[0].innerHTML, undefined);
  });
});
