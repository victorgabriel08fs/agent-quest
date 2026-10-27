// `npm run capture:deploy` (T4): validação, cópia atômica, limpeza e comandos.
// Sempre com pastas temporárias e AGENT_QUEST_HOME temporário (ADR 0010).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_HOOK,
  FORWARDER_FILE,
  HOOKS_FILE,
  HOOK_EVENTS,
  MARKETPLACE_FILE,
  PLUGIN_FILE,
  SOURCE_DIR,
  agentQuestHomeWarning,
  checkHooks,
  deployCapture,
  readCaptureVersion,
  runDeploy,
  validateCapture,
} from '../../../scripts/deploy-capture.mjs';
import { oneDriveWarning, resolveConfig } from '../../../server/config.js';
import { tempDir } from '../server/helpers.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/deploy-capture.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const temps = [];
after(() => {
  for (const tmp of temps) tmp.cleanup();
});

function newDir() {
  const tmp = tempDir('agent-quest-deploy-');
  temps.push(tmp);
  return tmp.dir;
}

/** Cópia de capture/ numa pasta temporária, para os testes poderem mexer. */
function sourceCopy() {
  const dir = path.join(newDir(), 'capture');
  cpSync(SOURCE_DIR, dir, { recursive: true });
  return dir;
}

/** Arquivos de uma pasta com o conteúdo, para comparar árvores. */
function snapshot(dir) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
  return Object.fromEntries(files.map((file) => [file.split(path.sep).join('/'), readFileSync(path.join(dir, file), 'utf8')]));
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2));

describe('validateCapture', () => {
  it('a captura do repositório é válida', async () => {
    assert.deepEqual(await validateCapture(SOURCE_DIR), []);
  });

  it('acusa JSON inválido, arquivo ausente, nome errado e versões diferentes', async () => {
    const dir = sourceCopy();
    writeFileSync(path.join(dir, HOOKS_FILE), '{ "hooks": ');
    rmSync(path.join(dir, FORWARDER_FILE));
    const marketplace = readJson(path.join(dir, MARKETPLACE_FILE));
    marketplace.name = 'outro';
    marketplace.plugins[0].version = '9.9.9';
    writeJson(path.join(dir, MARKETPLACE_FILE), marketplace);
    const problems = await validateCapture(dir);
    const has = (text) => problems.some((p) => p.includes(text));
    assert.ok(has('hooks.json: JSON inválido'), problems.join('\n'));
    assert.ok(has('forward.mjs: arquivo ausente'), problems.join('\n'));
    assert.ok(has('"name" deveria ser "agent-quest-local"'), problems.join('\n'));
    assert.ok(has('versão diferente'), problems.join('\n'));
  });

  it('pasta inexistente', async () => {
    const problems = await validateCapture(path.join(newDir(), 'nada'));
    assert.equal(problems.length, 1);
  });
});

describe('checkHooks', () => {
  const valid = () => ({ hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ ...EXPECTED_HOOK, args: [...EXPECTED_HOOK.args] }] }]])) });

  it('os 15 eventos do ADR 0001 com o hook esperado passam', () => {
    assert.equal(HOOK_EVENTS.length, 15);
    assert.deepEqual(checkHooks(valid()), []);
  });

  it('acusa evento ausente, evento a mais, matcher, hook diferente e campo a mais', () => {
    const cases = [
      [(d) => delete d.hooks.Stop, /ausentes: Stop/],
      [(d) => (d.hooks.MessageDisplay = d.hooks.Stop), /fora do ADR 0001: MessageDisplay/],
      [(d) => (d.hooks.PreToolUse[0].matcher = '*'), /PreToolUse: o grupo não pode ter "matcher"/],
      [(d) => (d.hooks.PreToolUse[0].hooks[0].async = false), /PreToolUse: o hook/],
      [(d) => (d.hooks.Stop[0].hooks[0].type = 'http'), /Stop: o hook/],
      [(d) => (d.hooks.Stop[0].hooks[0].args = ['forward.mjs']), /Stop: o hook/],
      [(d) => (d.hooks.Stop[0].hooks[0].timeout = 5), /Stop: o hook/],
      [(d) => d.hooks.Stop.push(d.hooks.Stop[0]), /Stop: deveria ter um único grupo/],
      [(d) => delete d.hooks, /falta o objeto "hooks"/],
    ];
    for (const [mutate, expected] of cases) {
      const data = valid();
      mutate(data);
      const problems = checkHooks(data);
      assert.ok(problems.some((p) => expected.test(p)), `${expected}: ${problems.join(' | ')}`);
    }
  });
});

describe('deployCapture', () => {
  it('copia tudo; rodar de novo não regrava nada e dá a mesma árvore', async () => {
    const target = path.join(newDir(), 'marketplace');
    const first = await deployCapture({ sourceDir: SOURCE_DIR, targetDir: target });
    assert.deepEqual(snapshot(target), snapshot(SOURCE_DIR));
    assert.ok(first.every((step) => step.op === 'write'));

    const second = await deployCapture({ sourceDir: SOURCE_DIR, targetDir: target });
    assert.ok(second.every((step) => step.op === 'unchanged'), JSON.stringify(second));
    assert.deepEqual(snapshot(target), snapshot(SOURCE_DIR));
  });

  it('substitui a cópia anterior: grava o que mudou e só depois remove o que saiu da fonte', async () => {
    const source = sourceCopy();
    const target = path.join(newDir(), 'marketplace');
    mkdirSync(path.join(source, 'plugins', 'agent-quest', 'antigo'), { recursive: true });
    writeFileSync(path.join(source, 'plugins', 'agent-quest', 'antigo', 'velho.txt'), 'velho');
    await deployCapture({ sourceDir: source, targetDir: target });

    rmSync(path.join(source, 'plugins', 'agent-quest', 'antigo'), { recursive: true });
    writeFileSync(path.join(source, FORWARDER_FILE), `${readFileSync(path.join(source, FORWARDER_FILE), 'utf8')}\n// nova versão\n`);
    // Sobras na cópia: temporário de um deploy interrompido e uma pasta vazia.
    writeFileSync(path.join(target, `${FORWARDER_FILE}.123.abcd.tmp`), 'pela metade');
    mkdirSync(path.join(target, 'vazia', 'dentro'), { recursive: true });

    const steps = await deployCapture({ sourceDir: source, targetDir: target });
    assert.deepEqual(snapshot(target), snapshot(source));
    assert.equal(existsSync(path.join(target, 'vazia')), false);
    assert.equal(existsSync(path.join(target, 'plugins', 'agent-quest', 'antigo')), false);

    const writes = steps.filter((s) => s.op === 'write').map((s) => s.file);
    const removes = steps.filter((s) => s.op === 'remove').map((s) => s.file);
    assert.deepEqual(writes, [FORWARDER_FILE]);
    assert.deepEqual(removes.sort(), [path.join('plugins', 'agent-quest', 'antigo', 'velho.txt'), `${FORWARDER_FILE}.123.abcd.tmp`].sort());
    const lastWrite = steps.findLastIndex((s) => s.op === 'write');
    const firstRemove = steps.findIndex((s) => s.op === 'remove');
    assert.ok(lastWrite < firstRemove, 'remoções só depois de todas as gravações');
  });

  it('quem lê durante o deploy nunca vê arquivo pela metade (temporário + rename)', async () => {
    const source = sourceCopy();
    const target = path.join(newDir(), 'marketplace');
    const original = readFileSync(path.join(source, FORWARDER_FILE), 'utf8');
    const versions = [`${original}\n// A ${'a'.repeat(200_000)}\n`, `${original}\n// B ${'b'.repeat(200_000)}\n`];
    writeFileSync(path.join(source, FORWARDER_FILE), versions[0]);
    await deployCapture({ sourceDir: source, targetDir: target });

    let stop = false;
    let reads = 0;
    const problems = [];
    // Um leitor que abre o arquivo de tempos em tempos, como encaminhadores começando.
    const reader = (async () => {
      while (!stop) {
        try {
          const text = await readFile(path.join(target, FORWARDER_FILE), 'utf8');
          reads++;
          if (!versions.includes(text)) problems.push(`conteúdo parcial (${text.length} caracteres)`);
        } catch (err) {
          problems.push(err.code);
        }
        await sleep(10);
      }
    })();
    for (let i = 1; i <= 12; i++) {
      writeFileSync(path.join(source, FORWARDER_FILE), versions[i % 2]);
      await deployCapture({ sourceDir: source, targetDir: target });
    }
    stop = true;
    await reader;
    assert.ok(reads > 0);
    assert.deepEqual(problems, []);
    assert.deepEqual(readdirSync(path.dirname(path.join(target, FORWARDER_FILE))), ['forward.mjs'], 'sem temporário sobrando');
  });
});

describe('runDeploy (npm run capture:deploy)', () => {
  const quiet = () => {
    const out = [];
    const err = [];
    return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
  };

  it('copia para <dados>/marketplace e imprime os comandos com o caminho completo', async () => {
    const home = newDir();
    const io = quiet();
    const code = await runDeploy({ env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, ...io });
    assert.equal(code, 0, io.err.join('\n'));
    const target = path.join(home, 'marketplace');
    assert.deepEqual(snapshot(target), snapshot(SOURCE_DIR));

    const text = io.out.join('\n');
    const plugin = path.join(target, 'plugins', 'agent-quest');
    for (const expected of [
      `claude plugin marketplace add "${target}"`,
      'claude plugin install agent-quest@agent-quest-local',
      'claude plugin disable agent-quest@agent-quest-local',
      'claude plugin marketplace remove agent-quest-local',
      `claude --plugin-dir "${plugin}"`,
      '/reload-plugins',
      'não executa o claude',
    ]) {
      assert.ok(text.includes(expected), `faltou: ${expected}\n${text}`);
    }
  });

  it('imprime a versão copiada, lida do plugin.json da cópia (captura 0.1.3)', async () => {
    const home = newDir();
    const io = quiet();
    assert.equal(await runDeploy({ env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, ...io }), 0);
    const version = readJson(path.join(SOURCE_DIR, PLUGIN_FILE)).version;
    assert.equal(version, '0.1.3');
    assert.ok(io.out.includes(`  Versão da captura: ${version}`), io.out.join('\n'));
    assert.equal(await readCaptureVersion(path.join(home, 'marketplace')), version);
    assert.equal(await readCaptureVersion(newDir()), 'desconhecida', 'sem plugin.json');
  });

  it('rodar duas vezes dá o mesmo resultado', async () => {
    const home = newDir();
    const env = { AGENT_QUEST_HOME: home };
    const first = quiet();
    assert.equal(await runDeploy({ env, platform: process.platform, homedir: home, ...first }), 0);
    const tree = snapshot(path.join(home, 'marketplace'));
    const second = quiet();
    assert.equal(await runDeploy({ env, platform: process.platform, homedir: home, ...second }), 0);
    assert.deepEqual(snapshot(path.join(home, 'marketplace')), tree);
    assert.match(second.out.join('\n'), /0 arquivo\(s\) gravado\(s\), 4 sem mudança, 0 removido\(s\)/);
    assert.deepEqual(first.out.slice(2), second.out.slice(2), 'mesmos comandos');
  });

  it('captura inválida: nada é copiado, mensagem clara e código 1', async () => {
    const source = sourceCopy();
    const hooks = readJson(path.join(source, HOOKS_FILE));
    delete hooks.hooks.Stop;
    writeJson(path.join(source, HOOKS_FILE), hooks);
    const home = newDir();
    const io = quiet();
    const code = await runDeploy({ env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, sourceDir: source, ...io });
    assert.equal(code, 1);
    assert.match(io.err.join('\n'), /nada foi copiado/);
    assert.match(io.err.join('\n'), /eventos ausentes: Stop/);
    assert.equal(existsSync(path.join(home, 'marketplace')), false);
  });

  it('OneDrive: mesmo aviso do servidor, com a orientação do ADR 0005 (variável do usuário do Windows)', async () => {
    const base = newDir();
    const local = path.join(base, 'OneDrive', 'Local');
    const io = quiet();
    // Sem AGENT_QUEST_HOME: pasta padrão (LOCALAPPDATA temporário) dentro de um "OneDrive".
    assert.equal(await runDeploy({ env: { LOCALAPPDATA: local }, platform: 'win32', homedir: base, ...io }), 0);
    const dataDir = path.win32.join(local, 'agent-quest');
    const text = io.out.join('\n');
    assert.ok(io.out.includes(oneDriveWarning(dataDir)), text);
    assert.match(oneDriveWarning(dataDir), /variável de ambiente do usuário do Windows/);
    assert.match(oneDriveWarning(dataDir), /reabra os terminais e o VS Code/);
    const server = resolveConfig({ argv: [], env: { LOCALAPPDATA: local }, platform: 'win32', homedir: base });
    assert.ok(server.warnings.includes(oneDriveWarning(dataDir)), 'o servidor usa o mesmo texto');
    assert.doesNotMatch(text, /AGENT_QUEST_HOME está definida/);
  });

  it('com AGENT_QUEST_HOME definida: avisa que servidor, capture:deploy e Claude Code precisam ver o mesmo valor', async () => {
    const home = newDir();
    const io = quiet();
    assert.equal(await runDeploy({ env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, ...io }), 0);
    assert.ok(io.out.includes(agentQuestHomeWarning(home)), io.out.join('\n'));
    const warning = agentQuestHomeWarning(home);
    for (const expected of ['servidor', 'capture:deploy', 'Claude Code', 'mesmo valor', 'variável de ambiente do usuário do Windows']) {
      assert.ok(warning.includes(expected), `faltou "${expected}": ${warning}`);
    }
  });

  it('deploy interrompido no meio: código 1 e aviso de que a instalação pode estar misturada', async () => {
    const home = newDir();
    const env = { AGENT_QUEST_HOME: home };
    assert.equal(await runDeploy({ env, platform: process.platform, homedir: home, ...quiet() }), 0);
    const target = path.join(home, 'marketplace');
    // Fonte com tudo mudado; na cópia, uma pasta no lugar do hooks.json faz a gravação dele falhar.
    const source = sourceCopy();
    for (const file of [MARKETPLACE_FILE, PLUGIN_FILE, HOOKS_FILE]) {
      const data = readJson(path.join(source, file));
      data.description = 'versão nova';
      writeJson(path.join(source, file), data);
    }
    rmSync(path.join(target, HOOKS_FILE));
    mkdirSync(path.join(target, HOOKS_FILE, 'trava'), { recursive: true });

    const io = quiet();
    const code = await runDeploy({ env, platform: process.platform, homedir: home, sourceDir: source, ...io });
    assert.equal(code, 1);
    const text = io.err.join('\n');
    assert.match(text, /Não foi possível copiar a captura/);
    assert.match(text, /inteiro/);
    assert.match(text, /misturada/);
    assert.match(text, /Rode o deploy de novo/);
    assert.doesNotMatch(text, /continuam inteiros/);
    // Estado misturado de verdade: o marketplace.json (antes na ordem) já é o novo.
    assert.equal(readJson(path.join(target, MARKETPLACE_FILE)).description, 'versão nova');
  });

  it('sem AGENT_QUEST_HOME e fora do OneDrive: nenhum aviso', async () => {
    const base = newDir();
    const io = quiet();
    assert.equal(await runDeploy({ env: { LOCALAPPDATA: path.join(base, 'Local') }, platform: 'win32', homedir: base, ...io }), 0);
    assert.doesNotMatch(io.out.join('\n'), /Aviso:/);
  });

  it('o plugin.json da cópia é o mesmo da fonte', async () => {
    const home = newDir();
    await runDeploy({ env: { AGENT_QUEST_HOME: home }, platform: process.platform, homedir: home, ...quiet() });
    assert.deepEqual(readJson(path.join(home, 'marketplace', PLUGIN_FILE)), readJson(path.join(SOURCE_DIR, PLUGIN_FILE)));
  });
});

describe('script de deploy pela linha de comando', () => {
  it('nunca executa o claude: não usa child_process', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(source, /child_process|\bexec\(|\bspawn\(/);
  });

  it('node scripts/deploy-capture.mjs: saída 0, cópia feita e nenhum "claude" chamado', () => {
    const home = newDir();
    // Um "claude" falso no início do PATH denunciaria qualquer chamada.
    const fakeBin = newDir();
    const marker = path.join(fakeBin, 'chamado.txt');
    writeFileSync(path.join(fakeBin, 'claude.cmd'), `@echo off\r\necho x > "${marker}"\r\n`);
    writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\necho x > "${marker}"\n`, { mode: 0o755 });
    const env = {};
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
    env.AGENT_QUEST_HOME = home;
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Captura copiada para/);
    assert.match(result.stdout, /Versão da captura: \d+\.\d+\.\d+/);
    assert.ok(result.stdout.includes(path.join(home, 'marketplace')), result.stdout);
    assert.equal(existsSync(path.join(home, 'marketplace', FORWARDER_FILE)), true);
    assert.equal(existsSync(marker), false, 'o script chamou o claude');
  });
});
