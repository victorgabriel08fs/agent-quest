# ADR 0001: Captura por hooks `command` assíncronos

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

## Contexto

O painel precisa dos eventos do Claude Code em tempo real, inclusive de cada subagente. As regras do produto exigem que a captura nunca trave nem atrase os agentes e que termine rápido e em silêncio quando o servidor estiver fora do ar.

Fontes possíveis (detalhes em `docs/pesquisa/hooks-claude-code.md`):

- **Hooks**: a única fonte que traz `agent_id` por instância de subagente. Tipos `command`, `http`, `mcp_tool`, `prompt` e `agent`.
- **OpenTelemetry**: os eventos não trazem `agent_id`, a exportação acontece a cada 5 s e ligar exige variáveis no `~/.claude/settings.json`.
- **Transcripts**: formato interno do Claude Code, escrito de forma assíncrona.

O que foi conferido na documentação oficial (hooks reference, 17/10/2026) e medido nesta máquina:

- Hook síncrono segura o Claude Code até terminar: "By default, hooks block Claude's execution until they complete".
- `"async": true` só existe em `type: "command"`. O Claude Code "starts the hook process and immediately continues without waiting for it to finish", e os avisos de conclusão de hooks assíncronos ficam ocultos fora do modo verbose.
- Hook `http` com falha de conexão gera "non-blocking error", mostrado como aviso `<hook name> hook error` no transcript. Com o servidor desligado, cada chamada de ferramenta geraria um aviso.
- `SessionStart` não aceita `http`.
- Medido no Windows 11 do usuário: conexão recusada em porta fechada do loopback leva menos de 3 ms; iniciar um `node` que lê stdin e sai leva cerca de 60 ms (mediana de 8 execuções).

## Decisão

Todo evento capturado usa um hook `command` em forma exec (`"command": "node"` com `"args"`, sem shell) e `"async": true`, chamando um encaminhador próprio, `forward.mjs`, que:

1. lê o JSON do stdin (até 16 MiB), registra `sentAt` e corta strings longas;
2. lê `runtime.json` no diretório de dados e sai se o arquivo não existir ou se o `pid` registrado não estiver vivo;
3. faz `POST http://127.0.0.1:<porta>/hooks` com o token, com timeout de 1 s;
4. nunca escreve em stdout nem em stderr, sempre sai com código 0 e se encerra sozinho em no máximo 2 s.

Eventos assinados (15), sem `matcher`, porque o filtro fica no servidor: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `PreCompact` e `PostCompact`.

Ficam de fora: `MessageDisplay` (síncrono e carrega o texto do assistente), `PostToolBatch` (repete o que Pre/PostToolUse já trazem), `TaskCreated`/`TaskCompleted` (sem uso na v1) e os eventos de configuração e ambiente.

## Alternativas consideradas

- **`http` para tudo, menos SessionStart.** Não cria processo por evento e preserva a ordem. Porém falha de conexão vira aviso visível em cada chamada, e um servidor que aceita a conexão e não responde atrasa cada hook até o timeout. Viola "termina rápido e em silêncio".
- **Combinar `http` e `command`.** Herda o problema do `http` justamente nos eventos mais frequentes.
- **OpenTelemetry.** Não distingue dois subagentes do mesmo tipo, mexe no `env` do usuário e chega com 5 s de atraso.
- **Ler os transcripts.** Formato interno, que muda entre versões e é gravado com atraso. Não serve como fonte principal.
- **Encaminhador com `curl.exe`.** Inicia mais rápido, mas não garante saída 0, não lê o token nem corta strings sem truques frágeis.

## Consequências

- O Claude Code nunca espera a captura. Com o servidor desligado, o custo é só iniciar o processo, fora do caminho do agente.
- Um processo Node por evento. Estimativa a medir: com trabalho paralelo intenso (2 a 3 eventos por segundo), 10% a 15% de um núcleo. Se pesar, a alternativa registrada é usar `http` só em Pre/PostToolUse, opcionalmente, aceitando os avisos.
- Processos independentes podem entregar eventos fora de ordem. O servidor tolera isso (`docs/arquitetura/modelo-de-eventos.md`, seção 8).
- O encaminhador depende de `node` no PATH do processo do Claude Code, no terminal e no VS Code. Validar no T0.
- O encaminhador não pode imprimir nada: em hook assíncrono, um JSON no stdout chega ao modelo no turno seguinte. Isso vira teste obrigatório.
- Em `claude -p`, hooks assíncronos ainda rodando são encerrados no fim. Eventos finais podem se perder; o servidor fecha sessões por inatividade.
- Prova de que não bloqueia: com `claude --debug-file <arquivo>`, cada execução aparece como "moved to the background" (Claude Code 2.1.296 ou mais novo; o usuário está na 2.1.301).

## Fontes

- https://code.claude.com/docs/en/hooks (seções "Run hooks in the background", "HTTP hook fields", "Exit code output", "Debug hooks")
- `docs/pesquisa/hooks-claude-code.md`, seções 5, 8 e 9

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão. A confirmação do V10 no T0 (hooks assíncronos sem bloqueio, sem aviso e sem janela de console piscando, no terminal e no VS Code) é condição para o usuário instalar a captura no marco "Primeira luz" (`docs/plano/v1.md`, G0a). Se o V10 for refutado, esta ADR é reaberta com o usuário antes de qualquer instalação.

## Complemento de 18/10/2026: teto do corpo e unidades

O passo 1 da decisão ("corta strings longas") ganhou um teto: o corpo enviado nunca passa de 1 000 000 bytes, com até três passos genéricos de redução, sem o encaminhador saber o que o normalizador usa. Os cortes contam unidades UTF-16. Detalhes na seção 1 do modelo de eventos ("Unidades no encaminhador" e "Teto do corpo"). Motivo: um payload com muitas strings menores passava de 1 MiB, recebia 413 e o evento se perdia, depois de até 270 ms enviando cerca de 10 MiB.

## Complemento de 18/10/2026: prazo de 2 s na prática

O item 4 da decisão ("se encerra sozinho em no máximo 2 s") passa a ser lido assim: **até cerca de 2 s, salvo payloads patológicos com centenas de milhares de chaves**. Numa máquina calma, isso só aparece perto de 16 MiB; sob carga, também abaixo de 8 MiB (medidas na seção 1 do modelo de eventos). O tester da captura 0.1.1 mostrou que a redução síncrona do teto do corpo impedia o prazo de disparar: com centenas de milhares de chaves, o processo passou de 2 s, gastou CPU e perdeu o evento. A captura 0.1.2 traz três mudanças:
- o passo 1 da redução nunca é interrompido pelo tempo, para eventos normais saírem completos;
- os passos 2 e 3 ganham um orçamento de 1 s desde o início da redução, limitado a 1 750 ms desde a partida do processo, para guardar 250 ms para o POST. O tempo é conferido dentro dos laços, e os passos 1 e 2 são abandonados cedo quando um piso do tamanho de saída já passa do teto;
- um envelope de emergência de custo constante;
- um atalho: com stdin acima de 8 MiB, vai direto ao envelope de emergência. Motivo: o `JSON.parse` e a listagem das chaves de um objeto não podem ser interrompidos, e somados passam de 2 s no extremo de 16 MiB.

Detalhes na seção 1 do modelo de eventos, "Orçamento de tempo da redução". O Claude Code nunca espera nenhum desses casos, porque o hook é assíncrono. O que está em jogo é CPU e a perda do evento, não o bloqueio do agente.

## Complemento de 26/10/2026: resultado do T0 (V10) e captura 0.1.3

Revisão do G0b com a sessão de teste do T0 (`docs/pesquisa/validacao-captura.md`; Claude Code 2.1.310, terminal e VS Code). A decisão continua a mesma.

- **V10 confirmado.** As 298 execuções da sonda registradas no log foram para segundo plano. Nenhuma foi síncrona, nenhum `hook error` apareceu, e o usuário não viu janela piscando nem aviso, no terminal e no VS Code. O log usa dois formatos, e a prova de que não bloqueia passa a aceitar os dois:
  - "`Hooks: <Evento>` [...] moved to the background (N ms)", na maioria dos eventos;
  - "`<Evento>:<matcher>` [...] completed with status 0", no mesmo milissegundo de "Config-based async hook, backgrounding process", em Notification, SessionEnd, PreCompact, PostCompact e StopFailure.
- **Correção da consequência "o custo é só iniciar o processo, fora do caminho do agente".** Parte desse custo fica no caminho do Claude Code. Pelo formato do log, que não é documentado, o "(N ms)" parece ser o tempo entre o disparo do hook e a passagem dele para segundo plano. Nas 264 linhas da sessão: mediana de 39 ms, p95 de 878 ms, máximo de 3 448 ms. O script só começou a rodar depois disso, então o Claude Code espera a criação do processo, não o encaminhador. A decisão se mantém, porque a alternativa (`http`) gera aviso visível com o servidor desligado. **Validação:** no passo 3 do marco "Primeira luz", o usuário anota o maior N com o `forward.mjs`. Se o p95 passar de 500 ms com a máquina calma, ou se ele sentir lentidão, a alternativa registrada nas consequências (`http` só em Pre/PostToolUse) volta para decisão dele.
- **Eventos finais na saída do modo interativo também podem se perder.** 1 de 3 SessionEnd foi para segundo plano mas não gravou o evento, porque o Claude Code saiu antes. Antes, isso só estava previsto para `claude -p`. O servidor cobre o caso pelas regras de inatividade (`visao-geral.md`, "Limpeza").
- **Captura 0.1.3** (decisões 13 e 16 do usuário, 26/10/2026; detalhes na seção 1 do modelo de eventos). São duas mudanças compatíveis, num só deploy:
  1. **Preâmbulo do cliente.** No UserPromptSubmit, se o `prompt` começa com o bloco `<browser_instruction>…</browser_instruction>` que a extensão do VS Code injeta, o encaminhador tira o bloco antes de qualquer corte. É a única exceção à regra "o encaminhador não sabe o que o normalizador usa". Justificativa:
     - minimização: são cerca de 4 mil caracteres que não são do usuário;
     - com o corte de 1 KiB + 3 KiB, um pedido do usuário com mais de cerca de 3 mil caracteres perdia o começo, de onde sai o título.
  2. **`env.entrypoint`** passa a levar o valor de `CLAUDE_CODE_ENTRYPOINT` (V11: `cli` no terminal, `claude-vscode` na extensão), validado contra `^[A-Za-z0-9_.-]{1,64}$`. Fora disso, vai `null`.
- **Limites do encaminhador mantidos** (decisão 14). O maior payload real teve 10,6 KB. Ficam o corte de 4 096 unidades, o teto de 1 000 000 bytes e o atalho de 8 MiB, com a perda aceita nos dois casos patológicos da captura 0.1.2: passo 1 sem orçamento e CPU a 100% logo abaixo de 8 MiB.
