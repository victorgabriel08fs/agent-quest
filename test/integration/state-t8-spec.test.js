// Estado II contra a especificação (tester, T8): tickets, etapas, aprovações,
// bugs, compactação e interrupção, do envelope ao estado, passando pelo
// normalizador real (com a detecção de testes do T6). Cenários próprios,
// escritos a partir de docs/arquitetura/modelo-de-eventos.md (seções 3, 4, 6, 8
// e 9, com as confirmações de 19/10/2026) e do T8 em docs/plano/v1.md. Os
// marcados [T0] usam cenários SINTÉTICOS e fecham com as fixtures reais.
//
// Cobre os critérios do T8, as escolhas confirmadas (inclusive as sete
// guardas), os ajustes de 19/10/2026 (cadeia && sem contagem e o
// PermissionRequest fora da deduplicação, este com o servidor real), casos
// adversos, permutação, invariantes e o desempenho pelo complemento do ADR 0010.
//
// Pastas, nomes e ids são fictícios (o repositório é público).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import {
  HOME,
  MIN,
  PROJECT,
  T0,
  Tracker,
  agent,
  agentIn,
  apply,
  checkState,
  diffPaths,
  envelopeOf,
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
  tick,
  view,
  windowOrder,
  withoutFeed,
} from './state-helpers.js';
import { cleanupTemps, newTemp, readJson, startRealServer } from './capture-helpers.js';
import { request, waitFor } from './server-helpers.js';

const SID = sessionId(1);
const GHP = `ghp_${'K'.repeat(36)}`;
const of = (events, kind) => events.filter((e) => e.kind === kind);
const lastStep = (result) => result.steps.at(-1).events;

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

describe('[T0] V8: ticket do pedido do usuário', () => {
  it('começa no pedido: questId = prompt_id, n por sessão, título redigido (primeira linha, até 80; comando com /)', () => {
    const s = script();
    s.prompt(0, `Implementar a ingestão com token=${GHP}\nSEGUNDA-LINHA-PRIVADA`);
    const p1 = s.promptId();
    s.stop(1000);
    s.prompt(2000, '/review agora com detalhes');
    s.use({ session: sessionId(2) });
    s.prompt(3000, 'x'.repeat(200));
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    const started = of(result.events, 'quest.started');
    assert.deepEqual(started.map((e) => [e.sessionId, e.data.n, e.data.implicit]), [[SID, 1, false], [SID, 2, false], [sessionId(2), 1, false]]);
    assert.equal(started[0].data.questId, p1);
    assert.equal(started[0].data.title, 'Implementar a ingestão com token=•••');
    assert.equal(started[1].data.title, '/review');
    assert.equal(Array.from(started[2].data.title).length, 80);
    const all = JSON.stringify({ s: getSessionStates(result.state), e: result.events });
    assert.ok(!all.includes('KKKKKKKK') && !all.includes('SEGUNDA-LINHA-PRIVADA'));
    assert.deepEqual(view(result.state).counters, { questsDone: 1, bugsCrushed: 0, pendingApprovals: 0 });
    checkState(result.state);
  });

  it('termina done (Stop), failed (StopFailure, com o tipo do erro) e interrupted (novo pedido, idle_prompt, SessionEnd)', () => {
    const s = script();
    s.prompt(0, 'A');
    s.stop(100);
    s.prompt(200, 'B');
    s.stopFailure(300, 'overloaded');
    s.prompt(400, 'C');
    s.prompt(500, 'D'); // C sem Stop
    s.notice(600, 'idle_prompt'); // D sem Stop
    s.prompt(700, 'E');
    s.sessionEnd(800, 'other');
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    const finished = of(result.events, 'quest.finished').map((e) => [e.data.n, e.data.outcome, e.data.error]);
    assert.deepEqual(finished, [[1, 'done', null], [2, 'failed', 'overloaded'], [3, 'interrupted', null], [4, 'interrupted', null], [5, 'interrupted', null]]);
    assert.deepEqual(kinds(result.steps[5].events), [['quest.finished', 'main'], ['quest.started', 'main']], 'novo pedido: fecha o anterior e abre o novo');
    assert.deepEqual(kinds(result.steps[6].events), [['quest.finished', 'main'], ['session.idle', null]]);
    assert.deepEqual(kinds(result.steps[8].events), [['quest.finished', 'main'], ['session.ended', null]]);
    const session = view(result.state);
    assert.equal(session.counters.questsDone, 1, 'só o done conta');
    assert.equal(session.quest.status, 'interrupted');
    checkState(result.state);
  });

  it('atividade sem ticket abre implícito; promptId de ticket encerrado não reabre; atraso sem promptId não abre (guarda 6)', () => {
    const s = script({ promptIds: false });
    s.tool(0, 'Read', { file_path: `${PROJECT}\\a.md` });
    s.stop(500);
    const late = s.call('Read', { file_path: `${PROJECT}\\atrasado.md` });
    s.pre(400, late); // ts antes do fim do ticket: atraso
    s.post(410, late);
    s.prompt(1000, 'Pedido P', { prompt_id: '9a0e0000-0000-4000-8000-00000000c0de' });
    s.stop(2000);
    s.hook(2100, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: `${PROJECT}\\b.md` }, tool_use_id: 'toolu_01DoP', prompt_id: '9a0e0000-0000-4000-8000-00000000c0de' });
    s.tool(3000, 'Read', { file_path: `${PROJECT}\\c.md` });
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    const started = of(result.events, 'quest.started').map((e) => [e.data.n, e.data.title, e.data.implicit]);
    assert.deepEqual(started, [[1, 'Tarefa em andamento', true], [2, 'Pedido P', false], [3, 'Tarefa em andamento', true]]);
    assert.deepEqual(kinds(result.steps[3].events), [['tool.started', 'main']], 'o atraso entra no feed, sem abrir ticket');
    assert.deepEqual(kinds(result.steps[7].events), [['tool.started', 'main']], 'promptId de ticket encerrado não reabre');
    assert.equal(of(result.events, 'quest.finished').find((e) => e.data.n === 1).data.actions, 1, 'o atraso não conta ações');
    checkState(result.state);
  });

  it('pedido com prompt_id já conhecido não muda nada, aberto ou encerrado (guarda 1)', () => {
    const s = script();
    s.prompt(0, 'Pedido');
    const repeat = { ...s.events[0], at: 50 };
    s.tool(100, 'Read', { file_path: `${PROJECT}\\a.md` });
    s.stop(500);
    const result = play([...s.events.slice(0, 1), repeat, ...s.events.slice(1), { ...s.events[0], at: 600 }]);
    assert.deepEqual(result.steps[1].events, []);
    assert.deepEqual(result.steps.at(-1).events, []);
    const session = view(result.state);
    assert.equal(session.quest.status, 'done');
    assert.equal(agentIn(session, 'main').status, 'idle', 'o pedido repetido não devolve o main a trabalhar');
  });
});

describe('[T0] V7, [G0b]: pedido de origem do sistema', () => {
  const NOTE = '<task-notification><task-id>tarefa-1</task-id><status>completed</status></task-notification>';
  const BG = agent(801, 'tester');

  it('reabre o ticket em waiting_background, sem evento; o Stop final o encerra em done (V13)', () => {
    const s = script();
    s.prompt(0, 'Teste em segundo plano');
    const p = s.promptId();
    const c = s.delegation('tester', 'Testar', { background: true });
    s.pre(100, c);
    s.start(130, BG);
    s.launched(140, c, BG);
    s.stop(1000, [{ id: BG.id, type: 'local_agent', status: 'running', agent_type: 'tester' }]);
    s.stopAgent(5000, BG);
    s.prompt(5100, NOTE, { prompt_id: '9a0e0000-0000-4000-8000-0000000005e1' });
    s.stop(6000, []);
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.deepEqual(kinds(result.steps[4].events), [], 'Stop com tarefa ativa: sem evento');
    assert.equal(view(play(s.events.slice(0, 5)).state).quest.status, 'waiting_background');
    assert.deepEqual(result.steps[6].events, [], 'o retorno reabre sem evento');
    assert.deepEqual(of(result.events, 'quest.started').length, 1, 'não abre outro ticket');
    const final = of(result.events, 'quest.finished');
    assert.deepEqual(final.map((e) => [e.data.questId, e.data.outcome]), [[p, 'done']]);
    assert.equal(view(result.state).counters.questsDone, 1);
    checkState(result.state);
  });

  it('reabre o último encerrado há menos de 30 min; depois disso (ou sem ticket), abre o implícito "Retorno de tarefa em segundo plano"', () => {
    const s = script();
    s.prompt(0, 'Pedido');
    const p = s.promptId();
    s.stop(1000);
    s.prompt(1000 + 10 * MIN, NOTE, { prompt_id: '9a0e0000-0000-4000-8000-0000000005e2' });
    s.stop(1000 + 11 * MIN);
    s.prompt(1000 + 45 * MIN, NOTE, { prompt_id: '9a0e0000-0000-4000-8000-0000000005e3' });
    const result = play(s.events);
    assert.deepEqual(result.steps[2].events, [], 'reaberto sem evento');
    assert.deepEqual(of(result.events, 'quest.finished').map((e) => [e.data.questId, e.data.outcome]), [[p, 'done'], [p, 'done']]);
    assert.equal(view(result.state).counters.questsDone, 1, 'o mesmo ticket conta uma vez');
    const implicit = of(result.events, 'quest.started').at(-1).data;
    assert.deepEqual([implicit.n, implicit.title, implicit.implicit], [2, 'Retorno de tarefa em segundo plano', true]);
    const fresh = script({ session: sessionId(3) });
    fresh.prompt(0, NOTE);
    assert.equal(of(play(fresh.events).events, 'quest.started')[0].data.title, 'Retorno de tarefa em segundo plano');
  });

  it('prompt que não é texto (origin null) conta como do usuário: abre ticket com título vazio', () => {
    const s = script();
    s.prompt(0, [{ type: 'image' }]);
    const result = play(s.events);
    assert.deepEqual(of(result.events, 'quest.started')[0].data.title, '');
    assert.equal(view(result.state).quest.title, '');
    assert.equal(view(result.state).label, `Sessão ${SID.slice(0, 6)}`, 'título vazio não vira rótulo');
    checkState(result.state);
  });

  it('valores fora da lista (source, reason, trigger, type do aviso) chegam null e não quebram o reducer', () => {
    const s = script();
    s.sessionStart(0, 'inventado');
    s.prompt(100);
    s.preCompact(200, 'inventado');
    s.postCompact(300, 'inventado');
    s.notice(400, 'inventado');
    s.sessionEnd(500, 'inventado');
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.equal(of(result.events, 'session.started')[0].data.source, null);
    assert.equal(of(result.events, 'context.compacted')[0].data.trigger, null);
    assert.equal(of(result.events, 'session.ended')[0].data.reason, null);
    assert.deepEqual(result.steps[4].events, [], 'aviso de tipo fora da lista não gera evento');
    checkState(result.state);
  });

  it('Stop com tarefas: só status de fim conhecido conta como encerrada; status ausente ou desconhecido mantém o ticket em espera', () => {
    for (const [status, expected] of [['completed', 'done'], ['failed', 'done'], ['killed', 'done'], ['running', 'waiting_background'], [null, 'waiting_background'], ['inventado', 'waiting_background']]) {
      const s = script();
      s.prompt(0);
      s.stop(100, [{ id: 'tarefa-1', type: 'local_bash', status, agent_type: null }]);
      assert.equal(view(play(s.events).state).quest.status, expected, String(status));
    }
  });
});

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------

describe('etapas: active no início da instância, done quando termina a última, reativação', () => {
  it('quest.phase nas transições; delegação que falha não prende a etapa; só o done vai ao feed', () => {
    const [T1, T2, T3] = [agent(811, 'tester'), agent(812, 'tester'), agent(813, 'tester')];
    const s = script();
    s.prompt(0);
    const c1 = s.delegation('tester', 'Parte 1');
    s.pre(100, c1); // 1
    s.start(130, T1); // 2
    const c2 = s.delegation('tester', 'Parte 2');
    s.pre(200, c2); // 3
    s.start(230, T2); // 4
    s.stopAgent(1000, T1); // 5
    s.stopAgent(2000, T2); // 6
    const c3 = s.delegation('tester', 'Parte 3');
    s.pre(3000, c3); // 7
    s.start(3030, T3); // 8
    s.stopAgent(4000, T3); // 9
    const c4 = s.delegation('arquiteto', 'Desenho que falha');
    s.pre(5000, c4); // 10
    s.fail(5100, c4, 'Interrompido', { interrupt: true }); // 11
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    const phases = (i) => of(result.steps[i].events, 'quest.phase').map((e) => [e.agentKey, e.data.phase, e.data.state]);
    assert.deepEqual(phases(1), [], 'a delegação não ativa a etapa');
    assert.deepEqual(phases(2), [[T1.id, 'test', 'active']]);
    assert.deepEqual(phases(4), [], 'já ativa');
    assert.deepEqual(phases(5), [], 'outro tester ainda em execução');
    assert.deepEqual(phases(6), [[T2.id, 'test', 'done']]);
    assert.deepEqual(phases(8), [[T3.id, 'test', 'active']], 'nova instância reativa');
    assert.deepEqual(phases(9), [[T3.id, 'test', 'done']]);
    assert.deepEqual(phases(10).concat(phases(11)), []);
    const session = view(result.state);
    assert.deepEqual(session.quest.phases, { design: 'pending', code: 'pending', test: 'done', docs: 'pending' });
    assert.ok(session.feed.filter((e) => e.kind === 'quest.phase').every((e) => e.data.state === 'done'));
    checkState(result.state);
  });

  it('papéis sem etapa (aux, orq) não emitem quest.phase; cada papel do time tem a sua', () => {
    const team = [agent(821, 'arquiteto'), agent(822, 'dev-backend'), agent(823, 'tester'), agent(824, 'documentador'), agent(825, 'Explore')];
    const s = script();
    s.prompt(0);
    team.forEach((w, i) => s.start(100 + i, w));
    const result = play(s.events);
    assert.deepEqual(of(result.events, 'quest.phase').map((e) => e.data.phase), ['design', 'code', 'test', 'docs']);
  });
});

// ---------------------------------------------------------------------------
// Aprovações
// ---------------------------------------------------------------------------

describe('[T0] V2, V4: aguardando aprovação', () => {
  it('na sessão principal: main e sessão waiting; Post da chamada → approved (user); pendingApprovals volta a 0', () => {
    const s = script();
    s.prompt(0);
    const c = s.call('Bash', { command: 'rm -rf build', description: 'Limpar' });
    s.pre(100, c);
    s.permissionRequest(120, c);
    s.post(5000, c);
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.deepEqual(kinds(result.steps[2].events), [['permission.requested', 'main']]);
    assert.deepEqual(result.steps[2].events[0].data, { tool: 'Bash', category: 'bash', target: 'rm -rf build' });
    const waiting = view(play(s.events.slice(0, 3)).state);
    assert.equal(waiting.status, 'waiting');
    assert.equal(agentIn(waiting, 'main').status, 'waiting');
    assert.deepEqual(agentIn(waiting, 'main').waitingFor, { tool: 'Bash', category: 'bash', target: 'rm -rf build' });
    assert.equal(waiting.counters.pendingApprovals, 1);
    assert.deepEqual(kinds(lastStep(result)), [['tool.finished', 'main'], ['permission.resolved', 'main']]);
    assert.deepEqual(lastStep(result)[1].data, { outcome: 'approved', by: 'user' });
    const session = view(result.state);
    assert.equal(session.counters.pendingApprovals, 0);
    assert.equal(agentIn(session, 'main').status, 'working');
    assert.equal(session.status, 'active');
    checkState(result.state);
  });

  it('num subagente: pelo agent_id do pedido (V2) ou, sem ele, pela chamada aberta com o mesmo tool e inputHash; Failure também é approved', () => {
    const [W, X] = [agent(831, 'tester'), agent(832, 'dev-backend')];
    const s = script();
    s.prompt(0);
    s.start(10, W);
    s.start(20, X);
    const cw = s.call('Bash', { command: 'npm publish' }, W);
    s.pre(100, cw);
    s.permissionRequest(110, cw); // com agent_id
    const cx = s.call('Write', { file_path: `${PROJECT}\\x.md`, content: 'CONTEUDO-PRIVADO' }, X);
    s.pre(200, cx);
    s.permissionRequest(210, cx, null); // sem agent_id: heurística pelo inputHash
    const tracker = new Tracker();
    const mid = play(s.events, { tracker });
    let session = view(mid.state);
    assert.deepEqual([agentIn(session, W.id).status, agentIn(session, X.id).status, agentIn(session, 'main').status], ['waiting', 'waiting', 'working']);
    assert.equal(session.counters.pendingApprovals, 2);
    assert.deepEqual(agentIn(session, X.id).waitingFor, { tool: 'Write', category: 'write', target: 'x.md' });
    const t = script();
    t.fail(300, cw, 'Exit code 1');
    t.post(400, cx);
    const end = play(t.events, { state: mid.state, tracker });
    assert.deepEqual(end.events.filter((e) => e.kind === 'permission.resolved').map((e) => [e.agentKey, e.data.outcome, e.data.by]), [[W.id, 'approved', 'user'], [X.id, 'approved', 'user']]);
    session = view(mid.state);
    assert.equal(session.counters.pendingApprovals, 0);
    assert.ok(!JSON.stringify(getSessionStates(mid.state)).includes('CONTEUDO-PRIVADO'));
    checkState(mid.state);
  });

  it('outra ação do mesmo agente sem Post → unknown (inferred), só se o ts da chamada nova for maior ou igual ao do pedido (guarda 4)', () => {
    const s = script();
    s.prompt(0);
    const c1 = s.call('Bash', { command: 'git push' });
    s.pre(100, c1);
    s.permissionRequest(200, c1);
    const parallel = s.call('Read', { file_path: `${PROJECT}\\a.md` });
    s.pre(150, parallel); // em paralelo, chegou atrasada: não resolve
    const next = s.call('Read', { file_path: `${PROJECT}\\b.md` });
    s.pre(300, next);
    const result = play(s.events);
    assert.deepEqual(of(result.steps[3].events, 'permission.resolved'), []);
    assert.deepEqual(of(result.steps[4].events, 'permission.resolved').map((e) => e.data), [{ outcome: 'unknown', by: 'inferred' }]);
    assert.equal(view(result.state).counters.pendingApprovals, 0);
  });

  it('PermissionDenied → denied (auto), mesmo sem pedido; encerra a chamada: atividade failed, sem tool.failed, sem saúde; Failure depois é ignorado', () => {
    const s = script();
    s.prompt(0);
    const c = s.call('Bash', { command: 'curl evil.example' });
    s.pre(100, c);
    s.permissionRequest(110, c);
    s.permissionDenied(120, c);
    s.fail(130, c, 'Permissão negada');
    const lone = s.call('Bash', { command: 'rm -rf /' });
    s.pre(200, lone);
    s.permissionDenied(210, lone);
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.deepEqual(kinds(result.steps[3].events), [['permission.resolved', 'main']]);
    assert.deepEqual(result.steps[3].events[0].data, { outcome: 'denied', by: 'auto' });
    assert.deepEqual(result.steps[4].events, [], 'o Failure da chamada negada é ignorado');
    assert.deepEqual(kinds(result.steps[6].events), [['permission.resolved', 'main']], 'denied sem pedido pendente');
    const main = agentIn(view(result.state), 'main');
    assert.equal(main.activity.state, 'failed');
    assert.deepEqual(main.health, { ok: 0, total: 0 });
    assert.equal(of(result.events, 'tool.failed').length, 0);
    checkState(result.state);
  });

  it('fim do agente, fim do turno e novo pedido do usuário resolvem como unknown; o pedido do sistema não resolve', () => {
    const W = agent(841, 'tester');
    const s = script();
    s.prompt(0);
    s.start(10, W);
    const cw = s.call('Bash', { command: 'npm publish' }, W);
    s.pre(100, cw);
    s.permissionRequest(110, cw);
    s.stopAgent(200, W); // 4
    const cm = s.call('Bash', { command: 'git push' });
    s.pre(300, cm);
    s.permissionRequest(310, cm);
    s.prompt(400, '<task-notification>volta</task-notification>', { prompt_id: '9a0e0000-0000-4000-8000-0000000005e9' }); // 7
    s.prompt(500, 'Novo pedido do usuário'); // 8
    const cs = s.call('Bash', { command: 'git tag' });
    s.pre(600, cs);
    s.permissionRequest(610, cs);
    s.stop(700); // 11
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.deepEqual(kinds(result.steps[4].events).slice(0, 2), [['permission.resolved', W.id], ['agent.finished', W.id]]);
    assert.deepEqual(of(result.steps[7].events, 'permission.resolved'), [], 'pedido do sistema não resolve');
    assert.deepEqual(of(result.steps[8].events, 'permission.resolved').map((e) => e.data.outcome), ['unknown']);
    assert.deepEqual(of(result.steps[11].events, 'permission.resolved').map((e) => e.data.outcome), ['unknown']);
    assert.equal(view(result.state).counters.pendingApprovals, 0);
    checkState(result.state);
  });

  it('aviso permission_prompt sem pedido pendente: main waiting com a chamada aberta, ou waitingFor genérico; com pedido pendente, nada', () => {
    const generic = script();
    generic.prompt(0);
    generic.notice(100, 'permission_prompt');
    let result = play(generic.events);
    assert.deepEqual(kinds(lastStep(result)), [['permission.requested', 'main']]);
    assert.deepEqual(agentIn(view(result.state), 'main').waitingFor, { tool: '', category: 'other', target: null });
    const open = script();
    open.prompt(0);
    const c = open.call('Bash', { command: 'npm install' });
    open.pre(50, c);
    open.notice(100, 'permission_prompt');
    open.permissionRequest(110, c); // o pedido de verdade, depois do aviso: duplicata
    open.notice(120, 'permission_prompt');
    result = play(open.events);
    assert.deepEqual(agentIn(view(result.state), 'main').waitingFor, { tool: 'Bash', category: 'bash', target: 'npm install' });
    assert.deepEqual(result.steps[3].events, [], 'o PermissionRequest da mesma chamada não abre outra espera');
    assert.deepEqual(result.steps[4].events, [], 'aviso com pedido pendente não faz nada');
    assert.equal(view(result.state).counters.pendingApprovals, 1);
  });

  it('guardas 2, 3, 5 e 7: pedido repetido, pedido atrasado de quem não trabalha, waiting não cai nos 15 min, removido pelo limite vira unknown', () => {
    const W = agent(851, 'tester');
    const s = script();
    s.prompt(0);
    const c = s.call('Bash', { command: 'git push' });
    s.pre(100, c);
    s.permissionRequest(110, c);
    s.permissionRequest(115, c); // guarda 2: mesmo pedido
    const late = script();
    late.stop(200);
    late.permissionRequest(300, c); // guarda 3: main depois do Stop
    const tracker = new Tracker();
    const r1 = play(s.events, { tracker });
    assert.equal(of(r1.events, 'permission.requested').length, 1);
    const r2 = play(late.events, { state: r1.state, tracker });
    assert.deepEqual(r2.steps[1].events, []);
    // Guarda 5: subagente waiting sem eventos há 20 min não é encerrado.
    const w = script({ session: sessionId(5) });
    w.prompt(0);
    w.start(10, W);
    const cw = w.call('Bash', { command: 'npm publish' }, W);
    w.pre(100, cw);
    w.permissionRequest(110, cw);
    const tracker5 = new Tracker();
    const r3 = play(w.events, { tracker: tracker5 });
    assert.deepEqual(tick(r3.state, T0 + 20 * MIN).events, []);
    assert.equal(agentIn(view(r3.state, sessionId(5)), W.id).status, 'waiting');
    // Guarda 7: o limite de 100 não encerrados tira o waiting mais antigo, e a aprovação vira unknown.
    const many = script({ session: sessionId(5) });
    for (let i = 0; i < 101; i++) many.start(1000 + i, agent(9000 + i, 'Explore'));
    const r4 = play(many.events, { state: r3.state, tracker: tracker5 });
    const resolved = r4.events.filter((e) => e.kind === 'permission.resolved');
    assert.deepEqual(resolved.map((e) => [e.agentKey, e.data.outcome]), [[W.id, 'unknown']]);
    const session = view(r3.state, sessionId(5));
    assert.equal(session.counters.pendingApprovals, 0);
    assert.ok(!session.agents.some((a) => a.key === W.id));
    checkState(r3.state);
  });

  it('negação e nova tentativa (V4): o mesmo comando tentado de novo gera um segundo permission.requested; o primeiro vira unknown', () => {
    const s = script();
    s.prompt(0);
    const first = s.call('Bash', { command: 'npm publish' });
    s.pre(100, first);
    s.permissionRequest(110, first); // negado pelo usuário: nada depois (V4)
    const retry = s.call('Bash', { command: 'npm publish' });
    s.pre(610, retry);
    s.permissionRequest(620, retry); // payload igual ao primeiro
    s.post(5000, retry);
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.equal(of(result.events, 'permission.requested').length, 2);
    assert.deepEqual(of(result.events, 'permission.resolved').map((e) => e.data.outcome), ['unknown', 'approved']);
    assert.equal(view(result.state).counters.pendingApprovals, 0);
  });

  it('aprovações em paralelo em vários agentes: cada uma resolve a sua, em qualquer ordem de chegada', () => {
    const agents = [agent(861, 'tester'), agent(862, 'dev-backend'), agent(863, 'documentador')];
    const s = script();
    s.prompt(0);
    const calls = agents.map((w, i) => {
      s.start(10 + i, w);
      const c = s.call('Bash', { command: `npm run tarefa-${i}` }, w);
      s.pre(100 + i, c);
      s.permissionRequest(110 + i, c);
      return c;
    });
    const tail = script();
    tail.post(1000, calls[1]);
    tail.fail(1001, calls[0], 'Exit code 1');
    tail.permissionDenied(1002, calls[2]);
    const tracker = new Tracker();
    const result = play([...s.events, ...tail.events], { tracker });
    assert.deepEqual(result.events.filter((e) => e.kind === 'permission.resolved').map((e) => [e.agentKey, e.data.outcome]), [
      [agents[1].id, 'approved'], [agents[0].id, 'approved'], [agents[2].id, 'denied'],
    ]);
    assert.equal(view(result.state).counters.pendingApprovals, 0);
    checkState(result.state);
  });
});

// ---------------------------------------------------------------------------
// Testes e bugs
// ---------------------------------------------------------------------------

const NODE_SUMMARY = (pass, fail) => `ℹ tests ${pass + fail}\nℹ pass ${pass}\nℹ fail ${fail}`;

describe('[T0] V3: testes e bugs', () => {
  it('3 falhas → bugs.open 3; o run seguinte aprovado → open 0 e bugsCrushed 3; falha sem contagem → 1 bug; bugs da sessão não zeram no ticket seguinte', () => {
    const s = script();
    s.prompt(0);
    const r1 = s.testRun(100, 'npm test', { ok: false, output: NODE_SUMMARY(7, 3) });
    const r2 = s.testRun(1000, 'npm test', { ok: true, output: NODE_SUMMARY(10, 0) });
    s.testRun(2000, 'node --test', { ok: false, output: 'erro sem resumo' });
    s.prompt(3000, 'Outro pedido');
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    const finished = of(result.events, 'test.finished');
    assert.deepEqual(finished.map((e) => [e.data.toolUseId, e.data.ok, e.data.passed, e.data.failed, e.data.total]), [
      [r1.id, false, 7, 3, 10], [r2.id, true, 10, 0, 10], [finished[2].data.toolUseId, false, null, null, null],
    ]);
    assert.equal(finished[0].data.framework, 'node:test');
    const after = (n) => view(play(s.events.slice(0, n)).state);
    assert.deepEqual([after(4).bugs.open, after(4).counters.bugsCrushed], [3, 0]);
    assert.deepEqual([after(6).bugs.open, after(6).counters.bugsCrushed], [0, 3]);
    const session = view(result.state);
    assert.deepEqual([session.bugs.open, session.counters.bugsCrushed], [1, 3]);
    assert.equal(session.bugs.lastRun.ok, false);
    assert.equal(session.quest.n, 2, 'ticket novo, bugs mantidos');
    checkState(result.state);
  });

  it('failed 0 com ok false (por exemplo, cobertura) dá 0 bugs, ao pé da letra; e o comando de teste aparece com categoria test', () => {
    const s = script();
    s.prompt(0);
    s.testRun(100, 'npm test', { ok: false, output: NODE_SUMMARY(4, 0) });
    const result = play(s.events);
    assert.equal(of(result.events, 'tool.started')[0].data.category, 'test');
    const session = view(result.state);
    assert.equal(session.bugs.open, 0);
    assert.equal(session.bugs.lastRun.ok, false);
  });

  it('saúde: comando de teste conta uma vez (pelo test.finished); tool.failed interrompido não conta', () => {
    const W = agent(871, 'tester');
    const s = script();
    s.prompt(0);
    s.start(10, W);
    s.testRun(100, 'npm test', { who: W, ok: false, output: NODE_SUMMARY(1, 1) });
    const c = s.call('Bash', { command: 'npm run build' }, W);
    s.pre(500, c);
    s.fail(600, c, 'Interrompido', { interrupt: true });
    const result = play(s.events);
    assert.deepEqual(agentIn(view(result.state), W.id).health, { ok: 0, total: 1 });
    assert.equal(of(result.events, 'tool.failed').at(-1).data.interrupted, true);
  });

  it('[T0] V12: teste interrompido (Esc durante npm test) não emite test.finished, mantém bugs.open e o lastRun, e não conta na saúde', () => {
    const s = script();
    s.prompt(0);
    s.testRun(100, 'npm test', { ok: false, output: NODE_SUMMARY(3, 2) });
    s.testRun(1000, 'npm test', { ok: false, interrupt: true, output: NODE_SUMMARY(0, 5) });
    const result = play(s.events);
    assert.equal(of(result.events, 'test.finished').length, 1);
    assert.equal(of(result.steps[4].events, 'tool.failed')[0].data.interrupted, true);
    const session = view(result.state);
    assert.equal(session.bugs.open, 2);
    assert.equal(session.bugs.lastRun.failed, 2);
    assert.deepEqual(agentIn(session, 'main').health, { ok: 0, total: 1 });
  });

  it('cadeia &&: falhou sem contagem → sem test.finished, tool.failed conta na saúde, bugs e lastRun não mudam; passou → test.finished aprovado; falhou com contagem → bugs', () => {
    const s = script();
    s.prompt(0);
    s.testRun(100, 'npm run build && npm test', { ok: false, output: 'erro de compilação' });
    const result1 = play(s.events);
    assert.equal(of(result1.events, 'test.finished').length, 0);
    assert.equal(of(result1.events, 'tool.started')[0].data.category, 'test');
    let session = view(result1.state);
    assert.deepEqual(session.bugs, { open: 0, lastRun: null }, 'o build que falhou não abre bug');
    assert.deepEqual(agentIn(session, 'main').health, { ok: 0, total: 1 });
    s.testRun(1000, 'npm run build && npm test', { ok: true, output: NODE_SUMMARY(5, 0) });
    s.testRun(2000, 'npm run build && npm test', { ok: false, output: NODE_SUMMARY(3, 2) });
    const result = play(s.events);
    assert.deepEqual(of(result.events, 'test.finished').map((e) => [e.data.ok, e.data.failed]), [[true, 0], [false, 2]]);
    session = view(result.state);
    assert.equal(session.bugs.open, 2);
    const all = JSON.stringify({ s: getSessionStates(result.state), e: result.events });
    assert.ok(!all.includes('chained') && !all.includes('partial'), 'campos internos do testResult não saem');
  });
});

// ---------------------------------------------------------------------------
// Compactação, rótulo e interrupção
// ---------------------------------------------------------------------------

describe('[T0] compactação', () => {
  it('PreCompact deixa a atividade "compactando"; PostCompact emite context.compacted; o SessionStart compact do mesmo par não repete', () => {
    const s = script();
    s.prompt(0);
    s.preCompact(1000, 'manual');
    s.postCompact(5000, 'manual');
    s.sessionStart(5100, 'compact');
    const tracker = new Tracker();
    const result = play(s.events, { tracker });
    assert.deepEqual(result.steps[1].events, []);
    assert.deepEqual(pickActivity(agentIn(view(play(s.events.slice(0, 2)).state), 'main').activity), { kind: 'compact', category: null, tool: null, target: null, detail: 'manual', state: 'running' });
    assert.deepEqual(kinds(result.steps[2].events), [['context.compacted', 'main']]);
    assert.deepEqual(result.steps[2].events[0].data, { trigger: 'manual' });
    assert.deepEqual(kinds(result.steps[3].events), [['session.started', null]]);
    assert.equal(agentIn(view(result.state), 'main').activity.state, 'done');
    checkState(result.state);
  });

  it('fora de ordem: SessionStart compact antes do PostCompact emite uma vez; duplicata em 60 s não repete; compactação nova repete; sem trigger no sinal, vale o do PreCompact', () => {
    const s = script();
    s.prompt(0);
    s.preCompact(1000, 'auto');
    s.sessionStart(4000, 'compact'); // 2: chegou antes
    s.hook(4100, 'PostCompact', { compact_summary: 'RESUMO' }); // 3: sem trigger, par do anúncio
    s.postCompact(4200, 'auto'); // 4: duplicata
    s.preCompact(10_000, 'manual'); // 5: compactação nova
    s.postCompact(12_000, 'manual'); // 6
    s.postCompact(12_000 + 61_000, 'auto'); // 7: mais de 60 s depois, sem PreCompact: outra
    const result = play(s.events);
    assert.deepEqual(of(result.steps[2].events, 'context.compacted').map((e) => e.data.trigger), ['auto']);
    assert.deepEqual(result.steps[3].events, []);
    assert.deepEqual(result.steps[4].events, []);
    assert.deepEqual(of(result.steps[6].events, 'context.compacted').map((e) => e.data.trigger), ['manual']);
    assert.deepEqual(of(result.steps[7].events, 'context.compacted').length, 1);
  });

  it('compactação num subagente: a atividade dele vira compact, e o evento é dele', () => {
    const W = agent(881, 'tester');
    const s = script();
    s.prompt(0);
    s.start(10, W);
    s.preCompact(100, 'auto', W);
    s.postCompact(200, 'auto', W);
    const result = play(s.events);
    assert.deepEqual(kinds(lastStep(result)), [['context.compacted', W.id]]);
  });
});

describe('rótulo da sessão', () => {
  it('sem session_title, cai para o título do primeiro ticket do usuário (até 48); implícito e título vazio não contam; session_title tem prioridade', () => {
    const s = script({ promptIds: true });
    s.tool(0, 'Read', { file_path: `${PROJECT}\\a.md` }); // implícito
    s.prompt(100, 'Um pedido com um título bem comprido, que passa dos quarenta e oito caracteres');
    s.prompt(200, 'Segundo pedido');
    const result = play(s.events);
    const label = view(result.state).label;
    assert.equal(Array.from(label).length, 48);
    assert.ok(label.startsWith('Um pedido com um título bem comprido') && label.endsWith('…'));
    s.prompt(300, 'Terceiro', { session_title: 'Título da sessão' });
    assert.equal(view(play(s.events).state).label, 'Título da sessão');
  });
});

describe('[T0] V12: interrupção com Esc', () => {
  it('sem Stop, o pedido seguinte libera os subagentes em primeiro plano e fecha o ticket como interrupted, nessa ordem', () => {
    const T = agent(891, 'tester');
    const s = script();
    s.prompt(0, 'A');
    const c = s.delegation('tester', 'Testar');
    s.pre(100, c);
    s.start(130, T);
    const b = s.call('Bash', { command: 'npm run lento' }, T);
    s.pre(200, b);
    s.prompt(5000, 'B'); // Esc antes: nenhum Stop
    const result = play(s.events);
    assert.deepEqual(kinds(lastStep(result)), [['agent.finished', T.id], ['quest.phase', T.id], ['quest.finished', 'main'], ['quest.started', 'main']]);
    assert.equal(lastStep(result)[0].data.outcome, 'unknown');
    assert.equal(lastStep(result)[2].data.outcome, 'interrupted');
    checkState(result.state);
  });

  it('Stop atrasado do turno anterior (ts antes do início do ticket aberto) não encerra o ticket novo nem deixa o main ocioso', { todo: 'achado do tester (T8): o Stop não confere o ts contra o início do ticket aberto, como o turnEndedWithoutStop' }, () => {
    const s = script();
    s.prompt(0, 'Pedido A');
    s.tool(1000, 'Read', { file_path: `${PROJECT}\\a.md` });
    s.stop(10_000);
    s.prompt(10_030, 'Pedido B, que estava na fila');
    s.tool(12_000, 'Read', { file_path: `${PROJECT}\\b.md` });
    const list = s.events;
    const swapped = [list[0], list[1], list[2], list[4], list[3], list[5], list[6]]; // o Stop de A chega 30 ms depois do pedido B
    const session = view(play(swapped).state);
    assert.equal(session.quest.n, 2);
    assert.equal(session.quest.status, 'open', 'o ticket B continua aberto');
    assert.equal(session.quest.actions, 1, 'a ferramenta de B conta no ticket B');
    assert.equal(agentIn(session, 'main').status, 'working', 'o main trabalha no pedido B');
  });

  it('novo pedido fecha como interrupted um ticket em waiting_background; o segundo plano continua', () => {
    const BG = agent(892, 'tester');
    const s = script();
    s.prompt(0, 'A');
    const c = s.delegation('tester', 'Fundo', { background: true });
    s.pre(100, c);
    s.start(130, BG);
    s.launched(140, c, BG);
    s.stop(1000, [{ id: BG.id, type: 'local_agent', status: 'running', agent_type: 'tester' }]);
    s.prompt(2000, 'B');
    const result = play(s.events);
    assert.deepEqual(kinds(lastStep(result)), [['quest.finished', 'main'], ['quest.started', 'main']]);
    assert.equal(lastStep(result)[0].data.outcome, 'interrupted');
    assert.equal(agentIn(view(result.state), BG.id).status, 'working');
  });

  it('idle_prompt: só fecha o ticket open (não o em waiting_background); compensa o Stop perdido; session.idle sempre, menos em sessão encerrada', () => {
    const T = agent(893, 'tester');
    const s = script();
    s.prompt(0);
    s.start(10, T);
    const c = s.call('Bash', { command: 'git push' });
    s.pre(20, c);
    s.permissionRequest(30, c);
    s.notice(1000, 'idle_prompt');
    const result = play(s.events);
    assert.deepEqual(kinds(lastStep(result)), [['permission.resolved', 'main'], ['agent.finished', T.id], ['quest.phase', T.id], ['quest.finished', 'main'], ['session.idle', null]]);
    assert.equal(agentIn(view(result.state), 'main').status, 'idle');
    const bg = script({ session: sessionId(6) });
    bg.prompt(0);
    bg.stop(100, [{ id: 'tarefa', type: 'local_bash', status: 'running', agent_type: null }]);
    bg.notice(200, 'idle_prompt');
    bg.sessionEnd(300);
    bg.notice(400, 'idle_prompt');
    const r2 = play(bg.events);
    assert.deepEqual(kinds(r2.steps[2].events), [['session.idle', null]], 'em espera: só o session.idle');
    assert.deepEqual(r2.steps[4].events, [], 'sessão encerrada: nada');
  });
});

// ---------------------------------------------------------------------------
// Ajuste: PermissionRequest fora da deduplicação do servidor
// ---------------------------------------------------------------------------

describe('PermissionRequest fora da deduplicação do servidor (ajuste de 19/10/2026), com o servidor real', () => {
  let server;
  let home;
  after(async () => {
    await server?.stop();
    cleanupTemps();
  });

  it('o mesmo PermissionRequest entregue duas vezes passa pela ingestão e vira um pedido; um comando negado e tentado de novo a 500 ms vira dois', async () => {
    home = newTemp('aq-int-t8-dedupe-');
    server = await startRealServer({ dataDir: home, env: { AGENT_QUEST_HOME: home } });
    const { token } = readJson(path.join(home, 'runtime.json'));
    const send = (item) => request(server.port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'content-type': 'application/json', 'x-agent-quest-token': token },
      body: JSON.stringify(envelopeOf({ ...item, at: Date.now() - T0 })),
    });
    const s = script({ session: sessionId(77) });
    s.prompt(0);
    const first = s.call('Bash', { command: 'npm publish' });
    s.pre(0, first);
    s.permissionRequest(0, first);
    for (const item of s.events) assert.equal((await send(item)).status, 204);
    assert.equal((await send(s.events.at(-1))).status, 204); // plugin carregado duas vezes
    const retry = s.call('Bash', { command: 'npm publish' });
    const t = script({ session: sessionId(77) });
    t.pre(0, retry);
    t.permissionRequest(0, retry); // payload igual ao do primeiro pedido
    for (const item of t.events) assert.equal((await send(item)).status, 204);
    const state = await waitFor(async () => {
      const res = await request(server.port, { path: '/api/state' });
      const session = JSON.parse(res.text).sessions.find((x) => x.id === sessionId(77));
      return session && session.feed.filter((e) => e.kind === 'permission.requested').length === 2 ? session : null;
    }, { label: 'dois permission.requested' });
    const health = JSON.parse((await request(server.port, { path: '/api/health' })).text);
    assert.equal(health.events.deduped, 0, 'nenhum PermissionRequest deduplicado pelo servidor');
    assert.equal(health.events.accepted, 6);
    assert.deepEqual(state.feed.filter((e) => e.kind.startsWith('permission.')).map((e) => [e.kind, e.data.outcome ?? null]), [
      ['permission.requested', null], ['permission.resolved', 'unknown'], ['permission.requested', null],
    ]);
    assert.equal(state.counters.pendingApprovals, 1);
    // Um PreToolUse repetido continua deduplicado pela ingestão.
    assert.equal((await send(t.events[0])).status, 204);
    await waitFor(async () => JSON.parse((await request(server.port, { path: '/api/health' })).text).events.deduped === 1, { label: 'Pre repetido deduplicado' });
  });
});

// ---------------------------------------------------------------------------
// Permutação, invariantes e desempenho
// ---------------------------------------------------------------------------

const W1 = agent(901, 'tester');
const W2 = agent(902, 'dev-backend');
const BGW = agent(903, 'documentador');

/** Um turno com o que o T8 acompanha, com tempos plausíveis (ms desde T0). */
function t8Scenario() {
  const s = script();
  s.sessionStart(0);
  s.prompt(3000, 'Implemente e teste');
  const c1 = s.delegation('dev-backend', 'Implementar');
  const c2 = s.delegation('tester', 'Testar');
  const c3 = s.delegation('documentador', 'Documentar em segundo plano', { background: true });
  s.pre(6000, c1);
  s.pre(6008, c2);
  s.pre(6016, c3);
  s.start(6050, W2);
  s.start(6060, W1);
  s.start(6070, BGW);
  s.launched(6080, c3, BGW);
  const edit = s.call('Edit', { file_path: `${PROJECT}\\server\\a.js`, old_string: 'X', new_string: 'Y' }, W2);
  s.pre(7000, edit);
  s.permissionRequest(7010, edit);
  s.post(9000, edit);
  s.testRun(9500, 'npm test', { who: W1, ok: false, output: NODE_SUMMARY(8, 2) });
  s.preCompact(10_000, 'auto');
  s.postCompact(12_000, 'auto');
  s.sessionStart(12_050, 'compact');
  s.testRun(13_000, 'npm test', { who: W1, ok: true, output: NODE_SUMMARY(10, 0) });
  s.stopAgent(15_000, W1);
  s.returned(15_030, c2, W1);
  s.stopAgent(15_100, W2);
  s.returned(15_120, c1, W2);
  s.stop(17_000, [{ id: BGW.id, type: 'local_agent', status: 'running', agent_type: 'documentador' }]);
  s.stopAgent(25_000, BGW);
  s.prompt(25_100, '<task-notification>fim</task-notification>', { prompt_id: '9a0e0000-0000-4000-8000-0000000007e1' });
  s.stop(27_000);
  return s.events;
}

function finalState(list, at) {
  const { state } = play(list);
  tick(state, T0 + at);
  return getSessionStates(state, { feed: false }).map(withoutFeed);
}

describe('permutação: embaralhar dentro de janelas de 200 ms dá o mesmo estado final (T8)', () => {
  for (const mode of ['jitter', 'janelas']) {
    it(`turno com etapas, aprovação, testes, compactação e segundo plano, ${mode}: 400 embaralhamentos com semente fixa`, (t) => {
      const list = t8Scenario();
      const end = Math.max(...list.map((item) => item.at)) + 1000;
      const baseline = finalState(list, end);
      const random = rng(20261020);
      const failures = new Map();
      let failed = 0;
      for (let i = 0; i < 400; i++) {
        const order = mode === 'jitter' ? jitterOrder(list, random) : windowOrder(list, random);
        const diffs = diffPaths(finalState(order, end), baseline);
        if (diffs.length === 0) continue;
        failed++;
        for (const diff of diffs) {
          const key = diff.split(':')[0];
          if (!failures.has(key)) failures.set(key, { count: 0, example: diff, order: order.map((x) => `${x.payload.hook_event_name}@${x.at}`).join(' ') });
          failures.get(key).count++;
        }
      }
      t.diagnostic(`${failed} de 400 com estado final diferente`);
      assert.equal(failed, 0, [...failures.entries()].map(([k, v]) => `${k} (${v.count}x): ${v.example}\n  ordem: ${v.order}`).join('\n'));
      const base = baseline[0];
      assert.deepEqual([base.quest.status, base.counters.questsDone, base.bugs.open, base.counters.bugsCrushed, base.counters.pendingApprovals], ['done', 1, 0, 2, 0]);
    });
  }
});

describe('invariantes no cenário do T8 em todas as ordens de chegada', () => {
  it('só tipos do contrato, nenhum *Key, pendingApprovals nunca negativo e coerente, bugs.open coerente com o lastRun, depois de cada fato', () => {
    const list = t8Scenario();
    const random = rng(7);
    for (let i = 0; i < 50; i++) {
      const order = i === 0 ? list : jitterOrder(list, random);
      const state = newState();
      const tracker = new Tracker();
      for (const item of order) {
        play([item], { state, tracker });
        checkState(state);
      }
    }
  });
});

describe('desempenho do T8: 1 000 fatos (ADR 0010, complemento de 19/10/2026)', () => {
  /** Turnos do t8Scenario repetidos em sessões diferentes até `n` fatos. */
  function facts(n) {
    const out = [];
    for (let k = 0; out.length < n; k++) {
      for (const item of t8Scenario()) {
        if (out.length >= n) break;
        const payload = { ...item.payload, session_id: sessionId(1000 + k) };
        const at = item.at + k * 30_000;
        out.push({ fact: normalize(envelopeOf({ ...item, at, payload }), { receivedAt: T0 + at, homeDir: HOME }), now: T0 + at });
      }
    }
    return out;
  }
  const run = (input) => {
    const state = newState();
    for (const { fact, now } of input) apply(state, fact, now);
  };
  const best = (input, n) => {
    run(input);
    let min = Infinity;
    for (let i = 0; i < n; i++) {
      const begin = performance.now();
      run(input);
      min = Math.min(min, performance.now() - begin);
    }
    return min;
  };

  it('melhor de 7: 1 000 fatos em menos de 50 ms, com uma nova tentativa; crescimento linear contra 125 fatos medidos logo antes (razão até 32)', (t) => {
    const big = facts(1000);
    const small = facts(125);
    assert.ok(big.every(({ fact }) => fact !== null));
    let ms = best(big, 7);
    if (ms >= 50) ms = best(big, 7); // ADR 0010: uma nova tentativa por ruído
    const ratio = ms / Math.max(best(small, 7), 1);
    t.diagnostic(`1 000 fatos: ${ms.toFixed(1)} ms; razão contra 125 fatos: ${ratio.toFixed(1)}`);
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
    assert.ok(ratio <= 32, `razão ${ratio.toFixed(1)}`);
  });
});
