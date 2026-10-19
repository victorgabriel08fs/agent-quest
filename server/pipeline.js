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
//
// O hub (server/http/sse.js) continua sem importar nada do domínio: recebe
// daqui as mensagens já numeradas e o snapshot pronto.

import os from 'node:os';
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
  tick,
} from './domain/state/index.js';

/** Intervalo do `tick` (plano, T9a). */
export const TICK_MS = 5000;

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
 */

/**
 * @typedef {object} Pipeline
 * @property {(envelope: Envelope, meta: { receivedAt: number }) => boolean} handleEnvelope
 *   processa um envelope aceito; `false` quando o normalizador o descarta
 *   (`ignored`). Erro do reducer é relançado para a fila contar e registrar.
 * @property {() => void} runTick          uma passada do `tick`, agora
 * @property {() => void} start            liga o `tick` periódico
 * @property {() => void} stop             desliga o `tick` periódico
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
    return true;
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

/** @returns {string|null} */
function defaultHomeDir() {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}
