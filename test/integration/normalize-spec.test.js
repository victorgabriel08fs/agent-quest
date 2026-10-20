// Normalizador contra a especificação (tester, T5): server/domain/normalize.js,
// tools.js e roles.js conferidos com vetores próprios, escritos a partir de
// docs/arquitetura/modelo-de-eventos.md (seções 2, 3, 5 e 10, inclusive
// "Forma do fato e limites", commit 2cf58a9) e das condições do adiantamento
// do T5 em docs/plano/v1.md, independentes dos vetores do dev. Cobre:
// - os 15 hooks, com o conjunto exato de chaves de cada fato, e os 18 outros
//   eventos documentados virando null;
// - null sem session_id ou com entrada que não é objeto, sem nunca lançar:
//   Proxy com armadilhas que lançam em cada nível, getters, JSON muito
//   aninhado e mutação aleatória de payloads válidos;
// - tabela de categorias, alvos e detalhes da seção 3;
// - caminhos do Windows: dentro e fora do projeto, caixa da unidade, `\` e `/`,
//   prefixos parecidos, `..`, UNC e raiz da unidade;
// - chaves proibidas e teto de 200 (caminhos guardados até 1024);
// - todo texto exibido sai de redactAndCut: limites 120/80/160/60/80 (e 80/200
//   de nomes e caminhos), ponto fixo do redact, segredo perto do corte;
// - leitura limitada (SCAN_CHARS): token sobre a borda;
// - inputHash independente da ordem das chaves;
// - resolveRole;
// - tempo com strings de 1 MB em cada campo.
// Revalidação (commits 2fa77ed, c6047f6 e b8ac1ca do modelo de eventos):
// - agent_id presente e inválido descarta o evento; inputHash null com
//   aninhamento extremo, sem derrubar o fato;
// - identificadores: exibido ponto fixo de redact, *Key cru, papel e categoria
//   pelo cru;
// - formas de caminho \\?\, \\.\, \\?\UNC\, //srv e /c/;
// - marcador de corte do encaminhador (B3) e controles na etapa 1 do redact.
// Terceira rodada (commits 93e6379 e 34863ed): ids pelo padrão fixo, etapa 7
// (ANSI depois da redação), BEL de OSC, identificador com ANSI, espaços dentro
// de sequências que não são fronteira, nome MCP remontado e leitura limpa de 32 Ki.
// Quarta rodada: vizinhos do B6 (BEL e ESC órfãos, OSC com ST, aninhada ou sem
// terminador) e valor de nome sensível dentro de cores ANSI.
//
// Os testes marcados com `todo` reproduzem bugs abertos no relatório do tester.
// Eles rodam e mostram a falha, mas não deixam a suíte vermelha enquanto o
// dev corrige; quem corrigir tira o `todo`.
//
// Pastas pessoais e projetos aqui são fictícios (o repositório é público).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { ROLES, TOOL_CATEGORIES } from '../../shared/contract.js';
import { charLength, redact, redactAndCut } from '../../server/domain/redact.js';
import { normalize } from '../../server/domain/normalize.js';
import { SCAN_CHARS, describeTool, displayPath, inputHash } from '../../server/domain/tools.js';
import { resolveRole } from '../../server/domain/roles.js';
import { growthWithin } from './timing.js';

const HOME = 'C:\\Users\\fulana';
const PROJECT = `${HOME}\\Code\\agents-quest`;
const SESSION = '0f0e0d0c-1111-4222-8333-444455556666';
const PROMPT = '1a2b3c4d-5555-4666-8777-888899990000';
const AGENT = 'a00112233445566ff';
const TOOL_USE = 'toolu_01QwErTyUiOpAsDfGhJkLzXc';
const TRANSCRIPT = `${HOME}\\.claude\\projects\\C--Users-fulana-Code-agents-quest\\${SESSION}.jsonl`;

/** Envelope v1 (seção 1) com os campos comuns da documentação dos hooks. */
function envelope(hook, fields = {}, { env = { projectDir: PROJECT, entrypoint: 'cli' }, sentAt = 1_760_000_000_000 } = {}) {
  return {
    v: 1,
    sentAt,
    forwarder: '0.1.0',
    env,
    truncated: false,
    payload: { session_id: SESSION, prompt_id: PROMPT, transcript_path: TRANSCRIPT, cwd: PROJECT, permission_mode: 'default', hook_event_name: hook, ...fields },
  };
}
const fact = (hook, fields, options) => normalize(envelope(hook, fields, options), { receivedAt: 1_760_000_000_500, homeDir: HOME });

// ---------------------------------------------------------------------------
// Invariantes da seção 10 (conferência própria, não usa fact-checks.js do dev)
// ---------------------------------------------------------------------------

const FORBIDDEN = ['content', 'old_string', 'new_string', 'stdout', 'stderr', 'tool_input', 'tool_response', 'last_assistant_message'];
const STORED_PATHS = ['projectDir', 'transcriptPath', 'agentTranscriptPath'];
const SHOWN = ['tool', 'target', 'detail', 'title', 'error', 'sessionTitle', 'model', 'agentType', 'subagentType', 'description', 'projectDir'];

function* leaves(value, at, key = null) {
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* leaves(value[i], `${at}[${i}]`, key);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* leaves(v, `${at}.${k}`, k);
  } else yield [at, key, value];
}
function* keysOf(value, at = 'fato') {
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* keysOf(value[i], `${at}[${i}]`);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      yield [`${at}.${k}`, k];
      yield* keysOf(v, `${at}.${k}`);
    }
  }
}

function assertSection10(f, label) {
  for (const [at, key] of keysOf(f)) assert.ok(!FORBIDDEN.includes(key), `${label}: chave proibida em ${at}`);
  for (const [at, key, value] of leaves(f, 'fato')) {
    if (typeof value !== 'string') continue;
    const topLevelPath = STORED_PATHS.includes(key) && at === `fato.${key}`;
    const max = topLevelPath ? 1024 : 200;
    assert.ok(charLength(value) <= max, `${label}: ${at} com ${charLength(value)} caracteres (máximo ${max})`);
  }
  // Todo texto exibido é ponto fixo de redact, inclusive identificadores (seção 2,
  // revisto em 18/10/2026). Os campos *Key são valores crus, só para uso interno.
  for (const key of SHOWN) {
    if (typeof f[key] === 'string') assert.equal(redact(f[key]), f[key], `${label}: ${key} não é ponto fixo de redact`);
  }
  for (const task of f.backgroundTasks ?? []) {
    for (const key of ['type', 'status', 'agentType']) {
      if (typeof task[key] === 'string') assert.equal(redact(task[key]), task[key], `${label}: backgroundTasks.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------

const COMMON_KEYS = ['kind', 'hook', 'sessionId', 'agentId', 'agentType', 'agentTypeKey', 'promptId', 'projectDir', 'client', 'ts', 'receivedAt', 'transcriptPath'];
const TOOL_KEYS = ['toolUseId', 'tool', 'category', 'target', 'detail', 'inputHash', 'background', 'subagentType', 'subagentTypeKey', 'description'];
/** Chaves de cada fato: seção 2 (tabela) e "Forma do fato e limites". */
const FACT_KEYS = {
  SessionStart: ['session.start', ['source', 'model', 'sessionTitle']],
  SessionEnd: ['session.end', ['reason']],
  UserPromptSubmit: ['prompt.submit', ['title', 'origin', 'sessionTitle']],
  PreToolUse: ['tool.pre', TOOL_KEYS],
  PostToolUse: ['tool.post', [...TOOL_KEYS, 'durationMs', 'linkedAgentId', 'launch', 'testResult']],
  PostToolUseFailure: ['tool.fail', [...TOOL_KEYS, 'error', 'interrupted', 'durationMs', 'testResult']],
  PermissionRequest: ['permission.request', ['tool', 'category', 'target', 'inputHash']],
  PermissionDenied: ['permission.denied', ['toolUseId', 'tool', 'category']],
  Notification: ['notice', ['type']],
  SubagentStart: ['subagent.start', []],
  SubagentStop: ['subagent.stop', ['agentTranscriptPath']],
  Stop: ['turn.stop', ['backgroundTasks']],
  StopFailure: ['turn.fail', ['error']],
  PreCompact: ['compact.pre', ['trigger']],
  PostCompact: ['compact.post', ['trigger']],
};

/** Os outros 18 eventos da documentação (docs/pesquisa/hooks-claude-code.md, seção 1). */
const OTHER_EVENTS = [
  'Setup', 'UserPromptExpansion', 'PostToolBatch', 'MessageDisplay', 'TaskCreated', 'TaskCompleted', 'TeammateIdle',
  'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
  'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult',
];

/** Payload documentado de cada hook, com conteúdo que nunca pode vazar. */
const DOCUMENTED = {
  SessionStart: { source: 'resume', model: 'claude-opus-5-5', session_title: 'Painel', agent_type: 'arquiteto' },
  SessionEnd: { reason: 'prompt_input_exit' },
  UserPromptSubmit: { prompt: 'Primeira linha\nVAZOU-PEDIDO' },
  PreToolUse: { tool_name: 'Edit', tool_input: { file_path: `${PROJECT}\\web\\app.js`, old_string: 'VAZOU-OLD', new_string: 'VAZOU-NEW' }, tool_use_id: TOOL_USE, agent_id: AGENT, agent_type: 'dev-frontend' },
  PostToolUse: { tool_name: 'Bash', tool_input: { command: 'ls', description: 'Listar' }, tool_use_id: TOOL_USE, tool_response: { stdout: 'VAZOU-STDOUT', stderr: 'VAZOU-STDERR', interrupted: false }, duration_ms: 7 },
  PostToolUseFailure: { tool_name: 'Bash', tool_input: { command: 'false' }, tool_use_id: TOOL_USE, error: 'Exit code 1\nVAZOU-ERRO', is_interrupt: false, duration_ms: 3 },
  PermissionRequest: { tool_name: 'Write', tool_input: { file_path: `${PROJECT}\\x.txt`, content: 'VAZOU-CONTEUDO' }, permission_suggestions: [] },
  PermissionDenied: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: TOOL_USE, reason: 'VAZOU-MOTIVO' },
  Notification: { notification_type: 'idle_prompt', message: 'VAZOU-MENSAGEM', title: 'VAZOU-TITULO' },
  SubagentStart: { agent_id: AGENT, agent_type: 'tester' },
  SubagentStop: { agent_id: AGENT, agent_type: 'tester', agent_transcript_path: `${HOME}\\t\\agent-${AGENT}.jsonl`, last_assistant_message: 'VAZOU-RESPOSTA', stop_hook_active: false, background_tasks: [], session_crons: [] },
  Stop: { last_assistant_message: 'VAZOU-RESPOSTA', stop_hook_active: false, background_tasks: [{ id: AGENT, type: 'local_agent', status: 'running', description: 'VAZOU-DESCRICAO', agent_type: 'tester' }], session_crons: [] },
  StopFailure: { error: 'overloaded', error_details: 'VAZOU-DETALHES', last_assistant_message: 'VAZOU-API' },
  PreCompact: { trigger: 'auto', custom_instructions: 'VAZOU-INSTRUCOES' },
  PostCompact: { trigger: 'manual', compact_summary: 'VAZOU-RESUMO' },
};

describe('cobertura dos 15 hooks (seção 2 e "Forma do fato e limites")', () => {
  for (const [hook, [kind, own]] of Object.entries(FACT_KEYS)) {
    it(`${hook} → ${kind}, com exatamente as chaves do contrato e nada do conteúdo`, () => {
      const f = fact(hook, DOCUMENTED[hook]);
      assert.ok(f, `${hook} virou null`);
      assert.equal(f.kind, kind);
      assert.equal(f.hook, hook);
      assert.deepEqual(Object.keys(f).sort(), [...COMMON_KEYS, ...own].sort());
      assert.doesNotMatch(JSON.stringify(f), /VAZOU-(?!PEDIDO)/, 'conteúdo do payload no fato');
      assert.doesNotMatch(JSON.stringify(f), /VAZOU-PEDIDO/, 'só a primeira linha do pedido');
      assertSection10(f, hook);
    });
  }

  it('fatos de ferramenta: subagentType e description sempre presentes; linkedAgentId, launch e testResult sempre presentes no tool.post', () => {
    const post = fact('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a' } });
    assert.deepEqual([post.subagentType, post.description, post.linkedAgentId, post.launch, post.testResult], [null, null, null, null, null]);
    const fail = fact('PostToolUseFailure', { tool_name: 'Read', tool_input: { file_path: 'a' }, error: 'x' });
    assert.deepEqual([fail.subagentType, fail.description, fail.testResult], [null, null, null]);
  });

  it('valores fora da lista viram null, e Notification de outro tipo ainda gera o fato notice', () => {
    assert.equal(fact('SessionStart', { source: 'STARTUP' }).source, null);
    assert.equal(fact('SessionEnd', { reason: 'bye' }).reason, null);
    assert.equal(fact('PreCompact', { trigger: ['auto'] }).trigger, null);
    const notice = fact('Notification', { notification_type: 'agent_completed' });
    assert.equal(notice.kind, 'notice');
    assert.equal(notice.type, null);
    const launch = fact('PostToolUse', { tool_name: 'Agent', tool_input: {}, tool_response: { status: 'running', agentId: AGENT } });
    assert.deepEqual([launch.launch, launch.linkedAgentId], [null, AGENT]);
  });

  it('sessão principal iniciada com --agent: agentId null e o tipo só como detalhe', () => {
    const f = fact('SessionStart', DOCUMENTED.SessionStart);
    assert.equal(f.agentId, null);
    assert.equal(f.agentType, 'arquiteto');
  });
});

describe('o que vira null, sem nunca lançar', () => {
  it('os 18 outros eventos documentados e variações de caixa', () => {
    for (const hook of [...OTHER_EVENTS, 'stop', 'STOP', 'Stop ', ' Stop', 'Notification\n']) {
      assert.equal(fact(hook, {}), null, hook);
    }
  });

  it('sem session_id válido', () => {
    for (const id of [undefined, null, '', 0, 1, true, [], {}, [SESSION], { id: SESSION }]) {
      assert.equal(fact('Stop', { session_id: id }), null, JSON.stringify(id));
    }
  });

  it('envelope ou payload que não são objetos', () => {
    for (const value of [undefined, null, 0, NaN, '', 'Stop', true, [], [envelope('Stop')], () => {}, Symbol('x'), 10n]) {
      assert.equal(normalize(value, { receivedAt: 1 }), null, String(typeof value));
      assert.equal(normalize({ v: 1, env: {}, payload: value }, { receivedAt: 1 }), null, String(typeof value));
    }
  });

  it('Proxy com armadilhas que lançam, em cada nível', () => {
    const boom = () => {
      throw new Error('armadilha');
    };
    const hostile = new Proxy({}, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, getPrototypeOf: boom });
    const base = { session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'tester' } };
    const cases = [
      hostile,
      { v: 1, payload: hostile },
      { v: 1, env: hostile, payload: base },
      { v: 1, payload: { ...base, tool_input: hostile } },
      { v: 1, payload: { ...base, tool_response: hostile } },
      { v: 1, payload: { ...base, hook_event_name: 'Stop', background_tasks: [hostile] } },
      { v: 1, payload: { ...base, hook_event_name: 'Stop', background_tasks: hostile } },
    ];
    for (const [i, value] of cases.entries()) {
      assert.doesNotThrow(() => normalize(value, { receivedAt: 1, homeDir: HOME }), `caso ${i}`);
    }
    assert.doesNotThrow(() => normalize(envelope('Stop'), hostile));
  });

  it('getters que lançam no envelope, no payload e nas opções', () => {
    const boom = () => {
      throw new Error('getter');
    };
    const cases = [
      Object.defineProperty({ v: 1 }, 'payload', { get: boom, enumerable: true }),
      { v: 1, payload: Object.defineProperty({ hook_event_name: 'Stop' }, 'session_id', { get: boom, enumerable: true }) },
      { v: 1, payload: { session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: Object.defineProperty({}, 'command', { get: boom, enumerable: true }) } },
      Object.defineProperty({ v: 1, payload: { session_id: SESSION, hook_event_name: 'Stop' } }, 'sentAt', { get: boom, enumerable: true }),
    ];
    for (const [i, value] of cases.entries()) assert.doesNotThrow(() => normalize(value, { receivedAt: 1 }), `caso ${i}`);
    assert.doesNotThrow(() => normalize(envelope('Stop'), Object.defineProperty({}, 'receivedAt', { get: boom, enumerable: true })));
  });

  it('JSON muito aninhado (como chegaria de um POST de até 1 MiB)', () => {
    const depth = 100_000;
    const text = `{"v":1,"payload":{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"mcp__x__y","tool_input":{"a":${'['.repeat(depth)}${']'.repeat(depth)}}}}`;
    const parsed = JSON.parse(text);
    let f;
    assert.doesNotThrow(() => (f = normalize(parsed, { receivedAt: 1 })));
    // Só o hash fica null; o fato continua (seção 2, revisão de 18/10/2026).
    assert.ok(f, 'o fato não pode cair por causa do inputHash');
    assert.deepEqual([f.kind, f.category, f.target, f.inputHash], ['tool.pre', 'mcp', 'x/y', null]);
  });

  it('mutação aleatória de payloads válidos: nunca lança, e todo fato respeita a seção 10 (determinístico)', () => {
    let seed = 0x5eed_7e57;
    const random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const atoms = [
      '', ' ', '\n', '\r\n', '\u2028', '\u200B', '\u202E', '\uD800', '🙂', 'é', '•••', '…', '"', "'", '\\', '/', 'C:', 'c:', '\\\\srv\\share',
      '..', '~', '=', ':', ':=', '=>', '--password ', 'token=', 'Authorization: ', 'Bearer ', 'ghp_', 'sk-ant-', 'AKIA', '-----BEGIN PRIVATE KEY-----',
      'https://u:p@h/', '<task-notification>', '/compact ', '__proto__', 'constructor', PROJECT, HOME, 'x'.repeat(300),
    ];
    const randomText = () => Array.from({ length: Math.floor(random() * 12) }, () => pick(atoms)).join('');
    const randomValue = (depth = 0) => {
      const r = random();
      if (r < 0.4) return randomText();
      if (r < 0.5) return pick([0, -1, 1.5, 1e308, -0, Number.MAX_SAFE_INTEGER]);
      if (r < 0.55) return pick([true, false, null]);
      if (depth > 2) return randomText();
      if (r < 0.75) return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, () => [pick(['command', 'file_path', 'agentId', 'status', 'id', 'x', '__proto__']), randomValue(depth + 1)]));
    };
    let facts = 0;
    for (let i = 0; i < 4000; i++) {
      const hook = pick(Object.keys(DOCUMENTED));
      const env = envelope(hook, structuredClone(DOCUMENTED[hook]));
      const target = random() < 0.7 ? env.payload : random() < 0.5 ? env : (env.env ??= {});
      const keys = Object.keys(target).filter((k) => k !== 'hook_event_name' && !(target === env.payload && k === 'session_id' && random() < 0.8));
      for (let n = 0; n < 1 + Math.floor(random() * 3); n++) {
        const key = random() < 0.8 && keys.length ? pick(keys) : pick(['tool_input', 'tool_response', 'agent_id', 'prompt', 'error', 'background_tasks']);
        target[key] = random() < 0.2 && typeof target[key] === 'object' && target[key] !== null ? { ...target[key], [pick(['command', 'file_path', 'url', 'description'])]: randomValue() } : randomValue();
      }
      let f;
      assert.doesNotThrow(() => (f = normalize(env, { receivedAt: 1, homeDir: HOME })), `iteração ${i}`);
      if (f === null) continue;
      facts++;
      assert.equal(f.kind, FACT_KEYS[f.hook][0], `iteração ${i}`);
      assertSection10(f, `iteração ${i}`);
    }
    assert.ok(facts > 2000, `poucos fatos: ${facts}`);
  });
});

describe('categorias, alvos e detalhes (seção 3)', () => {
  const ctx = { projectDir: PROJECT, homeDir: HOME };
  /** [tool_name, tool_input, categoria, alvo, detalhe] */
  const TABLE = [
    ['Read', { file_path: `${PROJECT}\\README.md` }, 'read', 'README.md', null],
    ['NotebookRead', { notebook_path: `${PROJECT}\\nb\\a.ipynb` }, 'read', 'nb/a.ipynb', null],
    ['Grep', { pattern: 'function\\s+\\w+', path: `${PROJECT}\\server` }, 'search', 'function\\s+\\w+', null],
    ['Glob', { pattern: 'web/**/*.js' }, 'search', 'web/**/*.js', null],
    ['LS', { path: `${PROJECT}\\docs` }, 'search', 'docs', null],
    ['LSP', { file_path: `${PROJECT}\\server\\main.js` }, 'search', 'server/main.js', null],
    ['ToolSearch', { query: 'notebook' }, 'search', 'notebook', null],
    ['Write', { file_path: `${PROJECT}\\novo.md`, content: 'x' }, 'write', 'novo.md', null],
    ['Edit', { file_path: `${HOME}\\.claude\\CLAUDE.md`, old_string: 'a', new_string: 'b' }, 'edit', '~/.claude/CLAUDE.md', null],
    ['MultiEdit', { file_path: 'D:\\outro\\a.js', edits: [] }, 'edit', 'D:/outro/a.js', null],
    ['NotebookEdit', { notebook_path: `${PROJECT}\\a.ipynb` }, 'edit', 'a.ipynb', null],
    ['Bash', { command: 'npm test -- test/unit\nsegunda', description: 'Rodar a suíte' }, 'bash', 'npm test -- test/unit', 'Rodar a suíte'], // quebra de linha depois do teste vale como ; (T6): não conta
    ['PowerShell', { command: 'Get-Content .\\a.txt', description: 'Ler' }, 'bash', 'Get-Content .\\a.txt', 'Ler'],
    ['BashOutput', { bash_id: 'b1' }, 'bash', null, null],
    ['Monitor', { command: 'tail -f log', description: 'Acompanhar' }, 'bash', 'tail -f log', 'Acompanhar'],
    ['TaskStop', { task_id: 't1' }, 'bash', null, null],
    ['WebFetch', { url: 'https://docs.example.org/a/b?token=abc#x', prompt: 'resuma' }, 'web', 'docs.example.org', null],
    ['WebFetch', { url: 'não é url' }, 'web', null, null],
    ['WebSearch', { query: 'node test runner windows' }, 'web', 'node test runner windows', null],
    ['TodoWrite', { todos: [{ content: 'x', status: 'pending' }] }, 'plan', null, null],
    ['TaskCreate', { subject: 'x' }, 'plan', null, null],
    ['TaskUpdate', { taskId: '1' }, 'plan', null, null],
    ['TaskList', {}, 'plan', null, null],
    ['TaskGet', { taskId: '1' }, 'plan', null, null],
    ['Skill', { skill: 'xlsx' }, 'skill', 'xlsx', null],
    ['mcp__github__create_issue', { title: 'x' }, 'mcp', 'github/create_issue', null],
    ['mcp__claude_ai_Supabase__execute_sql', { query: 'select 1' }, 'mcp', 'claude_ai_Supabase/execute_sql', null],
    ['Agent', { subagent_type: 'dev-backend', description: 'Implementar T5', prompt: 'x' }, null, 'dev-backend', 'Implementar T5'],
    ['Task', { subagent_type: 'Plan', description: 'Planejar' }, null, 'Plan', 'Planejar'],
    ['SendMessage', { to: 'x' }, 'other', 'SendMessage', null],
    ['read', { file_path: 'a' }, 'other', 'read', null],
  ];
  for (const [tool, input, category, target, detail] of TABLE) {
    it(`${tool} → ${category}`, () => {
      assert.deepEqual(describeTool(tool, input, ctx), { category, target, detail });
      const f = fact('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: TOOL_USE });
      assert.deepEqual([f.category, f.target, f.detail], [category, target, detail], 'no fato');
      assert.ok(category === null || TOOL_CATEGORIES.includes(category));
    });
  }

  it('Bash e PowerShell com comando de teste viram test (T6); com run_in_background continuam bash', () => {
    for (const command of ['npm test', 'node --test', 'npx vitest run', 'pytest -q', 'cd x && npm run test']) {
      assert.equal(fact('PreToolUse', { tool_name: 'Bash', tool_input: { command } }).category, 'test', command);
      assert.equal(fact('PreToolUse', { tool_name: 'PowerShell', tool_input: { command } }).category, 'test', command);
      assert.equal(fact('PreToolUse', { tool_name: 'Bash', tool_input: { command, run_in_background: true } }).category, 'bash', `${command} em segundo plano`);
    }
  });

  it('PermissionRequest e PermissionDenied usam a mesma categoria e o mesmo alvo do PreToolUse', () => {
    const input = { file_path: `${PROJECT}\\server\\a.js`, content: 'x' };
    const pre = fact('PreToolUse', { tool_name: 'Write', tool_input: input });
    const req = fact('PermissionRequest', { tool_name: 'Write', tool_input: input });
    const denied = fact('PermissionDenied', { tool_name: 'Write', tool_input: input, tool_use_id: TOOL_USE });
    assert.deepEqual([req.tool, req.category, req.target], [pre.tool, pre.category, pre.target]);
    assert.deepEqual([denied.tool, denied.category], [pre.tool, pre.category]);
  });
});

describe('caminhos do Windows (condição 3 do adiantamento e seção 10)', () => {
  /** [rótulo, file_path, projectDir, esperado] */
  const CASES = [
    ['\\ dentro', `${PROJECT}\\server\\domain\\tools.js`, PROJECT, 'server/domain/tools.js'],
    ['/ dentro', 'C:/Users/fulana/Code/agents-quest/server/main.js', PROJECT, 'server/main.js'],
    ['unidade minúscula no arquivo', 'c:\\Users\\fulana\\Code\\agents-quest\\a.js', PROJECT, 'a.js'],
    ['unidade minúscula no projeto', `${PROJECT}\\a.js`, 'c:\\Users\\fulana\\Code\\agents-quest', 'a.js'],
    ['caixa diferente no meio do caminho', 'C:\\USERS\\FULANA\\code\\Agents-Quest\\Docs\\X.md', PROJECT, 'Docs/X.md'],
    ['projeto com barra no fim', `${PROJECT}\\a.js`, `${PROJECT}\\`, 'a.js'],
    ['projeto com / e barra no fim', `${PROJECT}\\a.js`, 'c:/users/fulana/code/agents-quest/', 'a.js'],
    ['separadores misturados e duplicados', 'C:/Users\\fulana//Code\\\\agents-quest/web\\js/app.js', PROJECT, 'web/js/app.js'],
    ['a própria pasta do projeto', PROJECT, PROJECT, '.'],
    ['prefixo parecido (-2)', `${PROJECT}-2\\a.js`, PROJECT, '~/Code/agents-quest-2/a.js'],
    ['prefixo parecido (sem separador)', `${PROJECT}old\\a.js`, PROJECT, '~/Code/agents-questold/a.js'],
    ['pasta pessoal parecida', 'C:\\Users\\fulana2\\a.js', PROJECT, 'C:/Users/fulana2/a.js'],
    ['fora do projeto, na pasta pessoal', `${HOME}\\Downloads\\a.zip`, PROJECT, '~/Downloads/a.zip'],
    ['fora do projeto, pasta pessoal em minúsculas', 'c:\\users\\fulana\\.claude\\settings.json', PROJECT, '~/.claude/settings.json'],
    ['fora das duas', 'C:\\Windows\\System32\\drivers\\etc\\hosts', PROJECT, 'C:/Windows/System32/drivers/etc/hosts'],
    ['outra unidade', 'D:\\dados\\a.csv', PROJECT, 'D:/dados/a.csv'],
    ['.. dentro do projeto', `${PROJECT}\\server\\..\\web\\index.html`, PROJECT, 'web/index.html'],
    ['.. saindo do projeto', `${PROJECT}\\..\\outro\\a.js`, PROJECT, '~/Code/outro/a.js'],
    ['.. saindo e voltando', `${PROJECT}\\..\\agents-quest\\a.js`, PROJECT, 'a.js'],
    ['.. saindo da pasta pessoal', `${HOME}\\..\\Public\\a.txt`, PROJECT, 'C:/Users/Public/a.txt'],
    ['.. acima da raiz', 'C:\\..\\..\\Users\\fulana\\a.txt', PROJECT, '~/a.txt'],
    ['UNC dentro', '\\\\servidor\\share\\proj\\src\\a.js', '\\\\servidor\\share\\proj', 'src/a.js'],
    ['UNC, caixa diferente', '\\\\SERVIDOR\\Share\\Proj\\a.js', '\\\\servidor\\share\\proj', 'a.js'],
    ['UNC prefixo parecido', '\\\\servidor\\share\\proj2\\a.js', '\\\\servidor\\share\\proj', '//servidor/share/proj2/a.js'],
    ['UNC de outro servidor', '\\\\outro\\share\\proj\\a.js', '\\\\servidor\\share\\proj', '//outro/share/proj/a.js'],
    ['projeto na raiz da unidade', 'C:\\src\\a.js', 'C:\\', 'src/a.js'],
    ['relativo fica como veio, com /', 'src\\a.js', PROJECT, 'src/a.js'],
  ];
  for (const [label, file, projectDir, expected] of CASES) {
    it(label, () => {
      assert.equal(displayPath(file, { projectDir, homeDir: HOME }), expected);
      const f = fact('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } }, { env: { projectDir, entrypoint: null } });
      assert.equal(f.target, expected, 'no fato');
    });
  }

  it('projectDir cai para o cwd quando falta no envelope', () => {
    const f = fact('PreToolUse', { tool_name: 'Read', tool_input: { file_path: `${PROJECT}\\a.js` }, cwd: PROJECT }, { env: { entrypoint: 'cli' } });
    assert.deepEqual([f.projectDir, f.target], [PROJECT, 'a.js']);
  });

  it('sem projeto nem pasta pessoal, o caminho absoluto sai com / e não lança', () => {
    const f = normalize(envelope('PreToolUse', { tool_name: 'Read', tool_input: { file_path: `${PROJECT}\\a.js` }, cwd: null }, { env: {} }), { receivedAt: 1, homeDir: null });
    assert.equal(f.target, 'C:/Users/fulana/Code/agents-quest/a.js');
  });
});

describe('chaves proibidas e teto de 200 (seção 10), com caminhos guardados até 1024', () => {
  const huge = `${'conteudo '.repeat(200)}`;
  it('payload com todas as chaves proibidas, em todos os níveis, em todos os 15 hooks', () => {
    const poison = Object.fromEntries(FORBIDDEN.map((key) => [key, huge]));
    for (const hook of Object.keys(FACT_KEYS)) {
      const f = fact(hook, {
        ...DOCUMENTED[hook],
        ...poison,
        tool_input: { ...(DOCUMENTED[hook].tool_input ?? {}), ...poison },
        tool_response: { ...poison, agentId: AGENT, status: 'completed', nested: { ...poison } },
        background_tasks: [{ id: AGENT, type: 'local_agent', ...poison }],
      });
      assertSection10(f, hook);
      assert.doesNotMatch(JSON.stringify(f), /conteudo conteudo conteudo/, hook);
    }
  });

  it('transcript de subagente com mais de 200 caracteres é guardado inteiro; acima de 1024 vira null', () => {
    const project = `C:\\Users\\fulana\\OneDrive - Empresa Exemplo\\Documentos\\Clientes\\Projeto com nome comprido\\${'sub\\'.repeat(5)}agents-quest`;
    const slug = project.replace(/[:\\ ]/g, '-');
    const transcript = `C:\\Users\\fulana\\.claude\\projects\\${slug}\\${SESSION}.jsonl`;
    const agentTranscript = `C:\\Users\\fulana\\.claude\\projects\\${slug}\\${SESSION}\\subagents\\agent-${AGENT}.jsonl`;
    assert.ok(charLength(agentTranscript) > 200 && charLength(project) > 100);
    const f = fact('SubagentStop', { agent_id: AGENT, agent_type: 'tester', transcript_path: transcript, agent_transcript_path: agentTranscript }, { env: { projectDir: project, entrypoint: 'cli' } });
    assert.deepEqual([f.projectDir, f.transcriptPath, f.agentTranscriptPath], [project, transcript, agentTranscript]);
    assertSection10(f, 'transcript longo');

    const at1024 = `C:\\${'t'.repeat(1021)}`;
    const over = `${at1024}x`;
    assert.equal(charLength(at1024), 1024);
    const g = fact('SubagentStop', { agent_id: AGENT, transcript_path: at1024, agent_transcript_path: over }, { env: { projectDir: over } });
    assert.deepEqual([g.transcriptPath, g.agentTranscriptPath], [at1024, null]);
    assert.equal(g.projectDir, PROJECT, 'projectDir acima de 1024 cai para o cwd');
  });

  it('a exceção dos 1024 não vale para caminhos exibidos nem dentro de listas', () => {
    const long = `${PROJECT}\\${'pasta-longa\\'.repeat(40)}a.js`;
    const f = fact('PreToolUse', { tool_name: 'Read', tool_input: { file_path: long } });
    assert.equal(charLength(f.target), 200);
    assert.ok(f.target.endsWith('…'));
  });
});

const URL_SECRET = (k) => `${'a'.repeat(k)} https://usuaria:segredoXYZ123@exemplo.org/`;

describe('todo texto exibido sai de redactAndCut (seção 10)', () => {
  /** [campo, limite, montar] */
  const FIELDS = [
    ['comando (Bash)', 120, (t) => fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: t } }).target],
    ['comando (PowerShell)', 120, (t) => fact('PreToolUse', { tool_name: 'PowerShell', tool_input: { command: t } }).target],
    ['comando no PermissionRequest', 120, (t) => fact('PermissionRequest', { tool_name: 'Bash', tool_input: { command: t } }).target],
    ['descrição do Bash', 80, (t) => fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x', description: t } }).detail],
    ['descrição do Agent', 80, (t) => fact('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'x', description: t } }).description],
    ['título do pedido', 80, (t) => fact('UserPromptSubmit', { prompt: t }).title],
    ['erro da ferramenta', 160, (t) => fact('PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, error: t }).error],
    ['erro do turno', 160, (t) => fact('StopFailure', { error: t }).error],
    ['padrão de busca', 60, (t) => fact('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: t } }).target],
    ['consulta do ToolSearch', 60, (t) => fact('PreToolUse', { tool_name: 'ToolSearch', tool_input: { query: t } }).target],
    ['consulta web', 80, (t) => fact('PreToolUse', { tool_name: 'WebSearch', tool_input: { query: t } }).target],
    ['título da sessão', 80, (t) => fact('SessionStart', { session_title: t }).sessionTitle],
    ['modelo', 80, (t) => fact('SessionStart', { model: t }).model],
    ['tipo de agente', 80, (t) => fact('SubagentStart', { agent_id: AGENT, agent_type: t }).agentType],
    ['skill', 80, (t) => fact('PreToolUse', { tool_name: 'Skill', tool_input: { skill: t } }).target],
    ['ferramenta desconhecida', 80, (t) => fact('PreToolUse', { tool_name: t, tool_input: {} }).target],
    ['caminho de arquivo', 200, (t) => fact('PreToolUse', { tool_name: 'Read', tool_input: { file_path: t } }).target],
  ];
  const SECRETS = [
    (k) => `${'a'.repeat(k)} --password hunter2-segredo resto`,
    (k) => `${'a'.repeat(k)} token=segredoXYZ123 resto`,
    (k) => `${'a'.repeat(k)} ghp_${'Q'.repeat(36)} resto`,
    (k) => `${'a'.repeat(k)} -H "Authorization: Bearer segredoXYZ123"`,
    URL_SECRET,
    (k) => `${'a'.repeat(k)} '${'p'.repeat(2)}assword' => 'segredoXYZ123'`,
    (k) => `${'🙂'.repeat(k)} AKIA${'Z'.repeat(16)}`,
  ];
  const LEAK = /hunter2|segredoXYZ|QQQQ|ZZZZ/;

  for (const [label, limit, build] of FIELDS) {
    it(`${label}: até ${limit}, ponto fixo de redact, segredo nunca visível perto do corte`, () => {
      for (const make of SECRETS) {
        for (let k = Math.max(0, limit - 30); k <= limit + 2; k++) {
          const out = build(make(k));
          if (out === null) continue;
          assert.ok(charLength(out) <= limit, `${label} k=${k}: ${charLength(out)} > ${limit}`);
          assert.equal(redact(out), out, `${label} k=${k}: não é ponto fixo`);
          assert.doesNotMatch(out, LEAK, `${label} k=${k}: segredo visível em ${JSON.stringify(out)}`);
          assert.doesNotMatch(out, /[\uD800-\uDBFF]$/, `${label} k=${k}: par de surrogates partido`);
        }
      }
      assert.equal(build('b'.repeat(limit)), 'b'.repeat(limit), 'no limite exato não corta');
      const cut = build('b'.repeat(limit + 1));
      assert.equal(cut, `${'b'.repeat(limit - 1)}…`, 'um acima do limite corta com …');
    });
  }

  it('caminho de arquivo: a normalização das barras não desfaz o que a redação procura', () => {
    const files = [
      'https://usuaria:segredoXYZ123@exemplo.org/x',
      `${PROJECT}\\clone de https://usuaria:segredoXYZ123@exemplo.org`,
      `${PROJECT}\\password="a\\"b segredoXYZ123"`,
      `docs/password="a\\"bsegredoXYZ123"`,
    ];
    for (const file of files) {
      assert.notEqual(redact(file), file, 'o texto cru é redigido');
      const target = fact('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } }).target;
      assert.doesNotMatch(String(target), /segredoXYZ/, `${JSON.stringify(file)} → ${JSON.stringify(target)}`);
    }
  });

  it('invisíveis e controles de direção saem do texto exibido', () => {
    const f = fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf \u202Etxt.exe\u200B gh\u200Bp_' + 'a'.repeat(36) } });
    assert.equal(f.target, 'rm -rf txt.exe •••');
  });

  it('o pedido que começa com / mostra só o comando, redigido e no limite', () => {
    assert.equal(fact('UserPromptSubmit', { prompt: '/review token=abc' }).title, '/review');
    assert.equal(fact('UserPromptSubmit', { prompt: `/${'c'.repeat(200)} x` }).title, `/${'c'.repeat(78)}…`);
    assert.equal(fact('UserPromptSubmit', { prompt: '/token=abc' }).title, '/token=•••');
  });
});

describe('leitura limitada: token sobre a borda dos SCAN_CHARS', () => {
  const TOKENS = [
    `ghp_${'A'.repeat(36)}`,
    `AKIA${'B'.repeat(16)}`,
    `sk-ant-${'c'.repeat(40)}`,
    `npm_${'D'.repeat(36)}`,
    `hf_${'e'.repeat(30)}`,
    `glpat-${'f'.repeat(24)}`,
  ];
  const visible = (text) => [
    fact('UserPromptSubmit', { prompt: text }).title,
    fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: text } }).target,
    fact('PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, error: text }).error,
  ];
  const assertNoPiece = (text, token, label) => {
    // O prefixo conhecido mais o primeiro caractere do corpo: qualquer pedaço visível o contém.
    const prefix = token.match(/^(?:sk-ant-|glpat-|ghp_|npm_|hf_|AKIA)./)[0];
    for (const out of visible(text)) {
      assert.ok(out === null || !out.includes(prefix), `${label}: pedaço do token visível em ${JSON.stringify(out)}`);
    }
  };

  it('depois de espaços em branco, o trecho termina antes do token', () => {
    for (const token of TOKENS) {
      for (const gap of ['\n', ' ', '\t', '\r\n', '\u3000']) {
        for (const offset of [2, 5, 9, 15]) {
          const text = `${gap.repeat(Math.ceil((SCAN_CHARS - offset) / gap.length)).slice(0, SCAN_CHARS - offset)}${token} fim`;
          assertNoPiece(text, token, `${JSON.stringify(gap)} offset ${offset}`);
        }
      }
    }
  });

  it('depois de caracteres invisíveis (removidos pela redação), o token não aparece pela metade', () => {
    for (const token of TOKENS) {
      for (const invisible of ['\u200B', '\u00AD', '\u2060', '\uFE0F']) {
        const text = `${invisible.repeat(SCAN_CHARS - 10)}${token}`;
        assertNoPiece(text, token, `U+${invisible.codePointAt(0).toString(16)} ${token.slice(0, 4)}`);
      }
    }
  });

  it('depois de um token longo que a redação encolhe para •••, o token seguinte não aparece pela metade', () => {
    const text = `ghp_${'X'.repeat(SCAN_CHARS - 20)};AKIA${'B'.repeat(16)}`;
    assertNoPiece(text, `AKIA${'B'.repeat(16)}`, 'token encolhido');
  });
});

describe('inputHash (seção 2)', () => {
  it('PermissionRequest e PreToolUse casam com as chaves em outra ordem, em qualquer profundidade (JSON real)', () => {
    const a = JSON.parse('{"command":"node -e \\"1\\"","description":"Gravar","timeout":120000,"opts":{"z":[1,{"y":2,"x":[3,{"b":1,"a":0}]}],"a":null}}');
    const b = JSON.parse('{"opts":{"a":null,"z":[1,{"x":[3,{"a":0,"b":1}],"y":2}]},"timeout":120000,"description":"Gravar","command":"node -e \\"1\\""}');
    const pre = fact('PreToolUse', { tool_name: 'Bash', tool_input: a, tool_use_id: TOOL_USE });
    const req = fact('PermissionRequest', { tool_name: 'Bash', tool_input: b });
    assert.match(pre.inputHash, /^[0-9a-f]{16}$/);
    assert.equal(req.inputHash, pre.inputHash);
    assert.equal(inputHash(a), inputHash(b));
  });

  it('muda com qualquer valor, com a ordem de listas e com a forma Unicode', () => {
    const base = inputHash({ command: 'ls', list: ['a', 'b'] });
    for (const other of [{ command: 'ls ', list: ['a', 'b'] }, { command: 'ls', list: ['b', 'a'] }, { command: 'ls', list: ['a', 'b'], x: null }, { Command: 'ls', list: ['a', 'b'] }]) {
      assert.notEqual(inputHash(other), base, JSON.stringify(other));
    }
    assert.notEqual(inputHash({ c: 'ação' }), inputHash({ c: 'ação'.normalize('NFD') }));
  });

  it('é o SHA-256 da serialização com chaves ordenadas (16 primeiros hexadecimais)', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('{"a":[1,{"b":2,"c":3}],"d":"é"}').digest('hex').slice(0, 16);
    assert.equal(inputHash({ d: 'é', a: [1, { c: 3, b: 2 }] }), expected);
  });

  it('o inputHash não carrega o conteúdo e não depende do corte de exibição', () => {
    const long = `echo ${'x'.repeat(500)}`;
    const f1 = fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: `${long}a` } });
    const f2 = fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: `${long}b` } });
    assert.equal(f1.target, f2.target, 'mesmo alvo exibido');
    assert.notEqual(f1.inputHash, f2.inputHash, 'chamadas diferentes');
  });
});

describe('resolveRole (ADR 0007; seção 5)', () => {
  /** [agent_type, sobrescritas, papel] */
  const CASES = [
    ['arquiteto', undefined, 'arq'],
    ['dev-backend', undefined, 'dev'],
    ['dev-frontend', undefined, 'dev'],
    ['tester', undefined, 'tes'],
    ['documentador', undefined, 'doc'],
    ['plugin:tester', undefined, 'tes'],
    ['meu-plugin:arquiteto', undefined, 'arq'],
    ['a:b:dev-frontend', undefined, 'dev'],
    ['tester:outro', undefined, 'aux'],
    ['general-purpose', undefined, 'aux'],
    ['Explore', undefined, 'aux'],
    ['Plan', undefined, 'aux'],
    ['statusline-setup', undefined, 'aux'],
    ['agente-de-outro-projeto', undefined, 'aux'],
    ['TESTER', undefined, 'aux'],
    ['', undefined, 'aux'],
    [null, undefined, 'aux'],
    [undefined, undefined, 'aux'],
    [7, undefined, 'aux'],
    ['backend', { backend: 'dev' }, 'dev'],
    ['revisor', { revisor: 'tes' }, 'tes'],
    ['tester', { tester: 'doc' }, 'doc'],
    ['tester', { tester: 'aux' }, 'aux'],
    ['plugin:revisor', { revisor: 'arq' }, 'arq'],
    ['plugin:revisor', { 'plugin:revisor': 'doc', revisor: 'arq' }, 'doc'],
    ['arquiteto', { backend: 'dev' }, 'arq'],
    ['tester', { tester: 'orq' }, 'tes'],
    ['x', { x: 'orq' }, 'aux'],
    ['main', { main: 'orq' }, 'aux'],
    ['x', { x: 'DEV' }, 'aux'],
    ['x', { x: ['dev'] }, 'aux'],
    ['x', JSON.parse('{"__proto__":{"x":"dev"}}'), 'aux'],
    ['toString', {}, 'aux'],
    ['constructor', undefined, 'aux'],
    ['tester', null, 'tes'],
    ['tester', 'roles', 'tes'],
    ['tester', ['doc'], 'tes'],
  ];
  for (const [type, overrides, role] of CASES) {
    it(`${JSON.stringify(type)} ${overrides === undefined ? '' : JSON.stringify(overrides)} → ${role}`, () => {
      assert.equal(resolveRole(type, overrides), role);
    });
  }

  it('nenhuma combinação dá orq, e todo papel é do contrato', () => {
    const roles = [...ROLES, 'ORQ', 'chefe', '', null];
    const types = ['tester', 'plugin:tester', 'x', 'main', 'orq', ''];
    for (const type of types) {
      for (const value of roles) {
        const out = resolveRole(type, { [type]: value, tester: value, x: value });
        assert.ok(ROLES.includes(out), out);
        assert.notEqual(out, 'orq', `${type} → ${value}`);
      }
    }
  });
});

describe('agent_id presente e inválido descarta o evento (seção 2)', () => {
  it('fora de ^[A-Za-z0-9_.:-]{1,128}$ (inclusive só espaços, espaço, /, @, acento e controle): null, nunca main', () => {
    for (const id of ['', '   ', 'a b', 'a/b', 'a@b', 'ação', 'a\n', 'a​', 42, 0, true, false, {}, [], [AGENT], { id: AGENT }, 'a'.repeat(129)]) {
      for (const hook of ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Notification']) {
        assert.equal(fact(hook, { ...DOCUMENTED[hook], agent_id: id }), null, `${hook} com agent_id ${JSON.stringify(id)}`);
      }
    }
  });

  it('sem a chave ou com null continua a sessão principal; 128 caracteres ainda é válido', () => {
    const { agent_id: _ignored, ...withoutAgent } = DOCUMENTED.PreToolUse;
    assert.equal(fact('PreToolUse', withoutAgent).agentId, null);
    assert.equal(fact('PreToolUse', { ...withoutAgent, agent_id: null }).agentId, null);
    assert.equal(fact('PreToolUse', { ...withoutAgent, agent_id: 'a'.repeat(128) }).agentId, 'a'.repeat(128));
  });

  it('formatos reais passam; session_id segue o mesmo padrão; tool_use_id, prompt_id e agentId do Agent fora dele viram null sem descartar', () => {
    for (const id of ['a0123456789abcdef', '5f1c2b3a-1111-4222-a333-444455556666', 'toolu_01QwErTyUiOp', 'x.y:z-w_1']) {
      const f = fact('PostToolUse', { tool_name: 'Agent', tool_input: {}, agent_id: id, tool_use_id: id, prompt_id: id, tool_response: { agentId: id, status: 'completed' } });
      assert.deepEqual([f.agentId, f.toolUseId, f.promptId, f.linkedAgentId], [id, id, id, id], id);
      assert.equal(fact('Stop', { session_id: id }).sessionId, id);
    }
    for (const id of ['   ', 'a b', 'a/b', 'ação']) assert.equal(fact('Stop', { session_id: id }), null, JSON.stringify(id));
    const { agent_id: _ignored, ...withoutAgent } = DOCUMENTED.PostToolUse;
    const f = fact('PostToolUse', { ...withoutAgent, tool_name: 'Agent', tool_input: {}, tool_use_id: 'a b', prompt_id: '   ', tool_response: { agentId: 'x/y', status: 'completed' } });
    assert.deepEqual([f.kind, f.agentId, f.toolUseId, f.promptId, f.linkedAgentId, f.launch], ['tool.post', null, null, null, null, 'completed']);
    const stop = fact('Stop', { background_tasks: [{ id: 'a b', type: 'local_agent' }] });
    assert.equal(stop.backgroundTasks[0].id, null);
  });

  it('agent_type vazio vira null, mas o evento continua (só o agent_id identifica a instância)', () => {
    const f = fact('PreToolUse', { ...DOCUMENTED.PreToolUse, agent_type: '' });
    assert.deepEqual([f.agentId, f.agentType, f.agentTypeKey], [AGENT, null, null]);
  });
});

describe('identificadores: exibido ponto fixo de redact, *Key cru (seção 2, revisão de 18/10/2026)', () => {
  const SECRET_IDS = ['https://u:p@h/', `ghp_${'K'.repeat(36)}`, `AKIA${'Q'.repeat(16)}`, 'x --password=hunter2', 'token=abc'];
  const RAW = /u:p@|KKKK|QQQQ|hunter2|abc/;

  it('vetores obrigatórios em subagent_type e tool_name não aparecem crus', () => {
    for (const id of SECRET_IDS) {
      for (const tool of ['Agent', 'Task']) {
        const f = fact('PreToolUse', { tool_name: tool, tool_input: { subagent_type: id, description: 'x' } });
        for (const key of ['subagentType', 'target']) {
          assert.doesNotMatch(String(f[key]), RAW, `${tool}.${key} com ${JSON.stringify(id)}: ${JSON.stringify(f[key])}`);
          assert.equal(redact(f[key]), f[key]);
        }
        assert.equal(f.subagentTypeKey, id, 'o cru vai só no *Key');
      }
      for (const hook of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']) {
        const f = fact(hook, { tool_name: id, tool_input: {}, tool_use_id: TOOL_USE });
        assert.doesNotMatch(String(f.tool), RAW, `${hook}.tool com ${JSON.stringify(id)}: ${JSON.stringify(f.tool)}`);
        assert.equal(redact(f.tool), f.tool);
        if ('target' in f) assert.doesNotMatch(String(f.target), RAW);
      }
    }
  });

  it('agent_type, modelo, skill, alvo MCP e backgroundTasks também saem redigidos', () => {
    for (const id of SECRET_IDS) {
      const shown = [
        fact('SubagentStart', { agent_id: AGENT, agent_type: id }).agentType,
        fact('SessionStart', { model: id }).model,
        fact('PreToolUse', { tool_name: 'Skill', tool_input: { skill: id } }).target,
        fact('Stop', { background_tasks: [{ id: AGENT, type: 'local_agent', status: 'running', agent_type: id }] }).backgroundTasks[0].agentType,
      ];
      for (const value of shown) {
        assert.doesNotMatch(String(value), RAW, `${JSON.stringify(id)} → ${JSON.stringify(value)}`);
        assert.equal(redact(value), value);
      }
      assert.equal(fact('SubagentStart', { agent_id: AGENT, agent_type: id }).agentTypeKey, id);
      assert.equal(fact('Stop', { background_tasks: [{ id: AGENT, agent_type: id }] }).backgroundTasks[0].agentTypeKey, id);
    }
  });

  it('auth:tester aparece como auth:•••, e o papel sai do cru (tes)', () => {
    const f = fact('SubagentStart', { agent_id: AGENT, agent_type: 'auth:tester' });
    assert.deepEqual([f.agentType, f.agentTypeKey, resolveRole(f.agentTypeKey)], ['auth:•••', 'auth:tester', 'tes']);
    const d = fact('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'secret-scanner:dev-backend' } });
    assert.equal(resolveRole(d.subagentTypeKey), 'dev');
    assert.equal(redact(d.subagentType), d.subagentType);
  });

  it('identificador comum fica como está; o cru perde invisíveis e controles e decide a categoria', () => {
    const f = fact('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'agent-quest-probe:probe-worker' }, agent_id: AGENT, agent_type: 'dev-backend' });
    assert.deepEqual([f.subagentType, f.subagentTypeKey, f.agentType, f.agentTypeKey], ['agent-quest-probe:probe-worker', 'agent-quest-probe:probe-worker', 'dev-backend', 'dev-backend']);
    const hidden = fact('PreToolUse', { tool_name: 'Re\u200Ba\u001b[0md', tool_input: { file_path: `${PROJECT}\\a.js` }, agent_id: AGENT, agent_type: 'tes\u202Eter\u0007' });
    assert.deepEqual([hidden.tool, hidden.category, hidden.target, hidden.agentTypeKey, resolveRole(hidden.agentTypeKey)], ['Read', 'read', 'a.js', 'tester', 'tes']);
  });

  it('*Key acima de 128 vira null; o exibido é cortado em 80', () => {
    const f = fact('SubagentStart', { agent_id: AGENT, agent_type: 'n'.repeat(129) });
    assert.equal(f.agentTypeKey, null);
    assert.equal(f.agentType, `${'n'.repeat(79)}…`);
    assert.equal(fact('SubagentStart', { agent_id: AGENT, agent_type: 'n'.repeat(128) }).agentTypeKey, 'n'.repeat(128));
  });
});

describe('formas de caminho (seção 2, revisão de 18/10/2026)', () => {
  const UNC = '\\\\servidor\\share\\proj';
  /** [rótulo, file_path, projectDir, homeDir, esperado] */
  const CASES = [
    ['\\\\?\\ dentro do projeto', `\\\\?\\${PROJECT}\\src\\a.js`, PROJECT, HOME, 'src/a.js'],
    ['\\\\?\\ na pasta pessoal', `\\\\?\\${HOME}\\Downloads\\a.zip`, PROJECT, HOME, '~/Downloads/a.zip'],
    ['\\\\.\\ dentro do projeto', `\\\\.\\${PROJECT}\\a.js`, PROJECT, HOME, 'a.js'],
    ['\\\\.\\ na pasta pessoal', `\\\\.\\${HOME}\\a.txt`, PROJECT, HOME, '~/a.txt'],
    ['\\\\?\\ com prefixo parecido', `\\\\?\\${PROJECT}-2\\a.js`, PROJECT, HOME, '~/Code/agents-quest-2/a.js'],
    ['\\\\?\\UNC\\ dentro do projeto UNC', '\\\\?\\UNC\\servidor\\share\\proj\\a.js', UNC, HOME, 'a.js'],
    ['\\\\?\\UNC\\ em minúsculas', '\\\\?\\unc\\servidor\\share\\proj\\a.js', UNC, HOME, 'a.js'],
    ['//srv dentro do projeto UNC', '//servidor/share/proj/a.js', UNC, HOME, 'a.js'],
    ['//srv fora mantém as duas barras', '//servidor/share/outro/a.js', UNC, HOME, '//servidor/share/outro/a.js'],
    ['\\\\srv fora mantém as duas barras', '\\\\outro\\share\\a.js', PROJECT, HOME, '//outro/share/a.js'],
    ['projeto em \\\\?\\, arquivo comum', `${PROJECT}\\a.js`, `\\\\?\\${PROJECT}`, HOME, 'a.js'],
    ['projeto em //srv, arquivo \\\\srv', '\\\\servidor\\share\\proj\\a.js', '//servidor/share/proj', HOME, 'a.js'],
    ['/c/ dentro do projeto', '/c/Users/fulana/Code/agents-quest/a.js', PROJECT, HOME, 'a.js'],
    ['/C/ dentro do projeto', '/C/Users/fulana/Code/agents-quest/a.js', PROJECT, HOME, 'a.js'],
    ['/c/ na pasta pessoal', '/c/Users/fulana/.bashrc', PROJECT, HOME, '~/.bashrc'],
    ['/d/ em outra unidade', '/d/dados/a.csv', PROJECT, HOME, 'd:/dados/a.csv'],
    ['projeto em /c/, arquivo em C:\\', `${PROJECT}\\a.js`, '/c/Users/fulana/Code/agents-quest', HOME, 'a.js'],
    ['/c/ sem letra de unidade no contexto fica como veio', '/c/projeto/a.js', '/home/fulana/proj', '/home/fulana', '/c/projeto/a.js'],
    ['/cdrom não é unidade', '/cdrom/a.iso', PROJECT, HOME, '/cdrom/a.iso'],
  ];
  for (const [label, file, projectDir, homeDir, expected] of CASES) {
    it(label, () => {
      assert.equal(displayPath(file, { projectDir, homeDir }), expected);
      const f = normalize(envelope('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } }, { env: { projectDir, entrypoint: null } }), { receivedAt: 1, homeDir });
      assert.equal(f.target, expected, 'no fato');
    });
  }

  it('o caminho cru é redigido antes de normalizar (B2), e o resto do caminho continua relativo', () => {
    const cases = [
      [`${PROJECT}\\sub\\token=abc\\x.js`, 'sub/token=•••'],
      [`${PROJECT}\\sub\\x.js`, 'sub/x.js'],
      [`  ${PROJECT}\\x.js  `, 'x.js'],
      [`${PROJECT}\\a.js\nsegunda linha`, 'a.js'],
    ];
    for (const [file, expected] of cases) assert.equal(fact('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } }).target, expected, JSON.stringify(file));
  });
});

describe('marcador de corte do encaminhador (B3; seção 1 e seção 2)', () => {
  const M = (n) => `…[cortado ${n} caracteres]…`;
  const T = `ghp_${'A'.repeat(36)}`;
  const shown = (text) => [
    fact('UserPromptSubmit', { prompt: text }).title,
    fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: text } }).target,
    fact('PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, error: text }).error,
  ];

  it('as palavras encostadas no marcador saem, dos dois lados', () => {
    const cases = [
      [`${'\n'.repeat(10)}ghp_AAAAAA${M(1959)}xxxx resto`, '… resto'],
      [`${'\n'.repeat(10)}${M(10)}${'A'.repeat(30)} fim`, '… fim'],
      [`início ghp_AAA${M(1)}BBB${M(2)}CCC fim`, 'início … fim'],
      [`ghp_AAAA${M(5)}AAAA`, '…'],
      [`abc ${M(3)} def`, 'abc … def'],
      [`AKIAQQQ${M(7)}QQQQ`, '…'],
    ];
    for (const [text, expected] of cases) {
      for (const out of shown(text)) assert.equal(out, expected, JSON.stringify(text));
    }
  });

  it('marcador fora do formato do contrato não é tratado como corte', () => {
    assert.equal(fact('UserPromptSubmit', { prompt: 'a …[cortado muitos caracteres]… b' }).title, 'a …[cortado muitos caracteres]… b');
    assert.equal(fact('UserPromptSubmit', { prompt: 'a [cortado 5 caracteres] b' }).title, 'a [cortado 5 caracteres] b');
  });
});

describe('controles na etapa 1 do redact (seção 10, revisão de 18/10/2026)', () => {
  it('ANSI CSI e OSC, C0 (menos \\t, \\n e \\r), DEL e C1 saem; \\t vira espaço; nada disso impede a detecção', () => {
    const cases = [
      [`gh\u001b[31mp_${'A'.repeat(36)}`, '•••'],
      [`tok\u0000en=segredo`, 'token=•••'],
      [`AK\u007fIA${'Q'.repeat(16)}`, '•••'],
      [`ghp\u0085_${'A'.repeat(36)}`, '•••'],
      ['x\u001b]0;título\u0007y', 'xy'],
      ['x\u001b]8;;https://u:p@h\u001b\\link\u001b]8;;\u001b\\y', 'xlinky'],
      ['a\tb\t\tc', 'a b  c'],
      ['a\u001bb\u0008c\u009bd', 'abcd'],
    ];
    for (const [text, expected] of cases) {
      const out = redact(text);
      assert.equal(out, expected, JSON.stringify(text));
      assert.equal(redact(out), out, 'idempotente');
    }
    assert.equal(fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: '\u001b[32mnpm\u001b[0m\ttest' } }).target, 'npm test');
  });

  it('idempotência com surrogate solto encostado em controle ou invisível', () => {
    for (const gap of ['\u0000', '\u007f', '\u0085', '\u001b[0m', '\u200B']) {
      const text = `a\uDB40${gap}\uDC41b`;
      const once = redact(text);
      assert.equal(redact(once), once, `redact(redact(x)) com ${JSON.stringify(gap)}`);
      const cut = redactAndCut(text, 80);
      assert.equal(redact(cut), cut, `redactAndCut com ${JSON.stringify(gap)}`);
    }
  });
});

describe('borda de leitura em caractere que é espaço em branco e some na redação', () => {
  const T = `ghp_${'A'.repeat(10)}`;
  const title = (text) => fact('UserPromptSubmit', { prompt: text }).title;

  it('U+FEFF, \\v ou \\f no meio de um token na borda dos SCAN_CHARS não deixam o pedaço visível', () => {
    for (const gap of ['\uFEFF', '\v', '\f']) {
      const text = `${'\n'.repeat(SCAN_CHARS - 100)}${T}${gap}${'A'.repeat(200)}`;
      assert.equal(redact(text).trim(), '•••', 'o texto inteiro é redigido');
      assert.doesNotMatch(String(title(text)), /ghp_/, `${JSON.stringify(gap)}: ${JSON.stringify(title(text))}`);
    }
  });

  it('U+FEFF, \\v ou \\f encostados no marcador de corte não deixam o pedaço visível', () => {
    for (const gap of ['\uFEFF', '\v', '\f']) {
      const text = `${'\n'.repeat(10)}ghp_${'A'.repeat(12)}${gap}…[cortado 99 caracteres]… fim`;
      assert.doesNotMatch(String(title(text)), /ghp_/, `${JSON.stringify(gap)}: ${JSON.stringify(title(text))}`);
    }
  });
});

describe('etapa 7 (ANSI depois da redação) e consequências aprovadas em 18/10/2026', () => {
  const E = '\u001b';
  const BEL = '\u0007';
  const TOKEN = `ghp_${'A'.repeat(36)}`;
  const title = (text) => fact('UserPromptSubmit', { prompt: text }).title;

  it('vetores da seção 10: ESC[ghp_…, ESC[AKIA…, gh ESC[0m p_… e controle no meio do token', () => {
    const cases = [
      [`echo ${E}[${TOKEN}`, 'echo •••'], // T6: a etapa 7 tira a CSI incompleta antes do ••• (seção 10, correção no T6)
      [`${E}[AKIA${'Q'.repeat(16)}`, '•••'],
      [`gh${E}[0mp_${'A'.repeat(36)}`, '•••'],
      [`gh\u0001p_${'A'.repeat(36)}`, '•••'],
      [`${E}[${'1;'.repeat(40)}m${TOKEN}`, '•••'],
      [`${E}${TOKEN}`, '•••'],
    ];
    for (const [text, expected] of cases) {
      const out = redact(text);
      assert.equal(out, expected, JSON.stringify(text));
      assert.equal(redact(out), out);
      assert.doesNotMatch(String(fact('PreToolUse', { tool_name: 'Bash', tool_input: { command: text } }).target), /AAAA|QQQQ/);
    }
  });

  it('BEL que fecha uma OSC fica até a etapa 7 (a OSC sai inteira); BEL solto sai na etapa 1', () => {
    assert.equal(redact(`x ${E}]0;título${BEL} y`), 'x  y');
    assert.equal(redact(`tester${BEL}`), 'tester');
    assert.equal(redact(`a${BEL}b`), 'ab');
    assert.equal(redact(`${E}]8;;https://u:p@h${E}\\link${E}]8;;${E}\\`), 'link');
    assert.equal(fact('SubagentStart', { agent_id: AGENT, agent_type: `tester${BEL}` }).agentTypeKey, 'tester');
  });

  it('identificador: o cru tira ANSI (categoria), o exibido parte só da etapa 1 e passa pela redação', () => {
    const read = fact('PreToolUse', { tool_name: `Re${E}[0mad`, tool_input: { file_path: `${PROJECT}\\a.js` } });
    assert.deepEqual([read.category, read.tool, read.target], ['read', 'Read', 'a.js']);
    for (const value of [`${E}[${TOKEN}`, `${E}[g${TOKEN.slice(1)}`]) {
      const f = fact('PreToolUse', { tool_name: value, tool_input: {}, agent_id: AGENT, agent_type: value });
      const d = fact('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: value } });
      for (const shown of [f.tool, f.target, f.agentType, d.subagentType, d.target]) {
        assert.doesNotMatch(String(shown), /AAAA/, `${JSON.stringify(value)} → ${JSON.stringify(shown)}`);
        assert.equal(redact(shown), shown);
      }
    }
  });

  it('espaços dentro de CSI completa ou de OSC não servem de fronteira (leitura limitada e marcador)', () => {
    const partial = `ghp_${'A'.repeat(10)}`;
    const seqs = [`${E}[ m`, `${E}[1 q`, `${E}]0;a b${BEL}`, `${E}]8;; x ${E}\\`];
    for (const seq of seqs) {
      const atScan = `${'\n'.repeat(SCAN_CHARS - 20)}${partial}${seq}${'A'.repeat(200)}`;
      assert.doesNotMatch(String(title(atScan)), /ghp_/, `leitura limitada com ${JSON.stringify(seq)}: ${JSON.stringify(title(atScan))}`);
      const atMarker = `x ${partial}${seq}…[cortado 9 caracteres]… fim`;
      assert.equal(title(atMarker), 'x … fim', `marcador com ${JSON.stringify(seq)}`);
      const afterMarker = `x …[cortado 9 caracteres]…${seq}${'A'.repeat(30)} fim`;
      assert.equal(title(afterMarker), 'x … fim', `depois do marcador com ${JSON.stringify(seq)}`);
    }
  });

  it('nome MCP remontado parte a parte: mcp__ghp_…__x aparece como mcp__•••__x', () => {
    const cases = [
      [`mcp__${TOKEN}__x`, 'mcp__•••__x', '•••/x'],
      [`mcp__srv__${TOKEN}`, 'mcp__srv__•••', 'srv/•••'],
      ['mcp__github__create_issue', 'mcp__github__create_issue', 'github/create_issue'],
      ['mcp__https://u:p@h/__x', 'mcp__https://•••@h/__x', null],
    ];
    for (const [name, tool, target] of cases) {
      for (const hook of ['PreToolUse', 'PermissionRequest', 'PermissionDenied']) {
        const f = fact(hook, { tool_name: name, tool_input: {}, tool_use_id: TOOL_USE });
        assert.equal(f.tool, tool, `${hook} ${name}`);
        assert.equal(f.category, 'mcp');
        if (target !== null && 'target' in f) assert.equal(f.target, target);
        assert.equal(redact(f.tool), f.tool);
      }
    }
  });

  it('nome MCP exibido respeita o limite de 80 dos nomes', () => {
    for (const name of [`mcp__${'a'.repeat(80)}__${'b'.repeat(80)}`, `mcp__${'a'.repeat(300)}__${'b'.repeat(300)}`]) {
      const tool = fact('PreToolUse', { tool_name: name, tool_input: {} }).tool;
      assert.ok(charLength(tool) <= 80, `${charLength(tool)} caracteres: ${tool}`);
    }
  });

  it('OSC com controle dentro, cujo BEL a redação consome: redact continua idempotente', () => {
    for (const text of [`${E}]0;\u0000 password=abc${BEL} resto`, `${E}]0;\u0001 Authorization: x${BEL} resto`, `${E}]2;\u009b token=abc${BEL}`]) {
      const once = redact(text);
      assert.equal(redact(once), once, JSON.stringify(text));
      const cut = redactAndCut(text, 80);
      assert.equal(redact(cut), cut, `redactAndCut ${JSON.stringify(text)}`);
    }
  });

  it('vizinhos do B6: BEL e ESC órfãos, OSC com ST, aninhada ou sem terminador continuam idempotentes e sem controle', () => {
    const ST = `${E}\\`;
    const cases = [
      [`Authorization: "x ${E}]0;y" ${BEL} resto`, 'Authorization: •••  resto'],
      [`password="a ${E}]0;b" ${BEL} fim`, 'password=•••  fim'],
      [`password='a ${E}]8;;u${ST}' fim`, 'password=•••'],
      [`${E}]8;;https://u:p@h${ST}link${E}]8;;${ST}`, 'link'],
      [`x ${E}]0;a\u0000b${ST} y`, 'x  y'],
      // OSC aberta: desde 19/10/2026 a etapa 7 a tira com o corpo até o próximo ESC, BEL ou espaço (seção 10).
      [`${E}]0;\u0002 token=abc${ST} resto`, ' token=••• resto'],
      [`${E}]0;a ${E}]1;b${BEL} c${BEL} d`, '  c d'],
      [`x ${E}]0;tí\u0000tulo\u0001 password=abc`, 'x  password=•••'],
      [`${E}]${BEL}x`, 'x'],
      [`${E}]0;a${BEL}${BEL}b`, 'b'],
      [`abc ${E}`, 'abc '],
      [`a${E}${E}[mb`, 'ab'],
      [`gh${E}]0;x${BEL}p_${'A'.repeat(36)}`, '•••'],
      [`gh${E}]0;x${ST}p_${'A'.repeat(36)}`, '•••'],
      [`pass${E}]0;x${BEL}word=segredo`, 'password=•••'],
    ];
    for (const [text, expected] of cases) {
      const once = redact(text);
      assert.equal(once, expected, JSON.stringify(text));
      assert.equal(redact(once), once);
      assert.doesNotMatch(once, /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/, 'sobrou controle');
      for (const max of [5, 12, 40]) {
        const cut = redactAndCut(text, max);
        assert.equal(redact(cut), cut, `redactAndCut ${max} ${JSON.stringify(text)}`);
      }
    }
  });

  it('valor de nome sensível dentro de cores ANSI não aparece (API_KEY=ESC[32m…ESC[0m)', () => {
    const colored = (value) => `${E}[32m${value}${E}[0m`;
    const cases = [
      `API_KEY=${colored('abc123segredo')}`,
      `password: ${colored('abc123segredo')}`,
      `export SECRET=${colored('abc123segredo')}`,
      `setx API_KEY ${colored('abc123segredo')}`,
      `token=${colored(`ghp_${'A'.repeat(36)}`)}`,
      `-u ${colored('admin:abc123segredo')}`,
    ];
    for (const text of cases) {
      assert.doesNotMatch(redact(text), /abc123segredo|AAAA/, `redact: ${JSON.stringify(text)} → ${JSON.stringify(redact(text))}`);
      const error = fact('PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, error: `Erro: ${text}` }).error;
      assert.doesNotMatch(String(error), /abc123segredo|AAAA/, `erro no fato: ${JSON.stringify(error)}`);
    }
  });

  it('leitura limpa de 32 Ki: com mais de 24 Ki invisíveis no começo o resultado só encurta', () => {
    const tail = `ghp_${'A'.repeat(36)} fim ${'y'.repeat(5000)}`;
    for (const n of [25_000, 30_000, 40_000]) {
      const out = title(`${'​'.repeat(n)}${tail}`);
      assert.ok(out === null || '••• fim'.startsWith(out) || out.startsWith('••• fim'), `${n}: ${JSON.stringify(out)}`);
      assert.doesNotMatch(String(out), /ghp_|AAAA/);
    }
    const visible = `xxxxxxxxxx ${'palavra '.repeat(2000)}`;
    assert.equal(title(`${'​'.repeat(25_000)}${visible}`), title(visible));
  });
});

describe('tempo com strings enormes', () => {
  // ADR 0010, complemento de 19/10/2026: o custo de 1 MB é comparado, pela razão
  // e com o melhor de 5 intercalado, com a mesma forma em 1/16 do tamanho, medida
  // no mesmo processo logo antes. Com a leitura limitada (SCAN_CHARS), o que sobra
  // de linear (inputHash, contagem de caracteres) dá até cerca de 16; quadrático
  // daria cerca de 256. O limite é 96, 6 vezes o linear; passou dele, uma nova
  // tentativa com o melhor de 9; duas seguidas é falha. Medido em 19/10/2026
  // (pior combinação, melhor de 5): razão 23 em repouso, 18 com 12 processos
  // ocupando a CPU e até 79 com 24. Com o limite de 64, uma rodada em três com
  // 24 processos falhou por ruído (73 e 66); com 96, nenhuma em quatro. Uma
  // cópia do normalizador com um passo quadrático falha em repouso e com 24
  // processos (razões de 107 a 1 517).
  const MB = 1_000_000;
  const REFERENCE = MB / 16;
  const MAX_RATIO = 96;
  const shapes = {
    'texto contínuo': (n) => 'x'.repeat(n),
    'token= repetido': (n) => 'token='.repeat(n / 6),
    'invisível entre letras': (n) => 'a\u200B'.repeat(n / 2),
    'Authorization: repetido': (n) => 'Authorization: '.repeat(n / 15),
    'caminho com ..': (n) => `C:\\${'a\\..\\'.repeat(n / 5)}`,
    'só quebras de linha': (n) => '\n'.repeat(n),
    emoji: (n) => '🙂'.repeat(n / 2),
  };
  const slots = [
    ['UserPromptSubmit', (s) => ({ prompt: s })],
    ['PreToolUse', (s) => ({ tool_name: 'Bash', tool_input: { command: s, description: s } })],
    ['PreToolUse', (s) => ({ tool_name: 'Read', tool_input: { file_path: s } })],
    ['PreToolUse', (s) => ({ tool_name: 'WebFetch', tool_input: { url: `https://${s}` } })],
    ['PreToolUse', (s) => ({ tool_name: `mcp__${s}`, tool_input: { blob: s } })],
    ['PostToolUseFailure', (s) => ({ tool_name: 'Bash', tool_input: {}, error: s })],
    ['Stop', (s) => ({ background_tasks: [{ id: s, type: s, status: s, agent_type: s }], cwd: s })],
    // agent_id acima de 128 descarta o evento (seção 2, 18/10/2026): o tamanho fica nos outros campos.
    ['SubagentStop', (s) => ({ agent_id: 'a0123456789abcdef', agent_type: s, agent_transcript_path: s })],
  ];
  it('cada campo com ~1 MB (o corpo do POST vai até 1 MiB): custo limitado, pela razão contra a mesma forma com 1/16 do tamanho', () => {
    const slow = [];
    const run = (env) => normalize(env, { receivedAt: 1, homeDir: HOME });
    for (const [shape, make] of Object.entries(shapes)) {
      for (const [hook, fields] of slots) {
        const envelope = (n) => ({ v: 1, sentAt: 1, env: { projectDir: PROJECT }, payload: { session_id: SESSION, hook_event_name: hook, ...fields(make(n)) } });
        const big = envelope(MB);
        const out = run(big);
        assert.ok(out, `${shape} em ${hook} virou null`);
        assertSection10(out, `${shape} em ${hook}`);
        const growth = growthWithin(run, envelope(REFERENCE), big, { maxRatio: MAX_RATIO });
        if (!growth.ok) slow.push(`${shape} em ${hook}: ${growth.text}`);
      }
    }
    assert.deepEqual(slow, []);
  });
});
