// Legenda (T14): tabela "evento real → frase do tema" gerada pelos próprios
// temas, cobrindo todo tipo do feed e toda categoria de ferramenta, e a seção
// "De onde vem cada dado" com as fontes e aproximações do ADR 0008.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FEED_KINDS, TOOL_CATEGORIES } from '../../../shared/contract.js';
import { createHelpers, esc } from '../../../web/js/themes/helpers.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { LEGEND_EVENTS, legendEvent, legendTitle, renderLegend } from '../../../web/js/views/legend.js';

const THEMES = [escritorio, guilda];

/** Linhas de uma tabela da legenda: [cabeçalho da linha, células], só texto. */
const rows = (html) => [...html.matchAll(/<tr><th scope="row">([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)]
  .map((m) => [m[1].replace(/<[^>]+>/g, '').trim(), [...m[2].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim())]);

/** Parte do HTML entre um título de seção e o próximo. */
const section = (html, title) => {
  const start = html.indexOf(`<h3>${title}</h3>`);
  assert.ok(start >= 0, `seção ${title}`);
  const end = html.indexOf('<h3>', start + 4);
  return html.slice(start, end === -1 ? undefined : end);
};

describe('exemplos de eventos', () => {
  it('cobrem todo tipo do feed e toda categoria de ferramenta', () => {
    const kinds = new Set(LEGEND_EVENTS.map(([, kind]) => kind));
    for (const kind of FEED_KINDS) assert.ok(kinds.has(kind), kind);
    const categories = new Set(LEGEND_EVENTS.filter(([, kind]) => kind === 'tool.started').map(([, , data]) => data.category));
    assert.deepEqual([...categories].sort(), [...TOOL_CATEGORIES].sort());
    const outcomes = new Set(LEGEND_EVENTS.filter(([, kind]) => kind === 'quest.finished').map(([, , data]) => data.outcome));
    assert.deepEqual([...outcomes].sort(), ['done', 'failed', 'interrupted']);
  });

  it('eventos de exemplo seguem a forma do contrato', () => {
    LEGEND_EVENTS.forEach((_, index) => {
      const event = legendEvent(index);
      assert.equal(event.id, `legenda:${index}`);
      assert.equal(event.seq, index + 1);
      assert.ok(typeof event.kind === 'string' && event.data && typeof event.data === 'object');
    });
  });

  for (const theme of THEMES) {
    for (const discreet of [false, true]) {
      it(`${theme.id}${discreet ? ' (modo discreto)' : ''}: toda linha tem a frase do próprio tema, não vazia`, () => {
        const html = renderLegend({ theme, discreet });
        const events = rows(section(html, 'Eventos'));
        assert.equal(events.length, LEGEND_EVENTS.length);
        const h = createHelpers(theme, [], { discreet });
        events.forEach(([label, [phrase]], index) => {
          assert.ok(phrase && phrase.length > 0, `${label}: sem frase`);
          assert.doesNotMatch(phrase, /undefined|null|NaN|\[object/, phrase);
          // A frase é a do tema (mesmo HTML que o feed mostraria, a menos dos nomes dos agentes).
          assert.ok(theme.feedLine(legendEvent(index), h), label);
        });
        if (discreet) {
          for (const sample of ['README.md', 'npm install', 'implementar o painel', 'Implementar o painel', 'Exit code 1']) {
            assert.ok(!section(html, 'Eventos').includes(sample), `${sample} no modo discreto`);
          }
        }
      });
    }
  }

  it('os dois temas traduzem os mesmos eventos com frases diferentes', () => {
    const e = rows(section(renderLegend({ theme: escritorio }), 'Eventos'));
    const g = rows(section(renderLegend({ theme: guilda }), 'Eventos'));
    assert.deepEqual(e.map(([label]) => label), g.map(([label]) => label), 'a coluna do evento real é neutra');
    const different = e.filter(([, [phrase]], index) => phrase !== g[index][1][0]).length;
    assert.ok(different >= e.length - 2, 'quase todas as frases mudam com o tema');
  });
});

describe('lugares, estados e fontes', () => {
  for (const theme of THEMES) {
    const html = renderLegend({ theme });

    it(`${theme.id}: título e salas nos nomes do tema`, () => {
      assert.equal(legendTitle(theme), `Como ler o painel · ${theme.name}`);
      const places = section(html, 'Lugares');
      for (const room of Object.values(theme.rooms)) assert.ok(places.includes(esc(room.name)), room.name);
      for (const role of ['orq', 'arq', 'dev', 'tes', 'doc', 'aux']) assert.ok(places.includes(esc(theme.roles[role].name)), role);
    });

    it(`${theme.id}: estados com a linha de ação do tema`, () => {
      const states = section(html, 'Estados');
      for (const word of [theme.words.waiting, theme.words.idle, theme.words.orqIdle]) assert.ok(states.includes(esc(word)), word);
    });

    it(`${theme.id}: "De onde vem cada dado" traz as fontes e as aproximações do ADR 0008`, () => {
      const sources = section(html, 'De onde vem cada dado');
      const table = rows(sources);
      // O nome pode vir depois do ícone do tema (escondido de leitores de tela).
      const byName = { get: (text) => table.find(([name]) => name === text || name.endsWith(` ${text}`))?.[1] };
      // Indicadores do topo, com os nomes do tema.
      const stats = theme.stats({ durationMs: 0, bugsCrushed: 2, questsDone: 2, pendingApprovals: 2 });
      const label = (id) => stats.find((s) => s.id === id)?.label;
      assert.equal(byName.get(label('bugs'))?.[1], 'Aproximado (≈)');
      assert.equal(byName.get(label('quests'))?.[1], 'Real');
      assert.equal(byName.get(label('pending'))?.[1], 'Real');
      assert.equal(byName.get('Duração da sessão')?.[1], 'Real');
      assert.equal(byName.get(theme.bars.health)?.[1], 'Aproximado (≈)');
      assert.equal(byName.get(`Bugs na cena (${theme.rooms.test.name})`)?.[1], 'Aproximado (≈)');
      assert.equal(byName.get(theme.words.quest)?.[1], 'Real');
      assert.equal(byName.get('Etapas do ticket')?.[1], 'Derivado');
      assert.equal(byName.get(theme.words.party)?.[1], 'Real');
      // Fontes de cada um (ADR 0008).
      assert.match(byName.get(theme.bars.health)?.[0] ?? '', /últimas 10 ações/);
      // Barra de contexto (T16), com o nome do tema, a fonte e a regra da janela.
      assert.equal(byName.get(theme.bars.context)?.[1], 'Aproximado (≈)');
      const context = byName.get(theme.bars.context)?.[0] ?? '';
      assert.match(context, /message\.usage.*transcript.*~\/\.claude\/projects/);
      assert.match(context, /1 milhão de tokens por padrão; 200 mil para Opus e Sonnet até 4\.6, Haiku 4\.x e Claude 3\.x/);
      assert.match(context, /some .*compactação/);
      assert.match(byName.get(label('pending'))?.[0] ?? '', /PermissionRequest/);
      assert.match(byName.get(theme.words.quest)?.[0] ?? '', /UserPromptSubmit.*Stop/);
      for (const phase of Object.values(theme.phases)) assert.ok(byName.get('Etapas do ticket')?.[0].includes(phase), phase);
      // Nada do que saiu da v1 aparece como indicador.
      assert.match(sources, /Custo, XP, níveis e conquistas não fazem parte desta versão/);
      assert.ok(!table.some(([name]) => /custo|XP|nível|conquista/i.test(name)));
    });

    it(`${theme.id}: modo discreto e atalhos explicados`, () => {
      const help = section(html, 'Modo discreto e atalhos');
      assert.match(help, /Rodando um comando/);
      for (const key of ['1', '2', 'T', 'D', '?']) assert.ok(help.includes(`<kbd>${key}</kbd>`), key);
    });

    it(`${theme.id}: só marcação conhecida; nada de script, estilo ou manipuladores`, () => {
      assert.doesNotMatch(html, /<script|<img|<iframe|\sstyle=|\son[a-z]+=/i);
      const tags = new Set([...html.matchAll(/<([a-z0-9]+)[\s>]/g)].map((m) => m[1]));
      for (const tag of tags) assert.ok(['p', 'h3', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'b', 'i', 'code', 'kbd', 'span'].includes(tag), tag);
    });
  }
});
