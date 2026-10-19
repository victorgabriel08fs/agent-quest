// @ts-check
// Nomes dos agentes disponíveis para a equipe (roster): os arquivos `.md` de
// `<projeto>/.claude/agents/` e de `~/.claude/agents/` (modelo de eventos,
// seção 7). Lê só os nomes, nunca o conteúdo.
//
// Fica fora de server/domain/ (T7, ponto 10): o reducer recebe a função
// pronta em `createState({ readAgentNames })`, com padrão `() => []`, e a
// ligação de ponta a ponta (T9a) passa o leitor criado aqui.
//
// - A leitura é síncrona, então caminho de rede (UNC) e caminho relativo não
//   são lidos: uma pasta de rede poderia travar o servidor ou abrir conexão
//   com outra máquina.
// - Cache por pasta: cada pasta é listada uma vez por execução do servidor.
//   Arquivo novo só aparece depois de reiniciar, o que é aceito na v1.
// - Nunca lança: pasta que não existe ou que falha vira lista vazia.

import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Quantos arquivos são lidos por pasta. */
export const MAX_AGENT_FILES = 200;

/** Quantas pastas ficam no cache; acima disso, sai a mais antiga. */
export const MAX_CACHED_FOLDERS = 256;

/**
 * Nomes (sem `.md`) dos arquivos de uma pasta de agentes. Sem cache.
 * @param {string} folder                pasta `.claude/agents` já montada
 * @returns {string[]}
 */
export function listAgentFiles(folder) {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {string[]} */
  const names = [];
  for (const entry of entries.slice(0, MAX_AGENT_FILES)) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) names.push(entry.name.slice(0, -3));
  }
  return names;
}

/**
 * Leitor com cache por pasta, para o `createState({ readAgentNames })`.
 * @param {{ homeDir?: string|null, list?: (folder: string) => string[] }} [options]
 *   `homeDir`: pasta pessoal (padrão: os.homedir()). `list`: listagem de uma
 *   pasta (os testes trocam).
 * @returns {(projectDir: string) => string[]}
 */
export function createAgentNamesReader({ homeDir = defaultHomeDir(), list = listAgentFiles } = {}) {
  /** @type {Map<string, string[]>} */
  const cache = new Map();

  /** @param {unknown} base */
  function namesIn(base) {
    const folder = agentsFolder(base);
    if (folder === null) return [];
    const cached = cache.get(folder);
    if (cached) return cached;
    /** @type {string[]} */
    let names;
    try {
      names = list(folder);
    } catch {
      names = [];
    }
    cache.set(folder, names);
    if (cache.size > MAX_CACHED_FOLDERS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return names;
  }

  return (projectDir) => [...namesIn(projectDir), ...namesIn(homeDir)];
}

/**
 * Leitura direta, sem cache, do projeto e da pasta pessoal.
 * @param {string} projectDir
 * @param {{ homeDir?: string|null }} [options]
 * @returns {string[]}
 */
export function readAgentNamesFromDisk(projectDir, { homeDir = defaultHomeDir() } = {}) {
  return createAgentNamesReader({ homeDir })(projectDir);
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
