// Integração do T3 (tester): ingestão `POST /hooks` no servidor real.
//
// Fontes: plano da v1 (T3), modelo de eventos (seções 1, 8 e 9), ADR 0005
// (--debug-dump) e ADR 0006 (token, Origin, Content-Type, 1 MiB).
//
// Cobre: cada recusa (401, 403, 415, 413, 400) e o 204 com o servidor rodando
// como processo filho; recusas pelos cabeçalhos sem ler o corpo; descarte até
// 16 MiB antes do 413; contadores e forma do /api/health; duplicatas (processo
// real e relógio injetado); fila de 10 000 com descarte dos mais antigos; p95 do
// 204; rajada de 1 000 eventos com memória estável; --debug-dump; caminhos ruins
// (várias sessões, encaminhadores em paralelo, payload patológico).
//
// Regras do ADR 0010: AGENT_QUEST_HOME temporário e porta 0 em todo servidor;
// nenhum acesso à internet.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createApp } from '../../server/http/app.js';
import {
  ADR_HEADERS,
  MAIN,
  REPO,
  killTree,
  launchServer,
  minimalEnv,
  request,
  tempDir,
  waitFor,
} from './server-helpers.js';

const MiB = 1024 * 1024;
const VERSION = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

/** Chaves exatas de HealthResponse (modelo de eventos, seção 9). */
const HEALTH_KEYS = ['clients', 'events', 'lastEventAt', 'ok', 'sessions', 'startedAt', 'version'];
const EVENT_COUNTERS = ['accepted', 'deduped', 'dropped', 'ignored', 'received', 'rejected'];

let sequence = 0;

/** Envelope v1 como o da seção 1 do modelo de eventos, com payload único. */
function envelope(payload = {}, extra = {}) {
  sequence++;
  return {
    v: 1,
    sentAt: Date.now(),
    forwarder: '0.1.0',
    env: { projectDir: '<repo>', entrypoint: null },
    truncated: false,
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: 'sessao-int',
      tool_name: 'Read',
      tool_use_id: `toolu_int_${sequence}`,
      tool_input: { file_path: '<repo>/CLAUDE.md' },
      ...payload,
    },
    ...extra,
  };
}

/** Envelope válido com exatamente `size` bytes em JSON. */
function envelopeOfSize(size) {
  const base = envelope({ filler: '' });
  base.payload.filler = 'a'.repeat(size - Buffer.byteLength(JSON.stringify(base)));
  const text = JSON.stringify(base);
  assert.equal(Buffer.byteLength(text), size);
  return text;
}

/** Percentil por posição (sem interpolação). */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * `node server/main.js --port 0 ...extra` com AGENT_QUEST_HOME temporário.
 * Lê porta e token do runtime.json, como o encaminhador fará.
 */
async function startRealServer(extraArgs = []) {
  const home = tempDir('aq-int-hooks-');
  const run = launchServer(['--port', '0', ...extraArgs], minimalEnv({ AGENT_QUEST_HOME: home.dir }));
  assert.equal(await run.started, true, run.output());
  const runtime = JSON.parse(readFileSync(path.join(home.dir, 'runtime.json'), 'utf8'));
  assert.notEqual(runtime.port, 47821);

  /** POST /hooks com os cabeçalhos do encaminhador, que cada chamada pode trocar. */
  function post(body, headers = {}) {
    const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    return request(runtime.port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': runtime.token, ...headers },
      body: text,
    });
  }

  async function health() {
    const res = await request(runtime.port, { path: '/api/health' });
    assert.equal(res.status, 200);
    return JSON.parse(res.text);
  }

  async function stop() {
    await killTree(run.child);
    home.cleanup();
  }

  return { home: home.dir, run, port: runtime.port, token: runtime.token, runtime, post, health, stop };
}

/** Diferença dos contadores entre duas leituras do /api/health. */
function delta(before, after) {
  return Object.fromEntries(EVENT_COUNTERS.map((key) => [key, after.events[key] - before.events[key]]));
}

/** Zero em todos os contadores, menos os informados. */
function counts(partial) {
  return { received: 0, accepted: 0, rejected: 0, deduped: 0, dropped: 0, ignored: 0, ...partial };
}

/**
 * Manda os cabeçalhos e só um pedaço do corpo declarado, por socket cru.
 * Devolve a linha de status, ou `null` se nada chegar em `waitMs`.
 */
function partialBodyStatus(port, headerLines, { declared = MiB, sent = 'abcdefghij', waitMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const begin = performance.now();
    const finish = (line) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ line, ms: performance.now() - begin });
    };
    const timer = setTimeout(() => finish(null), waitMs);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\r\n')) finish(data.split('\r\n', 1)[0]);
    });
    socket.on('error', () => finish(data ? data.split('\r\n', 1)[0] : null));
    socket.write(
      `POST /hooks HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headerLines.join('\r\n')}\r\n` +
        `Content-Length: ${declared}\r\n\r\n${sent}`,
    );
  });
}

/** Resposta completa (cabeçalhos) por socket cru, sem mandar corpo. */
function rawHeadersOnly(port, headerLines) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    let closedByServer = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => (closedByServer = true));
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ head: data.split('\r\n\r\n', 1)[0], closedByServer });
    });
    socket.on('error', () => {});
    socket.write(`POST /hooks HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headerLines.join('\r\n')}\r\n\r\n`);
  });
}

describe('T3 integração: recusas e 204 no servidor real', () => {
  let srv;
  before(async () => {
    srv = await startRealServer();
  });
  after(async () => {
    if (srv) await srv.stop();
  });

  it('/api/health começa zerado, com a forma completa de HealthResponse', async () => {
    const health = await srv.health();
    assert.deepEqual(Object.keys(health).sort(), HEALTH_KEYS);
    assert.deepEqual(Object.keys(health.events).sort(), EVENT_COUNTERS);
    assert.equal(health.ok, true);
    assert.equal(health.version, VERSION);
    assert.equal(health.startedAt, srv.runtime.startedAt);
    assert.deepEqual(health.events, counts({}));
    assert.equal(health.lastEventAt, null);
    assert.equal(health.sessions, 0);
    assert.equal(health.clients, 0);
  });

  it('válido: 204 sem corpo, com os cabeçalhos do ADR 0006, no-store e sem CORS', async () => {
    const before = await srv.health();
    const res = await srv.post(envelope());
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    for (const [name, value] of Object.entries(ADR_HEADERS)) assert.equal(res.headers[name], value, name);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(res.headers).filter((h) => h.startsWith('access-control-')), []);
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 1, accepted: 1 }));
  });

  it('Host localhost:<porta> também é aceito na ingestão', async () => {
    assert.equal((await srv.post(envelope(), { Host: `localhost:${srv.port}` })).status, 204);
  });

  it('sem token, token vazio, errado, de outro tamanho, de outra execução ou repetido: 401', async () => {
    const before = await srv.health();
    const body = JSON.stringify(envelope());
    const noToken = await request(srv.port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(noToken.status, 401);
    const wrongSameLength = srv.token.slice(0, -1) + (srv.token.endsWith('A') ? 'B' : 'A');
    const others = [
      '',
      'errado',
      wrongSameLength,
      srv.token.slice(0, -1),
      `${srv.token}x`,
      srv.token.toLowerCase() === srv.token ? srv.token.toUpperCase() : srv.token.toLowerCase(),
      'A'.repeat(43),
      [srv.token, srv.token], // cabeçalho repetido: o Node junta com ", "
    ];
    for (const token of others) {
      const res = await srv.post(body, { 'X-Agent-Quest-Token': token });
      assert.equal(res.status, 401, JSON.stringify(token).slice(0, 60));
      for (const [name, value] of Object.entries(ADR_HEADERS)) assert.equal(res.headers[name], value, name);
      assert.doesNotMatch(res.text, new RegExp(srv.token), 'a resposta não ecoa o token');
    }
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 9, rejected: 9 }));
  });

  it('com qualquer Origin: 403, mesmo com token certo e mesmo sendo a própria origem', async () => {
    const before = await srv.health();
    const origins = [
      'http://evil.example',
      `http://127.0.0.1:${srv.port}`,
      `http://localhost:${srv.port}`,
      'null',
      'file://',
      'chrome-extension://abcdefghijklmnop',
      '',
    ];
    for (const origin of origins) {
      assert.equal((await srv.post(envelope(), { Origin: origin })).status, 403, JSON.stringify(origin));
    }
    // Origin pesa mais que o token: um navegador sem token também recebe 403.
    assert.equal((await srv.post(envelope(), { Origin: 'http://evil.example', 'X-Agent-Quest-Token': '' })).status, 403);
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 8, rejected: 8 }));
  });

  it('Content-Type diferente de application/json: 415; com parâmetros e maiúsculas, aceito', async () => {
    const before = await srv.health();
    const types = [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonx',
      'application/json-patch+json',
      'text/json',
      'application/javascript',
    ];
    for (const type of types) {
      assert.equal((await srv.post(envelope(), { 'Content-Type': type })).status, 415, type);
    }
    const noType = await request(srv.port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'X-Agent-Quest-Token': srv.token },
      body: JSON.stringify(envelope()),
    });
    assert.equal(noType.status, 415);
    for (const type of ['application/json; charset=utf-8', 'APPLICATION/JSON', 'application/json ; charset=UTF-8']) {
      assert.equal((await srv.post(envelope(), { 'Content-Type': type })).status, 204, type);
    }
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 12, rejected: 9, accepted: 3 }));
  });

  it('401, 403 e 415 respondem na hora, sem esperar o corpo declarado', async () => {
    const before = await srv.health();
    const json = 'Content-Type: application/json';
    const token = `X-Agent-Quest-Token: ${srv.token}`;
    const cases = [
      { headers: [json], status: 401 },
      { headers: [json, 'X-Agent-Quest-Token: errado'], status: 401 },
      { headers: [json, token, 'Origin: http://evil.example'], status: 403 },
      { headers: ['Content-Type: text/plain', token], status: 415 },
    ];
    for (const { headers, status } of cases) {
      const { line, ms } = await partialBodyStatus(srv.port, headers);
      assert.ok(line, `sem resposta para ${headers.join(' | ')}`);
      assert.match(line, new RegExp(`^HTTP/1\\.1 ${status} `), headers.join(' | '));
      assert.ok(ms < 1000, `${status} demorou ${ms.toFixed(0)} ms`);
    }
    // Contraprova: com token e JSON, o servidor espera o corpo inteiro antes de responder.
    const waiting = await partialBodyStatus(srv.port, [json, token], { waitMs: 500 });
    assert.equal(waiting.line, null, 'requisição válida deveria esperar o corpo');
    await waitFor(async () => (await srv.health()).events.rejected - before.events.rejected === 5, {
      label: 'contagem das 5 requisições',
    });
    const d = delta(before, await srv.health());
    assert.equal(d.rejected, 5, 'as 4 recusas e a requisição abandonada pelo cliente');
    assert.equal(d.accepted, 0);
  });

  it('corpo acima de 1 MiB: 413; exatamente 1 MiB: 204', async () => {
    const before = await srv.health();
    assert.equal((await srv.post(envelopeOfSize(MiB))).status, 204);
    const res = await srv.post(envelopeOfSize(MiB + 1));
    assert.equal(res.status, 413);
    assert.equal(res.headers['cache-control'], 'no-store');
    for (const [name, value] of Object.entries(ADR_HEADERS)) assert.equal(res.headers[name], value, name);
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 2, accepted: 1, rejected: 1 }));
  });

  it('com token válido, corpo de 10 MiB e de 16 MiB é lido e descartado: o cliente recebe o 413', async () => {
    const before = await srv.health();
    assert.equal((await srv.post(Buffer.alloc(10 * MiB, 'a'))).status, 413);
    assert.equal((await srv.post(Buffer.alloc(16 * MiB, 'a'))).status, 413);
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 2, rejected: 2 }));
  });

  it('acima de 1 MiB sem Content-Length (chunked): 413; pequeno e chunked: 204', async () => {
    const before = await srv.health();
    const chunked = (body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: srv.port,
            method: 'POST',
            path: '/hooks',
            agent: false,
            headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': srv.token },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', reject);
        for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.subarray(i, i + 64 * 1024));
        req.end();
      });
    assert.equal(await chunked(Buffer.from(envelopeOfSize(MiB + 1))), 413);
    assert.equal(await chunked(Buffer.from(JSON.stringify(envelope()))), 204);
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 2, accepted: 1, rejected: 1 }));
  });

  it('Content-Length acima de 16 MiB: 413 na hora, com Connection: close, sem ler o corpo', async () => {
    const before = await srv.health();
    const { head, closedByServer } = await rawHeadersOnly(srv.port, [
      'Content-Type: application/json',
      `X-Agent-Quest-Token: ${srv.token}`,
      `Content-Length: ${16 * MiB + 1}`,
    ]);
    assert.match(head, /^HTTP\/1\.1 413 /);
    assert.match(head, /\r\nconnection: close\r\n/i);
    assert.equal(closedByServer, true, 'o servidor encerra a conexão');
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 1, rejected: 1 }));
  });

  it('chunked passando de 16 MiB: conexão encerrada sem resposta; o servidor segue de pé e conta a recusa', async () => {
    const before = await srv.health();
    const outcome = await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: srv.port,
          method: 'POST',
          path: '/hooks',
          agent: false,
          headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': srv.token },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(`status ${res.statusCode}`));
        },
      );
      req.on('error', (err) => resolve(`erro ${err.code}`));
      const chunk = Buffer.alloc(256 * 1024, 'a');
      let written = 0;
      const pump = () => {
        while (written < 20 * MiB) {
          written += chunk.length;
          if (!req.write(chunk)) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    // Modelo de eventos, seção 1: "a conexão é encerrada sem resposta".
    assert.match(outcome, /^erro E\w+$/, outcome);
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 1, rejected: 1 }));
    assert.equal((await srv.post(envelope())).status, 204, 'o servidor segue aceitando');
  });

  it('JSON inválido ou envelope sem v: 1, payload.session_id ou payload.hook_event_name: 400', async () => {
    const before = await srv.health();
    const base = envelope();
    const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
    const bodies = [
      '',
      ' ',
      '{',
      '{"v":1,"payload":{"session_id":"s","hook_event_name":"Stop"}',
      '﻿' + JSON.stringify(base),
      'null',
      '[]',
      '"texto"',
      '1',
      'true',
      JSON.stringify([base]),
      JSON.stringify({ ...base, v: 2 }),
      JSON.stringify({ ...base, v: '1' }),
      JSON.stringify({ ...base, v: 1.5 }),
      JSON.stringify(without(base, 'v')),
      JSON.stringify(without(base, 'payload')),
      JSON.stringify({ ...base, payload: null }),
      JSON.stringify({ ...base, payload: [] }),
      JSON.stringify({ ...base, payload: 'PreToolUse' }),
      JSON.stringify({ ...base, payload: without(base.payload, 'session_id') }),
      JSON.stringify({ ...base, payload: { ...base.payload, session_id: '' } }),
      JSON.stringify({ ...base, payload: { ...base.payload, session_id: 42 } }),
      JSON.stringify({ ...base, payload: { ...base.payload, session_id: null } }),
      JSON.stringify({ ...base, payload: without(base.payload, 'hook_event_name') }),
      JSON.stringify({ ...base, payload: { ...base.payload, hook_event_name: '' } }),
      JSON.stringify({ ...base, payload: { ...base.payload, hook_event_name: ['Stop'] } }),
      // __proto__ vindo do JSON é chave própria, não herança: session_id continua ausente.
      '{"v":1,"payload":{"__proto__":{"session_id":"s"},"hook_event_name":"Stop"}}',
    ];
    for (const body of bodies) {
      const res = await srv.post(body);
      assert.equal(res.status, 400, body.slice(0, 80));
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    assert.deepEqual(
      delta(before, await srv.health()),
      counts({ received: bodies.length, rejected: bodies.length }),
    );
  });

  it('Host de outra origem: 403 e não conta em received', async () => {
    const before = await srv.health();
    for (const host of [`evil.example:${srv.port}`, `127.0.0.1:${srv.port + 1}`, '127.0.0.1', `[::1]:${srv.port}`]) {
      assert.equal((await srv.post(envelope(), { Host: host })).status, 403, host);
    }
    assert.deepEqual(delta(before, await srv.health()), counts({}));
  });

  it('outros métodos em /hooks: 405 com Allow: POST, sem contar em received', async () => {
    const before = await srv.health();
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await request(srv.port, { method, path: '/hooks' });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'POST', method);
      assert.deepEqual(Object.keys(res.headers).filter((h) => h.startsWith('access-control-')), [], method);
    }
    assert.deepEqual(delta(before, await srv.health()), counts({}));
  });

  it('received = accepted + deduped + rejected, e dropped e ignored ficam em 0 sem processador', async () => {
    const { events } = await srv.health();
    assert.ok(events.received > 0);
    assert.equal(events.received, events.accepted + events.deduped + events.rejected, JSON.stringify(events));
    assert.equal(events.dropped, 0);
    assert.equal(events.ignored, 0);
  });

  it('o terminal do servidor não mostrou corpo, token nem conteúdo de evento', () => {
    const out = srv.run.output();
    assert.doesNotMatch(out, new RegExp(srv.token));
    assert.doesNotMatch(out, /toolu_int_|sessao-int|CLAUDE\.md|PreToolUse/);
  });
});

describe('T3 integração: lastEventAt e duplicatas no servidor real', () => {
  let srv;
  before(async () => {
    srv = await startRealServer();
  });
  after(async () => {
    if (srv) await srv.stop();
  });

  it('lastEventAt: hora do servidor do último 204; recusas não mexem', async () => {
    assert.equal((await srv.health()).lastEventAt, null);
    for (const res of [
      await srv.post('{'),
      await srv.post(envelope(), { 'X-Agent-Quest-Token': 'errado' }),
      await srv.post(envelope(), { Origin: 'http://evil.example' }),
      await srv.post(envelope(), { 'Content-Type': 'text/plain' }),
      await srv.post(envelopeOfSize(MiB + 1)),
    ]) {
      assert.notEqual(res.status, 204);
    }
    assert.equal((await srv.health()).lastEventAt, null, 'nenhum 204 ainda');

    // sentAt bem diferente da hora real: lastEventAt precisa ser o relógio do servidor
    // na chegada, não o sentAt. A folga de 50 ms cobre a diferença entre o Date.now()
    // de dois processos no Windows (com ±5 ms o teste já falhou uma vez).
    const t1 = Date.now();
    assert.equal((await srv.post(envelope({}, { sentAt: 1 }))).status, 204);
    const t2 = Date.now();
    const first = (await srv.health()).lastEventAt;
    assert.ok(first >= t1 - 50 && first <= t2 + 50, `lastEventAt ${first} fora de [${t1}, ${t2}] ± 50 ms`);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await srv.post('{');
    assert.equal((await srv.health()).lastEventAt, first, '400 não atualiza');
  });

  it('o mesmo payload de dois encaminhadores (sentAt e forwarder diferentes) conta como deduped', async () => {
    const before = await srv.health();
    const payload = envelope().payload;
    assert.equal((await srv.post(envelope(payload, { sentAt: 1, forwarder: '0.1.0' }))).status, 204);
    const afterFirst = (await srv.health()).lastEventAt;
    // Só compara o relógio do servidor com ele mesmo: o Date.now() de dois processos
    // no Windows pode divergir alguns ms. A pausa garante que o relógio do servidor andou.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await srv.post(envelope(payload, { sentAt: 2, forwarder: '0.2.0', truncated: true }))).status, 204);
    const after = await srv.health();
    assert.deepEqual(delta(before, after), counts({ received: 2, accepted: 1, deduped: 1 }));
    assert.ok(after.lastEventAt > afterFirst, `duplicata também atualiza lastEventAt (${afterFirst} → ${after.lastEventAt})`);
  });

  it('duplicatas simultâneas (plugin carregado duas vezes): exatamente uma aceita', async () => {
    const before = await srv.health();
    const payloads = Array.from({ length: 20 }, () => envelope().payload);
    const posts = payloads.flatMap((payload) => [srv.post(envelope(payload)), srv.post(envelope(payload))]);
    const results = await Promise.all(posts);
    assert.ok(results.every((res) => res.status === 204));
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 40, accepted: 20, deduped: 20 }));
  });

  it('várias sessões ao mesmo tempo com o mesmo resto do payload: nada é tratado como duplicata', async () => {
    const before = await srv.health();
    const common = { hook_event_name: 'Stop', stop_hook_active: false };
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => srv.post({ v: 1, payload: { ...common, session_id: `sessao-${i}` } })),
    );
    assert.ok(results.every((res) => res.status === 204));
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 30, accepted: 30 }));
  });

  it('subagentes em paralelo (mesma sessão, agent_id diferentes): todos aceitos', async () => {
    const before = await srv.health();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        srv.post(
          envelope({
            hook_event_name: 'SubagentStart',
            agent_id: `a${String(i).padStart(16, '0')}`,
            agent_type: 'probe-worker',
            tool_use_id: undefined,
          }),
        ),
      ),
    );
    assert.ok(results.every((res) => res.status === 204));
    assert.deepEqual(delta(before, await srv.health()), counts({ received: 12, accepted: 12 }));
  });
});

describe('T3 integração: duplicatas com relógio injetado (createApp)', () => {
  const T0 = 1_760_000_000_000;
  const TOKEN = 'token-integracao-T3-0123456789abcdefghijk';
  let app;
  let port;
  const clock = { now: T0 };
  const processed = [];

  before(async () => {
    app = createApp({
      version: '0.0.0-teste',
      startedAt: T0,
      token: TOKEN,
      clock: () => clock.now,
      logError: () => {},
      onEnvelope: (env, meta) => void processed.push({ id: env.payload.tool_use_id, at: meta.receivedAt }),
    });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    port = app.server.address().port;
  });
  after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  });

  const post = (env, at) => {
    clock.now = at;
    return request(port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': TOKEN },
      body: JSON.stringify(env),
    });
  };

  it('até 5 s (inclusive) é duplicata; a partir de 5 s + 1 ms é aceito; duplicatas não esticam a janela', async () => {
    const a = envelope().payload;
    const b = envelope().payload;
    const steps = [
      [a, T0, 'aceito'],
      [a, T0 + 1, 'dup'],
      [b, T0 + 1000, 'aceito'],
      [a, T0 + 3000, 'dup'],
      [a, T0 + 5000, 'dup'],
      [a, T0 + 5001, 'aceito'],
      [b, T0 + 6000, 'dup'],
      [b, T0 + 6001, 'aceito'],
      [a, T0 + 10_001, 'dup'],
      [a, T0 + 10_002, 'aceito'],
    ];
    let accepted = 0;
    let deduped = 0;
    for (const [payload, at, expected] of steps) {
      const before = app.health().events;
      assert.equal((await post(envelope(payload, { sentAt: at - 3 }), at)).status, 204);
      const after = app.health().events;
      const got = after.accepted > before.accepted ? 'aceito' : after.deduped > before.deduped ? 'dup' : '?';
      assert.equal(got, expected, `t = T0 + ${at - T0}`);
      if (got === 'aceito') accepted++;
      else deduped++;
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.health().events.accepted, accepted);
    assert.equal(app.health().events.deduped, deduped);
    assert.equal(processed.length, accepted, 'duplicatas não chegam ao processador');
    assert.deepEqual(
      processed.map((p) => p.at - T0),
      [0, 1000, 5001, 6001, 10_002],
      'o processador recebe a hora de chegada do relógio do servidor',
    );
    assert.equal(app.health().lastEventAt, T0 + 10_002);
  });
});

describe('T3 integração: fila de 10 000 com descarte dos mais antigos', () => {
  it('10 003 aceitos com o processamento parado: dropped 3, e os 3 mais antigos são os que somem', async () => {
    const TOKEN = 'token-fila-T3-0123456789abcdefghijklmnopqrs';
    const pending = [];
    const handled = [];
    const app = createApp({
      version: '0.0.0-teste',
      startedAt: 0,
      token: TOKEN,
      logError: () => {},
      // Limite padrão (sem queueLimit): o teste confere o valor ligado no servidor.
      schedule: (run) => pending.push(run),
      onEnvelope: (env) => void handled.push(env.payload.tool_use_id),
    });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const port = app.server.address().port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
    const post = (env) =>
      request(port, {
        method: 'POST',
        path: '/hooks',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': TOKEN },
        body: JSON.stringify(env),
        agent,
      });
    try {
      const oldest = [envelope(), envelope(), envelope()];
      for (const env of oldest) assert.equal((await post(env)).status, 204);
      const rest = Array.from({ length: 10_000 }, () => envelope({ hook_event_name: 'PostToolUse' }));
      const statuses = new Map();
      for (let i = 0; i < rest.length; i += 500) {
        const results = await Promise.all(rest.slice(i, i + 500).map(post));
        for (const res of results) statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
      assert.deepEqual([...statuses], [[204, 10_000]], 'fila cheia não recusa: o 429 não é emitido');

      const health = app.health();
      assert.equal(health.events.received, 10_003);
      assert.equal(health.events.accepted, 10_003);
      assert.equal(health.events.dropped, 3);
      assert.equal(health.events.rejected, 0);

      while (pending.length) pending.shift()();
      assert.equal(handled.length, 10_000);
      const handledSet = new Set(handled);
      for (const env of oldest) assert.equal(handledSet.has(env.payload.tool_use_id), false, 'o mais antigo sumiu');
      for (const env of rest) assert.equal(handledSet.has(env.payload.tool_use_id), true);
    } finally {
      agent.destroy();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
  });
});

describe('T3 integração: desempenho do 204', () => {
  let srv;
  before(async () => {
    srv = await startRealServer();
  });
  after(async () => {
    if (srv) await srv.stop();
  });

  it('p95 abaixo de 20 ms em 200 requisições seguidas (servidor em outro processo, conexão nova por requisição)', async (t) => {
    // Medido no cliente, de fora do processo do servidor, como o encaminhador vê.
    // Robustez: aquecimento e até 3 rodadas de 200; a primeira abaixo de 20 ms
    // aprova. Trabalho pesado antes da resposta reprova as três.
    const realistic = () =>
      envelope({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test', description: 'Roda a suíte' },
        tool_response: { stdout: `${'x'.repeat(1024)}…[cortado 9000 caracteres]…${'y'.repeat(3072)}`, stderr: '' },
      });
    for (let i = 0; i < 20; i++) await srv.post(realistic());

    const rounds = [];
    for (let round = 0; round < 3; round++) {
      const times = [];
      for (let i = 0; i < 200; i++) {
        const body = JSON.stringify(realistic());
        const begin = performance.now();
        const res = await srv.post(body);
        times.push(performance.now() - begin);
        assert.equal(res.status, 204);
      }
      rounds.push({ p50: percentile(times, 50), p95: percentile(times, 95), max: Math.max(...times) });
      if (rounds.at(-1).p95 < 20) break;
    }
    const summary = rounds
      .map((r, i) => `rodada ${i + 1}: p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, máx ${r.max.toFixed(1)} ms`)
      .join('; ');
    t.diagnostic(summary);
    assert.ok(rounds.at(-1).p95 < 20, summary);
  });
});

describe('T3 integração: rajada de 1 000 eventos e memória do servidor', () => {
  let child;
  let home;
  let info;
  const replies = [];
  let waiting = null;

  /** Próxima mensagem do processo do servidor (IPC). */
  function nextMessage() {
    if (replies.length) return Promise.resolve(replies.shift());
    return new Promise((resolve) => (waiting = resolve));
  }

  before(async () => {
    home = tempDir('aq-int-burst-');
    // O servidor de produção (startServer) num processo próprio com --expose-gc,
    // para medir o heap dele depois de coletar o lixo, sem misturar com o cliente.
    const harness = [
      `import process from 'node:process';`,
      `import { startServer } from ${JSON.stringify(pathToFileURL(MAIN).href)};`,
      `const run = await startServer({ argv: ['--port', '0'], env: { AGENT_QUEST_HOME: process.env.AGENT_QUEST_HOME }, homedir: process.env.AGENT_QUEST_HOME, logError: (m) => process.send({ error: m }) });`,
      `process.send({ port: run.port, token: run.runtime.token });`,
      `process.on('message', async (m) => {`,
      `  if (m === 'mem') { globalThis.gc(); globalThis.gc(); process.send({ mem: process.memoryUsage() }); }`,
      `  if (m === 'close') { await run.close(); process.exit(0); }`,
      `});`,
    ].join('\n');
    child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', harness], {
      cwd: REPO,
      env: minimalEnv({ AGENT_QUEST_HOME: home.dir }),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    child.on('message', (message) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(message);
      } else {
        replies.push(message);
      }
    });
    info = await nextMessage();
    assert.equal(typeof info.port, 'number', JSON.stringify(info));
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.send('close');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      await killTree(child);
    }
    home?.cleanup();
  });

  async function heapUsed() {
    child.send('mem');
    const message = await nextMessage();
    assert.ok(message.mem, JSON.stringify(message));
    return message.mem.heapUsed;
  }

  function post(env) {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: info.port,
          method: 'POST',
          path: '/hooks',
          agent: false,
          headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': info.token },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', (err) => resolve(`erro ${err.code}`));
      req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
      req.end(JSON.stringify(env));
    });
  }

  it('5 rajadas de 1 000 POST simultâneos: todos 204, nada descartado e heap estável', async (t) => {
    const ROUNDS = 5;
    const heaps = [await heapUsed()];
    for (let round = 1; round <= ROUNDS; round++) {
      const batch = Array.from({ length: 1000 }, (_, i) =>
        envelope({
          hook_event_name: i % 2 ? 'PostToolUse' : 'PreToolUse',
          session_id: `sessao-${i % 5}`,
          agent_id: i % 3 ? `a${String(i % 7).padStart(16, '0')}` : undefined,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: { stdout: 'z'.repeat(4096) },
        }),
      );
      const results = await Promise.all(batch.map(post));
      const tally = {};
      for (const status of results) tally[status] = (tally[status] ?? 0) + 1;
      assert.deepEqual(tally, { 204: 1000 }, `rajada ${round}: ${JSON.stringify(tally)}`);
      heaps.push(await heapUsed());
    }

    const health = JSON.parse((await request(info.port, { path: '/api/health' })).text);
    assert.deepEqual(health.events, counts({ received: 5000, accepted: 5000 }));

    const mb = heaps.map((h) => (h / 1e6).toFixed(2));
    t.diagnostic(`heap depois do GC (MB): início ${mb[0]}; rajadas ${mb.slice(1).join(', ')}`);
    // A janela de duplicatas guarda os hashes dos últimos 5 s (até ~5 000 aqui):
    // crescimento pequeno e limitado é esperado; vazamento por evento não é.
    const growthFromFirstBurst = heaps.at(-1) - heaps[1];
    assert.ok(growthFromFirstBurst < 4e6, `heap cresceu ${(growthFromFirstBurst / 1e6).toFixed(2)} MB entre a 1ª e a última rajada`);
    assert.ok(Math.max(...heaps) - heaps[0] < 16e6, `pico de heap acima do início: ${mb.join(', ')}`);
  });

  it('depois da rajada o servidor responde ao /api/health e aceita eventos normalmente', async () => {
    assert.equal(await post(envelope()), 204);
    const res = await request(info.port, { path: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).events.accepted, 5001);
  });
});

describe('T3 integração: --debug-dump', () => {
  /** Nomes possíveis do arquivo do dia (perto da meia-noite, aceita os dois). */
  function todayNames(begin, end) {
    const name = (ts) => {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
    };
    return new Set([name(begin), name(end)]);
  }

  it('com a opção: aviso de dados sensíveis no início e pasta criada só no primeiro envelope aceito', async () => {
    const begin = Date.now();
    const srv = await startRealServer(['--debug-dump']);
    try {
      const dumps = path.join(srv.home, 'dumps');
      // O aviso sai no stderr e a URL no stdout: a ordem entre os dois canais não é garantida.
      const out = await waitFor(() => (/dados sensíveis/.test(srv.run.output()) ? srv.run.output() : null), {
        timeoutMs: 3000,
        label: 'aviso do --debug-dump no início',
      });
      assert.match(out, /--debug-dump/);
      assert.ok(out.includes(dumps), `o aviso mostra a pasta ${dumps}:\n${out}`);

      assert.equal(existsSync(dumps), false, 'sem envelope, sem pasta');
      await srv.post(envelope(), { 'X-Agent-Quest-Token': 'errado' });
      await srv.post('{');
      await srv.post(envelope(), { Origin: 'http://evil.example' });
      await srv.post(envelopeOfSize(MiB + 1));
      assert.equal(existsSync(dumps), false, 'recusas não criam a pasta');

      const first = envelope({ segredo: 'sk-ant-api03-FAKEFAKEFAKE' });
      const second = envelope({ hook_event_name: 'Stop', tool_name: undefined });
      assert.equal((await srv.post(first)).status, 204);
      assert.equal((await srv.post(envelope(first.payload, { sentAt: 1 }))).status, 204, 'duplicata');
      assert.equal((await srv.post(second)).status, 204);

      const names = todayNames(begin, Date.now());
      const lines = await waitFor(
        () => {
          if (!existsSync(dumps)) return null;
          const files = readdirSync(dumps);
          if (files.length !== 1) return null;
          const text = readFileSync(path.join(dumps, files[0]), 'utf8');
          const all = text.split('\n').filter(Boolean);
          return all.length >= 2 && text.endsWith('\n') ? { file: files[0], all } : null;
        },
        { label: 'arquivo do --debug-dump com 2 linhas' },
      );
      assert.ok(names.has(lines.file), `nome ${lines.file}, esperado ${[...names].join(' ou ')}`);
      assert.deepEqual(
        lines.all.map((line) => JSON.parse(line)),
        [first, second].map((env) => JSON.parse(JSON.stringify(env))),
        'só os aceitos, sem duplicata nem recusa, um por linha, como chegaram',
      );
      assert.doesNotMatch(srv.run.output(), /sk-ant-api03/, 'o terminal não mostra o conteúdo');
    } finally {
      await srv.stop();
    }
  });

  it('sem a opção: nada é gravado; o diretório de dados só tem o runtime.json', async () => {
    const srv = await startRealServer();
    try {
      for (let i = 0; i < 5; i++) assert.equal((await srv.post(envelope())).status, 204);
      await srv.post('{');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(path.join(srv.home, 'dumps')), false);
      assert.deepEqual(readdirSync(srv.home), ['runtime.json']);
      assert.doesNotMatch(srv.run.output(), /debug-dump|dados sensíveis/);
    } finally {
      await srv.stop();
    }
  });
});

describe('T3 integração: payload patológico não quebra contadores nem some em silêncio', () => {
  // Envelope válido (v: 1, session_id, hook_event_name) com um campo muito
  // aninhado. JSON.parse aceita; o hash do payload usa JSON.stringify, que é
  // recursivo e estoura a pilha. O resultado precisa ser coerente: ou o evento é
  // recusado (400, conta em rejected), ou é aceito/deduplicado. Nunca contado só
  // em received, nem derrubar a conexão com erro no log.
  let srv;
  before(async () => {
    srv = await startRealServer();
  });
  after(async () => {
    if (srv) await srv.stop();
  });

  it('payload com 20 000 níveis de aninhamento: received = accepted + deduped + rejected', async () => {
    const depth = 20_000;
    const body =
      '{"v":1,"payload":{"hook_event_name":"PostToolUse","session_id":"sessao-int","tool_name":"mcp__x__y",' +
      `"tool_input":${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    const before = await srv.health();
    const res = await srv.post(body);
    assert.ok([204, 400].includes(res.status), `status ${res.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await srv.health();
    const d = delta(before, after);
    assert.equal(d.received, 1);
    assert.equal(d.accepted + d.deduped + d.rejected, 1, `contadores incoerentes: ${JSON.stringify(d)}`);
    assert.doesNotMatch(srv.run.output(), /Erro ao responder/, 'erro inesperado no log do servidor');
  });

  it('com --debug-dump: envelope aceito que não dá para serializar é pulado e o dump continua gravando', async () => {
    const dumpSrv = await startRealServer(['--debug-dump']);
    try {
      const depth = 20_000;
      const deep = `${'['.repeat(depth)}${']'.repeat(depth)}`;
      const first = envelope({ marcador: 'primeiro' });
      const last = envelope({ marcador: 'ultimo' });
      // Payload pequeno (o hash funciona) e aninhamento extremo fora dele, em `env`.
      const deepEnv =
        '{"v":1,"env":' + deep + ',"payload":{"hook_event_name":"Stop","session_id":"sessao-int","marcador":"env-fundo"}}';
      // Aninhamento extremo dentro do payload: 400.
      const deepPayload =
        '{"v":1,"payload":{"hook_event_name":"Stop","session_id":"sessao-int","marcador":"payload-fundo","x":' + deep + '}}';

      assert.equal((await dumpSrv.post(first)).status, 204);
      assert.equal((await dumpSrv.post(deepEnv)).status, 204);
      assert.equal((await dumpSrv.post(deepPayload)).status, 400);
      assert.equal((await dumpSrv.post(last)).status, 204);
      const health = await dumpSrv.health();
      assert.deepEqual(health.events, counts({ received: 4, accepted: 3, rejected: 1 }));

      const dumps = path.join(dumpSrv.home, 'dumps');
      const markers = await waitFor(
        () => {
          if (!existsSync(dumps)) return null;
          const files = readdirSync(dumps);
          if (files.length !== 1) return null;
          const text = readFileSync(path.join(dumps, files[0]), 'utf8');
          const lines = text.split('\n').filter(Boolean);
          return lines.length >= 2 && text.endsWith('\n') ? lines.map((line) => JSON.parse(line).payload.marcador) : null;
        },
        { label: 'dump com as duas linhas serializáveis' },
      );
      assert.deepEqual(markers, ['primeiro', 'ultimo'], 'o envelope não serializável é pulado; o seguinte ainda é gravado');
      assert.doesNotMatch(dumpSrv.run.output(), /Erro ao gravar o --debug-dump|Erro ao responder/);
    } finally {
      await dumpSrv.stop();
    }
  });
});
