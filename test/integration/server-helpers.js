// Utilitários dos testes de integração do servidor (tester). Não é arquivo de teste.
//
// Regras do ADR 0010 seguidas aqui:
// - nada usa o diretório de dados real: todo processo recebe AGENT_QUEST_HOME (ou
//   LOCALAPPDATA/USERPROFILE) apontando para uma pasta temporária;
// - nada usa a porta padrão 47821: sempre --port 0 ou uma porta livre sorteada.
//
// O ambiente dos processos filhos é mínimo de propósito: sem USERPROFILE, HOME ou
// LOCALAPPDATA herdados, para que um esquecimento nunca caia no diretório real.
// Sem USERPROFILE, o Node acharia a pasta pessoal real pelo sistema
// (os.homedir()); por isso USERPROFILE e HOME apontam, por padrão, para uma
// pasta pessoal temporária, e o servidor de teste nunca lê o ~/.claude real
// (agentes em ~/.claude/agents, transcripts em ~/.claude/projects para a sonda
// de contexto do T15).

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const MAIN = path.join(REPO, 'server', 'main.js');

/** CSP literal do ADR 0006 (oráculo independente do código de produção). */
export const ADR_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Cabeçalhos do ADR 0006, em minúsculas, como chegam em `res.headers`. */
export const ADR_HEADERS = Object.freeze({
  'content-security-policy': ADR_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
});

/** Erros de remoção que no Windows costumam ser passageiros (antivírus, indexador, processo terminando). */
const TRANSIENT_RM_ERRORS = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE']);

/** Pausa síncrona (só para a limpeza, que precisa continuar síncrona para quem já a usa). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Apaga uma pasta, tentando de novo por até `timeoutMs` enquanto o erro for
 * passageiro. Depois de encerrar um processo à força, o Windows pode segurar a
 * pasta (diretório de trabalho ou arquivo aberto) por alguns instantes.
 * Síncrona de propósito: `tempDir().cleanup()` é chamada sem `await` em vários testes.
 */
export function removeDir(dir, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!TRANSIENT_RM_ERRORS.has(err?.code) || Date.now() > deadline) throw err;
      sleepSync(Math.min(100 * attempt, 1000));
    }
  }
}

/** Cria uma pasta temporária. `cleanup()` apaga com novas tentativas (síncrona). */
export function tempDir(prefix = 'aq-int-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => removeDir(dir) };
}

/**
 * Ambiente mínimo para o Node rodar, mais `extra`. USERPROFILE e HOME apontam
 * para uma pasta pessoal temporária, a não ser que `extra` diga outra.
 */
export function minimalEnv(extra = {}) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const home = fakeHome();
  return { ...env, USERPROFILE: home, HOME: home, ...extra };
}

/** Pasta pessoal temporária e vazia dos processos filhos, apagada no fim. */
let fakeHomeDir = null;
function fakeHome() {
  if (!fakeHomeDir) {
    fakeHomeDir = mkdtempSync(path.join(tmpdir(), 'aq-int-home-'));
    process.once('exit', () => {
      try {
        removeDir(fakeHomeDir, { timeoutMs: 5_000 });
      } catch {
        // pasta temporária do sistema; não vale derrubar o teste por ela
      }
    });
  }
  return fakeHomeDir;
}

/**
 * Faixa das portas fixas dos testes: fora da faixa dinâmica do Windows
 * (49152 a 65535) e da faixa padrão do Linux (32768 a 60999). Servidores com
 * porta 0, de qualquer arquivo de teste rodando em paralelo, recebem portas da
 * faixa dinâmica e por isso nunca disputam uma porta sorteada aqui.
 */
const FIXED_PORT_MIN = 20_000;
const FIXED_PORT_MAX = 31_999;

/**
 * Porta fixa para testes que precisam repetir a mesma porta (reinício, prioridade
 * de configuração). Sorteia fora da faixa dinâmica e confere que dá para escutar
 * nela (porta livre e não reservada pelo sistema). Nunca a 47821.
 */
export async function fixedPort() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = FIXED_PORT_MIN + Math.floor(Math.random() * (FIXED_PORT_MAX - FIXED_PORT_MIN + 1));
    const server = net.createServer();
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      await new Promise((resolve) => server.close(resolve));
      return port;
    }
  }
  throw new Error(`nenhuma porta livre entre ${FIXED_PORT_MIN} e ${FIXED_PORT_MAX}`);
}

/** Igual a `fixedPort()`; mantido pelo nome usado nos testes. */
export const freePort = fixedPort;

/**
 * Inicia um processo e espera até `ready` casar com a saída (stdout + stderr) ou o
 * processo terminar.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env: Record<string,string>, cwd?: string, ready?: RegExp, timeoutMs?: number }} options
 */
export function launch(command, args, { env, cwd = REPO, ready = /http:\/\/127\.0\.0\.1:\d+\//, timeoutMs = 15_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (out += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (out += chunk));
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`processo não ficou pronto a tempo:\n${out}`)), timeoutMs);
    const poll = setInterval(() => {
      if (ready.test(out)) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(true);
      }
    }, 20);
    exit.then(() => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve(false);
    });
  });
  started.catch(() => {}); // quem não espera `started` não gera rejeição sem tratamento
  return { child, exit, started, output: () => out };
}

/** `node server/main.js ...args` com o ambiente dado. */
export function launchServer(args, env, options = {}) {
  return launch(process.execPath, [MAIN, ...args], { env, ...options });
}

/**
 * Caminho do npm-cli.js, para rodar `npm start` e `npm run dev` de verdade sem
 * depender de shell. Sob `npm test`, vem de npm_execpath.
 */
export function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((p) => p && p.endsWith('npm-cli.js') && existsSync(p)) ?? null;
}

/** Cache e configuração do npm isolados numa pasta temporária, apagada no fim. */
let npmSandbox = null;
export function npmEnv() {
  if (!npmSandbox) {
    npmSandbox = mkdtempSync(path.join(tmpdir(), 'aq-int-npm-'));
    process.once('exit', () => {
      try {
        removeDir(npmSandbox, { timeoutMs: 5_000 });
      } catch {
        // pasta temporária do sistema; não vale derrubar o teste por ela
      }
    });
  }
  return {
    npm_config_cache: path.join(npmSandbox, 'cache'),
    npm_config_userconfig: path.join(npmSandbox, 'npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
  };
}

/** `npm <args>` de verdade (npm-cli.js pelo Node atual). */
export function launchNpm(args, env, options = {}) {
  const cli = npmCli();
  if (!cli) throw new Error('npm-cli.js não encontrado ao lado do node.exe nem em npm_execpath');
  return launch(process.execPath, [cli, ...args], { env: { ...npmEnv(), ...env }, ...options });
}

/** Encerra o processo e todos os descendentes (no Windows, com taskkill /T /F). */
export async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
  await exited;
}

/** Encerra um pid qualquer, se ainda existir. */
export function killPid(pid) {
  try {
    process.kill(pid);
  } catch {
    // já terminou
  }
}

/**
 * Requisição HTTP para 127.0.0.1 sem normalizar o caminho.
 * @returns {Promise<{ status: number, headers: Record<string, any>, body: Buffer, text: string }>}
 */
export function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`timeout em ${method} ${urlPath}`)));
    req.end(body);
  });
}

/**
 * Requisição crua por socket (para cabeçalhos duplicados, sem Host etc.).
 * @returns {Promise<{ status: number, head: string, body: string }>}
 */
export function rawRequest(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const [head, ...rest] = data.split('\r\n\r\n');
      const status = Number((head.match(/^HTTP\/1\.[01] (\d{3})/) ?? [])[1] ?? 0);
      resolve({ status, head, body: rest.join('\r\n\r\n') });
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('close', finish);
    socket.on('error', finish);
    socket.setTimeout(5000, () => socket.destroy());
    socket.write(text);
  });
}

/** Espera `predicate()` ficar verdadeiro (ou estoura o prazo). */
export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 25, label = 'condição' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`tempo esgotado esperando ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
