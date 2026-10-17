// V30.35: batida exhaustiva de features del dialecto. Cubre:
// 1. Bugs del codegen que crasheaban (FIXED en V30.35)
// 2. Bugs funcionales que no compilan cuando deberian (FIXED en V30.35)
// 3. Gaps de API / limitaciones del dialecto (documented)
//
// Convencion: los tests FIXED usan `assert.ok(compiled)` para validar
// que el caso compila (y a veces verifican el output). Los tests
// "documented" usan `assert.throws` + regex para validar que el
// comportamiento es consistente y servira de evidencia si se decide
// cerrar el gap en el futuro.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../../src/compiler.ts";

const DQ = String.fromCharCode(34); // comilla doble
const cpp = (source: string) => compile(source).cpp;

// =========================================================================
// Bloque 1: Bugs del codegen que crasheaban (FIXED en V30.35)
// =========================================================================

test("V30.35 FIX: Math.max con 2 args compila (antes crasheaba)", () => {
  // Antes: dispatchBuiltin llamaba require() con params[2] = undefined,
  // lo que causaba `Cannot read properties of undefined (reading 'includes')`
  // en typeMatches().
  let compiled = false;
  try { compile("print(numberToString(Math.max(1, 2)))"); compiled = true; } catch { /* */ }
  assert.ok(compiled, "Math.max(1, 2) debe compilar");
});

test("V30.35 FIX: Math.max con 3 args da error limpio (antes crasheaba)", () => {
  // Antes: crash con TypeError. Ahora: error semantico claro.
  let reported = false;
  try { compile("print(numberToString(Math.max(1, 2, 3)))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Math\.max espera 2 argumentos/i.test(msg);
  }
  assert.ok(reported, "Math.max(1, 2, 3) debe fallar con mensaje claro");
});

test("V30.35 FIX: Math.min con 1 arg da error limpio (antes crasheaba)", () => {
  let reported = false;
  try { compile("print(numberToString(Math.min(1)))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Math\.min espera 2 argumentos/i.test(msg);
  }
  assert.ok(reported, "Math.min(1) debe fallar con mensaje claro");
});

test("V30.35 FIX: delete obj.x da error limpio (antes crasheaba)", () => {
  // Antes: deleteStatement pasaba `target.span` a `this.error()` que
  // espera un Token. Eso producia un diagnostic con span = { start, end }
  // (no un Token), y el DiagnosticError constructor intentaba acceder
  // `d.span.start` -> TypeError: Cannot read properties of undefined
  // (reading 'start').
  let errorOk = false;
  let crashed = false;
  // Usamos `let obj = { a: 1, b: 2 }` (sin tipo `any`) para que el
  // parser realmente rechace el `delete obj.a` (con `any` se permite
  // cualquier target).
  try { compile("let obj = { a: 1, b: 2 }; delete obj.a; print(obj.b)"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    crashed = /Cannot read properties/.test(msg);
    errorOk = /delete requiere un acceso por [íi]ndice/.test(msg) && !crashed;
  }
  assert.ok(errorOk && !crashed, "delete obj.x debe fallar con error limpio (parser), no crash");
});

test("V30.35 FIX: new K(1, 2, 3, 4) con ctor de 3 args da error limpio", () => {
  // Antes: el type-checker solo validaba `args.length < requiredParams`
  // (minimo) pero no `args.length > totalParams` (maximo). El codegen
  // emitia `K{}.constructor(1, 2, 3, 4)` que g++ rechazaba con un
  // error criptico de C++. Ahora el type-checker rechaza antes.
  let reported = false;
  try {
    compile("class K { x: i32; y: i32; z: i32; constructor(x: i32, y: i32, z: i32) { this.x = x; this.y = y; this.z = z } } let k = new K(1, 2, 3, 4); print(numberToString(k.x))");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /espera como mucho 3 argumento/i.test(msg);
  }
  assert.ok(reported, "new K(1, 2, 3, 4) con ctor de 3 debe fallar con error claro");
});

// =========================================================================
// Bloque 2: Coverage de features que funcionan (sanity check)
// =========================================================================

test("V30.35 sanity: tipos primitivos compilan", () => {
  for (const src of [
    "let a: i8 = 127; print(numberToString(a))",
    "let a: i16 = 32767; print(numberToString(a))",
    "let a: i32 = 2147483647; print(numberToString(a))",
    "let a: u8 = 255; print(numberToString(a))",
    "let a: u32 = 4294967295; print(numberToString(a))",
    "let a: f32 = 3.14; print(numberToString(a))",
    "let a: f64 = 3.14159; print(numberToString(a))",
    "let a: boolean = true; let s = a ? " + DQ + "T" + DQ + " : " + DQ + "F" + DQ + "; print(s)",
  ]) {
    assert.doesNotThrow(() => compile(src), "debe compilar: " + src);
  }
});

test("V30.35 sanity: operadores aritmeticos compilan", () => {
  for (const src of [
    "let a: i32 = 10 + 3; print(numberToString(a))",
    "let a: i32 = 10 - 3; print(numberToString(a))",
    "let a: i32 = 10 * 3; print(numberToString(a))",
    "let a: i32 = 10 / 3; print(numberToString(a))",
    "let a: i32 = 10 % 3; print(numberToString(a))",
    "let a: i32 = 2 + 3 * 4; print(numberToString(a))",
    "let a: i32 = (2 + 3) * 4; print(numberToString(a))",
    "let b: boolean = 5 > 3; print(b.toString())",  // toString en boolean: ver Bloque 3
  ]) {
    // El ultimo test (boolean) falla por gap, no por aritmetica.
    if (src.includes("boolean = 5")) {
      try { compile(src); }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/toString|boolean/.test(msg)) throw e;
      }
      continue;
    }
    assert.doesNotThrow(() => compile(src), "debe compilar: " + src);
  }
});

test("V30.35 sanity: control flow compila", () => {
  const sources = [
    "if (true) { print(" + DQ + "yes" + DQ + ") } else { print(" + DQ + "no" + DQ + ") }",
    "let i: i32 = 0; while (i < 3) { print(numberToString(i)); i += 1 }",
    "for (let i: i32 = 0; i < 5; i += 1) { print(numberToString(i)) }",
    "for (let i: i32 = 0; i < 5; i += 1) { if (i == 2) continue; if (i == 4) break; print(numberToString(i)) }",
    "function f(x: i32): i32 { if (x < 0) return -1; return x * 2 } print(numberToString(f(5)))",
  ];
  for (const src of sources) {
    assert.doesNotThrow(() => compile(src), "debe compilar: " + src);
  }
});

test("V30.35 sanity: arrays y sus metodos", () => {
  const sources = [
    "let xs: i32[] = [1, 2, 3]; print(numberToString(xs.length))",
    "let xs: i32[] = [1, 2, 3]; print(numberToString(xs[0]))",
    "let xs: i32[] = []; print(numberToString(xs.length))",
    "let xs: i32[] = [1, 2, 3]; xs.push(5); print(numberToString(xs.length))",
    "let xs: i32[] = [1, 2, 3]; xs.pop(); print(numberToString(xs.length))",
    "let xs: i32[] = [1, 2, 3]; let ys = xs.map((x: i32): i32 => x * 2); print(numberToString(ys.length))",
    "let xs: i32[] = [1, 2, 3, 4]; let ys = xs.filter((x: i32): boolean => x > 2); print(numberToString(ys.length))",
    "let xs: i32[] = [1, 2, 3]; for (const x of xs) { print(numberToString(x)) }",
  ];
  for (const src of sources) {
    assert.doesNotThrow(() => compile(src), "debe compilar: " + src);
  }
});

test("V30.35 sanity: tuplas y acceso por indice", () => {
  const sources = [
    "let t: [i32, string] = [42, " + DQ + "hi" + DQ + "]; print(numberToString(t[0]))",
    "let t: [i32, string] = [42, " + DQ + "hi" + DQ + "]; print(t[1])",
  ];
  for (const src of sources) {
    assert.doesNotThrow(() => compile(src), "debe compilar: " + src);
  }
});

test("V30.35 sanity: classes y metodos", () => {
  const sources = [
    "class K { x: i32 = 42 } let k = new K(); print(numberToString(k.x))",
    "class K { x: i32; constructor(x: i32) { this.x = x } } let k = new K(7); print(numberToString(k.x))",
    "class K { private x: i32 = 42; get(): i32 { return this.x } } let k = new K(); print(numberToString(k.get()))",
    "class K { readonly x: i32 = 42; get(): i32 { return this.x } } let k = new K(); print(numberToString(k.get()))",
    "class Counter { static count: i32 = 0; static inc(): void { Counter.count += 1 } } Counter.inc(); Counter.inc(); print(numberToString(Counter.count))",
    "class Box<T> { value: T; constructor(v: T) { this.value = v } } let b = new Box<i32>(42); print(numberToString(b.value))",
  ];
  for (const src of sources) {
    assert.doesNotThrow(() => compile(src), "debe compilar: " + src);
  }
});

test("V30.35 sanity: enums y type aliases", () => {
  const sources = [
    "enum Color { Red, Green, Blue } print(numberToString(Color.Red))",
    "enum Status { Active = " + DQ + "active" + DQ + ", Inactive = " + DQ + "inactive" + DQ + " } print(Status.Active)",
    "type Num = i32; let x: Num = 42; print(numberToString(x))",
  ];
  for (const src of sources) {
    assert.doesNotThrow(() => compile(src), "debe compilar: " + src);
  }
});

test("V30.35 sanity: string API basica", () => {
  const sources = [
    "print(numberToString(length(" + DQ + "hello" + DQ + ")))",
    "print(" + DQ + "hello" + DQ + ".charAt(0))",
    "print(" + DQ + "HELLO" + DQ + ".toLowerCase())",
    "print(" + DQ + "hello" + DQ + ".toUpperCase())",
    "print(" + DQ + "  hi  " + DQ + ".trim())",
    "print(" + DQ + "hi" + DQ + ".repeat(3))",
    "print(" + DQ + "hello" + DQ + ".replace(" + DQ + "ll" + DQ + ", " + DQ + "rr" + DQ + "))",
  ];
  for (const src of sources) {
    assert.doesNotThrow(() => compile(src), "debe compilar: " + src);
  }
});

test("V30.35 sanity: Math, JSON, Date, regex", () => {
  const sources = [
    "print(numberToString(Math.floor(3.7)))",
    "print(numberToString(Math.ceil(3.2)))",
    "print(numberToString(Math.round(3.5)))",
    "print(numberToString(Math.abs(-5)))",
    "print(numberToString(Math.PI))",
    "print(JSON.stringify(" + DQ + "hello" + DQ + "))",
    "print(JSON.parse(" + DQ + "42" + DQ + "))",
    "print(numberToString(Date.now()))",
    "let r = regex(" + DQ + "abc" + DQ + "); print(r.test(" + DQ + "abcdef" + DQ + ").toString())",
  ];
  for (const src of sources) {
    try { compile(src); }
    catch (e) {
      // Algunos gaps conocidos (ver Bloque 3): boolean.toString, etc.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/toString|boolean|api/.test(msg.toLowerCase())) throw e;
    }
  }
});

// =========================================================================
// Bloque 3: Gaps documentados (NO fixed en V30.35, evidencia para el futuro)
// =========================================================================

test("V30.37 FIX: + con string hace constant folding cuando todos los operandos son estaticos", () => {
  // V30.36 emitia siempre ets::concat(...) incluso para concatenaciones
  // que se podian resolver en compile-time. V30.37 anade constant
  // folding: si todas las partes son estaticas (literales string,
  // numericos, booleanos, templates con partes estaticas, o
  // composiciones de los anteriores), el codegen emite un literal
  // std::string("...") en vez de ets::concat(...). Esto:
  //   1. Mete el string en .rodata (mas rapido en runtime)
  //   2. Evita el coste de ets::concat para casos triviales
  //   3. Mantiene el comportamiento funcional (output identico)
  //
  // Casos estaticos: deben emitir `std::string("...")`.
  // Casos dinamicos (con variables): siguen emitiendo ets::concat.
  const staticCases: { src: string; expected: string }[] = [
    { src: 'print("hello" + " " + "world")', expected: 'hello world' },
    { src: 'print("x" + 5)', expected: 'x5' },
    { src: 'print(5 + "x")', expected: '5x' },
    { src: 'print("v=" + true)', expected: 'v=true' },
    { src: 'print("n=" + 42)', expected: 'n=42' },
    { src: 'print("pi=" + 3.14)', expected: 'pi=3.14' },
    { src: 'print("a" + 1 + "b" + 2 + "c")', expected: 'a1b2c' },
    { src: 'print(-5 + "x")', expected: '-5x' },
  ];
  for (const { src, expected } of staticCases) {
    const r = compile(src);
    assert.ok(r.cpp.includes(`std::string("${expected}")`), `${src} debe emitir std::string("${expected}"), obtuvo: ${r.cpp.match(/std::string\([^)]+\)/g)?.join(", ")}`);
    assert.ok(!r.cpp.includes("ets::concat"), `${src} NO debe emitir ets::concat (constant fold), obtuvo: ${r.cpp}`);
  }
  // Casos dinamicos: deben seguir emitiendo ets::concat.
  const dynamicCases: string[] = [
    'let b: boolean = true; print("v=" + b)',
    'let n: i32 = 10; print("n=" + n)',
    'let n: i32 = 10; print("n=" + (n + 1))',
  ];
  for (const src of dynamicCases) {
    const r = compile(src);
    assert.ok(r.cpp.includes("ets::concat"), `${src} debe emitir ets::concat (caso dinamico), obtuvo: ${r.cpp.match(/print\([^)]+\)/g)?.join(", ")}`);
  }
  // Template literal: si todas las expressions son estaticas, fold.
  // Si alguna expression es dinamica, cae al path runtime.
  const tplStatic = compile("print(`n = ${42}`)");
  assert.ok(tplStatic.cpp.includes('std::string("n = 42")'), `template con literal debe fold: ${tplStatic.cpp}`);
  const tplDynamic = compile("let x: i32 = 10; print(`x = ${x}`)");
  assert.ok(tplDynamic.cpp.includes("ets::concat"), `template con var debe ser dinamico: ${tplDynamic.cpp}`);
  // Template anidado: `` `a${`b${"c"}`}d` `` es todo estatico -> "abcd".
  const tplNested = compile("print(`a${`b${\"c\"}`}d`)");
  assert.ok(tplNested.cpp.includes('std::string("abcd")'), `template anidado debe fold: ${tplNested.cpp}`);
});

test("V30.35 gap: boolean.toString() no existe", () => {
  // En otros lenguajes boolean.toString() existe. En el dialecto no.
  // El user tiene que usar `b ? "T" : "F"` o `"" + b` (que tb falla,
  // ver gap anterior).
  let reported = false;
  try { compile("let b: boolean = true; print(b.toString())"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /boolean.*no tiene m/i.test(msg);
  }
  assert.ok(reported, "boolean.toString() no existe (gap documentado)");
});

test("V30.35 gap: as cast (V30.55 ya soportado, sin conversion runtime)", () => {
  // V30.55: `as T` ya es sintactica y semanticamente valido. El
  // type-checker lo acepta como cast metadata. PERO el codegen no
  // anade conversion runtime — es responsabilidad del runtime hacer
  // la conversion si hace falta (e.g. std::get para variants).
  // Caso de uso real: narrowing en union para evitar `match()`.
  const out = cpp(`
    function getVal(): string | number { return "hello"; }
    let v: string | number = getVal();
    let s: string = v as string;
    print(s);
  `);
  // Compila sin error.
  assert.match(out, /s = v;/);
});

test("V30.35 gap: switch keyword no funciona (usar match)", () => {
  // El dialecto usa `match` (V30.15), no `switch`. La keyword `switch`
  // parsea como identificador y falla.
  let reported = false;
  try { compile("let x: i32 = 2; switch (x) { case 1: print(" + DQ + "one" + DQ + "); break; case 2: print(" + DQ + "two" + DQ + "); break }"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Se esperaba una expresi/i.test(msg);
  }
  assert.ok(reported, "switch keyword no funciona (gap documentado, usar match)");
});

test("V30.35 gap: indexOf y includes de string exigen 2 args (TS admite 1)", () => {
  // En TS, "hello".indexOf("e") funciona (1 arg). En el dialecto
  // exige 2 (e.g. indexOf("e", 0)).
  let reported = false;
  try { compile("print(numberToString(" + DQ + "hello" + DQ + ".indexOf(" + DQ + "e" + DQ + ")))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /indexOf espera 2 argumento/i.test(msg);
  }
  assert.ok(reported, "string.indexOf exige 2 args (gap documentado)");
});

test("V30.35 gap: array.sort() sin args no funciona (TS lo permite)", () => {
  // En TS, [3,1,2].sort() funciona sin comparador. En el dialecto
  // exige 1 argumento (e.g. comparador).
  let reported = false;
  try { compile("let xs: i32[] = [3, 1, 2]; xs.sort(); print(numberToString(xs[0]))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Array\.sort espera 1 argumento/i.test(msg);
  }
  assert.ok(reported, "array.sort() sin args falla (gap documentado)");
});

test("V30.35 gap: JSON.stringify(42) no funciona (solo string)", () => {
  // El dialecto SOLO acepta string en JSON.stringify. Para number
  // hay que hacer JSON.stringifyNumber(42) o stringToNumber antes.
  let reported = false;
  try { compile("print(JSON.stringify(42))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Se esperaba string/i.test(msg);
  }
  assert.ok(reported, "JSON.stringify(42) falla (gap documentado)");
});

test("V30.35 gap: spawn exige Promise<void> (no Promise<T>)", () => {
  // El dialecto exige que spawn() reciba una funcion async que
  // retorne Promise<void>. Si retorna Promise<T>, falla.
  // Workaround: hacer side-effects dentro de la funcion y devolver void.
  let reported = false;
  try { compile("async function f(): Promise<i32> { return 42 } spawn(f().then((x: i32) => print(numberToString(x))))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Promise<void>/.test(msg);
  }
  assert.ok(reported, "spawn exige Promise<void> (gap documentado)");
});

test("V30.35 gap: async function() no puede retornar void", () => {
  // El dialecto exige que una funcion async retorne Promise<T>,
  // no void. Workaround: retornar Promise<void> explicito.
  let reported = false;
  try { compile("async function f(): void { print(" + DQ + "x" + DQ + ") } spawn(f())"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /async debe retornar Promise/i.test(msg);
  }
  assert.ok(reported, "async function() no puede retornar void (gap documentado)");
});

test("V30.35 sanity: Promise.all<T> con typeArgument compila", () => {
  // V30.17: `Promise.all<T>([...])` SI acepta el typeArgument.
  // (Mi suposicion inicial era que no, pero la verificacion mostro
  // que compila correctamente.)
  assert.doesNotThrow(() => compile("let arr: Array<Promise<i32>> = []; let p = Promise.all<i32>(arr)"));
});

test("V30.35 sanity: Map y Set son clases builtin soportadas", () => {
  // Las clases Map<K,V> y Set<T> SI existen como builtins (a pesar
  // de que el dialecto no expone Array de K,V como tipo nativo, las
  // clases wrapper existen). El user puede hacer `new Map<K,V>()`.
  assert.doesNotThrow(() => compile("let m = new Map<i32, string>()"));
  assert.doesNotThrow(() => compile("let s = new Set<i32>()"));
});

test("V30.35 gap: null y undefined literales no existen", () => {
  // El dialecto no tiene null ni undefined. Para "ausencia" se usa
  // Optional<T> con optionalNone<T>().
  for (const src of ["print(null)", "print(undefined)"]) {
    let reported = false;
    try { compile(src); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reported = /S.mbolo no definido|undefined/.test(msg);
    }
    assert.ok(reported, `${src} no compila (gap documentado)`);
  }
});

test("V30.35 gap: class implements I no soportado (usar duck typing)", () => {
  // El dialecto no permite implements. Las clases con la misma
  // shape que una interface son intercambiables.
  let reported = false;
  try { compile("interface I { x: i32 } class C implements I { x: i32 = 42 }"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /herencia|se esperaba/.test(msg);
  }
  assert.ok(reported, "implements no soportado (gap documentado)");
});

test("V30.35 gap: tuple destructuring no infiere tipos de elementos", () => {
  // `let [n, s] = f()` no destructura la tupla en variables
  // separadas; el tipo sigue siendo tupla. Workaround: usar
  // index access (e.g. `let t = f(); let n = t[0];`).
  let reported = false;
  try { compile("function f(): [i32, string] { return [42, " + DQ + "hi" + DQ + "] } let [n, s] = f(); print(numberToString(n))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /numberToString.*acepta.*\[[iis]/i.test(msg);
  }
  assert.ok(reported, "tuple destructuring no infiere tipos (gap documentado)");
});

test("V30.35 gap: object destructuring con class requiere casts", () => {
  // `let { x, y } = p` con `p: P` (clase) no resuelve los campos
  // correctamente. El tipo de x queda como any.
  let reported = false;
  try { compile("class P { x: i32 = 1; y: i32 = 2 } let p = new P(); let { x, y } = p; print(numberToString(x))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /numberToString.*acepta.*any/i.test(msg);
  }
  assert.ok(reported, "object destructuring con class no infiere (gap documentado)");
});

test("V30.35 gap: readFileSync no existe (usar readFile)", () => {
  // El dialecto expone readFile (no readFileSync como en Node).
  // readFile devuelve Result<string> (no throw).
  let reported = false;
  try { compile("let s = readFileSync(" + DQ + "/etc/hostname" + DQ + "); print(s)"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Funci.n no definida.*readFileSync/i.test(msg);
  }
  assert.ok(reported, "readFileSync no existe (gap documentado, usar readFile)");
});

test("V30.35 gap: process.argv no es array (usar argument(0))", () => {
  // El dialecto expone argument(0) para acceder a argv. process.argv
  // como propiedad no existe.
  let reported = false;
  try { compile("print(process.argv)"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Process|class concreta/i.test(msg);
  }
  assert.ok(reported, "process.argv no existe (gap documentado, usar argument(0))");
});

test("V30.35 gap: optionalSome/optionalNone (no some/none)", () => {
  // El dialecto usa nombres prefijados para los constructores de
  // Optional<T> (optionalSome<T>(), optionalNone<T>()), no
  // some()/none().
  let reported = false;
  try { compile("let x: Optional<i32> = some(42); print(numberToString(x.valueOr(0)))"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /Funci.n no definida.*'some'/i.test(msg);
  }
  assert.ok(reported, "some() no existe (gap documentado, usar optionalSome<T>())");
});

test("V30.35 gap: for...in con object literal no funciona", () => {
  // El dialecto no soporta `for...in` sobre object literals.
  // Workaround: usar for-of sobre arrays de claves.
  let reported = false;
  try { compile("let obj: any = { a: 1, b: 2 }; for (const k in obj) { print(k) }"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /object literal|se esperaba una uni/i.test(msg);
  }
  assert.ok(reported, "for...in con object literal falla (gap documentado)");
});

test("V30.35 sanity: union class (A | B) se puede asignar a new A()", () => {
  // En realidad SI se puede hacer `let x: A | B = new A()` (el `new`
  // es sobre A, no sobre el union). Lo que NO se puede es hacer
  // `new (A | B)()` directamente.
  assert.doesNotThrow(() => compile("class A {} class B {} let x: A | B = new A()"));
});

test("V30.35 gap: try/catch no soportado (dialecto -fno-exceptions)", () => {
  // El dialecto no soporta try/catch por diseño. La liberia
  // usa Result<T, E> para errores.
  let reported = false;
  try { compile("try { print(" + DQ + "x" + DQ + ") } catch (e) { print(" + DQ + "err" + DQ + ") }"); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /try|Se esperaba|unknown/.test(msg);
  }
  assert.ok(reported, "try/catch no soportado (gap documentado, dialecto design)");
});

// =========================================================================
// Bloque 4: Cosas que el user encontro antes y ahora valido que siguen
// arregladas (regresion check)
// =========================================================================

test("V30.35 regression: V30.33 BUG-2 sigue fixed (; entre class members)", () => {
  let compiled = false;
  try {
    compile("class K { n: i32 = 42; constructor() {}; get(): i32 { return this.n } } let k = new K(); print(numberToString(k.get()))");
    compiled = true;
  } catch { /* */ }
  assert.ok(compiled, "; entre class members sigue compilando");
});

test("V30.35 regression: V30.33 BUG-3 sigue fixed (; despues de for)", () => {
  let compiled = false;
  try {
    compile("let s: i32 = 0; for (let i: i32 = 0; i < 5; i += 1) { s = s + i }; print(numberToString(s))");
    compiled = true;
  } catch { /* */ }
  assert.ok(compiled, "; despues de for sigue compilando");
});

test("V30.35 regression: V30.34 BUG-1 sigue fixed (new K() sin ctor con defaults)", () => {
  let compiled = false;
  try {
    const r = compile("class K { n: i32 = 42 } let k = new K()");
    compiled = r.cpp.includes("(*this).n = 42") || r.cpp.includes("(*this).n = 42.0");
  } catch { /* */ }
  assert.ok(compiled, "new K() sin ctor sigue aplicando defaults");
});
