# Validação da captura (T0)

Resultado da sessão de teste do T0 (`docs/plano/v1.md`), feita pelo usuário em 26/10/2026 com a sonda de `tools/probe/`, no Claude Code 2.1.310. Foram duas partes: no terminal, os pedidos 1 a 11, com o 10a repetido; no VS Code, os pedidos 1, 2 e 5. Os hashes da configuração ficaram iguais antes e depois.

Este documento traz só contagens, nomes de campos e formatos. Os dados brutos ficam em `%LOCALAPPDATA%\agent-quest\probe\` e nunca entram no repositório.

> **A completar pelo dev-backend (entrega do T0):** o resultado detalhado de V1 a V14 e os números do `report.mjs` sobre as fixtures sanitizadas. A seção abaixo é a do arquiteto (G0a). A seção seguinte é a leitura do arquiteto dos demais itens. O que mudou no design foi decidido no G0b (26/10/2026) e está no modelo de eventos, seção 11, "Resultado do T0".

## Volume da sessão

- 340 eventos válidos em 7 sessões: 5 no terminal (297 eventos) e 2 no VS Code (43 eventos). As sessões a mais no terminal vêm do `/clear` e das saídas e retomadas depois que o limite de uso da conta estourou no pedido 10a.
- 16 instâncias de subagente: `probe-worker` ×15 e `documentador` ×1.
- Todos os subagentes rodaram em segundo plano: o PostToolUse do `Agent` voltou com `status: "async_launched"` nas 16 delegações. Pela documentação, esse é o padrão atual: "With nothing configured, a subagent that Claude spawns from your main conversation starts in the background". No terminal e no VS Code, o *fork mode* fica ligado por padrão desde a 2.1.302 e, enquanto ele está ligado, o Claude não consegue esperar um subagente (https://code.claude.com/docs/en/sub-agents, seções "Run subagents in foreground or background" e "Turn fork mode off"). O primeiro plano só aparece com `CLAUDE_CODE_FORK_SUBAGENT=0`, com `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` ou em `claude -p` e no Agent SDK.

## Liberação da Primeira luz (G0a)

**Veredito: liberado em 26/10/2026.** V1, V9 e V10 foram confirmados. Ficam liberados o fechamento do T5 e do T7 (que ainda dependem das fixtures sanitizadas) e a instalação da captura pelo usuário no marco "Primeira luz".

| Item | Veredito | Evidência |
|---|---|---|
| V1 | confirmado | 37 de 37 eventos de ferramenta dentro de subagentes trazem `agent_id` e `agent_type` (Pre 20, Post 16, Failure 1). Os 16 subagentes têm eventos de ferramenta com o próprio `agent_id`. Ressalva: só houve subagente em segundo plano (ver "Volume da sessão") |
| V9 | confirmado | 131 de 131 eventos de subagente trazem o `session_id` da sessão principal; nenhum subagente teve `session_id` diferente do da chamada `Agent`. Os eventos de ferramenta dos subagentes trazem o `transcript_path` da sessão principal (131 de 131) |
| V10 | confirmado | Ver abaixo. O "refutado" do `report.mjs` é falso positivo da ferramenta |

### V10 em detalhe

1. **`node` encontrado:** a sonda gravou 340 eventos, no terminal e no VS Code.
2. **Todas as execuções foram para segundo plano.** O log do terminal registra 298 hooks da sonda como assíncronos ("Config-based async hook, backgrounding process" seguido de "Registering async hook"). Nenhuma execução foi síncrona. O log usa dois formatos de linha:
   - **264 linhas "moved to the background (N ms)":** SessionStart, UserPromptSubmit, Pre/PostToolUse, PostToolUseFailure, PermissionRequest, PostToolBatch, Stop, SubagentStart e SubagentStop;
   - **34 linhas "`<Evento>:<matcher>` [...] completed with status 0":** Notification (23), SessionEnd (5), PreCompact (2), PostCompact (2) e StopFailure (2). Essas linhas saem no mesmo milissegundo da passagem para segundo plano, ou seja, o Claude Code não esperou o script.

   A diferença de 264 linhas para 297 execuções que o `report.mjs` apontou é exatamente esse segundo formato: 33 execuções do terminal mais um SessionEnd cujo evento não foi gravado (ver o item 5). Por evento, o número de linhas do log bate com o de eventos gravados.
3. **Erros de hook:** nenhuma linha "hook error" no log. O "1 erro citando a sonda" do relatório não é erro de hook. É uma linha `[WARN] [Stall] agent_completion ... exitPath=error` de um `probe-worker` que terminou com erro quando o limite de uso estourou. A linha cita o tipo `agent-quest-probe:probe-worker`, e a busca do relatório casou o nome do plugin e a palavra `error`.
4. **Confirmação visual do usuário:** sem janela de console piscando e sem aviso `hook error`, no terminal e no VS Code.
5. **Perdas observadas, toleradas pelo design:**
   - 1 de 3 SessionEnd com `reason: prompt_input_exit` foi para segundo plano mas não chegou a gravar o evento: o Claude Code saiu antes. O ADR 0001 já previa isso para `claude -p`, e agora se vê também no modo interativo. O servidor libera os agentes e remove a sessão pelas regras de inatividade (`visao-geral.md`, tabela de limites: sem eventos, 6 h);
   - 1 SubagentStop foi cancelado pelo Claude Code depois de 36 ms, antes de ir para segundo plano. Ele coincidiu com o fim de um agente interno de resumo (`agent_summary`), que o design já ignora.

### Custo de partida do hook (medido; não muda o veredito)

O número entre parênteses em "moved to the background (N ms)" parece ser o tempo entre o disparo do hook e a passagem dele para segundo plano. O formato do log não é documentado, então isso é uma interpretação. Nas 264 linhas: mediana de 39 ms, p95 de 878 ms, máximo de 3 448 ms; 19 passaram de 500 ms. Cruzando com o `receivedAt` gravado pelo script, o `node` só começa a rodar de 54 ms a 3,6 s depois da passagem para segundo plano. Ou seja, o Claude Code não espera o script, mas parece esperar a criação do processo. Os picos coincidem com momentos de mais atividade (subagentes em paralelo, o primeiro pedido), mas a causa não foi isolada.

Isso não é bloqueio no sentido do V10. Mas corrige a frase do ADR 0001 de que o custo de iniciar o processo fica "fora do caminho do agente": parte dele fica no caminho. O registro e a forma de validar estão na lista do G0b.

### V5 e V13 (lidos no G0a, como pede o plano)

- **V5: "refutado" no relatório, mas só no subitem `run_in_background`.** O que o T7 usa foi confirmado:
  - o `tool_response.agentId` do PostToolUse do `Agent` é o `agent_id` dos eventos do subagente em 16 de 16;
  - o `status: "async_launched"` veio nas 16 delegações;
  - o nome da ferramenta é `Agent`.

  O que não se confirmou: `run_in_background: true` não aparece no `tool_input` (0 de 16), porque o segundo plano agora é o padrão e não depende do parâmetro. O primeiro plano não foi observado.
- **Decisão para o T7:** não se aplica a regra "V5 refutado → só fila por tipo".
  - O elo delegação → instância continua pelo `tool_response.agentId`, com a fila por tipo como elo provisório até o Post chegar, como já está.
  - O segundo plano é decidido pelo `async_launched` (`isBackgroundLaunch`) e pelo `background_tasks` do Stop (V13).
  - A leitura de `run_in_background` fica como defesa, sem efeito nos casos reais, e continua valendo para o Bash.
  - Os critérios do T7 sobre primeiro plano fecham com os cenários sintéticos, porque as fixtures reais não terão esse caso.
- **V13: confirmado.** `background_tasks[].id` é igual ao `agent_id` em 52 de 52 entradas (`type: subagent`, `status: running`).

## Leitura dos demais itens (insumo para o G0b)

Resumo do arquiteto, sem decisão tomada. As decisões ficam no G0b (`docs/plano/v1.md`).

- **V2 (refutado no relatório):** o PermissionRequest de subagente em segundo plano traz `agent_id` (9 de 9). O Notification `permission_prompt` nunca traz `agent_id` (0 de 8), nem cita o tipo do subagente na mensagem. Os 19 PermissionRequest casaram com o PreToolUse pelo `inputHash`.
- **V3 (confirmado):** 5 PostToolUseFailure de Bash ou PowerShell, todos com `error` começando por `Exit code N`.
- **V4 (confirmado):** negação sem Post nem Failure (4 casos, 2 em subagentes). Não veio PermissionDenied: ele é do modo automático, não da negação manual. Pela documentação, Esc na aprovação de um subagente em segundo plano nega só aquela chamada, sem parar o subagente.
- **V6 (confirmado):** 29 SubagentStop com `agent_type` vazio (agentes internos). Dois subagentes tiveram um segundo SubagentStart: um foi retomado depois do limite de uso; no outro, a causa (retomada ou nova mensagem) não foi conferida.
- **V7 (refutado no relatório):** o retorno do segundo plano dispara UserPromptSubmit em 16 de 17 casos. Três formatos apareceram no início do `prompt`:
  - `<task-notification>` (13, no terminal);
  - `<agent-message from="<agent-id>">` (2, no VS Code). O `from` é o `agent_id` do subagente, e um deles chegou antes do SubagentStop do mesmo agente;
  - `<browser_instruction>…</browser_instruction>` seguido do pedido do usuário (1, no primeiro pedido da conversa do VS Code). **É pedido do usuário**, com um bloco de cerca de 4,1 mil caracteres injetado pela extensão na frente. O corte do encaminhador guarda 1 KiB do início e 3 KiB do fim, então um pedido curto do usuário sobrevive no fim, mas o título sai do bloco. Um pedido do usuário com mais de cerca de 3 mil caracteres perde o começo. *Correção de 26/10/2026: a versão anterior deste item dizia que o texto do usuário sempre se perdia.* Decisão 13: a captura 0.1.3 tira o bloco antes do corte.
- **V8 (refutado no relatório):** o `prompt_id` está em todos os eventos dos subagentes e é diferente a cada pedido. Mas o subagente em segundo plano recebe o `prompt_id` **atual da sessão principal**, não o do pedido que o delegou: 6 de 16 subagentes mudaram de `prompt_id` no meio. Os valores novos vêm de retornos (`task-notification`, `agent-message`) e de comandos locais sem UserPromptSubmit (`/compact`, `/clear`, saída). Houve 8 `prompt_id` sem UserPromptSubmit.
- **V11 (confirmado):** `CLAUDE_PROJECT_DIR` em 340 de 340 eventos; `CLAUDE_CODE_ENTRYPOINT` vale `cli` ou `claude-vscode`.
- **V12:** 3 turnos interrompidos com Esc, todos sem Stop e com a ferramenta sem Post nem Failure (0 `is_interrupt`). Nenhum subagente interrompido: no 10a, o subagente estava em segundo plano e o Esc não o alcança. O limite de uso estourou no meio do 10a e gerou 2 StopFailure `rate_limit`, um da sessão principal e outro **com `agent_id` de subagente**.
- **V14 (confirmado):**
  - em 45 pares Pre/Post, o Post chegou antes do Pre em 6 (13,3%) e foi disparado antes em 4;
  - o maior payload teve 10 603 bytes;
  - strings acima de 4 KiB apareceram só em `compact_summary`, `last_assistant_message` e `prompt`;
  - notificação de tipo novo: `quota_auto_resume_fired`.
- **Contexto (T15):** o `agent_transcript_path` do SubagentStop seguiu `<pasta>/<sessão>/subagents/agent-<agent_id>.jsonl` em 17 de 17 casos, como o T15 monta.
