// Integração do T4 (tester): matriz de falhas do encaminhador, como processo
// filho, contra o servidor real do T3 (porta 0, AGENT_QUEST_HOME temporário,
// --debug-dump para ler o envelope exatamente como chegou).
//
// Em todos os casos: código 0 e stdout e stderr vazios. Tempos do critério: até
// 300 ms nos casos de saída rápida e até 2,2 s com o servidor travado ou com o
// stdin aberto, medidos como tempo de vida do próprio processo (capture-helpers.js).
//
// "Sem enviar" é conferido no servidor real (contadores do /api/health e dump)
// ou num ouvinte na porta em questão, nunca só pela ausência de erro.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import {
  FAST_LIMIT_MS,
  FORWARDER,
  PLUGIN_VERSION,
  STUCK_LIMIT_MS,
  assertDelivered,
  assertLifetimeWithin,
  assertLossesOnlyByDeadline,
  assertSilentExit,
  assertWithinLimit,
  cleanupTemps,
  loadFrom,
  withLoadSamples,
  closedPort,
  deadPid,
  forwarderEnv,
  hookPayload,
  isPidAlive,
  newTemp,
  readJson,
  recordingHttpServer,
  runForwarder,
  startRealServer,
  tcpBlackHole,
  writeRuntime,
} from './capture-helpers.js';
import { freePort, killTree, launchNpm, minimalEnv, waitFor } from './server-helpers.js';

const isWindows = process.platform === 'win32';

describe('T4 integração: matriz de falhas do encaminhador (servidor real do T3)', () => {
  let home;
  let server;
  /** Diretório de dados com o runtime.json do servidor real (o caso normal). */
  const envFor = (dataDir, extra = {}) => forwarderEnv({ AGENT_QUEST_HOME: dataDir, ...extra });

  before(async () => {
    home = newTemp('aq int captura ção-');
    server = await startRealServer({ dataDir: home, env: { AGENT_QUEST_HOME: home } });
  });

  after(async () => {
    if (server) await server.stop();
    cleanupTemps();
  });

  /** Roda `fn` e confere que o servidor real não recebeu nada (nem recusou nada). */
  async function assertNothingReaches(fn) {
    const before = await server.health();
    const result = await fn();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterEvents = await server.health();
    assert.equal(afterEvents.received, before.received, 'o servidor recebeu um POST');
    return result;
  }

  // --- caso normal -----------------------------------------------------------

  it('caso normal: o servidor real aceita o envelope v1 correto, em até 300 ms', async (t) => {
    const projectDir = 'C:\\Users\\usuario\\Projetos\\ação com espaço & (1)';
    // Variáveis que o encaminhador NUNCA pode mandar (modelo de eventos, seção 1).
    const decoys = {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      TERM_PROGRAM: 'vscode',
      ANTHROPIC_API_KEY: 'sk-ant-api03-ISCA-NAO-PODE-SAIR-0000000000',
      AWS_SECRET_ACCESS_KEY: 'ISCA/aws/segredo/0000000000',
      CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(FORWARDER)),
    };
    const before = await server.health();
    const sent = [];
    const timing = await assertWithinLimit(
      t,
      'caso normal',
      async () => {
        const payload = hookPayload({
          tool_name: 'Bash',
          tool_input: { command: 'npm test', description: 'Roda os testes ✓ 😀 ação' },
          nested: { list: [1, 'dois', { tres: null, quatro: true }], empty: {}, arr: [] },
        });
        const result = await runForwarder({ env: envFor(home, { CLAUDE_PROJECT_DIR: projectDir, ...decoys }), stdin: JSON.stringify(payload) });
        sent.push({ payload, result });
        return result;
      },
      FAST_LIMIT_MS,
    );

    // Entrega de cada rodada (regra de perdas em capture-helpers.js).
    const find = (payload) => server.dumped().find((e) => e.payload.tool_use_id === payload.tool_use_id);
    await waitFor(() => sent.every((s) => find(s.payload)), { timeoutMs: 3000, label: 'envelopes no dump' }).catch(() => {});
    const runs = sent.map((s) => ({ ...s, delivered: Boolean(find(s.payload)) }));
    assertLossesOnlyByDeadline(t, 'caso normal', runs, timing.references);
    const delivered = runs.filter((r) => r.delivered);
    if (delivered.length === 0) {
      t.skip(`envelope não avaliado: máquina sobrecarregada (${loadFrom(timing.references).text}); todas as rodadas esgotaram o prazo`);
      return;
    }
    const { payload: last, result } = delivered.at(-1);
    const envelope = find(last);
    assert.deepEqual(Object.keys(envelope).sort(), ['env', 'forwarder', 'payload', 'sentAt', 'truncated', 'v']);
    assert.deepEqual(Object.keys(envelope.env).sort(), ['entrypoint', 'projectDir']);
    assert.equal(envelope.v, 1);
    assert.equal(envelope.forwarder, PLUGIN_VERSION);
    assert.deepEqual(envelope.env, { projectDir, entrypoint: null });
    assert.equal(envelope.truncated, false);
    assert.deepEqual(envelope.payload, last);
    assert.equal(typeof envelope.sentAt, 'number');
    assert.ok(
      envelope.sentAt >= result.beginEpoch - 5 && envelope.sentAt <= result.endEpoch,
      `sentAt ${envelope.sentAt} fora da vida do processo (${result.beginEpoch}..${result.endEpoch})`,
    );

    const line = JSON.stringify(envelope);
    for (const value of Object.values(decoys)) {
      assert.ok(!line.includes(value), `o envelope levou o valor de uma variável de ambiente: ${value}`);
    }

    const events = await server.health();
    assert.equal(events.accepted - before.accepted, delivered.length, 'cada envelope entregue foi aceito uma vez');
    // Um envio cortado pelo prazo pode chegar pela metade e contar como recusa (corpo abortado).
    assert.ok(events.rejected - before.rejected <= runs.length - delivered.length, 'recusa sem explicação');
  });

  it('strings acima de 4 KiB chegam cortadas (1 KiB do início + 3 KiB do fim) com truncated: true', async (t) => {
    const emoji = '😀';
    const cases = {
      // oráculos escritos à mão (modelo de eventos, seção 1)
      simples: [`${'I'.repeat(1024)}${'M'.repeat(5000)}${'F'.repeat(3072)}`, `${'I'.repeat(1024)}…[cortado 5000 caracteres]…${'F'.repeat(3072)}`],
      limite: ['L'.repeat(4096), 'L'.repeat(4096)],
      umAcima: ['x'.repeat(4097), `${'x'.repeat(1024)}…[cortado 1 caracteres]…${'x'.repeat(3072)}`],
      emojiNasBordas: [
        `${'a'.repeat(1023)}${emoji}${'b'.repeat(6000)}${emoji}${'c'.repeat(3071)}`,
        `${'a'.repeat(1023)}…[cortado ${2 + 6000 + 2} caracteres]…${'c'.repeat(3071)}`,
      ],
      // "KiB" contado em unidades UTF-16 (decisão do dev): 4096 "ç" (8 KiB em UTF-8) não são cortados
      multibyteNoLimite: ['ç'.repeat(4096), 'ç'.repeat(4096)],
      resumoDeTestes: [`${'saída '.repeat(2000)}\nℹ tests 12\nℹ pass 12\nℹ fail 0`, null],
    };
    let payload;
    const envelope = await assertDelivered(t, 'corte', async () => {
      payload = hookPayload({
        hook_event_name: 'PostToolUse',
        tool_response: Object.fromEntries(Object.entries(cases).map(([k, [input]]) => [k, input])),
        deep: { list: [{ again: cases.simples[0] }] },
      });
      const id = payload.tool_use_id;
      const result = await runForwarder({ env: envFor(home), stdin: JSON.stringify(payload) });
      return { result, delivered: () => server.dumped().find((e) => e.payload.tool_use_id === id) };
    });
    if (!envelope) return;
    assert.equal(envelope.truncated, true);
    const got = envelope.payload.tool_response;
    for (const [name, [input, expected]] of Object.entries(cases)) {
      assert.ok(got[name].isWellFormed(), `${name}: par substituto partido`);
      if (expected !== null) assert.equal(got[name], expected, name);
    }
    assert.ok(got.resumoDeTestes.endsWith('ℹ tests 12\nℹ pass 12\nℹ fail 0'), 'o fim (resumo dos testes) é preservado');
    assert.ok(got.resumoDeTestes.startsWith('saída '.repeat(170)), 'o início é preservado');
    assert.equal(envelope.payload.deep.list[0].again, cases.simples[1], 'corta em qualquer nível');
    assert.equal(envelope.payload.session_id, payload.session_id, 'o resto do payload chega intacto');
  });

  // --- sem servidor ------------------------------------------------------------

  it('sem runtime.json: sai em até 300 ms, sem enviar', async (t) => {
    const empty = newTemp('aq-int-cap-vazio-');
    await assertNothingReaches(() =>
      assertWithinLimit(t, 'sem runtime.json', () => runForwarder({ env: envFor(empty), stdin: JSON.stringify(hookPayload()) }), FAST_LIMIT_MS),
    );
    // Diretório de dados que nem existe.
    const missing = path.join(empty, 'nao', 'existe');
    assertSilentExit(await runForwarder({ env: envFor(missing), stdin: JSON.stringify(hookPayload()) }), 'pasta inexistente');
  });

  it('runtime.json corrompido ou incompleto: sai em até 300 ms, sem enviar', async (t) => {
    const real = readJson(path.join(home, 'runtime.json'));
    const dir = newTemp('aq-int-cap-corrompido-');
    writeRuntime(dir, '{"port": 5');
    await assertNothingReaches(() =>
      assertWithinLimit(t, 'runtime.json corrompido', () => runForwarder({ env: envFor(dir), stdin: JSON.stringify(hookPayload()) }), FAST_LIMIT_MS),
    );
    // Variantes que apontam para o servidor real, mas com algum campo fora do esperado.
    const variants = {
      vazio: '',
      nulo: 'null',
      lista: '[]',
      binario: randomBytes(64),
      bomELixo: '\uFEFF{lixo',
      semToken: { port: real.port, pid: real.pid },
      tokenNumero: { port: real.port, token: 42, pid: real.pid },
      tokenVazio: { port: real.port, token: '', pid: real.pid },
      semPid: { port: real.port, token: real.token },
      pidZero: { port: real.port, token: real.token, pid: 0 },
      pidNegativo: { port: real.port, token: real.token, pid: -1 },
      pidTexto: { port: real.port, token: real.token, pid: String(real.pid) },
    };
    for (const [name, data] of Object.entries(variants)) {
      const variantDir = newTemp(`aq-int-cap-${name}-`);
      writeRuntime(variantDir, data);
      await assertNothingReaches(async () => {
        const result = await runForwarder({ env: envFor(variantDir), stdin: JSON.stringify(hookPayload()), timed: false });
        assertSilentExit(result, name);
      });
    }
    // runtime.json que é uma pasta.
    const dirAsFile = newTemp('aq-int-cap-pasta-');
    mkdirSync(path.join(dirAsFile, 'runtime.json'));
    assertSilentExit(await runForwarder({ env: envFor(dirAsFile), stdin: JSON.stringify(hookPayload()), timed: false }), 'runtime.json é pasta');
  });

  it('pid morto, com a porta e o token do servidor real: sai em até 300 ms, sem enviar', async (t) => {
    const real = readJson(path.join(home, 'runtime.json'));
    const dir = newTemp('aq-int-cap-pidmorto-');
    let reused = 0;
    const before = await server.health();
    await assertWithinLimit(
      t,
      'pid morto',
      async () => {
        const pid = await deadPid();
        writeRuntime(dir, { ...real, pid });
        const result = await runForwarder({ env: envFor(dir), stdin: JSON.stringify(hookPayload()) });
        if (isPidAlive(pid)) reused++; // pid reaproveitado no meio: a rodada não vale como prova
        return result;
      },
      FAST_LIMIT_MS,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const events = await server.health();
    if (reused === 0) assert.equal(events.received, before.received, 'o encaminhador enviou com o pid morto');
    else t.diagnostic(`${reused} pid(s) reaproveitado(s) durante o teste`);
  });

  it('porta fechada (pid vivo): sai em até 300 ms', async (t) => {
    const real = readJson(path.join(home, 'runtime.json'));
    const dir = newTemp('aq-int-cap-fechada-');
    writeRuntime(dir, { ...real, port: await closedPort() });
    await assertNothingReaches(() =>
      assertWithinLimit(t, 'porta fechada', () => runForwarder({ env: envFor(dir), stdin: JSON.stringify(hookPayload()) }), FAST_LIMIT_MS),
    );
  });

  it('porta fora de 1024 a 65535 ou que não seja inteiro: sai em até 300 ms, sem nem tentar a conexão', async (t) => {
    const real = readJson(path.join(home, 'runtime.json'));
    // Um ouvinte numa porta abaixo de 1024 denuncia qualquer tentativa.
    let low = null;
    for (const port of [1023, 1022, 1001, 999]) {
      try {
        low = await tcpBlackHole({ port });
        break;
      } catch {
        // porta em uso ou reservada: tenta a próxima
      }
    }
    try {
      const dir = newTemp('aq-int-cap-faixa-');
      if (low) {
        writeRuntime(dir, { ...real, port: low.port });
        await assertWithinLimit(t, `porta ${low.port}`, () => runForwarder({ env: envFor(dir), stdin: JSON.stringify(hookPayload()) }), FAST_LIMIT_MS);
        assert.equal(low.connections(), 0, `o encaminhador tentou a porta ${low.port}`);
      } else {
        t.diagnostic('nenhuma porta abaixo de 1024 livre para o ouvinte; a faixa baixa ficou só com as outras variantes');
      }
      // Variantes que, se fossem aceitas, chegariam ao servidor real.
      for (const port of [String(real.port), real.port + 0.5, 0, -1, 65536, 70000, null, true, [real.port], { n: real.port }]) {
        writeRuntime(dir, { ...real, port });
        await assertNothingReaches(async () => {
          assertSilentExit(await runForwarder({ env: envFor(dir), stdin: JSON.stringify(hookPayload()), timed: false }), JSON.stringify(port));
        });
      }
      // 1e999 vira Infinity no JSON.parse.
      writeRuntime(dir, `{"port": 1e999, "token": ${JSON.stringify(real.token)}, "pid": ${real.pid}}`);
      await assertNothingReaches(async () => {
        assertSilentExit(await runForwarder({ env: envFor(dir), stdin: JSON.stringify(hookPayload()), timed: false }), '1e999');
      });
    } finally {
      await low?.close();
    }
  });

  // --- servidor travado --------------------------------------------------------

  it('servidor que aceita e não responde (lê o corpo): desiste e sai em até 2,2 s', async (t) => {
    const hang = await recordingHttpServer({ hang: true });
    try {
      const dir = newTemp('aq-int-cap-travado-');
      writeRuntime(dir, { port: hang.port, token: 't', pid: process.pid });
      const result = await assertWithinLimit(t, 'travado (HTTP)', () => runForwarder({ env: envFor(dir), stdin: JSON.stringify(hookPayload()) }), STUCK_LIMIT_MS);
      assert.ok(result.ownMs >= 950, `saiu antes do prazo do POST (${result.ownMs.toFixed(0)} ms)`);
      assert.ok(hang.requests.length >= 1, 'o pedido chegou ao servidor travado');
    } finally {
      await hang.close();
    }
  });

  it('servidor que aceita a conexão e nunca lê nem responde: desiste e sai em até 2,2 s', async (t) => {
    const hole = await tcpBlackHole();
    try {
      const dir = newTemp('aq-int-cap-buraco-');
      writeRuntime(dir, { port: hole.port, token: 't', pid: process.pid });
      // Corpo grande (strings logo abaixo do corte), para o envio também ficar preso.
      const big = JSON.stringify(hookPayload({ lines: Array.from({ length: 400 }, () => 'q'.repeat(4000)) }));
      const result = await assertWithinLimit(t, 'travado (TCP)', () => runForwarder({ env: envFor(dir), stdin: big }), STUCK_LIMIT_MS);
      assert.ok(result.ownMs >= 950, `saiu antes do prazo do POST (${result.ownMs.toFixed(0)} ms)`);
      assert.ok(hole.connections() >= 1, 'a conexão chegou ao servidor travado');
    } finally {
      await hole.close();
    }
  });

  // --- stdin ruim --------------------------------------------------------------

  it('stdin inválido ou vazio: sai em até 300 ms, sem enviar', async (t) => {
    const variants = {
      vazio: '',
      texto: 'nada',
      lista: '[1,2]',
      nulo: 'null',
      numero: '42',
      string: '"texto"',
      cortado: '{"session_id":',
      binario: randomBytes(4096),
      utf16: Buffer.from('\uFEFF{"session_id":"s","hook_event_name":"Stop"}', 'utf16le'),
    };
    for (const [name, stdin] of Object.entries(variants)) {
      await assertNothingReaches(() =>
        assertWithinLimit(t, `stdin ${name}`, () => runForwarder({ env: envFor(home), stdin }), FAST_LIMIT_MS),
      );
    }
  });

  it('objeto JSON sem session_id: o encaminhador envia e o servidor recusa com 400 (validação é do servidor)', async (t) => {
    await assertDelivered(t, 'sem session_id', async () => {
      const before = await server.health();
      const result = await runForwarder({ env: envFor(home), stdin: JSON.stringify({ hook_event_name: 'Stop', n: Math.random() }) });
      return {
        result,
        delivered: async () => {
          const e = await server.health();
          return e.rejected === before.rejected + 1 && e.accepted === before.accepted;
        },
      };
    });
  });

  it('stdin de 10 MiB: string única chega cortada; muitas strings curtas chegam reduzidas (teto do corpo) com 204; inválido não sai; em até 300 ms', async (t) => {
    // a) uma string enorme (saída de comando, conteúdo de arquivo)
    let before = await server.health();
    const sent = [];
    const timing = await assertWithinLimit(
      t,
      '10 MiB, string única',
      async () => {
        const payload = hookPayload({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'z'.repeat(10 * 1024 * 1024) } });
        const result = await runForwarder({ env: envFor(home), stdin: JSON.stringify(payload) });
        sent.push({ id: payload.tool_use_id, result });
        return result;
      },
      FAST_LIMIT_MS,
    );
    const find = (id) => server.dumped().find((e) => e.payload.tool_use_id === id);
    await waitFor(() => sent.every((s) => find(s.id)), { timeoutMs: 3000, label: 'envelopes de 10 MiB' }).catch(() => {});
    const runs = sent.map((s) => ({ ...s, delivered: Boolean(find(s.id)) }));
    assertLossesOnlyByDeadline(t, '10 MiB, string única', runs, timing.references);
    for (const run of runs.filter((r) => r.delivered)) {
      const envelope = find(run.id);
      assert.equal(envelope.truncated, true);
      assert.ok(JSON.stringify(envelope).length < 16 * 1024);
    }
    let events = await server.health();
    assert.ok(events.rejected - before.rejected <= runs.filter((r) => !r.delivered).length, 'recusa sem explicação');

    // b) muitas strings abaixo de 4 KiB (por exemplo, um Glob enorme): o corte de
    //    4 KiB não basta, e o teto do corpo (modelo de eventos, seção 1) reduz o
    //    envelope até caber em 1 000 000 bytes. O servidor aceita com 204, sem 413.
    before = events;
    const manySent = [];
    const manyTiming = await assertWithinLimit(
      t,
      '10 MiB, muitas strings',
      async () => {
        const payload = hookPayload({ hook_event_name: 'PostToolUse', tool_response: { filenames: Array.from({ length: 2700 }, (_, i) => String(i).padEnd(4000, 'f')) } });
        const stdin = JSON.stringify(payload);
        assert.ok(Buffer.byteLength(stdin) > 10 * 1024 * 1024);
        const result = await runForwarder({ env: envFor(home), stdin });
        assert.equal(result.stdinError, null);
        manySent.push({ payload, result });
        return result;
      },
      FAST_LIMIT_MS,
    );
    await waitFor(() => manySent.every((s) => find(s.payload.tool_use_id)), { timeoutMs: 3000, label: 'envelopes reduzidos' }).catch(() => {});
    const manyRuns = manySent.map((s) => ({ ...s, delivered: Boolean(find(s.payload.tool_use_id)) }));
    assertLossesOnlyByDeadline(t, '10 MiB, muitas strings', manyRuns, manyTiming.references);
    for (const { payload } of manyRuns.filter((r) => r.delivered)) {
      const envelope = find(payload.tool_use_id);
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 1_000_000, 'corpo acima do teto');
      assert.equal(envelope.truncated, true);
      assert.equal(envelope.payload.session_id, payload.session_id);
      assert.equal(envelope.payload.hook_event_name, payload.hook_event_name);
      assert.equal(envelope.payload.tool_response.filenames.length, 100, 'passo 2: listas com os 100 primeiros itens');
    }
    events = await server.health();
    assert.ok(events.rejected - before.rejected <= manyRuns.filter((r) => !r.delivered).length, 'recusa (413?) sem explicação');

    // c) 10 MiB que não são JSON
    await assertNothingReaches(() =>
      assertWithinLimit(t, '10 MiB inválido', () => runForwarder({ env: envFor(home), stdin: 'x'.repeat(10 * 1024 * 1024) }), FAST_LIMIT_MS),
    );
  });

  it('stdin acima de 16 MiB: lê até o fim (quem escreve não recebe EPIPE), descarta e sai sem enviar', async () => {
    const huge = JSON.stringify(hookPayload({ tool_response: { stdout: 'z'.repeat(17 * 1024 * 1024) } }));
    await assertNothingReaches(async () => {
      const result = await runForwarder({ env: envFor(home), stdin: huge, timed: false });
      assertSilentExit(result, '17 MiB');
      assert.equal(result.stdinError, null, `quem escreve recebeu ${result.stdinError}`);
    });
  });

  it('stdin lido até o fim antes do runtime.json: sem servidor, quem escreve 8 MiB não recebe EPIPE', async () => {
    const empty = newTemp('aq-int-cap-pipe-');
    const big = JSON.stringify(hookPayload({ tool_response: { stdout: 'y'.repeat(8 * 1024 * 1024) } }));
    for (const [name, dir, data] of [
      ['sem runtime.json', empty, null],
      ['pid morto', newTemp('aq-int-cap-pipe2-'), { ...readJson(path.join(home, 'runtime.json')), pid: await deadPid() }],
      ['porta fora da faixa', newTemp('aq-int-cap-pipe3-'), { ...readJson(path.join(home, 'runtime.json')), port: 80 }],
    ]) {
      if (data) writeRuntime(dir, data);
      const result = await runForwarder({ env: envFor(dir), stdin: big, timed: false });
      assertSilentExit(result, name);
      assert.equal(result.stdinError, null, `${name}: quem escreve recebeu ${result.stdinError}`);
    }
  });

  it('stdin que nunca fecha: sai sozinho em até 2,2 s, sem enviar', async (t) => {
    for (const [name, stdin] of [
      ['JSON incompleto', '{"session_id":"s",'],
      ['JSON completo sem EOF', JSON.stringify(hookPayload())],
      ['nada escrito', ''],
    ]) {
      await assertNothingReaches(async () => {
        const result = await assertWithinLimit(t, `stdin aberto (${name})`, () => runForwarder({ env: envFor(home), stdin, keepStdinOpen: true }), STUCK_LIMIT_MS);
        assert.ok(result.ownMs >= 1900, `${name}: saiu antes do prazo de 2 s (${result.ownMs.toFixed(0)} ms)`);
      });
    }
  });

  it('stdin sem pipe (stdio ignore): sai 0 e em silêncio', async () => {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [FORWARDER], { env: envFor(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const guard = setTimeout(() => child.kill(), 10_000);
      child.on('close', (code, signal) => {
        clearTimeout(guard);
        resolve({ code, signal, out });
      });
    });
    assert.deepEqual(result, { code: 0, signal: null, out: '' });
  });

  // --- destino -------------------------------------------------------------------

  it('só envia para 127.0.0.1: ignora "host" no runtime.json e não usa ::1', async (t) => {
    const target = await recordingHttpServer();
    let v6 = null;
    try {
      v6 = await recordingHttpServer({ host: '::1', port: target.port });
    } catch {
      // sem IPv6 na máquina: a parte do ::1 fica de fora
    }
    try {
      const dir = newTemp('aq-int-cap-host-');
      for (const host of ['192.0.2.1', 'localhost', '::1', 'evil.example']) {
        writeRuntime(dir, { port: target.port, token: 'tok', pid: process.pid, host, hostname: host });
        const req = await assertDelivered(t, host, async () => {
          const id = hookPayload().tool_use_id;
          const result = await runForwarder({ env: envFor(dir), stdin: JSON.stringify(hookPayload({ tool_use_id: id })) });
          return { result, delivered: () => target.requests.find((r) => r.body.includes(id)) };
        });
        if (!req) continue;
        assert.equal(req.headers.host, `127.0.0.1:${target.port}`);
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/hooks');
        assert.equal(req.headers['content-type'], 'application/json');
        assert.equal(req.headers['x-agent-quest-token'], 'tok');
        assert.equal(req.headers.origin, undefined);
      }
      if (v6) assert.equal(v6.requests.length, 0, 'o encaminhador mandou para ::1');
    } finally {
      await target.close();
      await v6?.close();
    }
  });

  it('só envia para 127.0.0.1: variáveis de proxy (HTTP_PROXY, NODE_USE_ENV_PROXY) não desviam o envio', async (t) => {
    const target = await recordingHttpServer();
    const proxy = await recordingHttpServer();
    try {
      const proxyUrl = `http://127.0.0.1:${proxy.port}`;
      const proxyEnv = {
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        NO_PROXY: '',
      };
      const dir = newTemp('aq-int-cap-proxy-');
      writeRuntime(dir, { port: target.port, token: 'tok', pid: process.pid });
      await assertDelivered(t, 'proxy', async () => {
        const result = await runForwarder({ env: envFor(dir, proxyEnv), stdin: JSON.stringify(hookPayload()) });
        return { result, delivered: () => target.requests.length > 0 };
      });
      assert.equal(proxy.requests.length, 0, 'o envelope passou pelo proxy');

      // Controle: um cliente ingênuo (agente global) no mesmo ambiente vai para o
      // proxy, então o ambiente acima de fato desviaria uma implementação descuidada.
      const control = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          ['-e', `require('http').request({host:'127.0.0.1',port:${target.port},method:'POST',path:'/controle'},r=>{r.resume();r.on('end',()=>process.exit(0))}).on('error',()=>process.exit(0)).end('x')`],
          { env: minimalEnv(proxyEnv), stdio: 'ignore', windowsHide: true },
        );
        child.on('close', resolve);
      });
      void control;
      if (proxy.requests.some((r) => r.url.endsWith('/controle'))) {
        t.diagnostic('controle: com essas variáveis, um cliente com o agente global vai para o proxy; o encaminhador não foi');
      } else {
        t.diagnostic('controle: este Node não honrou NODE_USE_ENV_PROXY; a prova do proxy é parcial');
      }
    } finally {
      await target.close();
      await proxy.close();
    }
  });

  it('código: o único destino é 127.0.0.1, sem nome de host nem endereço vindo de fora', () => {
    const source = readFileSync(FORWARDER, 'utf8');
    assert.match(source, /export const HOST = '127\.0\.0\.1';/);
    assert.equal((source.match(/http\.request\(/g) ?? []).length, 1);
    assert.match(source, /http\.request\(\s*\{\s*host: HOST,\s*port: runtime\.port,/);
    assert.doesNotMatch(source, /localhost|0\.0\.0\.0|::1|hostname\s*:|https?:\/\//);
  });

  // --- concorrência -----------------------------------------------------------------

  it('várias sessões e subagentes em paralelo: 36 encaminhadores ao mesmo tempo, todos aceitos, sem misturar projetos', async (t) => {
    const before = await server.health();
    const jobs = [];
    for (let s = 0; s < 3; s++) {
      const projectDir = `C:\\Users\\usuario\\Projetos\\projeto-${s}`;
      const sessionId = `sessao-paralela-${process.pid}-${s}`;
      for (const agent of [null, `a${s}0000000000000a`, `a${s}0000000000000b`]) {
        for (const event of ['PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse']) {
          const payload = hookPayload({ session_id: sessionId, hook_event_name: event, ...(agent ? { agent_id: agent, agent_type: 'tester' } : {}) });
          jobs.push({ projectDir, payload });
        }
      }
    }
    const { value: results, samples } = await withLoadSamples(() =>
      Promise.all(jobs.map(({ projectDir, payload }) => runForwarder({ env: envFor(home, { CLAUDE_PROJECT_DIR: projectDir }), stdin: JSON.stringify(payload) }))),
    );
    results.forEach((r, i) => assertSilentExit(r, `paralelo ${i}`));
    const find = (payload) => server.dumped().find((e) => e.payload.tool_use_id === payload.tool_use_id);
    await waitFor(() => jobs.every((j) => find(j.payload)), { timeoutMs: 3000, label: 'envelopes em paralelo' }).catch(() => {});
    const runs = jobs.map((job, i) => ({ ...job, result: results[i], delivered: Boolean(find(job.payload)) }));
    assertLossesOnlyByDeadline(t, 'paralelo', runs, samples);
    const delivered = runs.filter((r) => r.delivered);
    const events = await server.health();
    assert.equal(events.accepted - before.accepted, delivered.length, 'cada envelope entregue foi aceito uma vez');
    assert.ok(events.rejected - before.rejected <= runs.length - delivered.length, 'recusa sem explicação');
    for (const { projectDir, payload } of delivered) {
      const envelope = find(payload);
      assert.equal(envelope.env.projectDir, projectDir, 'projeto trocado entre encaminhadores');
      assert.deepEqual(envelope.payload, payload);
    }
  });

  it('plugin carregado duas vezes: o mesmo payload de dois encaminhadores conta como deduped', async (t) => {
    // Os dois precisam chegar; sob sobrecarga, só vale repetir se o par esgotou prazo.
    const misses = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await server.health();
      const payload = JSON.stringify(hookPayload());
      const { value: results, samples } = await withLoadSamples(() => Promise.all([0, 1].map(() => runForwarder({ env: envFor(home), stdin: payload }))));
      results.forEach((r) => assertSilentExit(r, 'duplicado'));
      const events = await waitFor(async () => {
        const e = await server.health();
        return e.received - before.received >= 2 ? e : null;
      }, { timeoutMs: 3000, label: 'dois POST' }).catch(() => null);
      if (events) {
        assert.equal(events.accepted - before.accepted, 1);
        assert.equal(events.deduped - before.deduped, 1);
        return;
      }
      const got = (await server.health()).received - before.received;
      const runs = results.map((result, i) => ({ result, delivered: i < got }));
      // Não dá para saber qual dos dois se perdeu: exige que os 2 - got mais lentos tenham esgotado prazo.
      runs.sort((a, b) => a.result.ownMs - b.result.ownMs);
      assertLossesOnlyByDeadline(t, `duplicado (tentativa ${attempt + 1})`, runs, samples);
      misses.push(`${results.map((r) => r.ownMs.toFixed(0)).join('/')} ms (${loadFrom(samples).text})`);
    }
    t.skip(`deduplicação não avaliada: máquina sobrecarregada; nas 3 tentativas um dos envios esgotou o prazo: ${misses.join('; ')}`);
  });

  it('servidor cai no meio: encaminhadores em voo e os seguintes saem 0, em silêncio e dentro do prazo', async (t) => {
    const otherHome = newTemp('aq-int-cap-queda-');
    const other = await startRealServer({ dataDir: otherHome, env: { AGENT_QUEST_HOME: otherHome } });
    t.after(() => other.stop()); // se algo falhar antes da queda, o servidor não fica sobrando
    const { value: results, samples } = await withLoadSamples(async () => {
      const runs = [];
      for (let i = 0; i < 12; i++) runs.push(runForwarder({ env: envFor(otherHome), stdin: JSON.stringify(hookPayload()) }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      await other.stop(); // encerramento à força: o runtime.json fica com o pid morto
      for (let i = 0; i < 12; i++) runs.push(runForwarder({ env: envFor(otherHome), stdin: JSON.stringify(hookPayload()) }));
      return Promise.all(runs);
    });
    results.forEach((r, i) => assertSilentExit(r, `queda ${i}`));
    const late = results.filter((r) => r.ownMs > STUCK_LIMIT_MS).map((r) => `${r.ownMs.toFixed(0)} ms`);
    if (late.length) {
      // O prazo de 2 s é um timer do próprio processo; sob sobrecarga ele dispara atrasado.
      const load = loadFrom(samples);
      assert.ok(!load.normal, `acima de ${STUCK_LIMIT_MS} ms com a máquina normal (${load.text}): ${late.join(', ')}`);
      t.diagnostic(`máquina sobrecarregada (${load.text}): ${late.length} processo(s) acima de ${STUCK_LIMIT_MS} ms (${late.join(', ')})`);
    }
  });

  // --- sobra do npm run dev ----------------------------------------------------------

  it('sobra do npm run dev (servidor encerrado à força, como o node --watch faz): sai sem enviar, mesmo com a porta reaberta', { timeout: 120_000, skip: !isWindows && 'cenário do Windows' }, async (t) => {
    const devHome = newTemp('aq-int-cap-dev-');
    const port = await freePort();
    const dev = launchNpm(['run', 'dev', '--', '--port', String(port)], minimalEnv({ AGENT_QUEST_HOME: devHome }), { ready: /Ctrl\+C para parar\./ });
    let live;
    try {
      assert.equal(await dev.started, true, dev.output());
      live = readJson(path.join(devHome, 'runtime.json'));
      assert.equal(live.port, port);
    } finally {
      await killTree(dev.child); // encerramento à força, como o node --watch faz (e nunca fica sobrando)
    }
    await waitFor(() => !isPidAlive(live.pid), { label: 'fim do servidor do npm run dev' });
    const stale = readJson(path.join(devHome, 'runtime.json'));
    assert.deepEqual(stale, live, 'esperava a sobra do runtime.json com o pid morto');

    // Outro programa passa a escutar na porta da sobra: o encaminhador não pode tentar.
    const listener = await recordingHttpServer({ port });
    try {
      const result = await runForwarder({ env: envFor(devHome), stdin: JSON.stringify(hookPayload()), timed: false });
      assertSilentExit(result, 'sobra do npm run dev');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(listener.requests.length, 0, 'o encaminhador enviou para a porta da sobra');

      // Controle: o mesmo arquivo com um pid vivo leva o envio à porta (prova de que foi o pid que parou).
      writeRuntime(devHome, { ...stale, pid: process.pid });
      await assertDelivered(t, 'controle', async () => {
        const result = await runForwarder({ env: envFor(devHome), stdin: JSON.stringify(hookPayload()) });
        return { result, delivered: () => listener.requests.length > 0 };
      });
    } finally {
      await listener.close();
    }
  });
});

describe('T4 integração: teto do corpo de 1 000 000 bytes (modelo de eventos, seção 1)', () => {
  const MAX_BODY = 1_000_000;
  const MARKER = /…\[cortado \d+ caracteres\]…/;
  let home;
  let server;
  let recorder;
  let recorderHome;

  before(async () => {
    home = newTemp('aq-int-cap-teto-');
    server = await startRealServer({ dataDir: home, env: { AGENT_QUEST_HOME: home } });
    // Servidor de gravação: mede os bytes exatos do corpo que saiu do encaminhador.
    recorder = await recordingHttpServer();
    recorderHome = newTemp('aq-int-cap-teto-rec-');
    writeRuntime(recorderHome, { port: recorder.port, token: 't', pid: process.pid });
  });

  after(async () => {
    if (server) await server.stop();
    await recorder?.close();
    cleanupTemps();
  });

  /** Pedido gravado com este tool_use_id (o corpo cru e o envelope). */
  const recorded = (id) => {
    const req = recorder.requests.find((r) => r.body.includes(id));
    return req ? { bytes: req.bytes, text: req.body, envelope: JSON.parse(req.body) } : null;
  };

  const keys = (n, value) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, value]));

  // Casos do critério (plano, T4, ajuste de 18/10/2026), nas formas que acionam cada passo.
  const criterionCases = {
    '20 000 strings de 600 numa lista (passo 2)': () =>
      hookPayload({ hook_event_name: 'PostToolUse', tool_response: { lines: Array.from({ length: 20_000 }, () => 'x'.repeat(600)) } }),
    '20 000 strings de 600 como chaves do primeiro nível (passo 3)': () => ({ ...hookPayload({ hook_event_name: 'PostToolUse' }), ...keys(20_000, 'x'.repeat(600)) }),
    '20 000 chaves simples em tool_input, com agent_id (passo 3)': () =>
      hookPayload({ agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'tester', tool_name: 'mcp__srv__x', tool_input: keys(20_000, 'x'.repeat(600)) }),
    'lista de 50 000 nomes de arquivo (passo 2)': () =>
      hookPayload({
        hook_event_name: 'PostToolUse',
        tool_name: 'Glob',
        tool_response: { filenames: Array.from({ length: 50_000 }, (_, i) => `C:\\Users\\usuario\\proj\\src\\modulo-${i}\\arquivo-${i}.ts`) },
      }),
  };

  it('casos do critério com o servidor real: 204, truncated, ids intactos, corpo no teto e dentro do prazo de 2 s', async (t) => {
    for (const [name, make] of Object.entries(criterionCases)) {
      let payload;
      const results = [];
      const samples = [];
      const before = await server.health();
      const envelope = await assertDelivered(
        t,
        name,
        async () => {
          payload = make();
          const id = payload.tool_use_id;
          const stdin = JSON.stringify(payload);
          assert.ok(Buffer.byteLength(stdin) > 10 * 1024 * 1024 || name.startsWith('lista de 50'), `${name}: entrada pequena demais`);
          const result = await runForwarder({ env: forwarderEnv({ AGENT_QUEST_HOME: home }), stdin });
          results.push(result);
          return { result, delivered: () => server.dumped().find((e) => e.payload.tool_use_id === id) };
        },
        { samplesOut: samples },
      );
      if (!envelope) continue;
      const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
      t.diagnostic(`${name}: ${bytes} bytes, ${results.at(-1).ownMs.toFixed(0)} ms de vida`);
      assert.ok(bytes <= MAX_BODY, `${name}: corpo de ${bytes} bytes`);
      assert.equal(envelope.truncated, true, name);
      for (const key of ['hook_event_name', 'session_id', 'agent_id', 'tool_use_id']) {
        if (Object.hasOwn(payload, key)) assert.equal(envelope.payload[key], payload[key], `${name}: ${key}`);
      }
      const events = await server.health();
      assert.ok(events.accepted > before.accepted, `${name}: não foi aceito (204)`);
      assert.equal(events.rejected, before.rejected, `${name}: recusado (413?)`);
      assertLifetimeWithin(t, name, results, samples, 2000);
    }
  });

  it('limite exato: corpo de 1 000 000 bytes vai sem redução (truncated: false); com 1 byte a mais, cai para o passo 2', async (t) => {
    const projectDir = 'C:\\Users\\usuario\\Projetos\\teto exato';
    // Tamanho do corpo do passo 1, pelo formato do envelope v1 (seção 1). O sentAt
    // tem 13 dígitos (ms desde a época até o ano 2286), então o tamanho não muda.
    const bodyLength = (payload) =>
      Buffer.byteLength(
        JSON.stringify({ v: 1, sentAt: 1_760_000_000_000, forwarder: PLUGIN_VERSION, env: { projectDir, entrypoint: null }, truncated: false, payload }),
        'utf8',
      );
    for (const [label, extra] of [
      ['exatamente 1 000 000 bytes', 0],
      ['1 000 001 bytes', 1],
    ]) {
      const got = await assertDelivered(t, label, async () => {
        const payload = hookPayload({ hook_event_name: 'PostToolUse', tool_response: { lines: Array.from({ length: 243 }, () => 'a'.repeat(4096)), last: '' } });
        const missing = MAX_BODY - bodyLength(payload);
        assert.ok(missing >= 1 && missing + extra <= 4096, `ajuste fora da faixa: ${missing}`);
        payload.tool_response.last = 'a'.repeat(missing + extra);
        assert.equal(bodyLength(payload), MAX_BODY + extra);
        const result = await runForwarder({ env: forwarderEnv({ AGENT_QUEST_HOME: recorderHome, CLAUDE_PROJECT_DIR: projectDir }), stdin: JSON.stringify(payload) });
        return { result, delivered: () => recorded(payload.tool_use_id) };
      });
      if (!got) continue;
      if (extra === 0) {
        assert.equal(got.bytes, MAX_BODY, 'o corpo exato deveria ir como está');
        assert.equal(got.envelope.truncated, false);
        assert.equal(got.envelope.payload.tool_response.lines.length, 243);
      } else {
        assert.ok(got.bytes <= MAX_BODY, `${got.bytes} bytes`);
        assert.equal(got.envelope.truncated, true);
        assert.equal(got.envelope.payload.tool_response.lines.length, 100, 'passo 2: listas com os 100 primeiros');
        assert.match(got.envelope.payload.tool_response.lines[0], MARKER, 'passo 2: strings acima de 512 cortadas');
      }
    }
  });

  it('Unicode e escapes: o teto conta os bytes UTF-8 do corpo de verdade, e nenhum corte parte surrogate', async (t) => {
    const BACKSLASH = String.fromCharCode(92);
    // Cerca de 12 a 15 MiB no stdin cada (abaixo dos 16 MiB), em chaves do primeiro nível (passo 3).
    const cases = {
      'CJK (3 bytes por unidade)': [1200, '中'.repeat(4096), true],
      'emoji (4 bytes por par)': [1800, '😀'.repeat(2048), true],
      'emoji desalinhado (par na borda dos cortes)': [1800, `a${'😀'.repeat(2047)}b`, true],
      'surrogate solto (6 bytes no JSON)': [600, '\uD800'.repeat(4096), false],
      'caracteres de controle (6 bytes no JSON)': [600, '\u0001'.repeat(4096), true],
      'aspas e barras (2 bytes no JSON)': [1500, `"${BACKSLASH}`.repeat(2048), true],
    };
    for (const [name, [count, value, wellFormed]] of Object.entries(cases)) {
      const results = [];
      const samples = [];
      let payload;
      const got = await assertDelivered(
        t,
        name,
        async () => {
          payload = { ...hookPayload({ hook_event_name: 'PostToolUse' }), ...keys(count, value) };
          const stdin = JSON.stringify(payload);
          assert.ok(Buffer.byteLength(stdin) < 16 * 1024 * 1024, `${name}: stdin acima de 16 MiB`);
          const result = await runForwarder({ env: forwarderEnv({ AGENT_QUEST_HOME: recorderHome }), stdin });
          results.push(result);
          return { result, delivered: () => recorded(payload.tool_use_id) };
        },
        { samplesOut: samples },
      );
      if (!got) continue;
      t.diagnostic(`${name}: ${got.bytes} bytes, ${Object.keys(got.envelope.payload).length} chaves, ${results.at(-1).ownMs.toFixed(0)} ms de vida`);
      assert.ok(got.bytes <= MAX_BODY, `${name}: ${got.bytes} bytes`);
      assert.equal(got.envelope.truncated, true);
      assert.equal(got.envelope.payload.session_id, payload.session_id);
      assert.equal(got.envelope.payload.hook_event_name, payload.hook_event_name);
      const values = Object.entries(got.envelope.payload).filter(([k]) => /^k\d+$/.test(k)).map(([, v]) => v);
      assert.ok(values.length > 0, `${name}: nenhum valor coube`);
      for (const v of values) {
        assert.match(v, MARKER, `${name}: valor sem o marcador de corte`);
        if (wellFormed) assert.ok(v.isWellFormed(), `${name}: par de surrogates partido`);
      }
      assertLifetimeWithin(t, name, results, samples, 2000);
    }
  });

  it('passo 3: ordem do envelope mínimo (obrigatórios, prioritários, demais do primeiro nível, tool_input) e só valores simples', async (t) => {
    const cut600 = `${'x'.repeat(128)}…[cortado 88 caracteres]…${'x'.repeat(384)}`;
    for (const withAgent of [true, false]) {
      const label = withAgent ? 'com agent_id' : 'sem agent_id';
      let expected;
      const got = await assertDelivered(t, label, async () => {
        const n = hookPayload();
        // Ordem de propósito embaralhada; tool_response força o passo 3 e sai nele.
        const payload = {
          zeta: 'z',
          tool_input: { b: 2, a: 'x'.repeat(600), aninhado: { c: 1 }, lista: [1] },
          cwd: 'C:\\Users\\usuario\\Projetos\\ordem',
          lista: [1, 2, 3],
          agent_type: 'tester',
          alfa: true,
          session_id: n.session_id,
          trigger: 'manual',
          ...(withAgent ? { agent_id: 'a1b2c3d4e5f6a7b8c' } : {}),
          nulo: null,
          hook_event_name: 'PreToolUse',
          tool_response: keys(20_000, 'y'.repeat(600)),
          tool_name: 'Bash',
          tool_use_id: n.tool_use_id,
          numero: 42,
        };
        expected = [
          ['hook_event_name', 'PreToolUse'],
          ['session_id', payload.session_id],
          ...(withAgent ? [['agent_id', 'a1b2c3d4e5f6a7b8c']] : []),
          ['agent_type', 'tester'],
          ['tool_name', 'Bash'],
          ['tool_use_id', payload.tool_use_id],
          ['cwd', payload.cwd],
          ['trigger', 'manual'],
          ['zeta', 'z'],
          ['alfa', true],
          ['nulo', null],
          ['numero', 42],
          ['tool_input', { b: 2, a: cut600 }],
        ];
        const result = await runForwarder({ env: forwarderEnv({ AGENT_QUEST_HOME: recorderHome }), stdin: JSON.stringify(payload) });
        return { result, delivered: () => recorded(payload.tool_use_id) };
      });
      if (!got) continue;
      assert.equal(got.envelope.truncated, true);
      assert.deepEqual(Object.keys(got.envelope.payload), expected.map(([k]) => k), `${label}: ordem das chaves`);
      assert.deepEqual(Object.keys(got.envelope.payload.tool_input), ['b', 'a'], `${label}: ordem em tool_input`);
      assert.deepEqual(Object.entries(got.envelope.payload), expected, `${label}: valores`);
    }
  });

  it('aninhamento extremo (10 000 níveis) num payload acima do teto: sai 0 e em silêncio, e nada acima do teto sai', async (t) => {
    let nested = '"fim"';
    for (let i = 0; i < 10_000; i++) nested = `{"a":${nested}}`;
    const id = hookPayload().tool_use_id;
    const pad = Array.from({ length: 300 }, () => `"${'p'.repeat(4000)}"`).join(',');
    const stdin = `{"session_id":"sessao-aninhada","hook_event_name":"PostToolUse","tool_use_id":"${id}","d":${nested},"pad":[${pad}]}`;
    const result = await runForwarder({ env: forwarderEnv({ AGENT_QUEST_HOME: recorderHome }), stdin });
    assertSilentExit(result, 'aninhamento extremo');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const got = recorded(id);
    if (got) assert.ok(got.bytes <= MAX_BODY, `${got.bytes} bytes`);
    // Pela seção 1, o passo 3 levaria um envelope mínimo; hoje o evento não é enviado (relatório do tester, T4).
    t.diagnostic(got ? `enviado com ${got.bytes} bytes` : 'não enviado (a redução lança antes do passo 3)');
  });
});

describe('T4 integração: o servidor real e o encaminhador acham o mesmo diretório de dados', () => {
  after(() => cleanupTemps());

  it('sem AGENT_QUEST_HOME, pelo LOCALAPPDATA (uso normal), com espaço e acento no caminho', { skip: !isWindows && 'LOCALAPPDATA é do Windows' }, async (t) => {
    const local = newTemp('aq int local ção-');
    const dataDir = path.join(local, 'agent-quest');
    const real = await startRealServer({ dataDir, env: { LOCALAPPDATA: local } });
    try {
      let payload;
      const envelope = await assertDelivered(t, 'LOCALAPPDATA', async () => {
        payload = hookPayload();
        const id = payload.tool_use_id;
        const result = await runForwarder({ env: forwarderEnv({ LOCALAPPDATA: local }), stdin: JSON.stringify(payload) });
        return { result, delivered: () => real.dumped().find((e) => e.payload.tool_use_id === id) };
      });
      if (envelope) assert.deepEqual(envelope.payload, payload);
    } finally {
      await real.stop();
    }
  });

  it('AGENT_QUEST_HOME vazia vale como não definida, nos dois lados', { skip: !isWindows && 'LOCALAPPDATA é do Windows' }, async (t) => {
    const local = newTemp('aq-int-local-vazia-');
    const dataDir = path.join(local, 'agent-quest');
    const real = await startRealServer({ dataDir, env: { LOCALAPPDATA: local, AGENT_QUEST_HOME: '' } });
    try {
      await assertDelivered(t, 'AGENT_QUEST_HOME vazia', async () => {
        const id = hookPayload().tool_use_id;
        const result = await runForwarder({ env: forwarderEnv({ LOCALAPPDATA: local, AGENT_QUEST_HOME: '' }), stdin: JSON.stringify(hookPayload({ tool_use_id: id })) });
        return { result, delivered: () => real.dumped().find((e) => e.payload.tool_use_id === id) };
      });
    } finally {
      await real.stop();
    }
  });

  it('AGENT_QUEST_HOME diferente nos dois lados: o encaminhador não acha o servidor e sai em silêncio', async () => {
    const serverHome = newTemp('aq-int-home-a-');
    const otherHome = newTemp('aq-int-home-b-');
    const real = await startRealServer({ dataDir: serverHome, env: { AGENT_QUEST_HOME: serverHome } });
    try {
      const before = await real.health();
      assertSilentExit(await runForwarder({ env: forwarderEnv({ AGENT_QUEST_HOME: otherHome }), stdin: JSON.stringify(hookPayload()), timed: false }), 'homes diferentes');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((await real.health()).received, before.received);
    } finally {
      await real.stop();
    }
  });
});
