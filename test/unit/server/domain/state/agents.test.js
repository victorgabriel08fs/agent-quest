// Agentes no reducer de estado (T7): papel pelo valor cru, saúde, atividade,
// fim de turno com primeiro e segundo plano e a regra dos 15 min.
// Os cenários são SINTÉTICOS (formato do ADR 0010). Os testes de fim de turno
// e de atividade `delegate` em segundo plano dependem do V5 e do V13 [T0].

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../../../../server/domain/normalize.js';
import { apply, getSessionStates, tick } from '../../../../../server/domain/state/index.js';
import { HEALTH_WINDOW, STALE_AGENT_MS } from '../../../../../server/domain/state/agents.js';
import {
  HOME,
  PROJECT,
  START,
  agent,
  agentOf,
  assertEvents,
  assertNoRawKeys,
  assertRunShape,
  newState,
  run,
  scenario,
  sessionId,
  view,
} from './scenarios.js';

const SID = sessionId('principal');
const TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`;

describe('papel e comparações usam o valor cru, nunca o exibido', () => {
  const AUTH = agent('auth-1', 'auth:tester');
  const PLUGIN = agent('plugin-1', 'plugin:tester');
  const SECRET = agent('segredo-1', TOKEN);
  const REVIEWER = agent('revisor-1', 'revisor');
  let authCall;
  const scn = scenario('valor-cru', 'tipos que a redação muda', (b) => {
    b.sessionStart();
    b.prompt('Delegue');
    authCall = b.delegation('auth:tester', 'Testar a autenticação');
    b.pre(authCall);
    b.start(AUTH);
    b.start(PLUGIN);
    const secret = b.delegation(TOKEN, 'Tipo com cara de token');
    b.pre(secret);
    b.start(SECRET);
    const reviewer = b.delegation('revisor', 'Revisar');
    b.pre(reviewer);
    b.start(REVIEWER);
  });

  it('resolveRole(agentTypeKey) dá o papel; o estado e o evento levam o valor exibido', () => {
    const state = newState({ roleOverrides: { revisor: 'tes' } });
    const result = run(scn, { state });
    const session = view(result.state);
    const auth = agentOf(session, AUTH.id);
    assert.equal(auth.agentType, 'auth:•••');
    assert.equal(auth.role, 'tes');
    assert.equal(agentOf(session, PLUGIN.id).role, 'tes');
    assert.equal(agentOf(session, REVIEWER.id).role, 'tes');
    assert.equal(agentOf(session, SECRET.id).role, 'aux');
    const delegated = result.events.filter((event) => event.kind === 'agent.delegated');
    assert.deepEqual(delegated.map((event) => [event.data.toType, event.data.toRole]), [
      ['auth:•••', 'tes'],
      ['•••', 'aux'],
      ['revisor', 'tes'],
    ]);
  });

  it('o elo delegação → instância compara os tipos crus', () => {
    const session = view(run(scn).state);
    // `auth:tester` (cru) casa com `auth:tester`, embora os dois apareçam como `auth:•••`.
    assert.equal(agentOf(session, AUTH.id).label, 'Testar a autenticação');
    assert.equal(agentOf(session, AUTH.id).parentKey, 'main');
    // `plugin:tester` não casa com nenhum pedido: fica sem elo.
    assert.equal(agentOf(session, PLUGIN.id).label, 'plugin:tester');
    assert.equal(agentOf(session, PLUGIN.id).parentKey, null);
    assert.equal(agentOf(session, SECRET.id).label, 'Tipo com cara de token');
  });

  it('nenhum *Key nem valor cru aparece no SessionState ou nos eventos canônicos', () => {
    const result = run(scn);
    assertRunShape(result);
    const snapshot = getSessionStates(result.state);
    assertNoRawKeys(snapshot);
    assertNoRawKeys(result.events);
    const all = JSON.stringify({ snapshot, events: result.events });
    assert.ok(!all.includes('auth:tester'), 'auth:tester cru');
    assert.ok(!all.includes(TOKEN), 'token cru');
    assert.ok(!all.includes(TOKEN.slice(4)), 'corpo do token');
    assert.ok(!all.includes('PROMPT-DO-AGENTE'));
  });
});

describe('saúde: janela das últimas 10 ações', () => {
  it('tool.finished conta como sucesso e tool.failed como falha; delegações não contam', () => {
    const T = agent('saude', 'tester');
    const result = run(scenario('saude', '3 falhas e 9 sucessos', (b) => {
      b.prompt('Rode tudo');
      for (let i = 0; i < 3; i++) b.tool('Bash', { command: `node falha-${i}.js` }, { error: `Exit code ${i + 1}` });
      for (let i = 0; i < 9; i++) b.tool('Read', { file_path: `${PROJECT}\\a-${i}.md` });
      const call = b.delegation('tester', 'Testar');
      b.pre(call);
      b.start(T);
      b.returned(call, T);
    }));
    const session = view(result.state);
    assert.equal(HEALTH_WINDOW, 10);
    assert.deepEqual(agentOf(session, 'main').health, { ok: 9, total: 10 });
    assert.deepEqual(agentOf(session, T.id).health, { ok: 0, total: 0 });
  });
});

describe('[T0] V5: atividade por tipo (seção 9)', () => {
  const T = agent('atividade', 'tester');
  const BG = agent('atividade-bg', 'Explore');
  const calls = {};
  const scn = scenario('atividade', 'start, tool, delegate e segundo plano', (b) => {
    b.sessionStart();
    b.prompt('Delegue');
    calls.first = b.delegation('tester', 'Testar a ingestão');
    calls.second = b.delegation('Explore', 'Mapear em segundo plano', { background: true });
    b.pre(calls.first); // 2
    b.pre(calls.second); // 3
    b.start(T); // 4
    calls.bash = b.call('Bash', { command: 'npm test', description: 'Rodar a suíte' }, T);
    b.pre(calls.bash); // 5
    b.fail(calls.bash, 'Exit code 1'); // 6
    b.launched(calls.second, BG); // 7
    b.start(BG); // 8
    b.stopAgent(T); // 9
    b.returned(calls.first, T); // 10
  });
  const pick = ({ kind, category, tool, target, detail, state }) => ({ kind, category, tool, target, detail, state });

  it('start: agente criado antes de qualquer ferramenta', () => {
    const session = view(run(scn, { until: 5 }).state);
    assert.deepEqual(pick(agentOf(session, T.id).activity), { kind: 'start', category: null, tool: null, target: null, detail: null, state: 'running' });
  });

  it('tool: running no Pre, failed no Failure', () => {
    const running = view(run(scn, { until: 6 }).state);
    assert.deepEqual(pick(agentOf(running, T.id).activity), { kind: 'tool', category: 'bash', tool: 'Bash', target: 'npm test', detail: 'Rodar a suíte', state: 'running' });
    assert.equal(agentOf(view(run(scn, { until: 7 }).state), T.id).activity.state, 'failed');
  });

  it('delegate: a mais recente; em segundo plano, done logo no lançamento; em primeiro plano, no retorno', () => {
    const both = view(run(scn, { until: 4 }).state);
    assert.deepEqual(pick(agentOf(both, 'main').activity), { kind: 'delegate', category: null, tool: 'Agent', target: 'Explore', detail: 'Mapear em segundo plano', state: 'running' });
    const launched = view(run(scn, { until: 8 }).state);
    assert.equal(agentOf(launched, 'main').activity.state, 'done');
    assert.equal(agentOf(view(run(scn).state), BG.id).background, true);
  });

  it('o label do main é o agent_type da sessão iniciada com --agent, ou vazio', () => {
    const plain = view(run(scenario('sem-agent', 'sessão comum', (b) => b.sessionStart())).state);
    assert.equal(agentOf(plain, 'main').label, '');
    const withAgent = view(run(scenario('com-agent', 'sessão com --agent', (b) => {
      b.sessionStart('startup', { agent_type: 'revisor' });
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: { id: undefined, type: 'revisor' } });
    })).state);
    const main = agentOf(withAgent, 'main');
    assert.equal(main.label, 'revisor');
    assert.equal(main.agentType, 'revisor');
    assert.equal(main.role, 'orq');
    assert.deepEqual(withAgent.agents.map((item) => item.key), ['main']);
  });
});

describe('[T0] V5, V13: fim do turno da sessão principal (a parte de primeiro plano)', () => {
  const FG = agent('primeiro-plano', 'dev-backend');
  const BG = agent('segundo-plano', 'tester');
  const LISTED = agent('listado', 'documentador');
  const CHILD = agent('filho-do-bg', 'Explore');

  function turn(end) {
    return scenario('fim-de-turno', 'Stop com subagentes ainda trabalhando', (b) => {
      b.sessionStart();
      b.prompt('Trabalhem');
      const fg = b.delegation('dev-backend', 'Implementar');
      b.pre(fg);
      b.start(FG);
      const bg = b.delegation('tester', 'Testar em segundo plano', { background: true });
      b.pre(bg);
      b.start(BG);
      b.launched(bg, BG);
      const listed = b.delegation('documentador', 'Documentar');
      b.pre(listed);
      b.start(LISTED);
      const child = b.delegation('Explore', 'Mapear', { who: BG });
      b.pre(child);
      b.start(CHILD);
      end(b);
    });
  }

  it('UserPromptSubmit deixa o main working; Stop o deixa idle', () => {
    const beforePrompt = view(run(turn(() => {}), { until: 1 }).state);
    assert.equal(agentOf(beforePrompt, 'main').status, 'idle');
    const afterPrompt = view(run(turn(() => {}), { until: 2 }).state);
    assert.equal(agentOf(afterPrompt, 'main').status, 'working');
    const result = run(turn((b) => b.stop()));
    assert.equal(agentOf(view(result.state), 'main').status, 'idle');
  });

  it('Stop: primeiro plano recebe agent.finished(unknown); segundo plano, listado e filhos continuam', () => {
    const result = run(turn((b) => b.stop([{ id: LISTED.id, type: 'local_agent', status: 'running', agent_type: 'documentador' }])));
    assertEvents(result.steps.at(-1).events, [['agent.finished', FG.id, { outcome: 'unknown' }]]);
    const session = view(result.state);
    assert.equal(agentOf(session, FG.id).finished, true);
    assert.equal(agentOf(session, FG.id).status, 'idle');
    for (const id of [BG.id, LISTED.id, CHILD.id]) {
      assert.equal(agentOf(session, id).status, 'working', id);
      assert.equal(agentOf(session, id).finished, false, id);
    }
    assert.equal(agentOf(session, LISTED.id).background, true, 'listado no background_tasks passa a segundo plano (V13)');
    assertRunShape(result);
  });

  it('StopFailure faz o mesmo, sem background_tasks', () => {
    const result = run(turn((b) => b.stopFailure()));
    assertEvents(result.steps.at(-1).events, [
      ['agent.finished', FG.id, { outcome: 'unknown' }],
      ['agent.finished', LISTED.id, { outcome: 'unknown' }],
    ]);
    assert.equal(agentOf(view(result.state), 'main').status, 'idle');
    assert.equal(agentOf(view(result.state), BG.id).status, 'working');
  });

  it('subagente encerrado pelo Stop não volta a trabalhar com eventos atrasados', () => {
    const result = run(turn((b) => {
      b.stop();
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: FG });
      b.stopAgent(FG);
    }));
    const fg = agentOf(view(result.state), FG.id);
    assert.equal(fg.status, 'idle');
    assert.deepEqual(fg.health, { ok: 1, total: 1 });
    assert.deepEqual(result.steps.at(-1).events, [], 'SubagentStop de agente já encerrado não emite de novo');
  });
});

describe('tick: agente parado há 15 min', () => {
  const T = agent('parado', 'tester');
  const LONG = agent('comando-longo', 'dev-backend');
  const scn = scenario('parado', 'subagente sem eventos e outro com comando longo', (b) => {
    b.prompt('Trabalhem');
    b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: T });
    const long = b.call('Bash', { command: 'npm run build' }, LONG);
    b.pre(long);
  });

  it('sem ferramenta em execução: agent.finished(unknown) aos 15 min, não antes', () => {
    const { state, steps } = run(scn);
    const last = steps[2].at; // Post do Read, o último evento do tester
    assert.deepEqual(tick(state, last + STALE_AGENT_MS - 1).events, []);
    const result = tick(state, last + STALE_AGENT_MS);
    assertEvents(result.events, [['agent.finished', T.id, { outcome: 'unknown' }]]);
    assert.equal(result.events[0].ts, last + STALE_AGENT_MS);
    assert.deepEqual(result.changed, [SID]);
    const session = view(state);
    assert.equal(agentOf(session, T.id).finished, true);
    // Com ferramenta em execução, continua.
    assert.equal(agentOf(session, LONG.id).status, 'working');
    // O main, trabalhando sem ferramenta, fica ocioso sem evento.
    assert.equal(agentOf(session, 'main').status, 'idle');
    assert.ok(session.feed.some((event) => event.kind === 'agent.finished' && event.agentKey === T.id));
    assertRunShape({ state, events: result.events });
  });

  it('o main com uma delegação em execução não é liberado', () => {
    const { state, end } = run(scenario('main-delegando', 'main esperando o subagente', (b) => {
      b.prompt('Delegue');
      const call = b.delegation('tester', 'Testar');
      b.pre(call);
    }));
    tick(state, end + STALE_AGENT_MS * 2);
    assert.equal(agentOf(view(state), 'main').status, 'working');
  });
});

describe('a ordem de chegada não muda o estado final (seção 9, "Horas no estado")', () => {
  const A = agent('ordem-a', 'tester');
  const B = agent('ordem-b', 'tester');

  /** Mesmos eventos, com o `ts` de cada um fixo; muda só a ordem de chegada. */
  function play(order) {
    const scn = scenario('ordem', 'eventos com ts fixo', (b) => {
      b.sessionStart();
      b.prompt('Dois tester e uma leitura do main');
      const ca = b.delegation('tester', 'Testar A');
      const cb = b.delegation('tester', 'Testar B');
      b.pre(ca);
      b.pre(cb);
      b.start(A);
      b.start(B);
      for (let i = 0; i < 12; i++) b.tool('Bash', { command: `npm run passo-${i}` }, { who: A, error: i < 3 ? 'Exit code 1' : undefined });
      b.returned(ca, A);
      b.returned(cb, B);
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
    });
    const events = scn.events.map((event, i) => ({ ...event, ts: START + i * 10 }));
    const state = newState();
    for (const i of order(events.length)) {
      const { payload, env, ts } = events[i];
      const fact = normalize({ v: 1, sentAt: ts, env, payload }, { receivedAt: ts, homeDir: HOME });
      apply(state, fact, ts);
    }
    return view(state);
  }
  const strip = (session) => ({ ...session, feed: undefined });

  it('Post antes do Pre, SubagentStart trocados e saúde com mais de 10 ações', () => {
    const canonical = strip(play((n) => [...Array(n).keys()]));
    const swaps = (n) => {
      const list = [...Array(n).keys()];
      // Troca vizinhos: Pre e Post de cada chamada, os dois SubagentStart, os Posts do Agent.
      for (let i = 2; i + 1 < n; i += 2) [list[i], list[i + 1]] = [list[i + 1], list[i]];
      return list;
    };
    assert.deepEqual(strip(play(swaps)), canonical);
    assert.deepEqual(canonical.agents.map((item) => item.key), ['main', A.id, B.id]);
    assert.equal(agentOf(canonical, 'main').activity.tool, 'Read');
    assert.deepEqual(agentOf(canonical, A.id).health, { ok: 9, total: 10 });
  });
});

describe('SessionEnd libera os agentes (seção 6; T7, ponto 7)', () => {
  const W = agent('esc-dev', 'dev-backend');
  const BG = agent('esc-bg', 'tester');
  const calls = {};
  const scn = scenario('esc-e-clear', 'Esc sem Stop, seguido de /clear', (b) => {
    b.sessionStart();
    b.prompt('Rode o comando longo');
    b.tool('Bash', { command: 'node -e "setTimeout(()=>{},30000)"' }, { error: 'Interrupted by user' });
    b.prompt('Peça ao dev-backend e ao tester');
    const bg = b.delegation('tester', 'Testar em segundo plano', { background: true });
    b.pre(bg);
    b.start(BG);
    b.launched(bg, BG);
    calls.agent = b.delegation('dev-backend', 'Esperar 30 s');
    b.pre(calls.agent);
    b.start(W);
    calls.wait = b.call('Bash', { command: 'node -e "setTimeout(()=>{},30000)"' }, W);
    b.pre(calls.wait);
    // Esc: nenhum Stop. Depois, /clear.
    b.sessionEnd('clear');
  });

  it('subagentes trabalhando recebem agent.finished(unknown), o main fica idle, depois session.ended', () => {
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['agent.finished', BG.id, { outcome: 'unknown' }],
      ['agent.finished', W.id, { outcome: 'unknown' }],
      ['session.ended', null, { reason: 'clear' }],
    ]);
    const session = view(result.state);
    assert.equal(session.status, 'ended');
    assert.equal(agentOf(session, 'main').status, 'idle');
    for (const id of [W.id, BG.id]) assert.equal(agentOf(session, id).finished, true);
    assertRunShape(result);
  });

  it('eventos atrasados depois do SessionEnd não devolvem ninguém a trabalhando', () => {
    const result = run(scn);
    const late = run(scenario('esc-atrasados', 'atrasados', (b) => {
      b.post(calls.wait, { stdout: '' });
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: W });
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
    }), { state: result.state, start: result.end + 10 });
    assert.ok(late.events.some((event) => event.kind === 'tool.finished' && event.agentKey === W.id));
    const session = view(result.state);
    assert.equal(agentOf(session, W.id).status, 'idle');
    assert.equal(agentOf(session, W.id).finished, true);
    assert.equal(agentOf(session, 'main').status, 'idle');
    assert.equal(session.status, 'ended');
  });
});

describe('volta depois do encerramento inferido pelos 15 min (seção 6; T7, ponto 8)', () => {
  const T = agent('pensando', 'tester');
  const calls = {};
  const before = scenario('pensando', 'subagente que fica muito tempo sem ferramenta', (b) => {
    b.prompt('Peça ao tester');
    const call = b.delegation('tester', 'Testar');
    b.pre(call);
    b.start(T);
    calls.read = b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: T });
  });

  /** Roda até o tick dos 15 min, que encerra o tester por inferência. */
  function stale() {
    const result = run(before);
    const ticked = tick(result.state, result.end + STALE_AGENT_MS);
    assertEvents(ticked.events, [['agent.finished', T.id, { outcome: 'unknown' }]]);
    return { state: result.state, at: result.end + STALE_AGENT_MS + 1000 };
  }

  it('um tool.pre com toolUseId novo o devolve a working com finished: false, sem evento novo', () => {
    const { state, at } = stale();
    const result = run(scenario('pensando-volta', 'nova ferramenta', (b) => {
      b.pre(b.call('Bash', { command: 'npm test' }, T));
    }), { state, start: at });
    assertEvents(result.events, [['tool.started', T.id, { target: 'npm test' }]]);
    const tester = agentOf(view(state), T.id);
    assert.equal(tester.status, 'working');
    assert.equal(tester.finished, false);
    assert.equal(tester.label, 'Testar');
  });

  it('atrasos continuam sem efeito: Pre repetido e Post sem Pre', () => {
    const { state, at } = stale();
    const result = run(scenario('pensando-atrasos', 'atrasos', (b) => {
      b.pre(calls.read);
      b.post(b.call('Grep', { pattern: 'x' }, T), {});
    }), { state, start: at });
    assert.deepEqual(result.steps[0].events, [], 'Pre repetido é ignorado');
    assert.deepEqual(result.steps[1].events.map((event) => event.kind), ['tool.started', 'tool.finished']);
    const tester = agentOf(view(state), T.id);
    assert.equal(tester.finished, true);
    assert.equal(tester.status, 'idle');
  });

  it('não volta depois de SubagentStop ou de SessionEnd', () => {
    const cases = {
      SubagentStop: (b) => b.stopAgent(T),
      SessionEnd: (b) => b.sessionEnd('other'),
    };
    for (const [label, end] of Object.entries(cases)) {
      const { state, at } = stale();
      const result = run(scenario(`pensando-${label}`, label, (b) => {
        end(b);
        b.pre(b.call('Bash', { command: 'npm test' }, T));
      }), { state, start: at });
      const tester = agentOf(view(state), T.id);
      assert.equal(tester.finished, true, label);
      assert.equal(tester.status, 'idle', label);
      assert.ok(result.events.some((event) => event.kind === 'tool.started'), `${label}: o atraso ainda vai ao feed`);
    }
  });

  it('encerrado pelo Stop (primeiro plano), e não pelos 15 min, também não volta', () => {
    const stopped = run(scenario('parado-stop', 'Stop encerra o tester', (b) => {
      b.prompt('Peça ao tester');
      const call = b.delegation('tester', 'Testar');
      b.pre(call);
      b.start(T);
      b.stop();
      b.pre(b.call('Bash', { command: 'npm test' }, T));
    }));
    const tester = agentOf(view(stopped.state), T.id);
    assert.equal(tester.finished, true);
    assert.equal(tester.status, 'idle');
  });
});
