# Sonda do T0

Ferramenta descartável para validar na prática os itens V1 a V14 de `docs/arquitetura/modelo-de-eventos.md` (seção 11), como pede o T0 de `docs/plano/v1.md`.

- `plugin/`: plugin `agent-quest-probe`. Registra 18 hooks (`command`, forma exec, `async: true`, sem `matcher`) que chamam `scripts/dump.mjs`, e o subagente `probe-worker`.
- `plugin/scripts/dump.mjs`: grava cada payload bruto em `%LOCALAPPDATA%\agent-quest\probe\events.jsonl` (ou em `<AGENT_QUEST_HOME>\probe\`). Nunca imprime nada e sempre sai com código 0.
- `report.mjs`: dá o veredito de V1 a V14 e mede tamanhos, ordem e tempos, sem mostrar conteúdo nem a pasta pessoal.
- `sanitize.mjs`: gera os cenários de `test/fixtures/hooks/*.json` a partir do JSONL bruto (formato e regras no ADR 0010). A redação de segredos é a de `server/domain/redact.js`, a mesma do normalizador.
  - Nos textos mantidos, ela troca segredos por `•••` e tira caracteres invisíveis, caracteres de controle (a quebra de linha fica, e o tab vira espaço) e sequências ANSI de terminal (cores, títulos e links). Um segredo colorido é redigido inteiro.
  - Como no normalizador, cada texto mantido é redigido só nos primeiros 8192 caracteres, para um texto enorme não custar segundos. O resto não entra no cenário.
  - Das saídas, ficam só as linhas de resumo dos testes; dos erros, a primeira linha e as linhas de resumo. O resumo é reconhecido no texto sem cores, então os resumos coloridos do `node --test`, do Playwright, do Jest e do Vitest também ficam, já sem as cores.

> **Atenção:** o `events.jsonl` guarda os payloads completos (conteúdo de arquivos, saídas, pedidos). Ele fica só em `%LOCALAPPDATA%\agent-quest\probe\`, fora do repositório e do OneDrive, e é apagado depois de gerar os cenários.

Nada é instalado: a sonda só vale nas sessões abertas com `--plugin-dir` ou com a variável `CLAUDE_CODE_PLUGIN_DIRS`. Quem roda as sessões é o usuário.

## Roteiro da sessão de teste (cerca de 30 minutos)

Todos os comandos são para o PowerShell, rodados na raiz do repositório (a pasta onde está o `CLAUDE.md`). Cada bloco usa caminhos completos, então pode ser colado em qualquer PowerShell aberto nessa pasta.

### 1. Antes: preparar a pasta e registrar os hashes da configuração

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\agent-quest\probe" | Out-Null
$files = @("$HOME\.claude\settings.json") + @(Get-ChildItem -Path .claude -Filter 'settings*.json' -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
$files | ForEach-Object { if (Test-Path $_) { "$((Get-FileHash $_ -Algorithm SHA256).Hash)  $_" } else { "AUSENTE  $_" } } | Set-Content "$env:LOCALAPPDATA\agent-quest\probe\hashes-antes.txt"
Get-Content "$env:LOCALAPPDATA\agent-quest\probe\hashes-antes.txt"
```

### 2. Abrir a sessão do terminal com a sonda

Use um terminal comum (Windows Terminal ou PowerShell), fora do VS Code. Opcional, antes: `claude plugin validate tools\probe\plugin` confere o formato do plugin (só lê os arquivos).

```powershell
claude --plugin-dir "$PWD\tools\probe\plugin" --debug-file "$env:LOCALAPPDATA\agent-quest\probe\debug.txt"
```

Opcional: `/hooks` deve listar os 18 eventos da sonda, e `/agents` deve mostrar o `probe-worker`.

Durante a sessão:

- Fique no modo de permissão padrão (não use Shift+Tab para aceitar tudo).
- Quando pedir aprovação, **espere uns 10 segundos antes de responder** (para disparar o aviso `permission_prompt`) e aprove com **"Yes"** (só desta vez). Nunca escolha "don't ask again": isso grava em `.claude/settings.local.json` e quebra a comparação de hashes.
- **Esc na janela de aprovação é negação, não interrupção.** Para negar, use "No". Para interromper (pedidos 10 e 10a), aprove primeiro e só aperte Esc depois que o comando começar a rodar.
- Comandos simples, como `node -e`, também podem pedir aprovação. Aprove todos, exceto os que o roteiro manda negar.
- Espere cada pedido terminar antes de mandar o próximo.
- Repare se aparece algum aviso `hook error` na tela ou se alguma janela de console pisca. Anote para o V10.

### 3. Pedidos, nesta ordem

1. `Leia o CLAUDE.md e rode node -e "console.log(1)".`
2. `Rode node -e "process.exit(3)".` (saída diferente de zero)
3. `Crie tmp-probe/a.test.mjs com um teste do node:test que falha, rode node --test tmp-probe, corrija o teste e rode de novo.`
4. Aprovação aceita e negada na sessão principal:
   - `Rode node -e "require('fs').writeFileSync('tmp-probe/x.txt','1')"` e **aprove**;
   - `Rode node -e "require('fs').writeFileSync('tmp-probe/y.txt','2')"` e **negue** ("No").
5. `Use o probe-worker duas vezes em paralelo: um lê o CLAUDE.md e o outro roda node -e "console.log(2)".`
6. `Peça ao probe-worker para rodar node -e "require('fs').writeFileSync('tmp-probe/z.txt','3')".` (aprove)
   - 6a. `Peça ao probe-worker para rodar node -e "process.exit(4)".` (aprove; falha dentro de subagente, V1 e V3)
   - 6b. `Peça ao probe-worker para rodar node -e "require('fs').writeFileSync('tmp-probe/w.txt','4')".` (**negue** com "No"; aprovação negada dentro de subagente, V2 e V4)
7. `Rode o probe-worker em segundo plano para executar node -e "setTimeout(()=>console.log('fim'),15000)" e me avise quando terminar.` Aprove se pedir e espere o aviso de que terminou, sem mandar outro pedido antes.
8. `Peça ao probe-worker que delegue a outro probe-worker a leitura do CLAUDE.md.` (subagente aninhado)
9. `Peça ao documentador só para ler o CLAUDE.md e responder OK, sem alterar nada.` (tipo de agente do projeto)
10. `Rode node -e "setTimeout(()=>{},30000)"`: aprove e, uns 5 segundos depois de o comando começar, aperte **Esc**.
    - 10a. `Peça ao probe-worker para rodar node -e "setTimeout(()=>{},30000)"`: aprove e aperte **Esc** enquanto o comando roda (SubagentStop de subagente interrompido, V12).
11. `/compact`, depois `/clear`, depois `/exit`.

### 4. VS Code (obrigatório)

A captura vai rodar também nas sessões da extensão, então o V10 precisa ser confirmado lá antes do G0a: o relatório só confirma o V10 com uma sessão do terminal e uma do VS Code. Nada de configuração muda: a sonda entra pela variável `CLAUDE_CODE_PLUGIN_DIRS`, só neste PowerShell.

**Não feche o VS Code principal** (é onde o orquestrador roda). A sonda vai numa instância separada:

1. Num PowerShell na raiz do repositório:

   ```powershell
   $env:CLAUDE_CODE_PLUGIN_DIRS = "$PWD\tools\probe\plugin"
   code --user-data-dir "$env:TEMP\aq-vscode-probe" --new-window "$PWD"
   ```

   Com `--user-data-dir`, o VS Code abre como outro processo, que herda a variável deste PowerShell, sem tocar na janela principal. As extensões continuam vindo da pasta padrão; só as configurações da janela começam vazias.

   Como a pasta de dados é nova, a janela vai perguntar se você confia nos autores dos arquivos da pasta. **Aceite** ("Yes, I trust the authors"): em pasta sem confiança, o Claude Code pode segurar os hooks e a sonda não grava nada. Se o Claude Code pedir de novo para confiar na pasta, aceite também.
2. Nessa janela nova, abra o Claude Code numa conversa nova e repita os pedidos 1, 2 e 5, com as mesmas regras de aprovação, observando se aparece aviso `hook error` ou se alguma janela de console pisca.
3. No fim, feche só essa janela, limpe a variável e apague a pasta temporária:

   ```powershell
   Remove-Item Env:CLAUDE_CODE_PLUGIN_DIRS
   Remove-Item -Recurse -Force "$env:TEMP\aq-vscode-probe"
   ```

No VS Code não há log de depuração. Se os eventos dessa conversa não aparecerem no relatório (o subitem "sessão do VS Code com eventos" do V10 fica sem dados), a variável não chegou à extensão: registre como inconclusivo e combine outra forma com o arquiteto antes do G0a.

### 5. Depois: limpar, conferir os hashes e gerar o relatório

```powershell
Remove-Item -Recurse -Force tmp-probe -ErrorAction SilentlyContinue
$files = @("$HOME\.claude\settings.json") + @(Get-ChildItem -Path .claude -Filter 'settings*.json' -File -ErrorAction SilentlyContinue | ForEach-Object FullName)
$files | ForEach-Object { if (Test-Path $_) { "$((Get-FileHash $_ -Algorithm SHA256).Hash)  $_" } else { "AUSENTE  $_" } } | Set-Content "$env:LOCALAPPDATA\agent-quest\probe\hashes-depois.txt"
Compare-Object (Get-Content "$env:LOCALAPPDATA\agent-quest\probe\hashes-antes.txt") (Get-Content "$env:LOCALAPPDATA\agent-quest\probe\hashes-depois.txt")
node tools/probe/report.mjs
```

O `Compare-Object` não deve imprimir nada (hashes iguais).

O relatório lê `events.jsonl` e `debug.txt` da pasta da sonda. Opções úteis: `--json` (saída em JSON) e `--debug-samples 10` (mostra linhas reconhecidas no log, para conferir o formato; podem ter conteúdo). O V10 exige um "moved to the background" no log para cada execução gravada no terminal (com folga de 5%) e as duas sessões; a confirmação visual do usuário (sem aviso e sem janela piscando) fica registrada à parte.

## Gerar os cenários sanitizados

Feito pelo dev-backend com o orquestrador, depois da sessão:

```powershell
node tools/probe/sanitize.mjs --list
node tools/probe/sanitize.mjs --name basico --description "Lê o CLAUDE.md e roda um comando aprovado" --lines <primeira>-<última>
node tools/probe/sanitize.mjs --name comando-com-falha --description "Comando com saída 3" --prompts <n>
```

- `--list` mostra cada sessão e cada pedido com a faixa de linhas e os eventos do trecho. Use `--lines` (faixas de linhas da lista, útil para incluir o SessionStart no cenário básico) ou `--prompts` (faixa de pedidos da lista, por exemplo `2` ou `7-8`). O retorno do segundo plano aparece como um pedido `<...>`: inclua-o no cenário do pedido 7. Os números dos pedidos na lista contam também os subpedidos (6a, 6b, 10a) e os retornos, então confira antes de escolher.
- Cenários esperados: `basico`, `comando-com-falha`, `comando-com-falha-subagente`, `teste-falha-depois-passa`, `aprovacao-principal`, `aprovacao-subagente`, `paralelo-mesmo-tipo`, `segundo-plano`, `aninhado`, `agente-do-projeto`, `interrupcao-esc`, `interrupcao-esc-subagente`, `compactacao-e-clear`.
- Os ids reais (sessão, pedido, ferramenta, agente e chaves afins, como `sessionId`) viram ids sintéticos com a mesma forma, inclusive dentro de caminhos e das tags das notificações. O mesmo id real vira sempre o mesmo id sintético, também entre cenários.
- Cada cenário passa por uma conferência antes de ser gravado, em valores e em chaves: possível segredo, string longa, nome do usuário (também codificado para URL) ou id original. Se ela reclamar, nada é gravado. `--ignore-audit` só com revisão do orquestrador, e o tester confere o cenário de novo.
- Para conferir, rode o relatório sobre os cenários: `node tools/probe/report.mjs test/fixtures/hooks`. Os vereditos devem bater com os do JSONL bruto, exceto o V10, que depende do log (`--debug`).

Por fim, apague os dados brutos, salvo se o usuário decidir mantê-los:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agent-quest\probe"
```
