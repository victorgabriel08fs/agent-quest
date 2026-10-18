# Iniciar e parar o servidor

O servidor do Agent Quest roda na sua máquina. Ele recebe os eventos que a captura envia do Claude Code e serve o painel no navegador, sempre em `http://127.0.0.1`. Este guia mostra como iniciar, configurar e parar o servidor, e o que fazer com as mensagens mais comuns.

> Este guia descreve o servidor como ele está agora, na fundação da v1. Os trechos marcados com "nesta fase" mudam nas próximas entregas. Ligar a captura no Claude Code e ler o painel vão ter guias próprios.

## Resumo rápido

| Quero... | Comando |
|---|---|
| Iniciar o servidor | `npm start` |
| Iniciar com reinício automático ao mudar o código | `npm run dev` |
| Usar outra porta | `npm start -- --port 47900` |
| Parar | Ctrl+C na janela do servidor |
| Conferir se está no ar | abrir `http://127.0.0.1:47821/api/health` |

## Antes de começar

- **Node 24 ou mais novo.** Confira com `node --version`.
- **Nada para instalar.** O servidor não tem dependências, então não é preciso rodar `npm install` para usá-lo. Basta ter o repositório na máquina.
- Os comandos deste guia rodam na raiz do repositório, a pasta onde está o `package.json`. Os exemplos são para o PowerShell; quando o Git Bash é diferente, o comando dele aparece junto.

## Iniciar

### `npm start`

```powershell
npm start
```

Se tudo der certo, o terminal mostra:

```text
Agent Quest 0.1.0 rodando em http://127.0.0.1:47821/
Diretório de dados: C:\Users\<usuario>\AppData\Local\agent-quest
Ctrl+C para parar.
```

Abra o endereço no navegador. O servidor fica no ar enquanto esse terminal estiver aberto: deixe-o aberto (pode minimizar) e use outro terminal para o resto.

Nesta fase, o painel ainda não mostra sessões ao vivo. A ligação entre captura, servidor e painel chega nas próximas tarefas do [plano da v1](../plano/v1.md).

Se houver algum aviso (linha que começa com "Aviso:"), ele aparece antes dessas três linhas. Aviso não impede o servidor de subir; veja [Mensagens comuns](#mensagens-comuns).

### `npm run dev`: reinício automático

```powershell
npm run dev
```

Faz o mesmo que o `npm start`, mas pelo `node --watch`, um recurso do próprio Node (não é dependência). Quando você salva um arquivo de código do servidor (em `server/`), o Node mostra uma linha `Restarting ...`, encerra o servidor e sobe outro na mesma porta, com um `runtime.json` novo.

Bom saber:

- **Arquivos do painel** (`web/`) não reiniciam o servidor, e nem precisam: eles são lidos do disco a cada pedido e saem com `Cache-Control: no-cache`. Basta apertar F5 no navegador.
- **O `config.json` e as variáveis de ambiente** são lidos só no início. Mudou algum deles? Pare e inicie de novo.
- **Cada reinício começa do zero.** O que o servidor sabe fica só na memória, então os contadores do [`/api/health`](#conferir-o-servidor-com-apihealth) voltam a zero ([ADR 0005](../adr/0005-estado-em-memoria.md)).
- **Quando o servidor sai sozinho** (porta ocupada, porta inválida, "já está rodando"), o `node --watch` não devolve o prompt: ele fica esperando alguma mudança de arquivo. Aperte Ctrl+C para sair.
- **No Windows, parar o `npm run dev` pode deixar um `runtime.json` para trás.** É inofensivo; veja [Exceção do `npm run dev` no Windows](#exceção-do-npm-run-dev-no-windows).

### Escolher a porta

A porta padrão é 47821. Há três jeitos de trocar. Se mais de um estiver definido, vale o primeiro da lista:

| Prioridade | Fonte | Exemplo |
|---|---|---|
| 1 | Opção `--port` | `npm start -- --port 47900` |
| 2 | Variável de ambiente `AGENT_QUEST_PORT` | `$env:AGENT_QUEST_PORT = "47900"; npm start` |
| 3 | Chave `port` do [`config.json`](#o-arquivo-configjson) | `{ "port": 47900 }` |
| — | Padrão | 47821 |

A porta precisa ser um número inteiro de 1024 a 65535, que é a faixa em que a captura aceita enviar. O valor 0 pede ao sistema uma porta livre qualquer, e o endereço muda a cada início (é o que os testes automáticos usam). Qualquer outro valor faz o servidor sair com erro, sem subir.

- **O `--` é obrigatório no npm.** Ele separa as opções do npm das opções do servidor. Sem ele (`npm start --port 47900`), o npm fica com a opção e o servidor sobe na porta padrão. Vale também para `npm run dev -- --port 47900`.
- **No PowerShell**, a variável vale até você fechar o terminal. Para voltar ao padrão antes disso: `Remove-Item Env:AGENT_QUEST_PORT`.
- **No Git Bash**, defina a variável na mesma linha do comando:

  ```bash
  AGENT_QUEST_PORT=47900 npm start
  ```

- **A captura encontra a porta sozinha**, pelo [`runtime.json`](#o-runtimejson). Trocar a porta não exige mudar nada no Claude Code.

### O arquivo `config.json`

É opcional. Fica no diretório de dados (`%LOCALAPPDATA%\agent-quest\config.json`) e serve para deixar a porta definida de vez:

```json
{ "port": 47900 }
```

Para criá-lo pelo PowerShell (a pasta já existe depois do primeiro `npm start`):

```powershell
Set-Content -Path "$env:LOCALAPPDATA\agent-quest\config.json" -Value '{ "port": 47900 }'
```

- Nesta fase, só a chave `port` tem efeito.
- O arquivo é lido só no início do servidor.
- Se o arquivo não puder ser lido ou não for um objeto JSON válido, o servidor avisa no terminal, ignora o arquivo e segue com o padrão. Se a porta dentro dele for inválida, o servidor não sobe e mostra o erro com o caminho do arquivo.

### Gravar os eventos recebidos (`--debug-dump`)

> **Atenção: dados sensíveis.** Com esta opção, o servidor grava em disco os eventos como chegam da captura: trechos de código, comandos, saídas, caminhos, pedidos e possíveis segredos, sem nenhuma redação. Use só para investigar um problema e apague os arquivos depois.

```powershell
npm start -- --debug-dump
```

- Os eventos vão para `%LOCALAPPDATA%\agent-quest\dumps\AAAA-MM-DD.jsonl`: um arquivo por dia (data local) e um evento por linha. Só entram os eventos aceitos, ou seja, válidos e não repetidos.
- No início, o servidor mostra um aviso com o caminho da pasta.
- Sem a opção, nada é gravado e a pasta `dumps` nem é criada. Essa é a única exceção à regra de não guardar eventos em disco ([ADR 0005](../adr/0005-estado-em-memoria.md)).
- Se a gravação falhar (disco cheio, por exemplo), o terminal mostra "Erro ao gravar o --debug-dump; a gravação parou", e o servidor continua recebendo os eventos normalmente.
- Para apagar os arquivos, com o servidor parado:

  ```powershell
  Remove-Item -Recurse "$env:LOCALAPPDATA\agent-quest\dumps"
  ```

## Onde ficam os dados

O diretório de dados é `%LOCALAPPDATA%\agent-quest\`. Ele fica fora do OneDrive de propósito: ali há um token que não deve ser sincronizado com a nuvem. No uso normal, é sempre esta pasta; a variável `AGENT_QUEST_HOME`, que troca o diretório, serve para isolar testes e desenvolvimento (veja [Usar outra pasta](#usar-outra-pasta-agent_quest_home)). Para abrir a pasta:

```powershell
explorer "$env:LOCALAPPDATA\agent-quest"
```

Em Linux e macOS, a pasta é `$XDG_STATE_HOME/agent-quest` ou, sem essa variável, `~/.local/state/agent-quest` (o projeto é testado no Windows).

| Item | O que é | Quem cria |
|---|---|---|
| `runtime.json` | Como a captura encontra o servidor (veja abaixo) | O servidor, a cada início; é apagado ao parar |
| `config.json` | Configuração opcional (porta) | Você |
| `marketplace\` | Cópia do plugin de captura, pronta para instalar | `npm run capture:deploy` |
| `dumps\` | Eventos gravados com `--debug-dump` | O servidor, só com a opção |

O estado das sessões fica só na memória do servidor. Fora o `--debug-dump`, nenhum evento vai para o disco.

### O `runtime.json`

O servidor grava este arquivo ao iniciar e o apaga ao parar. O encaminhador da captura, que roda a cada evento do Claude Code, lê o arquivo para saber se há servidor no ar, em que porta e com qual token. Sem o arquivo, ou se o `pid` for de um processo que já terminou, o encaminhador sai na hora, sem enviar nada e sem atrasar o Claude Code.

```json
{
  "port": 47821,
  "token": "<43 caracteres aleatórios>",
  "pid": 12345,
  "version": "0.1.0",
  "startedAt": 1760731234567
}
```

- `port`: a porta em uso de verdade (se você pediu 0, aqui aparece a porta que o sistema escolheu).
- `token`: segredo gerado a cada início (32 bytes aleatórios em base64url). Só quem tem o token consegue enviar eventos ao servidor. Não compartilhe este arquivo.
- `pid`: o número do processo do servidor.
- `version` e `startedAt`: a versão do Agent Quest e a hora do início, em milissegundos desde 1970.

Não edite o arquivo. Ele é gravado de forma atômica (primeiro num arquivo temporário, depois renomeado), para a captura nunca ler um arquivo pela metade.

### Usar outra pasta (`AGENT_QUEST_HOME`)

A variável `AGENT_QUEST_HOME` troca o diretório de dados inteiro (a pasta é criada se não existir). **No uso normal, não defina essa variável.** O diretório padrão já fica fora do OneDrive e funciona sem nenhum ajuste.

O motivo: o servidor, o `npm run capture:deploy` e o encaminhador da captura procuram o diretório de dados cada um com o próprio ambiente. O encaminhador roda dentro do Claude Code e enxerga as variáveis do Claude Code, não as do terminal do servidor. Se `AGENT_QUEST_HOME` estiver definida só no terminal do servidor, a captura procura o `runtime.json` em `%LOCALAPPDATA%\agent-quest\`, não encontra e sai em silêncio: parece desligada, sem nenhum erro ([ADR 0005](../adr/0005-estado-em-memoria.md), complemento "`AGENT_QUEST_HOME` dos dois lados").

Por isso, sempre que a variável está definida, o servidor avisa ao iniciar:

```text
Aviso: AGENT_QUEST_HOME está definida (<diretório>). A captura só encontra este servidor se o Claude Code tiver a mesma variável, com o mesmo valor, no ambiente dele (terminal e VS Code). No uso normal, deixe AGENT_QUEST_HOME sem valor.
```

Quando faz sentido usar:

- **Para isolar testes e desenvolvimento**, sem o Claude Code no meio. Defina a variável só no terminal, com uma pasta temporária, e use também outra porta, porque a 47821 é a do servidor de uso normal:

  ```powershell
  $env:AGENT_QUEST_HOME = "$env:TEMP\agent-quest-teste"; npm start -- --port 0
  ```

  Ao terminar, limpe a variável desse terminal com `Remove-Item Env:AGENT_QUEST_HOME`. Os testes automáticos fazem o mesmo, com pasta temporária e porta livre, para nunca mexer no servidor de verdade.

- **Se você precisar mesmo de outro diretório no dia a dia** (por exemplo, porque o seu `%LOCALAPPDATA%` fica dentro do OneDrive), a variável tem de valer igual para o servidor, para o `npm run capture:deploy` e para o Claude Code, no terminal e no VS Code:
  1. No menu Iniciar, procure "Editar as variáveis de ambiente para sua conta" e crie `AGENT_QUEST_HOME` nas variáveis de usuário, com uma pasta fora do OneDrive.
  2. Feche e abra de novo todos os terminais e o VS Code, e reabra as sessões do Claude Code. O que já estava aberto continua com o ambiente antigo.

  Para voltar ao padrão, apague a variável na mesma janela e reabra tudo de novo.

Se o diretório de dados ficar dentro do OneDrive, o servidor avisa no início e sobe assim mesmo; veja o que fazer em [Mensagens comuns](#mensagens-comuns).

## Parar o servidor

### Ctrl+C

Na janela onde o servidor está rodando, aperte **Ctrl+C**. O terminal mostra `Encerrando o Agent Quest...`, o servidor apaga o `runtime.json` e sai. A partir daí, a captura deixa de enviar eventos, em silêncio, sem atrapalhar o Claude Code.

Se você apertar Ctrl+C de novo enquanto ele encerra, o processo sai na hora.

O que aparece depois depende do terminal:

- **PowerShell:** depois do Ctrl+C, o npm termina com código de saída 1 (`$LASTEXITCODE` mostra 1). É esperado e não indica erro: o servidor em si saiu com 0 e apagou o `runtime.json`.
- **Prompt de Comando (cmd):** o cmd pergunta `Deseja finalizar o arquivo em lotes (S/N)?`, porque no cmd o `npm` é um arquivo em lotes (`npm.cmd`). Responda `S` e Enter. Tanto faz a resposta: nessa hora o servidor já parou.
- **Git Bash:** aperte Ctrl+C na própria janela do servidor. Não use `kill` a partir de outro terminal: ele não passa pelo encerramento normal, e o servidor pode sair sem apagar o `runtime.json`. O mesmo vale para encerrar o processo pelo Gerenciador de Tarefas ou com `taskkill /F`.

Fechar a janela do terminal também encerra o servidor. Se o `runtime.json` ficar para trás, veja [Sobrou um `runtime.json`?](#sobrou-um-runtimejson).

### Exceção do `npm run dev` no Windows

No Windows, o vigia do `node --watch` encerra o servidor à força, tanto no Ctrl+C quanto a cada reinício automático, antes que o servidor consiga fazer a limpeza. Por isso, depois de um `npm run dev`, o `runtime.json` pode continuar na pasta com o `pid` de um processo que já terminou.

Isso é esperado e inofensivo:

- a captura vê que o `pid` não existe mais e sai sem enviar nada;
- o próximo `npm start` ou `npm run dev` substitui o arquivo, sem a mensagem "já está rodando".

Com o `npm start`, o Ctrl+C apaga o arquivo normalmente.

### Sobrou um `runtime.json`?

Um `runtime.json` com o `pid` de um processo que já terminou é sempre tratado como sobra: a captura o ignora, e o próximo início o substitui. Não é preciso fazer nada.

Para saber se há um servidor no ar, abra `http://127.0.0.1:47821/api/health` (ou a porta que você usa): se responder, há. Outro jeito é rodar `npm start`: se já houver um servidor, ele avisa "já está rodando" e sai sem mexer em nada. Se quiser apagar a sobra à mão, faça isso só com o servidor parado.

## Mensagens comuns

### "O Agent Quest já está rodando em http://127.0.0.1:47821/"

Já existe um servidor do Agent Quest no ar. O novo início sai com código 0 e não mexe nele: basta abrir o endereço mostrado. Acontece quando:

- o `runtime.json` aponta para um servidor que está rodando, mesmo que você tenha pedido outra porta (só roda um servidor por diretório de dados); ou
- a porta pedida já está com outro servidor do Agent Quest (de outro diretório de dados, por exemplo).

Para trocar a porta, pare o servidor atual (Ctrl+C na janela dele) e inicie de novo com a porta nova.

### "A porta 47821 já está em uso por outro programa."

```text
A porta 47821 já está em uso por outro programa.
Escolha outra porta: npm start -- --port <número> (ou AGENT_QUEST_PORT, ou "port" no config.json do diretório de dados).
```

Um programa que não é o Agent Quest ocupa a porta. O servidor não sobe e sai com código 1. Escolha outra porta com `--port`, `AGENT_QUEST_PORT` ou `config.json` (veja [Escolher a porta](#escolher-a-porta)).

O comando sugerido na segunda linha acompanha o jeito como você iniciou o servidor:

| Iniciou com | Sugestão |
|---|---|
| `npm start` | `npm start -- --port <número>` |
| `npm run dev` | `npm run dev -- --port <número>` |
| `node server/main.js`, direto pelo Node | `node server/main.js --port <número>` |

Para descobrir qual programa está na porta, no PowerShell:

```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 47821 -State Listen).OwningProcess
```

### "Sem permissão para usar a porta ..."

```text
Sem permissão para usar a porta 47821 (o Windows reserva algumas faixas).
Escolha outra porta: npm start -- --port <número>.
```

O Windows reserva algumas faixas de portas (por exemplo, para o Hyper-V ou o WSL), e a porta escolhida caiu numa delas. O servidor sai com código 1. Escolha outra porta; o comando sugerido segue o modo em uso, como na mensagem anterior. Para ver as faixas reservadas:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

### "Porta inválida em ..."

Exemplo:

```text
Porta inválida em --port: "80". Use um número inteiro de 1024 a 65535 (ou 0 para uma porta livre qualquer).
```

A mensagem diz de onde veio o valor: `--port`, `AGENT_QUEST_PORT` ou o caminho do `config.json`. Portas de 1 a 1023, acima de 65535 ou que não sejam número inteiro são recusadas, e o servidor sai com código 1 sem subir. Corrija o valor na fonte indicada. Se a fonte for `AGENT_QUEST_PORT`, a variável pode ter ficado definida no terminal: `Remove-Item Env:AGENT_QUEST_PORT`.

### "Aviso: AGENT_QUEST_HOME está definida (...)"

```text
Aviso: AGENT_QUEST_HOME está definida (<diretório>). A captura só encontra este servidor se o Claude Code tiver a mesma variável, com o mesmo valor, no ambiente dele (terminal e VS Code). No uso normal, deixe AGENT_QUEST_HOME sem valor.
```

O servidor está usando o diretório da variável, e não o padrão. O aviso aparece sempre que a variável está definida, mesmo quando está tudo certo.

- **Se você não definiu a variável de propósito**, remova-a e inicie de novo. No terminal atual: `Remove-Item Env:AGENT_QUEST_HOME` (no Git Bash, `unset AGENT_QUEST_HOME`). Confira também se ela não está nas variáveis da sua conta do Windows (veja [Nenhum evento chegando](#nenhum-evento-chegando)).
- **Se você está isolando um teste**, o aviso é esperado: nesse caso, a captura não deve mesmo encontrar este servidor.
- **Se você precisa de outro diretório no dia a dia**, confira se o Claude Code tem a mesma variável, com o mesmo valor (veja [Usar outra pasta](#usar-outra-pasta-agent_quest_home)).

### "Aviso: a pasta de dados (...) está dentro do OneDrive."

```text
Aviso: a pasta de dados (<diretório>) está dentro do OneDrive. O runtime.json guarda o token da execução e seria sincronizado com a nuvem. Para usar outra pasta, defina AGENT_QUEST_HOME como variável de ambiente do usuário do Windows e reabra os terminais e o VS Code, porque o Claude Code precisa ver o mesmo valor.
```

O servidor sobe assim mesmo, mas resolva:

- **Se apareceu também o aviso "AGENT_QUEST_HOME está definida"**, é a variável que aponta para dentro do OneDrive. Remova a variável (o padrão já fica fora do OneDrive) ou troque o valor por uma pasta fora dele, nos dois lados.
- **Se a variável não está definida**, é o próprio `%LOCALAPPDATA%` que está dentro do OneDrive. Defina `AGENT_QUEST_HOME` como variável de ambiente do usuário do Windows, com uma pasta fora do OneDrive, e reabra os terminais, o VS Code e as sessões do Claude Code, para todos verem o mesmo valor. O passo a passo está em [Usar outra pasta](#usar-outra-pasta-agent_quest_home). Defina a variável nas variáveis da sua conta, e não só no terminal: senão a captura não encontra o servidor.

O aviso aparece quando o caminho fica dentro da pasta indicada pelas variáveis do OneDrive no Windows, ou quando tem uma pasta chamada "OneDrive" ou "OneDrive - <organização>".

### Outras mensagens

- **"Argumentos inválidos: ..."**, seguida da linha de uso: opção desconhecida. O servidor aceita só `--port <número>` e `--debug-dump`. Sai com código 1.
- **"Aviso: ... config.json não é um objeto JSON válido; o arquivo foi ignorado."** (ou "não foi possível ler"): corrija o arquivo. Até lá, vale o padrão.
- **"Aviso: "roles" no config.json não é um objeto; foi ignorado."**: a chave `roles` está com formato errado. Ela ainda não tem efeito nesta fase; corrija ou remova a chave.
- **"Não foi possível gravar o runtime.json em ..."**: o diretório de dados não pôde ser criado ou gravado, por exemplo com `AGENT_QUEST_HOME` apontando para um lugar sem permissão. Sai com código 1.
- **O PowerShell recusa o `npm`** dizendo que a execução de scripts está desabilitada: use `npm.cmd` no lugar de `npm` (por exemplo, `npm.cmd start`). Nesse caso, o Ctrl+C também mostra a pergunta do cmd, `Deseja finalizar o arquivo em lotes (S/N)?`.

### Códigos de saída do servidor

| Código | Quando |
|---|---|
| 0 | Encerrado com Ctrl+C, ou "já está rodando" |
| 1 | Erro no início: porta inválida, ocupada ou sem permissão, argumento inválido ou `runtime.json` que não pôde ser gravado |

No PowerShell, depois do Ctrl+C, o npm devolve 1 mesmo com o servidor tendo saído com 0 (veja [Parar o servidor](#parar-o-servidor)).

## Conferir o servidor com `/api/health`

Abra `http://127.0.0.1:47821/api/health` no navegador ou, pelo terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:47821/api/health | ConvertTo-Json
```

```bash
# Git Bash
curl -s http://127.0.0.1:47821/api/health
```

Exemplo de resposta:

```json
{
  "ok": true,
  "version": "0.1.0",
  "startedAt": 1760731234567,
  "events": { "received": 42, "accepted": 40, "rejected": 0, "deduped": 2, "dropped": 0, "ignored": 0 },
  "lastEventAt": 1760731299000,
  "sessions": 0,
  "clients": 0
}
```

A resposta nunca traz conteúdo de evento: só contagens e horários.

| Campo | O que significa |
|---|---|
| `ok` | Sempre `true` quando o servidor responde. |
| `version` | Versão do Agent Quest (a do `package.json`). |
| `startedAt` | Hora em que o servidor iniciou, em milissegundos desde 1970. Muda a cada reinício. |
| `events.received` | Envios da captura que chegaram ao servidor (`POST /hooks`). Não conta pedidos com endereço (`Host`) inválido nem com outro método. |
| `events.accepted` | Eventos aceitos e colocados na fila de processamento. |
| `events.deduped` | Eventos repetidos: o mesmo conteúdo chegou de novo em até 5 segundos (por exemplo, com o plugin carregado duas vezes). Recebem resposta de sucesso, mas são descartados. |
| `events.rejected` | Envios recusados: sem o token certo, vindos de um navegador, com tipo de conteúdo diferente de JSON, acima de 1 MiB, com envelope inválido ou com a conexão interrompida no meio. |
| `events.dropped` | Eventos aceitos e depois descartados porque a fila passou de 10 000 itens (sai sempre o mais antigo). |
| `events.ignored` | Eventos aceitos que não geraram nada no processamento ou deram erro nele. |
| `lastEventAt` | Hora do último envio respondido com sucesso, repetido ou não, em milissegundos desde 1970; `null` se nada chegou desde o início. |
| `sessions` | Sessões guardadas em memória. Nesta fase, fica em 0. |
| `clients` | Painéis conectados ao vivo. Nesta fase, fica em 0. |

As contas sempre fecham assim:

- `received = accepted + deduped + rejected`;
- `dropped` e `ignored` são parte de `accepted`.

Como ler os números:

- **Captura funcionando:** `received` e `lastEventAt` mudam a cada ação no Claude Code.
- **`rejected` subindo:** algo está mandando pedidos que o servidor recusa. A captura normal quase nunca gera recusas.
- **`dropped` acima de 0:** chegou uma rajada maior do que a fila aguenta, e os eventos mais antigos dela se perderam.
- **`ignored`:** nesta fase, fica em 0, porque o servidor ainda só conta os eventos; o processamento chega nas próximas entregas.

A forma completa dessa resposta está na seção 9 do [modelo de eventos](../arquitetura/modelo-de-eventos.md).

## Solução de problemas

### Nenhum evento chegando

Você usa o Claude Code, mas o `received` do `/api/health` não sobe e o `lastEventAt` fica `null` (ou parado). A captura nunca mostra erro no Claude Code, então é preciso conferir por partes, nesta ordem:

1. **O servidor está no ar?** Abra `http://127.0.0.1:47821/api/health` (ou a porta que você usa). Se não responder, inicie o servidor.
2. **`AGENT_QUEST_HOME` é a mesma dos dois lados?** É a causa mais comum, porque a captura falha em silêncio quando o servidor e o Claude Code olham para diretórios de dados diferentes.
   - **Lado do servidor:** no início do servidor, veja a linha `Diretório de dados:` e se apareceu o aviso "AGENT_QUEST_HOME está definida".
   - **Lado do Claude Code:** ele herda as variáveis do terminal ou do VS Code em que foi aberto. Para ver o valor definido na sua conta do Windows, que vale para tudo o que for aberto depois:

     ```powershell
     [Environment]::GetEnvironmentVariable('AGENT_QUEST_HOME', 'User')
     ```

     Sem resposta, a variável não está definida na conta. Se você abriu o Claude Code a partir de um terminal, confira também esse terminal com `$env:AGENT_QUEST_HOME` (no Git Bash, `echo "$AGENT_QUEST_HOME"`).
   - **Os dois lados batem** quando a variável não está definida em lugar nenhum (o caso normal) ou quando tem o mesmo valor no servidor e no Claude Code.
   - **Se só o servidor tem a variável:** pare o servidor, rode `Remove-Item Env:AGENT_QUEST_HOME` (no Git Bash, `unset AGENT_QUEST_HOME`) e inicie de novo.
   - **Se você acabou de definir ou apagar a variável na conta do Windows:** feche e abra de novo os terminais e o VS Code, e reabra as sessões do Claude Code. Sessões abertas antes da mudança continuam com o valor antigo.
3. **A captura está ligada no Claude Code?** Ela precisa estar instalada e ativa. Ligar, pausar e remover a captura vai ter um guia próprio.
4. **`received` sobe, mas `rejected` sobe junto?** Os envios chegam e são recusados. Anote os números do `/api/health` e reporte o problema.

## Segurança em resumo

Os eventos podem conter código, comandos e segredos. Por isso, o servidor só atende o seu navegador e a captura, na sua máquina ([ADR 0006](../adr/0006-seguranca-do-servidor-local.md)):

- **Só `127.0.0.1`.** O servidor nunca escuta na rede: outros computadores não o alcançam.
- **Só endereços locais.** Todo pedido precisa chegar como `127.0.0.1:<porta>` ou `localhost:<porta>`. Qualquer outro nome, como o nome da máquina, recebe 403 ("Acesso negado."). Isso barra o ataque de DNS rebinding, em que um site faz o próprio domínio apontar para `127.0.0.1`.
- **Outras origens recebem 403.** Se uma página qualquer aberta no navegador tentar ler o painel ou a API, o navegador marca o pedido com a origem dela (cabeçalhos `Origin` e `Sec-Fetch-Site`), e o servidor recusa. No navegador, só são aceitos os pedidos do próprio painel e o endereço digitado na barra. Também não há CORS: nenhuma resposta libera acesso para outros sites, e pedidos `OPTIONS` recebem 405.
- **Só a captura envia eventos.** O `POST /hooks` exige o token do `runtime.json`, que muda a cada início, e recusa qualquer pedido vindo de navegador.
- **Nada da internet.** A página só carrega scripts e estilos do próprio servidor (política de segurança de conteúdo restrita), e o servidor só entrega arquivos das pastas `web/` e `shared/`.
- **Logs sem conteúdo.** O terminal do servidor nunca mostra o corpo, os cabeçalhos nem o caminho dos pedidos.

Risco aceito: programas que rodam com o seu usuário do Windows conseguem ler o token e abrir o painel, do mesmo jeito que já conseguem ler os seus arquivos.

## Para saber mais

- [Visão geral da arquitetura](../arquitetura/visao-geral.md): seções "Como rodar localmente", "Rotas e mapeamento de URL", "Limites e valores padrão" e "Falhas e como o sistema reage".
- [Modelo de eventos](../arquitetura/modelo-de-eventos.md), seção 9: a resposta do `/api/health`.
- [ADR 0005](../adr/0005-estado-em-memoria.md): estado só em memória e diretório de dados fora do OneDrive.
- [ADR 0006](../adr/0006-seguranca-do-servidor-local.md): segurança do servidor local.
- [Plano da v1](../plano/v1.md): tarefa T2, com os critérios de aceite do servidor.
