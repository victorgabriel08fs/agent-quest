// Integração da captura 0.1.3 (tester; plano, T4, "Captura 0.1.3", e passo 2 do
// "Caminho até a Primeira luz"). O encaminhador real roda como processo filho,
// como o Claude Code o roda, contra um servidor HTTP de teste que grava o corpo
// cru (porta sorteada, nunca a 47821; AGENT_QUEST_HOME temporário).
//
// Confere, com o envelope exatamente como sai do processo:
// - nenhuma variável de ambiente além de CLAUDE_PROJECT_DIR e
//   CLAUDE_CODE_ENTRYPOINT (validada) sai no corpo, nem mesmo com um ambiente
//   cheio de iscas parecidas com o ambiente do Claude Code e do VS Code;
// - o preâmbulo <browser_instruction> sai só do prompt do UserPromptSubmit, só
//   o primeiro bloco, só com o fechamento nas primeiras 65 536 unidades;
// - segredos dentro do bloco não saem da máquina do encaminhador; os de depois
//   do bloco saem (o servidor redige) e chegam redigidos no título do fato;
// - prompts gigantes e payloads malformados: saída 0, silêncio e prazo.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  STUCK_LIMIT_MS,
  assertLifetimeWithin,
  assertSilentExit,
  cleanupTemps,
  forwarderEnv,
  hookPayload,
  newTemp,
  recordingHttpServer,
  runForwarder,
  withLoadSamples,
  writeRuntime,
} from './capture-helpers.js';
import { REPO } from './server-helpers.js';
import { normalize } from '../../server/domain/normalize.js';

const OPEN = '<browser_instruction>';
const CLOSE = '</browser_instruction>';
/** Bloco no formato observado no T0 (cenário vscode): cerca de 4,1 mil caracteres. */
const BLOCK = `${OPEN}\n${'You can control the integrated browser with the tools below. '.repeat(67)}\n${CLOSE}`;
const GHP_INSIDE = `ghp_${'I'.repeat(36)}`;
const KEY_AFTER = `sk-ant-api03-${'Q'.repeat(40)}`;

describe('captura 0.1.3 (tester): encaminhador real, preâmbulo e env.entrypoint', () => {
  let home;
  let server;

  before(async () => {
    home = newTemp('aq-int-013-');
    server = await recordingHttpServer();
    writeRuntime(home, { port: server.port, token: 'token-de-teste', pid: process.pid, version: 'teste', startedAt: new Date().toISOString() });
  });

  after(async () => {
    await server?.close();
    cleanupTemps();
  });

  /** Roda o encaminhador e devolve { result, envelope|null, raw } do pedido que ele fez. */
  async function send(payload, { env = {}, stdin } = {}) {
    const before = server.requests.length;
    const result = await runForwarder({
      env: forwarderEnv({ AGENT_QUEST_HOME: home, ...env }),
      stdin: stdin ?? JSON.stringify(payload),
    });
    assertSilentExit(result, 'encaminhador');
    const fresh = server.requests.slice(before);
    assert.ok(fresh.length <= 1, 'um processo do encaminhador fez mais de um POST');
    const raw = fresh[0]?.body ?? null;
    return { result, raw, envelope: raw === null ? null : JSON.parse(raw) };
  }

  const prompt = (text, extra = {}) => hookPayload({ hook_event_name: 'UserPromptSubmit', prompt: text, ...extra });

  // --- variáveis de ambiente ---------------------------------------------------

  it('ambiente cheio de iscas: só projectDir e entrypoint saem, e nenhum outro valor aparece no corpo', async () => {
    const decoys = {
      ANTHROPIC_API_KEY: 'ISCA-anthropic-0001',
      ANTHROPIC_AUTH_TOKEN: 'ISCA-auth-0002',
      CLAUDE_CODE_OAUTH_TOKEN: 'ISCA-oauth-0003',
      CLAUDE_CODE_SSE_PORT: '61999',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\ISCA\\bash.exe',
      CLAUDE_CODE_ENTRYPOINT_EXTRA: 'ISCA-entry-extra',
      CLAUDE_ENTRYPOINT: 'ISCA-entry-sem-code',
      CLAUDE_ENV_FILE: 'C:\\ISCA\\env-file',
      CLAUDE_PLUGIN_ROOT: 'C:\\ISCA\\plugin-root',
      CLAUDE_PLUGIN_DATA: 'C:\\ISCA\\plugin-data',
      CLAUDECODE: 'ISCA-claudecode',
      TERM_PROGRAM: 'ISCA-term-program',
      VSCODE_GIT_IPC_HANDLE: 'ISCA-vscode-ipc',
      VSCODE_PID: '424242',
      GITHUB_TOKEN: GHP_INSIDE,
      AWS_SECRET_ACCESS_KEY: 'ISCA/aws/0004',
      USERNAME: 'ISCA-usuario',
      COMPUTERNAME: 'ISCA-maquina',
    };
    const payload = prompt('Rode os testes');
    const { envelope, raw } = await send(payload, {
      env: { ...decoys, CLAUDE_PROJECT_DIR: 'C:\\Projetos\\p', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
    });
    assert.ok(envelope, 'o servidor de teste não recebeu o envelope');
    assert.deepEqual(envelope.env, { projectDir: 'C:\\Projetos\\p', entrypoint: 'claude-vscode' });
    assert.deepEqual(Object.keys(envelope).sort(), ['env', 'forwarder', 'payload', 'sentAt', 'truncated', 'v']);
    assert.deepEqual(envelope.payload, payload);
    for (const [name, value] of Object.entries(decoys)) {
      assert.ok(!raw.includes(value), `o corpo levou ${name}`);
    }
  });

  it('entrypoint fora do padrão vai null e o valor não aparece no corpo (inclusive um segredo com espaço)', async () => {
    for (const value of [`${KEY_AFTER} x`, 'claude vscode', 'x'.repeat(65), 'cli\n', 'cli;rm', 'ção', '']) {
      const { envelope, raw } = await send(hookPayload(), { env: { CLAUDE_CODE_ENTRYPOINT: value } });
      assert.ok(envelope, `sem envelope para ${JSON.stringify(value)}`);
      assert.equal(envelope.env.entrypoint, null, JSON.stringify(value));
      if (value.length > 3) assert.ok(!raw.includes(value.trim()), `o corpo levou o entrypoint inválido ${JSON.stringify(value)}`);
    }
    for (const value of ['cli', 'claude-vscode', 'sdk-ts', 'x'.repeat(64)]) {
      const { envelope } = await send(hookPayload(), { env: { CLAUDE_CODE_ENTRYPOINT: value } });
      assert.equal(envelope.env.entrypoint, value);
    }
  });

  // --- preâmbulo: cenário real do VS Code ---------------------------------------

  it('cenário real vscode: o UserPromptSubmit com o preâmbulo chega só com o pedido; os outros ficam iguais', async () => {
    const scenario = JSON.parse(readFileSync(path.join(REPO, 'test', 'fixtures', 'hooks', 'vscode.json'), 'utf8'));
    const prompts = scenario.events.filter((e) => e.payload.hook_event_name === 'UserPromptSubmit');
    assert.ok(prompts.length >= 3, 'o cenário vscode mudou');
    for (const { env, payload } of prompts) {
      // As fixtures são sanitizadas («texto#N:tamanho»); o bloco é remontado no tamanho real.
      const sent = { ...payload, prompt: payload.prompt.replace(/^<browser_instruction>«texto#\d+:\d+»<\/browser_instruction>/, BLOCK) };
      const user = sent.prompt.startsWith(OPEN) ? sent.prompt.slice(BLOCK.length) : null;
      const { envelope } = await send(sent, { env: { CLAUDE_CODE_ENTRYPOINT: env.entrypoint, CLAUDE_PROJECT_DIR: env.projectDir } });
      assert.ok(envelope, 'sem envelope');
      assert.equal(envelope.env.entrypoint, 'claude-vscode');
      assert.equal(envelope.truncated, false);
      assert.deepEqual({ ...envelope.payload, prompt: null }, { ...sent, prompt: null }, 'o resto do payload mudou');
      assert.equal(envelope.payload.prompt, user ?? sent.prompt);
      const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: 'C:\\Users\\usuario' });
      assert.equal(fact.client, 'vscode');
      assert.equal(fact.origin, sent.prompt.startsWith('<agent-message') ? 'system' : 'user', sent.prompt.slice(0, 40));
    }
  });

  // --- preâmbulo: tentativas de quebrar -------------------------------------------

  it('segredo dentro do bloco não sai; segredo depois do bloco sai e é redigido no título', async () => {
    const block = `${OPEN}\ntoken ${GHP_INSIDE}\n${CLOSE}`;
    const { envelope, raw } = await send(prompt(`${block}\n\nexport ANTHROPIC_API_KEY=${KEY_AFTER} e rode`));
    assert.ok(!raw.includes(GHP_INSIDE), 'o segredo de dentro do bloco saiu do encaminhador');
    assert.equal(envelope.payload.prompt, `export ANTHROPIC_API_KEY=${KEY_AFTER} e rode`);
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: 'C:\\Users\\usuario' });
    assert.ok(!JSON.stringify(fact).includes(KEY_AFTER.slice(13)), 'o segredo chegou ao fato');
    assert.match(fact.title, /•••/);
  });

  it('sem fechamento: fica como está e passa pelo corte normal (segredo do bloco segue para a redação do servidor)', async () => {
    const text = `${OPEN}\n${GHP_INSIDE} ${'a'.repeat(6000)} pedido`;
    const { envelope } = await send(prompt(text));
    assert.equal(envelope.truncated, true);
    assert.ok(envelope.payload.prompt.startsWith(`${OPEN}\n${GHP_INSIDE}`));
    assert.match(envelope.payload.prompt, /…\[cortado \d+ caracteres\]…/);
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: 'C:\\Users\\usuario' });
    assert.equal(fact.title, null);
    assert.equal(fact.origin, 'user');
  });

  it('fechamento na borda das 65 536 unidades: termina em 65 536 sai; termina em 65 537 fica', async () => {
    const at = (end) => `${OPEN}${'b'.repeat(end - OPEN.length - CLOSE.length)}${CLOSE}\n\nPedido curto`;
    assert.equal(at(65_536).indexOf(CLOSE) + CLOSE.length, 65_536);
    const inside = await send(prompt(at(65_536)));
    assert.equal(inside.envelope.payload.prompt, 'Pedido curto');
    assert.equal(inside.envelope.truncated, false);
    const outside = await send(prompt(at(65_537)));
    assert.equal(outside.envelope.truncated, true, 'sem tirar o bloco, o prompt passa pelo corte');
    assert.ok(outside.envelope.payload.prompt.startsWith(OPEN));
    // Capturas que não tiram o bloco: o título ainda sai do fim, depois do último fechamento.
    assert.equal(normalize(outside.envelope, { receivedAt: Date.now(), homeDir: 'C:\\' }).title, 'Pedido curto');
  });

  it('vários blocos: só o primeiro sai; o título do fato ignora o segundo', async () => {
    const { envelope } = await send(prompt(`${BLOCK}\n\n${OPEN}segundo${CLOSE}\n\nLeia o CLAUDE.md`));
    assert.equal(envelope.payload.prompt, `${OPEN}segundo${CLOSE}\n\nLeia o CLAUDE.md`);
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: 'C:\\' });
    assert.equal(fact.title, 'Leia o CLAUDE.md');
    assert.equal(fact.origin, 'user');
  });

  it('só o bloco, sem pedido: prompt vazio, sem truncated; título null, origem user', async () => {
    const { envelope } = await send(prompt(`  \n${BLOCK}\n\n \t`));
    assert.equal(envelope.payload.prompt, '');
    assert.equal(envelope.truncated, false);
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: 'C:\\' });
    assert.equal(fact.title, null);
    assert.equal(fact.origin, 'user');
  });

  it('nada muda: tag no meio, outro nome, maiúsculas, quebra de linha depois do nome, outro evento, prompt não texto', async () => {
    const SHORT = `${OPEN}
instrução curta
${CLOSE}`; // abaixo de 4 KiB, sem o corte normal
    const cases = [
      prompt(`Explique ${SHORT} depois`),
      prompt(`<browser_instructions>x</browser_instructions> Rode`),
      prompt(`<Browser_Instruction>x</Browser_Instruction> Rode`),
      prompt(`<browser_instruction\nid="1">x${CLOSE} Rode`),
      prompt(`<agent-message from="a1b2">${SHORT}</agent-message>`),
      hookPayload({ hook_event_name: 'PreToolUse', prompt: `${SHORT}Rode`, tool_input: { command: `${SHORT}Rode` } }),
      hookPayload({ hook_event_name: 'userpromptsubmit', prompt: `${SHORT}Rode` }),
      prompt(42),
      prompt(null),
      prompt([`${SHORT}Rode`]),
      prompt({ text: `${SHORT}Rode` }),
    ];
    for (const payload of cases) {
      const { envelope } = await send(payload);
      assert.ok(envelope, JSON.stringify(payload).slice(0, 80));
      assert.deepEqual(envelope.payload, payload, JSON.stringify(payload.prompt).slice(0, 60));
    }
  });

  it('payloads malformados: saída 0 em silêncio, com ou sem POST', async () => {
    const stdins = [
      '[{"hook_event_name":"UserPromptSubmit","prompt":"<browser_instruction>a</browser_instruction>b"}]',
      '"<browser_instruction>a</browser_instruction>b"',
      'null',
      '{"hook_event_name":"UserPromptSubmit","prompt":"<browser_instruction>a</browser_instruction>b"',
      '{"__proto__":{"hook_event_name":"UserPromptSubmit"},"session_id":"s","prompt":"<browser_instruction>a</browser_instruction>b"}',
      '{"hook_event_name":["UserPromptSubmit"],"session_id":"s","prompt":"<browser_instruction>a</browser_instruction>b"}',
      '{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"\\ud83d<browser_instruction>\\ud800</browser_instruction>\\udc00 x"}',
      '{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"<browser_instruction>\\udbff</browser_instruction>\\ud83d"}',
      '{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"<browser_instruction>a</browser_instruction>b","prompt":7}',
    ];
    for (const stdin of stdins) {
      const { envelope } = await send(null, { stdin });
      if (envelope) assert.equal(envelope.v, 1);
    }
    // Bytes inválidos de UTF-8 dentro do bloco.
    const bytes = Buffer.concat([
      Buffer.from('{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"<browser_instruction>'),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('</browser_instruction>\\n\\nRode"}'),
    ]);
    const { envelope } = await send(null, { stdin: bytes });
    assert.equal(envelope.payload.prompt, 'Rode');
  });

  it('o primeiro valor com o nome "__proto__" não engana: o preâmbulo vale só para o hook_event_name próprio', async () => {
    const stdin = '{"__proto__":{"hook_event_name":"UserPromptSubmit","prompt":"x"},"session_id":"s","prompt":"<browser_instruction>a</browser_instruction>b"}';
    const { envelope } = await send(null, { stdin });
    assert.ok(envelope);
    assert.equal(envelope.payload.prompt, '<browser_instruction>a</browser_instruction>b');
  });

  // --- prompts gigantes: orçamento de tempo (seção 1) ------------------------------

  it('prompts gigantes com o preâmbulo: saída 0, silêncio, no prazo de 2,2 s, corpo até 1 000 000 bytes', async (t) => {
    const MiB = 1024 * 1024;
    const cases = [
      // abaixo do atalho de 8 MiB: o bloco sai e o pedido passa pelo corte 1 KiB + 3 KiB
      { label: '7,9 MiB com fechamento', text: `${BLOCK}\n\nPedido ${'p'.repeat(Math.floor(7.9 * MiB))}`, expectStart: 'Pedido ' },
      // fechamento só no fim: não sai, e o corte normal vale
      { label: '7,9 MiB sem fechamento na janela', text: `${OPEN}${'q'.repeat(Math.floor(7.9 * MiB))}${CLOSE}fim`, expectStart: OPEN },
      // espaços iniciais que ocupam a janela inteira
      { label: '7,9 MiB de espaços antes do bloco', text: `${' '.repeat(Math.floor(7.9 * MiB))}${BLOCK}Pedido`, expectStart: ' ' },
      // acima do atalho: envelope de emergência, sem prompt
      { label: '15 MiB com fechamento', text: `${BLOCK}\n\n${'r'.repeat(15 * MiB)}`, expectStart: null },
    ];
    const results = [];
    const { samples } = await withLoadSamples(async () => {
      for (const c of cases) {
        const payload = prompt(c.text);
        const { result, raw, envelope } = await send(payload);
        results.push(result);
        t.diagnostic(`${c.label}: ${result.ownMs.toFixed(0)} ms de vida, corpo ${raw === null ? 'não enviado' : `${Buffer.byteLength(raw)} bytes`}`);
        if (!envelope) continue; // perda só por prazo (conferida pelo tempo abaixo)
        assert.ok(Buffer.byteLength(raw) <= 1_000_000, `${c.label}: corpo acima do teto`);
        assert.equal(envelope.truncated, true, c.label);
        assert.equal(envelope.payload.session_id, payload.session_id);
        assert.equal(envelope.payload.hook_event_name, 'UserPromptSubmit');
        if (c.expectStart === null) assert.equal(envelope.payload.prompt, undefined, `${c.label}: o atalho não leva prompt`);
        else if (typeof envelope.payload.prompt === 'string') assert.ok(envelope.payload.prompt.startsWith(c.expectStart), c.label);
      }
    });
    assertLifetimeWithin(t, 'prompts gigantes', results, samples, STUCK_LIMIT_MS);
  });
});
