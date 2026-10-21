// SINTÉTICO: tickets, etapas, interrupção, compactação e rótulo (T8; modelo
// de eventos, seções 4, 6 e 8). Cenários no formato do ADR 0010, passando pelo
// normalizador e pelo reducer, com o relógio injetado (nenhum relógio real).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply, createState, getSessionState, getSessionStates, tick } from '../../../../../server/domain/state/index.js';
import {
  COMPACT_PAIR_MS,
  IMPLICIT_TITLE,
  REOPEN_WINDOW_MS,
  SYSTEM_RETURN_TITLE,
  beginCompaction,
  completeCompaction,
  hasActiveBackgroundTasks,
  isSystemPrompt,
  questKeyOf,
  turnEndedWithoutStop,
} from '../../../../../server/domain/state/quests.js';
import {
  PROJECT,
  T8_KINDS,
  agent,
  agentOf,
  assertEvents,
  assertRunShape,
  run,
  scenario,
  sessionId,
  view,
} from './scenarios.js';

/** Id do pedido de índice `n` (1, 2, ...) do cenário, como o builder gerou. */
function promptIdOf(scn, n = 1) {
  const prompts = scn.events.filter((event) => event.payload.hook_event_name === 'UserPromptSubmit');
  return prompts[n - 1].payload.prompt_id;
}

/** Instante de chegada do evento de índice `index` do cenário. */
function timeOf(result, index) {
  return result.steps[index].at;
}

const readClaude = { file_path: `${PROJECT}\\CLAUDE.md` };
const notification = (text) => `<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n<summary>${text}</summary>\n</task-notification>`;

describe('[T0] V8: ticket do pedido ao Stop', () => {
  const DEV = agent('dev-ticket', 'dev-backend');
  const scn = scenario('ticket', 'pedido, ferramenta, delegação e Stop', (b) => {
    b.sessionStart();
    b.prompt('Implementar a ingestão\nDetalhes na segunda linha, que não entram no título');
    b.tool('Read', readClaude);
    const call = b.delegation('dev-backend', 'Implementar');
    b.pre(call);
    b.start(DEV);
    b.tool('Edit', { file_path: `${PROJECT}\\server\\main.js`, old_string: 'a', new_string: 'b' }, { who: DEV });
    b.stopAgent(DEV);
    b.returned(call, DEV);
    b.stop();
  });

  it('quest.started no pedido, etapa do dev, quest.finished(done) no Stop', () => {
    const result = run(scn);
    const questId = promptIdOf(scn);
    assertEvents(result.events, [
      ['session.started', null],
      ['quest.started', 'main', { questId, n: 1, title: 'Implementar a ingestão', implicit: false }],
      ['tool.started', 'main'],
      ['tool.finished', 'main'],
      ['agent.delegated', 'main'],
      ['agent.started', DEV.id],
      ['quest.phase', DEV.id, { questId, phase: 'code', state: 'active' }],
      ['tool.started', DEV.id],
      ['tool.finished', DEV.id],
      ['agent.finished', DEV.id, { outcome: 'done' }],
      ['quest.phase', DEV.id, { questId, phase: 'code', state: 'done' }],
      ['quest.finished', 'main', { questId, n: 1, outcome: 'done', error: null, actions: 3 }],
    ], { kinds: null });
    const finished = result.events.at(-1);
    assert.equal(finished.data.durationMs, timeOf(result, 10) - timeOf(result, 1));
    assertRunShape(result);
  });

  it('estado: ticket done, tickets entregues, rótulo pelo título do primeiro ticket', () => {
    const result = run(scn);
    const session = view(result.state);
    assert.equal(session.quest.status, 'done');
    assert.equal(session.quest.endedAt, timeOf(result, 10));
    assert.deepEqual(session.quest.phases, { design: 'pending', code: 'done', test: 'pending', docs: 'pending' });
    assert.equal(session.quest.actions, 3);
    assert.deepEqual(session.counters, { questsDone: 1, bugsCrushed: 0, pendingApprovals: 0 });
    assert.equal(session.label, 'Implementar a ingestão');
    // quest.phase entra no feed só com done (seção 3).
    assert.deepEqual(session.feed.filter((event) => event.kind === 'quest.phase').map((event) => event.data.state), ['done']);
  });

  it('no meio do ticket: aberto, etapa ativa, ações contadas até ali', () => {
    const session = view(run(scn, { until: 7 }).state);
    assert.equal(session.quest.status, 'open');
    assert.equal(session.quest.endedAt, null);
    assert.equal(session.quest.phases.code, 'active');
    assert.equal(session.quest.actions, 3);
  });
});

describe('fim do ticket: novo pedido, StopFailure, SessionEnd e idle_prompt', () => {
  it('novo pedido do usuário com ticket aberto: interrupted, e o seguinte ganha n = 2', () => {
    const scn = scenario('dois-pedidos', 'pedido sem Stop e outro pedido', (b) => {
      b.sessionStart();
      b.prompt('Primeiro pedido');
      b.tool('Read', readClaude);
      b.prompt('Segundo pedido');
      b.tool('Read', readClaude);
      b.stop();
    });
    const result = run(scn);
    assertEvents(result.events, [
      ['quest.started', 'main', { questId: promptIdOf(scn, 1), n: 1, title: 'Primeiro pedido' }],
      ['quest.finished', 'main', { questId: promptIdOf(scn, 1), n: 1, outcome: 'interrupted', actions: 1 }],
      ['quest.started', 'main', { questId: promptIdOf(scn, 2), n: 2, title: 'Segundo pedido' }],
      ['quest.finished', 'main', { questId: promptIdOf(scn, 2), n: 2, outcome: 'done', actions: 1 }],
    ], { kinds: T8_KINDS });
    const session = view(result.state);
    assert.equal(session.counters.questsDone, 1, 'interrompido não conta como entregue');
    assert.equal(session.label, 'Primeiro pedido', 'o rótulo é o título do primeiro ticket');
    assertRunShape(result);
  });

  it('StopFailure: failed, com o tipo de erro', () => {
    const scn = scenario('stop-failure', 'pedido e StopFailure', (b) => {
      b.sessionStart();
      b.prompt('Pedido que falha');
      b.tool('Read', readClaude);
      b.stopFailure('rate_limit');
    });
    const result = run(scn);
    assertEvents(result.events, [
      ['quest.started', 'main'],
      ['quest.finished', 'main', { outcome: 'failed', error: 'rate_limit' }],
    ], { kinds: T8_KINDS });
    const session = view(result.state);
    assert.equal(session.quest.status, 'failed');
    assert.equal(session.quest.error, 'rate_limit');
    assert.equal(session.counters.questsDone, 0);
    assert.equal(agentOf(session, 'main').status, 'idle');
    assertRunShape(result);
  });

  it('SessionEnd: libera os agentes, interrupted e só depois session.ended', () => {
    const T = agent('tester-fim', 'tester');
    const scn = scenario('session-end', 'pedido, tester trabalhando e SessionEnd', (b) => {
      b.sessionStart();
      b.prompt('Testar');
      b.pre(b.delegation('tester', 'Testar tudo'));
      b.start(T);
      b.sessionEnd('clear');
    });
    const result = run(scn);
    assertEvents(result.events.slice(-4), [
      ['agent.finished', T.id, { outcome: 'unknown' }],
      ['quest.phase', T.id, { phase: 'test', state: 'done' }],
      ['quest.finished', 'main', { outcome: 'interrupted' }],
      ['session.ended', null, { reason: 'clear' }],
    ], { kinds: null });
    assert.equal(view(result.state).quest.status, 'interrupted');
    assertRunShape(result);
  });

  it('idle_prompt depois do Stop: só session.idle, fora do feed', () => {
    const scn = scenario('idle-depois-do-stop', 'pedido, Stop e idle_prompt', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      b.stop();
      b.wait(60_000);
      b.notice('idle_prompt');
    });
    const result = run(scn);
    assertEvents(result.events, [
      ['quest.started', 'main'],
      ['quest.finished', 'main', { outcome: 'done' }],
      ['session.idle', null],
    ], { kinds: T8_KINDS });
    assert.deepEqual(result.events.at(-1).data, {});
    assert.ok(!view(result.state).feed.some((event) => event.kind === 'session.idle'));
  });

  it('idle_prompt com ticket aberto (turno sem Stop): interrupted, main ocioso, primeiro plano liberado', () => {
    const T = agent('tester-idle', 'tester');
    const scn = scenario('idle-sem-stop', 'Esc e idle_prompt', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      b.pre(b.delegation('tester', 'Testar'));
      b.start(T);
      b.pre(b.call('Bash', { command: 'npm test', description: 'Rodar' }, T));
      b.wait(60_000);
      b.notice('idle_prompt');
    });
    const result = run(scn);
    assertEvents(result.events.slice(-4), [
      ['agent.finished', T.id, { outcome: 'unknown' }],
      ['quest.phase', T.id, { state: 'done' }],
      ['quest.finished', 'main', { outcome: 'interrupted' }],
      ['session.idle', null],
    ], { kinds: null });
    const session = view(result.state);
    assert.equal(agentOf(session, 'main').status, 'idle');
    assert.equal(agentOf(session, T.id).finished, true);
    assertRunShape(result);
  });
});

describe('ticket implícito e promptId de ticket encerrado (seção 6; seção 8, regra 5)', () => {
  it('atividade sem ticket aberto (servidor iniciado no meio): ticket implícito "Tarefa em andamento"', () => {
    const scn = scenario('implicito', 'ferramenta sem pedido', (b) => {
      b.tool('Read', readClaude);
      b.stop();
    });
    const result = run(scn);
    assertEvents(result.events, [
      ['quest.started', 'main', { n: 1, title: IMPLICIT_TITLE, implicit: true }],
      ['tool.started', 'main'],
      ['tool.finished', 'main'],
      ['quest.finished', 'main', { outcome: 'done', actions: 1 }],
    ], { kinds: null });
    const session = view(result.state);
    assert.ok(session.quest.id !== '');
    assert.equal(session.label, `Sessão ${sessionId('principal').slice(0, 6)}`, 'ticket implícito não dá rótulo');
    assertRunShape(result);
  });

  it('fato com o promptId de um ticket encerrado atualiza agente e feed, mas não reabre o ticket', () => {
    const scn = scenario('nao-reabre', 'ferramenta atrasada do ticket já encerrado', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      b.tool('Read', readClaude);
      b.stop();
      b.tool('Grep', { pattern: 'atrasado' }); // mesmo prompt_id do pedido
    });
    const result = run(scn);
    const late = result.steps.slice(-2).flatMap((step) => step.events);
    assertEvents(late, [['tool.started', 'main'], ['tool.finished', 'main']], { kinds: null });
    const session = view(result.state);
    assert.equal(session.quest.n, 1);
    assert.equal(session.quest.status, 'done');
    assert.equal(session.quest.actions, 1, 'a ação atrasada não conta no ticket encerrado');
    assert.equal(agentOf(session, 'main').activity.tool, 'Grep');
  });

  it('fato sem promptId depois do ticket encerrado abre um implícito', () => {
    const scn = scenario('sem-prompt-id', 'ferramenta sem prompt_id depois do Stop', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      b.stop();
      b.raw('PreToolUse', { tool_name: 'Read', tool_input: readClaude, tool_use_id: 'toolu_01semPromptId0000000000', prompt_id: undefined });
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['quest.started', 'main', { n: 2, title: IMPLICIT_TITLE, implicit: true }],
      ['tool.started', 'main'],
    ], { kinds: null });
  });

  it('atividade sem promptId com ts até o fim do ticket (chegou atrasada) não abre implícito', () => {
    const sid = 'sessao-atraso';
    const base = (kind, hook, ts, fields) => ({
      kind, hook, sessionId: sid, agentId: null, agentType: null, agentTypeKey: null, promptId: null,
      projectDir: PROJECT, client: 'terminal', ts, receivedAt: ts, transcriptPath: null, ...fields,
    });
    const pre = (toolUseId, ts) => base('tool.pre', 'PreToolUse', ts, {
      toolUseId, tool: 'Read', category: 'read', target: 'a.md', detail: null, inputHash: null,
      background: false, subagentType: null, subagentTypeKey: null, description: null,
    });
    const state = createState();
    const t0 = 1_760_000_000_000;
    apply(state, base('prompt.submit', 'UserPromptSubmit', t0, { promptId: 'p-1', title: 'Pedido', origin: 'user', sessionTitle: null }), t0);
    apply(state, base('turn.stop', 'Stop', t0 + 100, { backgroundTasks: [] }), t0 + 100);
    const late = apply(state, pre('toolu_01atrasada', t0 + 90), t0 + 120);
    assertEvents(late.events, [['tool.started', 'main']], { kinds: null });
    assert.equal(getSessionState(state, sid).quest.n, 1);
    const after = apply(state, pre('toolu_01depois', t0 + 200), t0 + 200);
    assertEvents(after.events, [['quest.started', 'main', { n: 2, implicit: true }], ['tool.started', 'main']], { kinds: null });
  });

  it('evento atrasado depois do SessionEnd não abre ticket', () => {
    const scn = scenario('fim-sem-ticket', 'Pre novo depois do SessionEnd', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      b.sessionEnd();
      b.raw('PreToolUse', { tool_name: 'Read', tool_input: readClaude, tool_use_id: 'toolu_01depoisDoFim000000000', prompt_id: undefined });
    });
    const result = run(scn);
    assert.ok(!result.steps.at(-1).events.some((event) => event.kind.startsWith('quest.')));
    assert.equal(view(result.state).quest.status, 'interrupted');
  });
});

describe('[T0] V7, V13, [G0b]: origem do sistema e segundo plano', () => {
  const BG = agent('explorador', 'Explore');

  /** Pedido com subagente em segundo plano; o Stop o lista em background_tasks. */
  function background(b) {
    b.sessionStart();
    b.prompt('Mapear em segundo plano');
    const call = b.delegation('Explore', 'Mapear', { background: true });
    b.pre(call);
    b.start(BG);
    b.launched(call, BG);
    b.stop([{ id: BG.id, type: 'local_agent', status: 'running', agent_type: 'Explore' }]);
  }

  it('Stop com tarefa ativa: waiting_background, sem evento; o retorno reabre o mesmo ticket; o Stop final encerra em done', () => {
    const scn = scenario('segundo-plano', 'segundo plano até o retorno', (b) => {
      background(b);
      b.tool('Grep', { pattern: 'x' }, { who: BG });
      b.stopAgent(BG);
      b.prompt(notification('Mapa pronto'));
      b.stop();
    });
    const waiting = run(scn, { until: 7 });
    assert.equal(view(waiting.state).quest.status, 'waiting_background');
    assert.equal(view(waiting.state).quest.endedAt, null);
    assert.ok(!waiting.events.some((event) => event.kind === 'quest.finished'));

    const result = run(scn);
    const questId = promptIdOf(scn, 1);
    assertEvents(result.events, [
      ['quest.started', 'main', { questId, n: 1 }],
      ['quest.finished', 'main', { questId, n: 1, outcome: 'done' }],
    ], { kinds: T8_KINDS });
    const session = view(result.state);
    assert.equal(session.quest.id, questId);
    assert.equal(session.quest.status, 'done');
    assert.equal(session.counters.questsDone, 1);
    assert.equal(session.label, 'Mapear em segundo plano');
    assertRunShape(result);
  });

  it('o pedido do sistema deixa o main trabalhando, sem abrir ticket', () => {
    const scn = scenario('retorno-trabalhando', 'retorno do segundo plano', (b) => {
      background(b);
      b.prompt(notification('Mapa pronto'));
    });
    const result = run(scn);
    assert.ok(!result.steps.at(-1).events.length, 'reabre sem evento');
    const session = view(result.state);
    assert.equal(agentOf(session, 'main').status, 'working');
    assert.equal(session.quest.status, 'open');
    assert.equal(session.quest.n, 1);
  });

  it('retorno até 30 min depois de um ticket encerrado o reabre; o segundo Stop não conta de novo', () => {
    const scn = scenario('reabre-encerrado', 'retorno depois do done', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      b.stop();
      b.wait(REOPEN_WINDOW_MS - 60_000);
      b.prompt(notification('Tarefa agendada'));
      b.tool('Read', readClaude);
      b.stop();
    });
    const result = run(scn);
    assertEvents(result.events, [
      ['quest.started', 'main', { n: 1 }],
      ['quest.finished', 'main', { n: 1, outcome: 'done', actions: 0 }],
      ['quest.finished', 'main', { n: 1, outcome: 'done', actions: 1 }],
    ], { kinds: T8_KINDS });
    assert.equal(view(result.state).counters.questsDone, 1);
  });

  it('retorno sem ticket para reabrir: implícito "Retorno de tarefa em segundo plano"', () => {
    const scn = scenario('retorno-implicito', 'retorno 31 min depois', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      b.stop();
      b.wait(REOPEN_WINDOW_MS + 60_000);
      b.prompt(notification('Tarefa agendada'));
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['quest.started', 'main', { n: 2, title: SYSTEM_RETURN_TITLE, implicit: true }],
    ], { kinds: null });
  });

  it('retorno numa sessão sem ticket: implícito', () => {
    const scn = scenario('retorno-sem-ticket', 'retorno como primeiro evento', (b) => {
      b.prompt(notification('Tarefa agendada'));
    });
    assertEvents(run(scn).events, [['quest.started', 'main', { n: 1, title: SYSTEM_RETURN_TITLE, implicit: true }]], { kinds: null });
  });

  it('novo pedido do usuário com o ticket em waiting_background: interrupted, e o segundo plano segue', () => {
    const scn = scenario('pedido-com-espera', 'pedido do usuário durante o segundo plano', (b) => {
      background(b);
      b.prompt('Outro pedido');
    });
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['quest.finished', 'main', { n: 1, outcome: 'interrupted' }],
      ['quest.started', 'main', { n: 2, title: 'Outro pedido' }],
    ], { kinds: null });
    assert.equal(agentOf(view(result.state), BG.id).status, 'working');
  });

  it('origin null (pedido que não é texto) conta como pedido do usuário', () => {
    const scn = scenario('pedido-nao-texto', 'prompt em lista', (b) => {
      b.sessionStart();
      b.prompt([{ type: 'image' }]);
    });
    const result = run(scn);
    assert.equal(result.steps.at(-1).fact.origin, null);
    assertEvents(result.events, [['quest.started', 'main', { n: 1, title: '', implicit: false }]], { kinds: T8_KINDS });
    assertRunShape(result);
  });
});

describe('etapas (seção 6, "Etapa")', () => {
  const ARQ = agent('arquiteto-1', 'arquiteto');
  const DEV1 = agent('dev-1', 'dev-backend');
  const DEV2 = agent('dev-2', 'dev-frontend');
  const DEV3 = agent('dev-3', 'dev-backend');

  const scn = scenario('etapas', 'arquitetura, dois devs em paralelo e um dev de novo', (b) => {
    b.sessionStart();
    b.prompt('Fazer a funcionalidade');
    const design = b.delegation('arquiteto', 'Desenhar');
    b.pre(design);
    b.start(ARQ);
    b.stopAgent(ARQ);
    b.returned(design, ARQ);
    const back = b.delegation('dev-backend', 'Backend', { background: true });
    const front = b.delegation('dev-frontend', 'Frontend', { background: true });
    b.pre(back);
    b.start(DEV1);
    b.launched(back, DEV1);
    b.pre(front);
    b.start(DEV2);
    b.launched(front, DEV2);
    b.stopAgent(DEV1);
    b.stopAgent(DEV2);
    const fix = b.delegation('dev-backend', 'Corrigir');
    b.pre(fix);
    b.start(DEV3);
    b.stopAgent(DEV3);
    b.returned(fix, DEV3);
    b.stop();
  });

  it('active no primeiro agente do papel, done quando termina o último, reativada por nova delegação', () => {
    const result = run(scn);
    assertEvents(result.events, [
      ['quest.started', 'main'],
      ['quest.phase', ARQ.id, { phase: 'design', state: 'active' }],
      ['quest.phase', ARQ.id, { phase: 'design', state: 'done' }],
      ['quest.phase', DEV1.id, { phase: 'code', state: 'active' }],
      ['quest.phase', DEV2.id, { phase: 'code', state: 'done' }],
      ['quest.phase', DEV3.id, { phase: 'code', state: 'active' }],
      ['quest.phase', DEV3.id, { phase: 'code', state: 'done' }],
      ['quest.finished', 'main', { outcome: 'done', actions: 4 }],
    ], { kinds: T8_KINDS });
    assert.deepEqual(view(result.state).quest.phases, { design: 'done', code: 'done', test: 'pending', docs: 'pending' });
    assertRunShape(result);
  });

  it('com o segundo dev ainda trabalhando, a etapa continua ativa', () => {
    const session = view(run(scn, { until: 13 }).state);
    assert.equal(session.quest.phases.code, 'active');
  });

  it('sessão sem papéis do time: nenhuma etapa sai de pending', () => {
    const AUX = agent('explorador-etapa', 'Explore');
    const result = run(scenario('sem-time', 'só convidado', (b) => {
      b.sessionStart();
      b.prompt('Explorar');
      const call = b.delegation('Explore', 'Explorar');
      b.pre(call);
      b.start(AUX);
      b.stopAgent(AUX);
      b.returned(call, AUX);
      b.stop();
    }));
    assert.ok(!result.events.some((event) => event.kind === 'quest.phase'));
    assert.deepEqual(view(result.state).quest.phases, { design: 'pending', code: 'pending', test: 'pending', docs: 'pending' });
  });

  it('agente criado sem tipo ganha o papel depois: a etapa ativa nessa hora', () => {
    const T = agent('tester-sem-tipo', 'tester');
    const result = run(scenario('tipo-depois', 'tipo chega no SubagentStart', (b) => {
      b.sessionStart();
      b.prompt('Testar');
      b.tool('Read', readClaude, { who: { id: T.id } });
      b.start(T);
    }));
    assertEvents(result.events, [
      ['quest.started', 'main'],
      ['quest.phase', T.id, { phase: 'test', state: 'active' }],
    ], { kinds: T8_KINDS });
  });

  it('subagente encerrado pelos 15 min e que volta com um Pre novo reativa a etapa', () => {
    const T = agent('tester-volta', 'tester');
    const scn15 = scenario('volta-etapa', 'tester parado e de volta', (b) => {
      b.sessionStart();
      b.prompt('Testar');
      b.pre(b.delegation('tester', 'Testar', { background: true }));
      b.start(T);
    });
    const first = run(scn15);
    const ticked = tick(first.state, first.end + 15 * 60_000);
    assertEvents(ticked.events, [
      ['agent.finished', T.id, { outcome: 'unknown' }],
      ['quest.phase', T.id, { phase: 'test', state: 'done' }],
    ], { kinds: null });
    const again = run(scenario('volta-etapa-2', 'Pre novo', (b) => {
      b.tool('Read', readClaude, { who: T });
    }), { state: first.state, start: first.end + 16 * 60_000 });
    assertEvents(again.events, [['quest.phase', T.id, { phase: 'test', state: 'active' }]], { kinds: ['quest.phase'] });
  });
});

describe('[T0] V12: interrupção com Esc', () => {
  const T = agent('tester-esc', 'tester');
  const BG = agent('dev-esc-fundo', 'dev-backend');

  const scn = scenario('esc', 'Esc com tester em primeiro plano, depois novo pedido', (b) => {
    b.sessionStart();
    b.prompt('Primeiro');
    const bg = b.delegation('dev-backend', 'No fundo', { background: true });
    b.pre(bg);
    b.start(BG);
    b.launched(bg, BG);
    b.pre(b.delegation('tester', 'Testar'));
    b.start(T);
    b.pre(b.call('Bash', { command: 'npm test', description: 'Rodar' }, T));
    // Esc: nenhum Stop.
    b.prompt('Segundo');
  });

  it('o novo pedido libera o primeiro plano e encerra o ticket como interrupted', () => {
    const result = run(scn);
    assertEvents(result.steps.at(-1).events, [
      ['agent.finished', T.id, { outcome: 'unknown' }],
      ['quest.phase', T.id, { phase: 'test', state: 'done' }],
      ['quest.finished', 'main', { n: 1, outcome: 'interrupted' }],
      ['quest.started', 'main', { n: 2, title: 'Segundo' }],
    ], { kinds: null });
    const session = view(result.state);
    assert.equal(agentOf(session, T.id).finished, true);
    assert.equal(agentOf(session, BG.id).status, 'working', 'o segundo plano segue');
    assert.equal(agentOf(session, 'main').status, 'working');
    assert.equal(session.quest.n, 2);
    assertRunShape(result);
  });

  it('o sinal é isolado em turnEndedWithoutStop (V12)', () => {
    const quest = { status: 'open', startedAt: 1000 };
    assert.equal(turnEndedWithoutStop(/** @type {any} */ (quest), 2000), true);
    assert.equal(turnEndedWithoutStop(/** @type {any} */ (quest), 500), false, 'sinal anterior ao ticket é atraso');
    assert.equal(turnEndedWithoutStop(/** @type {any} */ ({ ...quest, status: 'waiting_background' }), 2000), false);
    assert.equal(turnEndedWithoutStop(/** @type {any} */ ({ ...quest, status: 'done' }), 2000), false);
    assert.equal(turnEndedWithoutStop(null, 2000), false);
  });
});

describe('[T0] compactação (ordem de PreCompact, PostCompact e SessionStart compact)', () => {
  const pre = (b, trigger = 'auto', who) => b.raw('PreCompact', { trigger, custom_instructions: '' }, who);
  const post = (b, trigger = 'auto', who) => b.raw('PostCompact', { trigger, compact_summary: 'RESUMO-DA-COMPACTACAO' }, who);

  it('PreCompact deixa a atividade em "compactando", sem evento; PostCompact emite context.compacted', () => {
    const scn = scenario('compacta', 'Pre, Post e SessionStart compact', (b) => {
      b.sessionStart();
      b.prompt('Pedido longo');
      b.tool('Read', readClaude);
      pre(b);
      post(b);
      b.sessionStart('compact');
    });
    const during = run(scn, { until: 5 });
    assert.deepEqual(during.steps.at(-1).events, []);
    const activity = agentOf(view(during.state), 'main').activity;
    assert.deepEqual({ ...activity, at: 0 }, { kind: 'compact', category: null, tool: null, target: null, detail: 'auto', state: 'running', at: 0 });

    const result = run(scn);
    assertEvents(result.events, [['context.compacted', 'main', { trigger: 'auto' }]], { kinds: ['context.compacted'] });
    assert.equal(agentOf(view(result.state), 'main').activity.state, 'done');
    assert.ok(!JSON.stringify(view(result.state)).includes('RESUMO-DA-COMPACTACAO'));
    assertRunShape(result);
  });

  it('SessionStart compact antes do PostCompact: um evento só, com o trigger do PreCompact', () => {
    const scn = scenario('compacta-inverso', 'Pre, SessionStart compact e Post', (b) => {
      b.sessionStart();
      pre(b, 'manual');
      b.sessionStart('compact');
      post(b, 'manual');
    });
    const result = run(scn);
    assertEvents(result.events, [
      ['session.started', null],
      ['session.started', null],
      ['context.compacted', 'main', { trigger: 'manual' }],
    ], { kinds: null });
  });

  it('só o SessionStart compact (PostCompact perdido): context.compacted com trigger null', () => {
    const result = run(scenario('so-session-start', 'SessionStart compact', (b) => b.sessionStart('compact')));
    assertEvents(result.events, [['session.started', null], ['context.compacted', 'main', { trigger: null }]], { kinds: null });
  });

  it('compactação longa (mais de COMPACT_PAIR_MS entre Pre e Post) continua com um evento só', () => {
    const scn = scenario('compacta-longa', 'Pre, 90 s, Post e SessionStart compact', (b) => {
      b.sessionStart();
      pre(b);
      b.wait(COMPACT_PAIR_MS + 30_000);
      post(b);
      b.sessionStart('compact');
    });
    assert.equal(run(scn).events.filter((event) => event.kind === 'context.compacted').length, 1);
  });

  it('duas compactações seguidas: dois eventos', () => {
    const scn = scenario('duas-compactacoes', 'Pre, Post, Pre, Post', (b) => {
      b.sessionStart();
      pre(b);
      post(b);
      b.wait(10 * 60_000);
      pre(b, 'manual');
      post(b, 'manual');
    });
    assertEvents(run(scn).events, [
      ['context.compacted', 'main', { trigger: 'auto' }],
      ['context.compacted', 'main', { trigger: 'manual' }],
    ], { kinds: ['context.compacted'] });
  });

  it('compactação de um subagente: atividade e evento dele', () => {
    const T = agent('tester-compacta', 'tester');
    const scn = scenario('compacta-subagente', 'subagente compacta', (b) => {
      b.sessionStart();
      b.prompt('Testar');
      b.pre(b.delegation('tester', 'Testar'));
      b.start(T);
      pre(b, 'auto', T);
      post(b, 'auto', T);
    });
    const result = run(scn);
    assertEvents(result.events, [['context.compacted', T.id, { trigger: 'auto' }]], { kinds: ['context.compacted'] });
    assert.equal(agentOf(view(result.state), T.id).activity.kind, 'compact');
  });

  it('completeCompaction: sinal dentro da janela do anúncio, sem PreCompact no meio, é o par (ou duplicata)', () => {
    const table = /** @type {any} */ ({ compaction: null });
    assert.deepEqual(completeCompaction(table, 'auto', 1000), { trigger: 'auto' });
    assert.equal(completeCompaction(table, null, 1500), null);
    assert.equal(completeCompaction(table, 'auto', 1000 + COMPACT_PAIR_MS - 1), null);
    assert.deepEqual(completeCompaction(table, null, 1000 + COMPACT_PAIR_MS), { trigger: null }, 'fora da janela é outra');
    beginCompaction(table, 'manual');
    assert.deepEqual(completeCompaction(table, null, 1000 + COMPACT_PAIR_MS + 10), { trigger: 'manual' }, 'PreCompact novo abre outra');
  });
});

describe('fatos repetidos logo em seguida não geram evento nem mudam o estado (idempotência)', () => {
  it('pedido, aprovação, negação, aviso, compactação e Stop repetidos', () => {
    const scn = scenario('repetidos', 'cada fato duas vezes', (b) => {
      b.sessionStart();
      b.prompt('Pedido');
      const call = b.call('Bash', { command: 'npm run build', description: 'Build' });
      b.pre(call);
      b.raw('PermissionRequest', { tool_name: 'Bash', tool_input: call.input });
      b.post(call, { stdout: 'ok', stderr: '' });
      const denied = b.call('Bash', { command: 'rm -rf build', description: 'Apagar' });
      b.pre(denied);
      b.raw('PermissionDenied', { tool_name: 'Bash', tool_input: denied.input, tool_use_id: denied.id, reason: 'x' });
      const waiting = b.call('Bash', { command: 'git push', description: 'Enviar' });
      b.pre(waiting);
      b.notice('permission_prompt');
      b.raw('PreCompact', { trigger: 'auto' });
      b.raw('PostCompact', { trigger: 'auto' });
      b.stop();
    });
    const doubled = {
      ...scn,
      events: scn.events.flatMap((event) => (event.payload.hook_event_name === 'SessionStart' ? [event] : [event, { ...event, dt: 0 }])),
    };
    const once = run(scn);
    const twice = run(doubled);
    twice.steps.forEach((step, i) => {
      if (i > 0 && step.payload === twice.steps[i - 1].payload) assert.deepEqual(step.events, [], `duplicado de ${step.payload.hook_event_name}`);
    });
    assert.deepEqual(getSessionStates(twice.state), getSessionStates(once.state));
    assertRunShape(twice);
  });
});

describe('rótulo da sessão (seção 7)', () => {
  it('session_title vale mais que o título do primeiro ticket', () => {
    const scn = scenario('titulo-da-sessao', 'pedido com session_title', (b) => {
      b.sessionStart();
      b.prompt('Título do ticket', { session_title: 'Título da sessão' });
    });
    assert.equal(view(run(scn).state).label, 'Título da sessão');
  });

  it('título do primeiro ticket cortado em 48 caracteres', () => {
    const long = 'Implementar a ingestão de eventos com retomada e cliente lento no servidor';
    const result = run(scenario('titulo-longo', 'pedido com título longo', (b) => {
      b.sessionStart();
      b.prompt(long);
    }));
    const { label, quest } = view(result.state);
    assert.equal(quest.title, long);
    assert.ok([...label].length <= 48, label);
    assert.ok(label.endsWith('…'));
    assert.ok(long.startsWith(label.slice(0, -1)));
  });
});

describe('valores fora da lista chegam como null e não quebram o reducer', () => {
  it('source, reason, trigger e type desconhecidos', () => {
    const scn = scenario('fora-da-lista', 'valores desconhecidos', (b) => {
      b.raw('SessionStart', { source: 'teletransporte', model: 'claude-opus-5-5' });
      b.prompt('Pedido');
      b.raw('PreCompact', { trigger: 'misterioso' });
      b.raw('PostCompact', { trigger: 'misterioso' });
      b.notice('outro_tipo');
      b.raw('Stop', { background_tasks: [{ id: 'tarefa-1', status: 'estado-novo' }, 'lixo', null] });
      b.raw('SessionEnd', { reason: 'motivo-novo' });
    });
    const result = run(scn);
    assert.equal(result.steps[0].fact.source, null);
    assertEvents(result.events, [
      ['session.started', null, { source: null }],
      ['quest.started', 'main'],
      ['context.compacted', 'main', { trigger: null }],
      ['quest.finished', 'main', { outcome: 'interrupted' }],
      ['session.ended', null, { reason: null }],
    ], { kinds: null });
    // status desconhecido conta como tarefa ativa (V13): o ticket espera e termina interrupted no SessionEnd.
    assert.equal(view(result.state).quest.status, 'interrupted');
    assertRunShape(result);
  });
});

describe('funções isoladas por veredito (quests.js)', () => {
  it('V8: questKeyOf é o promptId do fato', () => {
    assert.equal(questKeyOf(/** @type {any} */ ({ promptId: 'p-1' })), 'p-1');
    assert.equal(questKeyOf(/** @type {any} */ ({ promptId: null })), null);
  });

  it('V7: isSystemPrompt só com origin system; null conta como usuário', () => {
    assert.equal(isSystemPrompt(/** @type {any} */ ({ origin: 'system' })), true);
    assert.equal(isSystemPrompt(/** @type {any} */ ({ origin: 'user' })), false);
    assert.equal(isSystemPrompt(/** @type {any} */ ({ origin: null })), false);
  });

  it('V13: hasActiveBackgroundTasks: só status de fim conhecido conta como encerrada', () => {
    assert.equal(hasActiveBackgroundTasks([]), false);
    for (const status of ['completed', 'failed', 'killed', 'Completed']) {
      assert.equal(hasActiveBackgroundTasks([/** @type {any} */ ({ status })]), false, status);
    }
    for (const status of ['running', 'pending', null, 'estado-novo']) {
      assert.equal(hasActiveBackgroundTasks([/** @type {any} */ ({ status })]), true, String(status));
    }
  });
});
