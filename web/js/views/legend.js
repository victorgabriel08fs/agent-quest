// @ts-check
// Legenda "Como ler o painel" (T14; ADR 0008 e 0009), como no mockup
// (mockups/painel.js, `legendHTML`): um diálogo com tabelas geradas pelos
// próprios temas, para não ficar desatualizada.
//
// - "Eventos": evento real do Claude Code → frase do tema. Cada linha passa um
//   evento canônico de exemplo (dados fictícios) pelo `theme.feedLine`; as
//   linhas cobrem todo tipo de FEED_KINDS e toda categoria de ferramenta.
// - "Lugares" e "Estados": salas da cena e a linha de ação de cada estado, nos
//   nomes do tema.
// - "De onde vem cada dado": a fonte de cada indicador e se ele é real,
//   aproximado (≈) ou derivado (ADR 0008), com os nomes que o tema dá a eles.
// - "Modo discreto e atalhos".
//
// Os textos de explicação são neutros (iguais nos dois temas, como os
// controles); os nomes e as frases vêm do tema. Todo texto dinâmico passa por
// `esc`, e as frases do tema já chegam escapadas.

import { ROLE_TITLES, PHASE_OWNER } from '../selectors.js';
import { createHelpers, esc } from '../themes/helpers.js';

/** @typedef {import('../../../shared/contract.js').CanonicalEvent} CanonicalEvent */
/** @typedef {import('../../../shared/contract.js').AgentState} AgentState */
/** @typedef {import('../../../shared/contract.js').RoleId} RoleId */
/** @typedef {import('../themes/contract.js').Theme} Theme */

/** Agentes fictícios dos exemplos (um por papel do time). */
const SAMPLE_AGENTS = /** @type {AgentState[]} */ ([
  ['main', 'orq', null], ['ex-arq', 'arq', 'arquiteto'], ['ex-dev', 'dev', 'dev-frontend'],
  ['ex-tes', 'tes', 'tester'], ['ex-doc', 'doc', 'documentador'], ['ex-aux', 'aux', 'Explore'],
].map(([key, role, agentType]) => ({
  key, agentId: key === 'main' ? null : key, agentType, role, label: '', status: 'working', finished: false,
  background: false, parentKey: key === 'main' ? null : 'main', activity: null, waitingFor: null,
  health: { ok: 0, total: 0 }, context: null, startedAt: 0, lastEventAt: 0,
})));

/**
 * Linhas da tabela "Eventos": [evento real (HTML seguro, neutro), tipo, dados, agente].
 * @type {ReadonlyArray<[string, CanonicalEvent['kind'], Record<string, unknown>, string|null]>}
 */
export const LEGEND_EVENTS = Object.freeze([
  ['Sessão começa (<code>SessionStart</code>)', 'session.started', { source: 'startup', projectName: 'meu-projeto' }, null],
  ['Pedido do usuário (<code>UserPromptSubmit</code>)', 'quest.started', { questId: 'q', n: 1, title: 'Implementar o painel', implicit: false }, 'main'],
  ['Orquestrador delega a um subagente (<code>Agent</code>)', 'agent.delegated', { toolUseId: 't0', toType: 'dev-frontend', toRole: 'dev', description: 'implementar o painel', background: false }, 'main'],
  ['<code>Read</code>', 'tool.started', { toolUseId: 't1', tool: 'Read', category: 'read', target: 'README.md', detail: null }, 'ex-arq'],
  ['<code>Grep</code>, <code>Glob</code>', 'tool.started', { toolUseId: 't2', tool: 'Grep', category: 'search', target: 'TODO', detail: null }, 'ex-arq'],
  ['<code>Write</code> (arquivo novo)', 'tool.started', { toolUseId: 't3', tool: 'Write', category: 'write', target: 'web/js/painel.js', detail: null }, 'ex-dev'],
  ['<code>Edit</code>', 'tool.started', { toolUseId: 't4', tool: 'Edit', category: 'edit', target: 'web/css/painel.css', detail: null }, 'ex-dev'],
  ['Comando de teste (<code>Bash</code> ou <code>PowerShell</code>)', 'tool.started', { toolUseId: 't5', tool: 'Bash', category: 'test', target: 'npm test', detail: null }, 'ex-tes'],
  ['Outro comando (<code>Bash</code> ou <code>PowerShell</code>)', 'tool.started', { toolUseId: 't6', tool: 'Bash', category: 'bash', target: 'npm install', detail: null }, 'ex-dev'],
  ['<code>WebFetch</code>, <code>WebSearch</code>', 'tool.started', { toolUseId: 't7', tool: 'WebFetch', category: 'web', target: 'nodejs.org', detail: null }, 'ex-doc'],
  ['Lista de tarefas (<code>TodoWrite</code>)', 'tool.started', { toolUseId: 't8', tool: 'TodoWrite', category: 'plan', target: null, detail: null }, 'main'],
  ['<code>Skill</code>', 'tool.started', { toolUseId: 't9', tool: 'Skill', category: 'skill', target: 'revisar', detail: null }, 'main'],
  ['Ferramenta MCP', 'tool.started', { toolUseId: 't10', tool: 'mcp__docs__buscar', category: 'mcp', target: 'docs/buscar', detail: null }, 'ex-doc'],
  ['Outra ferramenta', 'tool.started', { toolUseId: 't11', tool: 'Ferramenta', category: 'other', target: 'Ferramenta', detail: null }, 'ex-aux'],
  ['Testes passando', 'test.finished', { toolUseId: 't5', ok: true, passed: 14, failed: 0, total: 14, framework: 'node:test' }, 'ex-tes'],
  ['Testes falhando', 'test.finished', { toolUseId: 't5', ok: false, passed: 12, failed: 2, total: 14, framework: 'node:test' }, 'ex-tes'],
  ['Erro de ferramenta (<code>PostToolUseFailure</code>)', 'tool.failed', { toolUseId: 't6', tool: 'Bash', category: 'bash', target: 'npm install', error: 'Exit code 1', interrupted: false }, 'ex-dev'],
  ['Ação interrompida por quem usa o Claude Code', 'tool.failed', { toolUseId: 't6', tool: 'Bash', category: 'bash', target: 'npm install', error: null, interrupted: true }, 'ex-dev'],
  ['Pedido de aprovação (<code>PermissionRequest</code>)', 'permission.requested', { tool: 'Bash', category: 'bash', target: 'npm install' }, 'ex-dev'],
  ['Pedido aprovado', 'permission.resolved', { outcome: 'approved', by: 'user' }, 'ex-dev'],
  ['Pedido negado (<code>PermissionDenied</code>)', 'permission.resolved', { outcome: 'denied', by: 'auto' }, 'ex-dev'],
  ['Pedido sem resposta conhecida', 'permission.resolved', { outcome: 'unknown', by: 'inferred' }, 'ex-dev'],
  ['Subagente terminou (<code>SubagentStop</code>)', 'agent.finished', { outcome: 'done' }, 'ex-doc'],
  ['Etapa do ticket concluída', 'quest.phase', { questId: 'q', phase: 'code', state: 'done' }, 'ex-dev'],
  ['Ticket entregue (<code>Stop</code>)', 'quest.finished', { questId: 'q', n: 1, outcome: 'done', error: null, durationMs: 272_000, actions: 18 }, 'main'],
  ['Ticket com falha (<code>StopFailure</code>)', 'quest.finished', { questId: 'q', n: 1, outcome: 'failed', error: 'rate_limit', durationMs: 60_000, actions: 3 }, 'main'],
  ['Ticket interrompido', 'quest.finished', { questId: 'q', n: 1, outcome: 'interrupted', error: null, durationMs: 60_000, actions: 3 }, 'main'],
  ['Contexto compactado (<code>PreCompact</code> e <code>PostCompact</code>)', 'context.compacted', { trigger: 'auto' }, 'main'],
  ['Sessão encerrada (<code>SessionEnd</code>)', 'session.ended', { reason: 'prompt_input_exit' }, null],
]);

/**
 * Evento canônico de exemplo de uma linha da legenda.
 * @param {number} index
 * @returns {CanonicalEvent}
 */
export function legendEvent(index) {
  const [, kind, data, agentKey] = LEGEND_EVENTS[index];
  return { id: `legenda:${index}`, seq: index + 1, ts: 0, sessionId: 'legenda', agentKey, kind, data };
}

/** @param {string} th @param {string} td */
const row = (th, td) => `<tr><th scope="row">${th}</th><td>${td}</td></tr>`;
/** @param {string} title @param {string} rows */
const table = (title, rows) => `<h3>${esc(title)}</h3><table class="lg-table"><tbody>${rows}</tbody></table>`;

/**
 * Título do diálogo.
 * @param {Theme} theme
 * @returns {string}
 */
export function legendTitle(theme) {
  return `Como ler o painel · ${theme.name}`;
}

/**
 * Corpo do diálogo da legenda (HTML seguro).
 * @param {{ theme: Theme, discreet?: boolean }} params   discreet: as frases de exemplo no modo discreto
 * @returns {string}
 */
export function renderLegend({ theme, discreet = false }) {
  const h = createHelpers(theme, SAMPLE_AGENTS, { discreet });
  const events = LEGEND_EVENTS.map(([label], index) => row(label, theme.feedLine(legendEvent(index), h) ?? '')).join('');
  return `<p>O que aparece na tela é uma tradução do que os agentes estão fazendo de verdade no Claude Code. ` +
    `Escritório e Guilda contam os mesmos eventos, cada um com o próprio vocabulário.</p>` +
    table('Eventos', events) +
    table('Lugares', placesRows(theme)) +
    table('Estados', statesRows(theme, h)) +
    sourcesHTML(theme) +
    `<h3>Modo discreto e atalhos</h3>` +
    `<p>O modo discreto (botão <span aria-hidden="true">🕶️</span> ou tecla <kbd>D</kbd>) troca comandos, caminhos, títulos, ` +
    `descrições e erros por textos só de categoria, como "Rodando um comando" ou "Editando um arquivo". Use ao compartilhar a tela. ` +
    `Ele começa desligado, e a escolha fica guardada neste navegador.</p>` +
    `<table class="lg-table"><tbody>` +
    row('<kbd>1</kbd> <kbd>2</kbd>', 'Escolhem o tema') +
    row('<kbd>T</kbd>', 'Alterna o tema') +
    row('<kbd>D</kbd>', 'Liga e desliga o modo discreto') +
    row('<kbd>?</kbd>', 'Abre esta legenda; <kbd>Esc</kbd> fecha') +
    `</tbody></table>`;
}

/**
 * Salas da cena, com quem trabalha em cada uma.
 * @param {Theme} theme
 * @returns {string}
 */
function placesRows(theme) {
  /** @type {Array<['hq'|'design'|'dev'|'test'|'docs', RoleId]>} */
  const rooms = [['hq', 'orq'], ['design', 'arq'], ['dev', 'dev'], ['test', 'tes'], ['docs', 'doc']];
  const place = (/** @type {import('../themes/contract.js').RoomId} */ id) => `<span aria-hidden="true">${esc(theme.rooms[id].icon)}</span> ${esc(theme.rooms[id].name)}`;
  return rooms.map(([room, role]) => {
    const who = `<b>${esc(theme.roles[role].name)}</b> (${esc(ROLE_TITLES[role])})`;
    return row(place(room), room === 'hq'
      ? `Onde trabalham o ${who} e os convidados (<b>${esc(theme.roles.aux.name)}</b>)`
      : `Onde trabalha o ${who}`);
  }).join('') +
    row(place('idle'), 'Para onde vão os subagentes que terminaram a tarefa') +
    row('"+N"', 'Cada sala mostra até 3 agentes; os outros aparecem na contagem') +
    row(`Bugs na cena (${esc(theme.rooms.test.name)})`, 'Um por falha de teste em aberto (até 4 e "+N"); a sala fica em alarme enquanto houver');
}

/**
 * Estados de um agente, com a linha de ação do tema.
 * @param {Theme} theme
 * @param {import('../themes/contract.js').ThemeHelpers} h
 * @returns {string}
 */
function statesRows(theme, h) {
  const base = SAMPLE_AGENTS[2];
  /** @param {Partial<AgentState>} fields */
  const action = (fields) => esc(theme.actionText({ ...base, ...fields }, h));
  return row('Trabalhando', `${action({ status: 'working', activity: { kind: 'tool', category: 'edit', tool: 'Edit', target: 'web/css/painel.css', detail: null, state: 'running', at: 0 } })}`) +
    row('Aguardando aprovação', `${action({ status: 'waiting' })} (selo "!" na cena e destaque no topo)`) +
    row('Ocioso ou encerrado', action({ status: 'idle', finished: true })) +
    row('Orquestrador sem pedido', esc(theme.actionText({ ...SAMPLE_AGENTS[0], status: 'idle' }, h)));
}

/**
 * "De onde vem cada dado" (ADR 0008), com os nomes do tema.
 * @param {Theme} theme
 * @returns {string}
 */
function sourcesHTML(theme) {
  const stats = theme.stats({ durationMs: 0, bugsCrushed: 2, questsDone: 2, pendingApprovals: 2 });
  const stat = (/** @type {string} */ id) => {
    const item = stats.find((entry) => entry.id === id);
    return item ? `<span aria-hidden="true">${esc(item.icon)}</span> ${esc(id === 'duration' ? item.title : item.label)}` : esc(id);
  };
  const phases = Object.entries(PHASE_OWNER)
    .map(([phase, role]) => `${esc(ROLE_TITLES[/** @type {RoleId} */ (role)])} → ${esc(theme.phases[/** @type {keyof Theme['phases']} */ (phase)])}`)
    .join(', ');
  /** @type {Array<[string, string, string]>} */
  const rows = [
    [stat('duration'), 'Do primeiro evento da sessão até agora, ou até o último evento se ela foi encerrada', 'Real'],
    [stat('bugs'), 'Soma das falhas de teste que um run seguinte, aprovado, zerou', 'Aproximado (≈)'],
    [stat('quests'), 'Tickets encerrados com sucesso na sessão', 'Real'],
    [stat('pending'), 'Do pedido de aprovação (<code>PermissionRequest</code>) até a ferramenta rodar, outra ação do mesmo agente ou o fim do turno. "Negado ou cancelado" é inferido', 'Real'],
    [esc(theme.words.party), '<code>SubagentStart</code> e eventos com <code>agent_id</code> e <code>agent_type</code>; nomes dos arquivos em <code>.claude/agents/</code> do projeto e do usuário (só os nomes)', 'Real'],
    ['Trabalhando, aguardando, ocioso', '<code>PreToolUse</code>, <code>PostToolUse</code>, <code>PostToolUseFailure</code>, <code>PermissionRequest</code>, <code>SubagentStop</code>, <code>Stop</code> e <code>Notification</code>. "Aguardando" é atribuído por heurística se o pedido vier sem <code>agent_id</code>', 'Real'],
    ['Ação atual (balão e cartão)', 'Nome da ferramenta e campos minimizados da entrada (caminho, comando, padrão de busca), já cortados e redigidos pelo servidor', 'Real'],
    [esc(theme.bars.health), 'Fração de sucesso nas últimas 10 ações do agente; comando de teste conta pelo resultado do teste', 'Aproximado (≈)'],
    [esc(theme.bars.context), 'Contexto que ainda cabe na janela do agente. Vem do uso de tokens da última resposta (<code>message.usage</code>) no transcript local do agente, em <code>~/.claude/projects</code>, lido no máximo a cada 5 s. ' +
      'A janela sai do modelo dessa resposta: 1 milhão de tokens por padrão; 200 mil para Opus e Sonnet até 4.6, Haiku 4.x e Claude 3.x, enquanto o uso não passar disso. ' +
      'A barra some quando o transcript não pode ser lido e depois de uma compactação, até a próxima resposta', 'Aproximado (≈)'],
    [`Bugs na cena (${esc(theme.rooms.test.name)})`, 'Comandos de teste no <code>Bash</code> ou <code>PowerShell</code>: o resultado e a contagem lida do resumo (node:test, Jest, Vitest, pytest, PHPUnit/Pest, go test)', 'Aproximado (≈)'],
    [esc(theme.words.quest), 'Do pedido (<code>UserPromptSubmit</code>) até <code>Stop</code> ou <code>StopFailure</code>; o título é a primeira linha do pedido', 'Real'],
    ['Etapas do ticket', `Delegações a papéis do time dentro do ticket: ${phases}. Só aparecem quando o ticket envolve papéis do time`, 'Derivado'],
    ['Pausa (compactação)', '<code>PreCompact</code> e <code>PostCompact</code>', 'Real'],
  ];
  return `<h3>De onde vem cada dado</h3>` +
    `<table class="lg-table lg-sources"><thead><tr><th scope="col">Indicador</th><th scope="col">Fonte</th><th scope="col">Situação</th></tr></thead><tbody>` +
    rows.map(([name, source, kind]) => `<tr><th scope="row">${name}</th><td>${source}</td><td>${esc(kind)}</td></tr>`).join('') +
    `</tbody></table>` +
    `<p>"≈" marca o que é aproximado; o tooltip de cada indicador explica a conta. Quando um dado não existe, o indicador some em vez de mostrar zero. ` +
    `Custo, XP, níveis e conquistas não fazem parte desta versão.</p>`;
}
