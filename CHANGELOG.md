# Changelog

O que muda em cada entrega do Agent Quest, do ponto de vista de quem usa. As tarefas citadas entre parênteses estão no [plano da v1](docs/plano/v1.md).

## Não lançado

### Adicionado

- Painel no navegador, em `http://127.0.0.1:47821/`: equipe com as instâncias de cada papel, linha de ação e barra de saúde; cartão do ticket com as etapas; atividade com os eventos mais recentes no topo; indicadores do topo; e, sem sessões, os passos para ligar a captura com a hora do último evento recebido. Tudo sem script nem estilo inline e sem nada carregado da internet. (T10a)
- Temas Escritório e Guilda, com alternância por botões, teclas `1`, `2` e `T` e pelo endereço (`#escritorio`, `#guilda`); o navegador guarda a escolha. Trocar de tema não mexe no estado nem na conexão. (T10a)
- Conexão ao vivo com o servidor, com o selo "conectando", "ao vivo", "reconectando" ou "desconectado" e reconexão automática; seletor de sessão no topo, da mais recente para a mais antiga. Nesta fase, o servidor ainda não monta sessões a partir dos eventos, então o painel mostra o estado sem sessões. (T11a)
- Cena com as seis salas do tema: um token por agente na sala do seu papel, balão com a ação atual, até 3 tokens por sala e "+N", e a copa (taverna) para os subagentes que terminaram. Ainda sem animações. (T12a)
- Layout responsivo: três colunas a partir de 1280 px, duas de 820 a 1279 px e uma abaixo disso, sem rolagem horizontal até 360 px. (T10b)
- Testes de ponta a ponta com `npm run test:e2e`, usando o Microsoft Edge instalado, sem baixar navegadores. Pedem `npm install` uma vez, com internet, para o `@playwright/test`, a única dependência de desenvolvimento. (T10b)
- Guia [O painel](docs/guias/painel.md), primeira versão. (T10a, T11a, T12a e T10b)
- Tempo real, parte adiantada: `GET /events` (Server-Sent Events) envia `hello` e o estado completo a cada conexão, com sinal de vida a cada 15 segundos e até 8 painéis ao mesmo tempo (o nono recebe 503). `GET /api/state` devolve o mesmo estado de uma vez. As duas rotas seguem as regras de segurança do painel. O `clients` do `/api/health` conta as conexões abertas. Nesta fase, o estado vem vazio, até a ligação com o processamento dos eventos. (T9a, parte adiantada)
- Captura de eventos: plugin `agent-quest`, do marketplace local `agent-quest-local`, com os 15 hooks do ADR 0001, todos assíncronos. O encaminhador nunca imprime nada, sempre sai com código 0, termina em até 2 segundos, só envia para `127.0.0.1` e sai na hora quando o servidor está desligado. (T4)
- `npm run capture:deploy`: confere a captura, copia para `%LOCALAPPDATA%\agent-quest\marketplace\` sem deixar arquivo pela metade (pode rodar com sessões abertas) e imprime os comandos de testar, instalar, pausar, retomar e remover. Nunca executa o `claude`, e avisa quando `AGENT_QUEST_HOME` está definida ou a pasta está no OneDrive. (T4)
- Guia [Ligar, pausar e remover a captura](docs/guias/captura.md). Os comandos `claude plugin` do guia ainda vão ser conferidos no marco "Primeira luz". (T4)
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
