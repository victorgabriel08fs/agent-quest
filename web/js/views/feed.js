// @ts-check
// Feed de atividade: uma linha de `theme.feedLine` por evento de `FEED_KINDS`,
// mais recentes no topo. Comandos, caminhos e títulos aparecem como chegam do
// servidor, já redigidos (decisão 3 do plano), e passam pelos helpers de escape.
//
// T11b: filtros e animação de entrada, como no mockup (mockups/painel.js).
// - Filtro por papel ('role:<papel>') ou por instância ('agent:<chave>'); ''
//   mostra tudo. Os chips do cartão seguem o mockup ("Todos" e um por papel do
//   cartão da equipe); o filtro por instância é escolhido no cartão da equipe
//   (views/party.js). O filtro só esconde linhas (atributo hidden), nunca muda
//   o estado.
// - Papéis e agentes de cada linha seguem o `agentsOf` do mockup: a delegação
//   conta para quem delegou e para o papel chamado; a etapa concluída, para o
//   papel dono dela; linhas de sessão e de ticket só aparecem em "Todos".
// - A lista é atualizada no lugar (`syncFeedList`): linhas novas entram no topo,
//   e só elas recebem a classe da animação; trocar de sessão redesenha a lista
//   sem animação, e trocar de tema refaz o texto das linhas sem animação. Com
//   prefers-reduced-motion, o CSS não anima nada.
//
// T14: enquanto o filtro de instância está ligado, um chip com o rótulo dela
// aparece apertado e se desfaz no próprio chip (`data-toggle`) ou em "Todos".
// No modo discreto, as linhas usam as frases só de categoria do tema, e a
// sessão chega sem os textos livres (web/js/discreet.js).

import { ROLES } from '../../../shared/contract.js';
import { maskSession } from '../discreet.js';
import { PHASE_OWNER, feedView, rosterRoles, teamView } from '../selectors.js';
import { createHelpers, esc, formatClock, plural } from '../themes/helpers.js';

/** @typedef {import('../../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../../shared/contract.js').CanonicalEvent} CanonicalEvent */
/** @typedef {import('../../../shared/contract.js').RoleId} RoleId */
/** @typedef {import('../themes/contract.js').Theme} Theme */
/** @typedef {import('../themes/contract.js').ThemeHelpers} ThemeHelpers */

/** Sem filtro: todas as linhas. */
export const ALL = '';
const ROLE_PREFIX = 'role:';
const AGENT_PREFIX = 'agent:';

/** Classe das linhas que acabaram de entrar (animação do mockup, no CSS). */
export const NEW_ENTRY_CLASS = 'is-new';

/** Rótulo do grupo de chips, como no mockup. */
export const FILTERS_LABEL = 'Filtrar por agente';

/**
 * Filtro por papel.
 * @param {string} role
 * @returns {string}
 */
export const roleFilter = (role) => `${ROLE_PREFIX}${role}`;

/**
 * Filtro por instância (chave do agente: 'main' ou o agent_id).
 * @param {string} key
 * @returns {string}
 */
export const agentFilter = (key) => `${AGENT_PREFIX}${key}`;

/**
 * @typedef {{ kind: 'all' } | { kind: 'role', role: string } | { kind: 'agent', key: string }} FilterSpec
 */

/**
 * Lê o valor de um filtro. Valor desconhecido vale como "Todos".
 * @param {unknown} value
 * @returns {FilterSpec}
 */
export function parseFilter(value) {
  if (typeof value === 'string') {
    if (value.startsWith(ROLE_PREFIX) && value.length > ROLE_PREFIX.length) return { kind: 'role', role: value.slice(ROLE_PREFIX.length) };
    if (value.startsWith(AGENT_PREFIX) && value.length > AGENT_PREFIX.length) return { kind: 'agent', key: value.slice(AGENT_PREFIX.length) };
  }
  return { kind: 'all' };
}

/** @param {unknown} value @returns {value is RoleId} */
const isRole = (value) => typeof value === 'string' && /** @type {readonly string[]} */ (ROLES).includes(value);

/**
 * Nome de uma instância no chip do filtro: o rótulo (descrição da delegação),
 * senão o `agent_type`, senão o nome curto do papel no tema. No modo discreto
 * o rótulo já chega vazio.
 * @param {import('../../../shared/contract.js').AgentState} agent
 * @param {Theme} theme
 * @returns {string}
 */
export function instanceName(agent, theme) {
  const role = isRole(agent.role) ? agent.role : 'aux';
  for (const value of [agent.label, agent.agentType]) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return theme.roles[role].short;
}

/**
 * Filtro em vigor para a sessão mostrada. Vale enquanto o controle dele existir
 * (como a escolha de sessão do T11a): o papel precisa estar entre os chips (os
 * papéis do cartão da equipe), e a instância, entre as que o cartão mostra.
 * Senão, volta para "Todos".
 * @param {SessionState|null} session
 * @param {unknown} value
 * @returns {string}
 */
export function resolveFilter(session, value) {
  if (!session) return ALL;
  const spec = parseFilter(value);
  if (spec.kind === 'role') return rosterRoles(session).includes(/** @type {RoleId} */ (spec.role)) ? roleFilter(spec.role) : ALL;
  if (spec.kind === 'agent') {
    const shown = teamView(session).some((group) => group.instances.some((agent) => agent.key === spec.key));
    return shown ? agentFilter(spec.key) : ALL;
  }
  return ALL;
}

/**
 * Próximo filtro depois de um clique. Os chips escolhem o filtro (como no
 * mockup); os cartões da equipe alternam: clicar de novo no mesmo volta para
 * "Todos".
 * @param {string} current
 * @param {string} value
 * @param {'set'|'toggle'} mode
 * @returns {string}
 */
export function nextFilter(current, value, mode) {
  const chosen = parseFilter(value).kind === 'all' ? ALL : value;
  return mode === 'toggle' && chosen === current ? ALL : chosen;
}

/**
 * Papéis e agentes de uma linha, para o filtro (o `agentsOf` do mockup).
 * @param {CanonicalEvent} event
 * @param {ThemeHelpers} h
 * @returns {{ roles: RoleId[], keys: string[] }}
 */
export function feedSubjects(event, h) {
  const d = /** @type {Record<string, any>} */ (event.data ?? {});
  const key = typeof event.agentKey === 'string' && event.agentKey !== '' ? event.agentKey : null;
  switch (event.kind) {
    case 'session.started':
    case 'session.ended':
    case 'quest.started':
    case 'quest.finished':
      return { roles: [], keys: [] };
    case 'quest.phase': {
      const owner = typeof d.phase === 'string' && Object.hasOwn(PHASE_OWNER, d.phase)
        ? PHASE_OWNER[/** @type {keyof typeof PHASE_OWNER} */ (d.phase)]
        : null;
      return { roles: owner ? [owner] : [], keys: key ? [key] : [] };
    }
    case 'agent.delegated': {
      const roles = [h.roleOf(key)];
      if (isRole(d.toRole) && !roles.includes(d.toRole)) roles.push(d.toRole);
      return { roles, keys: key ? [key] : [] };
    }
    default:
      return { roles: [h.roleOf(key)], keys: key ? [key] : [] };
  }
}

/**
 * @typedef {object} FeedEntry
 * @property {string} id      chave da linha (id do evento, único na lista)
 * @property {string} html    <li> da linha (sem o atributo hidden)
 * @property {RoleId[]} roles
 * @property {string[]} keys
 */

/**
 * Diz se a linha aparece com o filtro.
 * @param {{ roles: readonly string[], keys: readonly string[] }} entry
 * @param {string} filter
 * @returns {boolean}
 */
export function entryMatches(entry, filter) {
  const spec = parseFilter(filter);
  if (spec.kind === 'role') return entry.roles.includes(spec.role);
  if (spec.kind === 'agent') return entry.keys.includes(spec.key);
  return true;
}

/**
 * Tom da linha (fundo colorido), igual nos dois temas.
 * @param {CanonicalEvent} event
 * @returns {''|'bad'|'good'|'warn'}
 */
export function feedTone(event) {
  const d = /** @type {Record<string, any>} */ (event.data ?? {});
  switch (event.kind) {
    case 'tool.failed': return d.interrupted ? 'warn' : 'bad';
    case 'test.finished': return d.ok ? 'good' : 'bad';
    case 'quest.phase': return 'good';
    case 'quest.finished': return d.outcome === 'done' ? 'good' : d.outcome === 'failed' ? 'bad' : '';
    case 'permission.requested': return 'warn';
    default: return '';
  }
}

/**
 * Ícone de sistema das linhas de sessão, ticket e etapa; null para as linhas
 * de agente, que mostram o retrato do papel.
 * @param {CanonicalEvent} event
 * @param {Theme} theme
 * @returns {string|null}
 */
export function systemIcon(event, theme) {
  const d = /** @type {Record<string, any>} */ (event.data ?? {});
  switch (event.kind) {
    case 'session.started':
    case 'session.ended': return theme.icons.session;
    case 'quest.started': return theme.icons.questStarted;
    case 'quest.phase': return theme.icons.phaseDone;
    case 'quest.finished':
      return d.outcome === 'done' ? theme.icons.questDone : d.outcome === 'failed' ? theme.icons.questFailed : theme.icons.questInterrupted;
    default: return null;
  }
}

/**
 * Linhas do feed da sessão, mais recentes primeiro, com os papéis e agentes de
 * cada uma. Eventos sem frase no tema ficam de fora.
 * @param {SessionState} session
 * @param {Theme} theme
 * @param {boolean} [discreet]   modo discreto (T14)
 * @returns {FeedEntry[]}
 */
export function feedEntries(session, theme, discreet = false) {
  const shown = discreet ? maskSession(session) : session;
  const h = createHelpers(theme, shown.agents ?? [], { discreet });
  session = shown;
  /** @type {FeedEntry[]} */
  const entries = [];
  const used = new Set();
  for (const event of feedView(session)) {
    const line = theme.feedLine(event, h);
    if (!line) continue;
    // A chave precisa ser única na lista: com dados adulterados (id ausente ou
    // repetido), ganha um sufixo.
    let id = typeof event.id === 'string' && event.id !== '' ? event.id : `seq:${String(event.seq)}`;
    if (used.has(id)) id = `${id}#${entries.length}`;
    used.add(id);
    entries.push({ id, html: entryHTML(event, line, theme, h), ...feedSubjects(event, h) });
  }
  return entries;
}

/**
 * @typedef {object} FeedModel
 * @property {string} context      sessão mostrada ('' sem sessão); outra sessão redesenha a lista sem animação
 * @property {string} filter       filtro aplicado
 * @property {string} head         HTML do cabeçalho (título e contagem)
 * @property {string} filters      HTML dos chips ('' sem sessão)
 * @property {string} empty        HTML da mensagem de feed vazio ('' quando alguma linha aparece)
 * @property {FeedEntry[]} entries mais recentes primeiro
 * @property {number} visible      linhas que aparecem com o filtro
 */

/**
 * Modelo do cartão de atividade: cabeçalho, chips, mensagem de vazio e linhas.
 * O filtro já deve vir validado (`resolveFilter`).
 * @param {{ session: SessionState|null, theme: Theme, filter?: string, discreet?: boolean }} params
 * @returns {FeedModel}
 */
export function feedModel({ session, theme, filter = ALL, discreet = false }) {
  const title = `<h2 id="feed-title">${esc(theme.words.feed)}</h2>`;
  const noFeed = esc(theme.words.noFeed);
  if (!session) {
    return { context: '', filter: ALL, head: title, filters: '', empty: noFeed, entries: [], visible: 0 };
  }
  const applied = parseFilter(filter).kind === 'all' ? ALL : filter;
  const entries = feedEntries(session, theme, discreet);
  const visible = applied === ALL ? entries.length : entries.filter((entry) => entryMatches(entry, applied)).length;
  const total = entries.length;
  let count = '';
  if (total > 0) {
    const shown = applied === ALL ? `${total}` : `${visible} de ${total}`;
    count = `<span class="muted">${shown} ${plural(total, 'evento', 'eventos')}</span>`;
  }
  return {
    context: String(session.id),
    filter: applied,
    head: `${title}${count}`,
    filters: filtersHTML(discreet ? maskSession(session) : session, theme, applied),
    empty: visible === 0 ? noFeed : '',
    entries,
    visible,
  };
}

/**
 * Chips de filtro, como no mockup: "Todos" e um por papel do cartão da equipe,
 * com o retrato do papel no tema. Com o filtro de instância ligado (T14), mais
 * um chip apertado com o nome dela, que se desfaz no próprio chip.
 * @param {SessionState} session
 * @param {Theme} theme
 * @param {string} filter
 * @returns {string}
 */
function filtersHTML(session, theme, filter) {
  const chips = [`<button type="button" class="chip" data-filter="" aria-pressed="${filter === ALL}">Todos</button>`];
  for (const role of rosterRoles(session)) {
    const value = roleFilter(role);
    const words = theme.roles[role];
    chips.push(`<button type="button" class="chip chip-ag" data-filter="${esc(value)}" data-agent="${esc(role)}" aria-pressed="${filter === value}" ` +
      `title="${esc(words.name)}" aria-label="${esc(`Só ${words.name}`)}">${esc(words.icon)}</button>`);
  }
  const spec = parseFilter(filter);
  const agent = spec.kind === 'agent' ? (session.agents ?? []).find((item) => item.key === spec.key) : undefined;
  if (agent) {
    const role = isRole(agent.role) ? agent.role : 'aux';
    const name = instanceName(agent, theme);
    chips.push(`<button type="button" class="chip chip-inst" data-filter="${esc(filter)}" data-toggle="" data-agent="${esc(role)}" aria-pressed="true" ` +
      `title="${esc(`Só ${name}. Clique de novo para mostrar todos`)}"><span aria-hidden="true">${esc(theme.roles[role].icon)}</span>` +
      `<span class="chip-l">${esc(name)}</span></button>`);
  }
  return chips.join('');
}

/**
 * Conteúdo completo do cartão de atividade (cabeçalho, chips e lista), com as
 * linhas fora do filtro escondidas. O painel usa as partes do `feedModel` e
 * atualiza a lista no lugar; esta forma serve para os testes e para quem
 * precisar do cartão inteiro de uma vez.
 * @param {{ session: SessionState|null, theme: Theme, filter?: string, discreet?: boolean }} params
 * @returns {string}
 */
export function renderFeed({ session, theme, filter = ALL, discreet = false }) {
  const model = feedModel({ session, theme, filter, discreet });
  const filters = model.filters ? `<div class="filters" role="group" aria-label="${esc(FILTERS_LABEL)}">${model.filters}</div>` : '';
  const empty = model.empty ? `<p class="card-empty">${model.empty}</p>` : '';
  const list = model.entries.length === 0
    ? ''
    : `<ol class="entries">${model.entries.map((entry) => (entryMatches(entry, model.filter) ? entry.html : hide(entry.html))).join('')}</ol>`;
  return `<div class="card-head">${model.head}</div>${filters}${empty}${list}`;
}

/**
 * Acrescenta `hidden` à tag de abertura de uma linha.
 * @param {string} html
 * @returns {string}
 */
const hide = (html) => html.replace(/^<li\b([^>]*)>/, '<li$1 hidden>');

/**
 * @param {CanonicalEvent} event
 * @param {string} line   HTML seguro do tema
 * @param {Theme} theme
 * @param {ThemeHelpers} h
 * @returns {string}
 */
function entryHTML(event, line, theme, h) {
  const tone = feedTone(event);
  const sys = systemIcon(event, theme);
  let avatar;
  if (sys) {
    avatar = `<span class="e-av sys" aria-hidden="true">${esc(sys)}</span>`;
  } else {
    const role = h.roleOf(event.agentKey);
    avatar = `<span class="e-av" data-agent="${esc(role)}" aria-hidden="true">${esc(theme.roles[role].icon)}</span>`;
  }
  // Número finito pode estar fora do intervalo de datas (±8,64e15 ms), e aí
  // toISOString() lança: a linha sai sem horário, e o feed continua.
  const ts = Number(event.ts);
  const date = new Date(ts);
  const time = Number.isFinite(date.getTime())
    ? `<time datetime="${date.toISOString()}">${formatClock(ts)}</time>`
    : '';
  return `<li class="entry${tone ? ` ${tone}` : ''}" data-id="${esc(event.id)}" data-kind="${esc(event.kind)}">` +
    `${avatar}<div class="e-body"><div class="e-text">${line}</div>${time}</div></li>`;
}

// ---------------------------------------------------------------------------
// Lista no lugar (navegador)
// ---------------------------------------------------------------------------

/**
 * O que `syncFeedList` usa de uma linha (o <li> do navegador, ou um falso nos testes).
 * @typedef {object} EntryNode
 * @property {boolean} hidden
 * @property {{ add(name: string): void, remove(name: string): void, contains(name: string): boolean }} classList
 * @property {(type: string, listener: () => void, options?: { once?: boolean }) => void} [addEventListener]
 */

/**
 * O que `syncFeedList` usa da lista (a <ol> do navegador, ou uma falsa).
 * @typedef {object} EntryList
 * @property {ArrayLike<EntryNode>} children
 * @property {(node: EntryNode, reference: EntryNode|null) => unknown} insertBefore
 * @property {(node: EntryNode) => unknown} removeChild
 * @property {(node: EntryNode, old: EntryNode) => unknown} replaceChild
 */

/**
 * @typedef {object} ListMemory
 * @property {string} context
 * @property {string} filter
 * @property {Map<string, { node: EntryNode, html: string }>} nodes
 */

/** O que cada lista mostra, para a próxima atualização. */
const memory = /** @type {WeakMap<EntryList, ListMemory>} */ (new WeakMap());

/**
 * @typedef {object} SyncResult
 * @property {boolean} rebuilt    a lista foi refeita (outra sessão), sem animação
 * @property {number} added       linhas novas
 * @property {number} animated    linhas novas com a animação de entrada
 * @property {number} replaced    linhas que mudaram de texto (tema, nome do agente), sem animação
 * @property {number} removed     linhas que saíram (limite de 200, outra execução do servidor)
 */

/**
 * Atualiza a lista do feed no lugar, como o `addLog` do mockup:
 * - linhas que continuam não são recriadas (a rolagem e a animação em curso
 *   ficam como estão);
 * - linhas novas acima de todas as que continuam (ou numa lista que estava
 *   vazia) entram com a classe NEW_ENTRY_CLASS, se aparecem com o filtro; a
 *   classe sai no fim da animação e quando o filtro muda, para a linha não
 *   animar de novo ao reaparecer;
 * - linhas novas no meio da lista (por exemplo, depois de buscar /api/state)
 *   entram sem animação;
 * - linha cujo HTML mudou (troca de tema, papel do agente conhecido depois) é
 *   trocada sem animação;
 * - outra sessão (`context`) refaz a lista toda, sem animação;
 * - o filtro só liga e desliga o atributo hidden.
 * @param {EntryList} list
 * @param {Pick<FeedModel, 'context'|'filter'|'entries'>} model
 * @param {(html: string) => EntryNode} create   cria o <li> a partir do HTML da view
 * @returns {SyncResult}
 */
export function syncFeedList(list, { context, filter, entries }, create) {
  const previous = memory.get(list);
  const same = previous !== undefined && previous.context === context;
  const filterChanged = previous !== undefined && previous.filter !== filter;
  /** @type {SyncResult} */
  const result = { rebuilt: !same, added: 0, animated: 0, replaced: 0, removed: 0 };

  /** @type {Map<string, { node: EntryNode, html: string }>} */
  const nodes = same ? previous.nodes : new Map();
  if (!same) {
    while (list.children.length > 0) {
      list.removeChild(list.children[0]);
      result.removed++;
    }
  }

  const wanted = new Set(entries.map((entry) => entry.id));
  for (const [id, record] of nodes) {
    if (wanted.has(id)) continue;
    list.removeChild(record.node);
    nodes.delete(id);
    result.removed++;
  }

  // Linhas novas acima da primeira que continua são as que acabaram de chegar.
  const firstKept = entries.findIndex((entry) => nodes.has(entry.id));
  entries.forEach((entry, index) => {
    const visible = entryMatches(entry, filter);
    let record = nodes.get(entry.id);
    if (record && record.html !== entry.html) {
      const node = create(entry.html);
      list.replaceChild(node, record.node);
      record = { node, html: entry.html };
      nodes.set(entry.id, record);
      result.replaced++;
    } else if (record && filterChanged) {
      record.node.classList.remove(NEW_ENTRY_CLASS);
    }
    if (!record) {
      const node = create(entry.html);
      record = { node, html: entry.html };
      nodes.set(entry.id, record);
      result.added++;
      if (same && visible && (firstKept === -1 || index < firstKept)) {
        node.classList.add(NEW_ENTRY_CLASS);
        node.addEventListener?.('animationend', () => node.classList.remove(NEW_ENTRY_CLASS), { once: true });
        result.animated++;
      }
    }
    const at = list.children[index] ?? null;
    if (at !== record.node) list.insertBefore(record.node, at);
    if (record.node.hidden !== !visible) record.node.hidden = !visible;
  });

  memory.set(list, { context, filter, nodes });
  return result;
}
