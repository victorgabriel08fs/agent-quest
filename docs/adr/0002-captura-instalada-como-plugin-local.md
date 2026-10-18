# ADR 0002: Captura instalada como plugin de um marketplace local

- **Status:** proposta (aguarda aprovação do usuário)
- **Data:** 17/10/2026

## Contexto

Os hooks precisam valer em todos os projetos do usuário, no terminal e no VS Code, e também dentro dos subagentes. Instalar e desinstalar não pode estragar configurações existentes. O repositório fica dentro do OneDrive.

O que foi conferido na documentação oficial (plugins, 17/10/2026):

- Um plugin declara hooks em `hooks/hooks.json`. `${CLAUDE_PLUGIN_ROOT}` é resolvido em `command` e `args`, e o processo do hook recebe `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` e `CLAUDE_PROJECT_DIR`.
- `claude plugin marketplace add <caminho>` registra o marketplace em `extraKnownMarketplaces`, na configuração do usuário. `claude plugin install <plugin>@<marketplace>` instala com escopo `user` por padrão.
- `claude plugin marketplace remove <nome>` remove o marketplace e desinstala os plugins dele. `claude plugin disable` e `enable` ligam e desligam sem desinstalar.
- Plugin de marketplace adicionado por caminho local é carregado direto da pasta, sem cópia para o cache. Edições valem na próxima sessão ou com `/reload-plugins`.
- `claude --plugin-dir <pasta>` e a variável `CLAUDE_CODE_PLUGIN_DIRS` carregam um plugin só naquela sessão, sem instalar nada.
- A extensão do VS Code gerencia plugins com os mesmos comandos do CLI e compartilha o `~/.claude/settings.json`.
- Hooks de plugin também disparam dentro dos subagentes (pesquisa, seção 3b).

## Decisão

1. O código da captura fica em `capture/`, já no formato de marketplace: `capture/.claude-plugin/marketplace.json` (marketplace `agent-quest-local`) e o plugin em `capture/plugins/agent-quest/`.
2. `npm run capture:deploy` copia `capture/` para `%LOCALAPPDATA%\agent-quest\marketplace\`, fora do OneDrive, e imprime os comandos abaixo com o caminho completo. O script não executa `claude`.
3. O usuário liga a captura uma única vez, em escopo de usuário:
   - `claude plugin marketplace add "<caminho impresso>"`
   - `claude plugin install agent-quest@agent-quest-local`
4. Para pausar: `claude plugin disable agent-quest@agent-quest-local`. Para remover tudo: `claude plugin marketplace remove agent-quest-local`.
5. Para testar sem instalar: `claude --plugin-dir "<repo>\capture\plugins\agent-quest"`.
6. Nenhum agente do time roda esses comandos por conta própria. Ligar a captura passa sempre pelo usuário.

## Alternativas consideradas

- **Script que edita o `~/.claude/settings.json`.** Dá controle total, mas pode corromper o arquivo (o próprio Claude Code também grava nele) e exige backup, marcação das entradas e desinstalação cuidadosa.
- **Hooks no `.claude/settings.local.json` de cada projeto.** Cobre só os projetos configurados, um por um.
- **Plugin com escopo `project`.** Grava no `.claude/settings.json`, que é versionado. Não serve para uma ferramenta pessoal.
- **Marketplace apontando direto para `capture/` no repositório.** Dispensa o deploy, mas qualquer edição em andamento passaria a valer em todas as sessões do usuário, e os arquivos ficariam no OneDrive, sujeitos a ficar só na nuvem.

## Consequências

- Nada do Agent Quest edita arquivos de configuração. O Claude Code grava só as chaves que ele mesmo gerencia (`extraKnownMarketplaces` e `enabledPlugins`).
- A captura vale em todas as sessões de todos os projetos. Quem quiser só alguns projetos pode instalar com `--scope local` em cada um (pergunta ao usuário).
- Mudança no encaminhador só chega às sessões depois de `npm run capture:deploy` e de uma sessão nova (ou `/reload-plugins`).
- Em pasta sem confiança de workspace, o Claude Code pode segurar os hooks até o usuário aceitar o diálogo de confiança.

## Fontes

- https://code.claude.com/docs/en/plugins-reference (hooks, variáveis de ambiente)
- https://code.claude.com/docs/en/plugins/loading (carregamento no lugar, `--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS`, conflitos de nome)
- https://code.claude.com/docs/en/plugins/cli-reference (`install`, `uninstall`, `enable`, `disable`, `marketplace add/remove`, escopos)
- https://code.claude.com/docs/en/plugin-marketplaces (marketplace local)
- https://code.claude.com/docs/en/vs-code (plugins compartilhados entre extensão e CLI)
