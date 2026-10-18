// Relatório da sonda do T0: lê os registros (JSONL bruto do dump.mjs ou
// cenários sanitizados) e dá um veredito para cada item V1 a V14 de
// docs/arquitetura/modelo-de-eventos.md, seção 11: "confirmado", "refutado"
// ou "inconclusivo". Também mede eventos por tipo, tamanho dos payloads,
// ordem de chegada de Pre e Post e os tempos do log de depuração.
//
// Uso (na raiz do repositório):
//   node tools/probe/report.mjs                        JSONL e log padrão em <dados>\probe\
//   node tools/probe/report.mjs <arquivo.jsonl>        outro JSONL bruto
//   node tools/probe/report.mjs test/fixtures/hooks    cenários sanitizados (pasta ou arquivos .json)
// Opções:
//   --debug <arquivo>     log do --debug-file do Claude Code (padrão: <dados>\probe\debug.txt, só sem entradas)
//   --json                resultado em JSON
//   --debug-samples <N>   mostra N linhas do log que o relatório reconheceu (podem ter conteúdo)
//
// O relatório nunca mostra conteúdo dos payloads: só contagens, nomes de
// eventos, ferramentas, tipos de agente, nomes de campos e de variáveis.
//
// Cada item tem subitens. Veredito do item: "refutado" se algum subitem foi
// refutado; "inconclusivo" se algum subitem obrigatório ficou sem dados;
// senão "confirmado". Subitens opcionais sem dados aparecem como "?".

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { displayPath, inputHash, isMainModule, isObject, loadInputs, probeDir, safeToken } from './records.mjs';

const C = 'confirmado';
const R = 'refutado';
const I = 'inconclusivo';
const SYMBOL = { [C]: '+', [R]: 'x', [I]: '?' };

const TOOL_HOOK_LIST = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const TOOL_HOOKS = new Set(TOOL_HOOK_LIST);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EXIT_CODE = /^Exit code -?\d+/;
const FAILED_SUMMARY = /^\s*[ℹ#]\s+fail\s+[1-9]/m;
const LONG_STRING = 4096;
const NOTIFICATION_WINDOW_MS = 120_000;
const RETURN_WINDOW_MS = 120_000;
const CLIENT_VARS = /^(CLAUDE_CODE_ENTRYPOINT|TERM_PROGRAM|VSCODE_|WT_SESSION$|entrypoint$)/i;
const ERRORISH = /\b(error|failed|enoent|eacces|not recognized|not found|cannot find)\b/i;
const BACKGROUND_COVERAGE = 0.95;

/**
 * Analisa os registros e devolve os vereditos e as medidas. Função pura.
 * @param {import('./records.mjs').ProbeRecord[]} records
 * @param {{ debugText?: string|null }} [options]
 */
export function analyze(records, options = {}) {
  const debug = typeof options.debugText === 'string' ? parseDebugLog(options.debugText) : null;
  const ctx = buildContext(records);
  const items = [
    checkV1(ctx), checkV2(ctx), checkV3(ctx), checkV4(ctx), checkV5(ctx), checkV6(ctx), checkV7(ctx),
    checkV8(ctx), checkV9(ctx), checkV10(ctx, debug), checkV11(ctx), checkV12(ctx), checkV13(ctx), checkV14(ctx),
  ];
  return {
    totals: {
      events: ctx.events.length,
      sessions: new Set(ctx.events.map((e) => e.session).filter(Boolean)).size,
      subagents: [...ctx.agents.values()].filter((a) => a.delegated).length,
    },
    items,
    stats: buildStats(ctx),
    debug,
  };
}

// ---------------------------------------------------------------------------
// Contexto: eventos enriquecidos, chamadas por tool_use_id, chamadas Agent,
// instâncias de subagente e turnos.

function buildContext(records) {
  const events = records.map(enrich);

  const calls = new Map();
  const slots = { PreToolUse: 'pre', PostToolUse: 'post', PostToolUseFailure: 'fail', PermissionDenied: 'denied' };
  for (const e of events) {
    const slot = slots[e.hook];
    if (!slot || !e.toolUseId) continue;
    let call = calls.get(e.toolUseId);
    if (!call) {
      call = { id: e.toolUseId, pre: null, post: null, fail: null, denied: null };
      calls.set(e.toolUseId, call);
    }
    if (!call[slot]) call[slot] = e;
  }

  const agentCalls = buildAgentCalls(calls);
  const agents = buildAgents(events, agentCalls);
  const mainSessions = new Set(
    events.filter((e) => !e.agentId && (e.hook === 'SessionStart' || e.hook === 'UserPromptSubmit')).map((e) => e.session),
  );

  const hashes = new Map();
  const hashOf = (e) => {
    if (!hashes.has(e)) hashes.set(e, inputHash(e.payload.tool_input));
    return hashes.get(e);
  };

  const ctx = {
    events,
    toolEvents: events.filter((e) => TOOL_HOOKS.has(e.hook)),
    calls,
    agentCalls,
    agents,
    mainSessions,
    turns: buildTurns(events),
    hashOf,
    matchPermission: null,
  };
  const matches = new Map();
  ctx.matchPermission = (pr) => {
    if (!matches.has(pr)) matches.set(pr, matchPermission(ctx, pr));
    return matches.get(pr);
  };
  return ctx;
}

function enrich(record, index) {
  const p = record.payload;
  return {
    index,
    line: record.line,
    source: record.source,
    receivedAt: record.receivedAt,
    writtenAt: record.writtenAt,
    bytes: record.bytes,
    raw: record.raw,
    env: record.env,
    payload: p,
    hook: str(p.hook_event_name),
    session: str(p.session_id),
    agentId: str(p.agent_id) || null,
    agentType: str(p.agent_type),
    toolName: str(p.tool_name),
    toolUseId: str(p.tool_use_id) || null,
    promptId: str(p.prompt_id) || null,
    longPaths: longStringPaths(p),
  };
}

function buildAgentCalls(calls) {
  const result = [];
  for (const call of calls.values()) {
    const first = call.pre ?? call.post ?? call.fail;
    if (!first || !AGENT_TOOLS.has(first.toolName)) continue;
    const input = obj(first.payload.tool_input);
    const response = obj(call.post?.payload.tool_response);
    result.push({
      id: call.id,
      toolName: first.toolName,
      session: first.session,
      from: first.agentId ?? 'main',
      promptId: first.promptId,
      pre: call.pre,
      post: call.post,
      fail: call.fail,
      subagentType: str(input.subagent_type),
      runInBackground: input.run_in_background === true,
      responseAgentId: str(response.agentId) || null,
      responseStatus: str(response.status) || null,
      responseKeys: Object.keys(response).sort(),
      background: input.run_in_background === true || response.status === 'async_launched',
      firstIndex: Math.min(...[call.pre, call.post, call.fail].filter(Boolean).map((e) => e.index)),
      agent: null,
    });
  }
  return result.sort((a, b) => a.firstIndex - b.firstIndex);
}

function buildAgents(events, agentCalls) {
  const agents = new Map();
  const get = (id) => {
    let agent = agents.get(id);
    if (!agent) {
      agent = {
        id, session: '', sessions: new Set(), events: [], starts: [], stops: [], toolEvents: [],
        startType: '', stopType: '', firstIndex: Infinity, call: null, linkMethod: null,
        type: '', background: null, parent: null, delegated: false,
      };
      agents.set(id, agent);
    }
    return agent;
  };

  for (const e of events) {
    if (!e.agentId) continue;
    const agent = get(e.agentId);
    if (!agent.session) agent.session = e.session;
    agent.sessions.add(e.session);
    agent.firstIndex = Math.min(agent.firstIndex, e.index);
    agent.events.push(e);
    if (e.hook === 'SubagentStart') {
      agent.starts.push(e);
      if (e.agentType && !agent.startType) agent.startType = e.agentType;
    } else if (e.hook === 'SubagentStop') {
      agent.stops.push(e);
      if (e.agentType && !agent.stopType) agent.stopType = e.agentType;
    } else if (TOOL_HOOKS.has(e.hook)) {
      agent.toolEvents.push(e);
    }
  }

  // Elo confirmado: tool_response.agentId do PostToolUse da chamada Agent.
  for (const call of agentCalls) {
    if (!call.responseAgentId) continue;
    const agent = get(call.responseAgentId);
    if (!agent.session) agent.session = call.session;
    if (!agent.call) {
      agent.call = call;
      agent.linkMethod = 'agentId';
      call.agent = agent;
    }
  }

  // Elo provisório: chamada Agent mais antiga da sessão, do mesmo tipo e ainda sem agente.
  const unlinked = [...agents.values()].filter((a) => !a.call).sort((a, b) => a.firstIndex - b.firstIndex);
  for (const agent of unlinked) {
    const type = agent.startType || agent.toolEvents.find((e) => e.agentType)?.agentType || '';
    if (!type) continue;
    const call = agentCalls.find(
      (c) => !c.agent && c.session === agent.session && c.firstIndex < agent.firstIndex && typesMatch(c.subagentType, type),
    );
    if (call) {
      agent.call = call;
      agent.linkMethod = 'fila';
      call.agent = agent;
    }
  }

  for (const agent of agents.values()) {
    agent.type = agent.startType || agent.stopType || agent.events.find((e) => e.agentType)?.agentType || agent.call?.subagentType || '';
    agent.background = agent.call ? agent.call.background : null;
    agent.parent = agent.call ? agent.call.from : null;
    agent.delegated = Boolean(agent.call) || Boolean(agent.startType);
  }
  return agents;
}

function buildTurns(events) {
  const bySession = new Map();
  for (const e of events) {
    if (!e.session) continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(e);
  }
  const turns = [];
  for (const [session, list] of bySession) {
    const prompts = list.filter((e) => e.hook === 'UserPromptSubmit' && !e.agentId);
    prompts.forEach((start, i) => {
      const next = prompts[i + 1];
      const end = list.find((e) => e.hook === 'SessionEnd' && e.index > start.index);
      const until = Math.min(next ? next.index : Infinity, end ? end.index : Infinity);
      turns.push({
        session,
        start,
        until,
        closed: until !== Infinity,
        events: list.filter((e) => e.index >= start.index && e.index < until),
      });
    });
  }
  return turns;
}

/** Casa um PermissionRequest com o PreToolUse da mesma chamada (o pedido não traz tool_use_id). */
function matchPermission(ctx, pr) {
  const candidates = ctx.events.filter(
    (e) => e.hook === 'PreToolUse' && e.session === pr.session && e.toolName === pr.toolName
      && e.receivedAt <= pr.receivedAt + 2000 && e.receivedAt >= pr.receivedAt - 600_000,
  );
  const closest = (list) => list.sort((a, b) => Math.abs(pr.receivedAt - a.receivedAt) - Math.abs(pr.receivedAt - b.receivedAt))[0] ?? null;

  const hash = inputHash(pr.payload.tool_input);
  const byHash = closest(candidates.filter((e) => ctx.hashOf(e) === hash));
  if (byHash) return { pre: byHash, method: 'inputHash' };

  const key = keyField(pr.payload.tool_input);
  if (key) {
    const byField = closest(candidates.filter((e) => keyField(e.payload.tool_input) === key));
    if (byField) return { pre: byField, method: 'mesmo comando ou arquivo' };
  }

  const open = candidates.filter((e) => {
    const call = ctx.calls.get(e.toolUseId);
    const end = call?.post ?? call?.fail;
    return !end || end.receivedAt >= pr.receivedAt;
  });
  const byTool = closest(open);
  return byTool ? { pre: byTool, method: 'ferramenta em aberto' } : { pre: null, method: null };
}

// ---------------------------------------------------------------------------
// Itens V1 a V14.

function checkV1(ctx) {
  const subagents = delegatedAgents(ctx);
  const withId = ctx.toolEvents.filter((e) => e.agentId);
  const orphans = orphanToolEvents(ctx);
  const checks = [check('subagentes observados', subagents.length ? C : I, `${subagents.length} instâncias`)];
  for (const hook of TOOL_HOOK_LIST) {
    const n = withId.filter((e) => e.hook === hook).length;
    const missing = orphans.filter((e) => e.hook === hook).length;
    checks.push(check(
      `${hook} com agent_id dentro de subagente`,
      missing ? R : n ? C : I,
      `${n} com agent_id; ${missing} sem agent_id durante subagente em primeiro plano`,
      hook !== 'PostToolUseFailure',
    ));
  }
  const noType = withId.filter((e) => !e.agentType).length;
  checks.push(check('agent_type junto com agent_id', !withId.length ? I : noType ? R : C, `${withId.length - noType} de ${withId.length} eventos`));
  const differentType = withId.filter((e) => {
    const startType = ctx.agents.get(e.agentId)?.startType;
    return startType && e.agentType && e.agentType !== startType;
  }).length;
  checks.push(check('agent_type igual ao do SubagentStart', !withId.length ? I : differentType ? R : C, `${differentType} diferentes`, false));
  const silent = subagents.filter((a) => a.toolEvents.length === 0);
  checks.push(check(
    'todo subagente tem eventos de ferramenta com o próprio agent_id',
    subagents.length && !silent.length ? C : I,
    silent.length ? `${silent.length} sem nenhum (${typeCounts(silent)}); conferir se usaram ferramentas` : `${subagents.length} de ${subagents.length}`,
    false,
  ));
  return item('V1', 'agent_id e agent_type nos eventos de ferramenta dos subagentes', checks, [
    `instâncias por tipo: ${typeCounts(subagents) || 'nenhuma'}`,
  ]);
}

function checkV2(ctx) {
  const matches = ctx.events.filter((e) => e.hook === 'PermissionRequest').map((pr) => ({ pr, ...ctx.matchPermission(pr) }));
  const origin = (m) => m.pr.agentId ?? m.pre?.agentId ?? null;
  const fromSub = matches.filter(origin);
  const foreground = fromSub.filter((m) => ctx.agents.get(origin(m))?.background !== true);
  const background = fromSub.filter((m) => ctx.agents.get(origin(m))?.background === true);
  const ok = (m) => Boolean(m.pr.agentId) && (!m.pre?.agentId || m.pr.agentId === m.pre.agentId);
  const verdictOf = (list) => (!list.length ? I : list.every(ok) ? C : R);
  const detailOf = (list, none) => (list.length ? `${list.filter(ok).length} de ${list.length} com o agent_id do subagente` : none);

  const notices = [];
  for (const n of ctx.events) {
    if (n.hook !== 'Notification' || str(n.payload.notification_type) !== 'permission_prompt') continue;
    const previous = matches
      .filter((m) => m.pr.session === n.session && m.pr.receivedAt <= n.receivedAt + 1000 && m.pr.receivedAt >= n.receivedAt - NOTIFICATION_WINDOW_MS)
      .sort((a, b) => b.pr.receivedAt - a.pr.receivedAt)[0];
    if (previous && origin(previous)) notices.push({ notice: n, agentId: origin(previous) });
  }
  const noticesOk = notices.filter((x) => x.notice.agentId === x.agentId).length;
  const mentionsType = notices.filter((x) => {
    const type = ctx.agents.get(x.agentId)?.type ?? '';
    const message = str(x.notice.payload.message);
    return type && (message.includes(type) || message.includes(type.split(':').at(-1)));
  }).length;

  const checks = [
    check('PermissionRequest de subagente em primeiro plano traz agent_id', verdictOf(foreground), detailOf(foreground, 'nenhum pedido de subagente em primeiro plano')),
    check('PermissionRequest de subagente em segundo plano traz agent_id', verdictOf(background), detailOf(background, 'nenhum pedido de subagente em segundo plano'), false),
    check(
      'Notification permission_prompt de pedido de subagente traz agent_id',
      !notices.length ? I : noticesOk === notices.length ? C : R,
      notices.length ? `${noticesOk} de ${notices.length}` : 'nenhum aviso ligado a pedido de subagente',
      false,
    ),
  ];
  return item('V2', 'agent_id no PermissionRequest e no Notification de pedidos de subagentes', checks, [
    `PermissionRequest casados com o PreToolUse: ${formatCounts(countBy(matches, (m) => m.method ?? 'sem PreToolUse')) || 'nenhum'} (o design casa por tool_name + inputHash)`,
    `pedidos da sessão principal: ${matches.length - fromSub.length}; mensagem do aviso cita o tipo do subagente: ${mentionsType} de ${notices.length}`,
  ]);
}

function checkV3(ctx) {
  const failures = ctx.events.filter((e) => e.hook === 'PostToolUseFailure' && SHELL_TOOLS.has(e.toolName) && e.payload.is_interrupt !== true);
  const withExit = failures.filter((e) => EXIT_CODE.test(str(e.payload.error)));
  const nonZeroAsPost = ctx.events.filter((e) => e.hook === 'PostToolUse' && SHELL_TOOLS.has(e.toolName) && (
    /process\.exit\(\s*[1-9]/.test(str(obj(e.payload.tool_input).command))
    || FAILED_SUMMARY.test(str(obj(e.payload.tool_response).stdout))
  ));
  const multiline = withExit.filter((e) => str(e.payload.error).includes('\n')).length;
  const checks = [
    check(
      'código de saída diferente de zero gera PostToolUseFailure',
      nonZeroAsPost.length ? R : failures.length ? C : I,
      nonZeroAsPost.length ? `${nonZeroAsPost.length} comandos com saída diferente de zero chegaram como PostToolUse` : `${failures.length} PostToolUseFailure de Bash/PowerShell`,
    ),
    check(
      'error começa com "Exit code N"',
      !failures.length ? I : withExit.length ? C : R,
      `${withExit.length} de ${failures.length}${failures.length > withExit.length ? `; outros formatos: ${failures.length - withExit.length}` : ''}`,
    ),
  ];
  const postKeys = keyUnion(ctx.events.filter((e) => e.hook === 'PostToolUse' && SHELL_TOOLS.has(e.toolName)).map((e) => e.payload.tool_response));
  return item('V3', 'Bash com saída diferente de zero gera PostToolUseFailure com "Exit code N"', checks, [
    `error com mais de uma linha (traz a saída do comando): ${multiline} de ${withExit.length}`,
    `campos do tool_response do Bash no PostToolUse: ${postKeys.join(', ') || 'nenhum'}`,
    `campos do PostToolUseFailure do Bash: ${keyUnion(failures.map((e) => e.payload)).join(', ') || 'nenhum'}`,
  ]);
}

function checkV4(ctx) {
  const outcomes = ctx.events.filter((e) => e.hook === 'PermissionRequest').map((pr) => {
    const { pre } = ctx.matchPermission(pr);
    if (!pre?.toolUseId) return { pr, pre: null, kind: 'sem PreToolUse' };
    const call = ctx.calls.get(pre.toolUseId);
    let kind = 'sem Post nem Failure';
    if (call.denied) kind = 'PermissionDenied';
    else if (call.post) kind = 'executada';
    else if (call.fail) {
      if (call.fail.payload.is_interrupt === true) kind = 'interrompida';
      else kind = EXIT_CODE.test(str(call.fail.payload.error)) ? 'executada com falha' : 'falha sem "Exit code"';
    }
    return { pr, pre, kind };
  });
  const counts = countBy(outcomes, (o) => o.kind);
  const none = counts['sem Post nem Failure'] ?? 0;
  const other = counts['falha sem "Exit code"'] ?? 0;
  let verdict = I;
  if (other && !none) verdict = R;
  else if (none && !other) verdict = C;
  const detail = outcomes.length
    ? `${formatCounts(counts)}${!none && !other ? '; nenhuma negação observada' : ''}${none && other ? '; resultado misto, conferir à mão' : ''}`
    : 'nenhum PermissionRequest';

  const denied = outcomes.filter((o) => o.kind === 'sem Post nem Failure');
  const after = denied.map((o) => {
    const key = o.pre.agentId ?? 'main';
    const next = ctx.events
      .filter((e) => e.index > o.pre.index && e.session === o.pre.session && (e.agentId ?? 'main') === key && e.hook !== 'Notification')
      .slice(0, 3)
      .map((e) => (e.toolName ? `${e.hook}(${safeToken(e.toolName)})` : e.hook));
    return next.join(' > ') || 'nada';
  });
  return item('V4', 'Permissão negada: só PreToolUse, sem Post nem Failure', [check('negação sem Post nem Failure', verdict, detail)], [
    `negações em subagentes: ${denied.filter((o) => o.pre.agentId).length} de ${denied.length}`,
    `o que veio depois de cada negação, no mesmo agente: ${after.join(' | ') || 'nada'}`,
  ]);
}

function checkV5(ctx) {
  const calls = ctx.agentCalls;
  const names = countBy(calls, (c) => c.toolName);
  const foreground = calls.filter((c) => c.post && c.responseStatus !== 'async_launched' && !c.runInBackground);
  const launched = calls.filter((c) => c.responseStatus === 'async_launched' || c.runInBackground);
  const fgOk = foreground.filter((c) => c.responseAgentId && c.responseStatus === 'completed').length;
  const bgWithPost = launched.filter((c) => c.post);
  const bgOk = bgWithPost.filter((c) => c.responseAgentId && c.responseStatus === 'async_launched').length;
  const asyncCalls = calls.filter((c) => c.responseStatus === 'async_launched');
  const flagOk = asyncCalls.filter((c) => c.runInBackground).length;
  const withAgentId = calls.filter((c) => c.responseAgentId);
  const known = withAgentId.filter((c) => ctx.agents.get(c.responseAgentId)?.events.length).length;
  const checks = [
    check('nome da ferramenta é Agent', !calls.length ? I : Object.keys(names).every((n) => n === 'Agent') ? C : R, formatCounts(names) || 'nenhuma chamada'),
    check(
      'PostToolUse em primeiro plano com agentId e status "completed"',
      !foreground.length ? I : fgOk === foreground.length ? C : R,
      foreground.length ? `${fgOk} de ${foreground.length}` : 'nenhum PostToolUse de Agent em primeiro plano',
    ),
    check(
      'PostToolUse em segundo plano com agentId e status "async_launched"',
      !bgWithPost.length ? I : bgOk === bgWithPost.length ? C : R,
      bgWithPost.length ? `${bgOk} de ${bgWithPost.length}` : 'nenhum Agent em segundo plano com PostToolUse',
    ),
    check(
      'run_in_background: true no tool_input do segundo plano',
      !asyncCalls.length ? I : flagOk === asyncCalls.length ? C : R,
      asyncCalls.length ? `${flagOk} de ${asyncCalls.length}` : 'nenhum "async_launched"',
    ),
    check(
      'agentId da resposta é o agent_id dos eventos do subagente',
      !withAgentId.length ? I : known === withAgentId.length ? C : R,
      withAgentId.length ? `${known} de ${withAgentId.length}` : 'nenhum agentId',
    ),
  ];
  return item('V5', 'tool_response.agentId e status no PostToolUse do Agent; nome e run_in_background', checks, [
    `status vistos: ${formatCounts(countBy(calls.filter((c) => c.responseStatus), (c) => safeToken(c.responseStatus))) || 'nenhum'}`,
    `campos do tool_response (primeiro plano): ${keyUnionLists(foreground.map((c) => c.responseKeys)).join(', ') || 'nenhum'}`,
    `campos do tool_response (segundo plano): ${keyUnionLists(asyncCalls.map((c) => c.responseKeys)).join(', ') || 'nenhum'}`,
  ]);
}

function checkV6(ctx) {
  const all = [...ctx.agents.values()];
  const starts = ctx.events.filter((e) => e.hook === 'SubagentStart');
  const stops = ctx.events.filter((e) => e.hook === 'SubagentStop');
  const typedStarts = starts.filter((e) => e.agentType);
  const emptyStarts = starts.filter((e) => !e.agentType);
  const emptyStops = stops.filter((e) => !e.agentType);
  const phantomStarts = all.filter((a) => !a.call && a.startType);
  const phantomStops = all.filter((a) => !a.call && !a.starts.length && a.stopType);
  const resumed = all.filter((a) => a.starts.length > 1);
  const checks = [
    check(
      'SubagentStart com agent_type só para agentes delegados',
      !starts.length ? I : phantomStarts.length ? R : C,
      phantomStarts.length
        ? `${phantomStarts.length} sem chamada Agent: ${typeCounts(phantomStarts)}`
        : `${typedStarts.length} com tipo, todos ligados a uma chamada Agent`,
    ),
    check(
      'SubagentStop de agente interno vem com agent_type vazio',
      phantomStops.length ? R : emptyStops.length ? C : I,
      `${emptyStops.length} com agent_type vazio; ${phantomStops.length} de agentes desconhecidos com tipo${phantomStops.length ? ` (${typeCounts(phantomStops)})` : ''}`,
      false,
    ),
    check('SubagentStart de agente interno (tipo vazio)', emptyStarts.length ? C : I, `${emptyStarts.length} observados (o design os ignora)`, false),
    check('SubagentStart na retomada', resumed.length ? C : I, resumed.length ? `${resumed.length} agentes com mais de um SubagentStart` : 'nenhuma retomada observada', false),
  ];
  return item('V6', 'SubagentStart e SubagentStop de agentes internos e na retomada', checks, [
    `SubagentStart: ${starts.length}; SubagentStop: ${stops.length}; agentes sem chamada Agent: ${all.filter((a) => !a.call).length}`,
  ]);
}

function checkV7(ctx) {
  const backgroundStops = [...ctx.agents.values()].filter((a) => a.background === true).flatMap((a) => a.stops);
  const prompts = ctx.events.filter((e) => e.hook === 'UserPromptSubmit' && !e.agentId);
  const candidates = new Set();
  let answered = 0;
  for (const stop of backgroundStops) {
    const next = prompts.find((u) => u.session === stop.session && u.index > stop.index && u.receivedAt <= stop.receivedAt + RETURN_WINDOW_MS);
    if (next) {
      candidates.add(next);
      answered++;
    }
  }
  for (const u of prompts) if (tagOf(u.payload.prompt)) candidates.add(u);
  const returns = [...candidates];
  const users = prompts.filter((u) => !candidates.has(u));
  const tags = returns.map((u) => tagOf(u.payload.prompt));
  const common = tags.length && tags.every((t) => t && t === tags[0]) ? tags[0] : null;
  const usersWithTag = common ? users.filter((u) => tagOf(u.payload.prompt) === common).length : 0;
  const userKeys = new Set(users.flatMap((u) => Object.keys(u.payload)));
  const onlyInReturns = keyUnion(returns.map((u) => u.payload)).filter((k) => !userKeys.has(k));
  const returnTags = [...new Set(returns.flatMap((u) => [...str(u.payload.prompt).matchAll(/<([A-Za-z][\w-]{0,40})[\s>/]/g)].map((m) => safeKey(m[1]))))];
  const checks = [
    check(
      'retorno do segundo plano dispara UserPromptSubmit',
      backgroundStops.length && answered ? C : I,
      backgroundStops.length ? `${answered} de ${backgroundStops.length} SubagentStop em segundo plano seguidos de UserPromptSubmit em até 2 min` : 'nenhum subagente em segundo plano terminou',
    ),
    check(
      'retorno tem marca própria no início do prompt',
      !returns.length ? I : common && !usersWithTag ? C : R,
      !returns.length
        ? 'nenhum retorno identificado'
        : common
          ? `${returns.length} começam com <${safeToken(common)}>; pedidos do usuário com a mesma marca: ${usersWithTag}`
          : `${returns.length} sem marca comum (${returns.map((u) => promptShape(u.payload.prompt)).join(', ')}); conferir se não é o pedido seguinte do usuário`,
    ),
  ];
  return item('V7', 'Formato do prompt no UserPromptSubmit de retorno de subagente em segundo plano', checks, [
    `campos que só aparecem nos retornos: ${onlyInReturns.join(', ') || 'nenhum'}`,
    `tags dos retornos (só os nomes): ${returnTags.join(', ') || 'nenhuma'}`,
  ]);
}

function checkV8(ctx) {
  const sub = ctx.events.filter((e) => e.agentId);
  const subWith = sub.filter((e) => e.promptId).length;
  const prompts = ctx.events.filter((e) => e.hook === 'UserPromptSubmit' && !e.agentId);
  const ids = prompts.map((e) => e.promptId).filter(Boolean);
  const unique = new Set(ids).size;
  const linked = [...ctx.agents.values()].filter((a) => a.call?.promptId && a.events.length);
  const mismatched = linked.filter((a) => a.events.some((e) => e.promptId && e.promptId !== a.call.promptId));
  const mainEvents = ctx.events.filter((e) => !e.agentId && e.hook !== 'SessionStart');
  const checks = [
    check('prompt_id nos eventos dos subagentes', !sub.length ? I : subWith === sub.length ? C : R, `${subWith} de ${sub.length}`),
    check(
      'prompt_id diferente a cada pedido',
      prompts.length < 2 ? I : ids.length === prompts.length && unique === prompts.length ? C : R,
      `${unique} distintos em ${prompts.length} UserPromptSubmit (${prompts.length - ids.length} sem prompt_id)`,
    ),
    check(
      'prompt_id do subagente igual ao do pedido que o delegou',
      !linked.length ? I : mismatched.length ? R : C,
      mismatched.length ? `${mismatched.length} de ${linked.length} diferentes (${typeCounts(mismatched)})` : `${linked.length} de ${linked.length}`,
    ),
  ];
  return item('V8', 'prompt_id nos eventos dos subagentes e diferente a cada pedido', checks, [
    `eventos da sessão principal com prompt_id (sem contar SessionStart): ${mainEvents.filter((e) => e.promptId).length} de ${mainEvents.length}`,
  ]);
}

function checkV9(ctx) {
  const sub = ctx.events.filter((e) => e.agentId);
  const outside = sub.filter((e) => !ctx.mainSessions.has(e.session)).length;
  const crossed = [...ctx.agents.values()].filter((a) => a.call && a.events.some((e) => e.session !== a.call.session)).length;
  const transcripts = new Map();
  for (const e of ctx.events) if (!e.agentId && e.payload.transcript_path) transcripts.set(e.session, e.payload.transcript_path);
  const sameTranscript = sub.filter((e) => e.payload.transcript_path && transcripts.get(e.session) === e.payload.transcript_path).length;
  const checks = [check(
    'session_id dos subagentes igual ao da sessão principal',
    !sub.length ? I : outside || crossed ? R : C,
    `${sub.length - outside} de ${sub.length} eventos com o session_id de uma sessão principal; ${crossed} subagentes com session_id diferente da chamada Agent`,
  )];
  return item('V9', 'session_id dos subagentes igual ao da sessão principal', checks, [
    `eventos de subagente com o transcript_path da sessão principal: ${sameTranscript} de ${sub.length}`,
  ]);
}

// V10 exige as duas sessões (terminal e VS Code) e, no log do terminal, um
// "moved to the background" por execução (ADR 0001), com folga de 5% para
// linhas que o Claude Code não chega a gravar ao sair.
function checkV10(ctx, debug) {
  const clientBySession = new Map([...sessionSignatures(ctx)].map(([session, signature]) => [session, clientOf(signature)]));
  const sessionsOf = (client) => [...clientBySession.values()].filter((c) => c === client).length;
  const terminalEvents = ctx.events.filter((e) => clientBySession.get(e.session) !== 'vscode').length;
  const vscodeEvents = ctx.events.length - terminalEvents;
  let coverage = I;
  let coverageDetail = 'log não informado (--debug)';
  if (debug) {
    coverageDetail = `${debug.background} linhas para ${terminalEvents} execuções gravadas no terminal`;
    if (!debug.background) {
      coverage = R;
      coverageDetail += '; conferir a versão e o formato do log com --debug-samples';
    } else if (terminalEvents && debug.background >= terminalEvents * BACKGROUND_COVERAGE) {
      coverage = C;
    } else if (terminalEvents) {
      coverageDetail += '; cobertura parcial, conferir com --debug-samples';
    }
  }
  let errorVerdict = I;
  if (debug) errorVerdict = debug.probeErrors ? R : debug.hookErrors ? I : C;
  const checks = [
    check('node encontrado: a sonda gravou eventos', ctx.events.length ? C : I, `${ctx.events.length} eventos`),
    check('"moved to the background" para cada execução do terminal', coverage, coverageDetail),
    check(
      'sem erro de hook da sonda no log',
      errorVerdict,
      !debug ? 'log não informado (--debug)' : `${debug.probeErrors} erros citando a sonda; ${debug.hookErrors} linhas "hook error" no total`,
    ),
    check('sessão do terminal com eventos', sessionsOf('terminal') ? C : I, `${sessionsOf('terminal')} sessões, ${terminalEvents} eventos`),
    check(
      'sessão do VS Code com eventos',
      sessionsOf('vscode') ? C : I,
      sessionsOf('vscode') ? `${sessionsOf('vscode')} sessões, ${vscodeEvents} eventos` : 'nenhuma: falta o passo do VS Code do roteiro',
    ),
    check('sem aviso "hook error" na tela e sem janela piscando', I, 'confirmar com o usuário, no terminal e no VS Code (o relatório não tem como ver)', false),
  ];
  return item('V10', 'Hooks async não bloqueiam, não geram aviso e o node é encontrado', checks, debug
    ? [`linhas do log que citam a sonda: ${debug.probeLines}; eventos gravados: ${ctx.events.length}`]
    : []);
}

function checkV11(ctx) {
  const events = ctx.events;
  const withDir = events.filter((e) => e.env.projectDir).length;
  const signatures = sessionSignatures(ctx);
  const variables = new Set([...signatures.values()].flatMap((s) => Object.keys(s)));
  const discriminating = [];
  const present = [];
  for (const name of variables) {
    const values = new Set([...signatures.values()].map((s) => s[name] ?? '(ausente)'));
    present.push(name);
    if (values.size >= 2) discriminating.push(`${name} (${[...values].map(safeValue).join(' / ')})`);
  }
  const single = present.map((name) => `${name} = ${safeValue([...signatures.values()].find((s) => s[name])?.[name])}`);
  const names = countBy(events.flatMap((e) => e.env.names ?? []), (n) => n);
  const checks = [
    check('CLAUDE_PROJECT_DIR no processo do hook', !events.length ? I : withDir === events.length ? C : R, `${withDir} de ${events.length} eventos`),
    check(
      'variável que indique terminal ou VS Code',
      !events.length ? I : discriminating.length ? C : present.length ? I : R,
      discriminating.length
        ? `distinguem as sessões: ${discriminating.join('; ')}`
        : present.length
          ? `presentes com um só valor: ${single.join('; ')}; falta uma sessão do outro cliente`
          : 'nenhuma variável candidata: client fica null',
    ),
  ];
  return item('V11', 'Variáveis de ambiente do processo do hook', checks, [
    `variáveis vistas (só nomes, com quantidade de eventos): ${formatCounts(names) || 'não registradas (cenário sanitizado)'}`,
  ]);
}

function checkV12(ctx) {
  const interrupts = ctx.events.filter((e) => e.hook === 'PostToolUseFailure' && e.payload.is_interrupt === true);
  const escTurns = ctx.turns.filter((turn) => {
    if (turn.events.some((e) => e.hook === 'PostToolUseFailure' && e.payload.is_interrupt === true)) return true;
    if (!turn.closed || turn.events.some((e) => !e.agentId && (e.hook === 'Stop' || e.hook === 'StopFailure'))) return false;
    return turn.events.some((e) => e.hook === 'PreToolUse' && !e.agentId && !hasEnd(ctx, e));
  });
  const stopAfter = interrupts.filter((f) => {
    const turn = ctx.turns.find((t) => t.events.includes(f));
    return turn?.events.some((e) => e.hook === 'Stop' && !e.agentId && e.index > f.index);
  });
  const interruptedAgents = new Set(interrupts.filter((e) => e.agentId).map((e) => e.agentId));
  for (const turn of escTurns) {
    for (const e of turn.events) if (e.hook === 'PreToolUse' && e.agentId && !hasEnd(ctx, e)) interruptedAgents.add(e.agentId);
  }
  const withStop = [...interruptedAgents].filter((id) => ctx.agents.get(id)?.stops.length).length;
  const sequences = escTurns.map((turn) => {
    const from = turn.events.find((e) => e.hook === 'PostToolUseFailure' && e.payload.is_interrupt === true)
      ?? turn.events.filter((e) => e.hook === 'PreToolUse' && !hasEnd(ctx, e)).at(-1);
    const after = turn.events.filter((e) => e.index > from.index).map((e) => e.hook);
    return [from.hook, ...after].filter((h, i, list) => i === 0 || h !== list[i - 1]).join(' > ');
  });
  const checks = [
    check(
      'Esc observado',
      escTurns.length ? C : I,
      escTurns.length ? `${escTurns.length} turnos interrompidos; ${interrupts.length} PostToolUseFailure com is_interrupt` : 'nenhum turno interrompido',
    ),
    check(
      'nenhum Stop depois do Esc no mesmo turno',
      stopAfter.length ? R : escTurns.length ? C : I,
      stopAfter.length ? `${stopAfter.length} interrupções seguidas de Stop` : `${escTurns.length} turnos sem Stop`,
    ),
    check(
      'Esc gera PostToolUseFailure com is_interrupt',
      interrupts.length ? C : I,
      interrupts.length ? `${interrupts.length}` : escTurns.length ? 'turno interrompido sem PostToolUseFailure: a ferramenta ficou sem Post' : 'nenhum Esc',
      false,
    ),
    check(
      'SubagentStop de subagente interrompido',
      !interruptedAgents.size ? I : withStop === interruptedAgents.size ? C : R,
      interruptedAgents.size ? `${withStop} de ${interruptedAgents.size} subagentes interrompidos com SubagentStop` : 'nenhum subagente interrompido',
      false,
    ),
  ];
  return item('V12', 'Esc no meio de um turno: eventos que chegam e SubagentStop', checks, [
    `eventos a partir do Esc, até o próximo pedido: ${sequences.join(' | ') || 'nenhum'}`,
    `campos do PostToolUseFailure do Esc: ${keyUnion(interrupts.map((e) => e.payload)).join(', ') || 'nenhum'}`,
  ]);
}

function checkV13(ctx) {
  const entries = [];
  for (const e of ctx.events) {
    if ((e.hook !== 'Stop' && e.hook !== 'SubagentStop') || !Array.isArray(e.payload.background_tasks)) continue;
    for (const task of e.payload.background_tasks) if (isObject(task)) entries.push(task);
  }
  const agentEntries = entries.filter((t) => str(t.agent_type) || /agent/i.test(str(t.type)));
  const known = [...ctx.agents.keys()];
  const equal = agentEntries.filter((t) => ctx.agents.has(str(t.id))).length;
  const contains = agentEntries.filter((t) => !ctx.agents.has(str(t.id)) && known.some((id) => str(t.id).includes(id))).length;
  const checks = [check(
    'background_tasks[].id igual ao agent_id',
    !agentEntries.length ? I : equal === agentEntries.length ? C : R,
    agentEntries.length ? `${equal} de ${agentEntries.length} iguais${contains ? `; ${contains} contêm o agent_id` : ''}` : 'nenhuma tarefa de subagente em background_tasks',
  )];
  return item('V13', 'background_tasks[].id do Stop igual ao agent_id', checks, [
    `campos das tarefas: ${keyUnion(entries).join(', ') || 'nenhum'}`,
    `type: ${formatCounts(countBy(entries, (t) => safeToken(t.type))) || 'nenhum'}; status: ${formatCounts(countBy(entries, (t) => safeToken(t.status))) || 'nenhum'}`,
  ]);
}

function checkV14(ctx) {
  const pairs = pairsOf(ctx);
  const arrival = pairs.filter((p) => p.end.index < p.pre.index).length;
  const spawn = pairs.filter((p) => p.end.receivedAt < p.pre.receivedAt).length;
  const biggest = ctx.events.reduce((max, e) => Math.max(max, e.bytes), 0);
  const long = ctx.events.filter((e) => e.longPaths.length).length;
  const checks = [
    check(
      'pares Pre/Post medidos',
      pairs.length ? C : I,
      pairs.length ? `${pairs.length} pares; Post chegou antes do Pre em ${arrival} (${percent(arrival, pairs.length)}); disparado antes em ${spawn}` : 'nenhum par',
    ),
    check(
      'tamanho dos payloads medido',
      ctx.events.length ? C : I,
      ctx.events.length ? `${ctx.events.length} payloads; maior: ${biggest} bytes; com string acima de 4 KiB: ${long}` : 'nenhum payload',
    ),
  ];
  return item('V14', 'Frequência de Post antes do Pre e tamanho dos payloads', checks, ['detalhes nas seções "Tamanho dos payloads" e "Ordem e intervalos"']);
}

// ---------------------------------------------------------------------------
// Medidas.

function buildStats(ctx) {
  const byHook = countBy(ctx.events, (e) => e.hook);
  const sizes = {};
  for (const hook of Object.keys(byHook)) {
    const list = ctx.events.filter((e) => e.hook === hook);
    sizes[hook] = { ...summarize(list.map((e) => e.bytes)), long: list.filter((e) => e.longPaths.length).length };
  }
  const longFields = countBy(ctx.events.flatMap((e) => e.longPaths.map((p) => `${e.hook}: ${p}`)), (x) => x);
  const pairs = pairsOf(ctx);
  return {
    byHook,
    sizes,
    longFields,
    order: {
      pairs: pairs.length,
      postFirstArrival: pairs.filter((p) => p.end.index < p.pre.index).length,
      postFirstSpawn: pairs.filter((p) => p.end.receivedAt < p.pre.receivedAt).length,
      interval: summarize(pairs.map((p) => p.end.receivedAt - p.pre.receivedAt)),
    },
    dumpTime: summarize(ctx.events.filter((e) => e.raw).map((e) => e.writtenAt - e.receivedAt)),
  };
}

/**
 * Resume o log do --debug-file sem guardar o texto das linhas.
 * @param {string} text
 */
export function parseDebugLog(text) {
  const result = { lines: 0, background: 0, probeLines: 0, probeErrors: 0, hookErrors: 0, timings: null };
  const timings = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    result.lines++;
    const lower = line.toLowerCase();
    const isProbe = lower.includes('dump.mjs') || lower.includes('agent-quest-probe');
    if (lower.includes('moved to the background')) result.background++;
    if (isProbe) result.probeLines++;
    if (isProbe && ERRORISH.test(line)) result.probeErrors++;
    if (lower.includes('hook error')) result.hookErrors++;
    if (lower.includes('hook') && !lower.includes('timeout')) {
      for (const match of line.matchAll(/(\d+(?:\.\d+)?)\s?ms\b/g)) timings.push(Number(match[1]));
    }
  }
  result.timings = summarize(timings);
  return result;
}

/** Linhas do log que o relatório reconheceu (podem ter conteúdo; só com --debug-samples). */
export function debugSamples(text, limit) {
  return text.split(/\r?\n/)
    .filter((line) => /moved to the background|dump\.mjs|agent-quest-probe|hook error/i.test(line))
    .slice(0, limit)
    .map((line) => line.slice(0, 200));
}

// ---------------------------------------------------------------------------
// Texto do relatório.

/**
 * @param {ReturnType<typeof analyze>} result
 * @param {{ sources?: string[], problems?: { source: string, line: number, problem: string }[], debugSource?: string|null }} [meta]
 */
export function formatReport(result, meta = {}) {
  const problems = meta.problems ?? [];
  const out = [];
  out.push('Agent Quest: relatório da sonda do T0');
  out.push(`Entradas: ${meta.sources?.length ? meta.sources.map((s) => displayPath(s)).join(', ') : '(nenhuma)'}`);
  out.push(`Eventos: ${result.totals.events} válidos, ${problems.length} descartados; sessões: ${result.totals.sessions}; subagentes: ${result.totals.subagents}`);
  for (const p of problems.slice(0, 5)) out.push(`  descartado: ${path.basename(p.source)}, linha ${p.line}: ${p.problem}`);
  if (problems.length > 5) out.push(`  ... e mais ${problems.length - 5}`);
  out.push(`Log de depuração: ${meta.debugSource && result.debug ? `${displayPath(meta.debugSource)} (${result.debug.lines} linhas)` : 'não informado'}`);
  out.push('');
  out.push('Vereditos (+ confirmado, x refutado, ? sem dados; subitens "opcional" não decidem o veredito)');
  for (const it of result.items) {
    out.push(`${it.id.padEnd(4)} ${it.verdict.padEnd(13)} ${it.title}`);
    for (const c of it.checks) out.push(`       ${SYMBOL[c.verdict]} ${c.label}${c.required ? '' : ' (opcional)'}: ${c.detail}`);
    for (const note of it.notes) out.push(`       · ${note}`);
  }

  const { stats } = result;
  out.push('', 'Eventos por tipo');
  for (const [hook, n] of sortedEntries(stats.byHook)) out.push(`  ${safeToken(hook).padEnd(22)} ${String(n).padStart(6)}`);

  out.push('', 'Tamanho dos payloads (bytes)');
  out.push(`  ${'evento'.padEnd(22)} ${'n'.padStart(6)} ${'mediana'.padStart(9)} ${'p95'.padStart(9)} ${'máximo'.padStart(9)} ${'>4 KiB'.padStart(7)}`);
  for (const [hook, s] of Object.entries(stats.sizes)) {
    out.push(`  ${safeToken(hook).padEnd(22)} ${String(s.n).padStart(6)} ${String(s.median).padStart(9)} ${String(s.p95).padStart(9)} ${String(s.max).padStart(9)} ${String(s.long).padStart(7)}`);
  }
  const longFields = sortedEntries(stats.longFields);
  out.push('', 'Campos com strings acima de 4 KiB (evento: campo, quantidade)');
  if (!longFields.length) out.push('  nenhum');
  for (const [field, n] of longFields.slice(0, 15)) out.push(`  ${field}: ${n}`);

  out.push('', 'Ordem e intervalos');
  const { order } = stats;
  out.push(`  pares Pre/Post: ${order.pairs}; Post chegou antes do Pre: ${order.postFirstArrival} (${percent(order.postFirstArrival, order.pairs)}); disparado antes (receivedAt): ${order.postFirstSpawn}`);
  out.push(`  intervalo Pre → Post (ms): ${formatSummary(order.interval)}`);
  out.push(`  tempo dentro do dump.mjs (ms): ${formatSummary(stats.dumpTime)}`);

  if (result.debug) {
    const d = result.debug;
    out.push('', 'Log de depuração');
    out.push(`  "moved to the background": ${d.background}; linhas que citam a sonda: ${d.probeLines}; erros da sonda: ${d.probeErrors}; "hook error": ${d.hookErrors}`);
    out.push(`  tempos em linhas de hook (ms): ${formatSummary(d.timings)} (formato do log não documentado; confira com --debug-samples)`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Auxiliares.

function check(label, verdict, detail, required = true) {
  return { label, verdict, required, detail };
}

function item(id, title, checks, notes = []) {
  let verdict = C;
  if (checks.some((c) => c.verdict === R)) verdict = R;
  else if (checks.some((c) => c.required && c.verdict === I) || !checks.some((c) => c.verdict === C)) verdict = I;
  return { id, title, verdict, checks, notes };
}

function delegatedAgents(ctx) {
  return [...ctx.agents.values()].filter((a) => a.delegated);
}

/** Eventos de ferramenta sem agent_id começados durante um subagente em primeiro plano (a sessão principal está esperando). */
function orphanToolEvents(ctx) {
  const windows = [];
  for (const agent of ctx.agents.values()) {
    if (!agent.delegated || agent.background !== false) continue;
    const start = agent.starts[0] ?? agent.call?.pre;
    const end = agent.stops.at(-1) ?? agent.call?.post ?? agent.call?.fail;
    if (start && end) windows.push({ session: agent.session, from: start.receivedAt, to: end.receivedAt });
  }
  return ctx.toolEvents.filter((e) => {
    if (e.agentId || AGENT_TOOLS.has(e.toolName)) return false;
    const call = e.toolUseId ? ctx.calls.get(e.toolUseId) : null;
    const began = Math.min(...[call?.pre, call?.post, call?.fail, e].filter(Boolean).map((x) => x.receivedAt));
    return windows.some((w) => w.session === e.session && began > w.from && began < w.to);
  });
}

function hasEnd(ctx, pre) {
  const call = pre.toolUseId ? ctx.calls.get(pre.toolUseId) : null;
  return Boolean(call && (call.post || call.fail));
}

function pairsOf(ctx) {
  const pairs = [];
  for (const call of ctx.calls.values()) {
    const end = call.post ?? call.fail;
    if (call.pre && end) pairs.push({ pre: call.pre, end });
  }
  return pairs;
}

/** Valores das variáveis candidatas a indicar o cliente, no primeiro evento de cada sessão. */
function sessionSignatures(ctx) {
  const signatures = new Map();
  for (const e of ctx.events) {
    if (!e.session || signatures.has(e.session)) continue;
    const signature = {};
    for (const [name, value] of Object.entries(e.env.entrypoints)) if (CLIENT_VARS.test(name)) signature[name] = value;
    for (const name of e.env.names ?? []) if (CLIENT_VARS.test(name) && !(name in signature)) signature[name] = '(presente)';
    signatures.set(e.session, signature);
  }
  return signatures;
}

/**
 * Cliente de uma sessão. Vale primeiro o CLAUDE_CODE_ENTRYPOINT (ou o
 * `entrypoint` do cenário): "vscode" no valor indica a extensão. Sem ele,
 * variáveis VSCODE_* ou TERM_PROGRAM=vscode indicam a extensão. O resto é terminal.
 * @param {Record<string, string>} signature
 * @returns {'terminal'|'vscode'}
 */
function clientOf(signature) {
  const entry = signature.CLAUDE_CODE_ENTRYPOINT ?? signature.entrypoint;
  if (entry && entry !== '(presente)') return /vscode/i.test(entry) ? 'vscode' : 'terminal';
  const vscodeNames = Object.keys(signature).some((name) => /^VSCODE_/i.test(name));
  return vscodeNames || /vscode/i.test(signature.TERM_PROGRAM ?? '') ? 'vscode' : 'terminal';
}

function typesMatch(a, b) {
  return Boolean(a && b) && (a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`));
}

function tagOf(prompt) {
  return /^\s*<([A-Za-z][\w-]*)/.exec(str(prompt))?.[1] ?? null;
}

function promptShape(prompt) {
  const text = str(prompt);
  const tag = tagOf(text);
  if (tag) return `<${safeToken(tag)}>`;
  if (text.trimStart().startsWith('/')) return 'comando /';
  return `texto de ${text.length} caracteres`;
}

function keyField(input) {
  const value = obj(input).command ?? obj(input).file_path;
  return typeof value === 'string' ? value : null;
}

function longStringPaths(value, prefix = '', out = []) {
  if (typeof value === 'string') {
    if (value.length > LONG_STRING) out.push(prefix || '(raiz)');
  } else if (Array.isArray(value)) {
    for (const v of value) longStringPaths(v, `${prefix}[]`, out);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) longStringPaths(v, prefix ? `${prefix}.${safeKey(k)}` : safeKey(k), out);
  }
  return out;
}

function keyUnion(objects) {
  return [...new Set(objects.filter(isObject).flatMap((o) => Object.keys(o)))].map(safeKey).sort();
}

function keyUnionLists(lists) {
  return [...new Set(lists.flat())].map(safeKey).sort();
}

function safeKey(key) {
  return /^[\w-]{1,40}$/.test(key) ? key : '<chave>';
}

function safeValue(value) {
  return value === '(ausente)' || value === '(presente)' ? value : safeToken(value);
}

function typeCounts(agents) {
  return formatCounts(countBy(agents, (a) => safeToken(a.type || '(sem tipo)')), (n) => `×${n}`);
}

function countBy(list, keyOf) {
  const counts = {};
  for (const x of list) {
    const key = keyOf(x);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sortedEntries(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatCounts(counts, format = (n) => String(n)) {
  return sortedEntries(counts).map(([k, n]) => `${k} ${format(n)}`).join(', ');
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { n: sorted.length, min: sorted[0], median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), max: sorted.at(-1) };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

function formatSummary(s) {
  return s ? `n ${s.n}, mínimo ${s.min}, mediana ${s.median}, p95 ${s.p95}, máximo ${s.max}` : 'sem dados';
}

function percent(part, total) {
  return total ? `${((part / total) * 100).toFixed(1).replace('.', ',')}%` : '0%';
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

function obj(value) {
  return isObject(value) ? value : {};
}

// ---------------------------------------------------------------------------
// Linha de comando.

const USAGE = `Uso: node tools/probe/report.mjs [entrada ...] [--debug <arquivo>] [--json] [--debug-samples <N>]
  entrada: JSONL bruto (.jsonl), cenário (.json) ou pasta de cenários.
  Sem entrada: lê events.jsonl e debug.txt de ${displayPath(probeDir())}`;

/** @param {string[]} argv */
export function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        debug: { type: 'string' },
        json: { type: 'boolean' },
        'debug-samples': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const defaults = positionals.length === 0;
  const inputs = defaults ? [path.join(probeDir(), 'events.jsonl')] : positionals;
  if (defaults && !fs.existsSync(inputs[0])) {
    console.error(`Arquivo não encontrado: ${displayPath(inputs[0])}\nRode a sessão de teste (tools/probe/README.md) ou informe uma entrada.`);
    return 1;
  }
  let debugSource = values.debug ?? null;
  if (!debugSource && defaults) {
    const fallback = path.join(probeDir(), 'debug.txt');
    if (fs.existsSync(fallback)) debugSource = fallback;
  }
  let debugText = null;
  if (debugSource) {
    try {
      debugText = fs.readFileSync(debugSource, 'utf8');
    } catch {
      console.error(`Log de depuração não encontrado: ${displayPath(debugSource)}`);
      return 1;
    }
  }

  const { records, problems, sources } = loadInputs(inputs);
  const result = analyze(records, { debugText });
  if (values.json) {
    const shown = { sources: sources.map((s) => displayPath(s)), problems: problems.map((p) => ({ ...p, source: displayPath(p.source) })), debugSource: debugSource && displayPath(debugSource) };
    console.log(JSON.stringify({ ...shown, ...result }, null, 2));
  } else {
    console.log(formatReport(result, { sources, problems, debugSource }));
  }
  const samples = Number(values['debug-samples'] ?? 0);
  if (samples > 0 && debugText) {
    console.log('\nLinhas reconhecidas no log (podem ter conteúdo):');
    for (const line of debugSamples(debugText, samples)) console.log(`  ${line}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
