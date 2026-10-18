import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, formatReport, parseDebugLog } from '../../../tools/probe/report.mjs';
import { displayPath, loadInputs, parseFixture, parseJsonl, resolveDataDir } from '../../../tools/probe/records.mjs';
import { AGENTS, buildSyntheticProbe, cloneRecords, CONTENT_MARKERS, promptId, SESSION, WORKER } from './probe-synthetic.js';

const REPORT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/probe/report.mjs');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ITEM_IDS = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14'];

const synthetic = buildSyntheticProbe();

/** Registros da sessão sintética, depois de uma alteração opcional nos objetos gravados pelo dump. */
function recordsWith(change = () => {}) {
  const raw = cloneRecords(synthetic.records);
  change(raw);
  const jsonl = raw.map((r) => JSON.stringify(r)).join('\n');
  return parseJsonl(jsonl, 'sintetico.jsonl').records;
}

function verdicts(records, options) {
  return Object.fromEntries(analyze(records, options).items.map((it) => [it.id, it.verdict]));
}

function verdictOf(id, records, options) {
  return verdicts(records, options)[id];
}

const payloads = (raw, predicate) => raw.map((r) => r.payload).filter(predicate);
const isSub = (p) => Boolean(p.agent_id);

let tmp;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aq-probe-report-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('report.mjs: vereditos', () => {
  it('sessão sintética completa, com log: V1 a V14 confirmados', () => {
    const result = analyze(recordsWith(), { debugText: synthetic.debugText });
    assert.deepEqual(result.items.map((it) => it.id), ITEM_IDS);
    for (const it of result.items) assert.equal(it.verdict, 'confirmado', `${it.id}: ${JSON.stringify(it.checks)}`);
    assert.equal(result.totals.sessions, 3);
    assert.equal(result.totals.subagents, 8);
  });

  it('sem log de depuração, só o V10 fica inconclusivo', () => {
    const result = verdicts(recordsWith());
    assert.equal(result.V10, 'inconclusivo');
    for (const id of ITEM_IDS.filter((x) => x !== 'V10')) assert.equal(result[id], 'confirmado', id);
  });

  it('sem eventos, todos inconclusivos', () => {
    for (const [id, verdict] of Object.entries(verdicts([]))) assert.equal(verdict, 'inconclusivo', id);
  });

  it('V1 refutado: ferramentas de subagente em primeiro plano sem agent_id', () => {
    const records = recordsWith((raw) => {
      for (const p of payloads(raw, (p) => isSub(p) && /ToolUse/.test(p.hook_event_name))) {
        delete p.agent_id;
        delete p.agent_type;
      }
    });
    assert.equal(verdictOf('V1', records), 'refutado');
  });

  it('V1 refutado: agent_id sem agent_type', () => {
    const records = recordsWith((raw) => {
      for (const p of payloads(raw, (p) => isSub(p) && p.hook_event_name === 'PreToolUse')) delete p.agent_type;
    });
    assert.equal(verdictOf('V1', records), 'refutado');
  });

  it('V2 refutado: PermissionRequest de subagente sem agent_id', () => {
    const records = recordsWith((raw) => {
      for (const p of payloads(raw, (p) => isSub(p) && p.hook_event_name === 'PermissionRequest')) {
        delete p.agent_id;
        delete p.agent_type;
      }
    });
    assert.equal(verdictOf('V2', records), 'refutado');
  });

  it('V3 refutado: falha de Bash sem "Exit code"', () => {
    const records = recordsWith((raw) => {
      for (const p of payloads(raw, (p) => p.hook_event_name === 'PostToolUseFailure' && !p.is_interrupt)) p.error = 'Command failed';
    });
    assert.equal(verdictOf('V3', records), 'refutado');
  });

  it('V3 refutado: comando com saída diferente de zero chegou como PostToolUse', () => {
    const records = recordsWith((raw) => {
      const failure = raw.find((r) => r.payload.hook_event_name === 'PostToolUseFailure' && /exit\(3\)/.test(r.payload.tool_input.command));
      failure.payload.hook_event_name = 'PostToolUse';
      failure.payload.tool_response = { stdout: '', stderr: '' };
      delete failure.payload.error;
    });
    assert.equal(verdictOf('V3', records), 'refutado');
  });

  it('V4 refutado: a negação gerou PostToolUseFailure', () => {
    const records = recordsWith((raw) => {
      const deniedIds = new Set();
      const ended = new Set(payloads(raw, (p) => /^PostToolUse/.test(p.hook_event_name)).map((p) => p.tool_use_id));
      for (const p of payloads(raw, (p) => p.hook_event_name === 'PreToolUse' && !ended.has(p.tool_use_id) && /tmp-probe\/(y|w)\.txt/.test(p.tool_input.command ?? ''))) deniedIds.add(p.tool_use_id);
      for (const id of deniedIds) {
        const prePayload = raw.find((r) => r.payload.tool_use_id === id).payload;
        raw.push({ ...raw.at(-1), payload: { ...prePayload, hook_event_name: 'PostToolUseFailure', error: 'The user doesn\'t want to proceed' } });
      }
    });
    assert.equal(verdictOf('V4', records), 'refutado');
  });

  it('V5 refutado: PostToolUse do Agent sem agentId', () => {
    const records = recordsWith((raw) => {
      for (const p of payloads(raw, (p) => p.hook_event_name === 'PostToolUse' && p.tool_name === 'Agent')) delete p.tool_response.agentId;
    });
    assert.equal(verdictOf('V5', records), 'refutado');
  });

  it('V6 refutado: SubagentStart com tipo sem chamada Agent', () => {
    const records = recordsWith((raw) => {
      raw.push({ ...raw.at(-1), payload: { session_id: SESSION, hook_event_name: 'SubagentStart', agent_id: 'afantasma00000001', agent_type: 'claude-interno' } });
    });
    assert.equal(verdictOf('V6', records), 'refutado');
  });

  it('V7 refutado: retorno do segundo plano sem marca no início', () => {
    const records = recordsWith((raw) => {
      raw.find((r) => r.payload.prompt_id === promptId('p07r') && r.payload.hook_event_name === 'UserPromptSubmit').payload.prompt = 'O agente terminou';
    });
    assert.equal(verdictOf('V7', records), 'refutado');
  });

  it('V8 refutado: eventos de subagente sem prompt_id', () => {
    const records = recordsWith((raw) => {
      for (const p of payloads(raw, isSub)) delete p.prompt_id;
    });
    assert.equal(verdictOf('V8', records), 'refutado');
  });

  it('V9 refutado: subagente com session_id próprio', () => {
    const records = recordsWith((raw) => {
      for (const p of payloads(raw, (p) => p.agent_id === AGENTS.w1.id)) p.session_id = 'sessao-do-subagente';
    });
    assert.equal(verdictOf('V9', records), 'refutado');
  });

  it('V10 refutado: log sem "moved to the background"; e com erro da sonda', () => {
    assert.equal(verdictOf('V10', recordsWith(), { debugText: 'linha sem nada\noutra linha' }), 'refutado');
    const withError = `${synthetic.debugText}\nHook PreToolUse (agent-quest-probe) failed: spawn node ENOENT`;
    assert.equal(verdictOf('V10', recordsWith(), { debugText: withError }), 'refutado');
  });

  it('V10 só confirma com terminal e VS Code e um "moved to the background" por execução do terminal', () => {
    const vscode = synthetic.records.find((r) => r.env.values.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode').payload.session_id;
    const terminalOnly = recordsWith((raw) => raw.splice(0, raw.length, ...raw.filter((r) => r.payload.session_id !== vscode)));
    const v10 = (records, debugText) => analyze(records, { debugText }).items.find((it) => it.id === 'V10');
    const missingVscode = v10(terminalOnly, synthetic.debugText);
    assert.equal(missingVscode.verdict, 'inconclusivo');
    assert.ok(missingVscode.checks.some((c) => c.label === 'sessão do VS Code com eventos' && c.required && c.verdict === 'inconclusivo'));

    const lines = synthetic.debugText.split('\n');
    const background = lines.filter((l) => l.includes('moved to the background'));
    assert.equal(v10(recordsWith(), background.slice(0, 10).join('\n')).verdict, 'inconclusivo', 'cobertura parcial');
    assert.equal(v10(recordsWith(), background.join('\n')).verdict, 'confirmado', 'uma linha por evento');
  });

  it('V11: sem CLAUDE_PROJECT_DIR é refutado; com um só cliente é inconclusivo', () => {
    const noDir = recordsWith((raw) => {
      for (const r of raw) delete r.env.values.CLAUDE_PROJECT_DIR;
    });
    assert.equal(verdictOf('V11', noDir), 'refutado');
    const terminalOnly = recordsWith((raw) => {
      for (const r of raw) {
        r.env.values.CLAUDE_CODE_ENTRYPOINT = 'cli';
        r.env.names = r.env.names.filter((n) => n !== 'VSCODE_PID');
      }
    });
    assert.equal(verdictOf('V11', terminalOnly), 'inconclusivo');
  });

  it('V12 refutado: Stop depois do Esc', () => {
    const records = recordsWith((raw) => {
      const i = raw.findIndex((r) => r.payload.hook_event_name === 'PostToolUseFailure' && r.payload.is_interrupt && !r.payload.agent_id);
      const stop = { ...raw[i].payload, hook_event_name: 'Stop', background_tasks: [] };
      delete stop.tool_name;
      raw.splice(i + 1, 0, { ...raw[i], payload: stop });
    });
    assert.equal(verdictOf('V12', records), 'refutado');
  });

  it('V13 refutado: background_tasks[].id diferente do agent_id', () => {
    const records = recordsWith((raw) => {
      for (const p of payloads(raw, (p) => p.hook_event_name === 'Stop')) {
        for (const task of p.background_tasks) task.id = 'tarefa-1';
      }
    });
    assert.equal(verdictOf('V13', records), 'refutado');
  });

  it('V14 mede a ordem: o Post fora de ordem é contado', () => {
    const result = analyze(recordsWith());
    assert.equal(result.stats.order.postFirstArrival, 1);
    assert.equal(result.stats.order.postFirstSpawn, 0);
    assert.ok(result.stats.order.pairs > 20);
    assert.ok(result.stats.sizes.PreToolUse.max >= result.stats.sizes.PreToolUse.median);
  });

  it('casa o PermissionRequest com o PreToolUse pelo inputHash', () => {
    const v2 = analyze(recordsWith()).items.find((it) => it.id === 'V2');
    assert.match(v2.notes[0], /inputHash 14/);
  });

  it('elo provisório pela fila do tipo quando falta o PostToolUse do Agent', () => {
    const records = recordsWith((raw) => {
      for (let i = raw.length - 1; i >= 0; i--) {
        if (raw[i].payload.hook_event_name === 'PostToolUse' && raw[i].payload.tool_name === 'Agent') raw.splice(i, 1);
      }
    });
    const v1 = analyze(records).items.find((it) => it.id === 'V1');
    assert.equal(v1.verdict, 'confirmado');
    assert.match(v1.notes[0], new RegExp(`${WORKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ×7`));
  });
});

describe('report.mjs: texto e log', () => {
  it('o relatório não mostra conteúdo dos payloads', () => {
    const records = recordsWith();
    const result = analyze(records, { debugText: synthetic.debugText });
    const text = `${formatReport(result, { sources: ['x.jsonl'], problems: [] })}\n${JSON.stringify(result)}`;
    for (const marker of [...CONTENT_MARKERS, 'console.log', 'fulano', 'Projetos', 'CLAUDE.md', 'Ler o CLAUDE', 'claude-opus', SESSION, AGENTS.w1.id, promptId('p01')]) {
      assert.ok(!text.includes(marker), `vazou: ${marker}`);
    }
  });

  it('formatReport lista os 14 itens e as seções de medidas', () => {
    const text = formatReport(analyze(recordsWith(), { debugText: synthetic.debugText }), { sources: ['x.jsonl'], problems: [], debugSource: 'debug.txt' });
    for (const id of ITEM_IDS) assert.match(text, new RegExp(`^${id}\\s+confirmado`, 'm'));
    for (const section of ['Eventos por tipo', 'Tamanho dos payloads (bytes)', 'Ordem e intervalos', 'Log de depuração']) assert.ok(text.includes(section), section);
  });

  it('parseDebugLog conta "moved to the background", erros e tempos', () => {
    const log = [
      'x [DEBUG] Hook PreToolUse (agent-quest-probe) moved to the background',
      'x [DEBUG] Hook PostToolUse (agent-quest-probe) moved to the background',
      'x [DEBUG] Hook PostToolUse dump.mjs completed in 80ms',
      'x [DEBUG] Hook Stop hook error: algo',
      'x [DEBUG] Hook Stop (agent-quest-probe) failed: ENOENT',
      'x [DEBUG] Hook timeout 600000ms',
      '',
    ].join('\r\n');
    const d = parseDebugLog(log);
    assert.equal(d.lines, 6);
    assert.equal(d.background, 2);
    assert.equal(d.probeLines, 4);
    assert.equal(d.probeErrors, 1);
    assert.equal(d.hookErrors, 1);
    assert.deepEqual(d.timings, { n: 1, min: 80, median: 80, p95: 80, max: 80 });
  });
});

describe('records.mjs', () => {
  it('parseJsonl descarta linhas inválidas e registros sem payload', () => {
    const text = [
      JSON.stringify({ probe: 1, receivedAt: 1, writtenAt: 2, bytes: 10, env: { names: [], values: {} }, payload: { hook_event_name: 'Stop', session_id: 's' } }),
      '{ quebrado',
      JSON.stringify({ probe: 1, receivedAt: 1, error: 'invalid-json', head: 'x' }),
      JSON.stringify({ probe: 1, receivedAt: 1, payload: { session_id: 's' } }),
      '',
    ].join('\r\n');
    const { records, problems } = parseJsonl(text, 'a.jsonl');
    assert.equal(records.length, 1);
    assert.deepEqual(problems.map((p) => p.line), [2, 3, 4]);
    assert.match(problems[1].problem, /invalid-json/);
  });

  it('parseFixture soma os dt e lê o env do envelope', () => {
    const { records, endTime } = parseFixture({
      name: 'x',
      description: 'y',
      events: [
        { dt: 0, env: { projectDir: 'C:\\p', entrypoint: 'cli' }, payload: { hook_event_name: 'SessionStart', session_id: 's' } },
        { dt: 250, env: { projectDir: 'C:\\p', entrypoint: null }, payload: { hook_event_name: 'Stop', session_id: 's' } },
      ],
    }, 'x.json', 1000);
    assert.deepEqual(records.map((r) => r.receivedAt), [1000, 1250]);
    assert.equal(endTime, 1250);
    assert.equal(records[0].env.projectDir, 'C:\\p');
    assert.deepEqual(records[0].env.entrypoints, { entrypoint: 'cli' });
    assert.deepEqual(records[1].env.entrypoints, {});
    assert.equal(records[0].env.names, null);
  });

  it('loadInputs lê JSONL, cenários soltos e pastas de cenários', () => {
    const dir = path.join(tmp, 'entradas');
    mkdirSync(path.join(dir, 'cenarios'), { recursive: true });
    writeFileSync(path.join(dir, 'bruto.jsonl'), synthetic.jsonl);
    const fixture = (name) => ({ name, description: name, events: [{ dt: 0, env: {}, payload: { hook_event_name: 'Stop', session_id: name } }] });
    writeFileSync(path.join(dir, 'cenarios', 'b.json'), JSON.stringify(fixture('b')));
    writeFileSync(path.join(dir, 'cenarios', 'a.json'), JSON.stringify(fixture('a')));
    writeFileSync(path.join(dir, 'cenarios', 'ignorado.txt'), 'x');
    const { records, sources, problems } = loadInputs([path.join(dir, 'bruto.jsonl'), path.join(dir, 'cenarios'), path.join(dir, 'nao-existe.json')]);
    assert.equal(records.length, synthetic.records.length + 2);
    assert.deepEqual(records.slice(-2).map((r) => r.payload.session_id), ['a', 'b']);
    assert.ok(records.at(-1).receivedAt - records.at(-2).receivedAt >= 600_000, 'cenários separados no tempo');
    assert.deepEqual(records.map((r) => r.index), records.map((_, i) => i));
    assert.equal(sources.length, 3);
    assert.equal(problems.length, 1);
  });

  it('displayPath esconde a pasta pessoal: relativo ao repositório, %LOCALAPPDATA% ou ~', () => {
    const home = os.homedir();
    const env = { LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
    assert.equal(displayPath(path.join(env.LOCALAPPDATA, 'agent-quest', 'probe', 'events.jsonl'), env, home), `%LOCALAPPDATA%${path.sep}agent-quest${path.sep}probe${path.sep}events.jsonl`);
    assert.equal(displayPath(path.join(home, 'outra', 'a.txt'), env, home), `~${path.sep}outra${path.sep}a.txt`);
    assert.equal(displayPath(path.join(REPO, 'test', 'fixtures', 'hooks'), env, home), path.join('test', 'fixtures', 'hooks'));
    assert.equal(displayPath(`${home}x${path.sep}a`, env, home), path.resolve(`${home}x${path.sep}a`), 'só corta na fronteira de pasta');
  });

  it('resolveDataDir segue AGENT_QUEST_HOME, depois LOCALAPPDATA', () => {
    assert.equal(resolveDataDir({ AGENT_QUEST_HOME: path.join(tmp, 'h') }, 'win32'), path.join(tmp, 'h'));
    assert.equal(resolveDataDir({ LOCALAPPDATA: 'C:\\L' }, 'win32'), path.join('C:\\L', 'agent-quest'));
    assert.equal(resolveDataDir({ AGENT_QUEST_HOME: '  ', XDG_STATE_HOME: '/st' }, 'linux'), path.join('/st', 'agent-quest'));
  });
});

describe('report.mjs: linha de comando', () => {
  function run(args, env = {}) {
    return spawnSync(process.execPath, [REPORT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_QUEST_HOME: path.join(tmp, 'dados-cli'), ...env },
      windowsHide: true,
    });
  }

  it('--json sobre um JSONL e um log', () => {
    const dir = path.join(tmp, 'cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'events.jsonl'), synthetic.jsonl);
    writeFileSync(path.join(dir, 'debug.txt'), synthetic.debugText);
    const result = run([path.join(dir, 'events.jsonl'), '--debug', path.join(dir, 'debug.txt'), '--json']);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.items.map((it) => it.verdict), ITEM_IDS.map(() => 'confirmado'));
  });

  it('sem entrada, lê <dados>\\probe e avisa se não houver arquivo', () => {
    const missing = run([]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Arquivo não encontrado/);

    const probe = path.join(tmp, 'dados-cli', 'probe');
    mkdirSync(probe, { recursive: true });
    writeFileSync(path.join(probe, 'events.jsonl'), synthetic.jsonl);
    writeFileSync(path.join(probe, 'debug.txt'), synthetic.debugText);
    const ok = run([]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^V10\s+confirmado/m, 'usou o debug.txt padrão');
    const home = os.homedir().toLowerCase();
    for (const output of [ok.stdout, missing.stderr, run(['--help']).stdout, run(['--json']).stdout]) {
      assert.ok(!output.toLowerCase().includes(home), 'a saída não mostra a pasta pessoal');
    }
  });

  it('opção desconhecida termina com erro e a ajuda', () => {
    const result = run(['--nao-existe']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Uso:/);
  });
});
