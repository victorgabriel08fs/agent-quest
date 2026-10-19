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
import { pathToFileURL } from 'node:url';
import {
  REPO,
  killTree,
  launchNpm,
  minimalEnv,
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

/**
 * O critério é o arquivo sumir. O `removedMs` do ajudante só mede quando ele
 * notou a remoção, dentro da janela de espera; se veio null (por exemplo, o
 * próprio ajudante ficou sem CPU), quem decide é o disco, conferido aqui depois
 * de o ajudante terminar.
 */
function assertRuntimeRemoved(t, r, dataDir) {
  const leftover = existsSync(path.join(dataDir, 'runtime.json'));
  assert.equal(leftover, false, `o runtime.json ficou para trás:\n${r.screen}`);
  if (r.removedMs === null) t.diagnostic('o runtime.json sumiu depois da janela de espera do ajudante');
  else t.diagnostic(`runtime.json apagado ${r.removedMs} ms depois do Ctrl+C`);
}

describe('T2 integração: Ctrl+C emulado no console', { skip: !isWindows && 'Ctrl+C de console só existe no Windows' }, () => {
  it('npm start no PowerShell: Ctrl+C apaga o runtime.json e o servidor sai com 0', { timeout: 120_000 }, (t) => {
    const dataDir = home();
    const r = emulateCtrlC('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "npm start -- --port 0"', dataDir);
    assert.equal(r.ok, true, `${r.error}\n${r.screen}`);
    assert.equal(r.ctrlC, 'ok');
    assert.notEqual(r.port, 47821);
    assert.match(r.screen, /Encerrando o Agent Quest\.\.\./, r.screen);
    assertRuntimeRemoved(t, r, dataDir);
    assert.equal(r.serverExitCode, 0, r.screen);
  });

  it('npm start direto no console: Ctrl+C apaga o runtime.json e o servidor sai com 0', { timeout: 120_000 }, (t) => {
    const dataDir = home();
    const r = emulateCtrlC(`${quote(process.execPath)} ${quote(npmCli())} start -- --port 0`, dataDir);
    assert.equal(r.ok, true, `${r.error}\n${r.screen}`);
    assert.match(r.screen, /Encerrando o Agent Quest\.\.\./, r.screen);
    assertRuntimeRemoved(t, r, dataDir);
    assert.equal(r.serverExitCode, 0, r.screen);
  });

  it('npm run dev: a sobra do runtime.json é inofensiva (encaminhador e próximo início)', { timeout: 180_000 }, async (t) => {
    assert.ok(existsSync(FORWARDER), `encaminhador não encontrado: ${FORWARDER}`);
    const dataDir = home();
    const runtimeFile = path.join(dataDir, 'runtime.json');

    // 1. Ctrl+C no npm run dev. Porta 0: a porta real vem do runtime.json, sem
    //    disputa com servidores de outros arquivos de teste.
    const r = emulateCtrlC(`${quote(process.execPath)} ${quote(npmCli())} run dev -- --port 0`, dataDir);
    assert.equal(r.ok, true, `${r.error}\n${r.screen}`);
    assert.ok(Number.isInteger(r.port) && r.port > 0, String(r.port));
    await waitFor(() => !isAlive(r.serverPid), { timeoutMs: 10_000, label: 'fim do servidor' });

    // 2. A sobra, se ficou, aponta para o servidor que já morreu. Se não ficou,
    //    o teste recria exatamente o que teria ficado, para cobrir o caso.
    if (existsSync(runtimeFile)) {
      t.diagnostic(`sobra observada: runtime.json com o pid ${r.serverPid}, que já terminou`);
    } else {
      t.diagnostic('desta vez o runtime.json foi apagado; recriando a sobra para testar o resto');
      writeFileSync(runtimeFile, JSON.stringify({ port: r.port, token: 'x'.repeat(43), pid: r.serverPid, version: '0.0.0', startedAt: 1 }));
    }
    const stale = JSON.parse(readFileSync(runtimeFile, 'utf8'));
    assert.equal(stale.pid, r.serverPid);
    assert.equal(stale.port, r.port);
    assert.equal(isAlive(stale.pid), false);
    const staleText = readFileSync(runtimeFile, 'utf8');

    // 3. O encaminhador sai com 0, em silêncio e sem tentar conectar. Para
    //    detectar qualquer tentativa sem disputar porta com outros testes, a
    //    porta da sobra é trocada pela de um ouvinte que o teste segura (porta 0);
    //    pid, token e o resto da sobra ficam como estavam. Quem decide é o pid morto.
    const connections = [];
    const listener = net.createServer((socket) => {
      connections.push(socket);
      socket.destroy();
    });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const listenerPort = listener.address().port;
    writeFileSync(runtimeFile, JSON.stringify({ ...stale, port: listenerPort }));

    // Tempo medido dentro do próprio processo do encaminhador (performance.now()
    // na saída, por um módulo carregado com --import), como nos testes do T4:
    // não conta a espera do sistema para criar o processo, que sob carga passa de segundos.
    const timer = path.join(home('aq-int-ctrlc-timer-'), 'own-timer.mjs');
    writeFileSync(
      timer,
      "import { writeFileSync } from 'node:fs';\nimport process from 'node:process';\n" +
        "process.on('exit', () => { try { writeFileSync(process.env.AQ_TEST_TIMING_FILE, String(performance.now())); } catch {} });\n",
    );
    let runs = 0;
    const runForwarder = () =>
      new Promise((resolve) => {
        const timingFile = `${timer}.${runs++}.txt`;
        const child = spawn(process.execPath, ['--import', pathToFileURL(timer).href, FORWARDER], {
          env: { ...process.env, AGENT_QUEST_HOME: dataDir, CLAUDE_PROJECT_DIR: REPO, AQ_TEST_TIMING_FILE: timingFile },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => {
          let ownMs = Infinity;
          try {
            ownMs = Number(readFileSync(timingFile, 'utf8'));
          } catch {
            // sem arquivo: o processo não saiu normalmente
          }
          resolve({ code, out, ownMs });
        });
        child.stdin.end(JSON.stringify({ session_id: 'sessao-teste', hook_event_name: 'Stop', cwd: REPO }));
      });

    try {
      const times = [];
      for (let i = 0; i < 3; i++) {
        const fwd = await runForwarder();
        assert.equal(fwd.code, 0, `tentativa ${i + 1}`);
        assert.equal(fwd.out, '', `tentativa ${i + 1}`);
        times.push(fwd.ownMs);
      }
      const median = [...times].sort((a, b) => a - b)[1];
      t.diagnostic(`encaminhador com a sobra: tempo do próprio processo ${times.map((ms) => Math.round(ms)).join(', ')} ms (mediana ${Math.round(median)})`);
      assert.ok(median < 2_000, `mediana ${median} ms: acima do prazo de 2 s do encaminhador`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(connections.length, 0, 'o encaminhador não pode tentar conectar com o pid morto');

      // Controle: o mesmo arquivo com um pid vivo faz o encaminhador conectar.
      // Prova que ele leu este diretório e que foi o pid morto que o parou.
      writeFileSync(runtimeFile, JSON.stringify({ ...stale, port: listenerPort, pid: process.pid }));
      const control = await runForwarder();
      assert.equal(control.code, 0);
      assert.equal(control.out, '');
      await waitFor(() => connections.length > 0, { timeoutMs: 5_000, label: 'conexão do encaminhador no controle' });
    } finally {
      writeFileSync(runtimeFile, staleText);
      await new Promise((resolve) => listener.close(resolve));
    }

    const env = minimalEnv({ AGENT_QUEST_HOME: dataDir });

    // 4. O próximo npm start substitui a sobra sem "já está rodando".
    const start = launchNpm(['start', '--', '--port', '0'], env, { ready: /Ctrl\+C para parar\./ });
    let started = null;
    try {
      assert.equal(await start.started, true, start.output());
      assert.doesNotMatch(start.output(), /já está rodando/);
      started = JSON.parse(readFileSync(runtimeFile, 'utf8'));
      assert.notEqual(started.pid, stale.pid);
      assert.notEqual(started.token, stale.token);
      assert.match(start.output(), new RegExp(`rodando em http://127\\.0\\.0\\.1:${started.port}/`));
    } finally {
      await killTree(start.child); // encerramento à força: deixa outra sobra, como um travamento
    }

    // 5. E o próximo npm run dev também a substitui sem "já está rodando".
    const leftover = JSON.parse(readFileSync(runtimeFile, 'utf8'));
    await waitFor(() => !isAlive(leftover.pid), { timeoutMs: 10_000, label: 'fim do servidor do npm start' });
    const dev = launchNpm(['run', 'dev', '--', '--port', '0'], env, { ready: /Ctrl\+C para parar\./ });
    try {
      assert.equal(await dev.started, true, dev.output());
      assert.doesNotMatch(dev.output(), /já está rodando/);
      const fresh = JSON.parse(readFileSync(runtimeFile, 'utf8'));
      assert.notEqual(fresh.pid, leftover.pid);
      assert.notEqual(fresh.token, leftover.token);
    } finally {
      await killTree(dev.child);
    }
  });
});
