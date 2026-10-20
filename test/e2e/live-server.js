// @ts-check
// Servidor real só de um teste ponta a ponta (T11b e T12b): porta livre e
// AGENT_QUEST_HOME temporário, nunca a 47821 nem o diretório real. Serve para os
// testes que param e religam o servidor sem afetar os outros arquivos, que
// rodam em paralelo com o servidor do playwright.config.js.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** @returns {Promise<number>} */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * @param {() => Promise<boolean>} check
 * @param {string} what
 */
export async function waitFor(check, what, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      // ainda não
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`tempo esgotado esperando ${what}`);
}

/**
 * Sobe `node server/main.js` na porta, com o diretório de dados dado, e espera o
 * `runtime.json` deste processo e o /api/health.
 * @param {number} port
 * @param {string} home
 */
export async function startServer(port, home) {
  const child = spawn(process.execPath, ['server/main.js', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, AGENT_QUEST_HOME: home },
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  /** @type {{ port: number, token: string, pid: number }|null} */
  let runtime = null;
  await waitFor(async () => {
    const parsed = JSON.parse(readFileSync(path.join(home, 'runtime.json'), 'utf8'));
    if (parsed.pid !== child.pid) return false;
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    runtime = parsed;
    return response.ok;
  }, 'o servidor de teste subir');
  if (!runtime) throw new Error('runtime.json ausente');
  return {
    child,
    token: /** @type {{ token: string }} */ (runtime).token,
    async stop() {
      child.kill();
      await exited;
    },
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

/**
 * Estado do servidor (o mesmo do snapshot).
 * @param {number} port
 */
export async function serverState(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  return /** @type {{ seq: number, sessions: any[] }} */ (await response.json());
}
