# Visão geral da arquitetura (v1)

> **Status:** proposta (aguarda aprovação do usuário). **Data:** 17/10/2026.
> **Ambiente de referência:** Windows 11, Node 24.20, Claude Code 2.1.301 (terminal e extensão do VS Code).

## Em uma frase

Um plugin do Claude Code dispara, a cada evento de hook, um encaminhador Node assíncrono que entrega o JSON a um servidor em `127.0.0.1`. O servidor minimiza os dados, mantém o estado das sessões em memória e transmite eventos canônicos por SSE para um painel no navegador, que traduz tudo para o tema escolhido.

## Fluxo de dados

```text
 Claude Code (terminal ou VS Code)                          Agent Quest (tudo na máquina do usuário)

 ┌───────────────────────────────┐  hook async   ┌─────────────────┐ POST /hooks    ┌───────────────────────────────┐ SSE /events  ┌─────────────────────┐
 │ sessão principal + subagentes │──stdin JSON──▶│ forward.mjs     │──────────────▶│ servidor (node:http)          │─────────────▶│ painel (navegador)  │
 │ plugin agent-quest: 15 hooks  │ 1 processo    │ sai sempre 0,   │ 127.0.0.1      │ ingestão → normalização →     │ hello,       │ store → temas →     │
 └───────────────────────────────┘ por evento    │ nunca imprime   │ + token        │ estado → eventos canônicos    │ snapshot,    │ equipe, cena, feed  │
                                                  └────────┬────────┘                │ (tudo em memória)             │ update       └─────────────────────┘
                                                           │ lê porta, token, pid     └──────────────┬────────────────┘
                                                           ▼                                         │ escreve ao iniciar, apaga ao sair
                                         %LOCALAPPDATA%\agent-quest\runtime.json ◀──────────────────┘
```

Passo a passo de um evento:

1. O Claude Code dispara um hook, por exemplo PreToolUse dentro de um subagente, e inicia `node forward.mjs` sem esperar (`async`).
2. O encaminhador lê o JSON, registra `sentAt`, corta strings acima de 4 KiB e lê `runtime.json`. Se o servidor não estiver no ar, sai.
3. `POST /hooks` com o token. O servidor responde 204 antes de processar.
4. O normalizador gera um fato mínimo e redigido; o reducer aplica as regras e produz eventos canônicos e o novo estado da sessão.
5. O hub SSE envia `update` aos navegadores conectados.
6. O painel atualiza o store, redesenha no próximo quadro de animação e anima conforme o tipo de evento, com o vocabulário do tema.

Meta: evento no painel em menos de 300 ms, dos quais cerca de 60 ms são o início do processo Node.

## Componentes

| Componente | Onde | Responsabilidade | Interface testável isolada |
|---|---|---|---|
| Plugin de captura | `capture/` (fonte) → `%LOCALAPPDATA%\agent-quest\marketplace\` (instalado) | Registrar os 15 hooks `command` assíncronos | `hooks.json` validado por `claude plugin validate` |
| Encaminhador | `capture/plugins/agent-quest/scripts/forward.mjs` | stdin → envelope v1 → POST; nunca imprime; sai 0; prazo de 2 s | processo filho: stdin + variáveis de ambiente → requisição HTTP |
| Configuração e runtime | `server/config.js`, `server/runtime-file.js` | Porta, diretório de dados, limites; gravar e apagar `runtime.json` | funções com `env` injetado |
| HTTP e segurança | `server/http/` | Rotas, `Host`/`Origin`, token, cabeçalhos, estáticos | servidor em porta efêmera |
| Ingestão | `server/ingest/` | Validar envelope, deduplicar, enfileirar | `POST /hooks` → 204 |
| Normalização | `server/domain/normalize.js`, `tools.js`, `redact.js`, `tests-detect.js`, `roles.js` | Payload do hook → fato mínimo e redigido | funções puras |
| Estado | `server/domain/state/` | Sessões, agentes, tickets, etapas, aprovações, bugs, saúde; emite eventos canônicos | `apply(state, fact, now)` e `tick(state, now)`, determinísticas |
| Tempo real | `server/http/sse.js` | `hello`, `snapshot`, `update`, retomada por `Last-Event-ID` | cliente SSE de teste |
| Sonda de contexto (opcional) | `server/usage/transcript-usage.js` | Ler o uso de tokens no fim do transcript | `readContextUsage(path, opts)` → objeto ou `null` |
| Painel | `web/` | Conexão, store, temas, telas, cena | módulos puros (store, seletores, temas, views que geram HTML) + E2E |
| Contrato compartilhado | `shared/contract.js` | Tipos de evento, papéis, categorias, etapas, status | importado pelo servidor e pelo navegador |

Assinaturas principais (contrato entre módulos):

```js
// server/domain/normalize.js
export function normalize(envelope, { receivedAt }) {}   // → Fact | null

// server/domain/state/index.js
export function createState({ roleOverrides, readAgentNames }) {}   // → State
export function apply(state, fact, now) {}   // → { events: CanonicalEvent[] sem seq, changed: string[] }
export function tick(state, now) {}          // → { events, changed, removed }

// web/js/store.js
export function applySnapshot(store, snapshot) {}
export function applyUpdate(store, update) {}   // → 'ok' | 'ignored' | 'gap'
export function removeSession(store, sessionId) {}
```

## Decisões

| ADR | Decisão |
|---|---|
| [0001](../adr/0001-captura-por-hooks-command-assincronos.md) | Hooks `command` assíncronos chamando um encaminhador Node; 15 eventos |
| [0002](../adr/0002-captura-instalada-como-plugin-local.md) | Captura distribuída como plugin de marketplace local, escopo de usuário, instalado pelo usuário |
| [0003](../adr/0003-stack-node-sem-build.md) | Node 24, JavaScript ESM sem build, zero dependências de runtime |
| [0004](../adr/0004-tempo-real-com-sse.md) | SSE com snapshot, updates e retomada |
| [0005](../adr/0005-estado-em-memoria.md) | Estado só em memória; dados em `%LOCALAPPDATA%`, fora do OneDrive |
| [0006](../adr/0006-seguranca-do-servidor-local.md) | Loopback, `Host`/`Origin`, token na ingestão, CSP, minimização e redação |
| [0007](../adr/0007-identidade-dos-agentes.md) | Identidade por `agent_id`, papéis por `agent_type`, convidados |
| [0008](../adr/0008-fontes-dos-indicadores.md) | O que é real, aproximado ou sai do painel |
| [0009](../adr/0009-tema-como-camada.md) | Tema como camada pura de apresentação |
| [0010](../adr/0010-estrategia-de-testes.md) | `node:test` + Playwright com o Edge instalado |

## Falhas e como o sistema reage

| Situação | Comportamento |
|---|---|
| Servidor desligado | Sem `runtime.json`, o encaminhador sai em cerca de 60 ms. O Claude Code nem espera (async) e nada aparece para o usuário. |
| Servidor caiu sem apagar `runtime.json` | O encaminhador vê o `pid` morto e sai. Se o pid tiver sido reaproveitado, a conexão é recusada em menos de 3 ms (medido). |
| Servidor travado (aceita e não responde) | O encaminhador desiste em 1 s e se encerra em até 2 s; o Claude Code continua sem esperar. |
| Payload grande ou malformado | Strings longas já chegam cortadas; corpo acima de 1 MiB recebe 413; envelope inválido, 400. Contadores em `/api/health`. |
| Eventos fora de ordem | Regras do reducer (`modelo-de-eventos.md`, seção 8). |
| Eventos duplicados | Descartados por hash do payload em uma janela de 5 s. |
| Evento perdido (Esc sem Stop, processo encerrado) | Próximo pedido, `idle_prompt`, SessionEnd ou 15 min sem eventos fecham o ticket e liberam os agentes. |
| Servidor reiniciado no meio de uma sessão | A sessão volta no próximo evento; agentes são criados sob demanda; ticket implícito "Tarefa em andamento". |
| Navegador perde a conexão | O `EventSource` reconecta; o servidor reenvia o que faltou ou manda snapshot; o selo "ao vivo" vira "reconectando". |
| Várias abas abertas | Todas recebem o mesmo fluxo (até 8 clientes). |
| Porta ocupada | Se for outra instância do Agent Quest, avisa o endereço e sai com 0; senão, erro claro sugerindo `--port`. |
| Captura não instalada | O painel vazio explica como ligar a captura e mostra "nenhum evento recebido desde HH:MM". |
| Muitos eventos ou sessões | Feed limitado a 200 por sessão; fila limitada (descarta os mais antigos e conta); limpeza de sessões antigas. |

## Segurança (resumo do ADR 0006)

- Servidor só em `127.0.0.1`. Toda rota exige `Host` `127.0.0.1:<porta>` ou `localhost:<porta>` (DNS rebinding).
- Ingestão com token por execução, `Content-Type: application/json` e sem `Origin` (bloqueia navegadores). Painel aceita só a própria origem. Sem CORS.
- CSP restrita (`default-src 'none'`, scripts e estilos só do próprio servidor), `nosniff`, `no-referrer`, COOP e CORP.
- Minimização: o estado nunca guarda conteúdo de arquivo, diff, saída de comando, texto do assistente nem pedido completo. Comandos, pedidos e erros são redigidos e truncados.
- Nada de eventos em disco; `runtime.json` e o plugin instalado ficam em `%LOCALAPPDATA%\agent-quest\`, fora do OneDrive.
- Painel com escape em todo texto dinâmico e "modo discreto" para tela compartilhada.
- Risco aceito: outro processo ou usuário local que acesse `127.0.0.1` pode abrir o painel.

## Limites e valores padrão

| Item | Valor |
|---|---|
| Porta | 47821 (`--port`, `AGENT_QUEST_PORT` ou `config.json`) |
| Diretório de dados | `%LOCALAPPDATA%\agent-quest\` (`AGENT_QUEST_HOME` sobrescreve) |
| Encaminhador | prazo de 2 s; POST com timeout de 1 s; stdin até 16 MiB; strings acima de 4 KiB viram 1 KiB do início + 3 KiB do fim |
| Corpo de `POST /hooks` | até 1 MiB |
| Deduplicação | 5 s |
| Feed por sessão | 200 eventos |
| Buffer de retomada SSE | 1000 atualizações |
| Heartbeat SSE | 15 s |
| Clientes SSE | 8 |
| Limpeza | sessão encerrada: 30 min; sem eventos: 6 h; agente "trabalhando" sem ferramenta rodando e sem eventos: 15 min |
| Saúde | últimas 10 ações do agente |
| Sonda de contexto (opcional) | até 1 leitura por agente a cada 5 s; últimos 64 KiB do arquivo |

## Estrutura de pastas

```text
agents-quest/
├── CLAUDE.md
├── README.md, CHANGELOG.md          (documentador)
├── package.json                     sem dependências de runtime; devDependency: @playwright/test
├── jsconfig.json                    checagem de tipos JSDoc no editor
├── playwright.config.js             E2E com channel 'msedge'
├── capture/                         marketplace local + plugin (fonte)
│   ├── .claude-plugin/marketplace.json
│   └── plugins/agent-quest/
│       ├── .claude-plugin/plugin.json
│       ├── hooks/hooks.json
│       └── scripts/forward.mjs
├── server/
│   ├── main.js, config.js, runtime-file.js
│   ├── http/        app.js, security.js, static.js, sse.js
│   ├── ingest/      envelope.js, dedupe.js, queue.js
│   ├── domain/      normalize.js, tools.js, redact.js, tests-detect.js, roles.js
│   │   └── state/   index.js, sessions.js, agents.js, quests.js, permissions.js
│   └── usage/       transcript-usage.js            (opcional, T15)
├── shared/
│   └── contract.js                  constantes e typedefs do contrato
├── web/
│   ├── index.html
│   ├── css/         base.css, layout.css, scene.css, themes.css
│   └── js/          main.js, connection.js, store.js, selectors.js, follow.js, scene.js, fx.js
│       ├── views/   topbar.js, sessions.js, party.js, quest.js, feed.js, legend.js
│       └── themes/  contract.js, helpers.js, escritorio.js, guilda.js
├── scripts/
│   ├── deploy-capture.mjs           npm run capture:deploy
│   └── inject-fixture.mjs           npm run inject (desenvolvimento e testes)
├── tools/probe/                     sonda descartável do T0
├── test/
│   ├── unit/        server/, web/, capture/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/    hooks/, state/, transcripts/      (sempre .json)
├── mockups/                         referência visual; não é servido
└── docs/
```

O servidor serve só `web/` e `shared/`. O mockup continua como referência e não é carregado pelo produto.

## Como rodar localmente

```powershell
npm start                           # servidor em http://127.0.0.1:47821/ (não precisa de npm install)
npm test                            # unidade + integração
npm install; npm run test:e2e       # E2E com o Edge instalado (npm install só na primeira vez, com internet)
npm run capture:deploy              # copia o plugin para %LOCALAPPDATA%\agent-quest\marketplace e mostra os comandos
npm run inject -- test/fixtures/hooks/<cenario>.json   # injeta um cenário gravado no servidor local
```

Ligar a captura é uma ação do usuário, uma vez (ADR 0002):

```powershell
claude plugin marketplace add "$env:LOCALAPPDATA\agent-quest\marketplace"
claude plugin install agent-quest@agent-quest-local
# pausar:  claude plugin disable agent-quest@agent-quest-local
# remover: claude plugin marketplace remove agent-quest-local
# testar sem instalar: claude --plugin-dir "<repo>\capture\plugins\agent-quest"
```

## Fora da v1

XP, níveis, conquistas, replay, custo da sessão, regressão de testes, início automático do servidor com o Windows e token de acesso ao painel. O custo tem caminho registrado no ADR 0008 (OpenTelemetry, com aprovação do usuário).
