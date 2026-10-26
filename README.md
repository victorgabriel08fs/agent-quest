# Agent Quest

**Veja o seu time de agentes do Claude Code trabalhando, ao vivo, num painel no navegador.** O orquestrador delega, os subagentes leem, editam e rodam comandos, e o Agent Quest mostra tudo como uma equipe num escritório ou uma party numa guilda. Tudo roda na sua máquina.

**In English:** Agent Quest is a local, gamified dashboard that shows, in real time, what each Claude Code agent is doing: the main session that orchestrates the work and every subagent it calls, drawn as an office team or a guild party. It runs 100% on your machine: the server listens only on `127.0.0.1`, with no cloud services, CDN or telemetry. Events come from a Claude Code plugin with asynchronous hooks, which never slow the agents down. It needs only Node 24, and Windows 11 is the tested platform. The full documentation is in Brazilian Portuguese.

<!-- print: painel principal no tema Escritório, a partir de um cenário sintético injetado (nunca de uma sessão real): ticket com as etapas; equipe com o orquestrador, dois devs em paralelo e o tester; cena com os tokens nas salas, um agente na copa e bugs na sala de testes; atividade com delegações, ferramentas, uma falha e um resultado de testes. Largura de 1280 px, até 1 MB, com texto alternativo. -->

> **Situação:** em desenvolvimento, rumo à v1. O código da v1 está pronto e testado com cenários sintéticos, menos uma barra opcional. A instalação da captura no Claude Code real e a conferência com eventos reais ainda esperam a sessão de teste dos hooks. Veja [Situação e roteiro](#situação-e-roteiro).

## O que é

O Agent Quest é um painel local e gamificado que mostra, em tempo real, o que cada agente do Claude Code está fazendo: a sessão principal, que orquestra, e cada subagente que ela chama. Você vê quem está na equipe, o que cada um faz agora, quem já terminou e o que acabou de acontecer. A gamificação é só para quem observa: os agentes não veem o painel nem pontuação, e nada muda no trabalho deles.

## Destaques

- **Equipe e cena ao vivo.** Cada subagente aparece com a descrição da tarefa que recebeu, a ação atual ("Editando `server/http/app.js`") e uma barra de saúde. Quem termina caminha até a copa.
- **Cada pedido vira um ticket,** com as etapas do time (arquitetura, desenvolvimento, QA e documentação) e um cartão final quando é entregue.
- **Testes viram bugs na cena.** Um run que falha solta bugs na sala de testes; o run seguinte que passa os esmaga.
- **Aprovações à vista.** Quem espera a sua aprovação ganha um "!", e o topo conta os pedidos pendentes.
- **Subagentes em paralelo.** Duas instâncias do mesmo agente aparecem separadas, cada uma com as próprias ações.
- **Várias sessões.** As sessões de todos os projetos, agrupadas, e o painel segue sozinho a que tem atividade.
- **Pronto para compartilhar a tela.** O modo discreto esconde comandos, caminhos e títulos com uma tecla.
- **Dois temas, os mesmos dados.** Escritório e Guilda, com troca a qualquer momento.
- **100% local.** Servidor, dados e interface ficam na sua máquina. Nada de nuvem, CDN ou telemetria.
- **Nunca atrapalha os agentes.** A captura roda em segundo plano e não atrasa o Claude Code. Com o servidor desligado, ela sai em silêncio.
- **Zero dependências para usar.** Só o Node 24. Nada de `npm install` nem etapa de build.

## Como funciona

```text
Claude Code ──hook──▶ encaminhador ──POST /hooks──▶ servidor local ──SSE /events──▶ painel
(sessão e subagentes)  (em segundo plano)  (127.0.0.1 + token)  (estado em memória)        (navegador)
```

1. O plugin `agent-quest` registra 15 hooks assíncronos no Claude Code. A cada evento (pedido, ferramenta, subagente, fim de turno), o Claude Code inicia o encaminhador em segundo plano e segue sem esperar.
2. O encaminhador lê o `runtime.json` para saber se o servidor está no ar e envia o evento só para `127.0.0.1`, com o token da execução. Ele nunca imprime nada e termina em cerca de 2 segundos; sem servidor, sai na hora.
3. O servidor responde na hora e só depois processa: tira o conteúdo do evento, redige segredos, atualiza o estado das sessões em memória e envia a mudança aos painéis abertos.
4. O painel aplica a mudança e a mostra no tema escolhido.

Mais detalhes: [visão geral da arquitetura](docs/arquitetura/visao-geral.md), [modelo de eventos](docs/arquitetura/modelo-de-eventos.md) e as [decisões de design (ADRs)](docs/README.md#decisões-adrs).

## Privacidade e segurança

Os eventos do Claude Code podem conter código, comandos e segredos. Por isso, o Agent Quest é seguro por padrão:

- **O que é capturado:** o evento que o Claude Code entrega a cada hook, com textos longos já cortados, mais a pasta do projeto. Ele só vai para o servidor na sua máquina.
- **O que o painel mostra:** nomes de ferramentas, a primeira linha dos comandos, caminhos relativos ao projeto, descrições e erros curtos, tudo cortado e com segredos redigidos (`API_KEY=•••`). Para compartilhar a tela, o modo discreto esconde esses textos; o nome do projeto continua visível.
- **O que nunca é guardado:** conteúdo de arquivos, trechos editados, saídas de comandos, o texto do assistente, a instrução passada a cada subagente e o pedido completo.
- **Nada de eventos em disco.** O estado fica só na memória e some quando o servidor para. A única exceção é a gravação de depuração `--debug-dump`, que você liga de propósito. O `runtime.json`, que diz à captura onde o servidor está, guarda só porta, token e processo, numa pasta fora do OneDrive.
- **Servidor fechado.** Escuta só em `127.0.0.1`, aceita só o próprio painel e a captura com o token da execução, não tem CORS e não carrega nada da internet.
- **Você no controle.** A captura é instalada, pausada e removida só por você, com os comandos do [guia da captura](docs/guias/captura.md#pausar-retomar-e-remover).

Os agentes continuam usando a API da Anthropic normalmente: isso é do Claude Code, não do Agent Quest. Detalhes e riscos aceitos: [ADR 0006](docs/adr/0006-seguranca-do-servidor-local.md) e [Segurança em resumo](docs/guias/servidor.md#segurança-em-resumo).

## Requisitos

- **Windows 11**, onde o projeto é desenvolvido e testado, com PowerShell ou Git Bash.
- **Node 24** ou mais novo.
- **Claude Code com suporte a plugins**, no terminal ou na extensão do VS Code. A referência do projeto é a versão 2.1.301.
- **Um navegador moderno.** O projeto é testado no Microsoft Edge.

## Início rápido

```powershell
git clone <url-do-repositório> agent-quest
cd agent-quest
npm start
```

Abra `http://127.0.0.1:47821/`. Sem a captura, o painel mostra o estado sem sessões e explica como ligá-la. Para parar o servidor, aperte Ctrl+C na janela dele. Com `npm run dev`, o servidor reinicia sozinho quando o código muda.

<!-- print: painel sem sessões, com os passos para ligar a captura e a linha do último evento recebido. -->

**Para ligar a captura, siga o guia [Primeira luz: ligar o painel e a captura](docs/guias/primeira-luz.md).** Ele cobre a cópia do plugin, um teste sem instalar, a instalação, o `/reload-plugins` e como pausar e remover.

> **Antes de instalar a captura:** a instalação no Claude Code real só acontece depois da sessão de teste dos hooks ([Sonda do T0](tools/probe/README.md)) e da liberação do design que vem dela. Os comandos de instalação seguem a documentação do Claude Code, mas ainda não foram conferidos numa instalação real. Quem instala a captura é sempre você.

## Uso

- **Sessões:** o seletor no topo lista as sessões do Claude Code de todos os projetos, agrupadas por projeto, com status e aprovações pendentes. Por padrão, o painel segue a sessão com atividade; escolher uma sessão no seletor a fixa. Quando outra sessão espera a sua aprovação, um aviso no topo leva até ela.
- **Modo discreto:** antes de compartilhar a tela, aperte `D` ou o botão 🕶️. Comandos, caminhos, títulos, descrições e erros dão lugar a frases só de categoria. **O nome do projeto continua visível.**
- **Legenda:** a tecla `?` ou o botão "?" explica cada frase do tema e de onde vem cada indicador.
- **Filtros:** os chips acima da atividade, o nome de um papel ou uma instância no cartão da equipe mostram só a atividade dele.
- **Ticket, equipe, cena e atividade:** o que cada área mostra está em [O painel](docs/guias/painel.md). Com a opção de reduzir movimento do sistema ligada, nada é animado.
- **Servidor:** porta, `config.json`, papéis de agentes com outros nomes e mensagens do terminal estão em [Iniciar e parar o servidor](docs/guias/servidor.md).

| Tecla | O que faz |
|---|---|
| `1`, `2` e `T` | Tema Escritório, tema Guilda e alterna o tema |
| `D` | Liga ou desliga o modo discreto |
| `?` | Abre a legenda (Esc fecha) |

O navegador guarda o tema, o modo discreto e a sessão escolhida.

<!-- print: o mesmo cenário sintético com o modo discreto ligado, mostrando as frases só de categoria. -->

<!-- print: seletor aberto com duas sessões sintéticas em projetos diferentes, agrupadas, e o aviso de aprovação pendente em outra sessão. -->

## Temas

Escritório e Guilda mostram os mesmos dados, com vocabulário e visual próprios. O tema é só uma camada: trocar de tema não mexe no estado nem na conexão.

| Papel | Agente do Claude Code | Escritório | Guilda |
|---|---|---|---|
| Orquestrador | a sessão principal | Gerente de Projeto, na Gerência | Mestre da Guilda, no Salão da Guilda |
| System Design | `arquiteto` | Arquiteto de Software, na Sala de Arquitetura | Arquimago, na Torre de Planos |
| Dev | `dev-backend`, `dev-frontend` | Dev Full-stack, no Open Space | Ferreiro, na Forja |
| Tester | `tester` | Analista de QA, no Lab de QA | Caçador de Bugs, na Arena |
| Documentação | `documentador` | Tech Writer, na Wiki | Escriba, na Biblioteca |
| Convidado | qualquer outro tipo de agente | Consultor Externo, na Gerência | Aventureiro Convidado, no Salão da Guilda |

Quem termina vai para a Copa (no Escritório) ou para a Taverna (na Guilda). Agentes com outros nomes ganham papel pela chave `roles` do `config.json` ([Papéis de outros agentes](docs/guias/servidor.md#papéis-de-outros-agentes-roles)).

<!-- print: o mesmo cenário sintético nos temas Escritório e Guilda, lado a lado. -->

## Solução de problemas

| Sintoma | Onde olhar |
|---|---|
| Painel vazio ("Nenhuma sessão por aqui ainda") | [Sem sessões](docs/guias/painel.md#sem-sessões): a linha de baixo diz se algum evento chegou |
| "A porta 47821 já está em uso por outro programa." | [Porta ocupada](docs/guias/servidor.md#a-porta-47821-já-está-em-uso-por-outro-programa) |
| Nenhum evento chegando | [Nenhum evento chegando](docs/guias/servidor.md#nenhum-evento-chegando) |
| Os eventos chegam, mas a sessão não aparece | [A sessão não aparece no painel](docs/guias/servidor.md#os-eventos-chegam-mas-a-sessão-não-aparece-no-painel) |
| Servidor desligado | A captura sai em silêncio, e o painel mostra "reconectando". Inicie o servidor de novo ([Selo de conexão](docs/guias/painel.md#selo-de-conexão)) |

## Desenvolvimento e contribuição

### O time de agentes

O Agent Quest é construído por um time de agentes do Claude Code, o mesmo tipo de time que o painel mostra. A sessão principal orquestra: quebra o trabalho em tarefas, delega ao agente certo e confere cada entrega.

| Agente | Papel |
|---|---|
| `arquiteto` | Design: ADRs, arquitetura, contratos e plano de tarefas |
| `dev-backend` | Captura, servidor local e modelo de eventos |
| `dev-frontend` | Painel no navegador e temas |
| `tester` | Testes de integração e de ponta a ponta |
| `documentador` | README, guias e changelog |

Toda tarefa passa por design, implementação, testes e documentação, nessa ordem, e só avança com a suíte verde. Mudança de arquitetura, stack ou contrato vira um ADR e precisa da aprovação do dono do projeto. As regras completas estão no [CLAUDE.md](CLAUDE.md), e as definições dos agentes, em [.claude/agents/](.claude/agents/).

### Estrutura do repositório

```text
capture/          plugin de captura (fonte): marketplace local, hooks e encaminhador
server/           servidor local: HTTP e segurança, ingestão, normalização, estado e tempo real
web/              painel no navegador: conexão, store, views, cena e temas
shared/           contrato entre o servidor e o painel
scripts/          npm test, npm run capture:deploy e npm run inject
test/             testes de unidade, integração e ponta a ponta, e fixtures
tools/probe/      sonda da sessão de teste dos hooks (T0)
docs/             guias, arquitetura, ADRs, plano e pesquisa
mockups/          referência visual aprovada do painel
.claude/agents/   o time de agentes que constrói o projeto
```

### Testes

```powershell
npm test           # unidade e integração, sem npm install
npm install        # uma vez, com internet, só para o E2E
npm run test:e2e   # ponta a ponta com o Microsoft Edge instalado, sem baixar navegadores
```

Os testes sobem servidores próprios, numa porta livre e com uma pasta de dados temporária: nunca mexem no seu servidor nem na sua captura. O `@playwright/test` é a única dependência de desenvolvimento ([ADR 0010](docs/adr/0010-estrategia-de-testes.md)).

Para ver o painel com dados sem o Claude Code, o injetor envia ao servidor local um cenário de eventos de hooks, pelo mesmo caminho da captura:

```powershell
npm run inject -- <arquivo.json> [--fast] [--speed N]
```

O formato do cenário, de onde ele vem e um exemplo mínimo estão em [Injetar um cenário](docs/guias/servidor.md#injetar-um-cenário-npm-run-inject). Os cenários reais, gravados e sanitizados, chegam com a sessão de teste dos hooks.

### Convenções

- Interface, documentação e comentários em português do Brasil; nomes no código em inglês.
- JavaScript ESM sem build e sem dependências de execução ([ADR 0003](docs/adr/0003-stack-node-sem-build.md)). Toda dependência nova precisa funcionar offline e ser justificada no design.
- Decisões em `docs/adr/`, arquitetura em `docs/arquitetura/` e plano em `docs/plano/`.

### Reportar um bug

Abra uma issue com a versão do Agent Quest (campo `version` do `/api/health`), a versão do Claude Code, o que você fez, o que esperava e o que aconteceu. Ajudam também os números do `http://127.0.0.1:47821/api/health` e as linhas de erro do terminal do servidor, que trazem só o tipo do erro.

**Nunca cole** conteúdo de sessões reais, o `runtime.json`, tokens ou arquivos do `--debug-dump`: eles podem ter código, comandos e segredos.

## Situação e roteiro

**Já funciona**, com testes:

- captura com os 15 hooks assíncronos e o `npm run capture:deploy`;
- servidor local seguro, sem dependências, com o estado das sessões em memória;
- normalização dos eventos com redação de segredos, inclusive a detecção de comandos de teste e a leitura do resumo deles;
- sessões, agentes, subagentes em paralelo e aninhados, delegações e a ida para a copa;
- tickets por pedido, etapas do time, aprovações pendentes, bugs abertos pelos testes e esmagados no run seguinte, e os indicadores do topo;
- painel ao vivo com ticket, equipe, cena animada, atividade com filtros, os dois temas e layout responsivo;
- várias sessões: seletor agrupado por projeto, "seguir atividade" e aviso de aprovação pendente em outra sessão;
- modo discreto, legenda "Como ler o painel" e atalhos de teclado;
- reconexão do painel sem baixar o estado inteiro de novo;
- injetor de cenários para desenvolvimento (`npm run inject`).

As regras de ticket, aprovação e testes foram testadas com cenários sintéticos e ainda vão ser conferidas com os eventos reais da sessão de teste dos hooks.

**Para fechar a v1:**

- **a Primeira luz:** a sessão de teste dos hooks no Claude Code real, a liberação do design e a primeira instalação da captura;
- conferir com os eventos reais as regras que dependem deles e fazer os ajustes que eles mostrarem;
- os prints deste README e o roteiro de aceite da v1 com o Claude Code real;
- opcional: uma barra com o uso aproximado do contexto de cada agente.

**Depois da v1:** XP e níveis, conquistas, replay e custo da sessão.

O plano completo está em [docs/plano/v1.md](docs/plano/v1.md), e o que muda em cada entrega, no [CHANGELOG](CHANGELOG.md).

## Documentação

| Para... | Leia |
|---|---|
| Ligar tudo pela primeira vez | [Primeira luz: ligar o painel e a captura](docs/guias/primeira-luz.md) |
| Iniciar, configurar e parar o servidor | [Iniciar e parar o servidor](docs/guias/servidor.md) |
| Entender cada área do painel | [O painel](docs/guias/painel.md) |
| Copiar, instalar, pausar e remover a captura | [Ligar, pausar e remover a captura](docs/guias/captura.md) |
| Arquitetura, ADRs, plano e pesquisa | [Índice da documentação](docs/README.md) |

## Licença

[MIT](LICENSE).
