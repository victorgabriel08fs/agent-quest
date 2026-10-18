// Helpers de escape e formatação dos temas (web/js/themes/helpers.js).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  actionTextFrom, b, code, createHelpers, esc, feedLineFrom, formatClock, formatDuration, i, pick, plural, targetOf,
} from '../../../web/js/themes/helpers.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { XSS, makeAgent } from './support.js';

describe('esc e os helpers de HTML', () => {
  it('escapa &, <, >, aspas duplas e simples', () => {
    assert.equal(esc(`a & b < c > d " e ' f`), 'a &amp; b &lt; c &gt; d &quot; e &#39; f');
  });

  it('trata null e undefined como texto vazio e converte números', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(42), '42');
  });

  it('code, b e i envolvem o texto já escapado', () => {
    assert.equal(code(XSS), '<code>&lt;img src=x onerror=alert(1)&gt;</code>');
    assert.equal(b('<b>'), '<b>&lt;b&gt;</b>');
    assert.equal(i('"x"'), '<i>&quot;x&quot;</i>');
  });

  it('plural escolhe a forma pela quantidade', () => {
    assert.equal(plural(1, 'ação', 'ações'), 'ação');
    assert.equal(plural(0, 'ação', 'ações'), 'ações');
    assert.equal(plural(2, 'ação', 'ações'), 'ações');
  });
});

describe('formatação de tempo', () => {
  it('formatDuration usa mm:ss até uma hora e h:mm:ss depois', () => {
    assert.equal(formatDuration(0), '00:00');
    assert.equal(formatDuration(65_000), '01:05');
    assert.equal(formatDuration(59 * 60_000 + 59_999), '59:59');
    assert.equal(formatDuration(3_661_000), '1:01:01');
  });

  it('formatDuration nunca fica negativa nem quebra com valor inválido', () => {
    assert.equal(formatDuration(-5_000), '00:00');
    assert.equal(formatDuration(Number.NaN), '00:00');
  });

  it('formatClock mostra a hora local, com ou sem segundos', () => {
    const ts = new Date(2026, 9, 18, 9, 5, 7).getTime();
    assert.equal(formatClock(ts), '09:05:07');
    assert.equal(formatClock(ts, { seconds: false }), '09:05');
    assert.equal(formatClock(Number.NaN), '--:--');
  });
});

describe('pick e targetOf', () => {
  it('pick ignora chaves herdadas e usa o padrão', () => {
    const table = { a: 1, other: 2 };
    assert.equal(pick(table, 'a', 'other'), 1);
    assert.equal(pick(table, 'constructor', 'other'), 2);
    assert.equal(pick(table, 'toString', 'other'), 2);
    assert.equal(pick(table, undefined, 'other'), 2);
  });

  it('targetOf usa o alvo, senão o nome da ferramenta, senão reticências', () => {
    assert.equal(targetOf({ target: 'a.js', tool: 'Read' }), 'a.js');
    assert.equal(targetOf({ target: null, tool: 'TodoWrite' }), 'TodoWrite');
    assert.equal(targetOf({ target: '', tool: '' }), '…');
  });
});

describe('createHelpers', () => {
  const agents = [
    makeAgent({ key: 'main', role: 'orq' }),
    makeAgent({ key: 'a-dev', role: 'dev', agentType: 'dev-backend' }),
    makeAgent({ key: 'a-aux', role: 'aux', agentType: 'Explore' }),
    makeAgent({ key: 'a-xss', role: 'aux', agentType: XSS }),
    makeAgent({ key: 'a-estranho', role: 'toString', agentType: 'plugin:outro' }),
  ];
  const h = createHelpers(escritorio, agents);

  it('role mostra o nome do papel no tema, em negrito', () => {
    assert.equal(h.role('main'), '<b>Gerente de Projeto</b>');
    assert.equal(h.role(null), '<b>Gerente de Projeto</b>');
    assert.equal(h.role('a-dev'), '<b>Dev Full-stack</b>');
    assert.equal(createHelpers(guilda, agents).role('a-dev'), '<b>Ferreiro</b>');
  });

  it('convidado (aux) mostra o agent_type real (ADR 0007), escapado', () => {
    assert.equal(h.role('a-aux'), '<b>Explore</b>');
    assert.equal(h.role('a-xss'), `<b>${esc(XSS)}</b>`);
  });

  it('agente desconhecido ou com papel fora do contrato vira convidado', () => {
    assert.equal(h.roleOf('nao-existe'), 'aux');
    assert.equal(h.role('nao-existe'), '<b>Consultor Externo</b>');
    assert.equal(h.roleOf('a-estranho'), 'aux');
    assert.equal(h.role('a-estranho'), '<b>plugin:outro</b>');
  });

  it('roleName resolve o alvo de uma delegação', () => {
    assert.equal(h.roleName('tes', 'tester'), '<b>Analista de QA</b>');
    assert.equal(h.roleName('aux', 'Plan'), '<b>Plan</b>');
    assert.equal(h.roleName('aux', null), '<b>Consultor Externo</b>');
    assert.equal(h.roleName('xyz', 'Outro'), '<b>Outro</b>');
  });

  it('short e phase devolvem texto do tema, com recuo seguro', () => {
    assert.equal(h.short('tes'), 'QA');
    assert.equal(h.short('constructor'), 'Consultor');
    assert.equal(h.phase('code'), 'Desenvolvimento');
    assert.equal(h.phase('outra'), 'outra');
    assert.equal(h.phase('toString'), 'toString');
  });
});

describe('despachantes', () => {
  it('feedLineFrom devolve null para tipo desconhecido', () => {
    const h = createHelpers(escritorio, []);
    const line = feedLineFrom(/** @type {any} */ ({}), /** @type {any} */ ({ kind: 'nao.existe', agentKey: null, data: {} }), h);
    assert.equal(line, null);
  });

  it('actionTextFrom sem agente devolve o texto de ocioso', () => {
    const phrases = /** @type {any} */ ({ idle: 'ocioso' });
    assert.equal(actionTextFrom(phrases, null), 'ocioso');
  });
});
