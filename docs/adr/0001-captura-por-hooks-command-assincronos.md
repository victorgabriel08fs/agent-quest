# ADR 0001: Captura por hooks `command` assíncronos

- **Status:** proposta (aguarda aprovação do usuário)
- **Data:** 17/10/2026

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
