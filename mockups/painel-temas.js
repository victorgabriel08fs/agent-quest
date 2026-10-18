// Vocabulário e visual de cada tema. O motor (painel.js) só conhece eventos canônicos;
// cada tema apenas traduz esses eventos em nomes, lugares e frases.
const AQ = (() => {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const F = f => `<code>${esc(f)}</code>`;
  const C = c => `<code>${esc(c)}</code>`;
  const I = t => `<i>${esc(t)}</i>`;
  const B = t => `<b>${esc(t)}</b>`;
  const joinPt = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`);
  const pl = (n, one, many) => (n === 1 ? one : many);
  const usd = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' });
  const COST_HINT = 'Custo estimado de API da sessão';
  const CAREER = ['Estagiário', 'Júnior', 'Pleno', 'Sênior', 'Especialista', 'Staff', 'Principal', 'Distinguished', 'Lenda'];
  const career = l => CAREER[Math.min(l, CAREER.length) - 1];

  const THEMES = {
    escritorio: {
      name: 'Escritório', icon: '🏢',
      roles: {
        orq: ['Gerente de Projeto', '📋', 'Gerente'],
        arq: ['Arquiteto de Software', '📐', 'Arquiteto'],
        dev: ['Dev Full-stack', '💻', 'Dev'],
        tes: ['Analista de QA', '🔍', 'QA'],
        doc: ['Tech Writer', '📝', 'Tech Writer'],
      },
      rooms: {
        hq: ['Gerência', '📋', ['📊', '🪴']],
        design: ['Sala de Arquitetura', '📐', ['🗒️', '📌']],
        dev: ['Open Space', '💻', ['🖥️', '🎧']],
        idle: ['Copa', '☕', ['🪴', '🍩']],
        docs: ['Wiki', '📚', ['🗂️', '📎']],
        test: ['Lab de QA', '🧪', ['🔬', '🧯']],
      },
      phases: ['Arquitetura', 'Desenvolvimento', 'QA', 'Documentação'],
      bars: ['Humor', 'Foco'],
      lvl: career,
      levelHelp: `Plano de carreira: ${CAREER.slice(0, 7).join(' → ')}. O anel mostra o XP que falta para a próxima promoção.`,
      levelFloat: l => `🎉 ${career(l)}`,
      compactFloat: '☕ +foco',
      questWord: 'Ticket',
      partyTitle: 'Equipe',
      feedTitle: 'Atividade',
      sysIcon: { quest_start: '🎫', phase_done: '🏁', quest_done: '🚀', achievement: '🏅' },
      bugIcon: '🐛',
      bugName: b => b,
      msgIcon: '📨',
      burst: ['🎉', '🎊', '✨', '⭐'],
      rarity: null,
      idle: 'Tomando café na copa',
      waiting: '✋ Aguardando sua aprovação',
      pendingIcon: '✋',
      pendingLabel: n => pl(n, 'aprovação pendente', 'aprovações pendentes'),
      stats: s => [
        ['💸', usd(s.cost), 'custo', COST_HINT],
        ['🐛', s.defeated, pl(s.defeated, 'bug esmagado', 'bugs esmagados')],
        ['🎫', s.quests, pl(s.quests, 'ticket entregue', 'tickets entregues')],
      ],
      verbs: {
        write: { arq: ['desenha', 'Desenhando'], dev: ['cria', 'Criando'], tes: ['escreve testes em', 'Escrevendo testes em'], doc: ['escreve', 'Escrevendo'] },
        edit: { arq: ['revisa', 'Revisando'], dev: ['edita', 'Editando'], tes: ['ajusta os testes em', 'Ajustando testes em'], doc: ['atualiza', 'Atualizando'] },
      },
      act: {
        quest_start: () => 'Organizando o quadro',
        start: () => 'Pegou o ticket',
        delegate: (e, h) => `Acompanhando o ${h.s(e.to)}`,
        read: e => `Lendo ${e.f}`,
        bash: e => `Terminal: ${e.d}`,
        approve: () => 'Aprovado, seguindo',
        error: () => 'Investigando um erro',
        test_run: () => 'Rodando os testes',
        test_fail: e => `${e.bugs.length} ${pl(e.bugs.length, 'bug encontrado', 'bugs encontrados')}`,
        test_pass: () => 'Tudo verde!',
        compact: () => 'Pausa para o café…',
      },
      log: {
        quest_start: e => `Novo ticket no quadro: ${B(e.title)}`,
        delegate: (e, h) => `${h.R('orq')} atribui o ticket ao ${h.R(e.to)}: ${I(e.d)}`,
        read: (e, h) => `${h.R(e.a)} lê ${F(e.f)}`,
        bash: (e, h) => `${h.R(e.a)} roda no terminal ${C(e.d)}`,
        permission: (e, h) => `✋ ${h.R(e.a)} pede sua aprovação: ${I(e.d)}`,
        approve: (e, h) => `Aprovado. ${h.R(e.a)} segue o trabalho`,
        error: (e, h) => `💥 ${h.R(e.a)} esbarrou num erro: ${C(e.d)}`,
        test_run: (e, h) => `${h.R(e.a)} roda a suíte de testes ${C(e.d)}`,
        test_fail: (e, h) => (e.bugs.length === 1
          ? `🐛 Ainda resta um bug: ${h.bugs(e.bugs)}`
          : `🐛 ${h.R(e.a)} encontrou ${e.bugs.length} bugs: ${h.bugs(e.bugs)}`),
        test_pass: e => `✅ ${e.n} testes verdes. Bugs esmagados!`,
        regression: (e, h) => `🚨 Regressão! Um bug que já tinha sido resolvido voltou: ${h.bugs(e.bugs)}`,
        done: (e, h) => `${h.R(e.a)} volta para a copa`,
        phase_done: (e, h) => `🏁 Etapa concluída: ${B(h.phase(e.p))}`,
        quest_done: () => '🚀 Ticket entregue! +100 XP para cada pessoa da equipe',
        achievement: (e, h) => `🏅 Conquista desbloqueada: ${B(h.ach(e.id))}`,
        levelup: (e, h) => `🎉 Promoção! ${h.R(e.a)} agora é ${B(h.lvl(e.lvl))}`,
        compact: (e, h) => `☕ ${h.R(e.a)} faz uma pausa para o café e recupera o foco (contexto compactado)`,
      },
      ach: {
        first_catch: ['Caça-Bugs', 'Encontrar o primeiro bug', '🐛'],
        full_party: ['Time Completo', 'Entregar um ticket com os quatro papéis', '🤝'],
        one_shot: ['De Primeira', 'Uma edição que passa nos testes de primeira', '🎯'],
        zero_regress: ['Zero Regressão', '10 tickets sem quebrar nenhum teste', '🛡️'],
        archivist: ['Tudo Documentado', 'Toda entrega com documentação', '📚'],
        night_owl: ['Hora Extra', 'Sessão com mais de 2 horas', '🌙'],
      },
      finale: () => ({ icon: '🚀', title: 'Ticket entregue!', sub: '+100 XP para cada pessoa da equipe' }),
    },

    guilda: {
      name: 'Guilda', icon: '🏰',
      roles: {
        orq: ['Mestre da Guilda', '👑', 'Mestre'],
        arq: ['Arquimago', '🔮', 'Arquimago'],
        dev: ['Ferreiro', '⚒️', 'Ferreiro'],
        tes: ['Caçador de Bugs', '🏹', 'Caçador'],
        doc: ['Escriba', '📜', 'Escriba'],
      },
      rooms: {
        hq: ['Salão da Guilda', '🏰', ['🚩', '🛡️']],
        design: ['Torre de Planos', '🗼', ['🔭', '✨']],
        dev: ['Forja', '🔥', ['⚒️', '🪵']],
        idle: ['Taverna', '🍺', ['🕯️', '🎲']],
        docs: ['Biblioteca', '📚', ['🕯️', '🪶']],
        test: ['Arena', '⚔️', ['🛡️', '💀']],
      },
      phases: ['Torre de Planos', 'Forja', 'Arena', 'Biblioteca'],
      bars: ['Vida', 'Mana'],
      lvl: l => `Nv. ${l}`,
      levelHelp: 'Cada ação dá XP. O anel mostra quanto falta para o próximo nível.',
      levelFloat: l => `⬆ Nv. ${l}`,
      compactFloat: '🧘 +mana',
      questWord: 'Quest',
      partyTitle: 'Party',
      feedTitle: 'Crônica',
      sysIcon: { quest_start: '📯', phase_done: '🚩', quest_done: '🎁', achievement: '🏅' },
      bugIcon: '👹',
      bugName: b => ({ NullPointer: 'Slime do NullPointer', 'Off-by-one': 'Goblin do Off-by-one', 'Race Condition': 'Espectro da Race Condition' })[b] || `Monstro ${b}`,
      msgIcon: '📜',
      burst: ['🪙', '✨', '💎', '⭐'],
      rarity: ['', 'item comum', 'item raro', 'item épico', 'item lendário'],
      idle: 'Descansando na taverna',
      waiting: '❗ Aguardando sua permissão',
      pendingIcon: '❗',
      pendingLabel: n => pl(n, 'pedido de permissão', 'pedidos de permissão'),
      stats: s => [
        ['🪙', usd(s.cost), 'ouro gasto', COST_HINT],
        ['⚔️', s.defeated, pl(s.defeated, 'monstro derrotado', 'monstros derrotados')],
        ['📜', s.quests, pl(s.quests, 'quest concluída', 'quests concluídas')],
      ],
      verbs: {
        write: { arq: ['desenha a planta', 'Desenhando a planta'], dev: ['forja', 'Forjando'], tes: ['prepara armadilhas em', 'Armando armadilhas em'], doc: ['escreve o pergaminho', 'Escrevendo'] },
        edit: { arq: ['revisa a planta', 'Revisando a planta'], dev: ['reforja', 'Reforjando'], tes: ['reforça as armadilhas em', 'Reforçando armadilhas em'], doc: ['corrige o pergaminho', 'Corrigindo'] },
      },
      act: {
        quest_start: () => 'Lendo o quadro de quests',
        start: () => 'Recebeu a missão',
        delegate: (e, h) => `Missão com o ${h.s(e.to)}`,
        read: e => `Explorando ${e.f}`,
        bash: e => `Conjurando ${e.d}`,
        approve: () => 'Permissão concedida, seguindo',
        error: () => 'Ferido! Se recompondo',
        test_run: () => 'Batalhando na Arena',
        test_fail: e => `Enfrentou ${e.bugs.length} ${pl(e.bugs.length, 'monstro', 'monstros')}`,
        test_pass: () => 'Vitória na Arena!',
        compact: () => 'Meditando…',
      },
      log: {
        quest_start: e => `Nova quest no quadro: ${B(e.title)}`,
        delegate: (e, h) => `${h.R('orq')} entrega a missão ao ${h.R(e.to)}: ${I(e.d)}`,
        read: (e, h) => `${h.R(e.a)} explora ${F(e.f)}`,
        bash: (e, h) => `${h.R(e.a)} conjura ${C(e.d)}`,
        permission: (e, h) => `❗ ${h.R(e.a)} pede sua permissão: ${I(e.d)}`,
        approve: (e, h) => `Permissão concedida. ${h.R(e.a)} segue em frente`,
        error: (e, h) => `💥 ${h.R(e.a)} sofre dano: ${C(e.d)}`,
        test_run: (e, h) => `${h.R(e.a)} abre os portões da Arena ${C(e.d)}`,
        test_fail: (e, h) => (e.bugs.length === 1
          ? `👹 Um monstro ainda resiste: ${h.bugs(e.bugs)}`
          : `👹 ${e.bugs.length} monstros surgem na Arena: ${h.bugs(e.bugs)}`),
        test_pass: e => `🏆 Todos os monstros derrotados! ${e.n} testes verdes`,
        regression: (e, h) => `☠️ Maldição! Um monstro já derrotado volta à vida: ${h.bugs(e.bugs)}`,
        done: (e, h) => `${h.R(e.a)} volta para a taverna`,
        phase_done: (e, h) => `🚩 Etapa concluída: ${B(h.phase(e.p))}`,
        quest_done: () => '🎁 Quest concluída! Baú aberto: +100 XP para cada membro da party',
        achievement: (e, h) => `🏅 Conquista desbloqueada: ${B(h.ach(e.id))}`,
        levelup: (e, h) => `⬆️ ${h.R(e.a)} sobe para o ${B(h.lvl(e.lvl))}!`,
        compact: (e, h) => `🧘 ${h.R(e.a)} medita e recupera a mana (contexto compactado)`,
      },
      ach: {
        first_catch: ['Primeiro Sangue', 'Encontrar o primeiro bug', '🩸'],
        full_party: ['Party Completa', 'Fechar uma quest com os quatro papéis', '🛡️'],
        one_shot: ['Golpe Certeiro', 'Uma edição que passa nos testes de primeira', '🎯'],
        zero_regress: ['Muralha', '10 quests sem deixar um monstro voltar', '🏰'],
        archivist: ['Arquivista', 'Toda quest registrada na Biblioteca', '📚'],
        night_owl: ['Vigília', 'Sessão com mais de 2 horas', '🌙'],
      },
      finale: () => ({ icon: '🎁', title: 'Quest concluída!', sub: 'Baú aberto: +100 XP para cada membro da party' }),
    },
  };

  return { esc, F, C, I, B, joinPt, pl, THEMES };
})();
