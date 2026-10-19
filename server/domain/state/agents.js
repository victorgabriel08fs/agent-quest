// @ts-check
// Agentes de uma sessão: chave, papel, instâncias, elo delegação → instância,
// atividade e saúde (modelo de eventos, seções 5, 6, 8 e 9; ADR 0007).
//
// - Papel e comparações de tipo usam o valor cru do fato (`agentTypeKey`,
//   `subagentTypeKey`), guardado só nos campos internos `typeKey` e
//   `toTypeKey`. O que vai para o painel (`toAgentState`) leva o tipo exibido.
// - Este módulo só muda o modelo em memória. Quem emite eventos canônicos é o
//   index.js.
//
// Adiantado antes do G0a (plano, T7, condição 1): o que depende de veredito do
// T0 fica nas funções da seção "Itens a confirmar no T0", com o item V no
// comentário: `agentKeyOf` (V1), `pickDelegation` e `linkedAgentOf` (V5),
// `isBackgroundLaunch` (V5) e `listedInBackground` e `runsInBackground` (V5 e V13).

import { resolveRole } from '../roles.js';

/** Chave da sessão principal (orquestradora). */
export const MAIN_KEY = 'main';

/** Saúde: janela das últimas ações do agente (seção 6, "Saúde"). */
export const HEALTH_WINDOW = 10;

/** Agente trabalhando sem ferramenta em execução e sem eventos há 15 min → `agent.finished(unknown)`. */
export const STALE_AGENT_MS = 15 * 60 * 1000;

/** Atividades de chamadas guardadas por agente para escolher a mais recente. */
export const ACTIVITY_WINDOW = 16;

/** Pedidos `Agent` guardados por sessão; acima disso, sai o mais antigo. */
export const MAX_DELEGATIONS = 200;

/** Profundidade máxima ao subir pelos `parentKey` (o Claude Code limita a 3; folga contra ciclos). */
const MAX_DEPTH = 16;

/**
 * @typedef {import('../../../shared/contract.js').RoleId} RoleId
 * @typedef {import('../../../shared/contract.js').Activity} Activity
 * @typedef {import('../../../shared/contract.js').AgentState} AgentState
 * @typedef {import('../../../shared/contract.js').AgentStatus} AgentStatus
 * @typedef {import('../normalize.js').Fact} Fact
 * @typedef {import('../normalize.js').ToolPreFact} ToolPreFact
 * @typedef {import('../normalize.js').ToolPostFact} ToolPostFact
 * @typedef {import('../normalize.js').ToolFailFact} ToolFailFact
 * @typedef {import('../normalize.js').BackgroundTask} BackgroundTask
 * @typedef {ToolPreFact|ToolPostFact|ToolFailFact} ToolFact
 */

/**
 * Agente em memória. Os campos do contrato (AgentState) mais os internos, que
 * nunca saem do servidor: `typeKey`, `activities`, `openCalls`,
 * `outcomes`, `delegation`, `turnEnded` e `revivable`.
 * @typedef {object} Agent
 * @property {string} key                 'main' ou o agent_id
 * @property {string|null} agentId
 * @property {string|null} agentType      valor exibido
 * @property {string|null} typeKey        valor cru, só interno (seção 2, "Identificadores")
 * @property {RoleId} role
 * @property {string} label
 * @property {AgentStatus} status
 * @property {boolean} finished           subagente que terminou (fica na copa)
 * @property {boolean} background
 * @property {string|null} parentKey
 * @property {Activity|null} activity
 * @property {Map<string, Activity>} activities  atividades das chamadas recentes, para escolher a atual
 * @property {Set<string>} openCalls      chamadas em execução (toolUseId)
 * @property {{ ts: number, ok: boolean }[]} outcomes  últimas ações, em ordem de ts
 * @property {Delegation|null} delegation pedido Agent ligado a esta instância
 * @property {boolean} turnEnded          main: turno encerrado (Stop ou SessionEnd) até o próximo pedido (seção 8, regra 4)
 * @property {boolean} revivable          encerrado só pela inferência dos 15 min: um `tool.pre` novo o traz de volta (seção 6)
 * @property {number} startedAt
 * @property {number} lastEventAt
 */

/**
 * Pedido `Agent` (ou `Task`) da sessão (seção 5, "Elo delegação → instância").
 * @typedef {object} Delegation
 * @property {string} id                  toolUseId, ou uma chave interna quando ele falta
 * @property {string|null} toolUseId
 * @property {string} from                agentKey de quem delegou
 * @property {string|null} toType         tipo exibido
 * @property {string|null} toTypeKey      tipo cru, só interno
 * @property {RoleId} toRole
 * @property {string|null} description
 * @property {boolean} background
 * @property {string|null} agentKey       instância ligada (provisória ou confirmada)
 * @property {boolean} confirmed          ligada pelo tool_response.agentId (V5)
 * @property {boolean} closed             o Post ou o Failure da chamada já chegou
 */

/**
 * O que as funções de elo precisam da sessão.
 * @typedef {object} AgentTable
 * @property {Map<string, Agent>} agents
 * @property {Map<string, Delegation>} delegations
 * @property {number} internalIds
 */

// ---------------------------------------------------------------------------
// Itens a confirmar no T0 (G0a e G0b)
// ---------------------------------------------------------------------------

/**
 * V1: chave do agente. `agent_id` presente identifica o subagente; sem ele, o
 * evento é da sessão principal (seção 5; ADR 0007). Nunca usa `agent_type`
 * para decidir se é a sessão principal. Se o V1 for refutado (eventos de
 * ferramenta de subagentes sem `agent_id`), a atribuição passa a ser a
 * heurística de tempo do ADR 0007 revisto, e muda esta função.
 * @param {Fact} fact
 * @returns {string}
 */
export function agentKeyOf(fact) {
  return fact.agentId ?? MAIN_KEY;
}

/**
 * V5: elo provisório pela fila por tipo. O pedido pendente mais antigo da
 * sessão com o mesmo tipo cru e ainda sem instância (seção 5, passo 2). Pedido
 * já encerrado só entra se for de segundo plano, porque em primeiro plano o
 * Post só chega quando o subagente devolve. Um pedido feito pelo próprio
 * agente nunca é dele: ninguém é filho de si mesmo. Se o V5 for refutado (sem
 * `tool_response.agentId`), este elo passa a ser o definitivo.
 * @param {AgentTable} table
 * @param {Agent} agent
 * @returns {Delegation|null}
 */
export function pickDelegation(table, agent) {
  if (agent.typeKey === null) return null;
  for (const delegation of table.delegations.values()) {
    if (delegation.agentKey !== null || delegation.from === agent.key) continue;
    if (delegation.closed && !delegation.background) continue;
    if (delegation.toTypeKey === agent.typeKey) return delegation;
  }
  return null;
}

/**
 * V5: a instância que o PostToolUse do `Agent` confirma (`tool_response.agentId`,
 * lido pelo normalizador como `linkedAgentId`).
 * @param {ToolPostFact} fact
 * @returns {string|null}
 */
export function linkedAgentOf(fact) {
  const id = fact.linkedAgentId ?? null;
  // O normalizador já recusa `main` como id de agente (T7, ponto 14); aqui é só defesa.
  return id === MAIN_KEY ? null : id;
}

/**
 * V5: lançamento em segundo plano pelo `status: async_launched` do Post do
 * `Agent`. O `run_in_background` do `tool_input` chega como `fact.background`.
 * @param {ToolFact} fact
 * @returns {boolean}
 */
export function isBackgroundLaunch(fact) {
  return fact.kind === 'tool.post' && fact.launch === 'async_launched';
}

/**
 * V13: o agente aparece em `background_tasks` do Stop, casado pelo `id` da
 * tarefa igual ao `agent_id`. Se o V13 for refutado, as tarefas passam a casar
 * por `agentTypeKey` (plano, T7), e muda só esta função.
 * @param {Agent} agent
 * @param {readonly BackgroundTask[]} tasks
 * @returns {boolean}
 */
export function listedInBackground(agent, tasks) {
  return agent.agentId !== null && tasks.some((task) => task.id === agent.agentId);
}

/**
 * V5 e V13: primeiro ou segundo plano. Um agente roda em segundo plano se ele
 * ou alguém acima dele (pelo `parentKey`) foi lançado em segundo plano
 * (`run_in_background` ou `async_launched`, V5) ou aparece em
 * `background_tasks` do Stop (V13). Sem flags confiáveis (V5 refutado), vale
 * só o `background_tasks`.
 * @param {AgentTable} table
 * @param {Agent} agent
 * @param {readonly BackgroundTask[]} tasks
 * @returns {boolean}
 */
export function runsInBackground(table, agent, tasks) {
  /** @type {Agent|undefined} */
  let current = agent;
  for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
    if (current.background || listedInBackground(current, tasks)) return true;
    if (current.parentKey === null || current.parentKey === MAIN_KEY) return false;
    current = table.agents.get(current.parentKey);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Criação e tipo
// ---------------------------------------------------------------------------

/**
 * A sessão principal: papel `orq`, rótulo vazio até aparecer um `agent_type`
 * (sessão iniciada com `--agent`).
 * Começa ociosa: o pedido e as ferramentas dela é que a deixam trabalhando.
 * @param {number} ts
 * @returns {Agent}
 */
export function createMainAgent(ts) {
  return newAgent({ key: MAIN_KEY, agentId: null, agentType: null, typeKey: null, role: 'orq', status: 'idle', ts });
}

/**
 * Subagente criado pelo SubagentStart ou pelo primeiro evento com um
 * `agent_id` novo (seção 8, regra 3). Papel pelo valor cru; sem tipo, `aux`.
 * Começa trabalhando, com a atividade `start` (seção 9).
 * @param {string} agentId
 * @param {Fact} fact
 * @param {unknown} overrides           "roles" do config.json
 * @returns {Agent}
 */
export function createSubagent(agentId, fact, overrides) {
  const agent = newAgent({
    key: agentId,
    agentId,
    agentType: fact.agentType,
    typeKey: fact.agentTypeKey,
    role: resolveRole(fact.agentTypeKey, overrides),
    status: 'working',
    ts: fact.ts,
  });
  agent.label = fact.agentType ?? '';
  agent.activity = { kind: 'start', category: null, tool: null, target: null, detail: null, state: 'running', at: fact.ts };
  return agent;
}

/**
 * @param {{ key: string, agentId: string|null, agentType: string|null, typeKey: string|null, role: RoleId, status: AgentStatus, ts: number }} fields
 * @returns {Agent}
 */
function newAgent({ key, agentId, agentType, typeKey, role, status, ts }) {
  return {
    key,
    agentId,
    agentType,
    typeKey,
    role,
    label: '',
    status,
    finished: false,
    background: false,
    parentKey: null,
    activity: null,
    activities: new Map(),
    openCalls: new Set(),
    outcomes: [],
    delegation: null,
    turnEnded: false,
    revivable: false,
    startedAt: ts,
    lastEventAt: ts,
  };
}

/**
 * Completa o tipo de um agente que já existe, sem nunca apagar o que se sabe.
 * - Sessão principal com `agent_type` (`--agent`): continua `main`/`orq`, e o
 *   tipo vira o rótulo, só como detalhe (seção 5).
 * - Subagente criado sem tipo (`aux`): o primeiro fato com tipo dá o papel.
 * @param {Agent} agent
 * @param {Fact} fact
 * @param {unknown} overrides
 * @returns {boolean}                   true se o tipo cru mudou (o elo pode ser completado)
 */
export function learnType(agent, fact, overrides) {
  if (agent.key === MAIN_KEY) {
    if (fact.agentId === null && fact.agentType !== null) {
      agent.agentType = fact.agentType;
      agent.label = fact.agentType;
    }
    return false;
  }
  if (agent.agentType === null && fact.agentType !== null) {
    agent.agentType = fact.agentType;
    if (agent.delegation === null) agent.label = fact.agentType;
  }
  if (agent.typeKey !== null || fact.agentTypeKey === null) return false;
  agent.typeKey = fact.agentTypeKey;
  agent.role = resolveRole(fact.agentTypeKey, overrides);
  return true;
}

/**
 * Hora do agente: `startedAt` é o menor `ts` visto e `lastEventAt` o maior,
 * para eventos fora de ordem não andarem o relógio para trás.
 * @param {Agent} agent
 * @param {number} ts
 */
export function touchAgent(agent, ts) {
  if (ts < agent.startedAt) agent.startedAt = ts;
  if (ts > agent.lastEventAt) agent.lastEventAt = ts;
}

// ---------------------------------------------------------------------------
// Status (seção 8, regra 4)
// ---------------------------------------------------------------------------

/**
 * Pode voltar a "trabalhando"? Subagente encerrado nunca volta; a sessão
 * principal não volta depois do Stop até o próximo pedido.
 * @param {Agent} agent
 * @returns {boolean}
 */
export function canWork(agent) {
  return !agent.finished && !agent.turnEnded;
}

/** @param {Agent} agent */
export function markWorking(agent) {
  if (canWork(agent)) agent.status = 'working';
}

/**
 * Subagente que terminou: ocioso e na copa.
 * @param {Agent} agent
 * @param {{ revivable?: boolean }} [options]   `revivable`: só no encerramento
 *   inferido pelos 15 min, que um `tool.pre` novo pode desfazer (seção 6)
 */
export function finishAgent(agent, { revivable = false } = {}) {
  agent.status = 'idle';
  agent.finished = true;
  agent.revivable = revivable;
}

/**
 * Volta depois do encerramento inferido pelos 15 min (seção 6, decidido em
 * 19/10/2026): um `tool.pre` com `toolUseId` novo mostra que o subagente está
 * vivo, e ele volta a `working` com `finished: false`, sem evento novo.
 * Depois de SubagentStop, Stop ou SessionEnd, não volta.
 * @param {Agent} agent
 * @returns {boolean}                   true se voltou
 */
export function reviveAgent(agent) {
  if (!agent.finished || !agent.revivable) return false;
  agent.finished = false;
  agent.revivable = false;
  agent.status = 'working';
  return true;
}

/**
 * Trabalhando, sem ferramenta em execução e sem eventos há STALE_AGENT_MS.
 * @param {Agent} agent
 * @param {number} now
 * @returns {boolean}
 */
export function isStale(agent, now) {
  return agent.status === 'working' && agent.openCalls.size === 0 && now - agent.lastEventAt >= STALE_AGENT_MS;
}

// ---------------------------------------------------------------------------
// Delegação → instância (seção 5)
// ---------------------------------------------------------------------------

/**
 * Registra o pedido `Agent` no primeiro evento da chamada (Pre, ou Post e
 * Failure fora de ordem). O papel de quem recebe sai do valor cru.
 * @param {AgentTable} table
 * @param {ToolFact} fact
 * @param {string} from                  agentKey de quem delegou
 * @param {unknown} overrides
 * @returns {Delegation}
 */
export function openDelegation(table, fact, from, overrides) {
  const id = fact.toolUseId ?? `#${++table.internalIds}`;
  /** @type {Delegation} */
  const delegation = {
    id,
    toolUseId: fact.toolUseId,
    from,
    toType: fact.subagentType,
    toTypeKey: fact.subagentTypeKey,
    toRole: resolveRole(fact.subagentTypeKey, overrides),
    description: fact.description,
    background: fact.background === true || isBackgroundLaunch(fact),
    agentKey: null,
    confirmed: false,
    closed: false,
  };
  table.delegations.set(id, delegation);
  if (table.delegations.size > MAX_DELEGATIONS) {
    const oldest = table.delegations.keys().next().value;
    if (oldest !== undefined) table.delegations.delete(oldest);
  }
  return delegation;
}

/**
 * Liga uma instância ainda sem elo: primeiro ao pedido já confirmado para ela
 * (Post do `Agent` que chegou antes), senão ao da fila por tipo (provisório).
 * @param {AgentTable} table
 * @param {Agent} agent
 * @returns {boolean}                   true se ligou
 */
export function linkAgent(table, agent) {
  if (agent.key === MAIN_KEY || agent.delegation !== null) return false;
  const delegation = confirmedFor(table, agent.key) ?? pickDelegation(table, agent);
  if (!delegation) return false;
  delegation.agentKey = agent.key;
  attach(agent, delegation);
  return true;
}

/**
 * Post do `Agent` com `tool_response.agentId` (seção 5, passo 3): confirma o
 * elo e, se o provisório apontava para outra instância, corrige. A instância
 * que perdeu o elo volta para a fila e, no caso de dois pedidos do mesmo tipo
 * em paralelo, fica com o pedido que era da outra: as descrições trocam, e o
 * `parentKey` acompanha.
 * @param {AgentTable} table
 * @param {Delegation} delegation
 * @param {string} agentId
 */
export function confirmDelegation(table, delegation, agentId) {
  if (agentId === delegation.from) return; // ninguém é filho de si mesmo
  if (delegation.agentKey === agentId) {
    delegation.confirmed = true;
    return;
  }
  const previous = delegation.agentKey !== null ? table.agents.get(delegation.agentKey) : undefined;
  const target = table.agents.get(agentId);
  const displaced = target?.delegation ?? null;

  delegation.agentKey = agentId;
  delegation.confirmed = true;
  if (displaced && displaced !== delegation) {
    displaced.agentKey = null;
    displaced.confirmed = false;
  }
  if (target) attach(target, delegation);
  if (previous && previous !== target) {
    detach(previous);
    linkAgent(table, previous);
  }
}

/**
 * Lançamento em segundo plano descoberto no Post (`async_launched`).
 * @param {AgentTable} table
 * @param {Delegation} delegation
 */
export function markBackground(table, delegation) {
  delegation.background = true;
  const agent = delegation.agentKey !== null ? table.agents.get(delegation.agentKey) : undefined;
  if (agent && agent.delegation === delegation) agent.background = true;
}

/**
 * Post ou Failure do `Agent`: a chamada terminou. O pedido sai da memória
 * quando não serve mais para ligar nenhuma instância. Na falha, o pedido ainda
 * sem instância é descartado mesmo em segundo plano, para não se ligar a um
 * SubagentStart posterior (seção 4; T7, ponto 4).
 * @param {AgentTable} table
 * @param {Delegation} delegation
 * @param {{ failed?: boolean }} [options]
 */
export function closeDelegation(table, delegation, { failed = false } = {}) {
  delegation.closed = true;
  const done = delegation.agentKey === null
    ? failed || !delegation.background
    : delegation.confirmed && table.agents.has(delegation.agentKey);
  if (done) table.delegations.delete(delegation.id);
}

/**
 * @param {AgentTable} table
 * @param {string} key
 * @returns {Delegation|null}
 */
function confirmedFor(table, key) {
  for (const delegation of table.delegations.values()) {
    if (delegation.confirmed && delegation.agentKey === key) return delegation;
  }
  return null;
}

/**
 * Rótulo = descrição da delegação, ou o tipo; `parentKey` = quem delegou.
 * @param {Agent} agent
 * @param {Delegation} delegation
 */
function attach(agent, delegation) {
  agent.delegation = delegation;
  agent.label = delegation.description ?? agent.agentType ?? '';
  agent.parentKey = delegation.from;
  agent.background = delegation.background;
}

/** @param {Agent} agent */
function detach(agent) {
  agent.delegation = null;
  agent.label = agent.agentType ?? '';
  agent.parentKey = null;
  agent.background = false;
}

// ---------------------------------------------------------------------------
// Atividade e saúde (seções 6 e 9)
// ---------------------------------------------------------------------------

/**
 * Atividade de uma chamada: `delegate` para Agent e Task (no fato, só elas têm
 * `category` null; seção 2), `tool` para as demais. `at` é o início da
 * chamada: o `ts` do Pre; quando o primeiro evento é o Post ou o Failure,
 * uma estimativa (`ts − durationMs`), que o Pre atrasado corrige
 * (`correctCallStart`).
 * @param {ToolFact} fact
 * @param {Activity['state']} state
 * @returns {Activity}
 */
export function callActivity(fact, state) {
  const duration = fact.kind === 'tool.pre' ? null : fact.durationMs;
  return {
    kind: fact.category === null ? 'delegate' : 'tool',
    category: fact.category,
    tool: fact.tool,
    target: fact.target,
    detail: fact.detail,
    state,
    at: duration === null ? fact.ts : fact.ts - duration,
  };
}

/**
 * Chave da atividade de uma chamada sem `toolUseId` (não casa com Post nem
 * Failure; seção 8).
 * @param {number} ts
 * @returns {string}
 */
export function anonymousCallKey(ts) {
  return `#${ts}`;
}

/**
 * Registra a atividade de uma chamada que começou (ou que já chegou
 * encerrada) e escolhe a atual.
 * @param {Agent} agent
 * @param {string} key                   toolUseId, ou `anonymousCallKey`
 * @param {Activity} activity
 */
export function beginCall(agent, key, activity) {
  agent.activities.set(key, activity);
  if (agent.activities.size > ACTIVITY_WINDOW) {
    const oldest = pickBy(agent.activities, (a, b) => a.at < b.at, (a, b) => a < b);
    if (oldest) agent.activities.delete(oldest[0]);
  }
  pickActivity(agent);
}

/**
 * Fim de uma chamada: a atividade dela passa a `done` ou `failed`.
 * @param {Agent} agent
 * @param {string} key
 * @param {'done'|'failed'} state
 */
export function endCall(agent, key, state) {
  const activity = agent.activities.get(key);
  if (activity && activity.state === 'running') activity.state = state;
}

/**
 * Fim de uma chamada sem `toolUseId`: encerra a mais recente sem id ainda
 * rodando, se houver.
 * @param {Agent} agent
 * @param {'done'|'failed'} state
 */
export function endAnonymousCall(agent, state) {
  /** @type {Map<string, Activity>} */
  const running = new Map([...agent.activities].filter(([key, activity]) => key.startsWith('#') && activity.state === 'running'));
  const latest = pickBy(running, (a, b) => a.at > b.at, (a, b) => a > b);
  if (latest) latest[1].state = state;
}

/**
 * Pre que chega depois do Post da mesma chamada (seção 8, regra 2): não gera
 * evento, mas o `ts` dele é o início real da chamada, que decide qual
 * atividade é a mais recente.
 * @param {Agent} agent
 * @param {string} key
 * @param {number} ts
 */
export function correctCallStart(agent, key, ts) {
  const activity = agent.activities.get(key);
  if (!activity || activity.at === ts) return;
  activity.at = ts;
  pickActivity(agent);
}

/**
 * Atividade atual: a chamada de início mais recente (seção 9; T7, ponto 12),
 * com desempate pela chave, para a ordem de chegada não mudar o resultado.
 * Sem nenhuma chamada, fica a atividade `start` (ou nenhuma).
 * @param {Agent} agent
 */
function pickActivity(agent) {
  const latest = pickBy(agent.activities, (a, b) => a.at > b.at, (a, b) => a > b);
  if (latest) agent.activity = latest[1];
}

/**
 * Entrada que vence pelo critério, com desempate pela chave.
 * @param {Map<string, Activity>} map
 * @param {(a: Activity, b: Activity) => boolean} wins
 * @param {(a: string, b: string) => boolean} tieWins
 * @returns {[string, Activity]|null}
 */
function pickBy(map, wins, tieWins) {
  /** @type {[string, Activity]|null} */
  let best = null;
  for (const entry of map) {
    if (!best || wins(entry[1], best[1]) || (entry[1].at === best[1].at && tieWins(entry[0], best[0]))) best = entry;
  }
  return best;
}

/**
 * Resultado de uma ação para a saúde. A janela guarda as HEALTH_WINDOW ações
 * de maior `ts`, para a ordem de chegada não mudar o resultado.
 * @param {Agent} agent
 * @param {boolean} ok
 * @param {number} ts
 */
export function recordOutcome(agent, ok, ts) {
  agent.outcomes.push({ ts, ok });
  agent.outcomes.sort((a, b) => a.ts - b.ts || Number(a.ok) - Number(b.ok));
  if (agent.outcomes.length > HEALTH_WINDOW) agent.outcomes.splice(0, agent.outcomes.length - HEALTH_WINDOW);
}

// ---------------------------------------------------------------------------
// Saída para o painel
// ---------------------------------------------------------------------------

/**
 * AgentState do contrato (seção 9), com as chaves na ordem do contrato e os
 * valores neutros do recorte (`waitingFor` e `context` null). Nenhum campo
 * interno sai daqui, em especial o tipo cru.
 * @param {Agent} agent
 * @returns {AgentState}
 */
export function toAgentState(agent) {
  let ok = 0;
  for (const outcome of agent.outcomes) if (outcome.ok) ok++;
  return {
    key: agent.key,
    agentId: agent.agentId,
    agentType: agent.agentType,
    role: agent.role,
    label: agent.label,
    status: agent.status,
    finished: agent.finished,
    background: agent.background,
    parentKey: agent.parentKey,
    activity: agent.activity ? { ...agent.activity } : null,
    waitingFor: null,
    health: { ok, total: agent.outcomes.length },
    context: null,
    startedAt: agent.startedAt,
    lastEventAt: agent.lastEventAt,
  };
}
