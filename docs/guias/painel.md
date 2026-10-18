# O painel

O painel é a página do Agent Quest no navegador. Ele mostra, ao vivo, o que cada agente de uma sessão do Claude Code está fazendo: quem está na equipe, o pedido em andamento, onde cada agente está na cena e o que acabou de acontecer. Tudo roda na sua máquina, sem nada carregado da internet.

Este guia é a primeira versão: explica como abrir o painel, o que cada área mostra, como trocar de tema e de sessão, e o que ainda não está ligado.

> **Situação nesta fase.** O painel já está pronto e conectado ao vivo ao servidor, mas o servidor ainda não transforma os eventos recebidos em sessões. Por isso, mesmo com a captura ligada, o painel mostra o estado sem sessões. Equipe, ticket, cena e atividade passam a mostrar eventos reais com as próximas entregas do servidor (T7 e a ligação de ponta a ponta do T9a, no [plano da v1](../plano/v1.md)). Até lá, o que você vê com dados vem dos testes, que usam estados de exemplo escritos à mão.

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

- Pode abrir o painel em mais de uma aba. O servidor aceita até 8 conexões ao vivo ao mesmo tempo; veja o [selo de conexão](#selo-de-conexão).
- Mudou algum arquivo em `web/`? Aperte F5. Os arquivos do painel saem do servidor com `Cache-Control: no-cache`, então o navegador busca a versão nova.

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

Nesta fase, bugs, entregas e aprovações ficam em zero: esses valores chegam com o T8.

### Equipe

Um bloco por papel, com o nome do papel no tema e o papel real embaixo. Aparecem o orquestrador, os papéis que têm agente definido em `.claude/agents/` do projeto, os que surgirem na sessão e, se algum agente fora do time for chamado, o convidado:

| Papel real | Agente do Claude Code | Escritório | Guilda |
|---|---|---|---|
| Orquestrador | a sessão principal | Gerente de Projeto | Mestre da Guilda |
| System Design | `arquiteto` | Arquiteto de Software | Arquimago |
| Dev | `dev-backend`, `dev-frontend` | Dev Full-stack | Ferreiro |
| Tester | `tester` | Analista de QA | Caçador de Bugs |
| Documentação | `documentador` | Tech Writer | Escriba |
| Convidado | qualquer outro tipo de agente (por exemplo, `general-purpose`, `Explore`, `Plan`) | Consultor Externo | Aventureiro Convidado |

Em cada bloco:

- **Uma linha por instância.** Cada subagente chamado é uma instância, com a descrição da delegação como rótulo. Convidados mostram também o tipo real do agente.
- **"×N"** aparece quando há mais de uma instância do papel em andamento ao mesmo tempo, e conta só as que não terminaram.
- **Linha de ação:** o que a instância está fazendo agora, na voz do tema. Por exemplo, "Editando `server/http/app.js`" no Escritório ou "Conjurando `git status`" na Guilda. Também mostra "Aguardando sua aprovação", "Delegando: ..." ou, quando parada, "Tomando café na copa" (na Guilda, "Descansando na taverna"). A sessão principal parada mostra "Aguardando o próximo pedido".
- **Barra de saúde** (Humor no Escritório, Vida na Guilda): ≈ a fração das últimas 10 ações sem erro. Passe o mouse para ver, por exemplo, "Humor ≈ 8 de 10 ações sem erro (últimas 10)".
- **Instâncias encerradas** do pedido atual continuam visíveis, até 3 por papel. As demais viram "+N instâncias encerradas". As de pedidos anteriores saem do cartão.

O cabeçalho mostra quantos agentes estão ativos entre os presentes, como "2/3 ativos".

### Ticket e etapas

O cartão do centro mostra o pedido em andamento (o ticket, ou quest na Guilda):

- número e situação: em andamento, aguardando tarefa em segundo plano, entregue, falhou ou interrompido;
- título: a primeira linha do seu pedido, já redigida;
- duração, número de ações e, se o pedido falhou, o tipo de erro;
- **etapas**: Arquitetura, Desenvolvimento, QA e Documentação (na Guilda, Torre de Planos, Forja, Arena e Biblioteca). Cada uma acende quando o agente daquele papel começa no pedido e ganha ✓ quando ele termina. As etapas só aparecem quando o pedido envolve algum papel do time.

Sem pedido em andamento, o cartão mostra "Sem ticket no momento" (ou "Nenhuma quest no quadro"). Nesta fase, é sempre assim: os tickets chegam com o T8.

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
- Os agentes encerrados em pedidos anteriores saem da cena.

Nesta fase, a cena é estática: os tokens mudam de sala sem animação.

### Atividade

A coluna da direita (Atividade, ou Crônica na Guilda) mostra uma linha por evento, a mais recente no topo, com o retrato de quem agiu (ou um ícone de sistema, nas linhas de sessão e de ticket) e o horário:

- sessão iniciada e encerrada;
- pedido iniciado e encerrado, e etapa concluída;
- delegação a um subagente e fim de um subagente;
- uso de ferramentas (ler, editar, rodar um comando, buscar...) e falhas;
- resultado de testes, pedidos de aprovação e compactação do contexto.

Falhas aparecem em vermelho, interrupções e pedidos de aprovação em amarelo, e sucessos em verde. O cabeçalho mostra quantos eventos estão na lista. O navegador guarda até 200 eventos por sessão.

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

Quando o servidor volta, o selo volta para "ao vivo" e o painel recebe o estado completo de novo. Como o servidor guarda tudo só em memória, um servidor reiniciado começa vazio, e as sessões reaparecem com os próximos eventos ([ADR 0005](../adr/0005-estado-em-memoria.md)).

## Seletor de sessão

O painel mostra uma sessão por vez. O seletor no topo lista as sessões que o servidor conhece, da que teve evento mais recente para a mais antiga. Cada opção traz o nome da sessão e o do projeto, como "Sessão 5f1c0a · agents-quest", e "encerrada" quando a sessão terminou. Passe o mouse sobre o seletor para ver a pasta do projeto.

- Ao abrir, o painel mostra a sessão mais recente.
- A sessão que você escolher continua escolhida enquanto existir. Se ela sumir (o servidor limpa sessões antigas), o painel volta para a mais recente.
- A escolha não é guardada entre recarregamentos da página.
- Sem sessões, o seletor fica escondido.

O agrupamento por projeto, a opção de seguir a sessão com atividade e o aviso de aprovação pendente em outra sessão chegam numa próxima entrega (T13).

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
| "Último evento recebido às HH:MM:SS." | A captura está enviando eventos. Nesta fase, as sessões ainda não aparecem: isso confirma que a captura funciona. |
| "Nenhum evento recebido desde HH:MM (início do servidor)." | Nada chegou desde que o servidor iniciou. Confira a captura ([solução de problemas](captura.md#solução-de-problemas)). |
| "Não foi possível consultar o servidor (/api/health)." | O painel não alcançou o servidor. Confira se ele está rodando. |

As colunas de equipe e atividade mostram "Ninguém no escritório ainda" e "Nenhuma atividade ainda", e a cena mostra as salas vazias.

## O que ainda não está ligado

| O que | Quando chega |
|---|---|
| Equipe, ticket, cena e atividade com eventos reais | T7 e a ligação de ponta a ponta do T9a |
| Tickets, etapas, "aguardando aprovação", bugs e resultado de testes; indicadores do topo com valores reais | T6 e T8 |
| Cena animada: o agente caminhando até a copa, o pergaminho da delegação, o impacto de uma falha, os bugs no Lab de QA e o selo "!" de aprovação | T12b |
| Filtros da atividade por papel e por agente, e animação de entrada das linhas | T11b |
| Retomada da conexão sem baixar o estado inteiro de novo | T9b |
| Seletor agrupado por projeto, "seguir atividade" e escolha guardada | T13 |
| Modo discreto (esconde comandos, caminhos e títulos) e a legenda com a fonte de cada indicador | T14 |
| Barra de contexto (Foco ou Mana), opcional | T15 e T16 |

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
- **O que é conferido:** o painel abre sem violar a política de segurança de conteúdo, sem erro de script e sem nenhuma requisição para fora; a troca de tema por botões, teclas, endereço e memória do navegador; o layout em 360, 820 e 1280 px; e a posição dos tokens na cena. Os testes com sessões simulam o servidor ao vivo com os estados de exemplo de `test/fixtures/state/`.
- **Quando um teste falha,** o Playwright guarda o rastro em `test-results/`, que não vai para o repositório.
- O `npm test` não roda estes testes: ele cobre os de unidade e de integração, e não precisa de `npm install`.

## Para saber mais

- [Iniciar e parar o servidor](servidor.md) e [Ligar, pausar e remover a captura](captura.md).
- [ADR 0004](../adr/0004-tempo-real-com-sse.md): tempo real com Server-Sent Events.
- [ADR 0008](../adr/0008-fontes-dos-indicadores.md): de onde vem cada indicador, e o que é real ou aproximado.
- [ADR 0009](../adr/0009-tema-como-camada.md): tema como camada de apresentação.
- [Modelo de eventos](../arquitetura/modelo-de-eventos.md), seções 6 (regras de ticket, etapa, aprovação, bugs, copa e saúde) e 9 (o estado que o servidor envia ao painel).
- [Mockup do painel](../../mockups/painel.html): a referência visual aprovada.
