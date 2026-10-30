// @ts-check
// Geometria da cena (T12a, bug B2 do tester): em todas as larguras, o balão de
// cada token fica dentro da sala e da cena e não cobre retratos, outros
// balões, nomes de outros tokens, o nome da sala nem o "+N"; retratos e nomes
// ficam dentro da sala e não se sobrepõem. Em sala larga, todo token
// trabalhando ou aguardando tem o balão visível; em sala estreita (celular),
// sala com mais de um token mostra só os retratos. O nome da sala não fica sob
// a decoração, o "+N", retratos ou nomes de tokens, cabe inteiro a partir de
// 1280 px (bug dos prints do T17) e, quando cortado, tem o nome inteiro no title.

import { expect, test } from '@playwright/test';
import { loadSnapshot, mockLiveServer } from './support.js';

const LONG = 'web/js/views/um-arquivo-com-um-nome-bem-comprido-para-testar-o-corte.js';

/**
 * Sessão lotada: todas as salas com mais de 3 tokens possíveis, nomes e ações
 * longos. Com `designers` acima de 3, a sala de planejamento (o nome mais longo
 * dos dois temas) também tem o "+N".
 * @param {number} [designers]
 */
function crowdedSession(designers = 2) {
  const session = structuredClone(loadSnapshot('primeira-luz').sessions[0]);
  const base = session.agents.find((/** @type {any} */ a) => a.role === 'dev' && !a.finished);
  /** @param {string} key @param {string} role @param {string} agentType @param {object} [extra] */
  const agent = (key, role, agentType, extra = {}) => ({
    ...base, key, agentId: key, role, agentType, label: `${agentType} ${key}`, status: 'working', finished: false,
    activity: { kind: 'tool', category: 'edit', tool: 'Edit', target: `${LONG}?${key}`, detail: null, state: 'running', at: base.startedAt },
    startedAt: base.startedAt + key.length, lastEventAt: base.lastEventAt, ...extra,
  });
  const main = { ...session.agents.find((/** @type {any} */ a) => a.key === 'main'), status: 'working', activity: { kind: 'delegate', category: null, tool: 'Agent', target: 'general-purpose', detail: 'uma delegação com uma descrição bem longa para o balão', state: 'running', at: base.startedAt } };
  session.agents = [
    main,
    agent('g1', 'aux', 'Explore'), agent('g2', 'aux', 'general-purpose'), agent('g3', 'aux', 'Plan'),
    ...Array.from({ length: designers }, (_, index) => agent(`a${index + 1}`, 'arq', 'arquiteto')),
    agent('d1', 'dev', 'dev-backend'), agent('d2', 'dev', 'dev-frontend'), agent('d3', 'dev', 'dev-backend'), agent('d4', 'dev', 'dev-frontend'), agent('d5', 'dev', 'dev-backend'),
    agent('t1', 'tes', 'tester', { status: 'waiting', waitingFor: { tool: 'Bash', category: 'bash', target: 'npm run test:e2e' } }), agent('t2', 'tes', 'tester'), agent('t3', 'tes', 'tester'),
    agent('w1', 'doc', 'documentador'),
    ...['f1', 'f2', 'f3', 'f4', 'f5'].map((key, index) => agent(key, index % 2 ? 'aux' : 'doc', index % 2 ? 'general-purpose' : 'documentador', { status: 'idle', finished: true, lastEventAt: base.lastEventAt - index })),
  ];
  session.roster = ['orq', 'arq', 'dev', 'tes', 'doc', 'aux'];
  return session;
}

const SCENARIOS = {
  'primeira-luz': () => loadSnapshot('primeira-luz').sessions[0],
  'ticket-completo': () => loadSnapshot('ticket-completo').sessions[0],
  lotada: () => crowdedSession(),
  'lotada-com-planejamento': () => crowdedSession(4),
};

/** Retângulos da cena, por sala, medidos no navegador. */
async function measure(/** @type {import('@playwright/test').Page} */ page) {
  return page.evaluate(() => {
    /** @param {Element|null} el */
    const rect = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || el.getClientRects().length === 0) return null;
      const b = el.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
    };
    return {
      scene: rect(document.querySelector('.scene')),
      rooms: [...document.querySelectorAll('.room')].map((room) => ({
        id: /** @type {HTMLElement} */ (room).dataset.room,
        layout: /** @type {HTMLElement} */ (room).dataset.layout,
        rect: rect(room),
        label: rect(room.querySelector('.room-label')),
        more: rect(room.querySelector('.room-more')),
        deco: rect(room.querySelector('.deco.d1')),
        icon: rect(room.querySelector('.room-label .ri')),
        roomName: (() => {
          const el = /** @type {HTMLElement|null} */ (room.querySelector('.room-name'));
          if (!el) return null;
          const line = parseFloat(getComputedStyle(el).lineHeight);
          return {
            text: el.textContent ?? '',
            title: el.title,
            rect: rect(el),
            // Cortado: o texto passa da caixa na largura ou sobra uma terceira
            // linha. A folga de meia linha ignora o pixel ou dois que a fonte
            // da Guilda desenha além da altura da linha.
            cut: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + line / 2,
          };
        })(),
        tokens: [...room.querySelectorAll('.token')].map((token) => ({
          key: /** @type {HTMLElement} */ (token).dataset.key,
          status: ['working', 'waiting', 'idle'].find((s) => token.classList.contains(s)) ?? '',
          avatar: rect(token.querySelector('.tok-av')),
          name: rect(token.querySelector('.tok-name')),
          bubble: rect(token.querySelector('.bubble')),
          text: token.querySelector('.bubble-text')?.textContent ?? '',
        })),
      })),
    };
  });
}

/** @typedef {{ l: number, t: number, r: number, b: number, w: number, h: number }} Rect */

/** Sobreposição com folga de meio pixel. @param {Rect|null} a @param {Rect|null} b */
const overlaps = (a, b) => a !== null && b !== null && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
/** @param {Rect|null} inner @param {Rect|null} outer */
const inside = (inner, outer) => !inner || !outer || (inner.l >= outer.l - 0.5 && inner.r <= outer.r + 0.5 && inner.t >= outer.t - 0.5 && inner.b <= outer.b + 0.5);

/**
 * Problemas de geometria de uma medida. A partir de 1280 px, o nome de cada
 * sala cabe inteiro (em até duas linhas); abaixo disso pode ser cortado, mas
 * tem o nome inteiro no title.
 * @param {Awaited<ReturnType<typeof measure>>} data
 * @param {number} width
 */
function problemsOf(data, width) {
  const problems = [];
  const allAvatars = data.rooms.flatMap((room) => room.tokens.map((token) => ({ key: token.key, rect: token.avatar })));
  const allBubbles = data.rooms.flatMap((room) => room.tokens.filter((t) => t.bubble).map((token) => ({ key: token.key, rect: token.bubble })));
  for (const room of data.rooms) {
    const narrow = (room.rect?.w ?? 0) < 140;
    const name = room.roomName;
    if (!name) problems.push(`${room.id}: sala sem nome`);
    else {
      if (name.title !== name.text) problems.push(`${room.id}: nome sem o title com o nome inteiro`);
      if (name.cut && width >= 1280) problems.push(`${room.id}: nome da sala cortado (${name.text})`);
      if (!inside(room.label, room.rect)) problems.push(`${room.id}: nome fora da sala`);
      if (overlaps(name.rect, room.deco)) problems.push(`${room.id}: nome sobre a decoração`);
      if (overlaps(name.rect, room.more)) problems.push(`${room.id}: nome sobre o "+N"`);
    }
    for (const token of room.tokens) {
      const who = `${room.id}/${token.key}`;
      if (!inside(token.avatar, room.rect)) problems.push(`${who}: retrato fora da sala`);
      if (!inside(token.name, room.rect)) problems.push(`${who}: nome fora da sala`);
      for (const part of [room.icon, room.roomName?.rect ?? null]) {
        if (overlaps(token.avatar, part)) problems.push(`${who}: retrato sobre o nome da sala`);
        if (overlaps(token.name, part)) problems.push(`${who}: nome do token sobre o nome da sala`);
      }
      const active = token.status === 'working' || token.status === 'waiting';
      if (active && !narrow && !token.bubble) problems.push(`${who}: trabalhando sem balão em sala larga`);
      if (active && !narrow && token.bubble && token.bubble.w < 60) problems.push(`${who}: balão estreito demais (${Math.round(token.bubble.w)} px)`);
      if (narrow && room.layout === 'rows' && token.bubble) problems.push(`${who}: balão em sala estreita lotada`);
      if (!token.bubble) continue;
      if (!inside(token.bubble, room.rect)) problems.push(`${who}: balão fora da sala`);
      if (!inside(token.bubble, data.scene)) problems.push(`${who}: balão fora da cena`);
      if (overlaps(token.bubble, room.label)) problems.push(`${who}: balão sobre o nome da sala`);
      if (overlaps(token.bubble, room.more)) problems.push(`${who}: balão sobre o "+N"`);
      for (const avatar of allAvatars) if (overlaps(token.bubble, avatar.rect)) problems.push(`${who}: balão sobre o retrato de ${avatar.key}`);
      for (const other of allBubbles) if (other.key !== token.key && overlaps(token.bubble, other.rect)) problems.push(`${who}: balão sobre o balão de ${other.key}`);
      for (const other of room.tokens) if (other.key !== token.key && overlaps(token.bubble, other.name)) problems.push(`${who}: balão sobre o nome de ${other.key}`);
    }
    for (const [i, a] of room.tokens.entries()) {
      for (const b of room.tokens.slice(i + 1)) {
        if (overlaps(a.avatar, b.avatar)) problems.push(`${room.id}: retratos de ${a.key} e ${b.key} sobrepostos`);
        if (overlaps(a.name, b.name)) problems.push(`${room.id}: nomes de ${a.key} e ${b.key} sobrepostos`);
        if (overlaps(a.name, b.avatar) || overlaps(b.name, a.avatar)) problems.push(`${room.id}: nome sobre retrato (${a.key}, ${b.key})`);
      }
    }
  }
  return problems;
}

for (const theme of ['escritorio', 'guilda']) {
  for (const [name, build] of Object.entries(SCENARIOS)) {
    test(`cena ${name} (${theme}): balões, retratos, nomes e nome da sala sem sobreposição em todas as larguras`, async ({ page }) => {
      await mockLiveServer(page, [build()]);
      const problems = [];
      for (const width of [360, 820, 1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width === 360) {
          await page.goto(`/#${theme}`);
          await expect(page.locator('.rooms .token').first()).toBeVisible();
        }
        await page.waitForTimeout(100);
        for (const problem of problemsOf(await measure(page), width)) problems.push(`${width} px ${problem}`);
      }
      expect(problems).toEqual([]);
    });
  }
}
