// Sessões no reducer de estado (T7): projetos, rótulo, status, equipe,
// limpeza, numeração dos eventos e forma do SessionState.
// Os cenários são SINTÉTICOS (formato do ADR 0010).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  apply,
  createSequence,
  createState,
  setAgentNames,
  getSessionState,
  getSessionStates,
  sessionCount,
  tick,
} from '../../../../../server/domain/state/index.js';
import {
  ACTIVE_WINDOW_MS,
  ENDED_TTL_MS,
  FEED_LIMIT,
  IDLE_TTL_MS,
  projectOf,
} from '../../../../../server/domain/state/sessions.js';
import {
  HOME,
  OTHER_PROJECT,
  PROJECT,
  START,
  agent,
  agentOf,
  assertAttribution,
  assertEventShape,
  assertRunShape,
  assertSeqContinuous,
  assertSessionShape,
  newState,
  run,
  scenario,
  sessionId,
  view,
} from './scenarios.js';

const SID = sessionId('principal');
const NEUTRAL_FIXTURE = fileURLToPath(new URL('../../../../fixtures/state/neutro.json', import.meta.url));

describe('duas sessões de projetos diferentes', () => {
  const A = sessionId('sessao-a');
  const B = sessionId('sessao-b');
  const TA = agent('tester-a', 'tester');
  const TB = agent('tester-b', 'tester');
  const scn = scenario('duas-sessoes', 'duas sessões intercaladas, com o mesmo tipo de agente', (b) => {
    b.use('sessao-a', { projectDir: PROJECT });
    b.sessionStart();
    b.prompt('Teste a ingestão');
    const call = b.delegation('tester', 'Testar a ingestão');
    b.pre(call);
    b.use('sessao-b', { projectDir: OTHER_PROJECT, entrypoint: 'claude-vscode' });
    b.sessionStart();
    b.start(TB);
    b.tool('Bash', { command: 'npm test' }, { who: TB });
    b.use('sessao-a', { projectDir: PROJECT, entrypoint: 'cli' });
    b.start(TA);
    b.tool('Read', { file_path: `${PROJECT}\\server\\main.js` }, { who: TA });
    b.use('sessao-b', { projectDir: OTHER_PROJECT, entrypoint: 'claude-vscode' });
    b.tool('Read', { file_path: `${OTHER_PROJECT}src\\loja.js` });
  });

  it('nenhuma atribuição cruzada', () => {
    const result = run(scn);
    const a = getSessionState(result.state, A);
    const b = getSessionState(result.state, B);
    assert.deepEqual(a.agents.map((item) => item.key), ['main', TA.id]);
    assert.deepEqual(b.agents.map((item) => item.key), ['main', TB.id]);
    // O pedido pendente da sessão A não é ligado ao tester da sessão B.
    assert.equal(agentOf(b, TB.id).label, 'tester');
    assert.equal(agentOf(b, TB.id).parentKey, null);
    assert.equal(agentOf(a, TA.id).label, 'Testar a ingestão');
    assert.equal(agentOf(a, TA.id).parentKey, 'main');
    assert.equal(assertAttribution(result.steps), 6);
    for (const event of result.events) {
      const expected = result.steps.find((step) => step.events.includes(event)).payload.session_id;
      assert.equal(event.sessionId, expected);
    }
    assert.equal(sessionCount(result.state), 2);
    assertRunShape(result);
  });

  it('project.key e project.name corretos para caminhos do Windows', () => {
    const result = run(scn);
    assert.deepEqual(getSessionState(result.state, A).project, {
      key: 'c:/Users/fulana/Projetos/agents-quest',
      name: 'agents-quest',
      dir: PROJECT,
    });
    assert.deepEqual(getSessionState(result.state, B).project, {
      key: 'd:/Trabalho/Loja-Ficticia',
      name: 'Loja-Ficticia',
      dir: OTHER_PROJECT,
    });
    assert.equal(getSessionState(result.state, A).client, 'terminal');
    assert.equal(getSessionState(result.state, B).client, 'vscode');
    // Caminhos relativos ao projeto de cada sessão.
    const targets = result.events.filter((event) => event.kind === 'tool.started').map((event) => event.data.target);
    assert.deepEqual(targets, ['npm test', 'server/main.js', 'src/loja.js']);
  });

  it('projectOf: forma canônica da seção 2, pela função do normalizador (T7, ponto 3)', () => {
    const cases = [
      ['C:\\Users\\fulana\\Projetos\\x\\', 'c:/Users/fulana/Projetos/x', 'x'],
      ['c:/Users/fulana/Projetos/x', 'c:/Users/fulana/Projetos/x', 'x'],
      ['\\\\?\\D:\\Trabalho\\Loja', 'd:/Trabalho/Loja', 'Loja'],
      ['\\\\servidor\\compartilhado\\proj', '//servidor/compartilhado/proj', 'proj'],
      ['/home/fulana/proj/', '/home/fulana/proj', 'proj'],
      // MSYS junta com a forma de unidade quando a pasta pessoal tem letra de unidade.
      ['/c/Users/fulana/Projetos/x', 'c:/Users/fulana/Projetos/x', 'x'],
      // Raiz de unidade.
      ['C:\\', 'c:/', 'C:'],
      ['C:/', 'c:/', 'C:'],
      ['D:', 'd:/', 'D:'],
      ['d:', 'd:/', 'D:'],
      ['/c', 'c:/', 'C:'],
    ];
    for (const [dir, key, name] of cases) {
      assert.deepEqual(projectOf(dir, HOME), { key, name, dir }, dir);
    }
    // Sem contexto de unidade, /c/... continua um caminho POSIX.
    assert.equal(projectOf('/c/Users/x', null).key, '/c/Users/x');
    assert.equal(projectOf('/c/Users/x', '/home/fulana').key, '/c/Users/x');
  });

  it('a mesma pasta em formas diferentes é o mesmo projeto: um só newProjects', () => {
    const state = newState();
    const forms = ['C:\\Users\\fulana\\Projetos\\x', 'c:/Users/fulana/Projetos/x/', '/c/Users/fulana/Projetos/x', '\\\\?\\C:\\Users\\fulana\\Projetos\\x'];
    const seen = [];
    forms.forEach((dir, i) => {
      const result = run(scenario(`formas-${i}`, dir, (b) => {
        b.use(`forma-${i}`, { projectDir: dir });
        b.sessionStart();
      }), { state, start: START + i * 1000 });
      seen.push(...result.steps.flatMap((step) => step.newProjects));
    });
    assert.deepEqual(seen, ['c:/Users/fulana/Projetos/x']);
    assert.deepEqual(new Set(getSessionStates(state).map((session) => session.project.key)), new Set(['c:/Users/fulana/Projetos/x']));
  });
});

describe('rótulo e status da sessão', () => {
  it('label = session_title (SessionStart ou pedido), senão "Sessão" + 6 caracteres do id', () => {
    const plain = run(scenario('rotulo-padrao', 'sem título', (b) => b.sessionStart()));
    assert.equal(view(plain.state).label, `Sessão ${SID.slice(0, 6)}`);
    const titled = run(scenario('rotulo-inicio', 'título no SessionStart', (b) => b.sessionStart('resume', { session_title: 'Painel da guilda' })));
    assert.equal(view(titled.state).label, 'Painel da guilda');
    const renamed = run(scenario('rotulo-pedido', 'título no pedido', (b) => {
      b.sessionStart();
      b.prompt('Faça algo', { session_title: 'Revisão do servidor' });
    }));
    assert.equal(view(renamed.state).label, 'Revisão do servidor');
  });

  it('active com agente trabalhando ou evento há menos de 2 min; idle depois; ended no SessionEnd', () => {
    const result = run(scenario('status', 'pedido, Stop e silêncio', (b) => {
      b.sessionStart();
      b.prompt('Leia o CLAUDE.md');
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
      b.stop();
    }));
    const { state, end } = result;
    assert.equal(view(state).status, 'active');
    assert.equal(agentOf(view(state), 'main').status, 'idle');
    // Ainda dentro dos 2 min: nada muda.
    assert.deepEqual(tick(state, end + ACTIVE_WINDOW_MS - 1), { events: [], changed: [], removed: [] });
    const later = tick(state, end + ACTIVE_WINDOW_MS);
    assert.deepEqual(later, { events: [], changed: [SID], removed: [] });
    assert.equal(view(state).status, 'idle');
    // Pedido novo: active de novo, pelo agente trabalhando.
    const prompt = run(scenario('status-2', 'novo pedido', (b) => b.prompt('Outro')), { state, start: end + 10 * 60_000 });
    assert.equal(view(prompt.state).status, 'active');
    // Pedido sem nenhuma ferramenta depois: a regra de 15 min libera o main, sem evento.
    assert.deepEqual(tick(state, prompt.end + ACTIVE_WINDOW_MS), { events: [], changed: [], removed: [] });
    assert.deepEqual(tick(state, prompt.end + 15 * 60_000), { events: [], changed: [SID], removed: [] });
    assert.equal(agentOf(view(state), 'main').status, 'idle');
    assert.equal(view(state).status, 'idle');
  });

  it('SessionEnd deixa a sessão ended e emite session.ended; SessionStart de novo a reabre', () => {
    const result = run(scenario('fim', 'fim e retomada', (b) => {
      b.sessionStart();
      b.sessionEnd('clear');
      b.sessionEnd('other');
    }));
    assert.equal(view(result.state).status, 'ended');
    const ended = result.events.filter((event) => event.kind === 'session.ended');
    assert.deepEqual(ended.map((event) => event.data), [{ reason: 'clear' }]);
    run(scenario('retomada', 'retomada', (b) => b.sessionStart('resume')), { state: result.state, start: result.end + 1000 });
    assert.equal(view(result.state).status, 'active');
  });
});

describe('equipe (roster)', () => {
  const DOC = agent('doc-r', 'documentador');
  const GUEST = agent('guest-r', 'general-purpose');
  const scn = scenario('roster', 'documentador e convidado', (b) => {
    b.sessionStart();
    b.tool('Read', { file_path: `${PROJECT}\\README.md` }, { who: DOC });
    b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: GUEST });
  });

  it('orq + papéis com arquivo em .claude/agents/ + papéis vistos + aux se houver convidado', () => {
    const state = newState();
    const result = run(scn, { state });
    // Até a leitura terminar, só os papéis vistos.
    assert.deepEqual(view(state).roster, ['orq', 'doc', 'aux']);
    const projects = result.steps.flatMap((step) => step.newProjects);
    assert.deepEqual(projects, ['c:/Users/fulana/Projetos/agents-quest'], 'uma vez por projeto, na forma canônica');
    const { changed } = setAgentNames(state, projects[0], ['arquiteto', 'dev-backend', 'tester', 'notas-soltas', 42]);
    assert.deepEqual(changed, [SID]);
    assert.deepEqual(view(state).roster, ['orq', 'arq', 'dev', 'tes', 'doc', 'aux']);
    // Os mesmos nomes de novo: nada muda.
    assert.deepEqual(setAgentNames(state, projects[0], ['tester', 'arquiteto', 'dev-backend']).changed, []);
  });

  it('a leitura que termina antes de outra sessão do mesmo projeto vale para ela, sem nova leitura', () => {
    const state = newState();
    run(scenario('primeira', 'primeira sessão', (b) => b.sessionStart()), { state });
    setAgentNames(state, PROJECT, ['tester']);
    const second = run(scenario('segunda', 'segunda sessão', (b) => {
      b.use('segunda');
      b.sessionStart();
    }), { state, start: START + 1000 });
    assert.deepEqual(second.steps.flatMap((step) => step.newProjects), []);
    assert.deepEqual(getSessionState(state, sessionId('segunda')).roster, ['orq', 'tes']);
  });

  it('só orq sem agentes; convidado sem arquivo; nomes com sobrescrita', () => {
    assert.deepEqual(view(run(scenario('so-orq', 'só a sessão', (b) => b.sessionStart())).state).roster, ['orq']);
    const state = newState({ roleOverrides: { revisor: 'tes' }, agentNames: ['revisor'] });
    run(scenario('sobrescrita', 'arquivo revisor', (b) => b.sessionStart()), { state });
    assert.deepEqual(view(state).roster, ['orq', 'tes']);
  });

  it('nomes inválidos ou projeto vazio não quebram o reducer', () => {
    const state = newState();
    const result = run(scn, { state });
    for (const names of [null, 'tester', [null, 42, '']]) {
      assert.deepEqual(setAgentNames(state, PROJECT, /** @type {any} */ (names)).changed, []);
    }
    assert.deepEqual(setAgentNames(state, '', ['tester']).changed, []);
    assert.deepEqual(view(state).roster, ['orq', 'doc', 'aux']);
    assertRunShape(result);
  });

  it('o createState não lê o disco nem recebe leitor (T7, ponto 10)', () => {
    const state = createState();
    run(scn, { state });
    assert.deepEqual(view(state).roster, ['orq', 'doc', 'aux']);
    assert.ok(!('readAgentNames' in state));
  });
});

describe('tick: limpeza das sessões', () => {
  it('sessão encerrada sai após 30 min; sessão sem eventos, após 6 h', () => {
    const state = newState();
    const ended = run(scenario('limpeza-fim', 'encerrada', (b) => {
      b.use('encerrada');
      b.sessionStart();
      b.sessionEnd();
    }), { state });
    const quiet = run(scenario('limpeza-parada', 'parada', (b) => {
      b.use('parada');
      b.sessionStart();
    }), { state, start: ended.end });
    const endedId = sessionId('encerrada');
    const quietId = sessionId('parada');

    assert.deepEqual(tick(state, ended.end + ENDED_TTL_MS - 1).removed, []);
    const first = tick(state, ended.end + ENDED_TTL_MS);
    assert.deepEqual(first.removed, [endedId]);
    assert.ok(!first.changed.includes(endedId));
    assert.equal(getSessionState(state, endedId), null);

    assert.deepEqual(tick(state, quiet.end + IDLE_TTL_MS - 1).removed, []);
    assert.deepEqual(tick(state, quiet.end + IDLE_TTL_MS).removed, [quietId]);
    assert.equal(sessionCount(state), 0);
  });

  it('um evento depois da limpeza cria a sessão de novo', () => {
    const state = newState();
    const first = run(scenario('volta', 'sessão que volta', (b) => b.sessionStart()), { state });
    tick(state, first.end + IDLE_TTL_MS);
    assert.equal(sessionCount(state), 0);
    run(scenario('volta-2', 'evento novo', (b) => b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` })), { state, start: first.end + IDLE_TTL_MS });
    assert.equal(sessionCount(state), 1);
  });
});

describe('forma do SessionState (seção 9) e valores neutros do recorte (regra 2)', () => {
  it('sessão recém-iniciada: mesmas chaves do snapshot neutro escrito à mão para o painel', () => {
    const result = run(scenario('neutro', 'só o SessionStart', (b) => b.sessionStart()));
    const session = view(result.state);
    assertSessionShape(session, { feed: true });
    const fixture = JSON.parse(readFileSync(NEUTRAL_FIXTURE, 'utf8')).sessions[0];
    assert.deepEqual(Object.keys(session), Object.keys(fixture));
    assert.deepEqual(Object.keys(session.agents[0]), Object.keys(fixture.agents[0]));
    assert.deepEqual(
      { ...session.agents[0], startedAt: 0, lastEventAt: 0 },
      { ...fixture.agents[0], startedAt: 0, lastEventAt: 0 },
    );
    assert.deepEqual(session.roster, ['orq']);
    assert.deepEqual(session.feed.map((event) => event.kind), ['session.started']);
  });

  it('com feed por padrão (snapshot e /api/state); sem feed para o update; sessão desconhecida é null', () => {
    const { state } = run(scenario('formas', 'sessão simples', (b) => b.sessionStart()));
    assertSessionShape(getSessionState(state, SID), { feed: true });
    const update = getSessionState(state, SID, { feed: false });
    assert.ok(!('feed' in update));
    assertSessionShape(update);
    assert.ok('feed' in getSessionStates(state)[0]);
    assert.ok(!('feed' in getSessionStates(state, { feed: false })[0]));
    assert.equal(getSessionState(state, 'nao-existe'), null);
  });

  it('o estado devolvido é uma cópia: mexer nele não muda a memória', () => {
    const { state } = run(scenario('copia', 'sessão simples', (b) => {
      b.sessionStart();
      b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` });
    }));
    const copy = view(state);
    copy.agents[0].activity.state = 'failed';
    copy.agents.pop();
    copy.project.name = 'outro';
    assert.equal(view(state).agents[0].activity.state, 'done');
    assert.equal(view(state).project.name, 'agents-quest');
  });

  it(`feed limitado a ${FEED_LIMIT}, com os mais recentes`, () => {
    const result = run(scenario('feed-cheio', '300 leituras', (b) => {
      b.sessionStart();
      for (let i = 0; i < 300; i++) b.tool('Read', { file_path: `${PROJECT}\\arquivo-${i}.md` });
    }));
    const { feed } = view(result.state);
    assert.equal(feed.length, FEED_LIMIT);
    assert.equal(feed.at(-1).data.target, 'arquivo-299.md');
    assert.equal(feed[0].data.target, 'arquivo-100.md');
  });

  it('apply com relógio ou fato estranhos não lança', () => {
    const state = newState();
    for (const fact of [undefined, 42, {}, { kind: 'tool.pre' }, { kind: 'x', sessionId: SID, ts: 1 }]) {
      assert.doesNotThrow(() => apply(state, /** @type {any} */ (fact), Number.NaN));
    }
    // Tipo desconhecido com sessão válida só cria a sessão.
    assert.equal(sessionCount(state), 1);
    assertSessionShape(getSessionState(state, SID), { feed: true });
  });
});

describe('numeração dos eventos (seção 9; T7, ponto 1)', () => {
  const T = agent('numerado', 'tester');
  const scn = scenario('numeracao', 'vários fatos e um tick', (b) => {
    b.sessionStart();
    b.prompt('Rode os testes');
    const call = b.delegation('tester', 'Testar');
    b.pre(call);
    b.start(T);
    b.tool('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, { who: T });
  });

  it('seq contínuo entre os eventos de vários fatos e de um tick, com o sequence injetado', () => {
    const sequence = createSequence('run7');
    const state = newState({ sequence });
    const result = run(scn, { state });
    const ticked = tick(state, result.end + 15 * 60_000);
    // T8: o fim do último tester fecha a etapa de testes.
    assert.deepEqual(ticked.events.map((event) => event.kind), ['agent.finished', 'quest.phase']);
    const all = [...result.events, ...ticked.events];
    assertSeqContinuous(all);
    assert.equal(all[0].seq, 1);
    assert.equal(sequence.current(), all.length);
    for (const event of all) assertEventShape(event, { runId: 'run7' });
    assert.equal(ticked.events[ticked.events.length - 1].id, `run7:${all.length}`);
  });

  it('o sequence é o mesmo que a ligação usa: um seq reservado fora do reducer não se repete', () => {
    const sequence = createSequence('run7');
    const state = newState({ sequence });
    const first = run(scenario('numeracao-1', 'um evento', (b) => b.sessionStart()), { state });
    const outside = sequence.next(); // por exemplo, um update sem evento publicado pela ligação
    const second = run(scenario('numeracao-2', 'outro', (b) => b.prompt('x')), { state, start: first.end + 10 });
    assert.deepEqual([first.events[0].seq, outside.seq], [1, 2]);
    assert.ok(second.events.every((event) => event.seq > outside.seq));
  });

  it('o feed guarda o mesmo objeto devolvido, já numerado e congelado', () => {
    const state = newState();
    const result = run(scn, { state });
    const { feed } = view(state);
    for (const event of feed) {
      assert.ok(result.events.includes(event), `${event.kind} do feed é o mesmo objeto`);
      assert.ok(Object.isFrozen(event));
      assert.throws(() => { /** @type {any} */ (event).seq = 99; }, TypeError);
    }
    assert.deepEqual(feed.map((event) => event.id), result.events.filter((event) => feed.includes(event)).map((event) => event.id));
    assert.match(feed[0].id, /^local:1$/, 'padrão: contador local');
  });
});
