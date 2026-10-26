// @ts-check
// Ligação de ponta a ponta (T9a, condições 5 e 6; modelo de eventos, seção 9):
// envelope aceito → normalize → apply → `update` no SSE; `tick` periódico →
// `update` e `session-removed`.
//
// - Um único `sequence`, com o `runId` da execução, numera tudo o que muda
//   estado. O reducer numera os eventos ao criá-los. Aqui saem, com o mesmo
//   `sequence`, os `update` sem evento (sessão alterada sem evento) e os
//   `session-removed`. Cada mensagem recebe o `seq` anterior + 1, e o `seq` e o
//   `id` de um evento são os do `update` que o leva.
// - Roda depois do 204, pela fila da ingestão (server/ingest/queue.js), nunca no
//   ciclo da requisição.
// - Nunca derruba o servidor. Um envelope que o normalizador descarta conta
//   como `ignored`. Um erro do reducer também conta como `ignored` (a fila
//   registra só o tipo do erro, sem conteúdo), e a sessão afetada recebe um
//   `update` sem evento, para o painel se acertar. Um erro no `tick` só vai ao
//   log, também só com o tipo.
// - O `tick` roda a cada 5 s com o relógio real (intervalo interno, sem efeito
//   no contrato). Os testes injetam o relógio e os temporizadores.
// - Pasta de projeto nova (`newProjects` do `apply`): lê `.claude/agents/` com o
//   leitor assíncrono de server/agent-names.js, fora do `apply`, e entrega os
//   nomes por `setAgentNames`; cada sessão cujo `roster` mudou recebe um
//   `update` sem evento (seção 7). Até lá, o `roster` tem só os papéis vistos.
//   Uma listagem que termina depois do prazo chega por `onLate` do leitor e é
//   aplicada do mesmo jeito.
// - Sonda de contexto (T15; seção 6, "Contexto"): `tool.finished`, Stop,
//   SubagentStop e PostCompact pedem a leitura do transcript do agente à sonda
//   (server/usage/transcript-usage.js), que respeita uma leitura por agente a
//   cada 5 s e lê fora do `apply`, de forma assíncrona. O resultado chega por
//   `setContextUsage` e sai como `update` (com `context.usage` quando o valor
//   muda). Só lê dentro de `~/.claude/projects/`; sem pasta pessoal, a sonda
//   fica desligada. Erro na sonda nunca chega à fila nem ao Claude Code.
//
// O hub (server/http/sse.js) continua sem importar nada do domínio: recebe
// daqui as mensagens já numeradas e o snapshot pronto.

import os from 'node:os';
import path from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { createAgentNamesReader } from './agent-names.js';
import { normalize } from './domain/normalize.js';
import {
  apply,
  createSequence,
  createState,
  getSessionState,
  getSessionStates,
  sessionCount,
  setAgentNames,
  setContextUsage,
  tick,
} from './domain/state/index.js';
import { createContextProbe, transcriptPathFor } from './usage/transcript-usage.js';

/** Intervalo do `tick` (plano, T9a). */
export const TICK_MS = 5000;

/** Modelos pedidos guardados (um por sessão, do SessionStart); acima disso, sai o mais antigo. */
const MAX_SESSION_MODELS = 1000;

/** Fatos que pedem a leitura do contexto do próprio agente (seção 6, "Contexto"). */
const CONTEXT_FACTS = new Set(['turn.stop', 'subagent.stop', 'compact.post']);

/**
 * @typedef {import('../shared/contract.js').UpdateMessage} UpdateMessage
 * @typedef {import('../shared/contract.js').SessionRemovedMessage} SessionRemovedMessage
 * @typedef {import('../shared/contract.js').SnapshotMessage} SnapshotMessage
 * @typedef {import('./ingest/envelope.js').Envelope} Envelope
 * @typedef {import('./agent-names.js').AgentNamesReader} AgentNamesReader
 */

/**
 * Quem entrega as mensagens aos painéis (o hub do SSE).
 * @typedef {object} Publisher
 * @property {(message: UpdateMessage) => void} publishUpdate
 * @property {(message: SessionRemovedMessage) => void} publishRemoved
 */

/**
 * @typedef {object} PipelineTimers
 * @property {(run: () => void, ms: number) => any} setInterval
 * @property {(handle: any) => void} clearInterval
 */

/**
 * @typedef {object} PipelineOptions
 * @property {string} runId                identifica a execução (o mesmo do hub)
 * @property {unknown} [roleOverrides]     "roles" do config.json
 * @property {string|null} [homeDir]       pasta pessoal (caminhos com `~`, chave do projeto e `~/.claude/agents/`)
 * @property {AgentNamesReader} [reader]   leitor pronto (testes); sem ele, o leitor em disco, com `onLate` ligado
 * @property {{ list?: (folder: string) => Promise<unknown>|unknown, timeoutMs?: number, lostAfterMs?: number, timers?: import('./agent-names.js').ReaderTimers }} [readerOptions]
 *   opções do leitor em disco padrão (os testes trocam a listagem e o prazo)
 * @property {() => number} [clock]        relógio do `tick` (ms)
 * @property {number} [tickMs]
 * @property {PipelineTimers} [timers]
 * @property {(message: string) => void} [logError]
 * @property {{ apply: typeof apply, tick: typeof tick }} [reducer]   os testes trocam
 * @property {UsageOptions} [usageOptions]   sonda de contexto (os testes trocam a raiz, a leitura e os temporizadores)
 */

/**
 * @typedef {object} UsageOptions
 * @property {string|null} [root]        pasta permitida; padrão `<homeDir>/.claude/projects`; null desliga a sonda
 * @property {typeof import('./usage/transcript-usage.js').readContextUsage} [read]
 * @property {() => number} [clock]      padrão: o relógio do pipeline
 * @property {import('./usage/transcript-usage.js').ProbeTimers} [timers]
 * @property {number} [intervalMs]
 */

/**
 * @typedef {object} Pipeline
 * @property {(envelope: Envelope, meta: { receivedAt: number }) => boolean} handleEnvelope
 *   processa um envelope aceito; `false` quando o normalizador o descarta
 *   (`ignored`). Erro do reducer é relançado para a fila contar e registrar.
 * @property {() => void} runTick          uma passada do `tick`, agora
 * @property {() => void} start            liga o `tick` periódico
 * @property {() => void} stop             desliga o `tick` periódico e cancela as leituras de contexto agendadas
 * @property {() => SnapshotMessage} snapshot    `{ seq, sessions }`, sessões com feed
 * @property {() => number} currentSeq    o último `seq` reservado (retomada do SSE)
 * @property {() => number} sessionCount
 * @property {(publisher: Publisher) => void} attach
 * @property {() => Promise<void>} settled  espera as leituras de .claude/agents/ em andamento (testes)
 */

/**
 * @param {PipelineOptions} options
 * @returns {Pipeline}
 */
export function createPipeline({
  runId,
  roleOverrides = {},
  homeDir = defaultHomeDir(),
  reader,
  readerOptions = {},
  clock = Date.now,
  tickMs = TICK_MS,
  timers = { setInterval, clearInterval },
  logError = console.error,
  reducer = { apply, tick },
  usageOptions = {},
}) {
  const sequence = createSequence(runId);
  const state = createState({ roleOverrides, sequence, homeDir });
  /** @type {Publisher|null} */
  let publisher = null;
  /** @type {any} */
  let timer = null;
  /** @type {Set<Promise<void>>} */
  const reading = new Set();
  /** Projetos cuja leitura de .claude/agents/ já foi pedida. @type {Set<string>} */
  const requested = new Set();
  const agentNames = reader ?? createAgentNamesReader({ homeDir, ...readerOptions, onLate: applyAgentNames });
  /** Modelo pedido de cada sessão (SessionStart), para a janela de 1 milhão. @type {Map<string, string>} */
  const sessionModels = new Map();
  const { root: usageRoot = projectsRoot(homeDir), ...probeOptions } = usageOptions;
  const probe = usageRoot === null
    ? null
    : createContextProbe({ clock, logError, ...probeOptions, root: usageRoot, onResult: applyContextUsage });

  /**
   * Um `update` por evento, na ordem, com o estado da sessão (sem feed); depois
   * um `update` sem evento para cada sessão alterada sem evento; por fim, um
   * `session-removed` por sessão limpa. Tudo síncrono, então o `seq` segue
   * contínuo e nenhum snapshot fica entre duas mensagens.
   * @param {{ events: import('../shared/contract.js').CanonicalEvent[], changed: string[] }} result
   * @param {string[]} [removed]
   */
  function publish({ events, changed }, removed = []) {
    /** @type {Set<string>} */
    const withEvent = new Set();
    for (const event of events) {
      withEvent.add(event.sessionId);
      const session = getSessionState(state, event.sessionId, { feed: false });
      if (session) publisher?.publishUpdate({ seq: event.seq, event, session });
    }
    for (const sessionId of changed) {
      if (!withEvent.has(sessionId)) publishStateOnly(sessionId);
    }
    for (const sessionId of removed) {
      publisher?.publishRemoved({ seq: sequence.next().seq, sessionId });
    }
  }

  /** @param {string} sessionId */
  function publishStateOnly(sessionId) {
    const session = getSessionState(state, sessionId, { feed: false });
    if (session) publisher?.publishUpdate({ seq: sequence.next().seq, event: null, session });
  }

  /** @type {Pipeline['handleEnvelope']} */
  function handleEnvelope(envelope, { receivedAt }) {
    const fact = normalize(envelope, { receivedAt, homeDir });
    if (!fact) return false;
    let result;
    try {
      result = reducer.apply(state, fact, receivedAt);
    } catch (err) {
      // O estado pode ter mudado pela metade, e eventos já numerados se perderam:
      // um update sem evento entrega o estado atual, e o salto de seq leva o
      // painel a buscar o /api/state.
      try {
        publishStateOnly(fact.sessionId);
        // O apply pode ter registrado um projeto novo antes de lançar; o
        // newProjects se perdeu com o erro, mas a pasta ainda precisa ser lida.
        readPendingProjects();
      } catch {
        // o erro original é o que importa
      }
      throw err;
    }
    publish(result);
    for (const projectDir of result.newProjects ?? []) readAgentNames(projectDir);
    requestContextReads(fact, result.events);
    return true;
  }

  /**
   * Pede à sonda a leitura do contexto dos agentes que acabaram uma ferramenta
   * (`tool.finished`) ou o turno, ou que terminaram uma compactação (Stop,
   * SubagentStop, PostCompact). Nunca lança: o envelope já foi processado.
   * @param {import('./domain/normalize.js').Fact} fact
   * @param {readonly import('../shared/contract.js').CanonicalEvent[]} events
   */
  function requestContextReads(fact, events) {
    if (probe === null) return;
    try {
      if (fact.kind === 'session.start' && typeof fact.model === 'string') rememberModel(fact.sessionId, fact.model);
      /** @type {Set<string>} */
      const keys = new Set();
      for (const event of events) {
        if (event.kind === 'tool.finished' && event.agentKey !== null) keys.add(event.agentKey);
      }
      if (CONTEXT_FACTS.has(fact.kind)) keys.add(fact.agentId ?? 'main');
      const agents = state.sessions.get(fact.sessionId)?.agents;
      for (const agentKey of keys) {
        if (!agents?.has(agentKey)) continue;
        const file = transcriptPathFor({
          agentKey,
          sessionId: fact.sessionId,
          transcriptPath: fact.transcriptPath,
          agentTranscriptPath: fact.kind === 'subagent.stop' && fact.agentId === agentKey ? fact.agentTranscriptPath : null,
        });
        if (file === null) continue;
        const model = agentKey === 'main' ? sessionModels.get(fact.sessionId) ?? null : null;
        probe.request({ sessionId: fact.sessionId, agentKey, path: file, model });
      }
    } catch (err) {
      logError(`Erro ao pedir o uso de contexto: ${errorKind(err)}`);
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} model
   */
  function rememberModel(sessionId, model) {
    sessionModels.delete(sessionId);
    sessionModels.set(sessionId, model);
    if (sessionModels.size > MAX_SESSION_MODELS) {
      const oldest = sessionModels.keys().next().value;
      if (oldest !== undefined) sessionModels.delete(oldest);
    }
  }

  /**
   * Resultado de uma leitura da sonda: `context` do agente no estado e o
   * `update` (com `context.usage` quando o valor mudou).
   * @param {string} sessionId
   * @param {string} agentKey
   * @param {import('./usage/transcript-usage.js').ContextUsage|null} usage
   * @param {number} at
   */
  function applyContextUsage(sessionId, agentKey, usage, at) {
    try {
      publish(setContextUsage(state, sessionId, agentKey, usage, at));
    } catch (err) {
      logError(`Erro ao aplicar o uso de contexto: ${errorKind(err)}`);
    }
  }

  /**
   * Lê `.claude/agents/` de um projeto novo, fora do `apply`, e publica o
   * `roster` novo das sessões dele. O leitor nunca rejeita (erro ou prazo
   * vencido viram lista vazia).
   * @param {string} projectDir
   */
  function readAgentNames(projectDir) {
    if (requested.has(projectDir)) return;
    requested.add(projectDir);
    const task = agentNames
      .read(projectDir)
      .then((names) => applyAgentNames(projectDir, names))
      .finally(() => reading.delete(task));
    reading.add(task);
  }

  /** Projetos que o estado espera ler (papéis ainda null) e que ninguém pediu. */
  function readPendingProjects() {
    for (const [projectDir, roles] of state.projects) {
      if (roles === null && !requested.has(projectDir)) readAgentNames(projectDir);
    }
  }

  /**
   * Entrega ao estado os nomes de um projeto (no prazo, ou depois, por
   * `onLate`) e publica o `roster` novo das sessões afetadas.
   * @param {string} projectDir
   * @param {string[]} names
   */
  function applyAgentNames(projectDir, names) {
    try {
      const { changed } = setAgentNames(state, projectDir, names);
      for (const sessionId of changed) publishStateOnly(sessionId);
    } catch (err) {
      logError(`Erro ao aplicar .claude/agents/: ${errorKind(err)}`);
    }
  }

  function runTick() {
    try {
      const result = reducer.tick(state, clock());
      for (const sessionId of result.removed) {
        sessionModels.delete(sessionId);
        probe?.forgetSession(sessionId);
      }
      publish(result, result.removed);
    } catch (err) {
      logError(`Erro no tick do estado: ${errorKind(err)}`);
    }
  }

  return {
    handleEnvelope,
    runTick,
    start() {
      if (timer !== null) return;
      timer = timers.setInterval(runTick, tickMs);
      // Com o relógio real, o tick sozinho não segura o processo.
      timer?.unref?.();
    },
    stop() {
      probe?.stop();
      if (timer === null) return;
      timers.clearInterval(timer);
      timer = null;
    },
    snapshot: () => ({ seq: sequence.current(), sessions: getSessionStates(state) }),
    currentSeq: () => sequence.current(),
    sessionCount: () => sessionCount(state),
    attach(next) {
      publisher = next;
    },
    async settled() {
      while (reading.size > 0) await Promise.all([...reading]);
      await probe?.settled();
      while (reading.size > 0) await Promise.all([...reading]);
    },
  };
}

/**
 * Tipo do erro, sem a mensagem (que pode carregar conteúdo de evento).
 * @param {unknown} err
 * @returns {string}
 */
function errorKind(err) {
  const e = /** @type {any} */ (err);
  return String(e?.code ?? e?.name ?? 'Error');
}

/**
 * Pasta dos transcripts do Claude Code (`~/.claude/projects`), a única que a
 * sonda de contexto lê.
 * @param {string|null} homeDir
 * @returns {string|null}
 */
function projectsRoot(homeDir) {
  return typeof homeDir === 'string' && path.isAbsolute(homeDir) ? path.join(homeDir, '.claude', 'projects') : null;
}

/** @returns {string|null} */
function defaultHomeDir() {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}
