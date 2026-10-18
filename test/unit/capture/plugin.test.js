// Arquivos do plugin de captura (T4): marketplace, plugin.json e hooks.json.
// A lista de eventos é a do ADR 0001, escrita aqui de novo de propósito (oráculo
// independente do código do deploy).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORWARDER_VERSION } from '../../../capture/plugins/agent-quest/scripts/forward.mjs';

const CAPTURE = fileURLToPath(new URL('../../../capture/', import.meta.url));
const PLUGIN = path.join(CAPTURE, 'plugins', 'agent-quest');
const readJson = (...parts) => JSON.parse(readFileSync(path.join(...parts), 'utf8'));

const ADR_0001_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
];

describe('estrutura de capture/', () => {
  it('só os arquivos do marketplace e do plugin', () => {
    const files = readdirSync(CAPTURE, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(CAPTURE, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(files, [
      '.claude-plugin/marketplace.json',
      'plugins/agent-quest/.claude-plugin/plugin.json',
      'plugins/agent-quest/hooks/hooks.json',
      'plugins/agent-quest/scripts/forward.mjs',
    ]);
  });
});

describe('marketplace.json', () => {
  const marketplace = readJson(CAPTURE, '.claude-plugin', 'marketplace.json');

  it('marketplace agent-quest-local, com dono', () => {
    assert.equal(marketplace.name, 'agent-quest-local');
    assert.equal(typeof marketplace.owner?.name, 'string');
  });

  it('um único plugin, agent-quest, com caminho relativo', () => {
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'agent-quest');
    assert.equal(marketplace.plugins[0].source, './plugins/agent-quest');
  });
});

describe('plugin.json', () => {
  const plugin = readJson(PLUGIN, '.claude-plugin', 'plugin.json');
  const marketplace = readJson(CAPTURE, '.claude-plugin', 'marketplace.json');

  it('plugin agent-quest', () => {
    assert.equal(plugin.name, 'agent-quest');
  });

  it('mesma versão no plugin.json, no marketplace e no encaminhador (ADR 0002, versão da captura)', () => {
    assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
    assert.equal(plugin.version, FORWARDER_VERSION);
    assert.equal(marketplace.plugins[0].version, plugin.version);
  });
});

describe('hooks.json', () => {
  const { hooks } = readJson(PLUGIN, 'hooks', 'hooks.json');

  it('exatamente os 15 eventos do ADR 0001', () => {
    assert.deepEqual(Object.keys(hooks).sort(), [...ADR_0001_EVENTS].sort());
    assert.equal(Object.keys(hooks).length, 15);
  });

  it('cada evento: um grupo sem matcher, com um hook command em forma exec, async, chamando o forward.mjs', () => {
    for (const [event, groups] of Object.entries(hooks)) {
      assert.equal(groups.length, 1, event);
      assert.equal('matcher' in groups[0], false, `${event}: sem matcher`);
      assert.deepEqual(Object.keys(groups[0]), ['hooks'], event);
      assert.deepEqual(
        groups[0].hooks,
        [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/forward.mjs'], async: true }],
        event,
      );
    }
  });
});
