// Normalizador (modelo de eventos, seções 2, 3 e 10): os 15 hooks, campos
// comuns, itens a confirmar no T0 (V5, V7, V11), redação e limites de ponta a
// ponta, minimização e robustez. Os payloads seguem a documentação dos hooks
// (docs/pesquisa/hooks-claude-code.md, seção 2); os cenários da sonda estão em
// normalize-synthetic.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { charLength, redact } from '../../../../server/domain/redact.js';
import {
  HOOK_FACTS,
  MAX_BACKGROUND_TASKS,
  MAX_STORED_PATH_CHARS,
  SYSTEM_PROMPT_TAGS,
  agentLaunch,
  clientFromEntrypoint,
  normalize,
  promptOrigin,
  promptTitle,
} from '../../../../server/domain/normalize.js';
import { inputHash } from '../../../../server/domain/tools.js';
import { resolveRole } from '../../../../server/domain/roles.js';
import { SHORT_HEAD_CHARS, SHORT_TAIL_CHARS, cutString } from '../../../../capture/plugins/agent-quest/scripts/forward.mjs';
import { assertFactInvariants, prng } from './fact-checks.js';

const HOME = 'C:\\Users\\fulano';
const PROJECT = `${HOME}\\Projetos\\agents-quest`;
const SESSION = '5f1c2b3a-1111-4222-a333-444455556666';
const PROMPT_ID = '9b0e1d2c-7777-4888-a999-aaaabbbbcccc';
const TRANSCRIPT = `${HOME}\\.claude\\projects\\c--Users-fulano-Projetos-agents-quest\\${SESSION}.jsonl`;
const AGENT = 'a0123456789abcdef';
const TOOL_USE = 'toolu_01ABCDEFGHIJKLMNOPQRSTUV';
const SENT_AT = 1_760_000_000_100;
const RECEIVED_AT = 1_760_000_000_200;

/** Envelope v1 com o payload completado pelos campos comuns. */
function envelope(hook, fields = {}, { env = { projectDir: PROJECT, entrypoint: 'cli' }, sentAt = SENT_AT } = {}) {
  return {
    v: 1,
    sentAt,
    forwarder: '0.1.0',
    env,
    truncated: false,
    payload: {
      session_id: SESSION,
      prompt_id: PROMPT_ID,
      transcript_path: TRANSCRIPT,
      cwd: PROJECT,
      permission_mode: 'default',
      hook_event_name: hook,
      ...fields,
    },
  };
}

const run = (hook, fields, options) => normalize(envelope(hook, fields, options), { receivedAt: RECEIVED_AT, homeDir: HOME });

/** Campos comuns esperados (seção 2). */
function common(hook, extra = {}) {
  return {
    kind: HOOK_FACTS[hook],
    hook,
    sessionId: SESSION,
    agentId: null,
    agentType: null,
    agentTypeKey: null,
    promptId: PROMPT_ID,
    projectDir: PROJECT,
    client: 'terminal',
    ts: SENT_AT,
    receivedAt: RECEIVED_AT,
    transcriptPath: TRANSCRIPT,
    ...extra,
  };
}

const NO_AGENT_TOOL = { subagentType: null, subagentTypeKey: null, description: null };

describe('HOOK_FACTS', () => {
  it('os 15 eventos do ADR 0001, cada um com o fato da seção 2', () => {
    assert.deepEqual(HOOK_FACTS, {
      SessionStart: 'session.start',
      SessionEnd: 'session.end',
      UserPromptSubmit: 'prompt.submit',
      PreToolUse: 'tool.pre',
      PostToolUse: 'tool.post',
      PostToolUseFailure: 'tool.fail',
      PermissionRequest: 'permission.request',
      PermissionDenied: 'permission.denied',
      Notification: 'notice',
      SubagentStart: 'subagent.start',
      SubagentStop: 'subagent.stop',
      Stop: 'turn.stop',
      StopFailure: 'turn.fail',
      PreCompact: 'compact.pre',
      PostCompact: 'compact.post',
    });
    assert.ok(Object.isFrozen(HOOK_FACTS));
  });
});

describe('o que vira null', () => {
  it('evento desconhecido, fora dos 15 ou herdado do protótipo', () => {
    for (const hook of ['PostToolBatch', 'TaskCreated', 'MessageDisplay', 'Setup', 'pretooluse', '', 'constructor', '__proto__', 'toString']) {
      assert.equal(run(hook), null, hook);
    }
    assert.equal(run(42), null);
  });

  it('sem session_id, vazio, de outro tipo ou longo demais', () => {
    for (const sessionId of [undefined, null, '', 42, {}, ['x'], 'x'.repeat(129)]) {
      assert.equal(run('Stop', { session_id: sessionId }), null, String(sessionId));
    }
    assert.notEqual(run('Stop', { session_id: 'x'.repeat(128) }), null);
  });

  it('envelope ou payload que não são objetos', () => {
    for (const value of [undefined, null, 'x', 42, [], { v: 1 }, { v: 1, payload: [] }, { v: 1, payload: 'x' }]) {
      assert.equal(normalize(value, { receivedAt: RECEIVED_AT }), null, JSON.stringify(value));
    }
  });

  it('nunca lança, nem com getter que lança ou sem o segundo argumento', () => {
    const hostile = { v: 1, get payload() { throw new Error('boom'); } };
    assert.equal(normalize(hostile, { receivedAt: RECEIVED_AT }), null);
    assert.doesNotThrow(() => normalize(envelope('Stop')));
    assert.doesNotThrow(() => normalize(envelope('Stop'), null));
    assert.equal(normalize(envelope('Stop')).sessionId, SESSION);
  });
});

describe('campos comuns', () => {
  it('agent_id e agent_type do subagente; sem agent_id é a sessão principal', () => {
    const fact = run('SubagentStart', { agent_id: AGENT, agent_type: 'dev-backend' });
    assert.equal(fact.agentId, AGENT);
    assert.equal(fact.agentType, 'dev-backend');
    const main = run('Stop', { agent_type: 'arquiteto' }); // sessão iniciada com --agent
    assert.equal(main.agentId, null);
    assert.equal(main.agentType, 'arquiteto');
  });

  it('agent_type vazio vira null (agentes internos, V6)', () => {
    assert.equal(run('SubagentStop', { agent_id: AGENT, agent_type: '' }).agentType, null);
  });

  it('ts vem do sentAt; sem ele (ou inválido), da hora de chegada', () => {
    assert.equal(run('Stop').ts, SENT_AT);
    for (const sentAt of [null, 'x', -1, 0, Number.NaN, Infinity]) {
      assert.equal(run('Stop', {}, { sentAt }).ts, RECEIVED_AT, String(sentAt));
    }
    const withoutSentAt = envelope('Stop');
    delete withoutSentAt.sentAt;
    assert.equal(normalize(withoutSentAt, { receivedAt: RECEIVED_AT }).ts, RECEIVED_AT);
  });

  it('projectDir vem do env; sem ele, do cwd do payload', () => {
    assert.equal(run('Stop', { cwd: 'D:\\outro' }).projectDir, PROJECT);
    assert.equal(run('Stop', { cwd: 'D:\\outro' }, { env: { entrypoint: 'cli' } }).projectDir, 'D:\\outro');
    assert.equal(run('Stop', { cwd: 42 }, { env: null }).projectDir, null);
  });

  it('projectDir acima de 1024 ou que mudaria na redação vira null', () => {
    const long = `C:\\${'p'.repeat(MAX_STORED_PATH_CHARS - 3)}`;
    assert.equal(run('Stop', { cwd: null }, { env: { projectDir: long } }).projectDir, long, 'exatamente 1024');
    assert.equal(run('Stop', { cwd: null }, { env: { projectDir: `${long}p` } }).projectDir, null);
    assert.equal(run('Stop', { cwd: null }, { env: { projectDir: 'C:\\token=abc\\proj' } }).projectDir, null);
  });

  it('caminhos guardados vão até 1024: transcript de subagente com mais de 200 caracteres', () => {
    // Projeto de 104 caracteres: o transcript do subagente passa de 200 (seção 2).
    const project = `C:\\Users\\fulano\\OneDrive\\Documentos\\${'Projetos-com-nome-comprido\\'.repeat(2)}agents-quest-${'x'.repeat(10)}`;
    const slug = project.replace(/[:\\]/g, '-');
    const sessionDir = `C:\\Users\\fulano\\.claude\\projects\\${slug}\\${SESSION}`;
    const transcript = `${sessionDir}.jsonl`;
    const agentTranscript = `${sessionDir}\\subagents\\agent-${AGENT}.jsonl`;
    assert.ok(charLength(project) > 100 && charLength(agentTranscript) > 200 && charLength(transcript) > 150, `${charLength(project)} ${charLength(agentTranscript)}`);

    const fact = run(
      'SubagentStop',
      { agent_id: AGENT, agent_type: 'tester', transcript_path: transcript, agent_transcript_path: agentTranscript, cwd: project },
      { env: { projectDir: project, entrypoint: 'cli' } },
    );
    assert.equal(fact.projectDir, project);
    assert.equal(fact.transcriptPath, transcript);
    assert.equal(fact.agentTranscriptPath, agentTranscript);
    assertFactInvariants(fact, 'transcript longo');

    const tooLong = `C:\\${'t'.repeat(MAX_STORED_PATH_CHARS)}.jsonl`;
    const capped = run('SubagentStop', { agent_id: AGENT, transcript_path: tooLong, agent_transcript_path: tooLong });
    assert.deepEqual([capped.transcriptPath, capped.agentTranscriptPath], [null, null]);
  });

  it('a exceção vale só para os caminhos guardados: o alvo de arquivo continua até 200', () => {
    const file = `${PROJECT}\\${'pasta\\'.repeat(60)}a.js`;
    const fact = run('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } });
    assert.equal(charLength(fact.target), 200);
  });

  it('prompt_id e transcript_path ausentes viram null', () => {
    const fact = run('Stop', { prompt_id: undefined, transcript_path: undefined });
    assert.equal(fact.promptId, null);
    assert.equal(fact.transcriptPath, null);
  });

  it('receivedAt e homeDir vêm das opções', () => {
    const fact = normalize(envelope('PreToolUse', { tool_name: 'Read', tool_input: { file_path: `${HOME}\\x.md` } }, { env: {} }), {
      receivedAt: 5,
      homeDir: HOME,
    });
    assert.equal(fact.receivedAt, 5);
    assert.equal(fact.target, '~/x.md');
  });
});

describe('fato de cada hook (seção 2)', () => {
  it('SessionStart → session.start', () => {
    const fact = run('SessionStart', { source: 'startup', model: 'claude-opus-5-5', session_title: 'Minha sessão' });
    assert.deepEqual(fact, { ...common('SessionStart'), source: 'startup', model: 'claude-opus-5-5', sessionTitle: 'Minha sessão' });
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) assert.equal(run('SessionStart', { source }).source, source);
    assert.equal(run('SessionStart', { source: 'outra' }).source, null);
    assert.equal(run('SessionStart', {}).model, null);
  });

  it('SessionEnd → session.end', () => {
    assert.deepEqual(run('SessionEnd', { reason: 'logout' }), { ...common('SessionEnd'), reason: 'logout' });
    for (const reason of ['clear', 'resume', 'logout', 'prompt_input_exit', 'other']) assert.equal(run('SessionEnd', { reason }).reason, reason);
    assert.equal(run('SessionEnd', { reason: 42 }).reason, null);
  });

  it('UserPromptSubmit → prompt.submit (só a primeira linha, redigida; nunca o pedido inteiro)', () => {
    const fact = run('UserPromptSubmit', { prompt: '\n  Implementar a ingestão com token=abc  \nSEGUNDA-LINHA secreta', session_title: 'Título' });
    assert.deepEqual(fact, {
      ...common('UserPromptSubmit'),
      title: 'Implementar a ingestão com token=•••',
      origin: 'user',
      sessionTitle: 'Título',
    });
    assert.doesNotMatch(JSON.stringify(fact), /SEGUNDA-LINHA|abc/);
  });

  it('PreToolUse → tool.pre', () => {
    const input = { command: 'npm test', description: 'Rodar a suíte', timeout: 1000 };
    const fact = run('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: TOOL_USE, agent_id: AGENT, agent_type: 'tester' });
    assert.deepEqual(fact, {
      ...common('PreToolUse', { agentId: AGENT, agentType: 'tester', agentTypeKey: 'tester' }),
      toolUseId: TOOL_USE,
      tool: 'Bash',
      category: 'bash',
      target: 'npm test',
      detail: 'Rodar a suíte',
      inputHash: inputHash(input),
      background: false,
      ...NO_AGENT_TOOL,
    });
  });

  it('PreToolUse do Agent: subagentType, description e background', () => {
    const input = { description: 'Testar a ingestão', prompt: 'PROMPT-DO-AGENTE', subagent_type: 'tester', run_in_background: true };
    const fact = run('PreToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: TOOL_USE });
    assert.deepEqual(fact, {
      ...common('PreToolUse'),
      toolUseId: TOOL_USE,
      tool: 'Agent',
      category: null,
      target: 'tester',
      detail: 'Testar a ingestão',
      inputHash: inputHash(input),
      background: true,
      subagentType: 'tester',
      subagentTypeKey: 'tester',
      description: 'Testar a ingestão',
    });
    assert.doesNotMatch(JSON.stringify(fact), /PROMPT-DO-AGENTE/);
    assert.equal(run('PreToolUse', { tool_name: 'Task', tool_input: input }).subagentType, 'tester', 'nome antigo');
  });

  it('PostToolUse → tool.post (sem stdout, stderr nem conteúdo)', () => {
    const input = { file_path: `${PROJECT}\\server\\main.js` };
    const fact = run('PostToolUse', {
      tool_name: 'Read',
      tool_input: input,
      tool_use_id: TOOL_USE,
      tool_response: { file: { content: 'CONTEUDO-DO-ARQUIVO' }, stdout: 'SAIDA' },
      duration_ms: 12,
    });
    assert.deepEqual(fact, {
      ...common('PostToolUse'),
      toolUseId: TOOL_USE,
      tool: 'Read',
      category: 'read',
      target: 'server/main.js',
      detail: null,
      inputHash: inputHash(input),
      background: false,
      ...NO_AGENT_TOOL,
      durationMs: 12,
      linkedAgentId: null,
      launch: null,
      testResult: null,
    });
    assert.doesNotMatch(JSON.stringify(fact), /CONTEUDO-DO-ARQUIVO|SAIDA/);
  });

  it('PostToolUse do Agent: linkedAgentId e launch (V5)', () => {
    const input = { description: 'x', subagent_type: 'tester' };
    const done = run('PostToolUse', {
      tool_name: 'Agent',
      tool_input: input,
      tool_use_id: TOOL_USE,
      tool_response: { status: 'completed', agentId: AGENT, content: [{ type: 'text', text: 'RESULTADO' }], totalTokens: 1 },
    });
    assert.equal(done.linkedAgentId, AGENT);
    assert.equal(done.launch, 'completed');
    assert.doesNotMatch(JSON.stringify(done), /RESULTADO/);
    const async = run('PostToolUse', {
      tool_name: 'Agent',
      tool_input: { ...input, run_in_background: true },
      tool_response: { status: 'async_launched', agentId: AGENT, prompt: 'PROMPT', outputFile: 'C:\\tmp\\x.output' },
    });
    assert.deepEqual([async.linkedAgentId, async.launch, async.background], [AGENT, 'async_launched', true]);
    assert.doesNotMatch(JSON.stringify(async), /PROMPT|x\.output/);
  });

  it('PostToolUse de outra ferramenta nunca liga agente, mesmo com agentId na resposta', () => {
    const fact = run('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { agentId: AGENT, status: 'completed' } });
    assert.deepEqual([fact.linkedAgentId, fact.launch], [null, null]);
  });

  it('PostToolUseFailure → tool.fail (primeira linha do erro, redigida; interrupção)', () => {
    const input = { command: 'node -e "process.exit(3)"' };
    const fact = run('PostToolUseFailure', {
      tool_name: 'Bash',
      tool_input: input,
      tool_use_id: TOOL_USE,
      error: 'Exit code 3\nSAIDA-DE-ERRO password=x',
      is_interrupt: true,
      duration_ms: 40,
    });
    assert.deepEqual(fact, {
      ...common('PostToolUseFailure'),
      toolUseId: TOOL_USE,
      tool: 'Bash',
      category: 'bash',
      target: 'node -e "process.exit(3)"',
      detail: null,
      inputHash: inputHash(input),
      background: false,
      ...NO_AGENT_TOOL,
      durationMs: 40,
      error: 'Exit code 3',
      interrupted: true,
      testResult: null,
    });
    assert.equal(run('PostToolUseFailure', { tool_name: 'Bash', error: 'x', is_interrupt: 'true' }).interrupted, false);
  });

  it('PermissionRequest → permission.request, com o mesmo inputHash do PreToolUse', () => {
    const input = { command: 'node -e "1"', description: 'x' };
    const fact = run('PermissionRequest', { tool_name: 'Bash', tool_input: input, permission_suggestions: [{ type: 'addRules' }] });
    assert.deepEqual(fact, {
      ...common('PermissionRequest'),
      tool: 'Bash',
      category: 'bash',
      target: 'node -e "1"',
      inputHash: inputHash(input),
    });
    const pre = run('PreToolUse', { tool_name: 'Bash', tool_input: { description: 'x', command: 'node -e "1"' }, tool_use_id: TOOL_USE });
    assert.equal(fact.inputHash, pre.inputHash, 'mesmo tool_input com as chaves em outra ordem');
  });

  it('PermissionDenied → permission.denied', () => {
    const fact = run('PermissionDenied', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, tool_use_id: TOOL_USE, reason: 'auto mode' });
    assert.deepEqual(fact, { ...common('PermissionDenied'), toolUseId: TOOL_USE, tool: 'Bash', category: 'bash' });
  });

  it('Notification → notice (só permission_prompt e idle_prompt; nunca a mensagem)', () => {
    assert.deepEqual(run('Notification', { notification_type: 'permission_prompt', message: 'MENSAGEM', title: 'T' }), {
      ...common('Notification'),
      type: 'permission_prompt',
    });
    assert.equal(run('Notification', { notification_type: 'idle_prompt' }).type, 'idle_prompt');
    for (const type of ['auth_success', 'agent_completed', '', 42, undefined]) {
      const fact = run('Notification', { notification_type: type, message: 'MENSAGEM' });
      assert.equal(fact.type, null, String(type));
      assert.doesNotMatch(JSON.stringify(fact), /MENSAGEM/);
    }
  });

  it('SubagentStart → subagent.start', () => {
    assert.deepEqual(run('SubagentStart', { agent_id: AGENT, agent_type: 'tester' }), {
      ...common('SubagentStart', { agentId: AGENT, agentType: 'tester', agentTypeKey: 'tester' }),
    });
  });

  it('SubagentStop → subagent.stop (sem o texto do assistente)', () => {
    const transcript = `${HOME}\\.claude\\projects\\p\\${SESSION}\\subagents\\agent-${AGENT}.jsonl`;
    const fact = run('SubagentStop', {
      agent_id: AGENT,
      agent_type: 'tester',
      agent_transcript_path: transcript,
      last_assistant_message: 'RESPOSTA-DO-ASSISTENTE',
      stop_hook_active: false,
      background_tasks: [],
    });
    assert.deepEqual(fact, { ...common('SubagentStop', { agentId: AGENT, agentType: 'tester', agentTypeKey: 'tester' }), agentTranscriptPath: transcript });
    assert.doesNotMatch(JSON.stringify(fact), /RESPOSTA-DO-ASSISTENTE/);
  });

  it('Stop → turn.stop, com as tarefas em segundo plano', () => {
    const fact = run('Stop', {
      last_assistant_message: 'RESPOSTA-DO-ASSISTENTE',
      stop_hook_active: false,
      background_tasks: [
        { id: AGENT, type: 'local_agent', status: 'running', description: 'DESCRICAO', agent_type: 'tester' },
        'lixo',
        { id: 42 },
      ],
      session_crons: [],
    });
    assert.deepEqual(fact, {
      ...common('Stop'),
      backgroundTasks: [
        { id: AGENT, type: 'local_agent', status: 'running', agentType: 'tester', agentTypeKey: 'tester' },
        { id: null, type: null, status: null, agentType: null, agentTypeKey: null },
      ],
    });
    assert.doesNotMatch(JSON.stringify(fact), /RESPOSTA-DO-ASSISTENTE|DESCRICAO/);
    assert.deepEqual(run('Stop', { background_tasks: 'x' }).backgroundTasks, []);
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, type: 'local_agent', status: 'running' }));
    assert.equal(run('Stop', { background_tasks: many }).backgroundTasks.length, MAX_BACKGROUND_TASKS);
  });

  it('StopFailure → turn.fail (tipo do erro; sem o texto do erro da API)', () => {
    const fact = run('StopFailure', { error: 'rate_limit', error_details: 'DETALHES', last_assistant_message: 'TEXTO-DA-API' });
    assert.deepEqual(fact, { ...common('StopFailure'), error: 'rate_limit' });
    assert.doesNotMatch(JSON.stringify(fact), /DETALHES|TEXTO-DA-API/);
  });

  it('PreCompact e PostCompact → compact.pre e compact.post (sem instruções nem resumo)', () => {
    const pre = run('PreCompact', { trigger: 'manual', custom_instructions: 'INSTRUCOES' });
    const post = run('PostCompact', { trigger: 'auto', compact_summary: 'RESUMO' });
    assert.deepEqual(pre, { ...common('PreCompact'), trigger: 'manual' });
    assert.deepEqual(post, { ...common('PostCompact'), trigger: 'auto' });
    assert.doesNotMatch(JSON.stringify([pre, post]), /INSTRUCOES|RESUMO/);
    assert.equal(run('PreCompact', { trigger: 'outro' }).trigger, null);
  });
});

describe('itens a confirmar no T0 (leitura defensiva)', () => {
  it('V7: origem do pedido pela marca do sistema no início', () => {
    assert.deepEqual(SYSTEM_PROMPT_TAGS, ['task-notification']);
    assert.equal(promptOrigin('<task-notification>\n<task-id>x</task-id>\n</task-notification>'), 'system');
    assert.equal(promptOrigin('  \n<task-notification> x'), 'system');
    assert.equal(promptOrigin('Implementar a ingestão'), 'user');
    assert.equal(promptOrigin('olhe <task-notification> no meio'), 'user');
    assert.equal(promptOrigin('<task-notifications>'), 'user');
    assert.equal(promptOrigin('<div>colado</div>'), 'user');
    assert.equal(promptOrigin(''), 'user');
    for (const value of [undefined, null, 42, {}, ['x']]) assert.equal(promptOrigin(value), null, String(value));
    assert.equal(run('UserPromptSubmit', { prompt: 42 }).origin, null);
    assert.equal(run('UserPromptSubmit', {}).title, null);
  });

  it('V5: linkedAgentId e launch do tool_response do Agent', () => {
    assert.deepEqual(agentLaunch({ status: 'completed', agentId: AGENT }), { linkedAgentId: AGENT, launch: 'completed' });
    assert.deepEqual(agentLaunch({ status: 'async_launched', agentId: AGENT }), { linkedAgentId: AGENT, launch: 'async_launched' });
    assert.deepEqual(agentLaunch({ status: 'outro', agentId: 42 }), { linkedAgentId: null, launch: null });
    assert.deepEqual(agentLaunch({ agent_id: AGENT }), { linkedAgentId: null, launch: null }, 'só agentId (camelCase)');
    for (const value of [undefined, null, 'x', [], 42]) assert.deepEqual(agentLaunch(value), { linkedAgentId: null, launch: null });
  });

  it('V11: client a partir do entrypoint', () => {
    assert.equal(clientFromEntrypoint('cli'), 'terminal');
    assert.equal(clientFromEntrypoint(' CLI '), 'terminal');
    assert.equal(clientFromEntrypoint('claude-vscode'), 'vscode');
    for (const value of ['sdk-ts', 'claude-desktop', '', null, undefined, 42, {}]) {
      assert.equal(clientFromEntrypoint(value), null, String(value));
    }
    assert.equal(run('Stop', {}, { env: { projectDir: PROJECT, entrypoint: 'claude-vscode' } }).client, 'vscode');
    assert.equal(run('Stop', {}, { env: { projectDir: PROJECT } }).client, null);
  });
});

describe('título do pedido', () => {
  it('primeira linha não vazia; "/" usa só o comando', () => {
    assert.equal(promptTitle('/compact'), '/compact');
    assert.equal(promptTitle('/review src/a.js com token=abc'), '/review');
    assert.equal(promptTitle('\n\n  Olá  \nmundo'), 'Olá');
    assert.equal(promptTitle('   '), null);
  });
});

describe('redação e limites de ponta a ponta, campo por campo (seção 10)', () => {
  /** [campo, montar o fato com o texto, campo do fato, limite] */
  const fields = [
    ['comando', (text) => run('PreToolUse', { tool_name: 'Bash', tool_input: { command: text } }), 'target', 120],
    ['descrição do Bash', (text) => run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x', description: text } }), 'detail', 80],
    ['descrição do Agent', (text) => run('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 't', description: text } }), 'description', 80],
    ['título do pedido', (text) => run('UserPromptSubmit', { prompt: text }), 'title', 80],
    ['erro da ferramenta', (text) => run('PostToolUseFailure', { tool_name: 'Bash', error: text }), 'error', 160],
    ['erro do turno', (text) => run('StopFailure', { error: text }), 'error', 160],
    ['padrão de busca', (text) => run('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: text } }), 'target', 60],
    ['consulta web', (text) => run('PreToolUse', { tool_name: 'WebSearch', tool_input: { query: text } }), 'target', 80],
    ['título da sessão', (text) => run('SessionStart', { session_title: text }), 'sessionTitle', 80],
  ];

  for (const [label, build, field, limit] of fields) {
    it(`${label}: redigido, até ${limit} caracteres e ponto fixo de redact`, () => {
      const secret = `ghp_${'Z'.repeat(36)}`;
      const short = build(`x ${secret} y`)[field];
      assert.equal(short, 'x ••• y');

      const long = build(`token=${'s'.repeat(30)} ${'palavra '.repeat(100)}`)[field];
      assert.ok(long.startsWith('token=•••'), long);
      assert.equal(charLength(long), limit);
      assert.ok(long.endsWith('…'));
      assert.equal(redact(long), long);

      const exact = build('a'.repeat(limit))[field];
      assert.equal(exact, 'a'.repeat(limit), 'no limite exato não corta');
    });
  }

  it('limite conta caracteres depois da redação (o segredo nunca aparece pela metade)', () => {
    const text = `${'a'.repeat(110)} sk-ant-${'k'.repeat(40)}`;
    const target = run('PreToolUse', { tool_name: 'Bash', tool_input: { command: text } }).target;
    assert.equal(target, `${'a'.repeat(110)} •••`);
    assert.doesNotMatch(target, /sk-ant|kkk/);
  });

  it('o comando de teste da seção 10 (curl com Bearer e senha em URL) sai limpo', () => {
    const fact = run('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'curl -H "Authorization: Bearer abc.def.ghi" https://usuario:senha-da-url@example.com/x' },
    });
    assert.equal(fact.target, 'curl -H "Authorization: •••" https://•••@example.com/x');
  });
});

describe('ajustes da revisão do tester (seções 2 e 10, 18/10/2026)', () => {
  it('agent_id presente e inválido descarta o evento; ausente ou null é a sessão principal', () => {
    for (const agentId of [42, {}, ['a'], '', true, 'a'.repeat(129)]) {
      assert.equal(run('PreToolUse', { tool_name: 'Read', agent_id: agentId }), null, JSON.stringify(agentId).slice(0, 20));
      assert.equal(run('SubagentStop', { agent_id: agentId, agent_type: 'tester' }), null);
    }
    assert.equal(run('PreToolUse', { tool_name: 'Read', agent_id: null }).agentId, null);
    assert.equal(run('PreToolUse', { tool_name: 'Read' }).agentId, null);
    assert.equal(run('PreToolUse', { tool_name: 'Read', agent_id: 'a'.repeat(128) }).agentId, 'a'.repeat(128));
  });

  it('fatos de ferramenta têm exatamente as chaves da própria linha, mais as comuns', () => {
    const commonKeys = Object.keys(common('PreToolUse'));
    const preKeys = ['toolUseId', 'tool', 'category', 'target', 'detail', 'inputHash', 'background', 'subagentType', 'subagentTypeKey', 'description'];
    const expected = {
      PreToolUse: [...commonKeys, ...preKeys],
      PostToolUse: [...commonKeys, ...preKeys, 'durationMs', 'linkedAgentId', 'launch', 'testResult'],
      PostToolUseFailure: [...commonKeys, ...preKeys, 'error', 'interrupted', 'durationMs', 'testResult'],
    };
    for (const [hook, keys] of Object.entries(expected)) {
      for (const tool of ['Bash', 'Agent', 'mcp__s__t', 'Desconhecida']) {
        const fact = run(hook, { tool_name: tool, tool_input: { command: 'x', subagent_type: 't' }, error: 'e', tool_response: {} });
        assert.deepEqual(Object.keys(fact).sort(), [...keys].sort(), `${hook} ${tool}`);
      }
    }
  });

  it('identificadores: exibidos crus só se casarem com o padrão e forem ponto fixo; o papel sai do *Key (auth:tester → tes)', () => {
    const fact = run('SubagentStart', { agent_id: AGENT, agent_type: 'auth:tester' });
    assert.equal(fact.agentType, 'auth:•••');
    assert.equal(fact.agentTypeKey, 'auth:tester');
    assert.equal(resolveRole(fact.agentTypeKey), 'tes');
    const delegation = run('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'token:dev-backend' } });
    assert.deepEqual([delegation.subagentType, delegation.target], ['token:•••', 'token:•••']);
    assert.equal(delegation.subagentTypeKey, 'token:dev-backend');
    assert.equal(resolveRole(delegation.subagentTypeKey), 'dev');
    assert.equal(run('SessionStart', { model: 'secret:model-1' }).model, 'secret:•••');
    assert.equal(run('PreToolUse', { tool_name: 'mcp__auth__token' }).target, 'auth/token');
    assert.equal(run('PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'pwd:helper' } }).target, 'pwd:•••');
    assert.deepEqual([run('SubagentStart', { agent_id: AGENT, agent_type: 'tester' }).agentType, run('Stop').agentTypeKey], ['tester', null]);
  });

  it('vetores obrigatórios: https://u:p@h/, ghp_… e AKIA… em subagent_type e tool_name não aparecem crus', () => {
    const secrets = ['https://u:p@h/', `ghp_${'A'.repeat(36)}`, `AKIA${'B'.repeat(16)}`];
    for (const secret of secrets) {
      const delegation = run('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: secret, description: 'x' } });
      const tool = run('PreToolUse', { tool_name: secret, tool_input: {} });
      const permission = run('PermissionRequest', { tool_name: secret, tool_input: {} });
      for (const value of [delegation.subagentType, delegation.target, tool.tool, tool.target, permission.tool, permission.target]) {
        assert.doesNotMatch(String(value), /u:p@|ghp_A|AKIAB/, `${secret} → ${value}`);
        assert.equal(redact(String(value)), String(value));
      }
      assert.equal(delegation.subagentTypeKey, secret, 'o cru fica só no *Key, para uso interno');
      assert.equal(tool.category, 'other');
    }
  });

  it('B8: valor sensível com cor ANSI não aparece no erro, no comando nem no título', () => {
    const colored = 'API_KEY=\x1B[32mabc123segredo\x1B[0m e token=\x1B[1mghp_' + 'A'.repeat(36) + '\x1B[0m';
    const fail = run('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: colored }, error: `Erro: ${colored}` });
    const prompt = run('UserPromptSubmit', { prompt: colored });
    for (const value of [fail.error, fail.target, prompt.title]) {
      assert.doesNotMatch(value, /abc123segredo|AAAA|\[32m|\[1m|\[0m/, value);
      assert.equal(redact(value), value);
    }
    assert.equal(fail.error, 'Erro: API_KEY=••• e token=•••');
  });

  it('nome MCP remontado e alvo servidor/ferramenta respeitam o limite de 80 (B7)', () => {
    for (const size of [40, 80, 300]) {
      const name = `mcp__${'a'.repeat(size)}__${'b'.repeat(size)}`;
      for (const hook of ['PreToolUse', 'PermissionRequest']) {
        const fact = run(hook, { tool_name: name, tool_input: {} });
        assert.ok(charLength(fact.tool) <= 80, `${hook} ${size}: tool com ${charLength(fact.tool)}`);
        assert.ok(charLength(fact.target) <= 80, `${hook} ${size}: target com ${charLength(fact.target)}`);
        assert.equal(redact(fact.tool), fact.tool);
        assert.equal(fact.category, 'mcp');
      }
    }
    assert.equal(run('PreToolUse', { tool_name: `mcp__${'a'.repeat(30)}__${'b'.repeat(30)}` }).tool, `mcp__${'a'.repeat(30)}__${'b'.repeat(30)}`);
  });

  it('nome MCP exibido remontado por partes: mcp__ghp_…__x vira mcp__•••__x; a categoria vem do cru', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const fact = run('PreToolUse', { tool_name: `mcp__${token}__x`, tool_input: {} });
    assert.deepEqual([fact.tool, fact.category, fact.target], ['mcp__•••__x', 'mcp', '•••/x']);
    const permission = run('PermissionRequest', { tool_name: `mcp__srv__${token}`, tool_input: {} });
    assert.deepEqual([permission.tool, permission.category, permission.target], ['mcp__srv__•••', 'mcp', 'srv/•••']);
    assert.equal(run('PreToolUse', { tool_name: 'mcp__claude_ai_Supabase__list_tables' }).tool, 'mcp__claude_ai_Supabase__list_tables');
    // ESC antes do token: a sequência sai depois da redação, sem comer letras do token.
    const escaped = run('PreToolUse', { tool_name: `mcp__\x1B[${token}__x` });
    for (const value of [escaped.tool, escaped.target]) assert.doesNotMatch(value, /hp_A|AAAA/, value);
    assert.equal(escaped.category, 'mcp');
  });

  it('ids: agent_id e session_id fora de ^[A-Za-z0-9_.:-]{1,128}$ descartam; tool_use_id e prompt_id viram null', () => {
    for (const bad of ['   ', 'a b', 'a\nb', 'á', 'a/b', '']) {
      assert.equal(run('PreToolUse', { tool_name: 'Read', agent_id: bad }), null, JSON.stringify(bad));
      assert.equal(run('Stop', { session_id: bad }), null, JSON.stringify(bad));
    }
    for (const good of ['a0123456789abcdef', SESSION, 'x_y.z:1-2']) {
      assert.equal(run('PreToolUse', { tool_name: 'Read', agent_id: good }).agentId, good);
    }
    const fact = run('PostToolUse', { tool_name: 'Read', tool_use_id: 'tool use', prompt_id: 'p d', tool_response: {} });
    assert.ok(fact, 'tool_use_id e prompt_id fora do padrão não descartam');
    assert.deepEqual([fact.toolUseId, fact.promptId], [null, null]);
    const link = run('PostToolUse', { tool_name: 'Agent', tool_input: {}, tool_response: { agentId: 'a b', status: 'completed' } });
    assert.equal(link.linkedAgentId, null);
  });

  it('*Key: sem invisíveis e controles; vazio ou acima de 128 vira null; também em backgroundTasks', () => {
    const zw = String.fromCharCode(0x200b);
    assert.equal(run('SubagentStart', { agent_id: AGENT, agent_type: `tes${zw}ter\x00` }).agentTypeKey, 'tester');
    assert.equal(run('SubagentStart', { agent_id: AGENT, agent_type: 'a'.repeat(129) }).agentTypeKey, null);
    assert.equal(run('SubagentStart', { agent_id: AGENT, agent_type: 'a'.repeat(128) }).agentTypeKey, 'a'.repeat(128));
    assert.equal(run('SubagentStart', { agent_id: AGENT, agent_type: `${zw}` }).agentTypeKey, null);
    assert.equal(run('PreToolUse', { tool_name: 'Bash', tool_input: { subagent_type: 'tester' } }).subagentTypeKey, null, 'só Agent e Task');
    const stop = run('Stop', { background_tasks: [{ id: AGENT, type: 'local_agent', status: 'running', agent_type: 'auth:tester' }] });
    assert.deepEqual(stop.backgroundTasks[0], { id: AGENT, type: 'local_agent', status: 'running', agentType: 'auth:•••', agentTypeKey: 'auth:tester' });
  });

  it('identificadores: invisíveis e controles saem antes; fora do padrão, redactAndCut(…, 80)', () => {
    const zw = String.fromCharCode(0x200b);
    const fact = run('PreToolUse', { tool_name: `Ba${zw}sh\x00`, agent_id: AGENT, agent_type: `tes${zw}ter\x1B[0m`, tool_input: { command: 'ls' } });
    assert.equal(fact.tool, 'Bash');
    assert.equal(fact.category, 'bash', 'a categoria sai do nome cru, sem invisíveis');
    assert.equal(fact.agentType, 'tester');
    assert.equal(run('SubagentStart', { agent_id: AGENT, agent_type: 'meu agente token=abc' }).agentType, 'meu agente token=•••');
    assert.equal(charLength(run('SubagentStart', { agent_id: AGENT, agent_type: 'x'.repeat(200) }).agentType), 80);
    assert.equal(run('SessionStart', { model: 'claude-opus-5-5[1m]' }).model, 'claude-opus-5-5[1m]');
    assert.equal(run('SubagentStart', { agent_id: AGENT, agent_type: `${zw}\x07` }).agentType, null);
  });

  it('B3: palavras partidas encostadas no marcador do encaminhador real somem (corte 1024 + 3072)', () => {
    // Vetor do tester: o começo do token fica no trecho do início, encostado no marcador.
    const text = `${'\n'.repeat(1014)}ghp_${'A'.repeat(36)} ${'x'.repeat(5000)}`;
    const cut = cutString(text);
    assert.match(cut, /ghp_A{6}…\[cortado \d+ caracteres\]…x/, 'o corte do encaminhador parte o token');
    const visible = [
      run('UserPromptSubmit', { prompt: cut }).title,
      run('PreToolUse', { tool_name: 'Bash', tool_input: { command: cut } }).target,
      run('PostToolUseFailure', { tool_name: 'Bash', error: cut }).error,
    ];
    for (const out of visible) assert.ok(out === null || !out.includes('ghp_'), JSON.stringify(out));
    assert.equal(visible[0], '…');
  });

  it('B3: token encostado no início do trecho final também some', () => {
    const text = `${'\n'.repeat(2000)}ghp_${'A'.repeat(36)}${'B'.repeat(3042)}`;
    const cut = cutString(text);
    assert.match(cut, /…\[cortado \d+ caracteres\]…A+B/, 'o trecho final começa no meio do token');
    const title = run('UserPromptSubmit', { prompt: cut }).title;
    assert.equal(title, '…');
  });

  it('B3: corte de 128 + 384 do teto do corpo', () => {
    const text = `${'\n'.repeat(120)}ghp_${'A'.repeat(36)} ${'x'.repeat(1000)}`;
    const cut = cutString(text, SHORT_HEAD_CHARS, SHORT_TAIL_CHARS);
    assert.match(cut, /ghp_A{4}…\[cortado/);
    assert.equal(run('UserPromptSubmit', { prompt: cut }).title, '…');
    const middle = `antes ${'a'.repeat(200)} ghp_${'A'.repeat(36)} depois ${'b'.repeat(400)} fim`;
    const title = run('UserPromptSubmit', { prompt: cutString(middle, SHORT_HEAD_CHARS, SHORT_TAIL_CHARS) }).title;
    assert.ok(title.startsWith('antes '), title);
    assert.doesNotMatch(title, /ghp_|aaaa…/);
  });
});

describe('minimização e robustez', () => {
  it('campos proibidos (seção 10): nenhum fato dos 15 hooks tem as chaves listadas, mesmo vindo no payload', () => {
    const forbidden = {
      content: 'X', old_string: 'X', new_string: 'X', stdout: 'X', stderr: 'X',
      last_assistant_message: 'X', compact_summary: 'X', custom_instructions: 'X', message: 'X', error_details: 'X',
    };
    const payload = {
      ...forbidden,
      agent_id: AGENT,
      tool_name: 'Bash',
      tool_input: { command: 'x', ...forbidden },
      tool_response: { ...forbidden, agentId: AGENT, status: 'completed' },
      prompt: 'pedido\nresto',
    };
    const extraKeys = ['prompt', 'message', 'compact_summary', 'custom_instructions', 'error_details', 'tool_input', 'tool_response'];
    for (const hook of Object.keys(HOOK_FACTS)) {
      const fact = run(hook, payload);
      assertFactInvariants(fact, hook);
      for (const key of extraKeys) assert.ok(!(key in fact), `${hook}: ${key}`);
    }
  });

  it('strings enormes em todos os campos: nada acima de 200 caracteres e tempo razoável', () => {
    const huge = `${'segredo token=abc '.repeat(30_000)}\n${'x'.repeat(100_000)}`;
    const payloadFields = {
      session_id: SESSION,
      agent_id: AGENT,
      agent_type: huge,
      prompt: huge,
      session_title: huge,
      model: huge,
      error: huge,
      tool_name: huge,
      tool_input: { command: huge, description: huge, file_path: huge, pattern: huge, query: huge, url: huge, content: huge },
      tool_response: { stdout: huge, agentId: huge, status: huge },
      background_tasks: [{ id: huge, type: huge, status: huge, agent_type: huge }],
      transcript_path: huge,
      agent_transcript_path: huge,
      cwd: huge,
    };
    const start = performance.now();
    for (const hook of Object.keys(HOOK_FACTS)) {
      const fact = run(hook, payloadFields, { env: { projectDir: huge, entrypoint: huge } });
      assert.ok(fact, hook);
      assertFactInvariants(fact, hook);
    }
    assert.ok(performance.now() - start < 5000, 'os 15 hooks com ~600 mil caracteres cada em menos de 5 s');
  });

  it('JSON aleatório nunca lança, e todo fato respeita a seção 10 (determinístico)', () => {
    const random = prng(20261018);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const hooks = [...Object.keys(HOOK_FACTS), 'PostToolBatch', 'Qualquer'];
    const tools = ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'TodoWrite', 'mcp__s__t', 'mcp__', 'X'];
    const pieces = ['a', ' ', '\n', '\\', '/', 'C:', '..', '=', ':', '"', "'", 'token', 'password', 'Bearer ', 'ghp_', 'é', '🙂', '<task-notification>', '•', '…', '\u0000', '\u200B'];

    function randomString() {
      const length = random() < 0.05 ? 2000 : Math.floor(random() * 40);
      let out = '';
      for (let i = 0; i < length; i++) out += pick(pieces);
      return out;
    }
    function randomValue(depth = 0) {
      const r = random();
      if (r < 0.35) return randomString();
      if (r < 0.45) return Math.floor(random() * 2e6) - 1e6;
      if (r < 0.5) return random() < 0.5;
      if (r < 0.55) return null;
      if (depth > 2) return randomString();
      if (r < 0.75) return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(depth + 1));
      const keys = ['command', 'description', 'file_path', 'pattern', 'query', 'url', 'subagent_type', 'agentId', 'status', 'id', 'type', 'agent_type', 'content', 'x'];
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 5) }, () => [pick(keys), randomValue(depth + 1)]));
    }

    const keys = [
      'agent_id', 'agent_type', 'prompt_id', 'transcript_path', 'cwd', 'source', 'model', 'session_title', 'reason', 'prompt',
      'tool_name', 'tool_input', 'tool_use_id', 'tool_response', 'duration_ms', 'error', 'is_interrupt', 'notification_type',
      'message', 'agent_transcript_path', 'last_assistant_message', 'background_tasks', 'trigger', 'compact_summary',
    ];
    let facts = 0;
    for (let i = 0; i < 3000; i++) {
      const payload = { hook_event_name: pick(hooks), session_id: random() < 0.9 ? `s${i % 7}` : randomValue() };
      for (const key of keys) {
        if (random() >= 0.5) continue;
        if (key === 'tool_name' && random() < 0.8) payload[key] = pick(tools);
        // agent_id fora do padrão descarta o evento (seção 2): na maior parte das vezes, um id válido.
        else if (key === 'agent_id' && random() < 0.8) payload[key] = `a${i.toString(16)}`;
        else payload[key] = randomValue();
      }
      const env = random() < 0.8 ? { projectDir: random() < 0.7 ? PROJECT : randomValue(), entrypoint: randomValue() } : randomValue();
      const value = random() < 0.95 ? { v: 1, sentAt: randomValue(), env, payload } : randomValue();
      let fact;
      assert.doesNotThrow(() => (fact = normalize(value, { receivedAt: RECEIVED_AT, homeDir: HOME })), `iteração ${i}`);
      if (fact === null) continue;
      facts++;
      assert.equal(fact.kind, HOOK_FACTS[payload.hook_event_name], `iteração ${i}`);
      assertFactInvariants(fact, `iteração ${i}`);
    }
    assert.ok(facts > 1500, `poucos fatos gerados: ${facts}`);
  });
});
