// @ts-check
// Ponta a ponta (ADR 0010): @playwright/test com o Microsoft Edge já instalado
// (channel 'msedge'), sem baixar navegadores. Comando: npm run test:e2e.
//
// O servidor real (server/main.js) sobe numa porta livre e com
// AGENT_QUEST_HOME temporário, nunca na 47821 nem no diretório de dados real
// (plano, "Definição de pronto"). Porta e diretório são escolhidos uma vez, no
// processo principal, e chegam aos workers pelas variáveis de ambiente.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { defineConfig } from '@playwright/test';

if (!process.env.AQ_E2E_PORT) {
  // Porta livre escolhida pelo sistema (o servidor só aceita 0 ou 1024 a 65535,
  // e com 0 a porta real só sai no runtime.json; aqui ela precisa ser conhecida antes).
  process.env.AQ_E2E_PORT = execFileSync(process.execPath, ['-e',
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
  ], { encoding: 'utf8' }).trim();
}
if (!process.env.AQ_E2E_HOME) {
  process.env.AQ_E2E_HOME = mkdtempSync(path.join(tmpdir(), 'aq-e2e-'));
}

const port = Number(process.env.AQ_E2E_PORT);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.js',
  outputDir: 'test-results',
  reporter: 'list',
  retries: 0,
  globalTeardown: './test/e2e/global-teardown.js',
  use: {
    baseURL,
    channel: 'msedge',
    headless: true,
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'edge', use: { channel: 'msedge' } }],
  webServer: {
    command: `node server/main.js --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
    // USERPROFILE e HOME também na pasta temporária: o servidor de teste não lê
    // o ~/.claude real (agentes e transcripts da sonda de contexto do T15).
    env: { ...process.env, AGENT_QUEST_HOME: process.env.AQ_E2E_HOME, USERPROFILE: process.env.AQ_E2E_HOME, HOME: process.env.AQ_E2E_HOME },
  },
});
