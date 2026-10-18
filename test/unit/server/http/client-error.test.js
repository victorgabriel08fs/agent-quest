// Respostas geradas fora do tratador de requisições (parser do Node, Expect, sem Host)
// também levam os cabeçalhos do ADR 0006. Sempre AGENT_QUEST_HOME temporário e porta 0.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import net from 'node:net';
import { handleClientError, rawResponse } from '../../../../server/http/client-error.js';
import { SECURITY_HEADERS } from '../../../../server/http/security.js';
import { startServer } from '../../../../server/main.js';
import { tempDir } from '../helpers.js';

/** Interpreta uma resposta HTTP crua: status, cabeçalhos (minúsculos) e corpo. */
function parseRaw(text) {
  const [head, ...rest] = text.split('\r\n\r\n');
  const [statusLine, ...lines] = head.split('\r\n');
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(statusLine.split(' ')[1]), statusLine, headers, body: rest.join('\r\n\r\n') };
}

function assertSecurityHeaders(headers, label) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(headers[name.toLowerCase()], value, `${label}: ${name}`);
  }
  const cors = Object.keys(headers).filter((name) => name.startsWith('access-control-'));
  assert.deepEqual(cors, [], label);
}

function fakeSocket({ writable = true, inFlight = null } = {}) {
  const socket = { writable, _httpMessage: inFlight, written: null, destroyed: false };
  socket.end = (data, callback) => {
    socket.written = data;
    callback?.();
  };
  socket.destroy = () => (socket.destroyed = true);
  return socket;
}

describe('rawResponse', () => {
  it('status, cabeçalhos de segurança, no-store, Connection: close e Content-Length em bytes', () => {
    for (const status of [400, 408, 413, 417, 431]) {
      const res = parseRaw(rawResponse(status));
      assert.equal(res.status, status);
      assert.match(res.statusLine, /^HTTP\/1\.1 \d{3} [A-Za-z ]+$/);
      assertSecurityHeaders(res.headers, String(status));
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers.connection, 'close');
      assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body));
    }
  });
});

describe('handleClientError', () => {
  it('escolhe o status pelo código do erro, como o Node', () => {
    const cases = [
      ['HPE_HEADER_OVERFLOW', 431],
      ['HPE_CHUNK_EXTENSIONS_OVERFLOW', 413],
      ['ERR_HTTP_REQUEST_TIMEOUT', 408],
      ['HPE_INVALID_HEADER_TOKEN', 400],
      ['HPE_INVALID_METHOD', 400],
      [undefined, 400],
    ];
    for (const [code, status] of cases) {
      const socket = fakeSocket();
      handleClientError(Object.assign(new Error('x'), { code }), socket);
      assert.equal(parseRaw(socket.written).status, status, String(code));
      assert.equal(socket.destroyed, true, `${code}: fecha a conexão depois de escrever`);
    }
  });

  it('só fecha, sem escrever, em conexão resetada, socket não gravável ou resposta em andamento', () => {
    const sockets = [
      [Object.assign(new Error('x'), { code: 'ECONNRESET' }), fakeSocket()],
      [new Error('x'), fakeSocket({ writable: false })],
      [new Error('x'), fakeSocket({ inFlight: { headersSent: true } })],
    ];
    for (const [err, socket] of sockets) {
      handleClientError(err, socket);
      assert.equal(socket.written, null);
      assert.equal(socket.destroyed, true);
    }
  });

  it('escreve se a resposta em andamento ainda não enviou cabeçalhos', () => {
    const socket = fakeSocket({ inFlight: { headersSent: false } });
    handleClientError(new Error('x'), socket);
    assert.equal(parseRaw(socket.written).status, 400);
  });
});

describe('servidor real: respostas fora do tratador de requisições', () => {
  const tmp = tempDir();
  let running;
  let port;

  before(async () => {
    running = await startServer({ argv: ['--port', '0'], env: { AGENT_QUEST_HOME: tmp.dir }, logError: () => {} });
    port = running.port;
  });

  after(async () => {
    await running?.close();
    tmp.cleanup();
  });

  /** Manda bytes crus e devolve a resposta inteira, até o servidor fechar a conexão. */
  function raw(text) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve({ ...parseRaw(data), closed: true }));
      socket.on('error', reject);
      socket.setTimeout(5000, () => socket.destroy(new Error('o servidor não fechou a conexão')));
      socket.write(text);
    });
  }

  const host = () => `Host: 127.0.0.1:${port}\r\n`;

  it('HTTP/1.1 sem Host: 403 com os cabeçalhos (regra de Host do ADR 0006)', async () => {
    const res = await raw('GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n');
    assert.equal(res.status, 403);
    assertSecurityHeaders(res.headers, 'sem Host');
  });

  it('HTTP/1.0 sem Host: 403 com os cabeçalhos', async () => {
    const res = await raw('GET / HTTP/1.0\r\n\r\n');
    assert.equal(res.status, 403);
    assertSecurityHeaders(res.headers, 'HTTP/1.0 sem Host');
  });

  it('cabeçalho com byte nulo: 400 com os cabeçalhos', async () => {
    const res = await raw(`GET / HTTP/1.1\r\n${host()}X-Teste: a\0b\r\n\r\n`);
    assert.equal(res.status, 400);
    assertSecurityHeaders(res.headers, 'byte nulo');
  });

  it('linha de requisição inválida: 400 com os cabeçalhos', async () => {
    const res = await raw('ISSO NAO E HTTP\r\n\r\n');
    assert.equal(res.status, 400);
    assertSecurityHeaders(res.headers, 'lixo');
  });

  it('cabeçalhos acima de 16 KiB: 431 com os cabeçalhos', async () => {
    const res = await raw(`GET / HTTP/1.1\r\n${host()}X-Grande: ${'a'.repeat(17 * 1024)}\r\n\r\n`);
    assert.equal(res.status, 431);
    assertSecurityHeaders(res.headers, '431');
  });

  it('Expect desconhecido: 417 com os cabeçalhos', async () => {
    const res = await raw(`GET / HTTP/1.1\r\n${host()}Expect: algo-estranho\r\nConnection: close\r\n\r\n`);
    assert.equal(res.status, 417);
    assertSecurityHeaders(res.headers, '417');
  });

  it('Expect: 100-continue continua funcionando', async () => {
    const res = await raw(`GET /api/health HTTP/1.1\r\n${host()}Expect: 100-continue\r\nConnection: close\r\n\r\n`);
    // A resposta interina "100 Continue" vem antes da final.
    assert.match(res.statusLine, /^HTTP\/1\.1 100/);
    assert.match(res.body, /HTTP\/1\.1 200 OK/);
  });

  it('o servidor continua respondendo depois dos erros', async () => {
    const res = await raw(`GET /api/health HTTP/1.1\r\n${host()}Connection: close\r\n\r\n`);
    assert.equal(res.status, 200);
  });
});
