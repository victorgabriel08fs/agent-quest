// Integração do T2 (tester): ciclo de vida do servidor como processo real.
//
// Cobre: porta (prioridade, 0 com porta real no runtime.json, faixas inválidas em
// cada fonte), diretório de dados (AGENT_QUEST_HOME, %LOCALAPPDATA%, fallback pela
// pasta pessoal, aviso do OneDrive), runtime.json (gravação atômica observada no
// disco, campos, sobra de pid morto ou arquivo corrompido), instância única e
// porta ocupada com `npm start` de verdade, e logs sem corpo de requisição.
//
// Nunca usa o diretório de dados real nem a porta 47821: todo processo recebe um
// diretório temporário e `--port 0` ou uma porta livre sorteada.

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
  REPO,
  freePort,
  killPid,
  killTree,
  launchNpm,
  launchServer,
  minimalEnv,
  rawRequest,
  request,
  tempDir,
  waitFor,
} from './server-helpers.js';

const VERSION = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const RUNTIME_KEYS = ['port', 'token', 'pid', 'version', 'startedAt'];

const temps = [];
const children = [];
const servers = [];

function home(prefix = 'aq-int-life-') {
  const tmp = tempDir(prefix);
  temps.push(tmp);
  return tmp.dir;
}

function readRuntime(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
}

/** Inicia `node server/main.js` e espera a última linha do início ("Ctrl+C para parar."). */
async function startServer(args, env, options = {}) {
  const run = launchServer(args, env, { ready: /Ctrl\+C para parar\./, ...options });
  children.push(run.child);
  await run.started;
  return run;
}

async function startNpm(args, env, options) {
  const run = launchNpm(args, env, options);
  children.push(run.child);
  await run.started;
  return run;
}

/**
 * Outro programa (não Agent Quest) escutando numa porta livre de 127.0.0.1.
 * Sem `handler`, é um TCP mudo: aceita e nunca responde. Os sockets são
 * guardados para o encerramento (um socket que ninguém lê não percebe o fim da
 * conexão, e o `close()` do servidor esperaria para sempre).
 */
async function otherProgram(handler) {
  const sockets = new Set();
  const server = handler
    ? http.createServer(handler)
    : net.createServer((socket) => {
        socket.on('error', () => {});
        socket.resume();
      });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, sockets });
  return server;
}

afterEach(async () => {
  while (children.length) await killTree(children.pop());
  while (servers.length) {
    const { server, sockets } = servers.pop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

after(() => {
  for (const tmp of temps) tmp.cleanup();
});

describe('porta', () => {
  it('--port 0, AGENT_QUEST_PORT=0 e config.json {"port":0}: runtime.json grava a porta real', { timeout: 60_000 }, async () => {
    const cases = [
      { label: '--port 0', args: ['--port', '0'], extra: {} },
      { label: 'AGENT_QUEST_PORT=0', args: [], extra: { AGENT_QUEST_PORT: '0' } },
      { label: 'config.json port 0', args: [], extra: {}, config: { port: 0 } },
    ];
    for (const c of cases) {
      const dir = home();
      if (c.config) writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c.config));
      const run = await startServer(c.args, minimalEnv({ AGENT_QUEST_HOME: dir, ...c.extra }));
      const runtime = readRuntime(dir);
      assert.ok(Number.isInteger(runtime.port) && runtime.port >= 1024 && runtime.port <= 65535, `${c.label}: ${runtime.port}`);
      assert.notEqual(runtime.port, 47821, c.label);
      assert.match(run.output(), new RegExp(`rodando em http://127\\.0\\.0\\.1:${runtime.port}/`), c.label);
      assert.equal((await request(runtime.port, { path: '/api/health' })).status, 200, c.label);
      await killTree(run.child);
    }
  });

  it('prioridade: --port, depois AGENT_QUEST_PORT, depois config.json', { timeout: 60_000 }, async () => {
    const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
    const dir = home();
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: p3 }));

    let run = await startServer(['--port', String(p1)], minimalEnv({ AGENT_QUEST_HOME: dir, AGENT_QUEST_PORT: String(p2) }));
    assert.match(run.output(), new RegExp(`http://127\\.0\\.0\\.1:${p1}/`));
    assert.equal(readRuntime(dir).port, p1);
    await killTree(run.child);

    run = await startServer([], minimalEnv({ AGENT_QUEST_HOME: dir, AGENT_QUEST_PORT: String(p2) }));
    assert.match(run.output(), new RegExp(`http://127\\.0\\.0\\.1:${p2}/`));
    assert.equal(readRuntime(dir).port, p2);
    await killTree(run.child);

    run = await startServer([], minimalEnv({ AGENT_QUEST_HOME: dir }));
    assert.match(run.output(), new RegExp(`http://127\\.0\\.0\\.1:${p3}/`));
    assert.equal(readRuntime(dir).port, p3);
  });

  it('de 1 a 1023, acima de 65535 ou não inteiro: erro claro, saída 1, sem escutar nem gravar runtime.json', { timeout: 120_000 }, async () => {
    const cases = [
      ...['1', '80', '1023', '65536', '99999', 'abc', '4000.5', '-1', '0x1F90', '1e4', ''].map((v) => ({
        source: '--port',
        args: [`--port=${v}`],
      })),
      ...['1', '1023', '70000', 'x', '47.5'].map((v) => ({ source: 'AGENT_QUEST_PORT', args: [], extra: { AGENT_QUEST_PORT: v } })),
      ...[1, 1023, 65536, 47.5, '80', true, -5, null].map((v) => ({ source: 'config.json', args: [], config: { port: v } })),
    ];
    for (const c of cases) {
      const dir = home();
      if (c.config) writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c.config));
      const run = launchServer(c.args, minimalEnv({ AGENT_QUEST_HOME: dir, ...(c.extra ?? {}) }), { ready: /$^/ });
      children.push(run.child);
      const code = await run.exit;
      const label = `${c.source} ${JSON.stringify(c.args)} ${JSON.stringify(c.extra ?? c.config)}`;
      assert.equal(code, 1, `${label}\n${run.output()}`);
      assert.match(run.output(), /Porta inválida em/, label);
      assert.ok(run.output().includes(c.source), `${label}: a mensagem deveria citar a fonte\n${run.output()}`);
      assert.match(run.output(), /1024 a 65535/, label);
      assert.doesNotMatch(run.output(), /rodando em|\n\s+at |Error:/, `${label}: sem stack trace\n${run.output()}`);
      assert.equal(existsSync(path.join(dir, 'runtime.json')), false, label);
    }
  });
});

describe('diretório de dados', () => {
  it('sem AGENT_QUEST_HOME: %LOCALAPPDATA%\\agent-quest (LOCALAPPDATA temporário)', { timeout: 30_000 }, async () => {
    const fakeLocal = home('aq-int-localappdata-');
    const run = await startServer(['--port', '0'], minimalEnv({ LOCALAPPDATA: fakeLocal, USERPROFILE: fakeLocal }));
    const expected = path.join(fakeLocal, 'agent-quest');
    assert.ok(existsSync(path.join(expected, 'runtime.json')), run.output());
    assert.equal(readRuntime(expected).pid, run.child.pid);
    assert.ok(run.output().includes(`Diretório de dados: ${expected}`), run.output());
  });

  it('sem AGENT_QUEST_HOME nem LOCALAPPDATA: <pasta pessoal>\\AppData\\Local\\agent-quest (USERPROFILE temporário)', { skip: process.platform !== 'win32' && 'só no Windows', timeout: 30_000 }, async () => {
    const fakeHome = home('aq-int-userprofile-');
    const run = await startServer(['--port', '0'], minimalEnv({ USERPROFILE: fakeHome, HOME: fakeHome }));
    const expected = path.join(fakeHome, 'AppData', 'Local', 'agent-quest');
    assert.ok(existsSync(path.join(expected, 'runtime.json')), run.output());
  });

  it('AGENT_QUEST_HOME inexistente, aninhado, com espaço e acento: é criado', { timeout: 30_000 }, async () => {
    const dir = path.join(home(), 'pasta com espaço', 'configuração', 'aq');
    const run = await startServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
    assert.equal(readRuntime(dir).pid, run.child.pid);
  });

  it('aviso do OneDrive: pela variável OneDrive e por pasta "OneDrive - Empresa"; sem aviso fora dele', { timeout: 60_000 }, async () => {
    const base = home();
    const byVar = await startServer(
      ['--port', '0'],
      minimalEnv({ AGENT_QUEST_HOME: path.join(base, 'Nuvem', 'aq'), OneDrive: path.join(base, 'Nuvem') }),
    );
    assert.match(byVar.output(), /OneDrive/);
    assert.match(byVar.output(), /AGENT_QUEST_HOME/);
    await killTree(byVar.child);

    const byFolder = await startServer(
      ['--port', '0'],
      minimalEnv({ LOCALAPPDATA: path.join(base, 'OneDrive - Empresa X'), USERPROFILE: base }),
    );
    assert.match(byFolder.output(), /OneDrive/);
    await killTree(byFolder.child);

    const clean = await startServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: path.join(base, 'limpo') }));
    assert.doesNotMatch(clean.output(), /OneDrive/);
  });

  it('diretório de dados impossível de criar: mensagem clara e saída 1', { timeout: 30_000 }, async () => {
    const file = path.join(home(), 'sou-um-arquivo');
    writeFileSync(file, 'x');
    const run = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: path.join(file, 'aq') }), { ready: /$^/ });
    children.push(run.child);
    assert.equal(await run.exit, 1, run.output());
    assert.match(run.output(), /runtime\.json/);
    assert.doesNotMatch(run.output(), /\n\s+at /, 'sem stack trace');
  });
});

describe('runtime.json', () => {
  it('gravado de forma atômica: temporário na mesma pasta e depois renomeado, sem sobra', { timeout: 30_000 }, async () => {
    const dir = home();
    const names = [];
    const watcher = watch(dir, (event, filename) => names.push(`${event}:${filename}`));
    try {
      const before = Date.now();
      const run = await startServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
      await waitFor(() => names.some((n) => n.endsWith(':runtime.json')), { label: 'evento do runtime.json' });
      const tmpEvents = names.filter((n) => /:runtime\.json\.\d+\.[0-9a-f]{8}\.tmp$/.test(n));
      assert.ok(tmpEvents.length > 0, `nenhum arquivo temporário observado: ${names.join(', ')}`);
      const tmpPid = Number(tmpEvents[0].split('.')[2]);
      assert.equal(tmpPid, run.child.pid, 'o temporário leva o pid do servidor');
      const firstTmp = names.findIndex((n) => /\.tmp$/.test(n));
      const lastFinal = names.findLastIndex((n) => n.endsWith(':runtime.json'));
      assert.ok(firstTmp < lastFinal, `ordem inesperada: ${names.join(', ')}`);
      assert.deepEqual(readdirSync(dir), ['runtime.json'], 'sobrou arquivo temporário');

      const text = readFileSync(path.join(dir, 'runtime.json'), 'utf8');
      const runtime = JSON.parse(text);
      assert.deepEqual(Object.keys(runtime), RUNTIME_KEYS);
      assert.match(runtime.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(runtime.token, 'base64url').length, 32);
      assert.equal(runtime.pid, run.child.pid);
      assert.equal(runtime.version, VERSION);
      assert.ok(runtime.startedAt >= before && runtime.startedAt <= Date.now());
      const health = JSON.parse((await request(runtime.port, { path: '/api/health' })).text);
      assert.equal(health.startedAt, runtime.startedAt);
      assert.equal(health.version, runtime.version);
    } finally {
      watcher.close();
    }
  });

  it('cada início gera um token novo', { timeout: 30_000 }, async () => {
    const dir = home();
    const tokens = new Set();
    for (let i = 0; i < 3; i++) {
      const run = await startServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
      tokens.add(readRuntime(dir).token);
      await killTree(run.child);
    }
    assert.equal(tokens.size, 3);
  });

  it('sobra de pid morto, arquivo corrompido ou vazio: substituído', { timeout: 60_000 }, async () => {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => dead.once('exit', resolve));
    const leftovers = [
      JSON.stringify({ port: 50999, token: 'velho', pid: dead.pid, version: '0.0.1', startedAt: 1 }),
      '{"port": 50999, "tok',
      '',
      'lixo',
    ];
    for (const content of leftovers) {
      const dir = home();
      writeFileSync(path.join(dir, 'runtime.json'), content);
      const run = await startServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
      assert.match(run.output(), /rodando em/, `${JSON.stringify(content)}\n${run.output()}`);
      const runtime = readRuntime(dir);
      assert.equal(runtime.pid, run.child.pid);
      assert.notEqual(runtime.token, 'velho');
      await killTree(run.child);
    }
  });

  it('sobra apontando para pid vivo que não é Agent Quest (porta com outro HTTP): substituída', { timeout: 30_000 }, async () => {
    const other = await otherProgram((req, res) => res.end('{"ok":true}'));
    const dir = home();
    writeFileSync(
      path.join(dir, 'runtime.json'),
      JSON.stringify({ port: other.address().port, token: 'velho', pid: process.pid, version: '0.0.1', startedAt: 1 }),
    );
    const run = await startServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
    assert.match(run.output(), /rodando em/, run.output());
    assert.equal(readRuntime(dir).pid, run.child.pid);
  });
});

describe('instância única e porta ocupada (npm start de verdade)', () => {
  it('segundo npm start com o primeiro rodando: "já está rodando em <url do primeiro>" e saída 0', { timeout: 60_000 }, async () => {
    const dir = home();
    const env = minimalEnv({ AGENT_QUEST_HOME: dir });
    const first = await startNpm(['start', '--', '--port', '0'], env);
    const firstUrl = first.output().match(/http:\/\/127\.0\.0\.1:\d+\//)[0];
    const before = readFileSync(path.join(dir, 'runtime.json'), 'utf8');

    const second = launchNpm(['start', '--', '--port', '0'], env, { ready: /$^/ });
    children.push(second.child);
    assert.equal(await second.exit, 0, second.output());
    assert.ok(second.output().includes(`já está rodando em ${firstUrl}`), second.output());
    assert.equal(readFileSync(path.join(dir, 'runtime.json'), 'utf8'), before, 'o runtime.json do primeiro não pode mudar');
    assert.equal((await request(Number(firstUrl.split(':')[2].replace('/', '')), { path: '/api/health' })).status, 200);
  });

  it('mesma porta fixa, outro diretório de dados: "já está rodando" e saída 0', { timeout: 60_000 }, async () => {
    const port = await freePort();
    const first = await startServer(['--port', String(port)], minimalEnv({ AGENT_QUEST_HOME: home() }));
    assert.match(first.output(), /rodando em/);
    const second = launchServer(['--port', String(port)], minimalEnv({ AGENT_QUEST_HOME: home() }), { ready: /$^/ });
    children.push(second.child);
    assert.equal(await second.exit, 0, second.output());
    assert.match(second.output(), new RegExp(`já está rodando em http://127\\.0\\.0\\.1:${port}/`));
  });

  it('porta ocupada por outro programa (HTTP ou TCP mudo): mensagem clara e saída 1 no npm start', { timeout: 60_000 }, async () => {
    for (const other of [await otherProgram((req, res) => res.end('oi')), await otherProgram()]) {
      const port = other.address().port;
      const dir = home();
      const run = launchNpm(['start', '--', '--port', String(port)], minimalEnv({ AGENT_QUEST_HOME: dir }), { ready: /$^/ });
      children.push(run.child);
      assert.equal(await run.exit, 1, run.output());
      assert.ok(run.output().includes(`A porta ${port} já está em uso por outro programa`), run.output());
      assert.match(run.output(), /--port/);
      assert.equal(existsSync(path.join(dir, 'runtime.json')), false);
    }
  });
});

describe('logs', () => {
  it('nunca mostram corpo, caminho, query nem cabeçalhos das requisições, nem com erros do parser', { timeout: 30_000 }, async () => {
    const dir = home();
    const run = await startServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
    const { port } = readRuntime(dir);
    const marker = 'MARCADOR-SECRETO-7c1e';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${marker}`,
      Cookie: `s=${marker}`,
      'X-Agent-Quest-Token': marker,
      'User-Agent': marker,
      Referer: `http://127.0.0.1:${port}/${marker}`,
    };
    const body = JSON.stringify({ v: 1, payload: { session_id: marker, hook_event_name: marker, prompt: marker } });
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
      for (const p of ['/', '/api/health', '/hooks', `/${marker}.js`, `/api/${marker}`, `/?q=${marker}`, `/..%5c${marker}`, `/%${marker}`]) {
        await request(port, { method, path: p, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
      }
    }
    await request(port, { path: '/', headers: { Host: `${marker}.example`, Origin: `http://${marker}` } });
    await rawRequest(port, `${marker} / HTTP/1.1\r\n\r\n`);
    await rawRequest(port, `GET /${marker} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Bad: a\u0000${marker}\r\n\r\n`);
    await rawRequest(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Big: ${marker}${'A'.repeat(20000)}\r\n\r\n`);
    await rawRequest(
      port,
      `POST /hooks HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await request(port, { path: '/api/health' })).status, 200, 'o servidor segue no ar');

    const output = run.output();
    assert.doesNotMatch(output, new RegExp(marker));
    const lines = output.split(/\r?\n/).filter(Boolean);
    const allowed = [
      /^Agent Quest \S+ rodando em http:\/\/127\.0\.0\.1:\d+\/$/,
      /^Diretório de dados: /,
      /^Ctrl\+C para parar\.$/,
      // Aviso do início com AGENT_QUEST_HOME definida (ADR 0005, complemento; ajuste do T2).
      /^Aviso: AGENT_QUEST_HOME está definida \(/,
    ];
    for (const line of lines) {
      assert.ok(allowed.some((re) => re.test(line)), `linha de log inesperada: ${line}`);
    }
  });
});
