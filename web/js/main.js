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

import { connect, frameBatcher } from './connection.js';
import { renderScene } from './scene.js';
import { resolveSelectedId, sessionList } from './selectors.js';
import { createStore } from './store.js';
import { resolveThemeId, themeIdForKey } from './themes/contract.js';
import escritorio from './themes/escritorio.js';
import guilda from './themes/guilda.js';
import { renderEmpty } from './views/empty.js';
import { renderFeed } from './views/feed.js';
import { renderParty } from './views/party.js';
import { renderQuest } from './views/quest.js';
import { sessionOptions, syncSessionSelect } from './views/sessions.js';
import { renderConnection, renderStats, renderThemeToggle } from './views/topbar.js';

/** @typedef {import('../../shared/contract.js').SessionState} SessionState */
/** @typedef {import('../../shared/contract.js').HealthResponse} HealthResponse */
/** @typedef {import('./connection.js').ConnectionState} ConnectionState */
/** @typedef {import('./views/empty.js').HealthState} HealthState */

const THEMES = [escritorio, guilda];
const THEME_IDS = THEMES.map((theme) => theme.id);
const STORAGE_KEY = 'agent-quest-theme';
const HEALTH_REFRESH_MS = 15_000;
const CLOCK_MS = 1_000;

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
  stats: byId('stats'),
  conn: byId('conn'),
  toggle: byId('theme-toggle'),
  party: byId('party'),
  questSlot: byId('quest-slot'),
  scene: byId('scene'),
  feed: byId('feed'),
};

const store = createStore();

/** Preferências de quem observa e o que não vem do SSE. */
const app = {
  themeId: THEME_IDS[0],
  /** Sessão escolhida; vale enquanto ela existir (T11a). */
  /** @type {string|null} */
  selectedId: null,
  /** @type {HealthResponse|null} */
  health: null,
  /** @type {HealthState} */
  healthState: 'loading',
  /** @type {ConnectionState} */
  connection: 'connecting',
};

const currentTheme = () => THEMES.find((theme) => theme.id === app.themeId) ?? THEMES[0];

/**
 * Lista do seletor e sessão mostrada. Se a escolhida sumiu, volta para a mais
 * recente.
 * @returns {{ list: SessionState[], session: SessionState|null }}
 */
function currentView() {
  const list = sessionList(store.sessions.values());
  app.selectedId = resolveSelectedId(list, app.selectedId);
  return { list, session: app.selectedId === null ? null : store.sessions.get(app.selectedId) ?? null };
}

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------

/** Último HTML escrito em cada região, para não recriar o DOM sem mudança. */
const lastHTML = new WeakMap();

/**
 * Escreve o HTML gerado pelas views (todo texto dinâmico já escapado) só quando
 * ele muda.
 * @param {Element} element
 * @param {string} html
 */
function setHTML(element, html) {
  if (lastHTML.get(element) === html) return;
  lastHTML.set(element, html);
  element.innerHTML = html;
}

/** @param {SessionState|null} session */
function renderCenter(session) {
  const theme = currentTheme();
  setHTML(ui.questSlot, session
    ? renderQuest({ session, theme, now: Date.now() })
    : renderEmpty({ theme, health: app.health, healthState: app.healthState }));
}

/** Partes que dependem do relógio (durações). */
function renderClock() {
  const { session } = currentView();
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
  syncSessionSelect(ui.sessionSelect, sessionOptions(list, app.selectedId));
  setHTML(ui.stats, renderStats(session, theme, now));
  setHTML(ui.conn, renderConnection(app.connection));
  setHTML(ui.party, renderParty({ session, theme }));
  setHTML(ui.feed, renderFeed({ session, theme }));
  setHTML(ui.scene, renderScene({ session, theme }));
  renderCenter(session);
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

ui.sessionSelect.addEventListener('change', () => {
  app.selectedId = ui.sessionSelect.value || null;
  renderAll();
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
