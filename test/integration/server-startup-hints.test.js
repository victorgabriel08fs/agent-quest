// Integração dos ajustes pós-entrega do T2 (tester), com processos reais:
//
// - com AGENT_QUEST_HOME definida, o início avisa que a captura só encontra este
//   servidor se o Claude Code tiver a mesma variável (ADR 0005, complemento);
// - as mensagens de porta ocupada e de porta sem permissão sugerem o comando do
//   modo em uso, pelo npm_lifecycle_event: `npm run dev`, `npm start` ou
//   `node server/main.js` (plano da v1, T2).
//
// Regras do ADR 0010: diretório de dados sempre temporário (AGENT_QUEST_HOME ou
// LOCALAPPDATA apontando para uma pasta temporária) e nunca a porta 47821.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { resolveConfig } from '../../server/config.js';
import { killTree, launchNpm, launchServer, minimalEnv, tempDir, waitFor } from './server-helpers.js';

const WARNING_PREFIX = 'Aviso: AGENT_QUEST_HOME está definida';
const SUGGESTIONS = {
  node: 'node server/main.js --port <número>',
  start: 'npm start -- --port <número>',
  dev: 'npm run dev -- --port <número>',
};

const temps = [];
const children = [];
const servers = [];

function home(prefix = 'aq-int-hints-') {
  const tmp = tempDir(prefix);
  temps.push(tmp);
  return tmp.dir;
}

after(async () => {
  for (const child of children) await killTree(child);
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  for (const tmp of temps) tmp.cleanup();
});

/** Outro programa (HTTP que não é o Agent Quest) escutando numa porta livre de 127.0.0.1. */
async function otherProgram() {
  const server = http.createServer((req, res) => res.end('outro programa'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  assert.notEqual(server.address().port, 47821);
  return server.address().port;
}

/**
 * Uma porta de 1024 a 65535 que o Windows recusa com EACCES (faixas excluídas,
 * `netsh int ipv4 show excludedportrange`, comando só de leitura). `null` se não houver.
 */
async function forbiddenPort() {
  if (process.platform !== 'win32') return null;
  const out = spawnSync('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout;
  const ranges = [...(out ?? '').matchAll(/^\s*(\d+)\s+(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]);
  for (const [start, end] of ranges) {
    for (const port of [start, Math.floor((start + end) / 2), end]) {
      if (port < 1024 || port > 65535 || port === 47821) continue;
      const code = await new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', (err) => resolve(err.code));
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve('ok')));
      });
      if (code === 'EACCES') return port;
    }
  }
  return null;
}

/** Linha do aviso de AGENT_QUEST_HOME na saída, ou null. */
function warningLine(output) {
  return output.split(/\r?\n/).find((line) => line.startsWith(WARNING_PREFIX)) ?? null;
}

describe('T2 ajuste: aviso de AGENT_QUEST_HOME no início', () => {
  it('node server/main.js com AGENT_QUEST_HOME: avisa, com o caminho, que o Claude Code precisa da mesma variável', async () => {
    const dir = home();
    const run = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
    children.push(run.child);
    assert.equal(await run.started, true, run.output());
    // O aviso sai no stderr e a URL no stdout: espera o aviso sem supor a ordem.
    const line = await waitFor(() => warningLine(run.output()), { timeoutMs: 3000, label: 'aviso de AGENT_QUEST_HOME' });
    assert.ok(line.includes(`(${dir})`), line);
    assert.match(line, /Claude Code/);
    assert.match(line, /mesma variável/);
    assert.match(line, /uso normal/);
    assert.equal(run.output().split(WARNING_PREFIX).length - 1, 1, 'o aviso sai uma vez');
    assert.ok(existsSync(path.join(dir, 'runtime.json')));
    await killTree(run.child);
  });

  it('npm start com AGENT_QUEST_HOME: o mesmo aviso', async () => {
    const dir = home();
    const run = launchNpm(['start', '--', '--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
    children.push(run.child);
    assert.equal(await run.started, true, run.output());
    const line = await waitFor(() => warningLine(run.output()), { timeoutMs: 3000, label: 'aviso de AGENT_QUEST_HOME' });
    assert.ok(line.includes(`(${dir})`), line);
    await killTree(run.child);
  });

  for (const [label, extra] of [
    ['sem AGENT_QUEST_HOME', {}],
    ['com AGENT_QUEST_HOME vazia (vale como não definida)', { AGENT_QUEST_HOME: '' }],
  ]) {
    it(`${label}: sem aviso, e o diretório de dados é %LOCALAPPDATA%\\agent-quest (temporário)`, async () => {
      const local = home('aq-int-hints-local-');
      // LOCALAPPDATA e USERPROFILE apontam para a pasta temporária: nunca o diretório real.
      const env = minimalEnv({ LOCALAPPDATA: local, USERPROFILE: local, HOME: local, ...extra });
      const run = launchServer(['--port', '0'], env);
      children.push(run.child);
      assert.equal(await run.started, true, run.output());
      const dataDir = path.join(local, 'agent-quest');
      await waitFor(() => existsSync(path.join(dataDir, 'runtime.json')), { label: 'runtime.json no LOCALAPPDATA temporário' });
      await new Promise((resolve) => setTimeout(resolve, 300)); // dá tempo de um aviso tardio no stderr
      assert.equal(warningLine(run.output()), null, run.output());
      assert.doesNotMatch(run.output(), /AGENT_QUEST_HOME/);
      assert.ok(run.output().includes(`Diretório de dados: ${dataDir}`), run.output());
      assert.deepEqual(readdirSync(local), ['agent-quest']);
      await killTree(run.child);
    });
  }
});

describe('T2 ajuste: mensagem de porta sugere o comando do modo em uso', () => {
  it('porta ocupada com node server/main.js: sugere node server/main.js e sai com 1', async () => {
    const port = await otherProgram();
    const dir = home();
    const run = launchServer(['--port', String(port)], minimalEnv({ AGENT_QUEST_HOME: dir }), { ready: /$^/ });
    children.push(run.child);
    assert.equal(await run.exit, 1, run.output());
    const out = run.output();
    assert.ok(out.includes(`A porta ${port} já está em uso por outro programa`), out);
    assert.ok(out.includes(`Escolha outra porta: ${SUGGESTIONS.node}`), out);
    assert.ok(!out.includes(SUGGESTIONS.start) && !out.includes(SUGGESTIONS.dev), out);
    assert.equal(existsSync(path.join(dir, 'runtime.json')), false);
  });

  it('porta ocupada com npm start: sugere npm start -- --port e sai com 1', async () => {
    const port = await otherProgram();
    const dir = home();
    const run = launchNpm(['start', '--', '--port', String(port)], minimalEnv({ AGENT_QUEST_HOME: dir }), { ready: /$^/ });
    children.push(run.child);
    assert.equal(await run.exit, 1, run.output());
    const out = run.output();
    assert.ok(out.includes(`Escolha outra porta: ${SUGGESTIONS.start}`), out);
    assert.ok(!out.includes(SUGGESTIONS.node) && !out.includes(SUGGESTIONS.dev), out);
    assert.equal(existsSync(path.join(dir, 'runtime.json')), false);
  });

  it('porta ocupada com npm run dev: sugere npm run dev -- --port', { timeout: 30_000 }, async () => {
    const port = await otherProgram();
    const dir = home();
    // Com node --watch, o vigia continua esperando mudanças depois da saída com erro;
    // por isso o teste espera a mensagem e encerra a árvore de processos.
    const run = launchNpm(['run', 'dev', '--', '--port', String(port)], minimalEnv({ AGENT_QUEST_HOME: dir }), {
      ready: /Escolha outra porta: [^\r\n]*\r?\n/,
      timeoutMs: 20_000,
    });
    children.push(run.child);
    assert.equal(await run.started, true, run.output());
    const out = run.output();
    assert.ok(out.includes(`A porta ${port} já está em uso por outro programa`), out);
    assert.ok(out.includes(`Escolha outra porta: ${SUGGESTIONS.dev}`), out);
    assert.ok(!out.includes(SUGGESTIONS.node) && !out.includes(SUGGESTIONS.start), out);
    assert.equal(existsSync(path.join(dir, 'runtime.json')), false);
    await killTree(run.child);
  });

  it('porta sem permissão (faixa excluída do Windows): mensagem clara com o comando do modo', async (t) => {
    const port = await forbiddenPort();
    if (port === null) {
      t.skip('nenhuma porta de 1024 a 65535 recusada com EACCES nesta máquina');
      return;
    }
    t.diagnostic(`porta recusada com EACCES: ${port}`);
    for (const [mode, launcher] of [
      ['node', (env) => launchServer(['--port', String(port)], env, { ready: /$^/ })],
      ['start', (env) => launchNpm(['start', '--', '--port', String(port)], env, { ready: /$^/ })],
    ]) {
      const dir = home();
      const run = launcher(minimalEnv({ AGENT_QUEST_HOME: dir }));
      children.push(run.child);
      assert.equal(await run.exit, 1, run.output());
      const out = run.output();
      assert.ok(out.includes(`Sem permissão para usar a porta ${port}`), out);
      assert.ok(out.includes(`Escolha outra porta: ${SUGGESTIONS[mode]}`), `${mode}:\n${out}`);
      assert.equal(existsSync(path.join(dir, 'runtime.json')), false);
    }
  });
});

describe('T2 ajuste: a regra de logs continua firme com a linha nova permitida', () => {
  it('o aviso de AGENT_QUEST_HOME é uma linha só e não carrega nada da requisição', async () => {
    const dir = home();
    const run = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: dir }));
    children.push(run.child);
    assert.equal(await run.started, true, run.output());
    const { port, token } = JSON.parse(readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
    const marker = 'MARCADOR-HINTS-4b2d';
    await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/hooks?${marker}`,
          agent: false,
          headers: { 'Content-Type': 'application/json', 'X-Agent-Quest-Token': token, 'User-Agent': marker },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', resolve);
      req.end(JSON.stringify({ v: 1, payload: { session_id: marker, hook_event_name: marker } }));
    });
    await waitFor(() => warningLine(run.output()), { timeoutMs: 3000, label: 'aviso de AGENT_QUEST_HOME' });
    const out = run.output();
    assert.doesNotMatch(out, new RegExp(marker));
    const lines = out.split(/\r?\n/).filter(Boolean);
    const warnings = lines.filter((line) => line.startsWith(WARNING_PREFIX));
    assert.equal(warnings.length, 1);
    // A linha impressa é exatamente o aviso que a configuração monta só com o
    // ambiente (nada da requisição entra nela), mesmo que a lista de linhas
    // permitidas do server-lifecycle.test.js só confira o começo.
    const expected = resolveConfig({
      argv: ['--port', '0'],
      env: { AGENT_QUEST_HOME: dir },
      platform: process.platform,
      homedir: dir,
    }).warnings.find((w) => w.startsWith(WARNING_PREFIX));
    assert.ok(expected && !expected.includes('\n'), 'o aviso é uma linha só');
    assert.equal(warnings[0], expected);
    await killTree(run.child);
  });
});
