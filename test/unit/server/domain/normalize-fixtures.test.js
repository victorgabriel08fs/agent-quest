// Cenários reais do T0 (test/fixtures/hooks/*.json, sanitizados).
//
// - Guarda: nenhuma string dos cenários muda ao passar por `redact`. Se a
//   redação ficar mais rígida, o teste aponta os cenários que precisam ser
//   gerados de novo com tools/probe/sanitize.mjs.
// - Todo evento vira o fato do tipo certo e respeita a seção 10.
//
// Enquanto o T0 não entrega os cenários, os testes ficam pulados, com o motivo.
// A tabela "fato igual ao esperado para cada evento" (critério do T5) entra
// junto com os cenários, no lugar da tabela sintética.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../../../server/domain/redact.js';
import { HOOK_FACTS, normalize } from '../../../../server/domain/normalize.js';
import { LIMITS, firstRedactedLine, textLine } from '../../../../server/domain/tools.js';
import { assertFactInvariants } from './fact-checks.js';
import { loadFixtureScenarios, scenarioEnvelopes } from './scenarios.js';

const WAITING = 'nenhum cenário em test/fixtures/hooks/ ainda: chegam com o T0';

/** Pasta pessoal dos cenários sanitizados (o nome do usuário vira "usuario"). */
const FIXTURE_HOME = 'C:\\Users\\usuario';

/** [caminho, valor] de cada string, em qualquer profundidade. */
function* strings(value, at) {
  if (typeof value === 'string') yield [at, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${at}[${i}]`);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* strings(item, `${at}.${key}`);
  }
}

describe('cenários do T0 (test/fixtures/hooks/)', () => {
  const scenarios = loadFixtureScenarios();

  it('guarda: nenhuma string dos cenários muda ao passar por redact', (t) => {
    if (scenarios.length === 0) return t.skip(WAITING);
    const changed = [];
    for (const { file, scenario } of scenarios) {
      for (const [at, text] of strings(scenario, file)) {
        if (redact(text) !== text) changed.push(at);
      }
    }
    assert.deepEqual(changed, [], 'gerar de novo estes cenários com o sanitize.mjs atual');
  });

  it('todo evento vira o fato do tipo certo, respeitando a seção 10', (t) => {
    if (scenarios.length === 0) return t.skip(WAITING);
    for (const { file, scenario } of scenarios) {
      for (const { index, event, envelope, receivedAt } of scenarioEnvelopes(scenario)) {
        const label = `${file}#${index}`;
        const fact = normalize(envelope, { receivedAt, homeDir: FIXTURE_HOME });
        const hook = event.payload?.hook_event_name;
        if (!Object.hasOwn(HOOK_FACTS, hook)) {
          assert.equal(fact, null, label);
          continue;
        }
        assert.ok(fact, `${label} (${hook}) virou null`);
        assert.equal(fact.kind, HOOK_FACTS[hook], label);
        assertFactInvariants(fact, label);
      }
    }
  });
});

// Ajustes do G0b antes do marco (plano, T6; modelo de eventos, seções 2 e 6).
describe('G0b, V7: origem e título dos pedidos nos cenários reais', () => {
  const scenarios = loadFixtureScenarios();

  /** Fato de cada UserPromptSubmit dos cenários, com o prompt original. */
  function prompts() {
    const out = [];
    for (const { file, scenario } of scenarios) {
      for (const { index, event, envelope, receivedAt } of scenarioEnvelopes(scenario)) {
        if (event.payload?.hook_event_name !== 'UserPromptSubmit') continue;
        const fact = normalize(envelope, { receivedAt, homeDir: FIXTURE_HOME });
        out.push({ label: `${file}#${index}`, file, prompt: event.payload.prompt, fact });
      }
    }
    return out;
  }

  /** Regra de origem e de título de antes do G0b, para comparar. */
  const previousOrigin = (prompt) => (/^<task-notification(?=[\s>])/.test(prompt.trimStart()) ? 'system' : 'user');
  function previousTitle(prompt) {
    const line = firstRedactedLine(prompt);
    if (line === null) return null;
    return textLine(line.startsWith('/') ? line.split(/\s/, 1)[0] : line, LIMITS.title);
  }

  it('cenário vscode: os dois retornos <agent-message> saem system', (t) => {
    if (scenarios.length === 0) return t.skip(WAITING);
    const returns = prompts().filter((item) => item.file === 'vscode.json' && item.prompt.trimStart().startsWith('<agent-message'));
    assert.equal(returns.length, 2);
    for (const { label, fact } of returns) assert.equal(fact.origin, 'system', label);
  });

  it('cenário vscode: o pedido com <browser_instruction> é do usuário e o título ignora o bloco', (t) => {
    if (scenarios.length === 0) return t.skip(WAITING);
    const [first, ...rest] = prompts().filter((item) => item.file === 'vscode.json' && item.prompt.startsWith('<browser_instruction'));
    assert.equal(rest.length, 0);
    assert.equal(first.fact.origin, 'user', first.label);
    const after = first.prompt.slice(first.prompt.lastIndexOf('</browser_instruction>') + '</browser_instruction>'.length);
    assert.ok(after.length > 0);
    assert.equal(first.fact.title, after, first.label);
    assert.doesNotMatch(first.fact.title, /browser_instruction|«texto#1/);
  });

  it('o origin e o título não mudam para nenhum outro pedido dos cenários reais', (t) => {
    if (scenarios.length === 0) return t.skip(WAITING);
    let compared = 0;
    for (const { label, prompt, fact } of prompts()) {
      const start = prompt.trimStart();
      if (start.startsWith('<agent-message') || start.startsWith('<browser_instruction')) continue;
      assert.equal(fact.origin, previousOrigin(prompt), label);
      assert.equal(fact.title, previousTitle(prompt), label);
      compared++;
    }
    assert.ok(compared >= 30, `${compared} pedidos comparados`);
  });
});
