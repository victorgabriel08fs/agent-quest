// Sessão sintética da sonda do T0, no formato gravado pelo dump.mjs.
// Não há dados reais ainda: estes payloads seguem a documentação dos hooks
// (docs/pesquisa/hooks-claude-code.md) e cobrem o roteiro do T0, inclusive os
// pedidos extras 6a, 6b e 10a. Na forma padrão, todos os itens V1 a V14 dão
// "confirmado" (com o log de depuração sintético).
//
// Os textos em MAIÚSCULAS (CONTEUDO-REAL-DO-ARQUIVO etc.) marcam conteúdo que
// nunca pode aparecer no relatório nem nos cenários sanitizados. Os ids têm a
// forma dos reais (UUID, toolu_..., "a" + 16 hexadecimais), e a pasta pessoal
// é fictícia.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const hex = (label, length) => createHash('sha256').update(label).digest('hex').slice(0, length);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** UUID v4 fictício e estável para um rótulo. */
export function uuid(label) {
  const h = hex(`uuid:${label}`, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** prompt_id fictício de um pedido do roteiro ('p01', 'p07r', 'q01'...). */
export const promptId = (label) => uuid(`prompt:${label}`);

const agentId = (label) => `a${hex(`agent:${label}`, 16)}`;
const toolUseId = (n) => `toolu_01${[...createHash('sha256').update(`tool:${n}`).digest()].slice(0, 22).map((b) => BASE62[b % 62]).join('')}`;

export const HOME = 'C:\\Users\\fulano';
export const PROJECT = `${HOME}\\Projetos\\agents-quest`;
export const WORKER = 'agent-quest-probe:probe-worker';
export const SESSION = uuid('sessao-terminal');
export const SESSION_CLEAR = uuid('sessao-clear');
export const SESSION_VSCODE = uuid('sessao-vscode');
export const AGENTS = {
  w1: { id: agentId('w1'), type: WORKER },
  w2: { id: agentId('w2'), type: WORKER },
  w3: { id: agentId('w3'), type: WORKER },
  w4: { id: agentId('w4'), type: WORKER },
  w5: { id: agentId('w5'), type: WORKER },
  w6: { id: agentId('w6'), type: WORKER },
  d1: { id: agentId('d1'), type: 'documentador' },
  w8: { id: agentId('w8'), type: WORKER },
  internal: { id: agentId('interno'), type: '' },
};

/** Textos que representam conteúdo real e não podem vazar. */
export const CONTENT_MARKERS = [
  'SEGREDO-DO-PEDIDO',
  'CONTEUDO-REAL-DO-ARQUIVO',
  'RESPOSTA-DO-ASSISTENTE',
  'SAIDA-DE-ERRO-REAL',
  'CONTEUDO-DO-TESTE',
  'CONTEUDO-DA-FALHA',
  'PROMPT-DO-AGENTE',
  'RESULTADO-DO-AGENTE',
  'RESUMO-DA-COMPACTACAO',
  'abc.def.ghi',
  'senha-da-url',
];

const ENV_TERMINAL = {
  names: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR'],
  values: { CLAUDE_PROJECT_DIR: PROJECT, CLAUDE_CODE_ENTRYPOINT: 'cli' },
};
const ENV_VSCODE = {
  names: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'VSCODE_PID'],
  values: { CLAUDE_PROJECT_DIR: PROJECT, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
};

/**
 * Monta a sessão sintética.
 * @returns {{ records: object[], jsonl: string, debugText: string }}
 */
export function buildSyntheticProbe() {
  const records = [];
  let time = 1_760_000_000_000;
  let env = ENV_TERMINAL;
  let session = SESSION;
  let currentPrompt = null;
  let toolSeq = 0;
  const agents = AGENTS;
  const projects = `${HOME}\\.claude\\projects\\c--Users-fulano-Projetos-agents-quest`;

  /** Grava um registro. `spawnShift` desloca o receivedAt (início do processo) em relação à gravação. */
  function emit(payload, { spawnShift = 0 } = {}) {
    time += 100;
    const receivedAt = time - 40 + spawnShift;
    records.push({ probe: 1, receivedAt, writtenAt: time, bytes: Buffer.byteLength(JSON.stringify(payload)), env, payload });
  }

  function base(hook, agent) {
    const payload = {
      session_id: session,
      transcript_path: `${projects}\\${session}.jsonl`,
      cwd: PROJECT,
      permission_mode: 'default',
      hook_event_name: hook,
    };
    if (currentPrompt) payload.prompt_id = currentPrompt;
    if (agent) {
      payload.agent_id = agent.id;
      payload.agent_type = agent.type;
    }
    return payload;
  }

  const prompt = (label, text) => {
    currentPrompt = promptId(label);
    emit({ ...base('UserPromptSubmit'), prompt: text });
  };
  const pre = (name, input, agent) => {
    const id = toolUseId(++toolSeq);
    return { id, name, input, agent, payload: { ...base('PreToolUse', agent), tool_name: name, tool_input: input, tool_use_id: id } };
  };
  const postPayload = (call, response) => ({
    ...base('PostToolUse', call.agent), tool_name: call.name, tool_input: call.input, tool_response: response, tool_use_id: call.id, duration_ms: 50,
  });
  const failPayload = (call, error, interrupt) => ({
    ...base('PostToolUseFailure', call.agent), tool_name: call.name, tool_input: call.input, tool_use_id: call.id, error,
    ...(interrupt ? { is_interrupt: true } : {}), duration_ms: 50,
  });
  const permission = (call) => emit({
    ...base('PermissionRequest', call.agent), tool_name: call.name, tool_input: call.input,
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: call.name, ruleContent: 'node -e:*' }], behavior: 'allow', destination: 'localSettings' }],
  });
  const notice = (type, agent) => emit({
    ...base('Notification', agent), message: 'Claude needs your permission to use Bash', notification_type: type,
  });
  const start = (agent) => emit({ ...base('SubagentStart', agent) });
  const stopAgent = (agent) => emit({
    ...base('SubagentStop', agent), stop_hook_active: false,
    agent_transcript_path: `${projects}\\${session}\\subagents\\agent-${agent.id}.jsonl`,
    last_assistant_message: 'RESPOSTA-DO-ASSISTENTE do subagente', background_tasks: [], session_crons: [],
  });
  const stop = (backgroundTasks = []) => emit({
    ...base('Stop'), stop_hook_active: false, last_assistant_message: 'RESPOSTA-DO-ASSISTENTE', background_tasks: backgroundTasks, session_crons: [],
  });

  /** Ferramenta simples: Pre, pedido de permissão opcional e Post (ou falha). */
  function tool(name, input, { agent, response = {}, error, interrupt, ask, deny, notify } = {}) {
    const call = pre(name, input, agent);
    emit(call.payload);
    if (ask || deny) permission(call);
    if (notify) notice('permission_prompt', agent);
    if (deny) return call;
    if (error !== undefined) emit(failPayload(call, error, interrupt));
    else emit(postPayload(call, response));
    return call;
  }

  const bashOk = (stdout) => ({ stdout, stderr: '', interrupted: false, isImage: false });
  const readOk = (filePath) => ({ type: 'text', file: { filePath, content: 'CONTEUDO-REAL-DO-ARQUIVO\nlinha 2', numLines: 2, startLine: 1, totalLines: 2 } });
  const agentInput = (type, description, extra = {}) => ({ description, prompt: `PROMPT-DO-AGENTE ${description}`, subagent_type: type, ...extra });
  const agentDone = (agent) => ({
    status: 'completed', agentId: agent.id, content: [{ type: 'text', text: 'RESULTADO-DO-AGENTE' }], totalTokens: 1200, totalToolUseCount: 1, totalDurationMs: 3000,
  });
  const claudeMd = `${PROJECT}\\CLAUDE.md`;

  // Sessão do terminal.
  emit({ ...base('SessionStart'), source: 'startup', model: 'claude-opus-5-5' });

  // 1. Básico, com aprovação na sessão principal e o aviso permission_prompt.
  prompt('p01', 'Leia o CLAUDE.md e rode node -e "console.log(1)". SEGREDO-DO-PEDIDO');
  tool('Read', { file_path: claudeMd }, { response: readOk(claudeMd) });
  tool('Bash', { command: 'node -e "console.log(1)"', description: 'Imprimir 1' }, { ask: true, notify: true, response: bashOk('1\n') });
  stop();

  // 2. Comando com saída 3.
  prompt('p02', 'Rode node -e "process.exit(3)".');
  tool('Bash', { command: 'node -e "process.exit(3)"', description: 'Sair com 3' }, { ask: true, error: 'Exit code 3\nSAIDA-DE-ERRO-REAL' });
  stop();

  // 3. Teste que falha e depois passa.
  prompt('p03', 'Crie tmp-probe/a.test.mjs com um teste que falha, rode, corrija e rode de novo.');
  const testFile = `${PROJECT}\\tmp-probe\\a.test.mjs`;
  tool('Write', { file_path: testFile, content: 'CONTEUDO-DO-TESTE' }, { response: { type: 'create', filePath: testFile } });
  tool('Bash', { command: 'node --test tmp-probe', description: 'Rodar os testes' }, {
    ask: true,
    error: 'Exit code 1\n✖ soma (1.1ms)\n  AssertionError: CONTEUDO-DA-FALHA\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ duration_ms 52.3\n',
  });
  tool('Edit', { file_path: testFile, old_string: 'CONTEUDO-DO-TESTE', new_string: 'CONTEUDO-DO-TESTE corrigido' }, { response: { filePath: testFile } });
  tool('Bash', { command: 'node --test tmp-probe', description: 'Rodar os testes' }, {
    ask: true, response: bashOk('✔ soma (0.9ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ duration_ms 48.1\n'),
  });
  stop();

  // 4. Aprovação aceita e negada na sessão principal.
  prompt('p04', 'Rode os dois comandos de gravação.');
  tool('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'tmp-probe/x.txt\',\'1\')"' }, { ask: true, response: bashOk('') });
  tool('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'tmp-probe/y.txt\',\'2\')"' }, { deny: true });
  stop();

  // 5. Dois probe-worker em paralelo; 6a: falha dentro de subagente. O Post do Read
  // do primeiro chega antes do Pre (fora de ordem), embora tenha começado depois.
  prompt('p05', 'Use o probe-worker duas vezes em paralelo.');
  const a1 = pre('Agent', agentInput(WORKER, 'Ler o CLAUDE.md'));
  const a2 = pre('Agent', agentInput(WORKER, 'Rodar console.log(2)'));
  emit(a1.payload);
  emit(a2.payload);
  start(agents.w1);
  start(agents.w2);
  const read1 = pre('Read', { file_path: claudeMd }, agents.w1);
  emit(postPayload(read1, readOk(claudeMd)));
  emit(read1.payload, { spawnShift: -200 });
  tool('Bash', { command: 'node -e "console.log(2)"' }, { agent: agents.w2, ask: true, notify: true, response: bashOk('2\n') });
  tool('Bash', { command: 'node -e "process.exit(4)"' }, { agent: agents.w2, ask: true, error: 'Exit code 4' });
  stopAgent(agents.w1);
  emit(postPayload(a1, agentDone(agents.w1)));
  stopAgent(agents.w2);
  emit(postPayload(a2, agentDone(agents.w2)));
  stop();

  // 6 e 6b. Aprovação aceita e negada dentro de um subagente.
  prompt('p06', 'Peça ao probe-worker para rodar dois comandos de gravação.');
  const a3 = pre('Agent', agentInput(WORKER, 'Gravar z.txt e w.txt'));
  emit(a3.payload);
  start(agents.w3);
  tool('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'tmp-probe/z.txt\',\'3\')"' }, { agent: agents.w3, ask: true, response: bashOk('') });
  tool('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'tmp-probe/w.txt\',\'4\')"' }, { agent: agents.w3, deny: true });
  stopAgent(agents.w3);
  emit(postPayload(a3, agentDone(agents.w3)));
  stop();

  // 7. Segundo plano: Post do Agent logo no lançamento, Stop com a tarefa rodando e retorno como novo pedido.
  prompt('p07', 'Rode o probe-worker em segundo plano e me avise quando terminar.');
  const a4 = pre('Agent', agentInput(WORKER, 'Esperar 15 s', { run_in_background: true }));
  emit(a4.payload);
  start(agents.w4);
  emit(postPayload(a4, {
    status: 'async_launched', agentId: agents.w4.id, description: 'Esperar 15 s', prompt: 'PROMPT-DO-AGENTE em segundo plano',
    outputFile: `${HOME}\\AppData\\Local\\Temp\\claude\\${session}\\tasks\\${agents.w4.id}.output`,
  }));
  stop([{ id: agents.w4.id, type: 'local_agent', status: 'running', description: 'Esperar 15 s', agent_type: WORKER }]);
  tool('Bash', { command: 'node -e "setTimeout(()=>console.log(\'fim\'),15000)"', timeout: 60000 }, { agent: agents.w4, ask: true, response: bashOk('fim\n') });
  stopAgent(agents.w4);
  prompt('p07r', `<task-notification>\n<task-id>${agents.w4.id}</task-id>\n<tool-use-id>${a4.id}</tool-use-id>\n<status>completed</status>\n<summary>Agent "Esperar 15 s" completed</summary>\n<result>RESULTADO-DO-AGENTE</result>\n</task-notification>`);
  stop();

  // 8. Subagente aninhado.
  prompt('p08', 'Peça ao probe-worker que delegue a outro probe-worker a leitura do CLAUDE.md.');
  const a5 = pre('Agent', agentInput(WORKER, 'Delegar a leitura'));
  emit(a5.payload);
  start(agents.w5);
  const a6 = pre('Agent', agentInput(WORKER, 'Ler o CLAUDE.md (aninhado)'), agents.w5);
  emit(a6.payload);
  start(agents.w6);
  tool('Read', { file_path: claudeMd }, { agent: agents.w6, response: readOk(claudeMd) });
  stopAgent(agents.w6);
  emit(postPayload(a6, agentDone(agents.w6)));
  stopAgent(agents.w5);
  emit(postPayload(a5, agentDone(agents.w5)));
  stop();

  // 9. Agente do projeto; depois, um agente interno (SubagentStop sem tipo e sem início).
  prompt('p09', 'Peça ao documentador só para ler o CLAUDE.md e responder OK.');
  const a7 = pre('Agent', agentInput('documentador', 'Ler o CLAUDE.md'));
  emit(a7.payload);
  start(agents.d1);
  tool('Read', { file_path: claudeMd }, { agent: agents.d1, response: readOk(claudeMd) });
  stopAgent(agents.d1);
  emit(postPayload(a7, agentDone(agents.d1)));
  stop();
  stopAgent(agents.internal);

  // 10. Esc na sessão principal (sem Stop).
  prompt('p10', 'Rode node -e "setTimeout(()=>{},30000)".');
  tool('Bash', { command: 'node -e "setTimeout(()=>{},30000)"' }, { ask: true, error: 'Interrupted by user', interrupt: true });

  // 10a. Esc durante um subagente (sem Stop).
  prompt('p10a', 'Peça ao probe-worker para rodar o mesmo comando.');
  const a8 = pre('Agent', agentInput(WORKER, 'Esperar 30 s'));
  emit(a8.payload);
  start(agents.w8);
  tool('Bash', { command: 'node -e "setTimeout(()=>{},30000)"' }, { agent: agents.w8, ask: true, error: 'Interrupted by user', interrupt: true });
  stopAgent(agents.w8);
  emit(failPayload(a8, 'Interrupted by user', true));

  // 11. /compact, /clear e saída.
  prompt('p11', '/compact');
  emit({ ...base('PreCompact'), trigger: 'manual', custom_instructions: '' });
  emit({ ...base('PostCompact'), trigger: 'manual', compact_summary: 'RESUMO-DA-COMPACTACAO' });
  emit({ ...base('SessionStart'), source: 'compact', model: 'claude-opus-5-5' });
  emit({ ...base('SessionEnd'), reason: 'clear' });
  session = SESSION_CLEAR;
  currentPrompt = null;
  emit({ ...base('SessionStart'), source: 'clear', model: 'claude-opus-5-5' });
  emit({ ...base('SessionEnd'), reason: 'prompt_input_exit' });

  // Sessão do VS Code, com um comando que tem segredos (para a redação).
  env = ENV_VSCODE;
  session = SESSION_VSCODE;
  emit({ ...base('SessionStart'), source: 'startup', model: 'claude-opus-5-5' });
  prompt('q01', 'Rode o curl.');
  tool('Bash', { command: 'curl -H "Authorization: Bearer abc.def.ghi" https://usuario:senha-da-url@example.com/x' }, { ask: true, response: bashOk('ok\n') });
  stop();
  emit({ ...base('SessionEnd'), reason: 'prompt_input_exit' });

  const debugText = [
    ...records.map((r, i) => `2026-10-17T20:00:${String(i % 60).padStart(2, '0')}.000Z [DEBUG] Hook ${r.payload.hook_event_name} (plugin agent-quest-probe): command moved to the background`),
    '2026-10-17T20:01:00.000Z [DEBUG] Hook PreToolUse (plugin agent-quest-probe) dump.mjs completed in 63ms',
    '2026-10-17T20:01:01.000Z [DEBUG] Hook PostToolUse (plugin agent-quest-probe) dump.mjs completed in 71ms',
    '2026-10-17T20:01:02.000Z [DEBUG] Outra linha qualquer',
  ].join('\n');

  return { records, jsonl: `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, debugText };
}

/** Cópia profunda dos registros, para os testes alterarem sem afetar outros. */
export function cloneRecords(records) {
  return JSON.parse(JSON.stringify(records));
}
