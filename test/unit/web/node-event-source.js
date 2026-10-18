// EventSource mínimo para os testes no Node (o do Node 24 exige a flag
// --experimental-eventsource). Segue o que a conexão do painel usa do padrão
// WHATWG (HTML, "Server-sent events"):
// - GET com Accept: text/event-stream e Last-Event-ID depois do primeiro id;
// - resposta 200 com text/event-stream: readyState 1 e evento 'open';
//   qualquer outra resposta: readyState 2 e 'error' (sem nova tentativa);
// - conexão que cai ou não abre: readyState 0, 'error' e nova tentativa depois
//   do `retry:` do servidor (padrão 3000 ms);
// - campos event, data, id e retry; comentários (':') ignorados.

import http from 'node:http';

export class NodeEventSource {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.lastEventId = '';
    this.retryMs = 3000;
    /** @type {Map<string, Array<(event: any) => void>>} */
    this.listeners = new Map();
    /** Cabeçalhos Last-Event-ID enviados em cada tentativa (para os testes). */
    this.sentLastEventIds = [];
    this.request = null;
    this.timer = null;
    this.#connect();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  close() {
    this.readyState = 2;
    clearTimeout(this.timer);
    this.request?.destroy();
  }

  #dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event });
  }

  #connect() {
    const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    this.sentLastEventIds.push(this.lastEventId || null);
    let settled = false;
    const request = http.get(this.url, { headers }, (response) => {
      const type = String(response.headers['content-type'] ?? '');
      if (response.statusCode !== 200 || !type.startsWith('text/event-stream')) {
        settled = true;
        response.resume();
        this.readyState = 2;
        this.#dispatch('error');
        return;
      }
      this.readyState = 1;
      this.#dispatch('open');
      response.setEncoding('utf8');
      let buffer = '';
      let data = '';
      let eventType = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line === '') {
            if (data !== '') this.#dispatch(eventType || 'message', { data: data.slice(0, -1), lastEventId: this.lastEventId });
            data = '';
            eventType = '';
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') eventType = value;
          else if (field === 'data') data += `${value}\n`;
          else if (field === 'id' && !value.includes('\0')) this.lastEventId = value;
          else if (field === 'retry' && /^\d+$/.test(value)) this.retryMs = Number(value);
        }
      });
      response.on('close', () => this.#lost(() => settled, () => { settled = true; }));
    });
    request.on('error', () => this.#lost(() => settled, () => { settled = true; }));
    this.request = request;
  }

  /** Conexão perdida: tenta de novo, a menos que tenha sido fechada. */
  #lost(isSettled, settle) {
    if (isSettled() || this.readyState === 2) return;
    settle();
    this.readyState = 0;
    this.#dispatch('error');
    this.timer = setTimeout(() => {
      if (this.readyState !== 2) this.#connect();
    }, this.retryMs);
  }
}
