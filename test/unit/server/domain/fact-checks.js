// Conferências comuns a todo fato do normalizador (modelo de eventos, seção 10).
// Não é arquivo de teste (não termina em .test.js).

import assert from 'node:assert/strict';
import { charLength, redact, stripInvisible } from '../../../../server/domain/redact.js';

/** Chaves que nunca podem aparecer num fato, em nenhuma profundidade (seção 10). */
export const FORBIDDEN_KEYS = [
  'content',
  'old_string',
  'new_string',
  'stdout',
  'stderr',
  'tool_input',
  'tool_response',
  'last_assistant_message',
];

/**
 * Caminhos guardados: as únicas exceções ao teto de 200, até 1024
 * (modelo de eventos, seção 2, "Forma do fato e limites").
 */
export const STORED_PATH_FIELDS = ['projectDir', 'transcriptPath', 'agentTranscriptPath'];

/** Campos de texto exibidos no painel: todos precisam ser ponto fixo de `redact`. */
export const DISPLAYED_FIELDS = [
  'tool',
  'target',
  'detail',
  'title',
  'error',
  'sessionTitle',
  'model',
  'agentType',
  'subagentType',
  'description',
  'projectDir',
];

/** Percorre o fato e devolve [caminho, chave, valor] de cada folha. */
function* walk(value, at = 'fato') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walk(value[i], `${at}[${i}]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield [`${at}.${key}`, key, item];
      yield* walk(item, `${at}.${key}`);
    }
  }
}

/**
 * Confere as regras da seção 10 num fato:
 * - nenhuma chave proibida;
 * - nenhuma string acima de 200 caracteres (charLength), menos os caminhos
 *   guardados do topo do fato, até 1024;
 * - campos exibidos são ponto fixo de redact.
 */
export function assertFactInvariants(fact, label = '') {
  for (const [where, key, value] of walk(fact)) {
    assert.ok(!FORBIDDEN_KEYS.includes(key), `${label} ${where}: chave proibida`);
    if (typeof value === 'string') {
      const limit = STORED_PATH_FIELDS.includes(key) && where === `fato.${key}` ? 1024 : 200;
      assert.ok(charLength(value) <= limit, `${label} ${where}: string com ${charLength(value)} caracteres`);
    }
  }
  // Todo texto exibido é ponto fixo de redact, inclusive identificadores (seção 2).
  for (const field of DISPLAYED_FIELDS) {
    const value = fact[field];
    if (typeof value === 'string') assert.equal(redact(value), value, `${label} ${field} não é ponto fixo de redact`);
  }
  for (const task of fact.backgroundTasks ?? []) {
    for (const field of ['type', 'status', 'agentType']) {
      if (typeof task[field] === 'string') assert.equal(redact(task[field]), task[field], `${label} backgroundTasks.${field}`);
    }
  }
  // Valores crus (*Key): só uso interno, sem invisíveis e controles, até 128.
  const keys = [fact.agentTypeKey, fact.subagentTypeKey, ...(fact.backgroundTasks ?? []).map((task) => task.agentTypeKey)];
  for (const key of keys) {
    if (key === null || key === undefined) continue;
    assert.equal(typeof key, 'string', `${label} *Key`);
    assert.ok(charLength(key) <= 128 && key !== '', `${label} *Key com ${charLength(key)} caracteres`);
    assert.equal(stripInvisible(key), key, `${label} *Key com invisíveis ou controles`);
  }
}

/** Gerador pseudoaleatório determinístico (mulberry32), para testes reproduzíveis. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
