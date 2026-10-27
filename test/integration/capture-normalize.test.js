// Integração do T5 (tester): captura real → servidor real → normalizador.
//
// O encaminhador do T4 roda como processo filho, como o Claude Code o roda, e
// manda o envelope ao servidor real do T3 (porta 0, AGENT_QUEST_HOME
// temporário, --debug-dump). Cada envelope gravado pelo dump, exatamente como
// chegou, passa pelo normalize() do T5. Confere o que só aparece com o
// envelope real:
// - os 15 hooks viram o fato certo, com projectDir vindo do CLAUDE_PROJECT_DIR
//   e o caminho do arquivo relativo ao projeto;
// - evento fora dos 15 é aceito pela ingestão (204) e vira null no normalizador;
// - strings acima de 4 KiB, cortadas pelo encaminhador (1 KiB do início + 3 KiB
//   do fim), continuam saindo redigidas, nos limites e como ponto fixo.
//
// Os testes marcados com `todo` reproduzem bugs abertos no relatório do tester.
// Eles rodam e mostram a falha, mas não deixam a suíte vermelha enquanto o
// problema não é resolvido; quem resolver tira o `todo`.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { charLength, redact } from '../../server/domain/redact.js';
import { normalize } from '../../server/domain/normalize.js';
import {
  assertDelivered,
  cleanupTemps,
  forwarderEnv,
  hookPayload,
  newTemp,
  runForwarder,
  startRealServer,
} from './capture-helpers.js';

const HOME = 'C:\\Users\\usuario';
const PROJECT = `${HOME}\\Projetos\\exemplo`;
const FORBIDDEN = ['content', 'old_string', 'new_string', 'stdout', 'stderr', 'tool_input', 'tool_response', 'last_assistant_message'];

/** Campos próprios de cada hook (documentação dos hooks), sobre o payload realista do T4. */
const HOOKS = {
  SessionStart: { source: 'startup', model: 'claude-opus-5-5' },
  SessionEnd: { reason: 'other' },
  UserPromptSubmit: { prompt: 'Leia o CLAUDE.md\nresto do pedido' },
  PreToolUse: {},
  PostToolUse: { tool_response: { file: { content: 'CONTEUDO-DO-ARQUIVO' } }, duration_ms: 4 },
  PostToolUseFailure: { error: 'Exit code 3\nSAIDA', is_interrupt: false },
  PermissionRequest: { permission_suggestions: [] },
  PermissionDenied: { reason: 'auto' },
  Notification: { notification_type: 'permission_prompt', message: 'MENSAGEM' },
  SubagentStart: { agent_id: 'a0011223344556677', agent_type: 'tester' },
  SubagentStop: { agent_id: 'a0011223344556677', agent_type: 'tester', last_assistant_message: 'RESPOSTA', background_tasks: [] },
  Stop: { last_assistant_message: 'RESPOSTA', background_tasks: [] },
  StopFailure: { error: 'rate_limit', last_assistant_message: 'TEXTO-DA-API' },
  PreCompact: { trigger: 'manual', custom_instructions: 'INSTRUCOES' },
  PostCompact: { trigger: 'manual', compact_summary: 'RESUMO' },
};
const KIND = {
  SessionStart: 'session.start', SessionEnd: 'session.end', UserPromptSubmit: 'prompt.submit', PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post', PostToolUseFailure: 'tool.fail', PermissionRequest: 'permission.request',
  PermissionDenied: 'permission.denied', Notification: 'notice', SubagentStart: 'subagent.start', SubagentStop: 'subagent.stop',
  Stop: 'turn.stop', StopFailure: 'turn.fail', PreCompact: 'compact.pre', PostCompact: 'compact.post',
};

function assertSection10(fact, label) {
  const visit = (value, at) => {
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${at}[${i}]`));
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        assert.ok(!FORBIDDEN.includes(key), `${label}: chave proibida ${at}.${key}`);
        visit(item, `${at}.${key}`);
      }
    } else if (typeof value === 'string') {
      const stored = /^fato\.(projectDir|transcriptPath|agentTranscriptPath)$/.test(at);
      assert.ok(charLength(value) <= (stored ? 1024 : 200), `${label}: ${at} com ${charLength(value)} caracteres`);
    }
  };
  visit(fact, 'fato');
  for (const key of ['tool', 'target', 'detail', 'title', 'error', 'sessionTitle', 'model', 'agentType', 'subagentType', 'description', 'projectDir']) {
    if (typeof fact[key] === 'string') assert.equal(redact(fact[key]), fact[key], `${label}: ${key} não é ponto fixo`);
  }
}

describe('T5 integração: envelope real do encaminhador → normalize()', () => {
  let home;
  let server;

  before(async () => {
    home = newTemp('aq-int-normalize-');
    server = await startRealServer({ dataDir: home, env: { AGENT_QUEST_HOME: home } });
  });

  after(async () => {
    if (server) await server.stop();
    cleanupTemps();
  });

  /**
   * Manda `fields` pelo encaminhador real e devolve o envelope gravado pelo
   * servidor (ou null, se a máquina estava sobrecarregada e o teste foi pulado).
   *
   * Com a máquina carregada, o encaminhador pode mandar o envelope de emergência
   * (orçamento de tempo da redução, seção 1), sem as chaves que não são
   * obrigatórias nem prioritárias. Isso é previsto, mas não deixa conferir o
   * normalizador sobre o envelope completo: o teste tenta de novo e, se só
   * vierem envelopes reduzidos, pula com as medidas (o pulo impede a aprovação).
   */
  async function deliver(t, label, fields, extraEnv = {}) {
    const reduced = [];
    for (let round = 0; round < 3; round++) {
      let sentKeys = [];
      const envelope = await assertDelivered(t, label, async () => {
        const payload = hookPayload(fields);
        sentKeys = Object.keys(payload);
        const result = await runForwarder({ env: forwarderEnv({ AGENT_QUEST_HOME: home, CLAUDE_PROJECT_DIR: PROJECT, ...extraEnv }), stdin: JSON.stringify(payload) });
        return { result, delivered: () => server.dumped().find((e) => e.payload.tool_use_id === payload.tool_use_id) };
      });
      if (!envelope) return null;
      const missing = sentKeys.filter((key) => !Object.hasOwn(envelope.payload, key));
      if (missing.length === 0) return envelope;
      reduced.push(`sem ${missing.join(', ')}`);
      t.diagnostic(`${label}: envelope reduzido pelo encaminhador (${reduced.at(-1)}); nova tentativa`);
    }
    t.skip(`${label}: o encaminhador mandou só envelopes reduzidos nas 3 tentativas (${reduced.join('; ')}); máquina sobrecarregada`);
    return null;
  }

  for (const [hook, fields] of Object.entries(HOOKS)) {
    it(`${hook}: o envelope gravado vira ${KIND[hook]}, com projectDir do CLAUDE_PROJECT_DIR`, async (t) => {
      const envelope = await deliver(t, hook, { hook_event_name: hook, ...fields });
      if (!envelope) return;
      assert.equal(envelope.env.projectDir, PROJECT);
      const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: HOME });
      assert.ok(fact, `${hook} virou null`);
      assert.equal(fact.kind, KIND[hook]);
      assert.equal(fact.sessionId, envelope.payload.session_id);
      assert.equal(fact.projectDir, PROJECT);
      assert.equal(fact.ts, envelope.sentAt, 'ts vem do sentAt do encaminhador');
      if (hook.includes('Tool') || hook.startsWith('Permission')) assert.equal(fact.category, 'read');
      // PermissionDenied não tem alvo (seção 2).
      if (hook.includes('Tool') || hook === 'PermissionRequest') assert.equal(fact.target, 'CLAUDE.md', 'caminho relativo ao projeto');
      assert.doesNotMatch(JSON.stringify(fact), /CONTEUDO-DO-ARQUIVO|SAIDA|MENSAGEM|RESPOSTA|TEXTO-DA-API|INSTRUCOES|RESUMO|resto do pedido/);
      assertSection10(fact, hook);
    });
  }

  // Captura 0.1.3 (plano, T4): env.entrypoint vira o `client` do fato (V11).
  for (const [entrypoint, client] of [['cli', 'terminal'], ['claude-vscode', 'vscode']]) {
    it(`0.1.3: CLAUDE_CODE_ENTRYPOINT=${entrypoint} chega como env.entrypoint, e o fato tem client '${client}'`, async (t) => {
      const envelope = await deliver(t, `entrypoint ${entrypoint}`, { hook_event_name: 'PreToolUse' }, { CLAUDE_CODE_ENTRYPOINT: entrypoint });
      if (!envelope) return;
      assert.equal(envelope.env.entrypoint, entrypoint);
      const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: HOME });
      assert.equal(fact.client, client);
    });
  }

  it('0.1.3: sem CLAUDE_CODE_ENTRYPOINT, env.entrypoint é null e o fato tem client null', async (t) => {
    const envelope = await deliver(t, 'sem entrypoint', { hook_event_name: 'PreToolUse' });
    if (!envelope) return;
    assert.equal(envelope.env.entrypoint, null);
    assert.equal(normalize(envelope, { receivedAt: Date.now(), homeDir: HOME }).client, null);
  });

  it('0.1.3: pedido do VS Code com <browser_instruction> chega sem o bloco; título do pedido, origem user', async (t) => {
    // Formato observado no T0 (V7), remontado: bloco de cerca de 4,1 mil caracteres + "\n\n" + pedido.
    const block = `<browser_instruction>\n${'Instrução da extensão sobre o navegador. '.repeat(100)}\n</browser_instruction>`;
    const request = `Revise o README ${'e confira os links '.repeat(250)}`;
    const envelope = await deliver(
      t,
      'preâmbulo do VS Code',
      { hook_event_name: 'UserPromptSubmit', prompt: `${block}\n\n${request}` },
      { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
    );
    if (!envelope) return;
    assert.ok(envelope.payload.prompt.startsWith('Revise o README'), 'o começo do pedido sobrevive ao corte');
    assert.doesNotMatch(envelope.payload.prompt, /browser_instruction/);
    assert.equal(envelope.truncated, true, 'o pedido de 4,7 mil caracteres ainda passa pelo corte de 1 KiB + 3 KiB');
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: HOME });
    assert.equal(fact.kind, 'prompt.submit');
    assert.equal(fact.client, 'vscode');
    assert.equal(fact.origin, 'user');
    assert.ok(fact.title.startsWith('Revise o README'), fact.title);
    assertSection10(fact, 'preâmbulo do VS Code');
  });

  it('evento fora dos 15 é aceito pela ingestão e vira null no normalizador', async (t) => {
    const envelope = await deliver(t, 'PostToolBatch', { hook_event_name: 'PostToolBatch', tool_calls: [] });
    if (!envelope) return;
    assert.equal(normalize(envelope, { receivedAt: Date.now(), homeDir: HOME }), null);
  });

  it('strings acima de 4 KiB cortadas pelo encaminhador continuam redigidas e nos limites', async (t) => {
    const command = `export API_TOKEN=segredo-de-teste-123 && curl -u admin:senha-de-teste https://exemplo.org ${'--flag '.repeat(1200)}`;
    const error = `Exit code 1\n${'linha de saída\n'.repeat(600)}password=segredo-no-fim`;
    const envelope = await deliver(t, 'corte de 4 KiB', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command, description: `Rodar ${'d'.repeat(5000)}` },
      error,
    });
    if (!envelope) return;
    assert.equal(envelope.truncated, true);
    assert.match(envelope.payload.tool_input.command, /…\[cortado \d+ caracteres\]…/);
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: HOME });
    assert.equal(fact.kind, 'tool.fail');
    assert.ok(charLength(fact.target) <= 120 && charLength(fact.detail) <= 80 && charLength(fact.error) <= 160);
    assert.ok(fact.target.startsWith('export API_TOKEN=•••'), fact.target);
    assert.doesNotMatch(JSON.stringify(fact), /segredo|senha-de-teste/);
    assert.equal(fact.error, 'Exit code 1');
    assertSection10(fact, 'corte de 4 KiB');
  });

  it('token sobre a borda de 1 KiB do corte do encaminhador não aparece pela metade', async (t) => {
    // Primeira linha começando perto da borda: o corte deixa "ghp_" + 6 caracteres, abaixo do tamanho mínimo da etapa 3.
    const prompt = `${'\n'.repeat(1024 - 10)}ghp_${'A'.repeat(36)} ${'x'.repeat(5000)}`;
    const envelope = await deliver(t, 'borda de 1 KiB', { hook_event_name: 'UserPromptSubmit', prompt });
    if (!envelope) return;
    assert.equal(envelope.truncated, true);
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: HOME });
    assert.doesNotMatch(String(fact.title), /ghp_A/, `título: ${JSON.stringify(fact.title)}`);
  });

  it('token partido no começo do trecho final (3 KiB) não aparece', async (t) => {
    // Começo todo em branco: a primeira linha começa no marcador, e o trecho final começa no meio do token.
    const tail = 3 * 1024;
    const body = `ghp_${'B'.repeat(36)} ${'y'.repeat(tail - 20)}`;
    const prompt = `${'\n'.repeat(2000)}${'z'.repeat(1000)}${body}`;
    const envelope = await deliver(t, 'começo do trecho final', { hook_event_name: 'UserPromptSubmit', prompt });
    if (!envelope) return;
    assert.match(envelope.payload.prompt, /…\[cortado \d+ caracteres\]…B+ y/, 'o trecho final começa no meio do token');
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: HOME });
    assert.doesNotMatch(String(fact.title), /BBBB/, `título: ${JSON.stringify(fact.title)}`);
    assert.equal(redact(fact.title), fact.title);
  });

  it('corte de 128 + 384 do teto do corpo: token na borda não aparece, e o fato continua válido', async (t) => {
    // Mais de 1 000 000 bytes depois do passo 1: o passo 2 corta strings acima de 512 em 128 + 384.
    const filler = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 'f'.repeat(4000)]));
    const prompt = `${'\n'.repeat(120)}ghp_${'C'.repeat(36)} ${'x'.repeat(2000)}`;
    const envelope = await deliver(t, 'teto do corpo', { hook_event_name: 'UserPromptSubmit', prompt, extra: filler });
    if (!envelope) return;
    assert.equal(envelope.truncated, true);
    assert.match(envelope.payload.prompt, /^\n{120}ghp_C{4}…\[cortado \d+ caracteres\]…/, 'corte de 128 do início');
    const fact = normalize(envelope, { receivedAt: Date.now(), homeDir: HOME });
    assert.equal(fact.kind, 'prompt.submit');
    assert.doesNotMatch(String(fact.title), /ghp_|CCCC/, `título: ${JSON.stringify(fact.title)}`);
    assertSection10(fact, 'teto do corpo');
  });
});
