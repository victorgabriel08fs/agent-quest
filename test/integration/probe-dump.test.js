// Integração da sonda do T0 (tester): plugin conferido contra o ADR 0001 e o
// dump.mjs rodado como o Claude Code roda, um processo filho por evento, nos
// caminhos ruins que os unitários não cobrem.
//
// Regras do ADR 0001 conferidas aqui: o dump nunca escreve em stdout nem em
// stderr, sempre sai com código 0 e se encerra sozinho; grava só em
// <AGENT_QUEST_HOME>\probe\ ou %LOCALAPPDATA%\agent-quest\probe\; do ambiente,
// grava só nomes e, de valores, só os três permitidos (ADR 0010, complemento).
// Nenhum teste usa o diretório de dados real: o ambiente do filho não herda
// AGENT_QUEST_HOME, LOCALAPPDATA, USERPROFILE nem HOME.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PLUGIN = path.join(REPO, 'tools', 'probe', 'plugin');
const DUMP = path.join(PLUGIN, 'scripts', 'dump.mjs');
const ADR_0001 = path.join(REPO, 'docs', 'adr', '0001-captura-por-hooks-command-assincronos.md');
const EXTRA_EVENTS = ['TaskCreated', 'TaskCompleted', 'PostToolBatch'];

// Variáveis que o filho nunca herda: as que o dump lê (dados e ambiente) e as da pasta pessoal.
const CONTROLLED = /^(CLAUDE|TERM_PROGRAM|VSCODE_|WT_SESSION$|AGENT_QUEST_HOME$|LOCALAPPDATA$|XDG_STATE_HOME$|USERPROFILE$|HOME$|HOMEDRIVE$|HOMEPATH$)/i;

let tmp;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aq-int-probe-dump-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function baseEnv(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!CONTROLLED.test(name)) env[name] = value;
  // Pasta pessoal falsa: se o dump cair no padrão por engano, cai aqui, não no diretório real.
  const fakeHome = path.join(tmp, 'pasta-pessoal-falsa');
  return { ...env, USERPROFILE: fakeHome, HOME: fakeHome, ...extra };
}

function newDir(name) {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Lista todos os arquivos (caminhos relativos) de uma pasta, recursivamente. */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).replaceAll('\\', '/'))
    .sort();
}

function readRecords(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Roda o dump.mjs como processo filho.
 * @param {{ env: Record<string,string>, cwd?: string, input?: string|Buffer, stdin?: 'pipe'|'ignore',
 *   keepOpen?: boolean, stream?: boolean }} options
 */
function runDump({ env, cwd = tmp, input, stdin = 'pipe', keepOpen = false, stream = false }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [DUMP], { env, cwd, stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = null;
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearInterval(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
    if (stdin !== 'pipe') return;
    child.stdin.on('error', () => {}); // o filho sai antes de ler tudo
    if (stream) {
      // Fluxo que nunca termina: 256 KiB a cada 5 ms, até o filho sair.
      const chunk = Buffer.alloc(256 * 1024, 'x');
      child.stdin.write('{"hook_event_name":"PostToolUse","tool_response":"');
      timer = setInterval(() => { if (!child.stdin.destroyed) child.stdin.write(chunk); }, 5);
      return;
    }
    if (input !== undefined) child.stdin.write(input);
    if (!keepOpen) child.stdin.end();
  });
}

function assertSilentZero(result, label = '') {
  assert.equal(result.code, 0, `${label} código de saída (sinal ${result.signal})`);
  assert.equal(result.stdout, '', `${label} stdout`);
  assert.equal(result.stderr, '', `${label} stderr`);
}

const payload = (extra = {}) => JSON.stringify({
  session_id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_input: { command: 'node -e "console.log(1)"' }, tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv', ...extra,
});

describe('plugin da sonda contra o ADR 0001', () => {
  it('hooks.json tem exatamente os 15 eventos do ADR 0001 (lidos do próprio ADR) mais os 3 de registro', () => {
    const adr = readFileSync(ADR_0001, 'utf8');
    const line = adr.split('\n').find((l) => l.startsWith('Eventos assinados (15)'));
    assert.ok(line, 'linha "Eventos assinados (15)" no ADR 0001');
    // A lista vem depois dos dois-pontos ("... sem `matcher`, porque o filtro fica no servidor: `SessionStart`, ...").
    const adrEvents = [...line.slice(line.indexOf(':')).matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
    assert.equal(adrEvents.length, 15, `eventos do ADR: ${adrEvents.join(', ')}`);
    const { hooks } = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(hooks).sort(), [...adrEvents, ...EXTRA_EVENTS].sort());
    for (const excluded of ['MessageDisplay']) assert.ok(!(excluded in hooks), `${excluded} fica de fora (ADR 0001)`);
  });

  it('todo hook é command em forma exec (node + args, sem shell), async, sem matcher, sem timeout, e aponta para o dump.mjs que existe', () => {
    const { hooks } = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
    for (const [event, groups] of Object.entries(hooks)) {
      for (const group of groups) {
        assert.ok(!('matcher' in group), `${event}: sem matcher`);
        for (const hook of group.hooks) {
          assert.equal(hook.type, 'command', event);
          assert.equal(hook.command, 'node', `${event}: forma exec, sem caminho nem shell`);
          assert.equal(hook.async, true, `${event}: async`);
          assert.ok(Array.isArray(hook.args) && hook.args.length === 1, `${event}: args`);
          assert.ok(!('shell' in hook), `${event}: sem shell`);
          const resolved = hook.args[0].replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN);
          assert.equal(path.resolve(resolved), DUMP, `${event}: aponta para o dump.mjs`);
        }
      }
    }
    assert.ok(existsSync(DUMP));
  });

  it('o plugin só tem o manifesto, os hooks, o dump e o probe-worker', () => {
    assert.deepEqual(listFiles(PLUGIN), ['.claude-plugin/plugin.json', 'agents/probe-worker.md', 'hooks/hooks.json', 'scripts/dump.mjs']);
  });
});

// Em sequência de propósito: a suíte roda os arquivos em paralelo, e há testes de tempo em outros arquivos.
describe('dump.mjs: caminhos ruins', () => {
  it('fluxo de stdin que nunca termina: sai sozinho com 0, em silêncio, em poucos segundos', async () => {
    const home = newDir('fluxo-infinito');
    const result = await runDump({ env: baseEnv({ AGENT_QUEST_HOME: home }), stream: true });
    assertSilentZero(result);
    assert.ok(result.ms < 7000, `levou ${result.ms} ms`);
    const [record] = readRecords(path.join(home, 'probe', 'events.jsonl'));
    assert.equal(record.payload, undefined, 'sem payload');
    assert.ok(['stdin-timeout', 'too-large'].includes(record.error), `erro ${record.error}`);
  });

  it('JSON pela metade e stdin aberto: desiste no prazo, grava o erro, sai com 0', async () => {
    const home = newDir('meio-json');
    const result = await runDump({ env: baseEnv({ AGENT_QUEST_HOME: home }), input: '{"hook_event_name":"Stop","x":', keepOpen: true });
    assertSilentZero(result);
    assert.ok(result.ms < 7000, `levou ${result.ms} ms`);
    const [record] = readRecords(path.join(home, 'probe', 'events.jsonl'));
    assert.equal(record.error, 'stdin-timeout');
    assert.equal(record.payload, undefined);
  });

  it('sem stdin (descritor ignorado): sai com 0 e em silêncio', async () => {
    const home = newDir('sem-stdin');
    assertSilentZero(await runDump({ env: baseEnv({ AGENT_QUEST_HOME: home }), stdin: 'ignore' }));
  });

  it('JSON aninhado em profundidade extrema: sai com 0 e em silêncio', async () => {
    const home = newDir('aninhado');
    const depth = 500_000;
    const input = `{"hook_event_name":"PreToolUse","x":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    const result = await runDump({ env: baseEnv({ AGENT_QUEST_HOME: home }), input });
    assertSilentZero(result);
  });

  it('bytes inválidos, BOM, UTF-16 e NUL: sai com 0 e em silêncio, sem payload inventado', async () => {
    const cases = {
      'utf8-invalido': Buffer.from([0x7b, 0xff, 0xfe, 0xc3, 0x28, 0x7d]),
      'utf16le-bom': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload(), 'utf16le')]),
      nul: Buffer.from('\u0000\u0000{"a":1}\u0000'),
      'so-espacos': Buffer.from('   \r\n\t  '),
    };
    for (const [name, input] of Object.entries(cases)) {
      const home = newDir(`bytes-${name}`);
      const result = await runDump({ env: baseEnv({ AGENT_QUEST_HOME: home }), input });
      assertSilentZero(result, name);
      const records = readRecords(path.join(home, 'probe', 'events.jsonl'));
      assert.equal(records.length, 1, name);
      assert.equal(records[0].payload, undefined, `${name}: sem payload`);
      assert.ok(records[0].error, `${name}: com erro`);
    }
  });

  it('BOM UTF-8 antes do JSON: grava o payload normalmente', async () => {
    const home = newDir('bom-utf8');
    assertSilentZero(await runDump({ env: baseEnv({ AGENT_QUEST_HOME: home }), input: `\uFEFF${payload()}` }));
    assert.equal(readRecords(path.join(home, 'probe', 'events.jsonl'))[0].payload.hook_event_name, 'PreToolUse');
  });

  it('events.jsonl é uma pasta, é somente leitura, ou o caminho tem caracteres inválidos: sai com 0 e em silêncio', async () => {
    const asDir = newDir('arquivo-e-pasta');
    mkdirSync(path.join(asDir, 'probe', 'events.jsonl'), { recursive: true });
    assertSilentZero(await runDump({ env: baseEnv({ AGENT_QUEST_HOME: asDir }), input: payload() }), 'pasta');

    const readOnly = newDir('somente-leitura');
    const file = path.join(readOnly, 'probe', 'events.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    chmodSync(file, 0o444);
    try {
      assertSilentZero(await runDump({ env: baseEnv({ AGENT_QUEST_HOME: readOnly }), input: payload() }), 'somente leitura');
      assert.equal(readFileSync(file, 'utf8'), '', 'nada gravado no arquivo protegido');
    } finally {
      chmodSync(file, 0o666);
    }

    const invalid = process.platform === 'win32' ? path.join(tmp, 'inva|lido<>') : '/proc/nao-existe/x';
    assertSilentZero(await runDump({ env: baseEnv({ AGENT_QUEST_HOME: invalid }), input: payload() }), 'caminho inválido');
  });

  it('nunca grava na pasta atual (o repositório, no Claude Code): só em <LOCALAPPDATA>\\agent-quest\\probe\\', async () => {
    const fakeRepo = newDir('repo-falso');
    writeFileSync(path.join(fakeRepo, 'CLAUDE.md'), '# repo falso\n');
    const local = newDir('localappdata');
    const extra = process.platform === 'win32' ? { LOCALAPPDATA: local } : { XDG_STATE_HOME: local };
    const result = await runDump({
      env: baseEnv({ ...extra, CLAUDE_PROJECT_DIR: fakeRepo }), cwd: fakeRepo, input: payload(),
    });
    assertSilentZero(result);
    assert.deepEqual(listFiles(fakeRepo), ['CLAUDE.md'], 'nada criado no repositório');
    assert.deepEqual(listFiles(local), ['agent-quest/probe/events.jsonl'], 'só o events.jsonl, no lugar certo');
    assert.deepEqual(listFiles(path.join(tmp, 'pasta-pessoal-falsa')), [], 'nada na pasta pessoal');
  });

  it('com AGENT_QUEST_HOME, grava só <AGENT_QUEST_HOME>\\probe\\events.jsonl e nada mais', async () => {
    const home = newDir('so-o-jsonl');
    const local = newDir('localappdata-nao-usado');
    const result = await runDump({ env: baseEnv({ AGENT_QUEST_HOME: home, LOCALAPPDATA: local }), input: payload() });
    assertSilentZero(result);
    assert.deepEqual(listFiles(home), ['probe/events.jsonl']);
    assert.deepEqual(listFiles(local), []);
  });

  it('ambiente: só nomes das famílias permitidas e valores só dos três permitidos, mesmo com segredos em CLAUDE_*', async () => {
    const home = newDir('ambiente');
    const secrets = {
      CLAUDE_CODE_OAUTH_TOKEN: 'SEGREDO-OAUTH-1234567890',
      CLAUDE_API_KEY: 'sk-ant-api03-SEGREDOSEGREDOSEGREDO',
      claude_minusculo_secret: 'SEGREDO-MINUSCULO',
      CLAUDE_CODE_SSE_PORT: 'SEGREDO-PORTA',
      VSCODE_GIT_ASKPASS_MAIN: 'SEGREDO-ASKPASS',
      WT_SESSION: 'SEGREDO-GUID',
      TERM_PROGRAM_VERSION: 'SEGREDO-VERSAO',
      ANTHROPIC_API_KEY: 'SEGREDO-ANTHROPIC',
      GITHUB_TOKEN: 'SEGREDO-GITHUB',
    };
    const longDir = `C:\\projeto\\${'p'.repeat(400)}`;
    const env = baseEnv({
      AGENT_QUEST_HOME: home,
      ...secrets,
      CLAUDE_PROJECT_DIR: longDir,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      TERM_PROGRAM: 'vscode',
    });
    assertSilentZero(await runDump({ env, input: payload() }));
    const text = readFileSync(path.join(home, 'probe', 'events.jsonl'), 'utf8');
    for (const [name, value] of Object.entries(secrets)) assert.ok(!text.includes(value), `valor de ${name} não pode ser gravado`);
    const [record] = readRecords(path.join(home, 'probe', 'events.jsonl'));
    assert.deepEqual(Object.keys(record.env.values).sort(), ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR', 'TERM_PROGRAM']);
    assert.ok(record.env.values.CLAUDE_PROJECT_DIR.length <= 300, 'valor cortado');
    for (const name of record.env.names) assert.match(name, /^(CLAUDE|TERM_PROGRAM|VSCODE_|WT_SESSION$)/i, name);
    assert.ok(!record.env.names.includes('ANTHROPIC_API_KEY') && !record.env.names.includes('GITHUB_TOKEN'));
    assert.ok(record.env.names.includes('claude_minusculo_secret'), 'nome em minúsculas também é só nome');
  });

  it('12 eventos de 1 MiB em paralelo: 12 linhas JSON inteiras, sem mistura', async () => {
    const home = newDir('paralelo-grande');
    const env = baseEnv({ AGENT_QUEST_HOME: home });
    const filler = 'q'.repeat(1024 * 1024);
    const n = 12;
    const results = await Promise.all(Array.from({ length: n }, (_, i) => runDump({
      env, input: payload({ tool_use_id: `toolu_${i}`, tool_input: { command: filler } }),
    })));
    results.forEach((r, i) => assertSilentZero(r, `#${i}`));
    const records = readRecords(path.join(home, 'probe', 'events.jsonl'));
    assert.equal(records.length, n);
    assert.deepEqual(records.map((r) => r.payload.tool_use_id).sort(), Array.from({ length: n }, (_, i) => `toolu_${i}`).sort());
    for (const r of records) assert.equal(r.payload.tool_input.command.length, filler.length);
  });
});
