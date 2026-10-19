// T9b no hub do SSE: retomada por `Last-Event-ID` (buffer de 1000) e
// desconexão de cliente lento (mais de 1 MiB acumulado), conforme o ADR 0004 e
// a seção 9 do modelo de eventos. O hub roda num servidor HTTP de teste, em
// 127.0.0.1 e porta 0, com mensagens numeradas à mão (o hub não numera).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { BUFFER_SIZE, MAX_PENDING_BYTES, createSseHub, lastSeqFrom } from '../../../../server/http/sse.js';

const RUN_ID = 'runT9b';
const servers = [];

afterEach(async () => {
  while (servers.length > 0) {
    const { server, hub } = servers.pop();
    hub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * Hub com um "estado" falso: o seq atual é o último publicado pelo teste.
 * `publish(n)` publica n updates seguidos, com `size` bytes de texto cada.
 */
async function startHub(options = {}) {
  let seq = 0;
  const hub = createSseHub({
    runId: RUN_ID,
    serverVersion: '9.9.9',
    getSnapshot: () => ({ seq, sessions: [] }),
    getSeq: () => seq,
    ...options,
  });
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, hub });
  return {
    hub,
    port: server.address().port,
    current: () => seq,
    publish(count = 1, size = 10) {
      for (let i = 0; i < count; i++) {
        seq++;
        hub.publishUpdate({ seq, event: null, session: { id: 'sessao-t9b', texto: 'x'.repeat(size) } });
      }
    },
    remove(sessionId = 'sessao-t9b') {
      seq++;
      hub.publishRemoved({ seq, sessionId });
    },
    skip() {
      seq++; // um seq reservado e nunca publicado (como um erro do reducer)
    },
  };
}

/** Cliente SSE: guarda as mensagens (`event`, `id`, `data`) conforme chegam. */
function connect(port, lastEventId) {
  return new Promise((resolve, reject) => {
    const headers = lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId };
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers, agent: false }, (res) => {
      const messages = [];
      const waiters = new Set();
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const message = {};
          for (const line of block.split('\n')) {
            const colon = line.indexOf(':');
            if (colon <= 0) continue;
            message[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          if (message.data) message.data = JSON.parse(message.data);
          if (message.event) messages.push(message);
        }
        for (const check of [...waiters]) check();
      });
      resolve({
        messages,
        close: () => req.destroy(),
        /** Espera até haver `count` mensagens. */
        until(count, timeoutMs = 3000) {
          return new Promise((done, fail) => {
            const check = () => {
              if (messages.length < count) return;
              clearTimeout(timer);
              waiters.delete(check);
              done(messages);
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error(`esperava ${count} mensagens, chegaram ${messages.length}: ${messages.map((m) => m.event).join(',')}`));
            }, timeoutMs);
            waiters.add(check);
            check();
          });
        },
      });
    });
    req.on('error', reject);
  });
}

/** Espera uma condição (sem relógio de teste: só repete a consulta). */
async function waitUntil(predicate, { timeoutMs = 5000 } = {}) {
  const limit = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error('condição não atendida a tempo');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('Last-Event-ID: formato', () => {
  it('só aceita <runId>:<seq> desta execução', () => {
    assert.equal(lastSeqFrom(`${RUN_ID}:12`, RUN_ID), 12);
    assert.equal(lastSeqFrom(` ${RUN_ID}:0 `, RUN_ID), 0);
    for (const value of [undefined, '', 'lixo', `${RUN_ID}:`, `${RUN_ID}:-1`, `${RUN_ID}:1.5`, `outra:12`, `${RUN_ID}:12:3`, `${RUN_ID}:${'9'.repeat(20)}`, 42]) {
      assert.equal(lastSeqFrom(value, RUN_ID), null, JSON.stringify(value));
    }
  });
});

describe('retomada por Last-Event-ID (buffer de 1000)', () => {
  it('reconexão válida recebe hello e só o que faltou, sem snapshot, e segue ao vivo', async () => {
    const hub = await startHub();
    hub.publish(5);
    hub.remove();
    const client = await connect(hub.port, `${RUN_ID}:2`);
    const messages = await client.until(5);
    assert.deepEqual(messages.map((m) => [m.event, m.data.seq]), [['hello', 6], ['update', 3], ['update', 4], ['update', 5], ['session-removed', 6]]);
    assert.equal(messages[1].id, `${RUN_ID}:3`);
    hub.publish(1);
    await client.until(6);
    assert.deepEqual([messages[5].event, messages[5].data.seq], ['update', 7]);
    client.close();
  });

  it('Last-Event-ID igual ao seq atual: só o hello, e o fluxo segue', async () => {
    const hub = await startHub();
    hub.publish(3);
    const client = await connect(hub.port, `${RUN_ID}:3`);
    await client.until(1);
    await settle();
    assert.deepEqual(client.messages.map((m) => m.event), ['hello']);
    assert.equal(client.messages[0].data.seq, 3);
    hub.publish(1);
    await client.until(2);
    assert.equal(client.messages[1].data.seq, 4);
    client.close();
  });

  it(`id de outra execução, inválido, futuro ou fora do buffer de ${BUFFER_SIZE}: snapshot`, async () => {
    const hub = await startHub();
    hub.publish(BUFFER_SIZE + 5); // o buffer guarda de 6 a 1005
    const cases = [
      ['outraExecucao:1000', 'outra execução'],
      ['lixo', 'inválido'],
      [`${RUN_ID}:${hub.current() + 1}`, 'futuro'],
      [`${RUN_ID}:4`, 'fora do buffer (falta o 5)'],
    ];
    for (const [id, label] of cases) {
      const client = await connect(hub.port, id);
      const messages = await client.until(2);
      assert.deepEqual(messages.map((m) => m.event), ['hello', 'snapshot'], label);
      assert.equal(messages[1].id, `${RUN_ID}:${hub.current()}`, label);
      client.close();
    }
    // Na borda: o 5 recebe do 6 em diante.
    const edge = await connect(hub.port, `${RUN_ID}:5`);
    const first = await edge.until(2);
    assert.deepEqual([first[1].event, first[1].data.seq], ['update', 6]);
    edge.close();
  });

  it('sem a mensagem seguinte no buffer (seq reservado e nunca publicado): snapshot', async () => {
    const hub = await startHub();
    hub.publish(2);
    hub.skip();
    hub.publish(2);
    const client = await connect(hub.port, `${RUN_ID}:2`);
    const messages = await client.until(2);
    assert.deepEqual(messages.map((m) => m.event), ['hello', 'snapshot']);
    client.close();
  });

  it(`o que falta passa de ${MAX_PENDING_BYTES} bytes: snapshot, para a retomada não derrubar o cliente`, async () => {
    const hub = await startHub();
    hub.publish(1);
    hub.publish(20, 64 * 1024); // cerca de 1,3 MB depois do seq 1
    const client = await connect(hub.port, `${RUN_ID}:1`);
    const messages = await client.until(2);
    assert.deepEqual(messages.map((m) => m.event), ['hello', 'snapshot']);
    client.close();
    // Logo abaixo do limite, retoma.
    const near = await connect(hub.port, `${RUN_ID}:${hub.current() - 10}`);
    const resumed = await near.until(11);
    assert.deepEqual(resumed.slice(1).map((m) => m.event), Array(10).fill('update'));
    near.close();
  });

  it('nenhuma publicação se intromete entre o envio da retomada e o registro do cliente', async () => {
    const hub = await startHub();
    hub.publish(10);
    const client = await connect(hub.port, `${RUN_ID}:7`);
    hub.publish(3);
    const messages = await client.until(7);
    assert.deepEqual(messages.slice(1).map((m) => m.data.seq), [8, 9, 10, 11, 12, 13]);
    client.close();
  });

  it(`teto de ${MAX_PENDING_BYTES} bytes no buffer: mensagens grandes tiram as antigas, e um id que saiu recebe snapshot`, async () => {
    const hub = await startHub();
    hub.publish(3); // pequenas: seq 1 a 3
    hub.publish(40, 64 * 1024); // cerca de 2,6 MB: o buffer fica com as mais recentes
    const bytes = hub.hub.bufferedBytes();
    assert.ok(bytes <= MAX_PENDING_BYTES, `buffer com ${bytes} bytes`);
    assert.ok(bytes > MAX_PENDING_BYTES - 70 * 1024, 'o buffer usa o teto, sem descartar além do necessário');
    // O id 3 saiu do buffer: snapshot.
    const gone = await connect(hub.port, `${RUN_ID}:3`);
    assert.deepEqual((await gone.until(2)).map((m) => m.event), ['hello', 'snapshot']);
    gone.close();
    // Os mais recentes continuam: retoma.
    const recent = await connect(hub.port, `${RUN_ID}:${hub.current() - 5}`);
    assert.deepEqual((await recent.until(6)).slice(1).map((m) => m.data.seq), [1, 2, 3, 4, 5].map((i) => hub.current() - 5 + i));
    recent.close();
    // Uma mensagem maior que o teto sozinha não fica guardada.
    hub.publish(1, MAX_PENDING_BYTES + 1);
    assert.equal(hub.hub.bufferedBytes(), 0);
  });

  it('o buffer guarda só as últimas mensagens, e publicar sem clientes também guarda', async () => {
    const hub = await startHub({ bufferSize: 3 });
    hub.publish(5); // sem nenhum cliente
    const inside = await connect(hub.port, `${RUN_ID}:2`);
    assert.deepEqual((await inside.until(4)).slice(1).map((m) => m.data.seq), [3, 4, 5]);
    inside.close();
    const outside = await connect(hub.port, `${RUN_ID}:1`);
    assert.equal((await outside.until(2))[1].event, 'snapshot');
    outside.close();
  });
});

describe('cliente lento (mais de 1 MiB acumulado)', () => {
  /** Cliente que manda o GET e nunca lê a resposta. */
  function stalledClient(port) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    socket.on('connect', () => {
      socket.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      socket.pause();
    });
    return socket;
  }

  it('é desconectado pelo servidor; quem lê continua recebendo tudo', async () => {
    const hub = await startHub();
    const reader = await connect(hub.port);
    await reader.until(2);
    const stalled = stalledClient(hub.port);
    await waitUntil(() => hub.hub.clientCount() === 2);
    for (let i = 0; i < 40 && hub.hub.clientCount() === 2; i++) {
      hub.publish(1, 64 * 1024);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await waitUntil(() => hub.hub.clientCount() === 1);
    const published = hub.current();
    await reader.until(2 + published, 10_000);
    assert.deepEqual(reader.messages.slice(2).map((m) => m.data.seq), Array.from({ length: published }, (_, i) => i + 1));
    stalled.destroy();
    reader.close();
  });

  it('volta com snapshot: o que faltou passa do limite', async () => {
    const hub = await startHub();
    hub.publish(1);
    const stalled = stalledClient(hub.port);
    await waitUntil(() => hub.hub.clientCount() === 1);
    const lastSeen = hub.current(); // o último id que o navegador teria guardado
    for (let i = 0; i < 40 && hub.hub.clientCount() === 1; i++) {
      hub.publish(1, 64 * 1024);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await waitUntil(() => hub.hub.clientCount() === 0);
    stalled.destroy();
    const back = await connect(hub.port, `${RUN_ID}:${lastSeen}`);
    const messages = await back.until(2);
    assert.deepEqual(messages.map((m) => m.event), ['hello', 'snapshot']);
    assert.equal(messages[1].data.seq, hub.current());
    back.close();
  });

  it('um snapshot grande no envio inicial não conta como acumulado', async () => {
    let seq = 0;
    const bigSnapshot = { seq: 0, sessions: [{ id: 'grande', texto: 'x'.repeat(3 * 1024 * 1024) }] };
    const hub = createSseHub({ runId: RUN_ID, serverVersion: '9.9.9', getSnapshot: () => ({ ...bigSnapshot, seq }), getSeq: () => seq });
    const server = http.createServer((req, res) => hub.handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push({ server, hub });
    const stalled = stalledClient(server.address().port);
    await waitUntil(() => hub.clientCount() === 1);
    seq++;
    hub.publishUpdate({ seq, event: null, session: { id: 'pequena' } });
    await settle();
    assert.equal(hub.clientCount(), 1, 'o envio inicial de 3 MiB parado não derrubou o cliente');
    stalled.destroy();
  });
});
