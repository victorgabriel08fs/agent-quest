# ADR 0003: Node 24, JavaScript ESM sem build e zero dependências de runtime

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

## Contexto

O Agent Quest roda 100% local e precisa funcionar offline depois de instalado, com poucas dependências. O ambiente é Windows 11 com Node 24.20 já instalado (via nvm). O mockup aprovado é HTML, CSS e JavaScript puros.

## Decisão

- **Runtime:** Node 24 (`"engines": { "node": ">=24" }`). O encaminhador usa só APIs que existem desde o Node 18, porque o PATH do Claude Code pode apontar para outra versão do nvm.
- **Servidor:** módulos nativos (`node:http`, `node:crypto`, `node:fs`, `node:path`, `node:os`), sem framework.
- **Linguagem:** JavaScript ESM com tipos em JSDoc. `// @ts-check` e um `jsconfig.json` dão checagem de tipos no VS Code, que já traz o TypeScript embutido, sem instalar nada.
- **Frontend:** módulos ES servidos pelo próprio servidor, sem bundler, sem framework e sem CDN. Fontes do sistema e emoji, como no mockup.
- **Contrato compartilhado:** `shared/contract.js` (constantes e typedefs), importado pelo servidor e pelo navegador.
- **Testes:** `node:test` e `node:assert` (ADR 0010).
- **Dependências:** nenhuma de runtime. Uma única devDependency, `@playwright/test`, para os testes de ponta a ponta (ADR 0010).

## Alternativas consideradas

- **Express ou Fastify.** Conveniência dispensável para meia dúzia de rotas, e uma dependência a mais.
- **TypeScript com build.** Tipos mais fortes, mas exige compilador e um passo de build no frontend. O Node 24 executa `.ts` removendo tipos, o navegador não.
- **React, Preact ou Vite.** Build e dependências para uma tela que o mockup já resolve em JS puro.

## Consequências

- `npm start` funciona sem `npm install`.
- Tipos só no editor. Os contratos ficam protegidos por testes de contrato.
- O mesmo código puro (store, temas, regras) roda no navegador e nos testes do Node.

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão. O usuário aprovou `@playwright/test` como a única devDependency (ADR 0010). O runtime continua sem dependências.
