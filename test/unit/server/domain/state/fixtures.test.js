// Cenários reais do T0 (test/fixtures/hooks/*.json, sanitizados; commit 166cce5)
// no reducer de estado. Fechamento [T0] do T7 (plano, passo 3 do "Caminho até
// a Primeira luz"; tabela "Fechamento [T0]" do T7).
//
// Cada critério [T0] fecha com o cenário real indicado no plano; o primeiro
// plano (V5, V13) continua com os sintéticos (decisão 15 do usuário), em
// state-spec.test.js e nos testes do dev desta pasta. Os esperados vêm do
// modelo de eventos revisto (seções 4, 5, 7, 8 e 9) e dos payloads; os ids
// opacos (`agent_id`) são lidos dos cenários, na ordem em que aparecem.
//
// O comportamento da retomada (V6) e do StopFailure de subagente fecha no T8
// ("Ajustes do G0b", depois do marco). Aqui, para `aninhado` e `limite-de-uso`,
// confere-se só que nada quebra e que o resultado é o descrito no modelo antes
// desses ajustes: SubagentStart de agente conhecido não gera nada.
//
// Também aqui a permutação do tester, refeita com os cenários reais:
// embaralhar a chegada dentro de janelas de 200 ms dá o mesmo estado final.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../../../../server/domain/normalize.js';
import { apply, getSessionState, getSessionStates, tick } from '../../../../../server/domain/state/index.js';
import { loadFixtureScenarios, scenarioEnvelopes } from '../scenarios.js';
import { START, agentOf, assertAttribution, assertEvents, assertLinks, assertRunShape, newState, run } from './scenarios.js';

/** Pasta pessoal dos cenários sanitizados (o nome do usuário vira "usuario"). */
const FIXTURE_HOME = 'C:\\Users\\usuario';
const WORKER = 'agent-quest-probe:probe-worker';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TOOL_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

const FIXTURES = new Map(loadFixtureScenarios().map(({ file, scenario }) => [file.replace(/\.json$/, ''), scenario]));

function scenarioOf(name) {
  const scenario = FIXTURES.get(name);
  assert.ok(scenario, `cenário ${name} não está em test/fixtures/hooks/`);
  return scenario;
}

/** Estado novo com a pasta pessoal dos cenários. */
const fresh = () => newState({ homeDir: FIXTURE_HOME });

/** Passa o cenário (ou só os eventos antes de `until`) pelo normalizador e pelo reducer. */
const play = (name, options = {}) => run(scenarioOf(name), { state: fresh(), homeDir: FIXTURE_HOME, ...options });

/** Subagentes com tipo, na ordem em que aparecem no cenário (os ids são sintéticos e opacos). */
function subagentIds(scenario) {
  const ids = [];
  for (const { payload } of scenario.events) {
    if (payload.agent_id && payload.agent_type && !ids.includes(payload.agent_id)) ids.push(payload.agent_id);
  }
  return ids;
}

/** O id da única sessão do cenário. */
function onlySession(scenario) {
  const ids = [...new Set(scenario.events.map((event) => event.payload.session_id))];
  assert.equal(ids.length, 1, 'uma sessão só');
  return ids[0];
}

/** Atividade sem a hora. */
const activityOf = (agent) => {
  if (!agent.activity) return null;
  const { at, ...rest } = agent.activity;
  return rest;
};

/**
 * Aplica o cenário um evento por vez e chama `onStep` com o estado já
 * atualizado. Mesmo caminho de `run`, para conferir invariantes passo a passo.
 */
function replay(scenario, onStep) {
  const state = fresh();
  for (const { envelope, receivedAt, event, index } of scenarioEnvelopes(scenario, { start: START })) {
    const fact = normalize(envelope, { receivedAt, homeDir: FIXTURE_HOME });
    const before = fact ? getSessionState(state, fact.sessionId, { feed: false }) : null;
    const result = fact ? apply(state, fact, receivedAt) : { events: [] };
    const after = fact ? getSessionState(state, fact.sessionId, { feed: false }) : null;
    onStep({ index, payload: event.payload, fact, events: result.events, before, after, state });
  }
  return state;
}

describe('[T0] V1, V9: delegação, ferramentas pelo agent_id e fim (segundo-plano, agente-do-projeto)', () => {
  const cases = [
    ['segundo-plano', { type: WORKER, role: 'aux', description: 'Run 15s node timeout', tool: ['Bash', 'bash'], stopIndex: 5 }],
    ['agente-do-projeto', { type: 'documentador', role: 'doc', description: 'Documentador reads CLAUDE.md', tool: ['Read', 'read'], stopIndex: 5 }],
  ];

  for (const [name, expected] of cases) {
    it(`${name}: agent.delegated, agent.started, ferramenta do subagente e agent.finished`, () => {
      const scenario = scenarioOf(name);
      const [sub] = subagentIds(scenario);
      const result = play(name);
      assertRunShape(result);
      assertEvents(result.events, [
        ['agent.delegated', 'main', { toType: expected.type, toRole: expected.role, description: expected.description, background: false }],
        ['agent.started', sub, { agentType: expected.type, role: expected.role, label: expected.description, parentKey: 'main' }],
        ['tool.started', sub, { tool: expected.tool[0], category: expected.tool[1] }],
        ['tool.finished', sub, { tool: expected.tool[0], category: expected.tool[1] }],
        ['agent.finished', sub, { outcome: 'done' }],
      ]);
      // V9: os eventos do subagente chegam com o session_id da sessão principal.
      const sessionId = onlySession(scenario);
      assert.ok(result.events.every((event) => event.sessionId === sessionId));
      assert.equal(getSessionStates(result.state).length, 1);

      const session = getSessionState(result.state, sessionId);
      const instance = agentOf(session, sub);
      assert.deepEqual(
        [instance.status, instance.finished, instance.background, instance.role, instance.label, instance.parentKey],
        ['idle', true, true, expected.role, expected.description, 'main'],
      );
      assert.equal(agentOf(session, 'main').status, 'idle');
      assert.deepEqual(session.roster, ['orq', expected.role]);
    });

    it(`${name}: no Stop com background_tasks o main fica idle e o subagente continua working`, () => {
      const scenario = scenarioOf(name);
      const [sub] = subagentIds(scenario);
      assert.equal(scenario.events[expected.stopIndex].payload.hook_event_name, 'Stop');
      assert.ok(scenario.events[expected.stopIndex].payload.background_tasks.some((task) => task.id === sub));
      const { state } = play(name, { until: expected.stopIndex + 1 });
      const session = getSessionState(state, onlySession(scenario));
      assert.equal(agentOf(session, 'main').status, 'idle');
      const instance = agentOf(session, sub);
      assert.deepEqual([instance.status, instance.finished, instance.background], ['working', false, true]);
    });
  }
});

describe('[T0] V1, V5, V9: dois do mesmo tipo em paralelo (paralelo-mesmo-tipo, vscode)', () => {
  const cases = [
    // [cenário, último índice dos Posts do Agent, rótulos na ordem dos subagentes, ferramentas de cada um]
    ['paralelo-mesmo-tipo', 6, ['Read CLAUDE.md', 'Run node console.log(2)'], [['Read'], ['Bash']]],
    ['vscode', 21, ['Ler CLAUDE.md', 'Rodar console.log(2)'], [['Read', 'SubagentHandback'], ['Bash', 'SubagentHandback']]],
  ];

  for (const [name, lastPost, labels, tools] of cases) {
    it(`${name}: duas instâncias com as descrições certas depois do Post e atribuição pelo agent_id`, () => {
      const scenario = scenarioOf(name);
      const ids = subagentIds(scenario);
      assert.equal(ids.length, 2);
      const sessionId = scenario.events.find((event) => event.payload.agent_id).payload.session_id;

      // Logo depois do último Post do Agent (que chega no lançamento, em segundo plano).
      const early = getSessionState(play(name, { until: lastPost + 1 }).state, sessionId);
      assert.deepEqual(ids.map((id) => agentOf(early, id).label), labels);

      const result = play(name);
      assertRunShape(result);
      assert.ok(assertAttribution(result.steps) >= 4);
      assert.equal(assertLinks(scenario, result.state), 2);
      const session = getSessionState(result.state, sessionId);
      ids.forEach((id, i) => {
        const instance = agentOf(session, id);
        assert.deepEqual([instance.label, instance.parentKey, instance.role, instance.finished, instance.background], [labels[i], 'main', 'aux', true, true], id);
        const used = result.events.filter((event) => event.kind === 'tool.started' && event.agentKey === id).map((event) => event.data.tool);
        assert.deepEqual(used, tools[i], id);
      });
      assert.equal(result.events.filter((event) => event.kind === 'agent.started').length, 2);
      assert.equal(result.events.filter((event) => event.kind === 'agent.delegated').length, 2);
      assert.deepEqual(session.roster, ['orq', 'aux']);
    });
  }
});

describe('[T0] V1: subagente aninhado (aninhado)', () => {
  it('o parentKey do segundo aponta para o primeiro, e a delegação aninhada é do primeiro', () => {
    const scenario = scenarioOf('aninhado');
    const [first, nested] = subagentIds(scenario);
    const result = play('aninhado');
    assertRunShape(result);
    assertEvents(result.events, [
      ['agent.delegated', 'main', { description: 'Delegate CLAUDE.md read' }],
      ['agent.started', first, { label: 'Delegate CLAUDE.md read', parentKey: 'main' }],
      ['agent.delegated', first, { toType: WORKER, description: 'Resumir CLAUDE.md' }],
      ['agent.started', nested, { label: 'Resumir CLAUDE.md', parentKey: first }],
      ['agent.finished', first, { outcome: 'done' }],
      ['tool.started', nested, { tool: 'Read', target: 'CLAUDE.md' }],
      ['tool.finished', nested],
      ['agent.finished', nested, { outcome: 'done' }],
    ]);
    const session = getSessionState(result.state, onlySession(scenario));
    assert.equal(agentOf(session, nested).parentKey, first);
    assert.equal(agentOf(session, first).parentKey, 'main');
  });
});

describe('[T0] V1, V14: fora de ordem (todos os cenários)', () => {
  it('nenhuma chamada gera dois tool.started (nem dois agent.delegated)', () => {
    let calls = 0;
    for (const [name, scenario] of FIXTURES) {
      const result = play(name);
      const seen = new Map();
      for (const event of result.events) {
        if (event.kind !== 'tool.started' && event.kind !== 'agent.delegated') continue;
        const id = event.data.toolUseId;
        assert.ok(id, `${name}: ${event.kind} sem toolUseId`);
        assert.ok(!seen.has(id), `${name}: ${event.kind} repetido para ${id}`);
        seen.set(id, event.kind);
      }
      const ids = new Set(scenario.events.filter((event) => TOOL_HOOKS.has(event.payload.hook_event_name)).map((event) => event.payload.tool_use_id));
      assert.equal(seen.size, ids.size, `${name}: uma abertura por chamada`);
      calls += ids.size;
    }
    assert.ok(calls >= 40, `${calls} chamadas`);
  });

  it('registro: Post antes do Pre e corrida inversa (A4) nos cenários reais', (t) => {
    const postFirst = [];
    const inverse = [];
    for (const [name, scenario] of FIXTURES) {
      const firstHook = new Map();
      const startAt = new Map();
      scenario.events.forEach(({ payload }, index) => {
        if (payload.hook_event_name === 'SubagentStart' && !startAt.has(payload.agent_id)) startAt.set(payload.agent_id, index);
        if (!TOOL_HOOKS.has(payload.hook_event_name) || firstHook.has(payload.tool_use_id)) return;
        firstHook.set(payload.tool_use_id, { hook: payload.hook_event_name, index });
        if (payload.hook_event_name !== 'PreToolUse') postFirst.push(`${name}#${index} ${payload.tool_name}`);
      });
      // A4: o SubagentStart da instância chega antes do Pre da delegação que a lança.
      scenario.events.forEach(({ payload }, index) => {
        if (payload.hook_event_name !== 'PreToolUse' || !AGENT_TOOLS.has(payload.tool_name)) return;
        const post = scenario.events.find((event) => event.payload.hook_event_name === 'PostToolUse' && event.payload.tool_use_id === payload.tool_use_id);
        const linked = post?.payload.tool_response?.agentId;
        if (linked && startAt.get(linked) < index) inverse.push(`${name}#${startAt.get(linked)}`);
      });
    }
    t.diagnostic(`Post antes do Pre: ${postFirst.length} (${postFirst.join(', ')})`);
    t.diagnostic(`corrida inversa (A4): ${inverse.length} (${inverse.join(', ')})`);
    // Contados à mão nos cenários: todos com o Agent, em segundo plano.
    assert.deepEqual(postFirst, [
      'aninhado#1 Agent',
      'aprovacao-subagente#22 Agent',
      'compactacao-com-subagente#1 Agent',
      'interrupcao-esc-subagente#2 Agent',
      'limite-de-uso#1 Agent',
    ]);
    assert.deepEqual(inverse, ['aprovacao-subagente#21', 'interrupcao-esc-subagente#1', 'limite-de-uso#2', 'paralelo-mesmo-tipo#1']);
  });

  it('A4 real (paralelo-mesmo-tipo): o Pre do Agent liga a instância que chegou antes, sem esperar o Post', () => {
    const scenario = scenarioOf('paralelo-mesmo-tipo');
    const [first] = subagentIds(scenario);
    assert.equal(scenario.events[1].payload.hook_event_name, 'SubagentStart');
    assert.equal(scenario.events[2].payload.tool_name, 'Agent');
    const before = getSessionState(play('paralelo-mesmo-tipo', { until: 2 }).state, onlySession(scenario));
    assert.equal(agentOf(before, first).label, WORKER, 'sem delegação, o rótulo é o tipo');
    const after = getSessionState(play('paralelo-mesmo-tipo', { until: 3 }).state, onlySession(scenario));
    assert.deepEqual([agentOf(after, first).label, agentOf(after, first).parentKey], ['Read CLAUDE.md', 'main']);
  });

  it('eventos atrasados depois do Stop não devolvem o main a working até o próximo pedido', () => {
    let checked = 0;
    for (const [name, scenario] of FIXTURES) {
      const turnOver = new Map();
      replay(scenario, ({ index, payload, fact, after }) => {
        if (!fact) return;
        if (payload.hook_event_name === 'UserPromptSubmit' || payload.hook_event_name === 'SessionStart') turnOver.set(fact.sessionId, false);
        const main = after?.agents.find((agent) => agent.key === 'main');
        if ((fact.kind === 'turn.stop' || fact.kind === 'turn.fail') && fact.agentId === null && main?.status === 'idle') turnOver.set(fact.sessionId, true);
        if (turnOver.get(fact.sessionId) && fact.kind !== 'turn.stop' && fact.kind !== 'turn.fail') {
          assert.notEqual(main.status, 'working', `${name}#${index} (${payload.hook_event_name}) devolveu o main a working`);
          checked++;
        }
      });
    }
    assert.ok(checked >= 30, `${checked} eventos depois do Stop`);
  });
});

describe('[T0] V1: servidor iniciado no meio (o teste corta os cenários)', () => {
  /** O cenário a partir do índice `from`, como se o servidor tivesse começado ali. */
  const cut = (scenario, from) => ({ ...scenario, events: scenario.events.slice(from).map((event, i) => (i === 0 ? { ...event, dt: 0 } : event)) });

  it('segundo-plano a partir do Bash do subagente: sessão e agente criados sob demanda', () => {
    const scenario = scenarioOf('segundo-plano');
    const [sub] = subagentIds(scenario);
    assert.equal(scenario.events[6].payload.agent_id, sub);
    const result = run(cut(scenario, 6), { state: fresh(), homeDir: FIXTURE_HOME });
    assertRunShape(result);
    assert.ok(!result.events.some((event) => event.kind === 'session.started'), 'sem session.started');
    assertEvents(result.events, [
      ['agent.started', sub, { agentType: WORKER, role: 'aux', label: WORKER, parentKey: null }],
      ['tool.started', sub, { tool: 'Bash' }],
      ['tool.finished', sub],
      ['agent.finished', sub, { outcome: 'done' }],
    ]);
    const session = getSessionState(result.state, onlySession(scenario));
    assert.deepEqual([session.project.name, session.project.key], ['agents-quest', 'c:/Users/usuario/OneDrive/Documentos/Code/agents-quest']);
    assert.deepEqual(session.agents.map((agent) => agent.key), ['main', sub]);
  });

  it('qualquer corte de qualquer cenário: um agent.started por agente e session.started só com SessionStart', () => {
    let cuts = 0;
    for (const [name, scenario] of FIXTURES) {
      for (let from = 1; from < scenario.events.length; from++) {
        const slice = cut(scenario, from);
        const label = `${name} desde #${from}`;
        const result = run(slice, { state: fresh(), homeDir: FIXTURE_HOME });
        assertRunShape(result);
        const starts = slice.events.filter((event) => event.payload.hook_event_name === 'SessionStart').length;
        assert.equal(result.events.filter((event) => event.kind === 'session.started').length, starts, label);
        for (const session of getSessionStates(result.state)) {
          for (const agent of session.agents.filter((item) => item.key !== 'main')) {
            const started = result.events.filter((event) => event.kind === 'agent.started' && event.agentKey === agent.key);
            assert.equal(started.length, 1, `${label}: agent.started de ${agent.key}`);
          }
        }
        cuts++;
      }
    }
    assert.ok(cuts > 250, `${cuts} cortes`);
  });
});

describe('[T0] V6: SubagentStop de agente interno (agent_type vazio) não gera nada', () => {
  it('nos 16 cenários: nenhum evento, nenhum agente e nenhuma mudança de estado', () => {
    let internal = 0;
    for (const [name, scenario] of FIXTURES) {
      replay(scenario, ({ index, payload, fact, events, before, after }) => {
        if (payload.hook_event_name !== 'SubagentStop' || payload.agent_type !== '') return;
        internal++;
        assert.equal(fact.agentType, null, `${name}#${index}`);
        assert.deepEqual(events, [], `${name}#${index}`);
        assert.deepEqual(after, before, `${name}#${index}`);
        if (after) assert.ok(!after.agents.some((agent) => agent.key === payload.agent_id), `${name}#${index}`);
      });
    }
    // Contados à mão nos cenários (no JSONL bruto do T0 eram 29; os cenários são um recorte).
    assert.equal(internal, 25);
  });
});

describe('[T0] V5: fim da atividade delegate em segundo plano (segundo-plano)', () => {
  it('running do Pre até o Post de lançamento (async_launched); done depois', () => {
    const scenario = scenarioOf('segundo-plano');
    const sessionId = onlySession(scenario);
    const delegate = { kind: 'delegate', category: null, tool: 'Agent', target: WORKER, detail: 'Run 15s node timeout' };
    assert.equal(scenario.events[3].payload.tool_response.status, 'async_launched');
    const beforePost = getSessionState(play('segundo-plano', { until: 3 }).state, sessionId);
    assert.deepEqual(activityOf(agentOf(beforePost, 'main')), { ...delegate, state: 'running' });
    const afterPost = getSessionState(play('segundo-plano', { until: 4 }).state, sessionId);
    assert.deepEqual(activityOf(agentOf(afterPost, 'main')), { ...delegate, state: 'done' });
    assert.equal(agentOf(afterPost, subagentIds(scenario)[0]).background, true);
    // O label do main é '' (sessão sem --agent).
    assert.equal(agentOf(afterPost, 'main').label, '');
  });
});

describe('[T0] aninhado e limite-de-uso passam pelo reducer (resultado de antes dos ajustes do G0b)', () => {
  it('aninhado: o SubagentStart da retomada do primeiro não gera nada, e ele termina uma vez só', () => {
    const scenario = scenarioOf('aninhado');
    const [first] = subagentIds(scenario);
    const result = play('aninhado');
    assertRunShape(result);
    assert.equal(result.steps[15].payload.hook_event_name, 'SubagentStart');
    assert.equal(result.steps[15].payload.agent_id, first);
    assert.deepEqual(result.steps[15].events, []);
    assert.deepEqual(result.steps[16].events, [], 'SubagentStop atrasado depois do fim');
    assert.equal(result.events.filter((event) => event.kind === 'agent.finished' && event.agentKey === first).length, 1);
    const instance = agentOf(getSessionState(result.state, onlySession(scenario)), first);
    assert.deepEqual([instance.status, instance.finished], ['idle', true]);
  });

  it('limite-de-uso: StopFailure de subagente não mexe em nada; o da principal fecha o ticket failed', () => {
    const scenario = scenarioOf('limite-de-uso');
    const [sub] = subagentIds(scenario);
    const sessionId = onlySession(scenario);
    const result = play('limite-de-uso');
    assertRunShape(result);
    const subFail = result.steps[12];
    assert.deepEqual([subFail.payload.hook_event_name, subFail.payload.agent_id], ['StopFailure', sub]);
    assert.deepEqual(subFail.events, []);
    const atSubFail = getSessionState(play('limite-de-uso', { until: 13 }).state, sessionId);
    const beforeSubFail = getSessionState(play('limite-de-uso', { until: 12 }).state, sessionId);
    assert.deepEqual(agentOf(atSubFail, 'main').status, agentOf(beforeSubFail, 'main').status);
    assert.deepEqual(atSubFail.quest, beforeSubFail.quest);
    assert.deepEqual([agentOf(atSubFail, sub).status, agentOf(atSubFail, sub).finished], ['working', false]);

    const mainFail = result.steps[14];
    assert.equal(mainFail.payload.agent_id, undefined);
    assert.deepEqual(mainFail.events.map((event) => [event.kind, event.data.outcome, event.data.error]), [['quest.finished', 'failed', 'rate_limit']]);
    // SubagentStart de agente conhecido e não encerrado (a retomada pelo SendMessage): nada.
    assert.deepEqual([result.steps[21].payload.hook_event_name, result.steps[21].events], ['SubagentStart', []]);
    assert.deepEqual(result.steps[25].events.map((event) => [event.kind, event.agentKey, event.data.outcome]), [['agent.finished', sub, 'done']]);
    const session = getSessionState(result.state, sessionId);
    assert.deepEqual([agentOf(session, sub).status, agentOf(session, sub).finished, agentOf(session, 'main').status], ['idle', true, 'idle']);
  });
});

describe('[T0] V1 em todos os 16 cenários', () => {
  const OWN_KINDS = new Set(['tool.started', 'tool.finished', 'tool.failed', 'test.finished', 'agent.delegated', 'permission.requested']);

  it('fato com agent_id nunca é do main, e fato sem agent_id nunca é de um subagente', () => {
    assert.equal(FIXTURES.size, 16);
    let withAgent = 0;
    let withoutAgent = 0;
    for (const [name, scenario] of FIXTURES) {
      const result = play(name);
      assertRunShape(result);
      assertAttribution(result.steps);
      replay(scenario, ({ index, payload, fact, events, before, after }) => {
        if (!fact) return;
        const label = `${name}#${index} (${payload.hook_event_name})`;
        const owner = payload.agent_id ?? 'main';
        // Ações próprias do agente do fato (ferramenta, delegação, pedido de aprovação).
        for (const event of events.filter((item) => OWN_KINDS.has(item.kind))) assert.equal(event.agentKey, owner, `${label}: ${event.kind}`);
        const mainBefore = before?.agents.find((agent) => agent.key === 'main');
        const mainAfter = after.agents.find((agent) => agent.key === 'main');
        if (payload.agent_id) {
          // O main não é tocado por fato de subagente.
          if (mainBefore) assert.deepEqual([mainAfter.lastEventAt, mainAfter.activity, mainAfter.health], [mainBefore.lastEventAt, mainBefore.activity, mainBefore.health], label);
          withAgent++;
        } else {
          // Nenhum subagente ganha atividade, hora ou saúde por fato sem agent_id.
          for (const agent of after.agents.filter((item) => item.key !== 'main')) {
            const previous = before?.agents.find((item) => item.key === agent.key);
            assert.ok(previous, `${label}: criou o subagente ${agent.key}`);
            assert.deepEqual([agent.lastEventAt, agent.activity, agent.health], [previous.lastEventAt, previous.activity, previous.health], `${label}: ${agent.key}`);
          }
          withoutAgent++;
        }
      });
    }
    assert.ok(withAgent >= 80 && withoutAgent >= 120, `${withAgent} com agent_id, ${withoutAgent} sem`);
  });
});

// ---------------------------------------------------------------------------
// Permutação (critério do tester do T7, [T0]: refeita com os cenários reais)
// ---------------------------------------------------------------------------

/** mulberry32: mesma semente, mesma sequência. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(random, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Eventos do cenário com o instante de cada um (`at`, desde o início), na ordem real. */
function timeline(scenario) {
  let at = 0;
  return scenario.events.map((event, i) => {
    at += event.dt;
    return { ...event, at, i };
  });
}

/** Atraso aleatório de até 200 ms na chegada: eventos a menos de 200 ms podem trocar de ordem. */
function jitterOrder(items, random) {
  return items.map((item) => ({ ...item, arrive: item.at + random() * 200 })).sort((a, b) => a.arrive - b.arrive || a.i - b.i);
}

/** Janelas de 200 ms com a grade deslocada ao acaso e a ordem embaralhada dentro de cada uma. */
function windowOrder(items, random) {
  const offset = random() * 200;
  const groups = new Map();
  for (const item of items) {
    const w = Math.floor((item.at + offset) / 200);
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(item);
  }
  const out = [];
  for (const [w, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const arrive = (w + 1) * 200 - offset;
    for (const item of shuffle(random, group)) out.push({ ...item, arrive: Math.max(arrive, item.at) });
  }
  return out;
}

/**
 * Estado final sem feed, com o status recalculado no mesmo instante. O `ts`
 * de cada fato é o instante real do evento (o `sentAt`); a chegada é o `now`.
 */
function finalState(order, end) {
  const state = fresh();
  for (const item of order) {
    const sentAt = START + item.at;
    const receivedAt = START + (item.arrive ?? item.at);
    const envelope = { v: 1, sentAt, forwarder: '0.1.0', env: item.env, truncated: false, payload: item.payload };
    const fact = normalize(envelope, { receivedAt, homeDir: FIXTURE_HOME });
    if (fact) apply(state, fact, receivedAt);
  }
  tick(state, START + end);
  return getSessionStates(state, { feed: false });
}

/** Caminhos em que dois valores JSON diferem. */
function diffPaths(a, b, where = '$', out = []) {
  if (Object.is(a, b)) return out;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${where}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[key], b[key], Array.isArray(a) ? `${where}[${key}]` : `${where}.${key}`, out);
  return out;
}

/**
 * Só o estado do T7 (sessões, agentes, delegação, saúde, status e roster): sem
 * o ticket, os contadores e os bugs, que são do T8 e fecham depois do marco.
 */
const t7View = (sessions) => sessions.map(({ quest, counters, bugs, ...rest }) => rest);

/** Embaralhamentos com estado final diferente do da ordem real (até 3 exemplos). */
function permutationFailures(name, { seed, count, view = (sessions) => sessions }) {
  const items = timeline(scenarioOf(name));
  const end = items.at(-1).at + 1000;
  const baseline = view(finalState(items, end));
  const random = rng(seed);
  let reordered = 0;
  const failures = [];
  for (const mode of ['jitter', 'janelas']) {
    for (let i = 0; i < count; i++) {
      const order = mode === 'jitter' ? jitterOrder(items, random) : windowOrder(items, random);
      if (order.some((item, j) => item.i !== j)) reordered++;
      const diffs = diffPaths(view(finalState(order, end)), baseline);
      if (diffs.length > 0 && failures.length < 3) failures.push(`${mode}: ${diffs.slice(0, 3).join('; ')}\n  ordem: ${order.map((item) => `${item.i}`).join(' ')}`);
    }
  }
  return { reordered, failures };
}

describe('[T0] permutação: embaralhar a chegada dentro de janelas de 200 ms dá o mesmo estado final', () => {
  const SEED = 20261030;
  const COUNT = 100;

  for (const name of [...FIXTURES.keys()]) {
    it(`${name}: ${COUNT} embaralhamentos por modo, com semente fixa (estado do T7)`, (t) => {
      const { reordered, failures } = permutationFailures(name, { seed: SEED, count: COUNT, view: t7View });
      t.diagnostic(`${reordered} de ${2 * COUNT} ordens diferentes da real`);
      assert.deepEqual(failures, []);
    });
  }

  // Achado do fechamento [T0] do T7, para o T8 (ajustes do G0b, depois do marco).
  // Com o ticket, dois cenários reais dependem da ordem de chegada, porque a
  // regra do Stop atrasado (A-T8-1, seção 6) só cobre o pedido do usuário:
  // - compactacao-com-subagente: o SessionEnd (/clear) chega 50 ms depois do
  //   Stop; se chegar antes, o ticket fecha `interrupted` em vez de `done`;
  // - vscode: o retorno <agent-message> chega 95 ms depois do Stop do turno
  //   anterior; se chegar antes, o ticket reaberto fica com o `endedAt` do
  //   primeiro Stop, e o Stop seguinte não o fecha de novo.
  // Quem resolver (design do T8) tira o `todo`.
  for (const name of ['compactacao-com-subagente', 'vscode']) {
    it(`${name}: estado completo, com o ticket`, { todo: 'corrida do Stop com o SessionEnd e com o retorno do sistema (T8, G0b)' }, () => {
      const { failures } = permutationFailures(name, { seed: SEED, count: COUNT });
      assert.deepEqual(failures, []);
    });
  }

  it('os demais cenários dão o mesmo estado completo, com o ticket', () => {
    for (const name of [...FIXTURES.keys()].filter((item) => !['compactacao-com-subagente', 'vscode'].includes(item))) {
      assert.deepEqual(permutationFailures(name, { seed: SEED, count: COUNT }).failures, [], name);
    }
  });

  it('os cenários de paralelo e de vscode têm ordens realmente trocadas', () => {
    for (const name of ['paralelo-mesmo-tipo', 'vscode']) {
      const items = timeline(scenarioOf(name));
      const random = rng(SEED);
      let reordered = 0;
      for (let i = 0; i < COUNT; i++) if (windowOrder(items, random).some((item, j) => item.i !== j)) reordered++;
      assert.ok(reordered > COUNT / 2, `${name}: ${reordered} de ${COUNT}`);
    }
  });
});
