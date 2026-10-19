// T9a: ligação de ponta a ponta com processos reais (plano, T9a, último
// critério): encaminhador real (processo filho, como o Claude Code o roda) →
// servidor real (`node server/main.js`, outro processo) → cliente SSE de teste,
// que recebe o `tool.started` em menos de 500 ms.
//
// Mede do início do processo do encaminhador até a chegada do `update` no
// cliente. Segue a regra de carga dos testes do T4 (capture-helpers.js,
// `assertWithinLimit`): até 5 rodadas, cada uma com a referência de partida do
// Node logo antes; com a máquina sobrecarregada, o tempo não é avaliado e o
// teste é pulado com as medidas.
//
// Nada usa o diretório de dados real nem a porta padrão: AGENT_QUEST_HOME
// temporário, porta 0 e pasta pessoal do servidor apontada para a temporária
// (o leitor de .claude/agents/ nunca lista a pasta pessoal real).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {
  assertSilentExit,
  assertWithinLimit,
  cleanupTemps,
  forwarderEnv,
  hookPayload,
  newTemp,
  readJson,
  runForwarder,
} from './capture-helpers.js';
import { killTree, launchServer, minimalEnv, request, waitFor } from './server-helpers.js';

/** Critério do T9a. */
const LIMIT_MS = 500;

/** Cliente SSE mínimo: cada mensagem guarda `event`, `id`, `data` e a hora de chegada. */
function openEvents(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
      const messages = [];
      const waiters = new Set();
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const at = Date.now();
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const message = { at };
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
        status: res.statusCode,
        messages,
        close: () => req.destroy(),
        /** Espera a mensagem que satisfaz `predicate`; null se não chegar no prazo. */
        waitFor(predicate, timeoutMs) {
          return new Promise((done) => {
            const finish = (value) => {
              clearTimeout(timer);
              waiters.delete(check);
              done(value);
            };
            const check = () => {
              const found = messages.find(predicate);
              if (found) finish(found);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            waiters.add(check);
            check();
          });
        },
      });
    });
    req.on('error', reject);
  });
}

describe('T9a integração: encaminhador real → servidor real → cliente SSE', () => {
  let home;
  let server;
  let runtime;
  let sse;

  before(async () => {
    home = newTemp('aq int ligação ção-');
    server = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: home, USERPROFILE: home, HOME: home }));
    assert.equal(await server.started, true, server.output());
    runtime = await waitFor(() => readJson(path.join(home, 'runtime.json')), { label: 'runtime.json do servidor real' });
    sse = await openEvents(runtime.port);
    assert.equal(sse.status, 200);
    assert.ok(await sse.waitFor((message) => message.event === 'snapshot', 3000), 'snapshot na conexão');
  });

  after(async () => {
    sse?.close();
    if (server) await killTree(server.child);
    cleanupTemps();
  });

  it(`o cliente SSE recebe o tool.started em menos de ${LIMIT_MS} ms, numerado e com o estado da sessão`, async (t) => {
    const env = forwarderEnv({ AGENT_QUEST_HOME: home });
    let delivered = null;
    await assertWithinLimit(
      t,
      'encaminhador → SSE',
      async () => {
        const payload = hookPayload({ tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Rodar a suíte' } });
        const arrived = sse.waitFor(
          (message) => message.event === 'update' && message.data.event?.kind === 'tool.started' && message.data.event.data.toolUseId === payload.tool_use_id,
          3000,
        );
        const result = await runForwarder({ env, stdin: JSON.stringify(payload) });
        const message = await arrived;
        if (message) delivered = { message, payload };
        // A medida é a da ponta a ponta: do início do encaminhador à chegada no cliente.
        return { ...result, ownMs: message ? message.at - result.beginEpoch : Infinity };
      },
      LIMIT_MS,
    );
    if (!delivered) return; // pulado por sobrecarga, com as medidas no diagnóstico
    const { message, payload } = delivered;
    assert.equal(message.id, `${message.data.event.id}`);
    assert.equal(message.data.event.seq, message.data.seq);
    assert.equal(message.data.event.sessionId, payload.session_id);
    assert.equal(message.data.event.agentKey, 'main');
    assert.deepEqual(
      (({ tool, category, target, detail }) => ({ tool, category, target, detail }))(message.data.event.data),
      { tool: 'Bash', category: 'bash', target: 'npm test', detail: 'Rodar a suíte' },
    );
    assert.equal(message.data.session.id, payload.session_id);
    assert.ok(!('feed' in message.data.session));
  });

  it('o seq é contínuo em tudo o que chegou ao cliente, e o /api/state bate com o que o cliente montou', async () => {
    const env = forwarderEnv({ AGENT_QUEST_HOME: home });
    const payload = hookPayload({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'SAIDA-REAL' } });
    const result = await runForwarder({ env, stdin: JSON.stringify(payload) });
    assertSilentExit(result, 'Post antes do Pre');
    await sse.waitFor((message) => message.data?.event?.data?.toolUseId === payload.tool_use_id && message.data.event.kind === 'tool.finished', 3000);
    const numbered = sse.messages.filter((message) => message.event === 'update' || message.event === 'session-removed');
    const snapshot = sse.messages.find((message) => message.event === 'snapshot');
    numbered.forEach((message, i) => assert.equal(message.data.seq, snapshot.data.seq + 1 + i, `mensagem ${i}`));
    const state = JSON.parse((await request(runtime.port, { path: '/api/state' })).text);
    assert.equal(state.seq, numbered.at(-1).data.seq);
    const health = JSON.parse((await request(runtime.port, { path: '/api/health' })).text);
    assert.equal(health.sessions, state.sessions.length);
    assert.equal(health.clients, 1);
    // Nada do conteúdo do resultado chega ao estado.
    assert.ok(!JSON.stringify(state).includes('SAIDA-REAL'));
  });
});
