// Injetor de cenários (T9b): `npm run inject -- <arquivo> [--fast] [--speed N]`.
// Relógio, espera e envio falsos nos testes de ritmo (ADR 0010, complemento
// "testes de tempo estáveis"); servidor real, num AGENT_QUEST_HOME temporário e
// na porta 0, nos testes de linha de comando. Cenários SINTÉTICOS.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  INJECTOR_ID,
  envelopeFor,
  injectScenario,
  parseArgs,
  runInject,
  validateScenario,
} from '../../../scripts/inject-fixture.mjs';
import { startServer } from '../../../server/main.js';

const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aq-inject-'));
  temps.push(dir);
  return dir;
}

/** Cenário sintético mínimo no formato do ADR 0010. */
function scenario(dts = [0, 100, 50, 0, 1000]) {
  return {
    name: 'sintetico-injetor',
    description: 'SINTÉTICO: eventos de uma sessão fictícia',
    events: dts.map((dt, i) => ({
      dt,
      env: { projectDir: 'C:\\Users\\fulana\\Projetos\\exemplo', entrypoint: 'cli' },
      payload: { hook_event_name: 'PreToolUse', session_id: 'sessao-injetor', tool_name: 'Read', tool_use_id: `toolu_injetor_${i}`, tool_input: { file_path: 'a.md' } },
    })),
  };
}

/** Relógio, espera e envio falsos: a espera avança o relógio. */
function fakes(statuses = []) {
  let now = 1_000;
  const waits = [];
  const sent = [];
  return {
    waits,
    sent,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    post: async (port, token, envelope) => {
      sent.push({ port, token, envelope, at: now });
      return statuses.length > 0 ? statuses.shift() : 204;
    },
    advance: (ms) => (now += ms),
  };
}

describe('argumentos', () => {
  it('arquivo, --fast e --speed N (ou --speed=N)', () => {
    assert.deepEqual(parseArgs(['a.json']), { ok: true, file: 'a.json', fast: false, speed: 1 });
    assert.deepEqual(parseArgs(['--fast', 'a.json']), { ok: true, file: 'a.json', fast: true, speed: 1 });
    assert.deepEqual(parseArgs(['a.json', '--speed', '4']), { ok: true, file: 'a.json', fast: false, speed: 4 });
    assert.deepEqual(parseArgs(['a.json', '--speed=0.5']), { ok: true, file: 'a.json', fast: false, speed: 0.5 });
  });

  it('erros com a forma de uso', () => {
    for (const argv of [[], ['a.json', 'b.json'], ['a.json', '--speed'], ['a.json', '--speed', '0'], ['a.json', '--speed=-2'], ['a.json', '--speed', 'rápido'], ['a.json', '--outra']]) {
      const result = parseArgs(argv);
      assert.equal(result.ok, false, JSON.stringify(argv));
      assert.match(/** @type {any} */ (result).error, /npm run inject|--speed|desconhecida/);
    }
  });
});

describe('cenário e envelope', () => {
  it('confere a forma do ADR 0010 sem olhar o conteúdo dos payloads', () => {
    assert.equal(validateScenario(scenario()).ok, true);
    for (const value of [null, [], {}, { events: {} }, { events: [null] }, { events: [{ dt: 0 }] }, { events: [{ dt: -1, payload: {} }] }, { events: [{ dt: 'x', payload: {} }] }, { events: [{ payload: [] }] }]) {
      assert.equal(validateScenario(value).ok, false, JSON.stringify(value));
    }
  });

  it('envelope v1 com sentAt, env e payload do cenário, e o campo forwarder do injetor', () => {
    const event = scenario().events[0];
    assert.deepEqual(envelopeFor(event, 123), {
      v: 1, sentAt: 123, forwarder: INJECTOR_ID,
      env: { projectDir: 'C:\\Users\\fulana\\Projetos\\exemplo', entrypoint: 'cli' },
      truncated: false, payload: event.payload,
    });
    assert.deepEqual(envelopeFor({ dt: 0, payload: {} }, 1).env, { projectDir: null, entrypoint: null });
  });
});

describe('ritmo do envio (relógio e espera falsos)', () => {
  it('respeita os intervalos pela agenda, em ordem, com o token e a porta', async () => {
    const fake = fakes();
    const result = await injectScenario(scenario(), { port: 4000, token: 'tok', ...fake });
    assert.deepEqual(result, { sent: 5, accepted: 5, refused: [] });
    assert.deepEqual(fake.sent.map((item) => item.at - 1_000), [0, 100, 150, 150, 1150]);
    assert.deepEqual(fake.sent.map((item) => item.envelope.payload.tool_use_id), [0, 1, 2, 3, 4].map((i) => `toolu_injetor_${i}`));
    assert.ok(fake.sent.every((item) => item.port === 4000 && item.token === 'tok'));
  });

  it('o atraso de um envio não se acumula: a próxima espera desconta', async () => {
    const fake = fakes();
    const slowPost = async (...args) => {
      fake.advance(80); // cada POST leva 80 ms
      return fake.post(...args);
    };
    await injectScenario(scenario([0, 100, 100]), { port: 4000, token: 'tok', ...fake, post: slowPost });
    assert.deepEqual(fake.waits, [20, 20], 'espera só o que falta até a agenda');
  });

  it('--speed divide os intervalos; --fast não espera', async () => {
    const fast = fakes();
    await injectScenario(scenario(), { port: 4000, token: 'tok', ...fast, fast: true });
    assert.deepEqual(fast.waits, []);
    const double = fakes();
    await injectScenario(scenario(), { port: 4000, token: 'tok', ...double, speed: 2 });
    assert.deepEqual(double.sent.map((item) => item.at - 1_000), [0, 50, 75, 75, 575]);
  });

  it('sentAt nunca se repete: no mesmo milissegundo, o seguinte ganha +1 ms', async () => {
    const fake = fakes();
    await injectScenario(scenario([0, 0, 0, 0]), { port: 4000, token: 'tok', ...fake, fast: true });
    assert.deepEqual(fake.sent.map((item) => item.envelope.sentAt), [1000, 1001, 1002, 1003]);
  });

  it('conta os recusados (status e posição) e segue até o fim', async () => {
    const fake = fakes([204, 401, 204, 0, 204]);
    assert.deepEqual(await injectScenario(scenario(), { port: 4000, token: 'tok', ...fake, fast: true }), {
      sent: 5, accepted: 3, refused: [{ index: 1, status: 401 }, { index: 3, status: 0 }],
    });
  });

  it('só envia para uma porta de 1024 a 65535', async () => {
    for (const port of [0, 80, 70000, 1.5]) {
      await assert.rejects(injectScenario(scenario(), { port, token: 'tok', ...fakes() }), RangeError, String(port));
    }
  });
});

describe('linha de comando', () => {
  const quiet = () => {
    const out = [];
    const err = [];
    return { out, err, log: (message) => out.push(message), logError: (message) => err.push(message) };
  };

  it('sem servidor (sem runtime.json): sai com 1 e diz como iniciar', async () => {
    const home = tempDir();
    const file = path.join(home, 'cenario.json');
    writeFileSync(file, JSON.stringify(scenario()));
    const io = quiet();
    const code = await runInject({ argv: [file], env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, ...io });
    assert.equal(code, 1);
    assert.match(io.err.join('\n'), /não está rodando.*npm start/);
  });

  it('arquivo que não existe ou não é cenário: sai com 1', async () => {
    const home = tempDir();
    const bad = path.join(home, 'ruim.json');
    writeFileSync(bad, '{"events": 3}');
    for (const [file, pattern] of [[path.join(home, 'nao-existe.json'), /Não foi possível ler/], [bad, /Cenário inválido/]]) {
      const io = quiet();
      assert.equal(await runInject({ argv: [file], env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, ...io }), 1);
      assert.match(io.err.join('\n'), pattern);
    }
  });

  it('runtime.json com porta fora da faixa (pid vivo): sai com 1 sem enviar', async () => {
    const home = tempDir();
    const file = path.join(home, 'cenario.json');
    writeFileSync(file, JSON.stringify(scenario()));
    writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ port: 80, token: 'x'.repeat(43), pid: process.pid, version: '0.1.0', startedAt: Date.now() }));
    const io = quiet();
    assert.equal(await runInject({ argv: [file], env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, ...io }), 1);
    assert.match(io.err.join('\n'), /fora de 1024 a 65535/);
  });

  it('com o servidor real: envia tudo pelo POST /hooks, com o token, e sai com 0', async () => {
    const home = tempDir();
    const server = await startServer({ argv: ['--port', '0'], env: { AGENT_QUEST_HOME: home }, homedir: home, logError: () => {} });
    try {
      const file = path.join(home, 'cenario.json');
      writeFileSync(file, JSON.stringify(scenario()));
      const io = quiet();
      const code = await runInject({ argv: [file, '--fast'], env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, ...io });
      assert.equal(code, 0, io.err.join('\n'));
      assert.match(io.out.join('\n'), /5 eventos aceitos/);
      const health = await (await fetch(`http://127.0.0.1:${server.port}/api/health`)).json();
      assert.equal(health.events.accepted, 5);
      assert.equal(health.events.rejected, 0);
    } finally {
      await server.close();
    }
  });
});
