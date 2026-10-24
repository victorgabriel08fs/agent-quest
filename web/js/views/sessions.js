// @ts-check
// Seletor de sessão (T11a; T13: agrupado por projeto, com status e aprovações
// pendentes de cada sessão).
//
// O seletor é um <select> nativo, fixo no index.html: acessível por teclado e
// sem perder o foco quando a lista muda, porque o elemento nunca é trocado. Os
// grupos são <optgroup> (um por projeto), e o texto de cada opção traz o
// rótulo, o projeto, o status e as aprovações pendentes, sempre por
// textContent (nunca HTML). O caminho do projeto da sessão mostrada vai no
// tooltip do <select> (main.js).
//
// Ordem: projetos pela sessão mais recente de cada um; dentro do projeto, da
// mais recente para a mais antiga (`sessionList`). Sessões sem projeto
// conhecido ficam juntas, com o texto do tema (modelo de eventos, seção 7).

import { plural } from '../themes/helpers.js';

/** @typedef {import('../../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../themes/contract.js').Theme} Theme */

/** Status de cada sessão no seletor (iguais nos dois temas, como o selo de conexão). */
export const SESSION_STATUS_TEXT = Object.freeze({
  active: 'ativa',
  waiting: 'aguardando aprovação',
  idle: 'parada',
  ended: 'encerrada',
});

/** Rótulo do grupo sem projeto quando não há tema (testes antigos). */
const UNKNOWN_PROJECT = 'Projeto desconhecido';

/**
 * @typedef {object} SessionOption
 * @property {string} value      id da sessão
 * @property {string} text       rótulo, projeto, status e aprovações pendentes (texto puro)
 * @property {boolean} selected
 * @property {string} group      chave do projeto ('' sem projeto)
 */

/**
 * @typedef {object} SessionGroup
 * @property {string} key        chave do projeto ('' sem projeto)
 * @property {string} label      nome do projeto (texto puro)
 * @property {SessionOption[]} options
 */

/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/**
 * Texto de uma opção: rótulo, projeto, status e aprovações pendentes.
 * @param {SessionState} session
 * @returns {string}
 */
export function sessionText(session) {
  const pending = num(session.counters?.pendingApprovals);
  const status = Object.hasOwn(SESSION_STATUS_TEXT, session.status)
    ? SESSION_STATUS_TEXT[/** @type {keyof typeof SESSION_STATUS_TEXT} */ (session.status)]
    : '';
  const parts = [session.label || session.id, session.project?.name];
  // "Aguardando aprovação" com a contagem vira só a contagem, sem repetir.
  if (status && !(session.status === 'waiting' && pending > 0)) parts.push(status);
  if (pending > 0) parts.push(`${pending} ${plural(pending, 'aprovação pendente', 'aprovações pendentes')}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * Grupos do seletor, um por projeto, na ordem da lista (`sessionList`).
 * @param {readonly SessionState[]} list
 * @param {string|null} selectedId
 * @param {Theme} [theme]   para o texto de "projeto desconhecido"
 * @returns {SessionGroup[]}
 */
export function sessionGroups(list, selectedId, theme) {
  /** @type {Map<string, SessionGroup & { dir: string }>} */
  const groups = new Map();
  for (const session of list) {
    const key = typeof session.project?.key === 'string' ? session.project.key : '';
    let group = groups.get(key);
    if (!group) {
      const name = key && session.project?.name ? session.project.name : theme?.words.unknownProject ?? UNKNOWN_PROJECT;
      group = { key, label: name, dir: session.project?.dir ?? '', options: [] };
      groups.set(key, group);
    }
    group.options.push({ value: session.id, text: sessionText(session), selected: session.id === selectedId, group: key });
  }
  // Dois projetos com o mesmo nome em pastas diferentes: a pasta desfaz a dúvida.
  // A comparação usa os nomes originais, antes de qualquer grupo ganhar a pasta.
  const all = [...groups.values()];
  const names = all.map((group) => group.label);
  return all.map(({ key, label, dir, options }) => {
    const repeated = names.filter((name) => name === label).length > 1;
    return { key, label: key && dir && repeated ? `${label} (${dir})` : label, options };
  });
}

/**
 * Opções do seletor, na ordem em que aparecem (agrupadas por projeto).
 * @param {readonly SessionState[]} list
 * @param {string|null} selectedId
 * @param {Theme} [theme]
 * @returns {SessionOption[]}
 */
export function sessionOptions(list, selectedId, theme) {
  return sessionGroups(list, selectedId, theme).flatMap((group) => group.options);
}

/**
 * O que o seletor usa de um elemento (o do navegador, ou um falso nos testes).
 * @typedef {object} NodeLike
 * @property {string} [label]
 * @property {string} [value]
 * @property {string|null} [textContent]
 * @property {ArrayLike<NodeLike>} [children]
 * @property {(node: any) => unknown} [appendChild]
 */

/**
 * @typedef {object} SelectLike
 * @property {ArrayLike<NodeLike>} children
 * @property {(node: any) => unknown} appendChild
 * @property {(node: any) => unknown} removeChild
 * @property {string} value
 * @property {{ createElement(tag: 'option'|'optgroup'): any }} ownerDocument
 */

/** Estrutura (grupos e ids) já desenhada em cada seletor. */
const shapes = /** @type {WeakMap<object, string>} */ (new WeakMap());

/**
 * Atualiza o <select> no lugar, sem trocar o elemento: o foco e o que o
 * teclado estiver fazendo continuam valendo. Os grupos e as opções só são
 * refeitos quando a estrutura muda (sessão nova, que saiu ou mudou de lugar);
 * senão, só os textos mudam.
 * @param {SelectLike} select
 * @param {readonly SessionGroup[]} groups
 */
export function syncSessionSelect(select, groups) {
  const shape = JSON.stringify(groups.map((group) => [group.key, group.options.map((option) => option.value)]));
  if (shapes.get(select) !== shape) {
    while (select.children.length > 0) select.removeChild(select.children[0]);
    for (const group of groups) {
      const element = select.ownerDocument.createElement('optgroup');
      element.label = group.label;
      for (const option of group.options) {
        const item = select.ownerDocument.createElement('option');
        item.value = option.value;
        item.textContent = option.text;
        element.appendChild(item);
      }
      select.appendChild(element);
    }
    shapes.set(select, shape);
  } else {
    groups.forEach((group, index) => {
      const element = select.children[index];
      if (element.label !== group.label) element.label = group.label;
      group.options.forEach((option, at) => {
        const item = element.children?.[at];
        if (item && item.textContent !== option.text) item.textContent = option.text;
      });
    });
  }
  const selected = groups.flatMap((group) => group.options).find((option) => option.selected);
  if (selected && select.value !== selected.value) select.value = selected.value;
}
