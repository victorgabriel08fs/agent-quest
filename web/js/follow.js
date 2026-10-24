// @ts-check
// "Seguir atividade" (T13; modelo de eventos, seção 7): qual sessão o painel
// mostra. Função pura, com o relógio como parâmetro (ADR 0010).
//
// - Modo padrão: seguir. A sessão mostrada troca para a mais ativa quando a
//   atual está parada há FOLLOW_IDLE_MS e outra está ativa, no máximo uma vez a
//   cada FOLLOW_MIN_SWITCH_MS.
// - "Parada" = sem evento há 30 s (`lastEventAt`) e sem aprovação pendente: uma
//   sessão esperando a aprovação do usuário (status `waiting`) não é deixada
//   para trás. "Ativa" = status `active` ou `waiting`, com evento mais recente
//   que o último da atual. Entre várias, a de evento mais recente.
// - Escolher uma sessão no seletor fixa a escolha e desliga o seguir. Fixada,
//   ela vale enquanto existir; se sumir, o painel mostra a mais recente e volta
//   para a fixada quando ela reaparecer.
// - A preferência (seguir ou a sessão fixada) fica no localStorage.

/** @typedef {import('../../shared/contract.js').SessionState} SessionState */

/** Parada há quanto tempo, para trocar de sessão. */
export const FOLLOW_IDLE_MS = 30_000;
/** Intervalo mínimo entre duas trocas automáticas. */
export const FOLLOW_MIN_SWITCH_MS = 10_000;
/** Chave do localStorage. */
export const FOLLOW_STORAGE_KEY = 'agent-quest-session';

/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Preferência de quem observa.
 * @typedef {object} FollowPreference
 * @property {boolean} follow            seguir atividade (padrão)
 * @property {string|null} pinnedId      sessão fixada (quando não segue)
 */

/** @type {FollowPreference} */
export const DEFAULT_PREFERENCE = Object.freeze({ follow: true, pinnedId: null });

/**
 * Lê a preferência guardada. Valor ausente ou adulterado vale o padrão.
 * @param {string|null|undefined} text
 * @returns {FollowPreference}
 */
export function parsePreference(text) {
  if (typeof text !== 'string' || text === '') return { ...DEFAULT_PREFERENCE };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCE };
    const pinnedId = typeof value.pinnedId === 'string' && value.pinnedId !== '' && value.pinnedId.length <= 200 ? value.pinnedId : null;
    const follow = value.follow === false && pinnedId !== null ? false : true;
    return { follow, pinnedId: follow ? null : pinnedId };
  } catch {
    return { ...DEFAULT_PREFERENCE };
  }
}

/**
 * Texto para guardar a preferência.
 * @param {FollowPreference} preference
 * @returns {string}
 */
export function serializePreference(preference) {
  return JSON.stringify(preference.follow ? { follow: true } : { follow: false, pinnedId: preference.pinnedId });
}

/**
 * @typedef {object} FollowInput
 * @property {readonly SessionState[]} list     sessões, da mais recente para a mais antiga (`sessionList`)
 * @property {FollowPreference} preference
 * @property {string|null} currentId            sessão mostrada agora
 * @property {number|null} lastSwitchAt         hora da última troca automática
 * @property {number} now
 */

/**
 * @typedef {object} FollowChoice
 * @property {string|null} id                   sessão a mostrar
 * @property {boolean} switched                 troca automática (conta para o intervalo mínimo)
 */

/**
 * Sessão a mostrar.
 * @param {FollowInput} input
 * @returns {FollowChoice}
 */
export function chooseSession({ list, preference, currentId, lastSwitchAt, now }) {
  const has = (/** @type {string|null} */ id) => id !== null && list.some((session) => session.id === id);
  const mostRecent = list[0]?.id ?? null;

  if (!preference.follow) {
    // Fixada: a escolha vale enquanto existir; senão, a atual, ou a mais recente.
    if (has(preference.pinnedId)) return { id: preference.pinnedId, switched: false };
    return { id: has(currentId) ? currentId : mostRecent, switched: false };
  }

  const current = list.find((session) => session.id === currentId);
  if (!current) return { id: mostRecent, switched: false };
  if (lastSwitchAt !== null && now - lastSwitchAt < FOLLOW_MIN_SWITCH_MS) return { id: current.id, switched: false };
  if (!isIdle(current, now)) return { id: current.id, switched: false };

  const target = list
    .filter((session) => session.id !== current.id && isActive(session) && num(session.lastEventAt) > num(current.lastEventAt))
    .sort((a, b) => num(b.lastEventAt) - num(a.lastEventAt))[0];
  return target ? { id: target.id, switched: true } : { id: current.id, switched: false };
}

/**
 * Parada: sem evento há FOLLOW_IDLE_MS e sem aprovação pendente.
 * @param {SessionState} session
 * @param {number} now
 */
export function isIdle(session, now) {
  if (session.status === 'waiting' || num(session.counters?.pendingApprovals) > 0) return false;
  return now - num(session.lastEventAt) >= FOLLOW_IDLE_MS;
}

/**
 * Ativa: com agente trabalhando, evento recente ou aprovação pendente (status do servidor).
 * @param {SessionState} session
 */
export function isActive(session) {
  return session.status === 'active' || session.status === 'waiting';
}
