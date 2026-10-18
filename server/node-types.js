// @ts-check
// Apelidos de tipos do Node usados em mais de um arquivo (ADR 0003, convenção
// para tipos do Node em JSDoc). No editor valem `any`, porque o projeto não tem
// @types/node (types/node.d.ts). Se o @types/node for aprovado, a troca pelos
// tipos reais acontece só aqui.
//
// Uso: /** @typedef {import('../node-types.js').IncomingMessage} IncomingMessage */

/**
 * @typedef {any} HttpServer          http.Server
 * @typedef {any} IncomingMessage     http.IncomingMessage
 * @typedef {any} ServerResponse      http.ServerResponse
 * @typedef {any} Socket              net.Socket
 */

export {};
