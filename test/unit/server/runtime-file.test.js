import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import {
  REMOVE_RETRY_WINDOW_MS,
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

  /** Erro de arquivo, como o `node:fs` lança. */
  const fsError = (code) => Object.assign(new Error(code), { code });

  /**
   * Relógio falso: a espera só anda o relógio e fica registrada.
   * @returns {{ now: () => number, sleep: (ms: number) => void, sleeps: number[] }}
   */
  const fakeClock = () => {
    let time = 1_000;
    const sleeps = [];
    return {
      now: () => time,
      sleep: (ms) => {
        sleeps.push(ms);
        time += ms;
      },
      sleeps,
    };
  };

  /** Pasta própria para cada caso, com o runtime.json desta execução já gravado. */
  let dirs = 0;
  const ownFile = async () => {
    const dataDir = path.join(tmp.dir, `rm-${++dirs}`);
    const info = sample();
    await writeRuntimeFile(dataDir, info);
    return { dataDir, info, file: runtimeFilePath(dataDir) };
  };

  it('remoção presa (EBUSY, EPERM, EACCES): tenta de novo, com espera crescente, e apaga quando solta', async () => {
    const { dataDir, info, file } = await ownFile();
    const failures = ['EBUSY', 'EPERM', 'EACCES'];
    const clock = fakeClock();
    let calls = 0;
    const unlink = (target) => {
      calls++;
      assert.equal(target, file);
      if (failures.length > 0) throw fsError(failures.shift());
      unlinkSync(target);
    };
    assert.equal(removeRuntimeFile(dataDir, info, { unlink, sleep: clock.sleep, now: clock.now }), true);
    assert.equal(existsSync(file), false);
    assert.equal(calls, 4);
    assert.deepEqual(clock.sleeps, [10, 20, 40]);
  });

  it('leitura presa (aberto sem compartilhar leitura, EBUSY): tenta de novo e apaga', async () => {
    const { dataDir, info, file } = await ownFile();
    const clock = fakeClock();
    let reads = 0;
    const read = (target) => {
      if (++reads <= 2) throw fsError('EBUSY');
      return readFileSync(target, 'utf8');
    };
    assert.equal(removeRuntimeFile(dataDir, info, { read, sleep: clock.sleep, now: clock.now }), true);
    assert.equal(existsSync(file), false);
    assert.equal(reads, 3);
    assert.deepEqual(clock.sleeps, [10, 20]);
  });

  it('preso a janela toda: desiste sem lançar, dentro da janela, e o arquivo fica (sobra para a próxima partida)', async () => {
    assert.equal(REMOVE_RETRY_WINDOW_MS, 500);
    const { dataDir, info, file } = await ownFile();
    const clock = fakeClock();
    let calls = 0;
    const unlink = () => {
      calls++;
      throw fsError('EBUSY');
    };
    assert.equal(removeRuntimeFile(dataDir, info, { unlink, sleep: clock.sleep, now: clock.now }), false);
    assert.equal(existsSync(file), true);
    // 10, 20, 40, 80 e depois 100 ms até a próxima espera passar da janela.
    assert.deepEqual(clock.sleeps, [10, 20, 40, 80, 100, 100, 100]);
    assert.ok(clock.sleeps.reduce((a, b) => a + b, 0) <= REMOVE_RETRY_WINDOW_MS);
    assert.equal(calls, clock.sleeps.length + 1);
  });

  it('confere o dono a cada tentativa: se outra execução gravou o arquivo durante a espera, não apaga', async () => {
    const { dataDir, info, file } = await ownFile();
    const other = sample({ token: createToken() });
    let calls = 0;
    const unlink = () => {
      calls++;
      throw fsError('EBUSY');
    };
    // Durante a espera, outro servidor grava o seu runtime.json.
    const sleep = () => writeFileSync(file, JSON.stringify(other));
    assert.equal(removeRuntimeFile(dataDir, info, { unlink, sleep, now: () => 0 }), false);
    assert.equal(calls, 1);
    assert.deepEqual(readRuntimeFile(dataDir), other);
  });

  it('erro que não é de arquivo preso: não tenta de novo', async () => {
    const { dataDir, info, file } = await ownFile();
    for (const code of ['ENOENT', 'EISDIR', undefined]) {
      const clock = fakeClock();
      let calls = 0;
      const unlink = () => {
        calls++;
        throw code ? fsError(code) : new Error('sem código');
      };
      assert.equal(removeRuntimeFile(dataDir, info, { unlink, sleep: clock.sleep, now: clock.now }), false, String(code));
      assert.equal(calls, 1, String(code));
      assert.deepEqual(clock.sleeps, [], String(code));
    }
    assert.equal(existsSync(file), true);
  });

  it('com o relógio e a espera reais: a espera bloqueia de verdade e termina perto do fim da janela', async () => {
    const { dataDir, info, file } = await ownFile();
    const unlink = () => {
      throw fsError('EBUSY');
    };
    const begin = performance.now();
    assert.equal(removeRuntimeFile(dataDir, info, { unlink }), false);
    const elapsed = performance.now() - begin;
    assert.equal(existsSync(file), true);
    // Desiste quando a próxima espera (no máximo 100 ms) passaria da janela: nunca
    // antes de ~400 ms (folga para a resolução do relógio). O teto é só uma
    // garantia de que o processo sai, com folga larga para máquina carregada.
    assert.ok(elapsed >= REMOVE_RETRY_WINDOW_MS - 100 - 30, `${elapsed.toFixed(0)} ms`);
    assert.ok(elapsed < REMOVE_RETRY_WINDOW_MS + 1500, `${elapsed.toFixed(0)} ms`);
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
