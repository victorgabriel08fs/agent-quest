// @ts-check
// Tema Guilda (ADR 0009): vocabulário portado de mockups/painel-temas.js,
// sem XP, níveis, conquistas e custo (ADR 0008). O visual fica em
// web/css/themes.css, sob :root[data-theme="guilda"].

import { actionTextFrom, feedLineFrom, formatDuration, pick, plural, targetOf } from './helpers.js';

/** @typedef {import('./contract.js').Theme} Theme */
/** @typedef {import('./helpers.js').FeedPhrases} FeedPhrases */
/** @typedef {import('./helpers.js').ActionPhrases} ActionPhrases */
/** @typedef {import('../../../shared/contract.js').RoleId} RoleId */

/**
 * Verbos de escrita e edição por papel: [na crônica, na linha de ação].
 * @type {Record<'write'|'edit', Record<RoleId, [string, string]>>}
 */
const VERBS = {
  write: {
    orq: ['escreve o édito', 'Escrevendo o édito'],
    arq: ['desenha a planta', 'Desenhando a planta'],
    dev: ['forja', 'Forjando'],
    tes: ['prepara armadilhas em', 'Armando armadilhas em'],
    doc: ['escreve o pergaminho', 'Escrevendo'],
    aux: ['rabisca', 'Rabiscando'],
  },
  edit: {
    orq: ['emenda o édito', 'Emendando o édito'],
    arq: ['revisa a planta', 'Revisando a planta'],
    dev: ['reforja', 'Reforjando'],
    tes: ['reforça as armadilhas em', 'Reforçando armadilhas em'],
    doc: ['corrige o pergaminho', 'Corrigindo'],
    aux: ['ajusta', 'Ajustando'],
  },
};

/** Abertura da sessão conforme o `source` do SessionStart. */
const SESSION_SOURCE = {
  startup: 'A guilda abre os portões',
  resume: 'A jornada continua',
  clear: 'Mesa limpa com /clear',
  compact: 'A jornada segue depois da meditação',
  fork: 'Uma nova expedição parte',
  other: 'A guilda se reúne',
};

/** @param {Record<string, any>} d */
const questSummary = (d) => {
  const parts = [];
  if (Number.isFinite(d.actions)) parts.push(`${d.actions} ${plural(d.actions, 'ação', 'ações')}`);
  if (Number.isFinite(d.durationMs)) parts.push(formatDuration(d.durationMs));
  return parts.length ? ` · ${parts.join(' · ')}` : '';
};

/** @param {RoleId} role @param {'write'|'edit'} kind @param {0|1} form */
const verb = (role, kind, form) => pick(VERBS[kind], role, 'aux')[form];

/** @type {FeedPhrases} */
const FEED = {
  sessionStarted: (d, h) => `${pick(SESSION_SOURCE, d.source, 'other')}${d.projectName ? ` em ${h.b(d.projectName)}` : ''}`,
  sessionEnded: (d, h) => `A guilda fecha os portões: sessão encerrada${d.reason ? ` (${h.code(d.reason)})` : ''}`,
  questStarted: (d, h) => `Nova quest no quadro: ${h.b(d.title)}`,
  questFinished: {
    done: (d, h) => `🎁 Quest ${h.esc(`#${d.n ?? '?'}`)} concluída!${questSummary(d)}`,
    failed: (d, h) => `☠️ Quest ${h.esc(`#${d.n ?? '?'}`)} fracassou${d.error ? `: ${h.code(d.error)}` : ''}`,
    interrupted: (d, h) => `🏳️ Quest ${h.esc(`#${d.n ?? '?'}`)} interrompida${questSummary(d)}`,
  },
  phaseDone: (d, h) => `🚩 Etapa concluída: ${h.b(h.phase(d.phase))}`,
  delegated: (who, d, h) =>
    `${who} entrega uma missão ao ${h.roleName(d.toRole, d.toType)}${d.description ? `: ${h.i(d.description)}` : ''}${d.background ? ' (em segundo plano)' : ''}`,
  agentFinished: {
    done: (who) => `${who} volta para a taverna`,
    unknown: (who) => `${who} volta para a taverna (fim não confirmado)`,
  },
  tool: {
    read: (who, d, h) => `${who} explora ${h.code(targetOf(d))}`,
    search: (who, d, h) => `${who} rastreia ${h.code(targetOf(d))}`,
    write: (who, d, h, role) => `${who} ${verb(role, 'write', 0)} ${h.code(targetOf(d))}`,
    edit: (who, d, h, role) => `${who} ${verb(role, 'edit', 0)} ${h.code(targetOf(d))}`,
    test: (who, d, h) => `${who} abre os portões da Arena ${h.code(targetOf(d))}`,
    bash: (who, d, h) => `${who} conjura ${h.code(targetOf(d))}`,
    web: (who, d, h) => `${who} envia um corvo a ${h.code(targetOf(d))}`,
    plan: (who) => `${who} revisa o mapa da missão`,
    skill: (who, d, h) => `${who} abre o grimório ${h.code(targetOf(d))}`,
    mcp: (who, d, h) => `${who} invoca ${h.code(targetOf(d))}`,
    other: (who, d, h) => `${who} usa o artefato ${h.code(targetOf(d))}`,
  },
  toolFailed: (who, d, h) => `💥 ${who} sofre dano: ${h.code(d.error || targetOf(d))}`,
  toolInterrupted: (who, d, h) => `⏹️ ${who} recua de ${h.code(targetOf(d))}`,
  testPassed: (who, d, h) => {
    const n = Number.isFinite(d.passed) ? d.passed : d.total;
    return Number.isFinite(n)
      ? `🏆 Vitória na Arena! ${who} vence com ${n} ${h.plural(n, 'teste verde', 'testes verdes')}`
      : `🏆 Vitória na Arena! ${who} vence com os testes verdes`;
  },
  testFailed: (who, d, h) =>
    Number.isFinite(d.failed)
      ? `👹 ${d.failed} ${h.plural(d.failed, 'monstro surge', 'monstros surgem')} diante do ${who}`
      : `👹 Um monstro surge diante do ${who}`,
  permissionRequested: (who, d, h) => `❗ ${who} pede sua permissão: ${h.code(targetOf(d))}`,
  permissionResolved: {
    approved: (who) => `Permissão concedida. ${who} segue em frente`,
    denied: (who) => `🚫 Permissão negada ao ${who}`,
    unknown: (who) => `O pedido do ${who} foi negado ou cancelado`,
  },
  compacted: (who) => `🧘 ${who} medita e recupera a mana (contexto compactado)`,
};

const WORDS = {
  quest: 'Quest',
  party: 'Party',
  feed: 'Crônica',
  idle: 'Descansando na taverna',
  orqIdle: 'Aguardando um novo pedido no salão',
  start: 'Recebeu a missão',
  waiting: '❗ Aguardando sua permissão',
  noQuest: 'Nenhuma quest no quadro',
  noQuestHint: 'O quadro de quests mostra a missão em andamento.',
  noSessions: 'O salão da guilda está vazio',
  noAgents: 'Nenhum aventureiro no salão ainda',
  noFeed: 'A crônica ainda está em branco',
  questStatus: {
    open: 'em curso',
    waiting_background: 'aguardando o retorno de uma missão em segundo plano',
    done: 'concluída',
    failed: 'fracassada',
    interrupted: 'interrompida',
  },
};

/** @type {ActionPhrases} */
const ACTION = {
  idle: WORDS.idle,
  orqIdle: WORDS.orqIdle,
  start: WORDS.start,
  waiting: WORDS.waiting,
  delegating: (text) => (text ? `Enviando missão: ${text}` : 'Enviando uma missão'),
  compacting: 'Meditando…',
  failed: 'Ferido! Se recompondo',
  doing: {
    read: (t) => `Explorando ${t}`,
    search: (t) => `Rastreando ${t}`,
    write: (t, role) => `${verb(role, 'write', 1)} ${t}`,
    edit: (t, role) => `${verb(role, 'edit', 1)} ${t}`,
    test: () => 'Batalhando na Arena',
    bash: (t) => `Conjurando ${t}`,
    web: (t) => `Enviando um corvo a ${t}`,
    plan: () => 'Lendo o quadro de quests',
    skill: (t) => `Abrindo o grimório ${t}`,
    mcp: (t) => `Invocando ${t}`,
    other: (t) => `Usando o artefato ${t}`,
  },
};

/** @type {Theme} */
const guilda = {
  id: 'guilda',
  name: 'Guilda',
  icon: '🏰',
  roles: {
    orq: { name: 'Mestre da Guilda', icon: '👑', short: 'Mestre' },
    arq: { name: 'Arquimago', icon: '🔮', short: 'Arquimago' },
    dev: { name: 'Ferreiro', icon: '⚒️', short: 'Ferreiro' },
    tes: { name: 'Caçador de Bugs', icon: '🏹', short: 'Caçador' },
    doc: { name: 'Escriba', icon: '📜', short: 'Escriba' },
    aux: { name: 'Aventureiro Convidado', icon: '🧭', short: 'Aventureiro' },
  },
  rooms: {
    hq: { name: 'Salão da Guilda', icon: '🏰', deco: ['🚩', '🛡️'] },
    design: { name: 'Torre de Planos', icon: '🗼', deco: ['🔭', '✨'] },
    dev: { name: 'Forja', icon: '🔥', deco: ['⚒️', '🪵'] },
    idle: { name: 'Taverna', icon: '🍺', deco: ['🕯️', '🎲'] },
    docs: { name: 'Biblioteca', icon: '📚', deco: ['🕯️', '🪶'] },
    test: { name: 'Arena', icon: '⚔️', deco: ['🛡️', '💀'] },
  },
  phases: { design: 'Torre de Planos', code: 'Forja', test: 'Arena', docs: 'Biblioteca' },
  bars: { health: 'Vida', context: 'Mana' },
  words: WORDS,
  icons: {
    session: '🏰',
    questStarted: '📯',
    questDone: '🎁',
    questFailed: '☠️',
    questInterrupted: '🏳️',
    phaseDone: '🚩',
  },
  feedLine: (event, h) => feedLineFrom(FEED, event, h),
  actionText: (agent) => actionTextFrom(ACTION, agent),
  finale: (summary) => ({
    icon: '🎁',
    title: 'Quest concluída!',
    sub: [
      `${summary.actions} ${plural(summary.actions, 'ação', 'ações')}`,
      `${summary.agents} ${plural(summary.agents, 'membro da party', 'membros da party')}`,
      formatDuration(summary.durationMs),
    ].join(' · '),
  }),
  stats: (view) => [
    { id: 'duration', icon: '⏳', value: formatDuration(view.durationMs), label: 'de jornada', title: 'Duração da sessão', highlight: false },
    {
      id: 'bugs',
      icon: '⚔️',
      value: String(view.bugsCrushed),
      label: plural(view.bugsCrushed, 'monstro derrotado', 'monstros derrotados'),
      title: '≈ Falhas de teste que um run seguinte, aprovado, zerou (aproximado)',
      highlight: false,
    },
    {
      id: 'quests',
      icon: '📜',
      value: String(view.questsDone),
      label: plural(view.questsDone, 'quest concluída', 'quests concluídas'),
      title: 'Quests encerradas com sucesso nesta sessão',
      highlight: false,
    },
    {
      id: 'pending',
      icon: '❗',
      value: String(view.pendingApprovals),
      label: plural(view.pendingApprovals, 'pedido de permissão', 'pedidos de permissão'),
      title: 'Pedidos de permissão esperando por você',
      highlight: view.pendingApprovals > 0,
    },
  ],
};

export default guilda;
