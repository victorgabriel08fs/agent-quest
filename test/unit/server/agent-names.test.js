// Leitura dos nomes de `.claude/agents/` para a equipe (roster), fora do
// domínio e fora do `apply` (modelo de eventos, seção 7; T7, ponto 10, e
// ajuste de 19/10/2026: uma listagem por vez, com `onLate`). Usa pastas
// temporárias, nunca a pasta pessoal real, e temporizadores falsos nos prazos
// (ADR 0010, complemento "testes de tempo estáveis").

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_AGENT_FILES,
  READ_TIMEOUT_MS,
  agentNamesFrom,
  createAgentNamesReader,
  listAgentFiles,
} from '../../../server/agent-names.js';

/** Pasta temporária com `projeto/.claude/agents/` e `casa/.claude/agents/`. */
async function withFixture(run) {
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
    await run({ root, project, home, projectAgents, homeAgents });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Temporizadores falsos: o prazo só vence quando o teste manda. */
function fakeTimers() {
  const pending = new Set();
  return {
    timers: {
      setTimeout(run) {
        const handle = { run };
        pending.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        pending.delete(handle);
      },
    },
    /** Vence todos os prazos pendentes. */
    expire() {
      for (const handle of [...pending]) {
        pending.delete(handle);
        handle.run();
      }
    },
    pending: () => pending.size,
  };
}

/**
 * Listagem controlada pelo teste: cada chamada fica presa até `finish(folder, entries)`.
 * Conta quantas estão em andamento ao mesmo tempo.
 */
function heldList() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  return {
    calls,
    maxActive: () => maxActive,
    active: () => active,
    list(folder) {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        calls.push({
          folder,
          finish(entries) {
            active--;
            resolve(entries);
          },
        });
      });
    },
    /** Termina a listagem da pasta (pelo trecho do caminho). */
    finish(fragment, entries) {
      const call = calls.find((item) => item.folder.includes(fragment));
      assert.ok(call, `nenhuma listagem de ${fragment}`);
      call.finish(entries);
    },
  };
}

/** Deixa as promessas e os `then` pendentes rodarem. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const abs = (name) => path.resolve(`/${name}`);
const folderOf = (base) => path.join(base, '.claude', 'agents');

describe('nomes de .claude/agents/ (leitor assíncrono)', () => {
  it('lê só os nomes dos arquivos .md do projeto e da pasta pessoal', async () => {
    await withFixture(async ({ project, home }) => {
      const names = await createAgentNamesReader({ homeDir: home }).read(project);
      assert.deepEqual(names.sort(), ['Revisor', 'arquiteto', 'tester']);
    });
  });

  it('pasta inexistente, caminho de rede (UNC), relativo ou vazio vira lista vazia, sem rejeitar', async () => {
    await withFixture(async ({ root }) => {
      assert.deepEqual(await createAgentNamesReader({ homeDir: null }).read(path.join(root, 'nao-existe')), []);
    });
    const listed = [];
    const reader = createAgentNamesReader({ homeDir: null, list: (folder) => listed.push(folder) && ['tester.md'] });
    for (const dir of ['\\\\servidor\\compartilhado', '//servidor/compartilhado', 'relativo/projeto', '', '   ', /** @type {any} */ (42)]) {
      assert.deepEqual(await reader.read(dir), [], JSON.stringify(dir));
    }
    assert.deepEqual(listed, [], 'nada foi listado');
  });

  it(`filtra os .md antes do limite de ${MAX_AGENT_FILES} nomes`, async () => {
    const entries = [...Array.from({ length: 300 }, (_, i) => `nota-${i}.txt`), 'tester.md', 'arquiteto.md'];
    assert.deepEqual(agentNamesFrom(entries), ['tester', 'arquiteto']);
    const many = Array.from({ length: MAX_AGENT_FILES + 20 }, (_, i) => `agente-${i}.md`);
    assert.equal(agentNamesFrom(many).length, MAX_AGENT_FILES);
    assert.deepEqual(agentNamesFrom(['.md', 'x.md', 42, null, 'y.MD']), ['x', 'y']);
    assert.deepEqual(agentNamesFrom('tester.md'), []);
    const reader = createAgentNamesReader({ homeDir: null, list: async () => entries });
    assert.deepEqual(await reader.read(abs('projeto')), ['tester', 'arquiteto']);
  });

  it('a listagem padrão devolve só arquivos', async () => {
    await withFixture(async ({ projectAgents, homeAgents }) => {
      assert.deepEqual((await listAgentFiles(projectAgents)).sort(), ['Revisor.MD', 'leia-me.txt', 'tester.md']);
      assert.deepEqual(await listAgentFiles(homeAgents), ['arquiteto.md']);
    });
  });

  it('erro na listagem (exceção, promessa rejeitada, valor que não é lista) vira lista vazia', async () => {
    for (const list of [() => { throw new Error('EACCES'); }, () => Promise.reject(new Error('EIO')), () => 'tester.md']) {
      const reader = createAgentNamesReader({ homeDir: null, list });
      assert.deepEqual(await reader.read(abs('projeto')), []);
    }
  });

  it('cache por pasta: cada pasta é listada uma vez, mesmo com leituras simultâneas', async () => {
    await withFixture(async ({ root, project, home, projectAgents }) => {
      const listed = [];
      const reader = createAgentNamesReader({
        homeDir: home,
        list: (folder) => {
          listed.push(folder);
          return listAgentFiles(folder);
        },
      });
      const [first, again] = await Promise.all([reader.read(project), reader.read(project)]);
      assert.deepEqual(again, first);
      writeFileSync(path.join(projectAgents, 'documentador.md'), '');
      assert.deepEqual((await reader.read(project)).sort(), first.sort(), 'arquivo novo só depois de reiniciar');
      assert.equal(listed.length, 2, 'projeto e pasta pessoal, uma vez cada');
      await reader.read(path.join(root, 'outro'));
      assert.equal(listed.length, 3, 'outro projeto lista só a pasta dele');
      assert.ok((await createAgentNamesReader({ homeDir: home }).read(project)).includes('documentador'), 'leitor novo vê o arquivo');
    });
  });
});

describe('uma listagem por vez, prazo por leitura e onLate (ajuste de 19/10/2026)', () => {
  it(`quatro pastas com a listagem presa ocupam no máximo uma listagem; cada read resolve [] no prazo (${READ_TIMEOUT_MS} ms por padrão)`, async () => {
    const clock = fakeTimers();
    const held = heldList();
    const reader = createAgentNamesReader({ homeDir: null, timers: clock.timers, list: held.list });
    const reads = ['p1', 'p2', 'p3', 'p4'].map((name) => reader.read(abs(name)));
    await settle();
    assert.equal(held.calls.length, 1, 'só a primeira pasta começou a ser listada');
    assert.equal(held.maxActive(), 1);
    assert.equal(held.calls[0].folder, folderOf(abs('p1')), 'a fila segue a ordem de chegada');
    clock.expire();
    assert.deepEqual(await Promise.all(reads), [[], [], [], []]);
    // As presas vão saindo uma de cada vez, na ordem.
    for (const [i, name] of ['p1', 'p2', 'p3', 'p4'].entries()) {
      held.finish(name, []);
      await settle();
      assert.equal(held.calls.length, Math.min(i + 2, 4));
      assert.equal(held.maxActive(), 1);
    }
  });

  it('listagem que termina depois do prazo atualiza o cache e chama onLate com os nomes completos do projeto', async () => {
    const clock = fakeTimers();
    const held = heldList();
    const late = [];
    const reader = createAgentNamesReader({
      homeDir: abs('casa'),
      timers: clock.timers,
      list: held.list,
      onLate: (projectDir, names) => late.push({ projectDir, names }),
    });
    const project = abs('projeto');
    const reading = reader.read(project);
    await settle();
    clock.expire();
    assert.deepEqual(await reading, [], 'no prazo, nada');
    held.finish('projeto', ['tester.md']);
    await settle();
    assert.deepEqual(late, [], 'a pasta pessoal ainda não terminou: nada parcial');
    held.finish('casa', ['arquiteto.md']);
    await settle();
    assert.deepEqual(late, [{ projectDir: project, names: ['tester', 'arquiteto'] }], 'uma chamada, completa');
    // O cache tem os dois: o próximo read responde na hora, sem listar de novo.
    assert.deepEqual(await reader.read(project), ['tester', 'arquiteto']);
    assert.equal(held.calls.length, 2);
  });

  it('a pasta pessoal atrasada chama onLate para cada projeto que perdeu o prazo dela', async () => {
    const clock = fakeTimers();
    const held = heldList();
    const late = [];
    const reader = createAgentNamesReader({
      homeDir: abs('casa'),
      timers: clock.timers,
      list: (folder) => (folder.includes('casa') ? held.list(folder) : Promise.resolve([`${path.basename(path.dirname(path.dirname(folder)))}.md`])),
      onLate: (projectDir, names) => late.push({ projectDir, names }),
    });
    // A pasta pessoal entra na fila logo depois da primeira pasta de projeto.
    const reads = [reader.read(abs('p1')), reader.read(abs('p2'))];
    await settle();
    clock.expire();
    await Promise.all(reads);
    held.finish('casa', ['arquiteto.md']);
    await settle();
    await settle();
    assert.deepEqual(
      late.map((item) => [item.projectDir, item.names]).sort(),
      [[abs('p1'), ['p1', 'arquiteto']], [abs('p2'), ['p2', 'arquiteto']]].sort(),
    );
  });

  it('dentro do prazo, onLate não é chamado; e um erro em onLate não para a fila', async () => {
    const calls = [];
    const reader = createAgentNamesReader({
      homeDir: null,
      list: async () => ['tester.md'],
      onLate: () => {
        calls.push('chamado');
        throw new Error('quem recebe falhou');
      },
    });
    assert.deepEqual(await reader.read(abs('projeto')), ['tester']);
    assert.deepEqual(calls, []);

    const clock = fakeTimers();
    const held = heldList();
    const failing = createAgentNamesReader({ homeDir: null, timers: clock.timers, list: held.list, onLate: () => { throw new Error('falhou'); } });
    const first = failing.read(abs('a'));
    const second = failing.read(abs('b'));
    await settle();
    clock.expire();
    await Promise.all([first, second]);
    held.finish('a', ['x.md']);
    await settle();
    assert.equal(held.calls.length, 2, 'a fila seguiu depois do erro em onLate');
    held.finish('b', []);
  });
});
