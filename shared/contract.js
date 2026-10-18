// @ts-check
// Contrato compartilhado entre o servidor e o painel.
// Fonte: docs/arquitetura/modelo-de-eventos.md, seções 3 e 9.
//
// Este módulo roda no Node e no navegador: não importa nada e não usa APIs
// exclusivas de nenhum dos dois. Mudança aqui é mudança de contrato e precisa
// da aprovação do usuário.
//
// Os tipos (typedefs) são usados em outros módulos por um typedef com
// import('../shared/contract.js').SessionState, por exemplo.

// ---------------------------------------------------------------------------
// Listas do contrato (congeladas)
// ---------------------------------------------------------------------------

/** Tipos de evento canônico (seção 3). */
export const EVENT_KINDS = Object.freeze(/** @type {const} */ ([
  'session.started',
  'session.ended',
  'session.idle',
  'quest.started',
  'quest.finished',
  'quest.phase',
  'agent.delegated',
  'agent.started',
  'agent.finished',
  'tool.started',
  'tool.finished',
  'tool.failed',
  'test.finished',
  'permission.requested',
  'permission.resolved',
  'context.compacted',
  'context.usage',
]));

/**
 * Tipos de evento que entram no feed de atividade (coluna "No feed" da seção 3).
 * `quest.phase` entra só quando `data.state` é `done`.
 */
export const FEED_KINDS = Object.freeze(/** @type {const} */ ([
  'session.started',
  'session.ended',
  'quest.started',
  'quest.finished',
  'quest.phase',
  'agent.delegated',
  'agent.finished',
  'tool.started',
  'tool.failed',
  'test.finished',
  'permission.requested',
  'permission.resolved',
  'context.compacted',
]));

/**
 * Papéis do time (ADR 0007), na ordem do cartão Equipe:
 * `orq` sessão principal (orquestradora), `arq` arquiteto, `dev` dev-backend e
 * dev-frontend, `tes` tester, `doc` documentador, `aux` convidado (qualquer outro tipo).
 */
export const ROLES = Object.freeze(/** @type {const} */ ([
  'orq',
  'arq',
  'dev',
  'tes',
  'doc',
  'aux',
]));

/** Categorias de ferramenta (seção 3, "Categorias de ferramenta"). */
export const TOOL_CATEGORIES = Object.freeze(/** @type {const} */ ([
  'read',
  'search',
  'write',
  'edit',
  'test',
  'bash',
  'web',
  'plan',
  'skill',
  'mcp',
  'other',
]));

/**
 * Etapas do ticket, na ordem do stepper (seção 6, "Etapa"):
 * `arq` → `design`, `dev` → `code`, `tes` → `test`, `doc` → `docs`.
 */
export const PHASES = Object.freeze(/** @type {const} */ ([
  'design',
  'code',
  'test',
  'docs',
]));

/** Status de um agente (`AgentState.status`). */
export const AGENT_STATUS = Object.freeze(/** @type {const} */ ([
  'working',
  'waiting',
  'idle',
]));

/**
 * Status de uma sessão (`SessionState.status`). Prioridade: `waiting` sobre
 * `active`, que tem prioridade sobre `idle`; `ended` após o SessionEnd (seção 7).
 */
export const SESSION_STATUS = Object.freeze(/** @type {const} */ ([
  'active',
  'waiting',
  'idle',
  'ended',
]));

/** Status de um ticket (`QuestState.status`). */
export const QUEST_STATUS = Object.freeze(/** @type {const} */ ([
  'open',
  'waiting_background',
  'done',
  'failed',
  'interrupted',
]));

// ---------------------------------------------------------------------------
// Tipos derivados das listas
// ---------------------------------------------------------------------------

/**
 * @typedef {typeof EVENT_KINDS[number]} EventKind
 * @typedef {typeof FEED_KINDS[number]} FeedKind
 * @typedef {typeof ROLES[number]} RoleId
 * @typedef {typeof TOOL_CATEGORIES[number]} ToolCategory
 * @typedef {typeof PHASES[number]} PhaseId
 * @typedef {typeof AGENT_STATUS[number]} AgentStatus
 * @typedef {typeof SESSION_STATUS[number]} SessionStatus
 * @typedef {typeof QUEST_STATUS[number]} QuestStatus
 */

/**
 * Estado de uma etapa dentro do ticket.
 * @typedef {'pending'|'active'|'done'} Phase
 */

// ---------------------------------------------------------------------------
// Evento canônico (seção 3)
// ---------------------------------------------------------------------------

/**
 * O formato de `data` depende de `kind` (tabela da seção 3).
 *
 * @typedef {object} CanonicalEvent
 * @property {string} id                 `${runId}:${seq}`
 * @property {number} seq                crescente dentro de uma execução do servidor
 * @property {number} ts                 ms desde a época (sentAt do encaminhador; se faltar, a hora de chegada)
 * @property {string} sessionId
 * @property {string|null} agentKey      'main', um agent_id, ou null (evento da sessão)
 * @property {EventKind} kind
 * @property {object} data
 */

// ---------------------------------------------------------------------------
// Estado da sessão (seção 9)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SessionState
 * @property {string} id
 * @property {{ key: string, name: string, dir: string }} project
 * @property {string} label
 * @property {'terminal'|'vscode'|null} client
 * @property {SessionStatus} status
 * @property {number} startedAt
 * @property {number} lastEventAt
 * @property {AgentState[]} agents       inclui 'main'
 * @property {RoleId[]} roster           papéis do cartão Equipe, em ordem
 * @property {QuestState|null} quest     atual ou último
 * @property {{ questsDone: number, bugsCrushed: number, pendingApprovals: number }} counters
 * @property {{ open: number, lastRun: TestRun|null }} bugs
 * @property {CanonicalEvent[]} [feed]   só no snapshot: até 200 eventos de FEED_KINDS
 */

/**
 * @typedef {object} AgentState
 * @property {string} key                'main' ou agent_id
 * @property {string|null} agentId
 * @property {string|null} agentType
 * @property {RoleId} role
 * @property {string} label              descrição da delegação, ou agentType
 * @property {AgentStatus} status
 * @property {boolean} finished          subagente que terminou (fica na copa)
 * @property {boolean} background
 * @property {string|null} parentKey
 * @property {Activity|null} activity    última atividade (balão e linha do cartão)
 * @property {{ tool: string, category: ToolCategory, target: string|null }|null} waitingFor
 * @property {{ ok: number, total: number }} health
 * @property {{ pct: number, usedTokens: number, windowTokens: number, at: number }|null} context
 * @property {number} startedAt
 * @property {number} lastEventAt
 */

/**
 * @typedef {object} Activity
 * @property {'tool'|'delegate'|'compact'|'start'} kind
 * @property {ToolCategory|null} category
 * @property {string|null} tool
 * @property {string|null} target
 * @property {string|null} detail
 * @property {'running'|'done'|'failed'} state
 * @property {number} at
 */

/**
 * @typedef {object} QuestState
 * @property {string} id
 * @property {number} n
 * @property {string} title
 * @property {boolean} implicit
 * @property {QuestStatus} status
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {{ design: Phase, code: Phase, test: Phase, docs: Phase }} phases
 * @property {number} actions
 * @property {string|null} error
 */

/**
 * @typedef {object} TestRun
 * @property {boolean} ok
 * @property {number|null} passed
 * @property {number|null} failed
 * @property {number|null} total
 * @property {string|null} framework
 * @property {number} at
 */

// ---------------------------------------------------------------------------
// Mensagens SSE de GET /events e outras rotas (seção 9)
// ---------------------------------------------------------------------------

/**
 * Evento SSE `hello`, o primeiro de cada conexão.
 * @typedef {object} HelloMessage
 * @property {number} protocol           versão do protocolo (1)
 * @property {string} runId              identifica a execução do servidor
 * @property {number} seq                seq atual do servidor
 * @property {string} serverVersion
 */

/**
 * Evento SSE `snapshot`. `GET /api/state` devolve o mesmo conteúdo.
 * @typedef {object} SnapshotMessage
 * @property {number} seq
 * @property {SessionState[]} sessions   com `feed`
 */

/**
 * Evento SSE `update`.
 * @typedef {object} UpdateMessage
 * @property {number} seq
 * @property {CanonicalEvent|null} event null quando só o estado mudou
 * @property {SessionState} session      sem `feed`
 */

/**
 * Evento SSE `session-removed`.
 * @typedef {object} SessionRemovedMessage
 * @property {number} seq
 * @property {string} sessionId
 */

/**
 * Resposta de `GET /api/health`, sem conteúdo de evento.
 * @typedef {object} HealthResponse
 * @property {boolean} ok
 * @property {string} version
 * @property {number} startedAt
 * @property {{ received: number, accepted: number, rejected: number, deduped: number, dropped: number, ignored: number }} events
 * @property {number|null} lastEventAt
 * @property {number} sessions           quantidade de sessões em memória
 * @property {number} clients            quantidade de clientes SSE conectados
 */
