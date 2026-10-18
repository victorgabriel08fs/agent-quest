// @ts-check
// Seletor simples de sessão (T11a, primeira versão; o T13 evolui este módulo
// com agrupamento por projeto, status, "seguir atividade" e localStorage).
//
// O seletor é um <select> nativo, fixo no index.html: acessível por teclado e
// sem perder o foco quando a lista muda, porque só as opções são atualizadas,
// por textContent (nunca HTML). Cada opção traz o rótulo e o nome do projeto;
// o caminho do projeto da sessão mostrada vai no tooltip do <select> (main.js).

/** @typedef {import('../../../shared/contract.js').SessionState} SessionState */

/**
 * @typedef {object} SessionOption
 * @property {string} value      id da sessão
 * @property {string} text       rótulo e nome do projeto (texto puro)
 * @property {boolean} selected
 */

/**
 * Opções do seletor, na ordem da lista (`sessionList`).
 * @param {readonly SessionState[]} list
 * @param {string|null} selectedId
 * @returns {SessionOption[]}
 */
export function sessionOptions(list, selectedId) {
  return list.map((session) => {
    const parts = [session.label || session.id, session.project?.name].filter(Boolean);
    if (session.status === 'ended') parts.push('encerrada');
    return { value: session.id, text: parts.join(' · '), selected: session.id === selectedId };
  });
}

/**
 * O que o seletor usa de um <select> (o do navegador, ou um falso nos testes).
 * @typedef {object} SelectLike
 * @property {{ length: number, [index: number]: { value: string, textContent: string|null } }} options
 * @property {string} value
 * @property {(index: number) => void} remove
 * @property {(option: any) => void} add
 * @property {{ createElement(tag: 'option'): any }} ownerDocument
 */

/**
 * Atualiza as opções do <select> no lugar, sem recriar o elemento: o foco e o
 * que o teclado estiver fazendo continuam valendo.
 * @param {SelectLike} select
 * @param {readonly SessionOption[]} options
 */
export function syncSessionSelect(select, options) {
  while (select.options.length > options.length) select.remove(select.options.length - 1);
  while (select.options.length < options.length) select.add(select.ownerDocument.createElement('option'));
  options.forEach((option, index) => {
    const element = select.options[index];
    if (element.value !== option.value) element.value = option.value;
    if (element.textContent !== option.text) element.textContent = option.text;
  });
  const selected = options.find((option) => option.selected);
  if (selected && select.value !== selected.value) select.value = selected.value;
}
