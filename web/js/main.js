// @ts-check
// Ponto de entrada do painel: monta a página com o tema escolhido, liga a
// alternância de tema (botões, teclas 1, 2 e T, hash da URL e localStorage, como
// no mockup), abre a conexão ao vivo com o servidor e mostra a sessão escolhida
// no seletor.
//
// O estado vem do servidor (store.js, alimentado por connection.js) e não é
// alterado aqui: as telas são geradas pelas views a partir dele. Os
// redesenhos pedidos pela conexão são agrupados por quadro de animação.
// Trocar de tema muda `data-theme` e refaz os textos, sem tocar no estado nem
// reabrir a conexão (ADR 0009).
//
// Filtros do feed (T11b): o filtro é preferência de quem observa e vale para a
// sessão em que foi escolhido. A lista do feed é atualizada no lugar
// (views/feed.js, `syncFeedList`), para as linhas novas entrarem no topo com a
// animação do mockup sem recriar as outras.
//
// Várias sessões (T13): o seletor agrupado por projeto (views/sessions.js), a
// política "seguir atividade" (follow.js, função pura, chamada a cada redesenho
// e a cada segundo, porque "parada há 30 s" depende do relógio), a preferência
// no localStorage e o aviso de aprovação pendente em outra sessão
// (views/topbar.js), com atalho para ela.

import { connect, frameBatcher } from './connection.js';
import { FOLLOW_STORAGE_KEY, chooseSession, parsePreference, serializePreference } from './follow.js';
import { createSceneFx } from './fx.js';
import { renderScene } from './scene.js';
import { sessionList } from './selectors.js';
import { createStore } from './store.js';
import { resolveThemeId, themeIdForKey } from './themes/contract.js';
import escritorio from './themes/escritorio.js';
import guilda from './themes/guilda.js';
import { renderEmpty } from './views/empty.js';
import { ALL, feedModel, nextFilter, resolveFilter, syncFeedList } from './views/feed.js';
import { renderParty } from './views/party.js';
import { renderQuest } from './views/quest.js';
import { sessionGroups, syncSessionSelect } from './views/sessions.js';
import { renderConnection, renderPendingAlert, renderStats, renderThemeToggle } from './views/topbar.js';

/** @typedef {import('../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../shared/contract.js').HealthResponse} HealthResponse */
/** @typedef {import('./connection.js').ConnectionState} ConnectionState */
/** @typedef {import('./views/empty.js').HealthState} HealthState */
/** @typedef {import('./follow.js').FollowPreference} FollowPreference */

const THEMES = [escritorio, guilda];
const THEME_IDS = THEMES.map((theme) => theme.id);
const STORAGE_KEY = 'agent-quest-theme';
const HEALTH_REFRESH_MS = 15_000;
const CLOCK_MS = 1_000;
/** Tempo máximo em que uma região fica sem redesenhar com um botão apertado. */
const HOLD_MAX_MS = 1_500;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento #${id} não encontrado em index.html`);
  return element;
}

const ui = {
  sessionInfo: byId('session-info'),
  sessionSelect: /** @type {HTMLSelectElement} */ (byId('session-select')),
  sessionFollow: byId('session-follow'),
  sessionAlert: byId('session-alert'),
  stats: byId('stats'),
  conn: byId('conn'),
  toggle: byId('theme-toggle'),
  party: byId('party'),
  questSlot: byId('quest-slot'),
  sceneStage: byId('scene-stage'),
  sceneFx: byId('scene-fx'),
  feedHead: byId('feed-head'),
  feedFilters: byId('feed-filters'),
  feedEmpty: byId('feed-empty'),
  feedEntries: byId('feed-entries'),
};

const store = createStore();

/** Animações da cena; com prefers-reduced-motion, nenhuma (T12b). */
const sceneFx = createSceneFx({ stage: ui.sceneStage, layer: ui.sceneFx, motion: () => !reducedMotion.matches });

/** Preferências de quem observa e o que não vem do SSE. */
const app = {
  themeId: THEME_IDS[0],
  /** Sessão mostrada, decidida pela política "seguir atividade" (T13). */
  /** @type {string|null} */
  selectedId: null,
  /** Seguir atividade ou sessão fixada (T13; guardada no localStorage). */
  /** @type {FollowPreference} */
  preference: parsePreference(storedPreference()),
  /** Hora da última troca automática de sessão (no máximo uma a cada 10 s). */
  /** @type {number|null} */
  lastSwitchAt: null,
  /** @type {HealthResponse|null} */
  health: null,
  /** @type {HealthState} */
  healthState: 'loading',
  /** @type {ConnectionState} */
  connection: 'connecting',
  /** Filtro do feed (T11b) e a sessão em que ele foi escolhido. */
  filter: { sessionId: /** @type {string|null} */ (null), value: ALL },
};

const currentTheme = () => THEMES.find((theme) => theme.id === app.themeId) ?? THEMES[0];

/**
 * Lista do seletor e sessão mostrada, pela política "seguir atividade"
 * (follow.js): seguindo, troca para a sessão ativa quando a atual está parada;
 * fixada, mostra a escolhida enquanto ela existir.
 * @param {number} [now]
 * @returns {{ list: SessionState[], session: SessionState|null }}
 */
function currentView(now = Date.now()) {
  const list = sessionList(store.sessions.values());
  const choice = chooseSession({ list, preference: app.preference, currentId: app.selectedId, lastSwitchAt: app.lastSwitchAt, now });
  if (choice.switched) app.lastSwitchAt = now;
  app.selectedId = choice.id;
  return { list, session: app.selectedId === null ? null : store.sessions.get(app.selectedId) ?? null };
}

/**
 * Guarda a preferência (seguir ou fixar).
 * @param {FollowPreference} preference
 */
function setPreference(preference) {
  app.preference = preference;
  try {
    localStorage.setItem(FOLLOW_STORAGE_KEY, serializePreference(preference));
  } catch {
    // armazenamento indisponível: a escolha vale só nesta aba
  }
}

/**
 * Fixa uma sessão (escolha no seletor ou atalho do aviso): desliga o seguir.
 * @param {string} id
 */
function pinSession(id) {
  if (!store.sessions.has(id)) return;
  setPreference({ follow: false, pinnedId: id });
  app.selectedId = id;
}

function storedPreference() {
  try {
    return localStorage.getItem(FOLLOW_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Filtro do feed em vigor: só na sessão em que foi escolhido, e enquanto o
 * controle dele existir (views/feed.js, `resolveFilter`).
 * @param {SessionState|null} session
 * @returns {string}
 */
function currentFilter(session) {
  const value = session && session.id === app.filter.sessionId ? resolveFilter(session, app.filter.value) : ALL;
  if (value === ALL) app.filter = { sessionId: null, value: ALL };
  return value;
}

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------

/** Último HTML escrito em cada região, para não recriar o DOM sem mudança. */
const lastHTML = new WeakMap();

/**
 * Regiões com botões que estão sendo apertados. Elas não são redesenhadas até
 * o botão ser solto: o clique chegaria a um elemento já trocado e se perderia.
 * @type {Set<Element>}
 */
const held = new Set();
/** @type {ReturnType<typeof setTimeout>|undefined} */
let holdTimer;

/** Atributos com a chave estável de um botão redesenhado (regras de interface). */
const FOCUS_KEYS = ['data-filter', 'data-focus-key'];

/**
 * Escreve o HTML gerado pelas views (todo texto dinâmico já escapado) só quando
 * ele muda. Se o foco estava num botão da região com chave estável
 * (`data-filter` ou `data-focus-key`), ele volta para o botão equivalente no
 * HTML novo (o teclado não perde o lugar a cada update). Se o botão sumiu e há
 * um `fallback`, o foco vai para ele.
 * @param {Element} element
 * @param {string} html
 * @param {HTMLElement} [fallback]
 */
function setHTML(element, html, fallback) {
  if (held.has(element) || lastHTML.get(element) === html) return;
  lastHTML.set(element, html);
  const active = document.activeElement;
  const inside = active !== null && active !== element && element.contains(active);
  const attr = inside ? FOCUS_KEYS.find((name) => active.hasAttribute(name)) ?? null : null;
  const focusKey = attr ? active?.getAttribute(attr) ?? null : null;
  element.innerHTML = html;
  if (!inside) return;
  const next = attr ? [...element.querySelectorAll(`[${attr}]`)].find((node) => node.getAttribute(attr) === focusKey) : null;
  if (next instanceof HTMLElement) next.focus({ preventScroll: true });
  else if (fallback) fallback.focus({ preventScroll: true });
}

/**
 * Cria um elemento a partir do HTML de uma view, pelo `setHTML` (num <template>,
 * fora da página).
 * @param {string} html
 * @returns {HTMLElement}
 */
function elementFromHTML(html) {
  const template = document.createElement('template');
  setHTML(template, html);
  const node = template.content.firstElementChild;
  if (!(node instanceof HTMLElement)) throw new Error('HTML de linha do feed sem elemento');
  return node;
}

/**
 * Segura o redesenho de uma região enquanto um botão dela está apertado (mouse,
 * toque ou teclado), por no máximo HOLD_MAX_MS.
 * @param {Element} element
 */
function holdWhilePressed(element) {
  const hold = () => {
    held.add(element);
    clearTimeout(holdTimer);
    holdTimer = setTimeout(releaseHeld, HOLD_MAX_MS);
  };
  element.addEventListener('pointerdown', hold);
  element.addEventListener('keydown', (event) => {
    const key = /** @type {KeyboardEvent} */ (event).key;
    if (key === ' ' || key === 'Enter') hold();
  });
}

function releaseHeld() {
  if (held.size === 0) return;
  held.clear();
  clearTimeout(holdTimer);
  scheduleRender();
}

/** @param {SessionState|null} session */
function renderCenter(session) {
  const theme = currentTheme();
  setHTML(ui.questSlot, session
    ? renderQuest({ session, theme, now: Date.now() })
    : renderEmpty({ theme, health: app.health, healthState: app.healthState }));
}

/**
 * Partes que dependem do relógio (durações) e a política "seguir atividade",
 * que troca de sessão quando a atual fica parada.
 */
function renderClock() {
  const before = app.selectedId;
  const { session } = currentView();
  if (app.selectedId !== before) {
    renderAll();
    return;
  }
  if (!session) return;
  const theme = currentTheme();
  const now = Date.now();
  setHTML(ui.stats, renderStats(session, theme, now));
  setHTML(ui.questSlot, renderQuest({ session, theme, now }));
}

function renderAll() {
  const theme = currentTheme();
  const now = Date.now();
  const { list, session } = currentView();
  document.title = `Agent Quest · ${theme.name}`;
  for (const button of ui.toggle.querySelectorAll('button[data-theme]')) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-theme') === app.themeId));
  }
  ui.sessionInfo.hidden = list.length === 0;
  ui.sessionSelect.title = session?.project?.dir ?? '';
  ui.sessionFollow.setAttribute('aria-pressed', String(app.preference.follow));
  // Com um controle do seletor apertado, as opções e o aviso esperam (no máximo 1,5 s).
  if (!held.has(ui.sessionInfo)) {
    syncSessionSelect(ui.sessionSelect, sessionGroups(list, app.selectedId, theme));
    setHTML(ui.sessionAlert, renderPendingAlert({ list, selectedId: app.selectedId, theme, now }), ui.sessionSelect);
  }
  setHTML(ui.stats, renderStats(session, theme, now));
  setHTML(ui.conn, renderConnection(app.connection));
  const filter = currentFilter(session);
  setHTML(ui.party, renderParty({ session, theme, filter }));
  renderFeedCard(feedModel({ session, theme, filter }));
  renderSceneArea(session, theme);
  renderCenter(session);
}

/**
 * Cena (T12b): guarda onde cada token estava, redesenha as salas e deixa o
 * fx.js animar o que mudou (FLIP, envelope, impacto, bugs e cartão final).
 * @param {SessionState|null} session
 * @param {import('./themes/contract.js').Theme} theme
 */
function renderSceneArea(session, theme) {
  const before = sceneFx.capture();
  setHTML(ui.sceneStage, renderScene({ session, theme }));
  sceneFx.update({ session, theme, before });
}

/**
 * Cartão de atividade: cabeçalho, chips e mensagem de vazio pelo `setHTML`; a
 * lista, no lugar.
 * @param {import('./views/feed.js').FeedModel} model
 */
function renderFeedCard(model) {
  setHTML(ui.feedHead, model.head);
  setHTML(ui.feedFilters, model.filters);
  ui.feedFilters.hidden = model.filters === '';
  setHTML(ui.feedEmpty, model.empty);
  ui.feedEmpty.hidden = model.empty === '';
  syncFeedList(/** @type {any} */ (ui.feedEntries), model, elementFromHTML);
}

/**
 * Aplica o filtro escolhido num botão (chip ou cartão da equipe).
 * @param {Event} event
 * @param {'set'|'toggle'} mode   chips escolhem; cartões alternam (como no mockup)
 */
function onFilterClick(event, mode) {
  const target = /** @type {Element|null} */ (event.target);
  // No cartão da equipe, clicar no bloco fora de um botão vale como clicar no papel.
  const control = target?.closest('[data-filter]') ?? (mode === 'toggle' ? target?.closest('.member')?.querySelector('[data-filter]') : null);
  if (!control) return;
  const { session } = currentView();
  if (!session) return;
  const value = nextFilter(currentFilter(session), control.getAttribute('data-filter') ?? ALL, mode);
  app.filter = { sessionId: session.id, value };
  // O clique já chegou: a região pode ser redesenhada.
  held.clear();
  renderAll();
}

/** Redesenho agrupado por quadro de animação (vários updates, um desenho). */
const scheduleRender = frameBatcher((callback) => requestAnimationFrame(callback), renderAll);

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

/** @param {string} id */
function applyTheme(id) {
  app.themeId = id;
  document.documentElement.dataset.theme = id;
  try {
    history.replaceState(null, '', `#${id}`);
  } catch {
    // alguns navegadores bloqueiam a troca do endereço; o tema continua valendo
  }
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // armazenamento indisponível: o tema vale só nesta aba
  }
  renderAll();
}

/** @param {string} id */
function switchTheme(id) {
  if (id === app.themeId || !THEME_IDS.includes(id)) return;
  const doc = /** @type {Document & { startViewTransition?: (update: () => void) => unknown }} */ (document);
  if (typeof doc.startViewTransition === 'function' && !reducedMotion.matches) {
    doc.startViewTransition(() => applyTheme(id));
  } else {
    applyTheme(id);
  }
}

function storedThemeId() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

async function refreshHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    app.health = /** @type {HealthResponse} */ (await response.json());
    app.healthState = 'ok';
  } catch {
    app.healthState = 'error';
  }
  if (store.sessions.size === 0) scheduleRender();
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------

setHTML(ui.toggle, renderThemeToggle(THEMES, app.themeId));
ui.toggle.addEventListener('click', (event) => {
  const target = /** @type {Element|null} */ (event.target);
  const button = target?.closest('button[data-theme]');
  const id = button?.getAttribute('data-theme');
  if (id) switchTheme(id);
});

// Escolher uma sessão no seletor a fixa e desliga o "seguir atividade" (T13).
ui.sessionSelect.addEventListener('change', () => {
  if (ui.sessionSelect.value) pinSession(ui.sessionSelect.value);
  held.clear();
  renderAll();
});

// "Seguir atividade": ligar volta a seguir; desligar fixa a sessão mostrada.
ui.sessionFollow.addEventListener('click', () => {
  if (app.preference.follow) {
    if (app.selectedId !== null) setPreference({ follow: false, pinnedId: app.selectedId });
  } else {
    setPreference({ follow: true, pinnedId: null });
    app.lastSwitchAt = null;
  }
  held.clear();
  renderAll();
});

// Atalho do aviso de aprovação pendente: vale como escolher a sessão no
// seletor. O aviso dessa sessão some, então o foco vai para o seletor (o
// setHTML já faz isso se o foco estava no botão).
ui.sessionAlert.addEventListener('click', (event) => {
  const target = /** @type {Element|null} */ (event.target);
  const id = target?.closest('[data-goto]')?.getAttribute('data-goto');
  if (!id) return;
  pinSession(id);
  held.clear();
  renderAll();
});

ui.party.addEventListener('click', (event) => onFilterClick(event, 'toggle'));
ui.feedFilters.addEventListener('click', (event) => onFilterClick(event, 'set'));
holdWhilePressed(ui.party);
holdWhilePressed(ui.feedFilters);
holdWhilePressed(ui.sessionInfo);
for (const type of ['pointerup', 'pointercancel', 'keyup']) window.addEventListener(type, releaseHeld, true);
// Só a janela perdendo o foco solta a região. O blur do botão que perde o foco
// no mousedown chega logo depois do pointerdown e soltaria a região no meio do
// clique (bug do tester no T11b).
window.addEventListener('blur', (event) => {
  if (event.target === window) releaseHeld();
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  const id = themeIdForKey(event.key, app.themeId, THEME_IDS);
  if (id) switchTheme(id);
});

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (THEME_IDS.includes(id)) switchTheme(id);
});

setInterval(renderClock, CLOCK_MS);
setInterval(() => {
  if (store.sessions.size === 0 && document.visibilityState === 'visible') refreshHealth();
}, HEALTH_REFRESH_MS);

app.themeId = resolveThemeId([location.hash.slice(1), storedThemeId()], THEME_IDS);
document.documentElement.dataset.theme = app.themeId;
renderAll();
refreshHealth();

connect({
  store,
  onChange: scheduleRender,
  onStatus: (state) => {
    app.connection = state;
    scheduleRender();
  },
});
