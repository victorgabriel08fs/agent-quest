// Redação de segredos (modelo de eventos, seção 10, segunda revisão de
// 18/10/2026): um vetor positivo por regra, inclusive cada exemplo da seção,
// negativos, o contrato de redactAndCut e charLength e as propriedades
// obrigatórias (idempotência, ponto fixo do corte, nunca lançar, tempo linear
// no formato do ADR 0010).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { charLength, isSensitiveName, redact, redactAndCut, REDACTED } from '../../../../server/domain/redact.js';

const R = REDACTED;

// Um invisível de cada faixa da seção 10.
const INVISIBLES = [
  '\u00AD', '\u034F', '\u115F', '\u1160', '\u180E', '\u200B', '\u200C', '\u200D', '\u200E', '\u200F',
  '\u202A', '\u202E', '\u2060', '\u2061', '\u2064', '\u2066', '\u2069', '\u3164', '\uFE00', '\uFE0F',
  '\uFEFF', '\uFFA0', '\u{E0001}', '\u{E0041}', '\u{E0FFF}',
];

/** [entrada, saída esperada] */
const POSITIVES = {
  'caracteres invisíveis': [
    ...INVISIBLES.map((c) => [`ghp_abcdefgh${c}ijklmnop1234`, R]),
    ['access\u200C_token=abc', `access_token=${R}`],
    ['oi\u202Eolleh\u202C \u00ADtexto\uFEFF\u2060\u200E\u200F\u2066\u2069', 'oiolleh texto'],
  ],
  'chave privada': [
    ['antes -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- depois', `antes ${R} depois`],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----', R],
    ['-----BEGIN EC PRIVATE KEY-----x-----END EC PRIVATE KEY----- e -----BEGIN ENCRYPTED PRIVATE KEY-----y', `${R} e ${R}`],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQ\n-----END PGP PRIVATE KEY BLOCK----- fim', `${R} fim`],
    ['echo -----BEGIN PRIVATE KEY----- MIIEvQ sem o fim', `echo ${R}`],
  ],
  'tokens com prefixo': [
    ['sk-ant-api03-abcdefghijklmnop', R],
    ['OPENAI=sk-proj-abcdefghijklmnopqrstuv', `OPENAI=${R}`],
    ['sk_live_abcdefghijklmnop sk_test_abcdefghijk rk_live_abcdefghijkl', `${R} ${R} ${R}`],
    ['ghp_abcdefghijklmnop1234 gho_abcdefghijklmnop1234 ghu_abcdefghijklmnop1234', `${R} ${R} ${R}`],
    ['ghs_abcdefghijklmnop1234 ghr_abcdefghijklmnop1234', `${R} ${R}`],
    ['github_pat_11ABCDEFG0123456789_abcdefghij', R],
    ['glpat-abcdefghij0123456789', R],
    [`npm_${'a1B2'.repeat(9)}`, R],
    ['pypi-AgEIcHlwaS5vcmcCJGFiY2RlZmdoaWprbG1ub3BxcnN0', R],
    ['hf_abcdefghijklmnopqrstuvwxyz', R],
    ['aws AKIAABCDEFGHIJKLMNOP', `aws ${R}`],
    ['maps AIzaSyA1234567890abcdefghijklmnopqrs', `maps ${R}`],
    ['slack xoxb-1234567890-abcdefghij xapp-1-A0B1C2D3-1234-abcdef', `slack ${R} ${R}`],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJh', `jwt ${R}`],
    ['AKIAZX9YW8VU7TS6RQ5Pghp_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0 fim', `${R} fim`],
  ],
  'credenciais embutidas': [
    ['psql postgres://admin:senha@localhost/db', `psql postgres://${R}@localhost/db`],
    ['curl -u a:b https://x', `curl -u ${R} https://x`],
    ['curl -uadmin:senha https://x', `curl -u${R} https://x`],
    ['curl -u "ana:senha" https://x', `curl -u ${R} https://x`],
    ['curl --user ana:senha https://x', `curl --user ${R} https://x`],
    ['curl --user=ana:senha https://x', `curl --user=${R} https://x`],
  ],
  'cabeçalhos': [
    ['curl -H "Authorization: Bearer abc.def" x', `curl -H "Authorization: ${R}" x`],
    ['authorization: Basic YWxhZGRpbjpvcGVu', `authorization: ${R}`],
    ['Proxy-Authorization: Basic YWxh', `Proxy-Authorization: ${R}`],
    ['curl -H "Cookie: sessao=abc; outro=1" x', `curl -H "Cookie: ${R}" x`],
    ['Set-Cookie: sessao=abc', `Set-Cookie: ${R}`],
    ['curl -H "X-Api-Key: x" https://y', `curl -H "X-Api-Key: ${R}" https://y`],
    ["curl -H 'x-auth-token: abc' y", `curl -H 'x-auth-token: ${R}' y`],
    ['X-Client-Secret: abc', `X-Client-Secret: ${R}`],
    ['{"Authorization": "Bearer a\\"b"}', `{"Authorization": ${R}}`],
    ['fetch com Bearer abc123.def', `fetch com Bearer ${R}`],
  ],
  'pares nome-valor': [
    ['curl "https://api.example.com/v1?access_token=A1&client_secret=B2"', `curl "https://api.example.com/v1?access_token=${R}&client_secret=${R}"`],
    ['db_password=x my_token=y refresh_token=z', `db_password=${R} my_token=${R} refresh_token=${R}`],
    ['MY_TOKEN=abc123 npm test', `MY_TOKEN=${R} npm test`],
    ['apiKey: abc api_key=1 api-key=2', `apiKey: ${R} api_key=${R} api-key=${R}`],
    ['AWS_SECRET_ACCESS_KEY=abc node app', `AWS_SECRET_ACCESS_KEY=${R} node app`],
    ['PGPASSWORD=a DBPassword=b APITOKEN=c GITHUBTOKEN=d SECRETKEY=e', `PGPASSWORD=${R} DBPassword=${R} APITOKEN=${R} GITHUBTOKEN=${R} SECRETKEY=${R}`],
    ['NPM_TOKEN=a authToken=b passphrase=c sig=d pwd=e', `NPM_TOKEN=${R} authToken=${R} passphrase=${R} sig=${R} pwd=${R}`],
    ['https://x.blob.core.windows.net/c?sv=2020&sig=AB%2Fc', `https://x.blob.core.windows.net/c?sv=2020&sig=${R}`],
    ['?X-Amz-Signature=abc&X-Amz-Credential=AKID%2Fx', `?X-Amz-Signature=${R}&X-Amz-Credential=${R}`],
    ['DB_PASSWORD="x y" node app', `DB_PASSWORD=${R} node app`],
    ['{"password": "x y", "user": "ana"}', `{"password": ${R}, "user": "ana"}`],
    ['{"password": "a\\"b c", "user": "ana"}', `{"password": ${R}, "user": "ana"}`],
    ["$cfg = ['password' => 'x y', 'host' => 'db'];", `$cfg = ['password' => ${R}, 'host' => 'db'];`],
    ['TOKEN := abc', `TOKEN := ${R}`],
    ['API_KEY ?= abc\nSECRET += def', `API_KEY ?= ${R}\nSECRET += ${R}`],
    ["export TOKEN='abc def'", `export TOKEN=${R}`],
    ['$env:API_KEY = "abc"', `$env:API_KEY = ${R}`],
    ['set DB_PASSWORD=abc', `set DB_PASSWORD=${R}`],
    ['setx API_KEY "x y"', `setx API_KEY ${R}`],
    ['SETX GITHUB_TOKEN abc', `SETX GITHUB_TOKEN ${R}`],
    ['mysql password=hunter2 passwd: x', `mysql password=${R} passwd: ${R}`],
    ['secret=s3 token=t auth=a credentials=c credential=d', `secret=${R} token=${R} auth=${R} credentials=${R} credential=${R}`],
    ['a=token=x', `a=token=${R}`],
    ['--password x --token y --api-key z', `--password ${R} --token ${R} --api-key ${R}`],
    ['mysql --password=hunter2', `mysql --password=${R}`],
    ['password="sem fim', `password=${R}`],
    ['sort_key=nome secretary=ana', `sort_key=${R} secretary=${R}`], // falsos positivos aceitos pela seção 10
  ],
};

const NEGATIVES = [
  'tokenizer=y',
  'tokens=3 max_tokens=4096',
  'oauth=z',
  'author=ana monkey=1 keyboard=2',
  'key_file=~/.ssh/id_ed25519',
  '--key-file ~/.ssh/id_ed25519',
  'npm_config_cache=x',
  'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
  'toolu_01AbCdEfGhIjKlMnOpQrStUv',
  'git push -u origin main',
  'npm test',
  'node --test tmp-probe',
  'https://example.com/a?b=1',
  'echo token e secret soltos',
  'C:\\Users\\usuario\\Projetos\\agents-quest',
  'task-skeleton desk-top-sk-x',
  '--verbose --password',
  'SETX PATH c:/bin',
  '-----BEGIN CERTIFICATE----- MIIC',
  'Exit code 1',
  'oi 😀 é • … «x»',
  '',
];

describe('redact: vetores positivos por regra', () => {
  for (const [rule, vectors] of Object.entries(POSITIVES)) {
    for (const [input, expected] of vectors) {
      it(`${rule}: ${JSON.stringify(input).slice(0, 60)}`, () => {
        assert.equal(redact(input), expected);
      });
    }
  }
});

describe('redact: negativos', () => {
  for (const input of NEGATIVES) {
    it(`não mexe em ${JSON.stringify(input).slice(0, 50)}`, () => {
      assert.equal(redact(input), input);
    });
  }
});

describe('isSensitiveName (só para testes)', () => {
  it('sensíveis e não sensíveis da seção 10', () => {
    const sensitive = [
      'PGPASSWORD', 'DBPassword', 'APITOKEN', 'GITHUBTOKEN', 'SECRETKEY', 'NPM_TOKEN', 'authToken', 'access_token', 'refresh_token',
      'client_secret', 'db_password', 'my_token', 'apiKey', 'api-key', 'AWS_SECRET_ACCESS_KEY', 'passphrase', 'sig', 'X-Amz-Signature',
      'X-Amz-Credential', 'pwd', 'privateKey', 'accessKey', 'db2Password', 'x.auth.header',
    ];
    const notSensitive = ['tokenizer', 'tokens', 'max_tokens', 'oauth', 'author', 'key_file', 'keyboard', 'monkey', 'npm_config_cache', 'keys'];
    for (const name of sensitive) assert.equal(isSensitiveName(name), true, name);
    for (const name of notSensitive) assert.equal(isSensitiveName(name), false, name);
  });
});

describe('charLength e redactAndCut', () => {
  it('charLength conta pontos de código, sem partir pares; não texto conta 0', () => {
    assert.equal(charLength('abc'), 3);
    assert.equal(charLength('😀😀'), 2);
    assert.equal(charLength('a\uD800b'), 3);
    assert.equal(charLength('\uDC00'), 1);
    assert.equal(charLength(''), 0);
    assert.equal(charLength(undefined), 0);
    for (const text of ['x', '😀é𝒜', `${'a'.repeat(10)}\uD83D`]) assert.equal(charLength(text), Array.from(text).length);
  });

  it('cabe: devolve o texto redigido; não cabe: max − 1 caracteres e "…"', () => {
    assert.equal(redactAndCut('curto', 80), 'curto');
    assert.equal(redactAndCut('token=abc', 80), `token=${R}`);
    assert.equal(redactAndCut('abcdefghij', 5), 'abcd…');
    assert.equal(redactAndCut('😀😀😀', 2), '😀…', 'não parte pares de surrogates');
    assert.equal(redactAndCut('qualquer', 0), '');
  });

  it('recua o corte quando o resultado não é ponto fixo (nome sensível sem valor, "•••" partido junto de um nome)', () => {
    assert.equal(redactAndCut('echo xxxxxxxxxx --password SEGREDO', 28), 'echo xxxxxxxxxx …');
    assert.equal(redactAndCut('echo token=SEGREDOLONGO', 9), 'echo tok…', 'sem separador, "tok" não é par');
    assert.equal(redactAndCut('echo token=SEGREDOLONGO', 13), 'echo …', '"token=•…" não seria ponto fixo');
    assert.equal(redactAndCut('x -H "Authorization: Bearer SEGREDO"', 22), 'x -H …');
    assert.equal(redactAndCut('--password x', 12), '…', '"--password …" não é ponto fixo e não há palavra antes');
  });

  it('o resultado é sempre ponto fixo de redact, cabe no limite e nunca mostra o segredo pela metade', () => {
    const secret = 'SEGREDO123';
    const texts = [
      `echo ghp_abcdefghijklmnop1234 --password ${secret} -H "Authorization: Bearer ${secret}" token=${secret} fim`,
      `${'d'.repeat(60)} token=${secret}`,
      `x -u admin:${secret} https://a:${secret}@b.c TOKEN := ${secret} 'password' => '${secret}'`,
      `😀 é ${'𝒜'.repeat(20)} api_key=${secret}`,
    ];
    for (const text of texts) {
      for (let max = 1; max <= 120; max++) {
        const out = redactAndCut(text, max);
        assert.ok(charLength(out) <= max, `max ${max}: ${out}`);
        assert.equal(redact(out), out, `max ${max}: ${JSON.stringify(out)}`);
        assert.ok(!out.includes('SEGRED') && !out.includes('ghp_a'), `max ${max}: ${out}`);
      }
    }
  });
});

describe('redact: propriedades', () => {
  const allInputs = [...Object.values(POSITIVES).flat().map(([input]) => input), ...NEGATIVES];

  it('é idempotente nos vetores', () => {
    for (const input of allInputs) {
      const once = redact(input);
      assert.equal(redact(once), once, JSON.stringify(input));
    }
  });

  it('tokens colados uns nos outros: a primeira passada já esconde todos e a segunda não muda nada', () => {
    for (const text of [
      'AKIAZX9YW8VU7TS6RQ5Pghp_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0',
      'AKIAZX9YW8VU7TS6RQ5Psk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3',
      'AKIAZX9YW8VU7TS6RQ5Pnpm_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Zx9Yw8 fim',
    ]) {
      const once = redact(text);
      assert.ok(!/Zx9Y/.test(once), once);
      assert.equal(redact(once), once);
    }
  });

  it('é idempotente em combinações aleatórias dos vetores (semente fixa)', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pieces = [...allInputs, ' ', '"', "'", '\\"', '=', ': ', ':=', '=>', '\n', '&', '--', '-u', R, '…', '\u200B', '\uD83D', 'setx '];
    for (let i = 0; i < 1000; i++) {
      const parts = Array.from({ length: 1 + Math.floor(random() * 6) }, () => pieces[Math.floor(random() * pieces.length)]);
      const text = parts.join(random() < 0.5 ? ' ' : '');
      const once = redact(text);
      assert.equal(redact(once), once, JSON.stringify(text));
    }
  });

  it('nunca lança exceção', () => {
    for (const input of [undefined, null, 42, {}, [], Symbol('x'), new String('token=x'), '\uD800', '\uDFFF\uD800', '\u0000'.repeat(100), '<'.repeat(1000), '"'.repeat(1001)]) {
      assert.doesNotThrow(() => redact(input));
      assert.equal(typeof redact(input), 'string');
      assert.doesNotThrow(() => redactAndCut(input, 10));
    }
    assert.equal(redact(undefined), '');
    assert.equal(redact(42), '');
  });

  // ADR 0010, complemento "teste de tempo da redação": oito entradas patológicas,
  // 4 KiB e 32 KiB, melhor de 7 depois de um aquecimento; t(32 KiB) < 100 ms e
  // t(32 KiB) / max(t(4 KiB), 1 ms) ≤ 32.
  it('o tempo cresce de forma linear (formato do ADR 0010), em redact e em redactAndCut', () => {
    const fill = (piece, size) => piece.repeat(Math.ceil(size / piece.length)).slice(0, size);
    const inputs = {
      'a=': (size) => fill('a=', size),
      'aspa sem fechamento e \\"': (size) => `"${fill('\\"', size - 1)}`,
      '--x ': (size) => fill('--x ', size),
      'BEGIN sem END': (size) => fill('-----BEGIN PRIVATE KEY-----', size),
      '://a:a:a:': (size) => fill('://a:a:a:', size),
      'invisível entre letras': (size) => fill('a\u200B', size),
      'token=': (size) => fill('token=', size),
      'Authorization: ': (size) => fill('Authorization: ', size),
    };
    const best = (fn, text) => {
      fn(text);
      let min = Infinity;
      for (let i = 0; i < 7; i++) {
        const started = performance.now();
        fn(text);
        min = Math.min(min, performance.now() - started);
      }
      return min;
    };
    const slow = [];
    for (const [name, build] of Object.entries(inputs)) {
      for (const [label, fn] of [['redact', redact], ['redactAndCut', (text) => redactAndCut(text, 120)]]) {
        const small = best(fn, build(4096));
        const large = best(fn, build(32 * 1024));
        if (large >= 100 || large / Math.max(small, 1) > 32) slow.push(`${label} ${name}: 4 KiB ${small.toFixed(2)} ms, 32 KiB ${large.toFixed(2)} ms`);
      }
    }
    assert.deepEqual(slow, []);
  });

  it('o recuo de redactAndCut é linear numa palavra longa (C1)', () => {
    const build = (size) => `${'a'.repeat(size - 16)} token=xxxxxxxx`;
    const cut = (text) => redactAndCut(text, charLength(text) - 6);
    const best = (text) => {
      cut(text);
      let min = Infinity;
      for (let i = 0; i < 7; i++) {
        const started = performance.now();
        cut(text);
        min = Math.min(min, performance.now() - started);
      }
      return min;
    };
    const small = best(build(4096));
    const large = best(build(32 * 1024));
    assert.ok(large < 100 && large / Math.max(small, 1) <= 32, `4 KiB ${small.toFixed(2)} ms, 32 KiB ${large.toFixed(2)} ms`);
    const out = cut(build(4096));
    assert.equal(redact(out), out);
    assert.ok(out.endsWith('a …'), out.slice(-10));
  });
});
