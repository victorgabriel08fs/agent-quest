// Leitura dos nomes de `.claude/agents/` para a equipe (roster), fora do
// domínio e fora do `apply` (modelo de eventos, seção 7; T7, ponto 10, e
// ajustes de 19/10/2026: uma listagem por vez com `onLate`, pasta pessoal
// primeiro e listagens perdidas). Usa pastas temporárias, nunca a pasta
// pessoal real, e um relógio falso nos prazos (ADR 0010, complemento "testes
// de tempo estáveis").

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOST_AFTER_MS,
  MAX_AGENT_FILES,
  MAX_UNFINISHED_LISTINGS,
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

/** Relógio falso: os temporizadores vencem quando o teste avança o tempo. */
function fakeClock() {
  let now = 0;
  const pending = new Set();
  return {
    timers: {
      setTimeout(run, ms) {
        const handle = { run, at: now + ms };
        pending.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        pending.delete(handle);
      },
    },
    /** Avança `ms` e roda, em ordem, o que venceu. */
    advance(ms) {
      now += ms;
      for (const handle of [...pending].sort((a, b) => a.at - b.at)) {
        if (handle.at <= now && pending.has(handle)) {
          pending.delete(handle);
          handle.run();
        }
      }
    },
  };
}

/**
 * Listagem controlada pelo teste: cada chamada fica presa até `finish`.
 * Conta as listagens não terminadas e o máximo delas ao mesmo tempo.
 */
function heldList() {
  const calls = [];
  let unfinished = 0;
  let maxUnfinished = 0;
  return {
    calls,
    folders: () => calls.map((call) => call.folder),
    unfinished: () => unfinished,
    maxUnfinished: () => maxUnfinished,
    list(folder) {
      unfinished++;
      maxUnfinished = Math.max(maxUnfinished, unfinished);
      return new Promise((resolve) => {
        calls.push({
          folder,
          finish(entries) {
            unfinished--;
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
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

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

describe('uma listagem por vez, prazo por leitura e onLate', () => {
  it(`quatro pastas presas: uma listagem por vez, e cada read resolve [] no prazo (${READ_TIMEOUT_MS} ms por padrão)`, async () => {
    const clock = fakeClock();
    const held = heldList();
    const reader = createAgentNamesReader({ homeDir: null, timers: clock.timers, list: held.list });
    const reads = ['p1', 'p2', 'p3', 'p4'].map((name) => reader.read(abs(name)));
    await settle();
    assert.deepEqual(held.folders(), [folderOf(abs('p1'))], 'só a primeira começou, na ordem de chegada');
    clock.advance(READ_TIMEOUT_MS);
    assert.deepEqual(await Promise.all(reads), [[], [], [], []]);
    // Antes de virar perdida, a presa segura a fila; ao terminar, a próxima começa.
    held.finish('p1', []);
    await settle();
    assert.deepEqual(held.folders().slice(1), [folderOf(abs('p2'))]);
    assert.equal(held.maxUnfinished(), 1);
  });

  it('listagem que termina depois do prazo atualiza o cache e chama onLate uma vez, com os nomes completos', async () => {
    const clock = fakeClock();
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
    clock.advance(READ_TIMEOUT_MS);
    assert.deepEqual(await reading, [], 'no prazo, nada');
    held.finish('casa', ['arquiteto.md']);
    await settle();
    assert.deepEqual(late, [], 'a pasta do projeto ainda não terminou: nada parcial');
    held.finish('projeto', ['tester.md']);
    await settle();
    assert.deepEqual(late, [{ projectDir: project, names: ['tester', 'arquiteto'] }]);
    assert.deepEqual(await reader.read(project), ['tester', 'arquiteto'], 'cache: responde na hora');
    assert.equal(held.calls.length, 2);
  });

  it('um erro em onLate não para a fila; dentro do prazo, onLate não é chamado', async () => {
    const calls = [];
    const quick = createAgentNamesReader({ homeDir: null, list: async () => ['tester.md'], onLate: () => calls.push('chamado') });
    assert.deepEqual(await quick.read(abs('projeto')), ['tester']);
    assert.deepEqual(calls, []);

    const clock = fakeClock();
    const held = heldList();
    const failing = createAgentNamesReader({ homeDir: null, timers: clock.timers, list: held.list, onLate: () => { throw new Error('falhou'); } });
    const reads = [failing.read(abs('a')), failing.read(abs('b'))];
    await settle();
    clock.advance(READ_TIMEOUT_MS);
    await Promise.all(reads);
    held.finish('a', ['x.md']);
    await settle();
    assert.equal(held.calls.length, 2, 'a fila seguiu depois do erro em onLate');
    held.finish('b', []);
  });
});

describe('pasta que nunca responde (seção 7, decidido em 19/10/2026)', () => {
  it('a pasta pessoal é listada logo na criação do leitor, antes de uma pasta de projeto presa', async () => {
    const clock = fakeClock();
    const held = heldList();
    const reader = createAgentNamesReader({ homeDir: abs('casa'), timers: clock.timers, list: held.list });
    await settle();
    assert.deepEqual(held.folders(), [folderOf(abs('casa'))], 'listada antes de qualquer read');
    held.finish('casa', ['arquiteto.md']);
    const reading = reader.read(abs('preso'));
    await settle();
    assert.deepEqual(held.folders().at(-1), folderOf(abs('preso')));
    clock.advance(READ_TIMEOUT_MS);
    assert.deepEqual(await reading, ['arquiteto'], 'a pessoal chega mesmo com a do projeto presa');
  });

  it(`depois de ${LOST_AFTER_MS / 1000} s a listagem é dada como perdida, a pasta fica morta e a próxima da fila é listada`, async () => {
    const clock = fakeClock();
    const held = heldList();
    const reader = createAgentNamesReader({ homeDir: null, timers: clock.timers, list: held.list });
    const reads = [reader.read(abs('p1')), reader.read(abs('p2'))];
    await settle();
    clock.advance(LOST_AFTER_MS - 1);
    await settle();
    assert.deepEqual(held.folders(), [folderOf(abs('p1'))], 'ainda não perdida');
    clock.advance(1);
    await settle();
    assert.deepEqual(held.folders(), [folderOf(abs('p1')), folderOf(abs('p2'))]);
    assert.deepEqual(await Promise.all(reads), [[], []]);
    // Morta: [] na hora, sem nova tentativa.
    assert.deepEqual(await reader.read(abs('p1')), []);
    assert.equal(held.calls.filter((call) => call.folder === folderOf(abs('p1'))).length, 1);
  });

  it(`com duas presas, a terceira não começa e recebe [] no prazo; nunca mais de ${MAX_UNFINISHED_LISTINGS} não terminadas`, async () => {
    const clock = fakeClock();
    const held = heldList();
    const reader = createAgentNamesReader({ homeDir: null, timers: clock.timers, list: held.list });
    reader.read(abs('p1'));
    reader.read(abs('p2'));
    const third = reader.read(abs('p3'));
    await settle();
    clock.advance(LOST_AFTER_MS);
    await settle();
    clock.advance(LOST_AFTER_MS);
    await settle();
    assert.equal(held.calls.length, 2, 'as duas presas viraram perdidas; a terceira não começou');
    assert.deepEqual(await third, [], 'recebeu [] no prazo normal');
    const fourth = reader.read(abs('p4'));
    clock.advance(READ_TIMEOUT_MS);
    assert.deepEqual(await fourth, []);
    assert.equal(held.calls.length, 2);
    assert.equal(held.maxUnfinished(), MAX_UNFINISHED_LISTINGS);
    // Uma perdida termina: abre a vaga, e a fila anda.
    held.finish('p1', []);
    await settle();
    assert.equal(held.calls.length, 3);
    assert.equal(held.calls[2].folder, folderOf(abs('p3')));
    assert.ok(held.maxUnfinished() <= MAX_UNFINISHED_LISTINGS);
  });

  it('uma perdida que termina tarde tira a marca de morta, atualiza o cache e chama onLate', async () => {
    const clock = fakeClock();
    const held = heldList();
    const late = [];
    const reader = createAgentNamesReader({
      homeDir: null,
      timers: clock.timers,
      list: held.list,
      onLate: (projectDir, names) => late.push({ projectDir, names }),
    });
    const project = abs('rede');
    const first = reader.read(project);
    await settle();
    clock.advance(LOST_AFTER_MS);
    await settle();
    assert.deepEqual(await first, []);
    assert.deepEqual(await reader.read(project), [], 'morta');
    held.finish('rede', ['tester.md', 'arquiteto.md']);
    await settle();
    assert.deepEqual(late, [{ projectDir: project, names: ['tester', 'arquiteto'] }]);
    assert.deepEqual(await reader.read(project), ['tester', 'arquiteto'], 'viva de novo, pelo cache');
  });
});
