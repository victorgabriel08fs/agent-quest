// Cenários reais do T0 (test/fixtures/hooks/*.json, sanitizados; commit 166cce5).
// Fechamento [T0] do T5 (plano, passo 3 do "Caminho até a Primeira luz").
//
// - Guarda: nenhuma string dos 16 cenários muda ao passar por `redact`. Se a
//   redação ficar mais rígida, o teste aponta os cenários que precisam ser
//   gerados de novo com tools/probe/sanitize.mjs.
// - Tabela por evento: para cada evento dos 16 cenários, o fato gerado é
//   igual ao esperado, inteiro (todas as chaves). Os esperados foram escritos à
//   mão a partir do modelo de eventos revisto no G0b (seções 2, 3, 6 e 10),
//   olhando os payloads, e não copiados da saída do normalizador:
//   - os campos comuns seguem as regras da seção 2 (`commonOf`): ids e caminhos
//     guardados como vieram no payload, `agent_type` vazio vira null, `client`
//     pelo `env.entrypoint` (V11), `ts` igual ao `sentAt`;
//   - o resto de cada linha (categoria, alvo, detalhe, título, origem, erro,
//     elo do Agent, testResult, tarefas do Stop) está escrito na tabela;
//   - ids opacos (`tool_use_id`, `tool_response.agentId`, `background_tasks[].id`)
//     e `duration_ms` são lidos do próprio payload, pela regra de mapeamento da
//     seção 2; o `inputHash` é recalculado aqui (SHA-256 do `tool_input` com
//     as chaves ordenadas, 16 hexadecimais), sem usar o tools.js.
// - G0b, V7: origem e título dos pedidos (passo 1 do caminho, já no fato).
//
// Os cenários sintéticos que cobrem o mesmo caso continuam em
// normalize-synthetic.test.js, marcados como sintéticos (ADR 0010, complemento
// de 26/10/2026), e também os que o T0 não mostrou (primeiro plano,
// `is_interrupt`, PermissionDenied).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { redact } from '../../../../server/domain/redact.js';
import { normalize } from '../../../../server/domain/normalize.js';
import { LIMITS, firstRedactedLine, textLine } from '../../../../server/domain/tools.js';
import { assertFactInvariants } from './fact-checks.js';
import { loadFixtureScenarios, scenarioEnvelopes } from './scenarios.js';

/** Pasta pessoal dos cenários sanitizados (o nome do usuário vira "usuario"). */
const FIXTURE_HOME = 'C:\\Users\\usuario';

/** Os 16 cenários do commit 166cce5. */
const SCENARIO_FILES = [
  'agente-do-projeto.json',
  'aninhado.json',
  'aprovacao-principal.json',
  'aprovacao-subagente.json',
  'basico.json',
  'comando-com-falha-subagente.json',
  'comando-com-falha.json',
  'compactacao-com-subagente.json',
  'compactacao-e-clear.json',
  'interrupcao-esc-subagente.json',
  'interrupcao-esc.json',
  'limite-de-uso.json',
  'paralelo-mesmo-tipo.json',
  'segundo-plano.json',
  'teste-falha-depois-passa.json',
  'vscode.json',
];

/** [caminho, valor] de cada string, em qualquer profundidade. */
function* strings(value, at) {
  if (typeof value === 'string') yield [at, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${at}[${i}]`);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* strings(item, `${at}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// Regras gerais (seção 2), independentes do normalizador
// ---------------------------------------------------------------------------

/** Fato por hook (seção 2). PostToolBatch não é assinado pela captura e vira null. */
const KIND = {
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'prompt.submit',
  PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post',
  PostToolUseFailure: 'tool.fail',
  PermissionRequest: 'permission.request',
  Notification: 'notice',
  SubagentStart: 'subagent.start',
  SubagentStop: 'subagent.stop',
  Stop: 'turn.stop',
  StopFailure: 'turn.fail',
  PreCompact: 'compact.pre',
  PostCompact: 'compact.post',
};

/** V11 (G0b): `cli` é o terminal; `claude-vscode`, a extensão. */
const CLIENT = { cli: 'terminal', 'claude-vscode': 'vscode' };

/** JSON com as chaves em ordem, em qualquer profundidade (seção 2, `inputHash`). */
function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const hashOf = (input) => createHash('sha256').update(sortedJson(input)).digest('hex').slice(0, 16);

/** Campos comuns a todo fato (seção 2, "Forma do fato e limites"). */
function commonOf(event, time) {
  const p = event.payload;
  const type = p.agent_type === '' || p.agent_type === undefined ? null : p.agent_type;
  return {
    kind: KIND[p.hook_event_name],
    hook: p.hook_event_name,
    sessionId: p.session_id,
    agentId: p.agent_id ?? null,
    agentType: type,
    agentTypeKey: type,
    promptId: p.prompt_id ?? null,
    projectDir: event.env.projectDir,
    client: CLIENT[event.env.entrypoint],
    ts: time,
    receivedAt: time,
    transcriptPath: p.transcript_path,
  };
}

// ---------------------------------------------------------------------------
// Linhas da tabela: cada uma é uma função do payload que devolve os campos
// próprios do fato (seção 2), ou IGNORED para evento fora dos 15 hooks.
// ---------------------------------------------------------------------------

const IGNORED = null;
const WORKER = 'agent-quest-probe:probe-worker';

/** Chamada descrita pela seção 3: ferramenta exibida, categoria, alvo e detalhe. */
const call = (tool, category, target, detail = null) => ({ tool, category, target, detail, agent: null });
const ps = (command, description) => call('PowerShell', 'bash', command, description);
const bash = (command, description) => call('Bash', 'bash', command, description);
const psTest = (command, description) => call('PowerShell', 'test', command, description);
/** Agent: categoria null, alvo = subagent_type, detalhe = description (seção 2). */
const agentCall = (type, description) => ({ tool: 'Agent', category: null, target: type, detail: description, agent: { type, description } });

const READ_CLAUDE = call('Read', 'read', 'CLAUDE.md');

/** Campos de ferramenta de `tool.pre` (seção 2, "Fatos de ferramenta"). */
const toolFields = (spec, p) => ({
  toolUseId: p.tool_use_id,
  tool: spec.tool,
  category: spec.category,
  target: spec.target,
  detail: spec.detail,
  inputHash: hashOf(p.tool_input),
  // V5: `run_in_background` não vem nas delegações reais (segundo plano por padrão).
  background: false,
  subagentType: spec.agent ? spec.agent.type : null,
  subagentTypeKey: spec.agent ? spec.agent.type : null,
  description: spec.agent ? spec.agent.description : null,
});

const pre = (spec) => (p) => toolFields(spec, p);
/** PostToolUse. `launched`: Agent em segundo plano, com o elo do `tool_response.agentId` (V5). */
const post = (spec, { launched = false, testResult = null } = {}) => (p) => ({
  ...toolFields(spec, p),
  durationMs: p.duration_ms,
  linkedAgentId: launched ? p.tool_response.agentId : null,
  launch: launched ? 'async_launched' : null,
  testResult,
});
const fail = (spec, error, { testResult = null } = {}) => (p) => ({
  ...toolFields(spec, p),
  durationMs: p.duration_ms,
  error,
  interrupted: false,
  testResult,
});
const perm = (spec) => (p) => ({ tool: spec.tool, category: spec.category, target: spec.target, inputHash: hashOf(p.tool_input) });
const prompt = (title, origin = 'user') => () => ({ title, origin, sessionTitle: null });
/** Retorno de subagente em segundo plano no terminal (V7): primeira linha e origem do sistema. */
const TASK_RETURN = prompt('<task-notification>', 'system');
const notice = (type) => () => ({ type });
const sessionStart = (source, model = null) => () => ({ source, model, sessionTitle: null });
const sessionEnd = (reason) => () => ({ reason });
const subStart = () => () => ({});
const subStop = () => (p) => ({ agentTranscriptPath: p.agent_transcript_path });
/** Stop: uma tarefa por tipo da lista, com `id` do payload (V13), `subagent` e `running`. */
const stop = (...types) => (p) => ({
  backgroundTasks: types.map((type, i) => ({ id: p.background_tasks[i].id, type: 'subagent', status: 'running', agentType: type, agentTypeKey: type })),
});
const turnFail = (error) => () => ({ error });
const compact = (trigger) => () => ({ trigger });

// Chamadas que se repetem.
const PS_PRINT_1 = ps('node -e "console.log(1)"', 'Run a one-line Node script that prints 1');
const PS_EXIT_3 = ps('node -e "process.exit(3)"; "exit code: $LASTEXITCODE"', 'Run a Node script that exits with code 3');
const BASH_WAIT_30_IN_PROJECT = bash(
  'cd "C:\\Users\\usuario\\OneDrive\\Documentos\\Code\\agents-quest" && node -e "setTimeout(()=>{},30000)"',
  'Run a Node script that waits 30 seconds',
);
const TEST_FAILED = { ok: false, passed: 0, failed: 1, total: 1, framework: 'node:test', chained: false };
const TEST_PASSED = { ok: true, passed: 1, failed: 0, total: 1, framework: 'node:test', chained: false };

/** Uma linha por evento, na ordem do cenário. */
const TABLE = {
  'agente-do-projeto.json': (() => {
    const doc = agentCall('documentador', 'Documentador reads CLAUDE.md');
    return [
      prompt('«pedido#1:78»'), pre(doc), subStart(), post(doc, { launched: true }), IGNORED, stop('documentador'),
      pre(READ_CLAUDE), post(READ_CLAUDE), IGNORED, subStop(), TASK_RETURN, stop(), notice('idle_prompt'),
    ];
  })(),
  'aninhado.json': (() => {
    const first = agentCall(WORKER, 'Delegate CLAUDE.md read');
    const nested = agentCall(WORKER, 'Resumir CLAUDE.md');
    return [
      prompt('«pedido#1:77»'), post(first, { launched: true }), pre(first), subStart(), IGNORED, stop(WORKER),
      pre(nested), subStart(), post(nested, { launched: true }), IGNORED, subStop(),
      pre(READ_CLAUDE), post(READ_CLAUDE), IGNORED, subStop(),
      subStart(), subStop(), TASK_RETURN, stop(),
    ];
  })(),
  'aprovacao-principal.json': (() => {
    const x = ps(`node -e "require('fs').writeFileSync('tmp-probe/x.txt','1')"; if ($?) { Get-Content tmp-probe/x.txt }`, 'Write a small text file via Node and show its contents');
    const y = ps(`node -e "require('fs').writeFileSync('tmp-probe/y.txt','2')"; if ($?) { Get-Content tmp-probe/y.txt }`, 'Write a second small text file via Node and show its contents');
    return [
      prompt('«pedido#1:65»'), pre(x), perm(x), notice('permission_prompt'), post(x), IGNORED, stop(), subStop(),
      prompt('«pedido#2:65»'), pre(y), perm(y), notice('permission_prompt'),
      prompt('«pedido#3:14»'), stop(), subStop(),
    ];
  })(),
  'aprovacao-subagente.json': (() => {
    const z = agentCall(WORKER, 'Write z.txt via node');
    const writeZ = bash(`node -e "require('fs').writeFileSync('tmp-probe/z.txt','3')"`, 'Write probe file with Node');
    const cat = bash('cat tmp-probe/z.txt', 'Show probe file contents');
    const w = agentCall(WORKER, 'Write w.txt via node');
    // 139 caracteres: 119 + "…" (seção 10, regra de corte de redactAndCut).
    const writeW = bash(
      `cd "C:/Users/usuario/OneDrive/Documentos/Code/agents-quest" && node -e "require('fs').writeFileSync('tmp-probe/w.txt','…`,
      'Write probe file with node',
    );
    return [
      prompt('«pedido#1:93»'), pre(z), post(z, { launched: true }), IGNORED, subStart(), stop(WORKER), subStop(),
      pre(writeZ), perm(writeZ), notice('permission_prompt'), subStop(), post(writeZ), IGNORED,
      pre(cat), post(cat), IGNORED, subStop(), TASK_RETURN, stop(), subStop(),
      prompt('«pedido#4:93»'), subStart(), post(w, { launched: true }), pre(w), IGNORED, stop(WORKER), subStop(),
      pre(writeW), perm(writeW), notice('permission_prompt'), IGNORED, subStop(), TASK_RETURN, stop(), subStop(),
    ];
  })(),
  'basico.json': [
    sessionStart('startup', 'claude-opus-5-5'), prompt('«pedido#1:49»'), pre(PS_PRINT_1), perm(PS_PRINT_1),
    notice('permission_prompt'), post(PS_PRINT_1), IGNORED, stop(), notice('idle_prompt'),
  ],
  'comando-com-falha-subagente.json': (() => {
    const d = agentCall(WORKER, 'Run node process.exit(4)');
    const exit4 = bash('cd "C:/Users/usuario/OneDrive/Documentos/Code/agents-quest" && node -e "process.exit(4)"', 'Run node command that exits with code 4');
    return [
      prompt('«pedido#1:58»'), pre(d), subStart(), IGNORED, post(d, { launched: true }), stop(WORKER),
      pre(exit4), perm(exit4), subStop(), notice('permission_prompt'), fail(exit4, 'Exit code 4'), IGNORED, subStop(),
      TASK_RETURN, stop(), subStop(),
    ];
  })(),
  'comando-com-falha.json': [
    prompt('«pedido#1:31»'), pre(PS_EXIT_3), perm(PS_EXIT_3), notice('permission_prompt'),
    fail(PS_EXIT_3, 'Exit code 3'), IGNORED, stop(), subStop(),
  ],
  'compactacao-com-subagente.json': (() => {
    const d = agentCall(WORKER, 'Rodar comando de espera');
    const wait = bash('node -e "setTimeout(()=>{},30000)"', 'Run a Node script that waits 30 seconds');
    return [
      prompt('«pedido#1:66»'), post(d, { launched: true }), pre(d), subStart(), IGNORED,
      perm(wait), pre(wait), stop(WORKER), subStop(), notice('permission_prompt'),
      compact('manual'), post(wait), IGNORED, subStop(), subStop(),
      sessionStart('compact', 'claude-opus-5-5'), compact('manual'), TASK_RETURN, stop(),
      sessionEnd('clear'), sessionStart('clear'), sessionEnd('prompt_input_exit'),
    ];
  })(),
  'compactacao-e-clear.json': [
    compact('manual'), subStop(), sessionStart('compact', 'claude-opus-5-5'), compact('manual'),
    sessionEnd('clear'), sessionStart('clear'), sessionEnd('prompt_input_exit'),
  ],
  'interrupcao-esc-subagente.json': (() => {
    const d = agentCall(WORKER, 'Run 30s node timeout again');
    return [
      prompt('«pedido#1:66»'), subStart(), post(d, { launched: true }), pre(d), IGNORED, stop(WORKER),
      pre(BASH_WAIT_30_IN_PROJECT), perm(BASH_WAIT_30_IN_PROJECT), subStop(), notice('permission_prompt'), subStop(),
      post(BASH_WAIT_30_IN_PROJECT), IGNORED, subStop(), TASK_RETURN,
    ];
  })(),
  'interrupcao-esc.json': (() => {
    const wait = ps('node -e "setTimeout(()=>{},30000)"; "exit code: $LASTEXITCODE"', 'Run a Node script that waits 30 seconds and exits');
    return [prompt('«pedido#1:39»'), pre(wait), prompt('«pedido#1:39»'), pre(wait), perm(wait), notice('permission_prompt')];
  })(),
  'limite-de-uso.json': (() => {
    const d = agentCall(WORKER, 'Run 30s node timeout');
    const search = call('ToolSearch', 'search', 'select:SendMessage');
    // Ferramenta fora da tabela da seção 3: `other`, com o nome como alvo.
    const send = call('SendMessage', 'other', 'SendMessage');
    return [
      prompt('«pedido#1:66»'), post(d, { launched: true }), subStart(), IGNORED, pre(d), stop(WORKER),
      pre(BASH_WAIT_30_IN_PROJECT), perm(BASH_WAIT_30_IN_PROJECT), notice('permission_prompt'), subStop(),
      post(BASH_WAIT_30_IN_PROJECT), IGNORED,
      turnFail('rate_limit'), TASK_RETURN, turnFail('rate_limit'),
      // quota_auto_resume_fired está fora da lista: type null, sem descartar o fato (seção 2).
      prompt('«pedido#4:148»'), notice(null),
      pre(search), post(search), IGNORED, pre(send), subStart(), post(send), IGNORED,
      stop(WORKER), subStop(), TASK_RETURN, subStop(), stop(), subStop(), notice('idle_prompt'), subStop(),
    ];
  })(),
  'paralelo-mesmo-tipo.json': (() => {
    const read = agentCall(WORKER, 'Read CLAUDE.md');
    const run = agentCall(WORKER, 'Run node console.log(2)');
    const print2 = bash('cd "C:/Users/usuario/OneDrive/Documentos/Code/agents-quest" && node -e "console.log(2)"', 'Run node to print 2');
    return [
      prompt('«pedido#1:101»'), subStart(), pre(read), post(read, { launched: true }), pre(run), post(run, { launched: true }),
      subStart(), IGNORED, pre(READ_CLAUDE), post(READ_CLAUDE), IGNORED, stop(WORKER, WORKER),
      pre(print2), perm(print2), subStop(), subStop(), TASK_RETURN, stop(WORKER), notice('permission_prompt'), subStop(),
      post(print2), IGNORED, subStop(), TASK_RETURN, stop(), subStop(), notice('idle_prompt'),
    ];
  })(),
  'segundo-plano.json': (() => {
    const d = agentCall(WORKER, 'Run 15s node timeout');
    const wait = bash(
      `cd "C:/Users/usuario/OneDrive/Documentos/Code/agents-quest" && node -e "setTimeout(()=>console.log('fim'),15000)"`,
      'Run a Node script that waits 15 seconds then prints',
    );
    return [
      prompt('«pedido#1:129»'), pre(d), subStart(), post(d, { launched: true }), IGNORED, stop(WORKER),
      pre(wait), perm(wait), subStop(), notice('permission_prompt'), subStop(), post(wait), IGNORED, subStop(),
      TASK_RETURN, stop(),
    ];
  })(),
  'teste-falha-depois-passa.json': (() => {
    const write = call('Write', 'write', 'tmp-probe/a.test.mjs');
    const edit = call('Edit', 'edit', 'tmp-probe/a.test.mjs');
    const first = psTest('node --test tmp-probe', 'Run the Node test runner on the probe folder');
    const second = psTest('node --test "tmp-probe/**/*.test.mjs"', 'Run the probe tests using a glob pattern');
    const third = psTest('node --test "tmp-probe/**/*.test.mjs"', 'Rerun the probe tests after the fix');
    return [
      prompt('«pedido#1:122»'), pre(write), perm(write), notice('permission_prompt'), post(write),
      pre(first), perm(first), notice('permission_prompt'), fail(first, 'Exit code 1', { testResult: TEST_FAILED }), IGNORED,
      pre(second), perm(second), notice('permission_prompt'), fail(second, 'Exit code 1', { testResult: TEST_FAILED }), IGNORED,
      pre(edit), perm(edit), notice('permission_prompt'), post(edit),
      pre(third), perm(third), notice('permission_prompt'), post(third, { testResult: TEST_PASSED }), IGNORED,
      stop(), subStop(),
    ];
  })(),
  'vscode.json': (() => {
    const exit3 = ps('node -e "process.exit(3)"; "exit code: $LASTEXITCODE"', 'Run a Node script that exits with code 3 and show the exit code');
    const read = agentCall(WORKER, 'Ler CLAUDE.md');
    const run = agentCall(WORKER, 'Rodar console.log(2)');
    const print2 = bash('node -e "console.log(2)"', 'Print 2 with Node');
    const handback = call('SubagentHandback', 'other', 'SubagentHandback');
    return [
      sessionStart('startup'), sessionEnd('other'), sessionStart('startup'),
      // O título ignora o preâmbulo <browser_instruction> (G0b; a captura 0.1.3 já o tira).
      prompt('«texto#2:49»'),
      // A letra da unidade vem minúscula (c:\...) e o projeto, maiúscula: o caminho continua relativo.
      pre(READ_CLAUDE), post(READ_CLAUDE), pre(PS_PRINT_1), post(PS_PRINT_1), IGNORED, stop(),
      prompt('«pedido#2:31»'), pre(exit3), fail(exit3, 'Exit code 3'), IGNORED, stop(),
      prompt('«pedido#3:101»'), pre(read), pre(run), subStart(), post(read, { launched: true }), subStart(), post(run, { launched: true }),
      IGNORED, stop(WORKER, WORKER),
      pre(print2), pre(READ_CLAUDE), post(READ_CLAUDE), IGNORED, post(print2), IGNORED,
      pre(handback), pre(handback), post(handback),
      // Retorno na extensão do VS Code (V7, G0b): origem do sistema.
      prompt('<agent-message>«texto#8:1005»</agent-message>', 'system'),
      IGNORED, post(handback), subStop(), IGNORED, subStop(), stop(),
      prompt('<agent-message>«texto#11:506»</agent-message>', 'system'), stop(), sessionEnd('other'),
    ];
  })(),
};

describe('[T0] cenários reais (test/fixtures/hooks/)', () => {
  const scenarios = loadFixtureScenarios();

  it('são os 16 cenários do T0, e a tabela tem uma linha por evento', () => {
    assert.deepEqual(scenarios.map(({ file }) => file), SCENARIO_FILES);
    assert.deepEqual(Object.keys(TABLE).sort(), SCENARIO_FILES);
    for (const { file, scenario } of scenarios) assert.equal(TABLE[file].length, scenario.events.length, file);
  });

  it('guarda: nenhuma string dos 16 cenários muda ao passar por redact', () => {
    assert.equal(scenarios.length, 16);
    const changed = [];
    for (const { file, scenario } of scenarios) {
      for (const [at, text] of strings(scenario, file)) {
        if (redact(text) !== text) changed.push(at);
      }
    }
    assert.deepEqual(changed, [], 'gerar de novo estes cenários com o sanitize.mjs atual');
  });

  describe('fato igual ao esperado para cada evento (teste por tabela)', () => {
    for (const { file, scenario } of scenarios) {
      it(file, () => {
        let facts = 0;
        for (const { index, event, envelope, receivedAt } of scenarioEnvelopes(scenario)) {
          const label = `${file}#${index} (${event.payload.hook_event_name})`;
          const fact = normalize(envelope, { receivedAt, homeDir: FIXTURE_HOME });
          const row = TABLE[file][index];
          if (row === IGNORED) {
            assert.equal(fact, null, label);
            continue;
          }
          assert.deepEqual(fact, { ...commonOf(event, receivedAt), ...row(event.payload) }, label);
          assertFactInvariants(fact, label);
          facts++;
        }
        assert.ok(facts > 0, file);
      });
    }
  });

  it('casos do plano: limite de uso, segundo plano e falhas de comando', () => {
    const factsOf = (file) => {
      const { scenario } = scenarios.find((item) => item.file === file);
      return scenarioEnvelopes(scenario).map(({ envelope, receivedAt }) => normalize(envelope, { receivedAt, homeDir: FIXTURE_HOME }));
    };
    // limite-de-uso: dois turn.fail com rate_limit, um deles de subagente.
    const fails = factsOf('limite-de-uso.json').filter((fact) => fact?.kind === 'turn.fail');
    assert.deepEqual(fails.map((fact) => [fact.error, fact.agentId !== null]), [['rate_limit', true], ['rate_limit', false]]);
    // segundo-plano: Pre do Agent com background false; Post com async_launched e o elo.
    const background = factsOf('segundo-plano.json');
    const agentPre = background.find((fact) => fact?.kind === 'tool.pre' && fact.tool === 'Agent');
    const agentPost = background.find((fact) => fact?.kind === 'tool.post' && fact.tool === 'Agent');
    assert.equal(agentPre.background, false);
    assert.equal(agentPost.launch, 'async_launched');
    assert.match(agentPost.linkedAgentId, /^a[0-9a-f]{16}$/);
    // comando-com-falha e comando-com-falha-subagente: error começa por "Exit code" (V3).
    for (const file of ['comando-com-falha.json', 'comando-com-falha-subagente.json']) {
      const failed = factsOf(file).filter((fact) => fact?.kind === 'tool.fail');
      assert.equal(failed.length, 1, file);
      assert.match(failed[0].error, /^Exit code \d+$/, file);
    }
  });
});

// Ajustes do G0b antes do marco (plano, T6; modelo de eventos, seções 2 e 6).
describe('G0b, V7: origem e título dos pedidos nos cenários reais', () => {
  const scenarios = loadFixtureScenarios();

  /** Fato de cada UserPromptSubmit dos cenários, com o prompt original. */
  function prompts() {
    const out = [];
    for (const { file, scenario } of scenarios) {
      for (const { index, event, envelope, receivedAt } of scenarioEnvelopes(scenario)) {
        if (event.payload?.hook_event_name !== 'UserPromptSubmit') continue;
        const fact = normalize(envelope, { receivedAt, homeDir: FIXTURE_HOME });
        out.push({ label: `${file}#${index}`, file, prompt: event.payload.prompt, fact });
      }
    }
    return out;
  }

  /** Regra de origem e de título de antes do G0b, para comparar. */
  const previousOrigin = (prompt) => (/^<task-notification(?=[\s>])/.test(prompt.trimStart()) ? 'system' : 'user');
  function previousTitle(prompt) {
    const line = firstRedactedLine(prompt);
    if (line === null) return null;
    return textLine(line.startsWith('/') ? line.split(/\s/, 1)[0] : line, LIMITS.title);
  }

  it('cenário vscode: os dois retornos <agent-message> saem system', () => {
    const returns = prompts().filter((item) => item.file === 'vscode.json' && item.prompt.trimStart().startsWith('<agent-message'));
    assert.equal(returns.length, 2);
    for (const { label, fact } of returns) assert.equal(fact.origin, 'system', label);
  });

  it('cenário vscode: o pedido com <browser_instruction> é do usuário e o título ignora o bloco', () => {
    const [first, ...rest] = prompts().filter((item) => item.file === 'vscode.json' && item.prompt.startsWith('<browser_instruction'));
    assert.equal(rest.length, 0);
    assert.equal(first.fact.origin, 'user', first.label);
    const after = first.prompt.slice(first.prompt.lastIndexOf('</browser_instruction>') + '</browser_instruction>'.length);
    assert.ok(after.length > 0);
    assert.equal(first.fact.title, after, first.label);
    assert.doesNotMatch(first.fact.title, /browser_instruction|«texto#1/);
  });

  it('o origin e o título não mudam para nenhum outro pedido dos cenários reais', () => {
    let compared = 0;
    for (const { label, prompt, fact } of prompts()) {
      const start = prompt.trimStart();
      if (start.startsWith('<agent-message') || start.startsWith('<browser_instruction')) continue;
      assert.equal(fact.origin, previousOrigin(prompt), label);
      assert.equal(fact.title, previousTitle(prompt), label);
      compared++;
    }
    assert.ok(compared >= 30, `${compared} pedidos comparados`);
  });
});
