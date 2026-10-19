// Redação contra a especificação (tester): server/domain/redact.js conferido
// com vetores próprios, escritos a partir da seção 10 de
// docs/arquitetura/modelo-de-eventos.md (revisão de 18/10/2026, commit cc50639),
// independentes dos vetores do dev. Cobre:
// - cada regra e cada exemplo da seção (sensíveis e não sensíveis), inclusive
//   as lacunas apontadas pelo tester antes da revisão;
// - um invisível de cada faixa no meio de uma chave conhecida;
// - idempotência em combinações aleatórias;
// - redactAndCut: no máximo `max` caracteres, ponto fixo do redact, prefixo
//   da redação, segredo nunca pela metade; charLength igual a Array.from;
// - "nunca lança" e o teste de tempo no formato do ADR 0010 (complemento
//   "teste de tempo da redação").
//
// Os testes marcados com `todo` reproduzem bugs abertos no relatório do tester.
// Eles rodam e mostram a falha, mas não deixam a suíte vermelha enquanto o
// dev corrige; quem corrigir tira o `todo`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { charLength, redact, redactAndCut, REDACTED } from '../../server/domain/redact.js';

const R = REDACTED;

// Segredos fictícios: nenhum pode sobrar na saída.
const S = 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0';

/** Um caractere invisível de cada faixa da etapa 1 da seção 10. */
const INVISIBLES = [
  '\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u00AD', // largura zero e hífen suave
  '\u200E', '\u200F', '\u202A', '\u202E', '\u2066', '\u2069', // direção
  '\u2061', '\u2062', '\u2063', '\u2064', '\u180E', '\u034F', // invisíveis matemáticos, mongol, combinante
  '\uFE00', '\uFE0F', // seletores de variação
  '\u115F', '\u1160', '\u3164', '\uFFA0', // preenchedores Hangul
  '\u{E0001}', '\u{E0041}', '\u{E007F}', // tags
];

/** [regra da seção 10, entrada, valor que não pode sobrar] */
const MUST_HIDE = [
  // 1. Invisíveis no meio de uma chave conhecida e de um nome sensível.
  ...INVISIBLES.map((c) => ['invisível', `ghp_${S.slice(0, 8)}${c}${S}`, S.slice(8)]),
  ...INVISIBLES.map((c) => ['invisível no nome', `pass${c}word=${S}`, S]),
  // 2. Chave privada (qualquer rótulo com PRIVATE KEY, com ou sem END).
  ['chave privada', `-----BEGIN RSA PRIVATE KEY-----\n${S}\n-----END RSA PRIVATE KEY-----`, S],
  ['chave privada', `-----BEGIN ENCRYPTED PRIVATE KEY-----${S}`, S],
  ['chave privada', `x -----BEGIN EC PRIVATE KEY----- ${S} -----END EC PRIVATE KEY----- y`, S],
  ['chave privada', `-----BEGIN OPENSSH PRIVATE KEY-----\n${S}\n-----END OPENSSH PRIVATE KEY-----`, S],
  ['chave privada', `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${S}\n-----END PGP PRIVATE KEY BLOCK-----`, S],
  // 3. Prefixos conhecidos.
  ['prefixo', `sk-ant-api03-${S}`, S], ['prefixo', `sk-proj-${S}`, S], ['prefixo', `sk_live_${S}`, S], ['prefixo', `sk_test_${S}`, S],
  ['prefixo', `rk_live_${S}`, S], ['prefixo', `ghp_${S}`, S], ['prefixo', `gho_${S}`, S], ['prefixo', `ghu_${S}`, S],
  ['prefixo', `ghs_${S}`, S], ['prefixo', `ghr_${S}`, S], ['prefixo', `github_pat_11${S}`, S], ['prefixo', `glpat-${S}`, S],
  ['prefixo', `npm_${S}${S.slice(0, 6)}`, S], ['prefixo', `pypi-${S}${S}`, S], ['prefixo', `hf_${S}`, S],
  ['prefixo', 'AKIAZX9YW8VU7TS6RQ5P', 'ZX9YW8VU7TS6RQ5P'], ['prefixo', `AIzaSy${S}`, S], ['prefixo', `xoxb-1234-${S}`, S],
  ['prefixo', `xapp-1-${S}`, S], ['prefixo', `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${S}`, S],
  ['tokens colados', `AKIAZX9YW8VU7TS6RQ5Pghp_${S}`, S], ['tokens colados', `AKIAZX9YW8VU7TS6RQ5Psk-ant-api03-${S}`, S],
  // 4. Credenciais embutidas (-u com espaço, com = e colado).
  ['url', `git clone https://ana:${S}@github.com/x.git`, S],
  ['curl -u', `curl -u ana:${S} https://x`, S], ['curl --user', `curl --user ana:${S} https://x`, S],
  ['curl --user=', `curl --user=ana:${S} https://x`, S], ['curl -u aspas', `curl -u "ana:${S}" https://x`, S],
  ['curl -u colado', `curl -uadmin:${S} https://x`, S], ['curl -u colado com aspas', `curl -u"admin:${S}" x`, S],
  // 5. Cabeçalhos.
  ['cabeçalho', `curl -H "Authorization: Bearer ${S}" x`, S], ['cabeçalho', `authorization: Basic ${S}`, S],
  ['cabeçalho', `PROXY-AUTHORIZATION: ${S}`, S], ['cabeçalho', `curl -H 'Cookie: sid=${S}' x`, S],
  ['cabeçalho', `set-cookie: sid=${S}; Path=/`, S], ['cabeçalho', `curl -H "X-Api-Key: ${S}" x`, S],
  ['cabeçalho', `X-AUTH-TOKEN:${S}`, S], ['cabeçalho', `x-client-secret: ${S}`, S], ['bearer solto', `usa bearer ${S}`, S],
  ['cabeçalho em JSON', `{"Authorization":"Bearer ${S}"}`, S],
  // 6. Pares nome-valor: cada nome "sensível" da seção, em várias formas.
  ...['PGPASSWORD', 'DBPassword', 'APITOKEN', 'GITHUBTOKEN', 'SECRETKEY', 'NPM_TOKEN', 'authToken', 'access_token', 'refresh_token',
    'client_secret', 'db_password', 'my_token', 'MY_TOKEN', 'apiKey', 'api-key', 'api_key', 'AWS_SECRET_ACCESS_KEY', 'passphrase', 'sig',
    'X-Amz-Signature', 'X-Amz-Credential', 'pwd', 'privateKey', 'secretAccessKey']
    .flatMap((name) => [['par', `${name}=${S}`, S], ['par', `${name}: ${S}`, S], ['par', `"${name}": "${S}"`, S]]),
  // separadores (o mais longo vale) e formas
  ['separador :=', `TOKEN := ${S}`, S], ['separador :=', `apiKey:=${S}`, S], ['separador ?=', `TOKEN ?= ${S}`, S],
  ['separador +=', `TOKEN += ${S}`, S], ['separador =>', `'password' => '${S}'`, S], ['separador =>', `"db_password"=>"${S}"`, S],
  ['forma', `export GITHUB_TOKEN=${S}`, S], ['forma', `$env:OPENAI_API_KEY = "${S}"`, S], ['forma', `set PASSWORD=${S}`, S],
  ['forma', `setx API_KEY "${S}"`, S], ['forma', `setx API_KEY ${S}`, S], ['forma', `SETX api_key ${S}`, S],
  ['forma', `curl "https://api.example.com/v1?access_token=${S}&x=1"`, S], ['forma', `{'password': '${S}'}`, S],
  ['forma', `https://x.blob.core.windows.net/c?sv=2020&sig=${S}`, S],
  ['opção', `--password ${S}`, S], ['opção', `--password=${S}`, S], ['opção', `--token ${S}`, S], ['opção', `--api-key ${S}`, S],
  ['opção', `mysql --password="${S}"`, S], ['opção', `wget --http-password ${S} x`, S],
  // valor entre aspas com aspas escapadas
  ['aspas escapadas', `{"password":"a\\"${S}"}`, S], ['aspas escapadas', `{"password": "x\\"y ${S}"}`, S],
  ['aspas escapadas', `{'secret': 'a\\'${S}'}`, S], ['aspas sem fechamento', `password="abc ${S}`, S],
];

/** Textos que a redação não pode tocar: os "não sensíveis" da seção, mais o que aparece nos cenários e no painel. */
const MUST_KEEP = [
  'tokenizer=y', 'tokens=3', 'max_tokens=1024', 'oauth=z', 'author=ana', 'key_file=x', 'keyboard=1', 'monkey: 2', 'npm_config_cache=x',
  'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', 'toolu_01AbCdEfGhIjKlMnOpQrStUv', '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
  'a0f1e2d3c4b5a6978', 'git push -u origin main', 'sort -u lista.txt', 'docker run --user node app', 'design=flat', 'signal=TERM',
  'assign=1', 'passport=x', '--key-file ~/.ssh/id_ed25519', 'node -e "console.log(1)"', 'node --test tmp-probe', 'ℹ tests 1',
  'ℹ fail 0', 'Exit code 3', 'Interrupted by user', '«comando#1:300»', '«2 linhas omitidas»', 'C:\\Users\\usuario\\Projetos\\agents-quest\\CLAUDE.md',
  'Content-Type: application/json', 'Accept: */*', 'echo token e secret soltos', 'sk-1', 'eyJ só isso', '<task-notification>',
  'https://example.com/a?b=1', 'Tests:       1 failed, 2 passed, 3 total', 'é ç ã 😀 • … «»',
];

describe('redact: cada regra e cada exemplo da seção 10 (revisão cc50639)', () => {
  for (const [rule, input, secret] of MUST_HIDE) {
    it(`${rule}: ${JSON.stringify(input).slice(0, 56)}`, () => {
      const out = redact(input);
      assert.ok(!out.includes(secret), `sobrou o segredo: ${JSON.stringify(out)}`);
      assert.ok(out.includes(R), `sem marcador: ${JSON.stringify(out)}`);
    });
  }

  it('mantém o nome e o separador e troca só o valor (com as aspas)', () => {
    assert.equal(redact(`access_token=${S}&x=1`), `access_token=${R}&x=1`);
    assert.equal(redact(`--api-key ${S} --verbose`), `--api-key ${R} --verbose`);
    assert.equal(redact(`"client_secret": "${S}", "user": "ana"`), `"client_secret": ${R}, "user": "ana"`);
    assert.equal(redact(`TOKEN := ${S} # x`), `TOKEN := ${R} # x`);
    assert.equal(redact(`'password' => '${S}',`), `'password' => ${R},`);
    assert.equal(redact(`{"password":"a\\"${S}","u":"ana"}`), `{"password":${R},"u":"ana"}`);
    assert.equal(redact(`curl -uadmin:${S} x`), `curl -u${R} x`);
  });

  it('negativos: nada muda', () => {
    for (const text of MUST_KEEP) assert.equal(redact(text), text, JSON.stringify(text));
  });

  it('remove os invisíveis de todas as faixas mesmo fora de segredos, e mantém letras, acentos, emoji, •, … e «', () => {
    assert.equal(redact(`a${INVISIBLES.join('b')}c`), `a${'b'.repeat(INVISIBLES.length - 1)}c`);
    assert.equal(redact('ação 😀 • … « »'), 'ação 😀 • … « »');
  });
});

describe('redact e redactAndCut: propriedades', () => {
  const random = (() => {
    let seed = 20261018;
    return () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
  })();
  const pieces = [
    ...MUST_HIDE.map(([, input]) => input), ...MUST_KEEP, R, '•', '••', '…', ' ', '"', "'", '\\"', '=', ':', ': ', ':=', '=>', '?=',
    '+=', '--', '-u', '-u ', 'setx ', '\n', '\t', '&', ';', '{', '}', '«', '»', 'token', 'Authorization', 'Bearer', 'Cookie', '://',
    '@', '\u200B', '\u{E0041}', '\uD83D\uDE00', '\uD800', 'é', 'PASSWORD', 'AKIAZX9YW8VU7TS6RQ5P',
  ];
  const randomText = () => {
    const parts = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pieces[Math.floor(random() * pieces.length)]);
    return parts.join(random() < 0.5 ? '' : ' ');
  };

  it('idempotente em 20000 combinações aleatórias (semente fixa)', () => {
    for (let i = 0; i < 20000; i++) {
      const text = randomText();
      const once = redact(text);
      assert.equal(redact(once), once, JSON.stringify(text));
    }
  });

  it('idempotente quando uma chave AKIA vem colada a outro token: a 1ª passada já esconde os dois', () => {
    for (const second of [`ghp_${S}`, `sk-ant-api03-${S}`, `npm_${S}${S.slice(0, 6)}`, `eyJa.eyJb.${S}`]) {
      const once = redact(`AKIAZX9YW8VU7TS6RQ5P${second}`);
      assert.ok(!once.includes(S), JSON.stringify(once));
      assert.equal(redact(once), once);
    }
  });

  it('redactAndCut em 20000 combinações e limites aleatórios: no máximo max caracteres, ponto fixo, prefixo da redação', () => {
    for (let i = 0; i < 20000; i++) {
      const text = randomText();
      const max = 1 + Math.floor(random() * 120);
      const out = redactAndCut(text, max);
      const full = redact(text);
      assert.ok(charLength(out) <= max, `${charLength(out)} > ${max}: ${JSON.stringify(out)}`);
      assert.equal(redact(out), out, `não é ponto fixo: ${JSON.stringify(out)} (de ${JSON.stringify(text)}, max ${max})`);
      if (out === full) continue;
      assert.ok(out.endsWith('…'), JSON.stringify(out));
      assert.ok(full.startsWith(out.slice(0, -1)), `não é prefixo da redação: ${JSON.stringify(out)}`);
    }
  });

  it('redactAndCut em todo limite de 1 a 60 caracteres: o segredo nunca aparece, nem pela metade', () => {
    const texts = [`echo ghp_${S} fim`, `x --password ${S} y`, `-H "Authorization: Bearer ${S}" z`, `TOKEN := ${S}`, `curl -uadmin:${S}`];
    for (const text of texts) {
      for (let max = 1; max <= 60; max++) {
        const out = redactAndCut(text, max);
        for (let k = 0; k + 6 <= S.length; k++) assert.ok(!out.includes(S.slice(k, k + 6)), `max ${max}: ${JSON.stringify(out)}`);
        assert.equal(redact(out), out);
      }
    }
  });

  it('charLength conta pontos de código, igual a Array.from, sem partir surrogates', () => {
    for (const text of ['', 'abc', '😀', 'a😀b', '\uD800', '\uDC00\uD800', '𝒜'.repeat(150), 'é\u0301', '\u{E0041}x']) {
      assert.equal(charLength(text), Array.from(text).length, JSON.stringify(text));
    }
    assert.equal(redactAndCut('😀😀😀', 2), '😀…');
    assert.equal(charLength(redactAndCut('𝒜'.repeat(300), 200)), 200);
  });

  it('nunca lança e sempre devolve texto', () => {
    const inputs = [
      undefined, null, 0, 1n, true, {}, [], Symbol('s'), () => 1, new String(`token=${S}`),
      { toString() { throw new Error('x'); } }, '\uD800', '\uDC00\uD800', '\u0000'.repeat(1000), '<'.repeat(5000),
      '-----BEGIN PRIVATE KEY-----'.repeat(200), '"'.repeat(5001), '•'.repeat(3000), `${'a'.repeat(100_000)}=`,
    ];
    for (const input of inputs) {
      for (const fn of [(x) => redact(x), (x) => redactAndCut(x, 50), (x) => redactAndCut(x, -1), (x) => redactAndCut(x, NaN), (x) => charLength(x)]) {
        let out;
        assert.doesNotThrow(() => { out = fn(input); }, String(typeof input));
        assert.ok(typeof out === 'string' || typeof out === 'number');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tempo (ADR 0010, complemento "teste de tempo da redação"): as oito entradas
// patológicas do ADR, mais as que o tester achou quadráticas na versão
// anterior; 4 KiB e 32 KiB; aquecimento e melhor de 7; t(32 KiB) < 100 ms e
// t(32 KiB) / max(t(4 KiB), 1 ms) ≤ 32; em caso de falha, mede de novo uma vez.

const fill = (piece, size) => piece.repeat(Math.ceil(size / piece.length)).slice(0, size);
const ADR_INPUTS = {
  'a= repetido': (n) => fill('a=', n),
  'aspa sem fechamento + \\" repetido': (n) => `"${fill('\\"', n - 1)}`,
  '--x repetido': (n) => fill('--x ', n),
  'BEGIN PRIVATE KEY sem END': (n) => fill('-----BEGIN PRIVATE KEY-----', n),
  '://a:a:a: repetido': (n) => fill('://a:a:a:', n),
  'invisível entre letras': (n) => fill('a\u200B', n),
  'token= repetido': (n) => fill('token=', n),
  'Authorization: repetido': (n) => fill('Authorization: ', n),
};
const TESTER_INPUTS = {
  'a: repetido': (n) => fill('a:', n), 'a.b: repetido': (n) => fill('a.b:', n), 'x=y= repetido': (n) => fill('x=y=', n),
  'a-b-c-d: repetido': (n) => fill('a-b-c-d:', n), 'usr/bin: repetido': (n) => fill('usr/bin:', n),
  "'a' => repetido": (n) => fill("'a' => ", n), 'setx a repetido': (n) => fill('setx a ', n), '-u a: repetido': (n) => fill('-u a:', n),
  'password repetido': (n) => fill('password', n),
};
// B8 (sequências ANSI dentro de valores, commit 3cde65c): classes (?:SEQ|X)+ com o
// laço seguido de algo que falha, OSC sem terminador, ESC repetido e misturas.
const E = '\u001b';
const colored = (text) => text.split('').map((ch) => `${E}[0m${ch}`).join('');
const ANSI_INPUTS = {
  'URL sem @: a + CSI': (n) => `://${fill(`a${E}[0m`, n - 3)}`,
  'URL sem @: ESC[ repetido': (n) => `://${fill(`${E}[`, n - 3)}`,
  'URL sem @: ESC] sem terminador': (n) => `://${E}]${fill('x', n - 5)}`,
  'URL sem @: ESC[ + CSI': (n) => `://${fill(`${E}[${E}[0m:`, n - 3)}`,
  '-u sem :: CSI + x': (n) => `-u ${fill(`${E}[1mx`, n - 3)}`,
  '-u sem :: ESC[ + parâmetros sem final': (n) => `-u ${fill(`${E}[111`, n - 3)}`,
  'Bearer no fim: ESC repetido': (n) => `Bearer ${fill(E, n - 7)}`,
  'ghp_ curto colorido + espaço': (n) => fill(`ghp_${colored('A'.repeat(15))} `, n),
  'AKIA com 17 coloridos': (n) => fill(` AKIA${colored('A'.repeat(17))}`, n),
  'JWT colorido sem segundo ponto': (n) => fill(` eyJ${colored('a'.repeat(50))}.${colored('b'.repeat(50))}`, n),
  'ghp_ + ESC[ repetido': (n) => `ghp_${fill(`${E}[`, n - 4)}`,
  'password= + (ESC]0;a)': (n) => `password=${fill(`${E}]0;a`, n - 9)}`,
  'password= + (ESC[1; ESC)': (n) => `password=${fill(`${E}[1;${E}`, n - 9)}`,
  'token= com CSI repetido': (n) => fill(`token=${E}[0m `, n),
  'Authorization: + (ESC]0;a b)': (n) => `Authorization: ${fill(`${E}]0;a b`, n - 15)}`,
};

function bestOf7(fn) {
  fn(); // aquecimento
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
    if (best > 200) break; // já reprovado: não insiste, para não pesar nos testes de tempo de outros arquivos
  }
  return best;
}

/** Mede cada entrada; as que falharem são medidas de novo uma vez (ADR 0010). Devolve as que falharam duas vezes. */
function growthFailures(inputs, run) {
  const measure = (make) => {
    const t4 = bestOf7(() => run(make(4096)));
    const t32 = bestOf7(() => run(make(32 * 1024)));
    return { t4, t32, ok: t32 < 100 && t32 / Math.max(t4, 1) <= 32 };
  };
  const failures = [];
  for (const [name, make] of Object.entries(inputs)) {
    let m = measure(make);
    if (!m.ok) m = measure(make);
    if (!m.ok) failures.push(`${name}: 4 KiB ${m.t4.toFixed(2)} ms, 32 KiB ${m.t32.toFixed(2)} ms`);
  }
  return failures;
}

describe('tempo linear (formato do ADR 0010)', () => {
  it('redact: as oito entradas do ADR e as do tester', () => {
    assert.deepEqual(growthFailures({ ...ADR_INPUTS, ...TESTER_INPUTS }, (text) => redact(text)), []);
  });

  it('redact e redactAndCut: entradas com sequências ANSI dentro de valores (B8)', () => {
    assert.deepEqual(growthFailures(ANSI_INPUTS, (text) => redact(text)), []);
    assert.deepEqual(growthFailures(ANSI_INPUTS, (text) => redactAndCut(text, 120)), []);
  });

  it('redactAndCut com o limite de comando (160) e com corte perto do fim do texto', () => {
    assert.deepEqual(growthFailures({ ...ADR_INPUTS, ...TESTER_INPUTS }, (text) => redactAndCut(text, 160)), []);
    assert.deepEqual(growthFailures(ADR_INPUTS, (text) => redactAndCut(text, charLength(text) - 5)), []);
  });

  it('redactAndCut quando o recuo precisa passar por uma palavra longa (C1, corrigido)', () => {
    // Texto: uma palavra longa e um par sensível; o corte cai em "token=•", que não é ponto fixo e força o recuo.
    const longWord = (n) => `${'a'.repeat(n - 16)} token=xxxxxxxx`;
    const manyWords = (n) => `${fill('ab ', n - 16)} token=xxxxxxxx`;
    const run = (text) => {
      const out = redactAndCut(text, charLength(text) - 6);
      assert.equal(redact(out), out, 'ponto fixo');
      assert.ok(charLength(out) <= charLength(text) - 6, 'limite');
    };
    assert.deepEqual(growthFailures({ 'palavra longa + token= cortado': longWord, 'muitas palavras + token= cortado': manyWords }, run), []);
  });
});

// ---------------------------------------------------------------------------
// B8 (commit 3cde65c): segredo com sequências ANSI completas (CSI, OSC com BEL
// ou ST) e ESC solto inseridos em posições aleatórias, nas formas de valor das
// etapas 3 a 6. Nenhum pedaço de 4 caracteres do segredo pode sobrar visível.
// Sequências incompletas (`ESC[` ou `ESC]` sem fim) ficam fora: o `[` e o `]`
// encerram um valor sem aspas, como no texto sem ESC (ver relatório do tester).

describe('B8: segredo com cores ANSI no meio não aparece (fuzz determinístico)', () => {
  it('nas formas de valor das etapas 3 a 6, com sequências completas e ESC solto', () => {
    let seed = 4242;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const BEL = '\u0007';
    const ST = `${E}\\`;
    const SEQS = [`${E}[0m`, `${E}[1;31m`, `${E}[ q`, `${E}]0;t${BEL}`, `${E}]8;;h x${ST}`, E];
    const SECRET = 'Zq7Wx3Rt9Lm2Pv8K';
    const PIECES = Array.from({ length: SECRET.length - 3 }, (_, i) => SECRET.slice(i, i + 4));
    const sprinkle = () => {
      let out = '';
      for (const ch of SECRET) {
        if (random() < 0.25) out += pick(SEQS);
        out += ch;
      }
      return random() < 0.3 ? out + pick(SEQS) : out;
    };
    const FORMS = [
      (s) => `API_KEY=${s}`, (s) => `password: ${s}`, (s) => `export DB_PASSWORD=${s}`, (s) => `$env:API_TOKEN = ${s}`,
      (s) => `setx API_KEY ${s}`, (s) => `--password ${s}`, (s) => `--token=${s}`, (s) => `-u admin:${s}`, (s) => `--user=admin:${s}`,
      (s) => `Bearer ${s}`, (s) => `Authorization: ${s}`, (s) => `X-Api-Key: ${s}`, (s) => `https://admin:${s}@h/x`,
      (s) => `"client_secret": ${s}`, (s) => `ghp_${s}${s}`, (s) => `sk-ant-${s}`, (s) => `glpat-${s}${s}`,
    ];
    const leaks = [];
    for (let i = 0; i < 6000; i++) {
      const text = `${pick(['', 'echo ', 'x ', `${E}[1m`, '"', 'cmd && '])}${random() < 0.2 ? pick(SEQS) : ''}${pick(FORMS)(sprinkle())}${pick(['', ' fim', `${E}[0m`, '"', ';'])}`;
      const out = redact(text);
      assert.equal(redact(out), out, JSON.stringify(text));
      const visible = out.replace(/[^A-Za-z0-9]/g, '');
      if (PIECES.some((piece) => visible.includes(piece))) leaks.push(`${JSON.stringify(text)} → ${JSON.stringify(out)}`);
    }
    assert.deepEqual(leaks.slice(0, 5), []);
  });
});
