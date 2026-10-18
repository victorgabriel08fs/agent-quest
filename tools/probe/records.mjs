// Leitura dos registros da sonda do T0, usada pelo relatório e pela sanitização.
//
// Duas fontes viram o mesmo formato (ProbeRecord):
// - o JSONL bruto gravado por plugin/scripts/dump.mjs, em que a ordem das
//   linhas é a ordem de chegada (gravação);
// - os cenários sanitizados de test/fixtures/hooks/*.json, no formato
//   { name, description, events: [{ dt, env, payload }] }, em que `dt` é o
//   intervalo em ms desde o evento anterior do cenário (0 no primeiro) e
//   `env` é o mesmo `env` do envelope v1: { projectDir, entrypoint }.

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Intervalo artificial entre cenários lidos juntos, para nenhuma janela de tempo cruzar dois cenários. */
const FIXTURE_GAP_MS = 10 * 60 * 1000;

/**
 * @typedef {object} ProbeRecord
 * @property {number} index        posição na leitura (ordem de chegada), a partir de 0
 * @property {string} source       arquivo de origem
 * @property {number} line         linha do JSONL ou posição no cenário, a partir de 1
 * @property {number} receivedAt   início do processo do hook (ms); nos cenários, tempo acumulado dos dt
 * @property {number} writtenAt    momento da gravação (ms); nos cenários, igual a receivedAt
 * @property {number} bytes        tamanho do payload em bytes
 * @property {boolean} raw         true para o JSONL bruto, false para cenário sanitizado
 * @property {{ names: string[]|null, projectDir: string|null, entrypoints: Record<string, string> }} env
 *   names: nomes das variáveis (null nos cenários); entrypoints: variáveis que podem indicar o cliente
 * @property {Record<string, any>} payload
 */

/** Diretório de dados (mesma regra do servidor, ADR 0005). */
export function resolveDataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  const custom = (env.AGENT_QUEST_HOME || '').trim();
  if (custom) return path.resolve(custom);
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'agent-quest');
  }
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'agent-quest');
}

/** Pasta da sonda: <dados>/probe. */
export function probeDir(env = process.env) {
  return path.join(resolveDataDir(env), 'probe');
}

/** Raiz do repositório (tools/probe fica dois níveis abaixo). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Caminho para mostrar na tela, sem o nome do usuário: relativo ao repositório
 * quando está dentro dele; senão com %LOCALAPPDATA% ou ~ no lugar do começo.
 * @param {string} target
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 */
export function displayPath(target, env = process.env, home = os.homedir()) {
  if (typeof target !== 'string' || !target) return target;
  const absolute = path.resolve(target);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const bases = [[env.LOCALAPPDATA, '%LOCALAPPDATA%'], [home, '~']];
  for (const [base, label] of bases) {
    if (!base) continue;
    const prefix = base.replace(/[\\/]+$/, '');
    const head = absolute.slice(0, prefix.length);
    const next = absolute.charAt(prefix.length);
    const sameHead = process.platform === 'win32' ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
    if (sameHead && (next === '' || next === '\\' || next === '/')) return `${label}${absolute.slice(prefix.length)}`;
  }
  return absolute;
}

/**
 * Lê o JSONL bruto do dump.mjs. Linhas inválidas ou sem payload viram `problems`.
 * @param {string} text
 * @param {string} source
 * @returns {{ records: ProbeRecord[], problems: { source: string, line: number, problem: string }[] }}
 */
export function parseJsonl(text, source) {
  const records = [];
  const problems = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      problems.push({ source, line: i + 1, problem: 'linha não é JSON' });
      continue;
    }
    if (!isObject(entry) || !isObject(entry.payload)) {
      const code = isObject(entry) && typeof entry.error === 'string' ? ` (${safeToken(entry.error)})` : '';
      problems.push({ source, line: i + 1, problem: `registro sem payload${code}` });
      continue;
    }
    if (typeof entry.payload.hook_event_name !== 'string') {
      problems.push({ source, line: i + 1, problem: 'payload sem hook_event_name' });
      continue;
    }
    const env = isObject(entry.env) ? entry.env : {};
    const values = isObject(env.values) ? env.values : {};
    const entrypoints = {};
    for (const [name, value] of Object.entries(values)) {
      if (name !== 'CLAUDE_PROJECT_DIR' && typeof value === 'string') entrypoints[name] = value;
    }
    const receivedAt = finite(entry.receivedAt);
    records.push({
      index: records.length,
      source,
      line: i + 1,
      receivedAt,
      writtenAt: finite(entry.writtenAt) || receivedAt,
      bytes: finite(entry.bytes) || Buffer.byteLength(JSON.stringify(entry.payload)),
      raw: true,
      env: {
        names: Array.isArray(env.names) ? env.names.filter((n) => typeof n === 'string') : [],
        projectDir: typeof values.CLAUDE_PROJECT_DIR === 'string' ? values.CLAUDE_PROJECT_DIR : null,
        entrypoints,
      },
      payload: entry.payload,
    });
  }
  return { records, problems };
}

/**
 * Lê um cenário sanitizado. Os tempos começam em `baseTime` e somam os `dt`.
 * @param {any} fixture
 * @param {string} source
 * @param {number} [baseTime]
 * @returns {{ records: ProbeRecord[], problems: { source: string, line: number, problem: string }[], endTime: number }}
 */
export function parseFixture(fixture, source, baseTime = 0) {
  const records = [];
  const problems = [];
  if (!isObject(fixture) || !Array.isArray(fixture.events)) {
    problems.push({ source, line: 0, problem: 'não é um cenário { name, description, events }' });
    return { records, problems, endTime: baseTime };
  }
  let time = baseTime;
  fixture.events.forEach((event, i) => {
    if (!isObject(event) || !isObject(event.payload) || typeof event.payload.hook_event_name !== 'string') {
      problems.push({ source, line: i + 1, problem: 'evento sem payload ou sem hook_event_name' });
      return;
    }
    time += Number.isFinite(event.dt) && event.dt > 0 ? event.dt : 0;
    const env = isObject(event.env) ? event.env : {};
    records.push({
      index: records.length,
      source,
      line: i + 1,
      receivedAt: time,
      writtenAt: time,
      bytes: Buffer.byteLength(JSON.stringify(event.payload)),
      raw: false,
      env: {
        names: null,
        projectDir: typeof env.projectDir === 'string' ? env.projectDir : null,
        entrypoints: typeof env.entrypoint === 'string' ? { entrypoint: env.entrypoint } : {},
      },
      payload: event.payload,
    });
  });
  return { records, problems, endTime: time };
}

/**
 * Lê arquivos .jsonl (bruto), arquivos .json (cenário) e pastas (todos os .json
 * dentro, em ordem alfabética). Os índices seguem a ordem de leitura.
 * @param {string[]} inputs
 */
export function loadInputs(inputs) {
  /** @type {ProbeRecord[]} */
  const records = [];
  const problems = [];
  const sources = [];
  let baseTime = 0;
  for (const input of inputs) {
    const stat = fs.statSync(input, { throwIfNoEntry: false });
    if (!stat) {
      problems.push({ source: input, line: 0, problem: 'arquivo não encontrado' });
      continue;
    }
    const files = stat.isDirectory()
      ? fs.readdirSync(input).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(input, f))
      : [input];
    for (const file of files) {
      sources.push(file);
      const text = fs.readFileSync(file, 'utf8');
      let parsed;
      if (file.endsWith('.jsonl')) {
        parsed = parseJsonl(text, file);
      } else {
        let fixture;
        try {
          fixture = JSON.parse(text);
        } catch {
          problems.push({ source: file, line: 0, problem: 'JSON inválido' });
          continue;
        }
        parsed = parseFixture(fixture, file, baseTime);
        baseTime = parsed.endTime + FIXTURE_GAP_MS;
      }
      for (const record of parsed.records) records.push(record);
      for (const problem of parsed.problems) problems.push(problem);
    }
  }
  records.forEach((record, i) => {
    record.index = i;
  });
  return { records, problems, sources };
}

/** JSON com as chaves dos objetos em ordem alfabética. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Mesmo inputHash do modelo de eventos (seção 2): SHA-256 com chaves ordenadas, 16 caracteres. */
export function inputHash(input) {
  return createHash('sha256').update(stableStringify(input ?? null)).digest('hex').slice(0, 16);
}

/** Devolve o valor se for um identificador curto (nome de evento, ferramenta, status); senão '<valor>'. */
export function safeToken(value) {
  return typeof value === 'string' && /^[\w.:@\-[\]]{1,64}$/.test(value) ? value : '<valor>';
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** true quando o módulo é o script chamado na linha de comando. */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  const self = fileURLToPath(metaUrl);
  return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

function finite(value) {
  return Number.isFinite(value) ? value : 0;
}
