import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENVELOPE_VERSION, MAX_BODY_BYTES, parseEnvelope, validateEnvelope } from '../../../../server/ingest/envelope.js';

const payload = { hook_event_name: 'PreToolUse', session_id: 'sessao-1', tool_name: 'Read' };

describe('constantes do envelope', () => {
  it('versão 1 e corpo de até 1 MiB', () => {
    assert.equal(ENVELOPE_VERSION, 1);
    assert.equal(MAX_BODY_BYTES, 1_048_576);
  });
});

describe('parseEnvelope', () => {
  it('aceita o envelope v1 completo da seção 1 e devolve o objeto como chegou', () => {
    const envelope = {
      v: 1,
      sentAt: 1_760_731_234_567,
      forwarder: '0.1.0',
      env: { projectDir: '<repo>', entrypoint: null },
      truncated: false,
      payload,
    };
    assert.deepEqual(parseEnvelope(JSON.stringify(envelope)), { ok: true, envelope });
  });

  it('aceita o mínimo: v, payload.session_id e payload.hook_event_name', () => {
    const result = parseEnvelope(JSON.stringify({ v: 1, payload: { session_id: 's', hook_event_name: 'Stop' } }));
    assert.equal(result.ok, true);
  });

  it('JSON inválido ou vazio', () => {
    for (const text of ['', '{', '{"v":1,', 'nada', '﻿{"v":1}']) {
      assert.deepEqual(parseEnvelope(text), { ok: false, error: 'json' }, JSON.stringify(text));
    }
  });

  it('JSON que não é objeto', () => {
    for (const text of ['null', '1', '"texto"', 'true', '[]', '[{"v":1}]']) {
      assert.deepEqual(parseEnvelope(text), { ok: false, error: 'not-object' }, text);
    }
  });
});

describe('validateEnvelope', () => {
  const cases = [
    ['sem v', { payload }, 'version'],
    ['v: 2', { v: 2, payload }, 'version'],
    ['v: "1"', { v: '1', payload }, 'version'],
    ['v: 1.5', { v: 1.5, payload }, 'version'],
    ['sem payload', { v: 1 }, 'payload'],
    ['payload null', { v: 1, payload: null }, 'payload'],
    ['payload lista', { v: 1, payload: [payload] }, 'payload'],
    ['payload texto', { v: 1, payload: JSON.stringify(payload) }, 'payload'],
    ['sem session_id', { v: 1, payload: { hook_event_name: 'Stop' } }, 'session_id'],
    ['session_id vazio', { v: 1, payload: { ...payload, session_id: '' } }, 'session_id'],
    ['session_id número', { v: 1, payload: { ...payload, session_id: 42 } }, 'session_id'],
    ['sem hook_event_name', { v: 1, payload: { session_id: 's' } }, 'hook_event_name'],
    ['hook_event_name vazio', { v: 1, payload: { ...payload, hook_event_name: '' } }, 'hook_event_name'],
    ['hook_event_name objeto', { v: 1, payload: { ...payload, hook_event_name: {} } }, 'hook_event_name'],
  ];
  for (const [label, value, error] of cases) {
    it(`recusa: ${label}`, () => {
      assert.deepEqual(validateEnvelope(value), { ok: false, error });
    });
  }

  it('não confere o resto: o normalizador (T5) trata campos ausentes ou com tipo errado', () => {
    const value = { v: 1, sentAt: 'ontem', env: 3, truncated: 'sim', payload: { ...payload, tool_input: null } };
    assert.equal(validateEnvelope(value).ok, true);
  });
});
