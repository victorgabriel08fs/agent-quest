// @ts-check
// Ponto de entrada do servidor (`npm start` e `npm run dev`).
//
// 1. Resolve a configuração (diretório de dados, porta).
// 2. Se o runtime.json aponta para um Agent Quest vivo, avisa "já está rodando" e sai com 0.
// 3. Escuta só em 127.0.0.1. Porta ocupada por outro Agent Quest: mesmo aviso e saída 0;
//    por outro programa: mensagem clara e saída 1.
// 4. Grava o runtime.json (atômico), com o token que o POST /hooks exige, e o
//    apaga no encerramento normal.
// 5. Com --debug-dump, grava os envelopes aceitos em <dados>/dumps/ (ADR 0005).
//
// `startServer` também é usado pelos testes, sempre com `AGENT_QUEST_HOME`
// temporário e porta 0 (porta livre).

import http from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { HOST, StartupError, VERSION, portCommand, resolveConfig } from './config.js';
import { createApp } from './http/app.js';
import { installProtocolErrorHandlers } from './http/client-error.js';
import { createDebugDump, dumpsDir } from './ingest/debug-dump.js';
import { createToken, isPidAlive, readRuntimeFile, removeRuntimeFile, writeRuntimeFile } from './runtime-file.js';

/** @typedef {import('./http/app.js').HttpServer} HttpServer */

/** Tempo máximo para perguntar a outra instância se ela está viva. */
const PROBE_TIMEOUT_MS = 1000;

/** Sinais que encerram o servidor. SIGHUP chega no Windows quando a janela do terminal fecha. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

/**
 * @typedef {object} StartOptions
 * @property {string[]} [argv]                           argumentos depois do nome do script
 * @property {Record<string, string|undefined>} [env]
 * @property {string} [platform]
 * @property {string} [homedir]
 * @property {(message: string) => void} [logError]      erros inesperados durante a execução
 */

/**
 * @typedef {object} RunningServer
 * @property {'started'} status
 * @property {string} url                                http://127.0.0.1:<porta>/
 * @property {number} port
 * @property {string} dataDir
 * @property {string[]} warnings
 * @property {import('./runtime-file.js').RuntimeInfo} runtime
 * @property {HttpServer} server
 * @property {() => Promise<void>} close                 apaga o runtime.json e fecha o servidor
 */

/**
 * @typedef {object} AlreadyRunning
 * @property {'already-running'} status
 * @property {string} url
 */

/**
 * Inicia o servidor. Lança `StartupError` (mensagem pronta para o terminal)
 * quando a configuração é inválida ou a porta está ocupada por outro programa.
 * @param {StartOptions} [options]
 * @returns {Promise<RunningServer|AlreadyRunning>}
 */
export async function startServer(options = {}) {
  const {
    argv = [],
    env = process.env,
    platform = process.platform,
    homedir = os.homedir(),
    logError = console.error,
  } = options;
  const config = resolveConfig({ argv, env, platform, homedir });

  const existing = readRuntimeFile(config.dataDir);
  if (existing && isPidAlive(existing.pid) && (await isAgentQuestAt(existing.port))) {
    return { status: 'already-running', url: urlFor(existing.port) };
  }
  // Daqui em diante, um runtime.json que exista é sobra e será substituído.

  const startedAt = Date.now();
  const token = createToken();
  // A pasta dos dumps só é criada no primeiro envelope gravado.
  const dump = config.debugDump
    ? createDebugDump({
        dir: dumpsDir(config.dataDir),
        onError: (err) => logError(`Erro ao gravar o --debug-dump; a gravação parou: ${errorKind(err)}`),
      })
    : null;
  const { server } = createApp({ version: VERSION, startedAt, token, dump, logError });
  installProtocolErrorHandlers(server);
  try {
    await listen(server, config.port);
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === 'EADDRINUSE') {
      if (await isAgentQuestAt(config.port)) return { status: 'already-running', url: urlFor(config.port) };
      throw new StartupError(
        `A porta ${config.port} já está em uso por outro programa.\n` +
          `Escolha outra porta: ${portCommand(env)} (ou AGENT_QUEST_PORT, ou "port" no config.json do diretório de dados).`,
      );
    }
    if (code === 'EACCES') {
      throw new StartupError(
        `Sem permissão para usar a porta ${config.port} (o Windows reserva algumas faixas).\n` +
          `Escolha outra porta: ${portCommand(env)}.`,
      );
    }
    throw err;
  }
  server.on('error', (/** @type {any} */ err) => logError(`Erro no servidor: ${err?.code ?? 'Error'}`));

  const port = server.address().port;
  /** @type {import('./runtime-file.js').RuntimeInfo} */
  const runtime = { port, token, pid: process.pid, version: VERSION, startedAt };
  try {
    await writeRuntimeFile(config.dataDir, runtime);
  } catch (err) {
    server.close();
    throw new StartupError(
      `Não foi possível gravar o runtime.json em ${config.dataDir} (${/** @type {any} */ (err)?.code ?? 'erro'}).`,
    );
  }

  /** @type {Promise<void>|null} */
  let closing = null;
  function close() {
    if (!closing) {
      // Primeiro o runtime.json, para os encaminhadores pararem de tentar na hora.
      removeRuntimeFile(config.dataDir, runtime);
      const serverClosed = new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      });
      closing = Promise.all([serverClosed, dump?.close()]).then(() => {});
    }
    return closing;
  }

  return {
    status: 'started',
    url: urlFor(port),
    port,
    dataDir: config.dataDir,
    warnings: config.warnings,
    runtime,
    server,
    close,
  };
}

/**
 * Pergunta ao /api/health da porta se quem responde é um Agent Quest.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isAgentQuestAt(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (/** @type {boolean} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const req = http.get({ host: HOST, port, path: '/api/health', agent: false }, (/** @type {any} */ res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (/** @type {string} */ chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) done(false);
      });
      res.on('end', () => done(res.statusCode === 200 && looksLikeHealth(body)));
      res.on('error', () => done(false));
    });
    req.on('error', () => done(false));
  });
}

/**
 * Liga os sinais de encerramento (Ctrl+C e afins) a `close()`. Um segundo sinal
 * durante o encerramento sai na hora.
 * @param {() => Promise<void>} close
 * @param {{ proc?: { on(signal: string, listener: () => void): unknown, exit(code?: number): void }, log?: (message: string) => void }} [options]
 */
export function installShutdownHandlers(close, { proc = process, log = console.log } = {}) {
  let stopping = false;
  const onSignal = () => {
    if (stopping) {
      proc.exit(1);
      return;
    }
    stopping = true;
    log('Encerrando o Agent Quest...');
    close().then(
      () => proc.exit(0),
      () => proc.exit(1),
    );
  };
  for (const signal of SHUTDOWN_SIGNALS) proc.on(signal, onSignal);
}

/**
 * Tipo do erro, sem a mensagem (que pode carregar caminhos ou conteúdo).
 * @param {unknown} err
 * @returns {string}
 */
function errorKind(err) {
  const e = /** @type {any} */ (err);
  return String(e?.code ?? e?.name ?? 'Error');
}

/**
 * @param {number} port
 * @returns {string}
 */
function urlFor(port) {
  return `http://${HOST}:${port}/`;
}

/**
 * @param {HttpServer} server
 * @param {number} port
 * @returns {Promise<void>}
 */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (/** @type {unknown} */ err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

/**
 * Confere a forma de `HealthResponse` (shared/contract.js).
 * @param {string} body
 * @returns {boolean}
 */
function looksLikeHealth(body) {
  try {
    const data = JSON.parse(body);
    return (
      data?.ok === true &&
      typeof data.version === 'string' &&
      typeof data.startedAt === 'number' &&
      typeof data.events?.received === 'number' &&
      typeof data.sessions === 'number' &&
      typeof data.clients === 'number'
    );
  } catch {
    return false;
  }
}

/** @returns {boolean} */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync.native(entry) === realpathSync.native(import.meta.filename);
  } catch {
    return false;
  }
}

async function main() {
  let result;
  try {
    result = await startServer({ argv: process.argv.slice(2) });
  } catch (err) {
    if (err instanceof StartupError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (result.status === 'already-running') {
    console.log(`O Agent Quest já está rodando em ${result.url}`);
    return;
  }

  for (const warning of result.warnings) console.warn(warning);
  const { dataDir, runtime, close } = result;
  // Último recurso (process.exit, exceção não tratada): o runtime.json não fica para trás.
  process.on('exit', () => removeRuntimeFile(dataDir, runtime));
  installShutdownHandlers(close);

  console.log(`Agent Quest ${VERSION} rodando em ${result.url}`);
  console.log(`Diretório de dados: ${dataDir}`);
  console.log('Ctrl+C para parar.');
}

if (isEntryPoint()) await main();
