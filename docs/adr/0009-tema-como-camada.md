# ADR 0009: Tema como camada de apresentação

- **Status:** aceita em 18/10/2026 (aprovada pelo usuário)
- **Data da proposta:** 17/10/2026

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

## Aprovação

Aprovada pelo usuário em 18/10/2026, sem mudanças na decisão.

## Complemento de 18/10/2026: acréscimos do T10a e contraste

**Acréscimos ao contrato** (vindos do T10a):

- `icons`: os ícones das linhas de sistema do feed (sessão, ticket e afins), por tema, com a mesma paridade de chaves dos outros campos.
- `--c-aux`: a cor do papel `aux` (convidado) nos dois temas.

**Contraste.** O usuário aprovou o layout e o visual do mockup, não tons específicos. Os tons do mockup ficam abaixo do WCAG 2.2 AA em texto. Contas feitas em 18/10/2026 contra o pior fundo em que cada cor aparece:

- no Escritório: `--faint` 2,3:1, `--warn` 2,3:1, `--good` 3,0:1, `--gold` 3,2:1, `--bad` 3,4:1 e `--muted` 4,4:1 sobre `--surface-3`;
- na Guilda, só `--faint` falha (3,1:1).

Decisão:

- **Critério, nos dois temas:**
  - texto com pelo menos 4,5:1 contra o pior fundo em que aparece, inclusive os fundos `--*-soft` sobre `--surface`;
  - texto grande (24 px ou mais, ou 18,66 px ou mais em negrito) com pelo menos 3:1;
  - indicador não textual com pelo menos 3:1 quando for o único meio de mostrar um estado (WCAG 1.4.11). Ponto de status acompanhado de texto não precisa.
- **Como manter a aparência:**
  - os tons vivos do mockup continuam em tudo que não é texto: pontos, bordas, barras, fundos, ícones e tokens;
  - para texto entram variáveis próprias: `--warn-text`, `--bad-text`, `--good-text` e `--gold-text`;
  - `--faint` deixa de ser usado em texto. Horários do feed, rodapé, ação de agente ocioso e rótulos pequenos passam a `--muted`.
- **Valores**, com o mesmo matiz e só a luminosidade ajustada, já conferidos contra o pior fundo:

  | Variável | Escritório | Guilda |
  |---|---|---|
  | `--muted` | `#636c81` (era `#667085`) | sem mudança (`#ab9a7e`) |
  | `--warn-text` | `#9f5e08` | igual a `--warn` |
  | `--bad-text` | `#d61e24` | igual a `--bad` |
  | `--good-text` | `#0e7c3e` | igual a `--good` |
  | `--gold-text` | `#946219` | igual a `--gold` |

  O dev pode refinar os tons, desde que o teste abaixo continue passando.
- **Teste:** um unitário em `test/unit/web/` lê `web/css/themes.css`, calcula o contraste de cada par usado (variável de texto contra cada fundo em que ela aparece, nos dois temas) e falha abaixo do critério.
