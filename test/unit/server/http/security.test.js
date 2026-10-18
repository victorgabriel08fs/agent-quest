import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  TOKEN_HEADER,
  applySecurityHeaders,
  checkHookRequest,
  checkPanelRequest,
  isAllowedHost,
  isJsonContentType,
  tokenMatches,
} from '../../../../server/http/security.js';

describe('cabeçalhos de segurança (ADR 0006)', () => {
  it('CSP exatamente como no ADR', () => {
    assert.equal(
      CONTENT_SECURITY_POLICY,
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it('lista completa, sem nenhum Access-Control-Allow-*', () => {
    assert.deepEqual(SECURITY_HEADERS, {
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    assert.ok(Object.isFrozen(SECURITY_HEADERS));
  });

  it('applySecurityHeaders aplica todos', () => {
    const headers = {};
    applySecurityHeaders({ setHeader: (name, value) => (headers[name] = value) });
    assert.deepEqual(headers, { ...SECURITY_HEADERS });
  });
});

describe('isAllowedHost', () => {
  const port = 51234;

  it('aceita 127.0.0.1:<porta> e localhost:<porta>, sem diferenciar maiúsculas', () => {
    for (const host of ['127.0.0.1:51234', 'localhost:51234', 'LocalHost:51234']) {
      assert.equal(isAllowedHost(host, port), true, host);
    }
  });

  it('recusa outros hosts, outra porta, sem porta e ausente', () => {
    const hosts = [
      'evil.example:51234',
      'evil.example',
      '127.0.0.1',
      'localhost',
      '127.0.0.1:51235',
      'localhost.:51234',
      '[::1]:51234',
      '0.0.0.0:51234',
      '127.0.0.2:51234',
      'localhost:51234.evil.example',
      '',
      undefined,
    ];
    for (const host of hosts) assert.equal(isAllowedHost(host, port), false, String(host));
  });
});

describe('checkPanelRequest', () => {
  const host = '127.0.0.1:51234';

  it('aceita sem Origin e sem Sec-Fetch-Site (curl, navegação digitada)', () => {
    assert.equal(checkPanelRequest({ host }), null);
  });

  it('aceita a própria origem e Sec-Fetch-Site same-origin ou none', () => {
    assert.equal(checkPanelRequest({ host, origin: 'http://127.0.0.1:51234' }), null);
    assert.equal(checkPanelRequest({ host: 'localhost:51234', origin: 'http://localhost:51234' }), null);
    assert.equal(checkPanelRequest({ host, 'sec-fetch-site': 'same-origin' }), null);
    assert.equal(checkPanelRequest({ host, 'sec-fetch-site': 'none' }), null);
  });

  it('recusa Origin de outra origem, inclusive a outra forma do loopback', () => {
    const origins = [
      'http://evil.example',
      'http://localhost:51234',
      'https://127.0.0.1:51234',
      'http://127.0.0.1:51235',
      'http://127.0.0.1',
      'null',
      '',
    ];
    for (const origin of origins) assert.equal(checkPanelRequest({ host, origin }), 'origin', origin);
  });

  it('recusa Sec-Fetch-Site cross-site e same-site', () => {
    assert.equal(checkPanelRequest({ host, 'sec-fetch-site': 'cross-site' }), 'sec-fetch-site');
    assert.equal(checkPanelRequest({ host, 'sec-fetch-site': 'same-site' }), 'sec-fetch-site');
    assert.equal(checkPanelRequest({ host, origin: `http://${host}`, 'sec-fetch-site': 'cross-site' }), 'sec-fetch-site');
  });
});

describe('tokenMatches (ADR 0006: comparação em tempo constante)', () => {
  const token = 'a'.repeat(43);

  it('aceita só o token idêntico', () => {
    assert.equal(tokenMatches(token, token), true);
    assert.equal(tokenMatches(['a'.repeat(20), 'a'.repeat(23)].join(''), token), true, 'outra string com o mesmo valor');
  });

  it('recusa token diferente, de outro tamanho, vazio ou ausente, sem lançar exceção', () => {
    for (const received of ['a'.repeat(42), 'a'.repeat(44), 'b'.repeat(43), 'A'.repeat(43), '', undefined, null, 42, [token]]) {
      assert.equal(tokenMatches(received, token), false, String(received));
    }
  });

  it('sem token da execução, nada é aceito', () => {
    assert.equal(tokenMatches('', ''), false);
    assert.equal(tokenMatches('x', null), false);
  });
});

describe('isJsonContentType', () => {
  it('aceita application/json com ou sem parâmetros, sem diferenciar maiúsculas', () => {
    for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', ' application/json ;x=1']) {
      assert.equal(isJsonContentType(type), true, type);
    }
  });

  it('recusa o resto', () => {
    for (const type of ['text/plain', 'application/jsonx', 'application/ld+json', 'json', '', undefined, ['application/json']]) {
      assert.equal(isJsonContentType(type), false, String(type));
    }
  });
});

describe('checkHookRequest', () => {
  const token = 'segredo-da-execucao';
  const ok = { 'content-type': 'application/json', [TOKEN_HEADER]: token };

  it('cabeçalho do token é X-Agent-Quest-Token', () => {
    assert.equal(TOKEN_HEADER, 'x-agent-quest-token');
  });

  it('aceita o que o encaminhador manda', () => {
    assert.equal(checkHookRequest(ok, token), null);
  });

  it('Origin: 403, mesmo vazio ou com tudo certo', () => {
    assert.equal(checkHookRequest({ ...ok, origin: 'http://evil.example' }, token), 403);
    assert.equal(checkHookRequest({ ...ok, origin: '' }, token), 403);
  });

  it('token ausente ou errado: 401', () => {
    assert.equal(checkHookRequest({ 'content-type': 'application/json' }, token), 401);
    assert.equal(checkHookRequest({ ...ok, [TOKEN_HEADER]: 'outro' }, token), 401);
  });

  it('Content-Type errado ou ausente: 415', () => {
    assert.equal(checkHookRequest({ ...ok, 'content-type': 'text/plain' }, token), 415);
    assert.equal(checkHookRequest({ [TOKEN_HEADER]: token }, token), 415);
  });

  it('ordem: Origin, depois token, depois Content-Type', () => {
    assert.equal(checkHookRequest({ origin: 'http://x' }, token), 403);
    assert.equal(checkHookRequest({ 'content-type': 'text/plain' }, token), 401);
  });
});
