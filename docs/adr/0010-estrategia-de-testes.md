# ADR 0010: Estratégia de testes

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

## Contexto

O time divide os testes: cada dev escreve os unitários do que implementou, e o tester escreve integração e ponta a ponta. Tudo precisa rodar offline no Windows (PowerShell e Git Bash), com poucas dependências.

## Decisão

- **Unidade e integração:** `node:test` e `node:assert`, sem dependências. Comando: `npm test`, que chama o executor `scripts/run-tests.mjs` (complemento de 18/10/2026, abaixo).
- **Pastas:**
  - `test/unit/server/`, `test/unit/web/`, `test/unit/capture/`: unitários dos devs;
  - `test/unit/shared/`: testes do contrato compartilhado, `shared/contract.js` (complemento de 18/10/2026);
  - `test/unit/scripts/`: testes dos scripts de `scripts/` (executor de testes, deploy da captura, injetor) (complemento de 18/10/2026);
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

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão, com estas definições:

- `@playwright/test` aprovado como a única devDependency do projeto.
- Sessão de teste do T0 autorizada. O próprio usuário roda o roteiro, com o orquestrador acompanhando.
- Os roteiros manuais com o Claude Code real passam a ser três: T0, marco "Primeira luz" e marco de aceite da v1 (`docs/plano/v1.md`).

## Complemento de 18/10/2026: executor de testes

**Contexto.** No T1 apareceu um problema: passar globs (`test/unit/**/*.test.js`) ao `node --test` pelo `package.json` não é confiável no Windows. O cmd, o PowerShell e o Git Bash tratam globs de jeitos diferentes, e um glob que não encontra nada pode fazer o `node --test` passar sem rodar nenhum teste.

**Decisão.**

- `npm test` roda `node scripts/run-tests.mjs`. O executor procura os `*.test.js` em `test/unit/` e `test/integration/` (com subpastas) e chama `node --test` com a lista explícita de arquivos, em ordem.
- Sai com erro se não encontrar nenhum teste ou se um caminho pedido não existir. Aceita pastas ou arquivos (`npm test -- test/unit/shared`) e repassa as opções do `node --test` na forma `--opção=valor`.
- Só usa módulos nativos do Node. `test/e2e/` fica fora: roda com `npm run test:e2e`.
- O próprio executor tem testes em `test/unit/scripts/`.

**Consequência.** O mesmo comando funciona igual no PowerShell e no Git Bash, e uma suíte vazia por engano falha em vez de passar.
