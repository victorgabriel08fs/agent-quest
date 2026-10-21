// SINTÉTICO: aguardando aprovação (T8; modelo de eventos, seções 4 e 6,
// "Aguardando aprovação"; ADR 0008). Cenários no formato do ADR 0010, passando
// pelo normalizador e pelo reducer, com o relógio injetado.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply, createState, getSessionState, tick } from '../../../../../server/domain/state/index.js';
import { outcomeForCallEnd, requesterOf } from '../../../../../server/domain/state/permissions.js';
import { PROJECT, agent, agentOf, assertEvents, assertRunShape, run, scenario, view } from './scenarios.js';

const build = { command: 'npm run build', description: 'Gerar o build' };
const lint = { command: 'npx eslint .', description: 'Lint' };

/** PermissionRequest da chamada (sem `tool_use_id`, como o hook real). */
function ask(b, call, { withAgentId = false } = {}) {
  b.raw('PermissionRequest', { tool_name: call.tool, tool_input: call.input, permission_suggestions: [] }, withAgentId ? call.who : undefined);
}

/** PermissionDenied da chamada (modo automático). */
function deny(b, call) {
  b.raw('PermissionDenied', { tool_name: call.tool, tool_input: call.input, tool_use_id: call.id, reason: 'MOTIVO-DA-NEGACAO' }, call.who);
}

describe('[T0] V2, V4: aprovação na sessão principal', () => {
  let call;
  const scn = scenario('aprovacao-main', 'Bash do main com pedido de aprovação', (b) => {
    b.sessionStart();
    b.prompt('Gerar o build');
    call = b.call('Bash', build);
    b.pre(call);
    ask(b, call);
    b.post(call, { stdout: 'ok', stderr: '' });
    b.stop();
  });

  it('o main fica waiting, com waitingFor, e a sessão fica waiting', () => {
    const result = run(scn, { until: 4 });
    assertEvents(result.steps.at(-1).events, [
      ['permission.requested', 'main', { tool: 'Bash', category: 'bash', target: 'npm run build' }],
    ], { kinds: null });
    const session = view(result.state);
    const main = agentOf(session, 'main');
    assert.equal(main.status, 'waiting');
    assert.deepEqual(main.waitingFor, { tool: 'Bash', category: 'bash', target: 'npm run build' });
    assert.equal(session.status, 'waiting');
    assert.equal(session.counters.pendingApprovals, 1);
    assertRunShape(result);
  });

  it('Post da chamada: tool.finished e depois permission.resolved(approved, user); pendingApprovals volta a 0', () => {
    const result = run(scn, { until: 5 });
    assertEvents(result.steps.at(-1).events, [
      ['tool.finished', 'main'],
      ['permission.resolved', 'main', { outcome: 'approved', by: 'user' }],
    ], { kinds: null });
    const session = view(result.state);
    assert.equal(agentOf(session, 'main').status, 'working');
    assert.equal(agentOf(session, 'main').waitingFor, null);
    assert.equal(session.status, 'active');
    assert.equal(session.counters.pendingApprovals, 0);
    assert.deepEqual(session.feed.filter((event) => event.kind.startsWith('permission.')).map((event) => event.kind), ['permission.requested', 'permission.resolved']);
    assertRunShape(run(scn));
  });
});

describe('[T0] V2: aprovação num subagente', () => {
  const T = agent('tester-aprovacao', 'tester');

  function delegated(b) {
    b.sessionStart();
    b.prompt('Testar');
    b.pre(b.delegation('tester', 'Testar'));
    b.start(T);
  }

  it('sem agent_id no pedido: a chamada aberta com o mesmo nome e inputHash decide (heurística da seção 6)', () => {
    let call;
    const scn = scenario('aprovacao-sub-heuristica', 'pedido sem agent_id', (b) => {
      delegated(b);
      call = b.call('Bash', lint, T);
      b.pre(call);
      ask(b, call);
      b.post(call, { stdout: '', stderr: '' });
    });
    const waiting = run(scn, { until: 6 });
    assertEvents(waiting.steps.at(-1).events, [['permission.requested', T.id, { tool: 'Bash', target: 'npx eslint .' }]], { kinds: null });
    const session = view(waiting.state);
    assert.equal(agentOf(session, T.id).status, 'waiting');
    assert.equal(agentOf(session, 'main').status, 'working', 'o main não é quem pediu');
    assert.equal(agentOf(session, 'main').waitingFor, null);
    assert.equal(session.status, 'waiting');
    assertRunShape(waiting);

    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['tool.finished', T.id],
      ['permission.resolved', T.id, { outcome: 'approved', by: 'user' }],
    ], { kinds: null });
    assert.equal(view(result.state).counters.pendingApprovals, 0);
  });

  it('com agent_id no pedido: vale o agent_id (V2), mesmo sem chamada que case', () => {
    const scn = scenario('aprovacao-sub-agent-id', 'pedido com agent_id', (b) => {
      delegated(b);
      ask(b, b.call('Write', { file_path: `${PROJECT}\\saida.txt`, content: 'CONTEUDO-REAL-DO-ARQUIVO' }, T), { withAgentId: true });
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [['permission.requested', T.id, { tool: 'Write', category: 'write' }]], { kinds: null });
    assert.ok(!JSON.stringify(view(result.state)).includes('CONTEUDO-REAL-DO-ARQUIVO'));
    assertRunShape(result);
  });

  it('outra ação do mesmo agente sem o Post: unknown (inferred), antes do tool.started da nova', () => {
    const scn = scenario('aprovacao-outra-acao', 'pedido abandonado', (b) => {
      delegated(b);
      const first = b.call('Bash', lint, T);
      b.pre(first);
      ask(b, first, { withAgentId: true });
      b.pre(b.call('Read', { file_path: `${PROJECT}\\CLAUDE.md` }, T));
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['permission.resolved', T.id, { outcome: 'unknown', by: 'inferred' }],
      ['tool.started', T.id],
    ], { kinds: null });
    const session = view(result.state);
    assert.equal(agentOf(session, T.id).status, 'working');
    assert.equal(session.counters.pendingApprovals, 0);
  });

  it('fim do agente com pedido pendente: unknown, depois agent.finished', () => {
    const scn = scenario('aprovacao-fim-do-agente', 'SubagentStop com pedido', (b) => {
      delegated(b);
      const call = b.call('Bash', lint, T);
      b.pre(call);
      ask(b, call);
      b.stopAgent(T);
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['permission.resolved', T.id, { outcome: 'unknown', by: 'inferred' }],
      ['agent.finished', T.id, { outcome: 'done' }],
      ['quest.phase', T.id, { phase: 'test', state: 'done' }],
    ], { kinds: null });
    assert.equal(view(result.state).status, 'active');
  });

  it('agente aguardando não é encerrado pela regra dos 15 min', () => {
    const scn = scenario('aprovacao-longa', 'espera longa pelo usuário', (b) => {
      delegated(b);
      const call = b.call('Bash', lint, T);
      b.pre(call);
      ask(b, call);
    });
    const result = run(scn);
    const ticked = tick(result.state, result.end + 20 * 60_000);
    assert.deepEqual(ticked.events, []);
    const session = view(result.state);
    assert.equal(agentOf(session, T.id).status, 'waiting');
    assert.equal(session.status, 'waiting');
  });
});

describe('PermissionDenied (modo automático)', () => {
  it('denied (auto); a chamada negada é encerrada como failed, sem tool.failed e sem contar na saúde', () => {
    let call;
    const scn = scenario('negada', 'pedido negado pelo modo automático', (b) => {
      b.sessionStart();
      b.prompt('Apagar');
      call = b.call('Bash', { command: 'rm -rf build', description: 'Apagar' });
      b.pre(call);
      ask(b, call);
      deny(b, call);
      b.post(call, { stdout: '', stderr: '' }); // atraso: a chamada já foi encerrada
    });
    const result = run(scn);
    assertEvents(result.steps[4].events, [['permission.resolved', 'main', { outcome: 'denied', by: 'auto' }]], { kinds: null });
    assert.deepEqual(result.steps[5].events, []);
    const main = agentOf(view(result.state), 'main');
    assert.equal(main.activity.state, 'failed');
    assert.deepEqual(main.health, { ok: 0, total: 0 });
    assert.equal(main.status, 'working');
    assert.ok(!JSON.stringify(view(result.state)).includes('MOTIVO-DA-NEGACAO'));
    assertRunShape(result);
  });

  it('sem pedido conhecido (o modo automático nega sem perguntar): permission.resolved(denied) mesmo assim', () => {
    const scn = scenario('negada-sem-pedido', 'PermissionDenied sem PermissionRequest', (b) => {
      b.sessionStart();
      b.prompt('Apagar');
      const call = b.call('Bash', { command: 'rm -rf build', description: 'Apagar' });
      b.pre(call);
      deny(b, call);
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [['permission.resolved', 'main', { outcome: 'denied', by: 'auto' }]], { kinds: null });
    assert.equal(view(result.state).counters.pendingApprovals, 0);
  });
});

describe('fim do turno, novo pedido e ordem trocada', () => {
  it('Stop com pedido pendente do main: unknown, depois o ticket', () => {
    const scn = scenario('aprovacao-stop', 'pedido sem resposta e Stop', (b) => {
      b.sessionStart();
      b.prompt('Gerar o build');
      const call = b.call('Bash', build);
      b.pre(call);
      ask(b, call);
      b.stop();
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['permission.resolved', 'main', { outcome: 'unknown', by: 'inferred' }],
      ['quest.finished', 'main', { outcome: 'done' }],
    ], { kinds: null });
    const session = view(result.state);
    assert.equal(agentOf(session, 'main').status, 'idle');
    assert.equal(session.counters.pendingApprovals, 0);
  });

  it('novo pedido do usuário com pedido pendente do main: unknown antes de encerrar o ticket', () => {
    const scn = scenario('aprovacao-novo-pedido', 'pedido sem resposta e novo pedido', (b) => {
      b.sessionStart();
      b.prompt('Gerar o build');
      const call = b.call('Bash', build);
      b.pre(call);
      ask(b, call);
      b.prompt('Esquece, faça outra coisa');
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['permission.resolved', 'main', { outcome: 'unknown', by: 'inferred' }],
      ['quest.finished', 'main', { outcome: 'interrupted' }],
      ['quest.started', 'main', { n: 2 }],
    ], { kinds: null });
    assert.equal(agentOf(view(result.state), 'main').status, 'working');
  });

  it('PermissionRequest antes do Pre (ordem de chegada trocada): o Pre com o mesmo inputHash o assume, e o Post aprova', () => {
    let call;
    const scn = scenario('aprovacao-antes-do-pre', 'pedido chega antes do Pre', (b) => {
      b.sessionStart();
      b.prompt('Gerar o build');
      call = b.call('Bash', build);
      ask(b, call);
      b.pre(call);
      b.post(call, { stdout: 'ok', stderr: '' });
    });
    const result = run(scn);
    assertEvents(result.steps[3].events, [['tool.started', 'main']], { kinds: null });
    assert.equal(agentOf(view(run(scn, { until: 4 }).state), 'main').status, 'waiting', 'continua aguardando depois do Pre');
    assertEvents(result.steps[4].events, [
      ['tool.finished', 'main'],
      ['permission.resolved', 'main', { outcome: 'approved', by: 'user' }],
    ], { kinds: null });
  });

  it('PermissionRequest atrasado depois do Stop não abre espera', () => {
    const scn = scenario('aprovacao-atrasada', 'pedido depois do Stop', (b) => {
      b.sessionStart();
      b.prompt('Gerar o build');
      const call = b.call('Bash', build);
      b.stop();
      ask(b, call);
    });
    const result = run(scn);
    assert.deepEqual(result.steps.at(-1).events, []);
    const session = view(result.state);
    assert.equal(session.counters.pendingApprovals, 0);
    assert.equal(agentOf(session, 'main').status, 'idle');
  });
});

describe('Notification permission_prompt', () => {
  it('sem PermissionRequest: marca o main como waiting, com a chamada aberta mais recente dele', () => {
    let call;
    const scn = scenario('aviso-sem-pedido', 'PermissionRequest perdido', (b) => {
      b.sessionStart();
      b.prompt('Gerar o build');
      call = b.call('Bash', build);
      b.pre(call);
      b.notice('permission_prompt');
      b.post(call, { stdout: 'ok', stderr: '' });
    });
    const waiting = run(scn, { until: 4 });
    assertEvents(waiting.steps.at(-1).events, [['permission.requested', 'main', { tool: 'Bash', category: 'bash', target: 'npm run build' }]], { kinds: null });
    assert.equal(view(waiting.state).status, 'waiting');
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['tool.finished', 'main'],
      ['permission.resolved', 'main', { outcome: 'approved', by: 'user' }],
    ], { kinds: null });
  });

  it('com pedido pendente na sessão: nenhum pedido novo', () => {
    const scn = scenario('aviso-com-pedido', 'PermissionRequest e Notification', (b) => {
      b.sessionStart();
      b.prompt('Gerar o build');
      const call = b.call('Bash', build);
      b.pre(call);
      ask(b, call);
      b.notice('permission_prompt');
    });
    const result = run(scn);
    assert.deepEqual(result.steps.at(-1).events, []);
    assert.equal(view(result.state).counters.pendingApprovals, 1);
  });

  it('sem chamada aberta: waitingFor sem ferramenta conhecida, resolvido no fim do turno', () => {
    const scn = scenario('aviso-sem-chamada', 'Notification sem chamada aberta', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      b.notice('permission_prompt');
      b.stop();
    });
    const waiting = run(scn, { until: 3 });
    assert.deepEqual(agentOf(view(waiting.state), 'main').waitingFor, { tool: '', category: 'other', target: null });
    assertRunShape(waiting);
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['permission.resolved', 'main', { outcome: 'unknown', by: 'inferred' }],
      ['quest.finished', 'main'],
    ], { kinds: null });
  });
});

describe('PermissionRequest sem deduplicação no servidor (seção 8, "Duplicatas", 19/10/2026)', () => {
  it('comando negado e tentado de novo a 500 ms: o segundo pedido idêntico cai na chamada nova e gera o segundo permission.requested', () => {
    let first;
    let retry;
    const scn = scenario('nova-tentativa', 'negado pelo usuário e tentado de novo', (b) => {
      b.sessionStart();
      b.prompt('Gerar o build');
      first = b.call('Bash', build);
      b.pre(first);
      ask(b, first);
      // Negado pelo usuário: nada depois do Pre (V4). O modelo tenta de novo.
      b.wait(490);
      retry = b.call('Bash', build);
      b.pre(retry);
      ask(b, retry);
      b.post(retry, { stdout: 'ok', stderr: '' });
    });
    const asks = scn.events.filter((event) => event.payload.hook_event_name === 'PermissionRequest');
    assert.equal(JSON.stringify(asks[0].payload), JSON.stringify(asks[1].payload), 'payloads idênticos');
    const result = run(scn);
    assertEvents(result.events, [
      ['permission.requested', 'main'],
      ['permission.resolved', 'main', { outcome: 'unknown', by: 'inferred' }],
      ['permission.requested', 'main'],
      ['permission.resolved', 'main', { outcome: 'approved', by: 'user' }],
    ], { kinds: ['permission.requested', 'permission.resolved'] });
    assert.equal(view(result.state).counters.pendingApprovals, 0);
  });

  it('a duplicata verdadeira (plugin carregado duas vezes) continua com um pedido só', () => {
    const scn = scenario('duplicata-verdadeira', 'o mesmo PermissionRequest entregue duas vezes', (b) => {
      b.sessionStart();
      b.prompt('Gerar o build');
      const call = b.call('Bash', build);
      b.pre(call);
      ask(b, call);
      ask(b, call);
    });
    const result = run(scn);
    assert.deepEqual(result.steps.at(-1).events, []);
    assert.equal(result.events.filter((event) => event.kind === 'permission.requested').length, 1);
    assert.equal(view(result.state).counters.pendingApprovals, 1);
  });
});

describe('chamada em paralelo que chega atrasada', () => {
  it('um Pre com ts anterior ao pedido não é "outra ação" depois dele e não o resolve', () => {
    const sid = 'sessao-paralela';
    const base = (kind, hook, ts, fields) => ({
      kind, hook, sessionId: sid, agentId: null, agentType: null, agentTypeKey: null, promptId: null,
      projectDir: PROJECT, client: 'terminal', ts, receivedAt: ts, transcriptPath: null, ...fields,
    });
    const tool = (toolUseId, command) => ({
      toolUseId, tool: 'Bash', category: 'bash', target: command, detail: null, inputHash: `hash-${toolUseId}`,
      background: false, subagentType: null, subagentTypeKey: null, description: null,
    });
    const state = createState();
    const t0 = 1_760_000_000_000;
    apply(state, base('tool.pre', 'PreToolUse', t0, tool('toolu_01a', 'npm run build')), t0);
    apply(state, base('permission.request', 'PermissionRequest', t0 + 20, { tool: 'Bash', category: 'bash', target: 'npm run build', inputHash: 'hash-toolu_01a' }), t0 + 20);
    const late = apply(state, base('tool.pre', 'PreToolUse', t0 + 10, tool('toolu_01b', 'git status')), t0 + 30);
    assertEvents(late.events, [['tool.started', 'main']], { kinds: null });
    assert.equal(getSessionState(state, sid).counters.pendingApprovals, 1);
    const after = apply(state, base('tool.pre', 'PreToolUse', t0 + 40, tool('toolu_01c', 'git diff')), t0 + 40);
    assertEvents(after.events, [['permission.resolved', 'main', { outcome: 'unknown' }], ['tool.started', 'main']], { kinds: null });
  });
});

describe('funções isoladas por veredito (permissions.js)', () => {
  const calls = new Map([
    ['toolu_a', { agentKey: 'main', open: true, delegation: false, tool: 'Bash', category: 'bash', target: 'x', inputHash: 'h1', ts: 10 }],
    ['toolu_b', { agentKey: 'sub-1', open: true, delegation: false, tool: 'Bash', category: 'bash', target: 'x', inputHash: 'h1', ts: 20 }],
    ['toolu_c', { agentKey: 'sub-2', open: false, delegation: false, tool: 'Bash', category: 'bash', target: 'x', inputHash: 'h1', ts: 30 }],
  ]);
  const table = /** @type {any} */ ({ agents: new Map(), calls, approvals: [] });

  it('V2: agent_id do pedido, senão a chamada aberta mais recente com mesmo nome e inputHash, senão main', () => {
    assert.deepEqual(requesterOf(table, { agentId: 'sub-1', tool: 'Bash', inputHash: 'h1' }), { agentKey: 'sub-1', toolUseId: 'toolu_b' });
    assert.deepEqual(requesterOf(table, { agentId: 'sub-9', tool: 'Bash', inputHash: 'h1' }), { agentKey: 'sub-9', toolUseId: null });
    assert.deepEqual(requesterOf(table, { agentId: null, tool: 'Bash', inputHash: 'h1' }), { agentKey: 'sub-1', toolUseId: 'toolu_b' }, 'a encerrada não conta');
    assert.deepEqual(requesterOf(table, { agentId: null, tool: 'Edit', inputHash: 'h1' }), { agentKey: 'main', toolUseId: null });
    assert.deepEqual(requesterOf(table, { agentId: null, tool: 'Bash', inputHash: null }), { agentKey: 'main', toolUseId: null });
  });

  it('V4: Post ou Failure da chamada que esperava é approved (user)', () => {
    assert.deepEqual(outcomeForCallEnd(/** @type {any} */ ({ kind: 'tool.post' })), { outcome: 'approved', by: 'user' });
    assert.deepEqual(outcomeForCallEnd(/** @type {any} */ ({ kind: 'tool.fail' })), { outcome: 'approved', by: 'user' });
  });
});
