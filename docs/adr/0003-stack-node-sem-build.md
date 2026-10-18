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

## Complemento de 18/10/2026: tipos do Node no editor

**Contexto.** Com `// @ts-check` e `"strict": true` no `jsconfig.json`, todo arquivo que importa `node:*` mostra "Cannot find name 'node:fs'" no editor, porque o projeto não tem `@types/node`. Arquivos que usam `process` ou `Buffer` como globais mostram "Cannot find name 'process'". A checagem vale mais justamente onde ficam os contratos (normalizador, reducer, encaminhador), e esses arquivos importam `node:crypto`, `node:fs` e `node:http`.

**Decisão.**

- Um arquivo local de declarações, `types/node.d.ts`, sem dependência e só para o editor:

  ```ts
  declare module 'node:*';
  interface ImportMeta { readonly dirname: string; readonly filename: string; }
  ```

  A primeira linha faz todo import `node:*` valer `any`. A segunda declara `import.meta.dirname` e `import.meta.filename`, que existem no Node 24.
- O `jsconfig.json` inclui `types/**/*`. `// @ts-check` e `"strict": true` continuam valendo.
- Convenção: no servidor, na captura e nos scripts, `process` e `Buffer` são sempre importados (`import process from 'node:process'`, `import { Buffer } from 'node:buffer'`), nunca usados como globais. APIs que o Node e o navegador compartilham (`URL`, `AbortController`, `setTimeout`, `TextEncoder`, `structuredClone`, `fetch`) já vêm do `lib` do `jsconfig.json`.
- Validação feita em 18/10/2026 com o TypeScript 6.0.3 que vem com o VS Code, num projeto de teste com o mesmo `jsconfig` e `"type": "module"`: sem o arquivo, cada import `node:*` dá erro; com ele, os imports passam, e um erro de tipo proposital no código do projeto continua sendo acusado. Um `process` global sem import continua dando erro, o que reforça a convenção.

**Alternativas consideradas.**

- **`@types/node` como devDependency.** Dá os tipos completos das APIs do Node e funciona offline depois de instalado. Porém seria uma segunda devDependency, e o usuário aprovou `@playwright/test` como a única. Também exigiria `npm install` só para o editor. Fica como proposta para o usuário: se ele aprovar, o `@types/node@24` substitui o `types/node.d.ts`, que é apagado no mesmo commit, para não haver declarações duplicadas.
- **Tirar `// @ts-check` dos arquivos que importam `node:*`.** Desliga a checagem justamente no normalizador, no reducer e no encaminhador.
- **Aquisição automática de tipos do editor.** Baixa tipos da internet por conta própria, não está documentada para o `jsconfig.json` e dá resultados diferentes em cada máquina.
- **Declarar à mão um subconjunto dos módulos do Node.** Exigiria manutenção, e um tipo escrito errado engana mais do que `any`.

**Consequências.**

- Os tipos e contratos do próprio projeto (`shared/contract.js` e as assinaturas em JSDoc) continuam checados. As chamadas às APIs do Node não são checadas no editor e ficam cobertas pelos testes.
- Nenhuma dependência nova, e o editor não baixa nada da internet.
