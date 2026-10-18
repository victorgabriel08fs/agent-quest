# Modelo de eventos

> **Status:** aceita em 18/10/2026 (aprovada pelo usuário). **Data da proposta:** 17/10/2026. **Base:** Claude Code 2.1.301.
> Contrato entre a captura, o servidor e o painel na v1. Itens marcados **[T0]** dependem da validação prática da primeira tarefa do plano (`docs/plano/v1.md`). Decisões relacionadas: ADRs 0001, 0005, 0007 e 0008.
> Nos exemplos, `<repo>` é o caminho absoluto do repositório (no ambiente de referência, uma pasta dentro do OneDrive) e `<agent-id>` é um `agent_id` real qualquer.

## Camadas

| Camada | Quem produz | Onde está definida | Quem depende dela |
|---|---|---|---|
| Payload do hook | Claude Code | https://code.claude.com/docs/en/hooks | encaminhador |
| Envelope v1 | `forward.mjs` | seção 1 | ingestão do servidor |
| Fato | normalizador (`server/domain/normalize.js`) | seção 2 (interno do servidor) | reducer de estado |
| Evento canônico e estado da sessão | reducer (`server/domain/state/`) | seções 3, 6 e 9 | painel e temas |

Mudança no formato dos hooks afeta só o normalizador. Mudança em eventos canônicos ou no estado da sessão é mudança de contrato e precisa da aprovação do usuário.

## 1. Envelope v1 (encaminhador → servidor)

`POST http://127.0.0.1:<porta>/hooks` com `Content-Type: application/json` e `X-Agent-Quest-Token: <token>`, sem `Origin`.

```json
{
  "v": 1,
  "sentAt": 1760731234567,
  "forwarder": "0.1.0",
  "env": { "projectDir": "<repo>", "entrypoint": null },
  "truncated": false,
  "payload": { "hook_event_name": "PreToolUse", "session_id": "…", "tool_name": "Read", "…": "…" }
}
```

- `sentAt`: `Date.now()` no início do encaminhador. Vira o `ts` dos eventos.
- `env.projectDir`: `CLAUDE_PROJECT_DIR` do processo do hook (a documentação de plugins garante que é exportado). `env.entrypoint`: valor de uma variável que diga se a sessão é do terminal ou do VS Code, se o T0 encontrar uma **[T0]**; senão `null`. A candidata é `CLAUDE_CODE_ENTRYPOINT`, que a sonda do T0 registra junto com `TERM_PROGRAM` (V11). O encaminhador nunca manda outras variáveis de ambiente.
- `payload`: o JSON do hook, com toda string acima de 4 KiB cortada em 1 KiB do início + 3 KiB do fim, separados por `…[cortado N caracteres]…`. O fim é preservado porque o resumo dos testes fica no fim da saída. `truncated` diz se algo foi cortado.
- Respostas: 204 aceito; 400 envelope inválido; 401 token ausente ou errado; 403 `Host` ou `Origin` inválido; 405 método diferente de `POST`; 413 acima de 1 MiB; 415 tipo de conteúdo errado. O encaminhador ignora todas.
- Fila cheia não gera resposta de erro. O envelope é aceito com 204, e a fila descarta o item mais antigo e conta `dropped` (alinhado em 18/10/2026; a versão anterior desta seção citava um 429 que nunca é emitido).
- Corpo grande: recusas pelos cabeçalhos (401, 403, 415) respondem sem ler o corpo. Com token válido, um corpo acima de 1 MiB é lido e descartado até 16 MiB, o mesmo teto do stdin do encaminhador, e depois recebe 413, para o cliente ver o status em vez de uma conexão cortada. Com `Content-Length` acima de 16 MiB, a resposta 413 sai na hora, com `Connection: close`. Se o corpo passar de 16 MiB sem ter declarado isso, a conexão é encerrada sem resposta.

## 2. Fatos (interno do servidor)

O normalizador transforma cada envelope em no máximo um fato, já minimizado e redigido (seção 10). Payload sem `session_id` ou com evento desconhecido vira `null` e só conta em `/api/health`.

Campos comuns: `hook`, `sessionId`, `agentId` (ou `null`), `agentType` (ou `null`), `promptId` (ou `null`), `projectDir`, `ts`, `receivedAt` e `transcriptPath` (usado só pela sonda de contexto, nunca enviado ao painel).

| Fato | Hook | Campos próprios |
|---|---|---|
| `session.start` | SessionStart | `source` (startup, resume, clear, compact, fork), `model`, `sessionTitle` |
| `session.end` | SessionEnd | `reason` |
| `prompt.submit` | UserPromptSubmit | `title` (primeira linha, até 80 caracteres), `origin` (`user` ou `system`), `sessionTitle` |
| `tool.pre` | PreToolUse | `toolUseId`, `tool`, `category`, `target`, `detail`, `inputHash`, `background`. Para `Agent`/`Task`: `subagentType`, `description` |
| `tool.post` | PostToolUse | os mesmos de `tool.pre` + `durationMs`. Para `Agent`/`Task`: `linkedAgentId` (de `tool_response.agentId`) e `launch` (`completed` ou `async_launched`). Para teste: `testResult` |
| `tool.fail` | PostToolUseFailure | os mesmos de `tool.pre` + `error` (primeira linha, até 160), `interrupted`, `durationMs`, `testResult` |
| `permission.request` | PermissionRequest | `tool`, `category`, `target`, `inputHash` |
| `permission.denied` | PermissionDenied | `toolUseId`, `tool`, `category` |
| `notice` | Notification | `type`: só `permission_prompt` e `idle_prompt`; os outros viram `null` |
| `subagent.start` | SubagentStart | — (usa `agentId` e `agentType` comuns) |
| `subagent.stop` | SubagentStop | `agentTranscriptPath` (só para a sonda de contexto) |
| `turn.stop` | Stop | `backgroundTasks`: lista de `{ id, type, status, agentType }` |
| `turn.fail` | StopFailure | `error` (tipo: `rate_limit`, `overloaded`, `authentication_failed`, ...) |
| `compact.pre`, `compact.post` | PreCompact, PostCompact | `trigger` (`manual` ou `auto`) |

`inputHash`: SHA-256 do `tool_input` serializado com chaves ordenadas, primeiros 16 caracteres hexadecimais. Serve para casar o PermissionRequest com o PreToolUse sem guardar o conteúdo.

`testResult`: `{ ok, passed, failed, total, framework }` (seção 6, "Bug na cena").

## 3. Eventos canônicos (servidor → painel)

```js
/**
 * @typedef {object} CanonicalEvent
 * @property {string} id        `${runId}:${seq}`
 * @property {number} seq       crescente dentro de uma execução do servidor
 * @property {number} ts        ms desde a época (sentAt do encaminhador; se faltar, a hora de chegada)
 * @property {string} sessionId
 * @property {string|null} agentKey   'main', um agent_id, ou null (evento da sessão)
 * @property {EventKind} kind
 * @property {object} data
 */
```

| `kind` | `agentKey` | `data` | No feed |
|---|---|---|---|
| `session.started` | `null` | `{ source, projectName }` | sim |
| `session.ended` | `null` | `{ reason }` | sim |
| `session.idle` | `null` | `{}` | não |
| `quest.started` | `main` | `{ questId, n, title, implicit }` | sim |
| `quest.finished` | `main` | `{ questId, n, outcome, error, durationMs, actions }`; `outcome`: `done`, `failed` ou `interrupted` | sim |
| `quest.phase` | dono da etapa | `{ questId, phase, state }`; `phase`: `design`, `code`, `test`, `docs`; `state`: `active` ou `done` | só `done` |
| `agent.delegated` | quem delegou | `{ toolUseId, toType, toRole, description, background }` | sim |
| `agent.started` | o novo agente | `{ agentType, role, label, parentKey }` | não |
| `agent.finished` | o agente | `{ outcome }`; `done` ou `unknown` | sim |
| `tool.started` | o agente | `{ toolUseId, tool, category, target, detail }` | sim |
| `tool.finished` | o agente | `{ toolUseId, tool, category, durationMs }` | não |
| `tool.failed` | o agente | `{ toolUseId, tool, category, target, error, interrupted }` | sim |
| `test.finished` | o agente | `{ toolUseId, ok, passed, failed, total, framework }` | sim |
| `permission.requested` | o agente | `{ tool, category, target }` | sim |
| `permission.resolved` | o agente | `{ outcome, by }`; `outcome`: `approved`, `denied` ou `unknown`; `by`: `user`, `auto` ou `inferred` | sim |
| `context.compacted` | o agente | `{ trigger }` | sim |
| `context.usage` | o agente | `{ pct, usedTokens, windowTokens }` (opcional, T15) | não |

`shared/contract.js` exporta essas listas (`EVENT_KINDS`, `FEED_KINDS`, `ROLES`, `TOOL_CATEGORIES`, `PHASES`, `AGENT_STATUS`, `SESSION_STATUS`, `QUEST_STATUS`).

### Categorias de ferramenta

| `tool_name` | `category` | `target` | `detail` |
|---|---|---|---|
| Read, NotebookRead | `read` | caminho do arquivo | — |
| Grep, Glob, LS, LSP, ToolSearch | `search` | padrão (até 60) ou caminho | — |
| Write | `write` | caminho | — |
| Edit, MultiEdit, NotebookEdit | `edit` | caminho | — |
| Bash, PowerShell, quando é comando de teste | `test` | comando (primeira linha, até 120) | `description` (até 80) |
| Bash, PowerShell, outros; BashOutput, Monitor, TaskStop | `bash` | comando | `description` |
| WebFetch | `web` | só o host da URL | — |
| WebSearch | `web` | consulta (até 80) | — |
| TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet | `plan` | — | — |
| Skill | `skill` | nome da skill | — |
| `mcp__<servidor>__<ferramenta>` | `mcp` | `<servidor>/<ferramenta>` | — |
| Agent, Task | (vira `agent.delegated`) | — | — |
| qualquer outra | `other` | `tool_name` | — |

## 4. Mapeamento hook → evento canônico

O normalizador gera o fato; o reducer aplica as regras da seção 6 e emite os eventos.

| Hook | Condição | Eventos canônicos |
|---|---|---|
| SessionStart | — | `session.started`. Com `source: compact`, também `context.compacted` se o PostCompact não tiver chegado |
| SessionEnd | — | `quest.finished(interrupted)` se havia ticket aberto; `session.ended` |
| UserPromptSubmit | origem do usuário | `quest.finished(interrupted)` se havia ticket aberto; `quest.started` |
| UserPromptSubmit | origem do sistema | reabre o ticket em espera, sem evento no feed |
| PreToolUse | `Agent` ou `Task` | `agent.delegated` |
| PreToolUse | outras ferramentas | `tool.started` |
| PostToolUse | `Agent` ou `Task` | confirma ou corrige o elo delegação → instância (sem evento) |
| PostToolUse | outras ferramentas | `tool.started` se o Pre não chegou; `tool.finished`; `test.finished` se for comando de teste; `permission.resolved(approved)` se havia pedido pendente para essa chamada |
| PostToolUseFailure | — | igual ao anterior, com `tool.failed` no lugar de `tool.finished` |
| PermissionRequest | — | `permission.requested` |
| PermissionDenied | — | `permission.resolved(denied, auto)` |
| Notification | `permission_prompt` | `permission.requested` só se não houver pedido pendente na sessão |
| Notification | `idle_prompt` | `quest.finished(interrupted)` se havia ticket aberto; `session.idle` |
| SubagentStart | `agent_type` não vazio | `agent.started`; nada se o agente já existe (retomada) |
| SubagentStop | agente conhecido ou `agent_type` não vazio | `agent.finished`; `quest.phase(done)` se era o último agente do papel em execução |
| Stop | sem tarefa em segundo plano rodando | `quest.finished(done)`; subagentes em primeiro plano ainda marcados como trabalhando → `agent.finished(unknown)` |
| Stop | com tarefa em segundo plano rodando | ticket passa a `waiting_background`, sem evento |
| StopFailure | — | `quest.finished(failed)` com o tipo de erro |
| PreCompact | — | atividade do agente vira "compactando", sem evento |
| PostCompact | — | `context.compacted` |
| (estado) | atividade sem ticket aberto | `quest.started(implicit)` |
| (estado) | primeiro agente de um papel do time no ticket | `quest.phase(active)` |

## 5. Identidade dos agentes

Decisão em ADR 0007. Regras operacionais:

- `agentKey = payload.agent_id ?? 'main'`.
- Papel por `agent_type` (tabela do ADR 0007; tipos desconhecidos viram `aux`). Para `plugin:agente`, tenta o nome inteiro e depois a parte depois do último `:`. Sobrescrita opcional em `<dados>/config.json` (`"roles"`).
- Se a sessão principal vier com `agent_type` (sessão iniciada com `--agent`), ela continua `main`/`orq`, e o tipo aparece só como detalhe.
- **Elo delegação → instância.** Cada sessão guarda os pedidos `Agent` pendentes por `toolUseId`: `{ from, toType, description, background, ts, agentKey }`.
  1. `tool.pre` de `Agent`: cria o pendente e emite `agent.delegated`.
  2. `subagent.start` (ou o primeiro evento com um `agent_id` novo): cria o agente e liga ao pendente mais antigo da sessão com o mesmo tipo e sem agente (provisório). `label` = `description`; `parentKey` = `from`.
  3. `tool.post` de `Agent` com `linkedAgentId`: se o elo provisório apontava para outro agente, troca as descrições e corrige `parentKey`. Para subagente em segundo plano (`launch: async_launched`), esse fato chega logo no início.
- **Aninhados:** `from` é o `agentKey` de quem chamou `Agent`, seja a sessão principal ou outro subagente. O painel anima a delegação de quem delegou para quem recebeu.
- **Agentes internos:** `subagent.stop` com `agentType` vazio e agente desconhecido é descartado.
- **Várias instâncias do mesmo papel:** todas aparecem; o painel agrupa por papel. O rótulo de cada uma é a descrição da delegação; sem ela, o `agent_type`.

## 6. Regras dos conceitos do painel

### Ticket (quest)

- **Começa** em `UserPromptSubmit` de origem do usuário. `questId` = `prompt_id`; `n` = contador da sessão; `title` = primeira linha do pedido (até 80 caracteres, redigida). Pedido que começa com `/` usa o comando como título.
- **Origem do sistema.** A documentação diz que UserPromptSubmit também dispara para retorno de subagente em segundo plano, tarefa agendada, `/loop` e mensagem de outra sessão, sem campo que diferencie. Regra provisória: texto que começa com a marca que o Claude Code usa nessas notificações (formato **[T0]**). Pedido do sistema não abre ticket: reabre o ticket em `waiting_background` ou o último ticket encerrado há menos de 30 min; senão abre um implícito, "Retorno de tarefa em segundo plano".
- **Termina:**
  - `Stop` sem tarefa em segundo plano rodando → `done`;
  - `Stop` com alguma tarefa de `background_tasks` ainda ativa → fica `waiting_background` até um próximo `Stop` sem tarefas;
  - `StopFailure` → `failed`, com o tipo de erro;
  - novo pedido do usuário com ticket aberto, `idle_prompt` ou `SessionEnd` → `interrupted`. O Claude Code não dispara Stop quando o usuário interrompe com Esc.
- Fato com `promptId` de ticket já encerrado atualiza agentes e feed, mas não reabre o ticket. Fato sem `promptId` vai para o ticket aberto.
- Atividade sem ticket aberto (por exemplo, servidor iniciado no meio de um turno) cria um ticket implícito, "Tarefa em andamento".
- `actions` conta `tool.started` e `agent.delegated` do ticket.

### Etapa

- Papel → etapa: `arq` → `design`, `dev` → `code`, `tes` → `test`, `doc` → `docs`.
- `active` quando um agente do papel começa no ticket; `done` quando termina o último agente desse papel em execução. Uma nova delegação reativa a etapa.
- O stepper só aparece quando alguma etapa sai de `pending`. Em sessões sem os papéis do time, o ticket mostra só título, ações e duração.

### Aguardando aprovação

- `PermissionRequest` não traz `tool_use_id`. Atribuição, em ordem:
  1. `agent_id` do próprio payload, se vier **[T0]**;
  2. a chamada pendente mais recente da sessão com o mesmo `tool_name` e o mesmo `inputHash` (o PreToolUse dispara antes da checagem de permissão);
  3. senão, `main`.
- O agente fica `waiting`, com `waitingFor: { tool, category, target }`, e `pendingApprovals` da sessão aumenta.
- **Resolução:**
  - chegou PostToolUse ou PostToolUseFailure da chamada → `approved` (`by: user`);
  - `PermissionDenied` → `denied` (`by: auto`; só acontece no modo auto);
  - outra ação do mesmo agente, fim do agente, fim do turno ou novo pedido → `unknown` (`by: inferred`), exibido como "negado ou cancelado". A documentação confirma que uma permissão negada dispara o PreToolUse e nada depois, nem PostToolUseFailure.
- `Notification` do tipo `permission_prompt` sem pedido pendente marca `main` como `waiting`, para o aviso aparecer mesmo se o PermissionRequest se perder.

### Bug na cena

- **Comando de teste:** Bash ou PowerShell cujo `command`, depois de tirar prefixos como `cd <pasta> &&` e atribuições de variáveis, começa com um destes padrões: `npm|pnpm|yarn|bun [run ]test…`, `node --test`, `[npx ](vitest|jest|mocha|ava)`, `[npx ]playwright test`, `pytest`, `python -m (pytest|unittest)`, `php artisan test`, `[vendor/bin/](phpunit|pest)`, `go test`, `cargo test`, `dotnet test`, `mvn test`, `gradle[w] test`. A lista fica num único módulo com testes por tabela. Comando com `run_in_background` não conta, porque o resultado não vem no PostToolUse.
- **Resultado:** PostToolUse → `ok: true`. PostToolUseFailure → `ok: false`; segundo a documentação, Bash que termina com código diferente de zero gera `error` começando com `Exit code N` **[T0]**.
- **Contagem**, lida do texto do resultado (fim do stdout ou do `error`): node:test (`ℹ fail N`, `# fail N`), Jest (`Tests: N failed, M passed, T total`), Vitest (`Tests  N failed | M passed`), pytest (`N failed, M passed`), PHPUnit (`Failures: N`), Pest (`Tests: N failed, M passed`), go test (quantidade de `--- FAIL:`). Sem resumo reconhecido: `failed: null`.
- **Estado da sessão:** run que falhou → `bugs.open = failed ?? 1`; run que passou → `bugsCrushed += bugs.open` e `bugs.open = 0`. Os bugs pertencem à sessão e não zeram no ticket seguinte, porque refletem o último resultado real.
- A cena mostra até 4 bugs na sala de testes e "+N" para o resto.

### Voltou para a copa

- Subagente: `SubagentStop` → `status: idle`, `finished: true`; o token vai para a copa (taverna). Instâncias encerradas saem da cena quando começa o ticket seguinte.
- Sessão principal: `Stop` → `idle`, mas o token do orquestrador fica na sala dele, como no mockup.
- No `Stop` sem tarefas em segundo plano, subagentes em primeiro plano que ainda constam como trabalhando recebem `agent.finished(unknown)`.
- Agente "trabalhando" sem ferramenta em execução e sem eventos há 15 min → `agent.finished(unknown)`.

### Saúde

Janela das últimas 10 ações do agente: `tool.finished` conta como sucesso e `tool.failed` como falha. Para comando de teste conta só o `test.finished`, para não contar duas vezes. Sem ações, 100%. O estado expõe `{ ok, total }` e o painel mostra a fração.

### Contexto (opcional, T15)

A sonda lê os últimos 64 KiB do transcript do agente: `transcript_path` para a sessão principal; para subagentes, `<pasta do transcript>/<session_id>/subagents/agent-<agent_id>.jsonl` (caminho documentado) ou o `agent_transcript_path` do SubagentStop. Da última resposta com `message.usage`: `usedTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Janela de 200 mil tokens, ou 1 milhão se o uso passar de 200 mil ou o modelo pedido terminar em `[1m]`. No máximo uma leitura por agente a cada 5 s. Só lê arquivos `.jsonl` dentro de `~/.claude/projects/`. Qualquer falha devolve `null` e a barra some.

## 7. Sessões e projetos

- **Chave:** `session_id`. Eventos de subagentes chegam com o `session_id` da sessão principal **[T0]**.
- **Projeto:** `env.projectDir`; se faltar, o `cwd` do primeiro evento. `project.key` é o caminho normalizado (barras `/`, letra de unidade minúscula, sem barra no fim); `project.name` é a última parte do caminho.
- **Rótulo:** `session_title`, senão o título do primeiro ticket (até 48 caracteres), senão `Sessão a1b2c3`.
- **Status:** `waiting` (aprovação pendente) tem prioridade sobre `active` (algum agente trabalhando ou evento há menos de 2 min), que tem prioridade sobre `idle`. `ended` após SessionEnd.
- **Equipe (`roster`):** sempre `orq`; mais os papéis do time cujos agentes existem em `<projeto>/.claude/agents/` ou `~/.claude/agents/` (o servidor lê só os nomes dos arquivos, uma vez por sessão); mais qualquer papel que aparecer na sessão; mais `aux` se houver convidado.
- **`/clear`, retomada e compactação:** se o `session_id` mudar, é outra sessão. A anterior encerra pelo SessionEnd ou pela limpeza.
- **Limpeza:** sessão encerrada sai da memória após 30 min; sem eventos, após 6 h.
- **No painel:** uma sessão por vez em equipe, cena, ticket e atividade. Seletor no topo, agrupado por projeto, com status e aprovações pendentes. O modo padrão "seguir atividade" troca para a sessão mais ativa quando a atual está parada há 30 s, no máximo uma vez a cada 10 s. Escolher uma sessão a fixa. Se outra sessão tiver aprovação pendente, um aviso aparece no topo.

## 8. Ordem, duplicatas e lacunas

Hooks não têm número de sequência, e cada evento vem de um processo próprio (ADR 0001), então a ordem de chegada pode diferir da real em dezenas de milissegundos. O servidor processa na ordem de chegada, numera cada evento canônico (`seq`) e aplica estas regras:

1. O primeiro evento de um `toolUseId` (Pre, Post ou Failure) gera `tool.started`, porque Post e Failure também trazem `tool_input`. Os seguintes só atualizam.
2. PreToolUse que chega depois do Post da mesma chamada é ignorado.
3. Evento de ferramenta com `agent_id` desconhecido cria o agente na hora (papel pelo `agent_type`). O SubagentStart que chegar depois só completa o elo.
4. Depois do SubagentStop, eventos atrasados do agente atualizam saúde e feed, mas não o devolvem a "trabalhando". O mesmo vale para a sessão principal depois do Stop, até o próximo pedido.
5. Fato com `promptId` de ticket encerrado não reabre o ticket.

**Duplicatas:** o mesmo payload (hash) repetido em até 5 s é descartado. Cobre, por exemplo, o plugin carregado duas vezes.

**Lacunas:** eventos perdidos (Esc sem Stop, processo encerrado) são compensados pelo próximo pedido, pelo `idle_prompt`, pelo SessionEnd e pela regra de 15 min dos agentes.

## 9. Contrato servidor → painel

### Mensagens SSE (`GET /events`)

```text
retry: 2000

event: hello
data: {"protocol":1,"runId":"k3f9q","seq":1234,"serverVersion":"0.1.0"}

id: k3f9q:1234
event: snapshot
data: {"seq":1234,"sessions":[SessionState com feed]}

id: k3f9q:1235
event: update
data: {"seq":1235,"event":CanonicalEvent ou null,"session":SessionState sem feed}

id: k3f9q:1236
event: session-removed
data: {"seq":1236,"sessionId":"…"}
```

- Na conexão: `hello`, depois as atualizações que faltaram (se `Last-Event-ID` for desta execução e estiver no buffer de 1000) ou um `snapshot`.
- `update` com `event: null` carrega só mudança de estado (por exemplo, a correção de um elo de delegação).
- O cliente ignora `seq` repetido ou menor e, se notar lacuna, busca `GET /api/state`.
- Heartbeat: linha de comentário `: ping` a cada 15 s.

### Estado da sessão

```js
/**
 * @typedef {'orq'|'arq'|'dev'|'tes'|'doc'|'aux'} RoleId
 *
 * @typedef {object} SessionState
 * @property {string} id
 * @property {{ key: string, name: string, dir: string }} project
 * @property {string} label
 * @property {'terminal'|'vscode'|null} client
 * @property {'active'|'waiting'|'idle'|'ended'} status
 * @property {number} startedAt
 * @property {number} lastEventAt
 * @property {AgentState[]} agents        inclui 'main'
 * @property {RoleId[]} roster            papéis do cartão Equipe, em ordem
 * @property {QuestState|null} quest      atual ou último
 * @property {{ questsDone: number, bugsCrushed: number, pendingApprovals: number }} counters
 * @property {{ open: number, lastRun: TestRun|null }} bugs
 * @property {CanonicalEvent[]} [feed]    só no snapshot: até 200 eventos de FEED_KINDS
 *
 * @typedef {object} AgentState
 * @property {string} key                 'main' ou agent_id
 * @property {string|null} agentId
 * @property {string|null} agentType
 * @property {RoleId} role
 * @property {string} label               descrição da delegação, ou agentType
 * @property {'working'|'waiting'|'idle'} status
 * @property {boolean} finished           subagente que terminou (fica na copa)
 * @property {boolean} background
 * @property {string|null} parentKey
 * @property {Activity|null} activity     última atividade (balão e linha do cartão)
 * @property {{ tool: string, category: string, target: string|null }|null} waitingFor
 * @property {{ ok: number, total: number }} health
 * @property {{ pct: number, usedTokens: number, windowTokens: number, at: number }|null} context
 * @property {number} startedAt
 * @property {number} lastEventAt
 *
 * @typedef {object} Activity
 * @property {'tool'|'delegate'|'compact'|'start'} kind
 * @property {string|null} category
 * @property {string|null} tool
 * @property {string|null} target
 * @property {string|null} detail
 * @property {'running'|'done'|'failed'} state
 * @property {number} at
 *
 * @typedef {object} QuestState
 * @property {string} id
 * @property {number} n
 * @property {string} title
 * @property {boolean} implicit
 * @property {'open'|'waiting_background'|'done'|'failed'|'interrupted'} status
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {{ design: Phase, code: Phase, test: Phase, docs: Phase }} phases   Phase = 'pending'|'active'|'done'
 * @property {number} actions
 * @property {string|null} error
 *
 * @typedef {object} TestRun
 * @property {boolean} ok
 * @property {number|null} passed
 * @property {number|null} failed
 * @property {number|null} total
 * @property {string|null} framework
 * @property {number} at
 */
```

Exemplo de `update` (abreviado):

```json
{
  "seq": 1240,
  "event": {
    "id": "k3f9q:1240", "seq": 1240, "ts": 1760731240100, "sessionId": "5f1c…",
    "agentKey": "<agent-id>", "kind": "tool.started",
    "data": { "toolUseId": "toolu_01…", "tool": "Bash", "category": "test", "target": "npm test", "detail": "Rodar a suíte" }
  },
  "session": {
    "id": "5f1c…", "project": { "key": "<repo normalizado como na seção 7>", "name": "agents-quest", "dir": "<repo>" },
    "label": "Implementar a ingestão", "client": null, "status": "active",
    "roster": ["orq", "arq", "dev", "tes", "doc"],
    "agents": [
      { "key": "main", "role": "orq", "status": "working", "activity": { "kind": "delegate", "...": "..." }, "...": "..." },
      { "key": "<agent-id>", "agentType": "tester", "role": "tes", "label": "testar a ingestão", "status": "working", "health": { "ok": 7, "total": 8 }, "...": "..." }
    ],
    "quest": { "id": "9b0e…", "n": 3, "title": "Implementar a ingestão", "status": "open", "phases": { "design": "done", "code": "done", "test": "active", "docs": "pending" }, "actions": 41, "...": "..." },
    "counters": { "questsDone": 2, "bugsCrushed": 3, "pendingApprovals": 0 },
    "bugs": { "open": 0, "lastRun": null }
  }
}
```

### Outras rotas

- `GET /api/state`: o mesmo conteúdo do `snapshot`.
- `GET /api/health`: `{ ok, version, startedAt, events: { received, accepted, rejected, deduped, dropped, ignored }, lastEventAt, sessions, clients }`, sem conteúdo de evento. Tipos (`HealthResponse` em `shared/contract.js`, confirmados em 18/10/2026):

  ```js
  /**
   * @typedef {object} HealthResponse
   * @property {boolean} ok              sempre true quando o servidor responde
   * @property {string} version          versão do package.json
   * @property {number} startedAt        ms desde a época
   * @property {{ received: number, accepted: number, rejected: number, deduped: number, dropped: number, ignored: number }} events
   * @property {number|null} lastEventAt hora de chegada (relógio do servidor, ms) do último POST /hooks respondido com 204,
   *                                     deduplicado ou não; null se nenhum chegou desde o início
   * @property {number} sessions         sessões em memória, inclusive encerradas ainda não limpas
   * @property {number} clients          conexões SSE abertas em /events
   */
  ```

  A forma é a mesma desde o T3: até o T9a, `sessions` e `clients` valem 0.

  Contadores de `events` (definidos no T3, 18/10/2026):
  - `received` conta só os `POST /hooks` que passaram pela checagem de `Host`. Requisição com `Host` inválido (403 antes do roteamento) ou com outro método (405) não entra.
  - `received = accepted + deduped + rejected`.
  - `dropped` (descartado por fila cheia) e `ignored` (sem fato, ou erro no processamento) são subconjuntos de `accepted`.

## 10. Minimização e redação

| Do payload | O que entra no fato |
|---|---|
| `tool_input.file_path` | caminho relativo ao projeto, com `/`; fora do projeto, com a pasta pessoal abreviada para `~` |
| `tool_input.command` | primeira linha, até 120 caracteres, redigida |
| `tool_input.description` (Bash, Agent) | até 80 caracteres, redigida |
| `tool_input.pattern`, `query` | até 60 (busca) ou 80 (web), redigidos |
| `tool_input.url` | só o host |
| `tool_input.content`, `old_string`, `new_string`, `prompt` (do Agent) | nunca |
| `tool_response` | só `agentId`/`status` (Agent) e o `testResult` (teste); nunca stdout, stderr ou conteúdo |
| `error` | primeira linha, até 160, redigida |
| `prompt` (UserPromptSubmit) | primeira linha, até 80, redigida; o resto nunca |
| `last_assistant_message`, `compact_summary`, `custom_instructions`, `message` (Notification) | nunca |

**Redação.** É uma função só, `redact(text) → string`, em `server/domain/redact.js`. O normalizador a usa em comandos, descrições, títulos, erros, buscas e consultas web, e a sanitização dos cenários do T0 (`tools/probe/sanitize.mjs`) importa o mesmo módulo, para as duas nunca divergirem. O módulo é puro: não importa `node:*` nem nada do servidor. Revista em 18/10/2026 com as lacunas apontadas pelo tester da sonda. Etapas, nesta ordem:

1. **Caracteres invisíveis.** Remove os de largura zero (U+200B, U+200C, U+200D, U+2060, U+FEFF), o hífen suave (U+00AD) e os controles de direção (U+200E, U+200F, U+202A a U+202E, U+2066 a U+2069). Uma chave conhecida com um invisível no meio continua sendo reconhecida, e o painel nunca mostra texto invisível nem invertido.
2. **Blocos de chave privada:** de `-----BEGIN … PRIVATE KEY-----` até o `-----END … PRIVATE KEY-----` correspondente, ou até o fim do texto se o fim faltar.
3. **Tokens com prefixo conhecido**, com tamanho mínimo depois do prefixo para evitar falso positivo:
   - `sk-ant-…`, `sk-…`, `sk_live_…`, `sk_test_…`, `rk_live_…`;
   - `ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `ghr_…`, `github_pat_…`, `glpat-…`;
   - `npm_` seguido de 36 letras ou dígitos (não confundir com nomes como `npm_config_cache`), `pypi-…`, `hf_…`;
   - `AKIA…`, `AIza…`, `xox[abprs]-…`, `xapp-…`;
   - JWT (`eyJ….….…`).
4. **Credenciais embutidas:** usuário e senha em URL (`://usuario:senha@` vira `://•••@`) e em `curl -u usuario:senha` ou `--user usuario:senha` (vira `-u •••`).
5. **Cabeçalhos**, em qualquer caixa e também dentro de aspas, como em `-H "X-Api-Key: abc"`. O valor inteiro é trocado em:
   - `Authorization:` e `Proxy-Authorization:`, inclusive `Bearer` e `Basic`;
   - `Cookie:` e `Set-Cookie:`;
   - qualquer cabeçalho cujo nome termine em `-Key`, `-Token` ou `-Secret` (`X-Api-Key:`, `X-Auth-Token:`).

   `Bearer <valor>` solto também é trocado.
6. **Pares nome-valor com nome sensível**, em qualquer caixa, nas formas:
   - `nome=valor` e `nome: valor`;
   - `"nome": "valor"`;
   - `export NOME=valor` e `$env:NOME = "valor"`;
   - `--nome valor` e `--nome=valor`. Opções curtas como `-p`, ambíguas demais, ficam de fora.

   O nome é sensível quando, dividido por `_`, `-`, `.` e pelas trocas de minúscula para maiúscula, alguma parte é `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `credential`, `credentials` ou `auth`, ou a última parte é `key`. Exemplos: `access_token`, `refresh_token`, `client_secret`, `db_password`, `my_token`, `MY_TOKEN`, `apiKey`, `api_key`, `AWS_SECRET_ACCESS_KEY`, `--password`, `--token`, `--api-key`. Não são sensíveis `tokenizer`, `oauth` nem `--key-file`. Mantém o nome e o separador e troca o valor, com as aspas se houver, por `•••`. Falsos positivos como `sort_key=nome` são aceitos: escondem um valor inofensivo.

Propriedades obrigatórias, com testes:

- **Idempotência:** `redact(redact(x)) === redact(x)`.
- **Redação antes do corte:** os limites da tabela acima contam caracteres depois da redação, então um segredo nunca aparece pela metade.
- **Robustez:** nunca lança exceção; tempo linear, sem expressão regular com retrocesso catastrófico; uma string patológica de 4 KiB é processada em menos de 10 ms.
- **Vetores:** pelo menos um positivo por regra acima, inclusive cada exemplo desta seção e uma chave com caractere de largura zero no meio, mais negativos (`npm_config_cache=x`, `tokenizer=y`, um SHA de commit, um `tool_use_id`).

Alternativa descartada: detectar segredo por entropia. Esconderia SHAs de commit, ids e hashes, que são úteis no painel, e mesmo assim não garantiria cobertura. A redação continua heurística: formatos desconhecidos podem passar, e o modo discreto cobre a tela compartilhada (ADR 0006).

Teste obrigatório: nenhum fato contém as chaves `content`, `old_string`, `new_string`, `stdout`, `stderr`, `tool_input`, `tool_response`, `last_assistant_message`, nem string acima de 200 caracteres.

## 11. A confirmar no T0

V1, V9 e V10 liberam o recorte da Primeira luz e a instalação da captura (G0a do plano). Os demais itens entram na revisão completa (G0b), antes do T6 e do T8.

| # | Item | Se falhar |
|---|---|---|
| V1 | `agent_id` e `agent_type` em Pre/PostToolUse e PostToolUseFailure dentro de subagentes | atribuição por subagente vira heurística por tempo; reabrir ADR 0007 |
| V2 | `agent_id` no PermissionRequest e no Notification de pedidos feitos por subagentes (primeiro e segundo plano) | fica a heurística por `tool_name` + `inputHash` |
| V3 | Bash com código de saída diferente de zero gera PostToolUseFailure com `error` começando por `Exit code N` | resultado do teste passa a vir só da leitura do resumo |
| V4 | Permissão negada: só PreToolUse, sem Post nem Failure | ajustar a resolução de "aguardando" |
| V5 | `tool_response.agentId` e `status` no PostToolUse do `Agent` (primeiro e segundo plano); nome da ferramenta (`Agent`) e `run_in_background` no `tool_input` | elo fica só pela fila por tipo |
| V6 | SubagentStart para agentes internos; SubagentStop com `agent_type` vazio; SubagentStart na retomada | ajustar filtros |
| V7 | Formato do `prompt` no UserPromptSubmit de retorno de subagente em segundo plano | retornos podem abrir tickets falsos |
| V8 | `prompt_id` presente nos eventos dos subagentes e diferente a cada pedido | ticket passa a ser delimitado só por tempo |
| V9 | `session_id` dos subagentes igual ao da sessão principal | separar sessões por `transcript_path` |
| V10 | Hooks `async` não bloqueiam ("moved to the background" no log), não geram aviso, `node` é encontrado e nenhuma janela de console pisca, no terminal e no VS Code | reabrir ADR 0001 |
| V11 | Variáveis de ambiente do processo do hook (só nomes): `CLAUDE_PROJECT_DIR` e alguma que indique terminal ou VS Code | `client` fica `null` |
| V12 | Esc no meio de um turno: quais eventos chegam; SubagentStop de subagente interrompido | ajustar limpeza |
| V13 | `background_tasks[].id` do Stop igual ao `agent_id` | casar tarefas por `agent_type` |
| V14 | Frequência de Post chegando antes do Pre e tamanho dos payloads por evento | calibrar corte de strings e regras de ordem |
