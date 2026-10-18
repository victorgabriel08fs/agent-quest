# ADR 0010: Estratégia de testes

- **Status:** proposta (aguarda aprovação do usuário)
- **Data:** 17/10/2026

## Contexto

O time divide os testes: cada dev escreve os unitários do que implementou, e o tester escreve integração e ponta a ponta. Tudo precisa rodar offline no Windows (PowerShell e Git Bash), com poucas dependências.

## Decisão

- **Unidade e integração:** `node:test` e `node:assert`, sem dependências. Comando: `npm test`.
- **Pastas:**
  - `test/unit/server/`, `test/unit/web/`, `test/unit/capture/`: unitários dos devs;
  - `test/integration/`: servidor real em porta efêmera, encaminhador como processo filho, SSE (tester);
  - `test/e2e/`: navegador real (tester);
  - `test/fixtures/hooks/`: cenários de hooks sanitizados, gerados no T0;
  - `test/fixtures/state/`: snapshots de estado para os testes do painel;
  - `test/fixtures/transcripts/`: transcripts sintéticos (T15).
  - Fixtures em `.json`, porque o `.gitignore` ignora `*.jsonl`.
- **O que os unitários cobrem:** funções puras (normalização, redação, detecção de testes, papéis, reducer de estado, store do painel, temas e views que geram HTML).
- **Ponta a ponta:** `@playwright/test` usando o Microsoft Edge já instalado (`channel: 'msedge'`), sem baixar navegadores. Comando: `npm run test:e2e`. É a única devDependency do projeto.
- **Regras:**
  - testes nunca usam o diretório de dados real nem a porta padrão: sempre `AGENT_QUEST_HOME` temporário e porta efêmera;
  - nenhum teste acessa a internet;
  - funções de estado recebem o relógio (`now`) como parâmetro, para testar limpeza e inatividade sem esperar.
- **Claude Code real:** roteiros manuais, com o usuário, no T0 e no marco de aceite da v1.

## Alternativas consideradas

- **Jest ou Vitest.** Dependências para o que o `node:test` já faz.
- **jsdom ou happy-dom.** As views geram HTML como texto, testável no Node; o que depende do DOM real vai para o ponta a ponta.
- **Sem ponta a ponta.** Ficariam sem cobertura teclado, `prefers-reduced-motion`, ausência de rolagem horizontal e violações de CSP.

## Consequências

- `npm install` só é necessário para o ponta a ponta, uma vez, com internet.
- Os cenários do T0 viram a base comum de testes de backend, frontend e integração.
