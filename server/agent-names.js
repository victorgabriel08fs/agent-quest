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
// - Uma listagem por vez, com as demais pastas numa fila. O prazo para de
//   esperar, mas não cancela o `readdir`, que segura uma das threads do libuv
//   (4 por padrão, usadas também para servir arquivos e gravar o runtime.json).
// - A pasta pessoal tem prioridade: `~/.claude/agents` é listada logo que o
//   leitor é criado, antes de qualquer pasta de projeto.
// - Pasta que nunca responde (decidido em 19/10/2026): a listagem que passa de
//   LOST_AFTER_MS é dada como perdida, a pasta fica morta (`[]` até reiniciar,
//   sem nova tentativa) e a fila anda. Somando a em andamento e as perdidas,
//   ficam no máximo MAX_UNFINISHED_LISTINGS listagens não terminadas; no teto,
//   nenhuma nova começa, e as pastas na fila recebem `[]` no prazo normal até
//   uma perdida terminar.
// - O `read` resolve dentro do prazo, com `[]` para a pasta que não respondeu
//   a tempo. Uma listagem atrasada ou perdida que termina depois vai para o
//   cache (e a pasta deixa de estar morta), e `onLate(projectDir, names)`
//   entrega os nomes completos de cada projeto que ficou sem eles.
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

/** Listagem que passa disto é dada como perdida, e a pasta fica morta. */
export const LOST_AFTER_MS = 10_000;

/** Listagens não terminadas (a em andamento mais as perdidas), no máximo. */
export const MAX_UNFINISHED_LISTINGS = 2;

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
 * @property {boolean} dead              listagem perdida: `[]` até ela terminar ou o servidor reiniciar
 * @property {Map<(names: string[]) => void, string>} waiters   `read` esperando, dentro do prazo, e o projeto de cada um
 * @property {Set<string>} late          projetos que receberam `[]` desta pasta (prazo vencido ou pasta morta)
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
 * Leitor com prazo por pasta, uma listagem por vez, pasta pessoal primeiro,
 * listagens perdidas e cache.
 * @param {{
 *   homeDir?: string|null,
 *   list?: (folder: string) => Promise<unknown>|unknown,
 *   timeoutMs?: number,
 *   lostAfterMs?: number,
 *   timers?: ReaderTimers,
 *   onLate?: (projectDir: string, names: string[]) => void,
 * }} [options]
 *   `homeDir`: pasta pessoal (padrão: os.homedir()). `list`: listagem de uma
 *   pasta (os testes trocam). `timeoutMs`: prazo de cada `read`. `lostAfterMs`:
 *   quando uma listagem é dada como perdida (os testes encurtam). `timers`:
 *   temporizadores (os testes trocam). `onLate`: chamado quando uma pasta que
 *   ficou devendo nomes a um projeto termina de ser listada.
 * @returns {AgentNamesReader}
 */
export function createAgentNamesReader({
  homeDir = defaultHomeDir(),
  list = listAgentFiles,
  timeoutMs = READ_TIMEOUT_MS,
  lostAfterMs = LOST_AFTER_MS,
  timers = { setTimeout, clearTimeout },
  onLate = () => {},
} = {}) {
  /** @type {Map<string, FolderEntry>} */
  const folders = new Map();
  /** @type {string[]} */
  const queue = [];
  /** Pasta da listagem em andamento (não perdida). @type {string|null} */
  let active = null;
  /** Listagens não terminadas: a em andamento mais as perdidas. */
  let unfinished = 0;

  // A pasta pessoal entra primeiro e começa a ser listada já.
  const homeFolder = agentsFolder(homeDir);
  if (homeFolder !== null) entryFor(homeFolder);

  /**
   * A entrada da pasta; uma pasta nova entra na fila.
   * @param {string} folder
   * @returns {FolderEntry}
   */
  function entryFor(folder) {
    let entry = folders.get(folder);
    if (!entry) {
      entry = { names: null, dead: false, waiters: new Map(), late: new Set() };
      folders.set(folder, entry);
      queue.push(folder);
      evictOld();
      pump();
    }
    return entry;
  }

  /**
   * Nomes de uma pasta para o projeto, dentro do prazo.
   * @param {unknown} base
   * @param {string} projectDir
   * @returns {Promise<string[]>}
   */
  function namesIn(base, projectDir) {
    const folder = agentsFolder(base);
    if (folder === null) return Promise.resolve([]);
    const entry = entryFor(folder);
    if (entry.names !== null) return Promise.resolve(entry.names);
    if (entry.dead) {
      entry.late.add(projectDir);
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      /** @param {string[]} names */
      const waiter = (names) => {
        timers.clearTimeout(timer);
        resolve(names);
      };
      const timer = timers.setTimeout(() => {
        entry.waiters.delete(waiter);
        entry.late.add(projectDir);
        resolve([]);
      }, timeoutMs);
      // Com o relógio real, o prazo sozinho não segura o processo.
      timer?.unref?.();
      entry.waiters.set(waiter, projectDir);
    });
  }

  /** Começa a próxima listagem da fila, se houver vaga. */
  function pump() {
    if (active !== null || unfinished >= MAX_UNFINISHED_LISTINGS || queue.length === 0) return;
    const folder = /** @type {string} */ (queue.shift());
    active = folder;
    unfinished++;
    const lost = timers.setTimeout(() => {
      if (active !== folder) return;
      // Perdida: a pasta fica morta, e a vaga de "em andamento" volta para a fila.
      active = null;
      markDead(folder);
      pump();
    }, lostAfterMs);
    lost?.unref?.();
    Promise.resolve()
      .then(() => list(folder))
      .then(agentNamesFrom, () => [])
      .then((names) => {
        timers.clearTimeout(lost);
        unfinished--;
        if (active === folder) active = null;
        finish(folder, names);
      })
      .finally(pump);
  }

  /** @param {string} folder */
  function markDead(folder) {
    const entry = folders.get(folder);
    if (!entry) return;
    entry.dead = true;
    for (const [waiter, projectDir] of [...entry.waiters]) {
      entry.late.add(projectDir);
      waiter([]);
    }
    entry.waiters.clear();
  }

  /**
   * @param {string} folder
   * @param {string[]} names
   */
  function finish(folder, names) {
    const entry = folders.get(folder);
    if (!entry) return;
    entry.dead = false;
    entry.names = names;
    for (const waiter of [...entry.waiters.keys()]) waiter(names);
    entry.waiters.clear();
    const late = [...entry.late];
    entry.late.clear();
    for (const projectDir of late) {
      // Só com as duas pastas do projeto resolvidas: a que faltar ainda chama
      // onLate quando terminar, com os nomes completos.
      if (!settled(projectDir) || !settled(homeDir)) continue;
      try {
        onLate(projectDir, [...cached(projectDir), ...cached(homeDir)]);
      } catch {
        // quem recebe trata os próprios erros; o leitor segue
      }
    }
  }

  /**
   * A pasta de agentes da base já foi listada, está morta ou não é lida?
   * @param {unknown} base
   * @returns {boolean}
   */
  function settled(base) {
    const folder = agentsFolder(base);
    if (folder === null) return true;
    const entry = folders.get(folder);
    return entry !== undefined && (entry.names !== null || entry.dead);
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
      if (entry.names !== null && folder !== homeFolder) folders.delete(folder);
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
