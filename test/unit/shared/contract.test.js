import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as contract from '../../../shared/contract.js';

const LIST_NAMES = [
  'EVENT_KINDS',
  'FEED_KINDS',
  'ROLES',
  'TOOL_CATEGORIES',
  'PHASES',
  'AGENT_STATUS',
  'SESSION_STATUS',
  'QUEST_STATUS',
];

// Valores esperados, copiados de docs/arquitetura/modelo-de-eventos.md (seções 3, 6 e 9).
// Se este teste quebrar, o contrato mudou: isso precisa da aprovação do usuário.
const EXPECTED = {
  EVENT_KINDS: [
    'session.started', 'session.ended', 'session.idle',
    'quest.started', 'quest.finished', 'quest.phase',
    'agent.delegated', 'agent.started', 'agent.finished',
    'tool.started', 'tool.finished', 'tool.failed',
    'test.finished',
    'permission.requested', 'permission.resolved',
    'context.compacted', 'context.usage',
  ],
  FEED_KINDS: [
    'session.started', 'session.ended',
    'quest.started', 'quest.finished', 'quest.phase',
    'agent.delegated', 'agent.finished',
    'tool.started', 'tool.failed',
    'test.finished',
    'permission.requested', 'permission.resolved',
    'context.compacted',
  ],
  ROLES: ['orq', 'arq', 'dev', 'tes', 'doc', 'aux'],
  TOOL_CATEGORIES: ['read', 'search', 'write', 'edit', 'test', 'bash', 'web', 'plan', 'skill', 'mcp', 'other'],
  PHASES: ['design', 'code', 'test', 'docs'],
  AGENT_STATUS: ['working', 'waiting', 'idle'],
  SESSION_STATUS: ['active', 'waiting', 'idle', 'ended'],
  QUEST_STATUS: ['open', 'waiting_background', 'done', 'failed', 'interrupted'],
};

describe('shared/contract.js', () => {
  it('exporta exatamente as listas do contrato', () => {
    assert.deepEqual(Object.keys(contract).sort(), [...LIST_NAMES].sort());
  });

  for (const name of LIST_NAMES) {
    describe(name, () => {
      const list = contract[name];

      it('é uma lista congelada de strings não vazias', () => {
        assert.ok(Array.isArray(list));
        assert.ok(Object.isFrozen(list));
        assert.ok(list.length > 0);
        for (const value of list) {
          assert.equal(typeof value, 'string');
          assert.ok(value.length > 0);
        }
        assert.throws(() => list.push('x'), TypeError);
        assert.throws(() => { list[0] = 'x'; }, TypeError);
      });

      it('não tem valores repetidos', () => {
        assert.equal(new Set(list).size, list.length);
      });

      it('tem os valores do modelo de eventos, na ordem', () => {
        assert.deepEqual([...list], EXPECTED[name]);
      });
    });
  }

  it('FEED_KINDS está contido em EVENT_KINDS', () => {
    const kinds = new Set(contract.EVENT_KINDS);
    for (const kind of contract.FEED_KINDS) {
      assert.ok(kinds.has(kind), `${kind} não está em EVENT_KINDS`);
    }
  });

  it('eventos que não vão para o feed ficam fora de FEED_KINDS', () => {
    for (const kind of ['session.idle', 'agent.started', 'tool.finished', 'context.usage']) {
      assert.ok(!contract.FEED_KINDS.includes(kind), `${kind} não deveria estar em FEED_KINDS`);
    }
  });

  it('tem as quantidades do modelo: 17 tipos de evento, 6 papéis, 11 categorias, 4 etapas', () => {
    assert.equal(contract.EVENT_KINDS.length, 17);
    assert.equal(contract.ROLES.length, 6);
    assert.equal(contract.TOOL_CATEGORIES.length, 11);
    assert.equal(contract.PHASES.length, 4);
  });

  it('não importa nada e não usa APIs exclusivas do Node (roda também no navegador)', () => {
    // Só o código conta: os typedefs nos comentários podem citar import('...') como tipo.
    const source = readFileSync(new URL('../../../shared/contract.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.match(source, /export const EVENT_KINDS/, 'o código deveria sobrar depois de tirar os comentários');
    assert.doesNotMatch(source, /^\s*import[\s{*'"]/m, 'import estático');
    assert.doesNotMatch(source, /\bimport\s*\(\s*['"]/, 'import dinâmico');
    assert.doesNotMatch(source, /^\s*export\s[^\n]*\bfrom\s*['"]/m, 'reexportação');
    assert.doesNotMatch(source, /\brequire\s*\(/, 'require');
    assert.doesNotMatch(source, /\b(process|Buffer|__dirname|__filename)\b/, 'global do Node');
  });
});
