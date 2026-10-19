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

## Complemento de 18/10/2026: formato e sanitização dos cenários de hooks

Os cenários de `test/fixtures/hooks/` são a base comum do T5, do T7, do T9 e do injetor. Por isso o formato é um contrato entre o T0 e essas tarefas. Mudar o formato exige atualizar este complemento.

**Formato.** Um arquivo `.json` por cenário:

```json
{
  "name": "paralelo-mesmo-tipo",
  "description": "Dois probe-worker em paralelo",
  "events": [
    { "dt": 0,  "env": { "projectDir": "C:\Users\usuario\…\agents-quest", "entrypoint": "cli" }, "payload": { "hook_event_name": "UserPromptSubmit", "…": "…" } },
    { "dt": 37, "env": { "projectDir": "…", "entrypoint": "cli" }, "payload": { "hook_event_name": "PreToolUse", "…": "…" } }
  ]
}
```

- `events` vem na ordem em que os eventos chegaram (a ordem de gravação da sonda), inclusive quando um Post chega antes do Pre. Essa ordem é o que o reducer recebe.
- `dt`: milissegundos desde o evento anterior do cenário, medidos pela hora de gravação da sonda (equivale à chegada no servidor). É 0 no primeiro evento e nunca negativo.
- `env`: o mesmo `env` do envelope v1 (modelo de eventos, seção 1). `projectDir` vem de `CLAUDE_PROJECT_DIR`. `entrypoint` vem de `CLAUDE_CODE_ENTRYPOINT`, a variável candidata do V11; se o T0 indicar outra, o G0b atualiza este ponto. Fica `null` quando não há valor.
- `payload`: o JSON do hook, sanitizado como abaixo.
- O injetor (T9b) monta, para cada evento, um envelope v1 com `sentAt` igual à hora do envio, `env` e `payload` do cenário, e respeita `dt` (ou não, com `--fast`).

**Sanitização** (`tools/probe/sanitize.mjs`). O repositório é público, e os cenários não podem ter conteúdo real nem dados pessoais:

- **Mantém:**
  - a estrutura do payload (chaves, números, booleanos e listas);
  - nomes de eventos e de ferramentas, tipos de agente, status e outros valores curtos de enumeração;
  - a primeira linha de cada comando, até 160 caracteres, com a redação da seção 10 do modelo de eventos. É acima do limite de 120 do normalizador, para o T5 testar o corte. A redação usada é a mesma função do normalizador, `server/domain/redact.js`, importada pelo `sanitize.mjs`;
  - descrições até 80 caracteres, padrões de busca até 60 e a primeira linha dos erros até 160, todos redigidos;
  - de saídas e erros, só as linhas de resumo dos testes. Os padrões de resumo e o limite `MAX_KEPT` são testados no texto limpo pelas etapas 1 e 7 da redação (sem invisíveis, controles e ANSI, sem redigir), e a linha mantida passa por `keep(...)`. Antes, resumos coloridos viravam "linha omitida" (achado do documentador, 19/10/2026). Os padrões incluem o do Playwright da seção 6 do modelo de eventos;
  - do pedido do usuário, só o comando `/...` ou as tags `<...>` das notificações do sistema;
  - os caminhos, com o nome do usuário da pasta pessoal trocado por `usuario`, inclusive na forma `c--Users-<nome>-...` das pastas de `~/.claude/projects/`.
- **Troca por marcadores `«tipo#n:tamanho»`:** conteúdo de arquivo, saídas, pedidos, textos do assistente e o resto. O mesmo texto vira sempre o mesmo marcador dentro do cenário, então igualdades como o `tool_input` do PermissionRequest e o do PreToolUse, base do `inputHash`, continuam valendo.
- **Troca ids reais por ids sintéticos.** Vale para os valores das chaves de id (`session_id`, `prompt_id`, `tool_use_id`, `agent_id`, `agentId`, `id`, `task_id`, `request_id`, `uuid` e afins) e para toda ocorrência desses mesmos valores dentro de outras strings: caminhos de transcript, `agent-<id>.jsonl`, `outputFile` e ids dentro das tags das notificações de tarefa. Regras:
  - o mesmo id real vira sempre o mesmo id sintético no cenário, então os elos (`tool_response.agentId` com `agent_id`, `background_tasks[].id`, `session_id` dos subagentes) continuam valendo;
  - o id sintético tem o mesmo comprimento, o mesmo prefixo (`toolu_`, o `a` inicial dos `agent_id`) e os mesmos separadores (hífens de UUID), para o normalizador ver a mesma forma.
- **Corte e contagem:** todo texto mantido é cortado com `redactAndCut` e medido com `charLength` (modelo de eventos, seção 10), sem corte próprio. Se o texto cortado mais o marcador `«tipo#n:tamanho»` não for ponto fixo de `redact`, fica só o marcador.
- **Conferência antes de gravar.** O cenário é recusado se tiver possível segredo (qualquer string que mude ao passar por `redact`), string acima de 200 caracteres (`charLength`) fora dos marcadores, o nome do usuário ou qualquer id original. `--ignore-audit` só pode ser usado com revisão do orquestrador, e o tester confere o cenário de novo.
- Os cenários não guardam `env.names` (a lista de variáveis de ambiente). Ela só aparece, resumida ao que interessa ao V11, em `docs/pesquisa/validacao-captura.md`.

**O que a sonda grava no JSONL bruto** (local, em `%LOCALAPPDATA%\agent-quest\probe\`, apagado depois do T0): o payload completo; os nomes, sem valores, das variáveis `CLAUDE*` (inclusive `CLAUDECODE`), `TERM_PROGRAM*`, `VSCODE_*` e `WT_SESSION`; e os valores só de `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT` e `TERM_PROGRAM`.

## Complemento de 18/10/2026: teste de tempo da redação

Um limite absoluto (por exemplo, 10 ms para 4 KiB) depende da máquina e não diferencia um código linear lento de um quadrático rápido. O teste de `redact` e de `redactAndCut` mede o **crescimento**:

- **Entradas patológicas**, cada uma montada em 4 KiB e em 32 KiB repetindo um mesmo trecho:
  - `a=` repetido;
  - aspa sem fechamento seguida de `\"` repetido;
  - `--x ` repetido;
  - `-----BEGIN PRIVATE KEY-----` sem END;
  - `://a:a:a:` repetido;
  - um caractere invisível entre cada letra;
  - as entradas do B10 (19/10/2026), cada uma repetida até o tamanho:
    - `.-u`, `]-u`, `.--user=` e `ESC]-u`;
    - `ESC]eyJ`, `ESC[0~eyJ` e uma OSC completa seguida de `eyJ`;
    - `a=` (nome não sensível) e `ESC]8;;x;`;
    - `eyJa.`, `://a:a` e `a-a-` (nome de cabeçalho sem `:`).

    Em todas, a expressão começa e falha várias vezes; elas são o teste de regressão da "Linearidade por construção" (modelo de eventos, seção 10, etapa 6);
  - `token=` repetido;
  - `Authorization: ` repetido.
- **Medição:** para cada entrada e tamanho, o melhor tempo de N = 7 execuções, depois de uma execução de aquecimento.
- **Critérios**, por entrada:
  - `t(32 KiB)` abaixo de 100 ms;
  - `t(32 KiB) / max(t(4 KiB), 1 ms)` no máximo 32. Linear daria cerca de 8 e quadrático cerca de 64; o piso de 1 ms evita razão instável com tempos muito pequenos.
- O teste roda no `npm test` normal. Se falhar por ruído da máquina, a regra é rodar de novo uma vez; falhar duas vezes seguidas é bug.

## Complemento de 19/10/2026: testes de tempo estáveis

Testes que medem tempo seguem estas regras:

- **Contador antes de relógio.** Quando o que importa é quantas vezes algo roda ou se um caminho foi tomado (por exemplo, se o orçamento de tempo do encaminhador foi conferido), o teste usa um contador determinístico ou um relógio injetado, nunca o relógio real. É o caso do teste do encaminhador em `forward.test.js`.
- **Relógio real só com referência do mesmo teste.** Para o custo de uma operação longa (`JSON.parse` de 1 MB no normalizador, 16 MiB no encaminhador), o teste mede no mesmo processo, logo antes, uma calibração da mesma operação sobre uma entrada de referência. Ele compara pela razão, com o melhor de N medições, e não por um número absoluto. Uma mediana medida em outro momento não capta a disputa de CPU durante um `JSON.parse` longo.
- **Crescimento** segue o complemento "teste de tempo da redação": melhor de N, razão com piso de 1 ms e limite absoluto só como teto largo.
- **Uma nova tentativa** é permitida em caso de ruído da máquina. Falhar duas vezes seguidas é bug.
