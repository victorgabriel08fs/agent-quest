// @ts-check
// Sonda de contexto (T15; modelo de eventos, seção 6, "Contexto"; ADR 0008).
//
// Lê o fim do transcript de um agente e calcula o uso aproximado da janela de
// contexto:
// - só os últimos 64 KiB do arquivo (MAX_READ_BYTES);
// - da última resposta com `message.usage`: `usedTokens = input_tokens +
//   cache_creation_input_tokens + cache_read_input_tokens`;
// - de trás para a frente, a leitura para na marca de compactação (entrada
//   `type: "system"`, `subtype: "compact_boundary"`): marca antes de qualquer
//   resposta com `usage` dá `null`, e a barra some até a próxima resposta. No
//   transcript da sessão principal, a marca com `isSidechain: true` é
//   ignorada, como as respostas;
// - janela pelo modelo da própria resposta (`message.model`; sem ele, o modelo
//   pedido, só na sessão principal): 1 milhão por padrão; 200 mil só para as
//   famílias sem 1M nativo (Opus e Sonnet até 4.6, Haiku 4.x e Claude 3.x)
//   quando o modelo pedido não termina em `[1m]`; uso acima de 200 mil vale
//   sempre 1 milhão (seção 6, "Janela"; decisão do usuário de 26/10/2026);
// - só arquivos `.jsonl` dentro de `~/.claude/projects/`, conferido no caminho
//   resolvido e, depois, no caminho real (sem escapar por `..`, link simbólico
//   ou junção). Caminho fora da pasta é recusado antes de qualquer acesso ao
//   disco;
// - qualquer falha (arquivo ausente, formato desconhecido, erro de leitura)
//   devolve `null`, sem exceção, e a barra some no painel.
//
// O formato do transcript é interno do Claude Code e muda entre versões
// (docs/pesquisa/hooks-claude-code.md, seção 8): tudo é lido de forma
// defensiva. Nada do conteúdo sai daqui, só os três números.
//
// `createContextProbe` agenda as leituras fora do caminho do `apply`: no
// máximo uma leitura por agente a cada 5 s (a última pedida dentro do
// intervalo sai no fim dele, para o valor final não se perder), uma leitura
// de cada vez no servidor, tudo assíncrono e sem lançar.

import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

/** Bytes lidos do fim do arquivo. */
export const MAX_READ_BYTES = 64 * 1024;

/** No máximo uma leitura por agente neste intervalo (ms). */
export const READ_INTERVAL_MS = 5000;

/** Janela das famílias sem 1M nativo (tokens). */
export const SMALL_WINDOW_TOKENS = 200_000;
/** Janela padrão, de 1 milhão (tokens). */
export const DEFAULT_WINDOW_TOKENS = 1_000_000;

/**
 * Famílias sem janela de 1 milhão nativa: Opus e Sonnet até 4.6, Haiku 4.x e
 * Claude 3.x (padrão de referência da seção 6, "Janela").
 */
const SMALL_WINDOW_MODEL = /^claude-(?:3(?:-\d)?-[a-z]+|(?:opus|sonnet)-4(?:-[0-6])?|haiku-4(?:-\d)?)(?:-\d{8})?$/i;

/** Sufixo do modelo pedido que pede a janela de 1 milhão. */
const ONE_MILLION_SUFFIX = /\[1m\]$/i;

/** Leituras em andamento ao mesmo tempo, no servidor inteiro. */
export const MAX_CONCURRENT_READS = 1;

/**
 * Agentes acompanhados pela sonda; acima disso, sai o de leitura mais antiga
 * sem leitura pendente (o início dessa leitura fica guardado à parte, para o
 * intervalo de 5 s continuar valendo).
 */
export const MAX_TRACKED_AGENTS = 2000;

const EXTENSION = '.jsonl';
const CASE_INSENSITIVE = process.platform === 'win32';

/**
 * @typedef {object} ContextUsage
 * @property {number} pct            0 a 100, inteiro
 * @property {number} usedTokens
 * @property {number} windowTokens
 */

/**
 * @typedef {object} ReadOptions
 * @property {string|null} root       pasta `~/.claude/projects` (os testes injetam uma temporária)
 * @property {string|null} [model]    modelo pedido no SessionStart (só vale na sessão principal)
 * @property {boolean} [main]         transcript da sessão principal: ignora entradas `isSidechain`
 * @property {number} [maxBytes]      padrão MAX_READ_BYTES
 */

/**
 * Uso de contexto no fim de um transcript.
 * @param {unknown} file
 * @param {ReadOptions} options
 * @returns {Promise<ContextUsage|null>}  nunca rejeita
 */
export async function readContextUsage(file, { root, model = null, main = false, maxBytes = MAX_READ_BYTES }) {
  try {
    const real = await allowedFile(file, root);
    if (real === null) return null;
    const text = await readTail(real, maxBytes);
    if (text === null) return null;
    const last = lastUsage(text.content, { complete: text.complete, main });
    if (last === null) return null;
    // O modelo pedido só é conhecido para a sessão principal (SessionStart).
    return contextUsage(last.usedTokens, { requested: main ? model : null, observed: last.model });
  } catch {
    return null;
  }
}

/**
 * Janela e porcentagem a partir dos tokens usados (seção 6, "Janela"):
 * 1. uso acima de 200 mil → 1 milhão;
 * 2. o modelo é o `observed` (o `message.model` da resposta lida); sem ele,
 *    o `requested` sem o `[1m]`; sem nenhum dos dois, o padrão;
 * 3. modelo de uma família sem 1M nativo, e `requested` sem `[1m]` no fim →
 *    200 mil;
 * 4. qualquer outro modelo, inclusive desconhecido → 1 milhão.
 * @param {number} usedTokens
 * @param {{ requested?: unknown, observed?: unknown }} [models]
 *   `requested`: modelo pedido no SessionStart (só da sessão principal);
 *   `observed`: `message.model` da resposta lida
 * @returns {ContextUsage}
 */
export function contextUsage(usedTokens, { requested = null, observed = null } = {}) {
  const windowTokens = windowFor(usedTokens, modelName(requested), modelName(observed));
  const pct = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
  return { pct, usedTokens, windowTokens };
}

/**
 * @param {number} usedTokens
 * @param {string|null} requested
 * @param {string|null} observed
 * @returns {number}
 */
function windowFor(usedTokens, requested, observed) {
  if (usedTokens > SMALL_WINDOW_TOKENS) return DEFAULT_WINDOW_TOKENS;
  if (requested !== null && ONE_MILLION_SUFFIX.test(requested)) return DEFAULT_WINDOW_TOKENS;
  const model = observed ?? (requested === null ? null : modelName(requested.replace(ONE_MILLION_SUFFIX, '')));
  return model !== null && SMALL_WINDOW_MODEL.test(model) ? SMALL_WINDOW_TOKENS : DEFAULT_WINDOW_TOKENS;
}

/**
 * Nome de modelo sem espaços nas pontas; `null` se não for texto ou for vazio.
 * @param {unknown} value
 * @returns {string|null}
 */
function modelName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name === '' ? null : name;
}

/**
 * Caminho do transcript de um agente (seção 6): `transcript_path` para a
 * sessão principal; para um subagente, o `agent_transcript_path` do
 * SubagentStop ou, sem ele, `<pasta do transcript>/<session_id>/subagents/
 * agent-<agent_id>.jsonl`. Ids que poderiam mudar a pasta (`.`, `..`, `:`,
 * barras) dão `null`. Só monta o caminho: quem confere a pasta permitida é a
 * leitura.
 * @param {{ agentKey: string, sessionId: string, transcriptPath: string|null, agentTranscriptPath?: string|null }} source
 * @returns {string|null}
 */
export function transcriptPathFor({ agentKey, sessionId, transcriptPath, agentTranscriptPath = null }) {
  if (agentKey === 'main') {
    if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
    // Um caminho de transcript de subagente não é o da sessão principal.
    return isSubagentFile(transcriptPath) ? null : transcriptPath;
  }
  if (!isSafeName(agentKey)) return null;
  if (typeof agentTranscriptPath === 'string' && agentTranscriptPath !== '') return agentTranscriptPath;
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  if (path.basename(transcriptPath) === `agent-${agentKey}${EXTENSION}`) return transcriptPath;
  if (isSubagentFile(transcriptPath) || !isSafeName(sessionId)) return null;
  return path.join(path.dirname(transcriptPath), sessionId, 'subagents', `agent-${agentKey}${EXTENSION}`);
}

// ---------------------------------------------------------------------------
// Pasta permitida e leitura
// ---------------------------------------------------------------------------

/**
 * Caminho real do arquivo, se for um `.jsonl` dentro da raiz; senão `null`.
 * A primeira conferência é só de texto (caminho resolvido): caminho fora da
 * raiz nem chega ao disco. A segunda usa os caminhos reais, para um link
 * simbólico ou uma junção dentro da raiz não levar a um arquivo de fora.
 * @param {unknown} file
 * @param {unknown} root
 * @returns {Promise<string|null>}
 */
async function allowedFile(file, root) {
  if (typeof file !== 'string' || typeof root !== 'string' || file === '' || root === '') return null;
  if (file.includes('\0') || root.includes('\0')) return null;
  if (!path.isAbsolute(file) || !path.isAbsolute(root)) return null;
  const resolved = path.resolve(file);
  const base = path.resolve(root);
  if (!hasExtension(resolved) || !isInside(base, resolved)) return null;
  const [realBase, realFile] = await Promise.all([fs.realpath(base), fs.realpath(resolved)]);
  if (!hasExtension(realFile) || !isInside(realBase, realFile)) return null;
  return realFile;
}

/**
 * Lê no máximo `maxBytes` do fim do arquivo. `complete` diz se o trecho
 * começa no início do arquivo (senão, a primeira linha está partida).
 * @param {string} file
 * @param {number} maxBytes
 * @returns {Promise<{ content: string, complete: boolean }|null>}
 */
async function readTail(file, maxBytes) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_READ_BYTES) : MAX_READ_BYTES;
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, limit);
    if (length === 0) return null;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    return { content: buffer.toString('utf8', 0, bytesRead), complete: length === stat.size };
  } finally {
    await handle.close();
  }
}

/**
 * Tokens (e modelo) da última resposta com `message.usage` válido, de trás
 * para a frente, até a marca de compactação. Linha que não é JSON, entrada
 * sem `usage` ou com números fora do formato esperado é pulada. Uso zero (por
 * exemplo, mensagem sintética de erro) não conta como resposta. Uma marca de
 * compactação antes de qualquer resposta dá `null`.
 * @param {string} content
 * @param {{ complete: boolean, main: boolean }} options
 * @returns {{ usedTokens: number, model: unknown }|null}   `model`: o `message.model` da resposta, como veio
 */
function lastUsage(content, { complete, main }) {
  const lines = content.split('\n');
  // O trecho começou no meio de uma linha: ela não serve.
  const first = complete ? 0 : 1;
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i].trim();
    if (line === '' || (!line.includes('"usage"') && !line.includes('"compact_boundary"'))) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // No transcript da sessão principal, uma entrada de subagente não é dela.
    if (!isPlainObject(entry) || (main && entry.isSidechain === true)) continue;
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return null;
    const used = usedTokensOf(entry);
    if (used !== null) return { usedTokens: used, model: /** @type {Record<string, any>} */ (entry.message).model };
  }
  return null;
}

/**
 * @param {Record<string, any>} entry
 * @returns {number|null}
 */
function usedTokensOf(entry) {
  const message = entry.message;
  if (!isPlainObject(message)) return null;
  if (entry.type !== 'assistant' && message.role !== 'assistant') return null;
  const usage = message.usage;
  if (!isPlainObject(usage)) return null;
  const input = tokenCount(usage.input_tokens, { required: true });
  const creation = tokenCount(usage.cache_creation_input_tokens, { required: false });
  const read = tokenCount(usage.cache_read_input_tokens, { required: false });
  if (input === null || creation === null || read === null) return null;
  const used = input + creation + read;
  return used > 0 && Number.isSafeInteger(used) ? used : null;
}

/**
 * @param {unknown} value
 * @param {{ required: boolean }} options   campo opcional ausente vale 0
 * @returns {number|null}
 */
function tokenCount(value, { required }) {
  if (value === undefined || value === null) return required ? null : 0;
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null;
}

/**
 * @param {string} base
 * @param {string} target
 * @returns {boolean}   `target` está dentro de `base` (e não é a própria `base`)
 */
function isInside(base, target) {
  const relative = path.relative(base, target);
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** @param {string} file */
function hasExtension(file) {
  const name = path.basename(file);
  const ext = CASE_INSENSITIVE ? name.toLowerCase() : name;
  // `:` fora da letra da unidade abriria um fluxo alternativo no Windows.
  return ext.endsWith(EXTENSION) && name.length > EXTENSION.length && !name.includes(':');
}

/** @param {string} file */
function isSubagentFile(file) {
  return /^agent-.+\.jsonl$/i.test(path.basename(file)) && path.basename(path.dirname(file)).toLowerCase() === 'subagents';
}

/**
 * Id que pode virar parte de um caminho sem mudar a pasta.
 * @param {unknown} value
 */
function isSafeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(value) && value !== '.' && value !== '..';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Agendamento
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ProbeTimers
 * @property {(run: () => void, ms: number) => any} setTimeout
 * @property {(handle: any) => void} clearTimeout
 */

/**
 * @typedef {object} ProbeRequest
 * @property {string} sessionId
 * @property {string} agentKey
 * @property {string|null} path       transcript do agente (transcriptPathFor)
 * @property {string|null} [model]
 */

/**
 * @typedef {object} ContextProbe
 * @property {(request: ProbeRequest) => void} request   pede uma leitura (respeita o intervalo)
 * @property {(sessionId: string) => void} forgetSession  sessão saiu da memória
 * @property {() => void} stop                            cancela as leituras agendadas
 * @property {() => Promise<void>} settled                espera as leituras em andamento (testes)
 */

/**
 * @typedef {object} ProbeOptions
 * @property {string|null} root
 * @property {(sessionId: string, agentKey: string, usage: ContextUsage|null, at: number) => void} onResult
 * @property {typeof readContextUsage} [read]
 * @property {() => number} [clock]
 * @property {ProbeTimers} [timers]
 * @property {number} [intervalMs]
 * @property {(message: string) => void} [logError]
 */

/**
 * @typedef {object} Entry
 * @property {string} sessionId
 * @property {string} agentKey
 * @property {string|null} path
 * @property {string|null} model
 * @property {number|null} lastStart
 * @property {any} timer
 * @property {boolean} queued
 * @property {boolean} running
 * @property {boolean} again          pedido chegou durante a leitura
 * @property {boolean} forgotten
 */

/**
 * Agenda as leituras do contexto, fora do caminho do `apply`. Nunca lança:
 * erro de leitura vira `null`, e erro de quem recebe o resultado só vai ao
 * log, com o tipo.
 * @param {ProbeOptions} options
 * @returns {ContextProbe}
 */
export function createContextProbe({
  root,
  onResult,
  read = readContextUsage,
  clock = Date.now,
  timers = { setTimeout, clearTimeout },
  intervalMs = READ_INTERVAL_MS,
  logError = () => {},
}) {
  /** @type {Map<string, Map<string, Entry>>} */
  const sessions = new Map();
  /** @type {Entry[]} */
  const queue = [];
  /** @type {Set<Promise<void>>} */
  const running = new Set();
  let tracked = 0;
  /**
   * Início da última leitura dos agentes despejados, para o intervalo de 5 s
   * continuar valendo se um deles for pedido de novo. Só guarda leituras ainda
   * dentro do intervalo, e no máximo MAX_TRACKED_AGENTS (sai o mais antigo).
   * Chave: `recentKey(sessionId, agentKey)`.
   * @type {Map<string, number>}
   */
  const recent = new Map();

  /** @param {Entry} entry */
  function schedule(entry) {
    if (entry.queued || entry.running || entry.timer !== null) return;
    const wait = entry.lastStart === null ? 0 : entry.lastStart + intervalMs - clock();
    if (wait <= 0) {
      enqueue(entry);
      return;
    }
    entry.timer = timers.setTimeout(() => {
      entry.timer = null;
      if (!entry.forgotten) enqueue(entry);
    }, wait);
    entry.timer?.unref?.();
  }

  /** @param {Entry} entry */
  function enqueue(entry) {
    entry.queued = true;
    queue.push(entry);
    pump();
  }

  function pump() {
    while (running.size < MAX_CONCURRENT_READS && queue.length > 0) {
      const entry = /** @type {Entry} */ (queue.shift());
      entry.queued = false;
      if (entry.forgotten) continue;
      const task = run(entry).finally(() => {
        running.delete(task);
        pump();
      });
      running.add(task);
    }
  }

  /** @param {Entry} entry */
  async function run(entry) {
    entry.running = true;
    entry.again = false;
    entry.lastStart = clock();
    /** @type {ContextUsage|null} */
    let usage = null;
    try {
      usage = entry.path === null ? null : await read(entry.path, { root, model: entry.model, main: entry.agentKey === 'main' });
    } catch {
      usage = null;
    } finally {
      entry.running = false;
    }
    if (entry.forgotten) return;
    try {
      onResult(entry.sessionId, entry.agentKey, usage, clock());
    } catch (err) {
      logError(`Erro ao aplicar o uso de contexto: ${errorKind(err)}`);
    }
    if (entry.again) schedule(entry);
  }

  /**
   * Tira o agente com a leitura mais antiga (menor `lastStart`) entre os que
   * não têm leitura pendente, para a memória não crescer sem limite. O
   * `lastStart` dele fica guardado em `recent` enquanto estiver dentro do
   * intervalo.
   */
  function evict() {
    /** @type {Entry|null} */
    let oldest = null;
    for (const agents of sessions.values()) {
      for (const entry of agents.values()) {
        if (entry.queued || entry.running || entry.timer !== null) continue;
        if (oldest === null || (entry.lastStart ?? -Infinity) < (oldest.lastStart ?? -Infinity)) oldest = entry;
      }
    }
    if (oldest === null) return;
    const agents = /** @type {Map<string, Entry>} */ (sessions.get(oldest.sessionId));
    agents.delete(oldest.agentKey);
    tracked--;
    if (agents.size === 0) sessions.delete(oldest.sessionId);
    if (oldest.lastStart !== null) remember(oldest.sessionId, oldest.agentKey, oldest.lastStart);
  }

  /**
   * @param {string} sessionId
   * @param {string} agentKey
   * @param {number} lastStart
   */
  function remember(sessionId, agentKey, lastStart) {
    const now = clock();
    // Tira do começo as que já saíram do intervalo (a ordem é a do despejo).
    for (const [key, start] of recent) {
      if (start + intervalMs > now) break;
      recent.delete(key);
    }
    if (lastStart + intervalMs <= now) return;
    const key = recentKey(sessionId, agentKey);
    recent.delete(key);
    recent.set(key, lastStart);
    if (recent.size > MAX_TRACKED_AGENTS) recent.delete(/** @type {string} */ (recent.keys().next().value));
  }

  /**
   * `lastStart` guardado de um agente despejado (e esquece o registro).
   * @param {string} sessionId
   * @param {string} agentKey
   * @returns {number|null}
   */
  function recall(sessionId, agentKey) {
    const key = recentKey(sessionId, agentKey);
    const start = recent.get(key);
    if (start === undefined) return null;
    recent.delete(key);
    return start + intervalMs > clock() ? start : null;
  }

  return {
    request({ sessionId, agentKey, path: file, model = null }) {
      if (typeof sessionId !== 'string' || typeof agentKey !== 'string') return;
      let agents = sessions.get(sessionId);
      if (!agents) {
        agents = new Map();
        sessions.set(sessionId, agents);
      }
      let entry = agents.get(agentKey);
      if (!entry) {
        if (tracked >= MAX_TRACKED_AGENTS) evict();
        // `evict` pode ter tirado a última entrada desta mesma sessão.
        if (!sessions.has(sessionId)) sessions.set(sessionId, agents);
        const lastStart = recall(sessionId, agentKey);
        entry = { sessionId, agentKey, path: null, model: null, lastStart, timer: null, queued: false, running: false, again: false, forgotten: false };
        agents.set(agentKey, entry);
        tracked++;
      }
      // O pedido mais recente decide o caminho da próxima leitura.
      entry.path = file ?? null;
      entry.model = model ?? null;
      if (entry.running) entry.again = true;
      else schedule(entry);
    },
    forgetSession(sessionId) {
      if (typeof sessionId !== 'string') return;
      const prefix = recentKey(sessionId, '');
      for (const key of recent.keys()) {
        if (key.startsWith(prefix)) recent.delete(key);
      }
      const agents = sessions.get(sessionId);
      if (!agents) return;
      for (const entry of agents.values()) {
        entry.forgotten = true;
        if (entry.timer !== null) timers.clearTimeout(entry.timer);
        entry.timer = null;
      }
      tracked -= agents.size;
      sessions.delete(sessionId);
    },
    stop() {
      for (const agents of sessions.values()) {
        for (const entry of agents.values()) {
          if (entry.timer !== null) timers.clearTimeout(entry.timer);
          entry.timer = null;
        }
      }
    },
    async settled() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}

/**
 * Chave de um agente no registro dos despejados. O tamanho do `sessionId` na
 * frente evita que duas combinações diferentes deem a mesma chave.
 * @param {string} sessionId
 * @param {string} agentKey
 */
function recentKey(sessionId, agentKey) {
  return `${sessionId.length}:${sessionId}:${agentKey}`;
}

/**
 * Tipo do erro, sem a mensagem.
 * @param {unknown} err
 * @returns {string}
 */
function errorKind(err) {
  const e = /** @type {any} */ (err);
  return String(e?.code ?? e?.name ?? 'Error');
}
