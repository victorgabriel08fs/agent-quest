import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_PORT,
  HOST,
  StartupError,
  VERSION,
  isInsideOneDrive,
  parseCliArgs,
  parsePort,
  portCommand,
  readConfigFile,
  resolveConfig,
  resolveDataDir,
} from '../../../server/config.js';
import { REPO, tempDir } from './helpers.js';

describe('constantes', () => {
  it('escuta só em 127.0.0.1, porta padrão 47821', () => {
    assert.equal(HOST, '127.0.0.1');
    assert.equal(DEFAULT_PORT, 47821);
  });

  it('VERSION vem do package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });
});

describe('resolveDataDir', () => {
  const win = { platform: 'win32', homedir: 'C:\\Users\\alguem' };
  const linux = { platform: 'linux', homedir: '/home/alguem' };

  it('Windows: %LOCALAPPDATA%\\agent-quest', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\alguem\\AppData\\Local' };
    assert.equal(resolveDataDir({ ...win, env }), 'C:\\Users\\alguem\\AppData\\Local\\agent-quest');
  });

  it('Windows sem LOCALAPPDATA: <home>\\AppData\\Local\\agent-quest', () => {
    assert.equal(resolveDataDir({ ...win, env: {} }), 'C:\\Users\\alguem\\AppData\\Local\\agent-quest');
  });

  it('outros sistemas: $XDG_STATE_HOME/agent-quest ou ~/.local/state/agent-quest', () => {
    assert.equal(resolveDataDir({ ...linux, env: { XDG_STATE_HOME: '/var/estado' } }), '/var/estado/agent-quest');
    assert.equal(resolveDataDir({ ...linux, env: {} }), '/home/alguem/.local/state/agent-quest');
  });

  it('AGENT_QUEST_HOME sobrescreve em qualquer sistema', () => {
    const env = { AGENT_QUEST_HOME: 'D:\\dados\\aq', LOCALAPPDATA: 'C:\\x', XDG_STATE_HOME: '/y' };
    assert.equal(resolveDataDir({ ...win, env }), 'D:\\dados\\aq');
    assert.equal(resolveDataDir({ ...linux, env }), 'D:\\dados\\aq');
  });

  it('AGENT_QUEST_HOME vazio é ignorado', () => {
    const env = { AGENT_QUEST_HOME: '', LOCALAPPDATA: 'C:\\Local' };
    assert.equal(resolveDataDir({ ...win, env }), 'C:\\Local\\agent-quest');
  });
});

describe('isInsideOneDrive', () => {
  const win = { platform: 'win32' };

  it('detecta pela variável OneDrive, sem diferenciar maiúsculas no Windows', () => {
    const env = { OneDrive: 'C:\\Users\\alguem\\Nuvem' };
    assert.equal(isInsideOneDrive('c:\\users\\ALGUEM\\nuvem\\dados', { ...win, env }), true);
    assert.equal(isInsideOneDrive('C:\\Users\\alguem\\Nuvem', { ...win, env }), true);
    assert.equal(isInsideOneDrive('C:\\Users\\alguem\\NuvemOutra\\dados', { ...win, env }), false);
  });

  it('detecta pelas variáveis OneDriveConsumer e OneDriveCommercial', () => {
    assert.equal(isInsideOneDrive('E:\\Pessoal\\x', { ...win, env: { OneDriveConsumer: 'E:\\Pessoal' } }), true);
    assert.equal(isInsideOneDrive('F:\\Empresa\\x', { ...win, env: { OneDriveCommercial: 'F:\\Empresa' } }), true);
  });

  it('detecta por uma pasta "OneDrive" ou "OneDrive - Organização" no caminho', () => {
    assert.equal(isInsideOneDrive('C:\\Users\\alguem\\OneDrive\\Documentos', { ...win, env: {} }), true);
    assert.equal(isInsideOneDrive('C:\\Users\\alguem\\OneDrive - Empresa X\\dados', { ...win, env: {} }), true);
    assert.equal(isInsideOneDrive('/home/alguem/OneDrive/dados', { platform: 'linux', env: {} }), true);
  });

  it('não acusa caminhos comuns', () => {
    assert.equal(isInsideOneDrive('C:\\Users\\alguem\\AppData\\Local\\agent-quest', { ...win, env: {} }), false);
    assert.equal(isInsideOneDrive('C:\\Users\\alguem\\OneDriveBackup\\x', { ...win, env: {} }), false);
    assert.equal(isInsideOneDrive('/home/alguem/.local/state/agent-quest', { platform: 'linux', env: {} }), false);
  });
});

describe('parseCliArgs', () => {
  it('aceita --port <n> e --port=<n>', () => {
    assert.deepEqual(parseCliArgs(['--port', '5000']), { port: '5000' });
    assert.deepEqual(parseCliArgs(['--port=5001']), { port: '5001' });
    assert.deepEqual(parseCliArgs([]), {});
  });

  it('aceita --debug-dump, sozinho ou com --port', () => {
    assert.deepEqual(parseCliArgs(['--debug-dump']), { debugDump: true });
    assert.deepEqual(parseCliArgs(['--port', '5000', '--debug-dump']), { port: '5000', debugDump: true });
  });

  it('recusa opção desconhecida, --port sem valor, argumento solto e --debug-dump com valor', () => {
    for (const argv of [['--porta', '1'], ['--port'], ['5000'], ['--debug-dump=sim'], ['--debug']]) {
      assert.throws(() => parseCliArgs(argv), StartupError, argv.join(' '));
    }
  });
});

describe('parsePort', () => {
  it('aceita 0 e de 1024 a 65535, em número ou texto', () => {
    assert.equal(parsePort('0', 'x'), 0);
    assert.equal(parsePort('1024', 'x'), 1024);
    assert.equal(parsePort(65535, 'x'), 65535);
    assert.equal(parsePort(' 47822 ', 'x'), 47822);
  });

  it('recusa o resto com mensagem que cita a fonte', () => {
    for (const value of ['80', '1023', '65536', 'abc', '-1', '4000.5', 4000.5, '', null, true, '0x1F90']) {
      assert.throws(() => parsePort(value, '--port'), (err) => err instanceof StartupError && /--port/.test(err.message), String(value));
    }
  });
});

describe('readConfigFile', () => {
  const tmp = tempDir();
  after(tmp.cleanup);

  it('arquivo ausente vale {} sem aviso', () => {
    assert.deepEqual(readConfigFile(path.join(tmp.dir, 'nao-existe')), { config: {}, warning: null });
  });

  it('JSON inválido ou que não seja objeto é ignorado com aviso', () => {
    for (const content of ['{ port: 1 }', '[1, 2]', '42', 'null']) {
      writeFileSync(path.join(tmp.dir, 'config.json'), content);
      const { config, warning } = readConfigFile(tmp.dir);
      assert.deepEqual(config, {});
      assert.match(warning, /config\.json/);
    }
  });

  it('aceita BOM do Bloco de Notas', () => {
    writeFileSync(path.join(tmp.dir, 'config.json'), '\uFEFF{ "port": 47900 }');
    assert.deepEqual(readConfigFile(tmp.dir), { config: { port: 47900 }, warning: null });
  });
});

describe('resolveConfig', () => {
  const tmp = tempDir();
  after(tmp.cleanup);
  const base = { platform: process.platform, homedir: tmp.dir };
  const env = (extra = {}) => ({ AGENT_QUEST_HOME: tmp.dir, ...extra });
  const writeConfig = (data) => writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify(data));

  it('porta: --port, depois AGENT_QUEST_PORT, depois config.json, depois 47821', () => {
    writeConfig({ port: 47903 });
    assert.deepEqual(
      pick(resolveConfig({ ...base, argv: ['--port', '47901'], env: env({ AGENT_QUEST_PORT: '47902' }) })),
      { port: 47901, portSource: '--port' },
    );
    assert.deepEqual(
      pick(resolveConfig({ ...base, argv: [], env: env({ AGENT_QUEST_PORT: '47902' }) })),
      { port: 47902, portSource: 'AGENT_QUEST_PORT' },
    );
    assert.deepEqual(pick(resolveConfig({ ...base, argv: [], env: env() })), { port: 47903, portSource: 'config.json' });
    writeConfig({});
    assert.deepEqual(pick(resolveConfig({ ...base, argv: [], env: env({ AGENT_QUEST_PORT: '' }) })), {
      port: DEFAULT_PORT,
      portSource: 'padrão',
    });
  });

  it('porta inválida em qualquer fonte é erro claro', () => {
    writeConfig({ port: 'abc' });
    assert.throws(() => resolveConfig({ ...base, argv: [], env: env() }), /config\.json/);
    assert.throws(() => resolveConfig({ ...base, argv: [], env: env({ AGENT_QUEST_PORT: '99999' }) }), /AGENT_QUEST_PORT/);
    assert.throws(() => resolveConfig({ ...base, argv: ['--port', '22'], env: env() }), /--port/);
  });

  it('usa o diretório de dados de AGENT_QUEST_HOME e lê as sobrescritas de papel', () => {
    writeConfig({ roles: { backend: 'dev' } });
    const config = resolveConfig({ ...base, argv: [], env: env() });
    assert.equal(config.dataDir, tmp.dir);
    assert.deepEqual(config.roles, { backend: 'dev' });
    assert.deepEqual(otherWarnings(config), []);
  });

  it('"roles" que não seja objeto é ignorado com aviso', () => {
    writeConfig({ roles: ['dev'] });
    const config = resolveConfig({ ...base, argv: [], env: env() });
    assert.deepEqual(config.roles, {});
    assert.equal(otherWarnings(config).length, 1);
  });

  it('--debug-dump desligado por padrão, sem aviso', () => {
    writeConfig({});
    const config = resolveConfig({ ...base, argv: [], env: env() });
    assert.equal(config.debugDump, false);
    assert.deepEqual(otherWarnings(config), []);
  });

  it('--debug-dump ligado avisa que os arquivos em <dados>/dumps têm dados sensíveis', () => {
    writeConfig({});
    const config = resolveConfig({ ...base, argv: ['--debug-dump'], env: env() });
    assert.equal(config.debugDump, true);
    const [warning, ...rest] = otherWarnings(config);
    assert.deepEqual(rest, []);
    assert.ok(warning.includes(path.join(tmp.dir, 'dumps')), warning);
    assert.match(warning, /dados sensíveis/);
  });

  it('avisa quando o diretório de dados está no OneDrive', () => {
    const config = resolveConfig({
      platform: 'win32',
      homedir: 'C:\\Users\\alguem',
      argv: [],
      env: { AGENT_QUEST_HOME: path.join(tmp.dir, 'OneDrive', 'aq') },
    });
    assert.equal(config.insideOneDrive, true);
    const warning = otherWarnings(config).find((w) => /está dentro do OneDrive/.test(w));
    assert.ok(warning, config.warnings.join('\n'));
    assert.ok(warning.includes(config.dataDir), warning);
    // Coerente com o ADR 0005 (complemento): a variável precisa valer também para o Claude Code.
    assert.match(warning, /variável de ambiente do usuário do Windows/);
    assert.match(warning, /reabra os terminais e o VS Code/);
    assert.match(warning, /Claude Code precisa ver o mesmo valor/);
  });

  it('fora do OneDrive, nenhum aviso de OneDrive', () => {
    writeConfig({});
    const config = resolveConfig({ ...base, argv: [], env: env() });
    assert.equal(config.insideOneDrive, false);
    assert.deepEqual(otherWarnings(config), []);
  });

  it('com AGENT_QUEST_HOME definida, avisa que o Claude Code precisa da mesma variável', () => {
    writeConfig({});
    const config = resolveConfig({ ...base, argv: [], env: env() });
    const warning = config.warnings.find(isHomeWarning);
    assert.ok(warning, config.warnings.join('\n'));
    assert.ok(warning.includes(tmp.dir), warning);
    assert.match(warning, /Claude Code/);
    assert.match(warning, /mesma variável/);
  });

  it('sem AGENT_QUEST_HOME, nenhum aviso sobre ela', () => {
    // LOCALAPPDATA e XDG_STATE_HOME falsos: o diretório de dados real nunca é lido.
    const fakeEnv = { LOCALAPPDATA: path.join(tmp.dir, 'local'), XDG_STATE_HOME: path.join(tmp.dir, 'estado') };
    const config = resolveConfig({ ...base, argv: [], env: fakeEnv });
    assert.ok(config.dataDir.startsWith(tmp.dir), config.dataDir);
    assert.deepEqual(config.warnings, []);
  });
});

describe('portCommand', () => {
  it('sugere o comando do modo em uso, pelo npm_lifecycle_event', () => {
    assert.equal(portCommand({ npm_lifecycle_event: 'dev' }), 'npm run dev -- --port <número>');
    assert.equal(portCommand({ npm_lifecycle_event: 'start' }), 'npm start -- --port <número>');
  });

  it('sem npm (ou com outro script), sugere o node direto', () => {
    assert.equal(portCommand({}), 'node server/main.js --port <número>');
    assert.equal(portCommand({ npm_lifecycle_event: 'test' }), 'node server/main.js --port <número>');
  });
});

/** O aviso de AGENT_QUEST_HOME definida (ADR 0005, complemento). */
function isHomeWarning(warning) {
  return warning.startsWith('Aviso: AGENT_QUEST_HOME está definida');
}

/** Avisos, menos o de AGENT_QUEST_HOME, que aparece em todo teste com diretório temporário. */
function otherWarnings(config) {
  return config.warnings.filter((w) => !isHomeWarning(w));
}

function pick({ port, portSource }) {
  return { port, portSource };
}
