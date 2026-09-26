// Unit tests del type-checker.
// Verifica que el checker detecta tipos correctos y rechaza errores
// con mensajes específicos.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer } from "../../src/lexer/lexer.ts";
import { Parser } from "../../src/parser/parser.ts";
import { TypeChecker } from "../../src/semantic/type-checker.ts";
import { DiagnosticError } from "../../src/core/diagnostic.ts";

function check(source: string) {
  const ast = new Parser(new Lexer(source).tokenize()).parseProgram();
  const checker = new TypeChecker();
  checker.check(ast);
  return { ast, checker };
}

function expectError(source: string, messageSubstring: string) {
  try {
    check(source);
    throw new Error(`Expected error containing "${messageSubstring}" but got none`);
  } catch (e) {
    if (e instanceof DiagnosticError) {
      const msgs = e.diagnostics.map(d => d.message);
      assert.ok(msgs.some(m => m.includes(messageSubstring)), `Expected message containing "${messageSubstring}", got: ${JSON.stringify(msgs)}`);
      return;
    }
    throw e;
  }
}

test("checker: acepta declaración simple", () => {
  const { checker } = check("const x: number = 42;");
  assert.ok(checker);
});

test("checker: rechaza tipo incompatible en asignación", () => {
  expectError("const x: number = \"hola\";", "string");
});

test("checker: rechaza operador bitwise con operandos no numéricos", () => {
  expectError("const x: number = \"a\" | \"b\";", "number");
});

test("checker: acepta bitwise entre números", () => {
  const { checker } = check("const x: number = 0xFF | 0x0F;");
  assert.ok(checker);
});

test("checker: detecta variable no declarada", () => {
  expectError("print(inexistente);", "Símbolo no definido");
});

test("checker: rechaza duplicado de símbolo", () => {
  expectError("const x: number = 1; const x: number = 2;", "duplicado");
});

test("checker: acepta clase con campos", () => {
  const { checker } = check("class Foo { x: number; y: string; } const f: Foo = new Foo(1, \"a\");");
  assert.ok(checker);
});

test("checker: rechaza readonly asignada fuera del constructor", () => {
  expectError("class Box { readonly x: number; constructor(n: number) { this.x = n; } change(m: number): void { this.x = m; } } const b: Box = new Box(1); b.change(2);", "readonly");
});

test("checker: acepta readonly asignada en el constructor", () => {
  const { checker } = check("class Box { readonly x: number; constructor(n: number) { this.x = n; } } const b: Box = new Box(1);");
  assert.ok(checker);
});

test("checker: acepta ternario", () => {
  const { checker } = check("const x: number = true ? 1 : 2;");
  assert.ok(checker);
});

test("checker: rechaza ternario con condición no booleana", () => {
  expectError("const x: number = 42 ? 1 : 2;", "boolean");
});

test("checker: acepta destructuring de array", () => {
  const { checker } = check("const arr: number[] = [1, 2, 3]; const [a, b, c] = arr;");
  assert.ok(checker);
});

test("checker: acepta default values en destructuring", () => {
  const { checker } = check("const arr: number[] = [1]; const [a, b = 2] = arr;");
  assert.ok(checker);
});

test("checker: rechaza default value de tipo incorrecto", () => {
  expectError("const arr: number[] = [1]; const [a, b = \"hola\"] = arr;", "Default value");
});

test("checker: acepta spread en array literal", () => {
  const { checker } = check("const a: number[] = [1, 2]; const b: number[] = [3, 4]; const c: number[] = [...a, ...b];");
  assert.ok(checker);
});

test("checker: rechaza spread con tipo incompatible", () => {
  expectError("const a: number[] = [1, 2]; const c: number[] = [\"x\", ...a];", "Se esperaba number");
});

test("checker: acepta function return type", () => {
  const { checker } = check("function add(a: number, b: number): number { return a + b; }");
  assert.ok(checker);
});

test("checker: rechaza return de tipo incorrecto", () => {
  expectError("function f(): number { return \"hola\"; }", "number");
});

test("checker: acepta enum", () => {
  const { checker } = check("enum Color { Red, Green } const c: Color = Color.Red;");
  assert.ok(checker);
});

test("checker: acepta Math global", () => {
  const { checker } = check("const x: number = Math.floor(3.7);");
  assert.ok(checker);
});

test("checker: rechaza uso de variable como tipo", () => {
  // El dialecto no permite usar variables como tipos (no hay typeof type).
  expectError("const x = 5; const y: x = 5;", "Tipo");
});
