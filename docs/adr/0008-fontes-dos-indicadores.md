# ADR 0008: De onde vem cada indicador do painel

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

## Contexto

O mockup mostra indicadores simulados: barras de saúde e de contexto, custo da sessão, bugs na cena, etapas do ticket, XP, conquistas. XP, níveis, conquistas e replay ficaram fora da v1. Para o resto, é preciso decidir o que tem dado real, o que entra aproximado e o que sai.

## Decisão

| Elemento do mockup | Fonte na v1 | Situação |
|---|---|---|
| Quem está na equipe | SubagentStart e eventos com `agent_id`/`agent_type`; nomes dos arquivos em `.claude/agents/` do projeto e do usuário (só os nomes) | Real |
| Trabalhando, aguardando, ocioso | Pre/PostToolUse, PostToolUseFailure, PermissionRequest, SubagentStop, Stop, Notification | Real. "Aguardando" é atribuído por heurística se o PermissionRequest vier sem `agent_id` |
| Ação atual (balão e cartão) | `tool_name` e campos minimizados de `tool_input` | Real |
| Barra de saúde (Humor / Vida) | Fração de sucesso nas últimas 10 ações do agente (PostToolUse contra PostToolUseFailure; comando de teste conta pelo resultado do teste) | Aproximada, derivada de dado real |
| Barra de contexto (Foco / Mana) | `message.usage` da última resposta no transcript do agente; janela de 200 mil tokens, ou 1 milhão se o uso passar disso ou o modelo pedido indicar `[1m]` | Aproximada e opcional (T15 e T16). Some se o formato do transcript mudar |
| Anel de XP e nível | — | Sai (fora do escopo) |
| Custo da sessão | — | Sai da v1. No lugar, a duração da sessão |
| Bugs na cena | Comandos de teste no Bash/PowerShell: resultado (PostToolUse ou PostToolUseFailure) e contagem lida do resumo (node:test, Jest, Vitest, pytest, PHPUnit/Pest, go test) | Aproximada |
| Bugs esmagados | Soma das falhas que um run seguinte, aprovado, zerou | Aproximada |
| Ticket (número, título, duração, ações) | UserPromptSubmit até Stop ou StopFailure; título = primeira linha do pedido | Real |
| Etapas do ticket | Delegações a papéis do time dentro do ticket: arquiteto → Arquitetura, devs → Desenvolvimento, tester → QA, documentador → Documentação | Derivada. Só aparece quando o ticket envolve papéis do time |
| Tickets entregues | Tickets encerrados com sucesso na sessão | Real |
| Aprovações pendentes | PermissionRequest até a ferramenta rodar, outra ação do mesmo agente ou o fim do turno | Real. "Negado ou cancelado" é inferido |
| Pausa para o café (compactação) | PreCompact e PostCompact | Real |
| Regressão | Exigiria identidade de cada teste | Sai |
| Conquistas, toasts, "+XP", promoção | — | Sai |
| Controle da simulação | — | Sai do painel. Vira o injetor de fixtures, para desenvolvimento e testes |

Sobre o custo, as fontes possíveis e por que nenhuma entra na v1:

- **Status line** (`cost.total_cost_usd`): só da sessão principal, exige configurar `statusLine` (muda o terminal do usuário) e não cobre a extensão do VS Code com certeza.
- **OpenTelemetry** (`claude_code.api_request.cost_usd`): custo por requisição, mas exige variáveis no `env` do `~/.claude/settings.json` e um receptor OTLP local. Candidato para depois da v1, com aprovação do usuário.
- **Tokens do transcript multiplicados por uma tabela de preços:** a tabela fica desatualizada e o número sairia errado sem aviso.

## Alternativas consideradas

- **Manter os números simulados do mockup.** Enganaria quem observa.
- **Saúde como pontuação com regras arbitrárias** (−30 por erro, +40 por teste verde, como no mockup). Mais "jogo", porém sem significado verificável. A fração de sucesso é explicável no tooltip ("8 de 10 ações sem erro").

## Consequências

- Todo indicador aproximado leva "≈" ou uma nota no tooltip e aparece na legenda com a fonte.
- O topo do painel mostra: duração da sessão, bugs esmagados, tickets entregues e aprovações pendentes.
- Quando um dado não existe (por exemplo, contexto de um agente sem transcript legível), o indicador some em vez de mostrar zero.

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão, com estas definições:

- **Barra de contexto (Foco / Mana):** opcional, no fim da v1 (T15 e T16). Pode sair da v1 sem afetar o resto.
- **Custo da sessão:** fora da v1. OpenTelemetry, ou qualquer outra fonte de custo, só entra depois da v1 e com nova aprovação do usuário, porque exige mudar o `env` do `~/.claude/settings.json` e criar um receptor OTLP local.
