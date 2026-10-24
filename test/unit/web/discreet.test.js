// Modo discreto (T14; ADR 0006; plano, decisão 3): troca alvo, detalhe,
// títulos e erros por textos só de categoria, desligado por padrão e guardado
// no localStorage. Aqui: a máscara do estado (web/js/discreet.js) e uma
// varredura de todas as views com marcadores nos campos de texto livre da
// seção 10 do modelo de eventos.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISCREET_STORAGE_KEY, HIDDEN_EVENT_FIELDS, isMasked, maskAgent, maskEvent, maskEventData, maskSession, neutralLabel,
  parseDiscreet, serializeDiscreet,
} from '../../../web/js/discreet.js';
import { renderScene } from '../../../web/js/scene.js';
import { sessionList } from '../../../web/js/selectors.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { feedModel, renderFeed } from '../../../web/js/views/feed.js';
import { renderLegend } from '../../../web/js/views/legend.js';
import { renderParty } from '../../../web/js/views/party.js';
import { renderQuest } from '../../../web/js/views/quest.js';
import { pinnedMissingText, sessionGroups } from '../../../web/js/views/sessions.js';
import { pendingAnnouncement, renderPendingAlert } from '../../../web/js/views/topbar.js';
import { SNAPSHOT_NAMES, deepFreeze, loadSession } from './support.js';

const THEMES = [escritorio, guilda];
const SECRET = 'SEGREDO';

describe('preferência', () => {
  it('desligado por padrão; só "1" liga; ida e volta pelo texto', () => {
    assert.equal(DISCREET_STORAGE_KEY, 'agent-quest-discreet');
    for (const text of [null, undefined, '', '0', 'true', 'sim', ' 1', '{}']) assert.equal(parseDiscreet(/** @type {any} */ (text)), false, String(text));
    assert.equal(parseDiscreet('1'), true);
    assert.equal(parseDiscreet(serializeDiscreet(true)), true);
    assert.equal(parseDiscreet(serializeDiscreet(false)), false);
  });
});

describe('máscara do estado', () => {
  it('rótulo neutro da sessão, como o padrão do servidor', () => {
    assert.equal(neutralLabel('5f1c0a9e-1111-4222-8333-444455556666'), 'Sessão 5f1c0a');
    assert.equal(neutralLabel(''), 'Sessão');
    assert.equal(neutralLabel(null), 'Sessão');
  });

  it('eventos: os textos livres da seção 10 viram null; o resto fica', () => {
    assert.deepEqual([...HIDDEN_EVENT_FIELDS].sort(), ['description', 'detail', 'error', 'label', 'target', 'title']);
    const data = { tool: 'Bash', category: 'bash', target: 'rm -rf x', detail: 'apagar', error: 'Exit 1', title: 'pedido', description: 'd', label: 'l', n: 3, ok: false };
    assert.deepEqual(maskEventData(data), { tool: 'Bash', category: 'bash', target: null, detail: null, error: null, title: null, description: null, label: null, n: 3, ok: false });
    assert.deepEqual(maskEventData({ outcome: 'done' }), { outcome: 'done' }, 'não cria campos que não existiam');
    assert.deepEqual(maskEventData(null), {});
    const event = deepFreeze({ id: 'r:1', seq: 1, ts: 0, sessionId: 's', agentKey: 'main', kind: 'tool.started', data });
    assert.equal(maskEvent(event).data.target, null);
    assert.equal(event.data.target, 'rm -rf x', 'não altera o original');
  });

  it('agentes: some o rótulo das instâncias e o alvo; o da sessão principal (agent_type) fica', () => {
    const activity = { kind: 'tool', category: 'edit', tool: 'Edit', target: 'a.js', detail: 'x', state: 'running', at: 1 };
    const waitingFor = { tool: 'Bash', category: 'bash', target: 'npm i' };
    const sub = maskAgent(deepFreeze({ key: 'a1', role: 'dev', agentType: 'dev-backend', label: 'implementar', activity, waitingFor }));
    assert.equal(sub.label, '');
    assert.equal(sub.agentType, 'dev-backend');
    assert.deepEqual(sub.activity, { ...activity, target: null, detail: null });
    assert.deepEqual(sub.waitingFor, { ...waitingFor, target: null });
    assert.equal(maskAgent(deepFreeze({ key: 'main', role: 'orq', label: 'revisor', activity: null, waitingFor: null })).label, 'revisor');
  });

  for (const name of SNAPSHOT_NAMES) {
    it(`${name}: pura, com cache por objeto e idempotente`, () => {
      const session = deepFreeze(loadSession(name));
      const masked = maskSession(session);
      assert.notEqual(masked, session);
      assert.equal(maskSession(session), masked, 'o mesmo objeto dá o mesmo resultado');
      assert.equal(maskSession(masked), masked, 'mascarar de novo não muda nada');
      assert.equal(isMasked(masked), true);
      assert.equal(isMasked(session), false);
      assert.equal(masked.label, neutralLabel(session.id));
      assert.equal(masked.project.dir, '');
      assert.equal(masked.project.name, session.project.name, 'o nome do projeto fica');
      if (session.quest) {
        assert.equal(masked.quest.title, '');
        assert.equal(masked.quest.error, session.quest.error ? '' : session.quest.error);
        assert.equal(masked.quest.n, session.quest.n);
      }
      assert.equal(masked.agents.length, session.agents.length);
      assert.deepEqual(masked.agents.map((a) => [a.key, a.role, a.status, a.agentType]), session.agents.map((a) => [a.key, a.role, a.status, a.agentType]));
      assert.equal(masked.feed.length, session.feed.length);
      assert.equal(masked.counters, session.counters);
      assert.equal(masked.lastEventAt, session.lastEventAt);
    });
  }
});

/**
 * Sessão com um marcador em todo campo de texto livre: rótulo da sessão,
 * pasta do projeto, título e erro do ticket, rótulos e alvos dos agentes e os
 * textos dos eventos do feed.
 * @param {any} base
 * @param {string} tag
 */
function secretSession(base, tag) {
  const mark = (/** @type {string} */ field) => `${SECRET}-${tag}-${field}`;
  const agents = base.agents.map((/** @type {any} */ agent, /** @type {number} */ index) => {
    if (agent.key === 'main') {
      return { ...agent, label: '', status: 'working', activity: { kind: 'delegate', category: null, tool: 'Agent', target: mark('alvo-deleg'), detail: mark('detalhe-deleg'), state: 'running', at: 0 } };
    }
    const waiting = index === 1;
    return {
      ...agent,
      label: mark('rotulo-instancia'),
      finished: false,
      status: waiting ? 'waiting' : 'working',
      activity: { kind: 'tool', category: index % 2 ? 'bash' : 'edit', tool: index % 2 ? 'Bash' : 'Edit', target: mark('alvo'), detail: mark('detalhe'), state: 'running', at: 0 },
      waitingFor: waiting ? { tool: 'Bash', category: 'bash', target: mark('espera') } : null,
    };
  });
  const feed = (base.feed ?? []).map((/** @type {any} */ event) => {
    const data = { ...(event.data ?? {}) };
    for (const field of HIDDEN_EVENT_FIELDS) data[field] = mark(field);
    return { ...event, data };
  });
  return {
    ...base,
    id: `${base.id}-${tag}`,
    label: mark('rotulo-sessao'),
    project: { ...base.project, dir: `C:\\${mark('pasta')}\\${base.project.name}` },
    quest: base.quest ? { ...base.quest, title: mark('titulo'), error: mark('erro') } : base.quest,
    status: 'waiting',
    counters: { ...base.counters, pendingApprovals: 2 },
    agents,
    feed,
  };
}

/**
 * Tudo o que as views desenham para uma sessão (e uma outra com aprovação pendente).
 * @param {any} session
 * @param {any} other
 * @param {import('../../../web/js/themes/contract.js').Theme} theme
 * @param {boolean} discreet
 */
function everything(session, other, theme, discreet) {
  const now = session.lastEventAt + 5_000;
  const list = sessionList([session, other]);
  const parts = [
    renderParty({ session, theme, discreet }),
    renderQuest({ session, theme, now, discreet }),
    renderFeed({ session, theme, discreet }),
    renderScene({ session, theme, discreet }),
    JSON.stringify(sessionGroups(list, session.id, theme, { discreet })),
    pinnedMissingText(discreet ? maskSession(session) : session),
    renderPendingAlert({ list, selectedId: other.id, theme, now, discreet }),
    pendingAnnouncement({ list, selectedId: other.id, theme, now, discreet }),
    renderLegend({ theme, discreet }),
  ];
  // O chip de cada instância filtrada e o filtro de cada papel.
  for (const agent of session.agents) parts.push(feedModel({ session, theme, filter: `agent:${agent.key}`, discreet }).filters);
  for (const agent of session.agents) parts.push(renderParty({ session, theme, filter: `agent:${agent.key}`, discreet }));
  return parts.join('\n');
}

describe('nenhuma view mostra texto livre no modo discreto', () => {
  for (const theme of THEMES) {
    for (const name of SNAPSHOT_NAMES) {
      it(`${theme.id}, ${name}: nenhum marcador aparece (e todos aparecem com o modo desligado)`, () => {
        const session = deepFreeze(secretSession(loadSession(name), 'a'));
        const other = deepFreeze(secretSession(loadSession('ticket-completo'), 'b'));
        const hidden = everything(session, other, theme, true);
        const leaks = hidden.match(new RegExp(`${SECRET}-[ab]-[a-z-]+`, 'g')) ?? [];
        assert.deepEqual([...new Set(leaks)], [], 'textos livres visíveis no modo discreto');

        const shown = everything(session, other, theme, false);
        for (const field of ['rotulo-sessao', ...(session.agents.length > 1 ? ['rotulo-instancia', 'alvo'] : ['detalhe-deleg'])]) assert.ok(shown.includes(`${SECRET}-a-${field}`), `sem o modo discreto, ${field} aparece`);
        if (session.quest) assert.ok(shown.includes(`${SECRET}-a-titulo`));
        const kinds = new Set(session.feed.map((/** @type {any} */ event) => event.kind));
        if (['tool.started', 'quest.started', 'agent.delegated'].some((kind) => kinds.has(kind))) {
          assert.ok(shown.includes(`${SECRET}-a-target`) || shown.includes(`${SECRET}-a-title`) || shown.includes(`${SECRET}-a-description`));
        }
      });
    }

    it(`${theme.id}: no modo discreto, o ticket mostra o título oculto do tema e só a indicação de erro`, () => {
      const session = secretSession(loadSession('ticket-completo'), 'c');
      const html = renderQuest({ session, theme, now: session.lastEventAt, discreet: true });
      assert.ok(html.includes(`<h1 class="q-title is-placeholder">${theme.words.hiddenTitle}</h1>`));
      assert.ok(html.includes('com erro (oculto no modo discreto)'));
      assert.ok(!html.includes(SECRET));
    });
  }
});
