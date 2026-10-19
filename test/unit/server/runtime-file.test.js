import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  RENAME_RETRY_WINDOW_MS,
  RUNTIME_FILE_NAME,
  createToken,
  isPidAlive,
  readRuntimeFile,
  removeRuntimeFile,
  runtimeFilePath,
  writeRuntimeFile,
} from '../../../server/runtime-file.js';
import { deadPid, tempDir } from './helpers.js';

const sample = (extra = {}) => ({
  port: 50123,
  token: createToken(),
  pid: process.pid,
  version: '0.1.0',
  startedAt: 1_760_000_000_000,
  ...extra,
});

describe('createToken', () => {
  it('32 bytes aleatórios em base64url', () => {
    const token = createToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.notEqual(createToken(), token);
  });
});

describe('writeRuntimeFile e readRuntimeFile', () => {
  const tmp = tempDir();
  after(tmp.cleanup);

  it('cria o diretório de dados e grava port, token, pid, version e startedAt', async () => {
    const dataDir = path.join(tmp.dir, 'nova', 'pasta');
    const info = sample();
    await writeRuntimeFile(dataDir, info);
    assert.equal(runtimeFilePath(dataDir), path.join(dataDir, RUNTIME_FILE_NAME));
    const onDisk = JSON.parse(readFileSync(runtimeFilePath(dataDir), 'utf8'));
    assert.deepEqual(onDisk, info);
    assert.deepEqual(Object.keys(onDisk), ['port', 'token', 'pid', 'version', 'startedAt']);
    assert.deepEqual(readRuntimeFile(dataDir), info);
  });

  it('não grava campos extras', async () => {
    await writeRuntimeFile(tmp.dir, { ...sample(), segredo: 'x' });
    assert.equal(readFileSync(runtimeFilePath(tmp.dir), 'utf8').includes('segredo'), false);
  });

  it('substitui o anterior e não deixa arquivo temporário', async () => {
    await writeRuntimeFile(tmp.dir, sample({ port: 50001 }));
    await writeRuntimeFile(tmp.dir, sample({ port: 50002 }));
    assert.equal(readRuntimeFile(tmp.dir).port, 50002);
    assert.deepEqual(readdirSync(tmp.dir).filter((name) => name.startsWith(RUNTIME_FILE_NAME)), [RUNTIME_FILE_NAME]);
  });

  it('com um leitor segurando o runtime.json aberto (no Windows, o rename falha com EPERM), grava quando ele solta', async () => {
    await writeRuntimeFile(tmp.dir, sample({ port: 52000 }));
    const fd = openSync(runtimeFilePath(tmp.dir), 'r');
    const released = new Promise((resolve) =>
      setTimeout(() => {
        closeSync(fd);
        resolve(undefined);
      }, 300),
    );
    const begin = Date.now();
    await writeRuntimeFile(tmp.dir, sample({ port: 52001 }));
    await released;
    assert.equal(readRuntimeFile(tmp.dir).port, 52001);
    assert.ok(Date.now() - begin < RENAME_RETRY_WINDOW_MS + 500, 'dentro da janela de novas tentativas');
    assert.deepEqual(readdirSync(tmp.dir).filter((name) => name.startsWith(RUNTIME_FILE_NAME)), [RUNTIME_FILE_NAME], 'sem temporário sobrando');
    assert.equal(RENAME_RETRY_WINDOW_MS, 2000);
  });

  it('um leitor nunca vê o arquivo pela metade durante gravações seguidas', async () => {
    const file = runtimeFilePath(tmp.dir);
    let reads = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        const text = readFileSync(file, 'utf8');
        JSON.parse(text); // lança se o arquivo estiver incompleto
        reads++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let i = 0; i < 50; i++) await writeRuntimeFile(tmp.dir, sample({ port: 51000 + i }));
    stop = true;
    await reader;
    assert.ok(reads > 0);
    assert.equal(readRuntimeFile(tmp.dir).port, 51049);
  });

  it('arquivo ausente, corrompido ou com campos errados vale null', () => {
    const dir = path.join(tmp.dir, 'ruins');
    assert.equal(readRuntimeFile(dir), null);
    const cases = [
      '{"port": 5',
      '[]',
      JSON.stringify({ ...sample(), port: '50123' }),
      JSON.stringify({ ...sample(), port: 0 }),
      JSON.stringify({ ...sample(), pid: -1 }),
      JSON.stringify({ ...sample(), token: '' }),
      JSON.stringify({ ...sample(), startedAt: undefined }),
    ];
    for (const content of cases) {
      writeFileSync(runtimeFilePath(tmp.dir), content);
      assert.equal(readRuntimeFile(tmp.dir), null, content);
    }
  });
});

describe('removeRuntimeFile', () => {
  const tmp = tempDir();
  after(tmp.cleanup);

  it('apaga o arquivo desta execução', async () => {
    const info = sample();
    await writeRuntimeFile(tmp.dir, info);
    assert.equal(removeRuntimeFile(tmp.dir, info), true);
    assert.equal(existsSync(runtimeFilePath(tmp.dir)), false);
  });

  it('não apaga o arquivo de outra execução (outro pid ou outro token)', async () => {
    const mine = sample();
    await writeRuntimeFile(tmp.dir, sample({ pid: mine.pid + 1 }));
    assert.equal(removeRuntimeFile(tmp.dir, mine), false);
    await writeRuntimeFile(tmp.dir, sample({ token: createToken() }));
    assert.equal(removeRuntimeFile(tmp.dir, mine), false);
    assert.equal(existsSync(runtimeFilePath(tmp.dir)), true);
  });

  it('não lança se o arquivo não existe', () => {
    assert.equal(removeRuntimeFile(path.join(tmp.dir, 'vazio'), sample()), false);
  });
});

describe('isPidAlive', () => {
  it('o próprio processo está vivo', () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it('processo que já terminou não está vivo', async () => {
    assert.equal(isPidAlive(await deadPid()), false);
  });

  it('pid inválido não está vivo (e nunca sinaliza o grupo de processos)', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) assert.equal(isPidAlive(pid), false, String(pid));
  });
});
