import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { charLength, redact } from '../../../server/domain/redact.js';
import {
  auditFixture, buildFixture, collectIds, createSanitizer, describeRecords, selectRecords, shapeLikeId,
} from '../../../tools/probe/sanitize.mjs';
import { inputHash, loadInputs, parseFixture, parseJsonl } from '../../../tools/probe/records.mjs';
import { analyze } from '../../../tools/probe/report.mjs';
import {
  AGENTS, buildSyntheticProbe, CONTENT_MARKERS, HOME, promptId, SESSION, SESSION_VSCODE, uuid,
} from './probe-synthetic.js';

const SANITIZE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/probe/sanitize.mjs');
const synthetic = buildSyntheticProbe();
const syntheticRecords = () => parseJsonl(synthetic.jsonl, 'sintetico.jsonl').records;
const sanitizer = () => createSanitizer({ home: HOME });

let tmp;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aq-probe-sanitize-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('redação: o sanitize.mjs usa o módulo único server/domain/redact.js', () => {
  it('não tem lista própria de padrões e importa o redact', () => {
    const source = readFileSync(SANITIZE, 'utf8');
    assert.match(source, /from '\.\.\/\.\.\/server\/domain\/redact\.js'/);
    assert.doesNotMatch(source, /REDACTIONS|redactSecrets|sk-ant|ghp_|AKIA/);
  });

  it('comandos, descrições e erros saem com a mesma redação do normalizador', () => {
    const s = sanitizer();
    const out = s.sanitizePayload({
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: 'curl "https://x?access_token=A1&client_secret=B2" db_password=C3', description: 'my_token=D4 --password E5' },
      error: 'Exit code 1 refresh_token=F6',
    });
    assert.equal(out.tool_input.command, 'curl "https://x?access_token=•••&client_secret=•••" db_password=•••');
    assert.equal(out.tool_input.description, 'my_token=••• --password •••');
    assert.equal(out.error, 'Exit code 1 refresh_token=•••');
    assert.equal(redact(out.tool_input.command), out.tool_input.command, 'idempotente no cenário');
  });
});

describe('correções do relatório do tester (B1, B2, B4, B5, B6)', () => {
  it('B1: esqueleto de tags acima de 200 caracteres fica com ids e status e um marcador «tags»', () => {
    const s = sanitizer();
    const agent = AGENTS.w4.id;
    const tool = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    const out = s.sanitizePayload({
      hook_event_name: 'UserPromptSubmit',
      prompt: `<task-notification>\n<task-id>${agent}</task-id>\n<tool-use-id>${tool}</tool-use-id>\n<output-file>${HOME}\\AppData\\Local\\Temp\\${agent}.output</output-file>\n<status>completed</status>\n<summary>Agent "x" completed</summary>\n<usage><total_tokens>1234</total_tokens><duration_ms>15012</duration_ms></usage>\n</task-notification>`,
    }).prompt;
    assert.ok(out.replace(/«[^«»]*»/g, '').length <= 200, out);
    assert.ok(out.startsWith('<task-notification>\n'));
    assert.ok(out.includes(`<task-id>${s.syntheticId(agent)}</task-id>`));
    assert.ok(out.includes(`<tool-use-id>${s.syntheticId(tool)}</tool-use-id>`));
    assert.ok(out.includes('<status>completed</status>'));
    assert.match(out, /«tags#1:\d+»\n<\/task-notification>$/);
    assert.ok(!out.includes('fulano') && !out.includes(agent));
  });

  it('B2: chave com caminho, segredo ou forma estranha vira marcador; chave que é id vira id sintético; chave comum fica', () => {
    const s = sanitizer();
    const digitId = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
    const out = s.sanitizePayload({
      session_id: SESSION, hook_event_name: 'PreToolUse',
      tool_input: { [`${HOME}\\notas.txt`]: 'x', ghp_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0: true, [digitId]: 0, comum_1: 2, [SESSION]: 1 },
    });
    const keys = Object.keys(out.tool_input);
    assert.match(keys[0], /^«chave#\d+:\d+»$/, 'caminho');
    assert.match(keys[1], /^«chave#\d+:\d+»$/, 'segredo');
    assert.match(keys[2], /^«chave#\d+:\d+»$/, 'começa com dígito');
    assert.equal(keys[3], 'comum_1');
    assert.equal(keys[4], s.syntheticId(SESSION), 'id registrado vira o id sintético');
    assert.equal(out.tool_input.comum_1, 2);
    const findings = auditFixture({ name: 'x', description: 'y', events: [{ dt: 0, env: {}, payload: { [`C:\\dados\\fulano\\a`]: 1, [SESSION]: 2, 'token=abc': 3 } }] }, { forbidden: ['fulano'], ids: [SESSION] });
    assert.deepEqual(findings.map((f) => f.problem.split(' (')[0]), ['contém o nome do usuário', 'contém um id original', 'possível segredo']);
    assert.ok(findings.every((f) => !f.where.includes('fulano')), 'o achado não repete a chave suspeita');
  });

  it('B4: linhas que só parecem resumo de teste são omitidas', () => {
    const s = sanitizer();
    const fake = '2 passing CONTEUDO\n--- FAIL: x CONTEUDO\nTests: CONTEUDO 3 total\n  Test Files  CONTEUDO (2)\n1 failed CONTEUDO in 0.1s\nTests: 3, Assertions: 5, CONTEUDO.\nok  pkg CONTEUDO 1.2s';
    assert.equal(s.sanitizePayload({ tool_response: { stdout: fake } }).tool_response.stdout, '«7 linhas omitidas»');
    const real = '  2 passing (15ms)\n  1 failing\n--- FAIL: TestSoma (0.00s)\nok  \tpkg/x\t(cached)\nTests:       1 failed, 2 passed, 3 total\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\nPassed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 12 ms';
    // A redação troca \t por espaço (modelo de eventos, seção 10, etapa 1).
    assert.equal(s.sanitizePayload({ tool_response: { stdout: real } }).tool_response.stdout, real.replace(/\t/g, ' '));
  });

  it('B5: nome do usuário em caminho codificado para URL é trocado e a conferência o acha', () => {
    const s = sanitizer();
    const out = s.sanitizePayload({ tool_input: { command: 'curl "http://127.0.0.1:47821/x?p=C%3A%5CUsers%5Cfulano%5Ca.txt&q=C%3A%2FUsers%2Ffulano%2Fb"' } });
    assert.equal(out.tool_input.command, 'curl "http://127.0.0.1:47821/x?p=C%3A%5CUsers%5Cusuario%5Ca.txt&q=C%3A%2FUsers%2Fusuario%2Fb"');
    const findings = auditFixture({ a: 'x?p=C%3A%5Cdados%5Cfulano%5Ca' }, { forbidden: ['fulano'] });
    assert.deepEqual(findings.map((f) => f.problem), ['contém o nome do usuário']);
  });

  it('B6: ids de chaves afins (sessionId, backgroundTaskId) são trocados também dentro de strings, sem diferenciar maiúsculas', () => {
    const hidden = '7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09';
    const records = [
      { line: 1, receivedAt: 1, writtenAt: 1, bytes: 1, raw: true, env: { names: [], projectDir: null, entrypoints: {} }, payload: { session_id: SESSION, hook_event_name: 'PostToolUse', tool_response: { sessionId: hidden, backgroundTaskId: 'bk7f3k9q2x8z' } } },
      { line: 2, receivedAt: 2, writtenAt: 2, bytes: 1, raw: true, env: { names: [], projectDir: null, entrypoints: {} }, payload: { session_id: SESSION, hook_event_name: 'PreToolUse', tool_input: { command: `cat tasks/BK7F3K9Q2X8Z.output && echo ${hidden.toUpperCase()} ${hidden}` } } },
    ];
    const ids = collectIds(records[0].payload);
    assert.ok(ids.has(hidden) && ids.has('bk7f3k9q2x8z'));
    const fixture = buildFixture(records, { name: 'x', description: 'y', home: HOME });
    const text = JSON.stringify(fixture).toLowerCase();
    assert.ok(!text.includes(hidden) && !text.includes('bk7f3k9q2x8z'), text);
    const fakeTask = fixture.events[0].payload.tool_response.backgroundTaskId;
    assert.match(fakeTask, /^[a-z]{2}\d[a-z]\d[a-z]\d[a-z]\d[a-z]\d[a-z]$/);
    assert.ok(fixture.events[1].payload.tool_input.command.startsWith(`cat tasks/${fakeTask.toUpperCase()}.output`));
    assert.deepEqual(auditFixture({ a: `x ${hidden.toUpperCase()}` }, { ids }).map((f) => f.problem), ['contém um id original']);
  });

  it('caminho mantido acima de 200 caracteres é cortado com redactAndCut e marcador', () => {
    const s = sanitizer();
    const long = `${HOME}\\${'pasta\\'.repeat(60)}arquivo.txt`;
    const out = s.sanitizePayload({ tool_input: { file_path: long } }).tool_input.file_path;
    assert.ok(charLength(out.replace(/«[^«»]*»/g, '')) <= 200);
    assert.ok(out.startsWith('C:\\Users\\usuario\\pasta'));
    assert.match(out, /…«caminho#1:\d+»$/);
    assert.equal(redact(out), out, 'ponto fixo');
  });

  it('corte por pontos de código, sem partir pares de surrogates (charLength)', () => {
    const s = sanitizer();
    const cut = s.sanitizePayload({ tool_input: { command: `${'a'.repeat(159)}😀${'b'.repeat(50)}` } }).tool_input.command;
    assert.match(cut, new RegExp(`^${'a'.repeat(159)}… «comando#\\d+:\\d+»$`));
    const astral = `echo ${'𝒜'.repeat(150)}`;
    const kept = s.sanitizePayload({ tool_input: { command: astral } }).tool_input.command;
    assert.equal(kept, astral, '155 caracteres cabem nos 160, mesmo com 305 unidades UTF-16');
  });

  it('S1: segredo no limite do corte nunca deixa sobra que o redact mudaria; o resultado é ponto fixo', () => {
    const s = sanitizer();
    for (let pad = 140; pad <= 162; pad++) {
      const out = s.sanitizePayload({
        hook_event_name: 'PostToolUseFailure',
        tool_input: { command: `${'x'.repeat(pad)} --password SEGREDO123 -H "Authorization: Bearer SEGREDO123" fim`, description: `${'d'.repeat(pad - 80)} token=SEGREDO123` },
        error: `${'e'.repeat(pad)} token=SEGREDO123`,
      });
      for (const text of [out.tool_input.command, out.tool_input.description, out.error]) {
        assert.equal(redact(text), text, `pad ${pad}: ${JSON.stringify(text.slice(-40))}`);
        assert.ok(!text.includes('SEGREDO'), `pad ${pad}`);
        assert.ok(charLength(text.replace(/«[^«»]*»/g, '')) <= 200);
      }
    }
  });
});

describe('sanitizePayload', () => {
  it('mantém estrutura, nomes de ferramentas, tipos de agente, números e booleanos; troca os ids', () => {
    const ids = { session_id: SESSION, prompt_id: promptId('p01'), agent_id: AGENTS.w1.id, tool_use_id: 'toolu_01AbCdEfGhIjKlMnOpQrStUv' };
    const payload = {
      ...ids, hook_event_name: 'PostToolUse', agent_type: 'agent-quest-probe:probe-worker',
      tool_name: 'Bash', permission_mode: 'default', duration_ms: 42, effort: { level: 'high' },
      tool_input: { command: 'npm test', run_in_background: false, timeout: 60000 },
      tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false },
    };
    const out = sanitizer().sanitizePayload(payload);
    for (const key of Object.keys(ids)) assert.notEqual(out[key], payload[key], key);
    assert.deepEqual({ ...out, ...ids }, payload, 'fora os ids, nada muda');
  });

  it('troca conteúdo de arquivo, pedidos do Agent e textos do assistente por marcadores', () => {
    const s = sanitizer();
    const out = s.sanitizePayload({
      hook_event_name: 'PostToolUse', tool_name: 'Write',
      tool_input: { file_path: `${HOME}\\p\\a.js`, content: 'CONTEUDO-REAL-DO-ARQUIVO' },
      tool_response: { file: { content: 'CONTEUDO-REAL-DO-ARQUIVO', numLines: 1 } },
      last_assistant_message: 'RESPOSTA-DO-ASSISTENTE',
    });
    assert.equal(out.tool_input.content, '«conteúdo#1:24»');
    assert.equal(out.tool_response.file.content, '«conteúdo#1:24»', 'mesmo texto, mesmo marcador');
    assert.equal(out.tool_response.file.numLines, 1);
    assert.match(out.last_assistant_message, /^«texto#\d+:22»$/);
    const agent = s.sanitizePayload({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'PROMPT-DO-AGENTE', description: 'Ler o CLAUDE.md', subagent_type: 'tester' } });
    assert.deepEqual(agent.tool_input, { prompt: '«pedido#1:16»', description: 'Ler o CLAUDE.md', subagent_type: 'tester' });
  });

  it('caminhos: troca o nome do usuário em todas as formas e preserva a letra da unidade', () => {
    const out = sanitizer().sanitizePayload({
      hook_event_name: 'PreToolUse',
      cwd: 'c:\\Users\\fulano\\Projetos\\proj',
      transcript_path: 'C:\\Users\\Fulano\\.claude\\projects\\c--Users-fulano-Projetos-proj\\s.jsonl',
      tool_input: { file_path: 'C:/Users/fulano/proj/a.js', command: 'type C:\\Users\\fulano\\proj\\a.js' },
      tool_response: { filePath: 'D:\\outros\\fulanos\\a.js' },
    });
    assert.equal(out.cwd, 'c:\\Users\\usuario\\Projetos\\proj');
    assert.equal(out.transcript_path, 'C:\\Users\\usuario\\.claude\\projects\\c--Users-usuario-Projetos-proj\\s.jsonl');
    assert.equal(out.tool_input.file_path, 'C:/Users/usuario/proj/a.js');
    assert.equal(out.tool_input.command, 'type C:\\Users\\usuario\\proj\\a.js');
    assert.equal(out.tool_response.filePath, 'D:\\outros\\fulanos\\a.js', 'outro nome não é tocado');
  });

  it('comandos: primeira linha redigida; o resto e o excesso viram marcador', () => {
    const s = sanitizer();
    assert.equal(s.sanitizePayload({ tool_input: { command: 'MY_TOKEN=abc node x.js' } }).tool_input.command, 'MY_TOKEN=••• node x.js');
    const multi = s.sanitizePayload({ tool_input: { command: "cat > a.txt <<'EOF'\nCONTEUDO-REAL-DO-ARQUIVO\nEOF" } }).tool_input.command;
    assert.match(multi, /^cat > a\.txt <<'EOF'\n«comando#1:\d+»$/);
    const long = s.sanitizePayload({ tool_input: { command: `node -e "${'x'.repeat(300)}"` } }).tool_input.command;
    assert.ok(long.length < 200);
    assert.match(long, /… «comando#2:\d+»$/);
  });

  it('descrições, padrões e URLs ficam curtos', () => {
    const url = 'https://user:pw@docs.example.com/a/b?q=segredo';
    const out = sanitizer().sanitizePayload({
      tool_input: { description: 'd'.repeat(100), pattern: 'p'.repeat(70), url },
    });
    assert.match(out.tool_input.description, /^d{79}… «descrição#1:100»$/, 'redactAndCut: 79 caracteres e "…"');
    assert.match(out.tool_input.pattern, /^p{59}… «padrão#1:70»$/);
    assert.equal(out.tool_input.url, `https://docs.example.com/«url#1:${url.length}»`);
    assert.equal(sanitizer().sanitizePayload({ url: 'https://example.com/' }).url, 'https://example.com');
  });

  it('saída e erro de teste: só as linhas de resumo e o "Exit code"', () => {
    const s = sanitizer();
    const failure = s.sanitizePayload({
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'node --test tmp-probe' },
      error: 'Exit code 1\n✖ soma (1.1ms)\n  AssertionError: CONTEUDO-DA-FALHA\n\nℹ tests 1\nℹ pass 0\nℹ fail 1\n✖ failing tests:\nCONTEUDO-DA-FALHA',
    });
    assert.equal(failure.tool_input.command, 'node --test tmp-probe');
    assert.equal(failure.error, 'Exit code 1\n«2 linhas omitidas»\nℹ tests 1\nℹ pass 0\nℹ fail 1\n«2 linhas omitidas»');
    const outputs = {
      'TAP: ok 1\n# tests 3\n# pass 3\n# fail 0': '«1 linha omitida»\n# tests 3\n# pass 3\n# fail 0',
      'detalhe\nTests:       1 failed, 2 passed, 3 total\nTime: 1s': '«1 linha omitida»\nTests:       1 failed, 2 passed, 3 total\n«1 linha omitida»',
      ' Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 3 passed (4)': ' Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 3 passed (4)',
      'x\n==== 1 failed, 2 passed in 0.12s ====': '«1 linha omitida»\n==== 1 failed, 2 passed in 0.12s ====',
      'FAILURES!\nTests: 3, Assertions: 5, Failures: 1.': 'FAILURES!\nTests: 3, Assertions: 5, Failures: 1.',
      '--- FAIL: TestSoma (0.00s)\nFAIL\tpkg/x\t0.01s': '--- FAIL: TestSoma (0.00s)\nFAIL pkg/x 0.01s', // \t vira espaço (seção 10, etapa 1)
      'saída comum\nsem resumo': '«2 linhas omitidas»',
    };
    for (const [stdout, expected] of Object.entries(outputs)) {
      assert.equal(s.sanitizePayload({ tool_response: { stdout } }).tool_response.stdout, expected, stdout);
    }
  });

  it('pedido do usuário: marcador; comando "/" e tags do sistema são mantidos', () => {
    const s = sanitizer();
    assert.equal(s.sanitizePayload({ hook_event_name: 'UserPromptSubmit', prompt: 'SEGREDO-DO-PEDIDO' }).prompt, '«pedido#1:17»');
    assert.equal(s.sanitizePayload({ hook_event_name: 'UserPromptSubmit', prompt: '/compact' }).prompt, '/compact');
    assert.equal(s.sanitizePayload({ hook_event_name: 'UserPromptSubmit', prompt: '/review o PR 12' }).prompt, '/review «argumentos#1:7»');
    const agent = AGENTS.w4.id;
    const system = s.sanitizePayload({
      hook_event_name: 'UserPromptSubmit',
      prompt: `<task-notification>\n<task-id>${agent}</task-id>\n<status>completed</status>\n<summary attr="x">Agent "Esperar" completed</summary>\n<result>RESULTADO-DO-AGENTE</result>\n</task-notification>`,
    }).prompt;
    const summary = 'Agent "Esperar" completed';
    const fake = s.syntheticId(agent);
    assert.notEqual(fake, agent);
    assert.equal(system, `<task-notification>\n<task-id>${fake}</task-id>\n<status>completed</status>\n<summary>«texto#1:${summary.length}»</summary>\n<result>«texto#2:19»</result>\n</task-notification>`);
  });

  it('erro do StopFailure é enumeração; Notification vira marcador; chaves desconhecidas também', () => {
    const s = sanitizer();
    const stopFailure = s.sanitizePayload({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'detalhe longo' });
    assert.equal(stopFailure.error, 'rate_limit');
    assert.match(stopFailure.error_details, /^«texto#\d+:13»$/);
    const notice = s.sanitizePayload({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission', title: 'x' });
    assert.equal(notice.notification_type, 'permission_prompt');
    assert.match(notice.message, /^«mensagem#\d+:28»$/);
    assert.equal(s.sanitizePayload({ campo_novo: 'qualquer coisa', vazio: '' }).campo_novo, '«texto#2:14»');
    assert.equal(s.sanitizePayload({ vazio: '' }).vazio, '');
  });

  it('preserva igualdades: PermissionRequest e PreToolUse com o mesmo tool_input continuam com o mesmo inputHash', () => {
    const s = sanitizer();
    const input = { command: "cat > a <<'EOF'\nlinha\nEOF", description: 'Gravar' };
    const other = { command: "cat > a <<'EOF'\noutra\nEOF", description: 'Gravar' };
    const preHash = inputHash(s.sanitizePayload({ hook_event_name: 'PreToolUse', tool_input: input }).tool_input);
    const prHash = inputHash(s.sanitizePayload({ hook_event_name: 'PermissionRequest', tool_input: { ...input } }).tool_input);
    const otherHash = inputHash(s.sanitizePayload({ hook_event_name: 'PreToolUse', tool_input: other }).tool_input);
    assert.equal(preHash, prHash);
    assert.notEqual(preHash, otherHash);
  });
});

describe('ids sintéticos (ADR 0010)', () => {
  const sameShape = (fake, original) => {
    assert.equal(fake.length, original.length);
    assert.notEqual(fake, original);
    for (let i = 0; i < original.length; i++) {
      const [a, b] = [original[i], fake[i]];
      if (!/[A-Za-z0-9]/.test(a)) assert.equal(b, a, `separador na posição ${i}`);
    }
  };

  it('UUID continua UUID: mesmo comprimento, hífens no lugar, só hexadecimal', () => {
    const original = uuid('qualquer');
    const fake = shapeLikeId(original);
    sameShape(fake, original);
    assert.match(fake, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'UUID v4 válido');
    assert.equal(fake[14], original[14]);
    assert.equal(fake[19], original[19]);
  });

  it('toolu_ e agent_id mantêm o prefixo; dígito vira dígito e letra vira letra da mesma caixa', () => {
    const tool = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    const fakeTool = shapeLikeId(tool);
    sameShape(fakeTool, tool);
    assert.ok(fakeTool.startsWith('toolu_01'));
    for (let i = 8; i < tool.length; i++) {
      for (const cls of [/\d/, /[a-z]/, /[A-Z]/]) if (cls.test(tool[i])) assert.match(fakeTool[i], cls, `posição ${i}`);
    }
    const agent = AGENTS.w1.id;
    const fakeAgent = shapeLikeId(agent);
    sameShape(fakeAgent, agent);
    assert.match(fakeAgent, /^a[0-9a-f]{16}$/);
    assert.match(shapeLikeId('12345678'), /^\d{8}$/);
  });

  it('é determinístico e muda a cada tentativa', () => {
    assert.equal(shapeLikeId(SESSION), shapeLikeId(SESSION));
    assert.notEqual(shapeLikeId(SESSION, 0), shapeLikeId(SESSION, 1));
  });

  it('o mesmo id vira o mesmo id sintético em todo lugar, inclusive dentro de outras strings', () => {
    const s = sanitizer();
    const agent = AGENTS.w4.id;
    const tool = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    // transcript_path vem antes de session_id: o id é trocado mesmo assim.
    const stop = s.sanitizePayload({
      transcript_path: `${HOME}\\.claude\\projects\\x\\${SESSION}.jsonl`,
      session_id: SESSION,
      hook_event_name: 'SubagentStop',
      agent_transcript_path: `${HOME}\\.claude\\projects\\x\\${SESSION}\\subagents\\agent-${agent}.jsonl`,
      agent_id: agent,
      background_tasks: [{ id: agent, type: 'local_agent', status: 'running' }],
    });
    const fakeSession = s.syntheticId(SESSION);
    const fakeAgent = s.syntheticId(agent);
    assert.equal(stop.session_id, fakeSession);
    assert.equal(stop.transcript_path, `C:\\Users\\usuario\\.claude\\projects\\x\\${fakeSession}.jsonl`);
    assert.equal(stop.agent_transcript_path, `C:\\Users\\usuario\\.claude\\projects\\x\\${fakeSession}\\subagents\\agent-${fakeAgent}.jsonl`);
    assert.equal(stop.agent_id, fakeAgent);
    assert.equal(stop.background_tasks[0].id, fakeAgent);

    const post = s.sanitizePayload({
      session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tool,
      tool_response: { status: 'async_launched', outputFile: `${HOME}\\AppData\\Local\\Temp\\${agent}.output`, agentId: agent },
    });
    assert.equal(post.tool_response.agentId, fakeAgent, 'elo agentId ↔ agent_id');
    assert.equal(post.tool_response.outputFile, `C:\\Users\\usuario\\AppData\\Local\\Temp\\${fakeAgent}.output`);
    assert.equal(post.session_id, fakeSession);

    const back = s.sanitizePayload({
      session_id: SESSION, hook_event_name: 'UserPromptSubmit',
      prompt: `<task-notification>\n<task-id>${agent}</task-id>\n<tool-use-id>${tool}</tool-use-id>\n</task-notification>`,
    });
    assert.equal(back.prompt, `<task-notification>\n<task-id>${fakeAgent}</task-id>\n<tool-use-id>${s.syntheticId(tool)}</tool-use-id>\n</task-notification>`);
    assert.equal(post.tool_use_id, s.syntheticId(tool));
  });

  it('id sem nada para variar depois do prefixo não trava: perde o prefixo ou vira marcador', () => {
    const s = sanitizer();
    const fake = s.syntheticId('toolu_01');
    assert.equal(fake.length, 8);
    assert.notEqual(fake, 'toolu_01');
    assert.match(s.syntheticId('---'), /^«id#\d+:3»$/);
  });

  it('ids diferentes viram ids diferentes; ids curtos só mudam na própria chave', () => {
    const s = sanitizer();
    assert.notEqual(s.syntheticId(AGENTS.w1.id), s.syntheticId(AGENTS.w2.id));
    const out = s.sanitizePayload({ id: '1', tool_response: { stdout: 'ℹ tests 1' } });
    assert.match(out.id, /^\d$/);
    assert.notEqual(out.id, '1');
    assert.equal(out.tool_response.stdout, 'ℹ tests 1');
  });

  it('collectIds junta as chaves de id e os ids das tags', () => {
    const ids = collectIds({
      session_id: SESSION, tool_use_id: 'toolu_01x', nested: [{ agentId: AGENTS.w1.id }], name: 'não é id',
      prompt: `<task-notification>\n<task-id>${AGENTS.w2.id}</task-id>\n<status>completed</status>\n</task-notification>`,
    });
    assert.deepEqual([...ids].sort(), [SESSION, 'toolu_01x', AGENTS.w1.id, AGENTS.w2.id].sort());
  });
});

describe('buildFixture, auditFixture e seleção', () => {
  it('monta { name, description, events: [{ dt, env, payload }] } com dt não negativo', () => {
    const records = syntheticRecords();
    const fixture = buildFixture(records, { name: 'tudo', description: 'Sessão sintética', home: HOME });
    assert.deepEqual(Object.keys(fixture), ['name', 'description', 'events']);
    assert.equal(fixture.events.length, records.length);
    assert.equal(fixture.events[0].dt, 0);
    for (const event of fixture.events) {
      assert.deepEqual(Object.keys(event), ['dt', 'env', 'payload']);
      assert.ok(Number.isInteger(event.dt) && event.dt >= 0);
      assert.equal(event.env.projectDir, 'C:\\Users\\usuario\\Projetos\\agents-quest');
    }
    assert.deepEqual([...new Set(fixture.events.map((e) => e.env.entrypoint))], ['cli', 'claude-vscode']);
    const total = fixture.events.reduce((sum, e) => sum + e.dt, 0);
    assert.equal(total, records.at(-1).writtenAt - records[0].writtenAt);
  });

  it('o cenário não tem conteúdo real, nome do usuário nem id original, e a conferência passa', () => {
    const records = syntheticRecords();
    const ids = new Set();
    for (const record of records) collectIds(record.payload, ids);
    assert.ok(ids.size > 40, `${ids.size} ids reais na sessão sintética`);
    const fixture = buildFixture(records, { name: 'tudo', description: 'Sessão sintética', home: HOME });
    const text = JSON.stringify(fixture);
    for (const marker of CONTENT_MARKERS) assert.ok(!text.includes(marker), `vazou: ${marker}`);
    for (const id of ids) assert.ok(!text.includes(id), `id original: ${id}`);
    assert.ok(!/fulano(?![a-z])/i.test(text), 'nome do usuário');
    assert.deepEqual(auditFixture(fixture, { forbidden: ['fulano'], ids }), []);
  });

  it('auditFixture aponta segredo, string longa, nome do usuário e id original', () => {
    const findings = auditFixture({
      name: 'x', description: 'y',
      events: [{
        dt: 0, env: {},
        payload: {
          a: 'token=abc', b: 'x'.repeat(201), c: `ok ${'«m»'.repeat(100)}`, d: 'C:\\dados\\fulano\\a',
          e: `C:\\x\\${SESSION}.jsonl`, f: 'curto',
        },
      }],
    }, { forbidden: ['fulano'], ids: [SESSION, 'curto'] });
    assert.deepEqual(findings.map((f) => [f.where, f.problem.split(' (')[0]]), [
      ['cenário.events[0].payload.a', 'possível segredo'],
      ['cenário.events[0].payload.b', 'string longa'],
      ['cenário.events[0].payload.d', 'contém o nome do usuário'],
      ['cenário.events[0].payload.e', 'contém um id original'],
    ]);
  });

  it('os vereditos do relatório se repetem nos cenários sanitizados (um ou vários)', () => {
    const records = syntheticRecords();
    const raw = analyze(records).items.map((it) => it.verdict);
    const single = buildFixture(records, { name: 'tudo', description: 'x', home: HOME });
    assert.deepEqual(analyze(parseFixture(single, 'tudo.json').records).items.map((it) => it.verdict), raw);

    const dir = path.join(tmp, 'cenarios');
    mkdirSync(dir, { recursive: true });
    // Pedidos 1 a 4 com o SessionStart; 5 e 6; 7 e o retorno do segundo plano (8); do 9 ao fim.
    const fifth = records.filter((r) => r.payload.hook_event_name === 'UserPromptSubmit')[4].line;
    const parts = [['01-inicio', { lines: `1-${fifth - 1}` }], ['02-paralelo', { prompts: '5-6' }], ['03-segundo-plano', { prompts: '7-8' }], ['04-resto', { prompts: '9-14' }]];
    for (const [name, selection] of parts) {
      const fixture = buildFixture(selectRecords(records, selection), { name, description: name, home: HOME });
      writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(fixture));
    }
    const split = loadInputs([dir]);
    assert.deepEqual(split.problems, []);
    assert.deepEqual(analyze(split.records).items.map((it) => it.verdict), raw);
    // O mesmo id real vira o mesmo id sintético em cenários diferentes.
    const sessions = new Set(split.records.filter((r) => r.payload.hook_event_name === 'UserPromptSubmit' && r.line === 1).map((r) => r.payload.session_id));
    assert.equal(sessions.size, 1);
    assert.ok(!sessions.has(SESSION));
  });

  it('selectRecords por linhas, por pedidos e por sessão', () => {
    const records = syntheticRecords();
    assert.deepEqual(selectRecords(records, { lines: '1-3,10' }).map((r) => r.line), [1, 2, 3, 10]);
    const second = selectRecords(records, { prompts: '2' });
    assert.equal(second[0].payload.prompt_id, promptId('p02'));
    assert.ok(second.every((r) => r.payload.prompt_id === promptId('p02')));
    const vscode = selectRecords(records, { session: SESSION_VSCODE.slice(0, 8) });
    assert.ok(vscode.length > 0 && vscode.every((r) => r.payload.session_id === SESSION_VSCODE));
    assert.equal(selectRecords(vscode, { prompts: '1' })[0].payload.prompt_id, promptId('q01'));
    assert.throws(() => selectRecords(records, { prompts: '99' }), /não existe/);
    assert.throws(() => selectRecords(records, { lines: '5-2' }), /faixa inválida/);
    assert.throws(() => selectRecords(records, { lines: '1', prompts: '1' }), /não os dois/);
  });

  it('describeRecords lista sessões e pedidos com a faixa de linhas', () => {
    const rows = describeRecords(syntheticRecords());
    assert.match(rows[0].label, /^SessionStart \(source startup\)/);
    assert.match(rows[1].label, /^pedido 1: "Leia o CLAUDE.md/);
    assert.ok(rows.some((r) => /^pedido 8: <task-notification> /.test(r.label)));
    assert.ok(rows.some((r) => /agentes: agent-quest-probe:probe-worker/.test(r.label)));
  });
});

describe('sanitize.mjs: linha de comando', () => {
  const input = () => {
    const file = path.join(tmp, 'events.jsonl');
    if (!existsSync(file)) writeFileSync(file, synthetic.jsonl);
    return file;
  };
  function run(args) {
    return spawnSync(process.execPath, [SANITIZE, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_QUEST_HOME: path.join(tmp, 'dados-cli') },
      windowsHide: true,
    });
  }

  it('--list mostra os pedidos', () => {
    const result = run(['--list', '--in', input()]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pedido 1: /);
    assert.match(result.stdout, /SessionEnd \(reason clear\)/);
  });

  it('grava o cenário, recusa sobrescrever sem --force e valida os argumentos', () => {
    const out = path.join(tmp, 'saida', 'basico.json');
    const first = run(['--in', input(), '--name', 'basico', '--description', 'Caso básico', '--lines', '1-9', '--out', out]);
    assert.equal(first.status, 0, first.stderr);
    const written = readFileSync(out, 'utf8');
    const fixture = JSON.parse(written);
    assert.equal(fixture.name, 'basico');
    assert.equal(fixture.events.length, 9);
    const ids = new Set();
    for (const record of syntheticRecords()) collectIds(record.payload, ids);
    for (const id of ids) assert.ok(!written.includes(id), `id original: ${id}`);
    assert.equal(run(['--in', input(), '--name', 'basico', '--description', 'x', '--lines', '1-9', '--out', out]).status, 1);
    assert.equal(run(['--in', input(), '--name', 'basico', '--description', 'x', '--lines', '1-9', '--out', out, '--force']).status, 0);
    assert.equal(run(['--in', input(), '--name', 'Nome Errado', '--description', 'x', '--lines', '1']).status, 1);
    assert.equal(run(['--in', input(), '--name', 'x', '--description', 'x']).status, 1);
    assert.equal(run(['--in', path.join(tmp, 'nao-existe.jsonl'), '--list']).status, 1);
  });

  it('não grava quando a conferência acha o nome do usuário', (t) => {
    const user = path.basename(os.homedir());
    if (user.length < 3) {
      t.skip('nome de usuário curto demais para o teste');
      return;
    }
    const file = path.join(tmp, 'com-usuario.jsonl');
    const record = { probe: 1, receivedAt: 1, writtenAt: 1, bytes: 1, env: { names: [], values: {} }, payload: { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `dir D:\\dados\\${user}\\x` } } };
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    const out = path.join(tmp, 'saida', 'com-usuario.json');
    const result = run(['--in', file, '--name', 'com-usuario', '--description', 'x', '--lines', '1', '--out', out]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /contém o nome do usuário/);
    assert.equal(existsSync(out), false);
  });
});
