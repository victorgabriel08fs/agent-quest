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
| Barra de contexto (Foco / Mana) | `message.usage` da última resposta no transcript do agente; janela pelo modelo dessa resposta: 1 milhão por padrão, 200 mil só para as famílias sem 1M nativo (regra revista pelo usuário em 26/10/2026; ver o complemento) | Aproximada (T15 e T16, na v1 pela decisão 10). Some se o formato do transcript mudar |
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

- **Barra de contexto (Foco / Mana):** opcional, no fim da v1 (T15 e T16). Pode sair da v1 sem afetar o resto. **Revisto em 26/10/2026:** pela decisão 10 do usuário (`docs/plano/v1.md`), a barra entrou na v1 e deixou de ser opcional; T15 e T16 já foram entregues.
- **Custo da sessão:** fora da v1. OpenTelemetry, ou qualquer outra fonte de custo, só entra depois da v1 e com nova aprovação do usuário, porque exige mudar o `env` do `~/.claude/settings.json` e criar um receptor OTLP local.

## Complemento (26/10/2026, revisão do T15)

Refinamentos da barra de contexto, sem mudar o contrato. As regras completas estão no modelo de eventos, seção 6, "Contexto".

- **Janela de contexto: decisão do usuário de 26/10/2026 (opção A).** Substitui a regra aprovada em 18/10/2026, que era "200 mil, ou 1 milhão se o uso passar disso ou o modelo pedido indicar `[1m]`". A regra antiga errava para o modelo do próprio usuário. O SessionStart real traz `model: "claude-opus-5-5"`, sem `[1m]`, e pela documentação o Opus 4.7 e posteriores, o Sonnet 5 e posteriores, o Haiku 5.5 e os Fable rodam com 1M por padrão, sem sufixo (https://code.claude.com/docs/en/model-config, "1M context window"). Os transcripts locais compactam perto de 967 mil tokens, o padrão dessa janela. Com a regra antiga, 150 mil tokens apareciam como 75%, quando o real é 15%. Regra nova:
  - a janela sai do modelo da própria resposta lida (`message.model` da entrada com `usage`), que existe também nos transcripts de subagentes;
  - o padrão é 1 milhão;
  - 200 mil só para as famílias sem 1M nativo: Opus e Sonnet até 4.6, Haiku 4.x e Claude 3.x. Vale só quando o modelo pedido não termina em `[1m]`;
  - uso acima de 200 mil continua valendo 1 milhão.

  A lista é de modelos antigos, por isso não envelhece: pela documentação, os modelos novos já saem com 1M. Limitações aceitas:
  - com `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, ou com um gateway limitado a 200 mil, a barra mostra cerca de 1/5 do uso real;
  - um subagente em Opus 4.6 ou Sonnet 4.6 `[1m]` aparece com 200 mil até passar desse uso, porque o `[1m]` pedido só é conhecido para a sessão principal (SessionStart).

  Alternativas descartadas:
  - manter a regra antiga, que erra até 5 vezes abaixo de 200 mil;
  - sempre 1M, que erra com modelos antigos;
  - a status line (`context_window_size`), que exige configurar `statusLine`;
  - deduzir a janela pela compactação, que só funciona depois da primeira.

- **Depois de uma compactação**, a barra some até a próxima resposta do agente. A leitura do transcript para na marca de compactação (`compact_boundary`). Sem isso, a barra mostraria o valor de antes, perto do limite, logo depois de a compactação liberar o contexto. É o mesmo comportamento da status line do Claude Code (`current_usage` fica `null` depois do `/compact`). Alternativas descartadas:
  - manter o último valor: errado justamente no momento em que a compactação aparece no painel;
  - usar o tamanho pós-compactação que a marca registra (`compactMetadata.postTokens`): não é documentado e, nos transcripts reais conferidos, ficou de 2 a 5 vezes abaixo (7 compactações em 5 transcripts, Claude Code 2.1.301) do uso da resposta seguinte. A barra pularia logo depois;
  - zerar o contexto no reducer ao receber o PostCompact: a leitura seguinte traria o valor antigo de volta, porque continuaria achando a última resposta de antes.
- **`CLAUDE_CONFIG_DIR`** fica fora da v1. Com a pasta do Claude Code mudada, os transcripts saem de `~/.claude/projects`, a sonda recusa os caminhos e a barra não aparece. É uma falha segura. Aceitar a pasta da variável exigiria que o servidor visse o ambiente do Claude Code (mudança no envelope, seção 1) ou confiasse no caminho do próprio payload (afrouxa a pasta permitida). Uma alternativa barata para depois da v1 é aceitar também `<CLAUDE_CONFIG_DIR>/projects` quando a variável estiver no ambiente do próprio servidor.
- **Leitura travada** sem prazo na v1. As barras ficam com o último valor, e o resto do painel não é afetado. O leitor de `.claude/agents/` tem prazo e "listagem perdida" porque lê pastas de projeto, que podem estar na rede ou só na nuvem. A sonda lê só `~/.claude/projects`, que fica no disco local no caso normal.
