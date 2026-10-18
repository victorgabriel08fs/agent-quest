# ADR 0009: Tema como camada de apresentação

- **Status:** proposta (aguarda aprovação do usuário)
- **Data:** 17/10/2026

## Contexto

Regra do produto: Escritório e Guilda traduzem os mesmos eventos canônicos, e nenhuma regra de negócio depende do tema. O mockup já separa vocabulário (`painel-temas.js`), motor (`painel-motor.js`) e interface (`painel.js`). Na v1, o motor sai do navegador e vai para o servidor.

## Decisão

- Estado e regras ficam no servidor (`docs/arquitetura/modelo-de-eventos.md`). O navegador guarda só o estado recebido e as preferências de quem observa.
- Cada tema é um módulo de dados e funções puras em `web/js/themes/<id>.js`, que recebe eventos canônicos e modelos de visão e devolve texto. Contrato:

  ```js
  /** @type {Theme} */
  export default {
    id: 'escritorio', name: 'Escritório', icon: '🏢',
    roles:  { orq, arq, dev, tes, doc, aux },               // { name, icon, short }
    rooms:  { hq, design, dev, idle, docs, test },          // { name, icon, deco: [a, b] }
    phases: { design, code, test, docs },                   // rótulos do stepper
    bars:   { health: 'Humor', context: 'Foco' },
    words:  { quest: 'Ticket', party: 'Equipe', feed: 'Atividade', ... },
    feedLine(event, h) {},    // HTML seguro, ou null para não aparecer no feed
    actionText(agent, h) {},  // texto do balão e da linha do cartão
    finale(questSummary) {},  // cartão de ticket entregue
    stats(sessionView) {},    // indicadores do topo
  };
  ```

  `h` traz os helpers de escape e formatação (`esc`, `code`, `b`, `role`, `plural`). Todo dado dinâmico passa por eles.
- O visual de cada tema fica em variáveis CSS sob `:root[data-theme="<id>"]`, como no mockup.
- Trocar de tema muda `data-theme`, refaz os textos e não toca no estado nem na conexão SSE.
- O papel `aux` (convidado) ganha vocabulário nos dois temas.
- Testes de contrato: os dois temas têm as mesmas chaves; todo tipo de evento e toda categoria de ferramenta geram texto nos dois; dados com HTML aparecem escapados.

## Alternativas consideradas

- **Tema decidindo comportamento** (por exemplo, quando um bug aparece). Proibido pela regra do produto.
- **Arquivos de tradução em JSON.** Perderiam as funções de frase (plural, concordância) que o mockup já usa.

## Consequências

- Um tema novo é um arquivo JS e um bloco de CSS.
- A legenda do painel é gerada a partir dos próprios temas, então não fica desatualizada.
