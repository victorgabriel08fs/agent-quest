import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEDUPE_WINDOW_MS, NOT_DEDUPED_HOOKS, createDedupe, payloadHash, skipsDedupe } from '../../../../server/ingest/dedupe.js';

const T0 = 1_760_000_000_000;

describe('payloadHash', () => {
  it('igual para payloads iguais, diferente para payloads diferentes', () => {
    const a = { hook_event_name: 'PreToolUse', session_id: 's', tool_use_id: 'toolu_1' };
    assert.equal(payloadHash(a), payloadHash(structuredClone(a)));
    assert.notEqual(payloadHash(a), payloadHash({ ...a, tool_use_id: 'toolu_2' }));
  });

  it('não carrega o conteúdo: é um SHA-256 em base64url', () => {
    const hash = payloadHash({ session_id: 'segredo-123' });
    assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(hash, /segredo/);
  });
});

describe('skipsDedupe (seção 8, "Duplicatas", 19/10/2026)', () => {
  it('só o PermissionRequest fica fora da deduplicação', () => {
    assert.deepEqual(NOT_DEDUPED_HOOKS, ['PermissionRequest']);
    assert.equal(skipsDedupe({ hook_event_name: 'PermissionRequest', session_id: 's' }), true);
    for (const hook of ['PreToolUse', 'PostToolUse', 'PermissionDenied', 'Notification', 'permissionrequest', '']) {
      assert.equal(skipsDedupe({ hook_event_name: hook }), false, hook);
    }
    for (const payload of [null, undefined, 'PermissionRequest', [], {}, { hook_event_name: ['PermissionRequest'] }]) {
      assert.equal(skipsDedupe(payload), false, JSON.stringify(payload));
    }
  });
});

describe('createDedupe (relógio injetado)', () => {
  it('janela de 5 s', () => {
    assert.equal(DEDUPE_WINDOW_MS, 5000);
  });

  it('o mesmo payload em até 5 s é duplicata; depois de 5 s, é aceito de novo', () => {
    const dedupe = createDedupe();
    assert.equal(dedupe.isDuplicate('h', T0), false);
    assert.equal(dedupe.isDuplicate('h', T0 + 1), true);
    assert.equal(dedupe.isDuplicate('h', T0 + 4999), true);
    assert.equal(dedupe.isDuplicate('h', T0 + 5000), true);
    assert.equal(dedupe.isDuplicate('h', T0 + 5001), false);
    assert.equal(dedupe.isDuplicate('h', T0 + 5002), true);
  });

  it('a janela conta da ocorrência aceita: duplicatas não a prolongam', () => {
    const dedupe = createDedupe();
    assert.equal(dedupe.isDuplicate('h', T0), false);
    assert.equal(dedupe.isDuplicate('h', T0 + 3000), true);
    assert.equal(dedupe.isDuplicate('h', T0 + 5001), false);
  });

  it('payloads diferentes não interferem', () => {
    const dedupe = createDedupe();
    assert.equal(dedupe.isDuplicate('a', T0), false);
    assert.equal(dedupe.isDuplicate('b', T0 + 1), false);
    assert.equal(dedupe.isDuplicate('a', T0 + 2), true);
    assert.equal(dedupe.isDuplicate('b', T0 + 5001), true);
    assert.equal(dedupe.isDuplicate('a', T0 + 5001), false);
  });

  it('esquece o que saiu da janela: a memória não cresce sem limite', () => {
    const dedupe = createDedupe();
    for (let i = 0; i < 1000; i++) dedupe.isDuplicate(`h${i}`, T0 + i);
    assert.equal(dedupe.size(), 1000);
    dedupe.isDuplicate('novo', T0 + 999 + 5001);
    assert.equal(dedupe.size(), 1);
  });

  it('janela configurável', () => {
    const dedupe = createDedupe({ windowMs: 100 });
    assert.equal(dedupe.isDuplicate('h', T0), false);
    assert.equal(dedupe.isDuplicate('h', T0 + 100), true);
    assert.equal(dedupe.isDuplicate('h', T0 + 101), false);
  });

  it('relógio do sistema voltando: recomeça do zero, sem duplicata presa no futuro', () => {
    const dedupe = createDedupe();
    assert.equal(dedupe.isDuplicate('a', T0), false);
    assert.equal(dedupe.isDuplicate('b', T0 - 60_000), false);
    assert.equal(dedupe.size(), 1);
    assert.equal(dedupe.isDuplicate('a', T0 - 59_000), false);
    assert.equal(dedupe.isDuplicate('b', T0 - 58_000), true);
  });
});
