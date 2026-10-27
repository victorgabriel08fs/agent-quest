// @ts-check
// Apoio aos E2E do tester (T11b em diante): servidor real só do teste, cenários
// fictícios montados em memória, injeção pelo injetor do T9b e um proxy HTTP
// que deixa cortar só a conexão SSE do painel.
//
// - Cada servidor sobe numa porta livre, com AGENT_QUEST_HOME temporário (nunca
//   a 47821 nem o diretório de dados real). USERPROFILE e HOME também apontam
//   para a pasta temporária, para o servidor não ler o ~/.claude/agents real.
// - Os cenários seguem o formato do ADR 0010 ({ dt, env, payload }) e usam só
//   dados fictícios (pasta pessoal "fulano", ids gerados por hash de rótulos).
// - O proxy reescreve o Host para o do servidor (o servidor só aceita a própria
//   porta), registra cada requisição e o que o servidor mandou em cada /events,
//   e deixa derrubar as conexões SSE e segurar as novas até liberar.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { injectScenario } from '../../scripts/inject-fixture.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Pasta de projeto fictícia dos cenários. */
export const PROJECT_DIR = 'C:\\Users\\fulano\\Projetos\\agents-quest';
export const OTHER_PROJECT_DIR = 'C:\\Users\\fulano\\Projetos\\outro-projeto';

/** @returns {Promise<number>} */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * @param {() => Promise<boolean>|boolean} check
 * @param {string} what
 * @param {number} [timeoutMs]
 */
export async function waitFor(check, what, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      // ainda não
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`tempo esgotado esperando ${what}`);
}

/**
 * Servidor real só do teste.
 * @param {{ port?: number, home?: string }} [options]
 */
export async function startLiveServer(options = {}) {
  const home = options.home ?? mkdtempSync(path.join(tmpdir(), 'aq-e2e-qa-'));
  const port = options.port ?? await freePort();
  const child = spawn(process.execPath, ['server/main.js', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, AGENT_QUEST_HOME: home, USERPROFILE: home, HOME: home },
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  /** @type {{ port: number, token: string, pid: number }|null} */
  let runtime = null;
  try {
    await waitFor(async () => {
      const parsed = JSON.parse(readFileSync(path.join(home, 'runtime.json'), 'utf8'));
      if (parsed.pid !== child.pid) return false;
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      runtime = parsed;
      return response.ok;
    }, 'o servidor de teste subir', 25_000);
    if (!runtime) throw new Error('runtime.json ausente');
  } catch (err) {
    // Sem servidor pronto, o processo deste teste não pode ficar para trás.
    child.kill();
    await exited;
    throw err;
  }
  const token = /** @type {{ token: string }} */ (runtime).token;
  let stopped = false;
  return {
    home,
    port,
    token,
    base: `http://127.0.0.1:${port}`,
    /** Para o servidor (o processo dele, nunca outro). */
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
      await exited;
    },
    /** Para o servidor e apaga a pasta temporária. */
    async dispose() {
      await this.stop();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // no Windows o processo pode ainda estar saindo; a pasta temporária fica para o sistema
      }
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof startLiveServer>>} LiveServer */

/**
 * Estado do servidor (o mesmo do snapshot).
 * @param {number} port
 * @returns {Promise<{ seq: number, sessions: any[] }>}
 */
export async function serverState(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  return /** @type {any} */ (await response.json());
}

/**
 * Espera o servidor terminar de processar (o seq para de mudar entre duas
 * leituras) e devolve o estado.
 * @param {number} port
 */
export async function settledState(port) {
  let previous = -1;
  /** @type {{ seq: number, sessions: any[] }|null} */
  let state = null;
  await waitFor(async () => {
    state = await serverState(port);
    const stable = state.seq === previous;
    previous = state.seq;
    if (!stable) await new Promise((resolve) => setTimeout(resolve, 150));
    return stable;
  }, 'o servidor processar a fila');
  return /** @type {{ seq: number, sessions: any[] }} */ (/** @type {unknown} */ (state));
}

/**
 * Injeta um cenário (pelo injetor do T9b) e espera o servidor processar tudo.
 * @param {LiveServer} server
 * @param {{ events: any[] }} scenario
 * @param {{ fast?: boolean, speed?: number }} [options]
 */
export async function inject(server, scenario, options = { fast: true }) {
  const result = await injectScenario(/** @type {any} */ (scenario), { port: server.port, token: server.token, ...options });
  if (result.refused.length > 0) throw new Error(`eventos recusados: ${JSON.stringify(result.refused.slice(0, 5))}`);
  return settledState(server.port);
}

// ---------------------------------------------------------------------------
// Cenários fictícios (formato do ADR 0010)
// ---------------------------------------------------------------------------

const hex = (/** @type {string} */ label, /** @type {number} */ length) => createHash('sha256').update(label).digest('hex').slice(0, length);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** UUID fictício e estável para um rótulo. */
export function uuid(/** @type {string} */ label) {
  const h = hex(`uuid:${label}`, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** agent_id fictício ("a" + 16 hexadecimais). */
export const agentIdFor = (/** @type {string} */ label) => `a${hex(`agent:${label}`, 16)}`;

const toolUseIdFor = (/** @type {string} */ label) =>
  `toolu_01${[...createHash('sha256').update(`tool:${label}`).digest()].slice(0, 22).map((b) => BASE62[b % 62]).join('')}`;

/**
 * @typedef {{ id: string, type: string }} ScenarioAgent
 * @typedef {{ id: string, name: string, input: Record<string, unknown>, agent?: ScenarioAgent }} ScenarioCall
 */

/**
 * Monta um cenário de uma sessão, evento a evento.
 * `transcriptDir` (T16): pasta do transcript da sessão principal, para a sonda
 * de contexto ler um transcript sintético (dentro de `<home>/.claude/projects`
 * do servidor de teste). Sem ela, o caminho é fictício e a sonda não lê nada.
 * @param {{ label: string, projectDir?: string, entrypoint?: string, dt?: number, transcriptDir?: string }} options
 */
export function createScenario({ label, projectDir = PROJECT_DIR, entrypoint = 'cli', dt = 15, transcriptDir }) {
  const sessionId = uuid(`sessao:${label}`);
  const transcriptPath = transcriptDir
    ? path.join(transcriptDir, `${sessionId}.jsonl`)
    : `${projectDir}\\.transcripts\\${sessionId}.jsonl`;
  /** @type {{ dt: number, env: { projectDir: string, entrypoint: string }, payload: Record<string, unknown> }[]} */
  const events = [];
  /** @type {string|null} */
  let promptId = null;
  let calls = 0;
  const env = { projectDir, entrypoint };

  /**
   * @param {string} hook
   * @param {ScenarioAgent} [agent]
   */
  const base = (hook, agent) => ({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: projectDir,
    permission_mode: 'default',
    hook_event_name: hook,
    ...(promptId ? { prompt_id: promptId } : {}),
    ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
  });
  /** @param {Record<string, unknown>} payload */
  const push = (payload) => {
    events.push({ dt: events.length === 0 ? 0 : dt, env, payload });
  };

  const api = {
    sessionId,
    transcriptPath,
    events,
    /** Agente fictício desta sessão. */
    agent(/** @type {string} */ name, /** @type {string} */ type) {
      return /** @type {ScenarioAgent} */ ({ id: agentIdFor(`${label}:${name}`), type });
    },
    start() {
      push({ ...base('SessionStart'), source: 'startup', model: 'modelo-ficticio' });
      return api;
    },
    prompt(/** @type {string} */ text) {
      promptId = uuid(`prompt:${label}:${events.length}`);
      push({ ...base('UserPromptSubmit'), prompt: text });
      return api;
    },
    /**
     * PreToolUse de uma chamada.
     * @param {string} name
     * @param {Record<string, unknown>} input
     * @param {ScenarioAgent} [agent]
     * @returns {ScenarioCall}
     */
    pre(name, input, agent) {
      const call = { id: toolUseIdFor(`${label}:${++calls}`), name, input, agent };
      push({ ...base('PreToolUse', agent), tool_name: name, tool_input: input, tool_use_id: call.id });
      return call;
    },
    /** @param {ScenarioCall} call @param {Record<string, unknown>} [response] */
    post(call, response = {}) {
      push({ ...base('PostToolUse', call.agent), tool_name: call.name, tool_input: call.input, tool_response: response, tool_use_id: call.id, duration_ms: 5 });
      return api;
    },
    /** @param {ScenarioCall} call @param {string} error */
    fail(call, error) {
      push({ ...base('PostToolUseFailure', call.agent), tool_name: call.name, tool_input: call.input, tool_use_id: call.id, error, duration_ms: 5 });
      return api;
    },
    /**
     * Ferramenta completa (Pre e Post, ou Pre e falha).
     * @param {string} name
     * @param {Record<string, unknown>} input
     * @param {{ agent?: ScenarioAgent, error?: string, response?: Record<string, unknown> }} [options]
     */
    tool(name, input, { agent, error, response } = {}) {
      const call = api.pre(name, input, agent);
      if (error !== undefined) api.fail(call, error);
      else api.post(call, response ?? {});
      return api;
    },
    /**
     * Delegação: PreToolUse do Agent em quem delega e SubagentStart do novo agente.
     * @param {ScenarioAgent} agent
     * @param {string} description
     * @param {{ parent?: ScenarioAgent }} [options]
     */
    delegate(agent, description, { parent } = {}) {
      const call = api.pre('Agent', { description, prompt: 'PEDIDO-FICTICIO', subagent_type: agent.type }, parent);
      push({ ...base('SubagentStart', agent) });
      return call;
    },
    /**
     * Fim do subagente: SubagentStop e o PostToolUse do Agent em quem delegou.
     * @param {ScenarioAgent} agent
     * @param {ScenarioCall} call
     */
    finish(agent, call) {
      push({
        ...base('SubagentStop', agent), stop_hook_active: false,
        agent_transcript_path: `${projectDir}\\.transcripts\\agent-${agent.id}.jsonl`,
        last_assistant_message: 'RESPOSTA-FICTICIA', background_tasks: [], session_crons: [],
      });
      api.post(call, { status: 'completed', agentId: agent.id, content: [{ type: 'text', text: 'RESULTADO-FICTICIO' }] });
      return api;
    },
    /**
     * Evento qualquer (por exemplo PermissionRequest), com os campos comuns.
     * @param {string} hook
     * @param {Record<string, unknown>} [extra]
     * @param {ScenarioAgent} [agent]
     */
    raw(hook, extra = {}, agent) {
      push({ ...base(hook, agent), ...extra });
      return api;
    },
    /**
     * Pedido de aprovação de uma chamada já começada (PermissionRequest).
     * @param {ScenarioCall} call
     */
    permission(call) {
      push({
        ...base('PermissionRequest', call.agent), tool_name: call.name, tool_input: call.input,
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: call.name, ruleContent: 'node -e:*' }], behavior: 'allow', destination: 'localSettings' }],
      });
      return api;
    },
    stop() {
      push({ ...base('Stop'), stop_hook_active: false, last_assistant_message: 'RESPOSTA-FICTICIA', background_tasks: [], session_crons: [] });
      return api;
    },
    end() {
      push({ ...base('SessionEnd'), reason: 'prompt_input_exit' });
      return api;
    },
    /** Marca a posição atual, para injetar o cenário em partes. */
    mark() {
      return events.length;
    },
    /** Parte do cenário, de `from` até `to` (exclusivo). */
    part(/** @type {number} */ from, /** @type {number} */ to = events.length) {
      return { events: events.slice(from, to) };
    },
  };
  return api;
}

/**
 * Junta cenários de sessões diferentes, alternando os eventos (duas sessões ao
 * mesmo tempo).
 * @param {...{ events: any[] }} scenarios
 */
export function interleave(...scenarios) {
  const events = [];
  const longest = Math.max(...scenarios.map((s) => s.events.length));
  for (let i = 0; i < longest; i++) {
    for (const scenario of scenarios) {
      if (i < scenario.events.length) events.push(scenario.events[i]);
    }
  }
  return { events };
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

/**
 * Ids das linhas visíveis do feed, de cima para baixo.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
export const visibleIds = (page) =>
  page.locator('#feed-entries li.entry:not([hidden])').evaluateAll((nodes) => nodes.map((node) => String(node.getAttribute('data-id'))));

/**
 * Ids do feed de uma sessão no servidor, mais recentes primeiro, que passam no filtro.
 * @param {any} session
 * @param {(event: any) => boolean} [keep]
 * @returns {string[]}
 */
export const expectedIds = (session, keep = () => true) =>
  [...session.feed].filter(keep).sort((a, b) => b.seq - a.seq).map((e) => e.id);

/**
 * Espera o painel mostrar o feed da sessão igual ao do servidor.
 * @param {import('@playwright/test').Page} page
 * @param {any} session
 */
export async function waitPanelFeed(page, session) {
  const ids = expectedIds(session);
  await waitFor(async () => JSON.stringify(await page.locator('#feed-entries li.entry').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-id')))) === JSON.stringify(ids),
    `o painel mostrar as ${ids.length} linhas da sessão ${session.id}`);
}

/**
 * Passa a registrar, na página, as animações que começam e as linhas que
 * entram e saem do feed.
 * @param {import('@playwright/test').Page} page
 */
export async function recordFeed(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    // Os observadores são ligados uma vez por documento; chamar de novo só zera os registros.
    if (w.__qa) {
      Object.assign(w.__qa, { animations: [], added: [], removed: [], partyRedraws: 0 });
      return;
    }
    w.__qa = { animations: [], added: [], removed: [], partyRedraws: 0 };
    const list = document.getElementById('feed-entries');
    const party = document.getElementById('party');
    if (!list || !party) throw new Error('feed ou equipe ausentes');
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches('li.entry')) w.__qa.added.push({ id: node.dataset.id, isNew: node.classList.contains('is-new'), hidden: node.hidden });
        }
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement && node.matches('li.entry')) w.__qa.removed.push(node.dataset.id);
        }
      }
    }).observe(list, { childList: true });
    new MutationObserver((records) => {
      if (records.some((record) => record.target === party)) w.__qa.partyRedraws++;
    }).observe(party, { childList: true });
    document.addEventListener('animationstart', (event) => w.__qa.animations.push(/** @type {AnimationEvent} */ (event).animationName), true);
  });
}

/** @param {import('@playwright/test').Page} page */
export const recorded = (page) => page.evaluate(() => /** @type {any} */ (window).__qa);

/** @param {import('@playwright/test').Page} page */
export const resetRecord = (page) => page.evaluate(() => {
  const qa = /** @type {any} */ (window).__qa;
  qa.animations = [];
  qa.added = [];
  qa.removed = [];
  qa.partyRedraws = 0;
});

// ---------------------------------------------------------------------------
// Proxy que corta só o SSE
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ProxiedRequest
 * @property {string} method
 * @property {string} url
 * @property {string|null} lastEventId
 * @property {number|null} status
 * @property {string} body        o que o servidor mandou (só /events e /api/state)
 */

/**
 * Proxy HTTP na frente do servidor. O painel abre pelo endereço do proxy.
 * @param {number} serverPort
 */
export async function startSseProxy(serverPort) {
  /** @type {ProxiedRequest[]} */
  const requests = [];
  /** @type {Set<{ res: import('node:http').ServerResponse, upstream: import('node:http').ClientRequest }>} */
  const streams = new Set();
  /** @type {(() => void)[]} */
  const held = [];
  let holding = false;

  const server = http.createServer((req, res) => {
    const url = String(req.url);
    const isEvents = url === '/events' || url.startsWith('/events?');
    const lastEventId = req.headers['last-event-id'];
    /** @type {ProxiedRequest} */
    const record = { method: String(req.method), url, lastEventId: typeof lastEventId === 'string' ? lastEventId : null, status: null, body: '' };
    requests.push(record);
    const forward = () => {
      const headers = { ...req.headers, host: `127.0.0.1:${serverPort}` };
      if (typeof headers.origin === 'string') headers.origin = `http://127.0.0.1:${serverPort}`;
      const upstream = http.request({ host: '127.0.0.1', port: serverPort, method: req.method, path: url, headers, agent: false }, (upRes) => {
        record.status = upRes.statusCode ?? 0;
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.on('data', (chunk) => {
          if (isEvents || url.startsWith('/api/state')) record.body += chunk.toString('utf8');
          res.write(chunk);
        });
        upRes.on('end', () => res.end());
        upRes.on('error', () => res.destroy());
      });
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
      if (isEvents) {
        const entry = { res, upstream };
        streams.add(entry);
        res.on('close', () => {
          streams.delete(entry);
          upstream.destroy();
        });
      }
    };
    if (isEvents && holding) held.push(forward);
    else forward();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    requests,
    /** Conexões SSE abertas pelo proxy. */
    openStreams: () => streams.size,
    /** Derruba as conexões SSE abertas e segura as próximas até `release`. */
    cut() {
      holding = true;
      for (const { res, upstream } of streams) {
        res.socket?.destroy();
        upstream.destroy();
      }
      streams.clear();
    },
    /** Quantas reconexões estão seguras. */
    heldCount: () => held.length,
    /** Deixa passar as reconexões seguras e as próximas. */
    release() {
      holding = false;
      for (const forward of held.splice(0)) forward();
    },
    async close() {
      for (const { res, upstream } of streams) {
        res.socket?.destroy();
        upstream.destroy();
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * Mensagens SSE de um corpo de /events: [{ event, id, data }], na ordem.
 * @param {string} body
 */
export function parseSse(body) {
  /** @type {{ event: string, id: string|null, data: any }[]} */
  const messages = [];
  for (const block of body.split(/\n\n/)) {
    const lines = block.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
    if (lines.length === 0) continue;
    let event = 'message';
    /** @type {string|null} */
    let id = null;
    const data = [];
    for (const line of lines) {
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      parsed = data.join('\n');
    }
    messages.push({ event, id, data: parsed });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Contraste medido na página (WCAG 2.2; complemento do ADR 0009)
// ---------------------------------------------------------------------------

/**
 * Mede, na página, o contraste do texto de cada elemento contra o fundo
 * composto (camadas translúcidas sobre o primeiro fundo opaco).
 * @param {string[]} selectors
 */
export function measure(selectors) {
  /** @param {string} value */
  const parse = (value) => {
    const v = value.trim();
    let m = v.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
    }
    m = v.match(/^color\(srgb\s+([^)]+)\)$/);
    if (m) {
      const [rgb, alpha] = m[1].split('/');
      const p = rgb.trim().split(/\s+/).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: alpha === undefined ? 1 : Number(alpha) };
    }
    throw new Error(`cor não reconhecida: ${v}`);
  };
  /** @param {{r:number,g:number,b:number,a:number}} top @param {{r:number,g:number,b:number}} under */
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  /** @param {Element} el */
  const backgroundOf = (el) => {
    const layers = [];
    for (let node = /** @type {Element|null} */ (el); node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color.a > 0) layers.push(color);
      if (color.a >= 1) break;
    }
    let result = { r: 1, g: 1, b: 1, a: 1 };
    if (layers.length && layers[layers.length - 1].a >= 1) result = layers.pop() ?? result;
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };
  /** @param {{r:number,g:number,b:number}} c */
  const luminance = (c) => {
    const f = (/** @type {number} */ x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  /** @param {{r:number,g:number,b:number}} a @param {{r:number,g:number,b:number}} b */
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const results = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!(el instanceof HTMLElement) || el.offsetParent === null) continue;
      const style = getComputedStyle(el);
      const bg = backgroundOf(el);
      const fg = over(parse(style.color), bg);
      results.push({ selector, text: (el.textContent ?? '').trim().slice(0, 30), ratio: Math.round(ratio(fg, bg) * 100) / 100 });
    }
  }
  return results;
}

/**
 * Indicadores não textuais: contorno de foco e borda do chip apertado contra o
 * fundo ao redor (o do pai).
 * @param {{ selector: string, property: 'outlineColor'|'borderTopColor' }} params
 */
export function measureIndicator({ selector, property }) {
  /** @param {string} value */
  const parse = (value) => {
    const v = value.trim();
    let m = v.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
    }
    m = v.match(/^color\(srgb\s+([^)]+)\)$/);
    if (m) {
      const [rgb, alpha] = m[1].split('/');
      const p = rgb.trim().split(/\s+/).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: alpha === undefined ? 1 : Number(alpha) };
    }
    throw new Error(`cor não reconhecida: ${v}`);
  };
  const over = (/** @type {any} */ top, /** @type {any} */ under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const backgroundOf = (/** @type {Element} */ el) => {
    const layers = [];
    for (let node = /** @type {Element|null} */ (el); node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color.a > 0) layers.push(color);
      if (color.a >= 1) break;
    }
    let result = { r: 1, g: 1, b: 1, a: 1 };
    if (layers.length && layers[layers.length - 1].a >= 1) result = layers.pop() ?? result;
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };
  const luminance = (/** @type {any} */ c) => {
    const f = (/** @type {number} */ x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (/** @type {any} */ a, /** @type {any} */ b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const el = document.querySelector(selector);
  if (!el || !el.parentElement) return null;
  const around = backgroundOf(el.parentElement);
  const color = over(parse(getComputedStyle(el)[property]), around);
  return Math.round(ratio(color, around) * 100) / 100;
}
