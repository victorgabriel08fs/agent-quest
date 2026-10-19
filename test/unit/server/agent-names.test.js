// Leitura dos nomes de `.claude/agents/` para a equipe (roster), fora do
// domínio (modelo de eventos, seção 7; T7, ponto 10). Usa pastas temporárias:
// nunca a pasta pessoal real.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_AGENT_FILES,
  createAgentNamesReader,
  listAgentFiles,
  readAgentNamesFromDisk,
} from '../../../server/agent-names.js';

/** Pasta temporária com `projeto/.claude/agents/` e `casa/.claude/agents/`. */
function fixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aq-agents-'));
  const project = path.join(root, 'projeto');
  const home = path.join(root, 'casa');
  const projectAgents = path.join(project, '.claude', 'agents');
  const homeAgents = path.join(home, '.claude', 'agents');
  mkdirSync(projectAgents, { recursive: true });
  mkdirSync(path.join(homeAgents, 'pasta.md'), { recursive: true });
  writeFileSync(path.join(projectAgents, 'tester.md'), 'CONTEUDO-QUE-NAO-E-LIDO');
  writeFileSync(path.join(projectAgents, 'Revisor.MD'), '');
  writeFileSync(path.join(projectAgents, 'leia-me.txt'), '');
  writeFileSync(path.join(homeAgents, 'arquiteto.md'), '');
  try {
    run({ root, project, home, projectAgents, homeAgents });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('nomes de .claude/agents/', () => {
  it('lê só os nomes dos arquivos .md do projeto e da pasta pessoal', () => {
    fixture(({ project, home }) => {
      assert.deepEqual(readAgentNamesFromDisk(project, { homeDir: home }).sort(), ['Revisor', 'arquiteto', 'tester']);
    });
  });

  it('pasta inexistente, caminho de rede (UNC), relativo ou vazio vira lista vazia, sem lançar', () => {
    fixture(({ root }) => {
      assert.deepEqual(readAgentNamesFromDisk(path.join(root, 'nao-existe'), { homeDir: null }), []);
    });
    for (const dir of ['\\\\servidor\\compartilhado', '//servidor/compartilhado', 'relativo/projeto', '', '   ', /** @type {any} */ (42)]) {
      assert.deepEqual(readAgentNamesFromDisk(dir, { homeDir: null }), [], JSON.stringify(dir));
    }
  });

  it(`no máximo ${MAX_AGENT_FILES} entradas por pasta`, () => {
    fixture(({ projectAgents }) => {
      for (let i = 0; i < MAX_AGENT_FILES + 20; i++) writeFileSync(path.join(projectAgents, `agente-${i}.md`), '');
      assert.ok(listAgentFiles(projectAgents).length <= MAX_AGENT_FILES);
    });
  });

  it('cache por pasta: cada pasta é listada uma vez, e um arquivo novo só aparece depois de reiniciar', () => {
    fixture(({ root, project, home, projectAgents }) => {
      const listed = [];
      const reader = createAgentNamesReader({
        homeDir: home,
        list: (folder) => {
          listed.push(folder);
          return listAgentFiles(folder);
        },
      });
      const first = reader(project).sort();
      writeFileSync(path.join(projectAgents, 'documentador.md'), '');
      assert.deepEqual(reader(project).sort(), first);
      assert.equal(listed.length, 2, 'projeto e pasta pessoal, uma vez cada');
      // Outro projeto lista só a pasta dele; a pessoal já está no cache.
      const other = path.join(root, 'outro');
      reader(other);
      assert.equal(listed.length, 3);
      assert.ok(createAgentNamesReader({ homeDir: home })(project).includes('documentador'), 'leitor novo vê o arquivo');
    });
  });

  it('uma listagem que lança vira lista vazia', () => {
    const reader = createAgentNamesReader({ homeDir: null, list: () => { throw new Error('sem acesso'); } });
    assert.deepEqual(reader(path.resolve('/projeto')), []);
  });
});
