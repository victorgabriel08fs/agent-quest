// Robustez do código do T11a e do T12a (cena, seletor e store) com valores
// extremos do contrato, como a varredura do tester para as views do T10a
// (test/integration/web-views-hostile.test.js): nada lança exceção, abre HTML
// ou mostra "undefined".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSelectedId, sessionList } from '../../../web/js/selectors.js';
import { renderScene } from '../../../web/js/scene.js';
import { applySnapshot, applyUpdate, createStore } from '../../../web/js/store.js';
import { renderFeed } from '../../../web/js/views/feed.js';
import { sessionOptions } from '../../../web/js/views/sessions.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { SNAPSHOT_NAMES, XSS, loadSession } from './support.js';

const THEMES = [escritorio, guilda];
const NUMBERS = [0, -1, 0.5, 8.64e15 + 1, 1e16, -1e16, Number.MAX_SAFE_INTEGER, 1e308, -1e308];
const STRINGS = ['', 'x'.repeat(2000), `${String.fromCodePoint(0x202e)}a${String.fromCodePoint(0x200b)}`, 'constructor', '__proto__', XSS];
const LEAKS = ['undefined', '[object ', 'NaN'];

/** Troca todas as folhas de um tipo pelo valor. */
function fill(value, type, replacement) {
  if (Array.isArray(value)) return value.map((item) => fill(item, type, replacement));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, type, replacement)]));
  return typeof value === type ? replacement : value;
}

/** Desenha cena, seletor e projeto, e passa pelo store; devolve o problema ou null. */
function problemOf(session, theme) {
  let html;
  let texts;
  try {
    const list = sessionList([session]);
    const options = sessionOptions(list, resolveSelectedId(list, null));
    html = renderScene({ session, theme });
    // Os textos das opções entram por textContent: podem conter "<", mas não podem vazar.
    texts = options.map((o) => o.text).join('');
    const store = createStore();
    applySnapshot(store, { seq: 1, sessions: [session] });
    const { feed: _feed, ...state } = session;
    applyUpdate(store, { seq: 2, event: session.feed?.[0] ?? null, session: state });
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
  if (/<img|<script/i.test(html)) return 'HTML aberto';
  const leak = LEAKS.find((token) => html.includes(token) || texts.includes(token));
  return leak ? `vazou "${leak}"` : null;
}

describe('valores extremos no código do T11a e do T12a', () => {
  for (const name of SNAPSHOT_NAMES) {
    it(`${name}: números e textos extremos não quebram cena, seletor nem store`, () => {
      const problems = [];
      for (const [type, values] of /** @type {const} */ ([['number', NUMBERS], ['string', STRINGS]])) {
        for (const value of values) {
          const session = fill(loadSession(name), type, value);
          for (const theme of THEMES) {
            const problem = problemOf(session, theme);
            if (problem) problems.push(`${type} = ${JSON.stringify(value).slice(0, 20)} (${theme.id}) → ${problem}`);
          }
        }
      }
      assert.deepEqual(problems, []);
    });
  }

  it('campos ausentes ou nulos degradam sem exceção', () => {
    const cases = {
      'agents nulo': (s) => { s.agents = null; },
      'quest e project nulos': (s) => { s.quest = null; s.project = null; },
      'status e papéis novos': (s) => { s.agents.forEach((a) => { a.status = 'sleeping'; a.role = 'quantum'; }); },
      'atividade sem campos': (s) => { s.agents.forEach((a) => { a.activity = { kind: 'tool' }; }); },
      'rótulo e projeto vazios': (s) => { s.label = ''; s.project = { key: '', name: '', dir: '' }; },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const session = loadSession('ticket-completo');
      mutate(session);
      for (const theme of THEMES) assert.equal(problemOf(session, theme), null, `${name} (${theme.id})`);
    }
  });

  it('feed com ts fora do intervalo de datas continua desenhando todas as linhas (regressão do T10a)', () => {
    const session = loadSession('primeira-luz');
    const bad = structuredClone(session);
    bad.feed[0].ts = 1e16;
    bad.feed[1].ts = -1e16;
    const count = (html) => (html.match(/<li class="entry/g) ?? []).length;
    for (const theme of THEMES) {
      const html = renderFeed({ session: bad, theme });
      assert.equal(count(html), count(renderFeed({ session, theme })));
      assert.match(html, /data-id="k3f9q:101"[^>]*>.*?<\/div><\/div><\/li>/, 'a linha sem horário continua no feed');
    }
  });
});
