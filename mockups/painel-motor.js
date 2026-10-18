// Motor da simulação: eventos canônicos (iguais para todos os temas) e o estado da party.
// No produto real, estes eventos viriam dos hooks do Claude Code em vez do roteiro abaixo.
const Motor = (() => {
  'use strict';

  const ORDER = ['orq', 'arq', 'dev', 'tes', 'doc'];
  const REAL_ROLE = { orq: 'Orquestrador', arq: 'System Design', dev: 'Dev', tes: 'Tester', doc: 'Documentação' };
  const PHASE_OWNER = ['arq', 'dev', 'tes', 'doc'];
  const PHASE_REAL = ['design', 'código', 'testes', 'docs'];

  const levelBase = l => 50 * l * (l - 1);
  const levelOf = xp => { let l = 1; while (levelBase(l + 1) <= xp) l++; return l; };
  const levelPct = xp => {
    const l = levelOf(xp);
    return Math.floor(((xp - levelBase(l)) / (levelBase(l + 1) - levelBase(l))) * 100);
  };

  // roteiro: a party construindo o próprio Agent Quest
  const QUESTS = [
    { title: 'Painel da Party', slug: 'painel-party' },
    { title: 'Log de Batalha', slug: 'log-batalha' },
    { title: 'Sistema de Conquistas', slug: 'conquistas' },
  ];
  const SCRIPT = [
    { k: 'quest_start' },
    { k: 'delegate', a: 'orq', to: 'arq', d: 'desenhar a arquitetura do {title}' },
    { k: 'read', a: 'arq', f: 'README.md' },
    { k: 'read', a: 'arq', f: '.claude/settings.json' },
    { k: 'write', a: 'arq', f: 'docs/adr/{n}-{slug}.md', r: 3 },
    { k: 'write', a: 'arq', f: 'docs/arquitetura/{slug}.md', r: 2 },
    { k: 'permission', a: 'arq', d: 'aprovar o design do {title}' },
    { k: 'approve', a: 'arq' },
    { k: 'done', a: 'arq' },
    { k: 'phase_done', p: 0 },
    { k: 'delegate', a: 'orq', to: 'dev', d: 'implementar o {title}' },
    { k: 'read', a: 'dev', f: 'docs/adr/{n}-{slug}.md' },
    { k: 'write', a: 'dev', f: 'server/{slug}.ts', r: 2 },
    { k: 'write', a: 'dev', f: 'web/{slug}.tsx', r: 2 },
    { k: 'permission', a: 'dev', d: 'rodar npm install ws' },
    { k: 'approve', a: 'dev' },
    { k: 'bash', a: 'dev', d: 'npm install ws' },
    { k: 'error', a: 'dev', d: "tsc: Property 'agentId' does not exist" },
    { k: 'edit', a: 'dev', f: 'server/{slug}.ts' },
    { k: 'done', a: 'dev' },
    { k: 'phase_done', p: 1 },
    { k: 'delegate', a: 'orq', to: 'tes', d: 'testar o {title}' },
    { k: 'read', a: 'tes', f: 'server/{slug}.ts' },
    { k: 'write', a: 'tes', f: 'tests/{slug}.test.ts', r: 2 },
    { k: 'test_run', a: 'tes', d: 'npm test' },
    { k: 'test_fail', a: 'tes', bugs: ['NullPointer', 'Off-by-one', 'Race Condition'] },
    { k: 'achievement', id: 'first_catch' },
    { k: 'done', a: 'tes' },
    { k: 'delegate', a: 'orq', to: 'dev', d: 'corrigir os 3 bugs' },
    { k: 'edit', a: 'dev', f: 'server/{slug}.ts' },
    { k: 'edit', a: 'dev', f: 'web/{slug}.tsx' },
    { k: 'done', a: 'dev' },
    { k: 'delegate', a: 'orq', to: 'tes', d: 'rodar os testes de novo' },
    { k: 'test_run', a: 'tes', d: 'npm test' },
    { k: 'test_fail', a: 'tes', bugs: ['Off-by-one'] },
    { k: 'done', a: 'tes' },
    { k: 'delegate', a: 'orq', to: 'dev', d: 'corrigir o Off-by-one' },
    { k: 'edit', a: 'dev', f: 'server/{slug}.ts' },
    { k: 'done', a: 'dev' },
    { k: 'delegate', a: 'orq', to: 'tes', d: 'validar a correção' },
    { k: 'test_run', a: 'tes', d: 'npm test' },
    { k: 'test_pass', a: 'tes', n: 14 },
    { k: 'done', a: 'tes' },
    { k: 'phase_done', p: 2 },
    { k: 'delegate', a: 'orq', to: 'doc', d: 'documentar o {title}' },
    { k: 'read', a: 'doc', f: 'docs/adr/{n}-{slug}.md' },
    { k: 'read', a: 'doc', f: 'server/{slug}.ts' },
    { k: 'write', a: 'doc', f: 'docs/{slug}.md', r: 1 },
    { k: 'edit', a: 'doc', f: 'README.md' },
    { k: 'done', a: 'doc' },
    { k: 'phase_done', p: 3 },
    { k: 'quest_done' },
    { k: 'achievement', id: 'full_party' },
  ];

  // exemplos para a legenda: como cada evento real aparece no tema
  const MAP_ROWS = [
    ['Orquestrador delega a um subagente', { k: 'delegate', a: 'orq', to: 'dev', d: 'implementar o Painel da Party' }],
    ['Read / Grep / Glob', { k: 'read', a: 'arq', f: 'README.md' }],
    ['Write (arquivo novo)', { k: 'write', a: 'dev', f: 'server/painel-party.ts', r: 2 }],
    ['Edit', { k: 'edit', a: 'dev', f: 'web/painel-party.tsx' }],
    ['Bash', { k: 'bash', a: 'dev', d: 'npm install ws' }],
    ['Testes rodando', { k: 'test_run', a: 'tes', d: 'npm test' }],
    ['Testes falhando', { k: 'test_fail', a: 'tes', bugs: ['NullPointer', 'Off-by-one'] }],
    ['Testes passando', { k: 'test_pass', a: 'tes', n: 14 }],
    ['Regressão: teste que passava volta a falhar', { k: 'regression', a: 'tes', bugs: ['NullPointer'] }],
    ['Erro de ferramenta', { k: 'error', a: 'dev', d: 'exit code 1' }],
    ['Pedido de permissão', { k: 'permission', a: 'dev', d: 'rodar npm install ws' }],
    ['Subagente terminou', { k: 'done', a: 'doc' }],
    ['Contexto compactado', { k: 'compact', a: 'orq' }],
  ];

  // ritmo (ms em 1×), relógio simulado (s) e custo simulado (US$) por tipo de evento
  const DELAY = { quest_start: 1300, delegate: 1300, read: 900, write: 1400, edit: 1200, bash: 1300, permission: 2600, approve: 900, error: 1500, test_run: 1700, test_fail: 1600, test_pass: 1600, done: 900, phase_done: 1200, quest_done: 4200, achievement: 1500, compact: 1500 };
  const SECS = { quest_start: 1, delegate: 3, read: 4, write: 11, edit: 7, bash: 9, permission: 16, approve: 1, error: 2, test_run: 14, test_fail: 1, test_pass: 1, done: 2, phase_done: 1, quest_done: 1, compact: 6 };
  const COST = { quest_start: .002, delegate: .006, read: .004, write: .012, edit: .008, bash: .003, error: .002, test_run: .004, done: .002, compact: .01 };
  const START = { orq: [1100, 70], arq: [700, 100], dev: [1650, 100], tes: [420, 100], doc: [150, 100] };
  const LOG_CLASS = { error: 'bad', test_fail: 'bad', test_pass: 'good', phase_done: 'good', quest_done: 'good', permission: 'warn', achievement: 'gold', levelup: 'gold' };
  const clamp = v => Math.max(0, Math.min(100, Math.round(v)));

  function createSim() {
    const agents = {};
    for (const id of ORDER) agents[id] = { status: 'idle', last: null, hp: 100, mana: START[id][1], xp: START[id][0] };
    const clock = 14 * 3600 + 2 * 60 + 10;
    const S = {
      agents, clock, questStart: clock, quest: 0,
      phases: ['pending', 'pending', 'pending', 'pending'],
      bugs: [], defeated: 0, saves: 0, quests: 0, score: 0, cost: 0,
      unlocked: new Set(), compactQueued: false, fx: [],
    };
    let cursor = 0;
    const queue = [];

    function resolve(step) {
      const q = QUESTS[S.quest % QUESTS.length];
      const n = String(S.quest + 1).padStart(4, '0');
      const sub = s => (s == null ? s : s.replace(/\{slug\}/g, q.slug).replace(/\{title\}/g, q.title).replace(/\{n\}/g, n));
      return { ...step, f: sub(step.f), d: sub(step.d), title: q.title, bugs: step.bugs && [...step.bugs] };
    }
    function nextEvent() {
      if (queue.length) return queue.shift();
      if (cursor >= SCRIPT.length) { cursor = 0; S.quest += 1; }
      return resolve(SCRIPT[cursor++]);
    }
    function gain(id, n, out) {
      const a = S.agents[id];
      const before = levelOf(a.xp);
      a.xp += n;
      S.fx.push({ a: id, n });
      const after = levelOf(a.xp);
      if (after > before) out.push({ k: 'levelup', a: id, lvl: after, time: S.clock });
    }

    // aplica um evento ao estado; devolve os eventos derivados (subidas de nível)
    function apply(e) {
      const A = S.agents, out = [];
      const ag = e.a ? A[e.a] : null;
      S.clock += SECS[e.k] || 0;
      S.cost += COST[e.k] || 0;
      e.time = S.clock;
      switch (e.k) {
        case 'quest_start':
          S.phases = ['pending', 'pending', 'pending', 'pending'];
          S.score = 0; S.bugs = []; S.questStart = S.clock;
          A.orq.status = 'working'; A.orq.last = e;
          break;
        case 'delegate': {
          const target = A[e.to];
          A.orq.status = 'working'; A.orq.last = e; A.orq.mana -= 6;
          target.status = 'working'; target.mana = 100; target.last = { k: 'start', d: e.d };
          const p = PHASE_OWNER.indexOf(e.to);
          if (p >= 0 && S.phases[p] === 'pending') S.phases[p] = 'active';
          gain('orq', 5, out);
          break;
        }
        case 'read': ag.mana -= 5; ag.last = e; gain(e.a, 5, out); break;
        case 'write': ag.mana -= 8; ag.last = e; gain(e.a, 20, out); break;
        case 'edit': ag.mana -= 6; ag.last = e; gain(e.a, 12, out); break;
        case 'bash': ag.mana -= 4; ag.last = e; gain(e.a, 6, out); break;
        case 'permission': ag.status = 'waiting'; ag.last = e; break;
        case 'approve': ag.status = 'working'; ag.last = e; break;
        case 'error': ag.hp -= 30; ag.last = e; break;
        case 'test_run': ag.mana -= 5; ag.last = e; gain(e.a, 5, out); break;
        case 'test_fail': {
          const fresh = e.bugs.filter(b => !S.bugs.includes(b));
          const gone = S.bugs.filter(b => !e.bugs.includes(b));
          S.saves += fresh.length; S.defeated += gone.length; S.bugs = [...e.bugs];
          A.dev.hp -= 8 * fresh.length; ag.mana -= 3; ag.last = e;
          gain(e.a, 5 + 15 * fresh.length, out);
          break;
        }
        case 'test_pass':
          S.defeated += S.bugs.length; S.bugs = [];
          A.dev.hp += 40; ag.hp += 10; ag.last = e;
          gain(e.a, 40, out); gain('dev', 30, out);
          break;
        case 'done': ag.status = 'idle'; ag.last = null; gain(e.a, 10, out); break;
        case 'phase_done':
          S.phases[e.p] = 'done'; S.score += 1; e.score = S.score; A.orq.mana -= 2;
          gain(PHASE_OWNER[e.p], 15, out);
          break;
        case 'quest_done':
          S.quests += 1; e.score = S.score;
          A.orq.status = 'idle'; A.orq.last = null;
          for (const id of ORDER) { A[id].hp = 100; gain(id, 100, out); }
          break;
        case 'achievement': S.unlocked.add(e.id); break;
        case 'compact': A.orq.mana = 72; A.orq.status = 'working'; A.orq.last = e; S.compactQueued = false; break;
      }
      for (const id of ORDER) { A[id].hp = clamp(A[id].hp); A[id].mana = clamp(A[id].mana); }
      if (A.orq.mana < 30 && !S.compactQueued) { S.compactQueued = true; queue.push({ k: 'compact', a: 'orq' }); }
      return out;
    }

    // avança um evento; conquistas já desbloqueadas são puladas
    function step() {
      S.fx = [];
      let e = nextEvent();
      while (e.k === 'achievement' && S.unlocked.has(e.id)) e = nextEvent();
      return { e, derived: apply(e) };
    }

    return { state: S, step };
  }

  return { ORDER, REAL_ROLE, PHASE_OWNER, PHASE_REAL, QUESTS, MAP_ROWS, DELAY, LOG_CLASS, levelOf, levelPct, createSim };
})();
