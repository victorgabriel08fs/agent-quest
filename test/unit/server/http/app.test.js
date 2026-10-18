// HTTP real em 127.0.0.1, porta livre, com o web/ e o shared/ do repositório.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createApp } from '../../../../server/http/app.js';
import { SECURITY_HEADERS } from '../../../../server/http/security.js';
import { request } from '../helpers.js';

const STARTED_AT = 1_760_000_000_000;

describe('servidor HTTP (createApp)', () => {
  let server;
  let port;
  const errors = [];

  before(async () => {
    ({ server } = createApp({ version: '9.9.9', startedAt: STARTED_AT, logError: (m) => errors.push(m) }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const get = (path, headers = {}) => request(port, { path, headers });

  describe('Host', () => {
    it('127.0.0.1:<porta> e localhost:<porta> recebem 200', async () => {
      assert.equal((await get('/api/health')).status, 200);
      assert.equal((await get('/api/health', { Host: `localhost:${port}` })).status, 200);
      assert.equal((await get('/', { Host: `localhost:${port}` })).status, 200);
    });

    it('outro Host recebe 403, em qualquer rota', async () => {
      for (const path of ['/api/health', '/', '/shared/contract.js', '/nada']) {
        assert.equal((await get(path, { Host: `evil.example:${port}` })).status, 403, path);
      }
      assert.equal((await get('/api/health', { Host: `127.0.0.1:${port + 1}` })).status, 403);
    });
  });

  describe('Origin, Sec-Fetch-Site e CORS', () => {
    it('Origin de outra origem recebe 403', async () => {
      assert.equal((await get('/api/health', { Origin: 'http://evil.example' })).status, 403);
      assert.equal((await get('/', { Origin: 'http://evil.example' })).status, 403);
    });

    it('a própria origem é aceita', async () => {
      assert.equal((await get('/api/health', { Origin: `http://127.0.0.1:${port}` })).status, 200);
    });

    it('Sec-Fetch-Site cross-site recebe 403; same-origin e none são aceitos', async () => {
      assert.equal((await get('/api/health', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await get('/', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await get('/api/health', { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
      assert.equal((await get('/', { 'Sec-Fetch-Site': 'none' })).status, 200);
    });

    it('OPTIONS recebe 405, inclusive como preflight', async () => {
      for (const path of ['/api/health', '/', '/hooks']) {
        const res = await request(port, { method: 'OPTIONS', path });
        assert.equal(res.status, 405, path);
      }
      const preflight = await request(port, {
        method: 'OPTIONS',
        path: '/api/health',
        headers: {
          Origin: 'http://evil.example',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-agent-quest-token',
        },
      });
      assert.equal(preflight.status, 405);
    });

    it('nenhuma resposta tem Access-Control-Allow-*', async () => {
      const responses = [
        await get('/api/health'),
        await get('/api/health', { Origin: 'http://evil.example' }),
        await get('/'),
        await request(port, { method: 'OPTIONS', path: '/api/health', headers: { Origin: 'http://evil.example' } }),
      ];
      for (const res of responses) {
        const cors = Object.keys(res.headers).filter((name) => name.startsWith('access-control-'));
        assert.deepEqual(cors, []);
      }
    });
  });

  describe('cabeçalhos', () => {
    it('toda resposta tem a CSP e os cabeçalhos do ADR 0006', async () => {
      const responses = {
        '200 api': await get('/api/health'),
        '200 estático': await get('/'),
        '403 host': await get('/', { Host: 'evil.example' }),
        '403 origem': await get('/', { Origin: 'http://evil.example' }),
        '403 travessia': await get('/../package.json'),
        '404': await get('/nada.js'),
        '405': await request(port, { method: 'POST', path: '/' }),
        'HEAD': await request(port, { method: 'HEAD', path: '/' }),
      };
      for (const [label, res] of Object.entries(responses)) {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
          assert.equal(res.headers[name.toLowerCase()], value, `${label}: ${name}`);
        }
      }
    });

    it('API com Cache-Control: no-store; estáticos com no-cache', async () => {
      assert.equal((await get('/api/health')).headers['cache-control'], 'no-store');
      assert.equal((await get('/api/nada')).headers['cache-control'], 'no-store');
      assert.equal((await get('/')).headers['cache-control'], 'no-cache');
      assert.equal((await get('/shared/contract.js')).headers['cache-control'], 'no-cache');
    });
  });

  describe('GET /api/health', () => {
    it('forma completa de HealthResponse, com os valores neutros antes do T3', async () => {
      const res = await get('/api/health');
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      assert.deepEqual(JSON.parse(res.body), {
        ok: true,
        version: '9.9.9',
        startedAt: STARTED_AT,
        events: { received: 0, accepted: 0, rejected: 0, deduped: 0, dropped: 0, ignored: 0 },
        lastEventAt: null,
        sessions: 0,
        clients: 0,
      });
    });

    it('HEAD sem corpo; outros métodos recebem 405 com Allow', async () => {
      const head = await request(port, { method: 'HEAD', path: '/api/health' });
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      const post = await request(port, { method: 'POST', path: '/api/health', body: '{}' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, 'GET, HEAD');
    });

    it('aceita query string; outras rotas de /api recebem 404', async () => {
      assert.equal((await get('/api/health?x=1')).status, 200);
      assert.equal((await get('/api/nada')).status, 404);
      assert.equal((await get('/api')).status, 404);
      assert.equal((await get('/api/%68ealth')).status, 404);
    });
  });

  describe('arquivos estáticos', () => {
    it('"/" serve web/index.html como HTML', async () => {
      const res = await get('/');
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.match(res.body, /<html/i);
      assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body));
    });

    it('/shared/contract.js como JavaScript', async () => {
      const res = await get('/shared/contract.js');
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.match(res.body, /EVENT_KINDS/);
    });

    it('travessia de caminho recebe 403 ou 404 e nunca vaza o arquivo', async () => {
      const vectors = [
        '/../package.json',
        '/%2e%2e/package.json',
        '/..%5cpackage.json',
        '/web/../server/main.js',
        '/shared/../server/main.js',
        '/../../../../Windows/win.ini',
        '/%2e%2e/%2e%2e/server/main.js',
        '/package.json',
        '/server/main.js',
        '/mockups/painel.html',
        '/test/unit/server/helpers.js',
      ];
      for (const vector of vectors) {
        const res = await get(vector);
        assert.ok([403, 404].includes(res.status), `${vector}: ${res.status}`);
        assert.doesNotMatch(res.body, /"name": "agent-quest"|startServer|<html/, vector);
      }
    });

    it('arquivo inexistente recebe 404; POST em estático recebe 405', async () => {
      assert.equal((await get('/nada.js')).status, 404);
      const post = await request(port, { method: 'POST', path: '/', body: 'x' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, 'GET, HEAD');
    });
  });

  it('nenhum erro inesperado registrado', () => {
    assert.deepEqual(errors, []);
  });
});
