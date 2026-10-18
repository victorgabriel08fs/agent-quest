// @ts-check
// Apaga o diretório de dados temporário dos testes ponta a ponta
// (AGENT_QUEST_HOME escolhido no playwright.config.js).

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export default function globalTeardown() {
  const home = process.env.AQ_E2E_HOME;
  // Só apaga o que o config criou: uma pasta aq-e2e-* dentro da pasta temporária.
  if (!home || path.dirname(home) !== tmpdir() || !path.basename(home).startsWith('aq-e2e-')) return;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // o servidor pode ainda estar saindo no Windows; a pasta temporária fica para o sistema limpar
  }
}
