// @ts-check
// Contrato dos temas (ADR 0009). Um tema é um módulo de dados e funções puras
// que traduz eventos canônicos e modelos de visão em texto. Nenhuma regra de
// negócio depende do tema: trocar de tema muda `data-theme`, refaz os textos e
// não toca no estado nem na conexão.
//
// Além das chaves do esboço do ADR 0009 (`id`, `name`, `icon`, `roles`, `rooms`,
// `phases`, `bars`, `words`, `feedLine`, `actionText`, `finale`, `stats`), o
// contrato tem `icons`: os ícones das linhas de sistema do feed (sessão, ticket
// e etapa), que no mockup ficavam em `sysIcon`.
//
// Este módulo também tem as regras de escolha do tema (hash da URL,
// `localStorage` e teclas 1, 2 e T, como no mockup), que não dependem do DOM.

/** @typedef {import('../../../shared/contract.js').RoleId} RoleId */
/** @typedef {import('../../../shared/contract.js').PhaseId} PhaseId */
/** @typedef {import('../../../shared/contract.js').ToolCategory} ToolCategory */
/** @typedef {import('../../../shared/contract.js').QuestStatus} QuestStatus */
/** @typedef {import('../../../shared/contract.js').CanonicalEvent} CanonicalEvent */
/** @typedef {import('../../../shared/contract.js').AgentState} AgentState */

/**
 * @typedef {'hq'|'design'|'dev'|'idle'|'docs'|'test'} RoomId
 */

/**
 * Nome e ícone de um papel no tema.
 * @typedef {object} RoleWords
 * @property {string} name     nome completo ("Dev Full-stack", "Ferreiro")
 * @property {string} icon     emoji do retrato
 * @property {string} short    nome curto ("Dev", "Ferreiro")
 */

/**
 * Sala da cena (usada a partir do T12a e na legenda do T14).
 * @typedef {object} RoomWords
 * @property {string} name
 * @property {string} icon
 * @property {[string, string]} deco   dois emojis de decoração
 */

/**
 * Palavras do tema usadas pelas telas.
 * @typedef {object} ThemeWords
 * @property {string} quest          "Ticket" / "Quest"
 * @property {string} party          título do cartão Equipe
 * @property {string} feed           título do cartão Atividade
 * @property {string} idle           agente sem tarefa (copa / taverna)
 * @property {string} orqIdle        orquestrador esperando o próximo pedido
 * @property {string} start          agente que acabou de começar
 * @property {string} waiting        agente aguardando aprovação
 * @property {string} noQuest        título do cartão do ticket sem ticket
 * @property {string} noQuestHint    linha de apoio do cartão sem ticket
 * @property {string} noSessions     título do painel sem sessões
 * @property {string} noAgents       cartão Equipe sem sessão
 * @property {string} noFeed         feed vazio
 * @property {Record<QuestStatus, string>} questStatus
 */

/**
 * Ícones das linhas de sistema do feed (no mockup, `sysIcon`).
 * @typedef {object} ThemeIcons
 * @property {string} session
 * @property {string} questStarted
 * @property {string} questDone
 * @property {string} questFailed
 * @property {string} questInterrupted
 * @property {string} phaseDone
 */

/**
 * Helpers que as telas entregam ao tema (`h`). Tudo que é dinâmico passa por
 * eles; as funções que devolvem HTML já escapam o texto.
 * @typedef {object} ThemeHelpers
 * @property {(value: unknown) => string} esc        escapa &, <, >, " e '
 * @property {(value: unknown) => string} code       `<code>` com o texto escapado
 * @property {(value: unknown) => string} b          `<b>` com o texto escapado
 * @property {(value: unknown) => string} i          `<i>` com o texto escapado
 * @property {(n: number, one: string, many: string) => string} plural
 * @property {(ms: number) => string} duration       "04:31" ou "1:02:03"
 * @property {(agentKey: string|null) => string} role   nome do papel do agente, em negrito (HTML seguro); convidado mostra o `agent_type`
 * @property {(roleId: string, agentType?: string|null) => string} roleName   o mesmo, a partir do papel (alvo de uma delegação)
 * @property {(agentKey: string|null) => RoleId} roleOf
 * @property {(roleId: string) => string} short      nome curto do papel (texto puro)
 * @property {(phaseId: string) => string} phase     rótulo da etapa no tema (texto puro)
 */

/**
 * Indicadores do topo (ADR 0008), já com os valores do contrato.
 * @typedef {object} SessionStatsView
 * @property {number} durationMs
 * @property {number} bugsCrushed
 * @property {number} questsDone
 * @property {number} pendingApprovals
 */

/**
 * Um indicador do topo, em texto puro (a tela escapa).
 * @typedef {object} StatItem
 * @property {'duration'|'bugs'|'quests'|'pending'} id
 * @property {string} icon
 * @property {string} value
 * @property {string} label
 * @property {string} title       tooltip; indicador aproximado leva "≈" (ADR 0008)
 * @property {boolean} highlight  destaque (aprovação pendente)
 */

/**
 * Resumo de um ticket entregue, para o cartão final (T12b).
 * @typedef {object} QuestSummary
 * @property {number} n
 * @property {string} title
 * @property {number} actions
 * @property {number} agents
 * @property {number} durationMs
 */

/**
 * @typedef {object} FinaleCard
 * @property {string} icon
 * @property {string} title
 * @property {string} sub
 */

/**
 * @typedef {object} Theme
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {Record<RoleId, RoleWords>} roles
 * @property {Record<RoomId, RoomWords>} rooms
 * @property {Record<PhaseId, string>} phases      rótulos do stepper
 * @property {{ health: string, context: string }} bars
 * @property {ThemeWords} words
 * @property {ThemeIcons} icons
 * @property {(event: CanonicalEvent, h: ThemeHelpers) => string|null} feedLine   HTML seguro, ou null para não aparecer no feed
 * @property {(agent: AgentState|null, h: ThemeHelpers) => string} actionText   texto puro do balão e da linha do cartão
 * @property {(summary: QuestSummary) => FinaleCard} finale
 * @property {(view: SessionStatsView) => StatItem[]} stats
 */

/** Chaves de primeiro nível de todo tema. */
export const THEME_KEYS = Object.freeze([
  'id', 'name', 'icon', 'roles', 'rooms', 'phases', 'bars', 'words', 'icons',
  'feedLine', 'actionText', 'finale', 'stats',
]);

/** Salas da cena, na ordem do mockup. */
export const ROOM_IDS = Object.freeze(/** @type {const} */ (['hq', 'design', 'dev', 'idle', 'docs', 'test']));

/** Funções do tema. */
const THEME_FUNCTIONS = ['feedLine', 'actionText', 'finale', 'stats'];

/**
 * Confere a forma de um tema. Devolve a lista de problemas (vazia se estiver certo).
 * @param {any} theme
 * @param {{ roles: readonly string[], phases: readonly string[] }} lists   papéis e etapas do contrato compartilhado
 * @returns {string[]}
 */
export function checkTheme(theme, { roles, phases }) {
  const problems = [];
  if (!theme || typeof theme !== 'object') return ['o tema não é um objeto'];
  for (const key of THEME_KEYS) {
    if (!(key in theme)) problems.push(`falta a chave "${key}"`);
  }
  for (const key of THEME_FUNCTIONS) {
    if (key in theme && typeof theme[key] !== 'function') problems.push(`"${key}" não é função`);
  }
  for (const key of ['id', 'name', 'icon']) {
    if (typeof theme[key] !== 'string' || theme[key] === '') problems.push(`"${key}" precisa ser texto`);
  }
  for (const role of roles) {
    const words = theme.roles?.[role];
    for (const field of ['name', 'icon', 'short']) {
      if (typeof words?.[field] !== 'string' || words[field] === '') problems.push(`roles.${role}.${field} ausente`);
    }
  }
  for (const room of ROOM_IDS) {
    const words = theme.rooms?.[room];
    if (typeof words?.name !== 'string' || typeof words?.icon !== 'string' || !Array.isArray(words?.deco) || words.deco.length !== 2) {
      problems.push(`rooms.${room} incompleta`);
    }
  }
  for (const phase of phases) {
    if (typeof theme.phases?.[phase] !== 'string' || theme.phases[phase] === '') problems.push(`phases.${phase} ausente`);
  }
  for (const bar of ['health', 'context']) {
    if (typeof theme.bars?.[bar] !== 'string' || theme.bars[bar] === '') problems.push(`bars.${bar} ausente`);
  }
  return problems;
}

/**
 * Primeiro id válido entre os candidatos (por exemplo, o hash da URL e depois o
 * `localStorage`), ou o primeiro tema da lista.
 * @param {Array<string|null|undefined>} candidates
 * @param {readonly string[]} ids
 * @returns {string}
 */
export function resolveThemeId(candidates, ids) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && ids.includes(candidate)) return candidate;
  }
  return ids[0];
}

/**
 * Tema pedido por uma tecla: `1`, `2`... escolhem pela posição; `t` ou `T`
 * alternam para o próximo. Devolve null se a tecla não for de tema.
 * @param {string} key
 * @param {string} currentId
 * @param {readonly string[]} ids
 * @returns {string|null}
 */
export function themeIdForKey(key, currentId, ids) {
  if (key === 't' || key === 'T') {
    const index = ids.indexOf(currentId);
    return ids[(index + 1) % ids.length];
  }
  if (/^[1-9]$/.test(key)) {
    return ids[Number(key) - 1] ?? null;
  }
  return null;
}
