// Integração da sonda do T0 (tester): o caminho completo que o dev-backend vai
// seguir depois da sessão de teste, pelas linhas de comando reais:
//   JSONL bruto -> report.mjs -> sanitize.mjs (um cenário por trecho) -> report.mjs sobre os cenários
// e tentativas de fazer conteúdo real, segredos, ids reais ou o nome do usuário
// vazarem para um cenário gravado (o repositório é público).
//
// O JSONL usa a pasta pessoal real desta máquina (os.homedir()), porque é com
// ela que o sanitize.mjs roda de verdade. Este arquivo não contém o nome do
// usuário: ele é calculado na hora. Os cenários vão para uma pasta temporária
// (--out) e o diretório de dados é sempre temporário (AGENT_QUEST_HOME).
//
// Os testes marcados com `todo` reproduzem bugs abertos no relatório do tester.
// Eles rodam e mostram a falha, mas não deixam a suíte vermelha enquanto o
// dev-backend corrige; quem corrigir tira o `todo`. Os testes dos bugs B1 a B7
// (já corrigidos) ficam como regressão.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact } from '../../server/domain/redact.js';
import { buildSyntheticProbe, CONTENT_MARKERS, HOME as FAKE_HOME, SESSION_VSCODE } from '../unit/tools/probe-synthetic.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SANITIZE = path.join(REPO, 'tools', 'probe', 'sanitize.mjs');
const REPORT = path.join(REPO, 'tools', 'probe', 'report.mjs');

const REAL_HOME = os.homedir();
const pathApi = REAL_HOME.includes('\\') ? path.win32 : path.posix;
const USER = pathApi.basename(REAL_HOME);
const USERS_DIR = pathApi.basename(pathApi.dirname(REAL_HOME));
const BS = '\\';

// Oráculo próprio de ids (independente do collectIds do sanitize.mjs).
const ID_KEY_ORACLE = new Set(['session_id', 'prompt_id', 'tool_use_id', 'agent_id', 'agentId', 'id', 'task_id']);
const MARKER = /«[^«»]*»/g;

let tmp;
let dataDir;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aq-int-probe-pipeline-'));
  dataDir = path.join(tmp, 'dados');
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Auxiliares.

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/** Sessão sintética do roteiro, com a pasta pessoal real no lugar da fictícia. */
function realHomeRecords() {
  const fakeUser = path.win32.basename(FAKE_HOME);
  return buildSyntheticProbe().records.map((r) => mapStrings(r, (s) => s
    .replaceAll(FAKE_HOME, REAL_HOME)
    .replaceAll(`c--${USERS_DIR}-${fakeUser}-`, `c--${USERS_DIR}-${USER}-`)));
}

function toJsonl(records) {
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

function record(payload, at = 1_760_000_000_000, env = {}) {
  return {
    probe: 1, receivedAt: at - 40, writtenAt: at, bytes: Buffer.byteLength(JSON.stringify(payload)),
    env: { names: ['CLAUDE_PROJECT_DIR'], values: { CLAUDE_PROJECT_DIR: `${REAL_HOME}${BS}Projetos${BS}agents-quest`, ...env } },
    payload,
  };
}

/** Toda saída dos CLIs (stdout e stderr), para conferir que nenhuma mensagem mostra a pasta pessoal. */
const cliOutputs = [];

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AGENT_QUEST_HOME: dataDir },
  });
  cliOutputs.push({ args: `${path.basename(script)} ${args.slice(0, 2).join(' ')}`, text: `${result.stdout}\n${result.stderr}` });
  return result;
}

let caseSeq = 0;
/** Grava o JSONL, roda o sanitize.mjs e devolve o resultado e o cenário (se gravado). */
function sanitizeCase(records, selection = ['--lines', `1-${records.length}`]) {
  const dir = path.join(tmp, `caso-${++caseSeq}`);
  mkdirSync(dir, { recursive: true });
  const input = path.join(dir, 'events.jsonl');
  writeFileSync(input, toJsonl(records));
  const out = path.join(dir, 'cenario.json');
  const result = run(SANITIZE, ['--in', input, '--name', `caso-${caseSeq}`, '--description', 'caso do tester', ...selection, '--out', out]);
  const fixture = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  return { result, fixture, text: fixture ? JSON.stringify(fixture) : '' };
}

/** Ids reais do JSONL, pelo oráculo do tester: chaves de id e ids das tags dos pedidos. */
function realIds(records) {
  const ids = new Set();
  const visit = (value, key) => {
    if (typeof value === 'string') {
      if (ID_KEY_ORACLE.has(key)) ids.add(value);
      if (key === 'prompt') for (const m of value.matchAll(/<(task-id|tool-use-id)>([^<]+)</g)) ids.add(m[2].trim());
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  for (const r of records) visit(r.payload, '');
  return [...ids].filter((id) => id.length >= 8);
}

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); strings(v, out); }
  return out;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Tudo o que um cenário gravado nunca pode ter. Confere também as chaves dos objetos.
 * Ids sem diferenciar maiúsculas. Toda string tem que ser ponto fixo do redact: é
 * a guarda que o T5 vai aplicar aos cenários (plano, T5).
 */
function assertClean(fixture, { ids = [], forbidden = [] } = {}) {
  const text = JSON.stringify(fixture);
  const lower = text.toLowerCase();
  assert.ok(!lower.includes(USER.toLowerCase()), 'nome do usuário no cenário');
  for (const id of ids) assert.ok(!lower.includes(id.toLowerCase()), `id original no cenário: ${id.slice(0, 6)}…`);
  for (const marker of CONTENT_MARKERS) assert.ok(!text.includes(marker), `conteúdo no cenário: ${marker}`);
  for (const value of forbidden) assert.ok(!text.includes(value), `valor proibido no cenário: ${value.slice(0, 12)}…`);
  for (const s of strings(fixture)) {
    const bare = s.replace(MARKER, '');
    // Caractere = ponto de código (seção 10, charLength), não unidade UTF-16.
    const chars = Array.from(bare).length; // oráculo próprio; o redact-spec confere que charLength dá o mesmo
    assert.ok(chars <= 200, `string com ${chars} caracteres fora dos marcadores`);
    assert.ok(!LONE_SURROGATE.test(s), `surrogate partido em ${JSON.stringify(s.slice(0, 40))}`);
    assert.equal(redact(s), s, 'o redact ainda muda uma string do cenário (guarda do T5)');
  }
}

/** O CLI pode gravar um cenário limpo ou recusar (código 2, nada gravado). Nunca gravar sujo. */
function assertCleanOrRefused({ result, fixture }, options) {
  if (result.status === 2) {
    assert.equal(fixture, null, 'recusou, mas gravou');
    return 'recusado';
  }
  assert.equal(result.status, 0, result.stderr);
  assertClean(fixture, options);
  return 'gravado';
}

function verdictsOf(json) {
  return Object.fromEntries(json.items.map((it) => [it.id, it.verdict]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------

describe('caminho completo pelas linhas de comando: JSONL -> relatório -> cenários -> relatório', () => {
  const records = realHomeRecords();
  const scenarios = {};
  let rawVerdicts;
  let rawText;

  before(() => {
    const dir = path.join(tmp, 'pipeline');
    mkdirSync(path.join(dir, 'cenarios'), { recursive: true });
    const input = path.join(dir, 'events.jsonl');
    const debug = path.join(dir, 'debug.txt');
    writeFileSync(input, toJsonl(records));
    writeFileSync(debug, buildSyntheticProbe().debugText);

    const json = run(REPORT, [input, '--debug', debug, '--json']);
    assert.equal(json.status, 0, json.stderr);
    rawVerdicts = verdictsOf(JSON.parse(json.stdout));
    const text = run(REPORT, [input, '--debug', debug]);
    assert.equal(text.status, 0, text.stderr);
    rawText = text.stdout;

    // Trechos como o README manda: --lines para o básico (com o SessionStart) e --prompts para o resto.
    const main = records.map((r, i) => ({ r, line: i + 1 }))
      .filter(({ r }) => r.payload.hook_event_name === 'UserPromptSubmit' && !r.payload.agent_id);
    const vscodeStart = records.findIndex((r) => r.payload.session_id === SESSION_VSCODE) + 1;
    const plan = [
      ['basico', ['--lines', `1-${main[1].line - 1}`]],
      ['comando-com-falha', ['--prompts', '2']],
      ['teste-falha-depois-passa', ['--prompts', '3']],
      ['aprovacao-principal', ['--prompts', '4']],
      ['paralelo-mesmo-tipo', ['--prompts', '5']],
      ['aprovacao-subagente', ['--prompts', '6']],
      ['segundo-plano', ['--prompts', '7-8']],
      ['aninhado', ['--prompts', '9']],
      ['agente-do-projeto', ['--prompts', '10']],
      ['interrupcao-esc', ['--prompts', '11']],
      ['interrupcao-esc-subagente', ['--prompts', '12']],
      ['compactacao-e-clear', ['--lines', `${main[12].line}-${vscodeStart - 1}`]],
      ['vscode', ['--lines', `${vscodeStart}-${records.length}`]],
    ];
    for (const [name, selection] of plan) {
      const out = path.join(dir, 'cenarios', `${name}.json`);
      const result = run(SANITIZE, ['--in', input, '--name', name, '--description', `Cenário ${name}`, ...selection, '--out', out]);
      scenarios[name] = { result, fixture: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
    }
    scenarios.dir = path.join(dir, 'cenarios');
  });

  it('o relatório sobre o JSONL dá veredito para V1 a V14 (todos confirmados na sessão sintética completa)', () => {
    assert.deepEqual(Object.keys(rawVerdicts), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14']);
    for (const [id, verdict] of Object.entries(rawVerdicts)) assert.equal(verdict, 'confirmado', id);
  });

  it('o texto do relatório não tem ids, conteúdo nem segredos dos payloads', () => {
    for (const id of realIds(records)) assert.ok(!rawText.includes(id), `id no relatório: ${id.slice(0, 6)}…`);
    for (const marker of CONTENT_MARKERS) assert.ok(!rawText.includes(marker), marker);
  });

  it('os 13 cenários são gravados pelo CLI, sem recusa da conferência', () => {
    for (const [name, { result, fixture }] of Object.entries(scenarios)) {
      if (name === 'dir') continue;
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.ok(fixture && fixture.events.length > 0, name);
      assert.deepEqual(Object.keys(fixture), ['name', 'description', 'events'], name);
    }
  });

  it('nenhum cenário tem id real, nome do usuário, conteúdo ou string longa (inclusive nas chaves)', () => {
    const ids = realIds(records);
    assert.ok(ids.length > 30, `ids reais conhecidos: ${ids.length}`);
    for (const [name, { fixture }] of Object.entries(scenarios)) {
      if (name === 'dir') continue;
      assertClean(fixture, { ids, forbidden: ['abc.def.ghi', 'senha-da-url'] });
    }
  });

  it('os ids sintéticos têm a forma dos reais e os elos continuam valendo dentro e entre cenários', () => {
    const all = Object.entries(scenarios).filter(([n]) => n !== 'dir').flatMap(([, s]) => s.fixture.events.map((e) => e.payload));
    for (const p of all) {
      assert.match(p.session_id, UUID);
      if (p.prompt_id) assert.match(p.prompt_id, UUID);
      if (p.agent_id) assert.match(p.agent_id, /^a[0-9a-f]{16}$/);
      if (p.tool_use_id) assert.match(p.tool_use_id, /^toolu_01[A-Za-z0-9]{22}$/);
      if (p.transcript_path) assert.ok(p.transcript_path.includes(`${p.session_id}.jsonl`), 'transcript_path com o id sintético da sessão');
      if (p.agent_transcript_path) assert.ok(p.agent_transcript_path.endsWith(`agent-${p.agent_id}.jsonl`), 'agent-<id>.jsonl com o id sintético');
    }
    const background = scenarios['segundo-plano'].fixture.events.map((e) => e.payload);
    const launched = background.find((p) => p.hook_event_name === 'PostToolUse' && p.tool_response?.status === 'async_launched');
    const agentId = launched.tool_response.agentId;
    assert.ok(background.some((p) => p.agent_id === agentId), 'agentId da resposta = agent_id dos eventos');
    assert.ok(launched.tool_response.outputFile.includes(`${agentId}.output`), 'outputFile com o id sintético');
    const stop = background.find((p) => p.hook_event_name === 'Stop' && p.background_tasks.length);
    assert.equal(stop.background_tasks[0].id, agentId, 'background_tasks[].id = agent_id');
    const notice = background.find((p) => p.hook_event_name === 'UserPromptSubmit' && p.prompt.startsWith('<task-notification>'));
    assert.ok(notice.prompt.includes(`<task-id>${agentId}</task-id>`), 'task-id da notificação = agent_id');
    assert.ok(notice.prompt.includes(`<tool-use-id>${launched.tool_use_id}</tool-use-id>`), 'tool-use-id da notificação = tool_use_id');
    // Mesmo id real, mesmo id sintético entre cenários: a sessão do terminal aparece em vários.
    const sessions = new Set(['basico', 'comando-com-falha', 'paralelo-mesmo-tipo'].map((n) => scenarios[n].fixture.events[0].payload.session_id));
    assert.equal(sessions.size, 1);
  });

  it('o relatório sobre a pasta de cenários reproduz os vereditos do JSONL, exceto o V10 (sem log)', () => {
    const json = run(REPORT, [scenarios.dir, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed.problems, []);
    const fixtureVerdicts = verdictsOf(parsed);
    for (const [id, verdict] of Object.entries(rawVerdicts)) {
      if (id === 'V10') assert.equal(fixtureVerdicts[id], 'inconclusivo', 'V10 sem log');
      else assert.equal(fixtureVerdicts[id], verdict, id);
    }
  });
});

describe('tentativas de vazamento para um cenário gravado', () => {
  const sid = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
  const aid = 'a0f1e2d3c4b5a6978';
  const base = (hook, extra = {}) => ({
    session_id: sid,
    transcript_path: `${REAL_HOME}${BS}.claude${BS}projects${BS}c--${USERS_DIR}-${USER}-Projetos-agents-quest${BS}${sid}.jsonl`,
    cwd: `${REAL_HOME}${BS}Projetos${BS}agents-quest`,
    permission_mode: 'default',
    hook_event_name: hook,
    ...extra,
  });
  let seq = 0;
  const toolu = () => `toolu_01Ab${String(++seq).padStart(4, '0')}CdEfGhIjKlMnOpQr`;

  it('segredos dos formatos da seção 10 em comando, descrição, erro, padrão, consulta, URL e caminho: o cenário sai sem nenhum', () => {
    const secrets = {
      'sk-ant': 'sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2',
      'sk': 'sk-proj-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1',
      ghp: 'ghp_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0',
      gho: 'gho_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0',
      ghs: 'ghs_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0',
      github_pat: 'github_pat_11ZX9YW8VU0Ts6Rq5Po4Nm3Lk2Jh1Gf0',
      akia: 'AKIAZX9YW8VU7TS6RQ5P',
      xoxb: 'xoxb-123456789012-Zx9Yw8Vu7Ts6',
      aiza: 'AIzaSyZx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZXIifQ.Zx9Yw8Vu7Ts6Rq5Po4Nm3',
      bearer: 'Zx9Yw8Vu7Ts6Rq5BEARER',
      pem: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      password: 'Hunter2Password',
      passwd: 'Hunter2Passwd',
      pwd: 'Hunter2Pwd',
      secret: 'Hunter2Secret',
      token: 'Hunter2Token',
      api_key: 'Hunter2ApiKey',
      apikey: 'Hunter2Apikey',
      authorization: 'Hunter2Authorization',
      urlpass: 'Hunter2UrlPass',
      MY_TOKEN: 'Hunter2MyToken',
      DB_PASSWORD: 'Hunter2DbPassword',
    };
    const s = secrets;
    const commands = [
      `export ANTHROPIC_API_KEY=${s['sk-ant']} && node app.js`,
      `curl -H "Authorization: Bearer ${s.bearer}" https://api.example.com`,
      `OPENAI=${s.sk} GH=${s.ghp} node x.js ${s.gho} ${s.ghs} ${s.github_pat}`,
      `aws configure set aws_access_key_id ${s.akia} && echo ${s.xoxb} ${s.aiza}`,
      `node jwt.js ${s.jwt}`,
      `echo "-----BEGIN PRIVATE KEY-----${s.pem}-----END PRIVATE KEY-----"`,
      `mysql password=${s.password} passwd=${s.passwd} pwd=${s.pwd}`,
      `node app.js secret=${s.secret} token=${s.token} api_key=${s.api_key} apikey=${s.apikey}`,
      `curl -H "authorization: ${s.authorization}" https://x`,
      `psql postgres://admin:${s.urlpass}@localhost/db`,
      `MY_TOKEN=${s.MY_TOKEN} DB_PASSWORD="${s.DB_PASSWORD}" npm test`,
    ];
    const records = [record(base('SessionStart', { source: 'startup' }))];
    for (const command of commands) {
      const id = toolu();
      records.push(record(base('PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command, description: `Rodar com token=${s.token}` } })));
      records.push(record(base('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: id, tool_input: { command }, error: `Exit code 1 password=${s.password}\nℹ tests 1\nAKIA ${s.akia}` })));
    }
    records.push(record(base('PreToolUse', {
      tool_name: 'Grep', tool_use_id: toolu(),
      tool_input: { pattern: `token=${s.token}`, path: `${REAL_HOME}${BS}x${BS}secret=${s.secret}`, glob: `*${s.ghp}*` },
    })));
    records.push(record(base('PreToolUse', {
      tool_name: 'WebFetch', tool_use_id: toolu(),
      tool_input: { url: `https://admin:${s.urlpass}@example.com/a?token=${s.token}`, prompt: `use ${s.sk}` },
    })));
    records.push(record(base('PreToolUse', { tool_name: 'WebSearch', tool_use_id: toolu(), tool_input: { query: `vazar ${s.ghp} api_key=${s.api_key}` } })));
    const outcome = sanitizeCase(records);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assertClean(outcome.fixture, { ids: realIds(records), forbidden: Object.values(secrets) });
  });

  it('segredos em campos de id ou de enumeração: o CLI grava limpo ou recusa, nunca grava o segredo', () => {
    const token = 'ghp_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0';
    const records = [
      record(base('PreToolUse', { tool_name: 'Bash', tool_use_id: token, tool_input: { command: 'ls' }, model: 'sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3' })),
      record(base('SubagentStart', { agent_id: aid, agent_type: 'AKIAZX9YW8VU7TS6RQ5P' })),
    ];
    const outcome = sanitizeCase(records);
    assertCleanOrRefused(outcome, { forbidden: [token, 'sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3', 'AKIAZX9YW8VU7TS6RQ5P'] });
  });

  it('nome do usuário em caminhos de todas as formas comuns: o cenário sai sem ele', () => {
    const forms = [
      `${REAL_HOME}${BS}OneDrive${BS}a.js`,
      `${REAL_HOME.replaceAll(BS, '/')}/a.js`,
      `${REAL_HOME.toLowerCase()}${BS}a.js`,
      `${REAL_HOME.toUpperCase()}${BS}a.js`,
      `/c/${USERS_DIR}/${USER}/a.js`,
      `/mnt/c/${USERS_DIR}/${USER}/a.js`,
      `${REAL_HOME.replaceAll(BS, BS + BS)}${BS}${BS}a.js`,
      `${BS}${BS}?${BS}${REAL_HOME}${BS}a.js`,
      `${pathApi.dirname(REAL_HOME)}${BS}${USER.toUpperCase()}~1${BS}a.js`, // nome curto 8.3
      `c--${USERS_DIR}-${USER}-Projetos-agents-quest`,
    ];
    const records = [];
    for (const form of forms) {
      const id = toolu();
      records.push(record(base('PreToolUse', {
        tool_name: 'Read', tool_use_id: id, cwd: form, tool_input: { file_path: form, description: `Ler ${form}`.slice(0, 70), pattern: form.slice(0, 55) },
      })));
      records.push(record(base('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: `type "${form}"` }, error: `ENOENT: ${form}` })));
    }
    const outcome = sanitizeCase(records);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assertClean(outcome.fixture, { ids: realIds(records) });
  });

  it('nome do usuário solto num texto mantido (fora de um caminho): o CLI recusa e não grava', () => {
    const records = [record(base('PreToolUse', { tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command: `echo ${USER}`, description: `Saudar ${USER}` } }))];
    const outcome = sanitizeCase(records);
    assert.equal(outcome.result.status, 2, outcome.result.stdout + outcome.result.stderr);
    assert.equal(outcome.fixture, null);
    assert.ok(!outcome.result.stderr.toLowerCase().includes(USER.toLowerCase()), 'a mensagem de recusa não repete o nome');
  });

  it('strings enormes em todos os campos: o CLI grava sem string acima de 200 fora dos marcadores, ou recusa', () => {
    const huge = (n, c = 'Z') => c.repeat(n);
    const records = [
      record(base('UserPromptSubmit', { prompt: `SEGREDO-DO-PEDIDO ${huge(50_000)}` })),
      record(base('PreToolUse', {
        tool_name: 'Bash', tool_use_id: toolu(),
        tool_input: { command: `node -e "${huge(10_000)}"`, description: huge(5_000, 'd'), timeout: 600000 },
      })),
      record(base('PostToolUse', {
        tool_name: 'Read', tool_use_id: toolu(), tool_input: { file_path: `${REAL_HOME}${BS}${huge(5_000, 'p')}.txt` },
        tool_response: { type: 'text', file: { filePath: `${REAL_HOME}${BS}a.txt`, content: `CONTEUDO-REAL-DO-ARQUIVO${huge(1024 * 1024)}` } },
      })),
      record(base('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command: 'x' }, error: `Exit code 2 ${huge(5_000, 'e')}\n${huge(5_000, 'f')}` })),
      record(base('PreToolUse', { tool_name: 'Grep', tool_use_id: toolu(), tool_input: { pattern: huge(1_000, 'g'), query: huge(1_000, 'q') } })),
      record(base('Notification', { notification_type: 'permission_prompt', message: huge(10_000, 'm'), title: huge(500, 't') })),
      record(base('Stop', { last_assistant_message: `RESPOSTA-DO-ASSISTENTE ${huge(100_000)}`, background_tasks: [] })),
      record(base('UserPromptSubmit', { prompt: `<task-notification>${Array.from({ length: 60 }, (_, i) => `<task-id>a${String(i).padStart(16, '0')}</task-id>`).join('')}</task-notification>` })),
    ];
    const outcome = sanitizeCase(records);
    assertCleanOrRefused(outcome, { ids: realIds(records) });
  });

  it('Unicode: emoji cortado no limite, controles bidi, NUL e combinantes não quebram o cenário nem esticam strings', () => {
    const emoji = '😀';
    const command = `${'a'.repeat(159)}${emoji}${'b'.repeat(50)}`;
    const records = [
      record(base('PreToolUse', { tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command, description: `‮olleh‬ ${'é'.repeat(3)}\u0000 é` } })),
      record(base('PreToolUse', { tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command: `echo ${'𝒜'.repeat(150)}` } })),
      record(base('UserPromptSubmit', { prompt: `${emoji} SEGREDO-DO-PEDIDO ${'ç'.repeat(300)}` })),
    ];
    const outcome = sanitizeCase(records);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assertClean(outcome.fixture, { ids: realIds(records) });
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(tmp, `caso-${caseSeq}`, 'cenario.json'), 'utf8')));
  });

  it('ids reais espalhados (caminhos, outputFile, tags, comando, descrição, erro, background_tasks) e ids de fora da seleção: nenhum sobra', () => {
    const outside = '9c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6'; // sessão de outro trecho do JSONL
    const agentTool = toolu();
    const records = [
      // Linha 1: outro trecho, fora da seleção (--lines 2-N), só declara o id.
      record({ ...base('SessionStart', { source: 'startup' }), session_id: outside, transcript_path: `${REAL_HOME}${BS}x${BS}${outside}.jsonl` }),
      record(base('PreToolUse', {
        tool_name: 'Agent', tool_use_id: agentTool, prompt_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        tool_input: { description: `Retomar ${aid} da sessão ${outside}`, prompt: 'PROMPT-DO-AGENTE', subagent_type: 'probe-worker', run_in_background: true },
      })),
      record(base('SubagentStart', { agent_id: aid, agent_type: 'probe-worker' })),
      record(base('PostToolUse', {
        tool_name: 'Agent', tool_use_id: agentTool,
        tool_input: { description: 'x', prompt: 'PROMPT-DO-AGENTE', subagent_type: 'probe-worker', run_in_background: true },
        tool_response: { status: 'async_launched', agentId: aid, outputFile: `${REAL_HOME}${BS}AppData${BS}Local${BS}Temp${BS}claude${BS}${sid}${BS}tasks${BS}${aid}.output` },
      })),
      record(base('Stop', { background_tasks: [{ id: aid, type: 'local_agent', status: 'running', agent_type: 'probe-worker' }], last_assistant_message: 'RESPOSTA-DO-ASSISTENTE' })),
      record(base('PreToolUse', {
        tool_name: 'Bash', tool_use_id: toolu(), agent_id: aid, agent_type: 'probe-worker',
        tool_input: { command: `type ${REAL_HOME}${BS}AppData${BS}Local${BS}Temp${BS}claude${BS}${sid}${BS}tasks${BS}${aid}.output && echo ${outside}` },
      })),
      record(base('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command: 'x' }, error: `Agent ${aid} failed in ${sid}` })),
      record(base('SubagentStop', {
        agent_id: aid, agent_type: 'probe-worker', last_assistant_message: 'RESPOSTA-DO-ASSISTENTE',
        agent_transcript_path: `${REAL_HOME}${BS}.claude${BS}projects${BS}p${BS}${sid}${BS}subagents${BS}agent-${aid}.jsonl`,
      })),
      record(base('UserPromptSubmit', {
        prompt: `<task-notification>\n<task-id>${aid}</task-id>\n<tool-use-id>${agentTool}</tool-use-id>\n<status>completed</status>\n<summary>Agent ${aid} completed in ${sid}</summary>\n</task-notification>`,
      })),
    ];
    const outcome = sanitizeCase(records, ['--lines', `2-${records.length}`]);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    const ids = [...realIds(records), outside];
    assertClean(outcome.fixture, { ids });
    const events = outcome.fixture.events.map((e) => e.payload);
    const synthAgent = events.find((p) => p.hook_event_name === 'SubagentStart').agent_id;
    assert.match(synthAgent, /^a[0-9a-f]{16}$/);
    assert.notEqual(synthAgent, aid);
    assert.equal(events.find((p) => p.tool_response?.agentId).tool_response.agentId, synthAgent);
    assert.equal(events.find((p) => p.hook_event_name === 'Stop').background_tasks[0].id, synthAgent);
    assert.ok(events.find((p) => p.hook_event_name === 'SubagentStop').agent_transcript_path.endsWith(`agent-${synthAgent}.jsonl`));
    assert.ok(events.find((p) => p.hook_event_name === 'UserPromptSubmit').prompt.includes(`<task-id>${synthAgent}</task-id>`));
  });

  // --- Regressão dos bugs B1 a B6 (corrigidos) e bugs abertos. ----------------

  it('id real em maiúsculas dentro de um caminho ou comando também é trocado (B6)', () => {
    const agentTool = toolu();
    const records = [
      record(base('SubagentStart', { agent_id: aid, agent_type: 'probe-worker', tool_use_id: agentTool })),
      record(base('PreToolUse', {
        tool_name: 'Bash', tool_use_id: toolu(),
        tool_input: { command: `type ${REAL_HOME}${BS}TASKS${BS}${aid.toUpperCase()}.OUTPUT && echo ${sid.toUpperCase()}` },
      })),
    ];
    const outcome = sanitizeCase(records);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assertClean(outcome.fixture, { ids: realIds(records) });
  });

  it('segredo cortado no limite do comando, da descrição, do erro ou do caminho: grava sem --ignore-audit e continua ponto fixo do redact', () => {
    const records = [];
    for (let pad = 140; pad <= 162; pad++) {
      records.push(record(base('PreToolUse', {
        tool_name: 'Bash', tool_use_id: toolu(),
        tool_input: { command: `${'x'.repeat(pad)} --password SEGREDO123 -H "Authorization: Bearer SEGREDO123" fim`, description: `${'d'.repeat(pad - 80)} token=SEGREDO123` },
      })));
      records.push(record(base('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command: 'x' }, error: `${'e'.repeat(pad)} token=SEGREDO123` })));
    }
    const outcome = sanitizeCase(records);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assertClean(outcome.fixture, { forbidden: ['SEGREDO123'] });
  });

  it('retorno do segundo plano com <output-file> e <usage> (forma provável do real) é gravado, sem --ignore-audit', () => {
    const agentTool = toolu();
    const records = [record(base('UserPromptSubmit', {
      prompt: `<task-notification>\n<task-id>${aid}</task-id>\n<tool-use-id>${agentTool}</tool-use-id>\n<output-file>${REAL_HOME}${BS}AppData${BS}Local${BS}Temp${BS}claude${BS}${sid}${BS}tasks${BS}${aid}.output</output-file>\n<status>completed</status>\n<summary>Agent "Esperar 15 s" completed</summary>\n<result>RESULTADO-DO-AGENTE</result>\n<usage><total_tokens>1234</total_tokens><tool_uses>1</tool_uses><duration_ms>15012</duration_ms></usage>\n</task-notification>`,
    }))];
    const outcome = sanitizeCase(records);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assertClean(outcome.fixture, { ids: realIds(records) });
  });

  it('chaves de objeto com caminho pessoal, id real ou segredo: o CLI grava limpo ou recusa', () => {
    const records = [record(base('PreToolUse', {
      tool_name: 'mcp__exemplo__salvar', tool_use_id: toolu(),
      tool_input: { [`${REAL_HOME}${BS}notas.txt`]: 'x', [sid]: 1, ghp_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0: true },
    }))];
    assertCleanOrRefused(sanitizeCase(records), { ids: [sid], forbidden: ['ghp_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0'] });
  });

  it('nomes compostos ou em minúsculas com token, secret, password e key: o valor é redigido', () => {
    const values = ['AccessTok3nValue', 'ClientS3cretValue', 'DbPassw0rdValue', 'MyT0kenValue', 'RefreshTok3nValue'];
    const records = [record(base('PreToolUse', {
      tool_name: 'Bash', tool_use_id: toolu(),
      tool_input: {
        command: `curl "https://api.example.com/v1?access_token=${values[0]}&client_secret=${values[1]}" db_password=${values[2]}`,
        description: `my_token=${values[3]} refresh_token=${values[4]}`,
      },
    }))];
    assertCleanOrRefused(sanitizeCase(records), { forbidden: values });
  });

  it('linhas que só parecem resumo de teste não carregam conteúdo da saída', () => {
    const records = [record(base('PostToolUse', {
      tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command: 'cat notas.txt' },
      tool_response: { stdout: '2 passing CONTEUDO-REAL-DO-ARQUIVO\n--- FAIL: x CONTEUDO-REAL-DO-ARQUIVO\nTests: CONTEUDO-REAL-DO-ARQUIVO 3 total', stderr: '' },
    }))];
    assertCleanOrRefused(sanitizeCase(records), {});
  });

  it('nome do usuário em caminho codificado para URL: o CLI troca ou recusa', () => {
    const records = [record(base('PreToolUse', {
      tool_name: 'Bash', tool_use_id: toolu(),
      tool_input: { command: `curl "http://127.0.0.1:47821/x?p=C%3A%5C${USERS_DIR}%5C${USER}%5Ca.txt"` },
    }))];
    assertCleanOrRefused(sanitizeCase(records), {});
  });

  it('id que só aparece numa chave fora da lista (sessionId, backgroundTaskId) e depois dentro de um comando: não sobra', () => {
    const hidden = '7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09';
    const records = [
      record(base('PostToolUse', { tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command: 'sleep 9' }, tool_response: { sessionId: hidden, backgroundTaskId: 'bk7f3k9q2x8z' } })),
      record(base('PreToolUse', { tool_name: 'Bash', tool_use_id: toolu(), tool_input: { command: `cat tasks/bk7f3k9q2x8z.output && echo ${hidden}` } })),
    ];
    assertCleanOrRefused(sanitizeCase(records), { forbidden: [hidden, 'bk7f3k9q2x8z'] });
  });
});

describe('report.mjs: V10, que libera a Primeira luz (G0a)', () => {
  function reportV10(records, debugLines) {
    const dir = path.join(tmp, `v10-${++caseSeq}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'events.jsonl'), toJsonl(records));
    writeFileSync(path.join(dir, 'debug.txt'), debugLines.join('\n'));
    const result = run(REPORT, [path.join(dir, 'events.jsonl'), '--debug', path.join(dir, 'debug.txt'), '--json']);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).items.find((it) => it.id === 'V10').verdict;
  }

  it('com todos os eventos em segundo plano, nos dois clientes, o V10 sai confirmado', () => {
    const { records, debugText } = buildSyntheticProbe();
    assert.equal(reportV10(records, debugText.split('\n')), 'confirmado');
  });

  it('sem nenhuma sessão do VS Code, o V10 não pode sair confirmado (o plano exige terminal e VS Code)', () => {
    const { records, debugText } = buildSyntheticProbe();
    const terminalOnly = records.filter((r) => r.payload.session_id !== SESSION_VSCODE);
    assert.notEqual(reportV10(terminalOnly, debugText.split('\n')), 'confirmado');
  });

  it('se só parte das execuções aparece como "moved to the background", o V10 não pode sair confirmado (ADR 0001: cada execução)', () => {
    const { records } = buildSyntheticProbe();
    const debug = ['2026-10-17T20:00:00.000Z [DEBUG] Hook PreToolUse (plugin agent-quest-probe): command moved to the background'];
    assert.notEqual(reportV10(records, debug), 'confirmado');
  });
});

describe('mensagens dos CLIs sem a pasta pessoal', () => {
  it('erros de arquivo ausente, ajuda e todas as saídas acima não mostram o nome do usuário', () => {
    run(SANITIZE, ['--list']); // sem --in: lê <dados>\probe\events.jsonl, que não existe
    run(SANITIZE, ['--in', path.join(tmp, 'nao-existe.jsonl'), '--list']);
    run(SANITIZE, ['--help']);
    run(REPORT, []);
    run(REPORT, ['--help']);
    run(REPORT, [path.join(tmp, 'nao-existe.jsonl')]);
    run(REPORT, [path.join(tmp, 'x.jsonl'), '--debug', path.join(tmp, 'nao-existe.txt')]);
    assert.ok(cliOutputs.length > 40, `saídas conferidas: ${cliOutputs.length}`);
    const leaks = cliOutputs.filter((o) => o.text.toLowerCase().includes(USER.toLowerCase())).map((o) => o.args);
    assert.deepEqual(leaks, []);
  });
});

describe('o CLI nunca grava no repositório durante estes testes', () => {
  it('test/fixtures/hooks continua só com o .gitkeep', () => {
    assert.deepEqual(readdirSync(path.join(REPO, 'test', 'fixtures', 'hooks')), ['.gitkeep']);
  });
});
