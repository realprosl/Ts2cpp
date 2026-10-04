// Unit tests del codegen.
// Verifica que `compile()` produce un .cpp esperado para snippets
// representativos. Usa sub-strings para no romper con cambios menores
// de formato.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../../src/compiler.ts";

const compilerRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

// V22 (Memory Model v2): ptr<T> y ref<T> sustituyen a Unq<T>/Rc<T>/Mut<T>.
// El codegen ya no envuelve automáticamente retornos ptr<T>; el usuario
// debe usar `new` con contexto ptr explícito o un helper (PR#4 implementa
// make_unique). Por ahora validamos que la firma del parámetro se emite
// con la sintaxis C++ correcta.

test("codegen V22: ptr<T> declarado se traduce a std::unique_ptr<T>", () => {
  // V22: ptr<T> se traduce a std::unique_ptr<T> en cualquier firma. La
  // conversión desde `new T()` a `ptr<T>` se implementa en PR#4 con
  // make_unique. Aquí validamos que un parámetro `ptr<T>` se traduce
  // correctamente a `std::unique_ptr<T>` (no la conversión de valor).
  const out = cpp(`
    class Counter { value: number; }
    function use(p: ptr<Counter>): void { print(numberToString(p.value)); }
  `);
  // V22: `p: ptr<Counter>` se traduce a `std::unique_ptr<Counter> p`.
  assert.match(out, /std::unique_ptr<Counter>\s+p/);
});

test("codegen V22: ref<T> como parámetro emite T&", () => {
  const out = cpp(`
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function increment(c: ref<Counter>): void {
      c.value = c.value + 1;
    }
  `);
  // V22: ref<Counter> se traduce a `Counter&` en la firma.
  assert.match(out, /Counter& c/);
  assert.match(out, /\s+increment\(Counter&/);
});

test("codegen V22: constRef<T> como parámetro emite const T&", () => {
  const out = cpp(`
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function inspect(c: constRef<Counter>): number {
      return c.value;
    }
  `);
  // V22: constRef<Counter> se traduce a `const Counter&` en la firma.
  assert.match(out, /const Counter& c/);
  assert.match(out, /\s+inspect\(const Counter&/);
});

// ---------------------------------------------------------------------------
// Fix: NewExpression no aplicaba static_cast entre tipos numéricos, lo que
// provocaba `-Wnarrowing` en g++ cuando un literal `double` se pasaba a un
// parámetro/campo de tipo numérico concreto (i8..f64). La misma lógica V3
// ya existía para variables, fixed arrays y assignments; aquí faltaba.
// Cobertura: los 10 numéricos concretos + casos mixtos.
// ---------------------------------------------------------------------------

const NUMERIC_TYPES = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64"] as const;
const NUMERIC_TO_CPP: Record<typeof NUMERIC_TYPES[number], string> = {
  i8: "int8_t", i16: "int16_t", i32: "int32_t", i64: "int64_t",
  u8: "uint8_t", u16: "uint16_t", u32: "uint32_t", u64: "uint64_t",
  f32: "float", f64: "double",
};

test("codegen: new T(1.0) emite static_cast para los 10 numéricos concretos (aggregate)", () => {
  for (const t of NUMERIC_TYPES) {
    const src = `class B { x: ${t}; } const b: B = new B(1.0); print(b.x);`;
    const out = cpp(src);
    const expected = `static_cast<${NUMERIC_TO_CPP[t]}>(1.0)`;
    assert.match(out, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `falta ${expected} para tipo ${t}. Output:\n${out}`);
  }
});

test("codegen: new T(1.0) emite static_cast también con constructor explícito", () => {
  for (const t of NUMERIC_TYPES) {
    const src = `class C { v: ${t}; constructor(n: ${t}) { this.v = n; } } const c: C = new C(2.0); print(c.v);`;
    const out = cpp(src);
    const expected = `static_cast<${NUMERIC_TO_CPP[t]}>(2.0)`;
    assert.match(out, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `falta ${expected} para tipo ${t} (constructor explícito). Output:\n${out}`);
  }
});

test("codegen: new T() con varios campos numéricos mezcla casts correctamente", () => {
  const out = cpp("class P { x: i32; y: u8; z: f32; } const p: P = new P(1.0, 2.0, 3.0); print(p.x);");
  assert.match(out, /static_cast<int32_t>\(1\.0\)/);
  assert.match(out, /static_cast<uint8_t>\(2\.0\)/);
  assert.match(out, /static_cast<float>\(3\.0\)/);
});

test("codegen: new T(number) NO añade cast si el target es `number` (sin narrowing)", () => {
  const out = cpp("class P { x: number; } const p: P = new P(42.0); print(p.x);");
  // No debe aparecer static_cast<double>: doble→doble no necesita cast.
  assert.doesNotMatch(out, /static_cast<double>\(42\.0\)/);
  assert.match(out, /P\{42\.0\}/);
});

test("codegen: new T(\"hi\") no numérico no se toca (no cast en strings)", () => {
  const out = cpp('class S { n: string; } const s: S = new S("hi"); print(s.n);');
  assert.doesNotMatch(out, /static_cast<std::string>\("hi"\)/);
  assert.match(out, /S\{std::string\("hi"\)\}/);
});

test("codegen: argumentos de NewExpression compilan limpio con g++ (sin narrowing)", () => {
  // Esta prueba compila el output con g++ y verifica que no emite
  // -Wnarrowing. Si alguien rompe el cast en el futuro, este test
  // detecta el regresión a nivel binario, no solo textual.
  const dir = mkdtempSync(join(tmpdir(), "ets-narrowing-"));
  try {
    for (const t of NUMERIC_TYPES) {
      const src = `class B { x: ${t}; } const b: B = new B(1.0); print(b.x);`;
      const out = cpp(src);
      const cppFile = join(dir, `probe_${t}.cpp`);
      writeFileSync(cppFile, out);
      // g++ con -Werror=narrowing y -c para solo compilar (no enlazar).
      execFileSync("g++", [
        "-std=c++20", "-Werror=narrowing",
        "-I", compilerRoot,
        "-c", cppFile, "-o", join(dir, `probe_${t}.o`),
      ], { stdio: "pipe" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
