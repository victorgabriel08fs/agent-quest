# Documentação do Agent Quest

O Agent Quest é um painel local e gamificado que mostra, em tempo real, o que cada agente do Claude Code está fazendo. Esta pasta reúne os guias de uso, a arquitetura, as decisões de design e o plano da versão em andamento.

## Guias de uso

| Guia | O que cobre |
|---|---|
| [Primeira luz: ligar o painel e a captura](guias/primeira-luz.md) | Comece por aqui: quando o marco pode acontecer, iniciar e parar o servidor (`npm start` e `npm run dev`), copiar, testar e instalar a captura, `/reload-plugins`, abrir o painel e escolher a sessão, o que o painel ainda não mostra, pausar e remover a captura e por que não definir `AGENT_QUEST_HOME` |
| [Iniciar e parar o servidor](guias/servidor.md) | Requisitos, `npm start` e `npm run dev`, porta, `config.json` e a chave `roles`, diretório de dados e `AGENT_QUEST_HOME`, `runtime.json`, `--debug-dump`, como parar em cada terminal, mensagens comuns e erros no terminal, `/api/health`, `/events` e `/api/state`, sessões em memória, o relógio do estado e a equipe de `.claude/agents/`, solução de problemas e segurança |
| [O painel](guias/painel.md) | Como abrir, o que aparece ao vivo, equipe, ticket e etapas, cena, atividade, indicadores, temas e atalhos, selo de conexão, seletor de sessão, estado sem sessões, o que ainda não está ligado e os testes de ponta a ponta |
| [Ligar, pausar e remover a captura](guias/captura.md) | O que a captura faz e nunca faz, eventos enormes resumidos e o orçamento de tempo, `npm run capture:deploy`, teste sem instalar, instalação, `/reload-plugins`, confiança da pasta, pausar, remover, atualizar e versão da captura, `AGENT_QUEST_HOME` dos dois lados e solução de problemas |

## Arquitetura

| Documento | O que cobre |
|---|---|
| [Visão geral](arquitetura/visao-geral.md) | Fluxo de dados, componentes, falhas, segurança, limites, estrutura de pastas, rotas e como rodar localmente |
| [Modelo de eventos](arquitetura/modelo-de-eventos.md) | Envelope da captura, fatos, eventos canônicos, regras do painel, contrato servidor → painel, minimização e redação |

## Decisões (ADRs)

| ADR | Decisão |
|---|---|
| [0001](adr/0001-captura-por-hooks-command-assincronos.md) | Captura por hooks `command` assíncronos |
| [0002](adr/0002-captura-instalada-como-plugin-local.md) | Captura instalada como plugin de um marketplace local |
| [0003](adr/0003-stack-node-sem-build.md) | Node 24, JavaScript ESM sem build e zero dependências de runtime |
| [0004](adr/0004-tempo-real-com-sse.md) | Tempo real com Server-Sent Events |
| [0005](adr/0005-estado-em-memoria.md) | Estado só em memória na v1, com dados fora do OneDrive |
| [0006](adr/0006-seguranca-do-servidor-local.md) | Segurança do servidor local e dos dados dos eventos |
| [0007](adr/0007-identidade-dos-agentes.md) | Identidade dos agentes e papéis do time |
| [0008](adr/0008-fontes-dos-indicadores.md) | De onde vem cada indicador do painel |
| [0009](adr/0009-tema-como-camada.md) | Tema como camada de apresentação |
| [0010](adr/0010-estrategia-de-testes.md) | Estratégia de testes |

## Plano

- [Plano da v1](plano/v1.md): tarefas, ordem de execução, critérios de aceite e o marco "Primeira luz".

## Pesquisa

- [Hooks, subagentes e telemetria do Claude Code](pesquisa/hooks-claude-code.md) (em inglês): levantamento que embasou a captura.

## Outros

- [README do projeto](../README.md): o que é o Agent Quest, início rápido, privacidade e situação do projeto.
- [Sonda do T0](../tools/probe/README.md): ferramenta de validação da captura e roteiro da sessão de teste.
- [Mockup do painel](../mockups/painel.html): referência visual aprovada. Abra o arquivo direto no navegador.
- [CHANGELOG](../CHANGELOG.md): o que mudou em cada entrega.
- [CLAUDE.md](../CLAUDE.md): regras do produto, time, fluxo de trabalho e convenções do projeto.
