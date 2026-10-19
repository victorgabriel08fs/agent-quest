// @ts-check
// Nomes dos agentes disponíveis para a equipe (roster): os arquivos `.md` de
// `<projeto>/.claude/agents/` e de `~/.claude/agents/` (modelo de eventos,
// seção 7). Lê só os nomes, nunca o conteúdo.
//
// Fica fora de server/domain/ e fora do caminho do `apply` (T7, ponto 10):
// a ligação (server/pipeline.js) chama `read` para cada pasta em `newProjects`
// e entrega o resultado ao estado por `setAgentNames`.
//
// - Assíncrono, com prazo por pasta (padrão 500 ms): uma letra mapeada para
//   pasta de rede ou uma pasta só na nuvem do OneDrive não trava o servidor, e
//   o prazo cobre esses casos sem precisar detectá-los.
// - No máximo uma listagem em andamento, com as demais pastas numa fila
//   (ajuste de 19/10/2026). O prazo para de esperar, mas não cancela o
//   `readdir`, que segura uma das threads do libuv (4 por padrão, usadas
//   também para servir arquivos); com várias pastas de rede mortas listadas
//   juntas, o servidor travaria.
// - O `read` resolve dentro do prazo, com `[]` para a pasta que não respondeu
//   a tempo. Quando essa listagem termina depois, o resultado vai para o cache
//   e `onLate(projectDir, names)` entrega os nomes completos do projeto.
// - Caminho de rede (UNC) e caminho relativo não são lidos.
// - Cache por pasta: cada pasta é listada uma vez por execução do servidor.
//   Arquivo novo só aparece depois de reiniciar, o que é aceito na v1.
// - Os `.md` são filtrados antes do limite de MAX_AGENT_FILES nomes.
// - Nunca rejeita: erro de listagem vira lista vazia.

import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

/** Quantos nomes de agente entram por pasta. */
export const MAX_AGENT_FILES = 200;

/** Prazo da leitura de cada pasta. */
export const READ_TIMEOUT_MS = 500;

/** Quantas pastas já listadas ficam no cache; acima disso, sai a mais antiga. */
export const MAX_CACHED_FOLDERS = 256;

/**
 * @typedef {object} ReaderTimers
 * @property {(run: () => void, ms: number) => any} setTimeout
 * @property {(handle: any) => void} clearTimeout
 */

/**
 * @typedef {object} AgentNamesReader
 * @property {(projectDir: string) => Promise<string[]>} read
 *   nomes (sem `.md`) do projeto e da pasta pessoal, dentro do prazo; nunca rejeita
 */

/**
 * Uma pasta conhecida pelo leitor.
 * @typedef {object} FolderEntry
 * @property {string[]|null} names       null enquanto a listagem não terminou
 * @property {Set<(names: string[]) => void>} waiters   `read` esperando, dentro do prazo
 * @property {Set<string>} late          projetos que receberam `[]` desta pasta por prazo vencido
 */

/**
 * Nomes dos arquivos de uma pasta (sem filtro). A listagem padrão.
 * @param {string} folder                pasta `.claude/agents` já montada
 * @returns {Promise<string[]>}
 */
export async function listAgentFiles(folder) {
  /** @type {{ name: string, isFile(): boolean }[]} */
  const entries = await readdir(folder, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

/**
 * Só os `.md`, sem a extensão, e depois o limite de MAX_AGENT_FILES.
 * @param {unknown} entries
 * @returns {string[]}
 */
export function agentNamesFrom(entries) {
  if (!Array.isArray(entries)) return [];
  /** @type {string[]} */
  const names = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.toLowerCase().endsWith('.md') || entry.length <= 3) continue;
    names.push(entry.slice(0, -3));
    if (names.length >= MAX_AGENT_FILES) break;
  }
  return names;
}

/**
 * Leitor com prazo por pasta, uma listagem por vez e cache.
 * @param {{
 *   homeDir?: string|null,
 *   list?: (folder: string) => Promise<unknown>|unknown,
 *   timeoutMs?: number,
 *   timers?: ReaderTimers,
 *   onLate?: (projectDir: string, names: string[]) => void,
 * }} [options]
 *   `homeDir`: pasta pessoal (padrão: os.homedir()). `list`: listagem de uma
 *   pasta (os testes trocam). `timers`: temporizadores do prazo (os testes
 *   trocam). `onLate`: chamado quando uma pasta que perdeu o prazo de um `read`
 *   termina de ser listada, com os nomes completos daquele projeto.
 * @returns {AgentNamesReader}
 */
export function createAgentNamesReader({
  homeDir = defaultHomeDir(),
  list = listAgentFiles,
  timeoutMs = READ_TIMEOUT_MS,
  timers = { setTimeout, clearTimeout },
  onLate = () => {},
} = {}) {
  /** @type {Map<string, FolderEntry>} */
  const folders = new Map();
  /** @type {string[]} */
  const queue = [];
  let listing = false;

  /**
   * Nomes de uma pasta para o projeto, dentro do prazo.
   * @param {unknown} base
   * @param {string} projectDir
   * @returns {Promise<string[]>}
   */
  function namesIn(base, projectDir) {
    const folder = agentsFolder(base);
    if (folder === null) return Promise.resolve([]);
    let entry = folders.get(folder);
    if (!entry) {
      entry = { names: null, waiters: new Set(), late: new Set() };
      folders.set(folder, entry);
      queue.push(folder);
      evictOld();
      pump();
    }
    if (entry.names !== null) return Promise.resolve(entry.names);
    const pending = entry;
    return new Promise((resolve) => {
      /** @param {string[]} names */
      const waiter = (names) => {
        timers.clearTimeout(timer);
        resolve(names);
      };
      const timer = timers.setTimeout(() => {
        pending.waiters.delete(waiter);
        pending.late.add(projectDir);
        resolve([]);
      }, timeoutMs);
      // Com o relógio real, o prazo sozinho não segura o processo.
      timer?.unref?.();
      pending.waiters.add(waiter);
    });
  }

  /** Lista a próxima pasta da fila, se nenhuma estiver em andamento. */
  function pump() {
    if (listing || queue.length === 0) return;
    const folder = /** @type {string} */ (queue.shift());
    listing = true;
    Promise.resolve()
      .then(() => list(folder))
      .then(agentNamesFrom, () => [])
      .then((names) => finish(folder, names))
      .finally(() => {
        listing = false;
        pump();
      });
  }

  /**
   * @param {string} folder
   * @param {string[]} names
   */
  function finish(folder, names) {
    const entry = folders.get(folder);
    if (!entry) return;
    entry.names = names;
    for (const waiter of [...entry.waiters]) waiter(names);
    entry.waiters.clear();
    const late = [...entry.late];
    entry.late.clear();
    for (const projectDir of late) {
      // Só com as duas pastas do projeto listadas: a que faltar ainda chama
      // onLate quando terminar, com os nomes completos.
      if (!listed(projectDir) || !listed(homeDir)) continue;
      try {
        onLate(projectDir, [...cached(projectDir), ...cached(homeDir)]);
      } catch {
        // quem recebe trata os próprios erros; o leitor segue
      }
    }
  }

  /**
   * A pasta de agentes da base já foi listada (ou não é lida)?
   * @param {unknown} base
   * @returns {boolean}
   */
  function listed(base) {
    const folder = agentsFolder(base);
    return folder === null || (folders.get(folder)?.names ?? null) !== null;
  }

  /**
   * Nomes já listados de uma base (projeto ou pasta pessoal); `[]` se ainda não.
   * @param {unknown} base
   * @returns {string[]}
   */
  function cached(base) {
    const folder = agentsFolder(base);
    return (folder !== null && folders.get(folder)?.names) || [];
  }

  /** Tira do cache as pastas mais antigas já listadas, acima do limite. */
  function evictOld() {
    for (const [folder, entry] of folders) {
      if (folders.size <= MAX_CACHED_FOLDERS) return;
      if (entry.names !== null) folders.delete(folder);
    }
  }

  return {
    async read(projectDir) {
      const [project, home] = await Promise.all([namesIn(projectDir, projectDir), namesIn(homeDir, projectDir)]);
      return [...project, ...home];
    },
  };
}

/**
 * `<base>/.claude/agents`, ou null se a base não for um caminho local absoluto.
 * @param {unknown} base
 * @returns {string|null}
 */
function agentsFolder(base) {
  if (typeof base !== 'string' || base.trim() === '') return null;
  if (/^[\\/]{2}/.test(base)) return null;
  if (!path.isAbsolute(base)) return null;
  return path.join(base, '.claude', 'agents');
}

/** @returns {string|null} */
function defaultHomeDir() {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}
