// @ts-check
// Configuração do servidor: diretório de dados, porta e config.json.
// Fontes: ADR 0005 (diretório de dados) e ADR 0006 (rede); visão geral, "Limites e valores padrão".
//
// As funções recebem `env`, `platform` e `homedir` por parâmetro, para os testes
// nunca dependerem do ambiente real. O encaminhador (T4) repete `resolveDataDir`
// sem importar este módulo, e um teste compara as duas.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { dumpsDir } from './ingest/debug-dump.js';

/** O servidor só escuta aqui (ADR 0006). Nunca 0.0.0.0 nem ::. */
export const HOST = '127.0.0.1';

/** Porta padrão (visão geral, "Limites e valores padrão"). */
export const DEFAULT_PORT = 47821;

/** Nome da pasta de dados dentro de %LOCALAPPDATA% ou do diretório de estado do XDG. */
export const DATA_DIR_NAME = 'agent-quest';

/** Versão do package.json, exposta no runtime.json e no /api/health. */
export const VERSION = readVersion();

const USAGE = 'Uso: npm start -- [--port <número>] [--debug-dump]';
const PORT_RULE = 'Use um número inteiro de 1024 a 65535 (ou 0 para uma porta livre qualquer).';

/**
 * Erro de configuração ou de início, com mensagem pronta para o terminal.
 * O processo sai com código 1.
 */
export class StartupError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'StartupError';
  }
}

/**
 * @typedef {object} ResolveOptions
 * @property {Record<string, string|undefined>} env
 * @property {string} platform           valor de process.platform
 * @property {string} homedir            pasta pessoal (os.homedir())
 */

/**
 * @typedef {object} ServerConfig
 * @property {string} dataDir
 * @property {number} port               0 pede uma porta livre ao sistema (testes)
 * @property {'--port'|'AGENT_QUEST_PORT'|'config.json'|'padrão'} portSource
 * @property {Record<string, unknown>} roles   sobrescritas de papel do config.json (validadas no T5)
 * @property {boolean} insideOneDrive
 * @property {boolean} debugDump        --debug-dump: grava os envelopes em <dados>/dumps/ (ADR 0005)
 * @property {string[]} warnings         avisos para o terminal
 */

/**
 * Diretório de dados (ADR 0005): `AGENT_QUEST_HOME`, se definido; no Windows,
 * `%LOCALAPPDATA%\agent-quest`; nos outros sistemas, `$XDG_STATE_HOME/agent-quest`
 * ou `~/.local/state/agent-quest`.
 * @param {ResolveOptions} options
 * @returns {string}
 */
export function resolveDataDir({ env, platform, homedir }) {
  if (env.AGENT_QUEST_HOME) return env.AGENT_QUEST_HOME;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(localAppData, DATA_DIR_NAME);
  }
  const stateHome = env.XDG_STATE_HOME || path.posix.join(homedir, '.local', 'state');
  return path.posix.join(stateHome, DATA_DIR_NAME);
}

/**
 * Diz se o caminho fica dentro de uma pasta do OneDrive, pelas variáveis que o
 * Windows define (`OneDrive`, `OneDriveConsumer`, `OneDriveCommercial`) ou por uma
 * pasta chamada "OneDrive" ou "OneDrive - <organização>" no caminho.
 * @param {string} dir
 * @param {{ env: Record<string, string|undefined>, platform: string }} options
 * @returns {boolean}
 */
export function isInsideOneDrive(dir, { env, platform }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (/** @type {string} */ value) => (platform === 'win32' ? value.toLowerCase() : value);
  const target = fold(p.resolve(dir));

  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[name];
    if (!root) continue;
    const base = fold(p.resolve(root));
    if (target === base || target.startsWith(base.endsWith(p.sep) ? base : base + p.sep)) return true;
  }
  return target.split(/[\\/]/).some((segment) => /^onedrive( - .+)?$/i.test(segment));
}

/**
 * Lê as opções da linha de comando.
 * @param {string[]} argv                argumentos depois do nome do script
 * @returns {{ port?: string, debugDump?: true }}
 */
export function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { port: { type: 'string' }, 'debug-dump': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new StartupError(`Argumentos inválidos: ${argv.join(' ')}\n${USAGE}`);
  }
  /** @type {{ port?: string, debugDump?: true }} */
  const args = {};
  if (values.port !== undefined) args.port = values.port;
  if (values['debug-dump'] === true) args.debugDump = true;
  return args;
}

/**
 * Lê `<dados>/config.json`, se existir. Arquivo ausente vale `{}`; arquivo
 * ilegível ou que não seja um objeto JSON é ignorado com um aviso.
 * @param {string} dataDir
 * @returns {{ config: Record<string, unknown>, warning: string|null }}
 */
export function readConfigFile(dataDir) {
  const file = path.join(dataDir, 'config.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return { config: {}, warning: null };
    return { config: {}, warning: `Aviso: não foi possível ler ${file}; o arquivo foi ignorado.` };
  }
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { config: parsed, warning: null };
  } catch {
    // cai no aviso abaixo
  }
  return { config: {}, warning: `Aviso: ${file} não é um objeto JSON válido; o arquivo foi ignorado.` };
}

/**
 * Valida uma porta vinda de uma das fontes. Aceita 0 (porta livre, usada nos
 * testes) e de 1024 a 65535, que é o que o encaminhador aceita (T4).
 * @param {unknown} value
 * @param {string} source                nome da fonte, para a mensagem de erro
 * @returns {number}
 */
export function parsePort(value, source) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (port === 0 || (port >= 1024 && port <= 65535)) return port;
  throw new StartupError(`Porta inválida em ${source}: ${JSON.stringify(value)}. ${PORT_RULE}`);
}

/**
 * Junta todas as fontes. Prioridade da porta: `--port`, `AGENT_QUEST_PORT`,
 * `config.json` e o padrão 47821.
 * @param {ResolveOptions & { argv: string[] }} options
 * @returns {ServerConfig}
 */
export function resolveConfig({ argv, env, platform, homedir }) {
  const args = parseCliArgs(argv);
  const dataDir = resolveDataDir({ env, platform, homedir });
  const { config, warning } = readConfigFile(dataDir);
  const warnings = warning ? [warning] : [];

  // O encaminhador resolve o diretório de dados com o ambiente do Claude Code (ADR 0005, complemento).
  if (env.AGENT_QUEST_HOME) {
    warnings.push(
      `Aviso: AGENT_QUEST_HOME está definida (${dataDir}). A captura só encontra este servidor ` +
        'se o Claude Code tiver a mesma variável, com o mesmo valor, no ambiente dele (terminal e VS Code). ' +
        'No uso normal, deixe AGENT_QUEST_HOME sem valor.',
    );
  }

  /** @type {ServerConfig['port']} */
  let port = DEFAULT_PORT;
  /** @type {ServerConfig['portSource']} */
  let portSource = 'padrão';
  if (args.port !== undefined) {
    port = parsePort(args.port, '--port');
    portSource = '--port';
  } else if (env.AGENT_QUEST_PORT) {
    port = parsePort(env.AGENT_QUEST_PORT, 'AGENT_QUEST_PORT');
    portSource = 'AGENT_QUEST_PORT';
  } else if (config.port !== undefined) {
    port = parsePort(config.port, path.join(dataDir, 'config.json'));
    portSource = 'config.json';
  }

  /** @type {Record<string, unknown>} */
  let roles = {};
  if (config.roles !== undefined) {
    if (config.roles && typeof config.roles === 'object' && !Array.isArray(config.roles)) {
      roles = /** @type {Record<string, unknown>} */ (config.roles);
    } else {
      warnings.push('Aviso: "roles" no config.json não é um objeto; foi ignorado.');
    }
  }

  const insideOneDrive = isInsideOneDrive(dataDir, { env, platform });
  if (insideOneDrive) warnings.push(oneDriveWarning(dataDir));

  const debugDump = args.debugDump === true;
  if (debugDump) {
    warnings.push(
      `Aviso: --debug-dump ligado. Os envelopes recebidos serão gravados em ${dumpsDir(dataDir)}, ` +
        'com dados sensíveis (código, comandos, caminhos e possíveis segredos). ' +
        'Use só para depuração e apague os arquivos depois.',
    );
  }

  return { dataDir, port, portSource, roles, insideOneDrive, debugDump, warnings };
}

/**
 * Aviso de pasta de dados dentro do OneDrive, com a orientação do ADR 0005
 * (complemento). Usado pelo servidor e pelo `npm run capture:deploy`.
 * @param {string} dataDir
 * @returns {string}
 */
export function oneDriveWarning(dataDir) {
  return (
    `Aviso: a pasta de dados (${dataDir}) está dentro do OneDrive. ` +
    'O runtime.json guarda o token da execução e seria sincronizado com a nuvem. ' +
    'Para usar outra pasta, defina AGENT_QUEST_HOME como variável de ambiente do usuário do Windows ' +
    'e reabra os terminais e o VS Code, porque o Claude Code precisa ver o mesmo valor.'
  );
}

/**
 * Comando para iniciar em outra porta no modo em uso, pelo `npm_lifecycle_event`
 * (o npm define essa variável com o nome do script).
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function portCommand(env) {
  if (env.npm_lifecycle_event === 'dev') return 'npm run dev -- --port <número>';
  if (env.npm_lifecycle_event === 'start') return 'npm start -- --port <número>';
  return 'node server/main.js --port <número>';
}

/** @returns {string} */
function readVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return String(pkg.version);
}
