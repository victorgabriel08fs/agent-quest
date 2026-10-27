# ADR 0007: Identidade dos agentes e papéis do time

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

## Contexto

O painel mostra quem fez cada ação. Segundo a documentação dos hooks:

- dentro de um subagente, os eventos de ferramenta trazem `agent_id` (um por instância) e `agent_type`: "the input carries the `agent_id` and `agent_type` [...] that identify the subagent";
- a sessão principal não tem `agent_id`; ela só tem `agent_type` quando foi iniciada com `--agent`;
- `agent_type` é o `name` do frontmatter para agentes próprios (`arquiteto`, `dev-backend`...), o nome do agente embutido (`general-purpose`, `Explore`, `Plan`) e `plugin:agente` para agentes de plugin;
- SubagentStart e SubagentStop não trazem `tool_use_id`. O elo com a chamada da ferramenta `Agent` é `tool_response.agentId` no PostToolUse dessa chamada;
- SubagentStop também dispara para agentes internos do Claude Code, com `agent_type` vazio.

## Decisão

- **Chave do agente:** `"main"` quando o evento não tem `agent_id`; senão, o próprio `agent_id`. Nunca usar `agent_type` para decidir se é a sessão principal.
- **Papel** a partir do `agent_type`:

  | `agent_type` | Papel |
  |---|---|
  | (sessão principal) | `orq` |
  | `arquiteto` | `arq` |
  | `dev-backend`, `dev-frontend` | `dev` |
  | `tester` | `tes` |
  | `documentador` | `doc` |
  | qualquer outro (`general-purpose`, `Explore`, `Plan`, agentes de outros projetos) | `aux` (convidado), exibindo o `agent_type` real |

  Para `plugin:agente`, tenta o nome inteiro e depois a parte depois do último `:`. Um `config.json` opcional no diretório de dados pode acrescentar ou trocar entradas (`"roles": { "backend": "dev" }`).
- **Instâncias:** cada `agent_id` é um agente. O painel agrupa por papel: o cartão mostra "×2" e a cena desenha um token por instância (até 3 por sala, depois "+N").
- **Elo delegação → instância:** no SubagentStart, liga ao pedido `Agent` pendente mais antigo da mesma sessão com o mesmo tipo (fila, provisório). No PostToolUse do `Agent`, confirma ou corrige pelo `tool_response.agentId`.
- **Delegante:** o agente que fez a chamada `Agent` (sessão principal ou subagente). Isso cobre subagentes aninhados.
- **Agentes internos:** SubagentStop de agente desconhecido com `agent_type` vazio é ignorado.

## Alternativas consideradas

- **Identidade por `agent_type`.** Mistura instâncias paralelas do mesmo tipo.
- **Elo só pelo PostToolUse.** Em primeiro plano, ele só chega quando o subagente termina, tarde demais para a animação de delegação.

## Consequências

- Dois subagentes do mesmo tipo iniciados juntos podem mostrar a descrição trocada por alguns segundos, até o PostToolUse corrigir.
- O design depende de `agent_id` nos eventos de ferramenta. A documentação afirma, mas o T0 confirma na prática.

## Fontes

- https://code.claude.com/docs/en/hooks (campos comuns, SubagentStart, SubagentStop)
- `docs/pesquisa/hooks-claude-code.md`, seção 3

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão. A confirmação do V1 e do V9 no T0 é condição para o recorte da Primeira luz (G0a em `docs/plano/v1.md`). Se o V1 for refutado, esta ADR é reaberta com o usuário antes do T5.

## Complemento de 26/10/2026: resultado do T0 (V1, V5, V6, V9 e V13)

Revisão do G0b com a sessão de teste do T0 (`docs/pesquisa/validacao-captura.md`). A decisão continua a mesma.

- **V1 e V9 confirmados.**
  - Os eventos de ferramenta dos subagentes trazem `agent_id` e `agent_type` (37 de 37).
  - Os subagentes usam o `session_id` da sessão principal (131 de 131).
  - Os eventos de ferramenta dos subagentes trazem o `transcript_path` da sessão principal. O do subagente vem só no `agent_transcript_path` do SubagentStop, ou é montado como `<pasta>/<sessão>/subagents/agent-<agent_id>.jsonl` (17 de 17).
- **Segundo plano é o padrão.** Na 2.1.310, as 16 delegações saíram com `status: "async_launched"`. Pela documentação, com o *fork mode* ligado (padrão desde a 2.1.302) o Claude não espera subagente em sessão interativa; o primeiro plano só aparece com `CLAUDE_CODE_FORK_SUBAGENT=0`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, em `claude -p` ou no Agent SDK (https://code.claude.com/docs/en/sub-agents). Consequências:
  - o PostToolUse do `Agent` chega logo depois do lançamento, então a correção do elo pelo `tool_response.agentId` (16 de 16) acontece em milissegundos. A alternativa rejeitada "elo só pelo PostToolUse" voltaria a ser viável, mas a fila por tipo continua valendo para o primeiro plano;
  - `run_in_background` não aparece no `tool_input` (0 de 16). O segundo plano é decidido pelo `async_launched` e pelo `background_tasks` do Stop, cujo `id` é o `agent_id` (V13, 52 de 52);
  - o caminho de primeiro plano continua no código e é coberto só por cenários sintéticos (decisão 15 do usuário).
- **Retomada (V6).** Um subagente pode receber um novo SubagentStart depois do próprio SubagentStop. Na sessão, isso aconteceu com um subagente que delegou em segundo plano e foi retomado para receber o retorno. Regra nova, sem mudar o contrato: SubagentStart de agente conhecido e encerrado, com `ts` maior que o do encerramento, devolve o agente a "trabalhando" e emite `agent.started` de novo. Um SubagentStart com `ts` anterior é atraso e não muda nada (modelo de eventos, seções 4 e 8).
- **StopFailure de subagente.** O StopFailure pode trazer `agent_id` (1 de 2, por limite de uso). Ele não mexe no `main` nem no ticket. O subagente continua como está, porque pode ser retomado, e foi o que aconteceu. Se não for retomado, a regra dos 15 min o encerra.
