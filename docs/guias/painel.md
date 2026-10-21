# O painel

O painel é a página do Agent Quest no navegador. Ele mostra, ao vivo, o que cada agente de uma sessão do Claude Code está fazendo: quem está na equipe, o pedido em andamento, onde cada agente está na cena e o que acabou de acontecer. Tudo roda na sua máquina, sem nada carregado da internet.

Este guia explica como abrir o painel, o que cada área mostra com os dados ao vivo, como trocar de tema e de sessão, e o que ainda não está ligado.

> **Situação nesta fase.** Com a captura ligada, o painel mostra as sessões reais ao vivo: ticket e etapas, equipe, aprovações pendentes, testes e bugs, a cena animada e a atividade com filtros acompanham cada evento do Claude Code. Ainda faltam o seletor agrupado por projeto e o modo discreto (veja [O que ainda não está ligado](#o-que-ainda-não-está-ligado)). As regras de ticket, aprovação e testes seguem o design e ainda vão ser conferidas com os eventos reais da sessão de teste do T0. Para ligar tudo pela primeira vez, siga [Primeira luz: ligar o painel e a captura](primeira-luz.md). Sem a captura instalada, o painel fica no [estado sem sessões](#sem-sessões).

## Resumo rápido

| Quero... | Como |
|---|---|
| Abrir o painel | `npm start` e abrir o endereço impresso, `http://127.0.0.1:47821/` |
| Trocar de tema | botões no topo, teclas `1` (Escritório), `2` (Guilda) ou `T` (alterna), ou `#escritorio` e `#guilda` no fim do endereço |
| Escolher a sessão | seletor no topo, ao lado do nome do Agent Quest |
| Ver uma mudança no código do painel | F5 no navegador |

## Abrir o painel

1. Inicie o servidor com `npm start` (veja [Iniciar e parar o servidor](servidor.md)).
2. Abra no navegador o endereço que o servidor imprime, `http://127.0.0.1:47821/` (ou a porta que você escolheu). O projeto é testado no Microsoft Edge; outro navegador moderno também serve. O painel precisa de JavaScript ligado.
3. Com a captura ligada, a sessão aparece na primeira ação do Claude Code. Escolha a que quer acompanhar no [seletor de sessão](#seletor-de-sessão).

- Pode abrir o painel em mais de uma aba. O servidor aceita até 8 conexões ao vivo ao mesmo tempo; veja o [selo de conexão](#selo-de-conexão).
- Mudou algum arquivo em `web/`? Aperte F5. Os arquivos do painel saem do servidor com `Cache-Control: no-cache`, então o navegador busca a versão nova.

## O que aparece ao vivo

- **Seletor de sessão:** as sessões do Claude Code que o servidor conhece, de todos os projetos, porque a captura vale para todos. Cada sessão aparece com o primeiro evento dela, mesmo que o servidor tenha sido iniciado no meio da sessão.
- **Ticket:** cada pedido seu vira um ticket, com título, situação, duração, ações e as etapas do time.
- **Equipe:** o orquestrador e cada subagente chamado, com papel, rótulo (a descrição da delegação), status (trabalhando, aguardando sua aprovação, parado ou encerrado na copa), a ação atual, como "Editando `server/http/app.js`", e a barra de saúde.
- **Cena:** um token por agente na sala do seu papel, com o balão da ação atual. Os agentes caminham até a copa quando terminam, a delegação voa como um envelope, as falhas dão um tranco, e os bugs abertos pelos testes aparecem na sala de testes.
- **Atividade:** pedidos, delegações, ferramentas, falhas, resultados de testes, aprovações e compactação, em ordem, com comandos e caminhos já redigidos e relativos ao projeto. Dá para filtrar por papel ou por agente.
- **Topo:** a duração da sessão, os bugs esmagados, os tickets entregues, as aprovações pendentes e o selo de conexão.
- Os dois temas, com alternância a qualquer momento, sem reabrir a conexão.

Nos testes, um evento leva menos de meio segundo da captura até a conexão ao vivo do painel.

## O que tem na tela

No topo ficam o seletor de sessão, os indicadores da sessão, o selo de conexão e a alternância de tema. Abaixo, em telas a partir de 1280 px de largura, três colunas:

| Esquerda | Centro | Direita |
|---|---|---|
| **Equipe**: quem está na sessão e o que cada um faz | **Ticket** (o pedido em andamento) e, abaixo, a **cena** | **Atividade**: o que acabou de acontecer |

- De 820 a 1279 px, o centro ocupa a largura toda em cima, e equipe e atividade ficam lado a lado embaixo. Os indicadores ganham uma linha própria no topo.
- Abaixo de 820 px, tudo vira uma coluna só: centro, equipe e atividade. Os indicadores mostram só o ícone e o número. Não há rolagem horizontal até 360 px.

Os nomes das áreas mudam com o tema (Equipe ou Party, Ticket ou Quest, Atividade ou Crônica), mas o conteúdo é o mesmo nos dois.

### Indicadores do topo

Aparecem quando há uma sessão escolhida. Os valores vêm do servidor ([ADR 0008](../adr/0008-fontes-dos-indicadores.md)):

| Indicador | Escritório | Guilda | O que conta |
|---|---|---|---|
| Duração | de sessão | de jornada | Tempo desde o início da sessão (ou até o último evento, se ela terminou) |
| Bugs | bugs esmagados | monstros derrotados | ≈ Falhas de teste que um run seguinte, aprovado, zerou (aproximado) |
| Entregas | tickets entregues | quests concluídas | Pedidos encerrados com sucesso na sessão |
| Aprovações | aprovações pendentes | pedidos de permissão | Pedidos de aprovação esperando por você; o indicador pisca quando há algum |

Todos vêm da sessão real. O de bugs é uma aproximação: ele conta as falhas de um run de testes que o run seguinte, aprovado, zerou (veja [Testes e bugs](#testes-e-bugs)).

### Equipe

Um bloco por papel, com o nome do papel no tema e o papel real embaixo. Aparecem o orquestrador, os papéis que têm agente definido em `.claude/agents/` (na pasta do projeto ou em `~/.claude/agents/`), os que surgirem na sessão e, se algum agente fora do time for chamado, o convidado:

| Papel real | Agente do Claude Code | Escritório | Guilda |
|---|---|---|---|
| Orquestrador | a sessão principal | Gerente de Projeto | Mestre da Guilda |
| System Design | `arquiteto` | Arquiteto de Software | Arquimago |
| Dev | `dev-backend`, `dev-frontend` | Dev Full-stack | Ferreiro |
| Tester | `tester` | Analista de QA | Caçador de Bugs |
| Documentação | `documentador` | Tech Writer | Escriba |
| Convidado | qualquer outro tipo de agente (por exemplo, `general-purpose`, `Explore`, `Plan`) | Consultor Externo | Aventureiro Convidado |

- **Papéis de `.claude/agents/`** entram um instante depois de a sessão aparecer, quando o servidor termina de ler as pastas. Um agente criado depois só entra com o servidor reiniciado, ou quando for chamado na sessão (veja [A equipe e o `.claude/agents/`](servidor.md#a-equipe-e-o-claudeagents)).
- **Agentes com outros nomes** ganham papel pela chave `roles` do `config.json` (veja [Papéis de outros agentes](servidor.md#papéis-de-outros-agentes-roles)).

Em cada bloco:

- **Uma linha por instância.** Cada subagente chamado é uma instância, com a descrição da delegação como rótulo, que aparece já no momento da delegação. Sem descrição, o rótulo é o tipo do agente. Convidados mostram também o tipo real do agente.
- **"×N"** aparece quando há mais de uma instância do papel em andamento ao mesmo tempo, e conta só as que não terminaram. Dois subagentes em paralelo aparecem como duas instâncias, cada uma com as próprias ações.
- **Linha de ação:** o que a instância está fazendo agora, na voz do tema. Por exemplo, "Editando `server/http/app.js`" no Escritório ou "Conjurando `git status`" na Guilda. Também mostra "Delegando: ...", "Rodando os testes" durante um comando de teste, "✋ Aguardando sua aprovação" quando o agente espera você ou, quando parada, "Tomando café na copa" (na Guilda, "Descansando na taverna"). A sessão principal parada mostra "Aguardando o próximo pedido".
- **Barra de saúde** (Humor no Escritório, Vida na Guilda): ≈ a fração das últimas 10 ações sem erro. Um comando de teste conta uma vez, pelo resultado dos testes, e uma ação que você interrompeu não conta. Passe o mouse para ver, por exemplo, "Humor ≈ 8 de 10 ações sem erro (últimas 10)".
- **Instâncias encerradas** do ticket atual continuam visíveis, até 3 por papel. As demais viram "+N instâncias encerradas". As de tickets anteriores saem do cartão. O servidor guarda os 50 subagentes encerrados mais recentes de cada sessão; os mais antigos somem também do "+N".
- **Filtro da atividade:** o nome do papel e cada instância são botões. Clique para ver na atividade só aquele papel ou aquela instância; clique de novo para voltar a todos (veja [Filtros](#filtros)).

O cabeçalho mostra quantos agentes estão ativos entre os presentes, como "2/3 ativos".

### Ticket e etapas

Cada pedido que você faz ao Claude Code vira um ticket (quest, na Guilda). O cartão do centro mostra o ticket em andamento ou, entre um pedido e outro, o último:

- número e situação: em andamento, aguardando tarefa em segundo plano, entregue, falhou ou interrompido;
- título: a primeira linha do seu pedido, já redigida; se o pedido começa com `/`, só o comando;
- duração, número de ações (ferramentas e delegações) e, se o pedido falhou, o tipo de erro;
- **etapas**: Arquitetura, Desenvolvimento, QA e Documentação (na Guilda, Torre de Planos, Forja, Arena e Biblioteca). Cada uma acende quando um agente daquele papel começa no ticket e ganha ✓ quando o último deles termina; uma delegação nova ao mesmo papel acende a etapa de novo. As etapas só aparecem quando o ticket envolve algum papel do time.

Como um ticket termina:

| Situação | Quando |
|---|---|
| entregue | O Claude Code terminou o turno. |
| aguardando tarefa em segundo plano | O turno terminou, mas uma tarefa em segundo plano ainda roda. O ticket fecha quando ela volta e o turno termina de vez. |
| falhou | O turno terminou com erro, por exemplo da API. |
| interrompido | O turno não terminou: você mandou um pedido novo antes do fim (por exemplo, depois de interromper com Esc), o Claude Code ficou parado esperando você ou a sessão terminou. |

- **Ticket implícito:** atividade sem pedido aberto, como com o servidor iniciado no meio de um turno, abre o ticket "Tarefa em andamento".
- **Antes do primeiro pedido da sessão,** o cartão mostra "Sem ticket no momento" (ou "Nenhuma quest no quadro").
- **Cartão final:** quando um ticket é entregue, aparece por alguns segundos sobre a cena um cartão com o resumo (ações, agentes e duração), como "Ticket entregue!" no Escritório ou "Quest concluída!" na Guilda.

### Aguardando aprovação

Quando o Claude Code pede a sua aprovação para uma ação, o agente que pediu fica "✋ Aguardando sua aprovação", com a ação em espera. A sessão também fica aguardando, e o indicador de aprovações pendentes do topo sobe e pisca.

- **Aprovado:** a ação roda, e a atividade mostra "Aprovado. ... segue o trabalho".
- **Negado ou cancelado:** quando você nega, o Claude Code não avisa. O painel percebe quando o agente segue para outra ação, o turno termina ou chega um pedido novo, e mostra "negado ou cancelado".
- **Negado pelo modo automático:** a atividade mostra "Pedido de ... negado".

### Testes e bugs

Os comandos de teste aparecem como teste, e não como comando de terminal: na equipe, "Rodando os testes"; na atividade, "roda a suíte de testes" com o comando.

- **Comandos reconhecidos:** `npm test` e `npm run test…` (também com pnpm, yarn, bun e composer), `node --test`, Jest, Vitest, Mocha, AVA e Playwright (também com `npx`, `pnpm exec` e afins), pytest e `python -m unittest`, PHPUnit, Pest e `php artisan test`, `go test`, `cargo test`, `dotnet test`, Maven e Gradle. Valem com `cd <pasta> &&` e variáveis antes (`CI=true npm test`), e no fim de uma cadeia `&&`, como `npm run build && npm test`. Um comando em segundo plano continua como comando de terminal, porque o resultado não volta.
- **Resultado:** quando o comando termina, a atividade mostra os testes verdes ou os bugs encontrados, com as contagens lidas do resumo do framework. Nenhum texto da saída vai ao painel: só os números. Sem resumo reconhecido, a linha sai sem números.
- **Bugs na cena:** um run que falha abre um bug por falha na sala de testes (o Lab de QA ou a Arena), ou 1 bug quando não há contagem. A sala fica em alarme. O run seguinte que passar esmaga os bugs, que somem com uma animação e entram no indicador de bugs esmagados do topo.
- **O que não abre bug:** um teste que você interrompeu e uma cadeia `&&` que falhou sem resumo de teste (a falha pode ter sido do build, por exemplo).

Os bugs são da sessão: continuam abertos de um ticket para o outro até um run passar.

### Cena

Abaixo do ticket, a cena mostra as seis salas do tema, com um token para cada agente:

| Sala | Escritório | Guilda | Quem fica |
|---|---|---|---|
| Orquestrador | Gerência | Salão da Guilda | A sessão principal, sempre, e os convidados |
| System Design | Sala de Arquitetura | Torre de Planos | Arquiteto |
| Dev | Open Space | Forja | Devs |
| Descanso | Copa | Taverna | Subagentes que já terminaram |
| Documentação | Wiki | Biblioteca | Documentador |
| Testes | Lab de QA | Arena | Tester |

- Cada agente fica na sala do seu papel e, quando termina, vai para a copa (taverna). A sessão principal não sai da sala dela, mesmo parada.
- Cabem até 3 tokens por sala; além disso, aparece "+N".
- Quem está trabalhando ou aguardando aprovação mostra um balão com a ação atual. A sala fica em destaque enquanto alguém trabalha nela.
- Quem espera a sua aprovação ganha o selo "!" e o balão da aprovação.
- A sala de testes mostra os bugs abertos, até 4 e "+N", e fica em alarme enquanto houver algum.
- Os agentes encerrados em tickets anteriores saem da cena.

A cena é animada, como no mockup:

- o subagente que termina caminha até a copa; se a copa já está cheia, ele vai até o "+N" e some;
- a delegação voa como um envelope (um pergaminho, na Guilda) de quem delegou até o novo agente;
- uma falha dá um tranco no retrato de quem falhou (uma ação que você interrompeu, não);
- os bugs novos surgem na sala de testes, e os esmagados somem com uma animação de derrota;
- o cartão final aparece quando um ticket é entregue.

Com a opção de reduzir movimento do sistema ligada, nada é animado: os tokens aparecem direto no lugar novo, e o cartão final aparece sem animação. Trocar de tema com o cartão final na tela faz o cartão sumir; isso muda no T14.

### Atividade

A coluna da direita (Atividade, ou Crônica na Guilda) mostra uma linha por evento, a mais recente no topo, com o retrato de quem agiu (ou um ícone de sistema, nas linhas de sessão e de ticket) e o horário:

- sessão iniciada e encerrada;
- pedido iniciado e encerrado, e etapa concluída;
- delegação a um subagente e fim de um subagente;
- uso de ferramentas (ler, editar, rodar um comando, buscar...) e falhas;
- resultado de testes, pedidos de aprovação e compactação do contexto.

- Cada ferramenta ganha uma linha quando começa, e uma falha ganha a sua. Um comando de teste ganha também a linha do resultado.
- "Sessão iniciada" só aparece quando o servidor recebe o início da sessão: uma sessão que já estava aberta quando o servidor subiu, ou quando a captura foi ligada, entra direto, sem essa linha.
- As linhas novas entram no topo com uma animação curta. Trocar de sessão ou de tema refaz a lista sem animação, e com a opção de reduzir movimento do sistema nada é animado.

Falhas aparecem em vermelho, interrupções e pedidos de aprovação em amarelo, e sucessos em verde. O cabeçalho mostra quantos eventos estão na lista. O navegador guarda até 200 eventos por sessão, e o servidor manda os 200 mais recentes a cada conexão.

#### Filtros

Acima da lista ficam os chips "Todos" e um por papel da equipe, com o retrato do papel. Também dá para filtrar pelo cartão da equipe, clicando no nome de um papel ou numa instância; clicar de novo volta para todos.

- O filtro só esconde linhas; o cabeçalho passa a mostrar "N de M eventos".
- No filtro por papel, uma delegação aparece para quem delegou e para o papel chamado, e uma etapa concluída, para o papel dono dela. As linhas de sessão e de ticket só aparecem em "Todos".
- No filtro por instância, a delegação que criou a instância fica de fora: ela é de quem delegou.
- O filtro volta para "Todos" quando você troca de sessão ou quando o papel ou a instância somem do cartão da equipe.

Comandos, caminhos e títulos aparecem como chegam do servidor, que corta e redige o que pode ser segredo antes de enviar ([ADR 0006](../adr/0006-seguranca-do-servidor-local.md)). Mesmo assim, cuidado ao compartilhar a tela: o modo discreto, que esconde esses textos, chega numa próxima entrega.

## Temas

São dois temas, com os mesmos dados e vocabulário próprio: **Escritório** (o padrão) e **Guilda**. O tema muda só os textos e o visual. Ele não toca no estado da sessão nem reabre a conexão com o servidor ([ADR 0009](../adr/0009-tema-como-camada.md)).

Para trocar:

- **Botões** no canto direito do topo.
- **Teclas:** `1` para Escritório, `2` para Guilda e `T` para alternar. As teclas não valem com Ctrl, Alt ou Cmd apertado, nem com o foco no seletor de sessão.
- **Endereço:** `http://127.0.0.1:47821/#escritorio` ou `http://127.0.0.1:47821/#guilda`. O endereço já abre no tema pedido, o que é útil para favoritos.

O navegador guarda a última escolha e a usa na próxima vez. O tema do endereço tem prioridade sobre o guardado. O título da aba mostra o tema atual, como "Agent Quest · Guilda". Com a opção de reduzir movimento do sistema ligada, a troca é imediata, sem transição.

## Selo de conexão

No topo, à direita, o selo mostra a conexão ao vivo com o servidor (passe o mouse para ver a explicação):

| Selo | O que significa |
|---|---|
| **conectando** | Abrindo a conexão pela primeira vez. |
| **ao vivo** | Conectado e recebendo os eventos do servidor. |
| **reconectando** | A conexão caiu (por exemplo, o servidor foi parado) e o navegador está tentando de novo sozinho. |
| **desconectado** | A conexão fechou de vez, por exemplo porque já há 8 painéis conectados. O painel tenta reabrir sozinho, com esperas crescentes de até 30 segundos. |

Se a conexão cair com o servidor ainda no ar (o computador suspenso, uma aba congelada pelo navegador), o painel reconecta sozinho e recebe só o que perdeu, sem baixar o estado inteiro de novo, desde que isso caiba no que o servidor guarda: as últimas 1 000 atualizações, até 1 MiB. Senão, recebe o estado completo. Uma aba que não acompanha o ritmo e acumula mais de 1 MiB sem ler é desconectada pelo servidor e volta sozinha, também com o estado completo ([detalhes](servidor.md#reconexão-e-painéis-lentos)).

Quando o servidor é reiniciado, o selo volta para "ao vivo" e o painel recebe o estado completo de novo. Como o servidor guarda tudo só em memória, um servidor reiniciado começa vazio, e as sessões reaparecem com os próximos eventos ([ADR 0005](../adr/0005-estado-em-memoria.md)).

## Seletor de sessão

O painel mostra uma sessão por vez. O seletor no topo lista as sessões que o servidor conhece, da que teve evento mais recente para a mais antiga. Cada opção traz o nome da sessão e o do projeto, como "Sessão 5f1c0a · meu-app", e "encerrada" quando a sessão terminou. Passe o mouse sobre o seletor para ver a pasta do projeto.

- O nome da sessão é o título dela no Claude Code; sem ele, o título do primeiro ticket da sessão, com até 48 caracteres; antes do primeiro pedido, "Sessão" com os 6 primeiros caracteres do id. Sem projeto conhecido, a opção traz só o nome da sessão.
- Aparecem as sessões de todos os projetos, porque a captura vale para todos. Os subagentes ficam dentro da sessão de quem os chamou.
- Ao abrir, o painel mostra a sessão mais recente.
- A sessão que você escolher continua escolhida enquanto existir. Se ela sumir, o painel volta para a mais recente. O servidor tira da memória as sessões encerradas há 30 minutos e as sem eventos há 6 horas.
- A escolha não é guardada entre recarregamentos da página.
- Sem sessões, o seletor fica escondido.

O agrupamento por projeto, a opção de seguir a sessão com atividade e o aviso de aprovação pendente em outra sessão chegam com o T13, em andamento.

## Sem sessões

Enquanto o servidor não conhece nenhuma sessão, o centro mostra "Nenhuma sessão por aqui ainda" (ou "O salão da guilda está vazio") com os passos para ligar a captura:

1. `npm run capture:deploy`;
2. `claude plugin marketplace add "$env:LOCALAPPDATA\agent-quest\marketplace"`;
3. `claude plugin install agent-quest@agent-quest-local`;
4. `/reload-plugins` nas sessões do Claude Code que já estavam abertas.

O passo a passo completo está em [Ligar, pausar e remover a captura](captura.md).

Abaixo dos passos, uma linha diz se o servidor está recebendo eventos. Ela é atualizada a cada 15 segundos, enquanto a aba estiver visível:

| Linha | O que significa |
|---|---|
| "Último evento recebido às HH:MM:SS." | A captura está enviando eventos, mas nenhuma sessão está em memória. Ou as sessões já foram limpas (encerradas há 30 minutos ou sem eventos há 6 horas), ou os eventos foram descartados: veja o `ignored` do `/api/health` e [Os eventos chegam, mas a sessão não aparece](servidor.md#os-eventos-chegam-mas-a-sessão-não-aparece-no-painel). |
| "Nenhum evento recebido desde HH:MM (início do servidor)." | Nada chegou desde que o servidor iniciou. Confira a captura ([solução de problemas](captura.md#solução-de-problemas)). |
| "Não foi possível consultar o servidor (/api/health)." | O painel não alcançou o servidor. Confira se ele está rodando. |

As colunas de equipe e atividade mostram "Ninguém no escritório ainda" e "Nenhuma atividade ainda", e a cena mostra as salas vazias.

## O que ainda não está ligado

| O que | Quando chega |
|---|---|
| Seletor agrupado por projeto, com status e aprovações pendentes de cada sessão; "seguir atividade"; aviso de aprovação pendente em outra sessão; escolha guardada | T13 (em andamento) |
| Modo discreto (esconde comandos, caminhos e títulos), a legenda com a fonte de cada indicador, o chip da instância filtrada e o cartão final que sobrevive à troca de tema | T14 |
| Barra de contexto (Foco ou Mana), opcional | T15 e T16 |

As regras de ticket, aprovação, testes e compactação seguem o design e foram testadas com cenários sintéticos. Elas ainda vão ser conferidas com os eventos reais da sessão de teste do T0, e podem mudar em detalhes depois dela.

## Testes de ponta a ponta (para quem desenvolve)

Os testes de ponta a ponta abrem o painel num navegador de verdade e conferem o que aparece na tela. Eles usam o `@playwright/test`, a única dependência de desenvolvimento do projeto, com o Microsoft Edge já instalado na máquina ([ADR 0010](../adr/0010-estrategia-de-testes.md)).

Uma vez, com internet, na raiz do repositório:

```powershell
npm install
```

Depois, quantas vezes quiser, sem internet:

```powershell
npm run test:e2e
```

- **Nenhum navegador é baixado.** O `npm install` instala só o pacote do Playwright, e os testes usam o Edge instalado (`channel: 'msedge'`), sem abrir janela. Não rode `npx playwright install`: o projeto não precisa dos navegadores do Playwright.
- **Não mexe no seu servidor.** Os testes sobem um servidor próprio, numa porta livre e com um diretório de dados temporário, nunca na porta 47821 nem em `%LOCALAPPDATA%\agent-quest\`. Dá para rodar com o seu servidor ligado. A pasta temporária é apagada no fim.
- **O que é conferido:** o painel abre sem violar a política de segurança de conteúdo, sem erro de script e sem nenhuma requisição para fora; a troca de tema por botões, teclas, endereço e memória do navegador; o layout em 360, 820 e 1280 px; a posição dos tokens na cena; os filtros da atividade; e as animações, inclusive que nenhuma é criada com movimento reduzido. Os testes com sessões usam os estados de exemplo de `test/fixtures/state/` e cenários sintéticos injetados num servidor de teste.
- **Ver o painel com dados sem a captura:** com o servidor no ar, o `npm run inject` envia um cenário de eventos pelo mesmo caminho da captura ([Injetar um cenário](servidor.md#injetar-um-cenário-npm-run-inject)).
- **Quando um teste falha,** o Playwright guarda o rastro em `test-results/`, que não vai para o repositório.
- O `npm test` não roda estes testes: ele cobre os de unidade e de integração, e não precisa de `npm install`.

## Para saber mais

- [Primeira luz: ligar o painel e a captura](primeira-luz.md): o roteiro completo, do servidor ao painel.
- [Iniciar e parar o servidor](servidor.md) e [Ligar, pausar e remover a captura](captura.md).
- [ADR 0004](../adr/0004-tempo-real-com-sse.md): tempo real com Server-Sent Events.
- [ADR 0008](../adr/0008-fontes-dos-indicadores.md): de onde vem cada indicador, e o que é real ou aproximado.
- [ADR 0009](../adr/0009-tema-como-camada.md): tema como camada de apresentação.
- [Modelo de eventos](../arquitetura/modelo-de-eventos.md), seções 6 (regras de ticket, etapa, aprovação, bugs, copa e saúde) e 9 (o estado que o servidor envia ao painel).
- [Mockup do painel](../../mockups/painel.html): a referência visual aprovada.
