// Filtros e animação de entrada do feed (T11b): filtro por papel e por
// instância, pelos chips e pelos cartões da equipe, como no mockup; linhas
// novas no topo com a classe da animação; a lista atualizada no lugar.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ALL, NEW_ENTRY_CLASS, agentFilter, entryMatches, feedEntries, feedModel, feedSubjects, nextFilter, parseFilter, renderFeed,
  resolveFilter, roleFilter, syncFeedList,
} from '../../../web/js/views/feed.js';
import { renderParty } from '../../../web/js/views/party.js';
import { createHelpers, esc } from '../../../web/js/themes/helpers.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { XSS, deepFreeze, loadSession, makeAgent, makeEvent } from './support.js';

const THEMES = [escritorio, guilda];

/** Chaves dos agentes do snapshot da Primeira luz. */
const DEV_INGEST = 'a1f0c9d8e7b6a5f41';
const DEV_REVIEW = 'a3d2c1b0a9f8e7d63';
const TESTER = 'a4c3b2a1f0e9d8c74';
const GUEST = 'a5b4a3f2e1d0c9b85';
const DEV_PANEL = 'a2e1d0c9b8a7f6e52';

/** Valores de um atributo, na ordem do HTML. */
const attrs = (html, name) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
/** Ids das linhas visíveis (sem hidden) de um HTML de feed. */
const visibleIds = (html) => [...html.matchAll(/<li class="entry[^"]*" data-id="([^"]*)"[^>]*?( hidden)?>/g)].filter((m) => !m[2]).map((m) => m[1]);
const seqOf = (id) => Number(id.split(':')[1]);

describe('valor do filtro', () => {
  it('papel e instância viram texto e voltam; valor desconhecido vale "Todos"', () => {
    assert.equal(roleFilter('dev'), 'role:dev');
    assert.equal(agentFilter('main'), 'agent:main');
    assert.deepEqual(parseFilter('role:tes'), { kind: 'role', role: 'tes' });
    assert.deepEqual(parseFilter('agent:a:b'), { kind: 'agent', key: 'a:b' }, 'a chave pode ter dois-pontos');
    for (const value of ['', 'role:', 'agent:', 'tes', null, undefined, 42, {}]) assert.deepEqual(parseFilter(value), { kind: 'all' }, String(value));
  });

  it('chips escolhem; cartões alternam (clicar de novo volta para "Todos"), como no mockup', () => {
    assert.equal(nextFilter(ALL, 'role:dev', 'set'), 'role:dev');
    assert.equal(nextFilter('role:dev', 'role:dev', 'set'), 'role:dev', 'chip apertado continua apertado');
    assert.equal(nextFilter('role:dev', '', 'set'), ALL, '"Todos"');
    assert.equal(nextFilter('agent:x', '', 'set'), ALL, '"Todos" desfaz também o filtro por instância');
    assert.equal(nextFilter(ALL, 'role:dev', 'toggle'), 'role:dev');
    assert.equal(nextFilter('role:dev', 'role:dev', 'toggle'), ALL);
    assert.equal(nextFilter('role:dev', 'agent:x', 'toggle'), 'agent:x');
    assert.equal(nextFilter('agent:x', 'agent:x', 'toggle'), ALL);
    assert.equal(nextFilter('role:dev', 'lixo', 'toggle'), ALL);
  });

  it('resolveFilter: vale enquanto o controle existe (papel nos chips, instância no cartão)', () => {
    const session = deepFreeze(loadSession('primeira-luz'));
    assert.equal(resolveFilter(session, 'role:doc'), 'role:doc', 'papel do roster, mesmo sem instância');
    assert.equal(resolveFilter(session, `agent:${DEV_REVIEW}`), `agent:${DEV_REVIEW}`, 'encerrada que aparece no cartão');
    assert.equal(resolveFilter(session, 'agent:main'), 'agent:main');
    assert.equal(resolveFilter(session, 'agent:sumiu'), ALL);
    assert.equal(resolveFilter(session, 'role:quantum'), ALL);
    assert.equal(resolveFilter(session, 'role:doc'.toUpperCase()), ALL);
    assert.equal(resolveFilter(null, 'role:dev'), ALL);
    assert.equal(resolveFilter(session, ''), ALL);

    const neutro = loadSession('neutro');
    assert.equal(resolveFilter(neutro, 'role:dev'), ALL, 'papel fora do roster não tem chip');
  });

  it('resolveFilter: instância que passou para o "+N" ou para um ticket anterior perde o filtro', () => {
    const session = loadSession('ticket-completo');
    const start = session.quest.startedAt;
    const arq = session.agents.find((a) => a.role === 'arq' && a.lastEventAt < start);
    assert.ok(arq, 'o snapshot tem uma encerrada do ticket anterior');
    assert.equal(resolveFilter(session, agentFilter(arq.key)), ALL);
    const extra = [1, 2, 3, 4].map((n) => ({ ...arq, key: `extra${n}`, agentId: `extra${n}`, lastEventAt: start + n * 1_000 }));
    const crowded = { ...session, agents: [...session.agents, ...extra] };
    assert.equal(resolveFilter(crowded, 'agent:extra4'), 'agent:extra4', 'entre as 3 mais recentes');
    assert.equal(resolveFilter(crowded, 'agent:extra1'), ALL, 'foi para o "+N"');
  });
});

describe('papéis e agentes de cada linha (agentsOf do mockup)', () => {
  const session = loadSession('primeira-luz');
  const h = createHelpers(escritorio, session.agents);

  it('delegação conta para quem delegou e para o papel chamado; a instância é só quem delegou', () => {
    const event = makeEvent('agent.delegated', { toType: 'tester', toRole: 'tes', description: 'x' }, 'main');
    assert.deepEqual(feedSubjects(event, h), { roles: ['orq', 'tes'], keys: ['main'] });
    const nested = makeEvent('agent.delegated', { toType: 'dev-backend', toRole: 'dev' }, DEV_INGEST);
    assert.deepEqual(feedSubjects(nested, h), { roles: ['dev'], keys: [DEV_INGEST] }, 'dev delegando a dev não repete o papel');
    const bogus = makeEvent('agent.delegated', { toRole: 'quantum' }, 'main');
    assert.deepEqual(feedSubjects(bogus, h), { roles: ['orq'], keys: ['main'] });
  });

  it('ferramentas, falhas e fim de subagente contam para o agente do evento', () => {
    assert.deepEqual(feedSubjects(makeEvent('tool.started', { category: 'read' }, TESTER), h), { roles: ['tes'], keys: [TESTER] });
    assert.deepEqual(feedSubjects(makeEvent('tool.failed', {}, GUEST), h), { roles: ['aux'], keys: [GUEST] });
    assert.deepEqual(feedSubjects(makeEvent('agent.finished', { outcome: 'done' }, DEV_REVIEW), h), { roles: ['dev'], keys: [DEV_REVIEW] });
    assert.deepEqual(feedSubjects(makeEvent('tool.started', {}, 'removido'), h), { roles: ['aux'], keys: ['removido'] },
      'agente que saiu do estado: mesmo papel do retrato (convidado)');
  });

  it('etapa concluída conta para o papel dono; sessão e ticket só aparecem em "Todos"', () => {
    assert.deepEqual(feedSubjects(makeEvent('quest.phase', { phase: 'test', state: 'done' }, TESTER), h), { roles: ['tes'], keys: [TESTER] });
    assert.deepEqual(feedSubjects(makeEvent('quest.phase', { phase: 'toString', state: 'done' }, 'main'), h), { roles: [], keys: ['main'] });
    for (const kind of ['session.started', 'session.ended', 'quest.started', 'quest.finished']) {
      assert.deepEqual(feedSubjects(makeEvent(kind, {}, kind.startsWith('session') ? null : 'main'), h), { roles: [], keys: [] }, kind);
    }
  });

  it('entryMatches', () => {
    const entry = { roles: ['orq', 'tes'], keys: ['main'] };
    assert.equal(entryMatches(entry, ALL), true);
    assert.equal(entryMatches(entry, 'role:tes'), true);
    assert.equal(entryMatches(entry, 'role:dev'), false);
    assert.equal(entryMatches(entry, 'agent:main'), true);
    assert.equal(entryMatches(entry, 'agent:outro'), false);
    assert.equal(entryMatches({ roles: [], keys: [] }, 'role:orq'), false);
  });
});

describe('cartão de atividade com filtro', () => {
  for (const theme of THEMES) {
    const session = loadSession('primeira-luz');

    it(`${theme.id}: chips "Todos" e um por papel do cartão da equipe, com retrato e rótulo "Só ..."`, () => {
      const { filters } = feedModel({ session, theme });
      assert.deepEqual(attrs(filters, 'data-filter'), ['', 'role:orq', 'role:arq', 'role:dev', 'role:tes', 'role:doc', 'role:aux']);
      assert.deepEqual(attrs(filters, 'aria-pressed'), ['true', 'false', 'false', 'false', 'false', 'false', 'false']);
      assert.ok(filters.includes('>Todos</button>'));
      for (const role of ['orq', 'dev', 'aux']) {
        assert.ok(filters.includes(`aria-label="${esc(`Só ${theme.roles[role].name}`)}">${theme.roles[role].icon}</button>`), role);
      }
      assert.match(filters, /class="chip chip-ag" data-filter="role:dev" data-agent="dev"/);
    });

    it(`${theme.id}: filtro por papel mostra o papel e as delegações a ele; o chip fica apertado`, () => {
      const html = renderFeed({ session, theme, filter: 'role:tes' });
      assert.deepEqual(visibleIds(html).map(seqOf), [112, 111, 107]);
      assert.equal(attrs(html.split('<ol')[0], 'aria-pressed').filter((v) => v === 'true').length, 1);
      assert.match(html, /data-filter="role:tes" data-agent="tes" aria-pressed="true"/);
      assert.ok(html.includes('3 de 21 eventos'));
    });

    it(`${theme.id}: filtro por instância mostra só as linhas dela; só o chip da instância (T14) fica apertado`, () => {
      const html = renderFeed({ session, theme, filter: `agent:${DEV_INGEST}` });
      assert.deepEqual(visibleIds(html).map(seqOf), [113, 110, 104]);
      const chips = html.split('<ol')[0];
      assert.deepEqual(attrs(chips, 'data-filter'), ['', 'role:orq', 'role:arq', 'role:dev', 'role:tes', 'role:doc', 'role:aux', `agent:${DEV_INGEST}`]);
      assert.deepEqual(attrs(chips, 'aria-pressed'), ['false', 'false', 'false', 'false', 'false', 'false', 'false', 'true']);
      assert.ok(chips.includes(`<button type="button" class="chip chip-inst" data-filter="agent:${DEV_INGEST}" data-toggle="" data-agent="dev" aria-pressed="true" `));
      assert.ok(chips.includes(`<span aria-hidden="true">${theme.roles.dev.icon}</span><span class="chip-l">implementar a ingestão</span></button>`));
      assert.ok(html.includes('3 de 21 eventos'));

      // Sessão principal sem rótulo: o nome curto do papel no tema.
      const main = renderFeed({ session, theme, filter: 'agent:main' });
      assert.deepEqual(visibleIds(main).map(seqOf), [121, 119, 117, 116, 114, 108, 107, 103, 102]);
      assert.ok(main.includes(`<span class="chip-l">${esc(theme.roles.orq.short)}</span>`));

      // Convidado: o rótulo; no modo discreto, o agent_type (o rótulo vem da descrição da delegação).
      assert.ok(renderFeed({ session, theme, filter: `agent:${GUEST}` }).includes('<span class="chip-l">mapear os hooks do Claude Code</span>'));
      const hidden = renderFeed({ session, theme, filter: `agent:${GUEST}`, discreet: true });
      assert.ok(hidden.includes('<span class="chip-l">Explore</span>'));
      assert.ok(!hidden.includes('mapear os hooks'));
    });

    it(`${theme.id}: o chip da instância não aparece com outro filtro nem com instância que não existe`, () => {
      assert.ok(!feedModel({ session, theme }).filters.includes('chip-inst'));
      assert.ok(!feedModel({ session, theme, filter: 'role:dev' }).filters.includes('chip-inst'));
      assert.ok(!feedModel({ session, theme, filter: 'agent:sumiu' }).filters.includes('chip-inst'));
    });

    it(`${theme.id}: rótulo da instância com HTML sai escapado no chip`, () => {
      const evil = { ...session, agents: session.agents.map((agent) => (agent.key === DEV_INGEST ? { ...agent, label: XSS } : agent)) };
      const { filters } = feedModel({ session: evil, theme, filter: `agent:${DEV_INGEST}` });
      assert.ok(filters.includes(`<span class="chip-l">${esc(XSS)}</span>`));
      assert.ok(!filters.includes('<img'));
    });

    it(`${theme.id}: "Todos" mostra tudo, sem hidden e sem "de"`, () => {
      const html = renderFeed({ session, theme });
      assert.equal(visibleIds(html).length, 21);
      assert.ok(!html.includes(' hidden'));
      assert.ok(html.includes('>21 eventos<'));
    });

    it(`${theme.id}: filtro sem nenhuma linha mostra a mensagem de feed vazio do tema`, () => {
      const model = feedModel({ session, theme, filter: 'role:doc' });
      assert.equal(model.visible, 0);
      assert.equal(model.empty, esc(theme.words.noFeed));
      assert.ok(model.head.includes('0 de 21 eventos'));
      assert.equal(feedModel({ session, theme }).empty, '');
    });
  }

  it('sem sessão: só o título e o vazio, sem chips', () => {
    const model = feedModel({ session: null, theme: escritorio, filter: 'role:dev' });
    assert.equal(model.filters, '');
    assert.equal(model.filter, ALL);
    assert.equal(model.context, '');
    assert.deepEqual(model.entries, []);
    assert.ok(!renderFeed({ session: null, theme: escritorio }).includes('chip'));
  });

  it('linhas com chave única mesmo com id repetido ou ausente; ordem do mais recente', () => {
    const session = loadSession('neutro');
    const feed = [makeEvent('tool.started', { category: 'read' }, 'main', 3), makeEvent('tool.started', { category: 'read' }, 'main', 4)];
    feed[0].id = 'igual';
    feed[1].id = 'igual';
    const entries = feedEntries({ ...session, feed: [...feed, { ...makeEvent('tool.started', {}, 'main', 5), id: undefined }] }, escritorio);
    const ids = entries.map((e) => e.id);
    assert.equal(new Set(ids).size, 3);
    assert.equal(ids[0], 'seq:5');
  });

  it('escapa o que vem nos papéis e nas chaves', () => {
    const session = loadSession('primeira-luz');
    const hostile = { ...session, agents: session.agents.map((a) => (a.key === 'main' ? a : { ...a, key: `${a.key}${XSS}` })) };
    const html = renderFeed({ session: hostile, theme: guilda, filter: `agent:${DEV_INGEST}${XSS}` });
    assert.ok(!html.includes('<img'));
    const party = renderParty({ session: hostile, theme: guilda, filter: `agent:${DEV_INGEST}${XSS}` });
    assert.ok(!party.includes('<img'));
    assert.ok(party.includes(`data-filter="agent:${esc(`${DEV_INGEST}${XSS}`)}" aria-pressed="true"`));
  });
});

describe('cartão da equipe com filtro', () => {
  const session = loadSession('primeira-luz');

  for (const theme of THEMES) {
    it(`${theme.id}: um botão por papel e um por instância, com o valor do filtro`, () => {
      const html = renderParty({ session, theme });
      const filters = attrs(html, 'data-filter');
      assert.deepEqual(filters.filter((v) => v.startsWith('role:')), ['role:orq', 'role:arq', 'role:dev', 'role:tes', 'role:doc', 'role:aux']);
      assert.deepEqual(filters.filter((v) => v.startsWith('agent:')).sort(),
        ['agent:main', `agent:${DEV_INGEST}`, `agent:${DEV_PANEL}`, `agent:${DEV_REVIEW}`, `agent:${TESTER}`, `agent:${GUEST}`].sort());
      assert.ok(!html.includes('aria-pressed="true"'));
      assert.ok(html.includes(`<button type="button" class="m-name m-pick" data-filter="role:dev" aria-pressed="false" title="${esc(`Filtrar a atividade: só ${theme.roles.dev.name}`)}">${esc(theme.roles.dev.name)}</button>`));
    });

    it(`${theme.id}: papel apertado marca o bloco; instância apertada marca a linha`, () => {
      const role = renderParty({ session, theme, filter: 'role:dev' });
      assert.match(role, /<li class="member working is-filter" data-agent="dev">/);
      assert.equal(role.split('aria-pressed="true"').length - 1, 1);
      assert.match(role, /data-filter="role:dev" aria-pressed="true"/);

      const inst = renderParty({ session, theme, filter: `agent:${TESTER}` });
      assert.match(inst, new RegExp(`<li class="inst working is-filter" data-key="${TESTER}"><button type="button" class="inst-pick" data-filter="agent:${TESTER}" aria-pressed="true"`));
      assert.equal(inst.split('aria-pressed="true"').length - 1, 1);
      assert.ok(!inst.includes('member working is-filter'));
    });
  }

  it('dentro dos botões só há elementos de frase (nada de div, lista ou outro botão)', () => {
    const html = renderParty({ session, theme: escritorio });
    const buttons = html.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
    assert.ok(buttons.length >= 12);
    for (const button of buttons) {
      const inner = button.replace(/^<button\b[^>]*>/, '');
      assert.doesNotMatch(inner, /<(div|ul|ol|li|p|button|a)\b/, button.slice(0, 80));
    }
  });

  it('instância sem chave aparece sem botão (não há como filtrar)', () => {
    const odd = { ...session, agents: [...session.agents, makeAgent({ key: '', role: 'tes', status: 'working', label: 'sem chave', lastEventAt: session.lastEventAt })] };
    const html = renderParty({ session: odd, theme: escritorio });
    assert.match(html, /<li class="inst working" data-key=""><span class="inst-pick is-static">/);
  });
});

// ---------------------------------------------------------------------------
// Lista no lugar
// ---------------------------------------------------------------------------

/** <li> falso com o que syncFeedList usa. */
function fakeNode(html) {
  const classes = new Set();
  const listeners = new Map();
  return {
    html,
    hidden: false,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type) => listeners.get(type)?.(),
  };
}

/** <ol> falsa; conta as linhas que já estavam na lista e mudaram de lugar. */
function fakeList() {
  const children = [];
  const list = {
    children,
    moved: 0,
    insertBefore(node, ref) {
      const from = children.indexOf(node);
      if (from >= 0) {
        children.splice(from, 1);
        list.moved++;
      }
      const at = ref ? children.indexOf(ref) : -1;
      if (at < 0) children.push(node);
      else children.splice(at, 0, node);
    },
    removeChild(node) {
      children.splice(children.indexOf(node), 1);
    },
    replaceChild(node, old) {
      children.splice(children.indexOf(old), 1, node);
    },
  };
  return list;
}

/** Sessão da Primeira luz só com os `n` primeiros eventos do feed. */
const upTo = (n, base = loadSession('primeira-luz')) => ({ ...base, feed: base.feed.slice(0, n) });
const sync = (list, session, theme = escritorio, filter = ALL) => syncFeedList(list, feedModel({ session, theme, filter }), fakeNode);
const shown = (list) => list.children.map((node) => seqOf(node.html.match(/data-id="([^"]*)"/)[1]));
const animated = (list) => list.children.filter((node) => node.classList.contains(NEW_ENTRY_CLASS)).map((node) => seqOf(node.html.match(/data-id="([^"]*)"/)[1]));

describe('syncFeedList', () => {
  it('primeiro desenho da sessão: todas as linhas, mais recentes no topo, sem animação', () => {
    const list = fakeList();
    const result = sync(list, upTo(18));
    assert.equal(result.rebuilt, true);
    assert.equal(result.animated, 0);
    assert.equal(list.children.length, 18);
    assert.equal(shown(list)[0], 118);
    assert.deepEqual(animated(list), []);
  });

  it('linhas novas entram no topo com a animação; as que continuam não são recriadas nem movidas', () => {
    const list = fakeList();
    sync(list, upTo(18));
    const before = [...list.children];
    const result = sync(list, upTo(21));
    assert.deepEqual({ added: result.added, animated: result.animated, replaced: result.replaced, removed: result.removed, rebuilt: result.rebuilt },
      { added: 3, animated: 3, replaced: 0, removed: 0, rebuilt: false });
    assert.deepEqual(shown(list).slice(0, 4), [121, 120, 119, 118]);
    assert.deepEqual(animated(list), [121, 120, 119]);
    assert.deepEqual(list.children.slice(3), before, 'mesmos objetos, na mesma ordem');
    assert.equal(list.moved, 0);
  });

  it('a classe sai no fim da animação; sessão vazia que recebe a primeira linha também anima', () => {
    const list = fakeList();
    sync(list, upTo(0));
    assert.equal(list.children.length, 0);
    sync(list, upTo(1));
    assert.deepEqual(animated(list), [101]);
    list.children[0].fire('animationend');
    assert.deepEqual(animated(list), []);
  });

  it('limite do feed: as mais antigas saem do fim, sem mexer nas outras', () => {
    const list = fakeList();
    const base = loadSession('primeira-luz');
    sync(list, { ...base, feed: base.feed.slice(0, 10) });
    const result = sync(list, { ...base, feed: base.feed.slice(2, 12) });
    assert.equal(result.removed, 2);
    assert.equal(result.animated, 2);
    assert.deepEqual(shown(list), [112, 111, 110, 109, 108, 107, 106, 105, 104, 103]);
    assert.equal(list.moved, 0);
  });

  it('linha nova no meio (depois de buscar /api/state) entra sem animação', () => {
    const list = fakeList();
    const base = loadSession('primeira-luz');
    sync(list, { ...base, feed: base.feed.filter((e) => e.seq !== 110) });
    const result = sync(list, base);
    assert.equal(result.added, 1);
    assert.equal(result.animated, 0);
    assert.equal(shown(list)[11], 110);
    assert.equal(list.moved, 0);
  });

  it('trocar de tema troca o texto das linhas no lugar, sem animação nem perda de posição', () => {
    const list = fakeList();
    sync(list, upTo(21), escritorio);
    const result = sync(list, upTo(21), guilda);
    assert.equal(result.rebuilt, false);
    assert.equal(result.replaced, 21);
    assert.equal(result.animated, 0);
    assert.deepEqual(list.children.map((node) => node.html), feedEntries(upTo(21), guilda).map((entry) => entry.html));
    assert.equal(list.moved, 0);
  });

  it('agente que ganha papel depois (convidado vira tester) troca o retrato das linhas antigas, sem animação', () => {
    const list = fakeList();
    const base = loadSession('primeira-luz');
    sync(list, base);
    const retyped = { ...base, agents: base.agents.map((a) => (a.key === GUEST ? { ...a, role: 'tes', agentType: 'tester' } : a)) };
    const result = sync(list, retyped);
    assert.equal(result.replaced, 3, 'as três linhas do convidado');
    assert.equal(result.animated, 0);
  });

  it('outra sessão refaz a lista sem animação', () => {
    const list = fakeList();
    sync(list, upTo(5));
    const other = loadSession('ticket-completo');
    const result = sync(list, other);
    assert.equal(result.rebuilt, true);
    assert.equal(result.animated, 0);
    assert.equal(result.removed, 5);
    assert.ok(list.children.every((node) => node.html.includes('w7x2m:')));
  });

  it('servidor reiniciado na mesma sessão (ids de outra execução): as antigas saem e as novas entram animadas', () => {
    const list = fakeList();
    const base = loadSession('primeira-luz');
    sync(list, base);
    const restarted = { ...base, feed: [{ ...base.feed[20], id: 'novaexec:1', seq: 1 }] };
    const result = sync(list, restarted);
    assert.equal(result.removed, 21);
    assert.equal(result.animated, 1);
    assert.equal(list.children.length, 1);
  });

  it('filtro só liga e desliga hidden; linha nova escondida não anima; mudar o filtro tira a animação pendente', () => {
    const list = fakeList();
    sync(list, upTo(18), escritorio, 'role:tes');
    const hidden = list.children.filter((node) => node.hidden).length;
    assert.equal(hidden, 18 - 3);
    const kept = [...list.children];

    const result = sync(list, upTo(21), escritorio, 'role:tes');
    assert.equal(result.added, 3);
    assert.equal(result.animated, 0, 'as três novas não são do tester');
    assert.ok(list.children.slice(0, 3).every((node) => node.hidden));

    sync(list, upTo(21), escritorio, `agent:${GUEST}`);
    assert.deepEqual(list.children.filter((node) => !node.hidden).map((node) => seqOf(node.html.match(/data-id="([^"]*)"/)[1])), [120, 118, 109]);
    assert.deepEqual(list.children.slice(3), kept, 'trocar o filtro não recria linhas');

    const next = fakeList();
    sync(next, upTo(18));
    sync(next, upTo(20));
    assert.deepEqual(animated(next), [120, 119]);
    sync(next, upTo(20), escritorio, 'role:aux');
    assert.deepEqual(animated(next), [], 'reaparecer depois de um filtro não anima de novo');
    sync(next, upTo(20), escritorio, ALL);
    assert.deepEqual(animated(next), []);
  });

  it('sem sessão: lista vazia', () => {
    const list = fakeList();
    sync(list, upTo(5));
    sync(list, null);
    assert.equal(list.children.length, 0);
  });
});

describe('CSS da animação e dos filtros', () => {
  const css = (name) => readFileSync(new URL(`../../../web/css/${name}`, import.meta.url), 'utf8');
  const all = ['base.css', 'layout.css'].map(css).join('\n');

  it('só a linha nova anima, com o slidein do mockup (.35s ease-out, de -6px e transparente)', () => {
    assert.match(all, /\.entry\.is-new \{ animation: slidein \.35s ease-out; \}/);
    assert.match(all, /@keyframes slidein \{ from \{ opacity: 0; transform: translateY\(-6px\); \} to \{ opacity: 1; transform: none; \} \}/);
    assert.doesNotMatch(all, /\.entry \{[^}]*animation/, 'a linha comum não anima (lista refeita, troca de tema)');
    assert.equal(NEW_ENTRY_CLASS, 'is-new');
  });

  it('com prefers-reduced-motion, a animação do feed e as transições da equipe saem', () => {
    const reduced = [...all.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
    assert.match(reduced, /animation: none !important/);
    assert.match(reduced, /\.entry\.is-new \{ animation: none; \}/);
    assert.match(reduced, /\.member, \.inst-pick \{ transition: none; \}/);
  });

  it('chips e botões da equipe portados do mockup, com estado apertado por aria-pressed', () => {
    for (const rule of ['.filters {', '.chip {', '.chip[aria-pressed="true"]', '.chip-ag[aria-pressed="true"]', '.member.is-filter', '.inst-pick[aria-pressed="true"]']) {
      assert.ok(all.includes(rule), rule);
    }
  });
});
