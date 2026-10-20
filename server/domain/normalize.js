// @ts-check
// Normalizador: envelope v1 → fato mínimo e redigido (modelo de eventos, seções 2 e 10).
//
// - Cobre os 15 hooks do ADR 0001. Evento desconhecido, envelope sem payload ou
//   payload sem `session_id` devolvem null (contam como `ignored` no /api/health).
// - Nunca lança: entrada malformada vira null, e campo com tipo errado vira null.
// - Minimização (seção 10): do `tool_input` só saem alvo, detalhe e `inputHash`;
//   do `tool_response`, só `agentId` e `status` do Agent e, de comando de teste,
//   as contagens do resumo (`testResult`, T6). Conteúdo de arquivo, saídas, texto
//   do assistente, resumo da compactação e o pedido completo nunca entram no fato.
// - Todo texto exibido passa por `redactAndCut` (via tools.js), com os limites
//   da seção 10. Nenhuma string do fato passa de 200 caracteres, menos os
//   caminhos guardados (projectDir, transcriptPath, agentTranscriptPath), até 1024.
//
// Adiantado antes do G0a (plano, T5): os campos que dependem do T0 ficam em
// funções próprias, lidas de forma defensiva, com o item V no comentário:
// `promptOrigin` (V7), `agentLaunch` (V5), `clientFromEntrypoint` (V11) e, no
// T6, `testOutputs` e o `testOk` de tests-detect.js (V3).

import os from 'node:os';
import { charLength, redact } from './redact.js';
import {
  AGENT_TOOLS,
  LIMITS,
  describeTool,
  firstRedactedLine,
  identifier,
  identifierKey,
  inputHash,
  isPlainObject,
  rawIdentifier,
  textLine,
  toolDisplayName,
} from './tools.js';
import { parseTestSummary, testCommandInfo, testOk } from './tests-detect.js';

/** Fato por hook (seção 2). Os 15 eventos assinados pelo plugin (ADR 0001). */
export const HOOK_FACTS = Object.freeze({
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

/** Ids (sessão, agente, pedido, chamada) mais longos que isto são tratados como inválidos. */
export const MAX_ID_CHARS = 128;

/**
 * Formato aceito para ids (seção 2): letras, dígitos, `_`, `.`, `:` e `-`, de 1
 * a 128, sem espaços nem controles. Cobre UUID e o `a…` hexadecimal dos agentes.
 * `session_id` e `agent_id` fora dele descartam o evento; `tool_use_id`,
 * `prompt_id` e os demais viram null.
 */
export const ID_PATTERN = new RegExp(`^[A-Za-z0-9_.:-]{1,${MAX_ID_CHARS}}$`);

/**
 * `agent_id` reservado: `main` é a chave da sessão principal no estado
 * (`agentKey = agent_id ?? 'main'`), então um subagente com esse id seria
 * atribuído ao orquestrador. É tratado como id inválido (seção 2; T7, ponto 14).
 */
export const RESERVED_AGENT_IDS = Object.freeze(['main']);

/**
 * Caminhos guardados como vieram (projectDir, transcriptPath, agentTranscriptPath):
 * até 1024; acima disso, null. São as únicas exceções ao teto de 200 da seção 10
 * (seção 2, "Forma do fato e limites"): um transcript de subagente passa de 200 com facilidade.
 */
export const MAX_STORED_PATH_CHARS = 1024;

/** Quantas tarefas em segundo plano do Stop entram no fato. */
export const MAX_BACKGROUND_TASKS = 50;

const SESSION_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'];
const SESSION_END_REASONS = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'];
const NOTICE_TYPES = ['permission_prompt', 'idle_prompt'];
const COMPACT_TRIGGERS = ['manual', 'auto'];
const AGENT_LAUNCHES = ['completed', 'async_launched'];

/**
 * Marcas que o Claude Code põe no início do pedido quando o UserPromptSubmit é
 * do sistema (retorno de subagente em segundo plano, por exemplo). Formato a
 * confirmar no T0 (V7); o G0b acrescenta as que aparecerem.
 */
export const SYSTEM_PROMPT_TAGS = Object.freeze(['task-notification']);
const SYSTEM_PROMPT = new RegExp(`^<(?:${SYSTEM_PROMPT_TAGS.join('|')})(?=[\\s>])`);

/** Pasta pessoal padrão para abreviar caminhos com `~`. */
const DEFAULT_HOME_DIR = defaultHomeDir();

/**
 * @typedef {keyof typeof HOOK_FACTS} HookName
 * @typedef {typeof HOOK_FACTS[HookName]} FactKind
 * @typedef {import('../../shared/contract.js').ToolCategory} ToolCategory
 */

/**
 * Campos comuns a todo fato (seção 2), mais `client` (V11).
 * @typedef {object} FactCommon
 * @property {FactKind} kind
 * @property {HookName} hook
 * @property {string} sessionId
 * @property {string|null} agentId
 * @property {string|null} agentType       valor exibido (ponto fixo de redact)
 * @property {string|null} agentTypeKey    valor cru, só para uso interno: papel e comparações (seção 2)
 * @property {string|null} promptId
 * @property {string|null} projectDir      env.projectDir; se faltar, o cwd do payload
 * @property {'terminal'|'vscode'|null} client
 * @property {number} ts                   sentAt do encaminhador; se faltar, ou a mais de 5 min da chegada, receivedAt
 * @property {number} receivedAt
 * @property {string|null} transcriptPath  só para a sonda de contexto (T15); nunca vai ao painel
 */

/**
 * Campos de uma chamada de ferramenta (tool.pre, tool.post, tool.fail).
 * @typedef {object} ToolFields
 * @property {string|null} toolUseId
 * @property {string|null} tool
 * @property {ToolCategory|null} category  null para Agent e Task
 * @property {string|null} target
 * @property {string|null} detail
 * @property {string|null} inputHash
 * @property {boolean} background          tool_input.run_in_background
 * @property {string|null} subagentType    só Agent e Task; valor exibido
 * @property {string|null} subagentTypeKey só Agent e Task; valor cru, só para uso interno
 * @property {string|null} description     só Agent e Task
 */

/**
 * @typedef {object} TestResult
 * @property {boolean} ok
 * @property {number|null} passed
 * @property {number|null} failed
 * @property {number|null} total
 * @property {string|null} framework
 * @property {boolean} chained          cadeia `&&` com o teste no fim (seção 6); campo interno do fato, fora do evento canônico
 * @property {true} [partial]           só quando `failed` é o mínimo da lista de falhas do node:test, sem resumo (B13); campo interno
 */

/**
 * @typedef {FactCommon & { kind: 'session.start', source: string|null, model: string|null, sessionTitle: string|null }} SessionStartFact
 * @typedef {FactCommon & { kind: 'session.end', reason: string|null }} SessionEndFact
 * @typedef {FactCommon & { kind: 'prompt.submit', title: string|null, origin: 'user'|'system'|null, sessionTitle: string|null }} PromptFact
 * @typedef {FactCommon & ToolFields & { kind: 'tool.pre' }} ToolPreFact
 * @typedef {FactCommon & ToolFields & { kind: 'tool.post', durationMs: number|null, linkedAgentId: string|null, launch: 'completed'|'async_launched'|null, testResult: TestResult|null }} ToolPostFact
 * @typedef {FactCommon & ToolFields & { kind: 'tool.fail', durationMs: number|null, error: string|null, interrupted: boolean, testResult: TestResult|null }} ToolFailFact
 * @typedef {FactCommon & { kind: 'permission.request', tool: string|null, category: ToolCategory|null, target: string|null, inputHash: string|null }} PermissionRequestFact
 * @typedef {FactCommon & { kind: 'permission.denied', toolUseId: string|null, tool: string|null, category: ToolCategory|null }} PermissionDeniedFact
 * @typedef {FactCommon & { kind: 'notice', type: 'permission_prompt'|'idle_prompt'|null }} NoticeFact
 * @typedef {FactCommon & { kind: 'subagent.start' }} SubagentStartFact
 * @typedef {FactCommon & { kind: 'subagent.stop', agentTranscriptPath: string|null }} SubagentStopFact
 * @typedef {{ id: string|null, type: string|null, status: string|null, agentType: string|null, agentTypeKey: string|null }} BackgroundTask
 * @typedef {FactCommon & { kind: 'turn.stop', backgroundTasks: BackgroundTask[] }} TurnStopFact
 * @typedef {FactCommon & { kind: 'turn.fail', error: string|null }} TurnFailFact
 * @typedef {FactCommon & { kind: 'compact.pre'|'compact.post', trigger: 'manual'|'auto'|null }} CompactFact
 * @typedef {SessionStartFact|SessionEndFact|PromptFact|ToolPreFact|ToolPostFact|ToolFailFact|PermissionRequestFact
 *   |PermissionDeniedFact|NoticeFact|SubagentStartFact|SubagentStopFact|TurnStopFact|TurnFailFact|CompactFact} Fact
 */

/**
 * @param {unknown} envelope             envelope v1 (seção 1), já aceito pela ingestão
 * @param {{ receivedAt?: number, homeDir?: string|null }} [options]
 *   `receivedAt`: hora de chegada (relógio do servidor, ms); sem ela, Date.now().
 *   `homeDir`: pasta pessoal para abreviar caminhos com `~` (padrão: os.homedir()).
 * @returns {Fact|null}
 */
export function normalize(envelope, options = {}) {
  try {
    const { receivedAt = Date.now(), homeDir = DEFAULT_HOME_DIR } = options ?? {};
    return buildFact(envelope, receivedAt, homeDir);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} envelope
 * @param {number} receivedAt
 * @param {string|null} homeDir
 * @returns {Fact|null}
 */
function buildFact(envelope, receivedAt, homeDir) {
  if (!isPlainObject(envelope)) return null;
  const data = /** @type {Record<string, unknown>} */ (envelope);
  if (!isPlainObject(data.payload)) return null;
  const payload = /** @type {Record<string, unknown>} */ (data.payload);

  const hook = payload.hook_event_name;
  if (typeof hook !== 'string' || !Object.hasOwn(HOOK_FACTS, hook)) return null;
  const sessionId = idValue(payload.session_id);
  if (sessionId === null) return null;
  // agent_id presente mas inválido descarta o evento: virar 'main' atribuiria o
  // evento ao orquestrador em silêncio (seção 2). Sem a chave, ou null, é a sessão principal.
  const agentId = agentIdValue(payload.agent_id);
  if (agentId === null && payload.agent_id !== undefined && payload.agent_id !== null) return null;

  const env = isPlainObject(data.env) ? /** @type {Record<string, unknown>} */ (data.env) : {};
  const arrival = Number.isFinite(receivedAt) ? receivedAt : Date.now();
  const projectDir = shownPath(env.projectDir) ?? shownPath(payload.cwd);
  const context = { projectDir, homeDir };

  /** @type {FactCommon} */
  const common = {
    kind: HOOK_FACTS[/** @type {HookName} */ (hook)],
    hook: /** @type {HookName} */ (hook),
    sessionId,
    agentId,
    agentType: identifier(payload.agent_type),
    agentTypeKey: identifierKey(payload.agent_type),
    promptId: idValue(payload.prompt_id),
    projectDir,
    client: clientFromEntrypoint(env.entrypoint),
    ts: eventTime(data.sentAt, arrival),
    receivedAt: arrival,
    transcriptPath: storedPath(payload.transcript_path),
  };

  switch (common.kind) {
    case 'session.start':
      return {
        ...common,
        kind: common.kind,
        source: oneOf(payload.source, SESSION_SOURCES),
        model: identifier(payload.model),
        sessionTitle: textLine(payload.session_title, LIMITS.title),
      };
    case 'session.end':
      return { ...common, kind: common.kind, reason: oneOf(payload.reason, SESSION_END_REASONS) };
    case 'prompt.submit':
      return {
        ...common,
        kind: common.kind,
        title: promptTitle(payload.prompt),
        origin: promptOrigin(payload.prompt),
        sessionTitle: textLine(payload.session_title, LIMITS.title),
      };
    case 'tool.pre':
      return { ...common, kind: common.kind, ...toolFields(payload, context) };
    case 'tool.post': {
      const tool = toolFields(payload, context);
      const link = AGENT_TOOLS.has(rawIdentifier(payload.tool_name)) ? agentLaunch(payload.tool_response) : NO_LAUNCH;
      return {
        ...common,
        kind: common.kind,
        ...tool,
        durationMs: duration(payload.duration_ms),
        linkedAgentId: link.linkedAgentId,
        launch: link.launch,
        testResult: tool.category === 'test' ? testResult(common.kind, payload) : null,
      };
    }
    case 'tool.fail': {
      const tool = toolFields(payload, context);
      return {
        ...common,
        kind: common.kind,
        ...tool,
        durationMs: duration(payload.duration_ms),
        error: textLine(payload.error, LIMITS.error),
        interrupted: payload.is_interrupt === true,
        testResult: tool.category === 'test' ? testResult(common.kind, payload) : null,
      };
    }
    case 'permission.request': {
      const { category, target } = describeTool(payload.tool_name, payload.tool_input, context);
      return {
        ...common,
        kind: common.kind,
        tool: toolName(payload.tool_name),
        category,
        target,
        inputHash: inputHash(payload.tool_input),
      };
    }
    case 'permission.denied': {
      const { category } = describeTool(payload.tool_name, payload.tool_input, context);
      return {
        ...common,
        kind: common.kind,
        toolUseId: idValue(payload.tool_use_id),
        tool: toolName(payload.tool_name),
        category,
      };
    }
    case 'notice':
      return {
        ...common,
        kind: common.kind,
        type: /** @type {NoticeFact['type']} */ (oneOf(payload.notification_type, NOTICE_TYPES)),
      };
    case 'subagent.start':
      return { ...common, kind: common.kind };
    case 'subagent.stop':
      return { ...common, kind: common.kind, agentTranscriptPath: storedPath(payload.agent_transcript_path) };
    case 'turn.stop':
      return { ...common, kind: common.kind, backgroundTasks: backgroundTasks(payload.background_tasks) };
    case 'turn.fail':
      return { ...common, kind: common.kind, error: textLine(payload.error, LIMITS.error) };
    case 'compact.pre':
    case 'compact.post':
      return {
        ...common,
        kind: common.kind,
        trigger: /** @type {CompactFact['trigger']} */ (oneOf(payload.trigger, COMPACT_TRIGGERS)),
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Itens a confirmar no T0 (leitura defensiva: ausente ou tipo errado vira null)
// ---------------------------------------------------------------------------

/**
 * V7: origem do pedido. O UserPromptSubmit também dispara para retorno de
 * subagente em segundo plano, tarefa agendada, `/loop` e mensagem de outra
 * sessão, sem campo que diferencie. Regra provisória (seção 6): pedido que
 * começa com uma das marcas de `SYSTEM_PROMPT_TAGS` é do sistema.
 * @param {unknown} prompt
 * @returns {'user'|'system'|null}       null se o pedido não for texto
 */
export function promptOrigin(prompt) {
  if (typeof prompt !== 'string') return null;
  return SYSTEM_PROMPT.test(prompt.trimStart()) ? 'system' : 'user';
}

/**
 * V5: elo delegação → instância, do PostToolUse do Agent (ou Task):
 * `tool_response.agentId` (camelCase) e `tool_response.status`
 * (`completed` em primeiro plano, `async_launched` em segundo plano).
 * @param {unknown} toolResponse
 * @returns {{ linkedAgentId: string|null, launch: 'completed'|'async_launched'|null }}
 */
export function agentLaunch(toolResponse) {
  if (!isPlainObject(toolResponse)) return NO_LAUNCH;
  const response = /** @type {Record<string, unknown>} */ (toolResponse);
  return {
    linkedAgentId: agentIdValue(response.agentId),
    launch: /** @type {'completed'|'async_launched'|null} */ (oneOf(response.status, AGENT_LAUNCHES)),
  };
}

/**
 * [T0] V3: textos de onde sai o resumo do teste (seção 6, "Contagem": o fim do
 * stdout ou do `error`). No PostToolUse, o `stdout` e depois o `stderr` do
 * `tool_response` do Bash (o Jest escreve o resumo no stderr), ou o próprio
 * `tool_response`, se for texto; no PostToolUseFailure, o `error`, que começa
 * com `Exit code N` e traz a saída. Nada desses textos entra no fato: só os
 * números do resumo.
 * @param {'tool.post'|'tool.fail'} kind
 * @param {Record<string, unknown>} payload
 * @returns {string[]}
 */
export function testOutputs(kind, payload) {
  if (kind === 'tool.fail') return typeof payload.error === 'string' ? [payload.error] : [];
  const response = payload.tool_response;
  if (typeof response === 'string') return [response];
  if (!isPlainObject(response)) return [];
  const fields = /** @type {Record<string, unknown>} */ (response);
  /** @type {string[]} */
  const texts = [];
  for (const text of [fields.stdout, fields.stderr]) if (typeof text === 'string') texts.push(text);
  return texts;
}

/**
 * V11: terminal ou VS Code, pelo `env.entrypoint` do envelope (valor de
 * `CLAUDE_CODE_ENTRYPOINT`, a candidata registrada pela sonda). `cli` é o
 * terminal; um valor com `vscode` (como `claude-vscode`) é a extensão. O resto
 * fica null até o T0 confirmar.
 * @param {unknown} entrypoint
 * @returns {'terminal'|'vscode'|null}
 */
export function clientFromEntrypoint(entrypoint) {
  if (typeof entrypoint !== 'string') return null;
  const value = entrypoint.trim().toLowerCase();
  if (value === 'cli') return 'terminal';
  if (value.includes('vscode')) return 'vscode';
  return null;
}

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------

/** @type {{ linkedAgentId: null, launch: null }} */
const NO_LAUNCH = Object.freeze({ linkedAgentId: null, launch: null });

/**
 * `sentAt` mais longe que isto da chegada, para mais ou para menos, vira a hora
 * de chegada (seção 1): um relógio errado ou um `sentAt` forjado não mantém a
 * sessão viva além da limpeza (observação 5 do tester do T7).
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * `ts` do fato: o `sentAt` do encaminhador, se for válido e estiver a até 5 min
 * da chegada; senão, a hora de chegada.
 * @param {unknown} sentAt
 * @param {number} arrival
 * @returns {number}
 */
function eventTime(sentAt, arrival) {
  if (!isTimestamp(sentAt)) return arrival;
  const value = /** @type {number} */ (sentAt);
  return Math.abs(value - arrival) <= MAX_CLOCK_SKEW_MS ? value : arrival;
}

/**
 * `testResult` de um comando de teste (seção 2): `ok` pelo hook (V3, em
 * `testOk`), as contagens do primeiro texto com resumo reconhecido (com os
 * padrões do framework que o comando identifica), `chained` para a cadeia `&&`
 * com o teste no fim e `partial` para a contagem mínima do B13 (seção 6).
 * @param {'tool.post'|'tool.fail'} kind
 * @param {Record<string, unknown>} payload
 * @returns {TestResult}
 */
function testResult(kind, payload) {
  const input = isPlainObject(payload.tool_input) ? /** @type {Record<string, unknown>} */ (payload.tool_input) : {};
  const command = testCommandInfo(input.command);
  let summary = parseTestSummary(null);
  for (const text of testOutputs(kind, payload)) {
    summary = parseTestSummary(text, command?.framework ?? null);
    if (summary.framework !== null) break;
  }
  return {
    ok: testOk(kind, summary),
    passed: summary.passed,
    failed: summary.failed,
    total: summary.total,
    framework: summary.framework,
    chained: command?.kind === 'chained',
    // Só na contagem mínima (B13): a forma dos outros resultados não muda.
    ...(summary.partial === true ? { partial: /** @type {true} */ (true) } : {}),
  };
}

/**
 * Título do pedido (seção 6): primeira linha, até 80, redigida. Pedido que
 * começa com `/` usa só o comando.
 * @param {unknown} prompt
 * @returns {string|null}
 */
export function promptTitle(prompt) {
  const line = firstRedactedLine(prompt);
  if (line === null) return null;
  const title = line.startsWith('/') ? line.split(/\s/, 1)[0] : line;
  return textLine(title, LIMITS.title);
}

/**
 * @param {Record<string, unknown>} payload
 * @param {import('./tools.js').PathContext} context
 * @returns {ToolFields}
 */
function toolFields(payload, context) {
  const tool = toolName(payload.tool_name);
  const input = isPlainObject(payload.tool_input) ? /** @type {Record<string, unknown>} */ (payload.tool_input) : {};
  const { category, target, detail } = describeTool(payload.tool_name, payload.tool_input, context);
  const isAgent = AGENT_TOOLS.has(rawIdentifier(payload.tool_name));
  return {
    toolUseId: idValue(payload.tool_use_id),
    tool,
    category,
    target,
    detail,
    inputHash: inputHash(payload.tool_input),
    // V5 (Agent): `run_in_background` no tool_input; vale também para o Bash.
    background: input.run_in_background === true,
    subagentType: isAgent ? target : null,
    subagentTypeKey: isAgent ? identifierKey(input.subagent_type) : null,
    description: isAgent ? detail : null,
  };
}

/**
 * Nome da ferramenta para exibir (seção 2, "Identificadores"; MCP remontado).
 * @param {unknown} value
 * @returns {string|null}
 */
function toolName(value) {
  return toolDisplayName(value);
}

/**
 * Lista `background_tasks` do Stop: `{ id, type, status, agentType }`.
 * @param {unknown} value
 * @returns {BackgroundTask[]}
 */
function backgroundTasks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_BACKGROUND_TASKS)
    .filter(isPlainObject)
    .map((task) => {
      const item = /** @type {Record<string, unknown>} */ (task);
      return {
        id: idValue(item.id),
        type: textLine(item.type, LIMITS.name),
        status: textLine(item.status, LIMITS.name),
        agentType: identifier(item.agent_type),
        agentTypeKey: identifierKey(item.agent_type),
      };
    });
}

/**
 * Id opaco: só texto que casa com ID_PATTERN (seção 2, revisto em 18/10/2026).
 * @param {unknown} value
 * @returns {string|null}
 */
function idValue(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

/**
 * Id de agente: como `idValue`, e nunca um id reservado (`main`).
 * @param {unknown} value
 * @returns {string|null}
 */
function agentIdValue(value) {
  const id = idValue(value);
  return id !== null && RESERVED_AGENT_IDS.includes(id) ? null : id;
}

/**
 * Caminho guardado como veio (projeto e transcripts): até MAX_STORED_PATH_CHARS.
 * @param {unknown} value
 * @returns {string|null}
 */
function storedPath(value) {
  return typeof value === 'string' && value.trim() !== '' && charLength(value) <= MAX_STORED_PATH_CHARS ? value : null;
}

/**
 * Caminho que o painel mostra (pasta do projeto): como `storedPath`, e também
 * ponto fixo de `redact`, como todo texto exibido.
 * @param {unknown} value
 * @returns {string|null}
 */
function shownPath(value) {
  const stored = storedPath(value);
  return stored !== null && redact(stored) === stored ? stored : null;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @returns {string|null}
 */
function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function duration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** @returns {string|null} */
function defaultHomeDir() {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}
