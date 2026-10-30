# Ligar, pausar e remover a captura

A captura é o que leva ao Agent Quest o que acontece no Claude Code. Ela é um plugin do Claude Code, o `agent-quest`, distribuído por um marketplace local, o `agent-quest-local`. A cada evento de uma sessão (pedido, ferramenta, subagente, fim de turno), o plugin chama um encaminhador que entrega o evento ao servidor do Agent Quest em `127.0.0.1`. Este guia mostra como copiar, testar, instalar, pausar, atualizar e remover a captura.

> **Situação nesta fase.** O encaminhador e o `npm run capture:deploy` estão prontos e cobertos por testes automáticos. A instalação no Claude Code de verdade (os comandos `claude plugin` e o `/reload-plugins`) ainda não foi feita: ela acontece no marco "Primeira luz" do [plano da v1](../plano/v1.md), depois que a validação dos hooks no Claude Code real (T0) confirmar que eles não travam nem mostram avisos. Os passos de instalação abaixo seguem a documentação do Claude Code e o [ADR 0002](../adr/0002-captura-instalada-como-plugin-local.md). Se algo sair diferente na prática, este guia será corrigido.

## Resumo rápido

| Quero... | Comando |
|---|---|
| Copiar a captura para a pasta de dados | `npm run capture:deploy` |
| Testar sem instalar | `claude --plugin-dir "<pasta do plugin>" --debug-file "<arquivo de log>"` (o deploy imprime o comando pronto) |
| Instalar (uma vez) | `claude plugin marketplace add "<pasta do marketplace>"` e `claude plugin install agent-quest@agent-quest-local` |
| Fazer valer numa sessão já aberta | `/reload-plugins` dentro da sessão |
| Pausar | `claude plugin disable agent-quest@agent-quest-local` e `/reload-plugins` |
| Retomar | `claude plugin enable agent-quest@agent-quest-local` e `/reload-plugins` |
| Remover tudo | `claude plugin marketplace remove agent-quest-local` |
| Atualizar uma captura já instalada (uma versão nova, como a 0.1.3) | `npm run capture:deploy` e `/reload-plugins` (ou sessão nova), sem reinstalar |

Quem roda esses comandos é sempre você. O `npm run capture:deploy` só copia arquivos e imprime os comandos; ele nunca executa o `claude`. Neste projeto, os agentes do time também não ligam, pausam nem removem a captura por conta própria.

## O que a captura faz

- Registra 15 hooks no Claude Code: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `PreCompact` e `PostCompact` ([ADR 0001](../adr/0001-captura-por-hooks-command-assincronos.md)).
- Instalada em escopo de usuário, vale em todas as sessões de todos os projetos, no terminal e na extensão do VS Code, inclusive dentro dos subagentes.
- A cada evento, o Claude Code inicia em segundo plano `node forward.mjs`, o encaminhador. Ele lê o evento, procura o `runtime.json` no diretório de dados para saber se o servidor está no ar, em que porta e com qual token, envia o evento ao servidor e termina.
- O que vai para o servidor: o JSON que o Claude Code entrega ao hook (que pode conter trechos de código, comandos, saídas e o seu pedido), com toda string acima de 4 KiB cortada em 1 KiB do início e 3 KiB do fim, mais o caminho do projeto (`CLAUDE_PROJECT_DIR`) e se a sessão é do terminal ou do VS Code (`CLAUDE_CODE_ENTRYPOINT`). Nos pedidos feitos na extensão do VS Code, o bloco de instruções que a extensão põe antes do seu texto sai antes do envio (veja [Pedidos feitos no VS Code](#pedidos-feitos-no-vs-code)). Cada envio tem no máximo 1 000 000 bytes: eventos enormes chegam resumidos (veja [Eventos enormes chegam resumidos](#eventos-enormes-chegam-resumidos)). A forma exata está na seção 1 do [modelo de eventos](../arquitetura/modelo-de-eventos.md).
- O servidor guarda tudo só em memória, sem gravar eventos em disco (a exceção é o `--debug-dump`; veja o [guia do servidor](servidor.md)). Ele transforma cada evento no estado das sessões que o painel mostra ao vivo, sem conteúdo de arquivo, saída de comando nem o pedido completo, e descarta o evento bruto.

## O que a captura nunca faz

- **Não atrasa o Claude Code.** Os hooks são assíncronos: o Claude Code inicia o encaminhador e segue sem esperar. Cada evento custa iniciar um processo `node` (cerca de 60 ms), fora do caminho do agente. O encaminhador tem um prazo de 2 segundos, contado da partida do processo. O envio espera no máximo 1 segundo, ou menos, se o prazo estiver perto do fim. Mesmo com o servidor travado, o encaminhador se encerra sozinho em cerca de 2 segundos. A exceção são eventos patológicos, com centenas de milhares de chaves; veja [Limite conhecido](#limite-conhecido).
- **Não incomoda quando o servidor está desligado.** Sem `runtime.json`, ou com o `pid` de um servidor que já terminou, o encaminhador sai na hora, sem enviar nada. Não é preciso pausar a captura só porque o servidor está parado.
- **Não imprime nada.** O encaminhador nunca escreve na saída nem no erro e sempre sai com código 0. Isso importa porque, num hook assíncrono, o que for impresso chega ao modelo no turno seguinte.
- **Não envia para fora da máquina.** O único destino possível é `127.0.0.1`, na porta lida do `runtime.json`, e só se ela for um número de 1024 a 65535. Das variáveis de ambiente, só vão o `CLAUDE_PROJECT_DIR` e o `CLAUDE_CODE_ENTRYPOINT`; esta, só se for um nome curto, de até 64 letras, dígitos, `_`, `.` ou `-` (senão, vai vazia).
- **Não mexe em configuração.** Nenhuma parte do Agent Quest edita arquivos de configuração do Claude Code. Quando você roda os comandos `claude plugin`, é o próprio Claude Code que grava, no `~/.claude/settings.json`, as chaves que ele mesmo gerencia (`extraKnownMarketplaces` e `enabledPlugins`).

## Pedidos feitos no VS Code

A captura 0.1.3 trouxe duas mudanças para quem usa a extensão do VS Code:

- **O bloco de instruções da extensão sai do pedido.** No primeiro pedido de uma conversa, a extensão põe antes do seu texto um bloco `<browser_instruction>…</browser_instruction>`, com cerca de 4 mil caracteres. O encaminhador tira esse bloco do início do pedido antes de qualquer corte, e o servidor recebe só o que você escreveu. Assim, o título do ticket sai da primeira linha do seu pedido, e um pedido longo não perde o começo no corte de 4 KiB. Nada novo é enviado: o bloco só deixa de ir. Isso vale só para o evento do pedido (`UserPromptSubmit`), só quando o bloco está no começo do texto e só quando o fechamento dele aparece nos primeiros 65 536 caracteres. Fora disso, o pedido segue como veio, com o corte normal.
- **O servidor sabe se a sessão é do terminal ou do VS Code.** O encaminhador manda o valor de `CLAUDE_CODE_ENTRYPOINT` (`cli` no terminal, `claude-vscode` na extensão) no campo `env.entrypoint`. O servidor guarda na sessão `terminal` ou `vscode` (o campo `client` do estado, que aparece no `/api/state`). Outro valor, ou nenhum, fica vazio. A interface do painel ainda não mostra esse campo.

Com uma captura anterior à 0.1.3, o servidor também ignora o bloco ao montar o título, mas um pedido longo pode chegar sem o começo, e o título do ticket se perde. Para resolver, [atualize a captura](#atualizar-a-captura).

## Eventos enormes chegam resumidos

Alguns eventos são enormes: um Glob com milhares de arquivos ou um comando com saída gigante, por exemplo. O servidor recusa envios acima de 1 MiB, e um envio recusado se perde. Por isso, o encaminhador nunca envia mais de 1 000 000 bytes. Ele resume o evento em até três passos e para no primeiro que couber:

1. **Corte normal.** Strings acima de 4 096 caracteres (4 KiB) ficam com 1 024 do início e 3 072 do fim. Quase todo evento para aqui.
2. **Corte forte.** Strings acima de 512 caracteres ficam com 128 do início e 384 do fim, e listas ficam com os 100 primeiros itens.
3. **Envelope mínimo.** Só ficam valores simples (texto, número, booleano e `null`), com textos de até 512 caracteres. Listas e objetos aninhados saem. Os campos entram nesta ordem, enquanto couberem:
   - os que identificam o evento: `hook_event_name`, `session_id` e, se existir, `agent_id`. Se nem eles couberem, nada é enviado;
   - `agent_type`, `tool_name`, `tool_use_id`, `prompt_id`, `cwd`, `notification_type`, `source`, `reason` e `trigger`;
   - os demais valores simples do primeiro nível do evento;
   - os valores simples de `tool_input`.

No lugar do trecho retirado de uma string fica a marca `…[cortado N caracteres]…`, e um corte nunca parte um caractere ao meio (um emoji, por exemplo). Todo evento que perdeu alguma parte, em qualquer passo, vai marcado com `truncated: true`. O painel não mostra essa marca; com o [`--debug-dump`](servidor.md#gravar-os-eventos-recebidos---debug-dump), dá para ver o campo em cada evento gravado.

### Orçamento de tempo

O resumo não pode estourar o prazo de 2 segundos do encaminhador. Por isso, ele tem um orçamento de tempo:

- **O passo 1 nunca é interrompido pelo tempo.** Um evento que cabe depois dele chega sempre completo, mesmo com a máquina lenta.
- **Os passos 2 e 3 têm até 1 segundo**, contado do início do resumo, depois de o evento ser lido. Esse orçamento termina, no máximo, 1,75 segundo depois da partida do encaminhador, para sobrar tempo para o envio.
- **Se o tempo acabar**, o encaminhador desiste do resumo e envia um envelope de emergência: só os campos das duas primeiras listas do passo 3, também com `truncated: true`.
- **Eventos acima de 8 MiB** vão direto para o envelope de emergência, sem passar pelos três passos. Custo aceito: esses eventos chegam sem o resultado da ferramenta (`tool_response`). Um comando de teste com saída gigante, por exemplo, chega sem o resultado do teste.
- **Eventos acima de 16 MiB** não são enviados.

Nada disso atrasa o Claude Code: o resumo acontece no encaminhador, que roda em segundo plano.

### Limite conhecido

Em eventos patológicos, com centenas de milhares de chaves, o encaminhador ainda pode passar dos 2 segundos. Duas etapas não podem ser interrompidas: a leitura do JSON do evento e a listagem das chaves de um objeto. Com a máquina calma, isso só acontece perto de 16 MiB; com a máquina carregada, também abaixo de 8 MiB. Nesse caso, o evento se perde em silêncio, e o Claude Code não é afetado.

Os limites (o corte de 4 KiB, o teto de 1 000 000 bytes e o atalho de 8 MiB) foram revistos com os tamanhos reais medidos na sessão de teste do T0 e mantidos: o maior evento real teve 10,6 KB (revisão G0b do [plano da v1](../plano/v1.md) e [ADR 0001](../adr/0001-captura-por-hooks-command-assincronos.md)). Os detalhes e as medidas estão na seção 1 do [modelo de eventos](../arquitetura/modelo-de-eventos.md), em "Teto do corpo" e "Orçamento de tempo da redução".

## Antes de começar

- **O servidor rodando**, para o teste da etapa 2 (veja [Iniciar e parar o servidor](servidor.md)). Para copiar e instalar, ele não precisa estar no ar.
- **Node 18 ou mais novo no PATH do Claude Code**, no terminal e no VS Code. O servidor pede Node 24, mas o encaminhador roda com o `node` que o Claude Code encontrar. Confira com `node --version` num terminal novo (e veja [`node` fora do PATH do VS Code](#node-fora-do-path-do-vs-code)).
- **Claude Code com suporte a plugins.** A referência do projeto é a versão 2.1.301. A linha "moved to the background" do log de depuração, usada no teste, existe a partir da 2.1.296.
- **`AGENT_QUEST_HOME` sem valor**, no uso normal (veja [`AGENT_QUEST_HOME` dos dois lados](#agent_quest_home-dos-dois-lados)).

Os comandos abaixo são para o PowerShell, na raiz do repositório.

## 1. Copiar a captura (`npm run capture:deploy`)

```powershell
npm run capture:deploy
```

O script confere a captura em `capture/` (os JSON e os 15 hooks), copia tudo para `%LOCALAPPDATA%\agent-quest\marketplace\`, fora do OneDrive, confere a cópia e imprime os comandos das próximas etapas, já com o caminho completo:

```text
Captura copiada para C:\Users\<usuario>\AppData\Local\agent-quest\marketplace
  4 arquivo(s) gravado(s), 0 sem mudança, 0 removido(s).
  Versão da captura: 0.1.3

Teste curto, sem instalar (vale só nesta sessão):
  claude --plugin-dir "C:\Users\<usuario>\AppData\Local\agent-quest\marketplace\plugins\agent-quest" --debug-file "C:\Users\<usuario>\AppData\Local\agent-quest\smoke-debug.txt"
  (apague o smoke-debug.txt depois do teste)

Instalar, em escopo de usuário (uma vez):
  claude plugin marketplace add "C:\Users\<usuario>\AppData\Local\agent-quest\marketplace"
  claude plugin install agent-quest@agent-quest-local
  Confira com: claude plugin list

Numa sessão já aberta, rode /reload-plugins para a captura valer nela.
Depois de um novo deploy, a versão nova vale com /reload-plugins ou numa sessão nova.

Pausar:  claude plugin disable agent-quest@agent-quest-local  (e /reload-plugins)
Retomar: claude plugin enable agent-quest@agent-quest-local  (e /reload-plugins)
Remover: claude plugin marketplace remove agent-quest-local

Este script não executa o claude: os comandos acima são para você rodar.
```

- **A linha `Versão da captura:`** mostra a versão que acabou de ser copiada, lida do `plugin.json` da cópia. Se não der para ler, ela mostra `desconhecida`.
- **Pode rodar de novo quantas vezes quiser.** O resultado é sempre o mesmo, e arquivos iguais nem são regravados (na segunda vez, a linha de contagem mostra `0 arquivo(s) gravado(s), 4 sem mudança`). Numa atualização, só os arquivos que mudaram são gravados.
- **Pode rodar com sessões do Claude Code abertas.** Cada arquivo é gravado num temporário e renomeado por cima do anterior, e só depois são removidos os arquivos que não existem mais em `capture/`. Assim, um encaminhador que esteja começando naquele instante nunca encontra um arquivo pela metade.
- **Se a captura em `capture/` tiver algum problema**, nada é copiado: o script mostra "A captura em capture/ tem problemas; nada foi copiado:" com a lista e sai com código 1.
- **Se um arquivo da cópia estiver em uso** (um encaminhador começando, o antivírus ou o indexador do Windows), o script tenta de novo por cerca de 2 segundos antes de desistir.
- **Se a cópia falhar no meio** mesmo assim, o script mostra "Não foi possível copiar a captura para ... (código do erro)." e "Cada arquivo da cópia está inteiro (na versão anterior ou na nova), mas a instalação pode ter ficado misturada entre as duas versões. Rode o deploy de novo (se algum arquivo estava em uso, espere um instante).", e sai com código 1. Espere um instante e rode de novo: a cópia só fica coerente depois de um deploy completo.
- **Se a conferência da cópia encontrar problemas**, o script mostra "A cópia em ... ficou com problemas:" com a lista e sai com código 1.
- Com `AGENT_QUEST_HOME` definida ou com a pasta de dados dentro do OneDrive, o script mostra um aviso antes dos comandos; veja [`AGENT_QUEST_HOME` dos dois lados](#agent_quest_home-dos-dois-lados).

## 2. Testar sem instalar (2 a 3 minutos)

Antes de instalar, faça um teste curto numa sessão que carrega o plugin só para ela, sem instalar nada. Com o servidor rodando, na raiz deste repositório:

```powershell
claude --plugin-dir "$env:LOCALAPPDATA\agent-quest\marketplace\plugins\agent-quest" --debug-file "$env:LOCALAPPDATA\agent-quest\smoke-debug.txt"
```

1. Na sessão, peça: "Leia o CLAUDE.md e rode `node -e "console.log(1)"`". Depois, saia da sessão.
2. Confira que o servidor contou os eventos: o `received` do `/api/health` subiu.

   ```powershell
   (Invoke-RestMethod http://127.0.0.1:47821/api/health).events
   ```

3. Confira no log que os hooks rodaram em segundo plano:

   ```powershell
   Select-String -Path "$env:LOCALAPPDATA\agent-quest\smoke-debug.txt" -Pattern "moved to the background"
   ```

4. Confirme que, durante a sessão, não apareceu nenhum aviso `hook error` e nenhuma janela de console piscou.
5. Apague o log, que pode ter detalhes da sessão:

   ```powershell
   Remove-Item "$env:LOCALAPPDATA\agent-quest\smoke-debug.txt"
   ```

Se algum desses pontos falhar, não instale: veja [Solução de problemas](#solução-de-problemas).

Outras formas de testar sem instalar:

- **Direto do repositório**, para experimentar uma mudança em `capture/` antes do deploy: `claude --plugin-dir "<repo>\capture\plugins\agent-quest"`.
- **Na extensão do VS Code**, que também passa a ser capturada depois da instalação: feche todas as janelas do VS Code e abra-o pelo PowerShell com a variável `CLAUDE_CODE_PLUGIN_DIRS`, que carrega o plugin só nas sessões desse VS Code:

  ```powershell
  $env:CLAUDE_CODE_PLUGIN_DIRS = "$env:LOCALAPPDATA\agent-quest\marketplace\plugins\agent-quest"; code .
  ```

## 3. Instalar

Uma vez só, num terminal (fora de uma sessão do Claude Code):

```powershell
claude plugin marketplace add "$env:LOCALAPPDATA\agent-quest\marketplace"
claude plugin install agent-quest@agent-quest-local
```

Confira com:

```powershell
claude plugin list
```

A lista deve mostrar `agent-quest@agent-quest-local`, com escopo de usuário e ativo.

- O primeiro comando registra o marketplace local; o segundo instala o plugin em escopo de usuário, que é o padrão. A partir daí, a captura vale em todas as sessões de todos os projetos, no terminal e no VS Code.
- O Claude Code carrega o plugin direto da pasta `marketplace\`, sem fazer outra cópia. Por isso a pasta fica em `%LOCALAPPDATA%`, fora do OneDrive, e é ela que o `npm run capture:deploy` atualiza.
- Sessões novas já começam com a captura. Nas que estavam abertas, veja a próxima etapa.

Lembrete: estes comandos ainda vão ser conferidos de verdade no marco "Primeira luz" (veja a "Situação nesta fase" no início).

## 4. Ligar nas sessões já abertas (`/reload-plugins`)

Numa sessão do Claude Code que já estava aberta antes da instalação, rode:

```text
/reload-plugins
```

O resumo `Reloaded: ...` deve listar hooks. Como o plugin só tem hooks, o recarregamento não invalida o cache de prompt da sessão e não precisa de `--force` (fontes no [ADR 0002](../adr/0002-captura-instalada-como-plugin-local.md)). Se o cliente que você usa não aceitar o comando, abra uma sessão nova. As demais sessões abertas passam a ser capturadas quando forem recarregadas ou reabertas.

Para conferir quais hooks estão ativos numa sessão, o comando `/hooks` do Claude Code lista todos.

## Confiança da pasta

Na primeira vez que você abre o Claude Code numa pasta, ele pergunta se você confia nela. Enquanto a pergunta não for aceita, o Claude Code pode segurar os hooks nessa pasta, e a captura não envia nada dessa sessão. Se uma sessão não aparecer no Agent Quest, confira se a confiança da pasta foi aceita.

## Pausar, retomar e remover

| Quero... | Comando | Depois |
|---|---|---|
| Pausar, sem desinstalar | `claude plugin disable agent-quest@agent-quest-local` | `/reload-plugins` nas sessões abertas |
| Retomar | `claude plugin enable agent-quest@agent-quest-local` | `/reload-plugins` nas sessões abertas |
| Remover tudo | `claude plugin marketplace remove agent-quest-local` | `/reload-plugins` nas sessões abertas, ou feche-as |

- **Pausar** desliga o plugin sem desinstalá-lo. Use quando não quiser que nada seja capturado por um tempo. Se o motivo for só o servidor estar desligado, nem precisa: a captura já sai em silêncio.
- **Remover** tira o marketplace e desinstala o plugin dele. A cópia em `%LOCALAPPDATA%\agent-quest\marketplace\` continua no disco; se quiser apagá-la também, faça isso depois de remover:

  ```powershell
  Remove-Item -Recurse "$env:LOCALAPPDATA\agent-quest\marketplace"
  ```

- Os mesmos comandos valem para o terminal e para a extensão do VS Code, que compartilham os plugins.

## Atualizar a captura

Quando o código em `capture/` muda (uma versão nova do encaminhador, como a 0.1.3, por exemplo) e a captura já está instalada:

1. Rode `npm run capture:deploy` de novo. Pode ser com sessões abertas. Confira a linha `Versão da captura:` na saída.
2. Nas sessões abertas, rode `/reload-plugins`, ou abra uma sessão nova. A versão nova vale a partir daí.

Não é preciso instalar de novo, nem remover antes: o Claude Code já carrega o plugin da pasta que o deploy atualiza, então os comandos `claude plugin marketplace add` e `claude plugin install` ficam como estão. Mudar só o servidor (porta, reinício, `npm run dev`) não exige nada na captura, porque o encaminhador lê o `runtime.json` a cada evento.

Neste projeto, o deploy da versão nova no diretório de dados real é feito por você, quando o orquestrador avisar que há uma versão aprovada pelo tester.

### Versão da captura

A captura tem versão própria, separada da do servidor. A versão atual é a 0.1.3, e toda mudança de comportamento em `capture/` sobe a versão. Ela aparece no `plugin.json`, no `marketplace.json`, no campo `forwarder` de cada evento enviado (o que ajuda a saber qual encaminhador mandou cada evento num `--debug-dump`) e na linha `Versão da captura:` do `npm run capture:deploy`.

| Versão | O que mudou |
|---|---|
| 0.1.3 | Tira o bloco `<browser_instruction>` da extensão do VS Code do início do pedido e manda se a sessão é do terminal ou do VS Code (veja [Pedidos feitos no VS Code](#pedidos-feitos-no-vs-code)). |
| 0.1.2 | Orçamento de tempo no resumo de eventos enormes (veja [Orçamento de tempo](#orçamento-de-tempo)). |
| 0.1.1 | Teto de 1 000 000 bytes por envio (veja [Eventos enormes chegam resumidos](#eventos-enormes-chegam-resumidos)). |

Para ver qual versão está na pasta que o Claude Code carrega, sem copiar nada:

```powershell
(Get-Content -Raw "$env:LOCALAPPDATA\agent-quest\marketplace\plugins\agent-quest\.claude-plugin\plugin.json" | ConvertFrom-Json).version
```

Se for mais antiga que a do repositório (`capture\plugins\agent-quest\.claude-plugin\plugin.json`), siga os dois passos acima. A versão declarada não controla a atualização: o Claude Code carrega o plugin direto da pasta, qualquer que seja a versão ([ADR 0002](../adr/0002-captura-instalada-como-plugin-local.md), complemento "versão da captura"). O que vale é o deploy e o `/reload-plugins` (ou uma sessão nova).

Para quem mexe no código da captura: `claude plugin validate capture` confere o marketplace e o plugin sem mudar nada (é só leitura).

## `AGENT_QUEST_HOME` dos dois lados

O servidor, o `npm run capture:deploy` e o encaminhador procuram o diretório de dados cada um com o próprio ambiente. O encaminhador roda dentro do Claude Code, então enxerga as variáveis do Claude Code. Se `AGENT_QUEST_HOME` estiver definida só no terminal do servidor, a captura procura o `runtime.json` em `%LOCALAPPDATA%\agent-quest\`, não encontra e sai em silêncio: parece desligada, sem nenhum erro ([ADR 0005](../adr/0005-estado-em-memoria.md), complemento "`AGENT_QUEST_HOME` dos dois lados").

- **No uso normal, deixe `AGENT_QUEST_HOME` sem valor.** O padrão já fica fora do OneDrive.
- **Se você precisar de outro diretório**, defina a variável como variável de ambiente do usuário do Windows e reabra os terminais, o VS Code e as sessões do Claude Code, para os três lados (servidor, deploy e Claude Code) verem o mesmo valor. O passo a passo está no [guia do servidor](servidor.md#usar-outra-pasta-agent_quest_home).
- **Se você trocar o diretório depois de instalar**, os próximos deploys vão para a pasta nova, mas o Claude Code continua carregando a cópia da pasta antiga. Remova a captura e instale de novo com os comandos que o deploy imprimir.

Com a variável definida, o deploy avisa:

```text
Aviso: AGENT_QUEST_HOME está definida (<diretório>). O servidor, o capture:deploy e o Claude Code (terminal e VS Code) precisam ver o mesmo valor; senão a captura procura o servidor em outra pasta e não envia nada. No uso normal, deixe AGENT_QUEST_HOME sem valor; para usar outra pasta, defina-a como variável de ambiente do usuário do Windows e reabra os terminais e o VS Code.
```

O servidor mostra um aviso parecido ao iniciar, e os dois mostram o aviso do OneDrive se a pasta de dados estiver dentro dele (veja [Mensagens comuns](servidor.md#mensagens-comuns) no guia do servidor).

## Solução de problemas

### Nenhum evento chegando

Você usa o Claude Code, mas o `received` do `/api/health` não sobe. A captura nunca mostra erro, então confira por partes, nesta ordem:

1. **O servidor está no ar?** Abra `http://127.0.0.1:47821/api/health`. Se não responder, inicie o servidor ([guia do servidor](servidor.md)).
2. **A captura funciona sem a instalação?** Repita o [teste sem instalar](#2-testar-sem-instalar-2-a-3-minutos). Se o teste conta eventos e a sessão instalada não, o problema está na instalação ou na sessão (passos 3 a 5). Se nem o teste conta, siga para os passos 6 e 7.
3. **O plugin está instalado e ativo?** `claude plugin list` deve mostrar `agent-quest@agent-quest-local` ativo. Se estiver desativado, use `claude plugin enable agent-quest@agent-quest-local`.
4. **A sessão já carregou a captura?** Sessões abertas antes da instalação (ou de um `enable`) precisam de `/reload-plugins` ou de serem reabertas. O `/hooks` mostra se os hooks estão registrados.
5. **A confiança da pasta foi aceita?** Veja [Confiança da pasta](#confiança-da-pasta).
6. **`AGENT_QUEST_HOME` é a mesma dos dois lados?** É a causa mais comum, porque a falha é silenciosa. Compare a linha `Diretório de dados:` do início do servidor com o que o Claude Code enxerga, como explicado em [Nenhum evento chegando](servidor.md#nenhum-evento-chegando), no guia do servidor.
7. **O Claude Code encontra o `node`?** Veja a próxima seção.

Para ver o que acontece com os hooks numa sessão, abra-a com `--debug-file` (como no teste) e procure por `hook` no arquivo. Apague o arquivo depois.

### `node` fora do PATH do VS Code

O encaminhador é iniciado pelo comando `node`, procurado no PATH do processo do Claude Code. No terminal, esse PATH é o do próprio terminal. Na extensão do VS Code, é o PATH com que o VS Code foi aberto. Se o VS Code não encontra o `node`, os eventos das conversas dele não chegam, mesmo com tudo instalado.

- **Instalou ou atualizou o Node com o VS Code aberto?** Feche todas as janelas do VS Code e abra de novo, para ele pegar o PATH novo.
- **Para conferir**, abra o terminal integrado do VS Code e rode `node --version`. Ele costuma herdar o ambiente do VS Code, então é um bom indício.
- **Se você usa um gerenciador de versões do Node** (como o nvm), o `node` que o Claude Code encontra pode ser outro. O encaminhador funciona com Node 18 ou mais novo; versões mais antigas não servem.
- **Uma alternativa** é abrir o VS Code a partir de um terminal em que `node --version` funciona: `code .`.

### Apareceu aviso `hook error` ou uma janela piscando

Não deveria acontecer: a captura foi feita para não mostrar nada. Se acontecer, pause a captura (`claude plugin disable agent-quest@agent-quest-local` e `/reload-plugins`) e reporte o problema, com a versão do Claude Code e, se possível, as linhas do log de depuração que citam o hook (sem conteúdo da sessão).

### Eventos faltando no fim de sessões com `claude -p`

No modo não interativo (`claude -p`), o Claude Code encerra os hooks assíncronos que ainda estão rodando quando termina. Os últimos eventos dessas sessões podem se perder. O servidor compensa boa parte disso com o [relógio do estado](servidor.md#o-relógio-do-estado): um agente que ainda constava como trabalhando, sem ferramenta em execução, é liberado depois de 15 minutos sem eventos, e a sessão sai da memória depois de 6 horas sem eventos.

## Para saber mais

- [Primeira luz: ligar o painel e a captura](primeira-luz.md): o roteiro completo, do servidor ao painel.
- [Iniciar e parar o servidor](servidor.md): porta, diretório de dados, `runtime.json` e `/api/health`.
- [ADR 0001](../adr/0001-captura-por-hooks-command-assincronos.md): por que hooks `command` assíncronos e quais eventos, com os complementos sobre o teto do corpo, o prazo de 2 s na prática e o preâmbulo do VS Code.
- [ADR 0002](../adr/0002-captura-instalada-como-plugin-local.md): por que um plugin de marketplace local, as fontes da documentação do Claude Code e a política de versão da captura.
- [ADR 0005](../adr/0005-estado-em-memoria.md): diretório de dados e o complemento sobre `AGENT_QUEST_HOME`.
- [Modelo de eventos](../arquitetura/modelo-de-eventos.md), seção 1: o envelope que o encaminhador envia, o `env.entrypoint`, o preâmbulo do cliente, o teto do corpo e o orçamento de tempo da redução.
- [Plano da v1](../plano/v1.md): tarefa T4 e o roteiro do marco "Primeira luz".
