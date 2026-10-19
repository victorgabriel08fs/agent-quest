// Cenários de hooks no formato do ADR 0010 (complemento "formato e sanitização
// dos cenários de hooks"): { name, description, events: [{ dt, env, payload }] }.
// Não é arquivo de teste (não termina em .test.js).
//
// - `syntheticScenario()`: a sessão SINTÉTICA da sonda (test/unit/tools/probe-synthetic.js),
//   convertida para o formato dos cenários. Fica só em memória: nada sintético
//   vai para test/fixtures/hooks/ (plano, T5, condição 4).
// - `loadFixtureScenarios()`: os cenários reais do T0, sanitizados, quando existirem.
// - `scenarioEnvelopes()`: envelope v1 de cada evento, como o injetor (T9b) monta.
//
// Quando as fixtures do T0 chegarem, os testes por tabela trocam
// `syntheticScenario()` por `loadFixtureScenarios()` sem mudar o resto.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntheticProbe, HOME } from '../../tools/probe-synthetic.js';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/hooks/', import.meta.url));

/** Pasta pessoal da sessão sintética (fictícia). */
export const SYNTHETIC_HOME = HOME;

/**
 * A sessão sintética da sonda no formato dos cenários.
 * @returns {{ name: string, description: string, synthetic: true, events: { dt: number, env: { projectDir: string|null, entrypoint: string|null }, payload: object }[] }}
 */
export function syntheticScenario() {
  const { records } = buildSyntheticProbe();
  let previous = null;
  const events = records.map((record) => {
    const dt = previous === null ? 0 : Math.max(0, record.writtenAt - previous);
    previous = record.writtenAt;
    const values = record.env?.values ?? {};
    return {
      dt,
      env: { projectDir: values.CLAUDE_PROJECT_DIR ?? null, entrypoint: values.CLAUDE_CODE_ENTRYPOINT ?? null },
      payload: record.payload,
    };
  });
  return {
    name: 'sintetico-roteiro-t0',
    description: 'SINTÉTICO: roteiro do T0 montado a partir da documentação dos hooks, não é captura real',
    synthetic: true,
    events,
  };
}

/**
 * Cenários reais em test/fixtures/hooks/*.json, em ordem de nome.
 * @returns {{ file: string, scenario: { name: string, description: string, events: { dt: number, env: object, payload: object }[] } }[]}
 */
export function loadFixtureScenarios() {
  let names;
  try {
    names = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({
    file: name,
    scenario: JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')),
  }));
}

/**
 * Envelope v1 de cada evento, com `sentAt` e `receivedAt` respeitando `dt`.
 * @param {{ events: { dt: number, env: object, payload: object }[] }} scenario
 * @param {{ start?: number }} [options]
 */
export function scenarioEnvelopes(scenario, { start = 1_760_000_000_000 } = {}) {
  let time = start;
  return scenario.events.map((event, index) => {
    time += Number.isFinite(event.dt) && event.dt > 0 ? event.dt : 0;
    return {
      index,
      event,
      receivedAt: time,
      envelope: { v: 1, sentAt: time, forwarder: '0.1.0', env: event.env, truncated: false, payload: event.payload },
    };
  });
}
