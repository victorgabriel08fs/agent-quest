// Os snapshots escritos à mão (test/fixtures/state/) seguem o contrato da seção 9
// do modelo de eventos. O "neutro" tem só os valores neutros da regra 2 do recorte.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_STATUS, EVENT_KINDS, FEED_KINDS, PHASES, QUEST_STATUS, ROLES, SESSION_STATUS, TOOL_CATEGORIES } from '../../../shared/contract.js';
import { SNAPSHOT_NAMES, loadSnapshot } from './support.js';

const SESSION_KEYS = ['id', 'project', 'label', 'client', 'status', 'startedAt', 'lastEventAt', 'agents', 'roster', 'quest', 'counters', 'bugs', 'feed'];
const AGENT_KEYS = ['key', 'agentId', 'agentType', 'role', 'label', 'status', 'finished', 'background', 'parentKey', 'activity', 'waitingFor', 'health', 'context', 'startedAt', 'lastEventAt'];
const QUEST_KEYS = ['id', 'n', 'title', 'implicit', 'status', 'startedAt', 'endedAt', 'phases', 'actions', 'error'];
const EVENT_KEYS = ['id', 'seq', 'ts', 'sessionId', 'agentKey', 'kind', 'data'];

describe('snapshots escritos à mão', () => {
  for (const name of SNAPSHOT_NAMES) {
    it(`${name}: forma do SnapshotMessage e do SessionState`, () => {
      const snapshot = loadSnapshot(name);
      assert.deepEqual(Object.keys(snapshot).sort(), ['seq', 'sessions']);
      for (const session of snapshot.sessions) {
        assert.deepEqual(Object.keys(session).sort(), [...SESSION_KEYS].sort());
        assert.deepEqual(Object.keys(session.project).sort(), ['dir', 'key', 'name']);
        assert.ok(SESSION_STATUS.includes(session.status));
        assert.ok(session.roster.every((role) => ROLES.includes(role)));
        assert.equal(session.roster[0], 'orq');
        assert.ok(session.agents.some((agent) => agent.key === 'main' && agent.role === 'orq'));
        for (const agent of session.agents) {
          assert.deepEqual(Object.keys(agent).sort(), [...AGENT_KEYS].sort(), agent.key);
          assert.ok(ROLES.includes(agent.role));
          assert.ok(AGENT_STATUS.includes(agent.status));
          if (agent.activity) assert.ok(agent.activity.category === null || TOOL_CATEGORIES.includes(agent.activity.category));
        }
        if (session.quest) {
          assert.deepEqual(Object.keys(session.quest).sort(), [...QUEST_KEYS].sort());
          assert.ok(QUEST_STATUS.includes(session.quest.status));
          assert.deepEqual(Object.keys(session.quest.phases).sort(), [...PHASES].sort());
        }
        assert.deepEqual(Object.keys(session.counters).sort(), ['bugsCrushed', 'pendingApprovals', 'questsDone']);
        assert.deepEqual(Object.keys(session.bugs).sort(), ['lastRun', 'open']);
        assert.ok(session.feed.length <= 200);
        for (const event of session.feed) {
          assert.deepEqual(Object.keys(event).sort(), [...EVENT_KEYS].sort());
          assert.ok(FEED_KINDS.includes(event.kind) && EVENT_KINDS.includes(event.kind), event.kind);
          assert.equal(event.sessionId, session.id);
          assert.equal(event.id.split(':')[1], String(event.seq));
          if (event.kind === 'tool.started') assert.ok(TOOL_CATEGORIES.includes(event.data.category));
        }
        assert.ok(new Set(session.feed.map((e) => e.seq)).size === session.feed.length, 'seq repetido');
      }
    });
  }

  it('neutro: só os valores neutros do recorte (regra 2)', () => {
    const [session] = loadSnapshot('neutro').sessions;
    assert.equal(session.quest, null);
    assert.equal(session.client, null);
    assert.deepEqual(session.counters, { questsDone: 0, bugsCrushed: 0, pendingApprovals: 0 });
    assert.deepEqual(session.bugs, { open: 0, lastRun: null });
    for (const agent of session.agents) {
      assert.equal(agent.waitingFor, null);
      assert.equal(agent.context, null);
      assert.notEqual(agent.status, 'waiting');
    }
    assert.notEqual(session.status, 'waiting');
  });

  it('primeira luz: só os tipos que o reducer do recorte emite (regra 3)', () => {
    const allowed = ['session.started', 'session.ended', 'agent.delegated', 'agent.started', 'agent.finished', 'tool.started', 'tool.finished', 'tool.failed'];
    const [session] = loadSnapshot('primeira-luz').sessions;
    for (const event of session.feed) assert.ok(allowed.includes(event.kind), event.kind);
    assert.equal(session.quest, null);
    assert.ok(session.agents.every((agent) => agent.status !== 'waiting' && agent.waitingFor === null && agent.context === null));
    assert.ok(!session.feed.some((event) => event.data.category === 'test'), 'até o T6, testes ficam em bash (regra 4)');
  });
});
