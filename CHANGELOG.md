# Changelog

O que muda em cada entrega do Agent Quest, do ponto de vista de quem usa. As tarefas citadas entre parênteses estão no [plano da v1](docs/plano/v1.md).

## Não lançado

### Adicionado

- Recepção dos eventos da captura em `POST /hooks`: só aceita pedidos com o token da execução (lido do `runtime.json`), sem origem de navegador, em JSON e com até 1 MiB. Responde na hora e processa depois, para nunca segurar o Claude Code. (T3)
- Eventos repetidos em até 5 segundos são descartados, e a fila de processamento guarda até 10 000 eventos; cheia, descarta os mais antigos. (T3)
- Contadores no `/api/health`: `received`, `accepted`, `rejected`, `deduped`, `dropped` e `ignored`, mais `lastEventAt` com a hora do último evento recebido. A resposta nunca traz conteúdo de evento. (T3)
- `--debug-dump`, só para depuração: grava os eventos recebidos em `%LOCALAPPDATA%\agent-quest\dumps\`, com aviso de dados sensíveis no início. Sem a opção, nada é gravado. (T3)
- Servidor local: `npm start` sobe o servidor em `http://127.0.0.1:47821/`, sem `npm install` e sem dependências. A porta pode ser trocada com `--port`, `AGENT_QUEST_PORT` ou `config.json`, e um segundo início avisa que o servidor "já está rodando". (T2)
- `npm run dev`: o mesmo servidor com `node --watch`, que reinicia sozinho quando o código do servidor muda. (T2)
- Diretório de dados em `%LOCALAPPDATA%\agent-quest\`, fora do OneDrive, ou na pasta indicada por `AGENT_QUEST_HOME`, com aviso no terminal se estiver dentro do OneDrive. O `runtime.json`, gravado ao iniciar e apagado ao parar com Ctrl+C, diz à captura onde o servidor está. (T2)
- Proteções do servidor: escuta só em `127.0.0.1`, aceita só os endereços `127.0.0.1` e `localhost` e só a própria origem, não tem CORS e envia em toda resposta a política de segurança de conteúdo e os demais cabeçalhos do ADR 0006. (T2)
- `GET /api/health`, para conferir se o servidor está no ar. (T2)
- Guia [Iniciar e parar o servidor](docs/guias/servidor.md), com solução de problemas, e índice da documentação em [docs/README.md](docs/README.md). (T2 e T3)
- Estrutura do projeto, sem dependências de execução, e `npm test`, que roda os testes de unidade e de integração no PowerShell e no Git Bash. (T1)

### Alterado

- Com `AGENT_QUEST_HOME` definida, o início avisa que a captura só encontra o servidor se o Claude Code tiver a mesma variável, com o mesmo valor. No uso normal, a recomendação é não definir a variável. (T2, ajuste)
- As mensagens de porta ocupada e de porta sem permissão sugerem o comando do jeito como o servidor foi iniciado: `npm start -- --port`, `npm run dev -- --port` ou `node server/main.js --port`. (T2, ajuste)
- O aviso do OneDrive explica como usar outra pasta: definir `AGENT_QUEST_HOME` como variável de ambiente do usuário do Windows e reabrir os terminais e o VS Code, para o Claude Code ver o mesmo valor. (T2, ajuste)

### Observações

- No Windows, parar o `npm run dev` pode deixar o `runtime.json` com o `pid` de um processo que já terminou. É inofensivo: a captura o ignora, e o próximo início o substitui. (T2)
