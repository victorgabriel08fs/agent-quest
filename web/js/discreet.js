// @ts-check
// Modo discreto (T14; ADR 0006; plano, decisão 3): para compartilhar a tela,
// o painel troca alvo, detalhe, títulos e erros por textos só de categoria.
// Desligado por padrão; quem observa liga pelo botão ou pela tecla D, e a
// escolha fica no localStorage.
//
// O que fica escondido são os textos livres que o servidor só corta e redige
// (modelo de eventos, seção 10), porque a redação é heurística e "o modo
// discreto cobre a tela compartilhada":
// - `target` e `detail` das ferramentas (caminho, comando, padrão de busca,
//   host, skill, servidor MCP) e o `target` dos pedidos de aprovação;
// - a descrição das delegações e o rótulo das instâncias, que vem dela;
// - o título do ticket (primeira linha do pedido) e o rótulo da sessão, que
//   vem do título;
// - o erro do ticket e das ferramentas (primeira linha do erro, que costuma
//   trazer caminho ou comando);
// - a pasta do projeto (caminho completo). O nome do projeto (última parte da
//   pasta) continua, para identificar a sessão no seletor.
//
// Ficam: papéis, tipos de agente, nomes de ferramenta, categorias, contagens,
// horários, status e o motivo do fim da sessão.
//
// Duas camadas, para nada vazar se uma falhar:
// 1. `maskSession` tira esses textos do estado antes de qualquer view ou tema
//    (função pura, com cache por objeto);
// 2. os temas recebem `h.discreet` e usam frases só de categoria
//    ("Rodando um comando", "Editando um arquivo").

/** @typedef {import('../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../shared/contract.js').AgentState} AgentState */
/** @typedef {import('../../shared/contract.js').CanonicalEvent} CanonicalEvent */

/** Chave do localStorage. */
export const DISCREET_STORAGE_KEY = 'agent-quest-discreet';

/** Caracteres do id no rótulo neutro da sessão (o mesmo padrão do servidor, `Sessão a1b2c3`). */
export const LABEL_ID_CHARS = 6;

/** Campos de texto livre dos eventos que o modo discreto tira (seção 10). */
export const HIDDEN_EVENT_FIELDS = Object.freeze(['target', 'detail', 'description', 'title', 'error', 'label']);

/**
 * Lê a preferência guardada: só o valor '1' liga (padrão desligado).
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function parseDiscreet(text) {
  return text === '1';
}

/**
 * Texto para guardar a preferência.
 * @param {boolean} on
 * @returns {string}
 */
export function serializeDiscreet(on) {
  return on ? '1' : '0';
}

/**
 * Rótulo neutro de uma sessão, sem o título do pedido.
 * @param {unknown} id
 * @returns {string}
 */
export function neutralLabel(id) {
  const text = typeof id === 'string' ? id : '';
  return text ? `Sessão ${Array.from(text).slice(0, LABEL_ID_CHARS).join('')}` : 'Sessão';
}

/**
 * Dados de um evento sem os textos livres (os campos viram null).
 * @param {unknown} data
 * @returns {Record<string, any>}
 */
export function maskEventData(data) {
  const source = data && typeof data === 'object' ? /** @type {Record<string, any>} */ (data) : {};
  /** @type {Record<string, any>} */
  const masked = { ...source };
  for (const field of HIDDEN_EVENT_FIELDS) {
    if (Object.hasOwn(masked, field)) masked[field] = null;
  }
  return masked;
}

/**
 * Evento sem os textos livres.
 * @param {CanonicalEvent} event
 * @returns {CanonicalEvent}
 */
export function maskEvent(event) {
  if (!event || typeof event !== 'object') return event;
  return { ...event, data: maskEventData(event.data) };
}

/**
 * Agente sem os textos livres: o rótulo das instâncias (descrição da
 * delegação) e o alvo e o detalhe da atividade e do pedido de aprovação. O
 * rótulo da sessão principal é o `agent_type` (seção 9) e fica.
 * @param {AgentState} agent
 * @returns {AgentState}
 */
export function maskAgent(agent) {
  if (!agent || typeof agent !== 'object') return agent;
  const label = agent.key === 'main' ? agent.label : '';
  const activity = agent.activity && typeof agent.activity === 'object'
    ? { ...agent.activity, target: null, detail: null }
    : agent.activity;
  const waitingFor = agent.waitingFor && typeof agent.waitingFor === 'object'
    ? { ...agent.waitingFor, target: null }
    : agent.waitingFor;
  return { ...agent, label, activity, waitingFor };
}

/** Sessões já mascaradas (o resultado de `maskSession` é ele mesmo mascarado). */
const masked = /** @type {WeakSet<object>} */ (new WeakSet());
/** Cache: o mesmo objeto de sessão dá o mesmo resultado (o store troca o objeto a cada update). */
const cache = /** @type {WeakMap<object, SessionState>} */ (new WeakMap());

/**
 * Sessão para o modo discreto: rótulo neutro, sem pasta do projeto, título e
 * erro do ticket, rótulos das instâncias e textos livres dos eventos do feed.
 * Pura; não altera a sessão recebida.
 * @param {SessionState} session
 * @returns {SessionState}
 */
export function maskSession(session) {
  if (!session || typeof session !== 'object') return session;
  if (masked.has(session)) return session;
  const cached = cache.get(session);
  if (cached) return cached;
  const project = session.project && typeof session.project === 'object'
    ? { ...session.project, dir: '' }
    : session.project;
  const quest = session.quest && typeof session.quest === 'object'
    ? { ...session.quest, title: '', error: session.quest.error ? '' : session.quest.error }
    : session.quest;
  /** @type {SessionState} */
  const result = {
    ...session,
    label: neutralLabel(session.id),
    project,
    quest,
    agents: Array.isArray(session.agents) ? session.agents.map(maskAgent) : session.agents,
  };
  if (Array.isArray(session.feed)) result.feed = session.feed.map(maskEvent);
  masked.add(result);
  cache.set(session, result);
  return result;
}

/**
 * Diz se uma sessão já passou por `maskSession`.
 * @param {unknown} session
 * @returns {boolean}
 */
export function isMasked(session) {
  return typeof session === 'object' && session !== null && masked.has(session);
}
