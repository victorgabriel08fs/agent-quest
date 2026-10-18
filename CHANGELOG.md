# Changelog

O que muda em cada entrega do Agent Quest, do ponto de vista de quem usa. As tarefas citadas entre parênteses estão no [plano da v1](docs/plano/v1.md).

## Não lançado

### Adicionado

- Servidor local: `npm start` sobe o servidor em `http://127.0.0.1:47821/`, sem `npm install` e sem dependências. A porta pode ser trocada com `--port`, `AGENT_QUEST_PORT` ou `config.json`, e um segundo início avisa que o servidor "já está rodando". (T2)
- `npm run dev`: o mesmo servidor com `node --watch`, que reinicia sozinho quando o código do servidor muda. (T2)
- Diretório de dados em `%LOCALAPPDATA%\agent-quest\`, fora do OneDrive, ou na pasta indicada por `AGENT_QUEST_HOME`, com aviso no terminal se estiver dentro do OneDrive. O `runtime.json`, gravado ao iniciar e apagado ao parar com Ctrl+C, diz à captura onde o servidor está. (T2)
- Proteções do servidor: escuta só em `127.0.0.1`, aceita só os endereços `127.0.0.1` e `localhost` e só a própria origem, não tem CORS e envia em toda resposta a política de segurança de conteúdo e os demais cabeçalhos do ADR 0006. (T2)
- `GET /api/health`, para conferir se o servidor está no ar. (T2)
- Guia [Iniciar e parar o servidor](docs/guias/servidor.md) e índice da documentação em [docs/README.md](docs/README.md). (T2)
- Estrutura do projeto, sem dependências de execução, e `npm test`, que roda os testes de unidade e de integração no PowerShell e no Git Bash. (T1)

### Observações

- No Windows, parar o `npm run dev` pode deixar o `runtime.json` com o `pid` de um processo que já terminou. É inofensivo: a captura o ignora, e o próximo início o substitui. (T2)
