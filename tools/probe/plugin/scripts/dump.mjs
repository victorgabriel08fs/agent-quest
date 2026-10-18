// Sonda do T0 (descartável): grava o payload bruto de cada hook do Claude Code
// em <dados>/probe/events.jsonl, onde <dados> é AGENT_QUEST_HOME, se definido,
// ou %LOCALAPPDATA%\agent-quest (ADR 0005). Roda como hook `command`
// assíncrono do plugin agent-quest-probe, um processo por evento.
//
// Regras (ADR 0001): nunca escreve em stdout nem em stderr, sempre sai com
// código 0 e se encerra sozinho, mesmo que o stdin nunca feche. Usa só APIs
// do Node 18 ou mais novo e não importa nada do repositório.
//
// Cada linha gravada:
//   { probe: 1, receivedAt, writtenAt, bytes, env: { names, values }, payload }
// Se o stdin vier vazio, inválido ou grande demais, a linha não tem `payload`
// e traz `error` ('empty', 'invalid-json', 'too-large', 'stdin-timeout' ou
// 'stdin-error'), mais `head` (início do texto) ou `hookEventName`.
//
// - receivedAt: Date.now() no início do processo (equivale ao sentAt do encaminhador);
// - writtenAt: Date.now() logo antes de gravar (equivale à chegada no servidor);
// - bytes: tamanho do stdin em bytes;
// - env.names: só os nomes das variáveis CLAUDE*, TERM_PROGRAM*, VSCODE_* e WT_SESSION;
// - env.values: valores só de CLAUDE_PROJECT_DIR e das variáveis que podem
//   indicar terminal ou VS Code (CLAUDE_CODE_ENTRYPOINT e TERM_PROGRAM).

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const receivedAt = Date.now();

const MAX_STDIN_BYTES = 16 * 1024 * 1024;
const DEADLINE_MS = 3000;
const HEAD_CHARS = 1024;
const MAX_VALUE_CHARS = 300;
const NAME_PATTERN = /^(CLAUDE|TERM_PROGRAM|VSCODE_|WT_SESSION$)/i;
const VALUE_VARS = ['CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'TERM_PROGRAM'];

const chunks = [];
let bytes = 0;
let overflow = false;
let finished = false;

process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);

// Prazo de segurança: se o stdin não fechar, grava o que chegou e sai.
setTimeout(() => finish('stdin-timeout'), DEADLINE_MS).unref();

try {
  process.stdin.on('data', onData);
  process.stdin.on('end', () => finish(null));
  process.stdin.on('error', () => finish('stdin-error'));
} catch {
  finish('stdin-error');
}

function onData(chunk) {
  bytes += chunk.length;
  if (overflow) return; // continua drenando o stdin, mas descarta
  if (bytes > MAX_STDIN_BYTES) {
    overflow = true;
    return;
  }
  chunks.push(chunk);
}

function finish(problem) {
  if (finished) return;
  finished = true;
  try {
    const record = buildRecord(problem);
    const file = path.join(resolveDataDir(process.env), 'probe', 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    record.writtenAt = Date.now();
    // Uma única escrita por linha, em modo de acréscimo: processos paralelos não se misturam.
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Falha silenciosa: a sonda nunca atrapalha o Claude Code.
  }
  quit();
}

function quit() {
  process.exit(0);
}

function buildRecord(problem) {
  const record = { probe: 1, receivedAt, writtenAt: 0, bytes, env: readEnv(process.env) };
  const raw = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
  if (overflow) {
    const match = /"hook_event_name"\s*:\s*"([A-Za-z]{1,64})"/.exec(raw);
    record.error = 'too-large';
    record.hookEventName = match ? match[1] : null;
    return record;
  }
  if (raw.trim() === '') {
    record.error = problem || 'empty';
    return record;
  }
  try {
    record.payload = JSON.parse(raw);
    if (problem) record.warning = problem;
  } catch {
    record.error = problem || 'invalid-json';
    record.head = raw.slice(0, HEAD_CHARS);
  }
  return record;
}

function readEnv(env) {
  const names = [];
  const values = {};
  for (const name of Object.keys(env)) {
    if (!NAME_PATTERN.test(name)) continue;
    names.push(name);
    const upper = name.toUpperCase();
    if (VALUE_VARS.includes(upper)) values[upper] = String(env[name]).slice(0, MAX_VALUE_CHARS);
  }
  names.sort();
  return { names, values };
}

// Mesma regra do servidor (ADR 0005): AGENT_QUEST_HOME, senão %LOCALAPPDATA%\agent-quest
// no Windows, senão $XDG_STATE_HOME/agent-quest ou ~/.local/state/agent-quest.
function resolveDataDir(env) {
  const custom = (env.AGENT_QUEST_HOME || '').trim();
  if (custom) return path.resolve(custom);
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agent-quest');
  }
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'agent-quest');
}
