# ADR 0006: Segurança do servidor local e dos dados dos eventos

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

## Contexto

Os eventos trazem caminhos, comandos, trechos de código, saídas e pedidos do usuário. Ameaças consideradas:

- sites abertos no navegador falando com `127.0.0.1` (CSRF, leitura cruzada, DNS rebinding);
- XSS por conteúdo vindo dos eventos (nome de arquivo, comando, mensagem de erro);
- vazamento por tela compartilhada;
- vazamento por disco ou por sincronização do OneDrive.

## Decisão

### Rede

- `listen(porta, '127.0.0.1')`. Nunca `0.0.0.0` nem `::`. Porta padrão 47821, configurável.
- Em todas as rotas, o cabeçalho `Host` precisa ser `127.0.0.1:<porta>` ou `localhost:<porta>`. Qualquer outro recebe 403 (proteção contra DNS rebinding).
- `POST /hooks` exige:
  - `X-Agent-Quest-Token` igual ao token da execução (32 bytes aleatórios gerados a cada início, comparação em tempo constante);
  - `Content-Type: application/json` (força preflight em navegadores, e o servidor recusa preflight);
  - ausência de `Origin` (navegadores sempre mandam `Origin` em POST; o encaminhador não manda);
  - corpo de até 1 MiB.
- Rotas do painel (`/`, arquivos estáticos, `/api/*`, `/events`): se vier `Origin`, precisa ser a própria origem; se vier `Sec-Fetch-Site`, precisa ser `same-origin` ou `none`.
- Sem CORS: nenhuma resposta tem `Access-Control-Allow-*`, e `OPTIONS` recebe 405.
- Cabeçalhos em toda resposta: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`. API e SSE com `Cache-Control: no-store`.
- Arquivos estáticos só de `web/` e `shared/`, sem listagem de diretório e com bloqueio de travessia de caminho (`..`, codificado ou com barra invertida).

### Dados

- **Minimização no normalizador:** só os campos da lista branca chegam ao estado (`docs/arquitetura/modelo-de-eventos.md`, seção 10). Nunca são guardados conteúdo de arquivo, diff, stdout ou stderr (dos testes, só as contagens), texto do assistente nem o pedido completo.
- **Redação de segredos** em comandos, descrições, pedidos e mensagens de erro: chaves com prefixos conhecidos, `Bearer`, pares `senha=`/`token=`, blocos de chave privada, URL com usuário e senha, variáveis `*_TOKEN=`, `*_KEY=`, `*_SECRET=`.
- **Truncamento:** comando 120 caracteres, título do pedido 80, erro 160, padrão de busca 60.
- **Painel:** todo texto dinâmico entra por `textContent` ou pelos helpers de escape dos temas. O "modo discreto" esconde comandos, caminhos e pedidos, para compartilhar a tela.
- **Disco:** ADR 0005. Os logs do servidor têm só contagens e erros, nunca conteúdo de evento.
- O token fica no `runtime.json`, dentro do perfil do usuário.

## Alternativas consideradas

- **Token também para abrir o painel** (URL com chave trocada por cookie, como no Jupyter). Protege contra outro usuário do Windows logado na mesma máquina. Custa UX e código; adiado, porque a máquina é pessoal.
- **Ingestão sem token.** `Host` e `Origin` já barram navegadores, mas o token fecha o resto da superfície a custo baixo e serve para o encaminhador confirmar que fala com o servidor certo.

## Consequências

- Processos locais do mesmo usuário conseguem ler o token e abrir o painel. Aceito: eles já têm acesso aos mesmos arquivos.
- Em máquina compartilhada entre usuários do Windows, outro usuário logado poderia abrir o painel. Se isso mudar, reabrir a decisão sobre o token do painel.
- A redação é heurística e pode deixar passar um segredo de formato desconhecido. O modo discreto cobre o caso de tela compartilhada.

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão, com a definição do padrão de exibição: por padrão, o painel mostra comandos, caminhos e títulos de pedidos já minimizados, truncados e redigidos pelo normalizador. O modo discreto é opcional, começa desligado e é ativado por quem observa (T14 do plano).
