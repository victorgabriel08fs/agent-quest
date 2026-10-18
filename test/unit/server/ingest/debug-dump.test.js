import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DUMPS_DIR_NAME, createDebugDump, dumpFileName, dumpsDir } from '../../../../server/ingest/debug-dump.js';
import { tempDir } from '../helpers.js';

const temps = [];
function newDir() {
  const tmp = tempDir();
  temps.push(tmp);
  return tmp.dir;
}
after(() => {
  for (const tmp of temps) tmp.cleanup();
});

describe('nomes', () => {
  it('pasta dumps dentro do diretório de dados', () => {
    assert.equal(DUMPS_DIR_NAME, 'dumps');
    assert.equal(dumpsDir(path.join('x', 'dados')), path.join('x', 'dados', 'dumps'));
  });

  it('AAAA-MM-DD.jsonl pela data local', () => {
    assert.equal(dumpFileName(new Date(2026, 0, 5, 0, 0, 0).getTime()), '2026-01-05.jsonl');
    assert.equal(dumpFileName(new Date(2026, 9, 18, 23, 59, 59).getTime()), '2026-10-18.jsonl');
  });
});

describe('createDebugDump', () => {
  const day1 = new Date(2026, 9, 18, 10, 0, 0).getTime();
  const day2 = new Date(2026, 9, 19, 0, 0, 1).getTime();

  it('só cria a pasta no primeiro envelope gravado', async () => {
    const dir = path.join(newDir(), 'dumps');
    const dump = createDebugDump({ dir });
    assert.equal(existsSync(dir), false);
    await dump.close();
    assert.equal(existsSync(dir), false);
  });

  it('um envelope por linha, como chegou, e acrescenta a um arquivo que já existe', async () => {
    const dir = path.join(newDir(), 'dumps');
    const a = { v: 1, payload: { session_id: 's', hook_event_name: 'Stop', texto: 'linha 1\nlinha 2' } };
    const b = { v: 1, payload: { session_id: 's', hook_event_name: 'SessionEnd' } };

    const first = createDebugDump({ dir });
    first.write(a, day1);
    await first.close();
    const second = createDebugDump({ dir });
    second.write(b, day1 + 1000);
    await second.close();

    const lines = readFileSync(path.join(dir, '2026-10-18.jsonl'), 'utf8').split('\n');
    assert.equal(lines.pop(), '', 'termina com quebra de linha');
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [a, b]);
  });

  it('troca de arquivo quando a data de chegada muda', async () => {
    const dir = path.join(newDir(), 'dumps');
    const dump = createDebugDump({ dir });
    dump.write({ v: 1, n: 1 }, day1);
    dump.write({ v: 1, n: 2 }, day2);
    dump.write({ v: 1, n: 3 }, day2 + 1);
    await dump.close();
    assert.deepEqual(readdirSync(dir).sort(), ['2026-10-18.jsonl', '2026-10-19.jsonl']);
    const count = (name) => readFileSync(path.join(dir, name), 'utf8').trim().split('\n').length;
    assert.equal(count('2026-10-18.jsonl'), 1);
    assert.equal(count('2026-10-19.jsonl'), 2);
  });

  it('envelope que não dá para serializar (aninhamento extremo) é pulado sem desligar o dump', async () => {
    const dir = path.join(newDir(), 'dumps');
    const errors = [];
    const dump = createDebugDump({ dir, onError: (err) => errors.push(err) });
    const deep = JSON.parse(`{"v":1,"payload":${'['.repeat(50_000)}${']'.repeat(50_000)}}`);
    dump.write({ v: 1, n: 1 }, day1);
    assert.doesNotThrow(() => dump.write(deep, day1));
    dump.write({ v: 1, n: 2 }, day1);
    await dump.close();
    assert.deepEqual(errors, []);
    const lines = readFileSync(path.join(dir, '2026-10-18.jsonl'), 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((line) => JSON.parse(line).n), [1, 2]);
  });

  it('falha de disco: avisa uma vez, nunca lança, e para de gravar', async () => {
    const base = newDir();
    const dir = path.join(base, 'dumps');
    writeFileSync(dir, 'um arquivo no lugar da pasta');
    const errors = [];
    const dump = createDebugDump({ dir, onError: (err) => errors.push(err) });
    dump.write({ v: 1 }, day1);
    dump.write({ v: 1 }, day1);
    await dump.close();
    assert.equal(errors.length, 1);
  });

  it('falha ao abrir o arquivo: avisa uma vez e close() termina', async () => {
    const dir = path.join(newDir(), 'dumps');
    const errors = [];
    const dump = createDebugDump({ dir, onError: (err) => errors.push(err) });
    // Uma pasta com o nome do arquivo do dia faz a abertura falhar.
    mkdirSync(path.join(dir, '2026-10-18.jsonl'), { recursive: true });
    dump.write({ v: 1 }, day1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    dump.write({ v: 1 }, day1);
    await dump.close();
    assert.equal(errors.length, 1);
  });
});
