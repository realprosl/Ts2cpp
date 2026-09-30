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

// ---------------------------------------------------------------------------
// V7.0: codegen de filter/map/reduce como llamadas a plantillas libres
// (`ets_filter_vec<T>`, `ets_map_vec<T, U>`, `ets_reduce<U, T>`). El
// helper runtime vive en `runtime/ets_collections.hpp` y se incluye solo
// cuando el programa usa al menos uno de los tres métodos.
// ---------------------------------------------------------------------------

test("codegen V7: arr.filter se emite como ets_filter_vec<T>", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let r = arr.filter((x: number): boolean => x > 0);");
  assert.match(out, /ets_filter_vec<double>\(/);
});

test("codegen V7: arr.map<U> se emite como ets_map_vec<T, U>", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let r: string[] = arr.map<string>((x: number): string => \"v\");");
  assert.match(out, /ets_map_vec<double,\s*std::string>\(/);
});

test("codegen V7: arr.reduce<U> se emite como ets_reduce<U, T>", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let r: number = arr.reduce<number>(0, (acc: number, x: number): number => acc + x);");
  assert.match(out, /ets_reduce<double,\s*double>\(/);
});

test("codegen V7.1: cadena filter → map → reduce se fusiona a un único `for`", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let r: number = arr.filter((x: number): boolean => x > 0).map<string>((x: number): string => \"v\").reduce<number>(0, (acc: number, s: string): number => acc + 1);");
  // V7.1: la cadena se reescribe a un único `for` con el lambda de filter
  // dentro del `if`. NO debe aparecer `ets_filter_vec`/`ets_map_vec`/
  // `ets_reduce` para esta cadena (las llamadas no fusionadas los usan).
  assert.match(out, /for \(const auto& _ets_item : arr\)/);
  assert.match(out, /_ets_acc\s*=/);
  // Solo debe aparecer UN bucle `for` para esta expresión (el de la fusión).
  const forMatches = out.match(/for \(/g) ?? [];
  assert.equal(forMatches.length, 1, `esperaba 1 bucle, encontré ${forMatches.length}`);
});

test("codegen V7: ets_collections.hpp se incluye cuando se usan los helpers", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let r = arr.filter((x: number): boolean => x > 0);");
  assert.match(out, /#include\s*"runtime\/ets_collections\.hpp"/);
});

test("codegen V7: ets_collections.hpp NO se incluye si no se usa", () => {
  const out = cpp("const x: number = 1;");
  assert.doesNotMatch(out, /ets_collections\.hpp/);
});

// V8.0: análisis de escape implícito. Cuando la firma de retorno es
// `Unq<T>` y el valor es de tipo `T` (por valor), el codegen envuelve
// automáticamente con `unSome<T>(...)`. Esto permite al usuario escribir
// `return new Counter(42)` o `return c` sin envolver manualmente.
test("codegen V8.0: return new T() con firma Unq<T> se envuelve con unSome", () => {
  const out = cpp(`
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function make(): Unq<Counter> {
      return new Counter(42);
    }
  `);
  assert.match(out, /return\s+unSome<Counter>\(Counter\{42\.0\}\)/);
});

test("codegen V8.0: return x (de tipo T) con firma Unq<T> se envuelve con unSome", () => {
  const out = cpp(`
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function make(): Unq<Counter> {
      let c = new Counter(42);
      return c;
    }
  `);
  assert.match(out, /return\s+unSome<Counter>\(c\)/);
});

test("codegen V8.0: return new T() con firma Rc<T> se envuelve con rcShare", () => {
  const out = cpp(`
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function share(): Rc<Counter> {
      return new Counter(42);
    }
  `);
  assert.match(out, /return\s+rcShare<Counter>\(Counter\{42\.0\}\)/);
});

test("codegen V8.0: let c = new T() sin firma de retorno Unq sigue siendo por valor", () => {
  const out = cpp(`
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function use(): void {
      let c = new Counter(42);
      print(numberToString(c.value));
    }
  `);
  // V8.0 no toca casos sin escape: `c` sigue siendo `Counter` por valor.
  assert.match(out, /auto\s+c\s*=\s*Counter\{42\.0\}/);
  // Y el `print` accede por valor, no por `unValue(c)`.
  assert.doesNotMatch(out, /unSome<Counter>|rcShare<Counter>/);
});
