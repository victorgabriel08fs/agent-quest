// Integração do T10a (tester): contrato servidor → painel com valores extremos.
//
// As views (indicadores do topo, equipe, ticket e feed) recebem o
// `SessionState` do servidor (modelo de eventos, seção 9). Aqui os campos dos
// snapshots de test/fixtures/state/ recebem valores do tipo certo, porém
// extremos (números enormes ou negativos, textos vazios, longos, com Unicode,
// com HTML ou com nomes herdados de Object), mais enumerações que ainda não
// existem e campos opcionais ausentes. Nos dois temas, as views nunca podem
// lançar exceção (no navegador, uma exceção no desenho deixa o painel parado),
// nem abrir HTML, nem mostrar "undefined" ou "[object ...]".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderFeed } from '../../web/js/views/feed.js';
import { renderParty } from '../../web/js/views/party.js';
import { renderQuest } from '../../web/js/views/quest.js';
import { renderStats } from '../../web/js/views/topbar.js';
import escritorio from '../../web/js/themes/escritorio.js';
import guilda from '../../web/js/themes/guilda.js';

const THEMES = [escritorio, guilda];
const SNAPSHOTS = ['neutro', 'primeira-luz', 'ticket-completo'];
const NOW = Date.UTC(2026, 9, 18, 17, 0, 0);

/** Números válidos em JSON, inclusive fora do intervalo de datas do JavaScript (±8,64e15 ms). */
const NUMBERS = [0, -1, 0.5, 8.64e15 + 1, 1e16, -1e16, Number.MAX_SAFE_INTEGER, 1e308, -1e308];
/** Textos válidos em JSON (o terceiro tem controle de direção e largura zero). */
const STRINGS = [
  '',
  'x'.repeat(2000),
  `${String.fromCodePoint(0x202e)}evil${String.fromCodePoint(0x200b)}`,
  '\u{1F469}‍\u{1F4BB}',
  'constructor',
  '__proto__',
  '<img src=x onerror=alert(1)>',
];
const LEAKS = ['undefined', '[object ', 'function (', 'native code'];

function loadSession(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/state/${name}.json`, import.meta.url), 'utf8')).sessions[0];
}

/** Caminhos das folhas de um tipo (número ou texto). */
function leafPaths(value, type, prefix = []) {
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leafPaths(v, type, [...prefix, k]));
  return typeof value === type ? [prefix] : [];
}

/** Desenha todas as views; lança se alguma lançar. */
function renderAll(session, theme) {
  return [
    renderStats(session, theme, NOW),
    renderParty({ session, theme }),
    renderQuest({ session, theme, now: NOW }),
    renderFeed({ session, theme }),
  ].join('');
}

/** Problema de um desenho (exceção, HTML aberto ou texto vazado), ou null. */
function problemOf(session, theme) {
  let html;
  try {
    html = renderAll(session, theme);
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
  if (/<img|<script/i.test(html)) return 'HTML aberto';
  const leak = LEAKS.find((token) => html.includes(token));
  return leak ? `vazou "${leak}"` : null;
}

const label = (keys) => keys.map((k) => (/^\d+$/.test(k) ? '[]' : k)).join('.');

function setAt(session, keys, value) {
  let node = session;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys.at(-1)] = value;
}

/**
 * Duas varreduras: (1) cada valor extremo em todos os campos do tipo ao mesmo
 * tempo; (2) cada campo sozinho, com um dos valores em rodízio. Devolve os
 * problemas encontrados, sem repetir.
 */
function sweep(name, type, values) {
  const base = loadSession(name);
  const paths = leafPaths(base, type);
  const problems = new Set();
  for (const value of values) {
    const session = structuredClone(base);
    for (const keys of paths) setAt(session, keys, value);
    for (const theme of THEMES) {
      const problem = problemOf(session, theme);
      if (problem) problems.add(`todos os campos = ${JSON.stringify(value).slice(0, 24)} (${theme.id}) → ${problem}`);
    }
  }
  paths.forEach((keys, index) => {
    const value = values[index % values.length];
    const session = structuredClone(base);
    setAt(session, keys, value);
    for (const theme of THEMES) {
      const problem = problemOf(session, theme);
      if (problem) problems.add(`${label(keys)} = ${JSON.stringify(value).slice(0, 24)} → ${problem}`);
    }
  });
  return [...problems];
}

describe('T10a integração: views com valores extremos do contrato', () => {
  for (const name of SNAPSHOTS) {
    it(`${name}: números extremos nos campos numéricos não derrubam as views`, () => {
      assert.deepEqual(sweep(name, 'number', NUMBERS), []);
    });

    it(`${name}: textos extremos nos campos de texto não derrubam nem abrem HTML`, () => {
      assert.deepEqual(sweep(name, 'string', STRINGS), []);
    });
  }

  it('evento com ts fora do intervalo de datas: o feed continua desenhando as outras linhas', () => {
    const session = loadSession('primeira-luz');
    const bad = structuredClone(session);
    bad.feed[0].ts = 1e16;
    const count = (text) => (text.match(/<li class="entry/g) ?? []).length;
    for (const theme of THEMES) {
      let html = '';
      assert.doesNotThrow(() => { html = renderFeed({ session: bad, theme }); }, theme.id);
      assert.equal(count(html), count(renderFeed({ session, theme })), theme.id);
    }
  });

  it('enumerações que ainda não existem e campos opcionais ausentes degradam sem exceção', () => {
    const cases = {
      'feed ausente (update)': (s) => { delete s.feed; },
      'agents e roster ausentes': (s) => { delete s.agents; delete s.roster; },
      'counters e project nulos': (s) => { s.counters = null; s.project = null; },
      'tipo de evento novo': (s) => { s.feed.forEach((e) => { e.kind = 'agent.teleported'; }); },
      'categoria nova': (s) => {
        s.feed.forEach((e) => { if (e.data && 'category' in e.data) e.data.category = 'quantum'; });
        s.agents.forEach((a) => { if (a.activity) a.activity.category = 'quantum'; });
      },
      'status novos': (s) => { s.status = 'sleeping'; s.agents.forEach((a) => { a.status = 'sleeping'; }); s.quest.status = 'archived'; },
      'etapas nulas': (s) => { s.quest.phases = null; },
      'saúde e dados nulos': (s) => { s.agents.forEach((a) => { a.health = null; }); s.feed.forEach((e) => { e.data = null; }); },
      'atividade sem campos': (s) => { s.agents.forEach((a) => { a.activity = { kind: 'tool' }; }); },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const session = loadSession('ticket-completo');
      mutate(session);
      for (const theme of THEMES) assert.equal(problemOf(session, theme), null, `${name} (${theme.id})`);
    }
  });
});
