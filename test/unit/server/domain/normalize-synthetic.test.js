// SINTÉTICO: normalizador sobre a sessão sintética da sonda do T0
// (test/unit/tools/probe-synthetic.js), convertida para o formato de cenário do
// ADR 0010. Os payloads seguem a documentação dos hooks; não são capturas reais.
//
// A tabela com os cenários reais do T0 ("fato igual ao esperado para cada
// evento", fechamento [T0] do T5) está em normalize-fixtures.test.js. Esta
// continua, marcada como sintética (ADR 0010, complemento de 26/10/2026),
// porque cobre também o que o T0 não mostrou: primeiro plano (`completed`),
// `is_interrupt`, `run_in_background` e PermissionDenied.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, CONTENT_MARKERS, PROJECT, WORKER } from '../../tools/probe-synthetic.js';
import { HOOK_FACTS, normalize } from '../../../../server/domain/normalize.js';
import { assertFactInvariants } from './fact-checks.js';
import { SYNTHETIC_HOME, scenarioEnvelopes, syntheticScenario } from './scenarios.js';

/** @type {{ payload: any, env: any, fact: any }[]} */
let rows;

before(() => {
  const scenario = syntheticScenario();
  rows = scenarioEnvelopes(scenario).map(({ envelope, receivedAt, event }) => ({
    payload: event.payload,
    env: event.env,
    fact: normalize(envelope, { receivedAt, homeDir: SYNTHETIC_HOME }),
  }));
});

const hookIs = (name) => (p) => p.hook_event_name === name;
const startsWith = (text) => (p) => typeof p.prompt === 'string' && p.prompt.startsWith(text);

/**
 * [descrição, seletor (payload, env), esperado (objeto parcial ou função do payload)].
 * Todo seletor precisa achar pelo menos um evento, e todos os achados batem.
 */
const TABLE = [
  ['início da sessão no terminal', (p, e) => p.hook_event_name === 'SessionStart' && p.source === 'startup' && e.entrypoint === 'cli',
    { kind: 'session.start', source: 'startup', model: 'claude-opus-5-5', client: 'terminal', agentId: null, projectDir: PROJECT }],
  ['início da sessão no VS Code (V11)', (p, e) => p.hook_event_name === 'SessionStart' && e.entrypoint === 'claude-vscode',
    { kind: 'session.start', client: 'vscode' }],
  ['SessionStart da compactação', (p) => p.hook_event_name === 'SessionStart' && p.source === 'compact', { source: 'compact' }],
  ['fim da sessão por /clear', (p) => p.hook_event_name === 'SessionEnd' && p.reason === 'clear', { kind: 'session.end', reason: 'clear' }],
  ['pedido do usuário', startsWith('Rode node -e "process.exit(3)"'),
    { kind: 'prompt.submit', title: 'Rode node -e "process.exit(3)".', origin: 'user' }],
  ['retorno do segundo plano é do sistema (V7)', startsWith('<task-notification>'),
    { kind: 'prompt.submit', origin: 'system', title: '<task-notification>' }],
  ['/compact usa o comando como título', startsWith('/compact'), { title: '/compact', origin: 'user' }],
  ['Read do CLAUDE.md na sessão principal', (p) => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read' && !p.agent_id,
    { kind: 'tool.pre', tool: 'Read', category: 'read', target: 'CLAUDE.md', agentId: null, agentType: null }],
  ['Read dentro de subagente leva agent_id e agent_type (V1)', (p) => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read' && p.agent_id,
    (p) => ({ agentId: p.agent_id, agentType: p.agent_type, target: 'CLAUDE.md' })],
  ['Write relativo ao projeto', (p) => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Write',
    { category: 'write', target: 'tmp-probe/a.test.mjs' }],
  ['Edit relativo ao projeto', (p) => p.hook_event_name === 'PostToolUse' && p.tool_name === 'Edit',
    { kind: 'tool.post', category: 'edit', target: 'tmp-probe/a.test.mjs', durationMs: 50 }],
  ['Bash com descrição', (p) => p.hook_event_name === 'PreToolUse' && p.tool_input?.description === 'Imprimir 1',
    { category: 'bash', target: 'node -e "console.log(1)"', detail: 'Imprimir 1', background: false }],
  ['comando de teste vira test (T6)', (p) => p.hook_event_name === 'PreToolUse' && p.tool_input?.command === 'node --test tmp-probe',
    { category: 'test', target: 'node --test tmp-probe', detail: 'Rodar os testes' }],
  ['teste que passa: testResult do stdout (T6)', (p) => p.hook_event_name === 'PostToolUse' && p.tool_input?.command === 'node --test tmp-probe',
    { kind: 'tool.post', category: 'test', testResult: { ok: true, passed: 1, failed: 0, total: 1, framework: 'node:test', chained: false } }],
  ['pedido de aprovação', (p) => p.hook_event_name === 'PermissionRequest' && p.tool_input?.command === 'node -e "console.log(1)"',
    { kind: 'permission.request', tool: 'Bash', category: 'bash', target: 'node -e "console.log(1)"' }],
  ['aviso de permissão', (p) => p.hook_event_name === 'Notification', { kind: 'notice', type: 'permission_prompt' }],
  ['falha com código de saída (V3)', (p) => p.hook_event_name === 'PostToolUseFailure' && String(p.error).startsWith('Exit code 3'),
    { kind: 'tool.fail', error: 'Exit code 3', interrupted: false, testResult: null }],
  ['falha do teste: só a primeira linha do erro; testResult do error (T6)', (p) => p.hook_event_name === 'PostToolUseFailure' && String(p.error).startsWith('Exit code 1'),
    { error: 'Exit code 1', category: 'test', testResult: { ok: false, passed: 0, failed: 1, total: 1, framework: 'node:test', chained: false } }],
  ['Esc na sessão principal', (p) => p.hook_event_name === 'PostToolUseFailure' && p.is_interrupt === true && !p.agent_id && p.tool_name === 'Bash',
    { error: 'Interrupted by user', interrupted: true }],
  ['delegação ao probe-worker', (p) => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Agent' && p.tool_input.subagent_type === WORKER && p.tool_input.description === 'Ler o CLAUDE.md' && !p.agent_id,
    { kind: 'tool.pre', tool: 'Agent', category: null, subagentType: WORKER, description: 'Ler o CLAUDE.md', target: WORKER, detail: 'Ler o CLAUDE.md' }],
  ['delegação ao agente do projeto', (p) => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Agent' && p.tool_input.subagent_type === 'documentador',
    { subagentType: 'documentador' }],
  ['delegação aninhada: quem delega é o subagente', (p) => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Agent' && p.agent_id,
    { agentId: AGENTS.w5.id, description: 'Ler o CLAUDE.md (aninhado)' }],
  ['elo em primeiro plano (V5)', (p) => p.hook_event_name === 'PostToolUse' && p.tool_name === 'Agent' && p.tool_response?.status === 'completed',
    (p) => ({ kind: 'tool.post', launch: 'completed', linkedAgentId: p.tool_response.agentId })],
  ['elo em segundo plano (V5)', (p) => p.hook_event_name === 'PostToolUse' && p.tool_name === 'Agent' && p.tool_response?.status === 'async_launched',
    { launch: 'async_launched', linkedAgentId: AGENTS.w4.id, background: true }],
  ['falha do Agent interrompido', (p) => p.hook_event_name === 'PostToolUseFailure' && p.tool_name === 'Agent',
    { kind: 'tool.fail', subagentType: WORKER, interrupted: true }],
  ['início de subagente', (p) => p.hook_event_name === 'SubagentStart' && p.agent_type === 'documentador',
    { kind: 'subagent.start', agentId: AGENTS.d1.id, agentType: 'documentador' }],
  ['fim de subagente com o transcript dele', (p) => p.hook_event_name === 'SubagentStop' && p.agent_id === AGENTS.w1.id,
    (p) => ({ kind: 'subagent.stop', agentTranscriptPath: p.agent_transcript_path })],
  ['agente interno: SubagentStop sem tipo (V6)', (p) => p.hook_event_name === 'SubagentStop' && p.agent_type === '',
    { kind: 'subagent.stop', agentId: AGENTS.internal.id, agentType: null }],
  ['Stop com tarefa em segundo plano', (p) => p.hook_event_name === 'Stop' && p.background_tasks.length > 0,
    { kind: 'turn.stop', backgroundTasks: [{ id: AGENTS.w4.id, type: 'local_agent', status: 'running', agentType: WORKER, agentTypeKey: WORKER }] }],
  ['compactação manual', (p) => p.hook_event_name === 'PreCompact' || p.hook_event_name === 'PostCompact', { trigger: 'manual' }],
  ['curl com Bearer e senha na URL', (p) => p.hook_event_name === 'PreToolUse' && String(p.tool_input?.command).startsWith('curl'),
    { target: 'curl -H "Authorization: •••" https://•••@example.com/x', client: 'vscode' }],
];

describe('SINTÉTICO: normalizador sobre a sessão da sonda', () => {
  it('todo evento vira um fato do tipo certo, com os campos comuns do payload', () => {
    assert.ok(rows.length > 100);
    for (const [i, { payload, fact }] of rows.entries()) {
      assert.ok(fact, `evento ${i} (${payload.hook_event_name}) virou null`);
      assert.equal(fact.kind, HOOK_FACTS[payload.hook_event_name], `evento ${i}`);
      assert.equal(fact.sessionId, payload.session_id, `evento ${i}`);
      assert.equal(fact.agentId, payload.agent_id ?? null, `evento ${i}`);
      assert.equal(fact.promptId, payload.prompt_id ?? null, `evento ${i}`);
      assert.equal(fact.projectDir, PROJECT, `evento ${i}`);
      assertFactInvariants(fact, `evento ${i}`);
    }
  });

  for (const [label, select, expected] of TABLE) {
    it(label, () => {
      const matches = rows.filter(({ payload, env }) => select(payload, env));
      assert.ok(matches.length > 0, `nenhum evento para "${label}"`);
      for (const { payload, fact } of matches) {
        const want = typeof expected === 'function' ? expected(payload) : expected;
        for (const [key, value] of Object.entries(want)) {
          assert.deepEqual(fact[key], value, `${label}: ${key}`);
        }
      }
    });
  }

  it('nenhum conteúdo real vaza (arquivo, saída, texto do assistente, prompt do agente, resumo, segredos)', () => {
    // O título do pedido é a primeira linha (até 80) por design; o marcador do pedido fica fora desta lista.
    const markers = CONTENT_MARKERS.filter((marker) => marker !== 'SEGREDO-DO-PEDIDO');
    const all = JSON.stringify(rows.map((row) => row.fact));
    for (const marker of markers) assert.ok(!all.includes(marker), marker);
  });

  it('o PermissionRequest tem o mesmo inputHash do PreToolUse da chamada (seção 6)', () => {
    let checked = 0;
    for (const [i, { payload, fact }] of rows.entries()) {
      if (payload.hook_event_name !== 'PermissionRequest') continue;
      const pre = rows
        .slice(0, i)
        .reverse()
        .find((row) => row.payload.hook_event_name === 'PreToolUse' && row.payload.session_id === payload.session_id && row.payload.tool_name === payload.tool_name);
      assert.ok(pre, `PermissionRequest ${i} sem PreToolUse antes`);
      assert.equal(fact.inputHash, pre.fact.inputHash, `PermissionRequest ${i}`);
      assert.equal(fact.target, pre.fact.target);
      checked++;
    }
    assert.ok(checked >= 10, `poucos pedidos conferidos: ${checked}`);
  });

  it('Post que chega antes do Pre traz a mesma chamada (seção 8, regra 1)', () => {
    const index = rows.findIndex(
      ({ payload }, i) => payload.hook_event_name === 'PostToolUse' && rows.slice(i + 1).some((r) => r.payload.hook_event_name === 'PreToolUse' && r.payload.tool_use_id === payload.tool_use_id),
    );
    assert.ok(index >= 0, 'o cenário sintético tem um Post antes do Pre');
    const post = rows[index].fact;
    const pre = rows.find((r) => r.payload.hook_event_name === 'PreToolUse' && r.payload.tool_use_id === post.toolUseId).fact;
    for (const key of ['toolUseId', 'tool', 'category', 'target', 'detail', 'inputHash', 'agentId']) {
      assert.deepEqual(post[key], pre[key], key);
    }
  });
});
