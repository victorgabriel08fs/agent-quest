// Estado I, leituras do dev decididas em 19/10/2026 (tester, T7): os seis
// pontos que mudam o código, conferidos contra o modelo de eventos (seções 2,
// 4, 6, 7, 8 e 9), a visão geral e o plano (T7, "Leituras do dev decididas"):
// - (1) numeração: `createState({ …, sequence })`, com `next() → { seq, id }`
//   e `current() → seq`; o reducer numera ao criar, e o feed guarda o mesmo
//   objeto, já numerado, que não muda depois;
// - (4) falha do Agent/Task: a delegação pendente sem instância ligada é
//   descartada;
// - (7) SessionEnd libera os agentes: subagentes trabalhando recebem
//   agent.finished(unknown), e o main fica idle;
// - (8) depois da inferência dos 15 min, um tool.pre com toolUseId novo
//   devolve o agente a working, sem evento além do tool.started; depois de
//   SubagentStop, Stop ou SessionEnd, nunca;
// - (10) a leitura de .claude/agents/ sai do domínio, e o padrão do
//   createState passa a ser () => [];
// - (14) agent_id literal "main" é descartado pelo normalizador.
//
// Cenários SINTÉTICOS (state-helpers.js). Pastas e ids fictícios, menos a
// pasta do próprio repositório, calculada na hora.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENT_KEYS,
  HOME,
  MIN,
  PROJECT,
  T0,
  Tracker,
  agent,
  agentIn,
  checkEvent,
  checkState,
  createState,
  getSessionStates,
  kinds,
  normalize,
  play,
  script,
  sessionId,
  setAgentNames,
  tick,
  view,
} from './state-helpers.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SID = sessionId(1);

/** sequence de teste: conta as chamadas e começa de `start`. */
function makeSequence(runId, start = 0) {
  let seq = start;
  let calls = 0;
  return {
    next() {
      calls++;
      seq++;
      return { seq, id: `${runId}:${seq}` };
    },
    current: () => seq,
    get calls() {
      return calls;
    },
  };
}

const stateWith = (sequence) => createState({ sequence });

// ---------------------------------------------------------------------------

describe('ponto 1: o reducer numera cada evento ao criá-lo, pelo sequence injetado', () => {
  const T = agent(801, 'tester');

  function turn() {
    const s = script();
    s.sessionStart(0);
    s.prompt(100);
    const c = s.delegation('tester', 'Testar');
    s.pre(200, c);
    s.start(230, T);
    s.tool(1000, 'Read', { file_path: `${PROJECT}\\a.md` }, T);
    return s.events;
  }

  it('seq contínuo entre os eventos de vários fatos e de um tick, com id = runId:seq e as chaves na ordem da seção 3', () => {
    const sequence = makeSequence('teste', 41);
    const state = stateWith(sequence);
    const result = play(turn(), { state });
    const ticked = tick(state, T0 + 1015 + 15 * MIN);
    const events = [...result.events, ...ticked.events];
    assert.deepEqual(kinds(ticked.events), [['agent.finished', T.id], ['quest.phase', T.id]]);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => 42 + i));
    for (const event of events) {
      assert.deepEqual(Object.keys(event), EVENT_KEYS);
      assert.equal(event.id, `teste:${event.seq}`);
      checkEvent(event, { numbered: true });
    }
    assert.equal(sequence.current(), 41 + events.length);
    assert.equal(sequence.calls, events.length, 'um next() por evento');
  });

  it('fato que não gera evento não consome número', () => {
    const sequence = makeSequence('teste');
    const state = stateWith(sequence);
    const list = turn();
    play(list, { state });
    const before = sequence.calls;
    play(list.slice(-2), { state }); // Pre e Post repetidos: ignorados
    assert.equal(sequence.calls, before);
  });

  it('o feed guarda o mesmo objeto devolvido, já numerado, e ninguém de fora consegue alterá-lo', () => {
    const state = stateWith(makeSequence('teste'));
    const result = play(turn(), { state });
    const { feed } = getSessionStates(state, { feed: true })[0];
    const fed = result.events.filter((e) => feed.includes(e));
    assert.equal(fed.length, feed.length, 'cada evento do feed é o mesmo objeto devolvido pelo apply');
    for (const event of feed) {
      const { seq, id } = event;
      try {
        event.seq = -1;
        event.id = 'outro:1';
        event.data.target = 'alterado';
      } catch {
        // objeto congelado: é o esperado
      }
      const again = getSessionStates(state, { feed: true })[0].feed.find((e) => e.ts === event.ts && e.kind === event.kind);
      assert.equal(again.seq, seq);
      assert.equal(again.id, id);
      assert.notEqual(again.data.target, 'alterado');
    }
  });

  it('sem sequence, o padrão é um contador local com runId fixo, contínuo', () => {
    const state = createState();
    const tracker = new Tracker({ numbered: true });
    const result = play(turn(), { state, tracker });
    const seqs = result.events.map((e) => e.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => seqs[0] + i));
    assert.equal(new Set(result.events.map((e) => e.id.slice(0, e.id.lastIndexOf(':')))).size, 1, 'um único runId');
    checkState(state);
  });
});

describe('ponto 4: falha do Agent descarta a delegação pendente sem instância', () => {
  for (const background of [false, true]) {
    it(`${background ? 'segundo' : 'primeiro'} plano: um SubagentStart posterior do mesmo tipo não se liga à delegação que falhou`, () => {
      const LATE = agent(811 + Number(background), 'tester');
      const s = script();
      s.prompt(0);
      const c = s.delegation('tester', 'Delegação que falhou', { background });
      s.pre(100, c);
      s.fail(150, c, 'Interrompido', { interrupt: true });
      s.start(5000, LATE);
      const result = play(s.events);
      assert.ok(!result.events.some((e) => e.kind === 'tool.failed'), 'falha de delegação não vira tool.failed');
      const session = view(result.state);
      assert.equal(agentIn(session, 'main').activity.state, 'failed');
      const late = agentIn(session, LATE.id);
      assert.equal(late.label, 'tester');
      assert.equal(late.parentKey, null);
      assert.equal(late.background, false);
    });
  }

  it('delegação que já tinha instância: a falha mantém o elo, e a atividade delegate vai para failed', () => {
    const W = agent(813, 'tester');
    const s = script();
    s.prompt(0);
    const c = s.delegation('tester', 'Testar');
    s.pre(100, c);
    s.start(130, W);
    s.fail(2000, c, 'Interrompido', { interrupt: true });
    const session = view(play(s.events).state);
    assert.equal(agentIn(session, W.id).label, 'Testar');
    assert.equal(agentIn(session, W.id).parentKey, 'main');
    assert.equal(agentIn(session, 'main').activity.state, 'failed');
  });
});

describe('ponto 7: SessionEnd libera os agentes', () => {
  const FG = agent(821, 'tester');
  const BG = agent(822, 'documentador');

  function escThenClear() {
    const s = script();
    s.sessionStart(0);
    s.prompt(100, 'Teste tudo');
    const fg = s.delegation('tester', 'Testar');
    s.pre(200, fg);
    s.start(230, FG);
    const bg = s.delegation('documentador', 'Documentar em segundo plano', { background: true });
    s.pre(300, bg);
    s.start(330, BG);
    s.launched(340, bg, BG);
    const running = s.call('Bash', { command: 'npm test' }, FG);
    s.pre(1000, running);
    // Esc: nenhum Stop. Depois, /clear.
    s.sessionEnd(2000, 'clear');
    return { list: s.events, running };
  }

  it('Esc sem Stop seguido de /clear: agent.finished(unknown) para os subagentes trabalhando, main idle, depois session.ended', () => {
    const { list } = escThenClear();
    const tracker = new Tracker();
    const result = play(list, { tracker });
    const last = result.steps.at(-1).events;
    // Cada subagente liberado fecha a etapa dele; depois o ticket aberto termina interrupted (T8) e sai session.ended.
    assert.deepEqual(kinds(last), [['agent.finished', FG.id], ['quest.phase', FG.id], ['agent.finished', BG.id], ['quest.phase', BG.id], ['quest.finished', 'main'], ['session.ended', null]]);
    assert.deepEqual(last.filter((e) => e.kind === 'quest.phase').map((e) => [e.data.phase, e.data.state]), [['test', 'done'], ['docs', 'done']]);
    assert.equal(last[4].data.outcome, 'interrupted');
    assert.deepEqual(last.filter((e) => e.kind === 'agent.finished').map((e) => [e.agentKey, e.data.outcome]).sort(), [[BG.id, 'unknown'], [FG.id, 'unknown']].sort());
    const session = view(result.state);
    assert.equal(session.status, 'ended');
    assert.equal(agentIn(session, 'main').status, 'idle');
    for (const key of [FG.id, BG.id]) {
      assert.equal(agentIn(session, key).status, 'idle', key);
      assert.equal(agentIn(session, key).finished, true, key);
    }
    checkState(result.state);
  });

  it('eventos atrasados depois do SessionEnd atualizam saúde e feed, mas ninguém volta a trabalhar', () => {
    const { list, running } = escThenClear();
    const s = script();
    s.post(2010, running);
    const mainCall = s.call('Read', { file_path: `${PROJECT}\\b.md` });
    s.post(2020, mainCall); // Post atrasado de uma chamada do main, sem o Pre
    s.pre(2030, { ...s.call('Read', { file_path: `${PROJECT}\\c.md` }, FG) }); // tool.pre novo do subagente
    const result = play([...list, ...s.events]);
    const session = view(result.state);
    assert.deepEqual(agentIn(session, FG.id).health, { ok: 1, total: 1 });
    assert.equal(agentIn(session, FG.id).status, 'idle');
    assert.equal(agentIn(session, FG.id).finished, true);
    assert.equal(agentIn(session, 'main').status, 'idle');
    assert.equal(session.status, 'ended');
  });
});

describe('ponto 8: volta depois do encerramento inferido pelos 15 min', () => {
  const T = agent(831, 'tester');

  function inferred() {
    const s = script();
    s.prompt(0);
    const c = s.delegation('tester', 'Testar');
    s.pre(100, c);
    s.start(130, T);
    const old = s.call('Bash', { command: 'npm test' }, T);
    s.pre(1000, old);
    s.post(1100, old);
    const { state } = play(s.events);
    const ticked = tick(state, T0 + 1100 + 15 * MIN);
    assert.deepEqual(kinds(ticked.events), [['agent.finished', T.id], ['quest.phase', T.id]]);
    return { state, old, s };
  }

  it('tool.pre com toolUseId novo devolve o agente a working, com finished false; no feed só o tool.started (a etapa volta a active, T8)', () => {
    const { state } = inferred();
    const s = script();
    const fresh = s.call('Read', { file_path: `${PROJECT}\\volta.md` }, T);
    s.pre(16 * MIN + 2000, { ...fresh, id: 'toolu_01Volta000000000000000' });
    const result = play(s.events, { state });
    assert.deepEqual(kinds(result.events), [['quest.phase', T.id], ['tool.started', T.id]]);
    assert.deepEqual(result.events[0].data.state, 'active');
    assert.ok(!view(state).feed.some((e) => e.kind === 'quest.phase' && e.data.state === 'active'), 'active não vai para o feed');
    const t = agentIn(view(state), T.id);
    assert.equal(t.status, 'working');
    assert.equal(t.finished, false);
  });

  it('quem voltou termina de novo no SubagentStop, com agent.finished(done)', () => {
    const { state } = inferred();
    const s = script();
    s.pre(16 * MIN + 2000, { id: 'toolu_01Volta000000000000001', tool: 'Read', input: { file_path: `${PROJECT}\\v.md` }, who: T });
    s.stopAgent(16 * MIN + 3000, T);
    const result = play(s.events, { state });
    assert.deepEqual(kinds(result.events), [['quest.phase', T.id], ['tool.started', T.id], ['agent.finished', T.id], ['quest.phase', T.id]]);
    assert.equal(result.events[2].data.outcome, 'done');
    assert.equal(result.events[3].data.state, 'done');
  });

  it('atrasos não devolvem: Post de chamada antiga, Pre repetido e Post sem Pre', () => {
    const { state, old } = inferred();
    const s = script();
    s.post(16 * MIN, old);
    s.pre(16 * MIN + 10, old);
    s.post(16 * MIN + 20, { id: 'toolu_01SoPost00000000000000', tool: 'Read', input: { file_path: `${PROJECT}\\x.md` }, who: T });
    play(s.events, { state });
    const t = agentIn(view(state), T.id);
    assert.equal(t.status, 'idle');
    assert.equal(t.finished, true);
  });

  for (const [name, end] of [
    ['SubagentStop', (s) => s.stopAgent(2000, T)],
    ['Stop', (s) => s.stop(2000)],
    ['SessionEnd', (s) => s.sessionEnd(2000)],
  ]) {
    it(`depois de ${name}, nem um tool.pre novo devolve o agente`, () => {
      const s = script();
      s.prompt(0);
      const c = s.delegation('tester', 'Testar');
      s.pre(100, c);
      s.start(130, T);
      end(s);
      s.pre(3000, { id: 'toolu_01Depois0000000000000', tool: 'Read', input: { file_path: `${PROJECT}\\d.md` }, who: T });
      const result = play(s.events);
      const t = agentIn(view(result.state), T.id);
      assert.equal(t.status, 'idle', name);
      assert.equal(t.finished, true, name);
    });
  }
});

describe('ponto 10: a leitura de .claude/agents/ fica fora do domínio', () => {
  it('o estado nunca lê o disco: num projeto com .claude/agents/, sem setAgentNames, o roster fica só com os papéis vistos', () => {
    const names = readdirSync(path.join(REPO, '.claude', 'agents')).filter((n) => n.endsWith('.md'));
    assert.ok(names.length > 0, 'o próprio repositório tem agentes em .claude/agents/');
    const s = script({ projectDir: REPO });
    s.prompt(0);
    const state = createState();
    play(s.events, { state });
    assert.deepEqual(view(state).roster, ['orq']);
  });

  it('nenhum módulo de server/domain/ importa node:fs', () => {
    const root = path.join(REPO, 'server', 'domain');
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(root);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!/from\s+['"](node:)?fs(\/promises)?['"]/.test(text), `${path.relative(REPO, file)} importa node:fs`);
    }
  });

  it('sessions.js não exporta mais a leitura de disco', async () => {
    const sessions = await import('../../server/domain/state/sessions.js');
    assert.equal(sessions.readAgentNamesFromDisk, undefined);
  });

  describe('leitor assíncrono (server/agent-names.js), com pastas temporárias reais e listagens falsas', () => {
    let reader;
    let root;
    let project;
    let home;

    before(async () => {
      reader = await import('../../server/agent-names.js');
      root = mkdtempSync(path.join(os.tmpdir(), 'aq-int-agents-'));
      project = path.join(root, 'projeto');
      home = path.join(root, 'casa');
      mkdirSync(path.join(project, '.claude', 'agents', 'pasta.md'), { recursive: true });
      mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
      writeFileSync(path.join(project, '.claude', 'agents', 'tester.md'), 'CONTEUDO-QUE-NAO-E-LIDO');
      writeFileSync(path.join(project, '.claude', 'agents', 'Documentador.MD'), '');
      writeFileSync(path.join(project, '.claude', 'agents', 'notas.txt'), '');
      writeFileSync(path.join(home, '.claude', 'agents', 'arquiteto.md'), '');
    });

    after(() => rmSync(root, { recursive: true, force: true }));

    /** Temporizadores falsos: o prazo só vence quando o teste manda. */
    function fakeTimers() {
      const pending = new Set();
      return {
        timers: {
          setTimeout: (run) => { const h = { run }; pending.add(h); return h; },
          clearTimeout: (h) => pending.delete(h),
        },
        expire: () => { for (const h of [...pending]) { pending.delete(h); h.run(); } },
        pending: () => pending.size,
      };
    }

    it('lê só os nomes .md do projeto e da pasta pessoal; ligado ao estado por newProjects e setAgentNames, os papéis entram no roster', async () => {
      const { read } = reader.createAgentNamesReader({ homeDir: home, timeoutMs: 10_000 });
      const s = script({ projectDir: project });
      s.prompt(0);
      const state = createState();
      const result = play(s.events, { state });
      const [projectKey] = result.steps[0].newProjects;
      const names = await read(projectKey);
      assert.deepEqual(names.sort(), ['Documentador', 'arquiteto', 'tester']);
      assert.deepEqual(setAgentNames(state, projectKey, names).changed, [SID]);
      assert.deepEqual(view(state).roster, ['orq', 'arq', 'tes'], '"Documentador" não é nome do time (caixa diferente)');
    });

    it('UNC, prefixo \\\\?\\, //, caminho relativo e valores que não são texto não chegam ao disco', async () => {
      const listed = [];
      const { read } = reader.createAgentNamesReader({ homeDir: null, list: (folder) => { listed.push(folder); return ['tester.md']; } });
      for (const dir of ['\\\\servidor\\projetos\\x', '\\\\?\\C:\\x', '\\\\?\\UNC\\srv\\x', '//srv/x', 'relativo\\x', 'C:relativo', '', '   ', null, 42]) {
        assert.deepEqual(await read(dir), [], String(dir));
      }
      assert.deepEqual(listed, []);
    });

    it('cache por pasta: cada pasta é listada uma vez; arquivo novo só aparece com um leitor novo (reinício)', async () => {
      const listed = [];
      const { read } = reader.createAgentNamesReader({ homeDir: home, timeoutMs: 10_000, list: (folder) => { listed.push(folder); return reader.listAgentFiles(folder); } });
      await read(project);
      await read(project);
      assert.equal(listed.length, 2, 'projeto e pasta pessoal, uma vez cada');
      writeFileSync(path.join(project, '.claude', 'agents', 'dev-backend.md'), '');
      assert.ok(!(await read(project)).includes('dev-backend'));
      assert.ok((await reader.createAgentNamesReader({ homeDir: home, timeoutMs: 10_000 }).read(project)).includes('dev-backend'));
    });

    it('listagem que falha, que devolve lixo ou que lança: lista vazia, sem rejeitar', async () => {
      for (const list of [() => { throw new Error('EACCES'); }, () => Promise.reject(new Error('EIO')), () => 'tester.md', () => null, () => [42, null, '.md', 'a.md']]) {
        const { read } = reader.createAgentNamesReader({ homeDir: null, list });
        const names = await read(project);
        assert.ok(Array.isArray(names));
        assert.ok(names.every((n) => n === 'a'), JSON.stringify(names));
      }
    });

    // Atualizado em 19/10/2026 pelo tester do T9a ao contrato novo (modelo de eventos, seção 7, "pasta que
    // nunca responde"; commit 8a74329). A versão anterior afirmava que "uma pasta morta segura a fila", com
    // onLate nunca chamado para a lenta: é o comportamento que o ajuste do leitor eliminou.
    it('listagem lenta ou que nunca responde: o read resolve com [] no prazo; a que passa do limite é perdida, a pasta fica morta e a fila anda; no máximo 2 não terminadas; a perdida que termina tarde chama onLate', async () => {
      const LOST = 10_000;
      const pending = new Set();
      const timers = {
        setTimeout: (run, ms) => { const h = { run, ms, unref() { return this; } }; pending.add(h); return h; },
        clearTimeout: (h) => pending.delete(h),
      };
      /** Dispara só os temporizadores com esse prazo (o do read ou o da listagem perdida). */
      const expire = (ms) => { for (const h of [...pending]) if (h.ms === ms) { pending.delete(h); h.run(); } };
      const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
      const nameOf = (folder) => path.basename(path.dirname(path.dirname(folder)));
      const started = [];
      const releases = new Map();
      const list = (folder) => {
        started.push(nameOf(folder));
        if (nameOf(folder) === 'rapida') return ['tester.md'];
        return new Promise((resolve) => releases.set(nameOf(folder), resolve)); // morta nunca é solta
      };
      const late = [];
      const { read } = reader.createAgentNamesReader({ homeDir: null, list, timers, timeoutMs: 500, lostAfterMs: LOST, onLate: (dir, names) => late.push([path.basename(dir), names]) });

      // Prazo do read: lista vazia, sem esperar a listagem.
      const morta = read(path.join(root, 'morta'));
      expire(500);
      assert.deepEqual(await morta, [], 'prazo vencido: lista vazia');
      // Uma listagem por vez: a lenta espera na fila enquanto a morta não é dada como perdida.
      const lenta = read(path.join(root, 'lenta'));
      await settle();
      assert.deepEqual(started, ['morta']);
      expire(500);
      assert.deepEqual(await lenta, []);
      // A morta passa do limite: é perdida, e a fila anda.
      expire(LOST);
      await settle();
      assert.deepEqual(started, ['morta', 'lenta'], 'a pasta seguinte não espera a travada para sempre');
      // A pasta morta responde [] na hora, sem nova listagem.
      assert.deepEqual(await read(path.join(root, 'morta')), []);
      // A lenta também é perdida: com 2 listagens não terminadas, a terceira não começa e recebe [] no prazo.
      expire(LOST);
      const rapida = read(path.join(root, 'rapida'));
      await settle();
      assert.deepEqual(started, ['morta', 'lenta'], 'no máximo 2 listagens não terminadas');
      expire(500);
      assert.deepEqual(await rapida, []);
      // A lenta, perdida, termina tarde: deixa de estar morta, vai para o cache, chama onLate e libera a vaga.
      releases.get('lenta')(['revisor.md']);
      await settle();
      assert.deepEqual(late.find(([dir]) => dir === 'lenta'), ['lenta', ['revisor']]);
      assert.deepEqual(await read(path.join(root, 'lenta')), ['revisor'], 'cache');
      assert.deepEqual(started, ['morta', 'lenta', 'rapida'], 'a vaga liberada deixa a fila andar');
      assert.deepEqual(late.find(([dir]) => dir === 'rapida'), ['rapida', ['tester']], 'a que ficou devendo recebe pelo onLate');
      assert.equal(late.some(([dir]) => dir === 'morta'), false, 'a morta nunca terminou');
    });

    it('listagem lenta que termina depois do prazo: o cache guarda o resultado, e onLate entrega os nomes do projeto', async () => {
      const clock = fakeTimers();
      let release;
      const slow = new Promise((resolve) => { release = resolve; });
      const late = [];
      const { read } = reader.createAgentNamesReader({ homeDir: null, list: () => slow, timers: clock.timers, onLate: (dir, names) => late.push([dir, names]) });
      const first = read(project);
      clock.expire();
      assert.deepEqual(await first, []);
      release(['tester.md', 'notas.txt']);
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(late, [[project, ['tester']]]);
      assert.deepEqual(await read(project), ['tester'], 'cache');
      assert.equal(clock.pending(), 0);
    });

    it('os .md são filtrados antes do limite de 200 nomes', async () => {
      const entries = [...Array.from({ length: 300 }, (_, i) => `nota-${i}.txt`), ...Array.from({ length: 250 }, (_, i) => `agente-${i}.md`)];
      const { read } = reader.createAgentNamesReader({ homeDir: null, list: () => entries });
      const names = await read(project);
      assert.equal(names.length, reader.MAX_AGENT_FILES);
      assert.ok(names.every((n) => n.startsWith('agente-')));
    });
  });
});

describe('ponto 14: agent_id literal "main" é descartado pelo normalizador', () => {
  const HOOKS_WITH_AGENT = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Notification', 'UserPromptSubmit', 'Stop'];

  it('em todo hook, o evento com agent_id "main" vira null', () => {
    for (const hook of HOOKS_WITH_AGENT) {
      const envelope = {
        v: 1, sentAt: T0, env: { projectDir: PROJECT }, truncated: false,
        payload: { hook_event_name: hook, session_id: SID, agent_id: 'main', agent_type: 'tester', tool_name: 'Read', tool_input: { file_path: 'a.md' }, tool_use_id: 'toolu_01main' },
      };
      assert.equal(normalize(envelope, { receivedAt: T0, homeDir: HOME }), null, hook);
    }
  });

  it('pelo reducer, um subagente com agent_id "main" não mexe na sessão principal', () => {
    const s = script();
    s.prompt(0);
    s.stop(100);
    s.tool(200, 'Read', { file_path: `${PROJECT}\\a.md` }, { id: 'main', type: 'tester' });
    s.stopAgent(300, { id: 'main', type: 'tester' });
    const result = play(s.events);
    assert.ok(result.steps.slice(2).every((step) => step.fact === null));
    const main = agentIn(view(result.state), 'main');
    assert.equal(main.status, 'idle');
    assert.deepEqual(main.health, { ok: 0, total: 0 });
    assert.equal(main.agentType, null);
  });

  it('"Main" e "MAIN" continuam válidos e são instâncias próprias, nunca o main', () => {
    for (const id of ['Main', 'MAIN', 'main1']) {
      const s = script();
      s.tool(0, 'Read', { file_path: `${PROJECT}\\a.md` }, { id, type: 'tester' });
      const session = view(play(s.events).state);
      assert.deepEqual(session.agents.map((a) => a.key), ['main', id]);
      assert.deepEqual(agentIn(session, 'main').health, { ok: 0, total: 0 });
    }
  });
});
