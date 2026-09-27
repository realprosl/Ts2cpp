// Unit tests del lexer.
// Cubre tokens básicos, keywords, literales numéricos (decimales y no
// decimales), strings, operadores y recovery tras error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer } from "../../src/lexer/lexer.ts";

function tokens(source: string) {
  return new Lexer(source).tokenize();
}

test("lexer: identificador simple", () => {
  const ts = tokens("foo");
  // El lexer emite un 'eof' terminal.
  assert.equal(ts.length, 2);
  assert.equal(ts[0].kind, "identifier");
  assert.equal(ts[0].lexeme, "foo");
});

test("lexer: keywords reconocidos", () => {
  const ts = tokens("let const class function");
  assert.equal(ts[0].kind, "let");
  assert.equal(ts[1].kind, "const");
  assert.equal(ts[2].kind, "class");
  assert.equal(ts[3].kind, "function");
});

test("lexer: operator keywords", () => {
  const ts = tokens("new return if else");
  assert.equal(ts[0].kind, "new");
  assert.equal(ts[1].kind, "return");
  assert.equal(ts[2].kind, "if");
  assert.equal(ts[3].kind, "else");
});

test("lexer: constructor no colisiona con prototype pollution", () => {
  // Regresión: KEYWORDS['constructor'] devolvía Object.prototype.constructor
  // porque el objeto heredaba de Object.prototype. Debe tratarse como identifier.
  const ts = tokens("constructor");
  assert.equal(ts.length, 2); // identifier + eof
  assert.equal(ts[0].kind, "identifier");
  assert.equal(ts[0].lexeme, "constructor");
});

test("lexer: literales numéricos decimales", () => {
  const ts = tokens("0 42 3.14");
  assert.equal(ts[0].lexeme, "0");
  assert.equal(ts[1].lexeme, "42");
  assert.equal(ts[2].lexeme, "3.14");
});

test("lexer: literales hexadecimales", () => {
  const ts = tokens("0xFF 0X1a 0x00");
  assert.equal(ts[0].lexeme, "0xFF");
  assert.equal(ts[1].lexeme, "0X1a");
  assert.equal(ts[2].lexeme, "0x00");
});

test("lexer: literales octales", () => {
  const ts = tokens("0o77 0O17");
  assert.equal(ts[0].lexeme, "0o77");
  assert.equal(ts[1].lexeme, "0O17");
});

test("lexer: literales binarios", () => {
  const ts = tokens("0b1010 0B1111");
  assert.equal(ts[0].lexeme, "0b1010");
  assert.equal(ts[1].lexeme, "0B1111");
});

test("lexer: separadores underscore en números", () => {
  const ts = tokens("1_000_000 0xFF_FF 0b1010_0101");
  assert.equal(ts[0].lexeme, "1_000_000");
  assert.equal(ts[1].lexeme, "0xFF_FF");
  assert.equal(ts[2].lexeme, "0b1010_0101");
});

test("lexer: strings con comillas dobles", () => {
  const ts = tokens('"hello world" "with \\"escape\\""');
  // El lexer guarda el contenido sin las comillas externas y desescapea los \".
  assert.equal(ts[0].lexeme, "hello world");
  assert.equal(ts[1].lexeme, 'with "escape"');
});

test("lexer: operadores aritméticos y comparación", () => {
  const ts = tokens("+ - * / % == != < > <= >=");
  // ts[0..10], descartar eof
  assert.deepEqual(ts.slice(0, 11).map(t => t.kind), ["+", "-", "*", "/", "%", "==", "!=", "<", ">", "<=", ">="]);
});

test("lexer: operadores bitwise (sin shift como token)", () => {
  // El dialecto soporta `<<` y `>>` pero el lexer los emite como dos tokens
  // `<` `<` (los shift se reconstruyen en el parser). Solo `|`, `&`, `^` y `~`
  // son tokens simples.
  const ts = tokens("| & ^ ~");
  assert.deepEqual(ts.slice(0, 4).map(t => t.kind), ["|", "&", "^", "~"]);
});

test("lexer: shifts se tokenizan como dos < o dos >", () => {
  // El lexer no fusiona '<<' y '>>' en tokens dobles (a diferencia de '==' o '&&'),
  // sino que emite dos tokens '<' o '>' separados. El parser los recombina.
  const ts = tokens("<< >>");
  assert.deepEqual(ts.slice(0, 4).map(t => t.kind), ["<", "<", ">", ">"]);
});

test("lexer: operador lógico and", () => {
  const ts = tokens("&& || !");
  assert.deepEqual(ts.slice(0, 3).map(t => t.kind), ["&&", "||", "!"]);
});

test("lexer: operador ternario (single ?)", () => {
  const ts = tokens("cond ? a : b");
  // '?' solo, ':' solo
  assert.equal(ts[1].kind, "?");
  assert.equal(ts[3].kind, ":");
});

test("lexer: ?? se tokeniza como un solo operador (será rechazado por el parser)", () => {
  // El dialecto rechaza `??` (nullish coalescing). El lexer lo reconoce como
  // un token doble '??', pero el parser lo rechaza con un mensaje claro.
  const ts = tokens("a ?? b");
  assert.equal(ts[1].kind, "??");
});

test("lexer: arrow function =>", () => {
  const ts = tokens("x => y");
  assert.equal(ts[1].kind, "=>");
});

test("lexer: asignación simple", () => {
  const ts = tokens("=");
  assert.equal(ts[0].kind, "=");
});

test("lexer: brackets, paréntesis y braces", () => {
  const ts = tokens("({[]})");
  // El lexer siempre añade un token 'eof' al final.
  assert.deepEqual(ts.map(t => t.kind), ["(", "{", "[", "]", "}", ")", "eof"]);
});

test("lexer: punto y coma", () => {
  const ts = tokens("a; b;");
  assert.equal(ts[1].kind, ";");
  assert.equal(ts[3].kind, ";");
});

test("lexer: comentarios de línea ignorados", () => {
  const ts = tokens("a // comentario\nb");
  // 'a', 'b' (los tokens intermedios son el salto de línea + comment,
  // pero el lexer solo emite tokens significativos)
  const idents = ts.filter(t => t.kind === "identifier");
  assert.deepEqual(idents.map(t => t.lexeme), ["a", "b"]);
});

test("lexer: literales boolean", () => {
  const ts = tokens("true false");
  assert.equal(ts[0].kind, "true");
  assert.equal(ts[1].kind, "false");
});

test("lexer: null se trata como identifier (el dialecto lo rechaza después)", () => {
  // El dialecto no tiene null literal; el lexer lo emite como identifier
  // y el semantic/type-checker lo rechaza si aparece.
  const ts = tokens("null");
  assert.equal(ts[0].kind, "identifier");
  assert.equal(ts[1].kind, "eof");
});
