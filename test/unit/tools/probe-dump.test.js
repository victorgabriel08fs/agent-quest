// O dump.mjs roda como hook assíncrono do Claude Code: em qualquer caso, sai
// com código 0 e não escreve nada em stdout nem em stderr (ADR 0001).
// Os testes usam sempre um AGENT_QUEST_HOME (ou LOCALAPPDATA) temporário.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DUMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/probe/plugin/scripts/dump.mjs');
const INHERITED = /^(CLAUDE|TERM_PROGRAM|VSCODE_|WT_SESSION$|AGENT_QUEST_HOME$|LOCALAPPDATA$|XDG_STATE_HOME$)/i;

let tmp;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aq-probe-dump-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Ambiente do processo atual sem as variáveis que o teste controla (o teste pode rodar dentro do Claude Code). */
function cleanEnv(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!INHERITED.test(name)) env[name] = value;
  return { ...env, ...extra };
}

function homeFor(name) {
  return path.join(tmp, name);
}

function eventsFile(home) {
  return path.join(home, 'probe', 'events.jsonl');
}

function readRecords(home) {
  return readFileSync(eventsFile(home), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

/**
 * Roda o dump.mjs como o Claude Code faria: processo filho, JSON no stdin.
 * @param {{ env: Record<string, string>, input?: string|Buffer, keepStdinOpen?: boolean }} options
 */
function runDump({ env, input, keepStdinOpen = false }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [DUMP], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {}); // o filho pode sair antes de ler tudo
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    if (!keepStdinOpen) child.stdin.end(input ?? '');
  });
}

function assertSilentSuccess(result) {
  assert.equal(result.code, 0, 'código de saída');
  assert.equal(result.stdout, '', 'stdout vazio');
  assert.equal(result.stderr, '', 'stderr vazio');
}

const samplePayload = {
  session_id: 'sess-1',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'node -e "console.log(1)"' },
  tool_use_id: 'toolu_1',
};

describe('dump.mjs como processo filho', () => {
  it('caso normal: grava o payload, os tempos e só os nomes e valores permitidos do ambiente', async () => {
    const home = homeFor('normal');
    const input = JSON.stringify(samplePayload);
    const startedAt = Date.now();
    const result = await runDump({
      input,
      env: cleanEnv({
        AGENT_QUEST_HOME: home,
        CLAUDE_PROJECT_DIR: 'C:\\projeto',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_OAUTH_TOKEN: 'segredo-que-nao-pode-ser-gravado',
        CLAUDECODE: '1',
        TERM_PROGRAM: 'vscode',
        TERM_PROGRAM_VERSION: '1.99.0',
        VSCODE_PID: '1234',
        WT_SESSION: 'guid',
        AQ_OUTRA_VARIAVEL: 'x',
      }),
    });
    assertSilentSuccess(result);
    const [record] = readRecords(home);
    assert.equal(record.probe, 1);
    assert.deepEqual(record.payload, samplePayload);
    assert.equal(record.bytes, Buffer.byteLength(input));
    assert.ok(record.receivedAt >= startedAt && record.writtenAt >= record.receivedAt);
    assert.equal(record.error, undefined);

    for (const name of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_PID', 'WT_SESSION']) {
      assert.ok(record.env.names.includes(name), `nome ${name}`);
    }
    assert.ok(!record.env.names.includes('AQ_OUTRA_VARIAVEL'));
    assert.ok(!record.env.names.includes('PATH') && !record.env.names.includes('Path'));
    assert.deepEqual(record.env.values, { CLAUDE_PROJECT_DIR: 'C:\\projeto', CLAUDE_CODE_ENTRYPOINT: 'cli', TERM_PROGRAM: 'vscode' });
    assert.ok(!readFileSync(eventsFile(home), 'utf8').includes('segredo-que-nao-pode-ser-gravado'));
  });

  it('acrescenta uma linha por execução, sem apagar as anteriores', async () => {
    const home = homeFor('acrescenta');
    const env = cleanEnv({ AGENT_QUEST_HOME: home });
    assertSilentSuccess(await runDump({ env, input: JSON.stringify({ ...samplePayload, tool_use_id: 'a' }) }));
    assertSilentSuccess(await runDump({ env, input: JSON.stringify({ ...samplePayload, tool_use_id: 'b' }) }));
    assert.deepEqual(readRecords(home).map((r) => r.payload.tool_use_id), ['a', 'b']);
  });

  it('stdin inválido: grava o erro e o início do texto, sem payload', async () => {
    const home = homeFor('invalido');
    assertSilentSuccess(await runDump({ env: cleanEnv({ AGENT_QUEST_HOME: home }), input: 'isto não é json {' }));
    const [record] = readRecords(home);
    assert.equal(record.error, 'invalid-json');
    assert.equal(record.head, 'isto não é json {');
    assert.equal(record.payload, undefined);
  });

  it('stdin vazio: grava o erro "empty"', async () => {
    const home = homeFor('vazio');
    assertSilentSuccess(await runDump({ env: cleanEnv({ AGENT_QUEST_HOME: home }), input: '' }));
    assert.equal(readRecords(home)[0].error, 'empty');
  });

  it('stdin grande (10 MiB): grava o payload inteiro', async () => {
    const home = homeFor('grande');
    const big = 'x'.repeat(10 * 1024 * 1024);
    const input = JSON.stringify({ ...samplePayload, hook_event_name: 'PostToolUse', tool_response: { stdout: big } });
    const result = await runDump({ env: cleanEnv({ AGENT_QUEST_HOME: home }), input });
    assertSilentSuccess(result);
    const [record] = readRecords(home);
    assert.equal(record.payload.tool_response.stdout.length, big.length);
    assert.equal(record.bytes, Buffer.byteLength(input));
  });

  it('stdin acima de 16 MiB: grava só o tamanho e o nome do evento', async () => {
    const home = homeFor('acima-do-limite');
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_response: { stdout: 'y'.repeat(17 * 1024 * 1024) } });
    assertSilentSuccess(await runDump({ env: cleanEnv({ AGENT_QUEST_HOME: home }), input }));
    const [record] = readRecords(home);
    assert.equal(record.error, 'too-large');
    assert.equal(record.hookEventName, 'PostToolUse');
    assert.equal(record.bytes, Buffer.byteLength(input));
    assert.equal(record.payload, undefined);
  });

  it('diretório inexistente: cria as pastas e grava', async () => {
    const home = path.join(tmp, 'nao', 'existe', 'ainda');
    assertSilentSuccess(await runDump({ env: cleanEnv({ AGENT_QUEST_HOME: home }), input: JSON.stringify(samplePayload) }));
    assert.equal(readRecords(home).length, 1);
  });

  it('diretório impossível de criar: sai com 0 e em silêncio', async () => {
    const file = path.join(tmp, 'um-arquivo');
    writeFileSync(file, 'não é pasta');
    const home = path.join(file, 'sub');
    assertSilentSuccess(await runDump({ env: cleanEnv({ AGENT_QUEST_HOME: home }), input: JSON.stringify(samplePayload) }));
    assert.equal(existsSync(eventsFile(home)), false);
  });

  it('sem AGENT_QUEST_HOME, usa %LOCALAPPDATA%\\agent-quest (ou o diretório de estado fora do Windows)', async () => {
    const base = homeFor('localappdata');
    const extra = process.platform === 'win32' ? { LOCALAPPDATA: base } : { XDG_STATE_HOME: base };
    assertSilentSuccess(await runDump({ env: cleanEnv(extra), input: JSON.stringify(samplePayload) }));
    assert.equal(readRecords(path.join(base, 'agent-quest')).length, 1);
  });

  it('20 execuções em paralelo: 20 linhas válidas, sem mistura', async () => {
    const home = homeFor('paralelo');
    const env = cleanEnv({ AGENT_QUEST_HOME: home });
    const filler = 'z'.repeat(64 * 1024);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => runDump({
      env,
      input: JSON.stringify({ ...samplePayload, tool_use_id: `t${i}`, tool_input: { command: filler } }),
    })));
    for (const result of results) assertSilentSuccess(result);
    const ids = readRecords(home).map((r) => r.payload.tool_use_id).sort();
    assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => `t${i}`).sort());
  });

  it('stdin que nunca fecha: desiste sozinho no prazo e sai com 0', async () => {
    const home = homeFor('stdin-aberto');
    const result = await runDump({ env: cleanEnv({ AGENT_QUEST_HOME: home }), keepStdinOpen: true });
    assertSilentSuccess(result);
    assert.ok(result.ms < 8000, `levou ${result.ms} ms`);
    assert.equal(readRecords(home)[0].error, 'stdin-timeout');
  });
});
