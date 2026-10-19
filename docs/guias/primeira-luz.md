# Primeira luz: ligar o painel e a captura

A "Primeira luz" é o primeiro momento em que o painel do Agent Quest mostra eventos reais: o servidor roda na sua máquina, a captura está instalada no Claude Code e o navegador mostra, ao vivo, o que o orquestrador e os subagentes estão fazendo. Este guia junta, numa ordem só, o que está nos guias do [servidor](servidor.md), da [captura](captura.md) e do [painel](painel.md).

> **Antes de tudo: quando e quem.**
>
> - **O marco só acontece depois da sessão de teste do T0 e da liberação G0a.** A sessão de teste confirma, no Claude Code real, que os hooks não travam nem mostram avisos, no terminal e no VS Code. O roteiro dela está em [Sonda do T0](../../tools/probe/README.md). Depois, o arquiteto confere os resultados e libera a instalação (G0a, no [plano da v1](../plano/v1.md)). Antes disso, não instale a captura.
> - **Quem instala, pausa, atualiza e remove a captura é sempre você.** O `npm run capture:deploy` só copia arquivos e imprime os comandos; ele nunca executa o `claude`. Os agentes do time também não fazem isso por conta própria.
>
> **Situação nesta fase.** Os comandos `claude plugin` e o `/reload-plugins` deste guia seguem a documentação do Claude Code e o [ADR 0002](../adr/0002-captura-instalada-como-plugin-local.md), mas ainda não foram conferidos numa instalação real: isso acontece justamente no marco. Se algo sair diferente na prática, este guia e o [guia da captura](captura.md) serão corrigidos.

## Resumo rápido

| Passo | Onde | Comando |
|---|---|---|
| 1. Iniciar o servidor | terminal que fica aberto | `npm start` (ou `npm run dev`) |
| 2. Copiar a captura | outro terminal | `npm run capture:deploy` |
| 3. Testar sem instalar | terminal | `claude --plugin-dir "<pasta do plugin>" --debug-file "<arquivo de log>"` (o deploy imprime o comando pronto) |
| 4. Instalar (uma vez) | terminal, fora do Claude Code | `claude plugin marketplace add "<pasta do marketplace>"` e `claude plugin install agent-quest@agent-quest-local` |
| 5. Ligar nas sessões abertas | dentro de cada sessão | `/reload-plugins` |
| 6. Abrir o painel | navegador | `http://127.0.0.1:47821/` |
| Pausar | terminal | `claude plugin disable agent-quest@agent-quest-local` e `/reload-plugins` |
| Remover tudo | terminal | `claude plugin marketplace remove agent-quest-local` |
| Parar o servidor | janela do servidor | Ctrl+C |

## Antes de começar

- **Node 24 ou mais novo** para o servidor. Confira com `node --version`.
- **Node 18 ou mais novo no PATH do Claude Code**, no terminal e no VS Code, para o encaminhador da captura (veja [`node` fora do PATH do VS Code](captura.md#node-fora-do-path-do-vs-code)).
- **Claude Code com suporte a plugins.** A referência do projeto é a versão 2.1.301.
- **`AGENT_QUEST_HOME` sem valor**, no servidor e no Claude Code. O motivo está em [Por que não definir `AGENT_QUEST_HOME`](#por-que-não-definir-agent_quest_home).
- Os comandos são para o PowerShell, na raiz do repositório (a pasta do `package.json`). Não é preciso `npm install`.

## 1. Iniciar o servidor

Num terminal que vai ficar aberto (pode minimizar):

```powershell
npm start
```

O terminal mostra:

```text
Agent Quest 0.1.0 rodando em http://127.0.0.1:47821/
Diretório de dados: C:\Users\<usuario>\AppData\Local\agent-quest
Ctrl+C para parar.
```

Confira a linha `Diretório de dados:`. No uso normal, é a pasta `%LOCALAPPDATA%\agent-quest`. Se aparecer um aviso "AGENT_QUEST_HOME está definida", pare o servidor e veja [Por que não definir `AGENT_QUEST_HOME`](#por-que-não-definir-agent_quest_home).

**`npm run dev`** faz o mesmo, mas reinicia o servidor sozinho quando o código em `server/` muda. É útil a partir da Primeira luz, porque o servidor vai mudar várias vezes enquanto os agentes trabalham. Cada reinício começa com o estado vazio, e as sessões voltam com os próximos eventos. No Windows, parar o `npm run dev` pode deixar um `runtime.json` com o `pid` de um processo que já terminou, o que é inofensivo ([detalhes](servidor.md#exceção-do-npm-run-dev-no-windows)).

Porta, `config.json` e mensagens do terminal: [Iniciar e parar o servidor](servidor.md).

## 2. Copiar a captura

Em outro terminal:

```powershell
npm run capture:deploy
```

O script confere a captura em `capture/`, copia o plugin para `%LOCALAPPDATA%\agent-quest\marketplace\`, fora do OneDrive, e imprime os comandos dos passos 3 a 5 com o caminho completo. Pode rodar com sessões do Claude Code abertas. A saída completa e o que fazer se algo falhar estão em [Copiar a captura](captura.md#1-copiar-a-captura-npm-run-capturedeploy).

## 3. Testar sem instalar (2 a 3 minutos)

Antes de instalar, faça um teste curto numa sessão que carrega o plugin só para ela. Com o servidor rodando, na raiz do repositório:

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

Se algum desses pontos falhar, não instale: veja a [solução de problemas da captura](captura.md#solução-de-problemas).

## 4. Instalar

Uma vez só, num terminal fora de uma sessão do Claude Code:

```powershell
claude plugin marketplace add "$env:LOCALAPPDATA\agent-quest\marketplace"
claude plugin install agent-quest@agent-quest-local
```

Confira com:

```powershell
claude plugin list
```

A lista deve mostrar `agent-quest@agent-quest-local`, com escopo de usuário e ativo. A partir daí, a captura vale em todas as sessões de todos os projetos, no terminal e no VS Code. Sessões novas já começam com ela.

## 5. Ligar nas sessões já abertas (`/reload-plugins`)

Em cada sessão do Claude Code que já estava aberta antes da instalação, rode:

```text
/reload-plugins
```

O resumo `Reloaded: ...` deve listar hooks. Como o plugin só tem hooks, o recarregamento não invalida o cache de prompt da sessão e não precisa de `--force`. Se o cliente que você usa não aceitar o comando, abra uma sessão nova. As outras sessões abertas passam a ser capturadas quando forem recarregadas ou reabertas.

Na primeira vez que o Claude Code abre numa pasta, ele pergunta se você confia nela. Enquanto a pergunta não for aceita, a captura pode não enviar nada dessa sessão ([Confiança da pasta](captura.md#confiança-da-pasta)).

## 6. Abrir o painel e escolher a sessão

Abra `http://127.0.0.1:47821/` no navegador (o projeto é testado no Microsoft Edge).

- A sessão aparece no painel na primeira ação do Claude Code depois do `/reload-plugins`, mesmo sem ter passado pelo início da sessão.
- O seletor no topo lista as sessões que o servidor conhece, da mais recente para a mais antiga, com o nome da sessão e o do projeto. Escolha a que você quer acompanhar, se ela não vier escolhida.
- As sessões de outros projetos também aparecem, porque a captura vale para todos. Cada uma fica separada, com a própria equipe e a própria atividade.
- Para conferir pelo terminal, o `sessions` do `/api/health` conta as sessões em memória.

### O que você vê

- **Equipe:** o orquestrador e cada subagente que ele chamar, com o papel, a descrição da delegação, o status (trabalhando, parado ou encerrado na copa) e a ação atual, como "Editando `server/http/app.js`". Dois subagentes em paralelo aparecem como duas instâncias.
- **Atividade:** delegações, ferramentas, falhas e fim de subagentes, em ordem, com comandos e caminhos já redigidos e relativos ao projeto.
- **Cena:** um token por agente na sala do seu papel, e a copa para quem terminou.
- **Temas:** Escritório e Guilda, com as teclas `1`, `2` e `T` ou os botões do topo. Trocar de tema no meio da atividade muda o vocabulário e o visual, sem reabrir a conexão com o servidor.

O guia [O painel](painel.md) explica cada área em detalhe.

### O que o painel ainda não mostra

Chegam depois do marco, enquanto o resto da v1 é construído:

| O que | Quando chega |
|---|---|
| Tickets e etapas, "aguardando aprovação", bugs e resultado de testes; os indicadores de bugs, entregas e aprovações ficam em zero até lá | T6 e T8 |
| Comandos de teste mostrados como teste; até lá, aparecem como comando de terminal | T6 |
| Cena animada | T12b |
| Filtros da atividade | T11b |
| Retomada da conexão sem baixar o estado inteiro | T9b |
| Seletor agrupado por projeto e "seguir atividade" entre sessões | T13 |
| Modo discreto, que esconde comandos, caminhos e títulos para compartilhar a tela | T14 |

A lista completa está em [O que ainda não está ligado](painel.md#o-que-ainda-não-está-ligado).

## Pausar, retomar e remover a captura

| Quero... | Comando | Depois |
|---|---|---|
| Pausar, sem desinstalar | `claude plugin disable agent-quest@agent-quest-local` | `/reload-plugins` nas sessões abertas |
| Retomar | `claude plugin enable agent-quest@agent-quest-local` | `/reload-plugins` nas sessões abertas |
| Remover tudo | `claude plugin marketplace remove agent-quest-local` | `/reload-plugins` nas sessões abertas, ou feche-as |

- Se algo incomodar (um aviso `hook error`, uma janela piscando, lentidão), pause e reporte o problema.
- Não é preciso pausar só porque o servidor está desligado: sem servidor, a captura sai em silêncio, sem atrasar o Claude Code.
- Remover tira o marketplace e desinstala o plugin. A cópia em `%LOCALAPPDATA%\agent-quest\marketplace\` continua no disco; os detalhes estão em [Pausar, retomar e remover](captura.md#pausar-retomar-e-remover).

## Parar o servidor

Na janela do servidor, aperte **Ctrl+C**. O terminal mostra `Encerrando o Agent Quest...`, e o servidor apaga o `runtime.json` e sai.

- O Claude Code segue sem avisos e sem lentidão: a captura não acha mais o servidor e sai em silêncio.
- O painel aberto mostra o selo "reconectando". Quando o servidor volta, ele se reconecta sozinho e recebe o estado de novo, que começa vazio, e as sessões reaparecem no evento seguinte.
- Se outro programa estiver com o `runtime.json` aberto bem nessa hora (um encaminhador lendo, o antivírus ou o indexador), o servidor tenta apagá-lo de novo antes de sair, por menos de 1 segundo. Se não der, o arquivo fica como sobra, o que é inofensivo: a captura vê o `pid` morto, e o próximo início o substitui.
- Com o `npm run dev`, no Windows, o Ctrl+C pode deixar o `runtime.json` para trás, também sem problema.
- Cada terminal tem seu jeito de mostrar o fim (código 1 do npm no PowerShell, pergunta do cmd): veja [Parar o servidor](servidor.md#parar-o-servidor).

## Quando o código muda

- **Código do servidor (`server/`):** com `npm start`, pare e inicie de novo; com `npm run dev`, o reinício é automático. O painel reconecta sozinho, e o estado recomeça vazio e se preenche com os próximos eventos.
- **Código do painel (`web/`):** F5 no navegador.
- **Código da captura (`capture/`):** só chega às sessões depois de `npm run capture:deploy` e de `/reload-plugins` (ou de uma sessão nova). Como isso troca o código que roda nos hooks de todas as sessões, quem roda é você, quando o orquestrador avisar que há uma versão nova aprovada pelo tester.
- **Painel quebrado não atrapalha os agentes:** a captura continua saindo em silêncio, com ou sem servidor.

## Por que não definir `AGENT_QUEST_HOME`

**No uso normal, deixe a variável `AGENT_QUEST_HOME` sem valor**, no terminal do servidor, no terminal do Claude Code e no VS Code. O diretório padrão, `%LOCALAPPDATA%\agent-quest\`, já fica fora do OneDrive e funciona sem nenhum ajuste.

O motivo: o servidor, o `npm run capture:deploy` e o encaminhador da captura procuram o diretório de dados cada um com o próprio ambiente. O encaminhador roda dentro do Claude Code e enxerga as variáveis do Claude Code, não as do terminal do servidor. Se `AGENT_QUEST_HOME` estiver definida só no terminal do servidor, a captura procura o `runtime.json` no diretório padrão, não encontra e sai em silêncio. A captura parece desligada, sem nenhum erro ([ADR 0005](../adr/0005-estado-em-memoria.md), complemento "`AGENT_QUEST_HOME` dos dois lados").

A variável existe para isolar testes e desenvolvimento, com uma pasta temporária e outra porta, sem o Claude Code no meio. Se você precisar mesmo de outro diretório no dia a dia (por exemplo, porque o seu `%LOCALAPPDATA%` fica dentro do OneDrive), siga [Usar outra pasta](servidor.md#usar-outra-pasta-agent_quest_home): a variável tem de valer igual para o servidor, para o deploy e para o Claude Code.

## Se algo não aparecer

| Sintoma | Onde olhar |
|---|---|
| O `received` do `/api/health` não sobe | [Nenhum evento chegando](servidor.md#nenhum-evento-chegando), no guia do servidor, e a [solução de problemas da captura](captura.md#solução-de-problemas) |
| Os eventos chegam, mas a sessão não aparece no painel | [Os eventos chegam, mas a sessão não aparece](servidor.md#os-eventos-chegam-mas-a-sessão-não-aparece-no-painel) |
| O terminal do servidor mostra `Erro ao processar um evento` | [Erros enquanto o servidor roda](servidor.md#erros-enquanto-o-servidor-roda) |
| Um papel do time não aparece na equipe | [A equipe e o `.claude/agents/`](servidor.md#a-equipe-e-o-claudeagents) |
| O projeto fica numa unidade de rede que não responde, e a equipe só tem os papéis vistos na sessão e os da pasta pessoal | O servidor não trava: abandona a pasta depois de 10 segundos e só tenta de novo quando reiniciar. Reconecte a unidade e reinicie o servidor ([Pasta que não responde](servidor.md#pasta-que-não-responde)) |
| Apareceu aviso `hook error` ou uma janela piscando | Pause a captura e veja [o guia da captura](captura.md#apareceu-aviso-hook-error-ou-uma-janela-piscando) |

## Para saber mais

- [Iniciar e parar o servidor](servidor.md), [Ligar, pausar e remover a captura](captura.md) e [O painel](painel.md).
- [Sonda do T0](../../tools/probe/README.md): o roteiro da sessão de teste que vem antes do marco.
- [Plano da v1](../plano/v1.md): o marco "Primeira luz", com o que o usuário vê, o roteiro e os critérios de aceite.
- [ADR 0002](../adr/0002-captura-instalada-como-plugin-local.md): por que a captura é um plugin de marketplace local.
- [ADR 0005](../adr/0005-estado-em-memoria.md): estado só em memória, diretório de dados e o complemento sobre `AGENT_QUEST_HOME`.
