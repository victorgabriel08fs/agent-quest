# ADR 0005: Estado só em memória na v1, com dados fora do OneDrive

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

## Contexto

O replay ficou para depois da v1. Os eventos podem conter código, comandos e segredos. O repositório fica no OneDrive, que sincroniza com a nuvem: gravar eventos ali contrariaria a regra "100% local".

## Decisão

- O servidor mantém em memória as sessões, os agentes, os tickets e, por sessão, os últimos 200 eventos canônicos, já minimizados e redigidos. Nenhum evento vai para o disco.
- Em disco fica só o `runtime.json` (porta, token, pid, versão e início), no diretório de dados:
  - Windows: `%LOCALAPPDATA%\agent-quest\` (fora do OneDrive);
  - outros sistemas: `$XDG_STATE_HOME/agent-quest` ou `~/.local/state/agent-quest`;
  - a variável `AGENT_QUEST_HOME` sobrescreve. O servidor avisa no terminal se o caminho estiver dentro de uma pasta do OneDrive.
- O mesmo diretório guarda a cópia instalada do plugin (`marketplace\`) e, opcionalmente, um `config.json` (porta e sobrescrita de papéis).
- As preferências do painel (tema, sessão fixada, filtros, modo discreto) ficam no `localStorage` do navegador.
- `--debug-dump`, desligado por padrão, grava os envelopes brutos em `<dados>/dumps/` para depuração e avisa no início.
- Limpeza da memória: sessão encerrada sai após 30 min; sessão sem eventos, após 6 h.

## Alternativas consideradas

- **JSONL com os eventos canônicos.** Seria a base natural do replay, mas é dado sensível em disco sem uso na v1.
- **SQLite (`node:sqlite`).** Ainda experimental no Node 24 e desnecessário sem consultas.

## Consequências

- Reiniciar o servidor zera o painel. As sessões reaparecem no próximo evento, com um ticket implícito "em andamento".
- Os eventos canônicos já têm `seq` e `ts`, então gravá-los em JSONL quando o replay entrar não muda o contrato.

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão.

## Complemento de 18/10/2026: `AGENT_QUEST_HOME` dos dois lados

O servidor, o `npm run capture:deploy` e o encaminhador resolvem o diretório de dados cada um com o próprio ambiente. O encaminhador roda como hook, filho do processo do Claude Code. Se `AGENT_QUEST_HOME` estiver definida só no terminal do servidor, o encaminhador procura o `runtime.json` no diretório padrão, não encontra e sai em silêncio: a captura parece desligada, sem nenhum erro.

Decisão:

- **Uso normal:** não definir `AGENT_QUEST_HOME`. O diretório padrão (`%LOCALAPPDATA%\agent-quest\`) já fica fora do OneDrive. A variável existe para isolar testes e desenvolvimento, que usam um diretório temporário e porta efêmera, sem o Claude Code no meio.
- **Se o usuário precisar de outro diretório:** a variável tem de valer igual para o servidor, para o `capture:deploy` e para o Claude Code, no terminal e no VS Code. O caminho é defini-la como variável de ambiente do usuário do Windows e reabrir terminais e o VS Code. Quem faz isso é o usuário (regra da captura no plano).
- Ao iniciar com `AGENT_QUEST_HOME` definida, o servidor imprime um aviso de que a captura só encontra este servidor se o Claude Code tiver a mesma variável (critério no T2 do plano).
- Na solução de problemas ("nenhum evento chegando"), conferir se a variável é a mesma dos dois lados.
