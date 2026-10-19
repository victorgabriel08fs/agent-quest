// Ferramentas: categoria, alvo e detalhe (modelo de eventos, seção 3), caminhos,
// host de URL, alvo de MCP e inputHash (seção 2).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_CATEGORIES } from '../../../../shared/contract.js';
import { charLength, redact } from '../../../../server/domain/redact.js';
import { growthWithin } from '../../../integration/timing.js';
import {
  AGENT_TOOLS,
  CATEGORY_BY_TOOL,
  CUT_MARKER,
  IDENTIFIER,
  LIMITS,
  SCAN_CHARS,
  boundaryChecker,
  describeTool,
  displayPath,
  dropCutWords,
  firstLine,
  identifier,
  identifierKey,
  rawIdentifier,
  redactWindow,
  inputHash,
  mcpTarget,
  normalizeSlashes,
  scanWindow,
  stableStringify,
  textLine,
  urlHost,
} from '../../../../server/domain/tools.js';

const HOME = 'C:\\Users\\fulano';
const PROJECT = `${HOME}\\Projetos\\agents-quest`;
const ctx = { projectDir: PROJECT, homeDir: HOME };

describe('LIMITS', () => {
  it('limites da seção 10', () => {
    assert.equal(LIMITS.command, 120);
    assert.equal(LIMITS.title, 80);
    assert.equal(LIMITS.error, 160);
    assert.equal(LIMITS.search, 60);
    assert.equal(LIMITS.web, 80);
    assert.equal(LIMITS.description, 80);
    assert.ok(LIMITS.path <= 200 && LIMITS.name <= 200);
  });
});

describe('describeTool: tabela da seção 3', () => {
  /** [tool_name, tool_input, { category, target, detail }] */
  const table = [
    ['Read', { file_path: `${PROJECT}\\src\\a.js`, offset: 1, limit: 2 }, { category: 'read', target: 'src/a.js', detail: null }],
    ['NotebookRead', { notebook_path: `${PROJECT}\\n.ipynb` }, { category: 'read', target: 'n.ipynb', detail: null }],
    ['Grep', { pattern: 'TODO\\(', path: PROJECT }, { category: 'search', target: 'TODO\\(', detail: null }],
    ['Glob', { pattern: '**/*.test.js' }, { category: 'search', target: '**/*.test.js', detail: null }],
    ['LS', { path: `${PROJECT}\\server` }, { category: 'search', target: 'server', detail: null }],
    ['LSP', { file_path: `${PROJECT}\\server\\main.js`, operation: 'hover' }, { category: 'search', target: 'server/main.js', detail: null }],
    ['ToolSearch', { query: 'select:Read' }, { category: 'search', target: 'select:Read', detail: null }],
    ['Write', { file_path: `${PROJECT}\\x.txt`, content: 'CONTEUDO' }, { category: 'write', target: 'x.txt', detail: null }],
    ['Edit', { file_path: `${PROJECT}\\x.txt`, old_string: 'a', new_string: 'b' }, { category: 'edit', target: 'x.txt', detail: null }],
    ['MultiEdit', { file_path: `${PROJECT}\\x.txt`, edits: [] }, { category: 'edit', target: 'x.txt', detail: null }],
    ['NotebookEdit', { notebook_path: `${PROJECT}\\n.ipynb`, new_source: 'x' }, { category: 'edit', target: 'n.ipynb', detail: null }],
    ['Bash', { command: 'npm test\nsegunda linha', description: 'Rodar a suíte' }, { category: 'bash', target: 'npm test', detail: 'Rodar a suíte' }],
    ['PowerShell', { command: 'Get-ChildItem', description: 'Listar' }, { category: 'bash', target: 'Get-ChildItem', detail: 'Listar' }],
    ['BashOutput', { bash_id: 'b1' }, { category: 'bash', target: null, detail: null }],
    ['Monitor', { description: 'Acompanhar o build' }, { category: 'bash', target: null, detail: 'Acompanhar o build' }],
    ['TaskStop', { task_id: 't1' }, { category: 'bash', target: null, detail: null }],
    ['WebFetch', { url: 'https://user:pw@docs.example.com:8443/a?b=c', prompt: 'x' }, { category: 'web', target: 'docs.example.com:8443', detail: null }],
    ['WebSearch', { query: 'node test runner' }, { category: 'web', target: 'node test runner', detail: null }],
    ['TodoWrite', { todos: [{ content: 'x' }] }, { category: 'plan', target: null, detail: null }],
    ['TaskCreate', { subject: 'x' }, { category: 'plan', target: null, detail: null }],
    ['TaskUpdate', {}, { category: 'plan', target: null, detail: null }],
    ['TaskList', {}, { category: 'plan', target: null, detail: null }],
    ['TaskGet', { task_id: '1' }, { category: 'plan', target: null, detail: null }],
    ['Skill', { skill: 'pdf', args: 'x' }, { category: 'skill', target: 'pdf', detail: null }],
    ['mcp__claude_ai_Supabase__list_tables', { project_id: 'x' }, { category: 'mcp', target: 'claude_ai_Supabase/list_tables', detail: null }],
    ['Agent', { subagent_type: 'tester', description: 'Testar a ingestão', prompt: 'PROMPT' }, { category: null, target: 'tester', detail: 'Testar a ingestão' }],
    ['Task', { subagent_type: 'Explore', description: 'Achar arquivos' }, { category: null, target: 'Explore', detail: 'Achar arquivos' }],
    ['FerramentaNova', { qualquer: 1 }, { category: 'other', target: 'FerramentaNova', detail: null }],
  ];

  for (const [name, input, expected] of table) {
    it(`${name} → ${expected.category}`, () => {
      assert.deepEqual(describeTool(name, input, ctx), expected);
    });
  }

  it('toda categoria produzida é do contrato', () => {
    for (const category of CATEGORY_BY_TOOL.values()) assert.ok(TOOL_CATEGORIES.includes(category), category);
    assert.ok(TOOL_CATEGORIES.includes('mcp') && TOOL_CATEGORIES.includes('other'));
  });

  it('Bash e PowerShell ficam em bash até o T6, mesmo com comando de teste', () => {
    assert.equal(describeTool('Bash', { command: 'npm test' }, ctx).category, 'bash');
    assert.equal(describeTool('PowerShell', { command: 'node --test' }, ctx).category, 'bash');
  });

  it('Agent e Task são as ferramentas de delegação', () => {
    assert.deepEqual([...AGENT_TOOLS].sort(), ['Agent', 'Task']);
  });

  it('nunca lê content, old_string, new_string nem o prompt do Agent', () => {
    const secret = 'CONTEUDO-SECRETO';
    const outs = [
      describeTool('Write', { file_path: 'a.txt', content: secret }, ctx),
      describeTool('Edit', { file_path: 'a.txt', old_string: secret, new_string: secret }, ctx),
      describeTool('Agent', { subagent_type: 'tester', description: 'x', prompt: secret }, ctx),
      describeTool('WebFetch', { url: 'https://example.com', prompt: secret }, ctx),
    ];
    assert.doesNotMatch(JSON.stringify(outs), /CONTEUDO-SECRETO/);
  });

  it('entrada malformada não lança: nome ou tool_input de tipo errado', () => {
    for (const [name, input] of [[null, null], [42, 'x'], ['Read', null], ['Read', []], ['Bash', { command: 42 }], ['WebFetch', { url: {} }], ['Grep', { pattern: ['x'] }]]) {
      const out = describeTool(name, input, ctx);
      assert.ok(out.category === null || TOOL_CATEGORIES.includes(out.category));
      assert.ok(out.target === null || typeof out.target === 'string');
    }
    assert.deepEqual(describeTool(42, {}, ctx), { category: 'other', target: null, detail: null });
  });
});

describe('describeTool: redação e limites', () => {
  it('comando: primeira linha, redigido, até 120', () => {
    const { target } = describeTool('Bash', { command: `export GITHUB_TOKEN=ghp_${'a'.repeat(36)} && ${'x'.repeat(300)}\nfim` }, ctx);
    assert.ok(target.startsWith('export GITHUB_TOKEN=•••'), target);
    assert.equal(charLength(target), 120);
    assert.ok(target.endsWith('…'));
    assert.equal(redact(target), target);
  });

  it('descrição até 80, busca até 60, consulta web até 80', () => {
    assert.equal(charLength(describeTool('Bash', { command: 'x', description: 'd'.repeat(500) }, ctx).detail), 80);
    assert.equal(charLength(describeTool('Agent', { subagent_type: 't', description: 'd'.repeat(500) }, ctx).detail), 80);
    assert.equal(charLength(describeTool('Grep', { pattern: 'p'.repeat(500) }, ctx).target), 60);
    assert.equal(charLength(describeTool('WebSearch', { query: 'q'.repeat(500) }, ctx).target), 80);
  });

  it('segredos em descrição, busca e consulta web viram •••', () => {
    assert.equal(describeTool('Bash', { command: 'x', description: 'usar password=hunter2' }, ctx).detail, 'usar password=•••');
    assert.equal(describeTool('Grep', { pattern: 'api_key=abc123' }, ctx).target, 'api_key=•••');
    assert.equal(describeTool('WebSearch', { query: 'Bearer abcdef123456' }, ctx).target, 'Bearer •••');
  });

  it('segredo que atravessa linhas não vaza pela primeira linha', () => {
    const { target } = describeTool('Bash', { command: 'cat <<EOF\n-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\nEOF' }, ctx);
    assert.equal(target, 'cat <<EOF');
    const key = describeTool('Bash', { command: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----' }, ctx);
    assert.equal(key.target, '•••');
  });

  it('caminho longo é cortado por redactAndCut, no limite de caminho', () => {
    const { target } = describeTool('Read', { file_path: `${PROJECT}\\${'pasta\\'.repeat(60)}a.js` }, ctx);
    assert.equal(charLength(target), LIMITS.path);
    assert.ok(target.endsWith('…'));
  });
});

describe('mcpTarget', () => {
  it('servidor/ferramenta, com "_" simples no nome do servidor', () => {
    assert.equal(mcpTarget('mcp__github__create_issue'), 'github/create_issue');
    assert.equal(mcpTarget('mcp__claude_ai_Claude_Docs__read'), 'claude_ai_Claude_Docs/read');
    assert.equal(mcpTarget('mcp__servidor__ferramenta__com__duplo'), 'servidor/ferramenta__com__duplo');
  });

  it('formas incompletas', () => {
    assert.equal(mcpTarget('mcp__so_servidor'), 'so_servidor');
    assert.equal(mcpTarget('mcp__servidor__'), 'servidor');
    assert.equal(mcpTarget('mcp__'), null);
    assert.equal(mcpTarget('mcp____x'), '__x');
  });
});

describe('urlHost', () => {
  it('só o host, sem usuário, senha, caminho nem consulta', () => {
    assert.equal(urlHost('https://usuario:senha@exemplo.com/caminho?token=abc#x'), 'exemplo.com');
    assert.equal(urlHost('http://127.0.0.1:8080/x'), '127.0.0.1:8080');
    assert.equal(urlHost('HTTPS://Docs.Example.COM'), 'docs.example.com');
  });

  it('URL inválida, sem host ou que não é texto: null', () => {
    for (const value of ['não é url', '', 'file:///C:/x', 'mailto:a@b.c', null, 42, {}]) {
      assert.equal(urlHost(value), null, String(value));
    }
  });
});

describe('displayPath', () => {
  it('dentro do projeto: relativo com "/", com "\\" ou "/" e a letra da unidade em qualquer caixa', () => {
    const files = [
      `${PROJECT}\\server\\main.js`,
      'c:\\users\\fulano\\projetos\\agents-quest\\server\\main.js',
      'C:/Users/fulano/Projetos/agents-quest/server/main.js',
      'c:/Users/fulano/Projetos/agents-quest\\server/main.js',
    ];
    const projects = [PROJECT, PROJECT.toLowerCase(), PROJECT.replace(/\\/g, '/'), `${PROJECT}\\`, `c${PROJECT.slice(1)}`];
    for (const projectDir of projects) {
      for (const file of files) {
        assert.equal(displayPath(file, { projectDir, homeDir: HOME }), 'server/main.js', `${file} em ${projectDir}`);
      }
    }
  });

  it('a pasta do projeto é "."', () => {
    assert.equal(displayPath(PROJECT, ctx), '.');
    assert.equal(displayPath(`${PROJECT}\\`, ctx), '.');
  });

  it('fora do projeto, dentro da pasta pessoal: "~"', () => {
    assert.equal(displayPath(`${HOME}\\.claude\\settings.json`, ctx), '~/.claude/settings.json');
    assert.equal(displayPath('c:/users/FULANO/Documentos/x.md', ctx), '~/Documentos/x.md');
    assert.equal(displayPath(HOME, ctx), '~');
  });

  it('fora das duas: absoluto com "/"', () => {
    assert.equal(displayPath('D:\\Outro\\x.js', ctx), 'D:/Outro/x.js');
    assert.equal(displayPath('C:\\Windows\\win.ini', ctx), 'C:/Windows/win.ini');
  });

  it('prefixo parecido não conta como dentro (agents-quest-2, fulano2)', () => {
    assert.equal(displayPath(`${PROJECT}-2\\x.js`, ctx), '~/Projetos/agents-quest-2/x.js');
    assert.equal(displayPath('C:\\Users\\fulano2\\x.js', ctx), 'C:/Users/fulano2/x.js');
  });

  it('".." é resolvido antes de comparar', () => {
    assert.equal(displayPath(`${PROJECT}\\server\\..\\web\\index.html`, ctx), 'web/index.html');
    assert.equal(displayPath(`${PROJECT}\\..\\outro\\x.js`, ctx), '~/Projetos/outro/x.js');
  });

  it('relativo fica como veio, com "/"', () => {
    assert.equal(displayPath('src\\a.js', ctx), 'src/a.js');
    assert.equal(displayPath('./src/a.js', ctx), 'src/a.js');
    assert.equal(displayPath('../x.js', ctx), '../x.js');
  });

  it('caminhos POSIX e UNC', () => {
    const posix = { projectDir: '/home/fulano/proj', homeDir: '/home/fulano' };
    assert.equal(displayPath('/home/fulano/proj/a/b.js', posix), 'a/b.js');
    assert.equal(displayPath('/home/fulano/.bashrc', posix), '~/.bashrc');
    assert.equal(displayPath('/etc/hosts', posix), '/etc/hosts');
    assert.equal(displayPath('/home/Fulano/proj/a.js', posix), '/home/Fulano/proj/a.js', 'POSIX diferencia maiúsculas');
    const unc = { projectDir: '\\\\servidor\\share\\proj', homeDir: HOME };
    assert.equal(displayPath('\\\\servidor\\share\\proj\\a.js', unc), 'a.js');
    assert.equal(displayPath('\\\\SERVIDOR\\Share\\proj\\a.js', unc), 'a.js');
  });

  it('sem projeto ou pasta pessoal conhecidos, ou com valores de tipo errado', () => {
    assert.equal(displayPath(`${PROJECT}\\a.js`, {}), 'C:/Users/fulano/Projetos/agents-quest/a.js');
    assert.equal(displayPath(`${PROJECT}\\a.js`, { projectDir: 42, homeDir: {} }), 'C:/Users/fulano/Projetos/agents-quest/a.js');
    assert.equal(displayPath(`${PROJECT}\\a.js`, { projectDir: 'relativo', homeDir: null }), 'C:/Users/fulano/Projetos/agents-quest/a.js');
    for (const value of [null, undefined, '', '   ', 42, {}]) assert.equal(displayPath(value, ctx), null, String(value));
  });
});

describe('displayPath: formas de caminho (seção 2, 18/10/2026)', () => {
  const posixCtx = { projectDir: '/home/fulano/proj', homeDir: '/home/fulano' };
  const forms = {
    'com \\\\?\\': (p) => `\\\\?\\${p}`,
    'com \\\\.\\': (p) => `\\\\.\\${p}`,
    'com barras': (p) => p.replace(/\\/g, '/'),
    'MSYS /c/': (p) => `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`,
  };

  it('arquivo em cada forma, dentro do projeto e da pasta pessoal', () => {
    for (const [label, form] of Object.entries(forms)) {
      assert.equal(displayPath(form(`${PROJECT}\\server\\main.js`), ctx), 'server/main.js', label);
      assert.equal(displayPath(form(`${HOME}\\.claude\\settings.json`), ctx), '~/.claude/settings.json', label);
    }
  });

  it('projeto e pasta pessoal em cada forma', () => {
    for (const [label, form] of Object.entries(forms)) {
      const context = { projectDir: form(PROJECT), homeDir: form(HOME) };
      if (label === 'MSYS /c/') continue; // sem letra de unidade no contexto, /c/ não é convertido (teste abaixo)
      assert.equal(displayPath(`${PROJECT}\\a.js`, context), 'a.js', label);
      assert.equal(displayPath(`${HOME}\\b.txt`, context), '~/b.txt', label);
    }
    // Projeto em MSYS, pasta pessoal com letra de unidade: o contexto é do Windows.
    assert.equal(displayPath(`${PROJECT}\\a.js`, { projectDir: forms['MSYS /c/'](PROJECT), homeDir: HOME }), 'a.js');
  });

  it('\\\\?\\UNC\\srv\\share vira //srv/share; UNC mantém as duas barras', () => {
    const unc = { projectDir: '\\\\srv\\share\\proj', homeDir: HOME };
    assert.equal(displayPath('\\\\?\\UNC\\srv\\share\\proj\\a.js', unc), 'a.js');
    assert.equal(displayPath('//srv/share/proj/a.js', unc), 'a.js');
    assert.equal(displayPath('//SRV/Share/proj/a.js', { projectDir: '//srv/share/proj', homeDir: HOME }), 'a.js');
    assert.equal(displayPath('\\\\?\\UNC\\srv\\share\\outro\\b.js', unc), '//srv/share/outro/b.js');
    assert.equal(displayPath('//srv/share/outro/b.js', ctx), '//srv/share/outro/b.js');
    assert.equal(normalizeSlashes('\\\\?\\UNC\\srv\\share\\x'), '//srv/share/x');
    assert.equal(normalizeSlashes('\\\\.\\C:\\x\\y'), 'C:/x/y');
  });

  it('/c/... só vira c:/... quando o projeto ou a pasta pessoal têm letra de unidade', () => {
    assert.equal(displayPath('/c/Users/fulano/Projetos/agents-quest/a.js', ctx), 'a.js');
    assert.equal(displayPath('/d/outro/x.js', ctx), 'd:/outro/x.js');
    assert.equal(displayPath('/c/dados/x.js', posixCtx), '/c/dados/x.js', 'caminho Linux fica como está');
    assert.equal(displayPath('/home/fulano/proj/c/x.js', posixCtx), 'c/x.js');
  });
});

describe('dropCutWords (B3, marcador de corte do encaminhador)', () => {
  const M = (n) => `…[cortado ${n} caracteres]…`;

  it('a palavra encostada em cada lado some; o resto fica', () => {
    assert.equal(dropCutWords(`antes palavra${M(10)}outra depois`), 'antes … depois');
    assert.equal(dropCutWords(`antes ${M(10)} depois`), 'antes … depois');
    assert.equal(dropCutWords(`a\nghp_AAAA${M(99)}xx\nfim`), 'a\n…\nfim');
  });

  it('sem espaço em branco, some tudo daquele lado', () => {
    assert.equal(dropCutWords(`tudojunto${M(5)}tudojunto`), '…');
    assert.equal(dropCutWords(`começo ${'x'.repeat(50)}${M(5)}${'y'.repeat(50)}`), 'começo …');
  });

  it('vários marcadores, marcador colado em outro e textos sem marcador', () => {
    assert.equal(dropCutWords(`a b${M(1)}c d e${M(2)}f g`), 'a … d … g');
    assert.equal(dropCutWords(`a b${M(1)}${M(2)}c d`), 'a … d');
    assert.equal(dropCutWords('sem marcador nenhum'), 'sem marcador nenhum');
    assert.equal(dropCutWords('…[cortado muitos caracteres]… não é o formato'), '…[cortado muitos caracteres]… não é o formato');
    assert.match('…[cortado 12 caracteres]…', CUT_MARKER);
  });

  it('tempo linear em palavras enormes dos dois lados (razão contra 1/16 do tamanho, ADR 0010)', () => {
    const text = (size) => `${'x'.repeat(size)}${M(5)}${'y'.repeat(size)}`;
    const small = text(62_500);
    const big = text(1_000_000);
    assert.equal(dropCutWords(big), '…');
    // 16 vezes a entrada: linear dá razão perto de 16, quadrático perto de 256.
    const growth = growthWithin(dropCutWords, small, big, { maxRatio: 48 });
    assert.ok(growth.ok, growth.text);
  });
});

describe('identifier (seção 2, "Identificadores")', () => {
  it('casa com o padrão e é ponto fixo de redact: fica como está', () => {
    for (const value of ['tester', 'agent-quest-probe:probe-worker', 'mcp/x', 'claude-opus-5-5', 'a@b', 'x'.repeat(80)]) {
      assert.equal(identifier(value), value);
      assert.ok(IDENTIFIER.test(value));
    }
  });

  it('casa com o padrão mas não é ponto fixo: redactAndCut (nunca aparece cru)', () => {
    assert.equal(identifier('auth:tester'), 'auth:•••');
    assert.equal(identifier('https://u:p@h/'), 'https://•••@h/');
    assert.equal(identifier(`ghp_${'A'.repeat(36)}`), '•••');
    assert.equal(identifier(`AKIA${'B'.repeat(16)}`), '•••');
    for (const value of ['auth:tester', 'https://u:p@h/', `ghp_${'A'.repeat(36)}`]) {
      assert.ok(IDENTIFIER.test(value));
      assert.equal(redact(identifier(value)), identifier(value));
    }
  });

  it('identifierKey: valor cru sem invisíveis e controles; vazio ou acima de 128 vira null', () => {
    assert.equal(identifierKey('auth:tester'), 'auth:tester');
    assert.equal(identifierKey(`ghp_${'A'.repeat(36)}`), `ghp_${'A'.repeat(36)}`);
    assert.equal(identifierKey(`tes${String.fromCharCode(0x200b)}ter\x00`), 'tester');
    // O valor cru (uso interno) também sai sem as sequências ANSI.
    assert.equal(identifierKey('tester\x1B[0m'), 'tester');
    assert.equal(identifierKey('x'.repeat(128)), 'x'.repeat(128));
    for (const value of ['x'.repeat(129), '', '\x00', null, undefined, 42]) assert.equal(identifierKey(value), null, String(value).slice(0, 10));
  });

  it('fora do padrão: redactAndCut(…, 80); invisíveis e controles saem antes', () => {
    assert.equal(identifier('meu agente'), 'meu agente');
    assert.equal(identifier('nome com token=abc'), 'nome com token=•••');
    assert.equal(identifier('x'.repeat(81)), `${'x'.repeat(79)}…`);
    assert.equal(identifier(`tes${String.fromCharCode(0x200b)}ter\x00`), 'tester');
    assert.equal(rawIdentifier(`Ba\x07sh\t`), 'Bash ');
    assert.equal(rawIdentifier('Ba\x1B[1msh'), 'Bash');
    // Exibido: a redação tira a sequência depois de redigir, sem comer letras do token.
    assert.equal(identifier(`\x1B[ghp_${'A'.repeat(36)}`), '[•••');
  });

  it('vazio, só invisíveis ou não texto: null', () => {
    for (const value of ['', '   ', '\x00\x07', null, undefined, 42, {}]) assert.equal(identifier(value), null, String(value));
    assert.equal(rawIdentifier(42), '');
  });
});

describe('normalizeSlashes', () => {
  it('usa "/", resolve "." e "..", tira a barra do fim menos na raiz', () => {
    assert.equal(normalizeSlashes('C:\\a\\.\\b\\..\\c\\'), 'C:/a/c');
    assert.equal(normalizeSlashes('C:\\'), 'C:/');
    assert.equal(normalizeSlashes('/a/b/'), '/a/b');
    assert.equal(normalizeSlashes('/'), '/');
    assert.equal(normalizeSlashes('a\\b'), 'a/b');
  });
});

describe('firstLine e textLine', () => {
  it('firstLine: primeira linha não vazia, sem espaços nas pontas', () => {
    assert.equal(firstLine('  \n\r\n  primeira  \nsegunda'), 'primeira');
    assert.equal(firstLine(`a${String.fromCharCode(0x2028)}b`), 'a');
    assert.equal(firstLine('\n \n'), null);
    assert.equal(firstLine(3), null);
  });

  it(`só os primeiros ${SCAN_CHARS} caracteres são lidos; o segredo no começo continua redigido`, () => {
    assert.equal(textLine(`rodar token=${'a'.repeat(SCAN_CHARS * 2)}`, 80), 'rodar');
    assert.equal(textLine(`token=${'a'.repeat(100)} e mais ${'b'.repeat(SCAN_CHARS * 2)}`, 80), 'token=••• e mais');
    assert.equal(textLine(`${'\n'.repeat(SCAN_CHARS)}depois do limite`, 80), null);
  });

  it('sem espaço em branco no trecho lido, a última palavra sai depois da redação (pode ser um token partido)', () => {
    assert.equal(textLine(`token=${'a'.repeat(SCAN_CHARS * 2)}`, 80), null);
    assert.equal(textLine(`${'x'.repeat(SCAN_CHARS * 3)}`, 10), null);
    // Invisíveis antes da borda: a etapa 1 os remove antes de achar a borda (B4),
    // então o token chega inteiro à redação.
    const token = `ghp_${'A'.repeat(36)}`;
    for (const code of [0x200b, 0xad, 0x2060, 0xfe0f]) {
      assert.equal(textLine(`${String.fromCodePoint(code).repeat(SCAN_CHARS - 10)}${token}`, 80), '•••', code.toString(16));
    }
    // Espaço em branco que a redação remove (U+FEFF, \v, \f) não serve de borda.
    for (const gap of [0xfeff, 0x0b, 0x0c]) {
      const text = `${'\n'.repeat(SCAN_CHARS - 100)}ghp_${'A'.repeat(10)}${String.fromCharCode(gap)}${'A'.repeat(200)}`;
      assert.doesNotMatch(String(textLine(text, 80)), /ghp_/, gap.toString(16));
      const marked = `ghp_${'A'.repeat(12)}${String.fromCharCode(gap)}…[cortado 99 caracteres]… fim`;
      assert.equal(textLine(marked, 80), '… fim', gap.toString(16));
    }
    // Token longo que a redação encolhe para ••• antes da borda, seguido de outro token partido.
    assert.equal(textLine(`ghp_${'X'.repeat(SCAN_CHARS - 20)};AKIA${'B'.repeat(16)}`, 80), null);
    // Quando a redação abre espaço (Bearer), o que vem antes da última palavra continua.
    assert.equal(textLine(`Bearer\t${'t'.repeat(SCAN_CHARS * 2)}`, 80), 'Bearer');
  });

  it(`token sobre a borda dos ${SCAN_CHARS} não é partido (o trecho termina no último espaço em branco)`, () => {
    const token = `ghp_${'a'.repeat(36)}`;
    for (const gap of ['\n', ' ', '\t']) {
      // O token começa 10 caracteres antes da borda: partido, sobrariam "ghp_aaaaaa", abaixo do tamanho mínimo.
      const text = `${gap.repeat(SCAN_CHARS - 10)}${token} depois`;
      assert.equal(scanWindow(text), gap.repeat(SCAN_CHARS - 11), JSON.stringify(gap));
      const line = textLine(text, 80);
      assert.equal(line, null, JSON.stringify(gap));
    }
    const prompt = `${'\n'.repeat(SCAN_CHARS - 10)}${token}`;
    assert.equal(textLine(prompt, 80), null);
    assert.doesNotMatch(String(textLine(`a${' '.repeat(SCAN_CHARS - 12)}${token}`, 80)), /ghp_/);
  });

  it('espaço dentro de uma sequência ANSI completa (que a etapa 7 remove) não serve de fronteira', () => {
    // CSI com intermediário espaço: `ESC[ q` sai inteira, e o token se junta de novo.
    const csi = `${'\n'.repeat(SCAN_CHARS - 20)}ghp_AAA\x1B[ q${'A'.repeat(33)} fim ${'x'.repeat(100)}`;
    assert.equal(redact(csi.slice(SCAN_CHARS - 20)).startsWith('•••'), true, 'o texto inteiro é redigido');
    assert.doesNotMatch(String(textLine(csi, 80)), /ghp_|AAA/);
    // OSC com espaço no texto, terminada por ST.
    const osc = `${'\n'.repeat(SCAN_CHARS - 20)}ghp_AAA\x1B]0;a b\x1B\\${'A'.repeat(33)} fim ${'x'.repeat(100)}`;
    assert.doesNotMatch(String(textLine(osc, 80)), /ghp_|AAA/);
    // O mesmo encostado no marcador de corte.
    assert.equal(textLine(`ghp_AAA\x1B[ q…[cortado 99 caracteres]… fim`, 80), '… fim');
    // Espaço fora de sequência continua sendo fronteira.
    const check = boundaryChecker('a b\x1B[1 qc d');
    assert.deepEqual([1, 6, 9].map(check), [true, false, true]);
  });

  it('texto enorme: só o começo é limpo, e uma OSC aberta até o fim dele não serve de fronteira', () => {
    // A OSC começa dentro do trecho e só termina depois do começo limpo (40 mil caracteres).
    const text = `${'\n'.repeat(SCAN_CHARS - 20)}ghp_AAA\x1B]0;${'a '.repeat(20_000)}\x1B\\${'A'.repeat(33)} fim`;
    assert.doesNotMatch(String(textLine(text, 80)), /ghp_|AAA/);
    assert.equal(boundaryChecker('x \x1B]0;a b', true)(7), false, 'OSC aberta até o fim: o espaço dentro dela não conta');
    assert.equal(boundaryChecker('x \x1B]0;a b', false)(7), true);
    assert.equal(boundaryChecker('x \x1B]0;a b', true)(1), true, 'espaço antes da OSC continua sendo fronteira');
    // Muitos invisíveis no começo: o começo limpo fica curto e o texto inteiro é limpo.
    const zw = String.fromCharCode(0x200b);
    assert.equal(textLine(`${zw.repeat(40_000)}ghp_${'A'.repeat(36)} depois`, 80), '••• depois');
    // Texto enorme comum: o começo aparece, e o resto não custa uma limpeza inteira.
    assert.equal(textLine(`npm test ${'x '.repeat(500_000)}`, 20), 'npm test x x x x x …');
  });

  it('redactWindow: redige só a janela de leitura, mantém as linhas e tira a palavra partida', () => {
    assert.equal(redactWindow('linha 1 token=abc\nlinha 2'), 'linha 1 token=•••\nlinha 2');
    assert.equal(redactWindow(`ab ${'x'.repeat(SCAN_CHARS * 2)}`), 'ab');
    assert.equal(redactWindow(42), '');
    const text = (n) => `echo ${'a '.repeat(n)}`;
    const huge = text(500_000);
    assert.ok(redactWindow(huge).length <= SCAN_CHARS);
    // Só a janela é redigida: o custo não cresce com o texto (razão contra 1/16 do tamanho, ADR 0010).
    const growth = growthWithin(redactWindow, text(31_250), huge, { maxRatio: 8 });
    assert.ok(growth.ok, growth.text);
  });

  it('scanWindow: texto curto inteiro; espaço logo depois da borda mantém o trecho todo; sem espaço, o trecho todo', () => {
    assert.equal(scanWindow('curto'), 'curto');
    assert.equal(scanWindow('x'.repeat(SCAN_CHARS)), 'x'.repeat(SCAN_CHARS));
    assert.equal(scanWindow(`${'x'.repeat(SCAN_CHARS)} resto`), 'x'.repeat(SCAN_CHARS));
    assert.equal(scanWindow(`${'x'.repeat(SCAN_CHARS + 5)}`), 'x'.repeat(SCAN_CHARS));
    assert.equal(scanWindow(`ab cd${'x'.repeat(SCAN_CHARS)}`), 'ab');
  });

  it('textLine: redigido, cortado, ponto fixo; vazio ou não texto vira null', () => {
    assert.equal(textLine('token=abc', 80), 'token=•••');
    assert.equal(textLine('', 80), null);
    assert.equal(textLine('   ', 80), null);
    assert.equal(textLine(null, 80), null);
    const cut = textLine(`--password ${'x'.repeat(200)}`, 20);
    assert.equal(redact(cut), cut);
    assert.ok(charLength(cut) <= 20);
  });
});

describe('inputHash', () => {
  it('16 caracteres hexadecimais; igual com as chaves em outra ordem, em qualquer profundidade', () => {
    const a = inputHash({ command: 'npm test', description: 'x', nested: { b: 1, a: [1, { d: 2, c: 3 }] } });
    const b = inputHash({ nested: { a: [1, { c: 3, d: 2 }], b: 1 }, description: 'x', command: 'npm test' });
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, b);
  });

  it('muda quando um valor muda ou a ordem de uma lista muda', () => {
    const base = inputHash({ command: 'npm test', list: [1, 2] });
    assert.notEqual(inputHash({ command: 'npm test ', list: [1, 2] }), base);
    assert.notEqual(inputHash({ command: 'npm test', list: [2, 1] }), base);
  });

  it('sem tool_input: null; outros tipos têm hash', () => {
    assert.equal(inputHash(undefined), null);
    for (const value of [null, 'x', 1, [], {}]) assert.match(inputHash(value), /^[0-9a-f]{16}$/);
  });

  it('stableStringify ignora chaves com undefined, como o JSON', () => {
    assert.equal(stableStringify({ b: 1, a: undefined, c: [undefined] }), '{"b":1,"c":[null]}');
  });
});
