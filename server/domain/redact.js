// @ts-check
// Redação de segredos (modelo de eventos, seção 10, revista duas vezes em
// 18/10/2026; ADR 0006, complemento "redação"). É o único lugar com regras de
// redação: o normalizador e a sanitização dos cenários do T0
// (tools/probe/sanitize.mjs) usam este módulo. Puro: não importa node:* nem
// nada do servidor, e roda também no navegador.
//
// Contrato público: redact, redactAndCut e charLength. isSensitiveName é
// exportada só para os testes.
//
// Etapas de redact, nesta ordem (toda troca vira "•••"):
//   1. remove caracteres invisíveis ([\p{Default_Ignorable_Code_Point}\p{Cf}]);
//   2. blocos de chave privada (rótulo com PRIVATE KEY);
//   3. tokens com prefixo conhecido (colados uns nos outros viram um só);
//   4. credenciais embutidas: usuário e senha em URL e em -u/--user;
//   5. cabeçalhos de credencial e `Bearer <valor>` solto;
//   6. pares nome-valor com nome sensível (separadores :=, ?=, +=, =>, =, :;
//      `"nome": "valor"`, `'nome' => 'valor'`, `setx NOME valor`,
//      `--nome valor`, `--nome=valor`).
//
// Propriedades: idempotente; nunca lança exceção; tempo linear. As expressões
// só começam no início de uma sequência de caracteres de nome (lookbehind),
// não têm quantificadores aninhados ambíguos, e o valor de um par só é lido
// quando o nome é sensível, então nenhum trecho é relido a cada par.

/** O que fica no lugar de cada segredo. */
export const REDACTED = '•••';

// 1. Invisíveis: largura zero, hífen suave, direção, U+2061 a U+2064, U+180E,
// U+034F, seletores de variação, preenchedores Hangul e tags.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

// 2. Blocos de chave privada: o rótulo precisa conter PRIVATE KEY.
const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]{0,60}PRIVATE KEY[A-Z0-9 ]{0,60})-----/g;

// 3. Tokens com prefixo conhecido, com tamanho mínimo depois do prefixo.
const TOKEN_FORMS = [
  'sk-ant-[A-Za-z0-9_-]{8,}',
  'sk-[A-Za-z0-9_-]{16,}',
  '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}',
  'gh[pousr]_[A-Za-z0-9]{16,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'glpat-[A-Za-z0-9_-]{20,}',
  'npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])',
  'pypi-[A-Za-z0-9_-]{32,}',
  'hf_[A-Za-z0-9]{16,}',
  'AKIA[0-9A-Z]{16}(?![0-9A-Z])',
  'AIza[0-9A-Za-z_-]{20,}',
  'xox[abprs]-[A-Za-z0-9-]{10,}',
  'xapp-[A-Za-z0-9-]{10,}',
  'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+', // JWT
];
const TOKENS = new RegExp(`(?<![A-Za-z0-9_-])(?:${TOKEN_FORMS.join('|')})`, 'g');
// O mesmo, ancorado numa posição: acha um token colado logo depois de outro
// (o lookbehind de TOKENS olharia o caractere original e não o reconheceria).
const TOKEN_AT = new RegExp(`(?:${TOKEN_FORMS.join('|')})`, 'y');

// Valores entre aspas: até a aspa de fechamento não escapada; sem fechamento,
// até o fim da linha. Valor sem aspas: até um espaço ou delimitador.
const DOUBLE_QUOTED = /"(?:\\[^\n]|[^"\\\n])*(?:"|\\?(?=\n|$))/.source;
const SINGLE_QUOTED = /'(?:\\[^\n]|[^'\\\n])*(?:'|\\?(?=\n|$))/.source;
const BARE_VALUE = /[^\s&;,"'{}()[\]<>|]+/.source;
const ANY_VALUE = `•••|${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${BARE_VALUE}`;

// 4. Credenciais embutidas.
const URL_CREDENTIALS = /(:\/\/)[^/\s:@]+:[^/\s@]+@/g;
const USER_VALUE = /"[^"\n]*:[^"\n]*"|'[^'\n]*:[^'\n]*'|[^\s"':]+:[^\s"']*/.source;
const USER_OPTION = new RegExp(`(?<![A-Za-z0-9_-])(?:(-u)([ \\t]*)|(--user)([ \\t]+|=))(?:${USER_VALUE})`, 'g');

// 5. Cabeçalhos (em qualquer caixa, também dentro de aspas) e Bearer solto.
// Um valor que já começa com "•••" é reconhecido só por isso (idempotência).
const HEADER_VALUE = /•••|"(?:\\[^\r\n]|[^"\\\r\n])*"?|'(?:\\[^\r\n]|[^'\\\r\n])*'?|(?:\\[^\r\n]|[^\r\n"'\\])+/.source;
const HEADER = new RegExp(`(?<![A-Za-z0-9-])((?:proxy-)?authorization|set-cookie|cookie|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-(?:key|token|secret))(["']?[ \\t]*:[ \\t]*)(?:${HEADER_VALUE})`, 'gi');
const BEARER = /(?<![A-Za-z0-9_-])(bearer)[ \t]+[A-Za-z0-9._~+/-]+=*/gi;

// 6. Pares nome-valor. Separadores: o mais longo vale.
const SEPARATOR = /[ \t]*(?::=|\?=|\+=|=>|=|:)[ \t]*/.source;
const PAIR_NAME = new RegExp(`(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]*)(["']?${SEPARATOR})`, 'g');
const PAIR_VALUE = new RegExp(`(?:${ANY_VALUE})`, 'y');
const SETX = new RegExp(`(?<![A-Za-z0-9_.-])(setx[ \\t]+)([A-Za-z_][A-Za-z0-9_.-]*)([ \\t]+)(${ANY_VALUE})`, 'gi');
const LONG_OPTION = new RegExp(`(?<![A-Za-z0-9_-])--([A-Za-z][A-Za-z0-9-]*)(=|[ \\t]+)(•••|${DOUBLE_QUOTED}|${SINGLE_QUOTED}|[^\\s"'-][^\\s"']*)`, 'g');

const CONTAINED_WORDS = ['password', 'passwd', 'passphrase', 'secret', 'credential', 'apikey', 'accesskey', 'privatekey'];
const SENSITIVE_PARTS = new Set(['token', 'pwd', 'auth', 'sig', 'signature']);
const NAME_SPLIT = /[_.-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const QUICK_WORDS = ['pass', 'secret', 'credential', 'key', 'token', 'pwd', 'auth', 'sig'];

/** Quantas vezes redactAndCut recua o corte antes de desistir e devolver só "…". */
const MAX_CUT_RETRIES = 64;

/**
 * Diz se um nome de variável, chave ou opção é sensível. O nome é dividido
 * por `_`, `-`, `.`, pela troca de minúscula ou dígito para maiúscula e pela
 * fronteira de sigla; as partes vão para minúsculas e a junção delas é a
 * "forma colada". Exportada só para os testes.
 * @param {string} name
 * @returns {boolean}
 */
export function isSensitiveName(name) {
  // Filtro rápido: toda regra exige uma destas palavras na forma colada.
  const quick = String(name).replace(/[_.-]+/g, '').toLowerCase();
  if (!QUICK_WORDS.some((word) => quick.includes(word))) return false;
  const parts = String(name).split(NAME_SPLIT).filter(Boolean).map((part) => part.toLowerCase());
  if (!parts.length) return false;
  const glued = parts.join('');
  return CONTAINED_WORDS.some((word) => glued.includes(word))
    || glued.endsWith('token')
    || parts.some((part) => SENSITIVE_PARTS.has(part))
    || parts[parts.length - 1] === 'key';
}

/**
 * Quantidade de caracteres (pontos de código Unicode). É a única definição de
 * "caractere" nos limites do projeto. Entrada que não é texto conta 0.
 * @param {unknown} text
 * @returns {number}
 */
export function charLength(text) {
  if (typeof text !== 'string') return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (isPairStart(text, i)) i++;
    count++;
  }
  return count;
}

/**
 * Troca segredos por "•••". Nunca lança: entrada que não é texto vira '', e
 * qualquer falha interna devolve só "•••".
 * @param {unknown} text
 * @returns {string}
 */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return '';
  try {
    let out = text.replace(INVISIBLE, '');
    out = redactPrivateKeys(out);
    out = redactTokens(out);
    out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
    out = out.replace(USER_OPTION, (whole, short, shortSep, long, longSep) => (
      short !== undefined ? `${short}${shortSep}${REDACTED}` : `${long}${longSep}${REDACTED}`
    ));
    out = out.replace(HEADER, `$1$2${REDACTED}`);
    out = out.replace(BEARER, `$1 ${REDACTED}`);
    out = redactPairs(out);
    out = out.replace(SETX, (whole, command, name, gap, value) => (
      value !== REDACTED && isSensitiveName(name) ? `${command}${name}${gap}${REDACTED}` : whole
    ));
    out = out.replace(LONG_OPTION, (whole, name, separator, value) => (
      value !== REDACTED && isSensitiveName(name) ? `--${name}${separator}${REDACTED}` : whole
    ));
    return out;
  } catch {
    return REDACTED;
  }
}

/**
 * Redige e corta para no máximo `max` caracteres, contando o "…" final. É a
 * única função de corte de textos exibidos. Regra (seção 10):
 *   1. r = redact(text); se couber, devolve r;
 *   2. senão, os primeiros max − 1 caracteres de r mais "…";
 *   3. enquanto o resultado não for ponto fixo de redact, recua o corte para
 *      antes da última palavra; no limite, sobra só "…".
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function redactAndCut(text, max) {
  const limit = Math.floor(Number(max));
  if (!(limit > 0)) return '';
  const redacted = redact(text);
  if (charLength(redacted) <= limit) return redacted;
  let head = takeChars(redacted, limit - 1);
  for (let i = 0; i < MAX_CUT_RETRIES; i++) {
    const candidate = `${head}…`;
    if (redact(candidate) === candidate) return candidate;
    const shorter = dropLastWord(head);
    if (shorter === head) break;
    head = shorter;
  }
  return '…';
}

/**
 * Tira do fim os espaços e a última palavra (sequência sem espaço), mantendo o
 * espaço anterior. Sem palavra, devolve o mesmo texto. Laço simples, linear,
 * para uma palavra longa não custar uma volta por posição.
 * @param {string} text
 */
function dropLastWord(text) {
  let end = text.length;
  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--;
  if (end === 0) return text;
  while (end > 0 && !isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

/**
 * Espaço em branco no sentido de \s das expressões regulares.
 * @param {number} code
 * @returns {boolean}
 */
function isSpace(code) {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** @param {string} text */
function redactPrivateKeys(text) {
  let out = '';
  let last = 0;
  PEM_BEGIN.lastIndex = 0;
  let match;
  while ((match = PEM_BEGIN.exec(text))) {
    const endMarker = `-----END ${match[1]}-----`;
    const end = text.indexOf(endMarker, PEM_BEGIN.lastIndex);
    const stop = end >= 0 ? end + endMarker.length : text.length;
    out += text.slice(last, match.index) + REDACTED;
    last = stop;
    PEM_BEGIN.lastIndex = stop;
  }
  return out + text.slice(last);
}

/**
 * Tokens com prefixo conhecido. Tokens colados uns nos outros viram um "•••"
 * só, já na primeira passada (idempotência).
 * @param {string} text
 */
function redactTokens(text) {
  let out = '';
  let last = 0;
  TOKENS.lastIndex = 0;
  let match;
  while ((match = TOKENS.exec(text))) {
    let end = match.index + match[0].length;
    for (;;) {
      TOKEN_AT.lastIndex = end;
      const glued = TOKEN_AT.exec(text);
      if (!glued || !glued[0]) break;
      end += glued[0].length;
    }
    out += text.slice(last, match.index) + REDACTED;
    last = end;
    TOKENS.lastIndex = end;
  }
  return out + text.slice(last);
}

/**
 * Pares nome-valor. Quando o nome não é sensível, a busca continua logo depois
 * do separador, para achar um par dentro do valor (`a=token=x`); o valor só é
 * lido quando o nome é sensível, e depois a busca continua depois dele.
 * @param {string} text
 */
function redactPairs(text) {
  let out = '';
  let last = 0;
  PAIR_NAME.lastIndex = 0;
  let match;
  while ((match = PAIR_NAME.exec(text))) {
    if (!isSensitiveName(match[1])) continue;
    const valueStart = match.index + match[0].length;
    PAIR_VALUE.lastIndex = valueStart;
    const value = PAIR_VALUE.exec(text);
    if (!value) continue;
    const valueEnd = valueStart + value[0].length;
    if (value[0] !== REDACTED) {
      out += text.slice(last, valueStart) + REDACTED;
      last = valueEnd;
    }
    PAIR_NAME.lastIndex = valueEnd;
  }
  return out + text.slice(last);
}

/**
 * Os primeiros `n` caracteres (pontos de código), sem partir um par de surrogates.
 * @param {string} text
 * @param {number} n
 * @returns {string}
 */
function takeChars(text, n) {
  let i = 0;
  for (let count = 0; count < n && i < text.length; count++) i += isPairStart(text, i) ? 2 : 1;
  return text.slice(0, i);
}

/**
 * true quando a posição começa um par de surrogates válido.
 * @param {string} text
 * @param {number} i
 * @returns {boolean}
 */
function isPairStart(text, i) {
  const high = text.charCodeAt(i);
  if (high < 0xd800 || high > 0xdbff || i + 1 >= text.length) return false;
  const low = text.charCodeAt(i + 1);
  return low >= 0xdc00 && low <= 0xdfff;
}
