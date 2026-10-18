// Integração do T2 (tester): servidor real (`node server/main.js --port 0`) como
// processo filho, com AGENT_QUEST_HOME temporário, falando HTTP de verdade.
//
// Cobre: Host, Origin, Sec-Fetch-Site, CORS, OPTIONS, cabeçalhos do ADR 0006,
// Cache-Control, travessia de caminho (inclusive variantes do Windows),
// mapeamento de URL da visão geral e tipos MIME dos arquivos reais.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADR_HEADERS,
  REPO,
  killTree,
  launchServer,
  minimalEnv,
  rawRequest,
  request,
  tempDir,
} from './server-helpers.js';

const BS = '\\'; // barra invertida crua, sem ambiguidade de escape

describe('T2 integração: servidor HTTP real', () => {
  const home = tempDir('aq-int-http-');
  let run;
  let port;
  /** Todas as respostas vistas, para as checagens globais (CORS, cabeçalhos). */
  const seen = [];

  async function req(urlPath, { method = 'GET', headers = {}, body } = {}) {
    const res = await request(port, { method, path: urlPath, headers, body });
    seen.push({ label: `${method} ${urlPath} ${JSON.stringify(headers)}`, res });
    return res;
  }

  before(async () => {
    run = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: home.dir }));
    assert.equal(await run.started, true, run.output());
    port = JSON.parse(readFileSync(path.join(home.dir, 'runtime.json'), 'utf8')).port;
  });

  after(async () => {
    if (run) await killTree(run.child);
    home.cleanup();
  });

  describe('Host (DNS rebinding)', () => {
    it('evil.example:<porta> recebe 403 em todas as rotas', async () => {
      for (const p of ['/api/health', '/', '/index.html', '/shared/contract.js', '/nada.js', '/api/nada']) {
        const res = await req(p, { headers: { Host: `evil.example:${port}` } });
        assert.equal(res.status, 403, p);
        assert.doesNotMatch(res.text, /"ok":true|EVENT_KINDS|<html/i, p);
      }
    });

    it('127.0.0.1:<porta> e localhost:<porta> recebem 200 (API e estático)', async () => {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
        assert.equal((await req('/api/health', { headers: { Host: host } })).status, 200, host);
        assert.equal((await req('/', { headers: { Host: host } })).status, 200, host);
      }
    });

    it('variantes do loopback e do host também recebem 403', async () => {
      const hosts = [
        `127.0.0.1:${port + 1}`,
        '127.0.0.1',
        'localhost',
        `localhost.:${port}`,
        `[::1]:${port}`,
        `0.0.0.0:${port}`,
        `127.0.0.2:${port}`,
        `127.1:${port}`,
        `2130706433:${port}`,
        `localhost:${port}.evil.example`,
        `evil.example:${port}@127.0.0.1:${port}`,
      ];
      for (const host of hosts) {
        assert.equal((await req('/api/health', { headers: { Host: host } })).status, 403, host);
      }
    });

    it('sem Host (HTTP/1.0) recebe 403; Host duplicado com o malicioso primeiro recebe 403', async () => {
      const noHost = await rawRequest(port, 'GET /api/health HTTP/1.0\r\n\r\n');
      assert.equal(noHost.status, 403);
      const dup = await rawRequest(
        port,
        `GET /api/health HTTP/1.1\r\nHost: evil.example:${port}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      assert.equal(dup.status, 403);
    });

    it('alvo em forma absoluta (como proxy) não serve a API', async () => {
      const res = await rawRequest(
        port,
        `GET http://evil.example/api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      assert.notEqual(res.status, 200);
      assert.doesNotMatch(res.body, /"ok":true/);
    });
  });

  describe('Origin e Sec-Fetch-Site', () => {
    it('Origin: http://evil.example recebe 403 em /api/health, estáticos e 404', async () => {
      for (const p of ['/api/health', '/', '/shared/contract.js', '/nada.js']) {
        assert.equal((await req(p, { headers: { Origin: 'http://evil.example' } })).status, 403, p);
      }
    });

    it('outras origens recusadas: null, https, outra porta, a outra forma do loopback', async () => {
      const origins = [
        'null',
        `https://127.0.0.1:${port}`,
        `http://127.0.0.1:${port + 1}`,
        `http://localhost:${port}`,
        'http://127.0.0.1',
        `http://127.0.0.1:${port}.evil.example`,
        'file://',
      ];
      for (const origin of origins) {
        assert.equal((await req('/api/health', { headers: { Origin: origin } })).status, 403, origin);
      }
    });

    it('a própria origem é aceita, como o navegador manda (127.0.0.1 e localhost)', async () => {
      const ok127 = await req('/api/health', {
        headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.equal(ok127.status, 200);
      const okLocal = await req('/shared/contract.js', {
        headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.equal(okLocal.status, 200);
    });

    it('Sec-Fetch-Site cross-site e same-site recebem 403; same-origin e none, 200', async () => {
      for (const value of ['cross-site', 'Cross-Site', 'same-site']) {
        assert.equal((await req('/api/health', { headers: { 'Sec-Fetch-Site': value } })).status, 403, value);
        assert.equal((await req('/', { headers: { 'Sec-Fetch-Site': value } })).status, 403, value);
      }
      assert.equal((await req('/', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
      assert.equal((await req('/api/health', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    });

    it('cabeçalhos duplicados não driblam a checagem', async () => {
      const dupOrigin = await rawRequest(
        port,
        `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\n` +
          'Origin: http://evil.example\r\nConnection: close\r\n\r\n',
      );
      assert.equal(dupOrigin.status, 403);
      const dupSite = await rawRequest(
        port,
        `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nSec-Fetch-Site: same-origin\r\n` +
          'Sec-Fetch-Site: cross-site\r\nConnection: close\r\n\r\n',
      );
      assert.equal(dupSite.status, 403);
    });
  });

  describe('CORS e métodos', () => {
    it('OPTIONS recebe 405 em qualquer rota, inclusive preflight e OPTIONS *', async () => {
      for (const p of ['/api/health', '/', '/shared/contract.js', '/nada', '/hooks']) {
        assert.equal((await req(p, { method: 'OPTIONS' })).status, 405, p);
      }
      const preflight = await req('/api/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://evil.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type, x-agent-quest-token',
        },
      });
      assert.ok([403, 405].includes(preflight.status), String(preflight.status));
      const star = await rawRequest(port, `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      assert.equal(star.status, 405);
      assert.doesNotMatch(star.head, /access-control-allow/i);
    });

    it('métodos de escrita em estáticos e em /api/health recebem 405 com Allow', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        for (const p of ['/', '/shared/contract.js', '/api/health']) {
          const res = await req(p, { method, body: '{}', headers: { 'Content-Type': 'application/json' } });
          assert.equal(res.status, 405, `${method} ${p}`);
          assert.equal(res.headers.allow, 'GET, HEAD', `${method} ${p}`);
        }
      }
    });

    it('HEAD em estático: 200, sem corpo, Content-Length do arquivo', async () => {
      const res = await req('/', { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 0);
      assert.equal(Number(res.headers['content-length']), readFileSync(path.join(REPO, 'web', 'index.html')).length);
    });
  });

  describe('mapeamento de URL (visão geral, "Rotas e mapeamento de URL")', () => {
    it('GET / e /index.html servem web/index.html byte a byte, como text/html', async () => {
      const disk = readFileSync(path.join(REPO, 'web', 'index.html'));
      for (const p of ['/', '/index.html']) {
        const res = await req(p);
        assert.equal(res.status, 200, p);
        assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', p);
        assert.ok(res.body.equals(disk), `${p} difere de web/index.html`);
      }
    });

    it('GET /shared/contract.js serve shared/contract.js byte a byte, como JavaScript', async () => {
      const res = await req('/shared/contract.js');
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.ok(res.body.equals(readFileSync(path.join(REPO, 'shared', 'contract.js'))));
    });

    it('o import relativo de web/js/ resolve para /shared/contract.js', () => {
      assert.equal(new URL('../../shared/contract.js', `http://127.0.0.1:${port}/js/main.js`).pathname, '/shared/contract.js');
      assert.equal(
        new URL('../../../shared/contract.js', `http://127.0.0.1:${port}/js/themes/guilda.js`).pathname,
        '/shared/contract.js',
      );
    });

    it('/web/... não existe no servidor, e não há pasta web/shared/ escondida pela rota', async () => {
      assert.equal((await req('/web/index.html')).status, 404);
      assert.equal(existsSync(path.join(REPO, 'web', 'shared')), false);
    });

    it('pastas não são listadas', async () => {
      for (const p of ['/shared/', '/shared', '/js/', '/web/', '//']) {
        const res = await req(p);
        assert.equal(res.status, 404, p);
        assert.doesNotMatch(res.text, /contract\.js|index\.html/, p);
      }
    });

    it('arquivos fora de web/ e shared/ nunca são servidos', async () => {
      for (const p of ['/package.json', '/server/main.js', '/CLAUDE.md', '/jsconfig.json', '/types/node.d.ts', '/mockups/painel.html']) {
        const res = await req(p);
        assert.equal(res.status, 404, p);
      }
    });
  });

  describe('travessia de caminho', () => {
    const PACKAGE_JSON = readFileSync(path.join(REPO, 'package.json'), 'utf8');
    const leaked = (text) => text.includes('"name": "agent-quest"') || text.includes('startServer') || text.includes('[fonts]') || text.includes('declare module');

    it('os quatro vetores do critério recebem 403 ou 404', async () => {
      for (const vector of ['/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/web/../server/main.js']) {
        const res = await req(vector);
        assert.ok([403, 404].includes(res.status), `${vector}: ${res.status}`);
        assert.equal(leaked(res.text), false, vector);
      }
      assert.ok(PACKAGE_JSON.includes('"name": "agent-quest"'));
    });

    it('variantes codificadas, com barra invertida e do Windows são recusadas sem vazar nada', async () => {
      const vectors = [
        '/%2E%2E/package.json',
        '/.%2e/package.json',
        '/%2e./package.json',
        '/..%2fpackage.json',
        '/%2e%2e%2fpackage.json',
        '/%2e%2e%5cpackage.json',
        `/..${BS}package.json`,
        `/js/..${BS}..${BS}package.json`,
        '/js/..%5c..%5cpackage.json',
        '/shared/..%5c..%5cpackage.json',
        '/shared/%2e%2e/package.json',
        '/shared/../package.json',
        '/shared/../server/main.js',
        '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/Windows/win.ini',
        '/C:/Windows/win.ini',
        '/C:%5cWindows%5cwin.ini',
        '/c:%2fWindows%2fwin.ini',
        '/%5c%5c127.0.0.1%5cc$%5cWindows%5cwin.ini',
        '/%5C%5C%3F%5CC:%5CWindows%5Cwin.ini',
        '//127.0.0.1/c$/Windows/win.ini',
        '/index.html::$DATA',
        '/shared/contract.js::$DATA',
        '/shared/contract.js%3a%3a$DATA',
        '/package.json%00.html',
        '/..%00/package.json',
        '/..%c0%afpackage.json',
        '/%c0%ae%c0%ae/package.json',
        '/js/..%20/..%20/package.json',
        '/js/%2e%2e%20/%2e%2e%20/package.json',
        '/js/.../.../package.json',
        '/js/..../package.json',
        '/js/..%2e/package.json',
        '/shared/contract.js/../../package.json',
        '/%252e%252e/package.json',
        '/types/node.d.ts',
        '/../types/node.d.ts',
      ];
      for (const vector of vectors) {
        const res = await req(vector);
        assert.ok([400, 403, 404].includes(res.status), `${vector}: ${res.status}`);
        assert.equal(leaked(res.text), false, `${vector} vazou conteúdo`);
      }
    });

    it('nomes de arquivo com ponto ou espaço no fim e nomes curtos 8.3 não servem nada fora da lista', async () => {
      for (const vector of ['/shared/contract.js.', '/shared/contract.js%20', '/index.html.', '/PACKAG~1.JSO', '/shared/CONTRA~1']) {
        assert.equal((await req(vector)).status, 404, vector);
      }
    });

    it('nomes de dispositivo do Windows respondem 404 sem travar o servidor', async () => {
      for (const vector of ['/con.js', '/CON.html', '/nul.js', '/aux.css', '/prn.txt', '/com1.js', '/lpt1.json', '/CONIN$.js', '/CONOUT$.js', '/shared/nul.js']) {
        const res = await req(vector);
        assert.equal(res.status, 404, vector);
      }
      assert.equal((await req('/api/health')).status, 200);
    });

    it('caminho muito longo responde sem derrubar o servidor', async () => {
      const res = await req(`/${'a'.repeat(3000)}.js`);
      assert.equal(res.status, 404);
      assert.equal((await req('/api/health')).status, 200);
    });
  });

  describe('erros de protocolo respondidos pelo Node (bug B2 do tester)', () => {
    /** Cabeçalhos da última resposta final (ignora 1xx) de uma resposta crua. */
    function finalHeaders(raw) {
      const blocks = `${raw.head}\r\n\r\n${raw.body}`.split('\r\n\r\n');
      const head = blocks.find((block) => /^HTTP\/1\.1 [2-5]\d\d /.test(block)) ?? '';
      const [statusLine, ...lines] = head.split('\r\n');
      const headers = {};
      for (const line of lines) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      return { status: Number(statusLine?.split(' ')[1] ?? 0), headers };
    }

    function assertAdrHeaders(label, headers) {
      for (const [name, value] of Object.entries(ADR_HEADERS)) assert.equal(headers[name], value, `${label}: ${name}`);
      const cors = Object.keys(headers).filter((name) => name.startsWith('access-control-'));
      assert.deepEqual(cors, [], label);
    }

    it('cada recusa do parser tem o status certo e os cabeçalhos do ADR 0006', async () => {
      const host = `Host: 127.0.0.1:${port}\r\n`;
      const cases = [
        ['sem Host em HTTP/1.1', 403, 'GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n'],
        ['byte nulo em cabeçalho', 400, `GET / HTTP/1.1\r\n${host}X-Bad: a\u0000b\r\n\r\n`],
        ['cabeçalhos acima de 16 KiB', 431, `GET / HTTP/1.1\r\n${host}X-Big: ${'A'.repeat(20_000)}\r\n\r\n`],
        ['URL acima de 16 KiB', 431, `GET /${'a'.repeat(20_000)} HTTP/1.1\r\n${host}\r\n`],
        ['Expect não suportado', 417, `GET / HTTP/1.1\r\n${host}Expect: xyz\r\nConnection: close\r\n\r\n`],
        ['linha de requisição inválida', 400, 'LIXO \u0001\u0002\r\n\r\n'],
        ['método inválido', 400, `G@T / HTTP/1.1\r\n${host}\r\n`],
        ['versão inválida', 400, `GET / HTTP/9.9\r\n${host}\r\n`],
        ['Content-Length com Transfer-Encoding', 400, `POST /hooks HTTP/1.1\r\n${host}Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`],
        ['Content-Length duplicado e divergente', 400, `POST /hooks HTTP/1.1\r\n${host}Content-Length: 4\r\nContent-Length: 5\r\n\r\nabcd`],
        ['CR solto em cabeçalho', 400, `GET / HTTP/1.1\r\n${host}X-A: a\rb\r\n\r\n`],
        ['espaço antes dos dois-pontos', 400, `GET / HTTP/1.1\r\n${host}X-A : b\r\n\r\n`],
        ['prefácio do HTTP/2', 400, 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'],
      ];
      for (const [label, status, text] of cases) {
        const res = finalHeaders(await rawRequest(port, text));
        assert.equal(res.status, status, label);
        assertAdrHeaders(label, res.headers);
        assert.equal(res.headers['cache-control'], 'no-store', label);
      }
      assert.equal((await req('/api/health')).status, 200, 'o servidor segue no ar');
    });

    it('Expect: 100-continue segue as regras normais (Host malicioso: 403; correto: 200), com os cabeçalhos', async () => {
      const evil = finalHeaders(
        await rawRequest(port, 'GET /api/health HTTP/1.1\r\nHost: evil.example\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n'),
      );
      assert.equal(evil.status, 403);
      assertAdrHeaders('100-continue com Host malicioso', evil.headers);
      const ok = finalHeaders(
        await rawRequest(port, `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`),
      );
      assert.equal(ok.status, 200);
      assertAdrHeaders('100-continue', ok.headers);
    });
  });

  describe('cabeçalhos de segurança e cache', () => {
    it('API com no-store; estáticos com no-cache; erros com no-store', async () => {
      assert.equal((await req('/api/health')).headers['cache-control'], 'no-store');
      assert.equal((await req('/api/nada')).headers['cache-control'], 'no-store');
      assert.equal((await req('/')).headers['cache-control'], 'no-cache');
      assert.equal((await req('/shared/contract.js')).headers['cache-control'], 'no-cache');
      assert.equal((await req('/nada.js')).headers['cache-control'], 'no-store');
    });

    it('/api/health: JSON com a forma de HealthResponse e sem conteúdo de evento', async () => {
      const res = await req('/api/health');
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      const data = JSON.parse(res.text);
      assert.deepEqual(Object.keys(data).sort(), ['clients', 'events', 'lastEventAt', 'ok', 'sessions', 'startedAt', 'version']);
      assert.deepEqual(Object.keys(data.events).sort(), ['accepted', 'deduped', 'dropped', 'ignored', 'received', 'rejected']);
      assert.equal(data.ok, true);
      assert.equal(data.version, JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
    });

    it('400 de caminho malformado também tem os cabeçalhos', async () => {
      const res = await req('/%');
      assert.equal(res.status, 400);
    });

    it('toda resposta da aplicação vista neste arquivo tem a CSP e os cabeçalhos do ADR 0006', () => {
      assert.ok(seen.length > 100, `poucas respostas: ${seen.length}`);
      const statuses = new Set(seen.map(({ res }) => res.status));
      for (const status of [200, 400, 403, 404, 405]) assert.ok(statuses.has(status), `faltou status ${status}`);
      for (const { label, res } of seen) {
        for (const [name, value] of Object.entries(ADR_HEADERS)) {
          assert.equal(res.headers[name], value, `${label}: ${name}`);
        }
      }
    });

    it('nenhuma resposta vista tem Access-Control-Allow-* (nem outro cabeçalho CORS de resposta)', () => {
      for (const { label, res } of seen) {
        const cors = Object.keys(res.headers).filter((name) => name.startsWith('access-control-'));
        assert.deepEqual(cors, [], label);
      }
    });
  });
});
