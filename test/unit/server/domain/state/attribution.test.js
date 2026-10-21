// SINTÉTICO: atribuição de eventos a agentes (T7, critérios marcados [T0]).
// Cenários no formato do ADR 0010, montados a partir da documentação dos hooks.
// Estes critérios só fecham com o G0a e as fixtures reais do T0: quando elas
// chegarem, cada cenário é trocado pelo de mesmo nome em test/fixtures/hooks/,
// e as conferências genéricas (assertAttribution, assertLinks, assertRunShape)
// continuam valendo.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../../../../server/domain/normalize.js';
import { apply, getSessionState } from '../../../../../server/domain/state/index.js';
import {
  HOME,
  PROJECT,
  START,
  agent,
  agentOf,
  assertAttribution,
  assertEvents,
  assertLinks,
  assertRunShape,
  newState,
  run,
  scenario,
  sessionId,
  view,
} from './scenarios.js';

const SID = sessionId('principal');

describe('[T0] V1, V9: orquestrador delega a um subagente', () => {
  const DOC = agent('doc-1', 'documentador');
  let call;
  const scn = scenario('delegacao-simples', 'orquestrador delega ao documentador', (b) => {
    b.sessionStart();
    b.prompt('Peça ao documentador para revisar o guia');
    call = b.delegation('documentador', 'Revisar o guia');
    b.pre(call);
    b.start(DOC);
    b.tool('Read', { file_path: `${PROJECT}\\docs\\guia.md` }, { who: DOC });
    b.tool('Bash', { command: 'node -e "process.exit(2)"', description: 'Sair com 2' }, { who: DOC, error: 'Exit code 2' });
    b.stopAgent(DOC);
    b.returned(call, DOC);
    b.stop();
  });

  it('emite delegação, início, ferramentas atribuídas pelo agent_id e fim', () => {
    const result = run(scn);
    assertEvents(result.events, [
      ['session.started', null, { source: 'startup', projectName: 'agents-quest' }],
      ['agent.delegated', 'main', { toolUseId: call.id, toType: 'documentador', toRole: 'doc', description: 'Revisar o guia', background: false }],
      ['agent.started', DOC.id, { agentType: 'documentador', role: 'doc', label: 'Revisar o guia', parentKey: 'main' }],
      ['tool.started', DOC.id, { tool: 'Read', category: 'read', target: 'docs/guia.md', detail: null }],
      ['tool.finished', DOC.id, { tool: 'Read', category: 'read', durationMs: 25 }],
      ['tool.started', DOC.id, { tool: 'Bash', category: 'bash', target: 'node -e "process.exit(2)"', detail: 'Sair com 2' }],
      ['tool.failed', DOC.id, { error: 'Exit code 2', interrupted: false }],
      ['agent.finished', DOC.id, { outcome: 'done' }],
    ]);
    assertRunShape(result);
    assert.equal(assertAttribution(result.steps), 4);
    assert.equal(assertLinks(scn, result.state), 1);
  });

  it('o subagente termina ocioso e encerrado; o orquestrador fica ocioso', () => {
    const session = view(run(scn).state);
    const doc = agentOf(session, DOC.id);
    assert.equal(doc.status, 'idle');
    assert.equal(doc.finished, true);
    assert.equal(doc.role, 'doc');
    assert.deepEqual(doc.health, { ok: 1, total: 2 });
    const main = agentOf(session, 'main');
    assert.equal(main.status, 'idle');
    assert.equal(main.finished, false);
    assert.deepEqual(session.roster, ['orq', 'doc']);
    // T8: o ticket abre no pedido e fecha no Stop; a etapa do documentador fecha quando ele termina.
    assert.deepEqual(session.feed.map((event) => event.kind), [
      'session.started', 'quest.started', 'agent.delegated', 'tool.started', 'tool.started', 'tool.failed',
      'agent.finished', 'quest.phase', 'quest.finished',
    ]);
  });

  it('no meio da delegação, os dois trabalham', () => {
    const session = view(run(scn, { until: 5 }).state);
    assert.equal(agentOf(session, 'main').status, 'working');
    assert.equal(agentOf(session, DOC.id).status, 'working');
    assert.equal(session.status, 'active');
  });
});

describe('[T0] V1, V5, V9: dois subagentes do mesmo tipo em paralelo', () => {
  const T1 = agent('tester-1', 'tester');
  const T2 = agent('tester-2', 'tester');

  function parallel({ swapped = true, withAgentId = true } = {}) {
    return scenario('paralelo-mesmo-tipo', 'dois tester em paralelo', (b) => {
      b.sessionStart();
      b.prompt('Use o tester duas vezes em paralelo');
      const c1 = b.delegation('tester', 'Testar a ingestão');
      const c2 = b.delegation('tester', 'Testar o painel');
      b.pre(c1);
      b.pre(c2);
      if (swapped) {
        b.start(T2);
        b.start(T1);
      } else {
        b.start(T1);
        b.start(T2);
      }
      b.tool('Read', { file_path: `${PROJECT}\\server\\ingest\\queue.js` }, { who: T1 });
      b.tool('Bash', { command: 'npm test' }, { who: T2 });
      b.stopAgent(T1);
      b.returned(c1, T1, { withAgentId });
      b.stopAgent(T2);
      b.returned(c2, T2, { withAgentId });
      b.stop();
    });
  }

  it('duas instâncias, cada uma com as próprias ferramentas', () => {
    const scn = parallel();
    const result = run(scn);
    const session = view(result.state);
    assert.deepEqual(session.agents.map((item) => item.key), ['main', T2.id, T1.id]);
    for (const id of [T1.id, T2.id]) {
      assert.equal(agentOf(session, id).role, 'tes');
      assert.equal(agentOf(session, id).finished, true);
      assert.deepEqual(agentOf(session, id).health, { ok: 1, total: 1 });
    }
    assert.equal(assertAttribution(result.steps), 4);
    assertRunShape(result);
  });

  it('SubagentStart em ordem trocada: a fila liga provisoriamente, e o PostToolUse do Agent corrige', () => {
    const scn = parallel();
    // Até os SubagentStart: a fila por tipo dá a primeira descrição ao primeiro que começou.
    const before = run(scn, { until: 6 });
    const started = before.events.filter((event) => event.kind === 'agent.started');
    assert.deepEqual(started.map((event) => [event.agentKey, event.data.label]), [
      [T2.id, 'Testar a ingestão'],
      [T1.id, 'Testar o painel'],
    ]);
    // Depois do Post da primeira delegação (índice 11): as descrições trocam, sem evento.
    const after = run(scn, { until: 12 });
    assert.deepEqual(after.steps[11].events, []);
    const session = view(after.state);
    assert.equal(agentOf(session, T1.id).label, 'Testar a ingestão');
    assert.equal(agentOf(session, T2.id).label, 'Testar o painel');
    // No fim, os elos batem com o tool_response.agentId de cada Post.
    const final = run(scn);
    assert.equal(assertLinks(scn, final.state), 2);
    for (const id of [T1.id, T2.id]) assert.equal(agentOf(view(final.state), id).parentKey, 'main');
  });

  it('se o V5 for refutado (Post sem agentId), vale a fila por tipo', () => {
    const session = view(run(parallel({ swapped: false, withAgentId: false })).state);
    assert.equal(agentOf(session, T1.id).label, 'Testar a ingestão');
    assert.equal(agentOf(session, T2.id).label, 'Testar o painel');
  });
});

describe('[T0] V1: subagente aninhado', () => {
  const ARQ = agent('arq-1', 'arquiteto');
  const EXPLORE = agent('explore-1', 'Explore');
  let nested;
  const scn = scenario('aninhado', 'arquiteto delega a um Explore', (b) => {
    b.sessionStart();
    b.prompt('Peça ao arquiteto para mapear os hooks');
    const outer = b.delegation('arquiteto', 'Planejar a captura');
    b.pre(outer);
    b.start(ARQ);
    nested = b.delegation('Explore', 'Mapear os hooks', { who: ARQ });
    b.pre(nested);
    b.start(EXPLORE);
    b.tool('Grep', { pattern: 'PreToolUse' }, { who: EXPLORE });
    b.stopAgent(EXPLORE);
    b.returned(nested, EXPLORE);
    b.stopAgent(ARQ);
    b.returned(outer, ARQ);
    b.stop();
  });

  it('parentKey aponta para o subagente que delegou', () => {
    const result = run(scn);
    const delegated = result.events.filter((event) => event.kind === 'agent.delegated');
    assert.deepEqual(delegated.map((event) => [event.agentKey, event.data.toRole]), [['main', 'arq'], [ARQ.id, 'aux']]);
    const session = view(result.state);
    assert.equal(agentOf(session, EXPLORE.id).parentKey, ARQ.id);
    assert.equal(agentOf(session, ARQ.id).parentKey, 'main');
    assert.equal(agentOf(session, EXPLORE.id).agentType, 'Explore');
    assert.deepEqual(session.roster, ['orq', 'arq', 'aux']);
    assert.equal(assertLinks(scn, result.state), 2);
    assertRunShape(result);
  });

  it('quem delegou fica com a atividade delegate até o Post da chamada', () => {
    const running = view(run(scn, { until: 8 }).state);
    assert.deepEqual(
      (({ kind, tool, target, detail, state }) => ({ kind, tool, target, detail, state }))(agentOf(running, ARQ.id).activity),
      { kind: 'delegate', tool: 'Agent', target: 'Explore', detail: 'Mapear os hooks', state: 'running' },
    );
    assert.equal(agentOf(view(run(scn).state), ARQ.id).activity.state, 'done');
  });
});

describe('[T0] V1, V14: eventos fora de ordem (seção 8, regras 1 a 4)', () => {
  const T = agent('tester-fora', 'tester');
  const BG = agent('tester-bg', 'tester');
  const calls = {};
  const scn = scenario('fora-de-ordem', 'Post antes do Pre, SubagentStop antes do Post e atrasados depois do Stop', (b) => {
    b.sessionStart();
    b.prompt('Rode os testes');
    // Regra 1 e 2 na sessão principal.
    calls.read = b.call('Read', { file_path: `${PROJECT}\\README.md` });
    b.post(calls.read, { type: 'text' });
    b.pre(calls.read);
    // Regra 1 e 2 num subagente.
    calls.delegate = b.delegation('tester', 'Testar');
    b.pre(calls.delegate);
    b.start(T);
    calls.bash = b.call('Bash', { command: 'npm test' }, T);
    b.post(calls.bash, { stdout: 'ok' });
    b.pre(calls.bash);
    // Regra 4: SubagentStop antes do último Post.
    calls.lint = b.call('Bash', { command: 'npm run lint' }, T);
    b.pre(calls.lint);
    b.stopAgent(T);
    b.post(calls.lint, { stdout: 'ok' });
    b.returned(calls.delegate, T);
    // Post do Agent em segundo plano antes do Pre.
    calls.background = b.delegation('tester', 'Testar em segundo plano', { background: true });
    b.launched(calls.background, BG);
    b.pre(calls.background);
    b.start(BG);
    // Regra 4 na sessão principal: atrasados depois do Stop.
    calls.late = b.call('Bash', { command: 'git status' });
    b.pre(calls.late);
    b.stop([{ id: BG.id, type: 'local_agent', status: 'running', description: 'Testar em segundo plano', agent_type: 'tester' }]);
    b.post(calls.late, { stdout: 'ok' });
    b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
  });

  it('Post antes do Pre gera um único tool.started; o Pre atrasado é ignorado', () => {
    const result = run(scn);
    for (const id of [calls.read.id, calls.bash.id]) {
      const started = result.events.filter((event) => event.kind === 'tool.started' && event.data.toolUseId === id);
      const finished = result.events.filter((event) => event.kind === 'tool.finished' && event.data.toolUseId === id);
      assert.equal(started.length, 1, `tool.started de ${id}`);
      assert.equal(finished.length, 1, `tool.finished de ${id}`);
    }
    const latePre = result.steps.filter((step) => step.payload.hook_event_name === 'PreToolUse' && [calls.read.id, calls.bash.id].includes(step.payload.tool_use_id));
    for (const step of latePre) assert.deepEqual(step.events, []);
    assert.equal(assertAttribution(result.steps), 10);
  });

  it('Post do Agent antes do Pre: uma única delegação, ligada à instância certa', () => {
    const result = run(scn);
    const delegated = result.events.filter((event) => event.kind === 'agent.delegated' && event.data.toolUseId === calls.background.id);
    assert.equal(delegated.length, 1);
    assert.equal(delegated[0].data.background, true);
    const bg = agentOf(view(result.state), BG.id);
    assert.equal(bg.label, 'Testar em segundo plano');
    assert.equal(bg.background, true);
    assert.equal(bg.status, 'working');
  });

  it('SubagentStop antes do último Post deixa o agente ocioso; o Post atrasado conta na saúde e no feed', () => {
    const result = run(scn);
    const stopIndex = result.steps.findIndex((step) => step.payload.hook_event_name === 'SubagentStop');
    const lateIndex = result.steps.findIndex((step) => step.payload.hook_event_name === 'PostToolUse' && step.payload.tool_use_id === calls.lint.id);
    assert.ok(stopIndex < lateIndex);
    assertEventsAt(result.steps[lateIndex].events, [['tool.finished', T.id]]);
    const tester = agentOf(view(result.state), T.id);
    assert.equal(tester.status, 'idle');
    assert.equal(tester.finished, true);
    assert.deepEqual(tester.health, { ok: 2, total: 2 });
    assert.equal(tester.activity.state, 'done');
  });

  it('eventos atrasados depois do Stop não devolvem a sessão principal a trabalhando', () => {
    const result = run(scn);
    const session = view(result.state);
    const main = agentOf(session, 'main');
    assert.equal(main.status, 'idle');
    const kinds = result.steps.slice(-3).flatMap((step) => step.events.map((event) => [event.kind, event.agentKey]));
    assert.deepEqual(kinds, [['tool.finished', 'main'], ['tool.started', 'main'], ['tool.finished', 'main']]);
    // O próximo pedido libera.
    const state = result.state;
    const prompt = normalize({ v: 1, sentAt: result.end + 10, env: { projectDir: PROJECT }, payload: { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'Outro pedido' } }, { receivedAt: result.end + 10, homeDir: HOME });
    apply(state, prompt, result.end + 10);
    assert.equal(agentOf(view(state), 'main').status, 'working');
  });

  it('a forma do estado e dos eventos segue o contrato', () => {
    assertRunShape(run(scn));
  });
});

describe('[T0] V1: servidor iniciado no meio', () => {
  const T = agent('tester-meio', 'tester');
  const scn = scenario('servidor-no-meio', 'primeiros eventos sem SessionStart nem SubagentStart', (b) => {
    b.tool('Bash', { command: 'npm test' }, { who: T });
    b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
  });

  it('o primeiro evento cria a sessão e o agente desconhecido, sem session.started', () => {
    const result = run(scn);
    assertEvents(result.events, [
      ['agent.started', T.id, { agentType: 'tester', role: 'tes', label: 'tester', parentKey: null }],
      ['tool.started', T.id, { target: 'npm test' }],
      ['tool.finished', T.id],
      ['tool.started', 'main', { target: 'CLAUDE.md' }],
      ['tool.finished', 'main'],
    ]);
    assert.deepEqual(result.steps[0].changed, [SID]);
    const session = view(result.state);
    assert.equal(session.label, `Sessão ${SID.slice(0, 6)}`);
    assert.equal(session.project.name, 'agents-quest');
    assert.equal(agentOf(session, T.id).status, 'working');
    assert.equal(agentOf(session, 'main').status, 'working');
    assert.equal(session.status, 'active');
    assertRunShape(result);
  });

  it('o SubagentStart que chega depois só completa o elo, sem evento', () => {
    const late = scenario('servidor-no-meio-elo', 'delegação e ferramenta antes do SubagentStart', (b) => {
      b.prompt('Rode os testes');
      const call = b.delegation('tester', 'Testar');
      b.pre(call);
      b.tool('Bash', { command: 'npm test' }, { who: T });
      b.start(T);
    });
    const result = run(late);
    // Criado pela ferramenta, já ligado ao pedido pendente do mesmo tipo.
    assertEvents(result.events.filter((event) => event.kind === 'agent.started'), [['agent.started', T.id, { label: 'Testar', parentKey: 'main' }]]);
    assert.deepEqual(result.steps.at(-1).events, []);
    assert.equal(agentOf(view(result.state), T.id).label, 'Testar');
  });
});

describe('[T0] V6: SubagentStop de agente interno', () => {
  const INTERNAL = agent('interno', '');

  it('agent_type vazio e agente desconhecido não geram nada, nem a sessão', () => {
    const scn = scenario('agente-interno', 'SubagentStop sem tipo', (b) => {
      b.stopAgent(INTERNAL);
      b.start(INTERNAL);
    });
    const result = run(scn);
    for (const step of result.steps) {
      assert.equal(step.fact.agentType, null);
      assert.deepEqual(step.events, []);
      assert.deepEqual(step.changed, []);
    }
    assert.equal(getSessionState(result.state, SID), null);
  });

  it('numa sessão existente, também não cria agente', () => {
    const scn = scenario('agente-interno-sessao', 'SubagentStop sem tipo depois do Stop', (b) => {
      b.sessionStart();
      b.stopAgent(INTERNAL);
    });
    const result = run(scn);
    assert.deepEqual(result.steps[1].events, []);
    assert.deepEqual(view(result.state).agents.map((item) => item.key), ['main']);
  });

  it('agente conhecido termina mesmo com agent_type vazio no SubagentStop', () => {
    const T = agent('conhecido', 'tester');
    const scn = scenario('agente-conhecido', 'SubagentStop sem tipo de agente conhecido', (b) => {
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: T });
      b.stopAgent({ id: T.id, type: '' });
    });
    const result = run(scn);
    assertEvents(result.steps[2].events, [['agent.finished', T.id, { outcome: 'done' }]]);
  });
});

describe('agent_id sem agent_type', () => {
  const GHOST = { id: agent('sem-tipo').id };

  it('cria a instância pelo agentId, com papel aux, e nunca atribui ao main', () => {
    const scn = scenario('sem-tipo', 'ferramenta de subagente sem agent_type', (b) => {
      b.prompt('x');
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: GHOST });
    });
    const result = run(scn);
    assertEvents(result.events, [
      ['agent.started', GHOST.id, { agentType: null, role: 'aux', label: '', parentKey: null }],
      ['tool.started', GHOST.id],
      ['tool.finished', GHOST.id],
    ]);
    const session = view(result.state);
    assert.equal(agentOf(session, GHOST.id).role, 'aux');
    assert.deepEqual(agentOf(session, 'main').health, { ok: 0, total: 0 });
    assert.deepEqual(session.roster, ['orq', 'aux']);
    assertRunShape(result);
  });

  it('um evento posterior com o tipo atualiza o papel', () => {
    const scn = scenario('sem-tipo-depois', 'tipo chega depois', (b) => {
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: GHOST });
      b.start({ id: GHOST.id, type: 'tester' });
    });
    const session = view(run(scn).state);
    assert.equal(agentOf(session, GHOST.id).role, 'tes');
    assert.equal(agentOf(session, GHOST.id).agentType, 'tester');
    assert.deepEqual(session.roster, ['orq', 'tes']);
  });

  it('agent_id inválido não chega ao reducer: o normalizador descarta o evento', () => {
    for (const bad of ['   ', '', 'com espaço', 42]) {
      const envelope = {
        v: 1, sentAt: START, env: { projectDir: PROJECT },
        payload: { hook_event_name: 'PreToolUse', session_id: SID, agent_id: bad, tool_name: 'Read', tool_input: { file_path: 'x' }, tool_use_id: 'toolu_01x' },
      };
      assert.equal(normalize(envelope, { receivedAt: START, homeDir: HOME }), null, JSON.stringify(bad));
    }
    // E o reducer, se receber algo que não é fato, não faz nada.
    const state = newState();
    assert.deepEqual(apply(state, /** @type {any} */ (null), START), { events: [], changed: [], newProjects: [] });
    assert.equal(state.sessions.size, 0);
  });
});

describe('agente desconhecido no SubagentStop (seção 4; T7, ponto 2)', () => {
  it('com tipo: agent.started e logo agent.finished', () => {
    const T = agent('so-o-fim', 'tester');
    const result = run(scenario('so-o-fim', 'SubagentStop sem SubagentStart', (b) => {
      b.sessionStart();
      b.stopAgent(T);
    }));
    assertEvents(result.steps[1].events, [
      ['agent.started', T.id, { agentType: 'tester', role: 'tes', label: 'tester', parentKey: null }],
      ['agent.finished', T.id, { outcome: 'done' }],
    ]);
    const tester = agentOf(view(result.state), T.id);
    assert.equal(tester.finished, true);
    assert.equal(tester.status, 'idle');
    assertRunShape(result);
  });
});

describe('falha do Agent (seção 4; T7, ponto 4)', () => {
  const T = agent('depois-da-falha', 'tester');

  for (const background of [false, true]) {
    it(`sem tool.failed; delegate vai a failed; o pedido sem instância é descartado (${background ? 'segundo' : 'primeiro'} plano)`, () => {
      const result = run(scenario('falha-agent', 'Agent falha antes de qualquer SubagentStart', (b) => {
        b.prompt('Peça ao tester');
        const call = b.delegation('tester', 'Testar', { background });
        b.pre(call);
        b.fail(call, 'Interrupted by user', { interrupt: true });
        b.start(T);
      }));
      assert.deepEqual(result.steps[2].events, [], 'a falha do Agent não emite evento');
      assert.ok(!result.events.some((event) => event.kind === 'tool.failed'));
      const session = view(result.state);
      const main = agentOf(session, 'main');
      assert.equal(main.activity.kind, 'delegate');
      assert.equal(main.activity.state, 'failed');
      // O SubagentStart posterior do mesmo tipo não se liga ao pedido descartado.
      const tester = agentOf(session, T.id);
      assert.equal(tester.label, 'tester');
      assert.equal(tester.parentKey, null);
      assertRunShape(result);
    });
  }

  it('com instância já ligada, o elo continua', () => {
    const result = run(scenario('falha-agent-ligado', 'Agent falha depois do SubagentStart', (b) => {
      b.prompt('Peça ao tester');
      const call = b.delegation('tester', 'Testar');
      b.pre(call);
      b.start(T);
      b.fail(call, 'Interrupted by user', { interrupt: true });
    }));
    const tester = agentOf(view(result.state), T.id);
    assert.equal(tester.label, 'Testar');
    assert.equal(tester.parentKey, 'main');
  });
});

describe('[T0] V5: corrida inversa, SubagentStart antes do Pre do Agent (seção 5, passo 2a; A4)', () => {
  const T1 = agent('inversa-1', 'tester');
  const T2 = agent('inversa-2', 'tester');

  it('a instância recebe a descrição e o parentKey no Pre, sem esperar o retorno, e o agent.started não se repete', () => {
    let call;
    const result = run(scenario('inversa', 'SubagentStart 10 ms antes do Pre', (b) => {
      b.prompt('Teste');
      b.start(T1);
      call = b.delegation('tester', 'Testar');
      b.pre(call);
      b.tool('Read', { file_path: `${PROJECT}\\a.md` }, { who: T1 });
    }));
    assertEvents(result.steps[1].events, [['agent.started', T1.id, { label: 'tester', parentKey: null }]]);
    assertEvents(result.steps[2].events, [['agent.delegated', 'main', { toolUseId: call.id, description: 'Testar' }]]);
    assert.equal(result.events.filter((event) => event.kind === 'agent.started').length, 1);
    // O estado que vai no update do Pre já leva o elo.
    const afterPre = view(run(scenario('inversa', 'até o Pre', (b) => {
      b.prompt('Teste');
      b.start(T1);
      b.pre(b.delegation('tester', 'Testar'));
    })).state);
    assert.equal(agentOf(afterPre, T1.id).label, 'Testar');
    assert.equal(agentOf(afterPre, T1.id).parentKey, 'main');
    assertRunShape(result);
  });

  it('dois do mesmo tipo com a corrida invertida nos dois: a mais antiga fica com o primeiro Pre', () => {
    const session = view(run(scenario('inversa-dupla', 'dois SubagentStart antes dos dois Pre', (b) => {
      b.prompt('Teste');
      b.start(T1);
      b.start(T2);
      b.pre(b.delegation('tester', 'Testar A'));
      b.pre(b.delegation('tester', 'Testar B'));
    })).state);
    assert.equal(agentOf(session, T1.id).label, 'Testar A');
    assert.equal(agentOf(session, T2.id).label, 'Testar B');
  });

  it('o Post do Agent corrige um elo trocado pela corrida', () => {
    const scn = scenario('inversa-trocada', 'SubagentStart na ordem oposta à dos Pre', (b) => {
      b.prompt('Teste');
      b.start(T2);
      b.start(T1);
      const a = b.delegation('tester', 'Testar A');
      const c = b.delegation('tester', 'Testar B');
      b.pre(a);
      b.pre(c);
      b.stopAgent(T1);
      b.returned(a, T1);
      b.stopAgent(T2);
      b.returned(c, T2);
    });
    const provisional = view(run(scn, { until: 5 }).state);
    assert.equal(agentOf(provisional, T2.id).label, 'Testar A', 'provisório: a mais antiga ficou com o primeiro Pre');
    const result = run(scn);
    assert.equal(agentOf(view(result.state), T1.id).label, 'Testar A');
    assert.equal(agentOf(view(result.state), T2.id).label, 'Testar B');
    assert.equal(assertLinks(scn, result.state), 2);
  });

  it('instância criada 3 s antes do Pre fica de fora; o Post liga depois', () => {
    const scn = scenario('inversa-antiga', 'SubagentStart 3 s antes do Pre', (b) => {
      b.prompt('Teste');
      b.start(T1);
      b.wait(3000);
      const call = b.delegation('tester', 'Testar');
      b.pre(call);
      b.returned(call, T1);
    });
    const beforePost = view(run(scn, { until: 3 }).state);
    assert.equal(agentOf(beforePost, T1.id).label, 'tester');
    assert.equal(agentOf(beforePost, T1.id).parentKey, null);
    assert.equal(agentOf(view(run(scn).state), T1.id).label, 'Testar');
  });

  it('quem delegou nunca é escolhido, nem os ancestrais dele', () => {
    const X = agent('inversa-delegador', 'tester');
    const session = view(run(scenario('inversa-delegador', 'tester sem elo delega a outro tester', (b) => {
      b.prompt('Teste');
      b.tool('Read', { file_path: `${PROJECT}\\a.md` }, { who: X });
      b.pre(b.delegation('tester', 'Subteste', { who: X }));
    })).state);
    assert.equal(agentOf(session, X.id).label, 'tester');
    assert.equal(agentOf(session, X.id).parentKey, null);
  });

  it('instância encerrada ou já ligada também fica de fora', () => {
    const session = view(run(scenario('inversa-inelegivel', 'encerrada e ligada', (b) => {
      b.prompt('Teste');
      b.pre(b.delegation('tester', 'Primeira'));
      b.start(T1);
      b.start(T2);
      b.stopAgent(T2);
      b.pre(b.delegation('tester', 'Segunda'));
    })).state);
    assert.equal(agentOf(session, T1.id).label, 'Primeira');
    assert.equal(agentOf(session, T2.id).label, 'tester');
  });
});

describe('robustez do elo e das chamadas', () => {
  it('uma instância nunca se liga à delegação que ela mesma fez', () => {
    const X = agent('auto-x', 'tester');
    const Y = agent('auto-y', 'tester');
    const result = run(scenario('auto-delegacao', 'tester delega a outro tester antes do próprio SubagentStart', (b) => {
      b.prompt('Teste');
      b.pre(b.delegation('tester', 'Subteste', { who: X }));
      b.pre(b.delegation('tester', 'Testar'));
      b.start(X);
      b.start(Y);
    }));
    const session = view(result.state);
    assert.equal(agentOf(session, X.id).parentKey, 'main');
    assert.equal(agentOf(session, X.id).label, 'Testar');
    assert.equal(agentOf(session, Y.id).parentKey, X.id);
    assert.equal(agentOf(session, Y.id).label, 'Subteste');
  });

  it('agent_type só com espaços conta como vazio (no fato, agentType: null)', () => {
    const result = run(scenario('tipo-espacos', 'SubagentStop com tipo em branco', (b) => {
      b.sessionStart();
      b.stopAgent({ id: agent('branco').id, type: '   ' });
      b.stopAgent({ id: agent('tab').id, type: '\t' });
    }));
    assert.equal(result.steps[1].fact.agentType, null);
    assert.deepEqual(result.steps.slice(1).flatMap((step) => step.events), []);
    assert.deepEqual(view(result.state).agents.map((item) => item.key), ['main']);
  });

  it('Post ou Failure com outro tool_name e o mesmo toolUseId seguem o tipo do primeiro evento', () => {
    const result = run(scenario('id-reaproveitado', 'ids repetidos com outra ferramenta', (b) => {
      b.prompt('x');
      const delegation = b.delegation('tester', 'Testar');
      b.pre(delegation);
      b.fail({ ...delegation, tool: 'Read', input: { file_path: 'a.md' } }, 'Exit code 1');
      const read = b.call('Read', { file_path: `${PROJECT}\\a.md` });
      b.pre(read);
      b.post({ ...read, tool: 'Agent', input: { subagent_type: 'tester', description: 'x' } }, { status: 'completed' });
    }));
    assertEvents(result.events, [
      ['agent.delegated', 'main'],
      ['tool.started', 'main', { tool: 'Read', category: 'read' }],
      ['tool.finished', 'main', { tool: 'Read', category: 'read' }],
    ]);
    assertRunShape(result);
  });
});

/** @param {object[]} actual @param {[string, string][]} expected */
function assertEventsAt(actual, expected) {
  assert.deepEqual(actual.map((event) => [event.kind, event.agentKey]), expected);
}
