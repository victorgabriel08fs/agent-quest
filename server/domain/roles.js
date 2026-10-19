// @ts-check
// Papel do agente a partir do `agent_type` (ADR 0007; modelo de eventos, seção 5).
//
// - Nomes do time: arquiteto → arq, dev-backend e dev-frontend → dev,
//   tester → tes, documentador → doc.
// - `plugin:agente`: tenta o nome inteiro e depois a parte depois do último `:`.
// - Sobrescritas do config.json (`"roles": { "backend": "dev" }`) acrescentam
//   ou trocam entradas, valendo antes da tabela do time.
// - Qualquer outro tipo (general-purpose, Explore, Plan, agentes de outros
//   projetos) é convidado: aux.
//
// A sessão principal é `orq` pela chave ('main'), nunca pelo agent_type: por isso
// nenhuma sobrescrita pode dar o papel orq a um subagente.

import { ROLES } from '../../shared/contract.js';

/** @typedef {import('../../shared/contract.js').RoleId} RoleId */

/** Tabela do ADR 0007. */
export const TEAM_ROLES = Object.freeze({
  arquiteto: 'arq',
  'dev-backend': 'dev',
  'dev-frontend': 'dev',
  tester: 'tes',
  documentador: 'doc',
});

/**
 * Papéis que uma sobrescrita pode atribuir (todos menos orq).
 * @type {Set<string>}
 */
const ASSIGNABLE = new Set(ROLES.filter((role) => role !== 'orq'));

/**
 * @param {unknown} agentType            agent_type do payload
 * @param {unknown} [overrides]          "roles" do config.json; entradas inválidas são ignoradas
 * @returns {RoleId}
 */
export function resolveRole(agentType, overrides = {}) {
  if (typeof agentType !== 'string' || agentType === '') return 'aux';
  const names = [agentType];
  const colon = agentType.lastIndexOf(':');
  if (colon >= 0 && colon < agentType.length - 1) names.push(agentType.slice(colon + 1));

  for (const name of names) {
    const override = overrideFor(overrides, name);
    if (override) return override;
    if (Object.hasOwn(TEAM_ROLES, name)) return /** @type {RoleId} */ (TEAM_ROLES[/** @type {keyof typeof TEAM_ROLES} */ (name)]);
  }
  return 'aux';
}

/**
 * @param {unknown} overrides
 * @param {string} name
 * @returns {RoleId|null}
 */
function overrideFor(overrides, name) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
  if (!Object.hasOwn(overrides, name)) return null;
  const role = /** @type {Record<string, unknown>} */ (overrides)[name];
  return typeof role === 'string' && ASSIGNABLE.has(role) ? /** @type {RoleId} */ (role) : null;
}
