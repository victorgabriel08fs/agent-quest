// Contraste das cores de texto nos dois temas (complemento do ADR 0009,
// WCAG 2.2 AA): lê web/css/themes.css, resolve as variáveis e calcula cada par
// texto/fundo em que a cor aparece no painel. Fundos translúcidos (--*-soft)
// são compostos sobre o fundo em que ficam.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS_DIR = fileURLToPath(new URL('../../../web/css/', import.meta.url));
const THEMES_CSS = readFileSync(path.join(CSS_DIR, 'themes.css'), 'utf8');

/** Mínimos do critério: texto normal, texto grande e indicador não textual. */
const NORMAL = 4.5;
const LARGE = 3;
const GRAPHIC = 3;

/**
 * Pares usados no painel: [cor do texto, fundo, mínimo, onde aparece].
 * O fundo é uma variável ou "translúcida/base". A barra superior é
 * semitransparente sobre --bg; o brilho do fundo tinge menos de 15% e entra
 * como --bg.
 */
const PAIRS = [
  ['--text', '--bg', NORMAL, 'marca, rótulo da sessão e seletor no topo'],
  ['--text', '--surface', NORMAL, 'texto dos cartões'],
  ['--text', '--surface-3', NORMAL, 'código, comandos e tipo do convidado'],
  ['--text', '--warn-soft/--surface', NORMAL, 'linha de aprovação no feed'],
  ['--text', '--bad-soft/--surface', NORMAL, 'linha de falha no feed'],
  ['--text', '--good-soft/--surface', NORMAL, 'linha de sucesso no feed'],
  ['--muted', '--bg', NORMAL, 'projeto, indicadores, selo e rodapé'],
  ['--muted', '--surface', NORMAL, 'papel real, ação ociosa, rótulos e legenda'],
  ['--muted', '--surface-2', NORMAL, 'texto secundário em superfície alternativa'],
  ['--muted', '--surface-3', NORMAL, 'botões de tema e números do stepper'],
  ['--muted', '--warn-soft/--surface', NORMAL, 'horário da linha de aprovação'],
  ['--muted', '--bad-soft/--surface', NORMAL, 'horário da linha de falha'],
  ['--muted', '--good-soft/--surface', NORMAL, 'horário da linha de sucesso'],
  ['--accent', '--surface', NORMAL, 'título pequeno do ticket'],
  ['--warn-text', '--bg', NORMAL, 'selo "reconectando"'],
  ['--warn-text', '--surface', NORMAL, 'agente aguardando aprovação'],
  ['--warn-text', '--warn-soft/--bg', NORMAL, 'indicador de aprovação pendente'],
  ['--warn-text', '--warn-soft/--surface', NORMAL, 'aviso sobre fundo de aviso'],
  ['--bad-text', '--bg', NORMAL, 'selo "ao vivo"'],
  ['--bad-text', '--surface', NORMAL, 'erro do ticket e falha ao consultar o servidor'],
  ['--bad-text', '--bad-soft/--surface', NORMAL, 'código do erro do ticket'],
  ['--good-text', '--surface', NORMAL, 'texto de sucesso'],
  ['--good-text', '--good-soft/--surface', NORMAL, 'texto de sucesso sobre fundo de sucesso'],
  ['--gold-text', '--surface', NORMAL, 'texto dourado'],
  ['--gold-text', '--gold-soft/--surface', NORMAL, 'texto dourado sobre fundo dourado'],
  ['--muted', '--surface', LARGE, 'título do ticket vazio (24 px)'],
  ['--muted', '--room-base', NORMAL, 'nome da sala na cena'],
  ...['--c-orq', '--c-arq', '--c-dev', '--c-tes', '--c-doc', '--c-idle'].map((tint) =>
    ['--muted', `${tint}*0.12/--room-base`, NORMAL, `nome da sala sobre o topo tingido (${tint})`]),
  ['--bubble-fg', '--bubble-bg', NORMAL, 'texto do balão na cena'],
  ['--text', '--room-base', NORMAL, '"+N" e nome do token na cena'],
  ['--surface', '--good', GRAPHIC, 'marca ✓ da etapa concluída'],
];

/**
 * Variáveis de um tema, como texto.
 * @param {string} id
 * @returns {Map<string, string>}
 */
function themeVars(id) {
  const start = THEMES_CSS.indexOf(`:root[data-theme="${id}"]`);
  assert.ok(start >= 0, `tema ${id} não encontrado em themes.css`);
  const body = THEMES_CSS.slice(THEMES_CSS.indexOf('{', start) + 1, THEMES_CSS.indexOf('\n}', start));
  const vars = new Map();
  for (const declaration of body.split(';')) {
    const match = declaration.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (match) vars.set(match[1], match[2]);
  }
  return vars;
}

/**
 * Cor RGBA de uma variável (hex, rgb, rgba ou var()).
 * @param {Map<string, string>} vars
 * @param {string} name
 * @returns {[number, number, number, number]}
 */
function colorOf(vars, name) {
  let value = vars.get(name);
  assert.ok(value, `variável ${name} ausente`);
  for (let depth = 0; value.startsWith('var('); depth++) {
    assert.ok(depth < 5, `var() circular em ${name}`);
    value = vars.get(value.slice(4, -1).trim()) ?? '';
  }
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)).concat(1);
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  assert.ok(rgb, `${name}: cor não reconhecida (${value})`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
}

/** Compõe a cor (com alfa) sobre um fundo opaco. */
function over([r, g, b, a], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

/**
 * Fundo de um par: variável opaca, "translúcida/base" ou "cor*alfa/base"
 * (mistura, como o color-mix das salas).
 */
function background(vars, spec) {
  const [topSpec, base] = spec.split('/');
  const [top, alpha] = topSpec.split('*');
  const color = colorOf(vars, top);
  if (alpha !== undefined) color[3] = Number(alpha);
  if (!base) return over(color, [255, 255, 255]);
  return over(color, over(colorOf(vars, base), [255, 255, 255]));
}

/** Luminância relativa (WCAG 2.x). */
function luminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Razão de contraste entre duas cores opacas. */
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('contraste das cores de texto (ADR 0009)', () => {
  it('a conta confere com valores conhecidos', () => {
    assert.equal(Math.round(ratio([0, 0, 0], [255, 255, 255]) * 10) / 10, 21);
    assert.equal(Math.round(ratio([119, 119, 119], [255, 255, 255]) * 100) / 100, 4.48);
  });

  for (const id of ['escritorio', 'guilda']) {
    const vars = themeVars(id);
    for (const [text, bg, min, where] of PAIRS) {
      it(`${id}: ${text} sobre ${bg} ≥ ${min}:1 (${where})`, () => {
        const fg = over(colorOf(vars, text), background(vars, bg));
        const value = ratio(fg, background(vars, bg));
        assert.ok(value >= min, `${value.toFixed(2)}:1`);
      });
    }
  }
});

describe('uso das cores no CSS', () => {
  const files = readdirSync(CSS_DIR).filter((name) => name.endsWith('.css'));

  it('texto não usa tons vivos nem --faint (eles ficam em pontos, bordas, barras e fundos)', () => {
    const vivid = /(?:^|[{;\s])color\s*:\s*[^;}]*var\(--(faint|warn|bad|good|gold|hp|mana|agent|c-[a-z]+)\)/;
    for (const name of files) {
      const css = readFileSync(path.join(CSS_DIR, name), 'utf8');
      for (const rule of css.split('}')) assert.doesNotMatch(rule, vivid, `${name}: ${rule.trim()}`);
    }
  });

  it('as variáveis de texto existem nos dois temas', () => {
    for (const id of ['escritorio', 'guilda']) {
      const vars = themeVars(id);
      for (const name of ['--text', '--muted', '--accent', '--warn-text', '--bad-text', '--good-text', '--gold-text']) {
        assert.ok(vars.has(name), `${id}: ${name}`);
      }
    }
  });
});
