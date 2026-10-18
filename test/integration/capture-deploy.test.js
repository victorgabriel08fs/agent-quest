// Integração do T4 (tester): `npm run capture:deploy` de verdade, e o deploy
// repetido enquanto encaminhadores rodam contra o servidor real do T3.
//
// Diretório de dados sempre temporário (LOCALAPPDATA ou AGENT_QUEST_HOME), porta
// sempre efêmera. Um "claude" falso no início do PATH denuncia qualquer chamada.
// Para alternar versões da captura sem tocar no repositório, o deploy em laço roda
// numa cópia temporária com a mesma estrutura (scripts/, server/, capture/).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  FORWARDER,
  PLUGIN_DIR,
  assertDelivered,
  assertLossesOnlyByDeadline,
  assertSilentExit,
  cleanupTemps,
  forwarderEnv,
  hookPayload,
  loadFrom,
  newTemp,
  runForwarder,
  startRealServer,
  withLoadSamples,
} from './capture-helpers.js';
import { REPO, killTree, launchNpm, launchServer, minimalEnv, waitFor } from './server-helpers.js';

const CAPTURE = path.join(REPO, 'capture');
const isWindows = process.platform === 'win32';

after(() => cleanupTemps());

/** Árvore de arquivos (caminho com "/" → conteúdo em bytes, como texto latin1 para comparar). */
function tree(dir) {
  const out = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full).split(path.sep).join('/')] = readFileSync(full).toString('latin1');
  }
  return out;
}

function mtimes(dir) {
  const out = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = statSync(full).mtimeMs;
  }
  return out;
}

/** Ambiente com um "claude" falso no início do PATH (cmd, bat, ps1 e sh). */
function envWithFakeClaude(extra) {
  const fakeBin = newTemp('aq-int-deploy-bin-');
  const marker = path.join(fakeBin, 'claude-foi-chamado.txt');
  writeFileSync(path.join(fakeBin, 'claude.cmd'), `@echo off\r\necho %* > "${marker}"\r\n`);
  writeFileSync(path.join(fakeBin, 'claude.bat'), `@echo off\r\necho %* > "${marker}"\r\n`);
  writeFileSync(path.join(fakeBin, 'claude.ps1'), `Set-Content -Path "${marker}" -Value "$args"\r\n`);
  writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\necho "$@" > "${marker}"\n`, { mode: 0o755 });
  const env = minimalEnv(extra);
  const original = process.env.PATH ?? process.env.Path ?? '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${fakeBin}${path.delimiter}${original}`;
  return { env, marker };
}

/** Roda o processo até o fim (com guarda) e devolve código e saída. */
function runToEnd(command, args, { env, cwd = REPO, guardMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const guard = setTimeout(() => child.kill(), guardMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr });
    });
  });
}

/** `npm run capture:deploy` de verdade (npm-cli.js pelo Node atual). */
async function npmDeploy(env, cwd = REPO) {
  const run = launchNpm(['run', 'capture:deploy'], env, { cwd, ready: /(?!)/, timeoutMs: 60_000 });
  const code = await run.exit;
  return { code, output: run.output() };
}

/**
 * Cópia temporária com a estrutura que o script de deploy espera: SOURCE_DIR é
 * `../capture` a partir de scripts/, e ele importa ../server/config.js.
 */
function repoLayout() {
  const root = newTemp('aq-int-deploy-repo-');
  cpSync(path.join(REPO, 'scripts', 'deploy-capture.mjs'), path.join(root, 'scripts', 'deploy-capture.mjs'));
  cpSync(path.join(REPO, 'server', 'config.js'), path.join(root, 'server', 'config.js'));
  cpSync(path.join(REPO, 'server', 'ingest', 'debug-dump.js'), path.join(root, 'server', 'ingest', 'debug-dump.js'));
  cpSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  cpSync(CAPTURE, path.join(root, 'capture'), { recursive: true });
  return root;
}

const deployCli = (root, env) => runToEnd(process.execPath, [path.join(root, 'scripts', 'deploy-capture.mjs')], { env, cwd: root });

describe('T4 integração: npm run capture:deploy', () => {
  it('copia capture/ para %LOCALAPPDATA%\\agent-quest\\marketplace, valida, imprime os comandos com o caminho completo e não chama o claude', { timeout: 120_000, skip: !isWindows && 'LOCALAPPDATA é do Windows' }, async (t) => {
    const local = newTemp('aq int deploy ção-');
    const { env, marker } = envWithFakeClaude({ LOCALAPPDATA: local });
    const dataDir = path.join(local, 'agent-quest');
    const target = path.join(dataDir, 'marketplace');
    const pluginDir = path.join(target, 'plugins', 'agent-quest');

    const first = await npmDeploy(env);
    assert.equal(first.code, 0, first.output);
    assert.equal(existsSync(marker), false, 'o deploy chamou o claude');
    assert.deepEqual(tree(target), tree(CAPTURE), 'a cópia é idêntica, byte a byte, a capture/');

    // Comandos dos passos 3 a 5 e 7 do marco, com o caminho completo.
    const lines = first.output.split(/\r?\n/);
    const expected = [
      `  claude --plugin-dir "${pluginDir}" --debug-file "${path.join(dataDir, 'smoke-debug.txt')}"`,
      `  claude plugin marketplace add "${target}"`,
      '  claude plugin install agent-quest@agent-quest-local',
      '  Confira com: claude plugin list',
      'Numa sessão já aberta, rode /reload-plugins para a captura valer nela.',
      'Pausar:  claude plugin disable agent-quest@agent-quest-local  (e /reload-plugins)',
      'Retomar: claude plugin enable agent-quest@agent-quest-local  (e /reload-plugins)',
      'Remover: claude plugin marketplace remove agent-quest-local',
    ];
    for (const line of expected) assert.ok(lines.includes(line), `faltou a linha:\n${line}\n---\n${first.output}`);
    assert.match(first.output, new RegExp(`Captura copiada para ${target.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.match(first.output, /4 arquivo\(s\) gravado\(s\), 0 sem mudança, 0 removido\(s\)/);

    // Rodar de novo dá o mesmo resultado, sem regravar nada.
    const before = mtimes(target);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await npmDeploy(env);
    assert.equal(second.code, 0, second.output);
    assert.deepEqual(tree(target), tree(CAPTURE));
    assert.deepEqual(mtimes(target), before, 'o segundo deploy regravou arquivos iguais');
    assert.match(second.output, /0 arquivo\(s\) gravado\(s\), 4 sem mudança, 0 removido\(s\)/);
    const commands = (out) => out.split(/\r?\n/).filter((l) => /claude |reload-plugins/.test(l));
    assert.deepEqual(commands(second.output), commands(first.output), 'mesmos comandos nas duas execuções');
    assert.equal(existsSync(marker), false, 'o deploy chamou o claude');

    // A cópia funciona como o Claude Code a chama (hooks.json): node "${CLAUDE_PLUGIN_ROOT}/scripts/forward.mjs",
    // com o cwd no projeto e sem AGENT_QUEST_HOME, contra o servidor real com o mesmo LOCALAPPDATA.
    const hooks = JSON.parse(readFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
    const arg = hooks.hooks.PreToolUse[0].hooks[0].args[0].replace('${CLAUDE_PLUGIN_ROOT}', pluginDir);
    assert.ok(arg.includes('\\') && arg.includes('/'), `caminho com separadores misturados, como no Windows: ${arg}`);
    const server = await startRealServer({ dataDir, env: { LOCALAPPDATA: local } });
    try {
      const project = newTemp('aq int projeto ção-');
      const envelope = await assertDelivered(t, 'cópia implantada', async () => {
        const payload = hookPayload();
        const result = await runForwarder({
          forwarder: arg,
          cwd: project,
          env: forwarderEnv({ LOCALAPPDATA: local, CLAUDE_PLUGIN_ROOT: pluginDir, CLAUDE_PROJECT_DIR: project }),
          stdin: JSON.stringify(payload),
        });
        return { result, delivered: () => server.dumped().find((e) => e.payload.tool_use_id === payload.tool_use_id) };
      });
      if (envelope) assert.equal(envelope.env.projectDir, project);
    } finally {
      await server.stop();
    }
  });

  it('com AGENT_QUEST_HOME: copia para <dados>/marketplace, criando a pasta se preciso', async () => {
    const home = path.join(newTemp('aq-int-deploy-home-'), 'ainda', 'nao', 'existe');
    const { env, marker } = envWithFakeClaude({ AGENT_QUEST_HOME: home });
    const result = await runToEnd(process.execPath, [path.join(REPO, 'scripts', 'deploy-capture.mjs')], { env });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(tree(path.join(home, 'marketplace')), tree(CAPTURE));
    assert.ok(result.stdout.includes(`claude plugin marketplace add "${path.join(home, 'marketplace')}"`), result.stdout);
    assert.equal(existsSync(marker), false);
  });

  it('captura inválida na fonte: código 1, mensagem clara e a cópia já instalada fica intacta', async () => {
    const root = repoLayout();
    const home = newTemp('aq-int-deploy-invalida-');
    const { env } = envWithFakeClaude({ AGENT_QUEST_HOME: home });
    const target = path.join(home, 'marketplace');
    assert.equal((await deployCli(root, env)).code, 0);
    const installed = tree(target);
    const installedTimes = mtimes(target);
    const hooksFile = path.join(root, 'capture', 'plugins', 'agent-quest', 'hooks', 'hooks.json');
    const original = readFileSync(hooksFile, 'utf8');

    const breakages = {
      'JSON pela metade': () => writeFileSync(hooksFile, original.slice(0, 200)),
      'evento a menos': () => {
        const data = JSON.parse(original);
        delete data.hooks.SessionStart;
        writeFileSync(hooksFile, JSON.stringify(data));
      },
      'matcher': () => {
        const data = JSON.parse(original);
        data.hooks.PreToolUse[0].matcher = 'Bash';
        writeFileSync(hooksFile, JSON.stringify(data));
      },
      'hook síncrono': () => {
        const data = JSON.parse(original);
        data.hooks.Stop[0].hooks[0].async = false;
        writeFileSync(hooksFile, JSON.stringify(data));
      },
      'forward.mjs ausente': () => rmSync(path.join(root, 'capture', 'plugins', 'agent-quest', 'scripts', 'forward.mjs')),
    };
    for (const [name, mutate] of Object.entries(breakages)) {
      const forwarderBackup = readFileSync(path.join(root, 'capture', 'plugins', 'agent-quest', 'scripts', 'forward.mjs'), { flag: 'r' });
      mutate();
      const result = await deployCli(root, env);
      assert.equal(result.code, 1, `${name}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /nada foi copiado/, name);
      assert.deepEqual(tree(target), installed, `${name}: a cópia instalada mudou`);
      assert.deepEqual(mtimes(target), installedTimes, `${name}: a cópia instalada foi regravada`);
      writeFileSync(hooksFile, original);
      writeFileSync(path.join(root, 'capture', 'plugins', 'agent-quest', 'scripts', 'forward.mjs'), forwarderBackup);
    }
  });

  it('deploy repetido enquanto encaminhadores rodam contra o servidor real: nenhuma saída diferente de 0; evento perdido só por prazo do ADR 0001 com a máquina sobrecarregada', { timeout: 300_000 }, async (t) => {
    const root = repoLayout();
    const home = newTemp('aq int deploy laço ção-');
    const { env } = envWithFakeClaude({ AGENT_QUEST_HOME: home });
    const server = await startRealServer({ dataDir: home, env: { AGENT_QUEST_HOME: home } });

    const sourceForwarder = path.join(root, 'capture', 'plugins', 'agent-quest', 'scripts', 'forward.mjs');
    const extraFile = path.join(root, 'capture', 'plugins', 'agent-quest', 'scripts', 'sobra-da-versao-b.txt');
    const original = readFileSync(FORWARDER, 'utf8');
    assert.match(original, /export const FORWARDER_VERSION = '0\.1\.0';/);
    // Versões grandes (300 KB) alargam a janela de gravação; a B muda a versão do
    // encaminhador (para o dump mostrar qual versão rodou) e tem um arquivo a mais.
    const versions = {
      A: `${original}\n// versão A ${'a'.repeat(300_000)}\n`,
      B: `${original.replace("FORWARDER_VERSION = '0.1.0'", "FORWARDER_VERSION = '0.1.0-b'")}\n// versão B ${'b'.repeat(300_000)}\n`,
    };
    const useVersion = (name) => {
      writeFileSync(sourceForwarder, versions[name]);
      if (name === 'B') writeFileSync(extraFile, 'só existe na versão B\n');
      else rmSync(extraFile, { force: true });
    };

    try {
      useVersion('A');
      const firstDeploy = await deployCli(root, env);
      assert.equal(firstDeploy.code, 0, firstDeploy.stdout + firstDeploy.stderr);

      // Como o Claude Code chama: node "${CLAUDE_PLUGIN_ROOT}/scripts/forward.mjs".
      const pluginRoot = path.join(home, 'marketplace', 'plugins', 'agent-quest');
      const deployedForwarder = `${pluginRoot}/scripts/forward.mjs`;
      const before = await server.health();

      let stop = false;
      const runs = [];
      const loop = async () => {
        while (!stop) {
          const payload = hookPayload();
          const result = await runForwarder({ forwarder: deployedForwarder, env: forwarderEnv({ AGENT_QUEST_HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot }), stdin: JSON.stringify(payload) });
          runs.push({ payload, result });
        }
      };
      const deploys = [];
      // A carga é medida durante o laço (referência de partida do Node, em paralelo).
      const { samples } = await withLoadSamples(async () => {
        const loops = [loop(), loop(), loop()];
        for (let i = 1; i <= 12; i++) {
          useVersion(i % 2 === 1 ? 'B' : 'A');
          deploys.push(await deployCli(root, env));
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        stop = true;
        await Promise.all(loops);
      });

      deploys.forEach((d, i) => assert.equal(d.code, 0, `deploy ${i + 1}: ${d.stdout}${d.stderr}`));
      runs.forEach(({ result }, i) => assertSilentExit(result, `encaminhador ${i + 1} durante o deploy`));
      assert.ok(runs.length >= 12, `poucos encaminhadores rodaram durante o deploy (${runs.length})`);

      // Entrega: um evento só pode faltar se o encaminhador dele esgotou um prazo
      // do ADR 0001 e a máquina estava sobrecarregada (regra em capture-helpers.js).
      const find = (payload) => server.dumped().find((e) => e.payload.tool_use_id === payload.tool_use_id);
      await waitFor(() => runs.every((r) => find(r.payload)), { timeoutMs: 5000, label: 'envelopes do laço' }).catch(() => {});
      const checked = runs.map((r) => ({ ...r, delivered: Boolean(find(r.payload)) }));
      assertLossesOnlyByDeadline(t, 'deploy com encaminhadores rodando', checked, samples);
      const delivered = checked.filter((r) => r.delivered);
      const events = await server.health();
      assert.equal(events.accepted - before.accepted, delivered.length, 'cada envelope entregue foi aceito uma vez');
      assert.ok(events.rejected - before.rejected <= checked.length - delivered.length, 'recusa sem explicação');

      const versionsSeen = new Set(delivered.map((r) => find(r.payload).forwarder));
      t.diagnostic(`${runs.length} encaminhadores durante 12 deploys (${delivered.length} entregues); versões vistas: ${[...versionsSeen].join(', ')}`);
      for (const version of versionsSeen) assert.ok(['0.1.0', '0.1.0-b'].includes(version), `versão inesperada: ${version}`);
      if (versionsSeen.size < 2) {
        const load = loadFrom(samples);
        assert.ok(!load.normal, `com a máquina normal (${load.text}), o laço deveria entregar com as duas versões`);
        t.diagnostic(`máquina sobrecarregada (${load.text}): o laço não entregou com as duas versões; a troca de versão ficou sem prova nesta execução`);
      }

      // Ao fim: a cópia é a última versão (A), sem o arquivo da B e sem temporários.
      assert.deepEqual(tree(path.join(home, 'marketplace')), tree(path.join(root, 'capture')));
      const leftovers = readdirSync(path.join(home, 'marketplace'), { recursive: true }).filter((f) => /\.tmp$/.test(f));
      assert.deepEqual(leftovers, []);
    } finally {
      await server.stop();
    }
  });

  it('deploy interrompido no meio (temporário de outra execução): o próximo deploy limpa a sobra', async () => {
    const root = repoLayout();
    const home = newTemp('aq-int-deploy-sobra-');
    const { env } = envWithFakeClaude({ AGENT_QUEST_HOME: home });
    assert.equal((await deployCli(root, env)).code, 0);
    const scripts = path.join(home, 'marketplace', 'plugins', 'agent-quest', 'scripts');
    writeFileSync(path.join(scripts, 'forward.mjs.99999.deadbeef.tmp'), 'pela metade');
    mkdirSync(path.join(home, 'marketplace', 'pasta-vazia', 'dentro'), { recursive: true });
    const result = await deployCli(root, env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /0 arquivo\(s\) gravado\(s\), 4 sem mudança, 1 removido\(s\)/);
    assert.deepEqual(tree(path.join(home, 'marketplace')), tree(path.join(root, 'capture')));
    assert.equal(existsSync(path.join(home, 'marketplace', 'pasta-vazia')), false);
  });
});

describe('T4 integração: avisos do ADR 0005 no capture:deploy, iguais aos do servidor', { skip: !isWindows && 'LOCALAPPDATA e OneDrive são do Windows' }, () => {
  const ONEDRIVE_LINE = /^Aviso: a pasta de dados .* está dentro do OneDrive\..*$/m;
  const HOME_LINE = /^Aviso: AGENT_QUEST_HOME está definida .*$/m;

  /** Saída do servidor real com o mesmo ambiente (só até imprimir a URL). */
  async function serverOutput(extra) {
    const run = launchServer(['--port', '0'], minimalEnv(extra));
    try {
      assert.equal(await run.started, true, run.output());
      return run.output();
    } finally {
      await killTree(run.child);
    }
  }

  const cases = [
    { name: 'pasta padrão numa pasta chamada OneDrive', env: (b) => ({ LOCALAPPDATA: path.join(b, 'OneDrive', 'Local') }), oneDrive: true, home: false },
    { name: 'pasta padrão dentro da variável OneDrive', env: (b) => ({ OneDrive: path.join(b, 'Nuvem'), LOCALAPPDATA: path.join(b, 'Nuvem', 'AppData') }), oneDrive: true, home: false },
    { name: 'AGENT_QUEST_HOME fora do OneDrive', env: (b) => ({ AGENT_QUEST_HOME: path.join(b, 'dados aq') }), oneDrive: false, home: true },
    { name: 'AGENT_QUEST_HOME dentro do OneDrive', env: (b) => ({ AGENT_QUEST_HOME: path.join(b, 'OneDrive - Empresa', 'aq') }), oneDrive: true, home: true },
    { name: 'AGENT_QUEST_HOME vazia e pasta padrão fora do OneDrive', env: (b) => ({ AGENT_QUEST_HOME: '', LOCALAPPDATA: path.join(b, 'Local') }), oneDrive: false, home: false },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.oneDrive ? 'aviso do OneDrive' : 'sem aviso do OneDrive'}, ${c.home ? 'aviso do AGENT_QUEST_HOME' : 'sem aviso do AGENT_QUEST_HOME'}`, { timeout: 120_000 }, async () => {
      const extra = c.env(newTemp('aq int avisos ção-'));
      const { env } = envWithFakeClaude(extra);
      const deploy = await npmDeploy(env);
      assert.equal(deploy.code, 0, deploy.output);
      const server = await serverOutput(extra);

      const deployOneDrive = deploy.output.match(ONEDRIVE_LINE)?.[0]?.trimEnd() ?? null;
      const serverOneDrive = server.match(ONEDRIVE_LINE)?.[0]?.trimEnd() ?? null;
      if (c.oneDrive) {
        assert.ok(deployOneDrive, `o deploy não avisou do OneDrive:\n${deploy.output}`);
        assert.equal(deployOneDrive, serverOneDrive, 'o aviso do OneDrive do deploy é diferente do do servidor');
        assert.match(deployOneDrive, /variável de ambiente do usuário do Windows/);
        assert.match(deployOneDrive, /Claude Code precisa ver o mesmo valor/);
      } else {
        assert.equal(deployOneDrive, null, deploy.output);
        assert.equal(serverOneDrive, null, server);
      }

      const deployHome = deploy.output.match(HOME_LINE)?.[0] ?? null;
      if (c.home) {
        assert.ok(deployHome, `o deploy não avisou do AGENT_QUEST_HOME:\n${deploy.output}`);
        assert.ok(deployHome.includes(extra.AGENT_QUEST_HOME), 'o aviso mostra o caminho em uso');
        assert.match(deployHome, /Claude Code/);
        assert.match(deployHome, /mesmo valor/);
        assert.match(deployHome, /variável de ambiente do usuário do Windows/);
        assert.match(server, HOME_LINE, 'o servidor também avisa');
      } else {
        assert.equal(deployHome, null, deploy.output);
        assert.doesNotMatch(server, HOME_LINE);
      }
    });
  }
});

describe('T4 integração: plugin.json, marketplace.json e hooks.json (oráculo próprio)', () => {
  const ADR_0001 = [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop',
    'StopFailure', 'PreCompact', 'PostCompact',
  ];

  it('hooks.json: exatamente os 15 eventos do ADR 0001, command em forma exec, async, sem matcher', () => {
    const data = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(data.hooks).sort(), [...ADR_0001].sort());
    for (const event of ADR_0001) {
      const groups = data.hooks[event];
      assert.equal(groups.length, 1, event);
      assert.equal(Object.hasOwn(groups[0], 'matcher'), false, event);
      assert.deepEqual(groups[0].hooks, [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/forward.mjs'], async: true }], event);
    }
    // Nada de MessageDisplay, PostToolBatch nem Task* (ADR 0001, "Ficam de fora").
    for (const out of ['MessageDisplay', 'PostToolBatch', 'TaskCreated', 'TaskCompleted']) assert.equal(Object.hasOwn(data.hooks, out), false, out);
  });

  it('marketplace agent-quest-local com o plugin agent-quest, mesma versão no plugin.json e no encaminhador', () => {
    const marketplace = JSON.parse(readFileSync(path.join(CAPTURE, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(marketplace.name, 'agent-quest-local');
    assert.deepEqual(marketplace.plugins.map((p) => [p.name, p.source]), [['agent-quest', './plugins/agent-quest']]);
    assert.equal(plugin.name, 'agent-quest');
    assert.equal(marketplace.plugins[0].version, plugin.version);
    assert.match(readFileSync(FORWARDER, 'utf8'), new RegExp(`FORWARDER_VERSION = '${plugin.version.replace(/\./g, '\\.')}'`));
  });

  it('package.json: script capture:deploy chama o script de deploy, sem dependências novas', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['capture:deploy'], 'node scripts/deploy-capture.mjs');
    assert.equal(pkg.dependencies, undefined);
  });
});
