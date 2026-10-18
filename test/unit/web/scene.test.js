// Cena estática (web/js/scene.js): sala e posição de cada instância (função
// pura), "+N", copa, convidados, balão com a ação atual e o HTML gerado.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MAX_TOKENS_PER_ROOM, ROOM_OF_ROLE, renderScene, roomOf, sceneLayout, sceneSummary,
} from '../../../web/js/scene.js';
import { ROOM_IDS } from '../../../web/js/themes/contract.js';
import { createHelpers, esc } from '../../../web/js/themes/helpers.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { SNAPSHOT_NAMES, XSS, deepFreeze, loadSession, makeAgent, mapStrings } from './support.js';

const THEMES = [escritorio, guilda];
const SCENE_CSS = readFileSync(new URL('../../../web/css/scene.css', import.meta.url), 'utf8');

/** Sala do layout por id. */
const room = (layout, id) => layout.find((r) => r.id === id);
/** Rótulo e vaga dos tokens de uma sala, e o arranjo dela. */
const placed = (layout, id) => [room(layout, id)?.layout, ...(room(layout, id)?.tokens.map((t) => [t.agent.label || t.agent.key, t.slot]) ?? [])];

describe('roomOf', () => {
  it('principal sempre na sala do orquestrador; encerrado na copa; papéis na própria sala; convidado com o orquestrador', () => {
    assert.equal(roomOf(makeAgent({ key: 'main', status: 'idle' })), 'hq');
    assert.equal(roomOf(makeAgent({ key: 'main', finished: true })), 'hq');
    assert.equal(roomOf(makeAgent({ key: 'a', role: 'dev', finished: true, status: 'idle' })), 'idle');
    for (const [role, id] of Object.entries(ROOM_OF_ROLE)) assert.equal(roomOf(makeAgent({ key: 'a', role })), id, role);
    assert.equal(roomOf(makeAgent({ key: 'a', role: 'aux', agentType: 'Explore' })), 'hq');
    assert.equal(roomOf(makeAgent({ key: 'a', role: 'inventado' })), 'hq');
    assert.equal(roomOf(makeAgent({ key: 'a', role: 'tes', status: 'idle' })), 'test', 'ocioso sem ter encerrado fica na sala');
  });
});

describe('sceneLayout', () => {
  it('sem sessão: as seis salas, vazias', () => {
    const layout = sceneLayout(null);
    assert.deepEqual(layout.map((r) => r.id), [...ROOM_IDS]);
    assert.ok(layout.every((r) => r.tokens.length === 0 && r.overflow === 0 && !r.active));
  });

  it('Primeira luz: principal e convidado na sala do orquestrador, dois devs deslocados, encerrado na copa', () => {
    const layout = sceneLayout(deepFreeze(loadSession('primeira-luz')));
    assert.deepEqual(placed(layout, 'hq'), ['rows', ['main', 0], ['mapear os hooks do Claude Code', 1]]);
    assert.deepEqual(placed(layout, 'dev'), ['rows', ['implementar a ingestão', 0], ['portar o painel do mockup', 1]]);
    assert.deepEqual(placed(layout, 'idle'), ['lanes', ['revisar o normalizador', 0]]);
    assert.deepEqual(placed(layout, 'test'), ['single', ['testar a ingestão', 0]]);
    assert.deepEqual(placed(layout, 'design'), ['single']);
    assert.deepEqual(layout.filter((r) => r.active).map((r) => r.id), ['hq', 'dev', 'test']);
  });

  it('ticket completo: encerradas do ticket atual na copa (mais recente primeiro); as de antes saem da cena', () => {
    const layout = sceneLayout(loadSession('ticket-completo'));
    assert.deepEqual(placed(layout, 'idle'), ['lanes', ['implementar a ingestão', 0], ['desenhar a ingestão', 1]]);
    assert.ok(!layout.some((r) => r.members.some((a) => a.label === 'revisar o ADR anterior')));
    assert.deepEqual(placed(layout, 'test'), ['single', ['testar a ingestão', 0]]);
    assert.equal(room(layout, 'test')?.active, true, 'aguardando também deixa a sala ativa');
    assert.deepEqual(placed(layout, 'hq'), ['single', ['main', 0]]);
  });

  it(`até ${MAX_TOKENS_PER_ROOM} por sala, em vagas deslocadas, e "+N" além disso; aguardando e trabalhando primeiro`, () => {
    const agents = [
      makeAgent({ key: 'main' }),
      makeAgent({ key: 'd1', role: 'dev', status: 'idle', label: 'parado', startedAt: 1 }),
      makeAgent({ key: 'd2', role: 'dev', status: 'working', label: 'w2', startedAt: 5 }),
      makeAgent({ key: 'd3', role: 'dev', status: 'working', label: 'w1', startedAt: 2 }),
      makeAgent({ key: 'd4', role: 'dev', status: 'waiting', label: 'espera', startedAt: 9 }),
      makeAgent({ key: 'd5', role: 'dev', status: 'working', label: 'w3', startedAt: 7 }),
    ];
    const dev = room(sceneLayout(/** @type {any} */ ({ agents, quest: null })), 'dev');
    assert.deepEqual(dev?.tokens.map((t) => [t.agent.label, t.slot, t.count]), [['espera', 0, 3], ['w1', 1, 3], ['w2', 2, 3]]);
    assert.equal(dev?.layout, 'rows');
    assert.equal(dev?.overflow, 2);
    assert.equal(dev?.members.length, 5);
  });

  it('copa também mostra até 3 (as mais recentes) e "+N"; sem ticket, todas as encerradas contam', () => {
    const agents = [makeAgent({ key: 'main' })];
    for (let n = 1; n <= 5; n++) agents.push(makeAgent({ key: `f${n}`, role: 'tes', finished: true, label: `f${n}`, lastEventAt: n * 10 }));
    const idle = room(sceneLayout(/** @type {any} */ ({ agents, quest: null })), 'idle');
    assert.deepEqual(idle?.tokens.map((t) => [t.agent.label, t.slot, t.count]), [['f5', 0, 3], ['f4', 1, 3], ['f3', 2, 3]]);
    assert.equal(idle?.layout, 'lanes');
    assert.equal(idle?.overflow, 2);
    assert.equal(idle?.active, false);
  });

  it('um token só na sala de trabalho usa o arranjo do mockup (single)', () => {
    const hq = room(sceneLayout(loadSession('neutro')), 'hq');
    assert.deepEqual([hq?.layout, hq?.tokens[0].slot, hq?.tokens[0].count], ['single', 0, 1]);
  });
});

describe('arranjos no CSS', () => {
  it('a sala é container e cada arranjo e vaga usados pelo JS têm regra no scene.css', () => {
    assert.match(SCENE_CSS, /\.room \{[^}]*container: room \/ size;/);
    for (const layout of ['single', 'rows', 'lanes']) assert.ok(SCENE_CSS.includes(`[data-layout="${layout}"]`), layout);
    for (const slot of [0, 1, 2]) assert.ok(SCENE_CSS.includes(`[data-layout="rows"] .token[data-slot="${slot}"]`), `rows ${slot}`);
    for (const [count, slots] of [[2, [0, 1]], [3, [0, 1, 2]]]) {
      for (const slot of slots) {
        assert.ok(SCENE_CSS.includes(`[data-layout="lanes"][data-count="${count}"] .token[data-slot="${slot}"]`), `lanes ${count}/${slot}`);
      }
    }
  });
});

describe('renderScene', () => {
  for (const theme of THEMES) {
    it(`${theme.id}: as seis salas do tema, com nome, ícone e decoração`, () => {
      const html = renderScene({ session: null, theme });
      for (const id of ROOM_IDS) {
        assert.match(html, new RegExp(`<div class="room" data-room="${id}"`));
        assert.ok(html.includes(esc(theme.rooms[id].name)), id);
      }
      assert.ok(!html.includes('class="token'));
      assert.match(html, /role="img" aria-label="Cena: [^"]*sem agentes"/);
    });

    it(`${theme.id}: tokens com retrato, nome curto e balão da ação atual (só trabalhando ou aguardando)`, () => {
      const session = loadSession('primeira-luz');
      const html = renderScene({ session, theme });
      const h = createHelpers(theme, session.agents);
      assert.equal((html.match(/class="token /g) ?? []).length, 6);
      for (const agent of session.agents) {
        const block = html.split(`data-key="${agent.key}"`)[1]?.split('class="token ')[0] ?? '';
        if (agent.status === 'working' && !agent.finished) {
          assert.ok(html.includes(`<span class="bubble-text">${esc(theme.actionText(agent, h))}</span>`), agent.label);
        }
        assert.ok(block.includes(`<div class="tok-av">${esc(theme.roles[agent.role].icon)}</div>`), agent.key);
      }
      assert.match(html, /<div class="tok-name">Explore<\/div>/, 'convidado mostra o agent_type');
      assert.match(html, new RegExp(`<div class="tok-name">${esc(theme.roles.dev.short)}</div>`));
      const finished = html.split('data-room="idle"')[1].split('data-room="docs"')[0];
      assert.match(finished, /class="token idle"/);
    assert.match(finished, /data-count="1" data-layout="lanes"/);
      assert.ok(!finished.includes('bubble'), 'encerrado na copa sem balão');
    });

    it(`${theme.id}: sala com mais de 3 mostra "+N"`, () => {
      const session = loadSession('primeira-luz');
      const extra = [1, 2, 3].map((n) => ({ ...session.agents[1], key: `extra${n}`, agentId: `extra${n}`, label: `extra ${n}`, startedAt: session.agents[1].startedAt + n }));
      const html = renderScene({ session: { ...session, agents: [...session.agents, ...extra] }, theme });
      const dev = html.split('data-room="dev"')[1].split('data-room="idle"')[0];
      assert.equal((dev.match(/class="token /g) ?? []).length, 3);
      assert.match(dev, /<span class="room-more" title="2 agentes a mais nesta sala">\+2<\/span>/);
      assert.ok(!dev.includes('deco d1'), 'o "+N" ocupa o canto da primeira decoração');
      assert.ok(html.split('data-room="design"')[1].split('data-room="dev"')[0].includes('deco d1'), 'sala sem "+N" mantém a decoração');
    });

    it(`${theme.id}: principal ocioso fica na sala dele, sem balão`, () => {
      const html = renderScene({ session: loadSession('neutro'), theme });
      const hq = html.split('data-room="hq"')[1].split('data-room="design"')[0];
      assert.match(hq, /class="token idle" data-key="main"/);
      assert.ok(!hq.includes('bubble'));
    });
  }

  it('todo texto dinâmico sai escapado e sem estilo inline', () => {
    for (const name of SNAPSHOT_NAMES) {
      const keep = new Set(['kind', 'role', 'status', 'category', 'state', 'key', 'agentKey']);
      const session = mapStrings(loadSession(name), (text, key) => (keep.has(key ?? '') ? text : `${text}${XSS}`));
      for (const theme of THEMES) {
        const html = renderScene({ session, theme });
        assert.ok(!html.includes('<img'), name);
        // Só as tags, com os valores dos atributos esvaziados: texto escapado não é atributo.
        for (const tag of (html.match(/<[^>]*>/g) ?? []).map((t) => t.replace(/"[^"]*"/g, '""'))) {
          assert.doesNotMatch(tag, /\sstyle=|\son[a-z]+=|^<\/?(script|style)\b/i, tag);
        }
      }
    }
    const attack = '"><img src=x onerror=alert(1)>';
    const session = mapStrings(loadSession('primeira-luz'), (text, key) => (['status', 'role', 'key'].includes(key ?? '') ? `${text}${attack}` : text));
    assert.ok(!renderScene({ session, theme: guilda }).includes('<img'));
  });

  it('trocar de tema não altera a sessão', () => {
    const session = loadSession('ticket-completo');
    const before = JSON.stringify(session);
    deepFreeze(session);
    renderScene({ session, theme: escritorio });
    renderScene({ session, theme: guilda });
    assert.equal(JSON.stringify(session), before);
  });

  it('resumo para leitores de tela conta trabalhando, aguardando e na copa (inclusive o "+N")', () => {
    assert.equal(sceneSummary(sceneLayout(loadSession('primeira-luz')), escritorio), 'Cena: 5 trabalhando, 0 aguardando aprovação, 1 em Copa');
    assert.equal(sceneSummary(sceneLayout(loadSession('ticket-completo')), guilda), 'Cena: 1 trabalhando, 1 aguardando aprovação, 2 em Taverna');
  });
});
