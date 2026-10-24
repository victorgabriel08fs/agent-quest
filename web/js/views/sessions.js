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
//
// T14:
// - modo discreto: as sessões chegam sem o rótulo (que vem do título do
//   pedido) e sem a pasta do projeto (web/js/discreet.js);
// - sessão fixada que sumiu (observação do tester do T13): o seletor ganha uma
//   primeira opção, desabilitada e escolhida, que avisa que a fixada sumiu e diz
//   qual sessão está na tela. Assim, escolher a sessão que já aparece dispara
//   `change` e passa a fixá-la;
// - lista nativa aberta (observação do tester do T13): com a lista do <select>
//   aberta, o `pointerup` não chega à página. `nextListOpen` acompanha se a
//   lista está aberta, e o main.js não refaz as opções enquanto ela estiver.

import { maskSession } from '../discreet.js';
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
 * @param {{ discreet?: boolean }} [options]   discreet: modo discreto (T14)
 * @returns {SessionGroup[]}
 */
export function sessionGroups(list, selectedId, theme, { discreet = false } = {}) {
  /** @type {Map<string, SessionGroup & { dir: string }>} */
  const groups = new Map();
  for (const session of discreet ? list.map(maskSession) : list) {
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
  // Sem a pasta (modo discreto), um número de ordem.
  const all = [...groups.values()];
  const names = all.map((group) => group.label);
  return all.map(({ key, label, dir, options }, index) => {
    const same = names.filter((name) => name === label).length;
    if (!key || same < 2) return { key, label, options };
    const order = names.slice(0, index + 1).filter((name) => name === label).length;
    return { key, label: dir ? `${label} (${dir})` : `${label} (${order})`, options };
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
 * @property {boolean} [disabled]
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

/**
 * Texto da primeira opção quando a sessão fixada sumiu: avisa e diz qual
 * sessão está na tela (texto de controle, igual nos dois temas).
 * @param {SessionState|null} shown   sessão mostrada (já mascarada no modo discreto)
 * @returns {string}
 */
export function pinnedMissingText(shown) {
  return shown ? `Sessão fixada indisponível · mostrando ${sessionText(shown)}` : 'Sessão fixada indisponível';
}

/**
 * Lista nativa do <select> aberta ou fechada, depois de um evento (Windows e
 * Chromium): o clique no seletor abre e fecha; F4, Alt+seta e Espaço abrem e
 * fecham; Enter, Esc e Tab fecham; `change`, perda de foco e clique fora
 * fecham. Setas com a lista fechada trocam a sessão direto (`change`).
 * @param {boolean} open
 * @param {{ type: 'pointerdown'|'keydown'|'change'|'blur'|'outside', key?: string, altKey?: boolean }} event
 * @returns {boolean}
 */
export function nextListOpen(open, { type, key = '', altKey = false }) {
  if (type === 'pointerdown') return !open;
  if (type === 'change' || type === 'blur' || type === 'outside') return false;
  if (type !== 'keydown') return open;
  if (key === 'F4' || (altKey && (key === 'ArrowDown' || key === 'ArrowUp')) || key === ' ') return !open;
  if (key === 'Enter' || key === 'Escape' || key === 'Tab') return false;
  return open;
}

/** Estrutura (grupos e ids) já desenhada em cada seletor. */
const shapes = /** @type {WeakMap<object, string>} */ (new WeakMap());

/**
 * Atualiza o <select> no lugar, sem trocar o elemento: o foco e o que o
 * teclado estiver fazendo continuam valendo. Os grupos e as opções só são
 * refeitos quando a estrutura muda (sessão nova, que saiu ou mudou de lugar);
 * senão, só os textos mudam.
 *
 * Com `placeholder` (sessão fixada que sumiu, T14), a primeira opção, sem
 * valor e desabilitada, fica escolhida: qualquer sessão escolhida na lista,
 * inclusive a que já aparece, dispara `change`.
 * @param {SelectLike} select
 * @param {readonly SessionGroup[]} groups
 * @param {{ placeholder?: string|null }} [options]
 */
export function syncSessionSelect(select, groups, { placeholder = null } = {}) {
  const hasPlaceholder = typeof placeholder === 'string' && placeholder !== '';
  const shape = JSON.stringify([hasPlaceholder, groups.map((group) => [group.key, group.options.map((option) => option.value)])]);
  const offset = hasPlaceholder ? 1 : 0;
  if (shapes.get(select) !== shape) {
    while (select.children.length > 0) select.removeChild(select.children[0]);
    if (hasPlaceholder) {
      const item = select.ownerDocument.createElement('option');
      item.value = '';
      item.disabled = true;
      item.textContent = placeholder;
      select.appendChild(item);
    }
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
    const first = select.children[0];
    if (hasPlaceholder && first && first.textContent !== placeholder) first.textContent = placeholder;
    groups.forEach((group, index) => {
      const element = select.children[index + offset];
      if (element.label !== group.label) element.label = group.label;
      group.options.forEach((option, at) => {
        const item = element.children?.[at];
        if (item && item.textContent !== option.text) item.textContent = option.text;
      });
    });
  }
  if (hasPlaceholder) {
    if (select.value !== '') select.value = '';
    return;
  }
  const selected = groups.flatMap((group) => group.options).find((option) => option.selected);
  if (selected && select.value !== selected.value) select.value = selected.value;
}
