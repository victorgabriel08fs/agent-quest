// Integração do T2 (tester): Ctrl+C emulado num console real do Windows.
//
// O ambiente dos agentes não tem console interativo. O plano aceita, no T2, a
// evidência por emulação: o ajudante console-ctrl-c.ps1 inicia o comando num
// console novo, sem janela, e manda CTRL_C_EVENT com GenerateConsoleCtrlEvent,
// o mesmo evento que o console gera quando se aperta Ctrl+C. O Ctrl+C de verdade
// é conferido pelo usuário no marco "Primeira luz".
//
// Critérios cobertos:
// - `npm start` (no PowerShell e direto): Ctrl+C apaga o runtime.json e o
//   servidor sai com 0;
// - `npm run dev`: a sobra do runtime.json (exceção aceita, bug B1) é inofensiva:
//   o encaminhador sai sem enviar nada, e o próximo `npm start` ou `npm run dev`
//   a substitui sem dizer "já está rodando".
//
// Diretório de dados temporário e porta livre sorteada (nunca a 47821).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
  REPO,
  freePort,
  killTree,
  launchNpm,
  npmCli,
  npmEnv,
  tempDir,
  waitFor,
} from './server-helpers.js';

const HELPER = path.join(REPO, 'test', 'integration', 'console-ctrl-c.ps1');
const FORWARDER = path.join(REPO, 'capture', 'plugins', 'agent-quest', 'scripts', 'forward.mjs');
const isWindows = process.platform === 'win32';

const temps = [];
function home(prefix = 'aq-int-ctrlc-') {
  const tmp = tempDir(prefix);
  temps.push(tmp);
  return tmp.dir;
}

after(() => {
  for (const tmp of temps) tmp.cleanup();
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Ambiente do console emulado: o do processo, com dados e cache do npm temporários. */
function consoleEnv(dataDir) {
  const env = { ...process.env, ...npmEnv(), AGENT_QUEST_HOME: dataDir };
  delete env.AGENT_QUEST_PORT;
  return env;
}

/** Roda o ajudante e devolve o resultado, com a tela já decodificada. */
function emulateCtrlC(commandLine, dataDir) {
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      HELPER,
      '-CommandLine',
      commandLine,
      '-WorkDir',
      REPO,
      '-RuntimeFile',
      path.join(dataDir, 'runtime.json'),
    ],
    { env: consoleEnv(dataDir), encoding: 'utf8', windowsHide: true, timeout: 90_000 },
  );
  const line = (res.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  let result;
  try {
    result = JSON.parse(line);
  } catch {
    throw new Error(`o ajudante não devolveu JSON:\n${res.stdout}\n${res.stderr}`);
  }
  result.screen = Buffer.from(result.screen ?? '', 'base64').toString('utf8');
  return result;
}

const quote = (p) => `"${p}"`;

describe('T2 integração: Ctrl+C emulado no console', { skip: !isWindows && 'Ctrl+C de console só existe no Windows' }, () => {
  it('npm start no PowerShell: Ctrl+C apaga o runtime.json e o servidor sai com 0', { timeout: 120_000 }, () => {
    const dataDir = home();
    const r = emulateCtrlC('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "npm start -- --port 0"', dataDir);
    assert.equal(r.ok, true, `${r.error}\n${r.screen}`);
    assert.equal(r.ctrlC, 'ok');
    assert.notEqual(r.port, 47821);
    assert.match(r.screen, /Encerrando o Agent Quest\.\.\./, r.screen);
    assert.notEqual(r.removedMs, null, `o runtime.json ficou para trás:\n${r.screen}`);
    assert.equal(existsSync(path.join(dataDir, 'runtime.json')), false);
    assert.equal(r.serverExitCode, 0, r.screen);
  });

  it('npm start direto no console: Ctrl+C apaga o runtime.json e o servidor sai com 0', { timeout: 120_000 }, () => {
    const dataDir = home();
    const r = emulateCtrlC(`${quote(process.execPath)} ${quote(npmCli())} start -- --port 0`, dataDir);
    assert.equal(r.ok, true, `${r.error}\n${r.screen}`);
    assert.match(r.screen, /Encerrando o Agent Quest\.\.\./, r.screen);
    assert.notEqual(r.removedMs, null, `o runtime.json ficou para trás:\n${r.screen}`);
    assert.equal(r.serverExitCode, 0, r.screen);
  });

  it('npm run dev: a sobra do runtime.json é inofensiva (encaminhador e próximo início)', { timeout: 180_000 }, async (t) => {
    assert.ok(existsSync(FORWARDER), `encaminhador não encontrado: ${FORWARDER}`);
    const dataDir = home();
    const runtimeFile = path.join(dataDir, 'runtime.json');
    const port = await freePort();

    // 1. Ctrl+C no npm run dev.
    const r = emulateCtrlC(`${quote(process.execPath)} ${quote(npmCli())} run dev -- --port ${port}`, dataDir);
    assert.equal(r.ok, true, `${r.error}\n${r.screen}`);
    assert.equal(r.port, port);
    await waitFor(() => !isAlive(r.serverPid), { timeoutMs: 10_000, label: 'fim do servidor' });

    // 2. A sobra, se ficou, aponta para o servidor que já morreu. Se não ficou,
    //    o teste recria exatamente o que teria ficado, para cobrir o caso.
    if (existsSync(runtimeFile)) {
      t.diagnostic(`sobra observada: runtime.json com o pid ${r.serverPid}, que já terminou`);
    } else {
      t.diagnostic('desta vez o runtime.json foi apagado; recriando a sobra para testar o resto');
      writeFileSync(runtimeFile, JSON.stringify({ port, token: 'x'.repeat(43), pid: r.serverPid, version: '0.0.0', startedAt: 1 }));
    }
    const stale = JSON.parse(readFileSync(runtimeFile, 'utf8'));
    assert.equal(stale.pid, r.serverPid);
    assert.equal(stale.port, port);
    assert.equal(isAlive(stale.pid), false);

    // 3. O encaminhador sai com 0, em silêncio e sem tentar a porta da sobra.
    const connections = [];
    const listener = net.createServer((socket) => {
      connections.push(socket);
      socket.destroy();
    });
    await waitFor(
      () =>
        new Promise((resolve) => {
          listener.once('error', () => resolve(false));
          listener.listen(port, '127.0.0.1', () => resolve(true));
        }),
      { timeoutMs: 5_000, label: `escutar na porta da sobra (${port})` },
    );
    const runForwarder = () =>
      new Promise((resolve) => {
        const begin = Date.now();
        const child = spawn(process.execPath, [FORWARDER], {
          env: { ...process.env, AGENT_QUEST_HOME: dataDir, CLAUDE_PROJECT_DIR: REPO },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('exit', (code) => resolve({ code, out, ms: Date.now() - begin }));
        child.stdin.end(JSON.stringify({ session_id: 'sessao-teste', hook_event_name: 'Stop', cwd: REPO }));
      });
    const staleText = readFileSync(runtimeFile, 'utf8');
    try {
      const fwd = await runForwarder();
      t.diagnostic(`encaminhador com a sobra: código ${fwd.code}, ${fwd.ms} ms`);
      assert.equal(fwd.code, 0);
      assert.equal(fwd.out, '');
      assert.ok(fwd.ms < 2_000, `${fwd.ms} ms`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(connections.length, 0, 'o encaminhador não pode tentar a porta da sobra');

      // Controle: o mesmo arquivo com um pid vivo faz o encaminhador tentar a
      // porta. Prova que ele leu este diretório e que foi o pid morto que o parou.
      writeFileSync(runtimeFile, JSON.stringify({ ...stale, pid: process.pid }));
      const control = await runForwarder();
      assert.equal(control.code, 0);
      assert.equal(control.out, '');
      await waitFor(() => connections.length > 0, { timeoutMs: 3_000, label: 'conexão do encaminhador no controle' });
    } finally {
      writeFileSync(runtimeFile, staleText);
      await new Promise((resolve) => listener.close(resolve));
    }

    // 4. O próximo npm start substitui a sobra sem "já está rodando".
    const env = { AGENT_QUEST_HOME: dataDir, PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const start = launchNpm(['start', '--', '--port', String(port)], env, { ready: /Ctrl\+C para parar\./ });
    try {
      assert.equal(await start.started, true, start.output());
      assert.doesNotMatch(start.output(), /já está rodando/);
      assert.match(start.output(), new RegExp(`rodando em http://127\\.0\\.0\\.1:${port}/`));
      const fresh = JSON.parse(readFileSync(runtimeFile, 'utf8'));
      assert.notEqual(fresh.pid, stale.pid);
      assert.notEqual(fresh.token, stale.token);
      assert.equal(fresh.port, port);
    } finally {
      await killTree(start.child); // encerramento à força: deixa outra sobra, como um travamento
    }

    // 5. E o próximo npm run dev também a substitui sem "já está rodando".
    const leftover = JSON.parse(readFileSync(runtimeFile, 'utf8'));
    assert.equal(isAlive(leftover.pid), false);
    const dev = launchNpm(['run', 'dev', '--', '--port', String(port)], env, { ready: /Ctrl\+C para parar\./ });
    try {
      assert.equal(await dev.started, true, dev.output());
      assert.doesNotMatch(dev.output(), /já está rodando/);
      const fresh = JSON.parse(readFileSync(runtimeFile, 'utf8'));
      assert.notEqual(fresh.pid, leftover.pid);
      assert.equal(fresh.port, port);
    } finally {
      await killTree(dev.child);
    }
  });
});
