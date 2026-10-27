// @ts-check
// `npm run capture:deploy` (ADR 0002): copia `capture/` para `<dados>/marketplace/`,
// fora do OneDrive, e imprime os comandos para o usuário testar, instalar, pausar
// e remover a captura. Este script nunca executa o `claude`: ligar a captura é
// sempre uma ação do usuário.
//
// O deploy é refeito com sessões rodando (depois do marco "Primeira luz"), então
// nenhum encaminhador pode encontrar arquivo pela metade:
// 1. confere os JSON da fonte antes de copiar qualquer coisa;
// 2. grava cada arquivo num temporário na mesma pasta e renomeia por cima do
//    anterior (arquivos iguais nem são regravados);
// 3. só depois remove o que não existe mais na fonte.
// Rodar duas vezes dá o mesmo resultado.

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isInsideOneDrive, oneDriveWarning, resolveDataDir } from '../server/config.js';

/** `capture/` do repositório. */
export const SOURCE_DIR = fileURLToPath(new URL('../capture', import.meta.url));

/** Pasta da cópia instalada dentro do diretório de dados (ADR 0005). */
export const MARKETPLACE_DIR_NAME = 'marketplace';

export const MARKETPLACE_NAME = 'agent-quest-local';
export const PLUGIN_NAME = 'agent-quest';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** Caminhos dentro de `capture/` (e da cópia). */
export const MARKETPLACE_FILE = path.join('.claude-plugin', 'marketplace.json');
export const PLUGIN_DIR = path.join('plugins', PLUGIN_NAME);
export const PLUGIN_FILE = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
export const HOOKS_FILE = path.join(PLUGIN_DIR, 'hooks', 'hooks.json');
export const FORWARDER_FILE = path.join(PLUGIN_DIR, 'scripts', 'forward.mjs');

/** Os 15 eventos do ADR 0001. */
export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
]);

/** O único hook aceito em cada evento: forma exec, assíncrono, sem matcher. */
export const EXPECTED_HOOK = Object.freeze({
  type: 'command',
  command: 'node',
  args: Object.freeze(['${CLAUDE_PLUGIN_ROOT}/scripts/forward.mjs']),
  async: true,
});

/**
 * No Windows, renomear por cima de um arquivo que outro processo está lendo
 * (um encaminhador começando, o antivírus, o indexador) falha com EPERM por
 * instantes. Tenta por cerca de 2 s; se não der, o arquivo anterior fica
 * inteiro e o deploy avisa para rodar de novo.
 */
const RENAME_RETRIES = 50;
const RENAME_RETRY_DELAY_MS = 40;
const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * @typedef {{ op: 'write'|'unchanged'|'remove', file: string }} DeployStep
 *   `file` relativo à pasta de destino, com o separador do sistema
 */

/**
 * Confere a captura numa pasta (a fonte, antes de copiar, ou a cópia, depois).
 * @param {string} dir
 * @returns {Promise<string[]>}  problemas encontrados; vazio se está tudo certo
 */
export async function validateCapture(dir) {
  const problems = [];
  /** @type {Map<string, any>} */
  const parsed = new Map();

  let files;
  try {
    files = await listFiles(dir);
  } catch {
    return [`pasta não encontrada: ${dir}`];
  }
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      parsed.set(file, JSON.parse(await readFile(path.join(dir, file), 'utf8')));
    } catch {
      problems.push(`${file}: JSON inválido`);
    }
  }
  for (const required of [MARKETPLACE_FILE, PLUGIN_FILE, HOOKS_FILE, FORWARDER_FILE]) {
    if (!files.includes(required)) problems.push(`${required}: arquivo ausente`);
  }

  const marketplace = parsed.get(MARKETPLACE_FILE);
  const plugin = parsed.get(PLUGIN_FILE);
  const hooks = parsed.get(HOOKS_FILE);

  if (marketplace) {
    if (marketplace.name !== MARKETPLACE_NAME) problems.push(`${MARKETPLACE_FILE}: "name" deveria ser "${MARKETPLACE_NAME}"`);
    if (typeof marketplace.owner?.name !== 'string') problems.push(`${MARKETPLACE_FILE}: falta "owner.name"`);
    const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    const entry = entries.find((/** @type {any} */ p) => p?.name === PLUGIN_NAME);
    if (entries.length !== 1 || !entry) {
      problems.push(`${MARKETPLACE_FILE}: "plugins" deveria ter só o plugin "${PLUGIN_NAME}"`);
    } else {
      if (entry.source !== `./plugins/${PLUGIN_NAME}`) problems.push(`${MARKETPLACE_FILE}: "source" deveria ser "./plugins/${PLUGIN_NAME}"`);
      if (plugin && entry.version !== plugin.version) problems.push(`${MARKETPLACE_FILE}: versão diferente da do plugin.json`);
    }
  }

  if (plugin) {
    if (plugin.name !== PLUGIN_NAME) problems.push(`${PLUGIN_FILE}: "name" deveria ser "${PLUGIN_NAME}"`);
    if (typeof plugin.version !== 'string' || plugin.version === '') problems.push(`${PLUGIN_FILE}: falta "version"`);
  }

  if (hooks) problems.push(...checkHooks(hooks).map((problem) => `${HOOKS_FILE}: ${problem}`));
  return problems;
}

/**
 * Versão da captura numa pasta, lida do plugin.json (igual à do marketplace.json
 * e do encaminhador; `validateCapture` e um teste conferem). Impressa no deploy,
 * para o usuário saber qual versão copiou.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function readCaptureVersion(dir) {
  try {
    const plugin = JSON.parse(await readFile(path.join(dir, PLUGIN_FILE), 'utf8'));
    return typeof plugin?.version === 'string' && plugin.version !== '' ? plugin.version : 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}

/**
 * Regras do hooks.json (T4): exatamente os 15 eventos, cada um com um único
 * hook igual a `EXPECTED_HOOK` e sem `matcher`.
 * @param {any} data
 * @returns {string[]}
 */
export function checkHooks(data) {
  const problems = [];
  const events = data?.hooks;
  if (events === null || typeof events !== 'object' || Array.isArray(events)) return ['falta o objeto "hooks"'];

  const names = Object.keys(events);
  const missing = HOOK_EVENTS.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !HOOK_EVENTS.includes(name));
  if (missing.length) problems.push(`eventos ausentes: ${missing.join(', ')}`);
  if (extra.length) problems.push(`eventos fora do ADR 0001: ${extra.join(', ')}`);

  for (const name of names.filter((n) => HOOK_EVENTS.includes(n))) {
    const groups = events[name];
    if (!Array.isArray(groups) || groups.length !== 1) {
      problems.push(`${name}: deveria ter um único grupo`);
      continue;
    }
    const group = groups[0];
    if (group === null || typeof group !== 'object' || 'matcher' in group) {
      problems.push(`${name}: o grupo não pode ter "matcher"`);
      continue;
    }
    const list = group.hooks;
    if (!Array.isArray(list) || list.length !== 1 || !sameHook(list[0])) {
      problems.push(`${name}: o hook deveria ser ${JSON.stringify(EXPECTED_HOOK)}`);
    }
  }
  return problems;
}

/**
 * Copia `sourceDir` para `targetDir`, arquivo por arquivo, de forma atômica, e
 * depois remove o que sobrou de uma cópia anterior.
 * @param {{ sourceDir: string, targetDir: string }} options
 * @returns {Promise<DeployStep[]>}  passos na ordem em que aconteceram
 */
export async function deployCapture({ sourceDir, targetDir }) {
  /** @type {DeployStep[]} */
  const steps = [];
  const files = await listFiles(sourceDir);
  await mkdir(targetDir, { recursive: true });

  for (const file of files) {
    const data = await readFile(path.join(sourceDir, file));
    const target = path.join(targetDir, file);
    const current = await readFile(target).catch(() => null);
    if (current && Buffer.compare(current, data) === 0) {
      steps.push({ op: 'unchanged', file });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, data);
    steps.push({ op: 'write', file });
  }

  // Só depois de tudo gravado: o que não existe mais na fonte sai da cópia.
  const keep = new Set(files);
  for (const file of await listFiles(targetDir)) {
    if (keep.has(file)) continue;
    await rm(path.join(targetDir, file), { force: true });
    steps.push({ op: 'remove', file });
  }
  await removeEmptyDirs(targetDir, targetDir);
  return steps;
}

/**
 * Comandos para o usuário, com o caminho completo da cópia (ADR 0002 e marco
 * "Primeira luz" do plano).
 * @param {{ targetDir: string, dataDir: string }} options
 * @returns {string[]}
 */
export function userInstructions({ targetDir, dataDir }) {
  const pluginDir = path.join(targetDir, PLUGIN_DIR);
  const debugFile = path.join(dataDir, 'smoke-debug.txt');
  return [
    'Teste curto, sem instalar (vale só nesta sessão):',
    `  claude --plugin-dir "${pluginDir}" --debug-file "${debugFile}"`,
    '  (apague o smoke-debug.txt depois do teste)',
    '',
    'Instalar, em escopo de usuário (uma vez):',
    `  claude plugin marketplace add "${targetDir}"`,
    `  claude plugin install ${PLUGIN_ID}`,
    '  Confira com: claude plugin list',
    '',
    'Numa sessão já aberta, rode /reload-plugins para a captura valer nela.',
    'Depois de um novo deploy, a versão nova vale com /reload-plugins ou numa sessão nova.',
    '',
    'Pausar:  claude plugin disable ' + PLUGIN_ID + '  (e /reload-plugins)',
    'Retomar: claude plugin enable ' + PLUGIN_ID + '  (e /reload-plugins)',
    `Remover: claude plugin marketplace remove ${MARKETPLACE_NAME}`,
    '',
    'Este script não executa o claude: os comandos acima são para você rodar.',
  ];
}

/**
 * Aviso do deploy com `AGENT_QUEST_HOME` definida (ADR 0005, complemento).
 * @param {string} dataDir
 * @returns {string}
 */
export function agentQuestHomeWarning(dataDir) {
  return (
    `Aviso: AGENT_QUEST_HOME está definida (${dataDir}). O servidor, o capture:deploy e o Claude Code ` +
    '(terminal e VS Code) precisam ver o mesmo valor; senão a captura procura o servidor em outra pasta ' +
    'e não envia nada. No uso normal, deixe AGENT_QUEST_HOME sem valor; para usar outra pasta, defina-a ' +
    'como variável de ambiente do usuário do Windows e reabra os terminais e o VS Code.'
  );
}

/**
 * Executa o deploy e devolve o código de saída. Recebe tudo por parâmetro, para
 * os testes nunca usarem o diretório de dados real.
 * @param {{ env: Record<string, string|undefined>, platform: string, homedir: string, sourceDir?: string, log?: (line: string) => void, error?: (line: string) => void }} options
 * @returns {Promise<number>}
 */
export async function runDeploy({ env, platform, homedir, sourceDir = SOURCE_DIR, log = console.log, error = console.error }) {
  const problems = await validateCapture(sourceDir);
  if (problems.length) {
    error('A captura em capture/ tem problemas; nada foi copiado:');
    for (const problem of problems) error(`  - ${problem}`);
    return 1;
  }

  const dataDir = resolveDataDir({ env, platform, homedir });
  const targetDir = path.join(dataDir, MARKETPLACE_DIR_NAME);
  let steps;
  try {
    steps = await deployCapture({ sourceDir, targetDir });
  } catch (err) {
    error(`Não foi possível copiar a captura para ${targetDir} (${errorKind(err)}).`);
    error(
      'Cada arquivo da cópia está inteiro (na versão anterior ou na nova), mas a instalação pode ter ficado ' +
        'misturada entre as duas versões. Rode o deploy de novo (se algum arquivo estava em uso, espere um instante).',
    );
    return 1;
  }
  const after = await validateCapture(targetDir);
  if (after.length) {
    error(`A cópia em ${targetDir} ficou com problemas:`);
    for (const problem of after) error(`  - ${problem}`);
    return 1;
  }

  const count = (/** @type {DeployStep['op']} */ op) => steps.filter((step) => step.op === op).length;
  log(`Captura copiada para ${targetDir}`);
  log(`  ${count('write')} arquivo(s) gravado(s), ${count('unchanged')} sem mudança, ${count('remove')} removido(s).`);
  log(`  Versão da captura: ${await readCaptureVersion(targetDir)}`);
  // ADR 0005, complemento: o encaminhador resolve o diretório com o ambiente do Claude Code.
  if (env.AGENT_QUEST_HOME) log(agentQuestHomeWarning(dataDir));
  if (isInsideOneDrive(dataDir, { env, platform })) log(oneDriveWarning(dataDir));
  log('');
  for (const line of userInstructions({ targetDir, dataDir })) log(line);
  return 0;
}

/**
 * Lista os arquivos de uma pasta, com subpastas, em ordem, relativos a ela.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} relative */
  async function walk(relative) {
    const entries = await readdir(path.join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) found.push(child);
    }
  }
  await walk('');
  return found.sort();
}

/**
 * Remove pastas vazias dentro de `dir` (nunca a própria raiz).
 * @param {string} dir
 * @param {string} root
 * @returns {Promise<boolean>}  true se `dir` ficou vazia
 */
async function removeEmptyDirs(dir, root) {
  const entries = await readdir(dir, { withFileTypes: true });
  let empty = true;
  for (const entry of entries) {
    if (entry.isDirectory() && (await removeEmptyDirs(path.join(dir, entry.name), root))) continue;
    empty = false;
  }
  if (empty && dir !== root) {
    await rmdir(dir).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Grava num temporário na mesma pasta e renomeia por cima do destino.
 * @param {string} target
 * @param {Uint8Array} data
 */
async function writeAtomic(target, data) {
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data);
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(temp, target);
        return;
      } catch (err) {
        if (attempt >= RENAME_RETRIES || !RETRYABLE_RENAME_ERRORS.has(/** @type {any} */ (err)?.code)) throw err;
        await sleep(RENAME_RETRY_DELAY_MS);
      }
    }
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * @param {any} hook
 * @returns {boolean}
 */
function sameHook(hook) {
  if (hook === null || typeof hook !== 'object') return false;
  const keys = Object.keys(hook).sort();
  if (keys.join(',') !== Object.keys(EXPECTED_HOOK).sort().join(',')) return false;
  return (
    hook.type === EXPECTED_HOOK.type &&
    hook.command === EXPECTED_HOOK.command &&
    hook.async === EXPECTED_HOOK.async &&
    Array.isArray(hook.args) &&
    hook.args.length === EXPECTED_HOOK.args.length &&
    hook.args.every((/** @type {unknown} */ arg, /** @type {number} */ i) => arg === EXPECTED_HOOK.args[i])
  );
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorKind(err) {
  const e = /** @type {any} */ (err);
  return String(e?.code ?? e?.name ?? 'Error');
}

/** @returns {boolean} */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await runDeploy({ env: process.env, platform: process.platform, homedir: os.homedir() });
}
