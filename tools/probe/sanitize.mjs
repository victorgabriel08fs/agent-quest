// Sanitização dos registros da sonda do T0: transforma um trecho do JSONL
// bruto num cenário de test/fixtures/hooks/<nome>.json. Formato e regras:
// ADR 0010, complemento "formato e sanitização dos cenários de hooks".
//   { name, description, events: [{ dt, env, payload }] }
// - dt: intervalo em ms desde o evento anterior do cenário (0 no primeiro),
//   medido pelo momento da gravação (equivale à chegada no servidor);
// - env: o `env` do envelope v1, { projectDir, entrypoint };
// - payload: o JSON do hook, sanitizado.
//
// O que a sanitização faz com o payload:
// - mantém a estrutura (números, booleanos, listas e chaves comuns), nomes de
//   eventos e de ferramentas, tipos de agente, status e outros valores curtos
//   de enumeração. Chaves fora do comum (caminho, id, segredo) viram marcador
//   ou id sintético;
// - troca os ids reais (valores das chaves de id, inclusive as afins como
//   sessionId, e toda ocorrência deles em outras strings, sem diferenciar
//   maiúsculas) por ids sintéticos estáveis, com o mesmo comprimento, prefixo e
//   separadores. O mesmo id real vira sempre o mesmo id sintético, inclusive
//   entre cenários, então os elos continuam valendo;
// - mantém caminhos (até 200 caracteres), trocando o nome do usuário da pasta
//   pessoal por "usuario", também na forma codificada para URL;
// - mantém a primeira linha dos comandos (até 160 caracteres), as descrições
//   (até 80), padrões de busca (até 60) e a primeira linha dos erros (até 160).
//   Redação, corte e contagem são os de server/domain/redact.js (redact,
//   redactAndCut e charLength, os mesmos do normalizador), sem corte próprio.
//   Se o texto cortado mais o marcador não for ponto fixo de redact, fica só o
//   marcador;
// - de saídas e erros, mantém só as linhas de resumo dos testes, no formato exato;
// - do pedido do usuário, mantém só o comando "/..." ou as tags "<...>". Se o
//   esqueleto das tags passar de 200 caracteres, ficam as tags com id ou status
//   e o resto vira um marcador «tags#n:tamanho»;
// - troca o resto (conteúdo de arquivo, saídas, pedidos, textos) por
//   marcadores «tipo#número:tamanho». O mesmo texto vira sempre o mesmo
//   marcador dentro de um cenário, e textos diferentes viram marcadores
//   diferentes: igualdades (por exemplo, o tool_input do PermissionRequest e
//   o do PreToolUse) continuam valendo.
//
// Uso (na raiz do repositório):
//   node tools/probe/sanitize.mjs --list [--in <arquivo.jsonl>] [--session <prefixo>]
//   node tools/probe/sanitize.mjs --name <nome> --description "<texto>" (--lines 12-40[,50-60] | --prompts 3[-4])
//        [--session <prefixo>] [--in <arquivo.jsonl>] [--out <arquivo.json>] [--entrypoint-var <NOME>] [--force]
// Sem --in, lê <dados>\probe\events.jsonl. Sem --out, grava em test/fixtures/hooks/<nome>.json.
// Antes de gravar, confere o cenário (auditFixture) e não grava se achar
// possível segredo, string longa, o nome do usuário ou um id original, em
// valores ou em chaves. --ignore-audit só com revisão do orquestrador (ADR 0010).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { charLength, plainText, redact, redactAndCut } from '../../server/domain/redact.js';
import { redactWindow } from '../../server/domain/tools.js';
import { REPO_ROOT, displayPath, isMainModule, isObject, parseJsonl, probeDir } from './records.mjs';

const ID_KEYS = new Set([
  'session_id', 'prompt_id', 'tool_use_id', 'agent_id', 'agentId', 'id', 'task_id', 'elicitation_id',
  'request_id', 'requestId', 'uuid', 'parentUuid', 'parent_tool_use_id',
]);
// Chaves afins: terminadas em _id, Id, ID, _uuid ou Uuid (e no plural), como sessionId e backgroundTaskId.
const ID_KEY_SUFFIX = /(?:_id|Id|ID|_uuid|Uuid|UUID)s?$/;
const PATH_KEYS = new Set([
  'cwd', 'transcript_path', 'agent_transcript_path', 'file_path', 'filePath', 'path', 'notebook_path',
  'outputFile', 'output_file', 'scratchpad_dir', 'directory', 'old_cwd', 'new_cwd', 'worktree_path',
  'trigger_file_path', 'parent_file_path', 'projectDir',
]);
const ENUM_KEYS = new Set([
  'hook_event_name', 'tool_name', 'agent_type', 'subagent_type', 'notification_type', 'source', 'reason',
  'trigger', 'permission_mode', 'model', 'resolvedModel', 'modelsUsed', 'final_model', 'status', 'type',
  'level', 'name', 'memory_type', 'load_reason', 'expansion_type', 'command_name', 'command_source',
  'behavior', 'destination', 'mode', 'toolName', 'event', 'version',
]);
const CONTENT_KEYS = new Set(['content', 'old_string', 'new_string', 'new_source', 'file_text', 'source_code']);
const MESSAGE_KEYS = new Set(['message', 'title']);

const ID_LIKE = /^[\w.:-]{1,128}$/;
// Ids mais curtos que isto não são procurados dentro de outras strings (dariam falsos positivos).
const MIN_EMBEDDED_ID = 8;
const ID_SALT = 'agent-quest-probe:ids:v1';
const ENUM_LIKE = /^[\w.:@\-[\]/]{1,80}$/;
// Chave comum de objeto: fica como está, se não tiver id, caminho pessoal nem segredo.
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// Dentro das tags do pedido do sistema, só ficam ids (com algum dígito) e palavras de enumeração em minúsculas.
const TAG_ID = /^(?=.*\d)[A-Za-z0-9_-]{6,64}$/;
const TAG_WORD = /^[a-z][a-z_]{0,19}$/;
const MARKER = /«[^«»]*»/g;
const MAX_KEPT = 200;
const MAX_TAG_PROMPT = 20_000;

// Linhas de resumo dos testes (mesmos frameworks do modelo de eventos, seção 6).
// Só o formato exato do resumo: números, palavras fixas e, no go test, o nome
// do teste ou do pacote. Texto livre na linha a desqualifica.
const COUNT_WORDS = 'failed|passed|skipped|todo|pending|total|obsolete|written|updated|risky|incomplete|warnings?|deprecated';
const PYTEST_WORDS = 'passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected';
const PHPUNIT_WORDS = 'Errors|Failures|Warnings|Skipped|Incomplete|Risky|Deprecations|Notices|PHPUnit Deprecations';
const SUMMARY_LINES = [
  /^\s*[ℹ#]\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+[\d.]+\s*$/, // node:test (spec e TAP)
  /^\s*1\.\.\d+\s*$/, // TAP
  new RegExp(`^\\s*(Tests|Test Suites|Snapshots):\\s+\\d+ (${COUNT_WORDS})(, \\d+ (${COUNT_WORDS}))*\\s*$`), // Jest
  new RegExp(`^\\s*(Test Files|Tests)\\s+\\d+ (${COUNT_WORDS})( \\| \\d+ (${COUNT_WORDS}))*\\s+\\(\\d+\\)\\s*$`), // Vitest
  new RegExp(`^[=\\s]*\\d+ (${PYTEST_WORDS})(, \\d+ (${PYTEST_WORDS}))* in [\\d.]+s( \\(\\d+:\\d+:\\d+\\))?[=\\s]*$`), // pytest
  new RegExp(`^\\s*(OK \\(\\d+ tests?, \\d+ assertions?\\)|Tests: \\d+, Assertions: \\d+(, (${PHPUNIT_WORDS}): \\d+)*\\.|FAILURES!|ERRORS!)\\s*$`), // PHPUnit
  new RegExp(`^\\s*Tests:\\s+\\d+ (${COUNT_WORDS})(, \\d+ (${COUNT_WORDS}))*\\s+\\(\\d+ assertions?\\)\\s*$`), // Pest
  /^(ok|FAIL)\s+[\w./-]{1,120}\s+([\d.]+s|\(cached\))\s*$/, // go test (pacote)
  /^\s*--- FAIL: [\w/.#-]{1,120} \(\d+(\.\d+)?s\)\s*$/, // go test (teste)
  /^test result: (ok|FAILED)\. \d+ passed; \d+ failed(; \d+ (ignored|measured|filtered out))*(; finished in [\d.]+s)?\s*$/, // cargo test
  /^\s*\d+ (passing|failing|pending)( \(\d+(\.\d+)?m?s\))?\s*$/, // mocha
  /^\s*(Passed|Failed)!\s+-\s+Failed:\s+\d+, Passed:\s+\d+, Skipped:\s+\d+, Total:\s+\d+(, Duration:\s+[\d.]+\s*\w+)?( - [\w.-]+\.dll \([\w.]+\))?\s*$/, // dotnet test
  // Playwright (reporters/base.ts; duração do msToString: 0ms, Nms, N.Ns, N.Nm, N.Nh, N.Nd ou "-").
  /^\s*\d+ (passed|failed|flaky|skipped|did not run|interrupted)( \((\d+(\.\d)?(ms|s|m|h|d)|-)\))?\s*$/,
];

/** Diz se a chave guarda um id (lista conhecida ou chave afim). */
function isIdKey(key) {
  return ID_KEYS.has(key) || ID_KEY_SUFFIX.test(key);
}

/**
 * Junta os ids reais de um payload: valores das chaves de id (inclusive as
 * afins) e ids dentro das tags dos pedidos do sistema (por exemplo, <task-id>).
 * @param {any} payload
 * @param {Set<string>} [into]
 */
export function collectIds(payload, into = new Set()) {
  const visit = (value, key, depth) => {
    if (typeof value === 'string') {
      if (isIdKey(key) && ID_LIKE.test(value)) into.add(value);
      else if (key === 'prompt' && depth === 1 && /^\s*<[A-Za-z]/.test(value) && value.length <= MAX_TAG_PROMPT) {
        for (const token of tagTexts(value)) if (TAG_ID.test(token)) into.add(token);
      }
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v, key, depth + 1);
    } else if (isObject(value)) {
      for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1);
    }
  };
  visit(payload, '', 0);
  return into;
}

/**
 * Id sintético com a forma do original: mesmo comprimento, mesmo prefixo
 * (`toolu_01`, o `a` inicial dos agent_id) e mesmos separadores. Hexadecimal
 * continua hexadecimal; nos outros, dígito vira dígito e letra vira letra da
 * mesma caixa. Num UUID, a versão e a variante ficam iguais (não identificam
 * nada). Determinístico: depende só do id real e da tentativa.
 * @param {string} original
 * @param {number} [attempt]
 * @param {boolean} [keepPrefix] false só no recuo de ids que não têm o que variar depois do prefixo
 */
export function shapeLikeId(original, attempt = 0, keepPrefix = true) {
  const known = /^[A-Za-z]+_(?:01)?/.exec(original)?.[0] ?? (/^a[0-9a-f]{8,}$/.test(original) ? 'a' : '');
  const prefix = keepPrefix ? known : '';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(original);
  const body = original.slice(prefix.length);
  const alnum = body.replace(/[^A-Za-z0-9]/g, '');
  let mode = 'class';
  if (!/^\d*$/.test(alnum)) {
    if (/^[0-9a-f]+$/.test(alnum)) mode = 'hex';
    else if (/^[0-9A-F]+$/.test(alnum)) mode = 'HEX';
  }
  const bytes = [];
  for (let block = 0; bytes.length < body.length; block++) {
    bytes.push(...createHash('sha256').update(`${ID_SALT}\u0000${original}\u0000${attempt}\u0000${block}`).digest());
  }
  let out = prefix;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const b = bytes[i];
    if (!/[A-Za-z0-9]/.test(c) || (uuid && (i === 14 || i === 19))) out += c;
    else if (mode === 'hex') out += '0123456789abcdef'[b % 16];
    else if (mode === 'HEX') out += '0123456789ABCDEF'[b % 16];
    else if (/\d/.test(c)) out += String(b % 10);
    else if (/[a-z]/.test(c)) out += String.fromCharCode(97 + (b % 26));
    else out += String.fromCharCode(65 + (b % 26));
  }
  return out;
}

/**
 * Cria um sanitizador com marcadores próprios (um por cenário).
 * @param {{ home?: string, placeholderUser?: string }} [options]
 */
export function createSanitizer({ home = os.homedir(), placeholderUser = 'usuario' } = {}) {
  const userPattern = buildUserPattern(home);
  const markers = new Map();
  const counters = new Map();
  const originals = new Set();
  const synthetic = new Map();
  const used = new Set();
  let embedded;

  function mapPaths(text) {
    return userPattern ? text.replace(userPattern, `$1${placeholderUser}`) : text;
  }

  function registerId(original) {
    if (originals.has(original)) return;
    originals.add(original);
    embedded = undefined;
  }

  function registerIds(payload) {
    for (const id of collectIds(payload)) registerId(id);
  }

  function syntheticId(original) {
    registerId(original);
    let value = synthetic.get(original);
    if (value === undefined) {
      const free = (candidate) => !used.has(candidate) && !originals.has(candidate);
      value = null;
      // Primeiro com o prefixo; se o id não tiver o que variar (ex.: só "toolu_01"), sem ele; por fim, marcador.
      for (const keepPrefix of [true, false]) {
        for (let attempt = 0; attempt < 20 && value === null; attempt++) {
          const candidate = shapeLikeId(original, attempt, keepPrefix);
          if (free(candidate)) value = candidate;
        }
      }
      if (value === null) value = marker('id', original);
      synthetic.set(original, value);
      used.add(value);
    }
    return value;
  }

  // Troca, dentro de qualquer texto mantido, as ocorrências dos ids reais já
  // registrados, sem diferenciar maiúsculas (em maiúsculas, o id sintético também vem em maiúsculas).
  function replaceIds(text) {
    if (embedded === undefined) {
      const list = [...originals].filter((id) => id.length >= MIN_EMBEDDED_ID).sort((a, b) => b.length - a.length);
      const byLower = new Map();
      for (const id of list) if (!byLower.has(id.toLowerCase())) byLower.set(id.toLowerCase(), id);
      embedded = list.length ? { pattern: new RegExp(list.map(escapeRegExp).join('|'), 'gi'), byLower } : null;
    }
    if (!embedded) return text;
    const { pattern, byLower } = embedded;
    return text.replace(pattern, (found) => {
      const original = byLower.get(found.toLowerCase()) ?? found;
      const fake = syntheticId(original);
      return found !== original && found === found.toUpperCase() ? fake.toUpperCase() : fake;
    });
  }

  // Texto pronto para a redação: pasta pessoal e ids já trocados.
  function prepare(text) {
    return replaceIds(mapPaths(text));
  }

  // Cinto de segurança (modelo de eventos, seção 10, etapa 6): como no
  // normalizador, só o começo do texto (janela de 8192 caracteres) é redigido.
  function keep(text) {
    return redactWindow(prepare(text));
  }

  // Texto cortado mais marcador só fica se for ponto fixo de redact; senão, só o marcador (seção 10).
  function fixedOr(text, fallback) {
    return redact(text) === text ? text : fallback;
  }

  function marker(kind, original) {
    if (original === '') return '';
    const key = `${kind}\u0000${original}`;
    let value = markers.get(key);
    if (!value) {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      value = `«${kind}#${n}:${charLength(original)}»`;
      markers.set(key, value);
    }
    return value;
  }

  function keepPath(value) {
    const kept = keep(value);
    if (charLength(kept) <= MAX_KEPT) return kept;
    const mark = marker('caminho', value);
    return fixedOr(`${redactAndCut(keep(value), 180)}${mark}`, mark);
  }

  function command(value) {
    const [first, ...rest] = value.split(/\r?\n/);
    const kept = keep(first);
    const more = rest.some((line) => line.trim());
    if (charLength(kept) <= 160 && !more) return kept;
    const mark = marker('comando', value);
    if (charLength(kept) <= 160) return fixedOr(`${kept}\n${mark}`, mark);
    return fixedOr(`${redactAndCut(keep(first), 160)} ${mark}`, mark);
  }

  function shortText(value, max, kind) {
    const [first, ...rest] = value.split(/\r?\n/);
    const kept = keep(first);
    if (charLength(kept) <= max && !rest.some((line) => line.trim())) return kept;
    const mark = marker(kind, value);
    return fixedOr(`${redactAndCut(keep(first), max)} ${mark}`, mark);
  }

  function url(value) {
    try {
      const parsed = new URL(value);
      if (!parsed.host) return marker('url', value);
      const hasRest = (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash;
      const out = `${parsed.protocol}//${keep(parsed.host)}${hasRest ? `/${marker('url', value)}` : ''}`;
      return charLength(out.replace(MARKER, '')) <= MAX_KEPT ? fixedOr(out, marker('url', value)) : marker('url', value);
    } catch {
      return marker('url', value);
    }
  }

  function prompt(value) {
    const trimmed = value.trimStart();
    const slash = /^\/[\w:-]+/.exec(trimmed);
    if (slash) {
      const rest = trimmed.slice(slash[0].length).trim();
      return rest ? `${slash[0]} ${marker('argumentos', rest)}` : slash[0];
    }
    if (/^<[A-Za-z]/.test(trimmed) && trimmed.length <= MAX_TAG_PROMPT) return tagSkeleton(trimmed);
    return marker('pedido', value);
  }

  function renderTagText(text) {
    const chunk = text.trim();
    if (!chunk) return text.includes('\n') ? '\n' : ' ';
    if (TAG_ID.test(chunk) && redact(chunk) === chunk) return syntheticId(chunk);
    return TAG_WORD.test(chunk) ? chunk : marker('texto', chunk);
  }

  function renderTag(node) {
    if (node.text !== undefined) return renderTagText(node.text);
    if (node.stray) return `</${node.stray}>`;
    return `<${node.name}>${node.children.map(renderTag).join('')}${node.closed ? `</${node.name}>` : ''}`;
  }

  // Mantém as tags (sem atributos), ids e palavras de enumeração; troca os
  // textos por marcadores. Se o esqueleto passar do limite, ficam só os filhos
  // do primeiro elemento que não têm marcador (ids e status), enquanto couberem,
  // e o resto vira um marcador «tags».
  function tagSkeleton(text) {
    const root = parseTags(text);
    const full = root.children.map(renderTag).join('');
    if (charLength(full.replace(MARKER, '')) <= MAX_KEPT) return fixedOr(full, marker('pedido', text));
    const first = root.children.find((child) => child.name);
    if (!first) return marker('pedido', text);
    const open = `<${first.name}>`;
    const close = first.closed ? `</${first.name}>` : '';
    let budget = MAX_KEPT - charLength(open) - charLength(close) - 2;
    const kept = [];
    const folded = [];
    for (const child of first.children) {
      if (child.text !== undefined && !child.text.trim()) continue;
      const rendered = renderTag(child);
      const cost = charLength(rendered) + 1;
      if (child.name && !rendered.includes('«') && cost <= budget) {
        kept.push(rendered);
        budget -= cost;
      } else {
        folded.push(rendered);
      }
    }
    for (const other of root.children) {
      if (other !== first && !(other.text !== undefined && !other.text.trim())) folded.push(renderTag(other));
    }
    const lines = [open, ...kept];
    if (folded.length) lines.push(marker('tags', folded.join('\n')));
    return fixedOr(`${lines.join('\n')}\n${close}`, marker('pedido', text));
  }

  function errorText(value) {
    const [first, ...rest] = value.split(/\r?\n/);
    const kept = keep(first);
    let head = kept;
    if (charLength(kept) > 160) {
      const mark = marker('erro', first);
      head = fixedOr(`${redactAndCut(keep(first), 160)} ${mark}`, mark);
    }
    const out = [head];
    appendSummary(out, rest);
    return fixedOr(out.join('\n'), marker('erro', value));
  }

  function output(value) {
    const out = [];
    appendSummary(out, value.split(/\r?\n/));
    return fixedOr(out.join('\n'), marker('saída', value));
  }

  function appendSummary(out, lines) {
    let omitted = 0;
    const flush = () => {
      if (omitted) out.push(omitted === 1 ? '«1 linha omitida»' : `«${omitted} linhas omitidas»`);
      omitted = 0;
    };
    for (const line of lines) {
      // Padrões e limite valem para o texto sem cores nem controles: um resumo
      // colorido (node --test, Playwright, Jest, Vitest) também é reconhecido. A
      // linha mantida continua passando por keep, que redige e tira as cores.
      const plain = plainText(line);
      if (charLength(plain) <= MAX_KEPT && SUMMARY_LINES.some((p) => p.test(plain))) {
        flush();
        out.push(keep(line.trimEnd()));
      } else if (plain.trim()) {
        omitted++;
      }
    }
    flush();
  }

  /** Chave comum fica; id vira id sintético; caminho, segredo ou forma estranha vira marcador. */
  function sanitizeKey(key) {
    if (!PLAIN_KEY.test(key)) return marker('chave', key);
    const withIds = replaceIds(key);
    if (mapPaths(withIds) !== withIds || redact(withIds) !== withIds) return marker('chave', key);
    return withIds;
  }

  function sanitizeString(value, key, depth, hook) {
    if (value === '') return '';
    // Id com cara de segredo vira marcador: o id sintético teria a mesma cara.
    if (isIdKey(key)) return ID_LIKE.test(value) && redact(value) === value ? syntheticId(value) : marker('id', value);
    if (PATH_KEYS.has(key)) return keepPath(value);
    switch (key) {
      case 'command': return command(value);
      case 'description': return shortText(value, 80, 'descrição');
      case 'pattern': case 'glob': return shortText(value, 60, 'padrão');
      case 'query': return shortText(value, 80, 'consulta');
      case 'url': return url(value);
      case 'prompt': return depth === 1 ? prompt(value) : marker('pedido', value);
      case 'error': return depth === 1 && hook === 'StopFailure' && ENUM_LIKE.test(value) ? keep(value) : errorText(value);
      case 'stdout': case 'stderr': case 'tool_response': return output(value);
      default: break;
    }
    if (ENUM_KEYS.has(key)) {
      const kept = ENUM_LIKE.test(value) ? keep(value) : '';
      return kept && kept === replaceIds(value) ? kept : marker('texto', value);
    }
    if (CONTENT_KEYS.has(key)) return marker('conteúdo', value);
    if (MESSAGE_KEYS.has(key)) return marker('mensagem', value);
    return marker('texto', value);
  }

  function walk(value, key, depth, hook) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, key, depth + 1, hook));
    if (isObject(value)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[sanitizeKey(k)] = walk(v, k, depth + 1, hook);
      return out;
    }
    if (typeof value === 'string') return sanitizeString(value, key, depth, hook);
    return null;
  }

  /**
   * Sanitiza um payload. Registra antes os ids dele, para trocá-los também
   * dentro de strings que aparecem antes da chave de id.
   * @param {Record<string, any>} payload
   */
  function sanitizePayload(payload) {
    registerIds(payload);
    const hook = typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : '';
    return walk(payload, '', 0, hook);
  }

  return { sanitizePayload, registerId, registerIds, syntheticId, mapPaths, keep, keepPath, marker, originalIds: () => [...originals] };
}

/**
 * Monta o cenário a partir de registros do JSONL bruto (já lidos por parseJsonl).
 * Registra primeiro os ids de todos os registros (e os de `knownIds`), para
 * que um id seja trocado em qualquer string, mesmo antes do evento que o declara.
 * @param {import('./records.mjs').ProbeRecord[]} records
 * @param {{ name: string, description: string, home?: string, placeholderUser?: string, entrypointVar?: string, knownIds?: Iterable<string> }} options
 */
export function buildFixture(records, { name, description, home, placeholderUser, entrypointVar = 'CLAUDE_CODE_ENTRYPOINT', knownIds = [] }) {
  const sanitizer = createSanitizer({ home, placeholderUser });
  for (const id of knownIds) sanitizer.registerId(id);
  for (const record of records) sanitizer.registerIds(record.payload);
  let last = null;
  const events = records.map((record) => {
    const time = record.writtenAt || record.receivedAt;
    const dt = last === null ? 0 : Math.max(0, Math.round(time - last));
    last = last === null ? time : Math.max(last, time);
    const entrypoint = record.env.entrypoints[entrypointVar];
    return {
      dt,
      env: {
        projectDir: record.env.projectDir ? sanitizer.keepPath(record.env.projectDir) : null,
        entrypoint: typeof entrypoint === 'string' && ENUM_LIKE.test(entrypoint) ? entrypoint : null,
      },
      payload: sanitizer.sanitizePayload(record.payload),
    };
  });
  return { name, description, events };
}

/**
 * Procura no cenário o que não deveria estar lá, em valores e em chaves:
 * segredos que a redação pegaria, strings longas (fora dos marcadores), o nome
 * do usuário (também codificado para URL) e ids originais (sem diferenciar maiúsculas).
 * @param {any} fixture
 * @param {{ forbidden?: string[], ids?: Iterable<string> }} [options]
 *   forbidden: nomes de usuário; ids: ids reais (de collectIds) que não podem aparecer
 * @returns {{ where: string, problem: string }[]}
 */
export function auditFixture(fixture, { forbidden = [], ids = [] } = {}) {
  const findings = [];
  const forbiddenPatterns = forbidden
    .filter((token) => typeof token === 'string' && token.length >= 3)
    .map((token) => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`, 'i'));
  const originalIds = [...ids].filter((id) => typeof id === 'string' && id.length >= MIN_EMBEDDED_ID).map((id) => id.toLowerCase());
  const hasForbidden = (text) => {
    const decoded = text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return forbiddenPatterns.some((p) => p.test(text) || p.test(decoded));
  };
  const check = (text, where) => {
    if (redact(text) !== text) findings.push({ where, problem: 'possível segredo' });
    const bare = charLength(text.replace(MARKER, ''));
    if (bare > MAX_KEPT) findings.push({ where, problem: `string longa (${bare} caracteres fora dos marcadores)` });
    if (hasForbidden(text)) findings.push({ where, problem: 'contém o nome do usuário' });
    const lower = text.toLowerCase();
    if (originalIds.some((id) => lower.includes(id))) findings.push({ where, problem: 'contém um id original' });
  };
  // O caminho do achado nunca repete uma chave suspeita (ela pode ter o nome do usuário).
  const label = (key) => (/^[A-Za-z_][\w-]{0,40}$/.test(key) && !hasForbidden(key) ? key : '<chave>');
  const visit = (value, where) => {
    if (typeof value === 'string') {
      check(value, where);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${where}[${i}]`));
    } else if (isObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        const at = `${where}.${label(k)}`;
        check(k, `${at} (chave)`);
        visit(v, at);
      }
    }
  };
  visit(fixture, 'cenário');
  return findings;
}

/**
 * Filtra os registros por sessão, por faixas de linhas ou por faixas de pedidos.
 * Pedidos são os UserPromptSubmit da sessão principal, numerados a partir de 1
 * (como no --list); a faixa A-B vai do pedido A até antes do pedido B+1.
 * @param {import('./records.mjs').ProbeRecord[]} records
 * @param {{ session?: string, lines?: string, prompts?: string }} [options]
 */
export function selectRecords(records, { session, lines, prompts } = {}) {
  if (lines && prompts) throw new Error('use --lines ou --prompts, não os dois');
  let pool = session ? records.filter((r) => String(r.payload.session_id ?? '').startsWith(session)) : records;
  if (lines) {
    const ranges = parseRanges(lines);
    pool = pool.filter((r) => ranges.some(([a, b]) => r.line >= a && r.line <= b));
  }
  if (prompts) {
    const list = pool.filter(isUserPrompt);
    const chosen = new Set();
    for (const [a, b] of parseRanges(prompts)) {
      const start = list[a - 1];
      if (!start) throw new Error(`o pedido ${a} não existe (há ${list.length})`);
      const next = list[b];
      for (const r of pool) if (r.line >= start.line && (!next || r.line < next.line)) chosen.add(r);
    }
    pool = pool.filter((r) => chosen.has(r));
  }
  return pool;
}

/**
 * Linhas para o --list: início e fim de sessão e cada pedido, com o resumo do trecho.
 * O texto do pedido aparece redigido e cortado, só para identificar o trecho no terminal.
 * @param {import('./records.mjs').ProbeRecord[]} records
 */
export function describeRecords(records) {
  const rows = [];
  const prompts = records.filter(isUserPrompt);
  for (const r of records) {
    const p = r.payload;
    const session = String(p.session_id ?? '').slice(0, 8);
    if (p.hook_event_name === 'SessionStart') {
      rows.push({ line: r.line, session, label: `SessionStart (source ${String(p.source ?? '?')})` });
    } else if (p.hook_event_name === 'SessionEnd') {
      rows.push({ line: r.line, session, label: `SessionEnd (reason ${String(p.reason ?? '?')})` });
    } else if (isUserPrompt(r)) {
      const n = prompts.indexOf(r) + 1;
      const next = prompts[n];
      const range = records.filter((x) => x.line >= r.line && (!next || x.line < next.line));
      const counts = {};
      for (const x of range) counts[x.payload.hook_event_name] = (counts[x.payload.hook_event_name] ?? 0) + 1;
      const types = [...new Set(range.map((x) => x.payload.agent_type).filter((t) => typeof t === 'string' && t))];
      const end = range.at(-1)?.line ?? r.line;
      rows.push({
        line: r.line,
        session,
        label: `pedido ${n}: ${previewPrompt(p.prompt)} (linhas ${r.line}-${end}; ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}${types.length ? `; agentes: ${types.join(', ')}` : ''})`,
      });
    }
  }
  return rows;
}

function previewPrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt.trimStart() : '';
  const tag = /^<([A-Za-z][\w-]*)/.exec(text);
  if (tag) return `<${tag[1]}>`;
  return `"${redactAndCut(redactWindow(text.split(/\r?\n/)[0]), 60)}"`;
}

/**
 * Árvore simples das tags de um pedido do sistema. Tag sem fechamento fica
 * aberta; fechamento sem abertura vira um item solto. Os atributos são
 * descartados (e limitados, para o tempo continuar linear).
 * @param {string} text
 */
function parseTags(text) {
  const root = { name: '', children: [], closed: true };
  const stack = [root];
  const pattern = /<(\/?)([A-Za-z][\w-]{0,100})[^<>]{0,500}>|([^<]+)|(<)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const top = stack[stack.length - 1];
    if (match[2] && !match[1]) {
      const node = { name: match[2], children: [], closed: false };
      top.children.push(node);
      stack.push(node);
    } else if (match[2]) {
      let i = stack.length - 1;
      while (i > 0 && stack[i].name !== match[2]) i--;
      if (i > 0) {
        stack[i].closed = true;
        stack.length = i;
      } else {
        top.children.push({ stray: match[2] });
      }
    } else {
      top.children.push({ text: match[3] ?? '<' });
    }
  }
  return root;
}

/** Textos entre as tags de um pedido do sistema, sem espaços nas pontas. */
function tagTexts(text) {
  return text.split(/<[^<>]{0,600}>/).map((chunk) => chunk.trim()).filter(Boolean);
}

function isUserPrompt(record) {
  return record.payload.hook_event_name === 'UserPromptSubmit' && !record.payload.agent_id;
}

function parseRanges(spec) {
  return String(spec).split(',').map((part) => {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error(`faixa inválida: "${part}" (use 12-40 ou 5)`);
    const a = Number(match[1]);
    const b = match[2] ? Number(match[2]) : a;
    if (a < 1 || b < a) throw new Error(`faixa inválida: "${part}"`);
    return [a, b];
  });
}

// Nome do usuário logo depois da pasta "Users" (ou equivalente), com qualquer
// separador: \, /, - (pastas de ~/.claude/projects) ou %5C/%2F (URL).
function buildUserPattern(home) {
  if (!home) return null;
  const p = home.includes('\\') ? path.win32 : path.posix;
  const user = p.basename(home);
  const parent = p.basename(p.dirname(home));
  if (!user || user.length < 2 || !parent) return null;
  return new RegExp(`(${escapeRegExp(parent)}(?:[\\\\/-]|%5[cC]|%2[fF])+)${escapeRegExp(user)}(?![A-Za-z0-9])`, 'gi');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function forbiddenTokens(home) {
  const tokens = new Set([path.basename(home)]);
  try {
    tokens.add(os.userInfo().username);
  } catch {
    // sem informação do usuário: fica só o nome da pasta pessoal
  }
  return [...tokens].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Linha de comando.

const USAGE = `Uso:
  node tools/probe/sanitize.mjs --list [--in <arquivo.jsonl>] [--session <prefixo>]
  node tools/probe/sanitize.mjs --name <nome> --description "<texto>" (--lines 12-40[,50-60] | --prompts 3[-4])
       [--session <prefixo>] [--in <arquivo.jsonl>] [--out <arquivo.json>] [--entrypoint-var <NOME>] [--force] [--ignore-audit]
Sem --in, lê ${displayPath(path.join(probeDir(), 'events.jsonl'))}. Sem --out, grava em test/fixtures/hooks/<nome>.json.`;

/** @param {string[]} argv */
export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        list: { type: 'boolean' },
        in: { type: 'string' },
        out: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        lines: { type: 'string' },
        prompts: { type: 'string' },
        session: { type: 'string' },
        'entrypoint-var': { type: 'string' },
        force: { type: 'boolean' },
        'ignore-audit': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const input = values.in ?? path.join(probeDir(), 'events.jsonl');
  let text;
  try {
    text = fs.readFileSync(input, 'utf8');
  } catch {
    console.error(`Arquivo não encontrado: ${displayPath(input)}`);
    return 1;
  }
  const { records, problems } = parseJsonl(text, input);
  if (problems.length) console.error(`Aviso: ${problems.length} linhas ignoradas (sem payload ou inválidas).`);

  if (values.list) {
    const pool = values.session ? selectRecords(records, { session: values.session }) : records;
    console.log(`${displayPath(input)}: ${records.length} eventos`);
    for (const row of describeRecords(pool)) console.log(`${String(row.line).padStart(6)}  ${row.session}  ${row.label}`);
    return 0;
  }

  if (!values.name || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(values.name)) {
    console.error(`Informe --name com letras minúsculas, números e hífens.\n${USAGE}`);
    return 1;
  }
  if (!values.description) {
    console.error(`Informe --description.\n${USAGE}`);
    return 1;
  }
  if (!values.lines && !values.prompts) {
    console.error(`Informe --lines ou --prompts (veja --list).\n${USAGE}`);
    return 1;
  }

  let selected;
  try {
    selected = selectRecords(records, { session: values.session, lines: values.lines, prompts: values.prompts });
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  if (!selected.length) {
    console.error('Nenhum evento na seleção.');
    return 1;
  }

  const home = os.homedir();
  // Ids de todo o arquivo, não só da seleção: um id de outro trecho também não pode vazar.
  const ids = new Set();
  for (const record of records) collectIds(record.payload, ids);
  const fixture = buildFixture(selected, {
    name: values.name,
    description: values.description,
    home,
    entrypointVar: values['entrypoint-var'],
    knownIds: ids,
  });
  const findings = auditFixture(fixture, { forbidden: forbiddenTokens(home), ids });
  if (findings.length) {
    console.error(`A conferência achou ${findings.length} problema(s):`);
    for (const f of findings.slice(0, 20)) console.error(`  ${f.where}: ${f.problem}`);
    if (!values['ignore-audit']) {
      console.error('Nada foi gravado. Ajuste a seleção ou, com revisão do orquestrador, use --ignore-audit.');
      return 2;
    }
  }

  const out = values.out ?? path.join(REPO_ROOT, 'test', 'fixtures', 'hooks', `${values.name}.json`);
  if (fs.existsSync(out) && !values.force) {
    console.error(`Já existe: ${displayPath(out)} (use --force para substituir).`);
    return 1;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`Cenário gravado: ${displayPath(out)} (${fixture.events.length} eventos)`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
