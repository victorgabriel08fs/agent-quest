// T15 (tester): sonda de contexto de ponta a ponta e contra o contrato
// (modelo de eventos, seção 6, "Contexto", e seção 9; ADR 0006 e ADR 0008).
//
// 1. Fuzz do estado: fatos aleatórios do `apply` intercalados com leituras da
//    sonda (`setContextUsage`), com as invariantes de state-helpers.js, que a
//    partir do T15 aceitam `context` preenchido e o `context.usage`.
// 2. Servidor real (`node server/main.js`, outro processo) com a pasta pessoal
//    temporária: POST /hooks com `transcript_path` para um transcript SINTÉTICO
//    em <home temporária>/.claude/projects → `context.usage` no SSE e
//    `context` no /api/state. Também pelo encaminhador real.
// 3. Restrição de caminho de ponta a ponta: `..`, junção, fluxo alternativo
//    (ADS, com `:`), outra extensão, UNC, letra da unidade em outra caixa.
// 4. No máximo uma leitura por agente a cada 5 s, com o relógio real.
//
// Nada usa a pasta real ~/.claude/projects, o diretório de dados real nem a
// porta 47821: AGENT_QUEST_HOME, USERPROFILE e HOME apontam para uma pasta
// temporária, e a porta é a 0.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEED_KINDS } from '../../shared/contract.js';
import { normalize } from '../../server/domain/normalize.js';
import { apply, getSessionStates, setContextUsage, tick } from '../../server/domain/state/index.js';
import { contextUsage } from '../../server/usage/transcript-usage.js';
import { forwarderEnv, runForwarder, assertSilentExit } from './capture-helpers.js';
import { killTree, launchServer, minimalEnv, request, tempDir, waitFor } from './server-helpers.js';
import {
  HOME,
  MIN,
  T0,
  Tracker,
  checkEvent,
  checkSession,
  checkState,
  fuzzTools,
  newState,
  randomEnvelope,
  rng,
} from './state-helpers.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/transcripts/', import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const jsonl = (lines) => lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';

/**
 * Resposta SINTÉTICA com `usage`. O modelo padrão é de uma família de 200 mil
 * (seção 6, "Janela"), para as porcentagens pequenas continuarem visíveis.
 */
const assistant = (input, { creation = 0, read = 0, sidechain = false, model = 'claude-sonnet-4-5-20250929' } = {}) => ({
  type: 'assistant',
  isSidechain: sidechain,
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'RESPOSTA-SINTETICA' }], usage: { input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: 1 } },
});
const userLine = (text = 'PEDIDO-SINTETICO') => ({ type: 'user', message: { role: 'user', content: text } });

let ids = 0;
const newSessionId = () => `7e150000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const newAgentId = () => `a7e15${String(++ids).padStart(12, '0')}`;

// ---------------------------------------------------------------------------
// 1. Fuzz do estado com leituras da sonda
// ---------------------------------------------------------------------------

describe('T15 integração: estado com leituras da sonda intercaladas (fuzz)', () => {
  it('apply, tick e setContextUsage em ordem aleatória mantêm o contrato da seção 9', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const random = rng(1500 + seed);
      const state = newState({ homeDir: HOME });
      const tracker = new Tracker({ numbered: true });
      const toolFor = fuzzTools(random);
      // Como no Claude Code, Pre, Post e Failure da mesma chamada trazem o mesmo
      // tool_input. O randomEnvelope sorteia um por evento, e um Pre de `ls` com
      // um Post de `npm test` daria um test.finished numa chamada bash.
      const inputFor = new Map();
      let now = T0;
      let lastSeq = 0;
      let reads = 0;
      let usageEvents = 0;
      const seqOk = (events) => {
        for (const event of events) {
          assert.ok(event.seq > lastSeq, `seq ${event.seq} depois de ${lastSeq}`);
          lastSeq = event.seq;
        }
      };
      for (let step = 0; step < 300; step++) {
        now += Math.floor(random() * 2000);
        const r = random();
        if (r < 0.6) {
          const envelope = randomEnvelope(random, now, { toolFor });
          const call = envelope.payload?.tool_use_id;
          if (typeof call === 'string') {
            if (inputFor.has(call)) envelope.payload.tool_input = inputFor.get(call);
            else inputFor.set(call, envelope.payload.tool_input);
          }
          const fact = normalize(envelope, { receivedAt: now, homeDir: HOME });
          if (!fact) continue;
          const result = apply(state, fact, now);
          tracker.consume(result.events, fact);
          seqOk(result.events);
        } else if (r < 0.95) {
          // Uma leitura da sonda para um agente qualquer (existente ou não).
          const sessions = getSessionStates(state, { feed: false });
          const session = sessions.length && random() < 0.9 ? sessions[Math.floor(random() * sessions.length)] : { id: 'sessao-que-nao-existe', agents: [{ key: 'main' }] };
          const agentKey = random() < 0.9 ? session.agents[Math.floor(random() * session.agents.length)]?.key ?? 'main' : 'agente-desconhecido';
          const before = state.sessions.get(session.id) ? getSessionStates(state, { feed: true }).find((s) => s.id === session.id) : null;
          const options = [
            () => contextUsage(Math.floor(random() * 1_500_000) + 1, { requested: random() < 0.2 ? 'modelo[1m]' : null, observed: random() < 0.5 ? 'claude-opus-4-6' : 'claude-opus-5-5' }),
            () => contextUsage([1000, 50_000, 199_999][Math.floor(random() * 3)]),
            () => null,
            () => ({ pct: -1, usedTokens: 10, windowTokens: 200_000 }),
            () => ({ pct: 10, usedTokens: 1.5, windowTokens: 200_000 }),
            () => ({ pct: 10, usedTokens: 10, windowTokens: 0 }),
            () => 'texto',
          ];
          const usage = options[Math.floor(random() * options.length)]();
          const result = setContextUsage(state, session.id, agentKey, usage, now);
          reads++;
          tracker.consume(result.events, null, { source: 'context' });
          seqOk(result.events);
          usageEvents += result.events.length;
          assert.ok(result.events.length <= 1);
          if (before) {
            const afterView = getSessionStates(state, { feed: true }).find((s) => s.id === session.id);
            // A leitura não mexe em nada além do `context` do agente.
            assert.equal(afterView.lastEventAt, before.lastEventAt, 'setContextUsage mudou o lastEventAt da sessão');
            assert.equal(afterView.status, before.status, 'setContextUsage mudou o status da sessão');
            assert.deepEqual(afterView.feed, before.feed, 'setContextUsage mudou o feed');
            const strip = (s) => s.agents.map(({ context, ...rest }) => rest);
            assert.deepEqual(strip(afterView), strip(before), 'setContextUsage mudou outro campo dos agentes');
            assert.equal(result.changed.length > 0 || result.events.length > 0, JSON.stringify(afterView.agents) !== JSON.stringify(before.agents));
          } else {
            assert.deepEqual(result, { events: [], changed: [] });
          }
          for (const event of result.events) {
            assert.equal(event.kind, 'context.usage');
            assert.equal(event.ts, now, 'o ts do context.usage é a hora da leitura');
            const agentState = getSessionStates(state, { feed: false }).find((s) => s.id === event.sessionId).agents.find((a) => a.key === event.agentKey);
            assert.deepEqual(agentState.context, { ...event.data, at: now });
          }
        } else {
          const result = tick(state, now + Math.floor(random() * 3) * 10 * MIN);
          tracker.consume(result.events, null);
          tracker.removed(result.removed);
          seqOk(result.events);
        }
        checkState(state);
      }
      for (const session of getSessionStates(state, { feed: true })) {
        assert.ok(!session.feed.some((event) => event.kind === 'context.usage'), 'context.usage no feed');
      }
      assert.ok(reads > 50, `seed ${seed}: poucas leituras (${reads})`);
      if (seed === 20) assert.ok(usageEvents > 0, 'o fuzz nunca produziu um context.usage');
    }
  });
});

// ---------------------------------------------------------------------------
// 2 a 4. Servidor real
// ---------------------------------------------------------------------------

/** Cliente SSE mínimo: guarda `event`, `id` e `data` de cada mensagem, com a hora de chegada. */
function openEvents(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
      const messages = [];
      const waiters = new Set();
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const at = Date.now();
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const message = { at };
          for (const line of block.split('\n')) {
            const colon = line.indexOf(':');
            if (colon <= 0) continue;
            message[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          if (message.data) message.data = JSON.parse(message.data);
          if (message.event) messages.push(message);
        }
        for (const check of [...waiters]) check();
      });
      resolve({
        status: res.statusCode,
        messages,
        close: () => req.destroy(),
        waitFor(predicate, timeoutMs) {
          return new Promise((done) => {
            const finish = (value) => {
              clearTimeout(timer);
              waiters.delete(check);
              done(value);
            };
            const check = () => {
              const found = messages.find(predicate);
              if (found) finish(found);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            waiters.add(check);
            check();
          });
        },
      });
    });
    req.on('error', reject);
  });
}

describe('T15 ponta a ponta: POST /hooks → sonda de contexto → SSE e /api/state (servidor real)', () => {
  let temp;
  let home;
  let root;
  let projectDir;
  let outside;
  let server;
  let runtime;
  let sse;

  before(async () => {
    temp = tempDir('aq-int-t15-');
    home = temp.dir;
    root = path.join(home, '.claude', 'projects');
    projectDir = path.join(home, 'Projetos', 'exemplo-t15');
    outside = path.join(home, 'fora');
    mkdirSync(path.join(root, 'c--Projetos-exemplo-t15'), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    server = launchServer(['--port', '0'], minimalEnv({ AGENT_QUEST_HOME: home, USERPROFILE: home, HOME: home }));
    assert.equal(await server.started, true, server.output());
    runtime = await waitFor(() => {
      try {
        return JSON.parse(readFileSync(path.join(home, 'runtime.json'), 'utf8'));
      } catch {
        return null;
      }
    }, { label: 'runtime.json do servidor' });
    sse = await openEvents(runtime.port);
    assert.equal(sse.status, 200);
    assert.ok(await sse.waitFor((m) => m.event === 'snapshot', 3000), 'snapshot na conexão');
  });

  after(async () => {
    sse?.close();
    if (server) await killTree(server.child);
    temp?.cleanup();
  });

  const projectFolder = () => path.join(root, 'c--Projetos-exemplo-t15');

  /** Grava um transcript e devolve o caminho. */
  function transcript(file, lines) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, jsonl(lines));
    return file;
  }

  function post(payload, { headers = {}, sentAt = Date.now() } = {}) {
    const body = JSON.stringify({ v: 1, sentAt, forwarder: '0.1.0', env: { projectDir, entrypoint: null }, truncated: false, payload });
    return request(runtime.port, {
      method: 'POST',
      path: '/hooks',
      headers: { 'content-type': 'application/json', 'x-agent-quest-token': runtime.token, 'content-length': Buffer.byteLength(body), ...headers },
      body,
    });
  }

  let tools = 0;
  /** Pre e Post de uma ferramenta (o Post gera o `tool.finished`, que pede a leitura). */
  async function toolDone(sessionId, transcriptPath, extra = {}) {
    const toolUseId = `toolu_01T15${String(++tools).padStart(19, '0')}`;
    const base = { session_id: sessionId, transcript_path: transcriptPath, cwd: projectDir, tool_name: 'Read', tool_input: { file_path: path.join(projectDir, 'a.js') }, tool_use_id: toolUseId, ...extra };
    assert.equal((await post({ ...base, hook_event_name: 'PreToolUse' })).status, 204);
    assert.equal((await post({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: 'SAIDA-SINTETICA' } })).status, 204);
    return toolUseId;
  }

  async function sessionStart(sessionId, transcriptPath, extra = {}) {
    assert.equal((await post({ hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcriptPath, cwd: projectDir, source: 'startup', ...extra })).status, 204);
  }

  const usageOf = (sessionId, agentKey = 'main') => (m) => m.event === 'update' && m.data.event?.kind === 'context.usage' && m.data.event.sessionId === sessionId && m.data.event.agentKey === agentKey;
  const usagesOf = (sessionId, agentKey = 'main') => sse.messages.filter(usageOf(sessionId, agentKey));

  async function apiState() {
    const res = await request(runtime.port, { path: '/api/state' });
    assert.equal(res.status, 200);
    return JSON.parse(res.text);
  }
  const agentFrom = (state, sessionId, agentKey = 'main') => state.sessions.find((s) => s.id === sessionId)?.agents.find((a) => a.key === agentKey);

  it('sessão principal: tool.finished lê o transcript_path; o update leva context.usage e o context do agente; o /api/state bate', async () => {
    const sid = newSessionId();
    const fx = fixture('principal-basico');
    const file = transcript(path.join(projectFolder(), `${sid}.jsonl`), fx.lines);
    await sessionStart(sid, file, { model: 'claude-opus-5-5' });
    await toolDone(sid, file);
    const message = await sse.waitFor(usageOf(sid), 3000);
    assert.ok(message, 'context.usage não chegou ao SSE');
    const { event, session } = message.data;
    checkEvent(event, { numbered: true });
    checkSession(session, { feed: false });
    assert.equal(message.id, event.id);
    assert.equal(event.seq, message.data.seq);
    assert.deepEqual(event.data, fx.expected);
    const main = session.agents.find((a) => a.key === 'main');
    assert.deepEqual(main.context, { ...fx.expected, at: event.ts });

    const state = await apiState();
    for (const s of state.sessions) checkSession(s, { feed: true });
    assert.deepEqual(agentFrom(state, sid).context, main.context);
    const snapshotSession = state.sessions.find((s) => s.id === sid);
    assert.ok(!snapshotSession.feed.some((e) => e.kind === 'context.usage'), 'context.usage no feed do /api/state');
    assert.ok(!FEED_KINDS.includes('context.usage'));
    // Nada do conteúdo do transcript chega ao estado: só os três números.
    assert.ok(!JSON.stringify(state).includes('RESPOSTA-SINTETICA') && !JSON.stringify(state).includes('PEDIDO-SINTETICO'));
    // O caminho do transcript nunca vai ao painel.
    assert.ok(!JSON.stringify(state).includes(`${sid}.jsonl`), 'transcript_path no /api/state');
    assert.ok(!sse.messages.some((m) => JSON.stringify(m.data).includes('.claude')), 'caminho do transcript no SSE');
  });

  it('pelo encaminhador real (como o Claude Code o roda): o PostToolUse leva ao context.usage', async () => {
    const sid = newSessionId();
    const file = transcript(path.join(projectFolder(), `${sid}.jsonl`), [userLine(), assistant(1000, { read: 79_000 })]);
    const env = forwarderEnv({ AGENT_QUEST_HOME: home });
    const payload = { session_id: sid, transcript_path: file, cwd: projectDir, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_use_id: `toolu_01T15fw${String(++tools).padStart(17, '0')}`, tool_response: {} };
    const result = await runForwarder({ env, stdin: JSON.stringify(payload) });
    assertSilentExit(result, 'encaminhador');
    const message = await sse.waitFor(usageOf(sid), 3000);
    assert.ok(message, 'context.usage não chegou pelo encaminhador');
    assert.deepEqual(message.data.event.data, { pct: 40, usedTokens: 80_000, windowTokens: 200_000 });
  });

  it('janela: [1m] no modelo pedido dá 1 milhão; resposta num modelo com 1M nativo (sem [1m]) também; uso acima de 200 mil também', async () => {
    const sid = newSessionId();
    const file = transcript(path.join(projectFolder(), `${sid}.jsonl`), [userLine(), assistant(10_000, { read: 90_000 })]);
    await sessionStart(sid, file, { model: 'claude-opus-5-5[1m]' });
    await toolDone(sid, file);
    const message = await sse.waitFor(usageOf(sid), 3000);
    assert.deepEqual(message?.data.event.data, { pct: 10, usedTokens: 100_000, windowTokens: 1_000_000 });

    const big = newSessionId();
    const bigFile = transcript(path.join(projectFolder(), `${big}.jsonl`), [userLine(), assistant(5_000, { creation: 5_000, read: 290_000 })]);
    await sessionStart(big, bigFile, { model: 'claude-opus-5-5' });
    await toolDone(big, bigFile);
    const bigMessage = await sse.waitFor(usageOf(big), 3000);
    assert.deepEqual(bigMessage?.data.event.data, { pct: 30, usedTokens: 300_000, windowTokens: 1_000_000 });

    // O caso do próprio usuário (ADR 0008, complemento de 26/10/2026): claude-opus-5-5 sem [1m].
    const native = newSessionId();
    const nativeFile = transcript(path.join(projectFolder(), `${native}.jsonl`), [userLine(), assistant(10_000, { read: 140_000, model: 'claude-opus-5-5' })]);
    await sessionStart(native, nativeFile, { model: 'claude-opus-5-5' });
    await toolDone(native, nativeFile);
    const nativeMessage = await sse.waitFor(usageOf(native), 3000);
    assert.deepEqual(nativeMessage?.data.event.data, { pct: 15, usedTokens: 150_000, windowTokens: 1_000_000 });
  });

  it('subagente: tool.finished lê <pasta>/<session_id>/subagents/agent-<id>.jsonl; SubagentStop lê o agent_transcript_path', async () => {
    const sid = newSessionId();
    const main = transcript(path.join(projectFolder(), `${sid}.jsonl`), [userLine(), assistant(1000, { read: 9000 })]);
    const aid = newAgentId();
    transcript(path.join(projectFolder(), sid, 'subagents', `agent-${aid}.jsonl`), [userLine(), assistant(2000, { read: 18_000 })]);
    await sessionStart(sid, main);
    assert.equal((await post({ hook_event_name: 'SubagentStart', session_id: sid, transcript_path: main, cwd: projectDir, agent_id: aid, agent_type: 'tester' })).status, 204);
    await toolDone(sid, main, { agent_id: aid, agent_type: 'tester' });
    const sub = await sse.waitFor(usageOf(sid, aid), 3000);
    assert.deepEqual(sub?.data.event.data, { pct: 10, usedTokens: 20_000, windowTokens: 200_000 });
    checkSession(sub.data.session, { feed: false });
    // O main não foi lido por causa do subagente.
    assert.equal(usagesOf(sid, 'main').length, 0);

    // Outro subagente: SubagentStop com agent_transcript_path (sem ferramenta antes).
    const other = newAgentId();
    const exact = transcript(path.join(projectFolder(), sid, 'subagents', `agent-${other}-exato.jsonl`), [userLine(), assistant(3000, { read: 27_000 })]);
    assert.equal((await post({ hook_event_name: 'SubagentStart', session_id: sid, transcript_path: main, cwd: projectDir, agent_id: other, agent_type: 'documentador' })).status, 204);
    assert.equal((await post({ hook_event_name: 'SubagentStop', session_id: sid, transcript_path: main, cwd: projectDir, agent_id: other, agent_type: 'documentador', agent_transcript_path: exact, last_assistant_message: 'TEXTO-DO-ASSISTENTE' })).status, 204);
    const stopped = await sse.waitFor(usageOf(sid, other), 3000);
    assert.deepEqual(stopped?.data.event.data, { pct: 15, usedTokens: 30_000, windowTokens: 200_000 });
    const state = await apiState();
    assert.equal(agentFrom(state, sid, other).finished, true);
    assert.deepEqual(agentFrom(state, sid, other).context, { pct: 15, usedTokens: 30_000, windowTokens: 200_000, at: stopped.data.event.ts });
  });

  it('Stop e PostCompact leem o transcript da sessão principal; o transcript principal ignora entradas isSidechain', async () => {
    const sid = newSessionId();
    const file = transcript(path.join(projectFolder(), `${sid}.jsonl`), [userLine(), assistant(1000, { read: 39_000 }), assistant(150_000, { sidechain: true })]);
    await sessionStart(sid, file);
    assert.equal((await post({ hook_event_name: 'UserPromptSubmit', session_id: sid, transcript_path: file, cwd: projectDir, prompt: 'Fazer algo', prompt_id: '7e15aaaa-0000-4000-8000-000000000001' })).status, 204);
    assert.equal((await post({ hook_event_name: 'Stop', session_id: sid, transcript_path: file, cwd: projectDir, stop_hook_active: false, last_assistant_message: 'TEXTO' })).status, 204);
    const stop = await sse.waitFor(usageOf(sid), 3000);
    assert.deepEqual(stop?.data.event.data, { pct: 20, usedTokens: 40_000, windowTokens: 200_000 });

    const compact = newSessionId();
    const compactFile = transcript(path.join(projectFolder(), `${compact}.jsonl`), [userLine(), assistant(500, { read: 1500 })]);
    await sessionStart(compact, compactFile);
    assert.equal((await post({ hook_event_name: 'PreCompact', session_id: compact, transcript_path: compactFile, cwd: projectDir, trigger: 'manual' })).status, 204);
    assert.equal((await post({ hook_event_name: 'PostCompact', session_id: compact, transcript_path: compactFile, cwd: projectDir, trigger: 'manual' })).status, 204);
    const after = await sse.waitFor(usageOf(compact), 3000);
    assert.deepEqual(after?.data.event.data, { pct: 1, usedTokens: 2000, windowTokens: 200_000 });
  });

  it('Pre, Failure e PermissionRequest não leem; transcript ausente ou de formato desconhecido deixa o context null', async () => {
    const sid = newSessionId();
    const file = transcript(path.join(projectFolder(), `${sid}.jsonl`), [userLine(), assistant(1000)]);
    await sessionStart(sid, file);
    const base = { session_id: sid, transcript_path: file, cwd: projectDir, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: `toolu_01T15pf${String(++tools).padStart(17, '0')}` };
    await post({ ...base, hook_event_name: 'PreToolUse' });
    await post({ ...base, hook_event_name: 'PermissionRequest' });
    await post({ ...base, hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' });
    // Formato desconhecido e arquivo ausente, cada um numa sessão.
    const unknown = newSessionId();
    const unknownFile = transcript(path.join(projectFolder(), `${unknown}.jsonl`), fixture('formato-desconhecido').lines);
    await toolDone(unknown, unknownFile);
    const missing = newSessionId();
    await toolDone(missing, path.join(projectFolder(), `${missing}.jsonl`));
    // Controle no fim da fila: as leituras saem uma por vez, na ordem.
    const control = newSessionId();
    const controlFile = transcript(path.join(projectFolder(), `${control}.jsonl`), [assistant(2000)]);
    await toolDone(control, controlFile);
    assert.ok(await sse.waitFor(usageOf(control), 3000), 'controle');
    for (const id of [sid, unknown, missing]) {
      assert.equal(usagesOf(id).length, 0, `context.usage de ${id}`);
    }
    const state = await apiState();
    for (const id of [sid, unknown, missing]) assert.equal(agentFrom(state, id).context, null);
  });

  it('caminho: só .jsonl dentro de ~/.claude/projects; .., junção, fluxo alternativo (:), outra extensão e UNC não são lidos', async (t) => {
    // Valor que nenhum outro teste usa, para achar um vazamento no SSE.
    const valid = jsonl([userLine(), assistant(1000, { read: 98_765 })]);
    const secret = path.join(outside, 'segredo.jsonl');
    writeFileSync(secret, valid);
    writeFileSync(path.join(root, '..', 'acima.jsonl'), valid);
    const inside = path.join(projectFolder(), 'dentro.jsonl');
    writeFileSync(inside, jsonl([userLine(), assistant(1)]));
    // Fluxo alternativo com conteúdo válido, num arquivo de dentro sem usage.
    const plain = path.join(projectFolder(), 'sem-usage.jsonl');
    writeFileSync(plain, jsonl([userLine()]));
    let ads = true;
    try {
      writeFileSync(`${plain}:fluxo.jsonl`, valid);
    } catch {
      ads = false;
    }
    writeFileSync(path.join(projectFolder(), 'outro.json'), valid);
    writeFileSync(path.join(projectFolder(), 'outro.jsonl.txt'), valid);
    let junction = true;
    try {
      symlinkSync(outside, path.join(projectFolder(), 'atalho'), 'junction');
    } catch {
      junction = false;
      t.diagnostic('sem permissão para criar junção: caso pulado');
    }
    const BS = '\\';
    const negatives = {
      fora: secret,
      'acima da raiz': path.join(root, '..', 'acima.jsonl'),
      '.. cru que escapa': [projectFolder(), '..', '..', '..', 'fora', 'segredo.jsonl'].join(BS),
      '.. com barras normais': [projectFolder().replaceAll(BS, '/'), '..', '..', '..', 'fora', 'segredo.jsonl'].join('/'),
      '..::$INDEX_ALLOCATION': [projectFolder(), '..::$INDEX_ALLOCATION', '..::$INDEX_ALLOCATION', '..::$INDEX_ALLOCATION', 'fora', 'segredo.jsonl'].join(BS),
      'pasta-irmã com o mesmo prefixo': path.join(`${root}2`, 'p', 'x.jsonl'),
      'outra extensão (.json)': path.join(projectFolder(), 'outro.json'),
      'outra extensão (.jsonl.txt)': path.join(projectFolder(), 'outro.jsonl.txt'),
      'ponto no fim (.jsonl.)': `${inside}.`,
      'UNC para a própria máquina': `${BS}${BS}localhost${BS}${secret.replace(/^([A-Za-z]):/, '$1$')}`,
      'prefixo \\\\?\\ para fora': `${BS}${BS}?${BS}${secret}`,
      'dispositivo NUL.jsonl': path.join(projectFolder(), 'NUL.jsonl'),
      'caminho relativo': 'fora/segredo.jsonl',
      'texto vazio': '',
    };
    if (ads) negatives['fluxo alternativo (ADS)'] = `${plain}:fluxo.jsonl`;
    if (junction) negatives['junção para fora'] = path.join(projectFolder(), 'atalho', 'segredo.jsonl');
    t.diagnostic(`casos que não podem ser lidos: ${Object.keys(negatives).join('; ')}`);
    mkdirSync(path.join(`${root}2`, 'p'), { recursive: true });
    writeFileSync(path.join(`${root}2`, 'p', 'x.jsonl'), valid);

    const positives = {
      'letra da unidade minúscula': inside.replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`),
      'letra da unidade maiúscula': inside.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`),
      'barras normais': inside.replaceAll(BS, '/'),
      '.. que continua dentro': [projectFolder(), 'sub', '..', 'dentro.jsonl'].join(BS),
      'extensão em maiúsculas (.JSONL)': (() => {
        const upper = path.join(projectFolder(), 'MAIUSCULA.JSONL');
        writeFileSync(upper, jsonl([assistant(1)]));
        return upper;
      })(),
    };

    const sessions = {};
    for (const [label, file] of Object.entries(negatives)) {
      sessions[label] = newSessionId();
      await toolDone(sessions[label], file);
    }
    for (const [label, file] of Object.entries(positives)) {
      sessions[label] = newSessionId();
      await toolDone(sessions[label], file);
    }
    // As leituras saem uma por vez, na ordem dos pedidos: quando o último positivo chega, todas terminaram.
    for (const label of Object.keys(positives)) {
      const message = await sse.waitFor(usageOf(sessions[label]), 5000);
      assert.ok(message, `${label}: deveria ler`);
      assert.equal(message.data.event.data.usedTokens, 1, label);
    }
    const state = await apiState();
    const leaked = Object.keys(negatives).filter((label) => usagesOf(sessions[label]).length > 0 || agentFrom(state, sessions[label])?.context !== null);
    assert.deepEqual(leaked, [], `lidos fora da regra: ${leaked.join(', ')}`);
    // O valor dos arquivos de fora (99 765) não apareceu em lugar nenhum.
    assert.ok(!sse.messages.some((m) => m.data?.event?.kind === 'context.usage' && m.data.event.data.usedTokens === 99_765), 'valor do arquivo de fora no SSE');
  });

  it('eventos malformados: transcript_path que não é texto, gigante ou com \\0 não derruba nada e não lê', async () => {
    const values = [42, { path: 'x.jsonl' }, ['a.jsonl'], true, `${projectFolder()}\\${'a'.repeat(1100)}.jsonl`, `${path.join(projectFolder(), 'dentro.jsonl')}\0.txt`];
    const sessions = [];
    for (const value of values) {
      const sid = newSessionId();
      sessions.push(sid);
      await toolDone(sid, value);
    }
    // agent_id que tentaria mudar a pasta do transcript de subagente.
    const sid = newSessionId();
    const main = path.join(projectFolder(), `${sid}.jsonl`);
    for (const bad of ['..', 'a:b', 'a\\..\\..\\x', 'a/../../x']) {
      await toolDone(sid, main, { agent_id: bad, agent_type: 'tester' });
    }
    const control = newSessionId();
    await toolDone(control, transcript(path.join(projectFolder(), `${control}.jsonl`), [assistant(3)]));
    assert.ok(await sse.waitFor(usageOf(control), 5000), 'controle');
    for (const id of [...sessions, sid]) assert.ok(!sse.messages.some((m) => m.data?.event?.kind === 'context.usage' && m.data.event.sessionId === id), id);
    const health = JSON.parse((await request(runtime.port, { path: '/api/health' })).text);
    assert.equal(health.ok, true);
  });

  it('origem não permitida: POST /hooks com Origin é recusado e não lê nada', async () => {
    const sid = newSessionId();
    const file = transcript(path.join(projectFolder(), `${sid}.jsonl`), [assistant(4)]);
    const res = await post({ hook_event_name: 'PostToolUse', session_id: sid, transcript_path: file, cwd: projectDir, tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu_01T15origem0000000000000' }, { headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
    const control = newSessionId();
    await toolDone(control, transcript(path.join(projectFolder(), `${control}.jsonl`), [assistant(5)]));
    assert.ok(await sse.waitFor(usageOf(control), 5000), 'controle');
    assert.equal(usagesOf(sid).length, 0);
  });

  it('várias sessões e subagentes ao mesmo tempo: cada agente recebe o próprio valor, sem misturar', async () => {
    const cases = Array.from({ length: 6 }, (_, i) => {
      const sid = newSessionId();
      const aid = newAgentId();
      const main = transcript(path.join(projectFolder(), `${sid}.jsonl`), [assistant(10_000 + i)]);
      transcript(path.join(projectFolder(), sid, 'subagents', `agent-${aid}.jsonl`), [assistant(20_000 + i)]);
      return { sid, aid, main, i };
    });
    await Promise.all(cases.map(async ({ sid, aid, main }) => {
      await sessionStart(sid, main);
      await post({ hook_event_name: 'SubagentStart', session_id: sid, transcript_path: main, cwd: projectDir, agent_id: aid, agent_type: 'tester' });
      await Promise.all([toolDone(sid, main), toolDone(sid, main, { agent_id: aid, agent_type: 'tester' })]);
    }));
    for (const { sid, aid, i } of cases) {
      const main = await sse.waitFor(usageOf(sid), 5000);
      const sub = await sse.waitFor(usageOf(sid, aid), 5000);
      assert.equal(main?.data.event.data.usedTokens, 10_000 + i, `main de ${sid}`);
      assert.equal(sub?.data.event.data.usedTokens, 20_000 + i, `subagente de ${sid}`);
    }
  });

  it('transcript de 20 MiB: lê só o fim (a resposta no começo não é vista), e rápido', async () => {
    const sid = newSessionId();
    const big = path.join(projectFolder(), `${sid}.jsonl`);
    const filler = JSON.stringify(userLine('x'.repeat(4000)));
    const head = JSON.stringify(assistant(123_456));
    writeFileSync(big, `${head}\n${`${filler}\n`.repeat(5000)}`);
    const sid2 = newSessionId();
    const big2 = path.join(projectFolder(), `${sid2}.jsonl`);
    writeFileSync(big2, `${`${filler}\n`.repeat(5000)}${JSON.stringify(assistant(654))}\n`);
    const started = Date.now();
    await toolDone(sid, big);
    await toolDone(sid2, big2);
    const message = await sse.waitFor(usageOf(sid2), 5000);
    assert.equal(message?.data.event.data.usedTokens, 654);
    assert.ok(message.at - started < 2000, `leitura lenta: ${message.at - started} ms`);
    assert.equal(usagesOf(sid).length, 0, 'a resposta do começo do arquivo grande foi vista');
  });

  it('no máximo uma leitura por agente a cada 5 s: rajada de ferramentas com o transcript mudando vira uma leitura agora e uma no fim do intervalo; outro agente não espera', async () => {
    const sid = newSessionId();
    const file = path.join(projectFolder(), `${sid}.jsonl`);
    const aid = newAgentId();
    const subFile = path.join(projectFolder(), sid, 'subagents', `agent-${aid}.jsonl`);
    transcript(file, [assistant(1000)]);
    transcript(subFile, [assistant(777)]);
    await sessionStart(sid, file);
    await post({ hook_event_name: 'SubagentStart', session_id: sid, transcript_path: file, cwd: projectDir, agent_id: aid, agent_type: 'tester' });
    const first = Date.now();
    await toolDone(sid, file);
    // Cada ferramenta da rajada muda o transcript: sem o limite, cada uma viraria um context.usage.
    for (let i = 1; i <= 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      transcript(file, [assistant(1000 + i)]);
      await toolDone(sid, file);
      if (i === 8) {
        // Outro agente da mesma sessão no meio da rajada: lê na hora.
        const before = Date.now();
        await toolDone(sid, file, { agent_id: aid, agent_type: 'tester' });
        const sub = await sse.waitFor(usageOf(sid, aid), 2000);
        assert.ok(sub, 'o subagente esperou o intervalo do main');
        assert.ok(sub.at - before < 1500, `subagente demorou ${sub.at - before} ms`);
      }
    }
    transcript(file, [assistant(9999)]);
    const elapsed = Date.now() - first;
    assert.ok(elapsed < 4500, `a rajada demorou demais (${elapsed} ms) para o teste valer`);
    // Até 4,5 s depois da primeira: uma leitura só.
    await new Promise((resolve) => setTimeout(resolve, 4500 - elapsed));
    assert.equal(usagesOf(sid).length, 1, `leituras do main antes de 5 s: ${usagesOf(sid).map((m) => m.data.event.data.usedTokens).join(', ')}`);
    // A do fim do intervalo chega, com o valor mais recente.
    const second = await sse.waitFor((m) => usageOf(sid)(m) && m.data.event.data.usedTokens === 9999, 3000);
    assert.ok(second, 'a leitura do fim do intervalo não chegou com o valor final');
    const [one, two] = usagesOf(sid);
    assert.equal(usagesOf(sid).length, 2);
    assert.ok(two.data.event.ts - one.data.event.ts >= 4900, `intervalo entre leituras: ${two.data.event.ts - one.data.event.ts} ms`);
    // E nada mais depois.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(usagesOf(sid).length, 2);
    assert.equal(usagesOf(sid, aid).length, 1);
  });

  it('o seq é contínuo em tudo o que chegou ao cliente, com os updates da sonda', async () => {
    const snapshot = sse.messages.find((m) => m.event === 'snapshot');
    const numbered = sse.messages.filter((m) => m.event === 'update' || m.event === 'session-removed');
    numbered.forEach((m, i) => assert.equal(m.data.seq, snapshot.data.seq + 1 + i, `mensagem ${i}`));
    for (const m of numbered.filter((x) => x.event === 'update')) {
      if (m.data.event) checkEvent(m.data.event, { numbered: true });
      checkSession(m.data.session, { feed: false });
    }
    const state = await apiState();
    assert.equal(state.seq, numbered.at(-1).data.seq);
  });
});
