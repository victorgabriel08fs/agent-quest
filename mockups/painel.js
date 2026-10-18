// Interface: monta a tela do tema atual, desenha o estado da party e anima cada evento.
(() => {
  'use strict';

  const { esc, F, B, joinPt, pl, THEMES } = AQ;
  const { ORDER, REAL_ROLE, PHASE_OWNER, PHASE_REAL, QUESTS, MAP_ROWS, DELAY, LOG_CLASS, levelOf, levelPct } = Motor;

  const ROOMS = ['hq', 'design', 'dev', 'idle', 'docs', 'test'];
  const ROOM_OF = { orq: 'hq', arq: 'design', dev: 'dev', tes: 'test', doc: 'docs' };
  const ROOM_AGENT = { hq: 'orq', design: 'arq', dev: 'dev', test: 'tes', docs: 'doc' };
  const SEAT = [0.5, 0.6];
  const IDLE_SEATS = { arq: [0.26, 0.37], dev: [0.74, 0.37], tes: [0.26, 0.75], doc: [0.74, 0.75] };
  const BUG_SPOTS = [[0.19, 0.42], [0.81, 0.42], [0.22, 0.84], [0.8, 0.84]];
  const ACH_ORDER = ['first_catch', 'full_party', 'one_shot', 'zero_regress', 'archivist', 'night_owl'];
  const MAX_LOG = 80;
  const STORE_KEY = 'agent-quest-theme';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const two = n => String(n).padStart(2, '0');
  const hhmmss = s => `${two(Math.floor(s / 3600) % 24)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
  const mmss = s => `${two(Math.floor(s / 60))}:${two(s % 60)}`;

  const $ = id => document.getElementById(id);
  const ui = {
    session: $('session'), toggle: $('theme-toggle'), roster: $('roster'), partyTitle: $('party-title'),
    partyCount: $('party-count'), miniLegend: $('mini-legend'), qKicker: $('q-kicker'), qTitle: $('q-title'),
    qMeta: $('q-meta'), stepper: $('stepper'), scene: $('scene'), roomsEl: $('rooms'), bugs: $('bugs'),
    tokensEl: $('tokens'), fx: $('fx'), badges: $('badges'), achCount: $('ach-count'), feedTitle: $('feed-title'),
    filters: $('filters'), entries: $('entries'), toasts: $('toasts'), legend: $('legend'),
    legendTitle: $('legend-title'), legendBody: $('legend-body'), pause: $('btn-pause'),
  };
  const speedBtns = [...document.querySelectorAll('[data-speed]')];

  let themeId = 'escritorio';
  let sim, state, logItems = [], timer = null, speed = 1, paused = false, filter = null;
  const bugSpot = new Map();
  const theme = () => THEMES[themeId];

  /* ---------- texto ---------- */
  const helperCache = new Map();
  function helpers(t) {
    if (!helperCache.has(t)) {
      helperCache.set(t, {
        R: id => `<b>${esc(t.roles[id][0])}</b>`,
        s: id => t.roles[id][2],
        bugs: list => esc(joinPt(list.map(t.bugName))),
        phase: p => t.phases[p],
        ach: id => t.ach[id][0],
        lvl: l => t.lvl(l),
        rar: r => (t.rarity && r ? ` <span class="rar r${r}">${esc(t.rarity[r])}</span>` : ''),
      });
    }
    return helperCache.get(t);
  }
  function logLine(t, e) {
    const h = helpers(t);
    if (e.k === 'write' || e.k === 'edit') {
      return `${h.R(e.a)} ${t.verbs[e.k][e.a][0]} ${F(e.f)}${e.k === 'write' ? h.rar(e.r) : ''}`;
    }
    const fn = t.log[e.k];
    return fn ? fn(e, h) : '';
  }
  function actionText(t, id) {
    const a = state.agents[id];
    if (a.status === 'idle') return t.idle;
    if (a.status === 'waiting') return t.waiting;
    const e = a.last;
    if (!e) return t.act.start();
    if (e.k === 'write' || e.k === 'edit') return `${t.verbs[e.k][e.a][1]} ${e.f}`;
    const fn = t.act[e.k];
    return fn ? fn(e, helpers(t)) : '';
  }
  const agentsOf = e => (e.k === 'delegate' ? ['orq', e.to] : e.k === 'phase_done' ? [PHASE_OWNER[e.p]] : e.a ? [e.a] : []);

  /* ---------- montagem da tela para o tema atual ---------- */
  function memberHTML(t, id) {
    const [name, icon] = t.roles[id];
    return `<li><button type="button" class="member idle" data-agent="${id}" aria-pressed="${filter === id}">
      <span class="avatar"><span aria-hidden="true">${icon}</span><i class="status-dot"></i></span>
      <span class="m-body">
        <span class="m-name">${esc(name)}</span>
        <span class="m-sub"><span class="m-role">${REAL_ROLE[id]}</span><span class="m-lvl"></span></span>
        <span class="m-action"></span>
        <span class="m-bars">
          <span class="mb hp-w"><span class="mb-l">${esc(t.bars[0])}</span><span class="mbar hp"><i></i></span></span>
          <span class="mb mana-w"><span class="mb-l">${esc(t.bars[1])}</span><span class="mbar mana"><i></i></span></span>
        </span>
      </span>
    </button></li>`;
  }
  function roomHTML(t, room) {
    const [name, icon, deco] = t.rooms[room];
    const ag = ROOM_AGENT[room];
    return `<div class="room" data-room="${room}"${ag ? ` data-agent="${ag}"` : ''}>
      <div class="room-label"><span class="ri" aria-hidden="true">${icon}</span>${esc(name)}</div>
      <span class="deco d1" aria-hidden="true">${deco[0]}</span><span class="deco d2" aria-hidden="true">${deco[1]}</span>
    </div>`;
  }
  function tokenHTML(t, id) {
    return `<div class="token idle no-anim" data-agent="${id}">
      <div class="bubble"><span class="bubble-text"></span></div>
      <div class="tok-av" aria-hidden="true">${t.roles[id][1]}<i class="tok-alert">!</i></div>
      <div class="tok-name">${esc(t.roles[id][2])}</div>
    </div>`;
  }
  function badgeHTML(t, id) {
    const [name, desc, icon] = t.ach[id];
    return `<div class="badge${state.unlocked.has(id) ? '' : ' locked'}" data-ach="${id}" title="${esc(desc)}">
      <span class="b-ic" aria-hidden="true">${icon}</span><span class="b-name">${esc(name)}</span><span class="b-desc">${esc(desc)}</span>
    </div>`;
  }
  function filtersHTML(t) {
    return `<button type="button" class="chip" data-filter="" aria-pressed="${!filter}">Todos</button>` +
      ORDER.map(id => `<button type="button" class="chip chip-ag" data-filter="${id}" data-agent="${id}" aria-pressed="${filter === id}" title="${esc(t.roles[id][0])}" aria-label="Só ${esc(t.roles[id][0])}">${t.roles[id][1]}</button>`).join('');
  }
  function legendHTML(t) {
    const places = ['hq', 'design', 'dev', 'test', 'docs'].map(room => {
      const id = ROOM_AGENT[room];
      return `<tr><th>${t.rooms[room][1]} ${esc(t.rooms[room][0])}</th><td>Onde trabalha o ${B(t.roles[id][0])} (${REAL_ROLE[id]})</td></tr>`;
    }).join('') + `<tr><th>${t.rooms.idle[1]} ${esc(t.rooms.idle[0])}</th><td>Onde ficam os agentes sem tarefa. Quando recebem uma, caminham até o seu posto</td></tr>`;
    const events = MAP_ROWS.map(([label, e]) => `<tr><th>${esc(label)}</th><td>${logLine(t, e)}</td></tr>`).join('');
    return `<p>O que aparece na tela é uma tradução do que os agentes estão fazendo de verdade no Claude Code.</p>
      <h3>Barras</h3><table class="lg-table">
        <tr><th>${esc(t.bars[0])}</th><td>Saúde da tarefa: cai com erros e bugs, sobe quando os testes passam</td></tr>
        <tr><th>${esc(t.bars[1])}</th><td>Contexto que ainda cabe na janela do agente. Enche de novo a cada tarefa nova</td></tr>
        <tr><th>Anel do retrato</th><td>${esc(t.levelHelp)}</td></tr></table>
      <h3>Lugares</h3><table class="lg-table">${places}</table>
      <h3>Eventos</h3><table class="lg-table">${events}</table>`;
  }

  function build() {
    const t = theme();
    document.title = `Agent Quest · ${t.name}`;
    ui.partyTitle.textContent = t.partyTitle;
    ui.feedTitle.textContent = t.feedTitle;
    ui.roster.innerHTML = ORDER.map(id => memberHTML(t, id)).join('');
    ui.members = Object.fromEntries(ORDER.map(id => [id, ui.roster.querySelector(`.member[data-agent="${id}"]`)]));
    ui.miniLegend.innerHTML = `
      <span><i class="sw hp"></i>${esc(t.bars[0])}: saúde da tarefa</span>
      <span><i class="sw mana"></i>${esc(t.bars[1])}: contexto restante do agente</span>
      <span><i class="sw ring"></i>Anel do retrato: XP até o próximo nível</span>`;
    ui.stepper.innerHTML = t.phases.map((p, i) =>
      `<li class="step" data-agent="${PHASE_OWNER[i]}" title="Etapa de ${PHASE_REAL[i]}"><span class="sd">${i + 1}</span><span class="sl">${esc(p)}</span></li>`).join('');
    ui.steps = [...ui.stepper.children];
    ui.roomsEl.innerHTML = ROOMS.map(r => roomHTML(t, r)).join('');
    ui.rooms = Object.fromEntries(ROOMS.map(r => [r, ui.roomsEl.querySelector(`[data-room="${r}"]`)]));
    ui.tokensEl.innerHTML = ORDER.map(id => tokenHTML(t, id)).join('');
    ui.tokens = Object.fromEntries(ORDER.map(id => [id, ui.tokensEl.querySelector(`.token[data-agent="${id}"]`)]));
    ui.bugs.textContent = '';
    ui.fx.textContent = '';
    ui.toasts.textContent = '';
    ui.scene.querySelectorAll('.finale').forEach(n => n.remove());
    ui.badges.innerHTML = ACH_ORDER.map(id => badgeHTML(t, id)).join('');
    ui.filters.innerHTML = filtersHTML(t);
    ui.legendTitle.textContent = `Como ler o painel · ${t.name}`;
    ui.legendBody.innerHTML = legendHTML(t);
    for (const b of ui.toggle.children) b.setAttribute('aria-pressed', String(b.dataset.theme === themeId));
    render(true);
    rebuildFeed();
  }

  /* ---------- desenho do estado ---------- */
  function setStatus(el, status) {
    el.classList.remove('idle', 'working', 'waiting');
    el.classList.add(status);
  }
  function render(still) {
    const t = theme(), S = state;
    const waiting = ORDER.filter(id => S.agents[id].status === 'waiting').length;
    ui.session.innerHTML = t.stats(S).map(([icon, value, label, title]) =>
      `<span class="stat"${title ? ` title="${esc(title)}"` : ''}><span aria-hidden="true">${icon}</span><b>${esc(value)}</b><span class="l">${esc(label)}</span></span>`).join('') +
      (waiting ? `<span class="stat pending"><span aria-hidden="true">${t.pendingIcon}</span><b>${waiting}</b><span class="l">${esc(t.pendingLabel(waiting))}</span></span>` : '');
    ui.qKicker.textContent = `${t.questWord} #${S.quest + 1}`;
    ui.qTitle.textContent = QUESTS[S.quest % QUESTS.length].title;
    const doneN = S.phases.filter(p => p === 'done').length;
    ui.qMeta.textContent = `${doneN} de 4 etapas · ⏱ ${mmss(S.clock - S.questStart)}`;
    ui.steps.forEach((el, i) => {
      el.classList.toggle('active', S.phases[i] === 'active');
      el.classList.toggle('done', S.phases[i] === 'done');
      el.querySelector('.sd').textContent = S.phases[i] === 'done' ? '✓' : String(i + 1);
    });
    let active = 0;
    for (const id of ORDER) {
      const a = S.agents[id];
      if (a.status !== 'idle') active += 1;
      const text = actionText(t, id);
      const row = ui.members[id];
      setStatus(row, a.status);
      row.querySelector('.avatar').style.setProperty('--xp', levelPct(a.xp));
      row.querySelector('.m-lvl').textContent = t.lvl(levelOf(a.xp));
      row.querySelector('.m-action').textContent = text;
      row.querySelector('.mbar.hp i').style.width = `${a.hp}%`;
      row.querySelector('.mbar.mana i').style.width = `${a.mana}%`;
      row.querySelector('.hp-w').title = `${t.bars[0]}: ${a.hp}/100`;
      row.querySelector('.mana-w').title = `${t.bars[1]}: ${a.mana}/100`;
      const tok = ui.tokens[id];
      setStatus(tok, a.status);
      // ao ficar ocioso o balão some com o último texto, sem trocar para "na copa" no caminho
      if (a.status !== 'idle') tok.querySelector('.bubble-text').textContent = text;
    }
    ui.partyCount.textContent = `${active}/5 ${pl(active, 'ativo', 'ativos')}`;
    for (const room of ROOMS) {
      const id = ROOM_AGENT[room];
      ui.rooms[room].classList.toggle('active', !!id && S.agents[id].status !== 'idle');
    }
    ui.rooms.test.classList.toggle('alarm', S.bugs.length > 0);
    for (const el of ui.badges.children) el.classList.toggle('locked', !S.unlocked.has(el.dataset.ach));
    ui.achCount.textContent = `${S.unlocked.size} de ${ACH_ORDER.length}`;
    placeTokens(!still);
    renderBugs(still);
  }

  // posições na cena: cada agente tem um posto; sem tarefa, vai para a copa/taverna
  function roomBox(room) {
    const el = ui.rooms[room];
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  }
  function seatOf(id) {
    if (id !== 'orq' && state.agents[id].status === 'idle') return ['idle', ...IDLE_SEATS[id]];
    return [ROOM_OF[id], ...SEAT];
  }
  function seatXY(id) {
    const [room, fx, fy] = seatOf(id);
    const b = roomBox(room);
    return [b.x + b.w * fx, b.y + b.h * fy, room];
  }
  function placeTokens(animate) {
    for (const id of ORDER) {
      const tok = ui.tokens[id];
      const [x, y, room] = seatXY(id);
      const av = tok.querySelector('.tok-av');
      const nx = String(Math.round(x - tok.offsetWidth / 2));
      const ny = String(Math.round(y - av.offsetHeight / 2));
      const moved = tok.dataset.x !== nx || tok.dataset.y !== ny;
      if (!animate) tok.classList.add('no-anim');
      tok.style.setProperty('--x', `${nx}px`);
      tok.style.setProperty('--y', `${ny}px`);
      tok.style.setProperty('--s', room === 'idle' ? '0.84' : '1');
      if (animate && moved) {
        tok.classList.add('walking');
        clearTimeout(tok.walkTimer);
        tok.walkTimer = setTimeout(() => tok.classList.remove('walking'), 900 / speed);
      }
      tok.dataset.x = nx;
      tok.dataset.y = ny;
      if (!animate) { void tok.offsetWidth; tok.classList.remove('no-anim'); }
    }
  }
  function renderBugs(still) {
    const t = theme();
    const shown = new Map([...ui.bugs.querySelectorAll('.bug:not(.defeat)')].map(n => [n.dataset.bug, n]));
    for (const [name, node] of shown) {
      if (state.bugs.includes(name)) continue;
      bugSpot.delete(name);
      if (still || reduceMotion) node.remove();
      else { node.classList.add('defeat'); setTimeout(() => node.remove(), 600); }
    }
    for (const name of state.bugs) {
      if (shown.has(name)) continue;
      if (!bugSpot.has(name)) {
        const used = new Set(bugSpot.values());
        let i = 0;
        while (used.has(i)) i += 1;
        bugSpot.set(name, i % BUG_SPOTS.length);
      }
      const node = document.createElement('div');
      node.className = still ? 'bug static' : 'bug';
      node.dataset.bug = name;
      node.title = t.bugName(name);
      node.innerHTML = `<span><span>${t.bugIcon}</span></span>`;
      ui.bugs.appendChild(node);
    }
    placeBugs();
  }
  function placeBugs() {
    const b = roomBox('test');
    for (const node of ui.bugs.querySelectorAll('.bug:not(.defeat)')) {
      const [fx, fy] = BUG_SPOTS[bugSpot.get(node.dataset.bug) ?? 0];
      node.style.transform = `translate(${Math.round(b.x + b.w * fx - 14)}px, ${Math.round(b.y + b.h * fy - 14)}px)`;
    }
  }

  /* ---------- atividade ---------- */
  function entryNode(e, still) {
    const t = theme();
    const li = document.createElement('li');
    const who = e.k === 'delegate' ? 'orq' : e.a;
    const agents = agentsOf(e);
    li.className = `entry ${LOG_CLASS[e.k] || ''}${still ? ' static' : ''}`;
    li.dataset.agents = agents.join(' ');
    const av = who
      ? `<span class="e-av" data-agent="${who}" aria-hidden="true">${t.roles[who][1]}</span>`
      : `<span class="e-av sys" aria-hidden="true">${t.sysIcon[e.k] || '•'}</span>`;
    li.innerHTML = `${av}<div class="e-body"><div class="e-text">${logLine(t, e)}</div><time>${hhmmss(e.time)}</time></div>`;
    li.hidden = !!filter && !agents.includes(filter);
    return li;
  }
  function addLog(e) {
    logItems.push(e);
    if (logItems.length > MAX_LOG) logItems.shift();
    ui.entries.prepend(entryNode(e, false));
    while (ui.entries.children.length > MAX_LOG) ui.entries.lastChild.remove();
  }
  function rebuildFeed() {
    ui.entries.textContent = '';
    for (let i = logItems.length - 1; i >= 0; i--) ui.entries.appendChild(entryNode(logItems[i], true));
  }
  function setFilter(id) {
    filter = id || null;
    for (const li of ui.entries.children) li.hidden = !!filter && !li.dataset.agents.split(' ').includes(filter);
    for (const c of ui.filters.children) c.setAttribute('aria-pressed', String((c.dataset.filter || null) === filter));
    for (const m of Object.values(ui.members)) m.setAttribute('aria-pressed', String(m.dataset.agent === filter));
  }

  /* ---------- efeitos ---------- */
  function retrigger(el, cls, ms) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
  function floatText(id, text, cls) {
    if (reduceMotion) return;
    const [x, y] = seatXY(id);
    const el = document.createElement('div');
    el.className = `float ${cls}`;
    el.dataset.agent = id;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y - 40}px`;
    ui.fx.appendChild(el);
    el.animate([
      { transform: 'translate(-50%, 6px)', opacity: 0 },
      { transform: 'translate(-50%, -4px)', opacity: 1, offset: 0.2 },
      { transform: 'translate(-50%, -34px)', opacity: 0 },
    ], { duration: Math.max(800, 1400 / speed), easing: 'ease-out' }).onfinish = () => el.remove();
  }
  function fly(to) {
    if (reduceMotion) return;
    const [x0, y0] = seatXY('orq');
    const [x1, y1] = seatXY(to);
    const el = document.createElement('div');
    el.className = 'flyer';
    el.textContent = theme().msgIcon;
    el.style.left = `${x0 - 15}px`;
    el.style.top = `${y0 - 15}px`;
    ui.fx.appendChild(el);
    const dx = x1 - x0, dy = y1 - y0;
    el.animate([
      { transform: 'translate(0, 0) scale(.6)', opacity: 0 },
      { transform: `translate(${dx / 2}px, ${dy / 2 - 60}px) scale(1.2) rotate(-12deg)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(.8)`, opacity: 0.1 },
    ], { duration: Math.max(450, 850 / speed), easing: 'ease-in-out' }).onfinish = () => el.remove();
  }
  function toast([name, desc, icon]) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="t-ic" aria-hidden="true">${icon}</span><span class="t-body"><small>Conquista desbloqueada</small><b>${esc(name)}</b><span>${esc(desc)}</span></span>`;
    ui.toasts.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 380); }, Math.max(1800, 3600 / speed));
  }
  function burst(host) {
    const icons = theme().burst;
    for (let i = 0; i < 18; i++) {
      const p = document.createElement('span');
      p.className = 'particle';
      p.textContent = icons[i % icons.length];
      host.appendChild(p);
      const ang = (Math.PI * 2 * i) / 18 + Math.random() * 0.3;
      const dist = 90 + Math.random() * 100;
      p.animate([
        { transform: 'translate(0, 0) scale(.4)', opacity: 1 },
        { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist}px) scale(1) rotate(${Math.round(Math.random() * 120 - 60)}deg)`, opacity: 0 },
      ], { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'forwards' });
    }
  }
  function finale(f) {
    const el = document.createElement('div');
    el.className = 'finale';
    el.innerHTML = `<div class="finale-card"><div class="big" aria-hidden="true">${f.icon}</div><h3>${esc(f.title)}</h3><p>${esc(f.sub)}</p></div>`;
    ui.scene.appendChild(el);
    if (!reduceMotion) burst(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, Math.max(1500, 3300 / speed));
  }
  function effects(e, derived) {
    const t = theme();
    if (e.k === 'delegate') fly(e.to);
    if (e.k === 'error') { retrigger(ui.tokens[e.a], 'hit', 550); floatText(e.a, `−30 ${t.bars[0]}`, 'bad'); }
    if (e.k === 'compact') floatText('orq', t.compactFloat, 'good');
    if (e.k !== 'quest_done') {
      const count = {};
      for (const g of state.fx) {
        if (g.n < 10) continue;
        const k = (count[g.a] = (count[g.a] || 0) + 1);
        setTimeout(() => floatText(g.a, `+${g.n} XP`, 'xp'), (k - 1) * 260);
      }
    }
    for (const d of derived) {
      if (d.k !== 'levelup') continue;
      retrigger(ui.tokens[d.a], 'lvlup', 1300);
      retrigger(ui.members[d.a], 'lvlup', 1300);
      setTimeout(() => floatText(d.a, t.levelFloat(d.lvl), 'lvl'), 420);
    }
    if (e.k === 'achievement') {
      toast(t.ach[e.id]);
      retrigger(ui.badges.querySelector(`[data-ach="${e.id}"]`), 'just', 1000);
    }
    if (e.k === 'quest_done') finale(t.finale(e));
  }

  /* ---------- simulação e controles ---------- */
  function schedule(ms) {
    clearTimeout(timer);
    timer = paused ? null : setTimeout(tick, ms / speed);
  }
  function tick() {
    timer = null;
    const { e, derived } = sim.step();
    [e, ...derived].forEach(addLog);
    render(false);
    effects(e, derived);
    schedule(DELAY[e.k] || 1200);
  }
  function reset() {
    clearTimeout(timer);
    timer = null;
    sim = Motor.createSim();
    state = sim.state;
    logItems = [];
    bugSpot.clear();
    build();
    schedule(700);
  }
  function setTheme(id) {
    if (!THEMES[id]) return;
    themeId = id;
    document.documentElement.dataset.theme = id;
    try { history.replaceState(null, '', `#${id}`); } catch (_) { /* alguns navegadores bloqueiam em file:// */ }
    try { localStorage.setItem(STORE_KEY, id); } catch (_) { /* armazenamento indisponível */ }
    build();
  }
  function switchTheme(id) {
    if (id === themeId || !THEMES[id]) return;
    if (document.startViewTransition && !reduceMotion) document.startViewTransition(() => setTheme(id));
    else setTheme(id);
  }
  function togglePause() {
    paused = !paused;
    ui.pause.setAttribute('aria-pressed', String(paused));
    ui.pause.textContent = paused ? '▶' : '⏸';
    ui.pause.title = paused ? 'Continuar (espaço)' : 'Pausar (espaço)';
    if (paused) { clearTimeout(timer); timer = null; } else schedule(300);
  }

  ui.toggle.innerHTML = Object.entries(THEMES).map(([id, t], i) =>
    `<button type="button" data-theme="${id}" aria-pressed="false" title="${esc(t.name)} (${i + 1})"><span aria-hidden="true">${t.icon}</span>${esc(t.name)}</button>`).join('');
  ui.toggle.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-theme]');
    if (b) switchTheme(b.dataset.theme);
  });
  ui.roster.addEventListener('click', ev => {
    const m = ev.target.closest('.member');
    if (m) setFilter(filter === m.dataset.agent ? null : m.dataset.agent);
  });
  ui.filters.addEventListener('click', ev => {
    const c = ev.target.closest('.chip');
    if (c) setFilter(c.dataset.filter || null);
  });
  ui.pause.addEventListener('click', togglePause);
  $('btn-reset').addEventListener('click', reset);
  for (const b of speedBtns) {
    b.addEventListener('click', () => {
      speed = Number(b.dataset.speed);
      for (const o of speedBtns) o.setAttribute('aria-pressed', String(o === b));
      ui.scene.style.setProperty('--walk', `${Math.round(900 / speed)}ms`);
      if (!paused) schedule(300);
    });
  }
  $('btn-legend').addEventListener('click', () => ui.legend.showModal());
  $('legend-close').addEventListener('click', () => ui.legend.close());
  ui.legend.addEventListener('click', ev => { if (ev.target === ui.legend) ui.legend.close(); });
  document.addEventListener('keydown', ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ui.legend.open) return;
    if (ev.key === '1') switchTheme('escritorio');
    else if (ev.key === '2') switchTheme('guilda');
    else if (ev.key === 't' || ev.key === 'T') switchTheme(themeId === 'escritorio' ? 'guilda' : 'escritorio');
    else if (ev.key === '?') ui.legend.showModal();
    else if (ev.key === ' ' && ev.target === document.body) { ev.preventDefault(); togglePause(); }
  });
  new ResizeObserver(() => { if (state) { placeTokens(false); placeBugs(); } }).observe(ui.scene);

  /* ---------- início ---------- */
  let initial = location.hash.slice(1);
  if (!THEMES[initial]) {
    try { initial = localStorage.getItem(STORE_KEY); } catch (_) { initial = null; }
  }
  themeId = THEMES[initial] ? initial : 'escritorio';
  document.documentElement.dataset.theme = themeId;
  reset();
})();
