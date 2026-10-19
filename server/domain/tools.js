// @ts-check
// Ferramentas: categoria, alvo e detalhe (modelo de eventos, seção 3) e o que
// entra no fato a partir do `tool_input` (seção 10).
//
// Todo texto exibido passa por `redactAndCut` (server/domain/redact.js), a única
// função de corte, com os limites da seção 10, depois de tirar as palavras
// partidas encostadas no marcador de corte do encaminhador (B3). Identificadores
// (nome de ferramenta, tipo de agente, skill, modelo, MCP) ficam como estão só
// quando casam com IDENTIFIER e já são ponto fixo de `redact` (seção 2). Nada de
// `tool_input` entra no fato além do alvo e do detalhe: conteúdo de arquivo,
// `old_string`, `new_string` e o `prompt` do Agent nunca são lidos.
//
// Caminhos: aceitam `\` ou `/`, a letra da unidade em qualquer caixa, os
// prefixos `\\?\` e `\\.\`, UNC e `/c/...` (MSYS). Dentro do projeto viram
// relativos com `/`; fora dele, a pasta pessoal vira `~`.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { ESCAPE_SEQUENCES, charLength, plainText, redact, redactAndCut, stripInvisible } from './redact.js';

/** @typedef {import('../../shared/contract.js').ToolCategory} ToolCategory */

/**
 * Limites em caracteres (contados com `charLength`, depois da redação).
 * Seção 10: comando, título, erro, busca, web e descrição. `name` (nomes de
 * skill, de agente, de modelo e de ferramenta desconhecida) e `path` não têm
 * limite no design: `path` usa o teto de 200 do teste de campos proibidos.
 */
export const LIMITS = Object.freeze({
  command: 120,
  title: 80,
  error: 160,
  search: 60,
  web: 80,
  description: 80,
  name: 80,
  path: 200,
});

/** Ferramentas de delegação: viram `agent.delegated` (nome antigo: Task). */
export const AGENT_TOOLS = Object.freeze(new Set(['Agent', 'Task']));

/** Categoria por `tool_name` (seção 3). MCP e Agent são tratados à parte; o resto é `other`. */
export const CATEGORY_BY_TOOL = Object.freeze(
  new Map(
    /** @type {[string, ToolCategory][]} */ ([
      ['Read', 'read'],
      ['NotebookRead', 'read'],
      ['Grep', 'search'],
      ['Glob', 'search'],
      ['LS', 'search'],
      ['LSP', 'search'],
      ['ToolSearch', 'search'],
      ['Write', 'write'],
      ['Edit', 'edit'],
      ['MultiEdit', 'edit'],
      ['NotebookEdit', 'edit'],
      // Bash e PowerShell ficam em `bash` até o T6, que acrescenta a categoria `test`.
      ['Bash', 'bash'],
      ['PowerShell', 'bash'],
      ['BashOutput', 'bash'],
      ['Monitor', 'bash'],
      ['TaskStop', 'bash'],
      ['WebFetch', 'web'],
      ['WebSearch', 'web'],
      ['TodoWrite', 'plan'],
      ['TaskCreate', 'plan'],
      ['TaskUpdate', 'plan'],
      ['TaskList', 'plan'],
      ['TaskGet', 'plan'],
      ['Skill', 'skill'],
    ]),
  ),
);

/**
 * @typedef {object} PathContext
 * @property {string|null} [projectDir]  CLAUDE_PROJECT_DIR (ou o cwd)
 * @property {string|null} [homeDir]     pasta pessoal do usuário
 */

/**
 * @typedef {object} ToolDescription
 * @property {ToolCategory|null} category    null para Agent e Task
 * @property {string|null} target
 * @property {string|null} detail
 */

/**
 * Categoria, alvo e detalhe de uma chamada de ferramenta (seção 3).
 * Para Agent e Task: categoria null, alvo = `subagent_type` e detalhe =
 * `description`, como na `Activity` do tipo `delegate` (seção 9).
 * @param {unknown} toolName
 * @param {unknown} toolInput
 * @param {PathContext} [context]
 * @returns {ToolDescription}
 */
export function describeTool(toolName, toolInput, context = {}) {
  // A categoria vem do nome cru, sem invisíveis e controles (seção 2, "Identificadores").
  const name = rawIdentifier(toolName);
  const input = isPlainObject(toolInput) ? /** @type {Record<string, unknown>} */ (toolInput) : {};

  if (AGENT_TOOLS.has(name)) {
    return {
      category: null,
      target: identifier(input.subagent_type),
      detail: textLine(input.description, LIMITS.description),
    };
  }
  if (name.startsWith('mcp__')) {
    // O alvo exibido sai do texto só com a etapa 1, nunca do cru (seção 2).
    const shown = shownIdentifierText(toolName);
    return { category: 'mcp', target: identifier(shown.startsWith('mcp__') ? mcpTarget(shown) : shown), detail: null };
  }

  const category = CATEGORY_BY_TOOL.get(name) ?? 'other';
  switch (category) {
    case 'read':
    case 'write':
    case 'edit':
      return { category, target: pathTarget(firstString(input, ['file_path', 'notebook_path', 'path']), context), detail: null };
    case 'search': {
      const pattern = firstString(input, ['pattern', 'query']);
      const target = pattern !== null
        ? textLine(pattern, LIMITS.search)
        : pathTarget(firstString(input, ['path', 'file_path', 'filePath']), context);
      return { category, target, detail: null };
    }
    case 'bash':
      return {
        category,
        target: textLine(input.command, LIMITS.command),
        detail: textLine(input.description, LIMITS.description),
      };
    case 'web':
      return {
        category,
        target: name === 'WebFetch' ? textLine(urlHost(input.url), LIMITS.web) : textLine(input.query, LIMITS.web),
        detail: null,
      };
    case 'plan':
      return { category, target: null, detail: null };
    case 'skill':
      return { category, target: identifier(firstString(input, ['skill', 'name'])), detail: null };
    default:
      return { category: 'other', target: identifier(toolName), detail: null };
  }
}

/** Identificador exibido como está (seção 2, "Identificadores"). */
export const IDENTIFIER = /^[A-Za-z0-9_.:@/-]{1,80}$/;

/** Valor cru de identificador mais longo que isto vira null (seção 2). */
export const MAX_IDENTIFIER_KEY_CHARS = 128;

/**
 * Valor cru de um identificador, para uso interno (categoria, `*Key`): sem
 * invisíveis e controles (etapa 1 da redação) e sem as sequências ANSI (como na
 * etapa 7). Nunca é exibido: tirar `ESC[g` antes da redação "come" o `g` de
 * `ghp_…` e deixaria o corpo do token à mostra. O que é exibido sai de
 * `identifier`, que redige antes de tirar as sequências.
 * @param {unknown} value
 * @returns {string}                     '' se não for texto
 */
export function rawIdentifier(value) {
  if (typeof value !== 'string') return '';
  if (value.length > RAW_SCAN_CHARS) {
    // Valor enorme: se o começo limpo já passa de 256, nenhum identificador
    // conhecido é tão longo e o *Key vira null; basta o começo.
    const head = plainText(value.slice(0, RAW_SCAN_CHARS));
    if (head.length > 256) return head;
  }
  return plainText(value);
}

/** A partir de quantos caracteres `rawIdentifier` olha primeiro só o começo. */
const RAW_SCAN_CHARS = 4096;

/**
 * Texto de um identificador para exibir, antes da regra de `identifier`: só a
 * etapa 1 (o ESC fica para a redação tirar depois de redigir).
 * @param {unknown} value
 * @returns {string}
 */
function shownIdentifierText(value) {
  return typeof value === 'string' ? stripInvisible(value) : '';
}

/**
 * Valor cru para uso interno (`agentTypeKey`, `subagentTypeKey`): sem
 * invisíveis e controles; vazio ou acima de 128 caracteres vira null. Decide o
 * papel e as comparações de tipo no reducer. Nunca vai para o painel nem para log.
 * @param {unknown} value
 * @returns {string|null}
 */
export function identifierKey(value) {
  const clean = rawIdentifier(value);
  return clean !== '' && charLength(clean) <= MAX_IDENTIFIER_KEY_CHARS ? clean : null;
}

/**
 * Identificador para exibir (`agent_type`, `subagent_type`, `tool_name`, skill,
 * modelo, servidor e ferramenta MCP): fica igual ao cru só se casar com
 * IDENTIFIER e for ponto fixo de `redact`; senão, `redactAndCut(…, 80)`.
 * Assim todo texto exibido é ponto fixo de `redact`, sem exceção (seção 2):
 * `auth:tester` aparece como `auth:•••`, e o papel sai do valor cru.
 * @param {unknown} value
 * @returns {string|null}               vazio ou não texto vira null
 */
export function identifier(value) {
  if (typeof value !== 'string') return null;
  // Valor longo: o caminho rápido daria o mesmo que textLine (um identificador
  // ponto fixo de até 80 caracteres sai igual de redactAndCut), e textLine só
  // limpa o começo do texto.
  if (value.length > 512) return textLine(value, LIMITS.name);
  const clean = shownIdentifierText(value);
  return IDENTIFIER.test(clean) && redact(clean) === clean ? clean : textLine(clean, LIMITS.name);
}

/**
 * Nome de ferramenta para exibir. MCP é remontado como
 * `mcp__<servidor>__<ferramenta>`, cada parte pela regra de identificador, porque
 * a redação não reconhece um token colado depois de `_` no nome inteiro:
 * `mcp__ghp_…__x` aparece como `mcp__•••__x` (seção 2). A categoria continua
 * vindo do nome cru (describeTool).
 * @param {unknown} value                tool_name
 * @returns {string|null}
 */
export function toolDisplayName(value) {
  const shown = shownIdentifierText(value);
  if (!shown.startsWith('mcp__')) return identifier(value);
  return mcpDisplayName(shown);
}

/**
 * `mcp__<servidor>__<ferramenta>` com cada parte pela regra de identificador.
 * @param {string} name                  já com a etapa 1
 * @returns {string|null}
 */
function mcpDisplayName(name) {
  const rest = name.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  const parts = separator <= 0 ? [rest] : [rest.slice(0, separator), rest.slice(separator + 2)];
  const shown = `mcp__${parts.map((part) => identifier(part) ?? '').join('__')}`;
  // O nome remontado também respeita o limite dos nomes (B7 do tester).
  return charLength(shown) <= LIMITS.name && redact(shown) === shown ? shown : textLine(shown, LIMITS.name);
}

/**
 * `mcp__<servidor>__<ferramenta>` → `<servidor>/<ferramenta>`. O servidor pode
 * ter `_` simples no nome; o separador é o primeiro `__` depois do prefixo.
 * @param {string} toolName
 * @returns {string|null}
 */
export function mcpTarget(toolName) {
  const rest = toolName.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return rest === '' ? null : rest;
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  return tool === '' ? server : `${server}/${tool}`;
}

/**
 * Só o host da URL (sem usuário, senha, caminho nem consulta).
 * @param {unknown} url
 * @returns {string|null}
 */
export function urlHost(url) {
  if (typeof url !== 'string') return null;
  try {
    const host = new URL(url.trim()).host;
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * Caminho para exibir: relativo ao projeto, com `/`; fora do projeto, a pasta
 * pessoal vira `~`; fora das duas, o caminho absoluto com `/`. Caminho relativo
 * fica como veio, com `/`. Não corta (quem corta é `redactAndCut`).
 * @param {unknown} filePath
 * @param {PathContext} [context]
 * @returns {string|null}
 */
export function displayPath(filePath, { projectDir = null, homeDir = null } = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return null;
  // `/c/...` (MSYS, Git Bash) só vira `c:/...` quando o contexto é do Windows.
  const drives = hasDriveLetter(projectDir) || hasDriveLetter(homeDir);
  const file = toDriveForm(normalizeSlashes(filePath), drives);
  if (!isAbsolute(file)) return file;

  const insideProject = relativeTo(file, projectDir, drives);
  if (insideProject !== null) return insideProject === '' ? '.' : insideProject;
  const insideHome = relativeTo(file, homeDir, drives);
  if (insideHome !== null) return insideHome === '' ? '~' : `~/${insideHome}`;
  return file;
}

/**
 * Normaliza um caminho com `\` ou `/`: tira os prefixos `\\?\` e `\\.\`
 * (`\\?\UNC\srv\share` vira `\\srv\share`), resolve `.` e `..`, usa `/` e
 * tira a barra do fim (menos na raiz). Caminhos com letra de unidade, `\` ou
 * `//` no começo (UNC) são do Windows, e o UNC mantém as duas barras.
 * @param {string} value
 * @returns {string}
 */
export function normalizeSlashes(value) {
  let text = value;
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(text)) text = `\\\\${text.slice(8)}`;
  else if (/^[\\/]{2}[?.][\\/]/.test(text)) text = text.slice(4);
  const windows = /^[A-Za-z]:/.test(text) || text.includes('\\') || text.startsWith('//');
  let out = windows ? path.win32.normalize(text).replace(/\\/g, '/') : path.posix.normalize(text);
  if (out.length > 1 && out.endsWith('/') && !/^[A-Za-z]:\/$/.test(out) && out !== '//') out = out.slice(0, -1);
  return out;
}

/**
 * @param {unknown} value
 * @returns {boolean}                    caminho com letra de unidade (em qualquer forma)
 */
function hasDriveLetter(value) {
  return typeof value === 'string' && value.trim() !== '' && /^[A-Za-z]:\//.test(normalizeSlashes(value));
}

/**
 * `/c/Users/...` → `c:/Users/...`, só quando `drives` (o projeto ou a pasta
 * pessoal têm letra de unidade), para não confundir um caminho Linux.
 * @param {string} normalized
 * @param {boolean} drives
 * @returns {string}
 */
function toDriveForm(normalized, drives) {
  if (!drives) return normalized;
  const match = /^\/([A-Za-z])(?=\/|$)/.exec(normalized);
  return match ? `${match[1]}:${normalized.slice(2) || '/'}` : normalized;
}

/**
 * Primeira linha não vazia do texto, sem espaços nas pontas.
 * @param {unknown} text
 * @returns {string|null}
 */
export function firstLine(text) {
  if (typeof text !== 'string') return null;
  const lines = /[^\r\n\u2028\u2029]+/g;
  let match;
  while ((match = lines.exec(text))) {
    const line = match[0].trim();
    if (line !== '') return line;
  }
  return null;
}

/**
 * Quantos caracteres do começo de um texto o normalizador lê para achar a
 * primeira linha. O encaminhador já corta strings em 4 KiB; o limite só evita
 * redigir um texto enorme inteiro (POST local de até 1 MiB) para exibir no
 * máximo 200 caracteres. Não é corte de texto exibido: quem corta é `redactAndCut`.
 */
export const SCAN_CHARS = 8192;

/**
 * Começo do texto que o normalizador lê: até SCAN_CHARS caracteres, terminando
 * no último espaço em branco antes do limite, para nunca partir um token no
 * meio (um token partido poderia ficar abaixo do tamanho mínimo da redação e
 * aparecer pela metade). Sem espaço em branco no trecho, devolve o trecho todo,
 * e `firstRedactedLine` descarta a última palavra depois da redação. Espaço em
 * branco que a redação remove não conta como fronteira (`boundaryChecker`).
 * @param {string} value
 * @param {(index: number) => boolean} [boundary]   padrão: boundaryChecker(value)
 * @returns {string}
 */
export function scanWindow(value, boundary) {
  if (value.length <= SCAN_CHARS) return value;
  const isBoundary = boundary ?? boundaryChecker(value);
  if (isBoundary(SCAN_CHARS)) return value.slice(0, SCAN_CHARS);
  for (let i = SCAN_CHARS - 1; i >= 0; i--) {
    if (isBoundary(i)) return value.slice(0, i);
  }
  return value.slice(0, SCAN_CHARS);
}

/**
 * Fronteira de palavra: espaço em branco que continua depois da redação.
 * Espaços dentro de uma sequência ANSI completa (o intermediário 0x20 de uma
 * CSI, o texto de uma OSC) saem com ela na etapa 7 da redação, então não servem
 * de fronteira; senão, juntariam de novo um token partido (como no B4).
 * Linear: as sequências são marcadas numa passada.
 * @param {string} text
 * @param {boolean} [openEnded]          o texto é só o começo: uma CSI ou OSC aberta
 *                                       até o fim pode terminar depois, então também conta
 * @returns {(index: number) => boolean}
 */
export function boundaryChecker(text, openEnded = false) {
  if (!text.includes('\x1B')) return (index) => isWhitespace(text[index]);
  const removed = new Uint8Array(text.length);
  const sequences = new RegExp(ESCAPE_SEQUENCES.source, 'g');
  let match;
  while ((match = sequences.exec(text))) removed.fill(1, match.index, match.index + match[0].length);
  if (openEnded) {
    const last = text.lastIndexOf('\x1B');
    const tail = text.slice(last);
    if (/^\x1B\[[\x20-\x3F]*$/.test(tail) || /^\x1B\][^\x07\x1B]*$/.test(tail)) removed.fill(1, last);
  }
  return (index) => isWhitespace(text[index]) && removed[index] !== 1;
}

/**
 * Primeira linha não vazia depois da redação. Redige antes de separar as
 * linhas, para pegar segredos que atravessam linhas (bloco de chave privada).
 * @param {unknown} value
 * @returns {string|null}
 */
export function firstRedactedLine(value) {
  if (typeof value !== 'string') return null;
  return firstLine(redactWindow(value));
}

/**
 * Redação com a leitura limitada (seção 2, "Leitura limitada"): só o começo do
 * texto (até SCAN_CHARS, terminando numa fronteira de palavra) passa pela
 * redação. É o "cinto de segurança" de todo chamador que redige texto externo
 * (seção 10, etapa 6): o normalizador e o sanitize.mjs usam esta função.
 * @param {unknown} value
 * @returns {string}                     texto redigido (pode ter várias linhas)
 */
export function redactWindow(value) {
  if (typeof value !== 'string') return '';
  // A etapa 1 vem antes de procurar fronteiras: U+FEFF, \v e \f são espaço em
  // branco para /\s/, mas a redação os remove, e uma fronteira calculada neles
  // juntaria de novo um token partido (B4).
  const { text: head, more } = cleanedHead(value);
  const text = dropCutWords(head);
  if (!more && text.length <= SCAN_CHARS) return redact(text);
  const boundary = boundaryChecker(text, more);
  const window = text.length > SCAN_CHARS ? scanWindow(text, boundary) : text;
  const redacted = redact(window);
  // Trecho que termina no meio de uma palavra (não havia espaço em branco para
  // recuar): a redação pode ter encolhido o que vinha antes (invisíveis
  // removidos, token longo virando •••), e a última palavra pode ser um token
  // partido. Ela sai depois da redação, como no redactAndCut.
  const cutInsideWord = window.length < text.length ? !boundary(window.length) : more;
  return cutInsideWord ? dropLastWord(redacted) : redacted;
}

/** Quantos caracteres do original a etapa 1 limpa de uma vez em textos longos. */
const HEAD_CHARS = SCAN_CHARS * 4;

/**
 * Começo do texto já com a etapa 1, sem limpar um texto enorme inteiro: como a
 * etapa 1 só remove caracteres, o começo limpo vem de um começo do original.
 * Se o começo limpo for curto demais (muitos invisíveis), limpa tudo.
 * @param {string} value
 * @returns {{ text: string, more: boolean }}   `more`: o original continua depois de `text`
 */
function cleanedHead(value) {
  if (value.length > HEAD_CHARS) {
    const head = stripInvisible(value.slice(0, HEAD_CHARS));
    if (head.length > SCAN_CHARS * 2) return { text: head, more: true };
  }
  return { text: stripInvisible(value), more: false };
}

/**
 * Marcador do corte de strings longas do encaminhador (seção 1). O formato é
 * contrato entre os dois lados: mudar o marcador exige mudar os dois.
 */
export const CUT_MARKER = /…\[cortado \d+ caracteres\]…/g;

/**
 * B3: o corte do encaminhador é por posição e pode partir um token antes da
 * redação. Cada `<palavra>…[cortado N caracteres]…<palavra>` vira `…`, em que
 * palavra é a sequência máxima sem espaço em branco encostada no marcador, de
 * cada lado (seção 2, "Marcador de corte do encaminhador"). Laço linear.
 * @param {string} text
 * @returns {string}
 */
export function dropCutWords(text) {
  if (!text.includes('[cortado ')) return text;
  let out = '';
  let last = 0;
  const boundary = boundaryChecker(text);
  const marker = new RegExp(CUT_MARKER.source, 'g');
  const markerAt = new RegExp(CUT_MARKER.source, 'y');
  let match;
  while ((match = marker.exec(text))) {
    let start = match.index;
    while (start > last && !boundary(start - 1)) start--;
    let end = match.index + match[0].length;
    while (end < text.length && !boundary(end)) {
      // O marcador tem espaços por dentro: um marcador colado faz parte da palavra.
      markerAt.lastIndex = end;
      end = text[end] === '…' && markerAt.test(text) ? markerAt.lastIndex : end + 1;
    }
    out += `${text.slice(last, start)}…`;
    last = end;
    marker.lastIndex = end;
  }
  return out + text.slice(last);
}

/**
 * Tira a última sequência sem espaço em branco do fim do texto (laço linear).
 * @param {string} text
 * @returns {string}
 */
function dropLastWord(text) {
  let end = text.length;
  while (end > 0 && !isWhitespace(text[end - 1])) end--;
  return text.slice(0, end);
}

/**
 * @param {string|undefined} char
 * @returns {boolean}
 */
function isWhitespace(char) {
  return char !== undefined && /\s/.test(char);
}

/**
 * Texto de uma linha para o fato: a primeira linha redigida, cortada com
 * `redactAndCut`. O resultado é sempre ponto fixo de `redact`. Vazio ou não
 * texto vira null.
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
export function textLine(value, max) {
  const line = firstRedactedLine(value);
  if (line === null) return null;
  const out = redactAndCut(line, max);
  return out === '' ? null : out;
}

/**
 * SHA-256 do `tool_input` serializado com as chaves em ordem, 16 primeiros
 * caracteres hexadecimais (seção 2). Casa o PermissionRequest com o PreToolUse
 * sem guardar o conteúdo.
 * @param {unknown} toolInput
 * @returns {string|null}               null se não houver `tool_input`
 */
export function inputHash(toolInput) {
  if (toolInput === undefined) return null;
  try {
    return createHash('sha256').update(stableStringify(toolInput)).digest('hex').slice(0, 16);
  } catch {
    // tool_input aninhado demais estoura a pilha: só o hash fica null, não o fato.
    return null;
  }
}

/**
 * JSON com as chaves dos objetos em ordem, em qualquer profundidade.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value);
    const entries = Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string|null} filePath
 * @param {PathContext} context
 * @returns {string|null}
 */
function pathTarget(filePath, context) {
  // Redige o caminho cru antes de normalizar: trocar "\" por "/" e resolver ".."
  // desfaria o que a redação procura (https:// virando https:/, aspas escapadas).
  // A pasta do projeto já é ponto fixo de redact, então a comparação continua valendo.
  return textLine(displayPath(firstRedactedLine(filePath), context), LIMITS.path);
}

/**
 * Primeiro valor em texto não vazio entre as chaves, na ordem.
 * @param {Record<string, unknown>} input
 * @param {string[]} keys
 * @returns {string|null}
 */
function firstString(input, keys) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * @param {string} normalized            saída de normalizeSlashes
 * @returns {boolean}
 */
function isAbsolute(normalized) {
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/');
}

/**
 * Parte de `file` depois de `base`, se `file` estiver dentro de `base` ('' se
 * forem iguais), ou null. Caminhos do Windows são comparados sem diferenciar
 * maiúsculas (inclusive a letra da unidade); o resultado mantém a caixa original.
 * @param {string} file                  já normalizado
 * @param {string|null|undefined} base   qualquer forma
 * @param {boolean} drives               contexto com letra de unidade (para `/c/...`)
 * @returns {string|null}
 */
function relativeTo(file, base, drives) {
  if (typeof base !== 'string' || base.trim() === '') return null;
  const root = toDriveForm(normalizeSlashes(base), drives);
  if (!isAbsolute(root)) return null;
  const windows = /^[A-Za-z]:\//.test(root) || /^[A-Za-z]:\//.test(file) || root.startsWith('//');
  const fold = (/** @type {string} */ text) => (windows ? text.toLowerCase() : text);

  const head = file.slice(0, root.length);
  if (fold(head) !== fold(root)) return null;
  if (file.length === root.length) return '';
  if (root.endsWith('/')) return file.slice(root.length);
  return file[root.length] === '/' ? file.slice(root.length + 1) : null;
}
