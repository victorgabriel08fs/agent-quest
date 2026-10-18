# ADR 0004: Tempo real com Server-Sent Events

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

## Contexto

O painel só recebe dados. As ações de quem observa (tema, sessão escolhida, filtros, modo discreto) ficam no próprio navegador e não precisam ir ao servidor.

## Decisão

- `GET /events` em SSE com as mensagens `hello`, `snapshot`, `update` e `session-removed` (formato em `docs/arquitetura/modelo-de-eventos.md`, seção 9).
- Cada mensagem que muda estado tem `id: <runId>:<seq>`. Na reconexão, o navegador manda `Last-Event-ID` e o servidor reenvia o que faltou, a partir de um buffer com as últimas 1000 atualizações. Se o id for de outra execução do servidor ou antigo demais, manda um `snapshot` novo.
- Cada `update` leva o evento canônico e o estado completo da sessão afetada, sem o feed. O estado de uma sessão tem poucos KB e o tráfego é só local.
- Heartbeat (comentário SSE) a cada 15 s. Até 8 clientes. Cliente lento demais (mais de 1 MiB acumulado) é desconectado e volta com snapshot.
- `GET /api/state` devolve o mesmo conteúdo do `snapshot`.

## Alternativas consideradas

- **WebSocket.** Bidirecional, mas exige uma biblioteca (`ws`) ou implementar o protocolo à mão, e não há mensagens do navegador para o servidor.
- **Polling.** Mais simples, porém com atraso e requisições inúteis.
- **Patches incrementais (JSON Patch).** Menos bytes, mais pontos de falha na aplicação dos patches.

## Consequências

- O `EventSource` do navegador reconecta sozinho.
- As mensagens são idempotentes por `seq`: o cliente ignora repetidas e, se notar uma lacuna, busca `/api/state`.
- O `EventSource` não envia cabeçalhos próprios. A proteção do fluxo é por `Host` e `Origin` (ADR 0006).

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão. O plano entrega o SSE em duas partes: T9a (`hello`, `snapshot`, `update`, `session-removed`, heartbeat e limite de clientes; toda conexão recebe `snapshot`) e T9b (retomada por `Last-Event-ID` e desconexão de cliente lento). Mandar `snapshot` numa reconexão já é um comportamento previsto nesta decisão (id de outra execução ou fora do buffer), então o contrato não muda entre as duas partes.

## Complemento de 18/10/2026: numeração contínua

O `seq` é contínuo. Cada `update`, com ou sem evento, e cada `session-removed` recebe exatamente o anterior + 1 dentro do mesmo `runId`, e qualquer salto é lacuna para o cliente. Detalhes na seção 9 do modelo de eventos ("Numeração"). O hub só repassa o `seq`, e quem numera é a ligação de ponta a ponta do servidor.
