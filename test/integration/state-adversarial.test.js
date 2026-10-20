// Estado I, caminhos ruins (tester, T7): fatos fora de ordem e duplicados, ids
// repetidos entre sessões, SubagentStop sem SubagentStart, delegações em
// paralelo, aninhamento profundo, sessão com milhares de agentes, relógio
// voltando, eventos depois do SessionEnd, agent_type com cara de segredo ou
// com ANSI, caminhos do Windows variados e invariantes com JSON aleatório
// passando pelo normalizador real (o reducer nunca lança com fatos válidos).
//
// Cenários SINTÉTICOS, montados em state-helpers.js. Os testes marcados com
// `todo` reproduzem achados abertos no relatório do tester.
//
// Pastas pessoais, projetos e ids são fictícios (o repositório é público).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  FORBIDDEN,
  HOME,
  MIN,
  OTHER_PROJECT,
  PROJECT,
  T0,
  Tracker,
  agent,
  agentIn,
  apply,
  checkSession,
  checkState,
  getSessionState,
  getSessionStates,
  kinds,
  newState,
  normalize,
  checkEvent,
  fuzzTools,
  pick,
  play,
  randomEnvelope,
  rng,
  script,
  sessionId,
  tick,
  view,
  withoutFeed,
} from './state-helpers.js';

const SID = sessionId(1);

/** Todas as ordens de uma lista pequena. */
function permutationsOf(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((item, i) => permutationsOf([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
}

/** Estado final sem feed, com o status recalculado num mesmo instante. */
function settled(list, at = 60_000) {
  const { state } = play(list);
  tick(state, T0 + at);
  return getSessionStates(state, { feed: false }).map(withoutFeed);
}

// ---------------------------------------------------------------------------

describe('fatos fora de ordem e duplicados', () => {
  const T = agent(201, 'tester');

  function turn() {
    const s = script();
    s.sessionStart(0);
    s.prompt(100, 'Teste');
    const c = s.delegation('tester', 'Testar');
    s.pre(200, c);
    s.start(230, T);
    s.tool(1000, 'Read', { file_path: `${PROJECT}\\a.md` }, T);
    const b = s.call('Bash', { command: 'npm test' }, T);
    s.pre(2000, b);
    s.fail(2100, b, 'Exit code 1');
    s.stopAgent(3000, T);
    s.returned(3020, c, T);
    s.tool(3100, 'Read', { file_path: `${PROJECT}\\b.md` });
    s.stop(4000);
    return s.events;
  }

  it('cada fato repetido logo em seguida (menos o SessionStart) não gera evento nem muda o estado final', () => {
    const list = turn();
    const doubled = list.flatMap((item) => (item.payload.hook_event_name === 'SessionStart' ? [item] : [item, { ...item }]));
    const result = play(doubled);
    for (let i = 0; i < result.steps.length; i++) {
      const step = result.steps[i];
      if (i > 0 && step.item.payload === result.steps[i - 1].item.payload) assert.deepEqual(step.events, [], `duplicado de ${step.item.payload.hook_event_name}`);
    }
    assert.deepEqual(settled(doubled), settled(list));
  });

  it('duplicados tardios (minutos depois, fora da janela de 5 s da deduplicação) não reabrem nada', () => {
    const list = turn();
    const late = list.filter((item) => ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SubagentStop', 'SubagentStart', 'Stop'].includes(item.payload.hook_event_name))
      .map((item) => ({ ...item, at: item.at + 10 * MIN }));
    const result = play([...list, ...late]);
    assert.deepEqual(result.steps.slice(list.length).flatMap((step) => step.events), []);
    const session = view(result.state);
    assert.equal(agentIn(session, T.id).status, 'idle');
    assert.equal(agentIn(session, 'main').status, 'idle');
    assert.deepEqual(agentIn(session, T.id).health, { ok: 1, total: 2 });
  });

  it('Stop chega antes do SubagentStop (corrida): agent.finished(unknown) e nada depois', () => {
    const s = script();
    s.prompt(0);
    const c = s.delegation('tester', 'Testar');
    s.pre(100, c);
    s.start(130, T);
    s.returned(3020, c, T);
    s.stop(3030);
    s.stopAgent(3000, T);
    const result = play(s.events);
    assert.deepEqual(result.events.filter((e) => e.kind === 'agent.finished').map((e) => e.data.outcome), ['unknown']);
    assert.deepEqual(result.steps.at(-1).events, []);
    assert.equal(agentIn(view(result.state), T.id).finished, true);
  });

  it('PostToolUse do Agent em segundo plano antes do Pre e do SubagentStart: uma delegação, elo certo', () => {
    const BG = agent(202, 'tester');
    const s = script();
    s.prompt(0);
    const c = s.delegation('tester', 'Em segundo plano', { background: true });
    s.launched(120, c, BG);
    s.start(110, BG);
    s.pre(100, c);
    const result = play(s.events);
    assert.equal(result.events.filter((e) => e.kind === 'agent.delegated').length, 1);
    const bg = agentIn(view(result.state), BG.id);
    assert.equal(bg.label, 'Em segundo plano');
    assert.equal(bg.parentKey, 'main');
    assert.equal(bg.background, true);
  });

  it('o resultado não depende de nada além dos fatos: a mesma entrada dá a mesma saída', () => {
    const list = turn();
    const a = play(list);
    const b = play(list);
    assert.deepEqual(JSON.stringify(a.events), JSON.stringify(b.events));
    assert.deepEqual(JSON.stringify(getSessionStates(a.state, { feed: true })), JSON.stringify(getSessionStates(b.state, { feed: true })));
  });

  it('apply não altera o fato recebido', () => {
    const state = newState();
    for (const item of turn()) {
      const fact = normalize({ v: 1, sentAt: T0 + item.at, env: item.env, payload: item.payload }, { receivedAt: T0 + item.at, homeDir: HOME });
      const before = JSON.stringify(fact);
      apply(state, fact, T0 + item.at);
      assert.equal(JSON.stringify(fact), before);
    }
  });
});

describe('ids repetidos entre sessões', () => {
  const A = sessionId(211);
  const B = sessionId(212);
  const SAME = agent(211, 'tester');

  it('mesmo agent_id e mesmos tool_use_id em duas sessões: tudo separado', () => {
    const s = script({ session: A });
    s.prompt(0);
    const ca = s.delegation('tester', 'Testar na A');
    s.pre(100, ca);
    const readA = s.call('Read', { file_path: `${PROJECT}\\a.md` }, SAME);
    s.pre(200, readA);
    s.use({ session: B, projectDir: OTHER_PROJECT });
    s.prompt(210);
    s.pre(220, readA); // mesmo tool_use_id, mesmo agent_id, outra sessão
    s.post(230, readA);
    s.stopAgent(240, SAME);
    s.stop(250);
    s.use({ session: A, projectDir: PROJECT });
    s.post(260, readA);
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    const a = view(result.state, A);
    const b = view(result.state, B);
    assert.equal(result.events.filter((e) => e.kind === 'tool.started').length, 2, 'um tool.started por sessão');
    assert.equal(result.events.filter((e) => e.kind === 'tool.finished').length, 2);
    assert.equal(agentIn(a, SAME.id).status, 'working', 'o SubagentStop da B não encerra o agente da A');
    assert.equal(agentIn(a, SAME.id).label, 'Testar na A');
    assert.equal(agentIn(b, SAME.id).finished, true);
    assert.equal(agentIn(b, SAME.id).parentKey, null, 'o pedido da A não se liga na B');
    assert.equal(agentIn(a, 'main').status, 'working', 'o Stop da B não mexe na A');
    checkState(result.state);
  });

  it('a limpeza de uma sessão não mexe na outra com os mesmos ids', () => {
    const s = script({ session: A });
    s.tool(0, 'Read', { file_path: `${PROJECT}\\a.md` }, SAME);
    s.use({ session: B });
    s.tool(10, 'Read', { file_path: `${PROJECT}\\a.md` }, SAME);
    s.sessionEnd(20);
    const { state } = play(s.events);
    assert.deepEqual(tick(state, T0 + 20 + 30 * MIN).removed, [B]);
    assert.ok(getSessionState(state, A));
    assert.equal(agentIn(view(state, A), SAME.id).finished, true, 'parado há 30 min: inferência dos 15 min');
  });
});

describe('SubagentStop sem SubagentStart', () => {
  const T = agent(221, 'tester');

  it('agente desconhecido com tipo: agent.started e logo agent.finished(done), ligado ao pedido pendente', () => {
    const s = script();
    s.prompt(0);
    const c = s.delegation('tester', 'Testar rápido');
    s.pre(100, c);
    s.stopAgent(500, T);
    s.returned(520, c, T);
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.deepEqual(kinds(result.steps[2].events), [['agent.started', T.id], ['agent.finished', T.id]]);
    assert.equal(result.steps[2].events[0].data.label, 'Testar rápido');
    assert.equal(result.steps[2].events[1].data.outcome, 'done');
    const t = agentIn(view(result.state), T.id);
    assert.equal(t.finished, true);
    assert.equal(t.parentKey, 'main');
  });

  it('sem pedido pendente: rótulo = tipo; SubagentStart e ferramentas atrasados não o devolvem a trabalhar', () => {
    const s = script();
    s.stopAgent(0, T);
    s.start(10, T);
    s.tool(20, 'Read', { file_path: `${PROJECT}\\a.md` }, T);
    const result = play(s.events);
    assert.deepEqual(kinds(result.events), [['agent.started', T.id], ['agent.finished', T.id], ['tool.started', T.id], ['tool.finished', T.id]]);
    const t = agentIn(view(result.state), T.id);
    assert.equal(t.label, 'tester');
    assert.equal(t.status, 'idle');
    assert.equal(t.finished, true);
    assert.deepEqual(t.health, { ok: 1, total: 1 });
  });

  it('agent_type só com espaços (no fato, agentType: null) e agente desconhecido também não gera nada', () => {
    const s = script();
    s.sessionStart(0);
    s.stopAgent(10, { id: agent(222).id, type: '   ' });
    s.stopAgent(20, { id: agent(223).id, type: '\t' });
    const result = play(s.events);
    assert.equal(result.steps[1].fact.agentType, null);
    assert.deepEqual(result.steps.slice(1).flatMap((step) => step.events), []);
    assert.deepEqual(view(result.state).agents.map((a) => a.key), ['main']);
  });
});

describe('delegações em paralelo', () => {
  it('tipos diferentes: em qualquer ordem dos SubagentStart, a fila por tipo acerta antes do Post', () => {
    const workers = [agent(231, 'tester'), agent(232, 'documentador'), agent(233, 'dev-backend')];
    for (const order of permutationsOf(workers)) {
      const s = script();
      s.prompt(0);
      const calls = workers.map((w) => s.delegation(w.type, `Tarefa de ${w.type}`));
      calls.forEach((c, i) => s.pre(100 + i, c));
      order.forEach((w, i) => s.start(150 + i, w));
      const session = view(play(s.events).state);
      for (const w of workers) {
        assert.equal(agentIn(session, w.id).label, `Tarefa de ${w.type}`, order.map((x) => x.type).join(','));
        assert.equal(agentIn(session, w.id).parentKey, 'main');
      }
    }
  });

  it('três do mesmo tipo: em todas as 36 ordens de SubagentStart e Post, nunca duas instâncias com a mesma descrição, e no fim cada uma com a sua', () => {
    const workers = [agent(241, 'tester'), agent(242, 'tester'), agent(243, 'tester')];
    for (const starts of permutationsOf([0, 1, 2])) {
      for (const posts of permutationsOf([0, 1, 2])) {
        const s = script();
        s.prompt(0);
        const calls = workers.map((w, i) => s.delegation('tester', `Testar parte ${i}`));
        calls.forEach((c, i) => s.pre(100 + i, c));
        starts.forEach((i, k) => s.start(150 + k, workers[i]));
        posts.forEach((i, k) => {
          s.stopAgent(1000 + k * 10, workers[i]);
          s.returned(1005 + k * 10, calls[i], workers[i]);
        });
        const state = newState();
        for (let n = 1; n <= s.events.length; n++) {
          play(s.events.slice(n - 1, n), { state });
          const session = view(state);
          const labels = session.agents.slice(1).map((a) => a.label);
          assert.equal(new Set(labels).size, labels.length, `rótulos repetidos ${labels} (starts ${starts}, posts ${posts}, passo ${n})`);
        }
        const session = view(state);
        workers.forEach((w, i) => assert.equal(agentIn(session, w.id).label, `Testar parte ${i}`, `starts ${starts}, posts ${posts}`));
        checkSession(session, { feed: true });
      }
    }
  });

  it('SubagentStart chega antes do Pre do Agent: depois do Post, elo certo', () => {
    const W = agent(251, 'tester');
    const s = script();
    s.prompt(0);
    s.start(90, W);
    const c = s.delegation('tester', 'Testar');
    s.pre(100, c);
    s.tool(1000, 'Read', { file_path: `${PROJECT}\\a.md` }, W);
    s.stopAgent(2000, W);
    s.returned(2010, c, W);
    const t = agentIn(view(play(s.events).state), W.id);
    assert.equal(t.label, 'Testar');
    assert.equal(t.parentKey, 'main');
  });

  it('SubagentStart chega antes do Pre do Agent: a instância recebe a descrição quando o Pre chega, sem esperar o retorno (seção 5, passo 2a)', () => {
    const W = agent(252, 'tester');
    const s = script();
    s.prompt(0);
    s.start(90, W); // corrida de dezenas de ms entre dois processos de hook
    const c = s.delegation('tester', 'Testar');
    s.pre(100, c);
    s.tool(1000, 'Read', { file_path: `${PROJECT}\\a.md` }, W); // trabalhando, antes do retorno
    const t = agentIn(view(play(s.events).state), W.id);
    assert.equal(t.label, 'Testar');
    assert.equal(t.parentKey, 'main');
  });
});

describe('aninhamento profundo', () => {
  const TYPES = ['arquiteto', 'dev-backend', 'tester', 'documentador', 'Explore', 'Plan', 'general-purpose'];

  function chain(depth, { background = false } = {}) {
    const s = script();
    s.prompt(0);
    const agents = [];
    let parent = null;
    for (let i = 0; i < depth; i++) {
      const w = agent(300 + i, TYPES[i % TYPES.length]);
      const c = s.delegation(w.type, `Nível ${i + 1}`, { who: parent, background: background && i === 0 });
      s.pre(100 + i * 100, c);
      s.start(130 + i * 100, w);
      if (background && i === 0) s.launched(140, c, w);
      agents.push(w);
      parent = w;
    }
    return { s, agents };
  }

  it('cadeia de 7 níveis: cada parentKey aponta para quem delegou; Stop libera todos os de primeiro plano', () => {
    const { s, agents } = chain(7);
    s.stop(5000);
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    const session = view(result.state);
    agents.forEach((w, i) => assert.equal(agentIn(session, w.id).parentKey, i === 0 ? 'main' : agents[i - 1].id, `nível ${i + 1}`));
    assert.equal(result.steps.at(-1).events.length, 7);
    assert.ok(result.steps.at(-1).events.every((e) => e.kind === 'agent.finished' && e.data.outcome === 'unknown'));
    assert.deepEqual(session.roster, ['orq', 'arq', 'dev', 'tes', 'doc', 'aux']);
    checkState(result.state);
  });

  it('cadeia de 12 níveis com o primeiro em segundo plano: no Stop, todos os descendentes seguem', () => {
    const { s } = chain(12, { background: true });
    s.stop(5000);
    const result = play(s.events);
    assert.deepEqual(result.steps.at(-1).events, []);
    assert.ok(view(result.state).agents.slice(1).every((a) => a.status === 'working'));
  });

  it('cadeia de 20 níveis com o primeiro em segundo plano: não trava nem lança (diagnóstico do limite de profundidade)', (t) => {
    const { s } = chain(20, { background: true });
    s.stop(5000);
    const result = play(s.events);
    const released = result.steps.at(-1).events.length;
    t.diagnostic(`descendentes liberados no Stop apesar do ancestral em segundo plano: ${released} de 19`);
    checkState(result.state);
  });

  it('uma instância nunca fica ligada à delegação que ela mesma fez (parentKey igual à própria chave)', () => {
    const X = agent(320, 'tester');
    const Y = agent(321, 'tester');
    const s = script();
    s.prompt(0);
    const own = s.delegation('tester', 'Subteste', { who: X });
    s.pre(100, own); // primeiro evento de X: o Pre do próprio Agent, antes do SubagentStart dele
    const fromMain = s.delegation('tester', 'Testar');
    s.pre(110, fromMain);
    s.start(120, X);
    s.start(130, Y);
    const session = view(play(s.events).state);
    assert.notEqual(agentIn(session, X.id).parentKey, X.id);
    assert.equal(agentIn(session, X.id).label, 'Testar');
    assert.equal(agentIn(session, Y.id).parentKey, X.id);
  });
});

describe('sessão com milhares de agentes (limite e lápides, seção 7)', () => {
  it('3 000 subagentes encerrados: ficam os 50 mais recentes, o estado não cresce, e o apply segue rápido', (t) => {
    const N = 3000;
    const s = script();
    s.prompt(0);
    const workers = [];
    for (let i = 0; i < N; i++) {
      const w = agent(10_000 + i, i % 2 ? 'tester' : 'Explore');
      workers.push(w);
      s.start(100 + i * 10, w);
      s.tool(101 + i * 10, 'Read', { file_path: `${PROJECT}\\f${i}.md` }, w, 2);
      s.stopAgent(105 + i * 10, w);
    }
    const state = newState();
    const tracker = new Tracker();
    const begin = performance.now();
    play(s.events, { state, tracker });
    const total = performance.now() - begin;
    const more = script();
    for (let i = 0; i < 500; i++) more.tool(N * 10 + 1000 + i * 10, 'Read', { file_path: `${PROJECT}\\g${i}.md` });
    const facts = more.events.map((item) => ({ fact: normalize({ v: 1, sentAt: T0 + item.at, env: item.env, payload: item.payload }, { receivedAt: T0 + item.at, homeDir: HOME }), now: T0 + item.at }));
    const begin2 = performance.now();
    for (const { fact, now } of facts) apply(state, fact, now);
    const thousand = performance.now() - begin2;
    const session = view(state);
    const bytes = Buffer.byteLength(JSON.stringify(withoutFeed(session)));
    t.diagnostic(`${N} agentes: ${s.events.length} fatos em ${total.toFixed(0)} ms; +1 000 fatos em ${thousand.toFixed(1)} ms; SessionState sem feed = ${(bytes / 1024).toFixed(1)} KiB`);
    assert.equal(session.agents.length, 51, 'main e os 50 encerrados mais recentes');
    assert.deepEqual(session.agents.slice(1).map((a) => a.key).sort(), workers.slice(-50).map((w) => w.id).sort());
    assert.ok(bytes < 64 * 1024, `${bytes} bytes`);
    checkSession(session, { feed: true });
    assert.ok(thousand < 500, `1 000 fatos: ${thousand.toFixed(1)} ms`);
  });

  it('mistura de ativos e encerrados: até 100 não encerrados (os de evento mais recente) e 50 encerrados; o main nunca sai', () => {
    const s = script();
    s.prompt(0);
    const active = Array.from({ length: 130 }, (_, i) => agent(20_000 + i, 'tester'));
    const done = Array.from({ length: 80 }, (_, i) => agent(21_000 + i, 'Explore'));
    let at = 100;
    for (const w of done) {
      s.start(at++, w);
      s.stopAgent(at++, w);
    }
    for (const w of active) s.start(at++, w);
    const state = newState();
    const result = play(s.events, { state, tracker: new Tracker() });
    const session = view(state);
    const keys = new Set(session.agents.map((a) => a.key));
    assert.ok(keys.has('main'));
    assert.equal(session.agents.filter((a) => !a.finished && a.key !== 'main').length, 100);
    assert.equal(session.agents.filter((a) => a.finished).length, 50);
    for (const w of active.slice(-100)) assert.ok(keys.has(w.id), 'os 100 ativos mais recentes ficam');
    for (const w of done.slice(-50)) assert.ok(keys.has(w.id), 'os 50 encerrados mais recentes ficam');
    assert.ok(!result.events.some((e) => e.kind === 'agent.finished' && active.slice(0, 30).some((w) => w.id === e.agentKey)), 'tirar pelo limite não emite agent.finished');
    checkSession(session, { feed: true });
  });

  it('lápides: evento atrasado de um agente que saiu pelo limite é ignorado (sem agent.started de novo, sem voltar a trabalhar)', () => {
    const s = script();
    s.prompt(0);
    const done = Array.from({ length: 60 }, (_, i) => agent(22_000 + i, 'Explore'));
    let at = 100;
    for (const w of done) {
      s.start(at++, w);
      s.stopAgent(at++, w);
    }
    const state = newState();
    const tracker = new Tracker();
    play(s.events, { state, tracker });
    const gone = done[0];
    assert.ok(!view(state).agents.some((a) => a.key === gone.id), 'o mais antigo saiu');
    const late = script();
    late.tool(5000, 'Read', { file_path: `${PROJECT}\\atrasado.md` }, gone);
    late.start(5100, gone);
    late.stopAgent(5200, gone);
    const result = play(late.events, { state, tracker });
    assert.deepEqual(result.events, []);
    assert.ok(result.steps.every((step) => step.changed.length === 0));
    assert.ok(!view(state).agents.some((a) => a.key === gone.id));
  });

  it('lápides esquecem depois de 1 000 ids: um evento muito atrasado do primeiro removido recria o agente (diagnóstico)', (t) => {
    const s = script();
    s.prompt(0);
    const done = Array.from({ length: 1100 }, (_, i) => agent(30_000 + i, 'Explore'));
    let at = 100;
    for (const w of done) {
      s.start(at++, w);
      s.stopAgent(at++, w);
    }
    const state = newState();
    play(s.events, { state });
    const late = script();
    late.tool(at + 1000, 'Read', { file_path: `${PROJECT}\\muito-atrasado.md` }, done[0]);
    const result = play(late.events, { state });
    t.diagnostic(`evento do 1º removido, depois de ${done.length - 50} remoções: ${result.events.map((e) => e.kind).join(', ') || 'ignorado'}`);
    checkSession(view(state), { feed: true });
  });
});

describe('A4: SubagentStart antes do Pre do Agent (seção 5, passo 2a)', () => {
  it('várias instâncias candidatas: cada Pre liga a mais antiga elegível, e o Post corrige o elo trocado', () => {
    const W1 = agent(40_001, 'tester');
    const W2 = agent(40_002, 'tester');
    const s = script();
    s.prompt(0);
    s.start(1000, W2); // chegam antes dos dois Pre, em ordem trocada
    s.start(1010, W1);
    const c1 = s.delegation('tester', 'Testar a ingestão');
    const c2 = s.delegation('tester', 'Testar o painel');
    s.pre(1050, c1);
    s.pre(1060, c2);
    const provisional = view(play(s.events).state);
    assert.equal(agentIn(provisional, W2.id).label, 'Testar a ingestão', 'a mais antiga (W2) fica com o primeiro Pre');
    assert.equal(agentIn(provisional, W1.id).label, 'Testar o painel');
    s.stopAgent(5000, W1);
    s.returned(5010, c1, W1);
    s.stopAgent(5100, W2);
    s.returned(5110, c2, W2);
    const final = view(play(s.events).state);
    assert.equal(agentIn(final, W1.id).label, 'Testar a ingestão');
    assert.equal(agentIn(final, W2.id).label, 'Testar o painel');
    for (const w of [W1, W2]) assert.equal(agentIn(final, w.id).parentKey, 'main');
  });

  it('relógio fora de ordem: o Pre com ts anterior ao da instância chega depois e ainda liga; o A4 vem no update do agent.delegated', () => {
    const W = agent(40_010, 'tester');
    const s = script();
    s.prompt(0);
    const c = s.delegation('tester', 'Testar');
    s.start(1100, W);
    s.pre(1000, c); // sentAt antes do SubagentStart, chegada depois
    const result = play(s.events);
    assert.deepEqual(kinds(result.steps.at(-1).events), [['agent.delegated', 'main']]);
    const w = agentIn(view(result.state), W.id);
    assert.equal(w.label, 'Testar');
    assert.equal(w.parentKey, 'main');
  });

  it('fica de fora: instância criada mais de 2 s antes, encerrada, já ligada, de outro tipo ou de quem delegou (e ancestrais)', () => {
    const OLD = agent(40_020, 'tester');
    const DONE = agent(40_021, 'tester');
    const OTHER = agent(40_022, 'documentador');
    const s = script();
    s.prompt(0);
    s.start(1000, OLD);
    s.start(3500, DONE);
    s.stopAgent(3600, DONE);
    s.start(3700, OTHER);
    const c = s.delegation('tester', 'Testar');
    s.pre(4000, c); // OLD nasceu 3 s antes
    const session = view(play(s.events).state);
    for (const key of [OLD.id, DONE.id, OTHER.id]) assert.equal(agentIn(session, key).parentKey, null, key);
    // Quem delegou e o pai dele nunca são escolhidos, mesmo do mesmo tipo e recém-criados.
    const PARENT = agent(40_030, 'tester');
    const CHILD = agent(40_031, 'tester');
    const t2 = script();
    t2.prompt(0);
    const top = t2.delegation('tester', 'Topo');
    t2.pre(100, top);
    t2.start(130, PARENT);
    const mid = t2.delegation('tester', 'Meio', { who: PARENT });
    t2.pre(200, mid);
    t2.start(230, CHILD);
    const own = t2.delegation('tester', 'Do filho', { who: CHILD });
    t2.pre(300, own);
    const nested = view(play(t2.events).state);
    assert.equal(agentIn(nested, PARENT.id).parentKey, 'main');
    assert.equal(agentIn(nested, CHILD.id).parentKey, PARENT.id);
    assert.equal(agentIn(nested, CHILD.id).label, 'Meio');
  });
});

describe('formas de borda do caminho do projeto (seção 7)', () => {
  const table = [
    ['/c/Users/beltrana/Codigo/agents-quest', 'c:/Users/beltrana/Codigo/agents-quest', 'agents-quest'],
    ['C:\\', 'c:/', 'C:'],
    ['C:/', 'c:/', 'C:'],
    ['c:', 'c:/', 'C:'],
    ['D:', 'd:/', 'D:'],
    ['/c', 'c:/', 'C:'],
    ['/d/', 'd:/', 'D:'],
  ];
  for (const [dir, key, name] of table) {
    it(`${JSON.stringify(dir)} → key ${key}, name ${name}`, () => {
      const s = script({ projectDir: dir });
      s.tool(0, 'Read', { file_path: 'CLAUDE.md' });
      const session = view(play(s.events, { state: newState({ homeDir: HOME }) }).state);
      assert.equal(session.project.key, key);
      assert.equal(session.project.name, name);
      checkSession(session, { feed: true });
    });
  }

  it('MSYS e Windows do mesmo projeto: uma key só, e newProjects o reporta uma vez', () => {
    const state = newState({ homeDir: HOME });
    const s = script({ projectDir: '/c/Users/beltrana/Codigo/agents-quest' });
    s.tool(0, 'Read', { file_path: 'CLAUDE.md' });
    s.use({ session: sessionId(2), projectDir: 'C:\\Users\\beltrana\\Codigo\\agents-quest\\' });
    s.tool(10, 'Read', { file_path: 'CLAUDE.md' });
    const result = play(s.events, { state });
    assert.deepEqual(result.steps.flatMap((step) => step.newProjects), ['c:/Users/beltrana/Codigo/agents-quest']);
    assert.deepEqual(new Set(getSessionStates(state).map((x) => x.project.key)), new Set(['c:/Users/beltrana/Codigo/agents-quest']));
  });
});

describe('tick com o relógio voltando para trás', () => {
  it('não lança, não remove, não emite; o relógio voltando ao normal retoma a limpeza', () => {
    const T = agent(401, 'tester');
    const s = script();
    s.prompt(0);
    s.start(100, T);
    s.sessionEnd(200);
    const { state } = play(s.events);
    for (const now of [T0 - 60 * MIN, T0 - 1, T0 + 100, Number.NaN, 0, -1]) {
      const result = tick(state, now);
      assert.deepEqual(result.removed, [], String(now));
      assert.deepEqual(result.events, [], String(now));
    }
    checkState(state);
    assert.deepEqual(tick(state, T0 + 200 + 30 * MIN).removed, [SID]);
  });

  it('apply com o relógio voltando entre fatos: não lança, e o estado só depende dos ts', () => {
    const T = agent(402, 'tester');
    const s = script();
    s.prompt(0);
    s.start(100, T);
    s.tool(200, 'Read', { file_path: `${PROJECT}\\a.md` }, T);
    const state = newState();
    const clocks = [T0 + 10 * MIN, T0 - 5 * MIN, T0 + 1, T0 - 60 * MIN];
    s.events.forEach((item, i) => {
      const fact = normalize({ v: 1, sentAt: T0 + item.at, env: item.env, payload: item.payload }, { receivedAt: clocks[i], homeDir: HOME });
      apply(state, fact, clocks[i]);
    });
    const session = view(state);
    checkSession(session, { feed: true });
    // Seção 1 (T6): sentAt a mais de 5 min da chegada vira a hora de chegada. Aqui só o
    // terceiro fato (chegada T0 + 1) fica com o sentAt; os outros ficam com a chegada
    // (T0 + 10 min, T0 − 5 min e T0 − 60 min), e o estado segue só os ts.
    assert.equal(session.lastEventAt, T0 + 10 * MIN);
    assert.equal(agentIn(session, T.id).startedAt, T0 - 60 * MIN);
  });

  it('fato com sentAt no futuro: diagnóstico da limpeza (horas pelo ts, ponto 12)', (t) => {
    const s = script();
    s.prompt(0);
    const future = { ...s.events[0] };
    const fact = normalize({ v: 1, sentAt: T0 + 24 * 60 * MIN, env: future.env, payload: future.payload }, { receivedAt: T0, homeDir: HOME });
    const state = newState();
    apply(state, fact, T0);
    const removedAfter7h = tick(state, T0 + 7 * 60 * MIN).removed.length;
    t.diagnostic(`sessão com sentAt 24 h no futuro removida 7 h depois? ${removedAfter7h === 1 ? 'sim' : 'não'}; lastEventAt = T0 + ${(view(state)?.lastEventAt - T0) / MIN} min`);
    checkState(state);
  });
});

describe('eventos depois do SessionEnd', () => {
  it('ferramentas atrasadas entram no feed, a sessão continua ended, sem novo session.started nem session.ended', () => {
    const s = script();
    s.sessionStart(0);
    s.prompt(100);
    s.sessionEnd(200, 'clear');
    s.tool(210, 'Read', { file_path: `${PROJECT}\\a.md` });
    s.sessionEnd(220, 'other');
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    const session = view(result.state);
    assert.equal(session.status, 'ended');
    assert.equal(result.events.filter((e) => e.kind === 'session.ended').length, 1);
    assert.equal(result.events.filter((e) => e.kind === 'session.started').length, 1);
    assert.equal(session.feed.at(-1).kind, 'tool.started');
    checkState(result.state);
  });

  it('SessionStart com o mesmo id (retomada) reabre a sessão e emite session.started', () => {
    const s = script();
    s.sessionStart(0);
    s.sessionEnd(100);
    s.sessionStart(200, 'resume');
    s.prompt(300);
    const result = play(s.events);
    assert.deepEqual(result.events.map((e) => e.kind), ['session.started', 'session.ended', 'session.started']);
    assert.equal(view(result.state).status, 'active');
    assert.equal(agentIn(view(result.state), 'main').status, 'working');
  });

  it('a limpeza conta 30 min do SessionEnd, mesmo com eventos atrasados depois dele', () => {
    const s = script();
    s.sessionEnd(0);
    s.tool(10 * MIN, 'Read', { file_path: `${PROJECT}\\a.md` });
    const { state } = play(s.events);
    assert.deepEqual(tick(state, T0 + 30 * MIN).removed, [SID]);
  });
});

describe('agent_type com cara de segredo ou com ANSI', () => {
  const ESC = '\x1b';
  const cases = [
    ['token do GitHub', `ghp_${'A'.repeat(36)}`, 'aux', 'AAAAAAAAAAAA'],
    ['token colorido', `${ESC}[ghp_${'C'.repeat(36)}`, 'aux', 'CCCCCCCCCCCC'],
    ['par nome-valor', 'password=hunter2', 'aux', 'hunter2'],
    ['URL com senha', 'https://u:segredo@h/', 'aux', 'segredo'],
    ['chave da AWS', `AKIA${'D'.repeat(16)}`, 'aux', 'DDDDDDDDDDDD'],
    ['tester colorido', `${ESC}[31mtester${ESC}[0m`, 'tes', null],
    ['tester com largura zero', 'tes\u200Bter', 'tes', null],
    ['tester com sequência OSC', `${ESC}]0;titulo\x07tester`, 'tes', 'titulo'],
    ['nome enorme', 'x'.repeat(300), 'aux', 'x'.repeat(81)],
  ];

  for (const [name, type, role, secret] of cases) {
    it(`${name}: papel pelo cru, elo pelo cru, nada cru no estado nem nos eventos`, () => {
      const W = agent(500 + cases.findIndex((c) => c[0] === name), type);
      const s = script();
      s.prompt(0);
      const c = s.delegation(type, 'Tarefa com tipo estranho');
      s.pre(100, c);
      s.start(130, W);
      s.tool(200, 'Read', { file_path: `${PROJECT}\\a.md` }, W);
      s.stopAgent(300, W);
      s.returned(310, c, W);
      const tracker = new Tracker();
      const result = play(s.events, { tracker });
      const session = view(result.state);
      const w = agentIn(session, W.id);
      assert.equal(w.role, role);
      assert.equal(w.label, 'Tarefa com tipo estranho', 'elo pelo tipo cru');
      assert.equal(result.events.find((e) => e.kind === 'agent.delegated').data.toRole, role);
      checkSession(session, { feed: true });
      const all = JSON.stringify({ session, events: result.events });
      assert.ok(!all.includes(ESC), 'ESC no estado');
      if (secret) assert.ok(!all.includes(secret), `${secret.slice(0, 12)} no estado`);
    });
  }
});

describe('caminhos do Windows variados', () => {
  const KEY = 'c:/Users/beltrana/Codigo/agents-quest';
  const table = [
    ['C:\\Users\\beltrana\\Codigo\\agents-quest', KEY, 'agents-quest'],
    ['c:\\Users\\beltrana\\Codigo\\agents-quest\\', KEY, 'agents-quest'],
    ['C:/Users/beltrana/Codigo/agents-quest/', KEY, 'agents-quest'],
    ['C:\\Users\\beltrana/Codigo\\agents-quest\\\\', KEY, 'agents-quest'],
    ['\\\\?\\C:\\Users\\beltrana\\Codigo\\agents-quest', KEY, 'agents-quest'],
    ['\\\\.\\C:\\Users\\beltrana\\Codigo\\agents-quest', KEY, 'agents-quest'],
    ['C:\\Users\\beltrana\\Codigo\\outro\\..\\agents-quest', KEY, 'agents-quest'],
    ['\\\\servidor\\projetos\\agents-quest', '//servidor/projetos/agents-quest', 'agents-quest'],
    ['\\\\?\\UNC\\servidor\\projetos\\agents-quest\\', '//servidor/projetos/agents-quest', 'agents-quest'],
    ['//servidor/projetos/agents-quest/', '//servidor/projetos/agents-quest', 'agents-quest'],
    ['D:\\Projetos Pessoais\\Café com Açúcar', 'd:/Projetos Pessoais/Café com Açúcar', 'Café com Açúcar'],
    ['/home/beltrana/agents-quest/', '/home/beltrana/agents-quest', 'agents-quest'],
  ];

  for (const [dir, key, name] of table) {
    it(`${JSON.stringify(dir)} → key ${key}, name ${name}`, () => {
      const s = script({ projectDir: dir });
      s.tool(0, 'Read', { file_path: 'CLAUDE.md' });
      const session = view(play(s.events).state);
      assert.deepEqual(session.project, { key, name, dir });
      checkSession(session, { feed: true });
    });
  }

  it('o mesmo projeto em formas diferentes dá a mesma key em sessões diferentes', () => {
    const s = script();
    table.slice(0, 7).forEach(([dir], i) => {
      s.use({ session: sessionId(600 + i), projectDir: dir });
      s.tool(i * 10, 'Read', { file_path: `${dir}\\CLAUDE.md` });
    });
    const result = play(s.events);
    assert.deepEqual(new Set(getSessionStates(result.state).map((session) => session.project.key)), new Set([KEY]));
    assert.ok(result.events.filter((e) => e.kind === 'tool.started').every((e) => e.data.target === 'CLAUDE.md'));
  });

  it('sem env.projectDir, o projeto vem do cwd; sem os dois, fica vazio até um evento trazer a pasta', () => {
    const s = script({ projectDir: null });
    s.hook(0, 'UserPromptSubmit', { prompt: 'x', cwd: undefined });
    s.events[0].payload.cwd = undefined;
    const { state } = play(s.events);
    assert.deepEqual(view(state).project, { key: '', name: '', dir: '' });
    const t = script();
    t.hook(10, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.md' }, tool_use_id: 'toolu_01cwd' });
    t.events[0].env.projectDir = null;
    t.events[0].payload.cwd = OTHER_PROJECT;
    play(t.events, { state });
    assert.deepEqual(view(state).project, { key: 'e:/Clientes/Padaria-Exemplo', name: 'Padaria-Exemplo', dir: OTHER_PROJECT });
  });

  it('formas de borda não lançam (diagnóstico): raiz da unidade, só a letra, estilo MSYS', (t) => {
    for (const dir of ['C:\\', 'D:', '/c/Users/beltrana/Codigo/agents-quest', '.', 'relativo\\pasta']) {
      const s = script({ projectDir: dir });
      s.tool(0, 'Read', { file_path: 'CLAUDE.md' });
      const session = view(play(s.events).state);
      checkSession(session, { feed: true });
      t.diagnostic(`${JSON.stringify(dir)} → ${JSON.stringify({ key: session.project.key, name: session.project.name })}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariantes com JSON aleatório passando pelo normalizador real
// ---------------------------------------------------------------------------

describe('invariantes: fatos gerados a partir de JSON aleatório passando pelo normalize', () => {
  const SEEDS = [1, 7, 42, 2026, 31337, 99991, 123456, 777777];
  const STEPS = 600;

  /**
   * Roda o fuzz de uma semente. `coherent`: o mesmo `tool_name` em toda a
   * chamada (como no Claude Code), com todas as invariantes do fluxo
   * (Tracker). Sem isso, só a forma de cada evento e do estado.
   */
  function fuzz(seed, { coherent }) {
    const random = rng(seed);
    const toolFor = coherent ? fuzzTools(random) : null;
    const state = newState({ agentNames: ['tester', 'arquiteto', 'revisor'], roleOverrides: { revisor: 'doc' } });
    const tracker = coherent ? new Tracker() : null;
    const emitted = [];
    const consume = (events, fact) => {
      if (tracker) tracker.consume(events, fact);
      else for (const event of events) checkEvent(event);
      emitted.push(...events);
    };
    let facts = 0;
    let now = T0;
    for (let i = 0; i < STEPS; i++) {
      try {
        if (random() < 0.05) {
          now += pick(random, [-3 * MIN, 0, 1000, 2 * MIN, 15 * MIN, 31 * MIN, 6 * 60 * MIN]);
          const result = tick(state, now);
          consume(result.events);
          tracker?.removed(result.removed);
          continue;
        }
        const envelope = randomEnvelope(random, now, { toolFor });
        const fact = normalize(envelope, { receivedAt: now, homeDir: HOME });
        now += Math.floor(random() * 400) - 60;
        if (!fact) continue;
        facts++;
        const result = apply(state, fact, now);
        assert.ok(Array.isArray(result.events) && Array.isArray(result.changed));
        consume(result.events, fact);
        if (i % 20 === 0) checkState(state);
      } catch (err) {
        err.message = `semente ${seed}, passo ${i}: ${err.message}`;
        throw err;
      }
    }
    checkState(state);
    const all = JSON.stringify({ sessions: getSessionStates(state, { feed: true }), events: emitted });
    for (const word of FORBIDDEN) assert.ok(!all.includes(word), `semente ${seed}: ${JSON.stringify(word.slice(0, 12))} chegou ao estado ou aos eventos`);
    return { facts, events: emitted.length };
  }

  it(`${SEEDS.length} sementes × ${STEPS} passos, com tick e relógio indo e voltando: nunca lança, e estado e fluxo de eventos seguem o contrato`, (t) => {
    let facts = 0;
    let events = 0;
    for (const seed of SEEDS) {
      const result = fuzz(seed, { coherent: true });
      facts += result.facts;
      events += result.events;
    }
    t.diagnostic(`${facts} fatos válidos, ${events} eventos canônicos conferidos`);
    assert.ok(facts > SEEDS.length * STEPS * 0.5, 'a maioria dos envelopes precisa virar fato');
  });

  it('com tool_name sorteado a cada evento (Pre, Post e Failure incoerentes): nunca lança, e a forma segue o contrato', () => {
    for (const seed of SEEDS) fuzz(seed, { coherent: false });
  });

  it('uma chamada aberta como delegação nunca recebe tool.failed (nem tool.finished) sem tool.started', () => {
    const s = script();
    s.prompt(0);
    const call = s.delegation('tester', 'Testar');
    s.pre(100, call);
    s.fail(200, { ...call, tool: 'Skill', input: { skill: 'revisar' } }, 'Falhou');
    const result = play(s.events);
    assert.deepEqual(result.steps.at(-1).events, []);
    assert.equal(agentIn(view(result.state), 'main').activity.state, 'failed');
  });

  it('reducer com fatos válidos montados à mão em formas extremas não lança', () => {
    const base = normalize({ v: 1, sentAt: T0, env: { projectDir: PROJECT }, payload: { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 'toolu_01a' } }, { receivedAt: T0, homeDir: HOME });
    const state = newState();
    const variants = [
      { ...base, toolUseId: null },
      { ...base, kind: 'tool.post', durationMs: null, linkedAgentId: 'a0', launch: 'async_launched', testResult: null },
      { ...base, kind: 'tool.fail', error: null, interrupted: true, durationMs: null, testResult: null },
      { ...base, tool: null, category: null, target: null, detail: null, subagentType: null, subagentTypeKey: null, description: null },
      { ...base, kind: 'turn.stop', backgroundTasks: [{ id: null, type: null, status: null, agentType: null, agentTypeKey: null }] },
      { ...base, kind: 'subagent.start', agentId: 'a1', agentType: null, agentTypeKey: 'tester' },
      { ...base, kind: 'subagent.stop', agentId: 'a1', agentTranscriptPath: null },
      { ...base, ts: 1 },
      { ...base, ts: Number.MAX_SAFE_INTEGER },
      { ...base, projectDir: null },
    ];
    const tracker = new Tracker();
    for (const fact of variants) {
      const result = apply(state, fact, T0);
      tracker.consume(result.events, fact);
    }
    checkState(state);
  });
});

