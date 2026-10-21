// SINTÉTICO: reducer de estado sobre a sessão sintética da sonda do T0
// (test/unit/tools/probe-synthetic.js), no formato de cenário do ADR 0010.
// Os payloads seguem a documentação dos hooks; não são capturas reais.
//
// Quando as fixtures do T0 chegarem a test/fixtures/hooks/, a primeira parte
// (forma, atribuição, elos e nenhum conteúdo real) roda sobre cada uma delas
// (loadFixtureScenarios) sem mudança; a segunda parte, com os ids da sessão
// sintética, é refeita com o que as fixtures mostrarem.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, CONTENT_MARKERS, SESSION, SESSION_CLEAR, SESSION_VSCODE } from '../../../tools/probe-synthetic.js';
import { getSessionState, getSessionStates } from '../../../../../server/domain/state/index.js';
import { loadFixtureScenarios, syntheticScenario } from '../scenarios.js';
import { agentOf, assertAttribution, assertLinks, assertRunShape, run } from './scenarios.js';

/** O evento sem o título do ticket. */
const withoutTitle = (event) => (event.kind === 'quest.started' ? { ...event, data: { ...event.data, title: '' } } : event);

/** A sessão sem os títulos de ticket (rótulo, ticket e feed). */
const withoutTitles = (session) => ({
  ...session,
  label: '',
  quest: session.quest && { ...session.quest, title: '' },
  feed: session.feed.map(withoutTitle),
});

/** Pasta pessoal dos cenários sanitizados (o nome do usuário vira "usuario"). */
const FIXTURE_HOME = 'C:\\Users\\usuario';

describe('SINTÉTICO: reducer sobre a sessão da sonda', () => {
  const scn = syntheticScenario();

  it('forma do estado e dos eventos, atribuição pelo agent_id e elos pelo tool_response.agentId', () => {
    const result = run(scn);
    assertRunShape(result);
    assert.ok(assertAttribution(result.steps) >= 30);
    assert.ok(assertLinks(scn, result.state) >= 7);
  });

  it('nenhum conteúdo real nem valor cru chega ao estado ou aos eventos', () => {
    const result = run(scn);
    const sessions = getSessionStates(result.state);
    // O título do ticket é a primeira linha do pedido (seção 6, T8). Na sonda,
    // o primeiro pedido leva SEGREDO-DO-PEDIDO nessa linha de propósito: a
    // marca só pode aparecer no título do ticket, no quest.started e no rótulo
    // da sessão, nunca no resto.
    const all = JSON.stringify({ sessions: sessions.map(withoutTitles), events: result.events.map(withoutTitle) });
    for (const marker of CONTENT_MARKERS) assert.ok(!all.includes(marker), marker);
    assert.ok(!/TypeKey|toTypeKey|typeKey/.test(all));
    const titles = result.events.filter((event) => event.kind === 'quest.started' && !event.data.implicit).map((event) => event.data.title);
    assert.ok(titles.length > 0);
    for (const title of titles) {
      assert.ok(title.length <= 80 && !title.includes('\n'), title);
      for (const marker of CONTENT_MARKERS.filter((item) => item !== 'SEGREDO-DO-PEDIDO')) assert.ok(!title.includes(marker), marker);
    }
  });

  it('três sessões: terminal, depois do /clear e VS Code', () => {
    const { state } = run(scn);
    assert.deepEqual(getSessionStates(state).map((session) => [session.id, session.status, session.client]), [
      [SESSION, 'ended', 'terminal'],
      [SESSION_CLEAR, 'ended', 'terminal'],
      [SESSION_VSCODE, 'ended', 'vscode'],
    ]);
  });

  it('instâncias da sessão do terminal: rótulos, papéis, aninhado, segundo plano e agente interno', () => {
    const { state } = run(scn);
    const session = getSessionState(state, SESSION);
    const expected = {
      w1: 'Ler o CLAUDE.md',
      w2: 'Rodar console.log(2)',
      w3: 'Gravar z.txt e w.txt',
      w4: 'Esperar 15 s',
      w5: 'Delegar a leitura',
      w6: 'Ler o CLAUDE.md (aninhado)',
      d1: 'Ler o CLAUDE.md',
      w8: 'Esperar 30 s',
    };
    for (const [name, label] of Object.entries(expected)) {
      const instance = agentOf(session, AGENTS[name].id);
      assert.equal(instance.label, label, name);
      assert.equal(instance.finished, true, name);
      assert.equal(instance.role, name === 'd1' ? 'doc' : 'aux', name);
    }
    assert.equal(agentOf(session, AGENTS.w6.id).parentKey, AGENTS.w5.id);
    assert.equal(agentOf(session, AGENTS.w4.id).background, true);
    assert.ok(!session.agents.some((item) => item.key === AGENTS.internal.id), 'agente interno não aparece');
    assert.deepEqual(session.roster, ['orq', 'doc', 'aux']);
  });

  it('o Read do primeiro probe-worker, com o Post antes do Pre, gera um único tool.started', () => {
    const result = run(scn);
    const reads = result.events.filter((event) => event.kind === 'tool.started' && event.agentKey === AGENTS.w1.id);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].data.target, 'CLAUDE.md');
  });
});

describe('[T0] cenários reais (test/fixtures/hooks/)', () => {
  const fixtures = loadFixtureScenarios();

  it('forma, atribuição pelo agent_id e elos em cada cenário', (t) => {
    if (fixtures.length === 0) return t.skip('nenhum cenário em test/fixtures/hooks/ ainda: chegam com o T0');
    for (const { file, scenario } of fixtures) {
      const result = run(scenario, { homeDir: FIXTURE_HOME });
      assertRunShape(result);
      assertAttribution(result.steps);
      assertLinks(scenario, result.state);
      assert.ok(result.events.length > 0, file);
    }
  });
});
