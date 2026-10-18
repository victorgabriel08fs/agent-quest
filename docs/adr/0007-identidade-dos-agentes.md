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
