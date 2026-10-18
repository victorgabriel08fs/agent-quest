// startServer no mesmo processo e `node server/main.js` como processo filho.
// Sempre com AGENT_QUEST_HOME temporário e porta 0 (ADR 0010).

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { StartupError, VERSION } from '../../../server/config.js';
import { installShutdownHandlers, isAgentQuestAt, startServer } from '../../../server/main.js';
import { createToken, readRuntimeFile, runtimeFilePath, writeRuntimeFile } from '../../../server/runtime-file.js';
import { deadPid, isolatedEnv, killChild, request, spawnServer, tempDir } from './helpers.js';

const temps = [];
const running = [];

function newHome() {
  const tmp = tempDir();
  temps.push(tmp);
  return tmp.dir;
}

/** startServer com diretório temporário e porta livre, a menos que `argv` diga outra porta. */
async function start(home, argv = ['--port', '0'], extraEnv = {}) {
  const result = await startServer({ argv, env: { AGENT_QUEST_HOME: home, ...extraEnv }, logError: () => {} });
  if (result.status === 'started') running.push(result);
  return result;
}

/** Outro programa escutando em 127.0.0.1, numa porta livre. */
async function otherProgram(handler) {
  const server = handler ? http.createServer(handler) : net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

afterEach(async () => {
  while (running.length) await running.pop().close();
});

after(() => {
  for (const tmp of temps) tmp.cleanup();
});

describe('startServer', () => {
  it('escuta só em 127.0.0.1, na porta pedida, e informa a URL', async () => {
    const result = await start(newHome());
    assert.equal(result.status, 'started');
    const address = result.server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.equal(address.family, 'IPv4');
    assert.equal(address.port, result.port);
    assert.notEqual(result.port, 47821);
    assert.equal(result.url, `http://127.0.0.1:${result.port}/`);
    assert.equal((await request(result.port, { path: '/api/health' })).status, 200);
  });

  it('grava o runtime.json com port, token, pid, version e startedAt', async () => {
    const home = newHome();
    const before = Date.now();
    const result = await start(home);
    const runtime = readRuntimeFile(home);
    assert.deepEqual(runtime, result.runtime);
    assert.equal(runtime.port, result.port);
    assert.match(runtime.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(runtime.pid, process.pid);
    assert.equal(runtime.version, VERSION);
    assert.ok(runtime.startedAt >= before && runtime.startedAt <= Date.now());
    const health = JSON.parse((await request(result.port, { path: '/api/health' })).body);
    assert.equal(health.startedAt, runtime.startedAt);
  });

  it('close() apaga o runtime.json e para de escutar; chamar de novo não falha', async () => {
    const home = newHome();
    const result = await start(home);
    await result.close();
    assert.equal(existsSync(runtimeFilePath(home)), false);
    assert.equal(result.server.listening, false);
    await result.close();
    await assert.rejects(request(result.port, { path: '/api/health' }));
  });

  it('close() fecha também conexões keep-alive abertas', async () => {
    const result = await start(newHome());
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: result.port, path: '/api/health', agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
    await result.close(); // ficaria preso se a conexão ociosa não fosse fechada
    agent.destroy();
  });

  it('close() não apaga um runtime.json que já é de outra execução', async () => {
    const home = newHome();
    const result = await start(home);
    const other = { ...result.runtime, pid: process.pid + 1, token: createToken() };
    await writeRuntimeFile(home, other);
    await result.close();
    assert.deepEqual(readRuntimeFile(home), other);
  });

  it('segunda instância com a primeira rodando: "já está rodando" com a URL da primeira', async () => {
    const home = newHome();
    const first = await start(home);
    const second = await start(home);
    assert.deepEqual(second, { status: 'already-running', url: first.url });
    assert.deepEqual(readRuntimeFile(home), first.runtime);
  });

  it('porta ocupada por outro Agent Quest (outro diretório de dados): "já está rodando"', async () => {
    const first = await start(newHome());
    const second = await start(newHome(), ['--port', String(first.port)]);
    assert.deepEqual(second, { status: 'already-running', url: first.url });
  });

  it('porta ocupada por outro programa: StartupError com mensagem clara', async () => {
    const answers = await otherProgram((req, res) => res.end('{"ok":true}'));
    const silent = await otherProgram();
    try {
      for (const server of [answers, silent]) {
        const port = server.address().port;
        await assert.rejects(
          start(newHome(), ['--port', String(port)]),
          (err) => err instanceof StartupError && err.message.includes(`porta ${port}`) && err.message.includes('--port'),
        );
      }
    } finally {
      answers.close();
      silent.close();
    }
  });

  it('a mensagem de porta ocupada sugere o comando do modo em uso (npm_lifecycle_event)', async () => {
    const busy = await otherProgram((req, res) => res.end('oi'));
    const port = String(busy.address().port);
    const cases = [
      [{ npm_lifecycle_event: 'dev' }, 'npm run dev -- --port <número>'],
      [{ npm_lifecycle_event: 'start' }, 'npm start -- --port <número>'],
      [{}, 'node server/main.js --port <número>'],
    ];
    try {
      for (const [extraEnv, command] of cases) {
        await assert.rejects(start(newHome(), ['--port', port], extraEnv), (err) => {
          assert.ok(err instanceof StartupError);
          assert.ok(err.message.includes(`Escolha outra porta: ${command}`), err.message);
          return true;
        });
      }
    } finally {
      busy.close();
    }
  });

  it('runtime.json de pid morto é sobra e é substituído', async () => {
    const home = newHome();
    const stale = { port: 50999, token: createToken(), pid: await deadPid(), version: '0.0.1', startedAt: 1 };
    await writeRuntimeFile(home, stale);
    const result = await start(home);
    assert.equal(result.status, 'started');
    const runtime = readRuntimeFile(home);
    assert.equal(runtime.pid, process.pid);
    assert.notEqual(runtime.token, stale.token);
  });

  it('runtime.json de pid vivo sem Agent Quest na porta também é sobra', async () => {
    const home = newHome();
    const closed = await otherProgram();
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    await writeRuntimeFile(home, { port, token: createToken(), pid: process.pid, version: '0.0.1', startedAt: 1 });
    const result = await start(home);
    assert.equal(result.status, 'started');
    assert.equal(readRuntimeFile(home).port, result.port);
  });

  it('avisa quando o diretório de dados está no OneDrive', async () => {
    const home = path.join(newHome(), 'OneDrive', 'agent-quest');
    const result = await start(home);
    assert.ok(result.warnings.some((w) => w.includes('está dentro do OneDrive')), result.warnings.join('\n'));
  });

  it('configuração inválida: StartupError antes de escutar', async () => {
    await assert.rejects(start(newHome(), ['--port', 'abc']), StartupError);
    await assert.rejects(start(newHome(), ['--desconhecida']), StartupError);
  });
});

describe('ingestão com o servidor completo (T3)', () => {
  /** POST /hooks com o token indicado. */
  function postHook(port, token, envelope) {
    return request(port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': token },
      body: JSON.stringify(envelope),
    });
  }

  const envelope = (n) => ({
    v: 1,
    sentAt: 1_760_000_000_000 + n,
    forwarder: '0.1.0',
    env: { projectDir: '<repo>', entrypoint: null },
    truncated: false,
    payload: { hook_event_name: 'PreToolUse', session_id: 'sessao-teste', tool_use_id: `toolu_${n}` },
  });

  it('POST /hooks aceita o token do runtime.json desta execução e recusa outro', async () => {
    const home = newHome();
    const result = await start(home);
    const { token } = readRuntimeFile(home);
    assert.equal((await postHook(result.port, token, envelope(1))).status, 204);
    assert.equal((await postHook(result.port, createToken(), envelope(2))).status, 401);
    const health = JSON.parse((await request(result.port, { path: '/api/health' })).body);
    assert.equal(health.events.received, 2);
    assert.equal(health.events.accepted, 1);
    assert.equal(health.events.rejected, 1);
    assert.equal(typeof health.lastEventAt, 'number');
  });

  it('sem --debug-dump, a pasta dumps nem é criada', async () => {
    const home = newHome();
    const result = await start(home);
    assert.equal((await postHook(result.port, result.runtime.token, envelope(1))).status, 204);
    await result.close();
    assert.equal(existsSync(path.join(home, 'dumps')), false);
    assert.ok(!result.warnings.some((w) => w.includes('debug-dump')));
  });

  it('com --debug-dump, os envelopes aceitos vão para <dados>/dumps/AAAA-MM-DD.jsonl, com aviso', async () => {
    const home = newHome();
    const result = await start(home, ['--port', '0', '--debug-dump']);
    assert.ok(
      result.warnings.some((w) => w.includes(path.join(home, 'dumps')) && /dados sensíveis/.test(w)),
      result.warnings.join('\n'),
    );
    const sent = [envelope(1), envelope(2)];
    for (const env of sent) assert.equal((await postHook(result.port, result.runtime.token, env)).status, 204);
    assert.equal((await postHook(result.port, result.runtime.token, sent[0])).status, 204, 'duplicata');
    assert.equal((await postHook(result.port, 'errado', envelope(3))).status, 401);
    await result.close();

    const files = readdirSync(path.join(home, 'dumps'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = readFileSync(path.join(home, 'dumps', files[0]), 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((line) => JSON.parse(line)), sent);
  });
});

describe('isAgentQuestAt', () => {
  it('reconhece um Agent Quest e recusa o resto (inclusive quem não responde)', async () => {
    const aq = await start(newHome());
    const other = await otherProgram((req, res) => res.end('oi'));
    const silent = await otherProgram();
    try {
      assert.equal(await isAgentQuestAt(aq.port), true);
      assert.equal(await isAgentQuestAt(other.address().port), false);
      const begin = Date.now();
      assert.equal(await isAgentQuestAt(silent.address().port, 200), false);
      assert.ok(Date.now() - begin < 2000);
    } finally {
      other.close();
      silent.close();
    }
  });
});

describe('installShutdownHandlers', () => {
  function fakeProcess() {
    const proc = new EventEmitter();
    proc.exitCodes = [];
    proc.exit = (code) => proc.exitCodes.push(code);
    return proc;
  }

  it('Ctrl+C (SIGINT) chama close() e sai com 0; o runtime.json some', async () => {
    const home = newHome();
    const result = await start(home);
    const proc = fakeProcess();
    installShutdownHandlers(result.close, { proc, log: () => {} });
    proc.emit('SIGINT');
    await result.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(existsSync(runtimeFilePath(home)), false);
    assert.deepEqual(proc.exitCodes, [0]);
  });

  it('escuta SIGINT, SIGTERM, SIGHUP e SIGBREAK; segundo sinal sai na hora com 1', async () => {
    const proc = fakeProcess();
    let calls = 0;
    installShutdownHandlers(() => {
      calls++;
      return new Promise(() => {}); // encerramento que não termina
    }, { proc, log: () => {} });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      assert.equal(proc.listenerCount(signal), 1, signal);
    }
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    assert.equal(calls, 1);
    assert.deepEqual(proc.exitCodes, [1]);
  });
});

describe('linha de comando (node server/main.js)', () => {
  const children = [];
  afterEach(async () => {
    while (children.length) await killChild(children.pop());
  });

  async function cli(args, home, extra) {
    const run = await spawnServer(args, isolatedEnv(home, extra));
    children.push(run.child);
    return run;
  }

  it('imprime http://127.0.0.1:<porta>/ e grava o runtime.json do processo', async () => {
    const home = newHome();
    const run = await cli(['--port', '0'], home);
    assert.match(run.output(), /rodando em http:\/\/127\.0\.0\.1:\d+\//);
    const runtime = readRuntimeFile(home);
    assert.equal(runtime.pid, run.child.pid);
    assert.equal(run.url, `http://127.0.0.1:${runtime.port}/`);
    assert.equal((await request(runtime.port, { path: '/api/health' })).status, 200);
  });

  it('com AGENT_QUEST_HOME definida, avisa no terminal que o Claude Code precisa da mesma variável', async () => {
    const home = newHome();
    const run = await cli(['--port', '0'], home);
    // O aviso sai no stderr e a URL no stdout: espera os dois chegarem.
    for (let i = 0; i < 40 && !/AGENT_QUEST_HOME está definida/.test(run.output()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(run.output(), /AGENT_QUEST_HOME está definida/);
    assert.ok(run.output().includes(home), run.output());
    assert.match(run.output(), /Claude Code tiver a mesma variável/);
  });

  it('segundo início com o primeiro rodando: "já está rodando em ..." e saída 0', async () => {
    const home = newHome();
    const first = await cli(['--port', '0'], home);
    const second = await cli(['--port', '0'], home);
    assert.equal(await second.exit, 0);
    assert.match(second.output(), /já está rodando em http:\/\/127\.0\.0\.1:\d+\//);
    assert.equal(second.url, first.url);
  });

  it('porta ocupada por outro programa: mensagem clara e saída 1', async () => {
    const busy = await otherProgram((req, res) => res.end('oi'));
    try {
      const port = busy.address().port;
      const run = await cli(['--port', String(port)], newHome());
      assert.equal(await run.exit, 1);
      assert.match(run.output(), new RegExp(`porta ${port} já está em uso por outro programa`));
      assert.equal(run.url, null);
    } finally {
      busy.close();
    }
  });

  it('porta inválida: mensagem clara e saída 1', async () => {
    const run = await cli(['--port', '80'], newHome());
    assert.equal(await run.exit, 1);
    assert.match(run.output(), /Porta inválida em --port/);
  });

  it('AGENT_QUEST_PORT vale quando não há --port', async () => {
    const free = await otherProgram();
    const port = free.address().port;
    await new Promise((resolve) => free.close(resolve));
    const run = await cli([], newHome(), { AGENT_QUEST_PORT: String(port) });
    assert.equal(run.url, `http://127.0.0.1:${port}/`);
  });

  it('avisa no terminal quando o diretório de dados está no OneDrive', async () => {
    const run = await cli(['--port', '0'], path.join(newHome(), 'OneDrive', 'aq'));
    // O aviso sai no stderr e a URL no stdout: espera os dois chegarem.
    for (let i = 0; i < 40 && !/está dentro do OneDrive/.test(run.output()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(run.output(), /está dentro do OneDrive/);
    assert.match(run.output(), /variável de ambiente do usuário do Windows/);
  });

  it('--debug-dump avisa no início que os arquivos têm dados sensíveis', async () => {
    const home = newHome();
    const run = await cli(['--port', '0', '--debug-dump'], home);
    assert.match(run.output(), /--debug-dump ligado/);
    assert.match(run.output(), /dados sensíveis/);
    assert.ok(run.output().includes(path.join(home, 'dumps')), run.output());
  });

  it('os logs nunca mostram o corpo das requisições', async () => {
    const home = newHome();
    const run = await cli(['--port', '0'], home);
    const { port } = readRuntimeFile(home);
    const marker = 'MARCADOR-SECRETO-9f3a';
    for (const target of ['/', '/api/health', '/hooks', '/../package.json']) {
      await request(port, { method: 'POST', path: target, body: marker, headers: { 'Content-Type': 'application/json' } });
    }
    await request(port, { path: `/?q=${marker}`, headers: { Host: 'evil.example' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(run.output(), new RegExp(marker));
    assert.ok(readFileSync(runtimeFilePath(home), 'utf8'));
  });
});
