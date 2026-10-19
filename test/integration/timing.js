// Regras de tempo dos testes de integração (tester), conforme o ADR 0010,
// complemento de 19/10/2026 ("testes de tempo estáveis"). Não é arquivo de teste.
//
// - O custo de uma operação longa é comparado com uma calibração da mesma
//   operação, sobre uma entrada de referência, medida no mesmo processo logo
//   antes (intercalada), pela razão e com o melhor de N. Nunca por um número
//   absoluto nem por uma mediana medida em outro momento.
// - A razão tem piso de 1 ms no denominador; o limite absoluto é só um teto
//   largo, para uma regressão muito lenta falhar sem esperar N rodadas.
// - Uma nova tentativa em caso de ruído da máquina; falhar duas vezes seguidas é falha.

import { performance } from 'node:perf_hooks';

/** Tempo de uma execução de `run(input)`, em ms. */
function once(run, input) {
  const begin = performance.now();
  run(input);
  return performance.now() - begin;
}

/**
 * Melhor de N da referência e da entrada grande, intercaladas, para as duas
 * verem a mesma disputa de CPU.
 * @param {(input: any) => unknown} run
 * @param {any} small
 * @param {any} big
 * @param {number} n
 */
export function bestPair(run, small, big, n) {
  once(run, small); // aquecimento
  let smallMs = Infinity;
  let bigMs = Infinity;
  for (let i = 0; i < n; i++) {
    smallMs = Math.min(smallMs, once(run, small));
    bigMs = Math.min(bigMs, once(run, big));
  }
  return { smallMs, bigMs, ratio: bigMs / Math.max(smallMs, 1) };
}

/**
 * Crescimento dentro de `maxRatio`: t(grande) / max(t(referência), 1 ms), com
 * o melhor de `n` e, se passar do limite, uma nova tentativa com `retryN`.
 * @param {(input: any) => unknown} run
 * @param {any} small        entrada de referência (a mesma forma, menor)
 * @param {any} big
 * @param {{ maxRatio: number, n?: number, retryN?: number, ceilingMs?: number }} options
 * @returns {{ ok: boolean, text: string }}
 */
export function growthWithin(run, small, big, { maxRatio, n = 5, retryN = 9, ceilingMs = 5000 }) {
  const first = once(run, big); // também aquece a entrada grande
  if (first > ceilingMs) return { ok: false, text: `uma execução levou ${first.toFixed(0)} ms (teto largo de ${ceilingMs} ms)` };
  const describe = (m) => `razão ${m.ratio.toFixed(1)} (${m.bigMs.toFixed(1)} ms contra ${m.smallMs.toFixed(2)} ms)`;
  const a = bestPair(run, small, big, n);
  if (a.ratio <= maxRatio) return { ok: true, text: describe(a) };
  const b = bestPair(run, small, big, retryN);
  return {
    ok: b.ratio <= maxRatio,
    text: `${describe(a)} e, na nova tentativa, ${describe(b)}; limite ${maxRatio}`,
  };
}
