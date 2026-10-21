// @ts-check
// Aguardando aprovação (modelo de eventos, seções 4 e 6, "Aguardando
// aprovação"; ADR 0008; T8 do plano).
//
// - PermissionRequest: o agente que pediu fica `waiting`, com `waitingFor`, e
//   a sessão fica `waiting` enquanto houver pedido pendente
//   (`counters.pendingApprovals`).
// - Resolução: Post ou Failure da chamada → `approved` (`by: user`);
//   PermissionDenied → `denied` (`by: auto`); outra ação do mesmo agente, fim
//   do agente, fim do turno, novo pedido ou fim da sessão → `unknown`
//   (`by: inferred`).
// - Notification `permission_prompt` sem pedido pendente na sessão marca o
//   agente (o `main`, sem `agent_id`) como `waiting`, para o aviso aparecer
//   mesmo se o PermissionRequest se perder.
//
// Este módulo muda o modelo em memória e emite pelo `emit` recebido; não
// importa o index.js.
//
// Adiantado antes do G0b (plano, T8): o que depende de veredito fica nas
// funções da seção "Itens a confirmar no T0": `requesterOf` (V2) e
// `outcomeForCallEnd` (V4).

import { MAIN_KEY, canWork } from './agents.js';

/**
 * @typedef {import('../../../shared/contract.js').ToolCategory} ToolCategory
 * @typedef {import('../../../shared/contract.js').EventKind} EventKind
 * @typedef {import('./agents.js').Agent} Agent
 * @typedef {import('./sessions.js').CallRecord} CallRecord
 * @typedef {(agentKey: string|null, kind: EventKind, data: Record<string, unknown>, ts: number) => void} Emit
 */

/**
 * Pedido de aprovação pendente.
 * @typedef {object} Approval
 * @property {string} agentKey
 * @property {string|null} toolUseId     a chamada que espera, quando se sabe
 * @property {string} tool
 * @property {ToolCategory} category
 * @property {string|null} target
 * @property {string|null} inputHash
 * @property {number} ts
 */

/**
 * O que este módulo usa da sessão.
 * @typedef {object} ApprovalTable
 * @property {Map<string, Agent>} agents
 * @property {Map<string, CallRecord>} calls
 * @property {Approval[]} approvals
 */

/**
 * @typedef {{ outcome: 'approved'|'denied'|'unknown', by: 'user'|'auto'|'inferred' }} Resolution
 */

/** Resolução inferida (outra ação, fim do agente ou do turno, novo pedido). */
export const INFERRED = Object.freeze(/** @type {Resolution} */ ({ outcome: 'unknown', by: 'inferred' }));

/** PermissionDenied (só no modo automático). */
export const DENIED = Object.freeze(/** @type {Resolution} */ ({ outcome: 'denied', by: 'auto' }));

// ---------------------------------------------------------------------------
// Itens a confirmar no T0 (G0b)
// ---------------------------------------------------------------------------

/**
 * V2: quem pediu a aprovação. O PermissionRequest não traz `tool_use_id`.
 * Em ordem (seção 6):
 * 1. o `agent_id` do próprio payload, se vier;
 * 2. a chamada aberta mais recente da sessão com o mesmo `tool_name` e o mesmo
 *    `inputHash` (o PreToolUse dispara antes da checagem de permissão);
 * 3. senão, o `main`.
 * Se o V2 for refutado (sem `agent_id` nos pedidos de subagentes), fica a
 * heurística do item 2.
 * @param {ApprovalTable} table
 * @param {{ agentId: string|null, tool: string|null, inputHash: string|null }} request
 * @returns {{ agentKey: string, toolUseId: string|null }}
 */
export function requesterOf(table, { agentId, tool, inputHash }) {
  const call = matchingCall(table, tool, inputHash, agentId);
  if (agentId !== null) return { agentKey: agentId, toolUseId: call?.toolUseId ?? null };
  if (call) return { agentKey: call.agentKey, toolUseId: call.toolUseId };
  return { agentKey: MAIN_KEY, toolUseId: null };
}

/**
 * V4: desfecho quando a chamada que esperava aprovação termina. A
 * documentação diz que uma permissão negada dispara só o PreToolUse, sem Post
 * nem Failure; então Post e Failure significam que a chamada rodou, aprovada.
 * Se o V4 for refutado (a negação gera um Failure), um Failure com a mensagem
 * de negação passa a ser `denied`, e muda esta função.
 * @param {import('../normalize.js').ToolPostFact|import('../normalize.js').ToolFailFact} _fact
 * @returns {Resolution}
 */
export function outcomeForCallEnd(_fact) {
  return { outcome: 'approved', by: 'user' };
}

// ---------------------------------------------------------------------------
// Pedido e resolução
// ---------------------------------------------------------------------------

/**
 * Registra um pedido pendente, deixa o agente `waiting` e emite
 * `permission.requested`.
 * @param {ApprovalTable} table
 * @param {Agent} agent
 * @param {Omit<Approval, 'agentKey'>} request
 * @param {Emit} emit
 */
export function requestApproval(table, agent, request, emit) {
  /** @type {Approval} */
  const approval = { ...request, agentKey: agent.key };
  table.approvals.push(approval);
  refreshAgent(table, agent);
  emit(agent.key, 'permission.requested', { tool: approval.tool, category: approval.category, target: approval.target }, request.ts);
}

/**
 * Resolve os pedidos pendentes que `match` aceitar, emitindo
 * `permission.resolved` para cada um, e devolve o agente ao status certo.
 * @param {ApprovalTable} table
 * @param {(approval: Approval) => boolean} match
 * @param {Resolution} resolution
 * @param {number} ts
 * @param {Emit} emit
 * @returns {number}                     quantos foram resolvidos
 */
export function resolveApprovals(table, match, resolution, ts, emit) {
  const resolved = table.approvals.filter(match);
  if (resolved.length === 0) return 0;
  table.approvals = table.approvals.filter((approval) => !resolved.includes(approval));
  for (const approval of resolved) {
    emit(approval.agentKey, 'permission.resolved', { outcome: resolution.outcome, by: resolution.by }, ts);
    const agent = table.agents.get(approval.agentKey);
    if (agent) refreshAgent(table, agent);
  }
  return resolved.length;
}

/**
 * Primeiro evento de uma chamada nova de um agente com pedido pendente
 * (seção 6): o pedido sem chamada conhecida que casa com ela (mesmo nome e
 * mesmo `inputHash`, quando o Pre chega depois do PermissionRequest) passa a
 * esperar por ela; os demais, "outra ação do mesmo agente", viram `unknown`.
 * Uma chamada com `ts` anterior ao pedido (chamada em paralelo que chegou
 * atrasada) não é "outra ação" depois dele e não o resolve.
 * @param {ApprovalTable} table
 * @param {Agent} agent
 * @param {{ toolUseId: string|null, tool: string|null, inputHash: string|null }} call
 * @param {number} ts
 * @param {Emit} emit
 */
export function noteNewCall(table, agent, { toolUseId, tool, inputHash }, ts, emit) {
  /** @type {Approval|null} */
  let linked = null;
  for (const approval of table.approvals) {
    if (approval.agentKey !== agent.key || approval.toolUseId !== null) continue;
    if (toolUseId !== null && approval.inputHash !== null && approval.inputHash === inputHash && approval.tool === (tool ?? '')) {
      approval.toolUseId = toolUseId;
      linked = approval;
      break;
    }
  }
  resolveApprovals(
    table,
    (approval) => approval !== linked && approval.agentKey === agent.key && approval.ts <= ts
      && (approval.toolUseId === null || approval.toolUseId !== toolUseId),
    INFERRED,
    ts,
    emit,
  );
}

/**
 * Status e `waitingFor` do agente a partir dos pedidos pendentes dele: com
 * pedido, `waiting` e o mais recente em `waitingFor`; sem, `working` (se pode
 * trabalhar) ou `idle`.
 * @param {ApprovalTable} table
 * @param {Agent} agent
 */
export function refreshAgent(table, agent) {
  const mine = table.approvals.filter((approval) => approval.agentKey === agent.key);
  agent.pending = mine.length;
  if (mine.length > 0) {
    const latest = mine[mine.length - 1];
    agent.waitingFor = { tool: latest.tool, category: latest.category, target: latest.target };
    agent.status = 'waiting';
    return;
  }
  agent.waitingFor = null;
  if (agent.status === 'waiting') agent.status = canWork(agent) ? 'working' : 'idle';
}

/**
 * A chamada aberta mais recente de um agente (para o aviso `permission_prompt`
 * sem PermissionRequest).
 * @param {ApprovalTable} table
 * @param {string} agentKey
 * @returns {(CallRecord & { toolUseId: string })|null}
 */
export function latestOpenCall(table, agentKey) {
  /** @type {(CallRecord & { toolUseId: string })|null} */
  let best = null;
  for (const [toolUseId, call] of table.calls) {
    if (!call.open || call.delegation || call.agentKey !== agentKey) continue;
    if (!best || call.ts >= best.ts) best = { ...call, toolUseId };
  }
  return best;
}

/**
 * A chamada aberta mais recente com o mesmo nome e o mesmo `inputHash` (e do
 * agente dado, se houver).
 * @param {ApprovalTable} table
 * @param {string|null} tool
 * @param {string|null} inputHash
 * @param {string|null} agentKey
 * @returns {(CallRecord & { toolUseId: string })|null}
 */
function matchingCall(table, tool, inputHash, agentKey) {
  if (inputHash === null) return null;
  /** @type {(CallRecord & { toolUseId: string })|null} */
  let best = null;
  for (const [toolUseId, call] of table.calls) {
    if (!call.open || call.delegation || call.inputHash !== inputHash || call.tool !== tool) continue;
    if (agentKey !== null && call.agentKey !== agentKey) continue;
    if (!best || call.ts >= best.ts) best = { ...call, toolUseId };
  }
  return best;
}
