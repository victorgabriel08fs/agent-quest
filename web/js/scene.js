// @ts-check
// Cena estática (T12a; o T12b acrescenta animações e os estados do T8).
// Portada da cena do mockup (mockups/painel.js e painel.css): as seis salas do
// tema, um token por instância, balão com a ação atual e a copa (taverna).
//
// Regras (modelo de eventos, seção 6, "Voltou para a copa"; ADR 0007):
// - a sessão principal fica sempre na sala do orquestrador (hq), mesmo ociosa;
// - subagente encerrado vai para a copa (sala 'idle');
// - os demais ficam na sala do papel; convidados (aux) na sala do orquestrador;
// - até 3 tokens por sala e "+N" para o resto;
// - encerradas antes do ticket atual saem da cena (como no cartão da equipe).
//
// `sceneLayout` é a função pura de sala e vaga. `renderScene` gera o HTML,
// com todo texto dinâmico escapado. A posição de cada vaga é do CSS
// (web/css/scene.css): a sala é um container (`container: room / size`), e o
// arranjo muda conforme o tamanho real dela, sem medir nada por JS. Com um
// token, o visual do mockup (balão acima do retrato); com dois ou três, uma
// linha por token (retrato e balão ao lado), para os balões não cobrirem
// retratos, outros balões nem o nome da sala; em sala estreita, só os
// retratos. (A CSP não impediria posicionar por CSSOM; a escolha é por
// simplicidade e por deixar o layout responsivo sem JS.)

import { ROLES } from '../../shared/contract.js';
import { createHelpers, esc } from './themes/helpers.js';
import { ROOM_IDS } from './themes/contract.js';

/** @typedef {import('../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../shared/contract.js').AgentState} AgentState */
/** @typedef {import('../../shared/contract.js').RoleId} RoleId */
/** @typedef {import('./themes/contract.js').Theme} Theme */
/** @typedef {import('./themes/contract.js').RoomId} RoomId */
/** @typedef {import('./themes/contract.js').ThemeHelpers} ThemeHelpers */

/** Sala de trabalho de cada papel (convidado fica com o orquestrador). */
export const ROOM_OF_ROLE = Object.freeze(/** @type {Record<RoleId, RoomId>} */ ({
  orq: 'hq',
  arq: 'design',
  dev: 'dev',
  tes: 'test',
  doc: 'docs',
  aux: 'hq',
}));

/** Papel dono de cada sala, para a cor (a copa usa a cor própria). */
export const ROOM_OWNER = Object.freeze(/** @type {Record<RoomId, RoleId|null>} */ ({
  hq: 'orq',
  design: 'arq',
  dev: 'dev',
  idle: null,
  docs: 'doc',
  test: 'tes',
}));

/** Tokens desenhados por sala; o resto vira "+N". */
export const MAX_TOKENS_PER_ROOM = 3;

/**
 * @typedef {object} TokenPlacement
 * @property {AgentState} agent
 * @property {RoomId} room
 * @property {number} slot      posição na sala (0, 1 ou 2), na ordem de prioridade
 * @property {number} count     tokens desenhados na sala (1 a 3); com a sala, define o arranjo
 */

/**
 * @typedef {object} RoomLayout
 * @property {RoomId} id
 * @property {AgentState[]} members      todos os agentes da sala, na ordem de prioridade
 * @property {TokenPlacement[]} tokens   no máximo MAX_TOKENS_PER_ROOM
 * @property {number} overflow           tokens da sala que não aparecem ("+N")
 * @property {boolean} active            algum agente da sala trabalhando ou aguardando
 * @property {SceneArrangement} layout   arranjo dos tokens (o CSS ajusta ao tamanho da sala)
 */

/**
 * Arranjo dos tokens na sala: 'single' (um token, balão acima do retrato),
 * 'rows' (dois ou três, uma linha por token com o balão ao lado) ou 'lanes'
 * (copa: retratos em fila, sem balão).
 * @typedef {'single'|'rows'|'lanes'} SceneArrangement
 */

/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** @param {string} role @returns {role is RoleId} */
const isRole = (role) => /** @type {readonly string[]} */ (ROLES).includes(role);

/**
 * Sala de um agente.
 * @param {AgentState} agent
 * @returns {RoomId}
 */
export function roomOf(agent) {
  if (agent.key === 'main') return 'hq';
  if (agent.finished) return 'idle';
  return isRole(agent.role) ? ROOM_OF_ROLE[agent.role] : 'hq';
}

/** Prioridade de quem ganha as vagas numa sala de trabalho. */
const STATUS_RANK = { waiting: 0, working: 1, idle: 2 };

/**
 * Sala e posição de cada instância da sessão (função pura).
 * @param {SessionState|null} session
 * @returns {RoomLayout[]}   uma entrada por sala, na ordem de ROOM_IDS
 */
export function sceneLayout(session) {
  /** @type {Map<RoomId, AgentState[]>} */
  const byRoom = new Map(ROOM_IDS.map((id) => [id, []]));
  const questStart = session?.quest ? num(session.quest.startedAt) : null;
  for (const agent of session?.agents ?? []) {
    if (agent.finished && agent.key !== 'main' && questStart !== null && num(agent.lastEventAt) < questStart) continue;
    byRoom.get(roomOf(agent))?.push(agent);
  }

  return ROOM_IDS.map((id) => {
    const agents = byRoom.get(id) ?? [];
    const ordered = id === 'idle'
      ? [...agents].sort((a, b) => num(b.lastEventAt) - num(a.lastEventAt))
      : [...agents].sort((a, b) =>
        Number(b.key === 'main') - Number(a.key === 'main')
        || (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3)
        || num(a.startedAt) - num(b.startedAt));
    const shown = ordered.slice(0, MAX_TOKENS_PER_ROOM);
    return {
      id,
      members: ordered,
      tokens: shown.map((agent, slot) => ({ agent, room: id, slot, count: shown.length })),
      layout: id === 'idle' ? 'lanes' : shown.length > 1 ? 'rows' : 'single',
      overflow: ordered.length - shown.length,
      active: agents.some((agent) => !agent.finished && (agent.status === 'working' || agent.status === 'waiting')),
    };
  });
}

/**
 * Conteúdo da cena: o caminho decorativo e as salas com os tokens. Sem sessão,
 * as salas vazias.
 * @param {{ session: SessionState|null, theme: Theme }} params
 * @returns {string}
 */
export function renderScene({ session, theme }) {
  const h = createHelpers(theme, session?.agents ?? []);
  const layout = sceneLayout(session);
  return `<div class="loop" aria-hidden="true"></div>` +
    `<div class="rooms" role="img" aria-label="${esc(sceneSummary(layout, theme))}">` +
    layout.map((room) => roomHTML(room, theme, h)).join('') +
    `</div>`;
}

/**
 * Resumo da cena para leitores de tela (o cartão da equipe tem o detalhe).
 * @param {RoomLayout[]} layout
 * @param {Theme} theme
 * @returns {string}
 */
export function sceneSummary(layout, theme) {
  let working = 0;
  let waiting = 0;
  let resting = 0;
  let total = 0;
  for (const room of layout) {
    for (const agent of room.members) {
      total++;
      if (room.id === 'idle') resting++;
      else if (agent.status === 'waiting') waiting++;
      else if (agent.status === 'working') working++;
    }
  }
  if (total === 0) return `Cena: ${theme.name}, sem agentes`;
  return `Cena: ${working} trabalhando, ${waiting} aguardando aprovação, ${resting} em ${theme.rooms.idle.name}`;
}

/**
 * @param {RoomLayout} room
 * @param {Theme} theme
 * @param {ThemeHelpers} h
 * @returns {string}
 */
function roomHTML(room, theme, h) {
  const words = theme.rooms[room.id];
  const owner = ROOM_OWNER[room.id];
  const more = room.overflow > 0
    ? `<span class="room-more" title="${room.overflow} ${room.overflow === 1 ? 'agente a mais' : 'agentes a mais'} nesta sala">+${room.overflow}</span>`
    : '';
  return `<div class="room${room.active ? ' active' : ''}" data-room="${room.id}"${owner ? ` data-agent="${owner}"` : ''} data-count="${room.tokens.length}" data-layout="${room.layout}">` +
    `<div class="room-label"><span class="ri">${esc(words.icon)}</span>${esc(words.name)}</div>` +
    // Com "+N", o selo ocupa o canto da primeira decoração.
    (more ? '' : `<span class="deco d1">${esc(words.deco[0])}</span>`) +
    `<span class="deco d2">${esc(words.deco[1])}</span>` +
    room.tokens.map((token) => tokenHTML(token, theme, h)).join('') +
    more +
    `</div>`;
}

/**
 * Um token: balão com a ação atual (só trabalhando ou aguardando, como no
 * mockup), retrato do papel e nome curto. Convidado mostra o agent_type.
 * @param {TokenPlacement} token
 * @param {Theme} theme
 * @param {ThemeHelpers} h
 * @returns {string}
 */
function tokenHTML({ agent, slot }, theme, h) {
  const role = h.roleOf(agent.key);
  const words = theme.roles[role];
  const name = role === 'aux' ? agent.agentType || words.short : words.short;
  const status = agent.finished ? 'idle' : agent.status;
  const title = [role === 'aux' ? agent.agentType || words.name : words.name, agent.label].filter(Boolean).join(' · ');
  const bubble = status === 'working' || status === 'waiting'
    ? `<div class="bubble"><span class="bubble-text">${esc(theme.actionText(agent, h))}</span></div>`
    : '';
  return `<div class="token ${esc(status)}" data-key="${esc(agent.key)}" data-agent="${esc(role)}" data-slot="${slot}" title="${esc(title)}">` +
    bubble +
    `<div class="tok-av">${esc(words.icon)}</div>` +
    `<div class="tok-name">${esc(name)}</div>` +
    `</div>`;
}
