# Agent Quest

Painel local e gamificado que mostra, em tempo real, o que cada agente do Claude Code está fazendo: a sessão principal (orquestradora) e os subagentes do time.

## Regras do produto

- **100% local.** Servidor, dados e interface rodam na máquina do usuário. Nada de serviços na nuvem, CDN, fontes ou bibliotecas carregadas da internet, nem telemetria. Os agentes continuam usando a API da Anthropic: isso é do Claude Code, não do Agent Quest.
- **Seguro por padrão.** O servidor escuta só em `127.0.0.1` e valida a origem das conexões, porque os eventos podem conter código, comandos e segredos.
- **Nunca atrapalhar os agentes.** A captura de eventos não pode travar nem atrasar o Claude Code. Se o servidor estiver fora do ar, o hook termina rápido e em silêncio.
- **Tema é só uma camada.** Escritório e Guilda traduzem os mesmos eventos canônicos em vocabulário e visual próprios. Nenhuma regra de negócio depende do tema.
- **A gamificação é para quem observa.** Os agentes não veem pontuação nem são instruídos a buscá-la.

## Escopo da v1

Captura real dos eventos → servidor local → painel no navegador com equipe, cena e atividade ao vivo, nos dois temas (Escritório e Guilda), com alternância entre eles.

Fica para depois da v1: XP e níveis, conquistas e replay.

Referência visual aprovada: `mockups/painel.html`. O arquivo `mockups/temas.html` é só histórico da escolha de tema.

## Time

A sessão principal é a **orquestradora**: quebra o trabalho em tarefas, delega para o agente certo, confere cada entrega e não pula etapas.

| Agente | Papel | Entrega |
|---|---|---|
| `arquiteto` | System design | ADRs, documentos de arquitetura, contratos entre as partes, plano de tarefas |
| `dev-backend` | Hooks, servidor local, modelo de eventos | Código e testes unitários do que escreveu |
| `dev-frontend` | Painel no navegador e temas | Código e testes unitários do que escreveu |
| `tester` | Qualidade | Testes de integração e ponta a ponta, relatório de bugs |
| `documentador` | Documentação | README, guias e documentação de cada funcionalidade |

## Fluxo de toda tarefa

1. **Design** (`arquiteto`). A decisão fica registrada em `docs/adr/` ou `docs/arquitetura/`. Mudança de arquitetura, stack ou contrato precisa da aprovação do usuário antes de seguir.
2. **Implementação** (`dev-backend` / `dev-frontend`). Segue o design. Se precisar desviar dele, volta para o arquiteto.
3. **Testes** (`tester`). A tarefa só avança com a suíte verde. Bug encontrado volta para o dev, e o tester valida de novo.
4. **Documentação** (`documentador`). A tarefa só fecha com a documentação atualizada.

## Convenções

- Interface, documentação e comentários em português do Brasil. Nomes no código (arquivos, variáveis, funções, tipos) em inglês.
- ADRs em `docs/adr/NNNN-titulo-curto.md`, numerados em sequência, com contexto, decisão, alternativas e consequências.
- Arquitetura em `docs/arquitetura/`. Plano e tarefas da versão em andamento em `docs/plano/`.
- Toda dependência nova precisa funcionar offline depois de instalada e ser justificada no design.
- Ambiente do usuário: Windows 11, Node 24, Git Bash e PowerShell.
