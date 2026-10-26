// Utilitários dos testes do servidor. Não é um arquivo de teste (não termina em .test.js).
//
// Regra do ADR 0010: nada aqui usa o diretório de dados real nem a porta padrão.
// Todo teste cria um AGENT_QUEST_HOME temporário e escuta na porta 0.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const MAIN = path.join(REPO, 'server', 'main.js');

/** Ambiente mínimo e isolado: só o necessário para o Node rodar, mais o AGENT_QUEST_HOME temporário. */
export function isolatedEnv(home, extra = {}) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // A pasta pessoal também é a temporária: o servidor nunca lê o ~/.claude real
  // (agentes e transcripts da sonda de contexto do T15).
  return { ...env, USERPROFILE: home, HOME: home, AGENT_QUEST_HOME: home, ...extra };
}

/**
 * Cria um diretório temporário e devolve o caminho e a função que o apaga.
 * @param {string} [prefix]
 */
export function tempDir(prefix = 'agent-quest-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Requisição HTTP crua para 127.0.0.1, sem normalizar o caminho.
 * O `Host` padrão é 127.0.0.1:<porta>; passe `headers.Host` para trocar.
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
export function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers, agent: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

/**
 * Roda `node server/main.js` como processo filho e espera a primeira linha com
 * uma URL (ou a saída do processo).
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, output: () => string, url: string|null, exit: Promise<number|null> }>}
 */
export function spawnServer(args, env) {
  const child = spawn(process.execPath, [MAIN, ...args], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    // No prazo estourado, o filho é encerrado: senão ele ficaria órfão (fora da
    // limpeza do teste) e, se escutasse depois, seguraria o processo de teste.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`o servidor não respondeu a tempo:\n${out}`));
    }, 10_000);
    const onData = (chunk) => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        clearTimeout(timer);
        resolve({ child, output: () => out, url: match[0], exit });
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    exit.then(() => {
      clearTimeout(timer);
      resolve({ child, output: () => out, url: null, exit });
    });
  });
}

/** Encerra o processo filho e espera a saída. */
export async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

/** Pid de um processo que já terminou. */
export async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}
