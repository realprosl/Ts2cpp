// Unit tests del parser.
// Verifica que el parser produce el AST esperado para snippets
// representativos del dialecto.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer } from "../../src/lexer/lexer.ts";
import { Parser } from "../../src/parser/parser.ts";

function parse(source: string) {
  return new Parser(new Lexer(source).tokenize()).parseProgram();
}

function firstStatement(source: string): unknown {
  const ast = parse(source);
  assert.equal(ast.kind, "Program");
  return ast.statements[0];
}

test("parser: declaración de variable simple", () => {
  const stmt = firstStatement("let x: number = 42;") as { kind: string; name: string; mutable: boolean };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.name, "x");
  assert.equal(stmt.mutable, true);
});

test("parser: declaración const inmutable", () => {
  const stmt = firstStatement("const pi: number = 3.14;") as { kind: string; name: string; mutable: boolean };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.name, "pi");
  assert.equal(stmt.mutable, false);
});

test("parser: array literal", () => {
  const stmt = firstStatement("const arr: number[] = [1, 2, 3];") as { kind: string; initializer: { kind: string; elements: unknown[] } };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.initializer.kind, "ArrayLiteralExpression");
  assert.equal(stmt.initializer.elements.length, 3);
});

test("parser: array destructuring", () => {
  // Usamos un initializer literal para que el parser no necesite saber el
  // tipo de `arr` (eso es responsabilidad del type-checker, no del parser).
  const stmt = firstStatement("const [a, b, c] = [1, 2, 3];") as { kind: string; arrayBindings: { name: string }[] };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.ok(stmt.arrayBindings);
  assert.equal(stmt.arrayBindings.length, 3);
  assert.deepEqual(stmt.arrayBindings.map(b => b.name), ["a", "b", "c"]);
});

test("parser: destructuring con default values", () => {
  const stmt = firstStatement("const [a = 1, b = 2] = arr;") as { kind: string; arrayBindings: { name: string; defaultValue?: { kind: string } }[] };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.arrayBindings.length, 2);
  assert.ok(stmt.arrayBindings[0].defaultValue);
  assert.ok(stmt.arrayBindings[1].defaultValue);
});

test("parser: destructuring con tipos declarados", () => {
  const stmt = firstStatement("const [a: number, b: string] = arr;") as { kind: string; arrayBindings: { name: string; declaredType?: string }[] };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.arrayBindings[0].declaredType, "number");
  assert.equal(stmt.arrayBindings[1].declaredType, "string");
});

test("parser: spread en array literal", () => {
  const stmt = firstStatement("const c = [...a, ...b];") as { kind: string; initializer: { elements: { kind: string }[] } };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.initializer.elements.length, 2);
  assert.equal(stmt.initializer.elements[0].kind, "SpreadElement");
  assert.equal(stmt.initializer.elements[1].kind, "SpreadElement");
});

test("parser: class con campos", () => {
  const stmt = firstStatement("class Foo { x: number; y: string; }") as { kind: string; name: string; fields: { name: string }[] };
  assert.equal(stmt.kind, "ClassDeclaration");
  assert.equal(stmt.name, "Foo");
  assert.equal(stmt.fields.length, 2);
  assert.deepEqual(stmt.fields.map(f => f.name), ["x", "y"]);
});

test("parser: class con constructor", () => {
  const stmt = firstStatement("class Foo { x: number; constructor(n: number) { this.x = n; } }") as { kind: string; methods: { name: string; params: unknown[] }[] };
  assert.equal(stmt.kind, "ClassDeclaration");
  const ctor = stmt.methods[0];
  assert.equal(ctor.name, "constructor");
  assert.equal(ctor.params.length, 1);
});

test("parser: class con readonly", () => {
  const stmt = firstStatement("class Foo { readonly x: number; }") as { kind: string; fields: { name: string; readonly?: boolean }[] };
  assert.equal(stmt.kind, "ClassDeclaration");
  assert.equal(stmt.fields[0].name, "x");
  assert.equal(stmt.fields[0].readonly, true);
});

test("parser: función con tipos y return", () => {
  const stmt = firstStatement("function add(a: number, b: number): number { return a + b; }") as { kind: string; name: string; params: unknown[]; returnType: string };
  assert.equal(stmt.kind, "FunctionDeclaration");
  assert.equal(stmt.name, "add");
  assert.equal(stmt.params.length, 2);
  assert.equal(stmt.returnType, "number");
});

test("parser: arrow function", () => {
  const stmt = firstStatement("const f = (x: number): number => x + 1;") as { kind: string; initializer: { kind: string; params: unknown[]; returnType: string } };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.initializer.kind, "ArrowFunctionExpression");
  assert.equal(stmt.initializer.params.length, 1);
  assert.equal(stmt.initializer.returnType, "number");
});

test("parser: if-else", () => {
  const stmt = firstStatement("if (x > 0) { print(\"pos\"); } else { print(\"neg\"); }") as { kind: string; condition: unknown; elseBranch: unknown };
  assert.equal(stmt.kind, "IfStatement");
  assert.ok(stmt.condition);
  assert.ok(stmt.elseBranch);
});

test("parser: for-of", () => {
  const stmt = firstStatement("for (const x of arr) { print(x); }") as { kind: string; binding: unknown; iterable: unknown };
  assert.equal(stmt.kind, "ForOfStatement");
  assert.ok(stmt.binding);
  assert.ok(stmt.iterable);
});

test("parser: ternario", () => {
  const stmt = firstStatement("const r = x > 0 ? \"pos\" : \"neg\";") as { kind: string; initializer: { kind: string; condition: unknown; thenBranch: { kind: string }; elseBranch: { kind: string } } };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.initializer.kind, "TernaryExpression");
  assert.equal(stmt.initializer.thenBranch.kind, "LiteralExpression");
  assert.equal(stmt.initializer.elseBranch.kind, "LiteralExpression");
});

test("parser: literales no decimales", () => {
  const stmt = firstStatement("const mask: number = 0xFF | 0x0F;") as { kind: string; initializer: { kind: string; left: { kind: string; raw?: string }; right: { kind: string; raw?: string } } };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.initializer.kind, "BinaryExpression");
  assert.equal(stmt.initializer.left.kind, "LiteralExpression");
  assert.equal(stmt.initializer.left.raw, "0xFF");
  assert.equal(stmt.initializer.right.raw, "0x0F");
});

test("parser: enum", () => {
  const stmt = firstStatement("enum Color { Red, Green, Blue }") as { kind: string; name: string; members: { name: string }[] };
  assert.equal(stmt.kind, "EnumDeclaration");
  assert.equal(stmt.name, "Color");
  assert.equal(stmt.members.length, 3);
});

test("parser: interface", () => {
  const stmt = firstStatement("interface I { foo(): number; }") as { kind: string; name: string; methods: { name: string }[] };
  assert.equal(stmt.kind, "InterfaceDeclaration");
  assert.equal(stmt.name, "I");
  assert.equal(stmt.methods[0].name, "foo");
});

test("parser: new expression", () => {
  const stmt = firstStatement("const p: Foo = new Foo(10);") as { kind: string; initializer: { kind: string; className: string; args: unknown[] } };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.initializer.kind, "NewExpression");
  assert.equal(stmt.initializer.className, "Foo");
  assert.equal(stmt.initializer.args.length, 1);
});

test("parser: member call expression", () => {
  const stmt = firstStatement("const r = obj.method(1, 2);") as { kind: string; initializer: { kind: string; method: string; args: unknown[] } };
  assert.equal(stmt.kind, "VariableDeclaration");
  assert.equal(stmt.initializer.kind, "MemberCallExpression");
  assert.equal(stmt.initializer.method, "method");
  assert.equal(stmt.initializer.args.length, 2);
});

// Tests del dialecto ";" opcional: el parser acepta newline significativo
// como terminador de statement (ademas del ';' explicito y el cierre '}').
test("parser: ; opcional entre declaraciones", () => {
  const ast = parse("let a: number = 1\nlet b: number = 2\nlet c: number = 3");
  assert.equal(ast.statements.length, 3);
  assert.equal((ast.statements[0] as { name: string }).name, "a");
  assert.equal((ast.statements[1] as { name: string }).name, "b");
  assert.equal((ast.statements[2] as { name: string }).name, "c");
});

test("parser: ; explicito sigue funcionando", () => {
  const ast = parse("let a: number = 1;\nlet b: number = 2;\nlet c: number = 3;");
  assert.equal(ast.statements.length, 3);
});

test("parser: mezcla de ; y newline", () => {
  const ast = parse("let a: number = 1\nlet b: number = 2;\nlet c: number = 3");
  assert.equal(ast.statements.length, 3);
});

test("parser: newline dentro de () no es terminador", () => {
  // f(\n  1\n  ) debe seguir siendo una sola llamada, no tres statements.
  const ast = parse("let r = f(\n  1,\n  2\n)");
  assert.equal(ast.statements.length, 1);
  const stmt = ast.statements[0] as { initializer: { kind: string; args: unknown[] } };
  assert.equal(stmt.initializer.args.length, 2);
});

test("parser: newline dentro de [] no es terminador", () => {
  const ast = parse("let a = [\n  1,\n  2,\n  3\n]");
  assert.equal(ast.statements.length, 1);
});

test("parser: lineas en blanco entre statements", () => {
  const ast = parse("let a = 1\n\n\nlet b = 2");
  assert.equal(ast.statements.length, 2);
});

test("parser: cierre de bloque } termina statement", () => {
  // El 'if' sin ';' antes del '}' debe seguir siendo valido.
  const ast = parse("if (x) { f() }");
  assert.equal(ast.statements.length, 1);
});

test("parser: 'for' con newlines funciona", () => {
  // El for tiene 3 componentes separados por ';' literales (no newlines).
  // El body puede no tener ';' antes del '}'.
  const ast = parse("for (let i = 0; i < 10; i = i + 1) { f() }");
  assert.equal(ast.statements.length, 1);
});
