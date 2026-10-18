// Integração do T2 (tester): `npm run dev` (node --watch) reinicia o servidor
// quando um arquivo importado muda, três vezes seguidas, sempre na mesma porta e
// com um runtime.json novo a cada reinício, sem "porta ocupada".
//
// Roda numa cópia temporária de package.json, server/, shared/ e web/, para
// editar arquivos sem tocar no repositório. Diretório de dados temporário e porta
// livre sorteada (nunca a 47821).
//
// O Ctrl+C de verdade (sinal pelo console) não cabe aqui: no Windows, encerrar o
// processo por código não executa o tratamento de sinal. Ele fica no roteiro manual.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { REPO, freePort, killTree, launchNpm, minimalEnv, request, tempDir, waitFor } from './server-helpers.js';

const RESTARTS = 3;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

describe('T2 integração: npm run dev (node --watch)', () => {
  const copy = tempDir('aq-int-dev-copy-');
  const home = tempDir('aq-int-dev-home-');
  let run;

  before(() => {
    for (const entry of ['package.json', 'server', 'shared', 'web']) {
      cpSync(path.join(REPO, entry), path.join(copy.dir, entry), { recursive: true });
    }
  });

  after(async () => {
    if (run) await killTree(run.child);
    copy.cleanup();
    home.cleanup();
  });

  it('o script dev é node --watch, sem dependência', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.dev, 'node --watch server/main.js');
  });

  it(`editar um arquivo importado reinicia ${RESTARTS} vezes seguidas, na mesma porta e com runtime.json novo`, { timeout: 120_000 }, async () => {
    const port = await freePort();
    const runtimeFile = path.join(home.dir, 'runtime.json');
    const readRuntime = () => {
      try {
        return JSON.parse(readFileSync(runtimeFile, 'utf8'));
      } catch {
        return null;
      }
    };

    run = launchNpm(['run', 'dev', '--', '--port', String(port)], minimalEnv({ AGENT_QUEST_HOME: home.dir }), {
      cwd: copy.dir,
      ready: /Ctrl\+C para parar\./,
    });
    assert.equal(await run.started, true, run.output());

    let current = readRuntime();
    assert.equal(current.port, port);
    const seenPids = new Set([current.pid]);
    const seenTokens = new Set([current.token]);

    for (let i = 1; i <= RESTARTS; i++) {
      // Conexões abertas e fechadas antes do reinício, como um painel e encaminhadores fariam.
      const agent = new http.Agent({ keepAlive: true });
      assert.equal((await request(port, { path: '/api/health', agent })).status, 200);
      assert.equal((await request(port, { path: '/', agent })).status, 200);
      for (let k = 0; k < 5; k++) assert.equal((await request(port, { path: '/api/health' })).status, 200);

      const previous = current;
      appendFileSync(path.join(copy.dir, 'server', 'config.js'), `\n// reinício ${i} do teste de integração\n`);

      current = await waitFor(
        () => {
          const next = readRuntime();
          return next && next.pid !== previous.pid && next.token !== previous.token ? next : null;
        },
        { timeoutMs: 20_000, label: `runtime.json do reinício ${i}` },
      );
      agent.destroy();

      assert.equal(current.port, port, `reinício ${i}: mesma porta`);
      assert.ok(!seenPids.has(current.pid), `reinício ${i}: pid novo`);
      assert.ok(!seenTokens.has(current.token), `reinício ${i}: token novo`);
      seenPids.add(current.pid);
      seenTokens.add(current.token);
      await waitFor(() => !isAlive(previous.pid), { timeoutMs: 10_000, label: `fim do processo anterior (${i})` });

      const health = await waitFor(
        async () => {
          try {
            const res = await request(port, { path: '/api/health' });
            return res.status === 200 ? JSON.parse(res.text) : null;
          } catch {
            return null;
          }
        },
        { timeoutMs: 10_000, label: `/api/health depois do reinício ${i}` },
      );
      assert.equal(health.startedAt, current.startedAt, `reinício ${i}: quem responde é a instância nova`);
    }

    const output = run.output();
    assert.doesNotMatch(output, /já está em uso|EADDRINUSE|já está rodando|Sem permissão/, output);
    assert.ok((output.match(/Restarting/g) ?? []).length >= RESTARTS, `esperava ${RESTARTS} reinícios do node --watch:\n${output}`);
    assert.equal((output.match(/rodando em http:\/\/127\.0\.0\.1:\d+\//g) ?? []).length, RESTARTS + 1, output);
  });
});
