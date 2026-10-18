import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/probe/plugin');
const readJson = (relative) => JSON.parse(readFileSync(path.join(PLUGIN, relative), 'utf8'));

// Os 15 eventos do ADR 0001, mais os três só para registro (T0).
const EXPECTED_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop',
  'StopFailure', 'PreCompact', 'PostCompact',
  'TaskCreated', 'TaskCompleted', 'PostToolBatch',
];

describe('plugin agent-quest-probe', () => {
  it('manifesto tem o nome agent-quest-probe', () => {
    const manifest = readJson('.claude-plugin/plugin.json');
    assert.equal(manifest.name, 'agent-quest-probe');
    assert.equal(typeof manifest.version, 'string');
    assert.equal(manifest.hooks, undefined, 'hooks/hooks.json é carregado pelo caminho padrão');
  });

  it('hooks.json registra exatamente os 18 eventos da sonda', () => {
    const { hooks } = readJson('hooks/hooks.json');
    assert.deepEqual(Object.keys(hooks).sort(), [...EXPECTED_EVENTS].sort());
  });

  it('todo hook é command em forma exec, async, sem matcher e chama o dump.mjs', () => {
    const { hooks } = readJson('hooks/hooks.json');
    for (const [event, groups] of Object.entries(hooks)) {
      assert.equal(groups.length, 1, event);
      assert.equal(groups[0].matcher, undefined, `${event} sem matcher`);
      assert.deepEqual(groups[0].hooks, [{
        type: 'command',
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/scripts/dump.mjs'],
        async: true,
      }], event);
    }
  });

  it('probe-worker é um subagente com Read, Bash e Agent', () => {
    const text = readFileSync(path.join(PLUGIN, 'agents/probe-worker.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
    const fields = Object.fromEntries(frontmatter.split('\n').map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }));
    assert.equal(fields.name, 'probe-worker');
    assert.ok(fields.description);
    assert.deepEqual(fields.tools.split(',').map((t) => t.trim()), ['Read', 'Bash', 'Agent']);
  });

  it('dump.mjs só importa módulos do Node (roda fora do repositório)', () => {
    const source = readFileSync(path.join(PLUGIN, 'scripts/dump.mjs'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    for (const specifier of imports) assert.match(specifier, /^node:/);
    assert.doesNotMatch(source, /console\.|process\.(stdout|stderr)/, 'o dump nunca escreve na saída');
  });
});
