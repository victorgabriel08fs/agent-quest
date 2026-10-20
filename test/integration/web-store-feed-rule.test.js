// Feed do store do painel contra a regra do contrato (modelo de eventos,
// seção 3, coluna "No feed"): `quest.phase` entra no feed só com `state: done`.
// O servidor segue a regra (server/domain/state/sessions.js, isFeedEvent), e o
// store (web/js/store.js) precisa seguir a mesma (selectors.js, isFeedEvent).
//
// Regressão do bug 2 do tester no T11b (corrigido em 19/10/2026): o store
// acrescentava todo tipo de FEED_KINDS, inclusive a etapa ativa. A view
// escondia essas linhas, mas elas ocupavam lugar no limite de 200: o painel ao
// vivo mostrava menos linhas que o servidor, e o feed do store divergia do
// /api/state. Era a causa das falhas de test/integration/sse-resume-spec.test.js
// ("o injetor de um cenário sintético ... termina igual ao /api/state") e de
// test/integration/inject-fixture.test.js ("o cliente que cai no meio da
// injeção ..."), que apareceram com o T8, porque só o T8 emite `quest.phase`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyHello, applySnapshot, applyUpdate, createStore } from '../../web/js/store.js';
import { feedView, isFeedEvent } from '../../web/js/selectors.js';

const RUN = 'qa-run';
const SESSION_ID = 'sessao-ficticia-1';

/** Estado mínimo de sessão (seção 9), sem feed. */
function sessionState() {
  return {
    id: SESSION_ID,
    project: { key: 'c:/projetos/agents-quest', name: 'agents-quest', dir: 'C:\\Projetos\\agents-quest' },
    label: 'Sessão fictícia',
    client: null,
    status: 'active',
    startedAt: 1_760_000_000_000,
    lastEventAt: 1_760_000_000_000,
    agents: [],
    roster: ['orq', 'tes'],
    quest: null,
    counters: { questsDone: 0, bugsCrushed: 0, pendingApprovals: 0 },
    bugs: { open: 0, lastRun: null },
  };
}

/** @param {number} seq @param {string} kind @param {object} data */
const event = (seq, kind, data, agentKey = 'main') => ({ id: `${RUN}:${seq}`, seq, ts: 1_760_000_000_000 + seq, sessionId: SESSION_ID, agentKey, kind, data });

function storeWithFullFeed() {
  const store = createStore();
  applyHello(store, { protocol: 1, runId: RUN, seq: 200, serverVersion: '0.1.0' });
  const feed = Array.from({ length: 200 }, (_, i) => event(i + 1, 'tool.started', { toolUseId: `t${i}`, tool: 'Read', category: 'read', target: `a${i}.md`, detail: null }));
  assert.equal(applySnapshot(store, { seq: 200, sessions: [{ ...sessionState(), feed }] }), true);
  return store;
}

describe('feed do store e a regra do contrato para quest.phase', () => {
  it('etapa concluída entra no feed do store (controle: a regra vale para done)', () => {
    const store = storeWithFullFeed();
    const done = event(201, 'quest.phase', { questId: 'q1', phase: 'test', state: 'done' }, 'tes-1');
    assert.equal(applyUpdate(store, { seq: 201, event: done, session: sessionState() }), 'ok');
    const feed = store.sessions.get(SESSION_ID)?.feed ?? [];
    assert.equal(feed.length, 200);
    assert.equal(feed.at(-1)?.id, done.id);
  });

  it('etapa ativa não entra no feed do store (seção 3: "só done")', () => {
    const store = storeWithFullFeed();
    const active = event(201, 'quest.phase', { questId: 'q1', phase: 'test', state: 'active' }, 'tes-1');
    assert.equal(isFeedEvent(active), false);
    assert.equal(applyUpdate(store, { seq: 201, event: active, session: sessionState() }), 'ok');
    const feed = store.sessions.get(SESSION_ID)?.feed ?? [];
    assert.equal(feed.some((e) => e.id === active.id), false, 'a etapa ativa ficou no feed do store');
    assert.equal(feed.length, 200);
  });

  it('30 etapas ativas ao vivo não tiram linhas visíveis: o painel continua com as 200 do servidor', () => {
    const store = storeWithFullFeed();
    for (let i = 0; i < 30; i++) {
      const seq = 201 + i;
      const active = event(seq, 'quest.phase', { questId: `q${i}`, phase: 'code', state: 'active' }, 'dev-1');
      assert.equal(applyUpdate(store, { seq, event: active, session: sessionState() }), 'ok');
    }
    const session = store.sessions.get(SESSION_ID);
    assert.ok(session);
    // O servidor, que não guarda etapa ativa, continua com as 200 linhas de ferramenta.
    assert.equal(feedView(session).length, 200);
  });
});
