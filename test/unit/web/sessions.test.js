// Seletor de sessão: ordem por lastEventAt e escolha (T11a); agrupamento por
// projeto, status e aprovações pendentes de cada sessão, <select> atualizado
// no lugar e aviso de aprovação pendente em outra sessão (T13).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSelectedId, sessionList } from '../../../web/js/selectors.js';
import { applySessionRemoved, applySnapshot, applyUpdate, createStore } from '../../../web/js/store.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { SESSION_STATUS_TEXT, sessionGroups, sessionOptions, sessionText, syncSessionSelect } from '../../../web/js/views/sessions.js';
import { pendingElsewhere, renderPendingAlert } from '../../../web/js/views/topbar.js';
import { XSS, deepFreeze, loadSnapshot } from './support.js';

const THEMES = [escritorio, guilda];

/** Sessão mínima com id, rótulo, projeto e horários. */
function session(id, lastEventAt, extra = {}) {
  return { id, label: `Sessão ${id}`, project: { key: `c:/p/${id}`, name: `projeto-${id}`, dir: `C:\\p\\${id}` }, status: 'active', startedAt: 0, lastEventAt, ...extra };
}

/** Projeto compartilhado por várias sessões. */
const project = (name, dir = `C:\\p\\${name}`) => ({ key: `c:/p/${name}`, name, dir });
const counters = (pendingApprovals) => ({ questsDone: 0, bugsCrushed: 0, pendingApprovals });

/**
 * Elemento falso (select, optgroup ou option) com o que syncSessionSelect usa.
 * O `value` do select segue a opção marcada, como no navegador.
 */
function fakeSelect() {
  const log = { created: 0, removed: 0 };
  /** @param {string} tag */
  const element = (tag) => {
    const node = {
      tag,
      label: '',
      value: '',
      textContent: '',
      selected: false,
      children: [],
      appendChild(child) {
        node.children.push(child);
        return child;
      },
      removeChild(child) {
        node.children.splice(node.children.indexOf(child), 1);
        log.removed++;
        return child;
      },
    };
    return node;
  };
  const select = element('select');
  const options = () => select.children.flatMap((group) => group.children);
  Object.defineProperty(select, 'value', {
    get: () => options().find((o) => o.selected)?.value ?? options()[0]?.value ?? '',
    set: (v) => {
      for (const option of options()) option.selected = option.value === v;
    },
  });
  select.ownerDocument = {
    createElement: (tag) => {
      log.created++;
      return element(tag);
    },
  };
  return { select, log, options };
}

/** Grupos desenhados: [rótulo do grupo, [[valor, texto]...]]. */
const drawn = (select) => select.children.map((group) => [group.tag, group.label, group.children.map((o) => [o.tag, o.value, o.textContent])]);

describe('ordem e escolha', () => {
  it('sessionList: mais recente primeiro por lastEventAt; empate pela que começou depois', () => {
    const list = sessionList([session('a', 10), session('b', 30), session('c', 20), session('d', 30, { startedAt: 5 })]);
    assert.deepEqual(list.map((s) => s.id), ['d', 'b', 'c', 'a']);
  });

  it('começa na mais recente; a escolha vale enquanto a sessão existir; se sumir, volta para a mais recente', () => {
    const list = sessionList([session('a', 10), session('b', 30)]);
    assert.equal(resolveSelectedId(list, null), 'b');
    assert.equal(resolveSelectedId(list, 'a'), 'a');
    const later = sessionList([session('a', 99), session('b', 30)]);
    assert.equal(resolveSelectedId(later, 'b'), 'b', 'outra sessão mais ativa não troca a escolha');
    assert.equal(resolveSelectedId(sessionList([session('b', 30)]), 'a'), 'b');
    assert.equal(resolveSelectedId([], 'a'), null);
  });

  it('com o store: sessão removida volta para a mais recente', () => {
    const store = createStore();
    const neutro = loadSnapshot('neutro').sessions[0];
    const luz = loadSnapshot('primeira-luz').sessions[0];
    applySnapshot(store, deepFreeze({ seq: 10, sessions: [neutro, luz] }));
    let chosen = resolveSelectedId(sessionList(store.sessions.values()), null);
    assert.equal(chosen, luz.id, 'a mais recente por lastEventAt');
    chosen = neutro.id;
    const { feed: _f, ...neutroState } = neutro;
    applyUpdate(store, { seq: 11, event: null, session: { ...neutroState, lastEventAt: luz.lastEventAt - 1 } });
    assert.equal(resolveSelectedId(sessionList(store.sessions.values()), chosen), neutro.id);
    applySessionRemoved(store, { seq: 12, sessionId: neutro.id });
    assert.equal(resolveSelectedId(sessionList(store.sessions.values()), chosen), luz.id);
  });
});

describe('texto de cada sessão', () => {
  it('rótulo, projeto e status; sem rótulo, o id; sem projeto, sem nome de projeto', () => {
    assert.equal(sessionText(session('a', 1)), 'Sessão a · projeto-a · ativa');
    assert.equal(sessionText(session('a', 1, { status: 'idle' })), 'Sessão a · projeto-a · parada');
    assert.equal(sessionText(session('a', 1, { status: 'ended' })), 'Sessão a · projeto-a · encerrada');
    assert.equal(sessionText(session('a', 1, { status: 'waiting' })), 'Sessão a · projeto-a · aguardando aprovação');
    assert.equal(sessionText(session('c', 1, { label: '', project: null })), 'c · ativa');
    assert.equal(sessionText(session('c', 1, { status: 'outro' })), 'Sessão c · projeto-c', 'status desconhecido não aparece');
    assert.deepEqual(Object.keys(SESSION_STATUS_TEXT).sort(), ['active', 'ended', 'idle', 'waiting']);
  });

  it('aprovações pendentes de cada sessão, no singular e no plural, sem repetir "aguardando"', () => {
    assert.equal(sessionText(session('a', 1, { status: 'waiting', counters: counters(1) })), 'Sessão a · projeto-a · 1 aprovação pendente');
    assert.equal(sessionText(session('a', 1, { status: 'waiting', counters: counters(3) })), 'Sessão a · projeto-a · 3 aprovações pendentes');
    assert.equal(sessionText(session('a', 1, { counters: counters(2) })), 'Sessão a · projeto-a · ativa · 2 aprovações pendentes');
    for (const bad of [0, -1, Number.NaN, '2', null]) {
      assert.equal(sessionText(session('a', 1, { counters: counters(bad) })), 'Sessão a · projeto-a · ativa', String(bad));
    }
  });

  it('o projeto aparece uma vez só, dentro da opção (sem linha separada acima do seletor)', () => {
    const [option] = sessionOptions([session('x', 1)], 'x');
    assert.equal(option.text.split('projeto-x').length - 1, 1);
  });
});

describe('agrupamento por projeto', () => {
  it('um grupo por projeto, na ordem da sessão mais recente de cada um; dentro dele, da mais recente para a mais antiga', () => {
    const list = sessionList([
      session('a1', 10, { project: project('alfa') }),
      session('b1', 40, { project: project('beta') }),
      session('a2', 30, { project: project('alfa') }),
      session('b2', 20, { project: project('beta'), status: 'ended' }),
    ]);
    const groups = sessionGroups(list, 'a2', escritorio);
    assert.deepEqual(groups.map((g) => [g.key, g.label, g.options.map((o) => [o.value, o.selected])]), [
      ['c:/p/beta', 'beta', [['b1', false], ['b2', false]]],
      ['c:/p/alfa', 'alfa', [['a2', true], ['a1', false]]],
    ]);
    assert.equal(groups[0].options[1].text, 'Sessão b2 · beta · encerrada');
    assert.deepEqual(sessionOptions(list, 'a2', escritorio).map((o) => o.value), ['b1', 'b2', 'a2', 'a1']);
  });

  for (const theme of THEMES) {
    it(`${theme.id}: sessões sem projeto conhecido ficam juntas, com o texto do tema`, () => {
      const list = [session('x', 30, { project: null }), session('a', 20), session('y', 10, { project: { key: '', name: '', dir: '' } })];
      const groups = sessionGroups(list, 'x', theme);
      assert.deepEqual(groups.map((g) => [g.key, g.label, g.options.map((o) => o.value)]), [
        ['', theme.words.unknownProject, ['x', 'y']],
        ['c:/p/a', 'projeto-a', ['a']],
      ]);
      assert.ok(theme.words.unknownProject.length > 0);
    });
  }

  it('sem tema, o grupo sem projeto usa o texto neutro', () => {
    assert.equal(sessionGroups([session('x', 1, { project: null })], 'x')[0].label, 'Projeto desconhecido');
  });

  it('dois projetos com o mesmo nome em pastas diferentes: a pasta desfaz a dúvida', () => {
    const list = [session('a', 20, { project: project('app', 'C:\\um\\app') }), session('b', 10, { project: { key: 'd:/dois/app', name: 'app', dir: 'D:\\dois\\app' } })];
    assert.deepEqual(sessionGroups(list, 'a').map((g) => g.label), ['app (C:\\um\\app)', 'app (D:\\dois\\app)']);
  });
});

describe('syncSessionSelect', () => {
  const twoProjects = (extra = {}) => sessionList([
    session('a', 30, { project: project('alfa') }),
    session('b', 20, { project: project('beta'), ...extra }),
    session('c', 10, { project: project('alfa') }),
  ]);

  it('desenha um <optgroup> por projeto, com as opções por texto, e marca a escolhida', () => {
    const { select, log } = fakeSelect();
    syncSessionSelect(select, sessionGroups(twoProjects(), 'b', escritorio));
    assert.deepEqual(drawn(select), [
      ['optgroup', 'alfa', [['option', 'a', 'Sessão a · alfa · ativa'], ['option', 'c', 'Sessão c · alfa · ativa']]],
      ['optgroup', 'beta', [['option', 'b', 'Sessão b · beta · ativa']]],
    ]);
    assert.equal(select.value, 'b');
    assert.equal(log.created, 5);
  });

  it('mudou só o texto (status, aprovações, tema): os elementos ficam, só o texto muda', () => {
    const { select, log, options } = fakeSelect();
    syncSessionSelect(select, sessionGroups([...twoProjects(), session('x', 5, { project: null })], 'a', escritorio));
    const before = options();
    const groupsBefore = [...select.children];
    syncSessionSelect(select, sessionGroups([...twoProjects({ status: 'waiting', counters: counters(2) }), session('x', 5, { project: null })], 'a', guilda));
    assert.deepEqual(options().map((o) => o.textContent), ['Sessão a · alfa · ativa', 'Sessão c · alfa · ativa', 'Sessão b · beta · 2 aprovações pendentes', 'Sessão x · ativa']);
    assert.equal(select.children[2].label, guilda.words.unknownProject, 'o rótulo do grupo segue o tema');
    assert.ok(options().every((o, i) => o === before[i]), 'reaproveita as opções (o select e o foco continuam)');
    assert.ok(select.children.every((g, i) => g === groupsBefore[i]));
    assert.equal(log.created, 7);
    assert.equal(log.removed, 0);
    assert.equal(select.value, 'a');
  });

  it('sessão nova, que saiu ou mudou de lugar: a estrutura é refeita e a escolha continua', () => {
    const { select, log } = fakeSelect();
    syncSessionSelect(select, sessionGroups(twoProjects(), 'c'));
    const created = log.created;
    // b passa a ser a mais recente: o grupo beta vai para cima.
    const moved = sessionList([session('a', 30, { project: project('alfa') }), session('b', 50, { project: project('beta') }), session('c', 10, { project: project('alfa') })]);
    syncSessionSelect(select, sessionGroups(moved, 'c'));
    assert.deepEqual(drawn(select).map(([, label, options]) => [label, options.map((o) => o[1])]), [['beta', ['b']], ['alfa', ['a', 'c']]]);
    assert.equal(select.value, 'c');
    assert.ok(log.created > created);
    // Uma sessão sai: o grupo dela some.
    syncSessionSelect(select, sessionGroups(sessionList([session('a', 30, { project: project('alfa') })]), 'a'));
    assert.deepEqual(drawn(select).map(([, label, options]) => [label, options.map((o) => o[1])]), [['alfa', ['a']]]);
    assert.equal(select.value, 'a');
    syncSessionSelect(select, []);
    assert.equal(select.children.length, 0);
  });

  it('texto com HTML entra como texto (textContent e label), sem virar marcação', () => {
    const { select, options } = fakeSelect();
    syncSessionSelect(select, sessionGroups([session('a', 1, { label: XSS, project: project(XSS) })], 'a'));
    assert.equal(options()[0].textContent, `${XSS} · ${XSS} · ativa`);
    assert.equal(select.children[0].label, XSS);
    assert.equal(options()[0].innerHTML, undefined);
    assert.equal(select.children[0].innerHTML, undefined);
  });
});

describe('aviso de aprovação pendente em outra sessão', () => {
  const list = () => sessionList([
    session('atual', 50, { counters: counters(4) }),
    session('outra', 40, { status: 'waiting', counters: counters(2), label: 'Revisar o T13', project: project('beta') }),
    session('velha', 10, { status: 'waiting', counters: counters(1) }),
    session('sem', 30, { counters: counters(0) }),
  ]);

  it('aponta a sessão mais recente com aprovação pendente, fora da mostrada, e conta as outras', () => {
    const found = pendingElsewhere(list(), 'atual');
    assert.equal(found?.session.id, 'outra');
    assert.equal(found?.more, 1);
    assert.equal(pendingElsewhere(list(), 'outra')?.session.id, 'atual');
    assert.equal(pendingElsewhere([session('atual', 1, { counters: counters(3) })], 'atual'), null, 'só a mostrada tem: sem aviso');
    assert.equal(pendingElsewhere([session('a', 1), session('b', 2, { counters: counters(Number.NaN) })], 'a'), null);
    assert.equal(pendingElsewhere([], null), null);
  });

  for (const theme of THEMES) {
    it(`${theme.id}: ícone e palavra do tema, onde está e atalho com chave estável`, () => {
      const now = 60_000;
      const html = renderPendingAlert({ list: list(), selectedId: 'atual', theme, now });
      const pending = theme.stats({ durationMs: 0, bugsCrushed: 0, questsDone: 0, pendingApprovals: 2 }).find((s) => s.id === 'pending');
      assert.ok(pending);
      assert.ok(html.includes(`<span class="alert-icon" aria-hidden="true">${pending.icon}</span>`));
      assert.ok(html.includes(`<b>2</b> ${pending.label} em <span class="alert-where">Revisar o T13 · beta</span> (e mais 1 sessão)`), html);
      assert.match(html, /<button type="button" class="alert-go" data-focus-key="session-alert" data-goto="outra">Ir para a sessão<\/button>/);
      assert.equal(renderPendingAlert({ list: list(), selectedId: 'sem', theme, now }).includes('(e mais 2 sessões)'), true);
      assert.equal(renderPendingAlert({ list: [session('a', 1)], selectedId: 'a', theme, now }), '');
    });
  }

  it('com os snapshots: a sessão aguardando aprovação gera o aviso quando outra é a mostrada', () => {
    const waiting = loadSnapshot('ticket-completo').sessions[0];
    const other = loadSnapshot('primeira-luz').sessions[0];
    const items = sessionList([waiting, other]);
    assert.match(renderPendingAlert({ list: items, selectedId: other.id, theme: escritorio, now: waiting.lastEventAt }), new RegExp(`data-goto="${waiting.id}"`));
    assert.equal(renderPendingAlert({ list: items, selectedId: waiting.id, theme: escritorio, now: waiting.lastEventAt }), '');
  });

  it('texto vindo do servidor é escapado', () => {
    const html = renderPendingAlert({ list: [session('a', 2), session(XSS, 1, { label: XSS, project: project(XSS), counters: counters(1) })], selectedId: 'a', theme: guilda, now: 0 });
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
});

