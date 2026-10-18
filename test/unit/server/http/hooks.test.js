// POST /hooks com HTTP real em 127.0.0.1, porta livre (T3 do plano da v1).
// Nenhum teste usa o diretório de dados real nem a porta padrão (ADR 0010).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import net from 'node:net';
import { createApp } from '../../../../server/http/app.js';
import { SECURITY_HEADERS } from '../../../../server/http/security.js';
import { MAX_BODY_BYTES } from '../../../../server/ingest/envelope.js';
import { request } from '../helpers.js';

const TOKEN = 'token-de-teste-0123456789abcdefghijklmnopq';
const T0 = 1_760_000_000_000;

const apps = [];
after(async () => {
  for (const { server } of apps) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** createApp em porta livre, com token, relógio e registro de erros de teste. */
async function startApp(options = {}) {
  const errors = [];
  const clock = { now: T0 };
  const app = createApp({
    version: '9.9.9',
    startedAt: T0,
    token: TOKEN,
    clock: () => clock.now,
    logError: (message) => errors.push(message),
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  apps.push(app);

  /** POST /hooks com os cabeçalhos do encaminhador, que cada teste pode trocar. */
  function post(body, headers = {}) {
    const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    return request(port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': TOKEN, ...headers },
      body: text,
    });
  }

  async function health() {
    return JSON.parse((await request(port, { path: '/api/health' })).body);
  }

  return { ...app, port, post, health, errors, clock };
}

let sequence = 0;
/** Envelope v1 válido, com payload único a cada chamada (a menos que `payload` seja passado). */
function envelope(payload = {}, extra = {}) {
  sequence++;
  return {
    v: 1,
    sentAt: T0 + sequence,
    forwarder: '0.1.0',
    env: { projectDir: '<repo>', entrypoint: null },
    truncated: false,
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: 'sessao-teste',
      tool_name: 'Read',
      tool_use_id: `toolu_${sequence}`,
      tool_input: { file_path: '<repo>/CLAUDE.md' },
      ...payload,
    },
    ...extra,
  };
}

/** Envelope válido com exatamente `size` bytes em JSON. */
function envelopeOfSize(size) {
  const base = envelope({ filler: '' });
  const filler = 'a'.repeat(size - Buffer.byteLength(JSON.stringify(base)));
  base.payload.filler = filler;
  const text = JSON.stringify(base);
  assert.equal(Buffer.byteLength(text), size);
  return text;
}

/** POST com o corpo em pedaços, sem Content-Length (Transfer-Encoding: chunked). */
function postChunked(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/hooks', headers, agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('error', reject);
    for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.subarray(i, i + 64 * 1024));
    req.end();
  });
}

/** Percentil por posição (sem interpolação), sobre uma cópia ordenada. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

describe('POST /hooks: recusas', () => {
  it('sem token ou com token errado: 401', async () => {
    const app = await startApp();
    const body = JSON.stringify(envelope());
    const noToken = await request(app.port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(noToken.status, 401);
    for (const token of ['', 'errado', TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase()]) {
      assert.equal((await app.post(body, { 'X-Agent-Quest-Token': token })).status, 401, JSON.stringify(token));
    }
  });

  it('sem token da execução configurado, nada é aceito', async () => {
    const app = await startApp({ token: null });
    assert.equal((await app.post(envelope())).status, 401);
  });

  it('com Origin: 403, mesmo com token certo e mesmo sendo a própria origem', async () => {
    const app = await startApp();
    for (const origin of ['http://evil.example', `http://127.0.0.1:${app.port}`, 'null']) {
      assert.equal((await app.post(envelope(), { Origin: origin })).status, 403, origin);
    }
  });

  it('Content-Type diferente de application/json: 415', async () => {
    const app = await startApp();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonx']) {
      assert.equal((await app.post(envelope(), { 'Content-Type': type })).status, 415, type);
    }
    const noType = await request(app.port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'X-Agent-Quest-Token': TOKEN },
      body: JSON.stringify(envelope()),
    });
    assert.equal(noType.status, 415);
    assert.equal((await app.post(envelope(), { 'Content-Type': 'Application/JSON; charset=utf-8' })).status, 204);
  });

  it('corpo acima de 1 MiB: 413; exatamente 1 MiB: 204', async () => {
    const app = await startApp();
    assert.equal((await app.post(envelopeOfSize(MAX_BODY_BYTES))).status, 204);
    assert.equal((await app.post(envelopeOfSize(MAX_BODY_BYTES + 1))).status, 413);
    assert.equal((await app.post(Buffer.alloc(10 * 1024 * 1024, 'a'))).status, 413);
  });

  it('corpo acima de 1 MiB sem Content-Length (chunked): 413', async () => {
    const app = await startApp();
    const headers = { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': TOKEN };
    const big = await postChunked(app.port, Buffer.from(envelopeOfSize(MAX_BODY_BYTES + 1)), headers);
    assert.equal(big.status, 413);
    const small = await postChunked(app.port, Buffer.from(JSON.stringify(envelope())), headers);
    assert.equal(small.status, 204);
  });

  it('Content-Length enorme declarado: 413 na hora, sem ler o corpo', async () => {
    const app = await startApp();
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(app.port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      socket.write(
        'POST /hooks HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${app.port}\r\n` +
          'Content-Type: application/json\r\n' +
          `X-Agent-Quest-Token: ${TOKEN}\r\n` +
          'Content-Length: 99999999999\r\n\r\n',
      );
    });
    assert.match(response, /^HTTP\/1\.1 413 /);
    assert.equal((await app.health()).events.rejected, 1);
  });

  it('recusa pelos cabeçalhos responde na hora, sem esperar o corpo', async () => {
    const app = await startApp();
    // Declara 999 bytes e manda só 10: quem não tem o token não segura a requisição.
    const statusLine = (headers) =>
      new Promise((resolve, reject) => {
        const socket = net.connect(app.port, '127.0.0.1');
        let data = '';
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('o servidor esperou o corpo'));
        }, 3000);
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          data += chunk;
          if (data.includes('\r\n')) {
            clearTimeout(timer);
            socket.destroy();
            resolve(data.split('\r\n', 1)[0]);
          }
        });
        socket.on('error', reject);
        socket.write(
          `POST /hooks HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\n${headers}Content-Length: 999\r\n\r\n0123456789`,
        );
      });
    assert.match(await statusLine('Content-Type: application/json\r\n'), / 401 /);
    assert.match(await statusLine(`Content-Type: application/json\r\nX-Agent-Quest-Token: ${TOKEN}\r\nOrigin: http://x\r\n`), / 403 /);
    assert.match(await statusLine(`Content-Type: text/plain\r\nX-Agent-Quest-Token: ${TOKEN}\r\n`), / 415 /);
  });

  it('JSON inválido ou envelope sem v: 1, payload.session_id ou payload.hook_event_name: 400', async () => {
    const app = await startApp();
    const bodies = [
      '',
      '{',
      'null',
      '[]',
      JSON.stringify({ ...envelope(), v: 2 }),
      JSON.stringify((({ v, ...rest }) => rest)(envelope())),
      JSON.stringify({ v: 1 }),
      JSON.stringify(envelope({ session_id: undefined })),
      JSON.stringify(envelope({ session_id: '' })),
      JSON.stringify(envelope({ hook_event_name: undefined })),
      JSON.stringify(envelope({ hook_event_name: 7 })),
    ];
    for (const body of bodies) {
      assert.equal((await app.post(body)).status, 400, body.slice(0, 80));
    }
  });

  it('payload que não dá para serializar de novo (aninhamento extremo): 400, contadores coerentes e sem erro no log', async () => {
    const app = await startApp();
    const depth = 20_000;
    const body =
      '{"v":1,"payload":{"hook_event_name":"PostToolUse","session_id":"s","tool_name":"x",' +
      `"tool_input":${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    assert.equal((await app.post(body)).status, 400);
    const { events } = await app.health();
    assert.equal(events.received, 1);
    assert.equal(events.rejected, 1);
    assert.equal(events.accepted + events.deduped, 0);
    assert.deepEqual(app.errors, []);
    assert.equal((await app.post(envelope())).status, 204, 'o servidor segue aceitando');
  });

  it('outros métodos: 405 com Allow: POST; OPTIONS: 405', async () => {
    const app = await startApp();
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const res = await request(app.port, { method, path: '/hooks' });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'POST', method);
    }
    assert.equal((await request(app.port, { method: 'OPTIONS', path: '/hooks' })).status, 405);
  });

  it('Host de outra origem: 403, antes de qualquer regra da ingestão', async () => {
    const app = await startApp();
    assert.equal((await app.post(envelope(), { Host: `evil.example:${app.port}` })).status, 403);
    assert.equal((await app.health()).events.received, 0);
  });

  it('toda resposta tem os cabeçalhos do ADR 0006 e Cache-Control: no-store; nenhuma tem CORS', async () => {
    const app = await startApp();
    const responses = {
      204: await app.post(envelope()),
      400: await app.post('{'),
      401: await app.post(envelope(), { 'X-Agent-Quest-Token': 'errado' }),
      403: await app.post(envelope(), { Origin: 'http://evil.example' }),
      413: await app.post(envelopeOfSize(MAX_BODY_BYTES + 1)),
      415: await app.post(envelope(), { 'Content-Type': 'text/plain' }),
    };
    for (const [status, res] of Object.entries(responses)) {
      assert.equal(res.status, Number(status));
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(res.headers[name.toLowerCase()], value, `${status}: ${name}`);
      }
      assert.equal(res.headers['cache-control'], 'no-store', status);
      assert.deepEqual(Object.keys(res.headers).filter((name) => name.startsWith('access-control-')), []);
    }
    assert.equal(responses[204].body, '');
  });
});

describe('POST /hooks: aceitos e contadores', () => {
  it('válido: 204; /api/health conta received, accepted, rejected e lastEventAt', async () => {
    const app = await startApp();
    const before = await app.health();
    assert.deepEqual(before.events, { received: 0, accepted: 0, rejected: 0, deduped: 0, dropped: 0, ignored: 0 });
    assert.equal(before.lastEventAt, null);

    app.clock.now = T0 + 100;
    assert.equal((await app.post(envelope())).status, 204);
    app.clock.now = T0 + 200;
    assert.equal((await app.post('{')).status, 400);
    assert.equal((await app.post(envelope(), { 'X-Agent-Quest-Token': '' })).status, 401);

    const after = await app.health();
    assert.deepEqual(after.events, { received: 3, accepted: 1, rejected: 2, deduped: 0, dropped: 0, ignored: 0 });
    assert.equal(after.lastEventAt, T0 + 100, 'só POST respondido com 204 atualiza lastEventAt');
    assert.equal(after.sessions, 0);
    assert.equal(after.clients, 0);
    assert.deepEqual(Object.keys(after).sort(), ['clients', 'events', 'lastEventAt', 'ok', 'sessions', 'startedAt', 'version']);
  });

  it('o mesmo payload em até 5 s conta como deduped; depois de 5 s, é aceito (relógio injetado)', async () => {
    const app = await startApp();
    const payload = envelope().payload;
    // Cada encaminhador manda o próprio sentAt; o que conta é o payload.
    const send = (at) => {
      app.clock.now = at;
      return app.post(envelope(payload, { sentAt: at }));
    };
    assert.equal((await send(T0)).status, 204);
    assert.equal((await send(T0 + 4999)).status, 204);
    assert.equal((await send(T0 + 5000)).status, 204);
    let health = await app.health();
    assert.equal(health.events.accepted, 1);
    assert.equal(health.events.deduped, 2);
    assert.equal(health.lastEventAt, T0 + 5000, 'duplicata também atualiza lastEventAt');

    assert.equal((await send(T0 + 5001)).status, 204);
    health = await app.health();
    assert.equal(health.events.accepted, 2);
    assert.equal(health.events.deduped, 2);
    assert.equal(health.events.received, 4);
  });

  it('responde 204 antes de processar; o processador recebe o envelope e a hora de chegada', async () => {
    const pending = [];
    const seen = [];
    const app = await startApp({
      schedule: (run) => pending.push(run),
      onEnvelope: (env, meta) => seen.push({ env, meta }),
    });
    const sent = envelope();
    app.clock.now = T0 + 42;
    assert.equal((await app.post(sent)).status, 204);
    assert.deepEqual(seen, [], 'nada processado antes da resposta');
    while (pending.length) pending.shift()();
    assert.deepEqual(seen, [{ env: sent, meta: { receivedAt: T0 + 42 } }]);
  });

  it('duplicatas e recusas não chegam ao processador', async () => {
    const seen = [];
    const app = await startApp({ onEnvelope: (env) => seen.push(env.payload.tool_use_id) });
    const first = envelope();
    await app.post(first);
    await app.post(envelope(first.payload));
    await app.post(envelope(), { 'X-Agent-Quest-Token': 'errado' });
    await app.post(envelope({ session_id: '' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [first.payload.tool_use_id]);
  });

  it('fila cheia descarta os mais antigos e conta dropped', async () => {
    const pending = [];
    const seen = [];
    const app = await startApp({
      queueLimit: 2,
      schedule: (run) => pending.push(run),
      onEnvelope: (env) => seen.push(env.payload.tool_use_id),
    });
    const sent = [envelope(), envelope(), envelope()];
    for (const env of sent) assert.equal((await app.post(env)).status, 204);
    const health = await app.health();
    assert.equal(health.events.accepted, 3);
    assert.equal(health.events.dropped, 1);
    while (pending.length) pending.shift()();
    assert.deepEqual(seen, [sent[1].payload.tool_use_id, sent[2].payload.tool_use_id]);
  });

  it('processador que devolve false ou lança: ignored, e o log mostra só o tipo do erro', async () => {
    const marker = 'MARCADOR-SECRETO-7c1d';
    const app = await startApp({
      onEnvelope: (env) => {
        if (env.payload.tool_name === 'Ignorar') return false;
        if (env.payload.tool_name === 'Quebrar') throw new TypeError(`falhou com ${marker}`);
        return undefined;
      },
    });
    await app.post(envelope({ tool_name: 'Ignorar' }));
    await app.post(envelope({ tool_name: 'Quebrar', segredo: marker }));
    await app.post(envelope({ tool_name: 'Read' }));
    await new Promise((resolve) => setImmediate(resolve));
    const health = await app.health();
    assert.equal(health.events.accepted, 3);
    assert.equal(health.events.ignored, 2);
    assert.deepEqual(app.errors, ['Erro ao processar um evento: TypeError']);
    assert.equal((await app.post(envelope())).status, 204, 'o servidor segue aceitando');
  });

  it('--debug-dump recebe só os envelopes aceitos (sem duplicatas nem recusas)', async () => {
    const written = [];
    const app = await startApp({ dump: { write: (env, receivedAt) => written.push({ env, receivedAt }) } });
    const first = envelope();
    app.clock.now = T0 + 7;
    await app.post(first);
    await app.post(envelope(first.payload));
    await app.post('{');
    assert.deepEqual(written, [{ env: first, receivedAt: T0 + 7 }]);
  });

  it('rajada de 300 eventos em paralelo: todos aceitos e processados, nada descartado', async () => {
    let processed = 0;
    const app = await startApp({ onEnvelope: () => void processed++ });
    const batch = Array.from({ length: 300 }, () => envelope());
    for (let i = 0; i < batch.length; i += 50) {
      const results = await Promise.all(batch.slice(i, i + 50).map((env) => app.post(env)));
      assert.ok(results.every((res) => res.status === 204));
    }
    await new Promise((resolve) => setImmediate(resolve));
    const health = await app.health();
    assert.equal(health.events.accepted, 300);
    assert.equal(health.events.dropped, 0);
    assert.equal(processed, 300);
  });

  it('os logs nunca mostram corpo nem token', async () => {
    const app = await startApp();
    const marker = 'MARCADOR-SECRETO-9f3a';
    await app.post(envelope({ segredo: marker }));
    await app.post(`{${marker}`);
    await app.post(envelope({ segredo: marker }), { 'X-Agent-Quest-Token': marker });
    assert.deepEqual(app.errors, []);
  });
});

describe('POST /hooks: desempenho', () => {
  it('204 em menos de 20 ms no p95, em 200 requisições seguidas', async (t) => {
    // Duas medidas por requisição, com uma conexão nova a cada uma, como faz o encaminhador:
    // - no cliente, do envio à resposta;
    // - no próprio servidor, do pedido recebido à resposta terminada (o tempo de
    //   responder, sem o atraso do laço de eventos do cliente, que roda no mesmo processo).
    // Para não ficar instável com a máquina carregada: aquecimento antes e até 5
    // rodadas espaçadas de 200; passa se, em alguma rodada, o p95 de uma das medidas
    // ficar abaixo de 20 ms. Uma regressão real (trabalho pesado antes da resposta)
    // aparece nas duas medidas e reprova todas as rodadas.
    // Referência: um servidor HTTP mínimo, medido em cada rodada. Se nem ele fica
    // abaixo de 20 ms, a máquina está sobrecarregada e o teste é marcado como pulado,
    // com as medidas no motivo.
    const bare = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
    apps.push({ server: bare });
    const barePort = bare.address().port;
    const app = await startApp();
    const serverTimes = [];
    app.server.prependListener('request', (req, res) => {
      if (req.url !== '/hooks') return;
      const begin = performance.now();
      res.on('finish', () => serverTimes.push(performance.now() - begin));
    });
    const realistic = () => envelope({ tool_input: { file_path: '<repo>/server/http/app.js', extra: 'x'.repeat(3000) } });
    for (let i = 0; i < 20; i++) await app.post(realistic());

    const rounds = [];
    let bestBare = Infinity;
    for (let round = 0; round < 5; round++) {
      if (round > 0) await new Promise((resolve) => setTimeout(resolve, 300));
      const bareTimes = [];
      for (let i = 0; i < 50; i++) {
        const begin = performance.now();
        await request(barePort, { method: 'POST', path: '/', body: 'x' });
        bareTimes.push(performance.now() - begin);
      }
      const clientTimes = [];
      serverTimes.length = 0;
      for (let i = 0; i < 200; i++) {
        const body = JSON.stringify(realistic());
        const begin = performance.now();
        const res = await app.post(body);
        clientTimes.push(performance.now() - begin);
        assert.equal(res.status, 204);
      }
      assert.equal(serverTimes.length, 200);
      const client = percentile(clientTimes, 95);
      const server = percentile(serverTimes, 95);
      const bareP95 = percentile(bareTimes, 95);
      bestBare = Math.min(bestBare, bareP95);
      rounds.push(`cliente ${client.toFixed(1)} ms, servidor ${server.toFixed(1)} ms, servidor mínimo ${bareP95.toFixed(1)} ms`);
      if (client < 20 || server < 20) return;
    }
    const summary = `p95 acima de 20 ms em todas as rodadas: ${rounds.join('; ')}`;
    if (bestBare >= 20) {
      t.skip(`tempo não avaliado, máquina sobrecarregada (nem um servidor mínimo fica abaixo de 20 ms). ${summary}`);
      return;
    }
    assert.fail(summary);
  });
});
