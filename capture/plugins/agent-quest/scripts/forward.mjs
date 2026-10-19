// @ts-check
// Encaminhador da captura do Agent Quest (ADR 0001; modelo de eventos, seção 1).
//
// Roda como hook `command` assíncrono do plugin agent-quest, um processo por
// evento. Recebe o JSON do hook no stdin e faz POST de um envelope v1 para o
// servidor local em 127.0.0.1, na porta do runtime.json.
//
// Regras que nunca podem ser quebradas (o Claude Code não pode ser atrapalhado):
// - nunca escreve em stdout nem em stderr (em hook assíncrono, o stdout chega ao
//   modelo no turno seguinte);
// - sempre sai com código 0, em qualquer caso;
// - se encerra sozinho em no máximo 2 s; o POST desiste em 1 s;
// - só envia para 127.0.0.1, na porta do runtime.json, de 1024 a 65535;
// - sem dependências, só com APIs do Node 18 ou mais novo (o PATH do Claude Code
//   pode apontar para outra versão do Node). Por isso não usa `fetch`, que no
//   Node 18 imprime um aviso de recurso experimental.
//
// O corpo enviado nunca passa de 1 000 000 bytes: a redução tem até três passos
// genéricos, parando no primeiro que couber (`buildBody`).
//
// Ordem (ADR 0001): lê o stdin até o fim, depois o runtime.json; sem servidor
// no ar, sai sem nem interpretar o JSON. Tudo fica num arquivo só, para um
// deploy feito com sessões rodando nunca juntar versões diferentes de dois módulos.
//
// As funções são exportadas para os testes; o encaminhamento só roda quando o
// arquivo é o ponto de entrada (`node forward.mjs`).

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

/** `Date.now()` no início do processo: vira o `sentAt` do envelope. */
const startedAt = Date.now();

/** Versão do encaminhador (igual à do plugin.json; um teste confere). */
export const FORWARDER_VERSION = '0.1.2';

/** Único destino possível (ADR 0006). */
export const HOST = '127.0.0.1';
export const HOOKS_PATH = '/hooks';
export const TOKEN_HEADER = 'X-Agent-Quest-Token';
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/** Mesmos nomes do servidor (server/config.js e server/runtime-file.js). */
export const DATA_DIR_NAME = 'agent-quest';
export const RUNTIME_FILE_NAME = 'runtime.json';

/** Limites (visão geral, "Limites e valores padrão"). */
export const MAX_STDIN_BYTES = 16 * 1024 * 1024;
export const DEADLINE_MS = 2000;
export const POST_TIMEOUT_MS = 1000;

/**
 * Strings acima de 4 KiB viram 1 KiB do início + 3 KiB do fim. Unidades UTF-16
 * (`String.length`), não bytes nem pontos de código (modelo de eventos, seção 1).
 */
export const MAX_STRING_CHARS = 4 * 1024;
export const HEAD_CHARS = 1024;
export const TAIL_CHARS = 3 * 1024;

/** Teto do corpo enviado, em bytes UTF-8 (modelo de eventos, seção 1, "Teto do corpo"). */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * Orçamento de tempo da redução (modelo de eventos, seção 1): até 1 s desde o
 * início da redução (stdin já lido e interpretado), só a partir do passo 2,
 * conferido antes de cada passo e a cada 1 000 itens nos laços. Esgotado, sai
 * o envelope de emergência. O prazo total de ~2 s fica com o timeout do POST.
 */
export const REDUCTION_BUDGET_MS = 1000;
export const BUDGET_CHECK_EVERY = 1000;

/**
 * Tempo guardado para o POST antes do prazo de 2 s: o orçamento da redução nunca
 * passa de `DEADLINE_MS - POST_RESERVE_MS` desde a partida do processo, para o
 * envelope de emergência ainda ser enviado.
 */
export const POST_RESERVE_MS = 250;

/**
 * Atalho por tamanho (modelo de eventos, seção 1): com stdin acima de 8 MiB, vai
 * direto ao envelope de emergência depois do `JSON.parse`, sem listar chaves (a
 * listagem de um objeto gigante não pode ser interrompida). Limite provisório,
 * revisto no G0b com os tamanhos reais do T0.
 */
export const SHORTCUT_STDIN_BYTES = 8 * 1024 * 1024;

/** Passo 2 da redução: strings acima de 512 unidades viram 128 + 384; listas, 100 itens. */
export const SHORT_STRING_CHARS = 512;
export const SHORT_HEAD_CHARS = 128;
export const SHORT_TAIL_CHARS = 384;
export const MAX_LIST_ITEMS = 100;

/**
 * @typedef {object} Runtime
 * @property {number} port
 * @property {string} token
 * @property {number} pid
 */

/**
 * Diretório de dados, com a mesma regra do servidor (`resolveDataDir` em
 * server/config.js; um teste compara as duas): `AGENT_QUEST_HOME`, se definido;
 * no Windows, `%LOCALAPPDATA%\agent-quest`; nos outros sistemas,
 * `$XDG_STATE_HOME/agent-quest` ou `~/.local/state/agent-quest`.
 * @param {{ env: Record<string, string|undefined>, platform: string, homedir: string }} options
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
 * @param {unknown} port
 * @returns {port is number}
 */
export function isValidPort(port) {
  return Number.isInteger(port) && /** @type {number} */ (port) >= MIN_PORT && /** @type {number} */ (port) <= MAX_PORT;
}

/**
 * Lê porta, token e pid do runtime.json. Devolve `null` se o arquivo não existir,
 * não for JSON ou tiver algum campo fora do esperado (porta fora de 1024 a 65535,
 * por exemplo).
 * @param {string} dataDir
 * @returns {Runtime|null}
 */
export function readRuntime(dataDir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dataDir, RUNTIME_FILE_NAME), 'utf8'));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const { port, token, pid } = data;
  if (!isValidPort(port)) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { port, token, pid };
}

/**
 * Diz se existe um processo com esse pid. `EPERM` significa que existe, mas é
 * de outro usuário.
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * Lê o stdin inteiro, guardando até `limit` bytes. Acima disso, continua lendo
 * e descartando até o fim (para quem escreve não receber erro de pipe) e
 * devolve `null`.
 * @param {any} stream
 * @param {number} limit
 * @returns {Promise<Uint8Array|null>}
 */
export function readStdin(stream, limit) {
  return new Promise((resolve) => {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let overflow = false;
    stream.on('data', (/** @type {Uint8Array} */ chunk) => {
      total += chunk.length;
      if (overflow) return;
      if (total > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(overflow ? null : Buffer.concat(chunks, total)));
    stream.on('error', () => resolve(null));
  });
}

/**
 * Interpreta o stdin do hook. Só um objeto JSON é aceito.
 * @param {Uint8Array} bytes
 * @returns {Record<string, unknown>|null}
 */
export function parsePayload(bytes) {
  try {
    const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Corta uma string longa: `head` unidades do início + `tail` do fim, separadas
 * por `…[cortado N caracteres]…`, em que N conta as unidades UTF-16 retiradas
 * (modelo de eventos, seção 1, "Unidades no encaminhador"). O fim é preservado
 * porque o resumo dos testes fica no fim da saída. Não parte pares de
 * surrogates: se um corte cair no meio de um, o par inteiro sai.
 * @param {string} text
 * @param {number} [head]
 * @param {number} [tail]
 * @returns {string}
 */
export function cutString(text, head = HEAD_CHARS, tail = TAIL_CHARS) {
  let headEnd = head;
  let tailStart = text.length - tail;
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  return `${text.slice(0, headEnd)}…[cortado ${tailStart - headEnd} caracteres]…${text.slice(tailStart)}`;
}

/**
 * Regras de um passo de redução.
 * @typedef {object} ReduceRules
 * @property {number} maxChars           strings acima disto são cortadas
 * @property {number} headChars
 * @property {number} tailChars
 * @property {number} maxItems           listas ficam com os primeiros itens até este número
 */

/** Passo 1: o corte normal de 4 KiB. */
export const STEP1_RULES = Object.freeze({
  maxChars: MAX_STRING_CHARS,
  headChars: HEAD_CHARS,
  tailChars: TAIL_CHARS,
  maxItems: Infinity,
});

/** Passo 2: strings acima de 512 unidades (128 + 384) e listas de até 100 itens. */
export const STEP2_RULES = Object.freeze({
  maxChars: SHORT_STRING_CHARS,
  headChars: SHORT_HEAD_CHARS,
  tailChars: SHORT_TAIL_CHARS,
  maxItems: MAX_LIST_ITEMS,
});

/**
 * Copia o valor aplicando as regras, em qualquer nível. Não altera o original,
 * para cada passo partir do payload como chegou (e o N do marcador contar as
 * unidades retiradas do texto original).
 *
 * Com `sizeLimit`, acompanha um piso do tamanho do JSON de saída, em unidades
 * UTF-16 (que nunca passam dos bytes UTF-8): quando o piso passa do limite, o
 * passo não vai caber de jeito nenhum e é abandonado na hora (`StepTooLarge`),
 * sem copiar nem serializar o resto. Assim um passo visita no máximo cerca de
 * `sizeLimit` nós, qualquer que seja o tamanho da entrada.
 * @param {unknown} root
 * @param {ReduceRules} rules
 * @param {{ timeBudget?: TimeBudget|null, sizeLimit?: number, keysOf?: (object: object) => string[] }} [options]
 * @returns {{ value: unknown, truncated: boolean }}
 */
export function reduceValue(root, rules, { timeBudget = null, sizeLimit = Infinity, keysOf = Object.keys } = {}) {
  let truncated = false;
  let floor = 0;

  /** @param {number} units */
  function grow(units) {
    floor += units;
    if (floor > sizeLimit) throw new StepTooLarge();
  }

  /**
   * @param {unknown} value
   * @returns {unknown}
   */
  function visit(value) {
    timeBudget?.tick();
    if (typeof value === 'string') {
      const out = value.length <= rules.maxChars ? value : cutString(value, rules.headChars, rules.tailChars);
      if (out !== value) truncated = true;
      grow(out.length + 2);
      return out;
    }
    if (Array.isArray(value)) {
      if (value.length > rules.maxItems) truncated = true;
      const count = Math.min(value.length, rules.maxItems);
      grow(2);
      const copy = new Array(count);
      for (let i = 0; i < count; i++) {
        if (i > 0) grow(1);
        copy[i] = visit(value[i]);
      }
      return copy;
    }
    if (value !== null && typeof value === 'object') {
      grow(2);
      /** @type {Record<string, unknown>} */
      const copy = {};
      let first = true;
      for (const key of keysOf(value)) {
        grow(key.length + (first ? 3 : 4));
        first = false;
        setOwn(copy, key, visit(/** @type {Record<string, unknown>} */ (value)[key]));
      }
      return copy;
    }
    grow(value === null || typeof value === 'boolean' ? 4 : 1);
    return value;
  }

  const value = visit(root);
  return { value, truncated };
}

/**
 * `Object.keys` com cache para objetos grandes (acima de 1 000 chaves): com
 * centenas de milhares de chaves, listar as chaves custa centenas de ms, e os
 * passos 1, 2 e 3 percorrem o mesmo objeto.
 * @returns {(object: object) => string[]}
 */
export function createKeyCache() {
  /** @type {WeakMap<object, string[]>} */
  const cache = new WeakMap();
  return (object) => {
    const cached = cache.get(object);
    if (cached) return cached;
    const keys = Object.keys(object);
    if (keys.length > 1000) cache.set(object, keys);
    return keys;
  };
}

/** O passo não cabe no teto de jeito nenhum (o piso do tamanho já passou). */
export class StepTooLarge extends Error {
  constructor() {
    super('o passo não cabe no teto do corpo');
    this.name = 'StepTooLarge';
  }
}

/**
 * Passo 1 isolado: corta toda string acima de 4 KiB, em qualquer nível.
 * @param {unknown} root
 * @returns {{ value: unknown, truncated: boolean }}
 */
export function truncateStrings(root) {
  return reduceValue(root, STEP1_RULES);
}

/**
 * Monta o envelope v1 (modelo de eventos, seção 1) com um payload já reduzido.
 * Das variáveis de ambiente, só vai `CLAUDE_PROJECT_DIR`. `entrypoint` fica
 * `null` até o T0 confirmar qual variável diz se a sessão é do terminal ou do VS Code.
 * @param {unknown} payload
 * @param {boolean} truncated
 * @param {{ sentAt: number, env: Record<string, string|undefined> }} options
 */
function envelopeOf(payload, truncated, { sentAt, env }) {
  const projectDir = env.CLAUDE_PROJECT_DIR;
  return {
    v: 1,
    sentAt,
    forwarder: FORWARDER_VERSION,
    env: { projectDir: typeof projectDir === 'string' && projectDir !== '' ? projectDir : null, entrypoint: null },
    truncated,
    payload,
  };
}

/**
 * Envelope do passo 1 (o corte normal de 4 KiB).
 * @param {Record<string, unknown>} payload
 * @param {{ sentAt: number, env: Record<string, string|undefined> }} options
 */
export function buildEnvelope(payload, options) {
  const { value, truncated } = truncateStrings(payload);
  return envelopeOf(value, truncated, options);
}

/**
 * Corpo do POST, com o teto de 1 000 000 bytes UTF-8 (modelo de eventos,
 * seção 1, "Teto do corpo"). Três passos, parando no primeiro que couber:
 * 1. o corte normal de 4 KiB;
 * 2. strings acima de 512 unidades (128 + 384) e listas de até 100 itens;
 * 3. envelope mínimo (`minimalPayload`).
 * Além do primeiro passo, `truncated` é `true`. Devolve `null` se nem o
 * envelope mínimo couber (por exemplo, um `session_id` absurdo): aí não envia.
 *
 * Orçamento de tempo ("Orçamento de tempo da redução"): conta a partir do início
 * da redução (o stdin já foi lido e interpretado), vale só a partir do passo 2 e
 * é conferido antes de cada passo e a cada 1 000 itens; esgotado, sai o envelope
 * de emergência (`emergencyPayload`). O passo 1 nunca é interrompido pelo tempo:
 * um payload que cabe no teto depois dele sai sempre completo, mesmo com a
 * máquina lenta. Os passos 1 e 2 são abandonados assim que se sabe que não cabem
 * (`reduceValue` com `sizeLimit`), então não custam mais que o teto.
 * @param {Record<string, unknown>} payload
 *
 * Atalho: com `inputBytes` (tamanho do stdin) acima de 8 MiB, sai direto o
 * envelope de emergência, sem passar pelos passos.
 * @param {{ sentAt: number, env: Record<string, string|undefined>, maxBytes?: number, now?: () => number, budgetMs?: number, inputBytes?: number }} options
 * @returns {string|null}
 */
export function buildBody(
  payload,
  { sentAt, env, maxBytes = MAX_BODY_BYTES, now = elapsedSinceStart, budgetMs = REDUCTION_BUDGET_MS, inputBytes = 0 },
) {
  const fits = (/** @type {string} */ body) => Buffer.byteLength(body, 'utf8') <= maxBytes;
  const emergency = () => {
    const body = JSON.stringify(envelopeOf(emergencyPayload(payload), true, { sentAt, env }));
    return fits(body) ? body : null;
  };
  if (inputBytes > SHORTCUT_STDIN_BYTES) return emergency();

  // O orçamento termina no que vier primeiro: 1 s depois do início da redução, ou
  // a hora que ainda deixa a reserva do POST antes do prazo de 2 s do processo.
  const timeBudget = createTimeBudget(now, Math.min(now() + budgetMs, DEADLINE_MS - POST_RESERVE_MS));
  // Bytes do envelope sem o payload (com `truncated: false`, a forma mais longa).
  const overhead = Buffer.byteLength(JSON.stringify(envelopeOf({}, false, { sentAt, env })), 'utf8') - 2;
  const sizeLimit = maxBytes - overhead;
  const keysOf = createKeyCache();

  // Passo 1: sem orçamento de tempo; só é abandonado se certamente não couber.
  try {
    const first = reduceValue(payload, STEP1_RULES, { sizeLimit, keysOf });
    const body1 = JSON.stringify(envelopeOf(first.value, first.truncated, { sentAt, env }));
    if (fits(body1)) return body1;
  } catch (err) {
    if (!(err instanceof StepTooLarge)) throw err;
  }

  try {
    timeBudget.check();
    try {
      const second = reduceValue(payload, STEP2_RULES, { timeBudget, sizeLimit, keysOf });
      timeBudget.check();
      const body2 = JSON.stringify(envelopeOf(second.value, true, { sentAt, env }));
      if (fits(body2)) return body2;
    } catch (err) {
      if (!(err instanceof StepTooLarge)) throw err;
    }

    timeBudget.check();
    const base = JSON.stringify(envelopeOf({}, true, { sentAt, env }));
    const minimal = minimalPayload(payload, maxBytes - Buffer.byteLength(base, 'utf8'), timeBudget, keysOf);
    if (!minimal) return null;
    const body3 = JSON.stringify(envelopeOf(minimal, true, { sentAt, env }));
    return fits(body3) ? body3 : null;
  } catch (err) {
    if (!(err instanceof ReductionTimeout)) throw err;
    return emergency();
  }
}

/**
 * Tempo desde o início do processo, em ms (inclui a partida do Node, como o prazo de 2 s).
 * @returns {number}
 */
export function elapsedSinceStart() {
  return process.uptime() * 1000;
}

/** O orçamento de tempo da redução acabou (interrompe os passos em andamento). */
export class ReductionTimeout extends Error {
  constructor() {
    super('orçamento de tempo da redução esgotado');
    this.name = 'ReductionTimeout';
  }
}

/**
 * @typedef {object} TimeBudget
 * @property {() => void} check          confere agora; lança `ReductionTimeout` se acabou
 * @property {() => void} tick           conta um item; confere o relógio a cada 1 000
 */

/**
 * @param {() => number} now             ms desde o início do processo
 * @param {number} limitMs
 * @returns {TimeBudget}
 */
export function createTimeBudget(now, limitMs) {
  let items = 0;
  const check = () => {
    if (now() >= limitMs) throw new ReductionTimeout();
  };
  return {
    check,
    tick() {
      items++;
      if (items % BUDGET_CHECK_EVERY === 0) check();
    },
  };
}

/**
 * Envelope de emergência (orçamento esgotado ou stdin acima de 8 MiB): só os
 * obrigatórios e os prioritários do passo 3, lidos por acesso direto no primeiro
 * nível (sem listar chaves), com textos de até 512 unidades. Custo constante,
 * qualquer que seja o tamanho do payload.
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
export function emergencyPayload(payload) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const key of [...MINIMAL_REQUIRED_KEYS, ...MINIMAL_PRIORITY_KEYS]) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const value = payload[key];
    if (!isSimpleValue(value)) continue;
    setOwn(result, key, shortenText(value));
  }
  return result;
}

/**
 * Valor simples do passo 3: texto, número, booleano ou `null`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isSimpleValue(value) {
  return value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string';
}

/**
 * Texto acima de 512 unidades vira 128 + 384 (regra do passo 2 e do passo 3).
 * @param {unknown} value
 * @returns {unknown}
 */
function shortenText(value) {
  return typeof value === 'string' && value.length > SHORT_STRING_CHARS
    ? cutString(value, SHORT_HEAD_CHARS, SHORT_TAIL_CHARS)
    : value;
}

/** Passo 3: entram sempre, se existirem no original (sem `agent_id`, um evento de subagente iria para o `main`). */
export const MINIMAL_REQUIRED_KEYS = Object.freeze(['hook_event_name', 'session_id', 'agent_id']);

/** Passo 3: depois dos obrigatórios, nesta ordem. */
export const MINIMAL_PRIORITY_KEYS = Object.freeze([
  'agent_type',
  'tool_name',
  'tool_use_id',
  'prompt_id',
  'cwd',
  'notification_type',
  'source',
  'reason',
  'trigger',
]);

/**
 * Passo 3: payload mínimo (modelo de eventos, seção 1, "Teto do corpo"). Só
 * valores simples (texto, número, booleano, `null`), com textos de até 512
 * unidades (128 + 384), acrescentados um a um enquanto couberem em `budget`
 * bytes. Listas e objetos aninhados saem. Ordem:
 * 1. obrigatórios: `hook_event_name`, `session_id` e `agent_id` (se existir);
 * 2. prioritários (`MINIMAL_PRIORITY_KEYS`), nessa ordem;
 * 3. os demais valores simples do primeiro nível, na ordem do original;
 * 4. os valores simples de `tool_input`, na ordem do original.
 * Devolve `null` se os obrigatórios não couberem: aí não envia.
 * @param {Record<string, unknown>} payload
 * @param {number} budget                bytes disponíveis para o JSON do payload
 * @param {TimeBudget|null} [timeBudget] orçamento de tempo, conferido a cada 1 000 chaves
 * @param {(object: object) => string[]} [keysOf]  lista de chaves (com cache entre os passos)
 * @returns {Record<string, unknown>|null}
 */
export function minimalPayload(payload, budget, timeBudget = null, keysOf = Object.keys) {
  /** @type {Record<string, unknown>} */
  const result = {};
  let size = 2; // {}
  /** Membros já gravados em cada objeto (para a vírgula), sem recontar as chaves. */
  const members = new Map([[result, 0]]);
  const isSimple = isSimpleValue;
  const shorten = shortenText;

  /**
   * Acrescenta `"chave":valor` a `target` se couber no orçamento.
   * @param {Record<string, unknown>} target
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  function add(target, key, value) {
    const count = members.get(target) ?? 0;
    const extra = (count > 0 ? 1 : 0) + Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (size + extra > budget) return false;
    setOwn(target, key, value);
    members.set(target, count + 1);
    size += extra;
    return true;
  }

  /** @param {string} key */
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);

  // 1. Obrigatórios: se existirem e não couberem, não envia.
  for (const key of MINIMAL_REQUIRED_KEYS) {
    if (!has(key) || !isSimple(payload[key])) continue;
    if (!add(result, key, shorten(payload[key]))) return null;
  }

  // 2. Prioritários, na ordem da decisão.
  for (const key of MINIMAL_PRIORITY_KEYS) {
    if (has(key) && isSimple(payload[key])) add(result, key, shorten(payload[key]));
  }

  // 3. Os demais simples do primeiro nível, na ordem do original, enquanto couberem:
  //    o primeiro que não cabe encerra o passo (linear, limitado pelo teto).
  let full = false;
  for (const key of keysOf(payload)) {
    timeBudget?.tick();
    if (SKIP_IN_REST.has(key)) continue;
    const value = payload[key];
    if (isSimple(value) && !add(result, key, shorten(value))) {
      full = true;
      break;
    }
  }

  // 4. Os simples de tool_input, na ordem do original.
  const input = payload.tool_input;
  if (!full && input !== null && typeof input === 'object' && !Array.isArray(input)) {
    /** @type {Record<string, unknown>} */
    const inner = {};
    if (add(result, 'tool_input', inner)) {
      for (const key of keysOf(input)) {
        timeBudget?.tick();
        const value = /** @type {Record<string, unknown>} */ (input)[key];
        if (isSimple(value) && !add(inner, key, shorten(value))) break;
      }
    }
  }
  return result;
}

/** Chaves que o passo 3 trata antes (obrigatórios e prioritários) ou à parte (`tool_input`). */
const SKIP_IN_REST = new Set([...MINIMAL_REQUIRED_KEYS, ...MINIMAL_PRIORITY_KEYS, 'tool_input']);

/**
 * Cria a chave como propriedade própria. `defineProperty`, e não atribuição,
 * para uma chave "__proto__" vinda do JSON continuar sendo só uma chave.
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 */
function setOwn(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/**
 * POST /hooks em 127.0.0.1. Nunca rejeita: termina na resposta (qualquer
 * status), no erro ou no prazo, o que vier primeiro.
 * @param {Runtime} runtime
 * @param {string} body
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function postEnvelope(runtime, body, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {any} */
    let req = null;
    /** @type {any} */
    let timer = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    try {
      req = http.request(
        {
          host: HOST,
          port: runtime.port,
          method: 'POST',
          path: HOOKS_PATH,
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            [TOKEN_HEADER]: runtime.token,
          },
        },
        (/** @type {any} */ res) => {
          res.resume();
          finish();
        },
      );
      req.on('error', finish);
      req.end(body);
    } catch {
      finish();
    }
  });
}

/**
 * Encaminha um evento. Nunca lança.
 * @param {{ stdin: any, env: Record<string, string|undefined>, platform: string, homedir: string, sentAt: number, now?: () => number }} options
 * @returns {Promise<void>}
 */
export async function forward({ stdin, env, platform, homedir, sentAt, now = elapsedSinceStart }) {
  try {
    // O stdin é lido até o fim antes de tudo (ADR 0001), para quem escreve
    // nunca encontrar o pipe fechado. Interpretar e cortar o JSON só se houver servidor.
    const bytes = await readStdin(stdin, MAX_STDIN_BYTES);
    const runtime = readRuntime(resolveDataDir({ env, platform, homedir }));
    if (!runtime || !isPidAlive(runtime.pid)) return;
    const payload = bytes && parsePayload(bytes);
    if (!payload) return;
    const body = buildBody(payload, { sentAt, env, now, inputBytes: bytes.length });
    if (body === null) return;
    // O POST espera o que falta até o prazo de 2 s, no máximo 1 s.
    const timeoutMs = Math.min(POST_TIMEOUT_MS, DEADLINE_MS - now());
    if (timeoutMs <= 0) return;
    await postEnvelope(runtime, body, timeoutMs);
  } catch {
    // Falha silenciosa: a captura nunca atrapalha o Claude Code.
  }
}

/** Ponto de entrada: tudo termina em `process.exit(0)`, sem imprimir nada. */
function main() {
  const quit = () => process.exit(0);
  // Nada vai para o terminal, nem avisos internos do Node.
  try {
    process.stdout.write = () => true;
    process.stderr.write = () => true;
  } catch {
    // segue sem a proteção extra
  }
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);
  // O prazo conta do início do processo, inclusive a partida do Node.
  const elapsedMs = Math.round(process.uptime() * 1000);
  setTimeout(quit, Math.max(0, DEADLINE_MS - elapsedMs)).unref();

  let homedir = '';
  try {
    homedir = os.homedir();
  } catch {
    // sem pasta pessoal: vale só AGENT_QUEST_HOME ou LOCALAPPDATA
  }
  forward({ stdin: process.stdin, env: process.env, platform: process.platform, homedir, sentAt: startedAt }).then(quit, quit);
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** @returns {boolean} */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync.native(entry) === fs.realpathSync.native(self);
  } catch {
    const fold = (/** @type {string} */ p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    return fold(entry) === fold(self);
  }
}

if (isEntryPoint()) main();
