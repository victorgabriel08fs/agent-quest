// Barra de contexto (T16; ADR 0008; modelo de eventos, seções 6 e 9): Foco no
// Escritório, Mana na Guilda. Mostra o contexto que ainda cabe na janela, com
// "≈" e a fonte no tooltip e no rótulo para leitores de tela, e some quando
// `context` é null. Estados escritos à mão a partir do snapshot ticket-completo.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { contextOf } from '../../../web/js/selectors.js';
import { esc, formatTokens, formatTokensPhrase } from '../../../web/js/themes/helpers.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { CONTEXT_SOURCE, contextText, renderParty } from '../../../web/js/views/party.js';
import { XSS, deepFreeze, loadSession, makeAgent } from './support.js';

const THEMES = [escritorio, guilda];
const MAIN = 'main';
const TESTER = 'a9a4b5c6d7e8f9a03';
const DEV = 'a8a3b4c5d6e7f8a92';

/**
 * Sessão do ticket-completo com `context` nos agentes indicados.
 * @param {Record<string, any>} contexts   chave do agente → context
 */
function sessionWith(contexts) {
  const session = structuredClone(loadSession('ticket-completo'));
  for (const agent of session.agents) {
    if (Object.hasOwn(contexts, agent.key)) agent.context = contexts[agent.key];
  }
  return deepFreeze(session);
}

/** Bloco HTML de uma instância (pela chave). */
function instance(html, key) {
  const start = html.indexOf(`data-key="${key}"`);
  assert.ok(start >= 0, `instância ${key}`);
  const end = html.indexOf('</li>', start);
  return html.slice(start, end);
}

const count = (html, text) => html.split(text).length - 1;

describe('contextOf', () => {
  it('null quando não há leitura ou o valor foge da forma do contrato', () => {
    for (const context of [null, undefined, 'x', 42, {}, { pct: '30', usedTokens: 1, windowTokens: 2 },
      { pct: 30, usedTokens: 60_000, windowTokens: 0 }, { pct: 30, usedTokens: -1, windowTokens: 200_000 },
      { pct: Number.NaN, usedTokens: 1, windowTokens: 2 }, { pct: 30, usedTokens: Infinity, windowTokens: 200_000 },
      { pct: XSS, usedTokens: XSS, windowTokens: XSS }]) {
      assert.equal(contextOf(/** @type {any} */ (makeAgent({ context }))), null, JSON.stringify(context));
    }
    assert.equal(contextOf(/** @type {any} */ (null)), null);
  });

  it('livre = 100 - pct, em décimos para a barra', () => {
    const at = 1;
    assert.deepEqual(contextOf(/** @type {any} */ (makeAgent({ context: { pct: 30, usedTokens: 60_000, windowTokens: 200_000, at } }))),
      { pct: 30, freePct: 70, usedTokens: 60_000, windowTokens: 200_000, tenths: 7 });
    assert.equal(contextOf(/** @type {any} */ (makeAgent({ context: { pct: 0, usedTokens: 0, windowTokens: 1_000_000, at } })))?.tenths, 10);
    assert.equal(contextOf(/** @type {any} */ (makeAgent({ context: { pct: 100, usedTokens: 1_000_000, windowTokens: 1_000_000, at } })))?.tenths, 0);
    assert.equal(contextOf(/** @type {any} */ (makeAgent({ context: { pct: 96, usedTokens: 960_000, windowTokens: 1_000_000, at } })))?.tenths, 0);
    // Fora de 0..100 é limitado (o servidor já limita; defesa).
    assert.equal(contextOf(/** @type {any} */ (makeAgent({ context: { pct: 140, usedTokens: 1, windowTokens: 1, at } })))?.freePct, 0);
    assert.equal(contextOf(/** @type {any} */ (makeAgent({ context: { pct: -5, usedTokens: 1, windowTokens: 1, at } })))?.freePct, 100);
  });
});

describe('formatTokens', () => {
  it('arredonda por extenso, com vírgula decimal', () => {
    const table = [
      [0, '0'], [850, '850'], [1_000, '1 mil'], [1_540, '1,5 mil'], [9_960, '10 mil'], [60_000, '60 mil'],
      [150_400, '150 mil'], [200_000, '200 mil'], [967_432, '967 mil'], [999_600, '1 milhão'],
      [1_000_000, '1 milhão'], [1_250_000, '1,3 milhão'], [2_000_000, '2 milhões'], [Number.NaN, '0'], [-3, '0'],
    ];
    for (const [n, text] of table) assert.equal(formatTokens(/** @type {number} */ (n)), text, String(n));
  });

  it('com a palavra "tokens"', () => {
    assert.equal(formatTokensPhrase(200_000), '200 mil tokens');
    assert.equal(formatTokensPhrase(1_000_000), '1 milhão de tokens');
    assert.equal(formatTokensPhrase(1), '1 token');
    assert.equal(formatTokensPhrase(850), '850 tokens');
  });
});

describe('barra de contexto no cartão da equipe', () => {
  const contexts = {
    [MAIN]: { pct: 15, usedTokens: 150_000, windowTokens: 1_000_000, at: 1 },
    [TESTER]: { pct: 30, usedTokens: 60_000, windowTokens: 200_000, at: 1 },
    [DEV]: null,
  };

  for (const theme of THEMES) {
    for (const discreet of [false, true]) {
      const mode = discreet ? ' (modo discreto)' : '';
      const html = renderParty({ session: sessionWith(contexts), theme, discreet });

      it(`${theme.id}${mode}: uma barra por agente com leitura, com o nome do tema`, () => {
        assert.equal(count(html, 'class="mbar mana"'), 2);
        assert.equal(count(html, 'class="mbar hp"'), count(html, '<li class="inst '), 'a saúde continua em todas as instâncias');
        assert.ok(instance(html, MAIN).includes(`<span class="mb-l" aria-hidden="true">${esc(theme.bars.context)}</span>`));
        assert.ok(!instance(html, DEV).includes('mbar mana'), 'context null: a barra some');
        assert.ok(!instance(html, 'a7a2b3c4d5e6f7a81').includes('mbar mana'));
      });

      it(`${theme.id}${mode}: valor com "≈" e a fonte no tooltip e no rótulo para leitores de tela`, () => {
        const main = `${theme.bars.context} ≈ 85% livre · 150 mil de 1 milhão de tokens usados (15%) · ${CONTEXT_SOURCE}`;
        const tester = `${theme.bars.context} ≈ 70% livre · 60 mil de 200 mil tokens usados (30%) · ${CONTEXT_SOURCE}`;
        for (const [key, text, fill] of [[MAIN, main, 9], [TESTER, tester, 7]]) {
          const block = instance(html, /** @type {string} */ (key));
          assert.ok(block.includes(`class="mb mb-context" title="${esc(text)}"`), `${key}: tooltip`);
          assert.ok(block.includes(`<span class="mbar mana" role="img" aria-label="${esc(text)}"><i data-fill="${fill}"></i></span>`), `${key}: barra`);
        }
        assert.match(CONTEXT_SOURCE, /transcript/);
      });

      it(`${theme.id}${mode}: mini-legenda explica a barra`, () => {
        assert.ok(html.includes(`<i class="sw mana" aria-hidden="true"></i>${esc(theme.bars.context)}: ≈ contexto que ainda cabe na janela do agente`));
      });

      it(`${theme.id}${mode}: sem script, estilo inline nem manipulador`, () => {
        assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=|<script/i);
      });
    }

    it(`${theme.id}: sem nenhum contexto, nem barra nem linha na mini-legenda`, () => {
      const html = renderParty({ session: sessionWith({}), theme });
      assert.ok(!html.includes('mbar mana'));
      assert.ok(!html.includes('sw mana'));
      assert.ok(!html.includes(theme.bars.context));
    });

    it(`${theme.id}: contexto fora da forma não desenha nada nem vaza texto`, () => {
      const html = renderParty({ session: sessionWith({ [MAIN]: { pct: XSS, usedTokens: XSS, windowTokens: XSS, at: XSS } }), theme });
      assert.ok(!html.includes('mbar mana'));
      assert.ok(!html.includes('<img'));
    });

    it(`${theme.id}: agente encerrado com leitura continua com a barra (some só com context null)`, () => {
      const html = renderParty({ session: sessionWith({ [DEV]: { pct: 50, usedTokens: 100_000, windowTokens: 200_000, at: 1 } }), theme });
      assert.ok(instance(html, DEV).includes('mbar mana'));
      assert.ok(instance(html, DEV).includes('data-fill="5"'));
    });
  }

  it('os dois temas mostram os mesmos números, com o próprio nome da barra', () => {
    const view = { pct: 30, freePct: 70, usedTokens: 60_000, windowTokens: 200_000, tenths: 7 };
    assert.equal(contextText(view, escritorio).replace('Foco', 'X'), contextText(view, guilda).replace('Mana', 'X'));
    assert.match(contextText(view, escritorio), /^Foco ≈ /);
    assert.match(contextText(view, guilda), /^Mana ≈ /);
  });

  it('o modo discreto não muda a barra (só números)', () => {
    const session = sessionWith(contexts);
    const pick = (html) => [...html.matchAll(/<span class="mb mb-context"[\s\S]*?<\/span><\/span><\/span>/g)].map((m) => m[0]);
    assert.deepEqual(pick(renderParty({ session, theme: escritorio, discreet: true })), pick(renderParty({ session, theme: escritorio })));
  });
});
