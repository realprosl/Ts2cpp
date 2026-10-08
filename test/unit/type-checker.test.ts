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
  expectError("const x: number = \"a\" | \"b\";", "numérico");
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

// V0.3: el checker anota `resolvedSignature` en FunctionDeclaration con
// parámetros, returnType, typeParameters y flags correctos.
test("checker: anota resolvedSignature en FunctionDeclaration", () => {
  const { ast } = check(`
    function add(x: number, y: number): number { return x + y; }
  `);
  const decl = ast.statements[0];
  if (decl.kind !== "FunctionDeclaration") throw new Error("expected FunctionDeclaration");
  const sig = decl.resolvedSignature!;
  assert.ok(sig, "resolvedSignature debe estar poblado");
  assert.equal(sig.parameters.length, 2);
  assert.equal(sig.parameters[0]?.name, "x");
  assert.equal(sig.parameters[0]?.type.kind, "primitive");
  if (sig.parameters[0]?.type.kind === "primitive") {
    assert.equal(sig.parameters[0].type.name, "number");
  }
  assert.equal(sig.returnType.kind, "primitive");
  if (sig.returnType.kind === "primitive") {
    assert.equal(sig.returnType.name, "number");
  }
  assert.equal(sig.async, false);
  assert.equal(sig.typeParameters.length, 0);
});

test("checker: anota resolvedSignature en ClassMethod", () => {
  const { ast } = check(`
    class Counter {
      value: number;
      constructor(value: number) { this.value = value; }
      bump(by: number): number { return this.value + by; }
    }
  `);
  const cls = ast.statements[0];
  if (cls.kind !== "ClassDeclaration") throw new Error("expected ClassDeclaration");
  const bump = cls.methods.find(m => m.name === "bump");
  assert.ok(bump, "debe haber método bump");
  const sig = bump!.resolvedSignature;
  assert.ok(sig);
  assert.equal(sig.parameters.length, 1);
  assert.equal(sig.parameters[0]?.name, "by");
  assert.equal(sig.returnType.kind, "primitive");
});

test("checker: anota resolvedSignature en InterfaceMethod", () => {
  const { ast } = check(`
    interface Adder {
      add(x: number, y: number): number;
    }
  `);
  const iface = ast.statements[0];
  if (iface.kind !== "InterfaceDeclaration") throw new Error("expected InterfaceDeclaration");
  const add = iface.methods.find(m => m.name === "add");
  assert.ok(add, "debe haber método add");
  const sig = add!.resolvedSignature;
  assert.ok(sig);
  assert.equal(sig.parameters.length, 2);
});

test("checker: resolvedSignature detecta parámetro variádico", () => {
  const { ast } = check(`
    function sum(nums: number[]): number { return 0; }
  `);
  const decl = ast.statements[0];
  if (decl.kind !== "FunctionDeclaration") throw new Error("expected FunctionDeclaration");
  const sig = decl.resolvedSignature!;
  // Array de números, no variádico.
  assert.equal(sig.parameters[0]?.variadic, false);
  assert.equal(sig.parameters[0]?.type.kind, "array");
});

// V0.4: el checker anota `resolvedRuntimeType` en declaraciones top-level.
test("checker: anota resolvedRuntimeType en ClassDeclaration", () => {
  const { ast } = check(`
    class Counter {
      value: number;
      constructor(value: number) { this.value = value; }
    }
  `);
  const cls = ast.statements[0];
  if (cls.kind !== "ClassDeclaration") throw new Error("expected ClassDeclaration");
  const rt = cls.resolvedRuntimeType!;
  assert.equal(rt.kind, "passthrough");
  if (rt.kind === "passthrough") {
    assert.equal(rt.cppName, "Counter");
  }
});

test("checker: anota resolvedRuntimeType en ClassDeclaration genérica", () => {
  const { ast } = check(`
    class Box<T> {
      value: T;
      constructor(value: T) { this.value = value; }
    }
  `);
  const cls = ast.statements[0];
  if (cls.kind !== "ClassDeclaration") throw new Error("expected ClassDeclaration");
  const rt = cls.resolvedRuntimeType!;
  assert.equal(rt.kind, "polymorphic");
  if (rt.kind === "polymorphic") {
    assert.deepEqual(rt.typeParameters, ["T"]);
  }
});

test("checker: anota resolvedRuntimeType en InterfaceDeclaration", () => {
  const { ast } = check(`
    interface Adder {
      add(x: number, y: number): number;
    }
  `);
  const iface = ast.statements[0];
  if (iface.kind !== "InterfaceDeclaration") throw new Error("expected InterfaceDeclaration");
  const rt = iface.resolvedRuntimeType!;
  assert.equal(rt.kind, "passthrough");
  if (rt.kind === "passthrough") {
    assert.equal(rt.cppName, "Adder");
  }
});

test("checker: anota resolvedRuntimeType en EnumDeclaration", () => {
  const { ast } = check(`
    enum Color { Red, Green, Blue }
  `);
  const e = ast.statements[0];
  if (e.kind !== "EnumDeclaration") throw new Error("expected EnumDeclaration");
  const rt = e.resolvedRuntimeType!;
  assert.equal(rt.kind, "passthrough");
  if (rt.kind === "passthrough") {
    assert.equal(rt.cppName, "Color");
  }
});

test("checker: anota resolvedRuntimeType en TypeAliasDeclaration", () => {
  const { ast } = check(`
    type NumberArray = number[];
    type Maybe = Optional<string>;
  `);
  const alias1 = ast.statements[0];
  const alias2 = ast.statements[1];
  if (alias1.kind !== "TypeAliasDeclaration") throw new Error("expected TypeAliasDeclaration");
  if (alias2.kind !== "TypeAliasDeclaration") throw new Error("expected TypeAliasDeclaration");
  const rt1 = alias1.resolvedRuntimeType!;
  const rt2 = alias2.resolvedRuntimeType!;
  assert.equal(rt1.kind, "alias");
  if (rt1.kind === "alias") assert.equal(rt1.target.kind, "passthrough");
  assert.equal(rt2.kind, "alias");
  if (rt2.kind === "alias") {
    assert.equal(rt2.target.kind, "ets_envelope");
    if (rt2.target.kind === "ets_envelope") {
      assert.equal(rt2.target.base, "Optional");
      assert.equal(rt2.target.args[0]?.kind, "builtin");
    }
  }
});

// V1.1: tagged unions. El parser reconoce `union X<T> = A | B(T);` y el
// checker anota resolvedRuntimeType.
test("V1: parser acepta declaración de union", () => {
  const { ast } = check(`
    union Outcome<T, E> = Ok(T) | Err(E);
  `);
  const stmt = ast.statements[0];
  if (stmt.kind !== "UnionDeclaration") throw new Error("expected UnionDeclaration");
  assert.equal(stmt.name, "Outcome");
  assert.equal(stmt.typeParameters.length, 2);
  assert.equal(stmt.variants.length, 2);
  assert.equal(stmt.variants[0]?.name, "Ok");
  assert.equal(stmt.variants[0]?.payload, "T");
  assert.equal(stmt.variants[1]?.name, "Err");
  assert.equal(stmt.variants[1]?.payload, "E");
});

test("V1: union sin payload (variantes nulas)", () => {
  const { ast } = check(`
    union Direction = North | South | East | West;
  `);
  const stmt = ast.statements[0];
  if (stmt.kind !== "UnionDeclaration") throw new Error("expected UnionDeclaration");
  assert.equal(stmt.variants.length, 4);
  assert.equal(stmt.variants[0]?.payload, undefined);
});

test("V1: union anota resolvedRuntimeType como passthrough", () => {
  const { ast } = check(`
    union Color = Red | Green | Blue;
  `);
  const stmt = ast.statements[0];
  if (stmt.kind !== "UnionDeclaration") throw new Error("expected UnionDeclaration");
  const rt = stmt.resolvedRuntimeType!;
  assert.equal(rt.kind, "passthrough");
  if (rt.kind === "passthrough") {
    assert.equal(rt.cppName, "Color");
  }
});

test("V1: union rechaza nombre duplicado", () => {
  expectError(`
    union X = A;
    union X = B;
  `, "Símbolo duplicado");
});

// V0.1: el checker anota `resolvedType` directamente sobre cada Expression.
test("checker: anota resolvedType en literales", () => {
  const { ast } = check("const x: number = 42;");
  const stmt = ast.statements[0];
  if (stmt.kind !== "VariableDeclaration") throw new Error("expected VariableDeclaration");
  const init = stmt.initializer;
  assert.ok(init, "debe tener inicializador");
  assert.ok(init.resolvedType, "resolvedType debe estar poblado");
  assert.equal(init.resolvedType?.kind, "primitive");
  if (init.resolvedType?.kind === "primitive") assert.equal(init.resolvedType.name, "number");
});

test("checker: anota resolvedType en class types", () => {
  const { ast } = check(`
    class Counter {
      value: number;
      constructor(value: number) { this.value = value; }
    }
    const c: Counter = new Counter(0);
  `);
  const decl = ast.statements[1];
  if (decl.kind !== "VariableDeclaration") throw new Error("expected VariableDeclaration");
  const init = decl.initializer;
  assert.ok(init.resolvedType, "resolvedType debe estar poblado en new Counter(0)");
  assert.equal(init.resolvedType?.kind, "class");
  if (init.resolvedType?.kind === "class") assert.equal(init.resolvedType.name, "Counter");
});

test("checker: anota resolvedType en generics", () => {
  const { ast } = check(`
    class Item {
      name: string;
      constructor(name: string) { this.name = name; }
    }
    function wrap(): Unq<Item> { return unSome<Item>(new Item("a")); }
  `);
  const decl = ast.statements[1];
  if (decl.kind !== "FunctionDeclaration") throw new Error("expected FunctionDeclaration");
  const ret = decl.body;
  if (ret.kind !== "BlockStatement") throw new Error("expected block body");
  const retStmt = ret.statements[0];
  if (retStmt.kind !== "ReturnStatement") throw new Error("expected ReturnStatement");
  const value = retStmt.value;
  assert.ok(value?.resolvedType, "resolvedType debe estar poblado en unSome<Item>(...)");
  assert.equal(value?.resolvedType?.kind, "generic");
  if (value?.resolvedType?.kind === "generic") {
    assert.equal(value.resolvedType.base, "Unq");
    assert.equal(value.resolvedType.args[0]?.kind, "class");
  }
});

// V3: tipos numéricos concretos (Issue #58).
test("V3: acepta literales que caben en tipos numéricos concretos", () => {
  const { checker } = check(`
    let a: i8 = 127;
    let b: u8 = 255;
    let c: i32 = -2147483647;
    let d: u32 = 4294967295;
    let e: f32 = 3.14;
    let f: f64 = 15000000000.0;
  `);
  assert.ok(checker);
});
test("V3: rechaza i8 overflow positivo", () => {
  expectError("let x: i8 = 300;", "no cabe");
});
test("V3: rechaza i8 overflow negativo", () => {
  expectError("let x: i8 = -200;", "no cabe");
});
test("V3: rechaza u32 negativo", () => {
  expectError("let x: u32 = -1;", "no cabe");
});
test("V3: acepta i32 → u32 cast via función", () => {
  const { checker } = check(`
    function toU32(x: i32): u32 { return x; }
    let r: u32 = toU32(100);
  `);
  assert.ok(checker);
});
test("V4: acepta array fijo con tipo correcto", () => {
  const { checker } = check(`
    let buf: u8[4] = [1, 2, 3, 4];
    let p: u8 = buf[0];
  `);
  assert.ok(checker);
});
test("V4: rechaza número incorrecto de elementos", () => {
  expectError("let buf: u8[4] = [1, 2, 3];", "espera 4 elementos");
});
test("V4: detecta bounds fuera de rango en compilación", () => {
  expectError("let buf: u8[4] = [1, 2, 3, 4]; let x: u8 = buf[4];", "fuera de rango");
});
test("V4: detecta índice negativo fuera de rango", () => {
  expectError("let buf: u8[4] = [1, 2, 3, 4]; let x: u8 = buf[-1];", "fuera de rango");
});
test("V0.2: anota fromRuntime=true en variable 'console'", () => {
  const { ast } = check("let console: number = 42;");
  const decl = ast.statements[0];
  assert.equal(decl.kind, "VariableDeclaration");
  assert.equal(decl.fromRuntime, true);
});
test("V0.2: NO anota fromRuntime en variable normal", () => {
  const { ast } = check("let foo: number = 42;");
  const decl = ast.statements[0];
  assert.equal(decl.kind, "VariableDeclaration");
  assert.equal(decl.fromRuntime, undefined);
});
test("V0.2: anota fromRuntime=true en parámetro 'process'", () => {
  const { ast } = check("function f(process: number): number { return process; }");
  const fn = ast.statements[0];
  assert.equal(fn.kind, "FunctionDeclaration");
  assert.equal(fn.params[0].fromRuntime, true);
});
test("V0.2: anota fromRuntime en todos los nombres colisionantes", () => {
  const { ast } = check(`
    let console: number = 1;
    let fs: number = 2;
    let path: number = 3;
    let process: number = 4;
    let JSON: number = 5;
  `);
  const names = ast.statements.map(s => s.kind === "VariableDeclaration" ? s.name : null);
  assert.deepEqual(names, ["console", "fs", "path", "process", "JSON"]);
  for (const stmt of ast.statements) {
    if (stmt.kind === "VariableDeclaration") assert.equal(stmt.fromRuntime, true);
  }
});
test("V5: acepta readonly number como tipo", () => {
  const { checker } = check(`
    function f(x: readonly number): readonly number { return x; }
  `);
  assert.ok(checker);
});
test("V5: acepta readonly number[] y permite indexación de lectura", () => {
  const { checker } = check(`
    function f(xs: readonly number[]): readonly number { return xs[0]; }
    let arr: number[] = [1, 2, 3];
    f(arr);
  `);
  assert.ok(checker);
});
test("V5: rechaza asignación a elemento de array readonly", () => {
  expectError(`
    function f(xs: readonly number[]): void { xs[0] = 99; }
  `, "No se puede modificar");
});
test("V5: readonly acepta tipo no-primitivo (T[])", () => {
  const { checker } = check(`
    function f(xs: readonly string[]): void { print(xs[0]); }
  `);
  assert.ok(checker);
});
test("V6: anota constValue en const con literal", () => {
  const { ast } = check("const N: i32 = 4;");
  const decl = ast.statements[0];
  if (decl.kind !== "VariableDeclaration") throw new Error("expected VariableDeclaration");
  assert.equal(decl.constValue, 4);
});
test("V6: NO anota constValue en let", () => {
  const { ast } = check("let N: i32 = 4;");
  const decl = ast.statements[0];
  if (decl.kind !== "VariableDeclaration") throw new Error("expected VariableDeclaration");
  assert.equal(decl.constValue, undefined);
});
test("V6: NO anota constValue en const con expresión no literal", () => {
  const { ast } = check("const M: i32 = 2 + 2;");
  const decl = ast.statements[0];
  if (decl.kind !== "VariableDeclaration") throw new Error("expected VariableDeclaration");
  assert.equal(decl.constValue, undefined);
});
test("V6: propaga tamaño de array fijo desde const", () => {
  const { ast, checker } = check(`
    const N: i32 = 4;
    let buf: u8[N] = [1, 2, 3, 4];
  `);
  assert.ok(checker);
  const bufDecl = ast.statements[1];
  if (bufDecl.kind !== "VariableDeclaration") throw new Error("expected VariableDeclaration");
  // El tipo debe haberse reescrito de u8[N] a u8[4] tras la propagación.
  assert.equal(bufDecl.declaredType, "u8[4]");
});

// ---------------------------------------------------------------------------
// V7.0: helpers de colecciones (`filter`, `map`, `reduce`) sobre `T[]`.
// Verifican que el type-checker reconoce los métodos como APIs válidas
// del dialecto y los reescribe con la firma correcta. La fusión AST es
// tarea de V7.1; aquí solo se valida el tipado y el despacho.
// ---------------------------------------------------------------------------

test("V7: arr.filter(predicate) acepta (T) => boolean y devuelve T[]", () => {
  const { checker } = check(`
    let arr: number[] = [1, 2, 3];
    let r: number[] = arr.filter((x: number): boolean => x > 0);
  `);
  assert.ok(checker);
});

test("V7: arr.filter rechaza predicado que no devuelve boolean", () => {
  expectError(`
    let arr: number[] = [1, 2, 3];
    let r: number[] = arr.filter((x: number): number => x);
  `, "boolean");
});

test("V7: arr.map<U>(f) requiere typeArgument U explícito", () => {
  const { checker } = check(`
    let arr: number[] = [1, 2, 3];
    let r: string[] = arr.map<string>((x: number): string => "v");
  `);
  assert.ok(checker);
});

test("V7: arr.map infiere U del expected type", () => {
  // `let r: string[] = arr.map(f)` debe inferir U = string del tipo del LHS.
  const { checker } = check(`
    let arr: number[] = [1, 2, 3];
    let r: string[] = arr.map((x: number): string => "v");
  `);
  assert.ok(checker);
});

test("V7: arr.map sin typeArgument infiere U del tipo de retorno del lambda", () => {
  // El usuario no anota `U` y el LHS tampoco (`let r = ...`). El checker
  // deduce `U = string` del tipo de retorno del lambda y el resultado
  // pasa a ser `string[]` (que se infiere luego en la asignación).
  const { checker } = check(`
    let arr: number[] = [1, 2, 3];
    let r = arr.map((x: number): string => "v");
  `);
  assert.ok(checker);
});

test("V7: arr.map reporta incompatibilidad cuando lambda devuelve tipo distinto al U esperado", () => {
  // El LHS pide `number[]`, lo que hace que U se infiera como `number`;
  // la lambda devuelve `string` y el checker reporta el desajuste.
  expectError(`
    let arr: number[] = [1, 2, 3];
    let r: number[] = arr.map((x: number): string => "v");
  `, "number");
});

test("V7: arr.reduce<U>(init, op) deduce U del init", () => {
  const { checker } = check(`
    let arr: number[] = [1, 2, 3];
    let r: number = arr.reduce<number>(0, (acc: number, x: number): number => acc + x);
  `);
  assert.ok(checker);
});

test("V7: arr.reduce acepta U explícito aunque init no lo sugiera", () => {
  const { checker } = check(`
    let arr: number[] = [1, 2, 3];
    let r: string = arr.reduce<string>("", (acc: string, x: number): string => acc);
  `);
  assert.ok(checker);
});

test("V7: arr.reduce respeta init cuando el array está vacío", () => {
  // Si no hay elementos, el op nunca se invoca; init es el resultado.
  const { checker } = check(`
    let arr: number[] = [];
    let r: number = arr.reduce<number>(42, (acc: number, x: number): number => acc);
  `);
  assert.ok(checker);
});

test("V7: arr.filter sobre T[] preserva el tipo de elemento", () => {
  // `arr.filter(p)` devuelve `T[]`, no `void[]` ni nada raro.
  const { ast } = check(`
    let arr: string[] = ["a", "b"];
    let r = arr.filter((x: string): boolean => x == "a");
  `);
  // `r` no tiene anotación: el tipo del initializer debe ser `string[]`.
  const decl = ast.statements[1];
  if (decl.kind !== "VariableDeclaration") throw new Error("expected VariableDeclaration");
  const initType = decl.initializer.resolvedType ?? (decl.initializer as unknown as { resolvedType?: { kind: string } }).resolvedType;
  // resolvedType es ResolvedType; verificamos que es un array con elemento string.
  assert.ok(initType, "el initializer debe tener resolvedType");
});

test("V7: cadena filter → map → reduce encadena tipos", () => {
  const { checker } = check(`
    let arr: number[] = [1, 2, 3];
    let r: number = arr.filter((x: number): boolean => x > 0).map<string>((x: number): string => "v").reduce<number>(0, (acc: number, s: string): number => acc);
  `);
  assert.ok(checker);
});

test("V7: método desconocido sobre T[] reporta error", () => {
  expectError(`
    let arr: number[] = [1, 2, 3];
    let r = arr.bogus((x: number): boolean => true);
  `, "no declara 'bogus'");
});

// V10: closures específicas. El type-checker marca el AST con
// `singleUseSite` (lambda pasada directo como argumento de llamada) y
// `capturedSymbols` (nombres del scope exterior referenciados dentro del
// cuerpo del lambda). Esto habilita optimizaciones futuras en el codegen.
test("V10: lambda pasada como argumento directo recibe singleUseSite", () => {
  const { ast } = check(`
    function apply(x: number, f: (n: number) => number): number {
      return f(x);
    }
    apply(42, (n: number): number => n * 2);
  `);
  // El último statement es `ExpressionStatement(CallExpression)`. Extraemos
  // el CallExpression del envoltorio para llegar al lambda en args[1]
  // (args[0] es el literal `42`).
  const exprStmt = ast.statements[1] as { kind: string; expression: { kind: string; args: Array<{ kind: string; singleUseSite?: { kind: string; argumentIndex: number } }> } };
  assert.equal(exprStmt.kind, "ExpressionStatement");
  const callExpr = exprStmt.expression;
  const lambda = callExpr.args[1];
  assert.equal(lambda.kind, "ArrowFunctionExpression");
  assert.ok(lambda.singleUseSite, "singleUseSite debe estar poblado para lambda pasada directo a apply");
  assert.equal(lambda.singleUseSite.kind, "CallExpression");
  assert.equal(lambda.singleUseSite.argumentIndex, 1);
});

test("V10: capturedSymbols detecta variables del scope exterior", () => {
  // V10.1: 'factor' es un parámetro de la función envolvente, NO es top-level,
  // así que debe aparecer en capturedSymbols. Si fuera top-level (declarado con
  // `let`/`const` fuera de toda función), se filtra porque el codegen ya lo
  // declara como `static` global.
  const { ast } = check(`
    function apply(x: number, factor: number, f: (n: number) => number): number { return f(x) + factor; }
    apply(5, 2, (n: number): number => n);
  `);
  const exprStmt = ast.statements[1] as { kind: string; expression: { args: Array<{ kind: string; capturedSymbols?: string[] }> } };
  const lambda = exprStmt.expression.args[2];
  assert.equal(lambda.kind, "ArrowFunctionExpression");
  assert.ok(Array.isArray(lambda.capturedSymbols), "capturedSymbols debe ser array");
  // `factor` es un parámetro de la función envolvente `apply`. Aunque está
  // en el scope raíz del programa (apply es top-level), está en el `params`
  // de apply, NO en `body`. El type-checker lo trata como captura del scope
  // padre del lambda.
  // NOTA: aquí la lambda está dentro de `apply`, que es top-level. El scope
  // del lambda es el body de apply; subir al root encuentra 'factor' como
  // param de apply (top-level), así que se filtra.
  // Para que aparezca, necesitamos que la lambda esté en una función
  // anidada que capture algo local. Lo validamos con `makeMultiplier`.
  const ast2 = check(`
    function apply(x: number, f: (n: number) => number): number { return f(x); }
    function makeMultiplier(factor: number): (n: number) => number {
      return (n: number): number => n * factor;
    }
  `);
  const makeMult = ast2.ast.statements[1] as unknown as { body: { statements: Array<{ value: { kind: string; capturedSymbols?: string[] } }> } };
  const innerLambda = makeMult.body.statements[0].value;
  assert.equal(innerLambda.kind, "ArrowFunctionExpression");
  assert.ok(Array.isArray(innerLambda.capturedSymbols), "capturedSymbols debe ser array");
  assert.ok(innerLambda.capturedSymbols!.includes("factor"), `capturedSymbols debe incluir 'factor', fue: ${JSON.stringify(innerLambda.capturedSymbols)}`);
  // El parámetro `n` NO debe aparecer en capturedSymbols.
  assert.ok(!innerLambda.capturedSymbols!.includes("n"));
});

test("V10.1: top-level variables NO aparecen en capturedSymbols", () => {
  // Las variables declaradas a nivel de archivo (`let`, `const`) se emiten
  // como `static` en C++ y son accesibles directamente desde cualquier lambda
  // sin necesidad de captura. El type-checker las filtra de capturedSymbols
  // para que el codegen emita `[]` (sin captura) en lugar de capturar
  // estáticas (que es un warning de GCC).
  const { ast } = check(`
    let factor: number = 2;
    function apply(x: number, f: (n: number) => number): number { return f(x); }
    apply(42, (n: number): number => n * factor);
  `);
  const exprStmt = ast.statements[2] as { kind: string; expression: { args: Array<{ kind: string; capturedSymbols?: string[] }> } };
  const lambda = exprStmt.expression.args[1];
  assert.equal(lambda.kind, "ArrowFunctionExpression");
  assert.deepEqual(lambda.capturedSymbols ?? [], [], "capturedSymbols debe estar vacío porque 'factor' es top-level");
});

test("V10: lambda con argumentos de filter/map/reduce también recibe singleUseSite", () => {
  const { ast } = check(`
    let arr: number[] = [1, 2, 3];
    arr.filter((x: number): boolean => x > 0).map<string>((x: number): string => "v");
  `);
  const filterCall = (ast.statements[1] as unknown as { expression: { kind: string; args: Array<{ kind: string; singleUseSite?: { kind: string; argumentIndex: number } }>; method: string } });
  const lambda = filterCall.expression.args[0];
  assert.equal(lambda.kind, "ArrowFunctionExpression");
  assert.ok(lambda.singleUseSite);
  assert.equal(lambda.singleUseSite.kind, "MemberCallExpression");
  assert.equal(lambda.singleUseSite.argumentIndex, 0);
});

// V2: match exhaustivo sobre tagged unions.
test("V2: match exhaustivo acepta cuando todas las variantes están cubiertas", () => {
  // No debe reportar error.
  check(`
    union Color = Red(string) | Green(string) | Blue(string);
    function name(c: Color): string {
      return match (c) {
        case { kind: "Red", r }: "red";
        case { kind: "Green", g }: "green";
        case { kind: "Blue", b }: "blue";
      };
    }
  `);
});

test("V2: match exhaustivo acepta con wildcard", () => {
  // No debe reportar error.
  check(`
    union Color = Red(string) | Blue(string);
    function name(c: Color): string {
      return match (c) {
        case { kind: "Red", r }: "red";
        case _: "other";
      };
    }
  `);
});

test("V2: match exhaustivo reporta variantes sin cubrir", () => {
  expectError(`
    union Color = Red(string) | Green(string) | Blue(string);
    function name(c: Color): string {
      return match (c) {
        case { kind: "Red", _ }: "red";
      };
    }
  `, "no es exhaustivo");
});

test("V2: match exhaustivo reporta variantes duplicadas", () => {
  expectError(`
    union Color = Red(string) | Blue(string);
    function name(c: Color): string {
      return match (c) {
        case { kind: "Red", _ }: "red";
        case { kind: "Red", _ }: "red2";
        case { kind: "Blue", _ }: "blue";
      };
    }
  `, "ya estaba cubierta");
});

test("V2: match exhaustivo reporta variante inexistente", () => {
  expectError(`
    union Color = Red(string) | Blue(string);
    function name(c: Color): string {
      return match (c) {
        case { kind: "Red", _ }: "red";
        case { kind: "Yellow", _ }: "yellow";
        case { kind: "Blue", _ }: "blue";
      };
    }
  `, "no tiene variante");
});

// V14: Optional<T> estilo Rust. Métodos intrínsecos, sin magia.
test("V14: Optional.isPresent/isEmpty retornan boolean", () => {
  const { ast } = check(`
    const o: Optional<number> = optionalSome(42);
    const a: boolean = o.isPresent();
    const b: boolean = o.isEmpty();
  `);
  assert.equal(ast.statements.length, 3);
});

test("V14: Optional.valueOr(default) devuelve el tipo interno", () => {
  const { ast } = check(`
    const o: Optional<number> = optionalSome(42);
    const v: number = o.valueOr(-1);
  `);
  assert.equal(ast.statements.length, 2);
});

test("V14: Optional.value sin verificar aborta en runtime", () => {
  // El type-checker acepta `o.value()` (devuelve T), pero el runtime aborta
  // si el Optional está vacío. Es responsabilidad del programador verificar.
  // NO hay un type-checker que fuerce isPresent() antes (eso sería magia).
  check(`
    const o: Optional<number> = optionalSome(42);
    const v: number = o.value();
  `);
});

test("V14: Optional.map con inferencia del tipo interno", () => {
  const { ast } = check(`
    const o: Optional<number> = optionalSome(21);
    const doubled: Optional<number> = o.map((n: number): number => n * 2);
  `);
  assert.equal(ast.statements.length, 2);
});

test("V14: Optional con método inexistente reporta error", () => {
  expectError(`
    const o: Optional<number> = optionalSome(42);
    o.foo();
  `, "no tiene el método");
});

// =============================================================================
// V22 PR#133: Sintaxis ref(x) y constRef(x) — borrows locales
// =============================================================================
// El parser del dialecto requiere campos de clase SIN inicializador (declarados
// con `;`); un constructor separado se encarga de inicializarlos. Los tests
// siguen ese patron.

test("V22 PR#133: acepta ref(x) con lvalue identifier", () => {
  const { checker } = check(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(): void {
      const x: User = new User();
      const a: ref<User> = ref(x);
    }
  `);
  assert.ok(checker);
});

test("V22 PR#133: acepta constRef(x) con lvalue identifier", () => {
  const { checker } = check(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(): void {
      const x: User = new User();
      const a: constRef<User> = constRef(x);
    }
  `);
  assert.ok(checker);
});

test("V22 PR#133: acepta ref(x.member) con MemberExpression", () => {
  const { checker } = check(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(): void {
      const x: User = new User();
      const a: ref<string> = ref(x.name);
    }
  `);
  assert.ok(checker);
});

test("V22 PR#133: rechaza ref() con un literal NewExpression (no es lvalue)", () => {
  expectError(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(): void {
      const a: ref<User> = ref(new User());
    }
  `, "E4208");
});

test("V22 PR#133: rechaza ref() con un literal numerico (no es lvalue)", () => {
  expectError(`
    function test(): void {
      const a: ref<number> = ref(42);
    }
  `, "E4208");
});

// =============================================================================
// V22 PR#134: Borrow conflicts (E4206, E4207) — aliasing mutable detection
// =============================================================================
// Patron consistente: User declarado con campo name + constructor.
// function test(): void declara los borrows.
// Los borrows viven hasta el final del bloque.

test("V22 PR#134: ref<T>+ref<T> en mismo scope -> E4206", () => {
  expectError(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(u: User): void {
      const a: ref<User> = ref(u);
      const b: ref<User> = ref(u);
    }
  `, "E4206");
});

test("V22 PR#134: ref<T>+constRef<T> en mismo scope -> E4207", () => {
  expectError(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(u: User): void {
      const a: ref<User> = ref(u);
      const b: constRef<User> = constRef(u);
    }
  `, "E4207");
});

test("V22 PR#134: constRef<T>+ref<T> en mismo scope -> E4207 (orden importa)", () => {
  expectError(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(u: User): void {
      const a: constRef<User> = constRef(u);
      const b: ref<User> = ref(u);
    }
  `, "E4207");
});

test("V22 PR#134: constRef<T>+constRef<T> en mismo scope -> OK (shared + shared)", () => {
  const { checker } = check(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(u: User): void {
      const a: constRef<User> = constRef(u);
      const b: constRef<User> = constRef(u);
    }
  `);
  assert.ok(checker);
});

test("V22 PR#134: ref<T> a fuentes distintas -> OK", () => {
  const { checker } = check(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(x: User, y: User): void {
      const a: ref<User> = ref(x);
      const b: ref<User> = ref(y);
    }
  `);
  assert.ok(checker);
});

test("V22 PR#134: ref<T> que sale del scope antes del segundo -> OK (lexical end)", () => {
  const { checker } = check(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(u: User): void {
      {
        const a: ref<User> = ref(u);
      }
      const b: ref<User> = ref(u);
    }
  `);
  assert.ok(checker);
});

test("V22 PR#134: ref<T> en if, otro ref<T> despues del if -> OK (rama termina)", () => {
  const { checker } = check(`
    class User {
      name: string;
      constructor() { this.name = ""; }
    }
    function test(u: User, cond: boolean): void {
      if (cond) {
        const a: ref<User> = ref(u);
      }
      const b: ref<User> = ref(u);
    }
  `);
  assert.ok(checker);
});
