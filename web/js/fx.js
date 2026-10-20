// @ts-check
// Animações da cena (T12b), com a Web Animations API e a técnica FLIP decidida
// no plano (T12b, "Técnica de animação"):
// - antes de cada desenho da cena, guarda o retângulo do retrato de cada token
//   (chave do agente); depois do desenho, quem mudou de lugar anima de onde
//   estava até a vaga nova (o subagente encerrado caminha até a copa);
// - token que sai da cena vira um "fantasma" na camada .fx e vai até o "+N" da
//   sala para onde foi (ou some no lugar);
// - `agent.delegated`: o envelope (pergaminho na Guilda) voa de quem delegou
//   até o novo agente; se ele ainda não apareceu, voa para a sala do papel e
//   muda de rumo quando o token aparece;
// - `tool.failed` (não interrompido): impacto no retrato;
// - bugs: os novos aparecem com "spawn"; os que somem viram fantasmas com a
//   animação de derrota (mockup);
// - `quest.finished` com `done`: cartão final com o resumo do tema, sem XP.
//
// Regras do plano: nenhum estilo inline, nem no HTML nem por atributo (CSP);
// posições por classes e data-*, movimento só por element.animate() ou classes
// com @keyframes. Com prefers-reduced-motion, nenhuma chamada a animate(): os
// tokens aparecem direto na vaga final, e o cartão final aparece sem animação.
//
// A cena é redesenhada inteira a cada mudança (setHTML). Para um efeito curto
// não ser cortado pelo redesenho seguinte, ele fica registrado e é refeito no
// elemento novo com o mesmo tempo decorrido. As animações contínuas do CSS
// (respirar, alarme, bugs) são sincronizadas pelo relógio da página, para não
// recomeçarem a cada redesenho.
//
// O que decide os efeitos (`sceneChanges`, `delegationTarget`, `questSummary`,
// `flipDelta`) é puro e testado em test/unit/web/fx.test.js; o resto mexe no
// DOM e é conferido no E2E.

import { ROOM_OF_ROLE, sceneLayout } from './scene.js';

/** @typedef {import('../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../shared/contract.js').CanonicalEvent} CanonicalEvent */
/** @typedef {import('./themes/contract.js').Theme} Theme */
/** @typedef {import('./themes/contract.js').QuestSummary} QuestSummary */
/** @typedef {import('./themes/contract.js').RoomId} RoomId */

/** Durações, do mockup (mockups/painel.css e painel.js). */
export const WALK_MS = 900;
export const WALK_STEP_MS = 320;
export const ENVELOPE_MS = 850;
export const HIT_MS = 500;
export const SPAWN_MS = 350;
export const BUG_SPAWN_MS = 450;
export const DEFEAT_MS = 550;
export const FADE_MS = 300;
export const FINALE_MS = 3300;
export const FINALE_OUT_MS = 400;

/** Janela para ligar a delegação à instância (modelo de eventos, seção 5, 2a). */
export const DELEGATION_WINDOW_MS = 2000;

/** Nome (id) de cada animação, para os testes ponta a ponta. */
export const FX_IDS = Object.freeze({
  move: 'fx-move',
  walk: 'fx-walk',
  size: 'fx-size',
  spawn: 'fx-spawn',
  fade: 'fx-fade',
  envelope: 'fx-envelope',
  hit: 'fx-hit',
  bugSpawn: 'fx-bug-spawn',
  defeat: 'fx-defeat',
  burst: 'fx-burst',
});

/** @param {unknown} value */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// ---------------------------------------------------------------------------
// Decisão (pura)
// ---------------------------------------------------------------------------

/**
 * O que a cena lembra do desenho anterior.
 * @typedef {object} SceneMemory
 * @property {string} context    sessão e tema; outro contexto não anima
 * @property {number} seq        maior seq do feed já visto
 * @property {number} bugs       bugs em aberto
 */

/**
 * @typedef {object} Delegation
 * @property {number} seq
 * @property {number} ts
 * @property {string} fromKey
 * @property {string|null} toRole
 * @property {string} description
 */

/**
 * @typedef {object} SceneChanges
 * @property {SceneMemory} memory          para o próximo desenho
 * @property {boolean} animate             mesmo contexto do desenho anterior
 * @property {Delegation[]} delegations    delegações novas, em ordem
 * @property {string[]} hits               agentes com falha nova (não interrompida), em ordem
 * @property {{ from: number, to: number }} bugs
 * @property {QuestSummary|null} finale    ticket entregue agora
 */

/**
 * Efeitos entre dois desenhos da cena. O primeiro desenho de uma sessão (ou
 * depois de trocar de sessão ou de tema) não anima: só guarda a memória.
 * Eventos novos são os do feed com `seq` acima do maior já visto.
 * @param {SceneMemory|null} previous
 * @param {SessionState|null} session
 * @param {string} context
 * @returns {SceneChanges}
 */
export function sceneChanges(previous, session, context) {
  const feed = (session?.feed ?? []).filter((event) => event && typeof event === 'object');
  const bugs = openBugCount(session);
  const same = previous !== null && previous.context === context;
  const maxSeq = feed.reduce((max, event) => Math.max(max, num(event.seq)), 0);
  const memory = { context, seq: same ? Math.max(previous.seq, maxSeq) : maxSeq, bugs };
  /** @type {SceneChanges} */
  const changes = { memory, animate: same, delegations: [], hits: [], bugs: { from: same ? previous.bugs : bugs, to: bugs }, finale: null };
  if (!same || !session) return changes;

  const fresh = feed.filter((event) => num(event.seq) > previous.seq).sort((a, b) => num(a.seq) - num(b.seq));
  for (const event of fresh) {
    const d = /** @type {Record<string, any>} */ (event.data ?? {});
    const key = typeof event.agentKey === 'string' && event.agentKey !== '' ? event.agentKey : null;
    if (event.kind === 'agent.delegated' && key) {
      changes.delegations.push({
        seq: num(event.seq),
        ts: num(event.ts),
        fromKey: key,
        toRole: typeof d.toRole === 'string' ? d.toRole : null,
        description: typeof d.description === 'string' ? d.description : '',
      });
    } else if (event.kind === 'tool.failed' && key && !d.interrupted) {
      changes.hits.push(key);
    } else if (event.kind === 'quest.finished' && d.outcome === 'done') {
      changes.finale = questSummary(session, event);
    }
  }
  return changes;
}

/**
 * @param {SessionState|null} session
 * @returns {number}
 */
function openBugCount(session) {
  const open = session?.bugs?.open;
  return typeof open === 'number' && Number.isFinite(open) && open > 0 ? Math.floor(open) : 0;
}

/**
 * Instância criada por uma delegação: filha de quem delegou, criada na janela
 * da seção 5 (2a), com o rótulo igual à descrição (senão, com o papel chamado).
 * Ignora as já usadas por outro envelope. Devolve a chave ou null.
 * @param {SessionState|null} session
 * @param {Delegation} delegation
 * @param {ReadonlySet<string>} [claimed]
 * @returns {string|null}
 */
export function delegationTarget(session, delegation, claimed = new Set()) {
  const candidates = (session?.agents ?? []).filter((agent) =>
    agent.key !== 'main' &&
    !claimed.has(agent.key) &&
    agent.parentKey === delegation.fromKey &&
    num(agent.startedAt) >= delegation.ts - DELEGATION_WINDOW_MS)
    .sort((a, b) => num(a.startedAt) - num(b.startedAt));
  const byLabel = delegation.description ? candidates.find((agent) => agent.label === delegation.description) : undefined;
  const byRole = delegation.toRole ? candidates.find((agent) => agent.role === delegation.toRole) : undefined;
  return (byLabel ?? byRole)?.key ?? null;
}

/**
 * Resumo do ticket entregue para o cartão final (`theme.finale`): número,
 * título, ações, agentes que trabalharam no ticket (o principal e os que
 * tiveram evento depois do início dele) e duração.
 * @param {SessionState} session
 * @param {CanonicalEvent} event   quest.finished
 * @returns {QuestSummary}
 */
export function questSummary(session, event) {
  const d = /** @type {Record<string, any>} */ (event.data ?? {});
  const quest = session.quest && session.quest.id === d.questId ? session.quest : null;
  const start = quest ? num(quest.startedAt) : null;
  const agents = (session.agents ?? []).filter((agent) => agent.key === 'main' || start === null || num(agent.lastEventAt) >= start).length;
  return {
    n: num(d.n ?? quest?.n),
    title: quest?.title ?? '',
    actions: num(d.actions ?? quest?.actions),
    agents,
    durationMs: num(d.durationMs ?? (quest && quest.endedAt !== null ? num(quest.endedAt) - num(quest.startedAt) : 0)),
  };
}

/**
 * @typedef {{ left: number, top: number, width: number, height: number }} Box
 */

/**
 * Deslocamento FLIP de um retrato: do centro antigo para o novo, e a escala do
 * tamanho antigo. Null se não mudou (menos de 1 px e 2% de tamanho).
 * @param {Box} before
 * @param {Box} after
 * @returns {{ dx: number, dy: number, scale: number }|null}
 */
export function flipDelta(before, after) {
  const dx = (before.left + before.width / 2) - (after.left + after.width / 2);
  const dy = (before.top + before.height / 2) - (after.top + after.height / 2);
  const scale = after.width > 0 ? before.width / after.width : 1;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.02) return null;
  return { dx, dy, scale };
}

// ---------------------------------------------------------------------------
// Efeitos no DOM (navegador)
// ---------------------------------------------------------------------------

/** Quadros de cada efeito (mockup). */
const KEYFRAMES = Object.freeze({
  walk: [
    { transform: 'translateY(0) rotate(-5deg)' },
    { transform: 'translateY(-4px) rotate(5deg)' },
    { transform: 'translateY(0) rotate(-5deg)' },
  ],
  hit: [
    { translate: '0 0' },
    { translate: '-5px 0', offset: 0.2 },
    { translate: '5px 0', offset: 0.4 },
    { translate: '-3px 0', offset: 0.6 },
    { translate: '3px 0', offset: 0.8 },
    { translate: '0 0' },
  ],
  spawn: [{ opacity: 0, scale: '0.6' }, { opacity: 1, scale: '1' }],
  bugSpawn: [{ opacity: 0, scale: '0', rotate: '-30deg' }, { opacity: 1, scale: '1', rotate: '0deg' }],
});

/**
 * Efeito registrado, refeito no elemento novo depois de cada redesenho.
 * @typedef {object} Effect
 * @property {string} target          'avatar:<chave>', 'token:<chave>' ou 'bug:<n>'
 * @property {Keyframe[]} keyframes
 * @property {KeyframeAnimationOptions & { duration: number, id: string }} options
 * @property {number} start           relógio da página (ms)
 * @property {Animation|null} animation
 * @property {Element|null} element
 */

/**
 * Envelope no ar.
 * @typedef {object} Flight
 * @property {HTMLElement} element
 * @property {Animation} animation
 * @property {Delegation} delegation
 * @property {number} start
 * @property {boolean} landed          já vai para o token (não muda mais de rumo)
 */

/**
 * @typedef {object} SceneSnapshot
 * @property {Map<string, { token: Element, avatar: DOMRect, role: string, icon: string }>} tokens
 * @property {Map<number, DOMRect>} bugs
 */

/**
 * @typedef {object} SceneFxOptions
 * @property {HTMLElement} stage        região redesenhada (salas e tokens)
 * @property {HTMLElement} layer        camada .fx (não é redesenhada)
 * @property {() => boolean} motion     false com prefers-reduced-motion
 * @property {() => number} [clock]     ms; padrão performance.now()
 */

/**
 * Liga os efeitos a uma cena. `capture()` antes do desenho; `update()` depois.
 * @param {SceneFxOptions} options
 */
export function createSceneFx({ stage, layer, motion, clock = () => performance.now() }) {
  /** @type {SceneMemory|null} */
  let memory = null;
  /** @type {Effect[]} */
  let effects = [];
  /** @type {Flight[]} */
  let flights = [];
  /** @type {HTMLElement|null} */
  let finaleCard = null;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let finaleTimer;

  /** @param {string} key */
  const tokenOf = (key) => [...stage.querySelectorAll('.token[data-key]')].find((el) => el.getAttribute('data-key') === key) ?? null;
  /** @param {string} key */
  const avatarOf = (key) => tokenOf(key)?.querySelector('.tok-av') ?? null;
  /** @param {string} target */
  function elementFor(target) {
    const [kind, ...rest] = target.split(':');
    const id = rest.join(':');
    if (kind === 'avatar') return avatarOf(id);
    if (kind === 'token') return tokenOf(id);
    if (kind === 'bug') return stage.querySelector(`.bug[data-bug="${Number(id)}"]`);
    return null;
  }

  /** Origem da camada .fx na página. */
  const origin = () => layer.getBoundingClientRect();
  /** @param {DOMRect} rect @returns {{ x: number, y: number }} centro relativo à camada */
  const center = (rect) => {
    const o = origin();
    return { x: rect.left + rect.width / 2 - o.left, y: rect.top + rect.height / 2 - o.top };
  };
  /** @param {RoomId} room */
  const roomEl = (room) => stage.querySelector(`.room[data-room="${room}"]`);

  /**
   * Inicia e registra um efeito curto.
   * @param {string} target
   * @param {Keyframe[]} keyframes
   * @param {Effect['options']} options
   */
  function play(target, keyframes, options) {
    const element = elementFor(target);
    if (!element) return;
    const effect = { target, keyframes, options, start: clock(), animation: element.animate(keyframes, options), element };
    effects.push(effect);
  }

  /** Cancela os efeitos de um alvo com os ids dados (também os do elemento atual). */
  function cancel(/** @type {string} */ target, /** @type {string[]} */ ids) {
    effects = effects.filter((effect) => {
      if (effect.target !== target || !ids.includes(effect.options.id)) return true;
      effect.animation?.cancel();
      return false;
    });
    const element = elementFor(target);
    for (const animation of element?.getAnimations() ?? []) if (ids.includes(animation.id)) animation.cancel();
  }

  /** Refaz nos elementos novos os efeitos que ainda não acabaram. */
  function replay() {
    const now = clock();
    effects = effects.filter((effect) => {
      const elapsed = now - effect.start;
      if (elapsed >= effect.options.duration * num(effect.options.iterations ?? 1)) return false;
      const element = elementFor(effect.target);
      if (!element) return false;
      if (element !== effect.element || !effect.animation || effect.animation.playState === 'idle') {
        effect.animation = element.animate(effect.keyframes, effect.options);
        effect.animation.currentTime = elapsed;
        effect.element = element;
      }
      return true;
    });
  }

  /** Animações contínuas do CSS no mesmo compasso, para não recomeçarem a cada desenho. */
  function syncAmbient() {
    for (const animation of stage.getAnimations({ subtree: true })) {
      const iterations = animation.effect?.getTiming().iterations;
      if (iterations === Infinity && animation.startTime !== 0) animation.startTime = 0;
    }
  }

  /** @returns {SceneSnapshot} */
  function capture() {
    /** @type {SceneSnapshot} */
    const snapshot = { tokens: new Map(), bugs: new Map() };
    for (const token of stage.querySelectorAll('.token[data-key]')) {
      const avatar = token.querySelector('.tok-av');
      const key = token.getAttribute('data-key');
      if (!avatar || key === null) continue;
      snapshot.tokens.set(key, {
        token,
        avatar: avatar.getBoundingClientRect(),
        role: token.getAttribute('data-agent') ?? 'aux',
        icon: avatar.firstChild?.textContent ?? '',
      });
    }
    for (const bug of stage.querySelectorAll('.bug[data-bug]')) snapshot.bugs.set(Number(bug.getAttribute('data-bug')), bug.getBoundingClientRect());
    return snapshot;
  }

  /**
   * Elemento temporário na camada .fx, sem estilo inline: a posição vem só da
   * animação (transform).
   * @param {string} className
   * @param {string} [role]
   */
  function temp(className, role) {
    const element = document.createElement('div');
    element.className = className;
    if (role) element.setAttribute('data-agent', role);
    layer.append(element);
    return element;
  }

  /**
   * Fantasma de um token que saiu: vai até o "+N" da sala nova, ou some no lugar.
   * @param {{ avatar: DOMRect, role: string, icon: string }} old
   * @param {DOMRect|null} target
   */
  function ghost(old, target) {
    const element = temp('ghost', old.role);
    const avatar = document.createElement('div');
    avatar.className = 'tok-av';
    avatar.textContent = old.icon;
    element.append(avatar);
    const size = element.getBoundingClientRect();
    const from = center(old.avatar);
    const scale = size.width > 0 ? old.avatar.width / size.width : 1;
    const half = { x: size.width / 2, y: size.height / 2 };
    const frames = [{ transform: `translate(${from.x - half.x}px, ${from.y - half.y}px) scale(${scale})`, opacity: 1 }];
    if (target) {
      const to = center(target);
      frames.push({ transform: `translate(${to.x - half.x}px, ${to.y - half.y}px) scale(${scale * 0.4})`, opacity: 0 });
    } else {
      frames.push({ transform: `translate(${from.x - half.x}px, ${from.y - half.y}px) scale(${scale * 0.8})`, opacity: 0 });
    }
    const animation = element.animate(frames, { duration: target ? WALK_MS : FADE_MS, easing: 'cubic-bezier(.45, 0, .25, 1)', fill: 'forwards', id: target ? FX_IDS.move : FX_IDS.fade });
    animation.onfinish = () => element.remove();
    animation.oncancel = () => element.remove();
  }

  /**
   * Retângulo de onde um agente está (token, "+N" da sala ou a sala).
   * @param {SessionState} session
   * @param {string} key
   * @returns {DOMRect|null}
   */
  function placeOf(session, key) {
    const avatar = avatarOf(key);
    if (avatar) return avatar.getBoundingClientRect();
    const room = sceneLayout(session).find((r) => r.members.some((agent) => agent.key === key));
    if (!room) return null;
    const element = roomEl(room.id);
    return (element?.querySelector('.room-more') ?? element)?.getBoundingClientRect() ?? null;
  }

  /**
   * Para onde vai o envelope: o token da instância, ou a sala do papel chamado.
   * @param {SessionState} session
   * @param {Delegation} delegation
   * @param {Set<string>} claimed
   * @returns {{ rect: DOMRect|null, exact: boolean }}
   */
  function flightTarget(session, delegation, claimed) {
    const key = delegationTarget(session, delegation, claimed);
    if (key) {
      claimed.add(key);
      const rect = placeOf(session, key);
      if (rect) return { rect, exact: true };
    }
    const role = delegation.toRole && Object.hasOwn(ROOM_OF_ROLE, delegation.toRole)
      ? ROOM_OF_ROLE[/** @type {keyof typeof ROOM_OF_ROLE} */ (delegation.toRole)]
      : 'hq';
    return { rect: roomEl(role)?.getBoundingClientRect() ?? null, exact: false };
  }

  /**
   * Quadros do envelope entre dois pontos (mockup, `fly`): sobe em arco e
   * diminui ao chegar.
   * @param {{ x: number, y: number }} a
   * @param {{ x: number, y: number }} b
   */
  const envelopeFrames = (a, b) => [
    { transform: `translate(${a.x}px, ${a.y}px) scale(.6)`, opacity: 0 },
    { transform: `translate(${(a.x + b.x) / 2}px, ${(a.y + b.y) / 2 - 60}px) scale(1.2) rotate(-12deg)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${b.x}px, ${b.y}px) scale(.8)`, opacity: 0.1 },
  ];

  /**
   * @param {SessionState} session
   * @param {Delegation} delegation
   * @param {Set<string>} claimed
   */
  function launch(session, delegation, claimed) {
    const from = placeOf(session, delegation.fromKey) ?? roomEl('hq')?.getBoundingClientRect() ?? null;
    const { rect, exact } = flightTarget(session, delegation, claimed);
    if (!from || !rect) return;
    const element = temp('flyer');
    const animation = element.animate(envelopeFrames(center(from), center(rect)), { duration: ENVELOPE_MS, easing: 'ease-in-out', fill: 'forwards', id: FX_IDS.envelope });
    /** @type {Flight} */
    const flight = { element, animation, delegation, start: clock(), landed: exact };
    animation.onfinish = () => { element.remove(); flights = flights.filter((f) => f !== flight); };
    flights.push(flight);
  }

  /**
   * Envelope que saiu antes de a instância aparecer muda de rumo para o token.
   * @param {SessionState} session
   * @param {Set<string>} claimed
   */
  function retarget(session, claimed) {
    for (const flight of flights) {
      if (flight.landed) continue;
      const remaining = ENVELOPE_MS - (clock() - flight.start);
      if (remaining < 150) continue;
      const key = delegationTarget(session, flight.delegation, claimed);
      const avatar = key ? avatarOf(key) : null;
      if (!key || !avatar) continue;
      claimed.add(key);
      // Do ponto em que o envelope está agora até o token, no tempo que falta.
      const here = center(flight.element.getBoundingClientRect());
      const there = center(avatar.getBoundingClientRect());
      const old = flight.animation;
      old.onfinish = null;
      old.oncancel = null;
      const animation = flight.element.animate([
        { transform: `translate(${here.x}px, ${here.y}px) scale(1)`, opacity: 1 },
        { transform: `translate(${there.x}px, ${there.y}px) scale(.8)`, opacity: 0.1 },
      ], { duration: remaining, easing: 'ease-out', fill: 'forwards', id: FX_IDS.envelope });
      old.cancel();
      flight.animation = animation;
      flight.landed = true;
      animation.onfinish = () => { flight.element.remove(); flights = flights.filter((f) => f !== flight); };
    }
  }

  /**
   * Cartão final do ticket entregue (mockup, `finale`), com o texto do tema.
   * @param {QuestSummary} summary
   * @param {Theme} theme
   * @param {boolean} animated
   */
  function showFinale(summary, theme, animated) {
    hideFinale();
    const card = theme.finale(summary);
    const overlay = temp('finale');
    const box = document.createElement('div');
    box.className = 'finale-card';
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = card.icon;
    const title = document.createElement('h3');
    title.textContent = card.title;
    const sub = document.createElement('p');
    sub.textContent = card.sub;
    box.append(big, title, sub);
    overlay.append(box);
    finaleCard = overlay;
    if (animated) burst(overlay);
    finaleTimer = setTimeout(() => {
      overlay.classList.add('out');
      finaleTimer = setTimeout(() => { overlay.remove(); if (finaleCard === overlay) finaleCard = null; }, FINALE_OUT_MS);
    }, FINALE_MS);
  }

  function hideFinale() {
    clearTimeout(finaleTimer);
    finaleCard?.remove();
    finaleCard = null;
  }

  /** Confete do cartão final (mockup, `burst`); os ícones vêm do CSS do tema. */
  function burst(/** @type {HTMLElement} */ host) {
    for (let i = 0; i < 18; i++) {
      const particle = document.createElement('span');
      particle.className = 'particle';
      particle.setAttribute('data-n', String(i % 4));
      host.append(particle);
      const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.3;
      const distance = 90 + Math.random() * 100;
      particle.animate([
        { transform: 'translate(0, 0) scale(.4)', opacity: 1 },
        { transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(1) rotate(${Math.round(Math.random() * 120 - 60)}deg)`, opacity: 0 },
      ], { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'forwards', id: FX_IDS.burst });
    }
  }

  /**
   * Bug que some: fantasma com a animação de derrota (mockup, `defeat`).
   * @param {DOMRect} rect
   */
  function defeat(rect) {
    const element = temp('bug ghost');
    element.append(document.createElement('i'));
    const size = element.getBoundingClientRect();
    const at = center(rect);
    const x = at.x - size.width / 2;
    const y = at.y - size.height / 2;
    const animation = element.animate([
      { transform: `translate(${x}px, ${y}px)`, opacity: 1 },
      { transform: `translate(${x}px, ${y - 14}px) scale(1.6) rotate(40deg)`, opacity: 0 },
    ], { duration: DEFEAT_MS, easing: 'ease-in', fill: 'forwards', id: FX_IDS.defeat });
    animation.onfinish = () => element.remove();
  }

  /**
   * Depois de cada desenho da cena.
   * @param {{ session: SessionState|null, theme: Theme, before: SceneSnapshot }} params
   */
  function update({ session, theme, before }) {
    const changes = sceneChanges(memory, session, `${theme.id}|${session?.id ?? ''}`);
    memory = changes.memory;
    const animated = motion();
    if (!changes.animate) {
      // Outra sessão ou outro tema (ou o primeiro desenho): nada anima, e o que
      // estava no ar sai.
      for (const effect of effects) effect.animation?.cancel();
      effects = [];
      for (const flight of flights) {
        flight.animation.onfinish = null;
        flight.animation.cancel();
        flight.element.remove();
      }
      flights = [];
      hideFinale();
      if (animated) syncAmbient();
      return;
    }
    if (!animated || !session) {
      // Movimento reduzido: nenhuma chamada a animate(); o cartão final aparece parado.
      if (changes.finale && session) showFinale(changes.finale, theme, false);
      return;
    }

    replay();

    // FLIP: quem mudou de lugar anima de onde estava.
    const after = capture();
    for (const [key, old] of before.tokens) {
      const now = after.tokens.get(key);
      if (!now) {
        ghost(old, placeOf(session, key));
        continue;
      }
      if (now.token === old.token) continue;
      const delta = flipDelta(old.avatar, now.avatar);
      if (!delta) continue;
      const tokenTarget = `token:${key}`;
      const avatarTarget = `avatar:${key}`;
      cancel(tokenTarget, [FX_IDS.move, FX_IDS.spawn]);
      cancel(avatarTarget, [FX_IDS.walk, FX_IDS.size]);
      const easing = 'cubic-bezier(.45, 0, .25, 1)';
      play(tokenTarget, [{ translate: `${delta.dx}px ${delta.dy}px` }, { translate: '0 0' }], { duration: WALK_MS, easing, id: FX_IDS.move });
      if (Math.abs(delta.scale - 1) >= 0.02) play(avatarTarget, [{ scale: String(delta.scale) }, { scale: '1' }], { duration: WALK_MS, easing, id: FX_IDS.size });
      play(avatarTarget, KEYFRAMES.walk, { duration: WALK_STEP_MS, iterations: Math.ceil(WALK_MS / WALK_STEP_MS), easing: 'ease-in-out', id: FX_IDS.walk });
    }
    for (const key of after.tokens.keys()) {
      if (!before.tokens.has(key)) play(`token:${key}`, KEYFRAMES.spawn, { duration: SPAWN_MS, easing: 'ease-out', id: FX_IDS.spawn });
    }

    for (const key of changes.hits) {
      if (!avatarOf(key)) continue;
      cancel(`avatar:${key}`, [FX_IDS.hit]);
      play(`avatar:${key}`, KEYFRAMES.hit, { duration: HIT_MS, easing: 'ease', id: FX_IDS.hit });
    }

    const { from, to } = changes.bugs;
    for (let index = from; index < to; index++) play(`bug:${index}`, KEYFRAMES.bugSpawn, { duration: BUG_SPAWN_MS, easing: 'cubic-bezier(.3, 1.6, .5, 1)', id: FX_IDS.bugSpawn });
    for (const [index, rect] of before.bugs) if (index >= to) defeat(rect);

    const claimed = new Set();
    retarget(session, claimed);
    for (const delegation of changes.delegations) launch(session, delegation, claimed);

    if (changes.finale) showFinale(changes.finale, theme, true);
    syncAmbient();
  }

  return { capture, update };
}
