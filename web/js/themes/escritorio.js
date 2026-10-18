// @ts-check
// Tema Escritório (ADR 0009): vocabulário portado de mockups/painel-temas.js,
// sem XP, níveis, conquistas e custo (ADR 0008). O visual fica em
// web/css/themes.css, sob :root[data-theme="escritorio"].

import { actionTextFrom, feedLineFrom, formatDuration, pick, plural, targetOf } from './helpers.js';

/** @typedef {import('./contract.js').Theme} Theme */
/** @typedef {import('./helpers.js').FeedPhrases} FeedPhrases */
/** @typedef {import('./helpers.js').ActionPhrases} ActionPhrases */
/** @typedef {import('../../../shared/contract.js').RoleId} RoleId */

/**
 * Verbos de escrita e edição por papel: [no feed, na linha de ação].
 * @type {Record<'write'|'edit', Record<RoleId, [string, string]>>}
 */
const VERBS = {
  write: {
    orq: ['cria', 'Criando'],
    arq: ['desenha', 'Desenhando'],
    dev: ['cria', 'Criando'],
    tes: ['escreve testes em', 'Escrevendo testes em'],
    doc: ['escreve', 'Escrevendo'],
    aux: ['cria', 'Criando'],
  },
  edit: {
    orq: ['edita', 'Editando'],
    arq: ['revisa', 'Revisando'],
    dev: ['edita', 'Editando'],
    tes: ['ajusta os testes em', 'Ajustando testes em'],
    doc: ['atualiza', 'Atualizando'],
    aux: ['edita', 'Editando'],
  },
};

/** Abertura da sessão conforme o `source` do SessionStart. */
const SESSION_SOURCE = {
  startup: 'Expediente aberto',
  resume: 'Sessão retomada',
  clear: 'Quadro limpo com /clear',
  compact: 'Sessão segue depois da compactação',
  fork: 'Sessão derivada',
  other: 'Sessão iniciada',
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
  sessionEnded: (d, h) => `Fim do expediente: sessão encerrada${d.reason ? ` (${h.code(d.reason)})` : ''}`,
  questStarted: (d, h) => `Novo ticket no quadro: ${h.b(d.title)}`,
  questFinished: {
    done: (d, h) => `🚀 Ticket ${h.esc(`#${d.n ?? '?'}`)} entregue!${questSummary(d)}`,
    failed: (d, h) => `💥 Ticket ${h.esc(`#${d.n ?? '?'}`)} falhou${d.error ? `: ${h.code(d.error)}` : ''}`,
    interrupted: (d, h) => `⏸️ Ticket ${h.esc(`#${d.n ?? '?'}`)} interrompido${questSummary(d)}`,
  },
  phaseDone: (d, h) => `🏁 Etapa concluída: ${h.b(h.phase(d.phase))}`,
  delegated: (who, d, h) =>
    `${who} atribui uma tarefa ao ${h.roleName(d.toRole, d.toType)}${d.description ? `: ${h.i(d.description)}` : ''}${d.background ? ' (em segundo plano)' : ''}`,
  agentFinished: {
    done: (who) => `${who} volta para a copa`,
    unknown: (who) => `${who} volta para a copa (fim não confirmado)`,
  },
  tool: {
    read: (who, d, h) => `${who} lê ${h.code(targetOf(d))}`,
    search: (who, d, h) => `${who} procura ${h.code(targetOf(d))}`,
    write: (who, d, h, role) => `${who} ${verb(role, 'write', 0)} ${h.code(targetOf(d))}`,
    edit: (who, d, h, role) => `${who} ${verb(role, 'edit', 0)} ${h.code(targetOf(d))}`,
    test: (who, d, h) => `${who} roda a suíte de testes ${h.code(targetOf(d))}`,
    bash: (who, d, h) => `${who} roda no terminal ${h.code(targetOf(d))}`,
    web: (who, d, h) => `${who} consulta ${h.code(targetOf(d))}`,
    plan: (who) => `${who} atualiza o quadro de tarefas`,
    skill: (who, d, h) => `${who} usa a skill ${h.code(targetOf(d))}`,
    mcp: (who, d, h) => `${who} chama ${h.code(targetOf(d))}`,
    other: (who, d, h) => `${who} usa ${h.code(targetOf(d))}`,
  },
  toolFailed: (who, d, h) => `💥 ${who} esbarrou num erro: ${h.code(d.error || targetOf(d))}`,
  toolInterrupted: (who, d, h) => `⏹️ ${who} interrompeu ${h.code(targetOf(d))}`,
  testPassed: (who, d, h) => {
    const n = Number.isFinite(d.passed) ? d.passed : d.total;
    return Number.isFinite(n) ? `✅ ${who}: ${n} ${h.plural(n, 'teste verde', 'testes verdes')}` : `✅ ${who}: testes verdes`;
  },
  testFailed: (who, d, h) =>
    Number.isFinite(d.failed)
      ? `🐛 ${who} encontrou ${d.failed} ${h.plural(d.failed, 'bug', 'bugs')}`
      : `🐛 ${who} viu os testes falharem`,
  permissionRequested: (who, d, h) => `✋ ${who} pede sua aprovação: ${h.code(targetOf(d))}`,
  permissionResolved: {
    approved: (who) => `Aprovado. ${who} segue o trabalho`,
    denied: (who) => `🚫 Pedido de ${who} negado`,
    unknown: (who) => `Pedido de ${who} negado ou cancelado`,
  },
  compacted: (who) => `☕ ${who} faz uma pausa para o café e recupera o foco (contexto compactado)`,
};

const WORDS = {
  quest: 'Ticket',
  party: 'Equipe',
  feed: 'Atividade',
  idle: 'Tomando café na copa',
  orqIdle: 'Aguardando o próximo pedido',
  start: 'Pegou o ticket',
  waiting: '✋ Aguardando sua aprovação',
  noQuest: 'Sem ticket no momento',
  noQuestHint: 'O quadro de tickets mostra o pedido em andamento.',
  noSessions: 'Nenhuma sessão por aqui ainda',
  noAgents: 'Ninguém no escritório ainda',
  noFeed: 'Nenhuma atividade ainda',
  questStatus: {
    open: 'em andamento',
    waiting_background: 'aguardando tarefa em segundo plano',
    done: 'entregue',
    failed: 'falhou',
    interrupted: 'interrompido',
  },
};

/** @type {ActionPhrases} */
const ACTION = {
  idle: WORDS.idle,
  orqIdle: WORDS.orqIdle,
  start: WORDS.start,
  waiting: WORDS.waiting,
  delegating: (text) => (text ? `Delegando: ${text}` : 'Delegando uma tarefa'),
  compacting: 'Pausa para o café…',
  failed: 'Investigando um erro',
  doing: {
    read: (t) => `Lendo ${t}`,
    search: (t) => `Procurando ${t}`,
    write: (t, role) => `${verb(role, 'write', 1)} ${t}`,
    edit: (t, role) => `${verb(role, 'edit', 1)} ${t}`,
    test: () => 'Rodando os testes',
    bash: (t) => `Terminal: ${t}`,
    web: (t) => `Consultando ${t}`,
    plan: () => 'Organizando o quadro',
    skill: (t) => `Usando a skill ${t}`,
    mcp: (t) => `Chamando ${t}`,
    other: (t) => `Usando ${t}`,
  },
};

/** @type {Theme} */
const escritorio = {
  id: 'escritorio',
  name: 'Escritório',
  icon: '🏢',
  roles: {
    orq: { name: 'Gerente de Projeto', icon: '📋', short: 'Gerente' },
    arq: { name: 'Arquiteto de Software', icon: '📐', short: 'Arquiteto' },
    dev: { name: 'Dev Full-stack', icon: '💻', short: 'Dev' },
    tes: { name: 'Analista de QA', icon: '🔍', short: 'QA' },
    doc: { name: 'Tech Writer', icon: '📝', short: 'Tech Writer' },
    aux: { name: 'Consultor Externo', icon: '💼', short: 'Consultor' },
  },
  rooms: {
    hq: { name: 'Gerência', icon: '📋', deco: ['📊', '🪴'] },
    design: { name: 'Sala de Arquitetura', icon: '📐', deco: ['🗒️', '📌'] },
    dev: { name: 'Open Space', icon: '💻', deco: ['🖥️', '🎧'] },
    idle: { name: 'Copa', icon: '☕', deco: ['🪴', '🍩'] },
    docs: { name: 'Wiki', icon: '📚', deco: ['🗂️', '📎'] },
    test: { name: 'Lab de QA', icon: '🧪', deco: ['🔬', '🧯'] },
  },
  phases: { design: 'Arquitetura', code: 'Desenvolvimento', test: 'QA', docs: 'Documentação' },
  bars: { health: 'Humor', context: 'Foco' },
  words: WORDS,
  icons: {
    session: '🏢',
    questStarted: '🎫',
    questDone: '🚀',
    questFailed: '💥',
    questInterrupted: '⏸️',
    phaseDone: '🏁',
  },
  feedLine: (event, h) => feedLineFrom(FEED, event, h),
  actionText: (agent) => actionTextFrom(ACTION, agent),
  finale: (summary) => ({
    icon: '🚀',
    title: 'Ticket entregue!',
    sub: [
      `${summary.actions} ${plural(summary.actions, 'ação', 'ações')}`,
      `${summary.agents} ${plural(summary.agents, 'pessoa na equipe', 'pessoas na equipe')}`,
      formatDuration(summary.durationMs),
    ].join(' · '),
  }),
  stats: (view) => [
    { id: 'duration', icon: '⏱️', value: formatDuration(view.durationMs), label: 'de sessão', title: 'Duração da sessão', highlight: false },
    {
      id: 'bugs',
      icon: '🐛',
      value: String(view.bugsCrushed),
      label: plural(view.bugsCrushed, 'bug esmagado', 'bugs esmagados'),
      title: '≈ Falhas de teste que um run seguinte, aprovado, zerou (aproximado)',
      highlight: false,
    },
    {
      id: 'quests',
      icon: '🎫',
      value: String(view.questsDone),
      label: plural(view.questsDone, 'ticket entregue', 'tickets entregues'),
      title: 'Tickets encerrados com sucesso nesta sessão',
      highlight: false,
    },
    {
      id: 'pending',
      icon: '✋',
      value: String(view.pendingApprovals),
      label: plural(view.pendingApprovals, 'aprovação pendente', 'aprovações pendentes'),
      title: 'Pedidos de aprovação esperando por você',
      highlight: view.pendingApprovals > 0,
    },
  ],
};

export default escritorio;
