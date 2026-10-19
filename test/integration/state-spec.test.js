// Estado I contra a especificação (tester, T7): server/domain/state/ conferido
// do envelope ao estado, passando pelo normalizador real, com cenários
// próprios escritos a partir de docs/arquitetura/modelo-de-eventos.md (seções
// 2 a 9, com as decisões de 19/10/2026 sobre as leituras do dev), do ADR 0007
// e do T7 em docs/plano/v1.md. Independentes dos cenários e das conferências
// do dev (test/unit/server/domain/state/).
//
// Cobre, um bloco por critério do T7 (os marcados [T0] com cenários
// SINTÉTICOS; fecham com as fixtures reais depois do G0a), e os critérios do
// tester: permutação dentro de janelas de 200 ms, 1 000 fatos em menos de
// 50 ms e feed limitado a 200.
//
// Casos adversos e invariantes (fuzz) estão em state-adversarial.test.js; os
// pontos que o dev está mudando (decisões de 19/10/2026), em
// state-decisions.test.js.
//
// Os testes marcados com `todo` reproduzem achados abertos no relatório do
// tester. Eles rodam e mostram a falha, mas não deixam a suíte vermelha
// enquanto o responsável decide ou corrige; quem resolver tira o `todo`.
//
// Pastas pessoais, projetos e ids são fictícios (o repositório é público).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_KEYS,
  AGENT_KEYS,
  DATA_KEYS,
  HOME,
  MIN,
  OTHER_PROJECT,
  PROJECT,
  SESSION_KEYS,
  T0,
  Tracker,
  agent,
  agentIn,
  apply,
  checkSession,
  checkState,
  createState,
  diffPaths,
  envelopeOf,
  getSessionState,
  getSessionStates,
  jitterOrder,
  kinds,
  newState,
  normalize,
  pickActivity,
  play,
  rng,
  script,
  sessionId,
  setAgentNames,
  tick,
  view,
  windowOrder,
  withoutFeed,
} from './state-helpers.js';

const SID = sessionId(1);
const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/state/${name}`, import.meta.url)), 'utf8'));

/** Confere que todo evento de ferramenta comum foi atribuído pelo `agent_id` do payload (V1). */
function checkAttribution(steps) {
  let checked = 0;
  for (const { item, events } of steps) {
    const { payload } = item;
    if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(payload.hook_event_name)) continue;
    if (['Agent', 'Task'].includes(payload.tool_name)) continue;
    for (const event of events.filter((e) => e.kind.startsWith('tool.'))) {
      assert.equal(event.agentKey, payload.agent_id ?? 'main', `${payload.hook_event_name} ${payload.tool_use_id}`);
      assert.equal(event.sessionId, payload.session_id);
      checked++;
    }
  }
  return checked;
}

// ---------------------------------------------------------------------------
// Cenários dos dois primeiros critérios (também usados na permutação)
// ---------------------------------------------------------------------------

const DOC = agent(1, 'documentador');

/** Orquestrador delega ao documentador; tempos plausíveis (ms desde T0). */
function delegationScenario() {
  const s = script();
  s.sessionStart(0);
  s.prompt(4000, 'Peça ao documentador para revisar o guia');
  const c = s.delegation('documentador', 'Revisar o guia de instalação');
  s.pre(7000, c);
  s.start(7040, DOC);
  const read = s.call('Read', { file_path: `${PROJECT}\\docs\\guia.md` }, DOC);
  s.pre(8500, read);
  s.post(8515, read);
  const grep = s.call('Grep', { pattern: 'npm start', path: `${PROJECT}\\docs` }, DOC);
  s.pre(8520, grep);
  s.post(8540, grep);
  const bash = s.call('Bash', { command: 'node -e "process.exit(1)"', description: 'Conferir a saída' }, DOC);
  s.pre(10000, bash);
  s.fail(10180, bash, 'Exit code 1');
  s.stopAgent(12000, DOC);
  s.returned(12030, c, DOC);
  const mainRead = s.call('Read', { file_path: `${PROJECT}\\docs\\guia.md` });
  s.pre(12100, mainRead);
  s.post(12110, mainRead);
  s.stop(14000);
  return { list: s.events, c, read, grep, bash, mainRead };
}

const T1 = agent(11, 'tester');
const T2 = agent(12, 'tester');

/** Dois tester em paralelo, com os SubagentStart em ordem trocada. */
function parallelScenario({ withAgentId = true } = {}) {
  const s = script();
  s.sessionStart(0);
  s.prompt(3000, 'Teste a ingestão e o painel em paralelo');
  const c1 = s.delegation('tester', 'Testar a ingestão');
  const c2 = s.delegation('tester', 'Testar o painel');
  s.pre(6000, c1);
  s.pre(6008, c2);
  s.start(6050, T2);
  s.start(6060, T1);
  const read = s.call('Read', { file_path: `${PROJECT}\\server\\ingest\\queue.js` }, T1);
  s.pre(7500, read);
  s.post(7520, read);
  const test = s.call('Bash', { command: 'npm test', description: 'Rodar a suíte' }, T2);
  s.pre(7530, test);
  s.post(7700, test);
  const edit = s.call('Edit', { file_path: `${PROJECT}\\test\\integration\\fila.test.js`, old_string: 'CONTEUDO-ANTIGO', new_string: 'CONTEUDO-NOVO' }, T1);
  s.pre(9000, edit);
  s.post(9030, edit);
  const lint = s.call('Bash', { command: 'npm run lint', description: 'Lint' }, T2);
  s.pre(9010, lint);
  s.fail(9150, lint, 'Exit code 2');
  s.stopAgent(11000, T1);
  s.returned(11030, c1, T1, { withAgentId });
  s.stopAgent(11100, T2);
  s.returned(11120, c2, T2, { withAgentId });
  s.stop(13000);
  return { list: s.events, c1, c2 };
}

// ---------------------------------------------------------------------------
// Critérios do T7
// ---------------------------------------------------------------------------

describe('[T0] V1, V9: orquestrador delega a um subagente', () => {
  it('agent.delegated, agent.started, ferramentas pelo agent_id e agent.finished, nessa ordem e com os dados da seção 3', () => {
    const { list, c, read, grep, bash, mainRead } = delegationScenario();
    const tracker = new Tracker();
    const result = play(list, { tracker });
    const expected = [
      ['session.started', null, { source: 'startup', projectName: 'agents-quest' }],
      ['agent.delegated', 'main', { toolUseId: c.id, toType: 'documentador', toRole: 'doc', description: 'Revisar o guia de instalação', background: false }],
      ['agent.started', DOC.id, { agentType: 'documentador', role: 'doc', label: 'Revisar o guia de instalação', parentKey: 'main' }],
      ['tool.started', DOC.id, { toolUseId: read.id, tool: 'Read', category: 'read', target: 'docs/guia.md', detail: null }],
      ['tool.finished', DOC.id, { toolUseId: read.id, tool: 'Read', category: 'read', durationMs: 12 }],
      ['tool.started', DOC.id, { toolUseId: grep.id, tool: 'Grep', category: 'search', target: 'npm start', detail: null }],
      ['tool.finished', DOC.id, { toolUseId: grep.id }],
      ['tool.started', DOC.id, { toolUseId: bash.id, tool: 'Bash', category: 'bash', target: 'node -e "process.exit(1)"', detail: 'Conferir a saída' }],
      ['tool.failed', DOC.id, { toolUseId: bash.id, tool: 'Bash', category: 'bash', target: 'node -e "process.exit(1)"', error: 'Exit code 1', interrupted: false }],
      ['agent.finished', DOC.id, { outcome: 'done' }],
      ['tool.started', 'main', { toolUseId: mainRead.id, target: 'docs/guia.md' }],
      ['tool.finished', 'main', { toolUseId: mainRead.id }],
    ];
    assert.deepEqual(kinds(result.events), expected.map(([kind, key]) => [kind, key]));
    expected.forEach(([kind, , data], i) => {
      for (const [field, value] of Object.entries(data)) assert.deepEqual(result.events[i].data[field], value, `${i} ${kind}.${field}`);
    });
    assert.equal(checkAttribution(result.steps), 8);
    for (const event of result.events) assert.equal(event.sessionId, SID, 'V9: tudo na sessão principal');
    checkState(result.state);
  });

  it('o subagente termina idle e finished; o orquestrador fica idle depois do Stop', () => {
    const session = view(play(delegationScenario().list).state);
    const doc = agentIn(session, DOC.id);
    assert.equal(doc.status, 'idle');
    assert.equal(doc.finished, true);
    assert.equal(doc.role, 'doc');
    assert.equal(doc.label, 'Revisar o guia de instalação');
    assert.equal(doc.parentKey, 'main');
    assert.deepEqual(doc.health, { ok: 2, total: 3 });
    const main = agentIn(session, 'main');
    assert.equal(main.status, 'idle');
    assert.equal(main.finished, false);
    assert.deepEqual(main.health, { ok: 1, total: 1 });
    assert.deepEqual(session.feed.map((e) => e.kind), [
      'session.started', 'agent.delegated', 'tool.started', 'tool.started', 'tool.started', 'tool.failed', 'agent.finished', 'tool.started',
    ]);
  });

  it('durante a delegação os dois trabalham, e o main mostra a atividade delegate', () => {
    const { list } = delegationScenario();
    const session = view(play(list.slice(0, 5)).state);
    assert.equal(session.status, 'active');
    assert.equal(agentIn(session, 'main').status, 'working');
    assert.deepEqual(pickActivity(agentIn(session, 'main').activity), {
      kind: 'delegate', category: null, tool: 'Agent', target: 'documentador', detail: 'Revisar o guia de instalação', state: 'running',
    });
    assert.equal(agentIn(session, DOC.id).status, 'working');
  });
});

describe('[T0] V1, V5, V9: dois subagentes do mesmo tipo em paralelo', () => {
  it('duas instâncias, cada uma com as próprias ferramentas', () => {
    const tracker = new Tracker();
    const result = play(parallelScenario().list, { tracker });
    const session = view(result.state);
    assert.deepEqual(session.agents.map((a) => a.key), ['main', T2.id, T1.id]);
    assert.equal(checkAttribution(result.steps), 8);
    assert.deepEqual(agentIn(session, T1.id).health, { ok: 2, total: 2 });
    assert.deepEqual(agentIn(session, T2.id).health, { ok: 1, total: 2 });
    const targets = (key) => result.events.filter((e) => e.kind === 'tool.started' && e.agentKey === key).map((e) => e.data.target);
    assert.deepEqual(targets(T1.id), ['server/ingest/queue.js', 'test/integration/fila.test.js']);
    assert.deepEqual(targets(T2.id), ['npm test', 'npm run lint']);
    checkState(result.state);
  });

  it('SubagentStart trocados: a fila liga provisoriamente; depois do PostToolUse do Agent, as descrições estão certas', () => {
    const { list } = parallelScenario();
    const startsDone = list.findIndex((item) => item.payload.hook_event_name === 'PreToolUse' && item.payload.agent_id === T1.id);
    const provisional = view(play(list.slice(0, startsDone)).state);
    assert.equal(agentIn(provisional, T2.id).label, 'Testar a ingestão', 'fila: o primeiro que começou fica com o pedido mais antigo');
    assert.equal(agentIn(provisional, T1.id).label, 'Testar o painel');

    const firstPost = list.findIndex((item) => item.payload.hook_event_name === 'PostToolUse' && item.payload.tool_name === 'Agent');
    const fixed = play(list.slice(0, firstPost + 1));
    assert.deepEqual(fixed.steps.at(-1).events, [], 'a correção do elo não emite evento');
    const session = view(fixed.state);
    assert.equal(agentIn(session, T1.id).label, 'Testar a ingestão');
    assert.equal(agentIn(session, T2.id).label, 'Testar o painel');
    for (const key of [T1.id, T2.id]) assert.equal(agentIn(session, key).parentKey, 'main');

    const final = view(play(list).state);
    assert.equal(agentIn(final, T1.id).label, 'Testar a ingestão');
    assert.equal(agentIn(final, T2.id).label, 'Testar o painel');
  });

  it('com o V5 refutado (PostToolUse sem agentId), vale só a fila por tipo, sem lançar', () => {
    const session = view(play(parallelScenario({ withAgentId: false }).list).state);
    assert.equal(agentIn(session, T2.id).label, 'Testar a ingestão');
    assert.equal(agentIn(session, T1.id).label, 'Testar o painel');
    checkSession(session, { feed: true });
  });
});

describe('[T0] V1: subagente aninhado', () => {
  const ARQ = agent(21, 'arquiteto');
  const EXP = agent(22, 'Explore');

  function nested() {
    const s = script();
    s.prompt(0, 'Peça ao arquiteto para mapear os hooks');
    const outer = s.delegation('arquiteto', 'Planejar a captura');
    s.pre(2000, outer);
    s.start(2030, ARQ);
    const inner = s.delegation('Explore', 'Mapear os hooks', { who: ARQ });
    s.pre(4000, inner);
    s.start(4030, EXP);
    s.tool(5000, 'Grep', { pattern: 'PreToolUse' }, EXP);
    s.stopAgent(6000, EXP);
    s.returned(6020, inner, EXP);
    s.stopAgent(8000, ARQ);
    s.returned(8020, outer, ARQ);
    s.stop(9000);
    return { list: s.events, inner };
  }

  it('parentKey aponta para o subagente que delegou, e a delegação sai dele', () => {
    const { list, inner } = nested();
    const tracker = new Tracker();
    const result = play(list, { tracker });
    const delegated = result.events.filter((e) => e.kind === 'agent.delegated');
    assert.deepEqual(delegated.map((e) => [e.agentKey, e.data.toType, e.data.toRole]), [['main', 'arquiteto', 'arq'], [ARQ.id, 'Explore', 'aux']]);
    assert.equal(delegated[1].data.toolUseId, inner.id);
    const startedExp = result.events.find((e) => e.kind === 'agent.started' && e.agentKey === EXP.id);
    assert.equal(startedExp.data.parentKey, ARQ.id);
    const session = view(result.state);
    assert.equal(agentIn(session, EXP.id).parentKey, ARQ.id);
    assert.equal(agentIn(session, ARQ.id).parentKey, 'main');
    assert.deepEqual(session.roster, ['orq', 'arq', 'aux']);
    checkState(result.state);
  });
});

describe('[T0] V1, V14: fora de ordem (seção 8, regras 1 a 4)', () => {
  const T = agent(31, 'tester');

  function outOfOrder() {
    const s = script();
    s.prompt(0, 'Rode os testes');
    const read = s.call('Read', { file_path: `${PROJECT}\\README.md` });
    s.post(1000, read);
    s.pre(990, read); // Pre chega depois do Post
    const c = s.delegation('tester', 'Testar');
    s.pre(2000, c);
    s.start(2030, T);
    const bash = s.call('Bash', { command: 'npm test' }, T);
    s.fail(3200, bash, 'Exit code 1'); // Failure antes do Pre
    s.pre(3000, bash);
    const lint = s.call('Bash', { command: 'npm run lint' }, T);
    s.pre(4000, lint);
    s.stopAgent(4100, T); // SubagentStop antes do último Post
    s.post(4090, lint);
    s.returned(4120, c, T);
    const late = s.call('Bash', { command: 'git status' });
    s.pre(5000, late);
    s.stop(5050);
    s.post(5040, late); // atrasado depois do Stop
    s.tool(5100, 'Read', { file_path: `${PROJECT}\\CLAUDE.md` }); // atrasado depois do Stop
    return { list: s.events, read, bash, lint };
  }

  it('Post (ou Failure) antes do Pre gera um único tool.started; o Pre atrasado não gera nada', () => {
    const { list, read, bash } = outOfOrder();
    const tracker = new Tracker();
    const result = play(list, { tracker });
    for (const id of [read.id, bash.id]) {
      assert.equal(result.events.filter((e) => e.kind === 'tool.started' && e.data.toolUseId === id).length, 1, id);
      const latePre = result.steps.find((step) => step.item.payload.hook_event_name === 'PreToolUse' && step.item.payload.tool_use_id === id);
      assert.deepEqual(latePre.events, [], `Pre atrasado de ${id}`);
    }
    const failed = result.events.find((e) => e.kind === 'tool.failed');
    assert.equal(failed.data.toolUseId, bash.id);
    assert.equal(failed.agentKey, T.id);
    checkAttribution(result.steps);
  });

  it('SubagentStop antes do último Post: o agente fica idle; o Post atrasado conta na saúde', () => {
    const { list, lint } = outOfOrder();
    const result = play(list);
    const lateStep = result.steps.find((step) => step.item.payload.hook_event_name === 'PostToolUse' && step.item.payload.tool_use_id === lint.id);
    assert.deepEqual(kinds(lateStep.events), [['tool.finished', T.id]]);
    const t = agentIn(view(result.state), T.id);
    assert.equal(t.status, 'idle');
    assert.equal(t.finished, true);
    assert.deepEqual(t.health, { ok: 1, total: 2 });
  });

  it('eventos atrasados depois do Stop não devolvem a sessão principal a trabalhando; o próximo pedido devolve', () => {
    const { list } = outOfOrder();
    const result = play(list);
    const tail = result.steps.slice(-3).flatMap((step) => kinds(step.events));
    assert.deepEqual(tail, [['tool.finished', 'main'], ['tool.started', 'main'], ['tool.finished', 'main']]);
    assert.equal(agentIn(view(result.state), 'main').status, 'idle');
    const s = script();
    s.prompt(6000, 'Outro pedido');
    play(s.events, { state: result.state });
    assert.equal(agentIn(view(result.state), 'main').status, 'working');
  });
});

describe('[T0] V1: servidor iniciado no meio da sessão', () => {
  const T = agent(41, 'tester');

  it('o primeiro evento cria a sessão e o agente desconhecido, sem SessionStart nem SubagentStart, e sem session.started', () => {
    const s = script();
    s.tool(1000, 'Bash', { command: 'npm test' }, T);
    s.tool(2000, 'Read', { file_path: `${PROJECT}\\CLAUDE.md` });
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.deepEqual(result.steps[0].changed, [SID]);
    assert.deepEqual(kinds(result.steps[0].events), [['agent.started', T.id], ['tool.started', T.id]]);
    assert.deepEqual(result.steps[0].events[0].data, { agentType: 'tester', role: 'tes', label: 'tester', parentKey: null });
    assert.ok(!result.events.some((e) => e.kind === 'session.started'), 'sessão sob demanda não emite session.started (ponto 3)');
    const session = view(result.state);
    assert.equal(session.label, `Sessão ${SID.slice(0, 6)}`);
    assert.deepEqual(session.project, { key: 'c:/Users/beltrana/Codigo/agents-quest', name: 'agents-quest', dir: PROJECT });
    assert.equal(agentIn(session, T.id).status, 'working');
    assert.equal(agentIn(session, 'main').status, 'working');
    checkState(result.state);
  });

  it('o SubagentStart que chega depois só completa o elo, sem evento', () => {
    const s = script();
    s.prompt(0, 'Rode os testes');
    const c = s.delegation('tester', 'Testar');
    s.pre(100, c);
    s.tool(1000, 'Bash', { command: 'npm test' }, T);
    s.start(1500, T);
    const result = play(s.events);
    assert.deepEqual(result.steps.at(-1).events, []);
    const t = agentIn(view(result.state), T.id);
    assert.equal(t.label, 'Testar');
    assert.equal(t.parentKey, 'main');
  });
});

describe('duas sessões de projetos diferentes', () => {
  const A = sessionId(51);
  const B = sessionId(52);
  const TA = agent(51, 'tester');
  const TB = agent(52, 'tester');

  function twoSessions() {
    const s = script({ session: A });
    s.sessionStart(0);
    s.prompt(100, 'Teste a ingestão');
    const c = s.delegation('tester', 'Testar a ingestão');
    s.pre(200, c);
    s.use({ session: B, projectDir: OTHER_PROJECT, entrypoint: 'claude-vscode' });
    s.sessionStart(210);
    s.start(220, TB); // mesmo tipo do pedido pendente da sessão A
    s.tool(230, 'Read', { file_path: `${OTHER_PROJECT}\\src\\pao.js` }, TB);
    s.use({ session: A, projectDir: PROJECT, entrypoint: 'cli' });
    s.start(240, TA);
    s.tool(250, 'Read', { file_path: `${PROJECT}\\server\\main.js` }, TA);
    s.use({ session: B, projectDir: OTHER_PROJECT, entrypoint: 'claude-vscode' });
    s.tool(260, 'Bash', { command: 'npm run build' });
    s.stop(270);
    return s.events;
  }

  it('nenhuma atribuição cruzada: agentes, elos, eventos e Stop ficam na própria sessão', () => {
    const tracker = new Tracker();
    const result = play(twoSessions(), { tracker });
    const a = view(result.state, A);
    const b = view(result.state, B);
    assert.deepEqual(a.agents.map((x) => x.key), ['main', TA.id]);
    assert.deepEqual(b.agents.map((x) => x.key), ['main', TB.id]);
    assert.equal(agentIn(b, TB.id).label, 'tester', 'o pedido pendente da sessão A não se liga ao tester da B');
    assert.equal(agentIn(b, TB.id).parentKey, null);
    assert.equal(agentIn(a, TA.id).label, 'Testar a ingestão');
    assert.equal(agentIn(a, TA.id).status, 'working', 'o Stop da B não encerra o subagente da A');
    assert.equal(agentIn(a, 'main').status, 'working', 'nem o main da A');
    assert.equal(agentIn(b, TB.id).finished, true);
    assert.equal(checkAttribution(result.steps), 6);
    assert.ok(a.feed.every((e) => e.sessionId === A) && b.feed.every((e) => e.sessionId === B));
    checkState(result.state);
  });

  it('project.key e project.name corretos para caminhos do Windows, e cliente de cada sessão', () => {
    const result = play(twoSessions());
    assert.deepEqual(view(result.state, A).project, { key: 'c:/Users/beltrana/Codigo/agents-quest', name: 'agents-quest', dir: PROJECT });
    assert.deepEqual(view(result.state, B).project, { key: 'e:/Clientes/Padaria-Exemplo', name: 'Padaria-Exemplo', dir: OTHER_PROJECT });
    assert.equal(view(result.state, A).client, 'terminal');
    assert.equal(view(result.state, B).client, 'vscode');
    const targets = result.events.filter((e) => e.kind === 'tool.started').map((e) => [e.sessionId, e.data.target]);
    assert.deepEqual(targets, [[B, 'src/pao.js'], [A, 'server/main.js'], [B, 'npm run build']]);
  });
});

describe('[T0] V6: SubagentStop de agente interno', () => {
  const INTERNAL = agent(61, '');

  it('agent_type vazio e agente desconhecido: nenhum evento, nenhuma sessão, nenhum agente', () => {
    const s = script();
    s.stopAgent(0, INTERNAL);
    s.stopAgent(10, { id: INTERNAL.id });
    const result = play(s.events);
    for (const step of result.steps) {
      assert.equal(step.fact.agentType, null);
      assert.deepEqual(step.events, []);
      assert.deepEqual(step.changed, []);
    }
    assert.equal(getSessionState(result.state, SID), null);

    const t = script();
    t.sessionStart(0);
    t.stopAgent(10, INTERNAL);
    const inSession = play(t.events);
    assert.deepEqual(inSession.steps[1].events, []);
    assert.deepEqual(view(inSession.state).agents.map((x) => x.key), ['main']);
  });

  it('agente conhecido termina mesmo com agent_type vazio no SubagentStop', () => {
    const T = agent(62, 'tester');
    const s = script();
    s.tool(0, 'Read', { file_path: `${PROJECT}\\a.md` }, T);
    s.stopAgent(100, { id: T.id, type: '' });
    const result = play(s.events);
    assert.deepEqual(kinds(result.steps.at(-1).events), [['agent.finished', T.id]]);
    assert.equal(result.steps.at(-1).events[0].data.outcome, 'done');
  });
});

describe('agent_id sem agent_type, e agent_id inválido', () => {
  const GHOST = { id: agent(71).id };

  it('cria ou atualiza a instância pelo agentId, com papel aux, e nunca atribui ao main', () => {
    const s = script();
    s.prompt(0, 'x');
    s.tool(100, 'Read', { file_path: `${PROJECT}\\CLAUDE.md` }, GHOST);
    s.tool(200, 'Bash', { command: 'ls' }, GHOST);
    const result = play(s.events);
    assert.deepEqual(result.steps[1].events[0].data, { agentType: null, role: 'aux', label: '', parentKey: null });
    const session = view(result.state);
    assert.deepEqual(agentIn(session, GHOST.id).health, { ok: 2, total: 2 });
    assert.deepEqual(agentIn(session, 'main').health, { ok: 0, total: 0 });
    assert.ok(result.events.filter((e) => e.kind.startsWith('tool.')).every((e) => e.agentKey === GHOST.id));
    assert.deepEqual(session.roster, ['orq', 'aux']);
    checkState(result.state);
  });

  it('o tipo que chega depois atualiza o papel, o agentType e o roster (ponto 9)', () => {
    const s = script();
    s.tool(0, 'Read', { file_path: `${PROJECT}\\CLAUDE.md` }, GHOST);
    s.start(100, { id: GHOST.id, type: 'tester' });
    const session = view(play(s.events).state);
    const ghost = agentIn(session, GHOST.id);
    assert.equal(ghost.role, 'tes');
    assert.equal(ghost.agentType, 'tester');
    assert.equal(ghost.label, 'tester');
    assert.deepEqual(session.roster, ['orq', 'tes']);
  });

  it('agent_id inválido nunca chega ao reducer: o normalizador descarta o evento', () => {
    for (const bad of ['   ', '', 'com espaço', 42, 'x'.repeat(129), '../a', 'a\u0000b', true, {}]) {
      const s = script();
      s.tool(0, 'Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { id: bad, type: 'tester' });
      s.start(10, { id: bad, type: 'tester' });
      const result = play(s.events);
      assert.ok(result.steps.every((step) => step.fact === null), JSON.stringify(bad));
      assert.equal(getSessionStates(result.state).length, 0, JSON.stringify(bad));
    }
  });
});

describe('papel e comparações pelo valor cru; estado e eventos com o valor exibido', () => {
  const TOKEN_A = `ghp_${'A'.repeat(36)}`;
  const TOKEN_B = `ghp_${'B'.repeat(36)}`;
  const AUTH = agent(81, 'auth:tester');
  const SECRET_B = agent(82, TOKEN_B);
  const SECRET_A = agent(83, TOKEN_A);
  const REVIEWER = agent(84, 'revisor');

  function rawScenario() {
    const s = script();
    s.prompt(0, 'Delegue');
    const auth = s.delegation('auth:tester', 'Testar a autenticação');
    s.pre(100, auth);
    s.start(130, AUTH);
    const secret = s.delegation(TOKEN_A, 'Tipo com cara de token');
    s.pre(200, secret);
    s.start(230, SECRET_B); // exibido igual (•••), cru diferente: não pode ligar
    s.start(240, SECRET_A);
    const reviewer = s.delegation('revisor', 'Revisar');
    s.pre(300, reviewer);
    s.start(330, REVIEWER);
    return s.events;
  }

  it('resolveRole(agentTypeKey) dá o papel; resolveRole(subagentTypeKey) dá o toRole; o estado leva o exibido', () => {
    const result = play(rawScenario(), { state: newState({ roleOverrides: { revisor: 'tes' } }) });
    const session = view(result.state);
    const auth = agentIn(session, AUTH.id);
    assert.equal(auth.agentType, 'auth:•••');
    assert.equal(auth.role, 'tes');
    assert.equal(agentIn(session, REVIEWER.id).role, 'tes');
    assert.equal(agentIn(session, SECRET_A.id).role, 'aux');
    assert.equal(agentIn(session, SECRET_A.id).agentType, '•••');
    const delegated = result.events.filter((e) => e.kind === 'agent.delegated');
    assert.deepEqual(delegated.map((e) => [e.data.toType, e.data.toRole]), [['auth:•••', 'tes'], ['•••', 'aux'], ['revisor', 'tes']]);
    const started = result.events.filter((e) => e.kind === 'agent.started');
    assert.deepEqual(started.map((e) => e.data.agentType), ['auth:•••', '•••', '•••', 'revisor']);
  });

  it('o elo delegação → instância compara os tipos crus, não os exibidos', () => {
    const session = view(play(rawScenario()).state);
    assert.equal(agentIn(session, AUTH.id).label, 'Testar a autenticação');
    assert.equal(agentIn(session, SECRET_B.id).label, '•••', 'tipo cru diferente não se liga, mesmo exibido igual');
    assert.equal(agentIn(session, SECRET_B.id).parentKey, null);
    assert.equal(agentIn(session, SECRET_A.id).label, 'Tipo com cara de token');
    assert.equal(agentIn(session, SECRET_A.id).parentKey, 'main');
  });

  it('nenhum *Key nem valor cru no SessionState ou nos eventos canônicos', () => {
    const tracker = new Tracker();
    const result = play(rawScenario(), { tracker });
    checkState(result.state);
    const all = JSON.stringify({ sessions: getSessionStates(result.state, { feed: true }), events: result.events });
    assert.ok(!/Key"/.test(all.replace(/"(agentKey|parentKey)"/g, '')), 'chave *Key no JSON');
    for (const raw of ['auth:tester', TOKEN_A, TOKEN_B, 'A'.repeat(20), 'B'.repeat(20), 'PEDIDO-COMPLETO-DO-AGENTE']) {
      assert.ok(!all.includes(raw), `valor cru no JSON: ${raw.slice(0, 12)}`);
    }
  });
});

describe('equipe (roster)', () => {
  const DOC2 = agent(91, 'documentador');
  const GUEST = agent(92, 'general-purpose');

  function rosterScenario() {
    const s = script();
    s.sessionStart(0);
    s.tool(100, 'Read', { file_path: `${PROJECT}\\README.md` }, DOC2);
    s.tool(200, 'Read', { file_path: `${PROJECT}\\CLAUDE.md` }, GUEST);
    return s.events;
  }

  // Leitor fora do apply (seção 7, revisto em 19/10/2026): o apply devolve
  // newProjects, uma vez por projeto, na forma canônica, e a ligação entrega os
  // nomes por setAgentNames, com update sem evento.
  it('orq + papéis com arquivo em .claude/agents/ (por setAgentNames) + papéis vistos + aux com convidado, na ordem de ROLES', () => {
    const state = createState();
    const result = play(rosterScenario(), { state });
    const reported = result.steps.flatMap((step) => step.newProjects);
    assert.deepEqual(reported, ['c:/Users/beltrana/Codigo/agents-quest'], 'newProjects uma vez, na forma canônica');
    assert.deepEqual(view(state).roster, ['orq', 'doc', 'aux'], 'antes da leitura: só os papéis vistos');
    const { changed } = setAgentNames(state, reported[0], ['dev-frontend', 'arquiteto', 'nao-e-do-time', 'Tester', 42, null]);
    assert.deepEqual(changed, [SID]);
    assert.deepEqual(view(state).roster, ['orq', 'arq', 'dev', 'doc', 'aux']);
    assert.deepEqual(setAgentNames(state, reported[0], ['dev-frontend', 'arquiteto']).changed, [], 'os mesmos papéis: nada muda');
  });

  it('arquivo de papel sem instância entra; nome desconhecido não traz aux; sobrescrita vale para os arquivos', () => {
    const s = script();
    s.sessionStart(0);
    const state = newState({ agentNames: ['revisor', 'Plan'], roleOverrides: { revisor: 'doc' } });
    play(s.events, { state });
    assert.deepEqual(view(state).roster, ['orq', 'doc']);
  });

  it('nomes que não são lista, pasta vazia ou outro projeto não quebram nada nem mexem nesta sessão', () => {
    for (const names of ['tester', null, 42, {}, [], [null, 7]]) {
      const state = createState();
      const result = play(rosterScenario(), { state });
      assert.doesNotThrow(() => setAgentNames(state, 'c:/Users/beltrana/Codigo/agents-quest', names));
      assert.deepEqual(setAgentNames(state, 'D:\\outro', ['tester']).changed, []);
      assert.deepEqual(setAgentNames(state, '', ['tester']).changed, []);
      assert.deepEqual(view(state).roster, ['orq', 'doc', 'aux']);
      checkState(result.state);
    }
  });

  it('o mesmo projeto em outra sessão, ou em outra forma de caminho, não é novo de novo e já recebe os papéis', () => {
    const state = newState({ agentNames: ['tester'] });
    const first = script();
    first.sessionStart(0);
    const second = script({ session: sessionId(2), projectDir: 'c:/Users/beltrana/Codigo/agents-quest/' });
    second.sessionStart(10);
    const a = play(first.events, { state });
    const b = play(second.events, { state });
    assert.deepEqual(a.steps[0].newProjects, ['c:/Users/beltrana/Codigo/agents-quest']);
    assert.deepEqual(b.steps[0].newProjects, []);
    assert.deepEqual(view(state, sessionId(2)).roster, ['orq', 'tes']);
  });

  it('projeto desconhecido: nada em newProjects, e o roster fica com os papéis vistos', () => {
    const s = script({ projectDir: null });
    s.tool(0, 'Read', { file_path: 'CLAUDE.md' }, DOC2);
    const state = newState({ agentNames: ['tester'] });
    const result = play(s.events, { state });
    assert.deepEqual(result.steps.flatMap((step) => step.newProjects), []);
    const session = view(state);
    assert.deepEqual(session.project, { key: '', name: '', dir: '' });
    assert.deepEqual(session.roster, ['orq', 'doc']);
  });
});

describe('[T0] V5, V13: fim do turno da sessão principal (primeiro plano)', () => {
  const FG = agent(101, 'dev-backend');
  const BG = agent(102, 'tester');
  const LISTED = agent(103, 'documentador');
  const CHILD = agent(104, 'Explore');
  const ASYNC = agent(105, 'arquiteto');

  function turn(end) {
    const s = script();
    s.sessionStart(0);
    s.prompt(100, 'Trabalhem');
    const fg = s.delegation('dev-backend', 'Implementar');
    s.pre(200, fg);
    s.start(230, FG);
    const bg = s.delegation('tester', 'Testar em segundo plano', { background: true });
    s.pre(300, bg);
    s.start(330, BG);
    s.launched(340, bg, BG);
    const listed = s.delegation('documentador', 'Documentar');
    s.pre(400, listed);
    s.start(430, LISTED);
    const child = s.delegation('Explore', 'Mapear', { who: BG });
    s.pre(500, child);
    s.start(530, CHILD);
    const async = s.delegation('arquiteto', 'Desenhar'); // sem run_in_background, mas lançado em segundo plano
    s.pre(600, async);
    s.start(630, ASYNC);
    s.launched(640, async, ASYNC);
    end(s);
    return s.events;
  }

  it('UserPromptSubmit deixa o main working; Stop deixa idle', () => {
    const s = script();
    s.sessionStart(0);
    assert.equal(agentIn(view(play(s.events).state), 'main').status, 'idle');
    s.prompt(100);
    const state = play(s.events).state;
    assert.equal(agentIn(view(state), 'main').status, 'working');
    const t = script();
    t.stop(200);
    play(t.events, { state });
    assert.equal(agentIn(view(state), 'main').status, 'idle');
  });

  it('Stop: primeiro plano recebe agent.finished(unknown); segundo plano, listado, lançado e filhos seguem', () => {
    const result = play(turn((s) => s.stop(1000, [{ id: LISTED.id, type: 'local_agent', status: 'running', description: 'Documentar', agent_type: 'documentador' }])));
    assert.deepEqual(kinds(result.steps.at(-1).events), [['agent.finished', FG.id]]);
    assert.equal(result.steps.at(-1).events[0].data.outcome, 'unknown');
    const session = view(result.state);
    assert.equal(agentIn(session, 'main').status, 'idle');
    assert.equal(agentIn(session, FG.id).finished, true);
    for (const key of [BG.id, LISTED.id, CHILD.id, ASYNC.id]) {
      assert.equal(agentIn(session, key).status, 'working', key);
      assert.equal(agentIn(session, key).finished, false, key);
    }
    assert.equal(agentIn(session, BG.id).background, true);
    assert.equal(agentIn(session, ASYNC.id).background, true, 'async_launched marca segundo plano');
    assert.equal(agentIn(session, LISTED.id).background, true, 'listado em background_tasks passa a segundo plano (V13)');
    checkState(result.state);
  });

  it('StopFailure faz o mesmo, sem background_tasks', () => {
    const result = play(turn((s) => s.stopFailure(1000)));
    assert.deepEqual(kinds(result.steps.at(-1).events), [['agent.finished', FG.id], ['agent.finished', LISTED.id]]);
    const session = view(result.state);
    assert.equal(agentIn(session, 'main').status, 'idle');
    for (const key of [BG.id, CHILD.id, ASYNC.id]) assert.equal(agentIn(session, key).status, 'working', key);
  });

  it('em todo Stop, mesmo com tarefas em segundo plano rodando, os de primeiro plano são liberados (ponto 5)', () => {
    const result = play(turn((s) => s.stop(1000, [{ id: BG.id, type: 'local_agent', status: 'running', agent_type: 'tester' }])));
    assert.deepEqual(kinds(result.steps.at(-1).events), [['agent.finished', FG.id], ['agent.finished', LISTED.id]]);
  });
});

describe('status e rótulo da sessão', () => {
  it('label = session_title (SessionStart ou pedido, o mais recente), senão "Sessão" + 6 caracteres do id', () => {
    const plain = script();
    plain.sessionStart(0);
    assert.equal(view(play(plain.events).state).label, `Sessão ${SID.slice(0, 6)}`);
    const titled = script();
    titled.sessionStart(0, 'resume', { session_title: 'Painel da guilda' });
    assert.equal(view(play(titled.events).state).label, 'Painel da guilda');
    titled.prompt(100, 'x', { session_title: 'Revisão do servidor' });
    assert.equal(view(play(titled.events).state).label, 'Revisão do servidor');
    const secret = script();
    secret.sessionStart(0, 'startup', { session_title: `deploy com token=ghp_${'C'.repeat(36)}` });
    const label = view(play(secret.events).state).label;
    assert.ok(!label.includes('CCCCCCCC'), label);
  });

  it('active com agente trabalhando ou evento há menos de 2 min; idle a partir de 2 min; ended no SessionEnd', () => {
    const s = script();
    s.sessionStart(0);
    s.prompt(100);
    s.tool(200, 'Read', { file_path: `${PROJECT}\\CLAUDE.md` });
    s.stop(300);
    const { state } = play(s.events);
    assert.equal(view(state).status, 'active');
    assert.deepEqual(tick(state, T0 + 300 + 2 * MIN - 1).changed, []);
    assert.equal(view(state).status, 'active');
    assert.deepEqual(tick(state, T0 + 300 + 2 * MIN).changed, [SID]);
    assert.equal(view(state).status, 'idle');
    // Um subagente trabalhando mantém a sessão active mesmo sem eventos.
    const BG = agent(111, 'tester');
    const t = script();
    t.start(3 * MIN, BG);
    play(t.events, { state });
    tick(state, T0 + 10 * MIN);
    assert.equal(view(state).status, 'active');
    const end = script();
    end.sessionEnd(11 * MIN, 'clear');
    const ended = play(end.events, { state });
    assert.deepEqual(kinds(ended.events).at(-1), ['session.ended', null]);
    assert.deepEqual(ended.events.at(-1).data, { reason: 'clear' });
    assert.equal(view(state).status, 'ended');
  });
});

describe('saúde: janela das últimas 10 ações', () => {
  it('tool.finished conta como sucesso, tool.failed como falha (inclusive interrompida); delegações não contam', () => {
    const T = agent(121, 'tester');
    const s = script();
    s.prompt(0);
    let at = 100;
    for (let i = 0; i < 3; i++) {
      const c = s.call('Bash', { command: `node falha-${i}.js` });
      s.pre(at, c);
      s.fail(at + 5, c, `Exit code ${i + 1}`, { interrupt: i === 2 });
      at += 100;
    }
    for (let i = 0; i < 9; i++, at += 100) s.tool(at, 'Read', { file_path: `${PROJECT}\\a-${i}.md` });
    const c = s.delegation('tester', 'Testar');
    s.pre(at, c);
    s.start(at + 10, T);
    s.returned(at + 20, c, T);
    const session = view(play(s.events).state);
    assert.deepEqual(agentIn(session, 'main').health, { ok: 9, total: 10 });
    assert.deepEqual(agentIn(session, T.id).health, { ok: 0, total: 0 });

    const few = script();
    few.prompt(0);
    const f = few.call('Bash', { command: 'false' });
    few.pre(10, f);
    few.fail(20, f, 'Exit code 1');
    assert.deepEqual(agentIn(view(play(few.events).state), 'main').health, { ok: 0, total: 1 });
  });
});

describe('tick com relógio injetado: 15 min, 30 min e 6 h', () => {
  const T = agent(131, 'tester');
  const LONG = agent(132, 'dev-backend');

  it('agente trabalhando sem ferramenta em execução e sem eventos há 15 min → agent.finished(unknown); não antes; nem com comando longo', () => {
    const s = script();
    s.prompt(0);
    const c = s.delegation('tester', 'Testar');
    s.pre(100, c);
    s.start(130, T);
    s.tool(1000, 'Read', { file_path: `${PROJECT}\\a.md` }, T); // último evento do tester em 1015
    const long = s.call('Bash', { command: 'npm run build' }, LONG);
    s.pre(1100, long);
    const tracker = new Tracker();
    const { state } = play(s.events, { tracker });
    const before = tick(state, T0 + 1015 + 15 * MIN - 1);
    assert.deepEqual(before.events, []);
    const at15 = tick(state, T0 + 1015 + 15 * MIN);
    tracker.consume(at15.events);
    assert.deepEqual(kinds(at15.events), [['agent.finished', T.id]]);
    assert.equal(at15.events[0].data.outcome, 'unknown');
    assert.equal(at15.events[0].ts, T0 + 1015 + 15 * MIN);
    assert.deepEqual(at15.changed, [SID]);
    assert.deepEqual(at15.removed, []);
    const session = view(state);
    assert.equal(agentIn(session, T.id).finished, true);
    assert.equal(agentIn(session, LONG.id).status, 'working', 'com ferramenta em execução, continua');
    assert.equal(agentIn(session, 'main').status, 'working', 'o main com a delegação em execução continua');
    assert.ok(session.feed.some((e) => e.kind === 'agent.finished' && e.agentKey === T.id), 'agent.finished vai para o feed');
    checkState(state);
  });

  it('main trabalhando sem ferramenta há 15 min só fica idle, sem agent.finished (ponto 6)', () => {
    const s = script();
    s.prompt(0);
    const { state } = play(s.events);
    const result = tick(state, T0 + 15 * MIN);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.changed, [SID]);
    assert.equal(agentIn(view(state), 'main').status, 'idle');
  });

  it('sessão encerrada sai após 30 min; sem eventos, após 6 h; removed fora de changed', () => {
    const state = newState();
    const ended = script({ session: sessionId(133) });
    ended.sessionStart(0);
    ended.sessionEnd(1000);
    const quiet = script({ session: sessionId(134) });
    quiet.sessionStart(2000);
    play([...ended.events, ...quiet.events], { state });
    assert.deepEqual(tick(state, T0 + 1000 + 30 * MIN - 1).removed, []);
    const at30 = tick(state, T0 + 1000 + 30 * MIN);
    assert.deepEqual(at30.removed, [sessionId(133)]);
    assert.ok(!at30.changed.includes(sessionId(133)));
    assert.equal(getSessionState(state, sessionId(133)), null);
    assert.deepEqual(tick(state, T0 + 2000 + 6 * 60 * MIN - 1).removed, []);
    assert.deepEqual(tick(state, T0 + 2000 + 6 * 60 * MIN).removed, [sessionId(134)]);
    assert.equal(getSessionStates(state).length, 0);
  });
});

describe('forma do SessionState (seção 9) contra o contrato e os snapshots do painel', () => {
  const neutro = fixture('neutro.json').sessions[0];
  const primeiraLuz = fixture('primeira-luz.json').sessions[0];

  it('sessão recém-iniciada: igual ao snapshot neutro escrito à mão, menos ids e horas', () => {
    const s = script({ session: neutro.id, projectDir: neutro.project.dir, entrypoint: null });
    s.sessionStart(0);
    s.hook(1500, 'Notification', { message: 'MENSAGEM', notification_type: 'idle_prompt' });
    const session = view(play(s.events).state, neutro.id);
    const mask = (value) => JSON.parse(JSON.stringify(value), (key, v) => (['startedAt', 'lastEventAt', 'ts', 'id', 'seq'].includes(key) && typeof v !== 'object' ? 0 : v));
    const { feed: ourFeed, ...ours } = mask(session);
    const { feed: theirFeed, ...theirs } = mask(neutro);
    assert.deepEqual({ ...ours, status: 'idle' }, theirs);
    assert.deepEqual(ourFeed.map((e) => [e.kind, e.agentKey, e.data]), theirFeed.map((e) => [e.kind, e.agentKey, e.data]));
    checkSession(session, { feed: true });
  });

  it('mesmas chaves, em todos os níveis, do snapshot "primeira-luz" que o painel usa', () => {
    const { list } = delegationScenario();
    const session = view(play(list.slice(0, 8)).state);
    assert.deepEqual(Object.keys(session).filter((k) => k !== 'feed').sort(), Object.keys(primeiraLuz).filter((k) => k !== 'feed').sort());
    assert.deepEqual([...SESSION_KEYS].sort(), Object.keys(primeiraLuz).filter((k) => k !== 'feed').sort());
    for (const item of session.agents) assert.deepEqual(Object.keys(item).sort(), Object.keys(primeiraLuz.agents[0]).sort());
    assert.deepEqual([...AGENT_KEYS].sort(), Object.keys(primeiraLuz.agents[0]).sort());
    const withActivity = primeiraLuz.agents.find((a) => a.activity);
    assert.deepEqual([...ACTIVITY_KEYS].sort(), Object.keys(withActivity.activity).sort());
    assert.ok(session.agents.every((a) => a.activity === null || Object.keys(a.activity).sort().join() === Object.keys(withActivity.activity).sort().join()));
    // Os dados dos eventos do feed batem com os que o painel espera, por tipo.
    for (const event of primeiraLuz.feed.filter((e) => e.kind in DATA_KEYS)) {
      assert.deepEqual(Object.keys(event.data).sort(), [...DATA_KEYS[event.kind]].sort(), event.kind);
    }
  });

  it('update sem feed; snapshot com feed; sessão desconhecida é null; o estado devolvido é cópia', () => {
    const { state } = play(delegationScenario().list);
    assert.ok(!('feed' in getSessionState(state, SID, { feed: false })));
    checkSession(getSessionState(state, SID, { feed: false }), { feed: false });
    assert.ok(Array.isArray(getSessionStates(state, { feed: true })[0].feed));
    assert.equal(getSessionState(state, sessionId(999)), null);
    const copy = view(state);
    copy.agents[0].activity.state = 'failed';
    copy.agents[0].health.ok = 99;
    copy.agents.pop();
    copy.project.name = 'outro';
    copy.roster.push('aux');
    const again = view(state);
    assert.equal(again.agents[0].activity.state, 'done');
    assert.equal(again.agents[0].health.ok, 1);
    assert.equal(again.agents.length, 2);
    assert.equal(again.project.name, 'agents-quest');
    assert.deepEqual(again.roster, ['orq', 'doc']);
  });
});

describe('[T0] V5: atividade por tipo (seção 9) e label do main', () => {
  const T = agent(141, 'tester');
  const BG = agent(142, 'Explore');

  function activityScenario() {
    const s = script();
    s.prompt(0);
    const first = s.delegation('tester', 'Testar a ingestão');
    const second = s.delegation('Explore', 'Mapear em segundo plano', { background: true });
    s.pre(100, first); // 1
    s.pre(110, second); // 2
    s.start(140, T); // 3
    const bash = s.call('Bash', { command: 'npm test', description: 'Rodar a suíte' }, T);
    s.pre(1000, bash); // 4
    s.fail(1200, bash, 'Exit code 1'); // 5
    s.launched(1300, second, BG); // 6
    s.start(1310, BG); // 7
    s.stopAgent(2000, T); // 8
    s.returned(2030, first, T); // 9
    const failing = s.delegation('tester', 'Delegação que falha');
    s.pre(3000, failing); // 10
    s.fail(3100, failing, 'Interrompido', { interrupt: true }); // 11
    return s.events;
  }

  it('start, tool (running → failed), delegate (a mais recente; segundo plano done no lançamento; primeiro plano no retorno; failed na falha)', () => {
    const list = activityScenario();
    const at = (n) => view(play(list.slice(0, n)).state);
    assert.deepEqual(pickActivity(agentIn(at(4), T.id).activity), { kind: 'start', category: null, tool: null, target: null, detail: null, state: 'running' });
    assert.deepEqual(pickActivity(agentIn(at(5), T.id).activity), { kind: 'tool', category: 'bash', tool: 'Bash', target: 'npm test', detail: 'Rodar a suíte', state: 'running' });
    assert.equal(agentIn(at(6), T.id).activity.state, 'failed');
    assert.deepEqual(pickActivity(agentIn(at(3), 'main').activity), { kind: 'delegate', category: null, tool: 'Agent', target: 'Explore', detail: 'Mapear em segundo plano', state: 'running' });
    assert.equal(agentIn(at(7), 'main').activity.state, 'done', 'segundo plano: done logo no lançamento');
    assert.equal(agentIn(at(12), 'main').activity.detail, 'Delegação que falha');
    assert.equal(agentIn(at(12), 'main').activity.state, 'failed');
    assert.equal(agentIn(at(8), BG.id).background, true);
    const result = play(list);
    assert.ok(!result.events.some((e) => e.kind === 'tool.failed' && ['Agent', 'Task'].includes(e.data.tool)), 'falha do Agent não vira tool.failed (ponto 4)');
  });

  it('Task (nome antigo) também é delegação', () => {
    const s = script();
    s.prompt(0);
    const c = s.delegation('tester', 'Testar pelo Task', { tool: 'Task' });
    s.pre(100, c);
    s.start(130, T);
    const result = play(s.events);
    assert.deepEqual(kinds(result.events), [['agent.delegated', 'main'], ['agent.started', T.id]]);
    assert.equal(agentIn(view(result.state), T.id).label, 'Testar pelo Task');
    assert.equal(agentIn(view(result.state), 'main').activity.tool, 'Task');
  });

  it('o label do main é o agent_type da sessão iniciada com --agent, ou vazio; continua main/orq', () => {
    const plain = script();
    plain.sessionStart(0);
    assert.equal(agentIn(view(play(plain.events).state), 'main').label, '');
    const withAgent = script();
    withAgent.sessionStart(0, 'startup', { agent_type: 'revisor' });
    withAgent.tool(100, 'Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { type: 'revisor' });
    const session = view(play(withAgent.events).state);
    const main = agentIn(session, 'main');
    assert.equal(main.label, 'revisor');
    assert.equal(main.agentType, 'revisor');
    assert.equal(main.role, 'orq');
    assert.deepEqual(session.agents.map((a) => a.key), ['main']);
    assert.ok(play(withAgent.events).events.filter((e) => e.kind.startsWith('tool.')).every((e) => e.agentKey === 'main'));
  });
});

// ---------------------------------------------------------------------------
// Critérios do tester
// ---------------------------------------------------------------------------

/** Estado final comparável: sem feed, com o status recalculado no mesmo instante. */
function finalState(list, at) {
  const { state } = play(list);
  tick(state, T0 + at);
  return getSessionStates(state, { feed: false }).map(withoutFeed);
}

/** Roda `count` embaralhamentos e junta as diferenças em relação à ordem real. */
function permutations(list, { seed, count, mode }) {
  const end = Math.max(...list.map((item) => item.at)) + 1000;
  const baseline = finalState(list, end);
  const random = rng(seed);
  const failures = new Map();
  let failed = 0;
  let reordered = 0;
  for (let i = 0; i < count; i++) {
    const order = mode === 'jitter' ? jitterOrder(list, random) : windowOrder(list, random);
    if (order.some((item, j) => item.payload !== list[j].payload)) reordered++;
    const diffs = diffPaths(finalState(order, end), baseline);
    if (diffs.length === 0) continue;
    failed++;
    for (const diff of diffs) {
      const path = diff.split(':')[0];
      if (!failures.has(path)) failures.set(path, { count: 0, example: diff, order: order.map((item) => `${item.payload.hook_event_name}@${item.at}`).join(' ') });
      failures.get(path).count++;
    }
  }
  return { failed, reordered, failures };
}

function report({ failed, failures }, count) {
  return `${failed} de ${count} embaralhamentos com estado final diferente:\n${[...failures.entries()]
    .map(([path, { count: n, example, order }]) => `  ${path} (${n}x): ${example}\n    ordem: ${order}`)
    .join('\n')}`;
}

describe('permutação: embaralhar dentro de janelas de 200 ms dá o mesmo estado final ([T0]: refeito com as fixtures reais)', () => {
  const SEED = 20261019;
  const COUNT = 400;
  const scenarios = [
    ['delegação simples', () => delegationScenario().list],
    ['dois tester em paralelo', () => parallelScenario().list],
  ];

  for (const [name, build] of scenarios) {
    for (const mode of ['jitter', 'janelas']) {
      it(`${name}, ${mode}: ${COUNT} embaralhamentos com semente fixa`, (t) => {
        const result = permutations(build(), { seed: SEED, count: COUNT, mode });
        t.diagnostic(`${result.reordered} de ${COUNT} ordens diferentes da real; ${result.failed} com estado final diferente`);
        assert.ok(result.reordered > COUNT / 2, 'os embaralhamentos precisam trocar a ordem');
        assert.equal(result.failed, 0, report(result, COUNT));
      });
    }
  }
});

/** 1 000 envelopes: duas sessões, quatro subagentes por turno (dois do mesmo tipo), um aninhado, falhas e Post antes do Pre. */
function heavyScenario(total = 1000) {
  const s = script();
  const A = sessionId(901);
  const B = sessionId(902);
  let at = 0;
  const next = () => (at += 7);
  for (let turn = 1; s.events.length < total; turn++) {
    s.use({ session: A, projectDir: PROJECT, entrypoint: 'cli' });
    if (turn === 1) s.sessionStart(next());
    s.prompt(next(), `Pedido ${turn}`);
    const workers = [agent(1000 + turn * 10, 'tester'), agent(1001 + turn * 10, 'tester'), agent(1002 + turn * 10, 'dev-backend'), agent(1003 + turn * 10, 'arquiteto')];
    const calls = workers.map((w, i) => s.delegation(w.type, `Tarefa ${turn}.${i}`));
    for (const c of calls) s.pre(next(), c);
    for (const w of [...workers].reverse()) s.start(next(), w);
    const explorer = agent(1004 + turn * 10, 'Explore');
    const nested = s.delegation('Explore', `Mapear ${turn}`, { who: workers[3] });
    s.pre(next(), nested);
    s.start(next(), explorer);
    for (let k = 0; k < 12; k++) {
      for (const w of [...workers, explorer]) {
        const c = k % 3 === 0
          ? s.call('Bash', { command: `npm run passo-${k}`, description: `Passo ${k}` }, w)
          : s.call('Read', { file_path: `${PROJECT}\\src\\modulo-${k}.js` }, w);
        if (k % 5 === 4) {
          s.post(next(), c);
          s.pre(next(), c);
        } else {
          s.pre(next(), c);
          if (k % 7 === 6) s.fail(next(), c, `Exit code ${k}`);
          else s.post(next(), c);
        }
      }
    }
    s.stopAgent(next(), explorer);
    s.returned(next(), nested, explorer);
    workers.forEach((w, i) => {
      s.stopAgent(next(), w);
      s.returned(next(), calls[i], w);
    });
    s.use({ session: B, projectDir: OTHER_PROJECT, entrypoint: 'claude-vscode' });
    for (let k = 0; k < 10; k++) s.tool(next(), 'Read', { file_path: `${OTHER_PROJECT}\\src\\p${k}.js` });
    s.use({ session: A, projectDir: PROJECT, entrypoint: 'cli' });
    s.stop(next());
  }
  s.events.length = total;
  return s.events;
}

describe('desempenho: 1 000 fatos em menos de 50 ms', () => {
  it('só o apply, melhor de 7 depois de um aquecimento (como o teste de tempo do ADR 0010)', (t) => {
    const list = heavyScenario();
    const facts = list.map((item) => ({ fact: normalize(envelopeOf(item), { receivedAt: T0 + item.at, homeDir: HOME }), now: T0 + item.at }));
    assert.equal(facts.length, 1000);
    assert.ok(facts.every(({ fact }) => fact !== null), 'todos os envelopes viram fato');
    let best = Infinity;
    let state;
    for (let run = 0; run <= 7; run++) {
      state = newState();
      const begin = performance.now();
      for (const { fact, now } of facts) apply(state, fact, now);
      const elapsed = performance.now() - begin;
      if (run > 0) best = Math.min(best, elapsed);
    }
    const begin = performance.now();
    play(list);
    const withNormalize = performance.now() - begin;
    t.diagnostic(`apply: melhor de 7 = ${best.toFixed(1)} ms; com o normalizador = ${withNormalize.toFixed(1)} ms`);
    assert.ok(best < 50, `melhor tempo ${best.toFixed(1)} ms`);
    checkState(state);
    assert.ok(getSessionStates(state, { feed: true }).every((session) => session.feed.length <= 200));
  });
});

describe('feed limitado a 200 por sessão', () => {
  it('fica com os 200 eventos de feed mais recentes, em ordem, separado por sessão, sem tool.finished nem agent.started', () => {
    const s = script();
    s.sessionStart(0);
    for (let i = 0; i < 300; i++) s.tool(100 + i * 10, 'Read', { file_path: `${PROJECT}\\arquivo-${i}.md` });
    s.use({ session: sessionId(2), projectDir: OTHER_PROJECT });
    const W = agent(151, 'tester');
    for (let i = 0; i < 150; i++) s.tool(5000 + i * 10, 'Bash', { command: `echo ${i}` }, W);
    const result = play(s.events);
    const a = view(result.state, SID);
    const b = view(result.state, sessionId(2));
    assert.equal(a.feed.length, 200);
    assert.equal(a.feed[0].data.target, 'arquivo-100.md');
    assert.equal(a.feed.at(-1).data.target, 'arquivo-299.md');
    assert.equal(b.feed.length, 150);
    for (const session of [a, b]) {
      assert.ok(session.feed.every((e) => e.kind !== 'tool.finished' && e.kind !== 'agent.started'));
      for (let i = 1; i < session.feed.length; i++) assert.ok(session.feed[i].ts >= session.feed[i - 1].ts);
    }
    const feedEvents = result.events.filter((e) => e.sessionId === SID && ['session.started', 'tool.started'].includes(e.kind));
    assert.deepEqual(a.feed, feedEvents.slice(-200), 'o feed tem os mesmos eventos devolvidos pelo apply');
  });
});
