# Visão geral da arquitetura (v1)

> **Status:** aceita em 18/10/2026 (aprovada pelo usuário). **Data da proposta:** 17/10/2026.
> Decisões do usuário na aprovação: captura em escopo de usuário (ADR 0002); painel mostra comandos, caminhos e títulos já redigidos, com modo discreto opcional (ADR 0006); `@playwright/test` como única devDependency (ADR 0010); barra de contexto opcional no fim da v1 (a decisão 10, de 26/10/2026, a pôs na v1) e custo fora da v1 (ADR 0008). A ordem de construção, com o marco "Primeira luz", está em `docs/plano/v1.md`.
> **Ambiente de referência:** Windows 11, Node 24.20, Claude Code 2.1.301 (terminal e extensão do VS Code); a sessão de teste do T0 rodou na 2.1.310, e o G0b (26/10/2026) revisou o design com ela.

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
| Ingestão | `server/ingest/` | Validar envelope, deduplicar, enfileirar; com `--debug-dump`, gravar os envelopes aceitos em `<dados>/dumps/` | `POST /hooks` → 204 |
| Normalização | `server/domain/normalize.js`, `tools.js`, `redact.js`, `tests-detect.js`, `roles.js` | Payload do hook → fato mínimo e redigido | funções puras |
| Estado | `server/domain/state/` | Sessões, agentes, tickets, etapas, aprovações, bugs, saúde; emite eventos canônicos | `apply(state, fact, now)` e `tick(state, now)`, determinísticas |
| Tempo real | `server/http/sse.js` | `hello`, `snapshot`, `update`, retomada por `Last-Event-ID` | cliente SSE de teste |
| Sonda de contexto (T15) | `server/usage/transcript-usage.js` | Montar o caminho do transcript de cada agente, ler o uso de tokens no fim dele e agendar as leituras fora do `apply` | `readContextUsage(file, opts)` → `Promise` de objeto ou `null` (nunca rejeita); `transcriptPathFor(...)`, pura; `createContextProbe({ ... })` com leitura, relógio e temporizadores injetáveis |
| Painel | `web/` | Conexão, store, temas, telas, cena | módulos puros (store, seletores, temas, views que geram HTML) + E2E |
| Contrato compartilhado | `shared/contract.js` | Tipos de evento, papéis, categorias, etapas, status | importado pelo servidor e pelo navegador |

Assinaturas principais (contrato entre módulos):

```js
// server/domain/normalize.js
export function normalize(envelope, { receivedAt, homeDir }) {}   // → Fact | null; homeDir opcional (padrão os.homedir()), para testes

// server/domain/redact.js (pura, sem node:*; também usada por tools/probe/sanitize.mjs; modelo de eventos, seção 10)
export function redact(text) {}              // → string, idempotente
export function redactAndCut(text, max) {}   // → string com no máximo max caracteres, ponto fixo de redact; único corte de textos exibidos
export function charLength(text) {}          // → número de pontos de código; única definição de "caractere" nos limites
export function plainText(text) {}           // → texto sem invisíveis, controles e ANSI (etapas 1 e 7), sem redigir

// server/domain/state/index.js
export function createState({ roleOverrides, sequence, homeDir }) {}   // → State; sequence padrão contador local; homeDir padrão null (a ligação passa os.homedir(), contexto de unidade para /c/...)
export function apply(state, fact, now) {}   // → { events: CanonicalEvent[] já numerados pelo sequence, changed: string[], newProjects: string[] }
export function setAgentNames(state, projectDir, names) {}   // → { changed: string[] } (ids de sessão, como apply e tick); roster das sessões do projeto (seção 7)
export function setContextUsage(state, sessionId, agentKey, usage, at) {}   // → { events, changed } (T15); usage { pct, usedTokens, windowTokens } ou null; at = hora da leitura
                                                                             //   valor novo: context do agente muda e sai context.usage; mesmo valor: nada (nem o at);
                                                                             //   null: context vira null, sem evento; sessão ou agente fora da memória: nada

// server/domain/tools.js
export function canonicalPath(path, { homeDir }) {}   // → forma canônica (seção 2, "Formas de caminho"); usada no displayPath e no project.key

// server/pipeline.js (ligação de ponta a ponta, T9a; fora do domínio e do hub)
export function createPipeline({ /* state, hub, reader, sequence, relógio, usageOptions */ }) {}   // ingestão → normalize → apply → hub; tick periódico; leitura de agentes; sonda de contexto
// usageOptions (T15; parâmetro opcional): { root, read, clock, timers, intervalMs }. root padrão <homeDir>/.claude/projects; root null (ou sem pasta pessoal) desliga a sonda.
//   O pipeline pede leituras depois do apply (tool.finished, turn.stop, subagent.stop, compact.post), guarda o model do SessionStart por sessão
//   e esquece sessão e agentes quando o tick remove a sessão; stop() também cancela as leituras agendadas; settled() espera as leituras em andamento
// startServer({ …, pipeline }) aceita um pipeline pronto só para testes e devolve o pipeline; createApp({ …, sessionCount, getSeq }) para o /api/health e o hub
// createSseHub({ …, getSeq }): getSeq ligado a pipeline.currentSeq(), para o hello e a retomada (T9b)
export function tick(state, now) {}          // → { events, changed, removed }; eventos já numerados pelo sequence
export function getSessionState(state, sessionId) {}   // → SessionState com feed, ou null (snapshot e /api/state)
export function getSessionStates(state) {}             // → SessionState[] com feed
export function sessionCount(state) {}                 // → número de sessões em memória (/api/health)

// server/agent-names.js (fora de server/domain/; ligado ao createState no T9a)
export function createAgentNamesReader({ homeDir, list, timeoutMs, onLate }) {}   // → { read(projectDir) → Promise<string[]> }; lê <projeto>/.claude/agents/ e ~/.claude/agents/
                                                                                   //   assíncrono, prazo por pasta (500 ms), cache por pasta, ignora UNC e caminho relativo,
                                                                                   //   [] em erro ou prazo; filtra .md antes do limite de 200; no máximo 1 listagem em andamento
                                                                                   //   (fila); onLate(projectDir, names) quando uma listagem termina depois do prazo; list injetável

// server/usage/transcript-usage.js (T15; fora de server/domain/; modelo de eventos, seção 6, "Contexto")
export async function readContextUsage(file, { root, model, main, maxBytes }) {}   // → Promise<{ pct, usedTokens, windowTokens } | null>, nunca rejeita
                                                                                    //   só .jsonl dentro de root (caminho resolvido e caminho real); últimos 64 KiB;
                                                                                    //   main: ignora entradas isSidechain; para na marca de compactação (null);
                                                                                    //   model = modelo pedido (SessionStart, só main); o modelo da resposta vem da própria entrada
export function contextUsage(usedTokens, { requested, observed }) {}               // → { pct, usedTokens, windowTokens }; regra da janela (seção 6, "Janela"; ADR 0008, decisão de 26/10/2026)
export function transcriptPathFor({ agentKey, sessionId, transcriptPath, agentTranscriptPath }) {}   // → string | null; só monta o caminho, sem disco
export function createContextProbe({ root, onResult, read, clock, timers, intervalMs, logError }) {}
  // → { request({ sessionId, agentKey, path, model }), forgetSession(sessionId), stop(), settled() }
  //   1 leitura por agente a cada 5 s (a última pedida no intervalo sai no fim dele); 1 leitura por vez no servidor;
  //   até 2 000 agentes acompanhados; onResult(sessionId, agentKey, usage | null, at); nunca lança

// web/js/store.js
export function createStore() {}
export function applyHello(store, hello) {}               // → true se o runId mudou (servidor reiniciado)
export function applySnapshot(store, snapshot) {}         // → true se aplicou
export function applyUpdate(store, update) {}             // → 'ok' | 'ignored' | 'gap' (numeração: modelo de eventos, seção 9)
export function applySessionRemoved(store, message) {}    // → 'ok' | 'ignored' | 'gap', mesmas regras de seq do update
export function removeSession(store, sessionId) {}        // → true se a sessão existia

// web/js/connection.js — selo de conexão:
//   'connecting' (conectando: antes de a primeira conexão abrir) | 'live' (ao vivo)
//   | 'reconnecting' (reconectando: o EventSource tenta de novo sozinho)
//   | 'offline' (desconectado: a conexão fechou de vez, por exemplo com 503)
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
| Servidor caiu sem apagar `runtime.json` (inclui o Ctrl+C e os reinícios do `npm run dev` no Windows, em que o `node --watch` encerra o processo à força) | O encaminhador vê o `pid` morto e sai; o próximo início substitui o arquivo. Se o pid tiver sido reaproveitado, a conexão é recusada em menos de 3 ms (medido). |
| Servidor travado (aceita e não responde) | O encaminhador desiste em 1 s e se encerra em até 2 s; o Claude Code continua sem esperar. |
| Payload grande ou malformado | Strings longas já chegam cortadas, e o encaminhador reduz o envelope até caber em 1 000 000 bytes; corpo acima de 1 MiB recebe 413; envelope inválido, 400. Contadores em `/api/health`. |
| Eventos fora de ordem | Regras do reducer (`modelo-de-eventos.md`, seção 8). |
| Eventos duplicados | Descartados por hash do payload em uma janela de 5 s. |
| Evento perdido (Esc sem Stop, processo encerrado) | Próximo pedido, `idle_prompt`, SessionEnd ou 15 min sem eventos fecham o ticket e liberam os agentes. |
| Servidor reiniciado no meio de uma sessão | A sessão volta no próximo evento; agentes são criados sob demanda; ticket implícito "Tarefa em andamento". |
| Navegador perde a conexão | O `EventSource` reconecta; o servidor reenvia o que faltou ou manda snapshot; o selo "ao vivo" vira "reconectando". |
| Várias abas abertas | Todas recebem o mesmo fluxo (até 8 clientes). |
| Porta ocupada | Se for outra instância do Agent Quest, avisa o endereço e sai com 0; senão, erro claro sugerindo `--port`. |
| Captura não instalada | O painel vazio explica como ligar a captura e mostra "nenhum evento recebido desde HH:MM". |
| Muitos eventos ou sessões | Feed limitado a 200 por sessão; fila limitada (descarta os mais antigos e conta); limpeza de sessões antigas. |
| Transcript ausente, fora de `~/.claude/projects` (inclui `CLAUDE_CONFIG_DIR`) ou em formato desconhecido | A sonda de contexto devolve `null` e a barra do agente some. Nada mais muda (T15). |
| Agente acabou de compactar | A barra some até a próxima resposta do agente, como a status line do Claude Code (modelo de eventos, seção 6, "Contexto"). |
| Leitura do transcript travada | As barras ficam com o último valor até o servidor reiniciar; o resto do painel continua ao vivo. Limitação aceita na v1 (seção 6, "Contexto"). |

## Segurança (resumo do ADR 0006)

- Servidor só em `127.0.0.1`. Toda rota exige `Host` `127.0.0.1:<porta>` ou `localhost:<porta>` (DNS rebinding).
- Ingestão com token por execução, `Content-Type: application/json` e sem `Origin` (bloqueia navegadores). Painel aceita só a própria origem. Sem CORS.
- CSP restrita (`default-src 'none'`, scripts e estilos só do próprio servidor), `nosniff`, `no-referrer`, COOP e CORP.
- Minimização: o estado nunca guarda conteúdo de arquivo, diff, saída de comando, texto do assistente nem pedido completo. Comandos, pedidos e erros são redigidos e truncados.
- Nada de eventos em disco; `runtime.json` e o plugin instalado ficam em `%LOCALAPPDATA%\agent-quest\`, fora do OneDrive.
- Painel com escape em todo texto dinâmico. Por padrão mostra comandos, caminhos e títulos já redigidos; o "modo discreto", opcional e desligado no início, esconde esses textos para compartilhar a tela.
- Risco aceito: outro processo ou usuário local que acesse `127.0.0.1` pode abrir o painel.

## Limites e valores padrão

| Item | Valor |
|---|---|
| Porta | 47821 (`--port`, `AGENT_QUEST_PORT` ou `config.json`). Aceita 0 (porta livre escolhida pelo sistema, usada nos testes) ou um inteiro de 1024 a 65535; de 1 a 1023, ou valor que não seja inteiro, o servidor sai com erro claro. O `runtime.json` sempre grava a porta real em uso, nunca 0, porque o encaminhador só aceita de 1024 a 65535 (T4) |
| Diretório de dados | `%LOCALAPPDATA%\agent-quest\` (`AGENT_QUEST_HOME` sobrescreve). No uso normal, não definir `AGENT_QUEST_HOME`: o encaminhador roda no ambiente do Claude Code e só acha o servidor se a variável for igual nos dois lados (ADR 0005, complemento) |
| Encaminhador | prazo de cerca de 2 s (salvo `JSON.parse` patológico); redução do corpo com orçamento de 1 s e envelope de emergência; POST com timeout de até 1 s, limitado ao que resta do prazo; stdin até 16 MiB; strings acima de 4096 unidades UTF-16 viram 1024 do início + 3072 do fim; corpo de no máximo 1 000 000 bytes, com cortes progressivos (modelo de eventos, seção 1) |
| Corpo de `POST /hooks` | até 1 MiB. Com token válido, o excesso é lido e descartado até 16 MiB antes do 413; acima disso, 413 imediato com `Connection: close` (se declarado) ou conexão encerrada (modelo de eventos, seção 1) |
| Remoção do `runtime.json` no encerramento | Até cerca de 0,8 s de novas tentativas: duas chamadas de até 500 ms, com esperas de 10 a 100 ms, para o caso de o arquivo estar em uso por um instante no Windows. Se ainda assim falhar, o arquivo fica como sobra, e o `pid` morto a trata (encaminhador e próximo início) |
| Fila de ingestão | 10 000 itens; cheia, descarta o mais antigo e conta `dropped`, sem recusar a requisição |
| Deduplicação | 5 s |
| Feed por sessão | 200 eventos |
| Buffer de retomada SSE | até 1 000 mensagens e até 1 MiB, o que vier primeiro; falta maior que isso recebe `snapshot` (modelo de eventos, seção 9) |
| Heartbeat SSE | 15 s |
| Clientes SSE | 8; cliente com mais de 1 MiB acumulado é desconectado e volta com snapshot. O envio inicial só conta depois do primeiro `drain` |
| Limpeza | sessão encerrada: 30 min; sem eventos: 6 h; agente "trabalhando" sem ferramenta rodando e sem eventos: 15 min |
| Saúde | últimas 10 ações do agente |
| Sonda de contexto | até 1 leitura por agente a cada 5 s; 1 leitura por vez no servidor; últimos 64 KiB do arquivo; até 2 000 agentes acompanhados e o modelo pedido de até 1 000 sessões |

## Estrutura de pastas

```text
agents-quest/
├── CLAUDE.md
├── README.md, CHANGELOG.md          (documentador)
├── package.json                     sem dependências de runtime; devDependency: @playwright/test
├── jsconfig.json                    checagem de tipos JSDoc no editor
├── types/
│   └── node.d.ts                    declarações mínimas de node:* só para o editor (ADR 0003)
├── playwright.config.js             E2E com channel 'msedge'
├── capture/                         marketplace local + plugin (fonte)
│   ├── .claude-plugin/marketplace.json
│   └── plugins/agent-quest/
│       ├── .claude-plugin/plugin.json
│       ├── hooks/hooks.json
│       └── scripts/forward.mjs
├── server/
│   ├── main.js, config.js, runtime-file.js
│   ├── pipeline.js                  ligação de ponta a ponta (T9a): ingestão → normalize → estado → hub, tick e leitura de agentes
│   ├── agent-names.js               nomes em .claude/agents/ (projeto e usuário), assíncrono, com prazo e cache por pasta; fora do domínio
│   ├── node-types.js                só typedefs de tipos do Node (ADR 0003)
│   ├── http/        app.js, security.js, static.js, sse.js
│   ├── ingest/      envelope.js, dedupe.js, queue.js, debug-dump.js (só com --debug-dump)
│   ├── domain/      normalize.js, tools.js, redact.js, tests-detect.js, roles.js
│   │   └── state/   index.js, sessions.js, agents.js, quests.js, permissions.js
│   └── usage/       transcript-usage.js            (T15)
├── shared/
│   └── contract.js                  constantes e typedefs do contrato
├── web/
│   ├── index.html, favicon.svg
│   ├── css/         base.css, layout.css, scene.css, themes.css   (cores e contraste: ADR 0009)
│   └── js/          main.js, connection.js, store.js, selectors.js, follow.js, scene.js, fx.js
│       ├── views/   topbar.js, sessions.js, party.js, quest.js, feed.js, empty.js (estado sem sessões), legend.js
│       └── themes/  contract.js, helpers.js, escritorio.js, guilda.js
├── scripts/
│   ├── run-tests.mjs                npm test: acha os *.test.js e chama node --test (ADR 0010)
│   ├── deploy-capture.mjs           npm run capture:deploy
│   └── inject-fixture.mjs           npm run inject (desenvolvimento e testes)
├── tools/probe/                     sonda descartável do T0
├── test/
│   ├── unit/        server/, web/, capture/, shared/, scripts/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/    hooks/, state/, transcripts/      (sempre .json)
├── mockups/                         referência visual; não é servido
└── docs/
```

O servidor serve só `web/` e `shared/`. O mockup continua como referência e não é carregado pelo produto.

### Rotas e mapeamento de URL (definido no T2, 18/10/2026)

| Requisição | O que responde |
|---|---|
| `GET /` | `web/index.html` |
| `GET /shared/<caminho>` | `shared/<caminho>` |
| `GET /api/health`, `GET /api/state` | API (JSON, `no-store`) |
| `GET /events` | SSE |
| `POST /hooks` | ingestão (só o encaminhador) |
| `GET /<caminho>` (qualquer outro) | `web/<caminho>`; por exemplo, `/js/main.js` serve `web/js/main.js` |

- As rotas de API, `/events` e `/hooks` vêm antes dos arquivos estáticos. Arquivos são servidos só para `GET` e `HEAD` (este responde os cabeçalhos, sem corpo).
- O código do painel importa o contrato por caminho relativo à pasta real, por exemplo `import { ROLES } from '../../shared/contract.js'` em `web/js/main.js`, ou `'../../../shared/contract.js'` em `web/js/themes/`. O mesmo import funciona no Node (testes unitários) e no navegador. No navegador, `/js/main.js` mais `../../shared/contract.js` vira `/shared/contract.js`, porque a resolução de URL não sobe além da raiz (conferido com `new URL` em 18/10/2026).
- Por isso não pode existir uma pasta `web/shared/`: ela ficaria escondida pela rota `/shared/`. O caminho `/web/...` não existe no servidor.

### Painel: estrutura e regras de interface (registradas no T11b, 19/10/2026)

- **Cartão de atividade** (`web/index.html`): quatro partes fixas, `#feed-head`, `#feed-filters` (chips), `#feed-empty` e `#feed-entries`. O redesenho troca só o conteúdo delas.
- **Filtros do feed:**
  - por papel, pelos chips;
  - por instância, pelo cartão da equipe. Enquanto o filtro de instância está ligado, aparece também um chip dessa instância, que se desfaz com o próprio chip ou com "Todos" (acréscimo previsto no T14);
  - o filtro volta para "Todos" ao trocar de sessão e quando o botão que o ligou some (a instância foi para o "+N" ou o papel saiu da equipe);
  - o filtro de uma instância mostra os eventos dela. A delegação que a criou aparece no filtro de quem delegou, porque o estado do agente não guarda o id da chamada que o criou. Guardar esse id seria mudança de contrato (`AgentState` ou `agent.started`), fora da v1.
- **Modo discreto** (T14, registrado em 24/10/2026):
  - **começa desligado** (decisão 3 do usuário). Liga pelo botão 🕶️, só com ícone em todas as larguras, como o "?", e com nome acessível, ou pela tecla `D`. A escolha fica no `localStorage` (`agent-quest-discreet`);
  - **o que esconde:** alvo, detalhe e títulos, como no plano; e também o erro do ticket e das ferramentas (a primeira linha costuma ter caminho ou comando), o rótulo da sessão (vem do título do pedido), o rótulo das instâncias (vem da descrição da delegação) e a pasta do projeto no tooltip. Vale também para o feed;
  - **o que fica visível:** o nome do projeto, porque sem ele não dá para se orientar, e o motivo do fim da sessão. Projetos de mesmo nome aparecem como "(1)" e "(2)", sem a pasta. Quem compartilha a tela deve saber que o nome do projeto aparece;
  - **como funciona:** a máscara é aplicada ao estado antes das views (`maskSession`), e os temas recebem `h.discreet` para usar frases só de categoria. O servidor não muda: a máscara é só de exibição, por cima da redação da seção 10;
  - a legenda mostra as frases no modo atual.
- **Topo:** abaixo de 640 px, as ações do topo quebram linha. O botão de alternância apertado tem um traço de 2 px, além do fundo, para não depender só da cor.
- **Limite conhecido da lista nativa do seletor:** se ela fechar sem escolha por um clique que não chega à página, as opções só são refeitas quando o seletor perde o foco ou recebe Tab, Enter ou Esc. É um efeito da pausa de redesenho com a lista aberta (regra "o clique não se perde"), aceito.
- **Sessões** (T13, registrado em 21/10/2026):
  - **textos de controle são neutros nos dois temas:** selo de conexão, status no seletor, "Seguir atividade" e "Ir para a sessão". O vocabulário do tema fica para o conteúdo (papéis, salas, eventos, ticket), para o nome do grupo sem projeto (`unknownProject`) e para a palavra e o ícone do aviso de aprovação;
  - o atalho do aviso de aprovação em outra sessão fixa essa sessão, como escolher no seletor;
  - **sessão fixada que some:** "seguir atividade" continua desligado, e o painel mostra a sessão atual, ou a mais recente, até a fixada reaparecer. O seguir não religa sozinho, porque ao recarregar a página a fixada só aparece depois do snapshot;
  - com o seguir ligado e o painel aberto antes de haver sessões, o painel fica na primeira que aparece até ela passar 30 s sem eventos;
  - **dois critérios de "parada", aceitos:** a política de seguir usa 30 s sem eventos, para reagir rápido; o status do seletor usa o `idle` do servidor (2 min). Os dois podem divergir por até 90 s. Por isso, a interface não chama de "parada" a condição da política;
  - visual fora do mockup, que não tem seletor de sessões: o botão e o aviso reaproveitam os estilos de pílula e de alerta. Abaixo de 640 px, o botão mostra só o ícone, com o texto ainda acessível a leitores de tela;
  - a escolha fica no `localStorage` (`agent-quest-session`), como conveniência do navegador, igual às outras preferências do painel (ADR 0005). Guarda só o id da sessão.
- **Cena** (T12b, 20/10/2026):
  - `#scene-stage` é redesenhado; `#scene-fx`, a camada de efeitos (envelope, impacto, confete), não é redesenhado e tem `aria-hidden`;
  - o movimento usa FLIP com `element.animate()` nas propriedades individuais `translate` e `scale`, que se somam ao `transform` das vagas, nunca `style=`;
  - depois de cada redesenho, os efeitos curtos são refeitos no elemento novo com o mesmo tempo decorrido, e as animações contínuas do CSS seguem o relógio da página, sem empilhar animações;
  - os bugs ficam nas laterais da faixa de baixo da sala de testes, e não onde o mockup os põe, para não ficarem sob o balão do tester.
- **Regras para qualquer parte interativa redesenhada** (valem para o T12b, o T13 e o T14):
  - **o foco não se perde:** depois do redesenho, o foco volta ao botão equivalente, achado pela chave estável (`data-key` ou equivalente);
  - **o clique não se perde:** enquanto um botão da região está apertado, ela não é redesenhada, por no máximo 1,5 s. Os dados pendentes entram no redesenho seguinte.

## Como rodar localmente

```powershell
npm start                           # servidor em http://127.0.0.1:47821/ (não precisa de npm install)
npm run dev                         # o mesmo, com node --watch (nativo): reinicia sozinho quando o código do servidor muda; no Windows, o Ctrl+C pode deixar o runtime.json com pid morto (inofensivo)
npm test                            # unidade + integração, pelo scripts/run-tests.mjs (npm test -- test/unit/shared roda só uma parte)
npm install; npm run test:e2e       # E2E com o Edge instalado (npm install só na primeira vez, com internet)
npm run capture:deploy              # copia o plugin para %LOCALAPPDATA%\agent-quest\marketplace e mostra os comandos
npm run inject -- test/fixtures/hooks/<cenario>.json   # injeta um cenário gravado no servidor local
npm start -- --debug-dump           # só para depuração: grava os envelopes brutos em %LOCALAPPDATA%\agent-quest\dumps\ (dados sensíveis)
```

Ligar a captura é uma ação do usuário, uma vez (ADR 0002):

```powershell
claude plugin marketplace add "$env:LOCALAPPDATA\agent-quest\marketplace"
claude plugin install agent-quest@agent-quest-local
# numa sessão já aberta: /reload-plugins; nas demais, vale a partir da próxima sessão
# pausar:  claude plugin disable agent-quest@agent-quest-local
# remover: claude plugin marketplace remove agent-quest-local
# testar sem instalar: claude --plugin-dir "<repo>\capture\plugins\agent-quest"
```

## Fora da v1

XP, níveis, conquistas, replay, custo da sessão, regressão de testes, início automático do servidor com o Windows e token de acesso ao painel. O custo tem caminho registrado no ADR 0008 (OpenTelemetry), que só entra depois da v1 e com nova aprovação do usuário. A barra de contexto (T15 e T16) entrou na v1 pela decisão 10 do usuário (26/10/2026).
