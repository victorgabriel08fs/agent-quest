// Cena animada (T12b): o que decide os efeitos entre dois desenhos (fx.js, puro)
// e o que a cena ganhou (selo de aprovação, bugs e "+N", alarme). O movimento
// no DOM é conferido no E2E (test/e2e/scene-fx.spec.js).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FINALE_MS, finaleRemaining,
  DELEGATION_WINDOW_MS, FX_IDS, delegationTarget, flipDelta, questSummary, sceneChanges,
} from '../../../web/js/fx.js';
import { MAX_BUGS_SHOWN, openBugs, renderScene } from '../../../web/js/scene.js';
import { esc } from '../../../web/js/themes/helpers.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { deepFreeze, loadSession, makeAgent, makeEvent } from './support.js';

const THEMES = [escritorio, guilda];
const CSS = ['scene.css', 'themes.css', 'base.css'].map((name) => readFileSync(new URL(`../../../web/css/${name}`, import.meta.url), 'utf8')).join('\n');

/** Sessão com o feed e o estado trocados. */
const withFeed = (session, feed, extra = {}) => ({ ...session, feed, ...extra });
/** Contexto como o fx.js monta: tema e sessão. */
const ctx = (session, theme = 'escritorio') => `${theme}|${session?.id ?? ''}`;

describe('sceneChanges', () => {
  const base = loadSession('primeira-luz');

  it('primeiro desenho (ou outra sessão, ou outro tema): nada anima, só guarda a memória', () => {
    const first = sceneChanges(null, deepFreeze(base), ctx(base));
    assert.equal(first.animate, false);
    assert.deepEqual(first.delegations, []);
    assert.deepEqual(first.hits, []);
    assert.equal(first.memory.seq, 121);
    assert.deepEqual(first.bugs, { from: 0, to: 0 });

    const other = sceneChanges(first.memory, base, ctx(base, 'guilda'));
    assert.equal(other.animate, false, 'trocar de tema não anima');
    const none = sceneChanges(first.memory, null, ctx(null));
    assert.equal(none.animate, false);
  });

  it('eventos novos: delegação, falha (não a interrompida) e ticket entregue, em ordem', () => {
    const before = withFeed(base, base.feed.slice(0, 10));
    const memory = sceneChanges(null, before, ctx(base)).memory;
    const changes = sceneChanges(memory, base, ctx(base));
    assert.equal(changes.animate, true);
    assert.deepEqual(changes.delegations.map((d) => [d.seq, d.fromKey, d.toRole, d.description]), [
      [114, 'main', 'dev', 'portar o painel do mockup'],
    ]);
    assert.deepEqual(changes.hits, ['a4c3b2a1f0e9d8c74'], 'a falha do tester; a interrompida (121) não tem impacto');
    assert.equal(changes.finale, null);
    assert.equal(changes.memory.seq, 121);

    const again = sceneChanges(changes.memory, base, ctx(base));
    assert.deepEqual([again.delegations, again.hits], [[], []], 'o mesmo evento não anima duas vezes');
  });

  it('feed com seq menor (outra execução do servidor) não dispara efeitos', () => {
    const memory = sceneChanges(null, base, ctx(base)).memory;
    const restarted = withFeed(base, [{ ...base.feed[11], id: 'nova:3', seq: 3 }]);
    const changes = sceneChanges(memory, restarted, ctx(base));
    assert.deepEqual([changes.hits, changes.delegations], [[], []]);
    assert.equal(changes.memory.seq, 121);
  });

  it('bugs: de quantos para quantos; ausente ou inválido vale zero', () => {
    const done = loadSession('ticket-completo');
    const memory = sceneChanges(null, done, ctx(done)).memory;
    assert.equal(memory.bugs, 2);
    const more = sceneChanges(memory, { ...done, bugs: { open: 6, lastRun: null } }, ctx(done));
    assert.deepEqual(more.bugs, { from: 2, to: 6 });
    const zero = sceneChanges(more.memory, { ...done, bugs: { open: 0, lastRun: null } }, ctx(done));
    assert.deepEqual(zero.bugs, { from: 6, to: 0 });
    for (const open of [null, -3, 'x', Number.NaN, 1e400]) {
      assert.equal(sceneChanges(null, /** @type {any} */ ({ ...done, bugs: { open } }), 'c').memory.bugs, 0, String(open));
    }
    assert.equal(sceneChanges(null, /** @type {any} */ ({ ...done, bugs: { open: 2.9 } }), 'c').memory.bugs, 2);
  });

  it('ticket entregue: cartão final com o resumo (ações, agentes e duração), sem XP', () => {
    const open = loadSession('ticket-completo');
    const delivered = loadSession('ticket-entregue');
    const memory = sceneChanges(null, open, ctx(open)).memory;
    const changes = sceneChanges(memory, delivered, ctx(delivered));
    assert.deepEqual(changes.finale, { n: 3, title: 'Implementar a ingestão', actions: 47, agents: 4, durationMs: 331_000 });
    assert.deepEqual(changes.bugs, { from: 2, to: 0 });
    for (const theme of THEMES) {
      const card = theme.finale(/** @type {any} */ (changes.finale));
      assert.ok(card.sub.includes('47 ações'), theme.id);
      assert.ok(card.sub.includes('05:31'), theme.id);
      assert.doesNotMatch(`${card.title} ${card.sub}`, /XP|n[ií]vel/i, theme.id);
    }
  });

  it('ticket que falhou ou foi interrompido não abre o cartão final', () => {
    const open = loadSession('ticket-completo');
    const memory = sceneChanges(null, open, ctx(open)).memory;
    for (const outcome of ['failed', 'interrupted']) {
      const feed = [...open.feed, makeEvent('quest.finished', { questId: 'pr-0003', n: 3, outcome }, 'main', 400)];
      assert.equal(sceneChanges(memory, { ...open, feed }, ctx(open)).finale, null, outcome);
    }
  });

  it('dados adulterados não lançam', () => {
    const odd = /** @type {any} */ ({ id: 's', feed: [null, 1, { seq: 'x' }, { seq: 5, kind: 'agent.delegated', agentKey: '', data: null }, { seq: 6, kind: 'tool.failed', agentKey: 'k' }], agents: null, bugs: null });
    const memory = sceneChanges(null, { ...odd, feed: [] }, 'c').memory;
    const changes = sceneChanges(memory, odd, 'c');
    assert.deepEqual(changes.delegations, []);
    assert.deepEqual(changes.hits, ['k']);
  });
});

describe('delegationTarget', () => {
  const ts = 1_000_000;
  const delegation = { seq: 1, ts, fromKey: 'main', toRole: 'dev', description: 'implementar a ingestão' };
  const agent = (key, fields) => makeAgent({ key, agentId: key, role: 'dev', parentKey: 'main', startedAt: ts + 30, ...fields });

  it('a instância filha de quem delegou, com o rótulo igual à descrição', () => {
    const session = /** @type {any} */ ({ agents: [makeAgent({ key: 'main' }), agent('a', { label: 'outra coisa' }), agent('b', { label: 'implementar a ingestão' })] });
    assert.equal(delegationTarget(session, delegation), 'b');
  });

  it('sem rótulo igual, a mais antiga do papel chamado; nunca uma já usada, de outro pai ou velha demais', () => {
    const session = /** @type {any} */ ({
      agents: [
        makeAgent({ key: 'main' }),
        agent('velha', { label: '', startedAt: ts - DELEGATION_WINDOW_MS - 1 }),
        agent('outro-pai', { label: '', parentKey: 'x' }),
        agent('tes', { label: '', role: 'tes' }),
        agent('c', { label: '', startedAt: ts + 50 }),
        agent('d', { label: '', startedAt: ts + 40 }),
      ],
    });
    assert.equal(delegationTarget(session, delegation), 'd');
    assert.equal(delegationTarget(session, delegation, new Set(['d'])), 'c');
    assert.equal(delegationTarget(session, delegation, new Set(['c', 'd'])), null);
  });

  it('corrida inversa: a instância criada até 2 s antes do Pre também vale', () => {
    const session = /** @type {any} */ ({ agents: [agent('cedo', { label: 'implementar a ingestão', startedAt: ts - 1500 })] });
    assert.equal(delegationTarget(session, delegation), 'cedo');
  });

  it('sem sessão ou sem candidata: null', () => {
    assert.equal(delegationTarget(null, delegation), null);
    assert.equal(delegationTarget(/** @type {any} */ ({ agents: [makeAgent({ key: 'main' })] }), delegation), null);
  });
});

describe('questSummary', () => {
  it('conta o principal e quem teve evento depois do início do ticket', () => {
    const session = loadSession('ticket-entregue');
    const event = session.feed.at(-1);
    assert.equal(event.kind, 'quest.finished');
    assert.deepEqual(questSummary(session, event), { n: 3, title: 'Implementar a ingestão', actions: 47, agents: 4, durationMs: 331_000 });
  });

  it('ticket de outro id: sem título, todos os agentes contam', () => {
    const session = loadSession('ticket-entregue');
    const event = makeEvent('quest.finished', { questId: 'outro', n: 9, outcome: 'done', actions: 2, durationMs: 1000 }, 'main');
    assert.deepEqual(questSummary(session, event), { n: 9, title: '', actions: 2, agents: session.agents.length, durationMs: 1000 });
  });
});

describe('flipDelta', () => {
  const box = (left, top, width = 46) => ({ left, top, width, height: width });

  it('do centro antigo para o novo, com a escala do tamanho antigo', () => {
    assert.deepEqual(flipDelta(box(100, 50), box(20, 200)), { dx: 80, dy: -150, scale: 1 });
    const resized = flipDelta(box(0, 0, 46), box(0, 0, 36));
    assert.ok(resized);
    assert.equal(resized.dx, 5);
    assert.equal(resized.scale, 46 / 36);
  });

  it('sem mudança (menos de 1 px e 2% de tamanho): null', () => {
    assert.equal(flipDelta(box(10, 10), box(10.4, 9.6)), null);
    assert.equal(flipDelta(box(10, 10, 46), box(10, 10, 46.5)), null);
    assert.equal(flipDelta(box(0, 0, 10), box(0, 0, 0)) !== null, true, 'largura zero não divide por zero');
  });
});

describe('cena: estados do T8 (snapshots escritos à mão)', () => {
  for (const theme of THEMES) {
    it(`${theme.id}: agente aguardando tem o selo "!" e o balão de aprovação do tema`, () => {
      const html = renderScene({ session: loadSession('ticket-completo'), theme });
      const test = html.split('data-room="test"')[1].split('data-room=')[0];
      assert.match(test, /<div class="token waiting" data-key="a9a4b5c6d7e8f9a03"/);
      assert.ok(test.includes(`<span class="bubble-text">${esc(theme.words.waiting)}</span>`));
      assert.ok(test.includes(`<div class="tok-av">${esc(theme.roles.tes.icon)}<i class="tok-alert" aria-hidden="true">!</i></div>`));
      assert.equal((html.match(/tok-alert/g) ?? []).length, 1, 'só quem aguarda');
    });

    it(`${theme.id}: bugs na sala de testes conforme bugs.open, sala em alarme e contagem para leitores de tela`, () => {
      const session = loadSession('ticket-completo');
      const html = renderScene({ session, theme });
      const test = html.split('data-room="test"')[1].split('data-room=')[0];
      assert.match(html, /<div class="room active alarm" data-room="test"/);
      assert.equal((test.match(/<span class="bug" data-bug="\d"><i><\/i><\/span>/g) ?? []).length, 2);
      assert.ok(!test.includes('bug-more'));
      assert.match(html, /aria-label="Cena: [^"]*, 2 falhas de teste em aberto"/);
      assert.equal((html.match(/alarm/g) ?? []).length, 1, 'só a sala de testes');
    });

    it(`${theme.id}: até ${MAX_BUGS_SHOWN} bugs e "+N"; sem bugs, sem alarme`, () => {
      const session = loadSession('ticket-completo');
      const many = renderScene({ session: { ...session, bugs: { open: 7, lastRun: null } }, theme });
      assert.deepEqual([...many.matchAll(/data-bug="(\d)"/g)].map((m) => m[1]), ['0', '1', '2', '3']);
      assert.match(many, /<span class="bug-more">\+3<\/span>/);
      const none = renderScene({ session: loadSession('ticket-entregue'), theme });
      assert.ok(!none.includes('class="bug') && !none.includes('alarm'));
      assert.match(renderScene({ session: { ...session, bugs: { open: 1, lastRun: null } }, theme }), /, 1 falha de teste em aberto"/);
    });
  }

  it('openBugs: inteiro não negativo', () => {
    assert.equal(openBugs(null), 0);
    assert.equal(openBugs(/** @type {any} */ ({ bugs: { open: 3.7 } })), 3);
    assert.equal(openBugs(/** @type {any} */ ({ bugs: { open: -2 } })), 0);
    assert.equal(openBugs(/** @type {any} */ ({ bugs: { open: '4' } })), 0);
  });
});

describe('CSS da cena animada', () => {
  it('cada tema define o texto sobre o aviso e os ícones do envelope, do bug e do confete', () => {
    for (const id of ['escritorio', 'guilda']) {
      const block = CSS.slice(CSS.indexOf(`:root[data-theme="${id}"] {`));
      const body = block.slice(0, block.indexOf('\n}'));
      for (const name of ['--on-warn', '--fx-message', '--fx-bug', '--fx-burst-1', '--fx-burst-2', '--fx-burst-3', '--fx-burst-4']) {
        assert.match(body, new RegExp(`${name}:\\s*[^;]+;`), `${id}: ${name}`);
      }
    }
  });

  it('animações contínuas do mockup e as posições dos bugs têm regra; a camada .fx não recebe cliques', () => {
    for (const name of ['bob', 'ping', 'crawl', 'menace', 'alarm', 'fadein', 'fadeout', 'popin']) assert.match(CSS, new RegExp(`@keyframes ${name} `), name);
    for (let n = 0; n < MAX_BUGS_SHOWN; n++) assert.ok(CSS.includes(`.bug[data-bug="${n}"]`), `bug ${n}`);
    assert.match(CSS, /\.fx \{[^}]*pointer-events: none;/);
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  });

  it('ids das animações (para os testes ponta a ponta) são únicos', () => {
    const ids = Object.values(FX_IDS);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id.startsWith('fx-')));
  });
});

describe('cartão final na troca de tema (T14)', () => {
  const finale = { summary: { n: 1, title: '', actions: 3, agents: 2, durationMs: 1000 }, sessionId: 's1', shownAt: 10_000 };

  it('mesma sessão: o tempo que faltava; outra sessão, sem cartão ou tempo esgotado: 0', () => {
    assert.equal(finaleRemaining(finale, 's1', 10_000), FINALE_MS);
    assert.equal(finaleRemaining(finale, 's1', 11_000), FINALE_MS - 1_000);
    assert.equal(finaleRemaining(finale, 's1', 10_000 + FINALE_MS), 0);
    assert.equal(finaleRemaining(finale, 's1', 10_000 + FINALE_MS + 5_000), 0);
    assert.equal(finaleRemaining(finale, 's2', 10_500), 0);
    assert.equal(finaleRemaining(null, 's1', 10_500), 0);
    assert.equal(finaleRemaining(finale, 's1', 9_000), FINALE_MS, 'relógio que voltou não aumenta o tempo');
  });
});
