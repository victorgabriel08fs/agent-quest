// Política "seguir atividade" (T13; modelo de eventos, seção 7), com relógio
// falso: o `now` é sempre passado pelo teste (ADR 0010).
// - troca quando a sessão atual está parada há 30 s e outra está ativa;
// - no máximo uma troca a cada 10 s;
// - desligada quando o usuário fixa uma sessão;
// - a preferência guardada no localStorage é lida e escrita por texto.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PREFERENCE, FOLLOW_IDLE_MS, FOLLOW_MIN_SWITCH_MS, FOLLOW_STORAGE_KEY,
  chooseSession, isActive, isIdle, parsePreference, serializePreference,
} from '../../../web/js/follow.js';
import { sessionList } from '../../../web/js/selectors.js';

const T0 = 1_760_000_000_000;
const FOLLOW = { follow: true, pinnedId: null };

/** Sessão mínima: id, status, último evento e aprovações pendentes. */
function session(id, lastEventAt, status = 'active', pendingApprovals = 0) {
  return { id, label: `Sessão ${id}`, project: { key: `c:/p/${id}`, name: id, dir: `C:\\p\\${id}` }, status, startedAt: 0, lastEventAt, counters: { questsDone: 0, bugsCrushed: 0, pendingApprovals } };
}

/** Relógio falso com a memória da última troca, como o main.js usa a política. */
function follower(preference = FOLLOW) {
  const state = { currentId: /** @type {string|null} */ (null), lastSwitchAt: /** @type {number|null} */ (null), switches: 0 };
  return {
    state,
    /** @param {any[]} sessions @param {number} now */
    at(sessions, now) {
      const choice = chooseSession({ list: sessionList(sessions), preference, currentId: state.currentId, lastSwitchAt: state.lastSwitchAt, now });
      if (choice.switched) {
        state.lastSwitchAt = now;
        state.switches++;
      }
      state.currentId = choice.id;
      return choice;
    },
  };
}

describe('valores da política', () => {
  it('30 s parada, 10 s entre trocas, chave do localStorage', () => {
    assert.equal(FOLLOW_IDLE_MS, 30_000);
    assert.equal(FOLLOW_MIN_SWITCH_MS, 10_000);
    assert.equal(FOLLOW_STORAGE_KEY, 'agent-quest-session');
    assert.deepEqual(DEFAULT_PREFERENCE, { follow: true, pinnedId: null });
    assert.ok(Object.isFrozen(DEFAULT_PREFERENCE));
  });
});

describe('seguir atividade', () => {
  it('sem sessão mostrada, começa na mais recente; lista vazia dá null', () => {
    const f = follower();
    assert.deepEqual(f.at([session('a', T0 - 5_000), session('b', T0 - 1_000)], T0), { id: 'b', switched: false });
    assert.deepEqual(chooseSession({ list: [], preference: FOLLOW, currentId: 'x', lastSwitchAt: null, now: T0 }), { id: null, switched: false });
  });

  it('troca quando a atual está parada há 30 s e outra está ativa, com evento mais recente', () => {
    const f = follower();
    const a = session('a', T0);
    f.at([a], T0);
    const b = session('b', T0 + 20_000);
    // 29 999 ms sem evento: ainda não está parada.
    assert.deepEqual(f.at([a, b], T0 + FOLLOW_IDLE_MS - 1), { id: 'a', switched: false });
    // 30 s exatos: troca.
    assert.deepEqual(f.at([a, b], T0 + FOLLOW_IDLE_MS), { id: 'b', switched: true });
    assert.equal(f.state.switches, 1);
  });

  it('a atual com evento recente não troca, mesmo com outra mais ativa', () => {
    const f = follower();
    f.at([session('a', T0)], T0);
    const now = T0 + 60_000;
    assert.deepEqual(f.at([session('a', now - 5_000), session('b', now - 1)], now), { id: 'a', switched: false });
  });

  it('não troca para sessão parada, encerrada ou com evento mais antigo que o da atual', () => {
    const now = T0 + 120_000;
    const base = { preference: FOLLOW, currentId: 'a', lastSwitchAt: null, now };
    for (const other of [session('b', T0 + 1_000, 'idle'), session('b', T0 + 1_000, 'ended'), session('b', T0 - 1, 'active'), session('b', T0, 'active')]) {
      const list = sessionList([session('a', T0), other]);
      assert.deepEqual(chooseSession({ ...base, list }), { id: 'a', switched: false }, `${other.status} em ${other.lastEventAt - T0}`);
    }
  });

  it('sessão esperando aprovação conta como ativa para receber a troca', () => {
    const now = T0 + 60_000;
    const list = sessionList([session('a', T0), session('b', T0 + 5_000, 'waiting', 1)]);
    assert.deepEqual(chooseSession({ list, preference: FOLLOW, currentId: 'a', lastSwitchAt: null, now }), { id: 'b', switched: true });
  });

  it('a atual com aprovação pendente nunca é deixada para trás', () => {
    const now = T0 + 10 * 60_000;
    for (const current of [session('a', T0, 'waiting', 1), session('a', T0, 'active', 2)]) {
      const list = sessionList([current, session('b', now - 1)]);
      assert.deepEqual(chooseSession({ list, preference: FOLLOW, currentId: 'a', lastSwitchAt: null, now }), { id: 'a', switched: false });
    }
  });

  it('entre várias ativas, vai para a de evento mais recente', () => {
    const now = T0 + 60_000;
    const list = sessionList([session('a', T0), session('b', T0 + 40_000), session('c', T0 + 50_000, 'waiting'), session('d', T0 + 55_000, 'idle')]);
    assert.deepEqual(chooseSession({ list, preference: FOLLOW, currentId: 'a', lastSwitchAt: null, now }), { id: 'c', switched: true });
  });

  it('no máximo uma troca a cada 10 s', () => {
    const f = follower();
    const now = T0 + 100_000;
    f.at([session('a', T0)], T0);
    // a → b: a está parada e b ativa.
    assert.deepEqual(f.at([session('a', T0), session('b', T0 + 1_000)], now), { id: 'b', switched: true });
    // Logo depois, b também parada e c ativa: espera os 10 s.
    const list = [session('a', T0), session('b', T0 + 1_000), session('c', T0 + 2_000)];
    for (const dt of [0, 1, 5_000, FOLLOW_MIN_SWITCH_MS - 1]) {
      assert.deepEqual(f.at(list, now + dt), { id: 'b', switched: false }, `+${dt} ms`);
    }
    assert.deepEqual(f.at(list, now + FOLLOW_MIN_SWITCH_MS), { id: 'c', switched: true });
    assert.equal(f.state.switches, 2);
  });

  it('a sessão atual sumiu: vai para a mais recente, sem contar como troca automática', () => {
    const f = follower();
    f.at([session('a', T0), session('b', T0 - 1_000)], T0);
    assert.equal(f.state.currentId, 'a');
    assert.deepEqual(f.at([session('b', T0 - 1_000), session('c', T0 - 2_000)], T0 + 1_000), { id: 'b', switched: false });
    assert.equal(f.state.lastSwitchAt, null);
  });

  it('isIdle e isActive', () => {
    assert.equal(isIdle(session('a', T0), T0 + FOLLOW_IDLE_MS), true);
    assert.equal(isIdle(session('a', T0), T0 + FOLLOW_IDLE_MS - 1), false);
    assert.equal(isIdle(session('a', T0, 'waiting'), T0 + 3_600_000), false);
    assert.equal(isIdle(session('a', T0, 'idle', 1), T0 + 3_600_000), false);
    assert.equal(isIdle({ ...session('a', T0), lastEventAt: undefined }, T0), true, 'sem hora vale como muito antiga');
    assert.deepEqual(['active', 'waiting', 'idle', 'ended'].map((status) => isActive(session('a', T0, status))), [true, true, false, false]);
  });
});

describe('sessão fixada', () => {
  const pinned = (id) => ({ follow: false, pinnedId: id });

  it('fixada, nunca troca sozinha, mesmo parada e com outra ativa', () => {
    const f = follower(pinned('a'));
    const later = T0 + 10 * 60_000;
    assert.deepEqual(f.at([session('a', T0), session('b', later - 1)], later), { id: 'a', switched: false });
    assert.deepEqual(f.at([session('a', T0), session('b', later - 1)], later + 60_000), { id: 'a', switched: false });
    assert.equal(f.state.switches, 0);
  });

  it('fixada numa sessão que não é a mais recente: mostra a fixada desde o início', () => {
    const f = follower(pinned('a'));
    assert.deepEqual(f.at([session('a', T0 - 50_000), session('b', T0)], T0), { id: 'a', switched: false });
  });

  it('a fixada sumiu: mostra a mais recente e fica nela; volta para a fixada quando ela reaparece', () => {
    const f = follower(pinned('a'));
    f.at([session('a', T0), session('b', T0 - 1)], T0);
    assert.deepEqual(f.at([session('b', T0 - 1), session('c', T0 - 2)], T0 + 1_000), { id: 'b', switched: false });
    // Sem a fixada, não segue atividade: c mais ativa não tira de b.
    assert.deepEqual(f.at([session('b', T0 - 1), session('c', T0 + 90_000)], T0 + 120_000), { id: 'b', switched: false });
    assert.deepEqual(f.at([session('a', T0 + 1), session('b', T0 - 1)], T0 + 130_000), { id: 'a', switched: false });
  });
});

describe('preferência no localStorage', () => {
  it('ida e volta: seguir e sessão fixada', () => {
    assert.equal(serializePreference({ follow: true, pinnedId: null }), '{"follow":true}');
    assert.equal(serializePreference({ follow: true, pinnedId: 'x' }), '{"follow":true}', 'seguindo, não guarda sessão');
    assert.deepEqual(parsePreference(serializePreference({ follow: true, pinnedId: null })), { follow: true, pinnedId: null });
    assert.deepEqual(parsePreference(serializePreference({ follow: false, pinnedId: 'sess-1' })), { follow: false, pinnedId: 'sess-1' });
  });

  it('valor ausente, vazio, adulterado ou incoerente vale o padrão (seguir)', () => {
    const bad = [null, undefined, '', 'x', '[]', 'null', '42', '"texto"', '{}', '{"follow":"no"}', '{"follow":false}',
      '{"follow":false,"pinnedId":""}', '{"follow":false,"pinnedId":7}', `{"follow":false,"pinnedId":"${'a'.repeat(201)}"}`];
    for (const text of bad) assert.deepEqual(parsePreference(/** @type {any} */ (text)), { follow: true, pinnedId: null }, String(text));
    // Devolve uma cópia: alterar o resultado não muda o padrão.
    const value = parsePreference(null);
    value.follow = false;
    assert.equal(DEFAULT_PREFERENCE.follow, true);
  });

  it('seguindo, uma sessão guardada junto é ignorada', () => {
    assert.deepEqual(parsePreference('{"follow":true,"pinnedId":"sess-1"}'), { follow: true, pinnedId: null });
  });
});
