// Unit tests del codegen.
// Verifica que `compile()` produce un .cpp esperado para snippets
// representativos. Usa sub-strings para no romper con cambios menores
// de formato.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../../src/compiler.ts";

function cpp(source: string) {
  return compile(source).cpp;
}

test("codegen: variable simple top-level se emite como static", () => {
  // Las variables a top-level se emiten como `static constexpr T name = value;`
  // cuando son const (V6) o `static T name = value;` cuando son let.
  const out = cpp("const x: number = 42;");
  assert.match(out, /static\s+(constexpr\s+)?double\s+x\s*=\s*42\.0/);
});

test("codegen: array literal se emite como std::vector", () => {
  const out = cpp("const arr: number[] = [1, 2, 3];");
  assert.match(out, /std::vector<double>\s+arr\s*=/);
});

test("codegen: spread genera lambda con insert", () => {
  const out = cpp("const a: number[] = [1, 2]; const b: number[] = [...a, 3];");
  assert.match(out, /insert/);
  assert.match(out, /push_back/);
});

test("codegen: string literal se emite como std::string", () => {
  const out = cpp('const s: string = "hello";');
  // El dialecto usa std::string para `string`.
  assert.match(out, /std::string/);
  assert.match(out, /hello/);
});

test("codegen: class genera struct C++", () => {
  const out = cpp("class Foo { x: number; }");
  assert.match(out, /struct\s+Foo\s*\{/);
  assert.match(out, /double\s+x/);
});

test("codegen: constructor emite método void", () => {
  // El dialecto emite el constructor como un método void dentro del struct,
  // SIN prefijo `Foo::` (los métodos se acceden vía `this->`). El nombre
  // se mantiene para que sea accesible desde C++.
  const out = cpp("class Foo { x: number; constructor(n: number) { this.x = n; } }");
  assert.match(out, /void\s+constructor\(\s*double\s+n\s*\)/);
});

test("codegen: destructor no se emite (no hay manejo manual)", () => {
  const out = cpp("class Foo { x: number; }");
  assert.doesNotMatch(out, /~Foo/);
});

test("codegen: function emite bloque", () => {
  const out = cpp("function add(a: number, b: number): number { return a + b; }");
  assert.match(out, /double\s+add\(\s*double\s+a\s*,\s*double\s+b\s*\)/);
  assert.match(out, /return\s+\(\s*a\s*\+\s*b\s*\)/);
});

test("codegen: if-else emite paréntesis en condición", () => {
  const out = cpp("const x: number = 5; if (x > 0) { print(x); }");
  // El codegen emite `if ((x > 0.0))` con paréntesis.
  assert.match(out, /if\s*\(\s*\(\s*x\s*>\s*0\.0\s*\)\s*\)/);
});

test("codegen: for-of emite bucle sobre vector", () => {
  const out = cpp("const arr: number[] = [1, 2]; for (const x of arr) { print(x); }");
  // El codegen emite `for (const auto& x : arr)`.
  assert.match(out, /for\s*\(\s*const\s+auto&\s+x\s*:\s*arr\s*\)/);
});

test("codegen: ternario emite ?:", () => {
  const out = cpp("const x: number = true ? 1 : 2;");
  assert.match(out, /\?\s*1\.0\s*:\s*2\.0/);
});

test("codegen: print se emite como print(string(...))", () => {
  const out = cpp('print("hello");');
  // El dialecto convierte el string literal a std::string al pasarlo a print.
  assert.match(out, /print\(\s*std::string\(\s*"hello"\s*\)\s*\)/);
});

test("codegen: header principal se incluye", () => {
  const out = cpp("const x: number = 1;");
  assert.match(out, /#include\s*"runtime\/ets_runtime\.hpp"/);
  assert.match(out, /int\s+main\(/);
});

test("codegen: int main retorna 0", () => {
  const out = cpp("const x: number = 1;");
  assert.match(out, /return\s+0\s*;/);
});
