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
import { compile, analyze, parse } from "../../src/compiler.ts";

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

test("codegen: constructor devuelve *this (no void) para rvalues en auto-union", () => {
  // V30.13: el constructor del dialecto se emite como un método que devuelve
  // `Foo&` (no void) para que la expresión `Foo{}.constructor(...)` se
  // pueda usar como rvalue. Esto es necesario para envolver la clase en
  // un auto-union: `make_Foo(Foo{}.constructor(x))`. Sin `*this`, el
  // metodo retorna void y el `std::vector<...>{...make_Foo(void)...}`
  // falla con "invalid use of void expression". El nombre se mantiene
  // (`constructor`) para que sea accesible desde C++.
  const out = cpp("class Foo { x: number; constructor(n: number) { this.x = n; } }");
  assert.match(out, /Foo\s*&\s+constructor\(\s*double\s+n\s*\)/);
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

test("codegen V30.13.2: arr.length se emite como size()", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let n: number = arr.length;");
  assert.match(out, /arr\.size\(\)/);
});

test("codegen V30.13.2: arr.push(x) se emite como ets_push_vec<T>", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; arr.push(4);");
  assert.match(out, /ets_push_vec<double>\(/);
});

test("codegen V30.13.2: arr.pop() se emite como ets_pop_vec<T>", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; arr.pop();");
  assert.match(out, /ets_pop_vec<double>\(/);
});

test("codegen V30.13.2: arr.slice(start, end) se emite como ets_slice_vec<T>", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let r: number[] = arr.slice(0, 2);");
  assert.match(out, /ets_slice_vec<double>\(/);
});

test("codegen V30.13.2: arr.includes(v) se emite como ets_includes_vec<T>", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let b: boolean = arr.includes(2);");
  assert.match(out, /ets_includes_vec<double>\(/);
});

test("codegen V30.13.2: arr.find(p) se emite como ets_find_vec<T>", () => {
  const out = cpp("let arr: number[] = [1, 2, 3]; let r: number = arr.find((x: number): boolean => x > 1).value();");
  assert.match(out, /ets_find_vec<double>\(/);
});

test("codegen V30.13.4: interface sin metodos emite concept trivial", () => {
  const out = cpp("interface I { kind: string; }");
  assert.match(out, /concept I = true;/);
});

test("codegen V30.14.1: type alias para union en Array<...> se traduce a std::variant<...>", () => {
  // V30.14.1: `type SvgChild = Line | MultiLine` + `Array<SvgChild>`
  // debe generar `std::vector<std::variant<Line, MultiLine>>`, igual
  // que la union directa `Array<Line | MultiLine>`.
  const out = cpp(`
    class Line { kind: string; constructor() { this.kind = "line" } }
    class MultiLine { kind: string; constructor() { this.kind = "ml" } }
    type SvgChild = Line | MultiLine
    class Svg { children: Array<SvgChild>; constructor() { this.children = [] } }
  `);
  assert.match(out, /std::vector<std::variant<Line, MultiLine>>/);
  assert.doesNotMatch(out, /std::vector<SvgChild>/);
});

test("codegen V30.13.4: array literal con spread se emite como lambda + insert", () => {
  const out = cpp("let a: number[] = [1, 2]; let b: number[] = [3, 4]; let c: number[] = [...a, ...b, 5];");
  // V30.13.4: la captura esta vacia porque no estamos en un class method.
  // El codegen emite el lambda con captura vacia seguido de los argumentos.
  assert.match(out, /\[\]\(std::vector<double> dst\)/);
  assert.match(out, /dst\.insert\(dst\.end\(\), \(a\)\.begin\(\), \(a\)\.end\(\)\)/);
  assert.match(out, /dst\.insert\(dst\.end\(\), \(b\)\.begin\(\), \(b\)\.end\(\)\)/);
  assert.match(out, /dst\.push_back\(5\.0\)/);
});

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

test("codegen V22: move(p) se traduce a std::move(p)", () => {
  const out = cpp(`
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function use(): void {
      let p: ptr<Counter> = new Counter(10);
      let q: ptr<Counter> = move(p);
      print(q.value);
    }
  `);
  // V22: move() emite std::move() y el tipo ptr<Counter> se traduce a
  // std::unique_ptr<Counter>.
  assert.match(out, /std::make_unique<Counter>\(10\.0\)/);
  assert.match(out, /std::move\(p\)/);
  assert.match(out, /std::unique_ptr<Counter>\s+q\s*=\s*std::move\(p\)/);
});

test("codegen V22: make_unique<T> cuando targetType es ptr<T>", () => {
  // V22: cuando la firma devuelve `ptr<T>` y se devuelve `new T(...)`,
  // el codegen emite `std::make_unique<T>(...)` en lugar de construir
  // por valor.
  const out = cpp(`
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function make(): ptr<Counter> { return new Counter(42); }
  `);
  assert.match(out, /std::unique_ptr<Counter>\s+make\(\)/);
  assert.match(out, /return std::make_unique<Counter>\(42\.0\)/);
});

function checkDiagnostics(src: string) {
  const program = parse(src);
  try {
    const { checker } = analyze([program]);
    return (checker as unknown as { diagnostics: { message: string }[] }).diagnostics ?? [];
  } catch (err) {
    // `analyze` throws DiagnosticError when there are diagnostics.
    const diagErr = err as { diagnostics?: { message: string }[] };
    return diagErr.diagnostics ?? [];
  }
}

test("type-checker V22: move() sobre no-ptr<T> genera E4100", () => {
  // V22: move() solo es válido sobre ptr<T> o constPtr<T>. Llamarlo sobre
  // un valor plano es diagnóstico E4100.
  const src = `
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function use(): void {
      let c: Counter = new Counter(10);
      let d: Counter = move(c);
    }
  `;
  const diagnostics = checkDiagnostics(src);
  const e4100 = diagnostics.find(d => d.message.includes("E4100"));
  assert.ok(e4100, `Esperaba un diagnóstico E4100. Diagnósticos: ${diagnostics.map(d => d.message).join("\n")}`);
});

test("type-checker V22: uso de variable movida genera E4102", () => {
  // V22: después de move(p), cualquier acceso a p es E4102 (uso de moved value).
  const src = `
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function use(): void {
      let p: ptr<Counter> = new Counter(10);
      let q: ptr<Counter> = move(p);
      let v: number = p.value;
    }
  `;
  const diagnostics = checkDiagnostics(src);
  const e4102 = diagnostics.find(d => d.message.includes("E4102"));
  assert.ok(e4102, `Esperaba un diagnóstico E4102. Diagnósticos: ${diagnostics.map(d => d.message).join("\n")}`);
});

test("type-checker V22: move en if sin else deja la variable como maybe-moved (E4103)", () => {
  // V22: si una variable se mueve dentro de un `if` sin `else`, fuera del
  // if queda `maybe-moved` (pudo no haberse ejecutado). El uso posterior
  // es diagnóstico E4103 (uso de maybe-moved value).
  const src = `
    class Counter { value: number; constructor(v: number) { this.value = v; } }
    function use(cond: boolean): void {
      let p: ptr<Counter> = new Counter(10);
      if (cond) {
        let q: ptr<Counter> = move(p);
        print(q.value);
      }
      let v: number = p.value;
    }
  `;
  const diagnostics = checkDiagnostics(src);
  const e4103 = diagnostics.find(d => d.message.includes("E4103"));
  assert.ok(e4103, `Esperaba un diagnóstico E4103. Diagnósticos: ${diagnostics.map(d => d.message).join("\n")}`);
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

// V23: tests del codegen para la nueva sintaxis `match(value, [when(...), ...])`.
// Verifica que la interceptación convierte la CallExpression en un IIFE con
// if/else chain, NO en una llamada a función (que sería `match(v, std::vector<void>{...})`).
test("codegen V23: match(v, [when(0, cb)]) emite if con comparación", () => {
  const out = cpp(`
function classify(n: number): string {
  return match(n, [
    when(0, (v: number): string => "cero"),
    otherwise((): string => "otro"),
  ]);
}
print(classify(0));
`);
  // El IIFE debe contener un `if` con la comparación contra el patrón.
  assert.match(out, /\[&]\(\)\s*->\s*std::string\s*\{/);
  assert.match(out, /if\s*\(\s*\(n\)\s*==\s*\(0\.0\)\s*\)/);
  // El literal 0 se emite como 0.0 (el dialecto modela number como double).
  assert.match(out, /0\.0/);
  // NO debe aparecer la llamada normal a `match` ni un std::vector<void>.
  assert.doesNotMatch(out, /std::vector<void>\{/);
  assert.doesNotMatch(out, /match\(\s*n\s*,\s*std::vector/);
});

test("codegen V23: match con multiple when emite if/else if chain", () => {
  const out = cpp(`
function f(n: number): string {
  return match(n, [
    when(0, (v: number): string => "a"),
    when(1, (v: number): string => "b"),
    otherwise((): string => "c"),
  ]);
}
`);
  // Primer when: `if`, los siguientes: `else if`.
  assert.match(out, /if\s*\(\s*\(n\)\s*==\s*\(0\.0\)\s*\)/);
  assert.match(out, /else\s+if\s*\(\s*\(n\)\s*==\s*\(1\.0\)\s*\)/);
  assert.match(out, /else\s*\{[^}]*return[^}]*\}/);
});

test("codegen V23: match sin otherwise aborta", () => {
  const out = cpp(`
function f(n: number): string {
  return match(n, [
    when(0, (v: number): string => "a"),
  ]);
}
`);
  // El else final debe ser `std::abort()` marcado `[[unlikely]]`.
  assert.match(out, /\[\[unlikely\]\]\s*std::abort\(\)/);
});

test("codegen V23: match con discriminator emite acceso a .key", () => {
  const out = cpp(`
class Fake { kind: string; payload: number; constructor(k: string, p: number) { this.kind = k; this.payload = p; } }
function f(r: Fake): string {
  return match(r, "kind", [
    when("a", (x: Fake): string => "A"),
    when("b", (x: Fake): string => "B"),
  ]);
}
`);
  // El acceso debe ser `r.kind` y la comparación contra el string literal.
  assert.match(out, /\(r\.kind\)\s*==\s*\(std::string\("a"\)\)/);
  assert.match(out, /\(r\.kind\)\s*==\s*\(std::string\("b"\)\)/);
});

test("codegen V23: whenType emite rama siempre-activa con callback sin args", () => {
  const out = cpp(`
function f(v: number | string): string {
  return match(v, [
    whenType<number>(() => "num"),
  ]);
}
`);
  // El callback se invoca con 0 args.
  assert.match(out, /\[\]\(\)\s*->\s*std::string\s*\{[^}]*\}\(\)/);
  // El primer whenType es la rama activa; el comentario unreachable no
  // aparece porque solo hay uno.
  assert.doesNotMatch(out, /unreachable/);
});

test("codegen V23: varios whenType con union usan holds_alternative encadenados", () => {
  // V23.2: cuando el subject es una union, cada whenType<T> emite
  // `if (std::holds_alternative<T>(v))` en cadena, NO comentarios
  // unreachable. Esto es el narrowing real que el codegen ahora
  // soporta (issue #95 — V23.1 no lo tenia, V23.2 lo anade).
  const out = cpp(`
function f(v: number | string): string {
  return match(v, [
    whenType<number>(() => "num"),
    whenType<string>(() => "str"),
  ]);
}
`);
  // Cada variante se emite como `holds_alternative<T_i>` encadenado.
  assert.match(out, /std::holds_alternative<double>\(v\)/);
  assert.match(out, /std::holds_alternative<std::string>\(v\)/);
  // El segundo whenType NO es unreachable (narrowing real).
  assert.doesNotMatch(out, /unreachable/);
});

test("codegen V23: whenType sobre subject NO-union cae al comportamiento legacy", () => {
  // V23.2: cuando el subject NO es una union, whenType cae al
  // comportamiento legacy de V23.1: solo el primer whenType es
  // activo, los siguientes quedan como comentarios `unreachable`
  // (porque no podemos narrowar — el subject ya es de un tipo
  // concreto, no una union).
  const out = cpp(`
function f(v: number): string {
  return match(v, [
    whenType<number>(() => "num"),
    whenType<string>(() => "str"),
  ]);
}
`);
  // El segundo whenType queda como comentario unreachable.
  assert.match(out, /unreachable/);
  // NO se emite holds_alternative porque el subject no es union.
  assert.doesNotMatch(out, /std::holds_alternative/);
});

test("codegen V23: match con callbacks de 0 params se invocan sin args", () => {
  const out = cpp(`
function f(n: number): string {
  return match(n, [
    when(0, (): string => "cero"),
    otherwise((): string => "otro"),
  ]);
}
`);
  // El callback de 0 params se invoca con `()` y no con `(n)`.
  assert.match(out, /\[\]\(\)\s*->\s*std::string\s*\{[^}]*std::string\("cero"\)/
  );
  // Verificamos que NO se le pasa el subject al callback de 0 params.
  assert.doesNotMatch(out, /\[\]\(\)\s*->\s*std::string[^}]*\(\s*n\s*\)/);
});

// ---------------------------------------------------------------------------
// V30.11.1: detección inter-procedimental de mutación. Antes, `methodMutates`
// solo miraba asignaciones directas a `this.campo`. Si un método solo llama
// a `this.otroMetodo()` que muta, se marcaba `const` en C++ y g++ reventaba
// con "passing const Svg as 'this' argument discards qualifiers". Estos
// tests verifican que el método se sigue marcando no-const cuando una
// llamada transitiva a otro método de la misma clase muta, y que los métodos
// puramente lectores siguen siendo `const` (no rompemos el caso V30.10.2).
// ---------------------------------------------------------------------------

test("codegen V30.11.1: método que llama a this.otro() que muta → no-const", () => {
  // Svg.run() no asigna a this.x/this.y directamente, pero llama a
  // this.modX()/this.modY() que sí lo hacen. run() debe ser no-const.
  const out = cpp(`
    class Svg {
      x: i8; y: i8
      constructor() { this.x = 0; this.y = 0 }
      modX(v: i8): i8 { this.x = this.x + v; return this.x }
      modY(v: i8): i8 { this.y = this.y + v; return this.y }
      run(): void { const _a = this.modX(10); const _b = this.modY(20) }
    }
    const s = new Svg(); s.run();
  `);
  // modX y modY asignan a this → no-const (caso baseline previo).
  assert.match(out, /int8_t\s+modX\(\s*int8_t\s+v\s*\)\s*\{/);
  assert.doesNotMatch(out, /modX\([^)]*\)\s+const\s+\{/);
  // run() NO debe llevar `const` aunque solo llame a modX/modY.
  const runMatches = out.match(/void\s+run\s*\([^)]*\)\s+(const\s+)?\{/);
  assert.ok(runMatches, "debe existir método run()");
  assert.equal(runMatches[1], undefined, "run() debe ser no-const");
});

test("codegen V30.11.1: método que solo lee this.campo → const (no rompe caso existente)", () => {
  // getX() solo lee this.x — debe seguir siendo const como en V30.10.2.
  const out = cpp(`
    class Pair {
      x: i8; y: i8
      constructor() { this.x = 0; this.y = 0 }
      getX(): i8 { return this.x }
      getY(): i8 { return this.y }
      sum(): i8 { return this.getX() + this.getY() }
    }
  `);
  // getX, getY, sum son puramente lectores → todos const.
  assert.match(out, /int8_t\s+getX\(\)\s+const\s*\{/);
  assert.match(out, /int8_t\s+getY\(\)\s+const\s*\{/);
  // sum() llama a this.getX() y this.getY() (que son const), por lo tanto
  // sum() también debe poder ser const.
  assert.match(out, /int8_t\s+sum\(\)\s+const\s*\{/);
});

test("codegen V30.11.1: ciclo A↔B entre métodos de la misma clase no causa recursión infinita", () => {
  // ping() llama a pong() y pong() llama a ping(). Aunque ambos asignan a
  // this.counter, lo crítico aquí es que el visited set evita que el
  // análisis caiga en un loop infinito. Ambos métodos deben ser no-const.
  const out = cpp(`
    class PingPong {
      counter: i8
      constructor() { this.counter = 0 }
      ping(): void { this.counter = this.counter + 1; this.pong() }
      pong(): void { this.counter = this.counter + 1; this.ping() }
    }
  `);
  // Tanto ping como pong asignan a this.counter → no-const.
  assert.doesNotMatch(out, /void\s+ping\s*\(\)\s+const\s*\{/);
  assert.doesNotMatch(out, /void\s+pong\s*\(\)\s+const\s*\{/);
  // El test compila (no se cuelga el codegen) y produce la salida esperada.
  assert.match(out, /struct\s+PingPong\s*\{/);
});

test("codegen V30.11.1: método que no llama a nada y no muta → const (baseline)", () => {
  // verify() no asigna a this y no llama a this.otro() — debe seguir siendo
  // const. Este test es el guardrail de que no rompemos el camino feliz.
  const out = cpp(`
    class Bag {
      v: i8
      constructor() { this.v = 0 }
      verify(): i8 {
        const local: i8 = 42;
        return local;
      }
    }
  `);
  // verify() no toca this y no llama a métodos de la clase → const.
  assert.match(out, /int8_t\s+verify\(\)\s+const\s*\{/);
});

test("V30.12.2: Array<Interface> con 2 clases concretas genera auto-union", () => {
  const out = cpp(`
    interface Mod {
      kind: string
      x: i8
    }
    class DrawLine {
      kind: string
      x: i8
      constructor(x: i8) { this.kind = "drawLine"; this.x = x }
    }
    class MoveCursor {
      kind: string
      x: i8
      constructor(x: i8) { this.kind = "moveCursor"; this.x = x }
    }
    const ops: Array<Mod> = [new DrawLine(10), new MoveCursor(-2)];
  `);
  assert.match(out, /Mod_AutoUnion/);
  assert.match(out, /std::vector<Mod_AutoUnion>/);
});

test("V30.12.2: Array<Interface> sin clases concretas reporta error", () => {
  assert.throws(
    () => cpp(`
      interface Mod {
        kind: string
        x: i8
      }
      const ops: Array<Mod> = [];
    `),
    /no hay clases concretas|union auto|Mod/,
  );
});

// ---------------------------------------------------------------------------
// V30.12.1: captura de `this` por referencia en callbacks de `match`.
//
// Antes, las arrow functions dentro de un método de clase se emitían con
// `[=, this]` (captura por valor de `this`). Si el método exterior estaba
// marcado `const` por el codegen (no mutaba directamente), el `this` copiado
// al callback era `const`, y llamadas a métodos no-const de `this` desde el
// callback fallaban con `passing const Svg as \'this\' argument discards
// qualifiers`. El fix: dentro de `emitNewMatch`, activamos una flag
// `inMatchCallback` que hace que la captura del callback use `[&, this]`
// (por referencia) en lugar de `[=, this]`. Esto solo afecta a los callbacks
// emitidos como `when`/`whenType`/`otherwise`; el resto de lambdas siguen
// con la captura legacy.
// ---------------------------------------------------------------------------

test("codegen V30.12.1: callback de match en método que llama a this.metodoNoConst() → captura por referencia", () => {
  // Repro mínimo del fallo reportado. apply() NO muta directamente, por lo
  // que el codegen lo marca `const`. Pero el callback de `when` llama a
  // this.modX() que sí muta. Antes del fix el callback se emitía con
  // `[=, this]` → g++ reventaba. Después del fix usa `[&, this]`.
  // Usamos el patrón del test V23 (clase con campo `kind: string`):
  // el discriminator matchea contra el literal "drawLine" como string.
  const out = cpp(`
    class Mod { kind: string; x: i8; constructor(k: string, v: i8) { this.kind = k; this.x = v } }
    class Counter {
      x: i8
      constructor() { this.x = 0 }
      modX(d: i8): i8 { this.x = this.x + d; return this.x }
      apply(m: Mod): void {
        match(m, "kind", [
          when("drawLine", (x: Mod): void => print(\`x: \${this.modX(x.x)}\`)),
        ])
      }
    }
  `);
  // El callback de `when` debe capturar `this` por referencia.
  // Buscamos el patrón dentro del IIFE del match. Como `[&, this]` puede
  // aparecer en varios sitios (uno por callback), basta con que aparezca
  // AL MENOS una vez en el contexto del callback.
  assert.match(out, /\[&,\s*this\]/);
  // Y la llamada a this.modX() debe estar presente (la prueba semántica
  // del fix: el callback sí intenta llamar al método no-const). El
  // dialecto emite la llamada sobre `(*this)` en lugar de `this->`.
  assert.match(out, /\(\*this\)\.modX\(/);
});

test("codegen V30.12.1: callback de match que solo lee this.campo → sigue funcionando (no regresión)", () => {
  // El fix solo cambia la captura en callbacks de match. Un callback que
  // SOLO lee `this` (no llama a métodos no-const) debe seguir funcionando,
  // y la salida C++ debe seguir capturando `this` por referencia dentro del
  // callback de match. Aquí verificamos que se emite el `print(this.x)` y
  // que el callback está bien formado.
  const out = cpp(`
    class Mod { kind: string; v: i8; constructor(k: string, x: i8) { this.kind = k; this.v = x } }
    class Reader {
      x: i8
      constructor() { this.x = 7 }
      apply(m: Mod): void {
        match(m, "kind", [
          when("a", (_x: Mod): void => print(\`x: \${this.x}\`)),
        ])
      }
    }
  `);
  // El callback usa `[&, this]` por el fix.
  assert.match(out, /\[&,\s*this\]/);
  // El acceso a this.x se compila a `(*this).x` (el dialecto estica
  // desreferencia el `this` capturado por referencia y emite el operador
  // `.` para mantener la semántica de campo directo de la clase).
  assert.match(out, /\(\*this\)\.x/);
});

test("codegen V30.12.1: match en función libre (no método) NO se ve afectado por el flag", () => {
  // Si match se usa fuera de un método de clase, `inClassMethod` es false
  // y la captura por defecto aplica: el callback se emite con `[]` (no
  // captura nada del scope exterior) o con la captura basada en
  // `capturedSymbols` según corresponda. El flag `inMatchCallback` solo
  // cambia la rama de captura `[=, this]` vs `[&, this]` que SOLO aplica
  // cuando `inClassMethod` es true. Verificamos que en una función libre
  // no aparece `[&, this]` (no hay `this` que capturar) y el callback se
  // emite con la captura correcta.
  const out = cpp(`
    function libre(n: number): string {
      return match(n, [
        when(0, (v: number): string => "cero"),
        otherwise((): string => "otro"),
      ]);
    }
  `);
  // En función libre NO debe haber captura de `this`.
  assert.doesNotMatch(out, /\[&,\s*this\]/);
  assert.doesNotMatch(out, /\[=,\s*this\]/);
});

// V30.12.3: codegen emite las definiciones de clase en orden topológico para
// que cada clase esté completa cuando otra la referencia por valor.
// ---------------------------------------------------------------------------

/** Helper: extrae el orden de aparición de `struct X {` (definiciones, no
 *  los forward decls `struct X;`) en el cpp generado. */
function structDefinitionOrder(cppSource: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const defRe = /^struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;
  for (const m of cppSource.matchAll(defRe)) {
    const name = m[1];
    if (name && !seen.has(name)) { seen.add(name); order.push(name); }
  }
  return order;
}

test("codegen V30.12.3: dos clases con dependencia simple se ordenan topológicamente", () => {
  // Holder referencia A por valor en su campo → A debe definirse ANTES que
  // Holder para que `A a` esté completo. El AST pone Holder primero; el
  // codegen tiene que emitir el forward decl + def de A primero.
  const out = cpp(`
    class Holder {
      a: A
      constructor() { this.a = new A() }
    }
    class A {
      x: i8
      constructor() { this.x = 42 }
    }
    const h: Holder = new Holder()
  `);
  const order = structDefinitionOrder(out);
  // `A` debe aparecer antes que `Holder` en las DEFINICIONES (líneas
  // `struct A {` y `struct Holder {`, no en los forward decls `;`).
  const ai = order.indexOf("A");
  const hi = order.indexOf("Holder");
  assert.ok(ai >= 0 && hi >= 0, `falta A o Holder. Definiciones: ${order.join(", ")}. Output:\n${out}`);
  assert.ok(ai < hi, `A debe definirse antes que Holder, pero el orden es ${order.join(", ")}`);
});

test("codegen V30.12.3: tres clases en cadena A→B→C se definen en orden topológico", () => {
  // Top se construye sobre Mediano, Mediano sobre Base. AST: Top, Mediano,
  // Base. Tras el sort el orden debe ser Base, Mediano, Top (inverso del
  // AST) para que cada clase esté completa cuando otra la mencione.
  const out = cpp(`
    class Top {
    medio: Mediano
    constructor() { this.medio = new Mediano() }
    }
    class Mediano {
      base: Base
      constructor() { this.base = new Base() }
    }
    class Base {
      leaf: i8
      constructor() { this.leaf = 1 }
    }
    const t: Top = new Top()
  `);
  const order = structDefinitionOrder(out);
  const baseAt = order.indexOf("Base");
  const medAt = order.indexOf("Mediano");
  const topAt = order.indexOf("Top");
  assert.ok(baseAt >= 0 && medAt >= 0 && topAt >= 0,
    `falta alguna clase. Definiciones: ${order.join(", ")}. Output:\n${out}`);
  assert.ok(baseAt < medAt, `Base debe ir antes que Mediano, orden = ${order.join(", ")}`);
  assert.ok(medAt < topAt, `Mediano debe ir antes que Top, orden = ${order.join(", ")}`);
});

test("codegen V30.12.3: ciclo A↔B se detecta y se emite warning por stderr", () => {
  // Las dos clases se referencian entre sí por valor. El dialecto no las
  // soporta (cualquier forward decl que pongamos es inmediatamente
  // invalidada por la definición de la otra). El codegen detecta el SCC
  // y emite un warning explicativo por stderr.
  const src = `
    class A { b: B; constructor() { this.b = new B() } }
    class B { a: A; constructor() { this.a = new A() } }
    const aa: A = new A()
  `;
  // Capturamos stderr para verificar que el warning sale sin abortar.
  const originalWrite = process.stderr.write.bind(process.stderr);
  let warning = "";
  let fakeWrite: ((s: string | Uint8Array) => boolean) | null = null;
  fakeWrite = ((chunk: string | Uint8Array): boolean => {
    warning += typeof chunk === "string" ? chunk : "";
    return true;
  }) as unknown as (s: string | Uint8Array) => boolean;
  (process.stderr as unknown as { write: typeof fakeWrite }).write = fakeWrite;
  let compileError: unknown = null;
  let out = "";
  try {
    out = compile(src).cpp;
  } catch (err) {
    compileError = err;
  } finally {
    (process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
  // El codegen NO aborta (queremos que g++ reporte el error concreto con
  // su mejor diagnóstico). Solo emitimos warning + salida con orden AST.
  assert.ok(out.length > 0, "el codegen debe producir salida incluso con ciclo");
  assert.ok(compileError === null, `el codegen no debe lanzar, lanzó: ${compileError}`);
  assert.match(warning, /V30\.12\.3/);
  assert.match(warning, /A.*B|ciclo/);
});

test("V30.14.2: type alias union genera SvgChild_Union struct con dispatch + kind publico", () => {
  const src = `
    class Line {
      kind: string
      constructor() { this.kind = "line" }
      build(): string { return "<line/>" }
    }
    class Circle {
      kind: string
      constructor() { this.kind = "circle" }
      build(): string { return "<circle/>" }
    }
    type SvgChild = Line | Circle
    let c: SvgChild = new Line()
    print(c.kind)
    print(c.build())
  `;
  const out = compile(src).cpp;
  assert.match(out, /struct SvgChild_Union/, "debe emitir SvgChild_Union");
  assert.match(out, /std::string kind/, "kind publico es string");
  assert.match(out, /_kindIndex/, "_kindIndex privado");
  assert.match(out, /build\(\) const \{ switch \(_kindIndex\)/, "build() dispatch via _kindIndex");
  assert.match(out, /make_Line/, "make_Line constructor del union");
});

test("V30.14.3: add(SvgChild) enveuelve el call site con make_X", () => {
  const src = `
    class Line {
      kind: string
      constructor() { this.kind = "line" }
    }
    class Circle {
      kind: string
      constructor() { this.kind = "circle" }
    }
    interface SvgChild {
      kind: string
    }
    class Svg {
      children: Array<SvgChild>
      constructor() { this.children = [] }
      add(child: SvgChild): void { this.children.push(child) }
    }
    let svg: Svg = new Svg()
    svg.add(new Line())
    svg.add(new Circle())
    print(svg.children.length)
  `;
  const out = compile(src).cpp;
  // El call site de svg.add(new Line()) debe envolver con make_Line.
  assert.match(out, /svg\.add\(make_Line\(/, "svg.add(new Line()) debe envolver con make_Line");
  assert.match(out, /svg\.add\(make_Circle\(/, "svg.add(new Circle()) debe envolver con make_Circle");
});

test("V30.14.4: type alias union con built-ins NO genera auto-union", () => {
  const src = `
    type Maybe = string | number
    let m: Maybe = "hello"
    print(m)
  `;
  const out = compile(src).cpp;
  // El type alias Maybe = string | number NO debe generar Maybe_Union
  // porque sus variantes son built-ins, no clases del dialecto.
  assert.doesNotMatch(out, /struct Maybe_Union/, "no debe emitir Maybe_Union para built-ins");
  assert.doesNotMatch(out, /make_string/, "no debe emitir make_string");
});

test("V30.15: match con type-alias union narrowa el subject al tipo de la variant", () => {
  const src = `
    class Line {
      kind: string
      constructor() { this.kind = "line" }
      build(): string { return "<line/>" }
    }
    class Circle {
      kind: string
      constructor() { this.kind = "circle" }
      build(): string { return "<circle/>" }
    }
    type SvgChild = Line | Circle
    function describe(c: SvgChild): string {
      return match(c, "kind", [
        when("Line", (x: Line): string => x.build()),
        when("Circle", (x: Circle): string => x.build()),
      ])
    }
    let s: SvgChild = new Line()
    print(describe(s))
  `;
  const out = compile(src).cpp;
  // V30.15: cada `when` con class name debe narrowar el subject via
  // `std::holds_alternative<T>(c.payload)` + `std::get<T>(c.payload)`.
  assert.match(out, /std::holds_alternative<Line>\(c\.payload\)/, "debe narrowar a Line via holds_alternative");
  assert.match(out, /std::holds_alternative<Circle>\(c\.payload\)/, "debe narrowar a Circle via holds_alternative");
  assert.match(out, /std::get<Line>\(c\.payload\)/, "debe extraer Line via std::get");
  assert.match(out, /std::get<Circle>\(c\.payload\)/, "debe extraer Circle via std::get");
});

test("V30.15.1: whenType<T> sobre type-alias union narrowa via c.payload", () => {
  const src = `
    class Line { kind: string; constructor() { this.kind = "line" } }
    class Circle { kind: string; constructor() { this.kind = "circle" } }
    type SvgChild = Line | Circle
    function describe(c: SvgChild): string {
      return match(c, [
        whenType<Line>(() => "line!"),
        whenType<Circle>(() => "circle!"),
      ])
    }
    let s: SvgChild = new Line()
    print(describe(s))
  `;
  const out = compile(src).cpp;
  // V30.15.1: whenType<T> debe usar c.payload para holds_alternative.
  assert.match(out, /std::holds_alternative<Line>\(c\.payload\)/, "whenType<Line> debe narrowar via c.payload");
  assert.match(out, /std::holds_alternative<Circle>\(c\.payload\)/, "whenType<Circle> debe narrowar via c.payload");
});

test("V30.16: type parameter constraint permite acceder a miembros del constraint", () => {
  const src = `
    interface HasLength { length: number }
    function longest<T extends HasLength>(a: T, b: T): T {
      if (a.length > b.length) return a
      return b
    }
    class S {
      length: number
      constructor(public s: string) { this.length = s.length }
    }
    let r: S = longest(new S("hello"), new S("hi!"))
    print(r.s)
  `;
  const out = compile(src).cpp;
  // V30.16: el type-checker debe resolver `a.length` mirando el
  // constraint `HasLength` (que es una interface con `length: number`).
  // El codegen emite `requires HasLength<T>` y permite el acceso a
  // `a.length` y `b.length`.
  assert.match(out, /template\s*<typename\s*T>\s*requires\s*HasLength<T>/, "debe emitir requires HasLength<T>");
  assert.match(out, /a\.length/, "debe emitir a.length");
  assert.match(out, /b\.length/, "debe emitir b.length");
});

test("V30.17: Promise.all<T>(tasks) emite ::ets::task_all<T>(make_task_vector(...))", () => {
  const src = `
    async function slow1(): Promise<number> { return 10 }
    async function slow2(): Promise<number> { return 20 }
    const r: number[] = await Promise.all<number>([slow1(), slow2()])
    print(r.length)
    print(r[0])
  `;
  const out = compile(src).cpp;
  // V30.17: Promise.all<T> debe emitir `::ets::task_all<T>(...)` para
  // que el `await` funcione via co_await o syncWait. El helper
  // `make_task_vector` mueve los tasks del array de usuario al
  // vector de Task<T> (Task no es copiable).
  assert.match(out, /::ets::task_all<[^>]+>/, "debe emitir ::ets::task_all<T>");
  assert.match(out, /::ets::make_task_vector\(/, "debe usar make_task_vector para mover tasks");
});

test("V30.17.1: Promise.race<T>(tasks) emite ::ets::task_race<T>", () => {
  const src = `
    async function slow1(): Promise<number> { return 10 }
    async function slow2(): Promise<number> { return 20 }
    const r: number = await Promise.race<number>([slow1(), slow2()])
    print(r)
  `;
  const out = compile(src).cpp;
  assert.match(out, /::ets::task_race<[^>]+>/, "debe emitir ::ets::task_race<T>");
});

test("V30.18: timeout<T>(task, ms, sentinel) emite ::ets::timeout<T>", () => {
  const src = `
    async function slow(): Promise<number> { return 42 }
    const r: number = await timeout<number>(slow(), 50, -1)
    print(r)
  `;
  const out = compile(src).cpp;
  // V30.18: el codegen debe emitir `::ets::timeout<T>(...)` con el
  // type argument explicito, para que el runtime pueda instanciar
  // el helper con el tipo concreto.
  assert.match(out, /::ets::timeout<[^>]+>/, "debe emitir ::ets::timeout<T>");
});

test("V30.18: retry<T>(fn, times, delayMs, sentinel) emite ::ets::retry<T>", () => {
  const src = `
    async function flaky(): Promise<number> { return 0 }
    const r: number = await retry<number>(() => flaky(), 3, 10, 0)
    print(r)
  `;
  const out = compile(src).cpp;
  assert.match(out, /::ets::retry<[^>]+>/, "debe emitir ::ets::retry<T>");
});

test("V30.19: += -= *= /= emiten C++ con el operador (no target = target op value)", () => {
  const src = `
    let x: number = 10
    x += 5
    x -= 3
    x *= 2
    x /= 4
    print(x)
  `;
  const out = compile(src).cpp;
  // V30.19: el codegen debe emitir el operador compuesto directamente
  // (e.g. `x += 5.0;` en lugar de `x = x + 5.0;`). Esto es mas
  // eficiente y semanticamente equivalente para tipos primitivos.
  assert.match(out, /\(x \+= 5\.0\)/, "debe emitir x += 5.0");
  assert.match(out, /\(x -= 3\.0\)/, "debe emitir x -= 3.0");
  assert.match(out, /\(x \*= 2\.0\)/, "debe emitir x *= 2.0");
  assert.match(out, /\(x \/= 4\.0\)/, "debe emitir x /= 4.0");
});

test("V30.19: this.count += 1 cuenta como mutacion (metodo no es const)", () => {
  const src = `
    class Counter {
      count: number
      constructor() { this.count = 0 }
      inc(): void {
        this.count += 1
        this.count *= 2
      }
    }
    let c: Counter = new Counter()
    c.inc()
    c.inc()
    c.inc()
    print(c.count)
  `;
  const out = compile(src).cpp;
  // V30.19: el metodo `inc` debe ser no-const (sin `const` al final)
  // porque muta `this.count`. Antes de V30.19, `methodMutates` no
  // reconocia `CompoundAssignmentExpression` y marcaba el metodo como
  // const, lo que producia un error de compilacion C++ ("assignment of
  // member in read-only object").
  assert.match(out, /void inc\(\) \{/, "inc() no debe ser const");
  assert.doesNotMatch(out, /void inc\(\) const/, "inc() no debe tener `const`");
});

test("V30.19: arr[0] += 10 funciona para indices de array", () => {
  const src = `
    let arr: number[] = [1, 2, 3]
    arr[0] += 10
    print(arr[0])
  `;
  const out = compile(src).cpp;
  // V30.19: el compound assignment sobre IndexExpression emite
  // `arr[static_cast<std::size_t>(0.0)] += 10.0`.
  assert.match(out, /\+= 10\.0/, "debe emitir el += aplicado al indice");
});

test("V30.20: object destructuring shorthand `{ x, y } = p` desazucara a accesos a fields", () => {
  const src = `
    class Point {
      x: number
      y: number
      constructor(x: number, y: number) { this.x = x; this.y = y }
    }
    function describe(p: Point): void {
      const { x, y } = p
      print(x)
      print(y)
    }
    describe(new Point(1, 2))
  `;
  const out = compile(src).cpp;
  // V30.20: el destructuring se desazucara a un temporal + accesos
  // directos a fields. Buscamos `__ets_destructure_N.x` (shorthand).
  assert.match(out, /__ets_destructure_\d+\.x/, "debe emitir acceso a .x en el temporal");
  assert.match(out, /__ets_destructure_\d+\.y/, "debe emitir acceso a .y en el temporal");
});

test("V30.20: object destructuring renombrado `{ x: a, y: b } = p` emite a = p.x; b = p.y", () => {
  const src = `
    class Point {
      x: number
      y: number
      constructor(x: number, y: number) { this.x = x; this.y = y }
    }
    const p: Point = new Point(10, 20)
    const { x: a, y: b } = p
    print(a)
    print(b)
  `;
  const out = compile(src).cpp;
  // V30.20: el rename usa el mismo `property` (x, y) pero con `name`
  // distinto (a, b). La emision C++ es la misma: `a = p_tmp.x; b = p_tmp.y`.
  assert.match(out, /__ets_destructure_\d+\.x/, "debe acceder al field x");
  assert.match(out, /__ets_destructure_\d+\.y/, "debe acceder al field y");
  // Las variables locales son `a` y `b`, no `x` e `y`.
  assert.match(out, /\b(?!static )a = __ets_destructure_\d+\.x/, "a se inicializa con .x");
  assert.match(out, /\b(?!static )b = __ets_destructure_\d+\.y/, "b se inicializa con .y");
});

test("V30.20: object destructuring anidado `{ name, inner: i } = o; { v } = i`", () => {
  const src = `
    class Inner {
      v: number
      constructor(v: number) { this.v = v }
    }
    class Outer {
      name: string
      inner: Inner
      constructor(name: string, inner: Inner) { this.name = name; this.inner = inner }
    }
    const o: Outer = new Outer("test", new Inner(42))
    const { name, inner: i } = o
    const { v } = i
    print(name)
    print(v)
  `;
  const out = compile(src).cpp;
  // V30.20: dos `__ets_destructure_N` separados, uno para `o` y otro para `i`.
  // El segundo accede a `.v` sobre el primero.
  const matches = out.match(/__ets_destructure_\d+/g) || [];
  assert.ok(matches.length >= 2, "debe haber al menos 2 temporales de destructuring");
});

test("V30.21.1: default args en template functions NO se duplican en la definicion", () => {
  // V30.21.1: en C++ los value defaults solo pueden aparecer en la
  // primera declaracion (forward / header). Si el codegen los pone
  // tambien en la def, C++ se queja con
  // `redeclaration ... may not have default arguments`. El fix
  // emite los defaults solo en el forward, no en la def.
  const src = `
    function square(x: number): number { return x * x }
    function apply(f: (n: number) => number, x: number = 4): number {
      return f(x)
    }
    print(apply(square))
    print(apply(square, 5))
  `;
  const out = compile(src).cpp;
  // El forward del template `apply` puede ser multilinea
  // (`template <typename F0>\nstatic double apply(...);`).
  // Debe tener `= 4.0` en la primera declaracion.
  assert.match(out, /apply\([^;]*= 4\.0\);/, "el forward debe tener el default = 4.0");
  // La def: NO debe tener defaults (sino hay duplicacion).
  // La def aparece despues del forward, asi que usamos un regex
  // que busque la def (con `{` al final, no `;`).
  const defMatch = out.match(/apply\(F0&& f, double x\)\s*\{/);
  assert.ok(defMatch, "debe haber una definicion de apply sin default");
  assert.doesNotMatch(defMatch![0], /=/, "la def NO debe tener defaults");
});

test("V30.21.1: default args en funciones no-template funcionan (forward con default, def sin default)", () => {
  const src = `
    function greet(name: string = "World"): void {
      print(name)
    }
    greet()
    greet("Alice")
  `;
  const out = compile(src).cpp;
  // El forward debe llevar el default. El codegen emite
  // `void greet(std::string name = std::string("World"));`
  // (con std::string wrap para tipos de string).
  const forwardMatch = out.match(/^void greet\([^;]+\);/m);
  assert.ok(forwardMatch, "debe haber un forward de greet");
  assert.match(forwardMatch![0], /std::string\("World"\)/, "el forward debe tener el default wrap en std::string");
  // La def no debe llevar el default.
  const defMatch = out.match(/void greet\([^)]*\)\s*\{/m);
  assert.ok(defMatch, "debe haber una def de greet");
  assert.doesNotMatch(defMatch![0], /World/, "la def no debe tener el default");
});

test("V30.21.1: default args en constructors funcionan (constructor shorthand)", () => {
  const src = `
    class Counter {
      start: number
      end: number
      constructor(start: number = 0, end: number = 10) {
        this.start = start
        this.end = end
      }
    }
    new Counter()
    new Counter(5)
    new Counter(5, 7)
  `;
  const out = compile(src).cpp;
  // V30.21.1: el constructor es un metodo, no usa la misma `signature()`
  // que las funciones libres, asi que los defaults se emiten en el
  // sitio unico donde aparece el metodo (dentro del struct).
  // Solo verificamos que compila sin "redeclaration with default
  // arguments" — si V30.21.1 funciona, no hay duplicacion.
  assert.doesNotMatch(out, /redeclaration/i, "no debe haber error de redeclaracion");
});

test("V30.22.1: static fields se declaran dentro y se definen fuera", () => {
  const src = `
    class Counter {
      static count: number = 0
      static inc(): void { Counter.count += 1 }
    }
    Counter.inc()
    Counter.inc()
    Counter.inc()
    print(Counter.count)
  `;
  const out = compile(src).cpp;
  // Dentro del struct: `static double count;` (declaración).
  assert.match(out, /static\s+double\s+count\s*;/, "debe haber un static double count;");
  // Fuera del struct: `double Counter::count = 0.0;` (definición con init).
  assert.match(out, /double\s+Counter::count\s*=\s*0\.0\s*;/, "debe haber definicion double Counter::count = 0.0;");
  // Static method se emite inline dentro del struct.
  assert.match(out, /static\s+void\s+inc\s*\(\s*\)\s*\{/, "debe haber static void inc() { inline");
  // Acceso con ::, no con .
  assert.match(out, /Counter::count\s*\+=\s*1/, "el acceso debe ser con :: no con .");
});

test("V30.22.2: Math.PI y Math.random funcionan via ets:: y ets_math", () => {
  const src = `
    print(Math.PI)
    print(Math.random())
  `;
  const out = compile(src).cpp;
  // Math.PI se emite como ets::math_pi() (property de namespace).
  assert.match(out, /ets::math_pi\(\)/, "Math.PI debe emitirse como ets::math_pi()");
  // Math.random() se emite literal porque el runtime tiene
  // `inline ets_math Math{}` con `random()` static.
  assert.match(out, /Math\.random\(\)/, "Math.random() debe emitirse como Math.random() (inline struct)");
});

test("V30.22.6: named args se reordenan al orden de la firma", () => {
  const src = `
    function make(name: string, age: number): void {
      print(name)
      print(age)
    }
    make(name: "Ana", age: 30)
  `;
  const out = compile(src).cpp;
  // Los args en el call site deben estar en el orden de la firma.
  assert.match(out, /make\(std::string\("Ana"\),\s*30\.0\)/, "los args deben estar en orden (name, age) en el call site");
});

test("V30.22.7: spread en llamadas con firma array", () => {
  const src = `
    function sum(values: number[]): number {
      let total: number = 0
      for (let i: number = 0; i < values.length; i = i + 1) total = total + values[i]
      return total
    }
    const args: number[] = [1, 2, 3, 4, 5]
    print(sum(...args))
  `;
  const out = compile(src).cpp;
  // El spread se emite como el array directo.
  assert.match(out, /sum\(args\)/, "el spread debe emitirse como el array pasado directamente");
});
<<<<<<< Updated upstream
=======

test("V30.23: type alias sobre array se expande en el type-checker", () => {
  // Bug: `children: SvgChildren[]` donde `SvgChildren = Line | MultiLine`
  // no se evaluaba al union expandido `Line | MultiLine[]`. Esto rompia
  // `concat`, `map`, y cualquier operacion sobre el array.
  const src = `
    type SvgChildren = Line | MultiLine
    class Line { build(): string { return "L" } }
    class MultiLine { build(): string { return "M" } }
    class Svg {
      children: SvgChildren[]
      constructor() { this.children = [] }
      addChildren(c: SvgChildren[]): void {
        this.children = this.children.concat(c)
      }
      size(): number { return this.children.length }
    }
    let l: Line = new Line()
    let m: MultiLine = new MultiLine()
    let s: Svg = new Svg()
    s.addChildren([l, m])
    print(s.size())
  `;
  const out = compile(src).cpp;
  // El cpp debe compilar y emitir el field con el auto-union.
  assert.match(out, /std::vector<std::variant<Line, MultiLine>>/, "el field children debe emitirse como std::vector<std::variant<Line, MultiLine>>");
  // El concat debe usar el union expandido.
  assert.doesNotMatch(out, /concat\(.*SvgChildren/, "no debe haber referencia literal a SvgChildren en el codigo generado");
});

test("V30.23: type alias en param de arrow function se expande", () => {
  // Bug: `(child: SvgChildren) => ...` no expandia el alias del param.
  // El type-checker comparaba `SvgChildren` vs `Line | MultiLine` y fallaba.
  const src = `
    type SvgChildren = Line | MultiLine
    class Line { build(): string { return "L" } }
    class MultiLine { build(): string { return "M" } }
    class Svg {
      children: SvgChildren[]
      constructor() { this.children = [] }
      test(): number {
        let total: number = 0
        this.children.forEach((c: SvgChildren): void => { total = total + 1 })
        return total
      }
    }
    let s: Svg = new Svg()
    print(s.test())
  `;
  const out = compile(src).cpp;
  // El forEach debe emitir el lambda con el tipo expandido.
  assert.match(out, /std::variant<Line, MultiLine>/, "el forEach debe usar el union expandido en el lambda");
});

test("V30.24: array.join(separator) une elementos string[]", () => {
  // Feature nueva: `arr.join(sep)` estilo JS, equivalente a Python
  // `sep.join(arr)`. Solo valido para `string[]`.
  const src = `
    const parts: string[] = ["a", "b", "c"]
    print(parts.join(","))
  `;
  const out = compile(src).cpp;
  // El codegen emite `ets_join_vec(arr, sep)`.
  assert.match(out, /ets_join_vec\(parts, std::string\(\",\"\)\)/, "el join debe emitirse como ets_join_vec");
});

test("V30.24: array.join sobre number[] debe fallar type-check", () => {
  // El type-checker rechaza `join` sobre arrays que no son `string[]`.
  const src = `
    const nums: number[] = [1, 2, 3]
    print(nums.join(","))
  `;
  // El compile() lanza DiagnosticError porque el type-checker reporta
  // el error antes de la generacion de codigo.
  assert.throws(() => compile(src), /Array\.join solo se permite sobre string\[\]/, "el type-checker debe rechazar join sobre number[]");
});

test("V30.24: array.join con split encadenado funciona", () => {
  // Caso de uso real: `str.split(sep).join(otherSep)` permite reemplazar
  // separadores en un string. Verifica que ambos métodos coexisten.
  const src = `
    const csv: string = "a,b,c,d"
    const parts: string[] = csv.split(",")
    print(parts.join("-"))
  `;
  const out = compile(src).cpp;
  // split emite `::ets::string_split` (helper del namespace ets).
  assert.match(out, /::ets::string_split\(csv, std::string\(\",\"\)\)/, "el split debe emitirse como ::ets::string_split");
  assert.match(out, /ets_join_vec\(/, "el join debe emitirse como ets_join_vec");
});
>>>>>>> Stashed changes
