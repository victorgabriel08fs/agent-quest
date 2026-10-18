// Contrato dos temas (ADR 0009): Escritório e Guilda com as mesmas chaves,
// texto para todo tipo de evento do feed e toda categoria de ferramenta, papel
// aux, escape de todo dado dinâmico e nada do que o ADR 0008 tirou da v1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_STATUS, EVENT_KINDS, FEED_KINDS, PHASES, QUEST_STATUS, ROLES, TOOL_CATEGORIES } from '../../../shared/contract.js';
import { ROOM_IDS, THEME_KEYS, checkTheme, resolveThemeId, themeIdForKey } from '../../../web/js/themes/contract.js';
import { createHelpers, esc } from '../../../web/js/themes/helpers.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { XSS, makeAgent, makeEvent, mapStrings } from './support.js';

const THEMES = [escritorio, guilda];
const AGENTS = [
  makeAgent({ key: 'main', role: 'orq' }),
  makeAgent({ key: 'a-arq', role: 'arq', agentType: 'arquiteto' }),
  makeAgent({ key: 'a-dev', role: 'dev', agentType: 'dev-backend' }),
  makeAgent({ key: 'a-tes', role: 'tes', agentType: 'tester' }),
  makeAgent({ key: 'a-doc', role: 'doc', agentType: 'documentador' }),
  makeAgent({ key: 'a-aux', role: 'aux', agentType: 'Explore' }),
];
const AGENT_KEYS = AGENTS.map((agent) => agent.key);

/** Dados de exemplo para cada tipo de evento (tabela da seção 3). */
const SAMPLE_DATA = {
  'session.started': { source: 'startup', projectName: 'agents-quest' },
  'session.ended': { reason: 'logout' },
  'session.idle': {},
  'quest.started': { questId: 'q1', n: 1, title: 'Implementar a ingestão', implicit: false },
  'quest.finished': { questId: 'q1', n: 1, outcome: 'done', error: null, durationMs: 61_000, actions: 3 },
  'quest.phase': { questId: 'q1', phase: 'code', state: 'done' },
  'agent.delegated': { toolUseId: 't1', toType: 'tester', toRole: 'tes', description: 'testar a ingestão', background: false },
  'agent.started': { agentType: 'tester', role: 'tes', label: 'testar a ingestão', parentKey: 'main' },
  'agent.finished': { outcome: 'done' },
  'tool.started': { toolUseId: 't2', tool: 'Read', category: 'read', target: 'server/main.js', detail: null },
  'tool.finished': { toolUseId: 't2', tool: 'Read', category: 'read', durationMs: 12 },
  'tool.failed': { toolUseId: 't3', tool: 'Bash', category: 'bash', target: 'npm test', error: 'Exit code 1', interrupted: false },
  'test.finished': { toolUseId: 't4', ok: false, passed: 12, failed: 2, total: 14, framework: 'node:test' },
  'permission.requested': { tool: 'Bash', category: 'bash', target: 'npm install' },
  'permission.resolved': { outcome: 'approved', by: 'user' },
  'context.compacted': { trigger: 'auto' },
  'context.usage': { pct: 40, usedTokens: 80_000, windowTokens: 200_000 },
};

/** Variações que precisam de frase própria. */
const VARIANTS = [
  ['session.started', { source: 'resume', projectName: 'agents-quest' }],
  ['session.started', { source: 'clear', projectName: 'agents-quest' }],
  ['session.started', { source: 'compact', projectName: 'agents-quest' }],
  ['session.started', { source: 'fork', projectName: 'agents-quest' }],
  ['session.started', { source: 'desconhecida', projectName: null }],
  ['session.ended', { reason: null }],
  ['quest.started', { questId: 'q2', n: 2, title: 'Tarefa em andamento', implicit: true }],
  ['quest.finished', { questId: 'q1', n: 1, outcome: 'failed', error: 'rate_limit', durationMs: 1_000, actions: 1 }],
  ['quest.finished', { questId: 'q1', n: 1, outcome: 'interrupted', error: null, durationMs: 1_000, actions: 1 }],
  ['quest.finished', { questId: 'q1', n: 1, outcome: 'outro' }],
  ['agent.delegated', { toolUseId: 't1', toType: 'Explore', toRole: 'aux', description: '', background: true }],
  ['agent.finished', { outcome: 'unknown' }],
  ['tool.failed', { toolUseId: 't3', tool: 'Bash', category: 'bash', target: 'npm test', error: null, interrupted: true }],
  ['tool.failed', { toolUseId: 't3', tool: 'Read', category: 'read', target: null, error: null, interrupted: false }],
  ['test.finished', { toolUseId: 't4', ok: true, passed: 14, failed: 0, total: 14, framework: 'node:test' }],
  ['test.finished', { toolUseId: 't4', ok: true, passed: null, failed: null, total: null, framework: null }],
  ['test.finished', { toolUseId: 't4', ok: false, passed: null, failed: null, total: null, framework: null }],
  ['test.finished', { toolUseId: 't4', ok: false, passed: 0, failed: 1, total: 1, framework: 'jest' }],
  ['permission.resolved', { outcome: 'denied', by: 'auto' }],
  ['permission.resolved', { outcome: 'unknown', by: 'inferred' }],
  ['context.compacted', { trigger: 'manual' }],
];

/**
 * Caminhos de chaves de um valor (objetos aninhados), para comparar a forma
 * dos temas. Funções contam como folha.
 * @param {any} value
 * @param {string} [prefix]
 * @returns {string[]}
 */
function keyPaths(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${prefix}:${Array.isArray(value) ? `array(${value.length})` : typeof value}`];
  }
  return Object.keys(value).sort().flatMap((key) => keyPaths(value[key], prefix ? `${prefix}.${key}` : key));
}

/** @param {string|null} text */
function assertCleanText(text, context) {
  assert.equal(typeof text, 'string', `${context}: deveria ser texto`);
  assert.ok(text.trim().length > 0, `${context}: texto vazio`);
  assert.doesNotMatch(text, /undefined|null|NaN|\[object/, `${context}: ${text}`);
}

describe('contrato dos temas', () => {
  for (const theme of THEMES) {
    it(`${theme.id}: segue o contrato (chaves, papéis, salas, etapas e barras)`, () => {
      assert.deepEqual(checkTheme(theme, { roles: ROLES, phases: PHASES }), []);
      assert.deepEqual(Object.keys(theme).sort(), [...THEME_KEYS].sort());
      assert.deepEqual(Object.keys(theme.roles).sort(), [...ROLES].sort());
      assert.deepEqual(Object.keys(theme.rooms).sort(), [...ROOM_IDS].sort());
      assert.deepEqual(Object.keys(theme.phases).sort(), [...PHASES].sort());
      assert.deepEqual(Object.keys(theme.words.questStatus).sort(), [...QUEST_STATUS].sort());
    });
  }

  it('Escritório e Guilda têm exatamente as mesmas chaves (paridade)', () => {
    assert.deepEqual(keyPaths(escritorio), keyPaths(guilda));
  });

  it('cada tema tem id, nome e ícone próprios', () => {
    assert.deepEqual(THEMES.map((t) => t.id), ['escritorio', 'guilda']);
    assert.notEqual(escritorio.name, guilda.name);
    assert.notEqual(escritorio.icon, guilda.icon);
  });

  it('checkTheme aponta o que falta', () => {
    const broken = { ...escritorio, roles: { ...escritorio.roles, aux: undefined }, feedLine: 'x' };
    const problems = checkTheme(broken, { roles: ROLES, phases: PHASES });
    assert.ok(problems.some((p) => p.includes('roles.aux')));
    assert.ok(problems.some((p) => p.includes('"feedLine" não é função')));
    assert.deepEqual(checkTheme(null, { roles: ROLES, phases: PHASES }), ['o tema não é um objeto']);
  });

  it('os exemplos de dados cobrem todos os tipos de evento do contrato', () => {
    assert.deepEqual(Object.keys(SAMPLE_DATA).sort(), [...EVENT_KINDS].sort());
  });
});

describe('feedLine', () => {
  for (const theme of THEMES) {
    const h = createHelpers(theme, AGENTS);

    it(`${theme.id}: todo tipo de FEED_KINDS gera HTML não vazio`, () => {
      for (const kind of FEED_KINDS) {
        for (const agentKey of AGENT_KEYS) {
          assertCleanText(theme.feedLine(makeEvent(kind, SAMPLE_DATA[kind], agentKey), h), `${kind} (${agentKey})`);
        }
      }
    });

    it(`${theme.id}: tipos fora do feed e etapa que só começou devolvem null`, () => {
      for (const kind of EVENT_KINDS.filter((k) => !FEED_KINDS.includes(k))) {
        assert.equal(theme.feedLine(makeEvent(kind, SAMPLE_DATA[kind]), h), null, kind);
      }
      assert.equal(theme.feedLine(makeEvent('quest.phase', { questId: 'q1', phase: 'code', state: 'active' }), h), null);
    });

    it(`${theme.id}: variações (origens, desfechos, testes, aprovações) têm frase própria`, () => {
      const seen = new Set();
      for (const [kind, data] of VARIANTS) {
        const line = theme.feedLine(makeEvent(kind, data, 'a-tes'), h);
        assertCleanText(line, `${kind} ${JSON.stringify(data)}`);
        seen.add(line);
      }
      assert.ok(seen.size >= VARIANTS.length - 2, 'variações demais com a mesma frase');
    });

    it(`${theme.id}: toda categoria de ferramenta gera uma frase diferente, para cada papel`, () => {
      for (const agentKey of AGENT_KEYS) {
        const lines = TOOL_CATEGORIES.map((category) => {
          const line = theme.feedLine(makeEvent('tool.started', { toolUseId: 't', tool: 'Ferramenta', category, target: 'alvo.txt', detail: 'detalhe' }, agentKey), h);
          assertCleanText(line, `${category} (${agentKey})`);
          return line;
        });
        assert.equal(new Set(lines).size, TOOL_CATEGORIES.length, `${agentKey}: categorias com a mesma frase`);
      }
    });

    it(`${theme.id}: sem alvo, a frase usa o nome da ferramenta`, () => {
      for (const category of TOOL_CATEGORIES) {
        const line = theme.feedLine(makeEvent('tool.started', { toolUseId: 't', tool: 'MinhaFerramenta', category, target: null, detail: null }, 'a-dev'), h);
        assertCleanText(line, category);
      }
      const read = theme.feedLine(makeEvent('tool.started', { tool: 'NotebookRead', category: 'read', target: null }, 'a-dev'), h);
      assert.match(read, /NotebookRead/);
    });

    it(`${theme.id}: categoria ou desfecho desconhecido (inclusive chave herdada) cai no padrão`, () => {
      for (const category of ['nova', 'constructor', 'toString', undefined]) {
        assertCleanText(theme.feedLine(makeEvent('tool.started', { tool: 'X', category, target: 'y' }, 'a-dev'), h), String(category));
      }
      for (const outcome of ['constructor', 'hasOwnProperty']) {
        assertCleanText(theme.feedLine(makeEvent('quest.finished', { n: 1, outcome }), h), outcome);
        assertCleanText(theme.feedLine(makeEvent('permission.resolved', { outcome }, 'a-dev'), h), outcome);
      }
    });

    it(`${theme.id}: convidado aparece pelo agent_type real, inclusive como alvo de delegação`, () => {
      const own = theme.feedLine(makeEvent('tool.started', { tool: 'Grep', category: 'search', target: 'x' }, 'a-aux'), h);
      assert.match(own, /<b>Explore<\/b>/);
      const delegated = theme.feedLine(makeEvent('agent.delegated', { toType: 'general-purpose', toRole: 'aux', description: 'd' }), h);
      assert.match(delegated, /<b>general-purpose<\/b>/);
    });

    it(`${theme.id}: escreve e edita com o verbo de cada papel`, () => {
      const verbs = AGENT_KEYS.map((key) => theme.feedLine(makeEvent('tool.started', { tool: 'Write', category: 'write', target: 'a.md' }, key), h));
      assert.ok(new Set(verbs).size >= 4, 'papéis demais com o mesmo verbo');
    });

    it(`${theme.id}: todo texto dinâmico sai escapado`, () => {
      const vectorAgents = mapStrings(AGENTS, (text, key) => (key === 'key' || key === 'role' ? text : `${text}${XSS}`));
      const hx = createHelpers(theme, vectorAgents);
      const samples = [...Object.entries(SAMPLE_DATA), ...VARIANTS];
      for (const category of TOOL_CATEGORIES) samples.push(['tool.started', { tool: 'T', category, target: 't', detail: 'd' }]);
      for (const [kind, data] of samples) {
        const dirty = mapStrings(data, (text, key) => (['category', 'outcome', 'state', 'source', 'toRole'].includes(key ?? '') ? text : `${text}${XSS}`));
        for (const agentKey of AGENT_KEYS) {
          const line = theme.feedLine(makeEvent(kind, dirty, agentKey), hx);
          if (line === null) continue;
          assert.ok(!line.includes('<img'), `${kind}: ${line}`);
        }
      }
      const line = theme.feedLine(makeEvent('tool.started', { tool: 'Read', category: 'read', target: XSS }, 'a-dev'), hx);
      assert.ok(line.includes(esc(XSS)), line);
    });
  }
});

describe('actionText', () => {
  for (const theme of THEMES) {
    const h = createHelpers(theme, AGENTS);

    it(`${theme.id}: sem agente (papel sem instância) e encerrado mostram o texto de ocioso`, () => {
      assert.equal(theme.actionText(null, h), theme.words.idle);
      assert.equal(theme.actionText(makeAgent({ key: 'a', role: 'dev', status: 'idle', finished: true }), h), theme.words.idle);
    });

    it(`${theme.id}: orquestrador ocioso aguarda o próximo pedido; aguardando aprovação tem destaque`, () => {
      assert.equal(theme.actionText(makeAgent({ status: 'idle' }), h), theme.words.orqIdle);
      assert.equal(theme.actionText(makeAgent({ key: 'a', role: 'tes', status: 'waiting' }), h), theme.words.waiting);
    });

    it(`${theme.id}: todo status, tipo de atividade e categoria geram texto puro`, () => {
      const activities = [
        null,
        { kind: 'start', category: null, tool: null, target: null, detail: null, state: 'running', at: 0 },
        { kind: 'delegate', category: null, tool: 'Agent', target: 'tester', detail: 'testar', state: 'running', at: 0 },
        { kind: 'delegate', category: null, tool: 'Agent', target: null, detail: null, state: 'running', at: 0 },
        { kind: 'compact', category: null, tool: null, target: null, detail: null, state: 'running', at: 0 },
        ...TOOL_CATEGORIES.flatMap((category) => ['running', 'done', 'failed'].map((state) => (
          { kind: 'tool', category, tool: 'Ferramenta', target: 'alvo.js', detail: null, state, at: 0 }))),
        { kind: 'tool', category: 'read', tool: 'Read', target: null, detail: null, state: 'running', at: 0 },
        { kind: 'tool', category: 'constructor', tool: 'X', target: 'y', detail: null, state: 'running', at: 0 },
      ];
      for (const role of ROLES) {
        for (const status of AGENT_STATUS) {
          for (const activity of activities) {
            const text = theme.actionText(makeAgent({ key: role === 'orq' ? 'main' : 'a', role, status, activity }), h);
            assertCleanText(text, `${role}/${status}/${activity?.kind}/${activity?.category}/${activity?.state}`);
            assert.doesNotMatch(text, /</, 'actionText devolve texto puro, sem HTML');
          }
        }
      }
    });

    it(`${theme.id}: ação em andamento mostra o alvo como chegou do servidor`, () => {
      const agent = makeAgent({ key: 'a', role: 'dev', status: 'working', activity: { kind: 'tool', category: 'edit', tool: 'Edit', target: 'server/http/app.js', detail: null, state: 'running', at: 0 } });
      assert.match(theme.actionText(agent, h), /server\/http\/app\.js$/);
      const bash = makeAgent({ key: 'a', role: 'dev', status: 'working', activity: { kind: 'tool', category: 'bash', tool: 'Bash', target: 'npm test', detail: null, state: 'running', at: 0 } });
      assert.match(theme.actionText(bash, h), /npm test/);
    });
  }
});

describe('stats e finale', () => {
  for (const theme of THEMES) {
    it(`${theme.id}: indicadores do ADR 0008 zerados aparecem como zero`, () => {
      const stats = theme.stats({ durationMs: 0, bugsCrushed: 0, questsDone: 0, pendingApprovals: 0 });
      assert.deepEqual(stats.map((s) => s.id), ['duration', 'bugs', 'quests', 'pending']);
      assert.deepEqual(stats.map((s) => s.value), ['00:00', '0', '0', '0']);
      assert.ok(stats.every((s) => !s.highlight));
      for (const stat of stats) {
        for (const field of ['icon', 'value', 'label', 'title']) assertCleanText(stat[field], `${stat.id}.${field}`);
      }
    });

    it(`${theme.id}: aprovação pendente ganha destaque; singular e plural`, () => {
      const one = theme.stats({ durationMs: 3_661_000, bugsCrushed: 1, questsDone: 1, pendingApprovals: 1 });
      const many = theme.stats({ durationMs: 0, bugsCrushed: 3, questsDone: 2, pendingApprovals: 2 });
      assert.equal(one[0].value, '1:01:01');
      assert.ok(one.find((s) => s.id === 'pending')?.highlight);
      for (let index = 1; index < one.length; index++) assert.notEqual(one[index].label, many[index].label);
    });

    it(`${theme.id}: o indicador aproximado de bugs leva "≈" no tooltip`, () => {
      const bugs = theme.stats({ durationMs: 0, bugsCrushed: 0, questsDone: 0, pendingApprovals: 0 }).find((s) => s.id === 'bugs');
      assert.match(bugs?.title ?? '', /≈/);
    });

    it(`${theme.id}: finale resume ações, agentes e duração, sem XP`, () => {
      const card = theme.finale({ n: 3, title: 'T', actions: 12, agents: 3, durationMs: 271_000 });
      assertCleanText(card.icon, 'icon');
      assertCleanText(card.title, 'title');
      assert.match(card.sub, /12 ações/);
      assert.match(card.sub, /04:31/);
      assert.doesNotMatch(card.sub, /XP/);
    });
  }
});

describe('fora da v1 (ADR 0008)', () => {
  it('nenhum texto de tema fala de XP, nível, conquista, promoção ou custo', () => {
    const forbidden = /\bXP\b|n[íi]vel|\bNv\.|conquista|promo[çc][ãa]o|custo|ouro gasto|US\$|\$\d/i;
    for (const theme of THEMES) {
      const h = createHelpers(theme, AGENTS);
      const texts = [JSON.stringify(theme)];
      for (const [kind, data] of [...Object.entries(SAMPLE_DATA), ...VARIANTS]) texts.push(theme.feedLine(makeEvent(kind, data), h) ?? '');
      texts.push(JSON.stringify(theme.stats({ durationMs: 1, bugsCrushed: 1, questsDone: 1, pendingApprovals: 1 })));
      texts.push(JSON.stringify(theme.finale({ n: 1, title: 't', actions: 1, agents: 1, durationMs: 1 })));
      for (const text of texts) assert.doesNotMatch(text, forbidden, `${theme.id}: ${text}`);
    }
  });
});

describe('escolha do tema', () => {
  const ids = ['escritorio', 'guilda'];

  it('hash da URL vence o localStorage; valores inválidos são ignorados', () => {
    assert.equal(resolveThemeId(['guilda', 'escritorio'], ids), 'guilda');
    assert.equal(resolveThemeId(['', 'guilda'], ids), 'guilda');
    assert.equal(resolveThemeId(['outro', null], ids), 'escritorio');
    assert.equal(resolveThemeId([undefined, 'toString'], ids), 'escritorio');
  });

  it('teclas 1 e 2 escolhem; T alterna; o resto não é de tema', () => {
    assert.equal(themeIdForKey('1', 'guilda', ids), 'escritorio');
    assert.equal(themeIdForKey('2', 'escritorio', ids), 'guilda');
    assert.equal(themeIdForKey('3', 'escritorio', ids), null);
    assert.equal(themeIdForKey('t', 'escritorio', ids), 'guilda');
    assert.equal(themeIdForKey('T', 'guilda', ids), 'escritorio');
    for (const key of ['x', ' ', 'Enter', '0', '?']) assert.equal(themeIdForKey(key, 'escritorio', ids), null);
  });
});
