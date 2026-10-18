// Seletores do painel (web/js/selectors.js): funções puras sobre o SessionState.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FEED_KINDS, PHASES, ROLES } from '../../../shared/contract.js';
import {
  MAX_FINISHED_SHOWN, PHASE_OWNER, PHASE_TITLES, ROLE_TITLES, feedView, healthOf, isFeedEvent, partySummary, questView,
  rosterRoles, sessionDurationMs, statsView, teamView,
} from '../../../web/js/selectors.js';
import { deepFreeze, loadSession, makeAgent, makeEvent } from './support.js';

describe('tabelas fixas', () => {
  it('cada etapa tem o papel dono da seção 6 do modelo de eventos', () => {
    assert.deepEqual({ ...PHASE_OWNER }, { design: 'arq', code: 'dev', test: 'tes', docs: 'doc' });
    assert.deepEqual(Object.keys(PHASE_TITLES).sort(), [...PHASES].sort());
  });

  it('todo papel do contrato tem o papel real', () => {
    assert.deepEqual(Object.keys(ROLE_TITLES).sort(), [...ROLES].sort());
  });
});

describe('duração e indicadores', () => {
  const session = { status: 'active', startedAt: 1_000, lastEventAt: 5_000, counters: { questsDone: 2, bugsCrushed: 3, pendingApprovals: 1 } };

  it('sessão ativa conta até agora; encerrada, até o último evento', () => {
    assert.equal(sessionDurationMs(/** @type {any} */ (session), 61_000), 60_000);
    assert.equal(sessionDurationMs(/** @type {any} */ ({ ...session, status: 'ended' }), 61_000), 4_000);
    assert.equal(sessionDurationMs(/** @type {any} */ (session), 0), 0);
  });

  it('statsView lê os contadores; ausentes valem zero', () => {
    assert.deepEqual(statsView(/** @type {any} */ (session), 2_000), { durationMs: 1_000, bugsCrushed: 3, questsDone: 2, pendingApprovals: 1 });
    assert.deepEqual(statsView(/** @type {any} */ ({ status: 'idle', startedAt: 0, lastEventAt: 0 }), 0), { durationMs: 0, bugsCrushed: 0, questsDone: 0, pendingApprovals: 0 });
  });

  it('snapshot neutro: contadores zerados', () => {
    const view = statsView(loadSession('neutro'), Date.now());
    assert.equal(view.bugsCrushed + view.questsDone + view.pendingApprovals, 0);
  });
});

describe('equipe', () => {
  it('rosterRoles segue o roster, sem repetir, e acrescenta papéis vistos que faltem', () => {
    const session = /** @type {any} */ ({
      roster: ['orq', 'tes', 'orq', 'inventado'],
      agents: [makeAgent({ key: 'main' }), makeAgent({ key: 'a', role: 'aux' }), makeAgent({ key: 'b', role: 'dev' })],
    });
    assert.deepEqual(rosterRoles(session), ['orq', 'tes', 'dev', 'aux']);
  });

  it('primeira luz: papéis do roster, instâncias em ordem e "×N" só com as não encerradas', () => {
    const session = deepFreeze(loadSession('primeira-luz'));
    const groups = teamView(session);
    assert.deepEqual(groups.map((g) => g.role), ['orq', 'arq', 'dev', 'tes', 'doc', 'aux']);

    const dev = groups.find((g) => g.role === 'dev');
    assert.equal(dev?.activeCount, 2);
    assert.equal(dev?.status, 'working');
    assert.deepEqual(dev?.instances.map((a) => a.label), ['implementar a ingestão', 'portar o painel do mockup', 'revisar o normalizador']);
    assert.equal(dev?.hiddenFinished, 0);

    const arq = groups.find((g) => g.role === 'arq');
    assert.deepEqual([arq?.instances.length, arq?.activeCount, arq?.status], [0, 0, 'idle']);

    const aux = groups.find((g) => g.role === 'aux');
    assert.equal(aux?.instances[0].agentType, 'Explore');
  });

  it('ticket completo: encerradas de tickets anteriores saem e não entram no "+N"; aguardando tem prioridade', () => {
    const groups = teamView(loadSession('ticket-completo'));
    const arq = groups.find((g) => g.role === 'arq');
    assert.deepEqual(arq?.instances.map((a) => a.label), ['desenhar a ingestão']);
    assert.equal(arq?.hiddenFinished, 0);
    assert.equal(groups.find((g) => g.role === 'tes')?.status, 'waiting');
    assert.equal(groups.find((g) => g.role === 'doc')?.instances.length, 0);
  });

  it(`mostra no máximo ${MAX_FINISHED_SHOWN} encerradas por papel, as mais recentes primeiro`, () => {
    const agents = [makeAgent({ key: 'main' })];
    for (let n = 1; n <= MAX_FINISHED_SHOWN + 2; n++) {
      agents.push(makeAgent({ key: `d${n}`, role: 'dev', finished: true, label: `d${n}`, startedAt: n, lastEventAt: n * 10 }));
    }
    agents.push(makeAgent({ key: 'ativo', role: 'dev', status: 'working', label: 'ativo', startedAt: 99, lastEventAt: 99 }));
    const dev = teamView(/** @type {any} */ ({ roster: ['orq', 'dev'], agents, quest: null })).find((g) => g.role === 'dev');
    assert.deepEqual(dev?.instances.map((a) => a.label), ['ativo', 'd5', 'd4', 'd3']);
    assert.equal(dev?.hiddenFinished, 2);
    assert.equal(dev?.activeCount, 1);
  });

  it('com ticket, o "+N" conta só as encerradas do ticket atual', () => {
    const agents = [makeAgent({ key: 'main' })];
    for (let n = 1; n <= 2; n++) {
      agents.push(makeAgent({ key: `antes${n}`, role: 'tes', finished: true, label: `antes${n}`, startedAt: n, lastEventAt: 50 + n }));
    }
    for (let n = 1; n <= MAX_FINISHED_SHOWN + 2; n++) {
      agents.push(makeAgent({ key: `agora${n}`, role: 'tes', finished: true, label: `agora${n}`, startedAt: 100 + n, lastEventAt: 100 + n * 10 }));
    }
    const quest = { id: 'q', n: 2, title: 't', implicit: false, status: 'open', startedAt: 100, endedAt: null, phases: {}, actions: 0, error: null };
    const tes = teamView(/** @type {any} */ ({ roster: ['orq', 'tes'], agents, quest })).find((g) => g.role === 'tes');
    assert.deepEqual(tes?.instances.map((a) => a.label), ['agora5', 'agora4', 'agora3']);
    assert.equal(tes?.hiddenFinished, 2, 'só agora1 e agora2; antes1 e antes2 ficam fora');
  });

  it('partySummary conta trabalhando ou aguardando entre os não encerrados', () => {
    assert.deepEqual(partySummary(loadSession('primeira-luz')), { active: 5, present: 5 });
    assert.deepEqual(partySummary(loadSession('ticket-completo')), { active: 2, present: 2 });
    assert.deepEqual(partySummary(loadSession('neutro')), { active: 0, present: 1 });
  });

  it('healthOf: fração em décimos; sem ações, 100%', () => {
    assert.deepEqual(healthOf(makeAgent({ health: { ok: 0, total: 0 } })), { ok: 0, total: 0, tenths: 10 });
    assert.deepEqual(healthOf(makeAgent({ health: { ok: 7, total: 8 } })), { ok: 7, total: 8, tenths: 9 });
    assert.deepEqual(healthOf(makeAgent({ health: { ok: 0, total: 3 } })), { ok: 0, total: 3, tenths: 0 });
    assert.deepEqual(healthOf(makeAgent({ health: { ok: 12, total: 10 } })), { ok: 10, total: 10, tenths: 10 });
    assert.deepEqual(healthOf(makeAgent({ health: null })), { ok: 0, total: 0, tenths: 10 });
  });
});

describe('ticket', () => {
  it('sem ticket, devolve null', () => {
    assert.equal(questView(loadSession('neutro'), 0), null);
    assert.equal(questView(loadSession('primeira-luz'), 0), null);
  });

  it('ticket aberto: duração até agora, etapas e stepper', () => {
    const session = loadSession('ticket-completo');
    const view = questView(session, session.quest.startedAt + 90_000);
    assert.equal(view?.n, 3);
    assert.equal(view?.durationMs, 90_000);
    assert.equal(view?.actions, 41);
    assert.equal(view?.showStepper, true);
    assert.equal(view?.phasesDone, 2);
    assert.deepEqual(view?.phases.map((p) => [p.id, p.state, p.owner]), [
      ['design', 'done', 'arq'], ['code', 'done', 'dev'], ['test', 'active', 'tes'], ['docs', 'pending', 'doc'],
    ]);
  });

  it('ticket encerrado usa endedAt; etapas todas pendentes escondem o stepper', () => {
    const quest = { id: 'q', n: 1, title: 't', implicit: true, status: 'done', startedAt: 1_000, endedAt: 4_000, phases: { design: 'pending', code: 'pending', test: 'pending', docs: 'estranho' }, actions: 2, error: null };
    const view = questView(/** @type {any} */ ({ quest }), 99_999);
    assert.equal(view?.durationMs, 3_000);
    assert.equal(view?.showStepper, false);
    assert.equal(view?.phases[3].state, 'pending');
  });
});

describe('feed', () => {
  it('isFeedEvent segue FEED_KINDS; etapa só quando termina', () => {
    for (const kind of FEED_KINDS) {
      if (kind !== 'quest.phase') assert.equal(isFeedEvent(makeEvent(kind, {})), true, kind);
    }
    assert.equal(isFeedEvent(makeEvent('tool.finished', {})), false);
    assert.equal(isFeedEvent(makeEvent('agent.started', {})), false);
    assert.equal(isFeedEvent(makeEvent('quest.phase', { state: 'active' })), false);
    assert.equal(isFeedEvent(makeEvent('quest.phase', { state: 'done' })), true);
  });

  it('feedView: mais recentes no topo, sem alterar o estado', () => {
    const session = deepFreeze(loadSession('ticket-completo'));
    const events = feedView(session);
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
    assert.ok(!seqs.includes(305), 'quest.phase active não entra');
    assert.ok(seqs.includes(309), 'quest.phase done entra');
    assert.equal(events.length, session.feed.length - 1);
  });

  it('feedView ordena mesmo com o feed fora de ordem e ignora o que não é do feed', () => {
    const feed = [makeEvent('tool.started', {}, 'main', 3), makeEvent('tool.finished', {}, 'main', 4), makeEvent('session.started', {}, null, 1)];
    assert.deepEqual(feedView(/** @type {any} */ ({ feed })).map((e) => e.seq), [3, 1]);
    assert.deepEqual(feedView(/** @type {any} */ ({})), []);
  });
});
