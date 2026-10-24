// @ts-check
// Servidor real só de um teste ponta a ponta (T11b, T12b e T13), sobre o apoio
// do tester (test/e2e/qa-live.js), para os dois usarem o mesmo código:
// - porta livre e AGENT_QUEST_HOME temporário, nunca a 47821 nem o diretório
//   real;
// - USERPROFILE e HOME na mesma pasta temporária, para o servidor de teste não
//   ler o ~/.claude/agents de quem roda os testes;
// - se a subida falha, o processo é encerrado antes do erro (nada fica para trás).
// Serve para os testes que param e religam o servidor sem afetar os outros
// arquivos, que rodam em paralelo com o servidor do playwright.config.js.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freePort, serverState, startLiveServer, waitFor } from './qa-live.js';

export { freePort, serverState, waitFor };

/**
 * Sobe `node server/main.js` na porta, com o diretório de dados (e a pasta
 * pessoal) dados, e espera o `runtime.json` deste processo e o /api/health.
 * @param {number} port
 * @param {string} home
 */
export async function startServer(port, home) {
  const server = await startLiveServer({ port, home });
  return {
    token: server.token,
    stop: () => server.stop(),
  };
}

/** Pasta temporária de dados para um teste. */
export const tempHome = () => mkdtempSync(path.join(tmpdir(), 'aq-e2e-live-'));

/** Apaga a pasta temporária (no Windows o processo pode ainda estar saindo). */
export function removeHome(/** @type {string} */ home) {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // fica para o sistema limpar
  }
}
