// Papéis a partir do agent_type (ADR 0007; modelo de eventos, seção 5).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../../../../shared/contract.js';
import { TEAM_ROLES, resolveRole } from '../../../../server/domain/roles.js';

describe('resolveRole', () => {
  it('nomes do time', () => {
    assert.equal(resolveRole('arquiteto'), 'arq');
    assert.equal(resolveRole('dev-backend'), 'dev');
    assert.equal(resolveRole('dev-frontend'), 'dev');
    assert.equal(resolveRole('tester'), 'tes');
    assert.equal(resolveRole('documentador'), 'doc');
    assert.deepEqual(Object.keys(TEAM_ROLES).sort(), ['arquiteto', 'dev-backend', 'dev-frontend', 'documentador', 'tester']);
  });

  it('plugin:agente tenta o nome inteiro e depois a parte depois do último ":"', () => {
    assert.equal(resolveRole('plugin:tester'), 'tes');
    assert.equal(resolveRole('meu-plugin:dev-backend'), 'dev');
    assert.equal(resolveRole('a:b:documentador'), 'doc');
    assert.equal(resolveRole('agent-quest-probe:probe-worker'), 'aux');
    assert.equal(resolveRole('tester:'), 'aux');
  });

  it('embutidos e desconhecidos são convidados (aux)', () => {
    for (const type of ['general-purpose', 'Explore', 'Plan', 'outro-projeto-agente', 'Tester', 'ARQUITETO', ' tester']) {
      assert.equal(resolveRole(type), 'aux', type);
    }
  });

  it('sem tipo, vazio ou com tipo errado: aux', () => {
    for (const type of [null, undefined, '', 0, {}, ['tester']]) assert.equal(resolveRole(type), 'aux', String(type));
  });

  it('nomes herdados do protótipo não viram papel', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'plugin:constructor']) {
      assert.equal(resolveRole(type), 'aux', type);
      assert.equal(resolveRole(type, {}), 'aux', type);
    }
  });

  it('sobrescritas do config.json acrescentam e trocam entradas, antes da tabela do time', () => {
    const overrides = { backend: 'dev', tester: 'doc', 'plugin:revisor': 'tes', revisor: 'arq' };
    assert.equal(resolveRole('backend', overrides), 'dev');
    assert.equal(resolveRole('tester', overrides), 'doc');
    assert.equal(resolveRole('plugin:tester', overrides), 'doc');
    assert.equal(resolveRole('plugin:revisor', overrides), 'tes', 'o nome inteiro vem antes da parte final');
    assert.equal(resolveRole('outro:revisor', overrides), 'arq');
    assert.equal(resolveRole('arquiteto', overrides), 'arq', 'o resto da tabela continua valendo');
    assert.equal(resolveRole('Explore', { Explore: 'aux' }), 'aux');
  });

  it('sobrescritas inválidas são ignoradas, e nenhuma dá o papel orq', () => {
    const overrides = { a: 'orq', b: 'chefe', c: 3, d: null, tester: 'orq' };
    for (const type of ['a', 'b', 'c', 'd']) assert.equal(resolveRole(type, overrides), 'aux', type);
    assert.equal(resolveRole('tester', overrides), 'tes');
    for (const bad of [null, 'roles', ['dev'], 42]) assert.equal(resolveRole('tester', bad), 'tes', String(bad));
  });

  it('sempre devolve um papel do contrato, nunca orq', () => {
    const types = ['arquiteto', 'x', '', 'plugin:tester', 'general-purpose', 'documentador'];
    for (const type of types) {
      const role = resolveRole(type, { x: 'doc' });
      assert.ok(ROLES.includes(role), role);
      assert.notEqual(role, 'orq');
    }
  });
});
