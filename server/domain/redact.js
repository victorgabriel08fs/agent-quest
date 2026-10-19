// @ts-check
// Redação de segredos (modelo de eventos, seção 10, revista duas vezes em
// 18/10/2026; ADR 0006, complemento "redação"). É o único lugar com regras de
// redação: o normalizador e a sanitização dos cenários do T0
// (tools/probe/sanitize.mjs) usam este módulo. Puro: não importa node:* nem
// nada do servidor, e roda também no navegador.
//
// Contrato público: redact, redactAndCut e charLength; stripInvisible (a etapa
// 1 sozinha) limpa os identificadores no normalizador. isSensitiveName é
// exportada só para os testes.
//
// Etapas de redact, nesta ordem (toda troca vira "•••"):
//   1. troca surrogates soltos por U+FFFD e remove caracteres invisíveis
//      ([\p{Default_Ignorable_Code_Point}\p{Cf}]) e controles de um caractere
//      (C0 menos \t, \n, \r e ESC; DEL; C1); \t vira espaço;
//   2. blocos de chave privada (rótulo com PRIVATE KEY);
//   3. tokens com prefixo conhecido (colados uns nos outros viram um só);
//   4. credenciais embutidas: usuário e senha em URL e em -u/--user;
//   5. cabeçalhos de credencial e `Bearer <valor>` solto;
//   6. pares nome-valor com nome sensível (separadores :=, ?=, +=, =>, =, :;
//      `"nome": "valor"`, `'nome' => 'valor'`, `setx NOME valor`,
//      `--nome valor`, `--nome=valor`);
//   7. sequências ANSI (CSI do ECMA-48 e OSC) e qualquer ESC ou BEL que sobrar,
//      depois da redação, para não comer letras de tokens (`ESC[ghp_…` vira `[•••`);
//      se saiu algo, as etapas 2 a 6 rodam de novo (no máximo duas passadas).
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
// 1. Controles de um caractere (18/10/2026): C0 menos \t, \n, \r e ESC; DEL; C1.
// O ESC fica: as sequências ANSI só saem na etapa 7, depois da redação. Uma OSC
// terminada por BEL fica inteira: ali o BEL faz parte da sequência (não é um
// controle de um caractere), e a etapa 7 a remove junto.
const CONTROLS = /(\x1B\][^\x07\x1B]*\x07)|[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F-\x9F]/g;
// Controles de um caractere dentro do corpo de uma OSC mantida (B6 do tester):
// saem também, e só o BEL que a fecha fica para a etapa 7.
const OSC_BODY_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F-\x9F]/g;
const TAB = /\t/g;

// 7. Sequências ANSI (18/10/2026), depois da redação: CSI na gramática do
// ECMA-48 (parâmetros 0x30–0x3F, intermediários 0x20–0x2F, final 0x40–0x7E),
// OSC completa (até BEL ou ESC \) e OSC aberta com o corpo até o próximo ESC,
// BEL, espaço em branco ou fim (19/10/2026, a mesma forma da alternativa 3 de
// SEQ: um terminal esconderia esse corpo, e o painel não mostra mais de um
// token partido do que o terminal mostraria); depois, qualquer ESC ou BEL que
// sobrar. Cada tentativa para no próximo ESC (o corpo da OSC aberta, também no
// espaço), então o tempo é linear. Exportada para o normalizador saber quais
// espaços em branco a redação remove (fronteiras de leitura).
export const ESCAPE_SEQUENCES = /\x1B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\](?![^\x07\x1B]*(?:\x07|\x1B\x5C))[^\x07\x1B\s]*/g;
// ESC de sequência incompleta e BEL que sobrar. O BEL só chega aqui se fechava
// uma OSC (etapa 1) e a redação quebrou a sequência, por exemplo engolindo o ESC
// dentro de um valor redigido; ele sai com o resto da OSC (B6 do tester).
const LEFTOVER = /[\x07\x1B]/g;

// Sequências ANSI dentro de valores (B8 do tester; seção 10, etapa 6): como o
// ESC só sai na etapa 7, as classes de valor sem aspas que não exigem nada
// depois do laço aceitam uma sequência como parte do valor: `(?:SEQ|X)+`, em que
// X é a classe sem o ESC. Em cada ESC, exatamente uma das quatro alternativas de
// SEQ casa, com um único comprimento (leitura única):
//   1. CSI completa ou incompleta: todos os bytes 0x20–0x3F e, se houver, o
//      final; se o próximo não for ASCII imprimível (ESC, fim, `ç`), termina
//      incompleta. Encurtar o laço deixaria um byte 0x20–0x3F como próximo, e as
//      duas saídas falham.
//   2. OSC completa (até BEL ou ESC \).
//   3. OSC aberta (sem terminador, B11 do tester): o `ESC]` e o corpo até o
//      próximo ESC, BEL, espaço em branco ou fim; o lookahead final força o corpo
//      máximo. Um espaço continua terminando o valor.
//   4. ESC solto: todo ESC que não começa `[` nem `]`.
// A etapa 7 continua removendo só o que o ECMA-48 reconhece (ESCAPE_SEQUENCES).
//
// Linearidade por construção (B10 do tester; seção 10, etapa 6), regras para
// toda expressão das etapas 3 a 6:
//   1. cabeça antes do laço: pares, `setx` e `--nome` procuram só a cabeça,
//      julgam o nome e só então leem o valor com uma expressão ancorada;
//   2. começos disjuntos: nenhum caractere que pode estar dentro do laço de uma
//      tentativa pode ser a borda à esquerda de um novo começo (tokens e
//      credencial em URL sem SEQ; `-u` só depois de espaço ou aspas);
//   3. SEQ só em laços sem exigência depois (pares, `setx`, `--nome`,
//      cabeçalhos, `Bearer`, `-u` sem aspas): o laço casa de primeira, guloso;
//   4. o cursor nunca volta.
const CSI = /\x1B\[[\x20-\x3F]*(?:[\x40-\x7E]|(?![\x20-\x7E]))/.source;
const OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\x5C)/.source;
const OSC_OPEN = /\x1B\](?![^\x07\x1B]*(?:\x07|\x1B\x5C))[^\x07\x1B\s]*(?![^\x07\x1B\s])/.source;
const LONE_ESC = /\x1B(?![\[\]])/.source;
const SEQ = `${CSI}|${OSC}|${OSC_OPEN}|${LONE_ESC}`;
/** Um elemento de valor: uma sequência ANSI ou um caractere da classe `x` (sem ESC). */
const unit = (/** @type {string} */ x) => `(?:${SEQ}|${x})`;

// 2. Blocos de chave privada: o rótulo precisa conter PRIVATE KEY.
const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]{0,60}PRIVATE KEY[A-Z0-9 ]{0,60})-----/g;

// 3. Tokens com prefixo conhecido, com tamanho mínimo depois do prefixo. O corpo
// tem só os caracteres do token, sem SEQ (revertido do B8 no B10): a borda à
// esquerda exclui esses mesmos caracteres, então nenhum começo cai dentro do
// corpo de outro. Um token com cor é pego na segunda passada, sem a cor.
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
  // JWT: um começo só cabe no início de um segmento, e cada tentativa examina
  // no máximo três segmentos.
  'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
];
const TOKENS = new RegExp(`(?<![A-Za-z0-9_-])(?:${TOKEN_FORMS.join('|')})`, 'g');
// O mesmo, ancorado numa posição: acha um token colado logo depois de outro
// (o lookbehind de TOKENS olharia o caractere original e não o reconheceria).
const TOKEN_AT = new RegExp(`(?:${TOKEN_FORMS.join('|')})`, 'y');

// Valores entre aspas: até a aspa de fechamento não escapada; sem fechamento,
// até o fim da linha (sem mudança com o B8). Valor sem aspas: até um espaço ou
// delimitador, com as sequências ANSI como parte do valor; um valor que começa
// com ESC casa e absorve a sequência.
const DOUBLE_QUOTED = /"(?:\\[^\n]|[^"\\\n])*(?:"|\\?(?=\n|$))/.source;
const SINGLE_QUOTED = /'(?:\\[^\n]|[^'\\\n])*(?:'|\\?(?=\n|$))/.source;
const BARE_VALUE = `${unit(/[^\s&;,"'{}()[\]<>|\x1B]/.source)}+`;
const ANY_VALUE = `•••|${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${BARE_VALUE}`;

// 4. Credenciais embutidas. Na URL, o corpo exclui `/` (parte da cabeça `://`)
// e não aceita SEQ (revertido do B8 no B10); a classe já aceita o ESC e o `[`,
// então uma credencial com cor continua sendo pega. O `-u`/`--user` só começa
// no início ou depois de espaço em branco ou aspas, e o valor sem aspas é um
// laço só, sem exigência depois: o `:` é conferido fora da expressão.
const URL_CREDENTIALS = /(:\/\/)[^/\s:@]+:[^/\s@]+@/g;
const USER_QUOTED = /"[^"\n]*:[^"\n]*"|'[^'\n]*:[^'\n]*'/.source;
const USER_BARE = `${unit(/[^\s"'\x1B]/.source)}+`;
const USER_OPTION = new RegExp(`(?<![^\\s"'])(?:(-u)([ \\t]*)|(--user)([ \\t]+|=))(${USER_QUOTED}|${USER_BARE})`, 'g');

// 5. Cabeçalhos (em qualquer caixa, também dentro de aspas) e Bearer solto.
// Um valor que já começa com "•••" é reconhecido só por isso (idempotência).
const HEADER_QUOTED = /•••|"(?:\\[^\r\n]|[^"\\\r\n])*"?|'(?:\\[^\r\n]|[^'\\\r\n])*'?/.source;
const HEADER_VALUE = `${HEADER_QUOTED}|${unit(/\\[^\r\n]|[^\r\n"'\\\x1B]/.source)}+`;
const HEADER = new RegExp(`(?<![A-Za-z0-9-])((?:proxy-)?authorization|set-cookie|cookie|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-(?:key|token|secret))(["']?[ \\t]*:[ \\t]*)(?:${HEADER_VALUE})`, 'gi');
const BEARER = new RegExp(`(?<![A-Za-z0-9_-])(bearer)[ \\t]+${unit('[A-Za-z0-9._~+/-]')}+=*`, 'gi');

// 6. Pares nome-valor, `setx NOME valor` e `--nome valor`: uma busca global só
// da cabeça (nome e separador), o teste de sensibilidade do nome e, para nome
// sensível, o valor com uma expressão ancorada (flag y) logo depois da cabeça.
// Um nome não sensível nunca tem o valor examinado. Separadores: o mais longo vale.
const SEPARATOR = /[ \t]*(?::=|\?=|\+=|=>|=|:)[ \t]*/.source;
const PAIR_NAME = new RegExp(`(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]*)(["']?${SEPARATOR})`, 'g');
const PAIR_VALUE = new RegExp(`(?:${ANY_VALUE})`, 'y');
const SETX_HEAD = /(?<![A-Za-z0-9_.-])setx[ \t]+([A-Za-z_][A-Za-z0-9_.-]*)[ \t]+/gi;
const LONG_OPTION_HEAD = /(?<![A-Za-z0-9_-])--([A-Za-z][A-Za-z0-9-]*)(?:=|[ \t]+)/g;
const LONG_OPTION_VALUE = new RegExp(
  `•••|${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${unit(/[^\s"'\x1B-]/.source)}${unit(/[^\s"'\x1B]/.source)}*`,
  'y',
);

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
 * Etapa 1 da redação: troca surrogates soltos por U+FFFD, depois tira os
 * caracteres invisíveis e os controles de um caractere (C0 menos \t, \n, \r e
 * ESC; DEL; C1); \t vira espaço. O ESC fica, e a OSC terminada por BEL fica
 * inteira: as sequências ANSI saem na etapa 7. Também limpa os identificadores
 * no normalizador (seção 2).
 * Idempotente: sem surrogates soltos, nenhuma remoção junta duas metades num
 * caractere novo (invisível ou não), e nada que ela remove pode ser recriado.
 * @param {unknown} text
 * @returns {string}
 */
export function stripInvisible(text) {
  if (typeof text !== 'string') return '';
  return text
    .toWellFormed()
    .replace(INVISIBLE, '')
    .replace(CONTROLS, (control, osc) => (osc === undefined ? '' : `${osc.slice(0, -1).replace(OSC_BODY_CONTROLS, '')}\x07`))
    .replace(TAB, ' ');
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
    let out = redactSecrets(stripInvisible(text));
    // Etapa 7: tirar as sequências pode juntar pedaços de um segredo
    // (`gh ESC[0m p_…` sem os espaços); se saiu algo, as etapas 2 a 6 rodam de
    // novo. A segunda passada não acha mais ESC: no máximo duas passadas.
    const withoutEscapes = removeEscapes(out);
    if (withoutEscapes !== out) out = redactSecrets(withoutEscapes);
    return out;
  } catch {
    return REDACTED;
  }
}

/**
 * Etapas 2 a 6 da redação.
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  let out = redactPrivateKeys(text);
  out = redactTokens(out);
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  out = out.replace(USER_OPTION, (whole, short, shortSep, long, longSep, value) => {
    // Sem aspas, o valor só é credencial se tiver `:` fora das sequências ANSI.
    if (!/^["']/.test(value) && !removeEscapes(value).includes(':')) return whole;
    return short !== undefined ? `${short}${shortSep}${REDACTED}` : `${long}${longSep}${REDACTED}`;
  });
  out = out.replace(HEADER, `$1$2${REDACTED}`);
  out = out.replace(BEARER, `$1 ${REDACTED}`);
  out = redactNamedValues(out, PAIR_NAME, PAIR_VALUE);
  out = redactNamedValues(out, SETX_HEAD, PAIR_VALUE);
  out = redactNamedValues(out, LONG_OPTION_HEAD, LONG_OPTION_VALUE);
  return out;
}

/**
 * Texto limpo, sem redigir: etapas 1 e 7 (sem invisíveis, controles,
 * sequências ANSI e ESC e BEL soltos). É a única implementação desse texto,
 * usada para o valor cru dos identificadores (tools.js), para os padrões de
 * resumo de teste do sanitize.mjs e, no T6, para o parseTestSummary.
 * @param {unknown} text
 * @returns {string}
 */
export function plainText(text) {
  return removeEscapes(stripInvisible(text));
}

/**
 * Etapa 7: sequências CSI e OSC inteiras e qualquer ESC ou BEL que sobrar.
 * @param {string} text
 * @returns {string}
 */
function removeEscapes(text) {
  if (!text.includes('\x1B') && !text.includes('\x07')) return text;
  return text.replace(ESCAPE_SEQUENCES, '').replace(LEFTOVER, '');
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
 * Valores de nome sensível (pares, `setx NOME valor`, `--nome valor`), com a
 * cabeça antes do laço: `head` acha só o nome (grupo 1) e o separador; o valor
 * só é lido, com `value` ancorado logo depois da cabeça, quando o nome é
 * sensível. Quando o nome não é sensível, a busca continua logo depois do
 * separador, para achar um par dentro do valor (`a=token=x`); depois de um
 * valor lido, continua depois dele. O cursor nunca volta.
 * @param {string} text
 * @param {RegExp} head                  global
 * @param {RegExp} value                 ancorada (flag y)
 */
function redactNamedValues(text, head, value) {
  let out = '';
  let last = 0;
  head.lastIndex = 0;
  let match;
  while ((match = head.exec(text))) {
    if (!isSensitiveName(match[1])) continue;
    const valueStart = match.index + match[0].length;
    value.lastIndex = valueStart;
    const found = value.exec(text);
    if (!found) continue;
    const valueEnd = valueStart + found[0].length;
    if (found[0] !== REDACTED) {
      out += text.slice(last, valueStart) + REDACTED;
      last = valueEnd;
    }
    head.lastIndex = valueEnd;
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
