# ADR 0002: Captura instalada como plugin de um marketplace local

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

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
- A captura vale em todas as sessões de todos os projetos. Quem quiser só alguns projetos pode instalar com `--scope local` em cada um (o usuário escolheu o escopo de usuário; ver "Aprovação").
- Mudança no encaminhador só chega às sessões depois de `npm run capture:deploy` e de uma sessão nova (ou `/reload-plugins`).
- Em pasta sem confiança de workspace, o Claude Code pode segurar os hooks até o usuário aceitar o diálogo de confiança.

## Fontes

- https://code.claude.com/docs/en/plugins-reference (hooks, variáveis de ambiente)
- https://code.claude.com/docs/en/plugins/loading (carregamento no lugar, `--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS`, conflitos de nome)
- https://code.claude.com/docs/en/plugins/cli-reference (`install`, `uninstall`, `enable`, `disable`, `marketplace add/remove`, escopos)
- https://code.claude.com/docs/en/plugin-marketplaces (marketplace local)
- https://code.claude.com/docs/en/vs-code (plugins compartilhados entre extensão e CLI)
- https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins (`/reload-plugins` aplica na sessão aberta plugins instalados por um `claude plugin` rodado em outro terminal)
- https://code.claude.com/docs/en/prompt-caching#enabling-or-disabling-a-plugin ("Claude Code never invalidates the cache for a plugin's skills, commands, agents, hooks, monitors, or themes")

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão, com o **escopo de usuário**: a captura vale em todas as sessões de todos os projetos, no terminal e no VS Code. A instalação é feita pelo próprio usuário no marco "Primeira luz" (`docs/plano/v1.md`), depois de um teste curto com `--plugin-dir`. Numa sessão que já estava aberta, a captura passa a valer depois de `/reload-plugins` nela; como o plugin só tem hooks, o recarregamento não invalida o cache de prompt (fontes acima). Nas outras sessões, vale a partir da próxima sessão.

## Complemento de 18/10/2026: versão da captura

- **Uma versão só para a captura**, no formato semver: a mesma string em `capture/plugins/agent-quest/.claude-plugin/plugin.json`, na entrada do plugin em `capture/.claude-plugin/marketplace.json` e no `FORWARDER_VERSION` do `forward.mjs`, que vai no campo `forwarder` do envelope. Um teste unitário confere que as três são iguais. A versão da captura é independente da do servidor (`package.json`), porque a captura é implantada à parte (`npm run capture:deploy`).
- **Quando subir:** toda mudança de comportamento em `capture/` sobe a versão.
  - Patch para correção ou mudança compatível; por exemplo, o teto do corpo leva a `0.1.1`.
  - Minor para hook novo ou campo novo e opcional no envelope.
  - Major quando o envelope mudar de `v`.
  - Mudança só de texto ou de teste não sobe.
- **Quem sobe:** o dev que muda `capture/`, no mesmo commit. O tester confere o teste das três versões, e o documentador registra a versão no `CHANGELOG.md`.
- **Para que serve:** um plugin de marketplace local é carregado direto da pasta, qualquer que seja a versão declarada (fonte: plugins/loading, "loads its current source files at every session start, whatever its version string says"). Por isso a versão não controla atualização: ela serve para identificar, nos dumps e no servidor, qual encaminhador mandou cada envelope, e para o orquestrador avisar o usuário de que há um deploy novo a fazer.
