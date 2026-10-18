// Views do painel: HTML gerado a partir dos snapshots escritos à mão
// (test/fixtures/state/), nos dois temas.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderEmpty, healthLine, CAPTURE_COMMANDS } from '../../../web/js/views/empty.js';
import { feedTone, renderFeed, systemIcon } from '../../../web/js/views/feed.js';
import { renderParty } from '../../../web/js/views/party.js';
import { renderQuest } from '../../../web/js/views/quest.js';
import { CONNECTION_LABELS, renderConnection, renderStats, renderThemeToggle } from '../../../web/js/views/topbar.js';
import { sessionOptions } from '../../../web/js/views/sessions.js';
import { esc } from '../../../web/js/themes/helpers.js';
import escritorio from '../../../web/js/themes/escritorio.js';
import guilda from '../../../web/js/themes/guilda.js';
import { SNAPSHOT_NAMES, XSS, deepFreeze, loadSession, makeEvent, mapStrings } from './support.js';

const THEMES = [escritorio, guilda];

/** Todas as views de uma sessão, num tema. */
function renderAll(session, theme, now = session.lastEventAt + 5_000) {
  return {
    stats: renderStats(session, theme, now),
    party: renderParty({ session, theme }),
    quest: renderQuest({ session, theme, now }),
    feed: renderFeed({ session, theme }),
  };
}

/** Valores de um atributo, na ordem do HTML. */
const attrs = (html, name) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const count = (html, text) => html.split(text).length - 1;

/**
 * Confere que o HTML não tem script, estilo inline nem manipulador de evento
 * (ADR 0006). Olha só as tags, com os valores dos atributos esvaziados: texto
 * escapado como `&lt;img onerror=...&gt;` não é atributo.
 */
function assertNoInline(html, context) {
  const tags = (html.match(/<[^>]*>/g) ?? []).map((tag) => tag.replace(/"[^"]*"/g, '""'));
  for (const tag of tags) {
    assert.doesNotMatch(tag, /^<\/?(script|style|iframe|object|embed)\b|\sstyle=|\son[a-z]+=|\s(src|href)=/i, `${context}: ${tag}`);
  }
  assert.doesNotMatch(html, /javascript:/i, context);
}

describe('views com os snapshots escritos à mão', () => {
  for (const name of SNAPSHOT_NAMES) {
    for (const theme of THEMES) {
      it(`${name} (${theme.id}): gera HTML sem script, estilo inline nem manipulador`, () => {
        const views = renderAll(loadSession(name), theme);
        for (const [part, html] of Object.entries(views)) assertNoInline(html, `${name}/${part}`);
      });
    }
  }

  it('trocar de tema não toca no estado (snapshot congelado, mesmo conteúdo depois)', () => {
    for (const name of SNAPSHOT_NAMES) {
      const session = loadSession(name);
      const before = JSON.stringify(session);
      deepFreeze(session);
      const first = renderAll(session, escritorio, 1);
      renderAll(session, guilda, 1);
      assert.deepEqual(renderAll(session, escritorio, 1), first);
      assert.equal(JSON.stringify(session), before);
    }
  });
});

describe('snapshot neutro (valores neutros do recorte)', () => {
  for (const theme of THEMES) {
    const session = loadSession('neutro');
    const views = renderAll(session, theme);

    it(`${theme.id}: ticket vazio do tema, sem stepper`, () => {
      assert.match(views.quest, /class="card quest is-empty"/);
      assert.ok(views.quest.includes(esc(theme.words.noQuest)));
      assert.ok(!views.quest.includes('stepper'));
    });

    it(`${theme.id}: indicadores zerados aparecem como zero, sem destaque`, () => {
      for (const id of ['bugs', 'quests', 'pending']) {
        assert.match(views.stats, new RegExp(`data-stat="${id}"[^>]*><span aria-hidden="true">[^<]*</span><b>0</b>`));
      }
      assert.match(views.stats, /data-stat="duration"/);
      assert.ok(!views.stats.includes('stat pending'));
    });

    it(`${theme.id}: equipe só com o orquestrador, sem "×N"`, () => {
      assert.deepEqual(attrs(views.party, 'data-agent'), ['orq']);
      assert.ok(!views.party.includes('m-count'));
      assert.ok(views.party.includes(esc(theme.words.orqIdle)));
    });

    it(`${theme.id}: feed com o início da sessão`, () => {
      assert.equal(count(views.feed, '<li class="entry'), 1);
      assert.ok(views.feed.includes('agents-quest'));
    });
  }
});

describe('snapshot da Primeira luz', () => {
  const session = loadSession('primeira-luz');

  for (const theme of THEMES) {
    const views = renderAll(session, theme);

    it(`${theme.id}: rótulo da sessão e projeto no topo`, () => {
      assert.deepEqual(sessionOptions([session], session.id).map((o) => o.text), ['Sessão 5f1c0a · agents-quest']);
    });

    it(`${theme.id}: papéis do roster na ordem, com nome do tema e papel real`, () => {
      const members = [...views.party.matchAll(/<li class="member [^"]*" data-agent="([^"]*)"/g)].map((m) => m[1]);
      assert.deepEqual(members, ['orq', 'arq', 'dev', 'tes', 'doc', 'aux']);
      for (const role of members) assert.ok(views.party.includes(esc(theme.roles[role].name)), role);
      assert.ok(views.party.includes('>System Design<'));
      assert.ok(views.party.includes('>Convidado<'));
    });

    it(`${theme.id}: "×2" conta só as instâncias de dev não encerradas`, () => {
      assert.equal(count(views.party, 'class="m-count"'), 1);
      assert.match(views.party, />×2</);
      assert.ok(!views.party.includes('×3'));
    });

    it(`${theme.id}: instâncias com rótulo, status e linha de ação do tema`, () => {
      for (const label of ['implementar a ingestão', 'portar o painel do mockup', 'revisar o normalizador', 'testar a ingestão']) {
        assert.ok(views.party.includes(`>${esc(label)}<`), label);
      }
      const devAgent = session.agents.find((a) => a.label === 'implementar a ingestão');
      assert.ok(views.party.includes(esc(theme.actionText(devAgent, /** @type {any} */ ({})))));
      assert.match(views.party, /<li class="inst finished"/);
      assert.match(views.party, /<li class="inst working"/);
      assert.ok(views.party.includes(esc(theme.words.idle)), 'encerrado e papéis sem instância na copa');
    });

    it(`${theme.id}: convidado mostra o agent_type real`, () => {
      assert.match(views.party, /<span class="i-type">Explore<\/span>/);
    });

    it(`${theme.id}: barra de saúde por instância, com a fração no tooltip`, () => {
      assert.ok(views.party.includes(`${esc(theme.bars.health)} ≈ 7 de 8 ações sem erro (últimas 10)`));
      assert.match(views.party, /data-fill="9"/);
      assert.ok(!views.party.includes(theme.bars.context), 'a barra de contexto é do T16');
    });

    it(`${theme.id}: sem ticket no recorte, cartão vazio do tema`, () => {
      assert.ok(views.quest.includes(esc(theme.words.noQuest)));
    });

    it(`${theme.id}: feed com os 21 eventos, mais recentes no topo`, () => {
      const ids = attrs(views.feed, 'data-id');
      assert.equal(ids.length, 21);
      const seqs = ids.map((id) => Number(id.split(':')[1]));
      assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
      assert.equal(seqs[0], 121);
    });

    it(`${theme.id}: feed com comandos e caminhos como chegaram do servidor`, () => {
      for (const text of ['server/ingest/envelope.js', 'node --test test/integration', 'Exit code 1', 'github/search_issues', 'code.claude.com']) {
        assert.ok(views.feed.includes(esc(text)), text);
      }
    });

    it(`${theme.id}: tom e ícone das linhas`, () => {
      assert.match(views.feed, /<li class="entry bad" data-id="k3f9q:112"/);
      assert.match(views.feed, /<li class="entry warn" data-id="k3f9q:121"/);
      assert.match(views.feed, new RegExp(`data-id="k3f9q:101"[^>]*><span class="e-av sys" aria-hidden="true">${theme.icons.session}<`));
    });
  }
});

describe('snapshot com ticket completo (forma depois do T8)', () => {
  const session = loadSession('ticket-completo');

  for (const theme of THEMES) {
    const views = renderAll(session, theme, session.quest.startedAt + 271_000);

    it(`${theme.id}: número, status, título, duração e ações do ticket`, () => {
      assert.ok(views.quest.includes(`${esc(`${theme.words.quest} #3`)} · ${esc(theme.words.questStatus.open)}`));
      assert.match(views.quest, /<h1 class="q-title">Implementar a ingestão<\/h1>/);
      assert.ok(views.quest.includes('⏱ 04:31'));
      assert.ok(views.quest.includes('41 ações'));
      assert.ok(views.quest.includes('2 de 4 etapas'));
    });

    it(`${theme.id}: stepper com as etapas do tema e o estado de cada uma`, () => {
      const steps = [...views.quest.matchAll(/<li class="([^"]*)" data-agent="([^"]*)"/g)].map((m) => [m[1], m[2]]);
      assert.deepEqual(steps, [['step done', 'arq'], ['step done', 'dev'], ['step active', 'tes'], ['step', 'doc']]);
      for (const label of Object.values(theme.phases)) assert.ok(views.quest.includes(`>${esc(label)}<`), label);
    });

    it(`${theme.id}: aprovação pendente em destaque no topo e no cartão`, () => {
      assert.match(views.stats, /class="stat pending" data-stat="pending"/);
      assert.ok(views.party.includes(esc(theme.words.waiting)));
      assert.match(views.party, /<li class="member waiting" data-agent="tes"/);
      assert.ok(!views.party.includes('instância encerrada'), 'a encerrada do ticket anterior não entra no "+N"');
    });

    it(`${theme.id}: feed sem a etapa que só começou e com todos os tipos do feed`, () => {
      assert.ok(!views.feed.includes('data-id="w7x2m:305"'));
      const kinds = new Set(attrs(views.feed, 'data-kind'));
      for (const kind of ['session.started', 'quest.started', 'quest.finished', 'quest.phase', 'agent.delegated', 'agent.finished',
        'tool.started', 'test.finished', 'permission.requested', 'permission.resolved', 'context.compacted']) {
        assert.ok(kinds.has(kind), kind);
      }
    });
  }

  it('ticket que falhou mostra o erro', () => {
    const failed = { ...session, quest: { ...session.quest, status: 'failed', endedAt: session.quest.startedAt + 1_000, error: 'rate_limit' } };
    const html = renderQuest({ session: failed, theme: escritorio, now: Date.now() });
    assert.match(html, /data-status="failed"/);
    assert.match(html, /<span class="q-error">erro: <code>rate_limit<\/code><\/span>/);
    assert.ok(html.includes('⏱ 00:01'));
  });

  it('ticket sem etapas do time esconde o stepper', () => {
    const plain = { ...session, quest: { ...session.quest, phases: { design: 'pending', code: 'pending', test: 'pending', docs: 'pending' } } };
    const html = renderQuest({ session: plain, theme: guilda, now: Date.now() });
    assert.ok(!html.includes('stepper'));
    assert.ok(!html.includes('etapas'));
  });
});

describe('escape de todo texto dinâmico (ADR 0006)', () => {
  /** Campos de enumeração: trocá-los quebraria a escolha da frase, então ficam para o segundo teste. */
  const ENUM_KEYS = new Set(['kind', 'role', 'toRole', 'status', 'category', 'outcome', 'state', 'phase', 'by', 'trigger', 'client', 'source', 'roster']);

  for (const name of SNAPSHOT_NAMES) {
    for (const theme of THEMES) {
      it(`${name} (${theme.id}): textos com ${XSS} aparecem escapados`, () => {
        const session = mapStrings(loadSession(name), (text, key) => (ENUM_KEYS.has(key ?? '') ? text : `${text}${XSS}`));
        const views = renderAll(session, theme, 0);
        for (const [part, html] of Object.entries(views)) {
          assert.ok(!html.includes('<img'), `${name}/${part}`);
          assertNoInline(html, `${name}/${part}`);
        }
        assert.ok(views.feed.includes(esc(XSS)), 'o vetor aparece escapado no feed');
        assert.ok(views.party.includes(esc(XSS)), 'o vetor aparece escapado na equipe');
      });

      it(`${name} (${theme.id}): enumerações adulteradas também não abrem HTML`, () => {
        const attack = `"><img src=x onerror=alert(1)>`;
        const session = mapStrings(loadSession(name), (text, key) => (ENUM_KEYS.has(key ?? '') ? `${text}${attack}` : text));
        for (const [part, html] of Object.entries(renderAll(session, theme, 0))) {
          assert.ok(!html.includes('<img'), `${name}/${part}`);
        }
      });
    }
  }

  it('topo, conexão, alternância e painel vazio escapam o que recebem', () => {
    assert.ok(!renderConnection(/** @type {any} */ (XSS)).includes('<img'));
    const fake = { ...escritorio, id: XSS, name: XSS, icon: XSS };
    assert.ok(!renderThemeToggle([fake], 'x').includes('<img'));
    const words = { ...escritorio.words, noSessions: XSS };
    assert.ok(!renderEmpty({ theme: { ...escritorio, words }, health: null, healthState: 'loading' }).includes('<img'));
  });
});

describe('topo', () => {
  it('sem sessão, os indicadores ficam vazios', () => {
    assert.equal(renderStats(null, escritorio, 0), '');
  });

  it('selo de conexão nos quatro estados; valor desconhecido vira desconectado', () => {
    for (const state of /** @type {const} */ (['connecting', 'live', 'reconnecting', 'offline'])) {
      const html = renderConnection(state);
      assert.match(html, new RegExp(`class="conn conn-${state}"`));
      assert.ok(html.includes(CONNECTION_LABELS[state].label));
    }
    assert.match(renderConnection(/** @type {any} */ ('toString')), /conn-offline/);
  });

  it('alternância de tema: um botão por tema, com atalho e aria-pressed', () => {
    const html = renderThemeToggle(THEMES, 'guilda');
    assert.deepEqual(attrs(html, 'data-theme'), ['escritorio', 'guilda']);
    assert.deepEqual(attrs(html, 'aria-pressed'), ['false', 'true']);
    assert.deepEqual(attrs(html, 'title'), ['Escritório (1)', 'Guilda (2)']);
  });
});

describe('equipe: rótulo do main e "+N"', () => {
  /** Bloco HTML do membro de um papel. */
  const memberBlock = (html, role) => html.split(`data-agent="${role}">`)[1]?.split('<li class="member')[0] ?? '';

  it('main com label vazio mostra só o nome do papel; com --agent, o tipo aparece como detalhe', () => {
    const session = loadSession('neutro');
    const plain = renderParty({ session, theme: escritorio });
    assert.ok(!memberBlock(plain, 'orq').includes('i-label'));
    const withAgent = { ...session, agents: session.agents.map((a) => ({ ...a, agentType: 'revisor', label: 'revisor' })) };
    const html = renderParty({ session: withAgent, theme: escritorio });
    assert.match(memberBlock(html, 'orq'), /<span class="i-text">revisor<\/span>/);
    assert.ok(html.includes('>Gerente de Projeto<'));
  });

  it('"+N instâncias encerradas" conta só as encerradas do ticket atual além das 3 exibidas', () => {
    const session = loadSession('ticket-completo');
    const start = session.quest.startedAt;
    const extra = [1, 2, 3, 4].map((n) => ({ ...session.agents[2], key: `extra${n}`, agentId: `extra${n}`, label: `extra ${n}`, lastEventAt: start + n * 1_000 }));
    const html = renderParty({ session: { ...session, agents: [...session.agents, ...extra] }, theme: guilda });
    assert.ok(memberBlock(html, 'arq').includes('+2 instâncias encerradas'), 'cinco do ticket atual: 3 aparecem, 2 no "+N"; a do ticket anterior fica fora');
  });
});

describe('equipe e feed sem sessão', () => {
  for (const theme of THEMES) {
    it(`${theme.id}: mensagens vazias do tema`, () => {
      assert.ok(renderParty({ session: null, theme }).includes(esc(theme.words.noAgents)));
      assert.ok(renderFeed({ session: null, theme }).includes(esc(theme.words.noFeed)));
      assert.match(renderParty({ session: null, theme }), /id="party-title"/);
      assert.match(renderFeed({ session: null, theme }), /id="feed-title"/);
    });
  }

  it('sessão sem eventos de feed mostra o feed vazio', () => {
    const session = { ...loadSession('neutro'), feed: [makeEvent('tool.finished', {}, 'main')] };
    assert.ok(renderFeed({ session, theme: escritorio }).includes(esc(escritorio.words.noFeed)));
  });
});

describe('tom e ícone do feed', () => {
  it('feedTone segue o mockup: falha vermelha, sucesso verde, aprovação amarela', () => {
    assert.equal(feedTone(makeEvent('tool.failed', { interrupted: false })), 'bad');
    assert.equal(feedTone(makeEvent('tool.failed', { interrupted: true })), 'warn');
    assert.equal(feedTone(makeEvent('test.finished', { ok: true })), 'good');
    assert.equal(feedTone(makeEvent('test.finished', { ok: false })), 'bad');
    assert.equal(feedTone(makeEvent('quest.phase', { state: 'done' })), 'good');
    assert.equal(feedTone(makeEvent('quest.finished', { outcome: 'done' })), 'good');
    assert.equal(feedTone(makeEvent('quest.finished', { outcome: 'failed' })), 'bad');
    assert.equal(feedTone(makeEvent('quest.finished', { outcome: 'interrupted' })), '');
    assert.equal(feedTone(makeEvent('permission.requested', {})), 'warn');
    assert.equal(feedTone(makeEvent('tool.started', {})), '');
  });

  it('systemIcon: sessão, ticket e etapa usam o ícone do tema; agentes, o retrato', () => {
    assert.equal(systemIcon(makeEvent('session.ended', {}, null), guilda), guilda.icons.session);
    assert.equal(systemIcon(makeEvent('quest.started', {}), guilda), guilda.icons.questStarted);
    assert.equal(systemIcon(makeEvent('quest.finished', { outcome: 'done' }), guilda), guilda.icons.questDone);
    assert.equal(systemIcon(makeEvent('quest.finished', { outcome: 'failed' }), guilda), guilda.icons.questFailed);
    assert.equal(systemIcon(makeEvent('quest.finished', { outcome: 'interrupted' }), guilda), guilda.icons.questInterrupted);
    assert.equal(systemIcon(makeEvent('quest.phase', { state: 'done' }), guilda), guilda.icons.phaseDone);
    assert.equal(systemIcon(makeEvent('tool.started', {}), guilda), null);
  });
});

describe('painel sem sessões', () => {
  for (const theme of THEMES) {
    it(`${theme.id}: explica como ligar a captura`, () => {
      const html = renderEmpty({ theme, health: null, healthState: 'loading' });
      for (const command of Object.values(CAPTURE_COMMANDS)) assert.ok(html.includes(esc(command)), command);
      assert.ok(html.includes(esc(theme.words.noSessions)));
      assertNoInline(html, 'vazio');
    });
  }

  it('mostra o lastEventAt do /api/health', () => {
    const startedAt = new Date(2026, 9, 18, 14, 2, 0).getTime();
    const health = { ok: true, version: '0.1.0', startedAt, events: {}, lastEventAt: null, sessions: 0, clients: 0 };
    assert.equal(healthLine(/** @type {any} */ (health), 'ok'), 'Nenhum evento recebido desde 14:02 (início do servidor).');
    const last = new Date(2026, 9, 18, 14, 5, 9).getTime();
    assert.equal(healthLine(/** @type {any} */ ({ ...health, lastEventAt: last }), 'ok'), 'Último evento recebido às 14:05:09.');
    assert.equal(healthLine(null, 'loading'), 'Consultando o servidor…');
    assert.equal(healthLine(null, 'error'), 'Não foi possível consultar o servidor (/api/health).');
    const html = renderEmpty({ theme: escritorio, health: /** @type {any} */ (health), healthState: 'ok' });
    assert.ok(html.includes('Nenhum evento recebido desde 14:02'));
  });
});
