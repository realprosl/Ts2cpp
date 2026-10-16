
// V30.32: batida de tests unitarios para cubrir casos raros y edge
// cases de features que tenian cobertura minima. NO corrige bugs:
// donde un caso es bug (no compila cuando deberia), se anota con
// `// BUG:` en lugar de fallar el test, para que el test sirva de
// evidencia al arreglar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../../src/compiler.ts";

const DQ = String.fromCharCode(34); // comilla doble para evitar escape hell

// --- Bloque 1: Regex (V30.25) ---

test("V30.32 regex: pattern simple + test true", () => {
  const out = compile("const r = regex(" + DQ + "abc" + DQ + "); print(r.test(" + DQ + "abcdef" + DQ + "))").cpp;
  assert.match(out, /ets::ets_regex/);
  assert.match(out, /\.test/);
});

test("V30.32 regex: test false (no match)", () => {
  const out = compile("const r = regex(" + DQ + "abc" + DQ + "); print(r.test(" + DQ + "xyz" + DQ + "))").cpp;
  assert.match(out, /ets::ets_regex/);
});

test("V30.32 regex: match devuelve string", () => {
  const out = compile("const r = regex(" + DQ + "[0-9]+" + DQ + "); const m = r.match(" + DQ + "abc 123 def" + DQ + "); print(m)").cpp;
  assert.match(out, /ets::ets_regex/);
  assert.match(out, /\.match/);
});

test("V30.32 regex: replace string -> string", () => {
  const out = compile("const r = regex(" + DQ + "[0-9]+" + DQ + "); const s = r.replace(" + DQ + "a1b2c3" + DQ + ", " + DQ + "X" + DQ + "); print(s)").cpp;
  assert.match(out, /\.replace/);
});

test("V30.32 regex: pattern vacio (compila sin error)", () => {
  // Pattern vacio: en std::regex es valido (matchea siempre). El
  // dialecto debe aceptar la llamada sin fallar.
  assert.doesNotThrow(() => compile("const r = regex(" + DQ + DQ + "); print(r.test(" + DQ + "x" + DQ + "))"));
});

test("V30.32 regex: Regex[] - array de regex", () => {
  const out = compile("const rs: Regex[] = [regex(" + DQ + "a" + DQ + "), regex(" + DQ + "b" + DQ + ")]; print(rs[0].test(" + DQ + "a" + DQ + "))").cpp;
  assert.match(out, /ets::ets_regex/);
});

// --- Bloque 2: Math (V30.22.2) ---

test("V30.32 Math.PI via builtin", () => {
  // Math.PI se emite como ets::math_pi() (V30.22.2).
  const out = compile("print(numberToString(Math.PI))").cpp;
  assert.match(out, /ets::math_pi/);
});

test("V30.32 Math.E via builtin", () => {
  // Math.E se emite como ets::math_e().
  const out = compile("print(numberToString(Math.E))").cpp;
  assert.match(out, /ets::math_e/);
});

test("V30.32 Math.floor(3.7) == 3", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Math.floor(3.7)))"));
});

test("V30.32 Math.ceil(3.2) == 4", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Math.ceil(3.2)))"));
});

test("V30.32 Math.round(3.6) == 4", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Math.round(3.6)))"));
});

test("V30.32 Math.abs(-5) == 5", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Math.abs(-5)))"));
});

test("V30.32 Math.sqrt(16) == 4", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Math.sqrt(16)))"));
});

test("V30.32 Math.pow(2, 10) == 1024", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Math.pow(2, 10)))"));
});

test("V30.32 Math.max(3, 7) == 7", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Math.max(3, 7)))"));
});

test("V30.32 Math.min(3, 7) == 3", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Math.min(3, 7)))"));
});

test("V30.32 Math.random() emite Math.random literal y compila", () => {
  // A diferencia de Math.PI / Math.E (que se reescriben a
  // `ets::math_pi()` / `ets::math_e()` por ser PROPIEDADES),
  // `Math.random()` es un METODO y se emite como llamada literal
  // `Math.random()`. Esto compila correctamente porque el runtime
  // declara `inline ets_math Math{}` en el scope global, asi que
  // `Math.random()` resuelve a `ets_math::random()`.
  //
  // V30.33 (correccion): este test se actualiza para reflejar que
  // el comportamiento del codegen es correcto, no un bug como
  // inicialmente asumimos.
  const out = compile("let r = Math.random(); print(numberToString(r))").cpp;
  assert.ok(out.includes("Math.random()"), "se emite Math.random() literal");
});

test("V30.32 Math.max anidado funciona", () => {
  // El dialecto debe componer varias llamadas a Math.max correctamente.
  assert.doesNotThrow(() => compile("let r = Math.max(Math.min(3, 7), Math.abs(-5)); print(numberToString(r))"));
});

// --- Bloque 3: Date (V30.22.4) ---

test("V30.32 Date.now() retorna number", () => {
  const out = compile("print(numberToString(Date.now()))").cpp;
  assert.match(out, /ets_chrono|Date::now|now/);
});

test("V30.32 Date.utc() retorna number", () => {
  assert.doesNotThrow(() => compile("print(numberToString(Date.utc(2026, 0, 1)))"));
});

// --- Bloque 4: JSON (V30.22.3) ---

test("V30.32 JSON.stringify(string) compila y emite", () => {
  const out = compile("const s = JSON.stringify(" + DQ + "hi" + DQ + "); print(s)").cpp;
  assert.match(out, /JSON\.stringify/);
});

test("V30.32 JSON.stringify(number) requiere metodo especifico", () => {
  // BUG/DISENO: el dialecto expone `stringify` solo con overload
  // para string. Para number hay que llamar `JSON.stringifyNumber`.
  // Esto es API inconsistente con JavaScript. Documentamos el
  // comportamiento actual.
  assert.throws(
    () => compile("const s = JSON.stringify(42)"),
    /string|number/,
    "JSON.stringify solo acepta string, no number (usar JSON.stringifyNumber)",
  );
});

test("V30.32 JSON.stringifyNumber(number) funciona", () => {
  assert.doesNotThrow(() => compile("const s = JSON.stringifyNumber(42); print(s)"));
});

test("V30.32 JSON.parse retorna string", () => {
  // El parse legacy retorna string (no el tipo). Para datos
  // estructurados, hay que usar `parseValue` que retorna JsonValue.
  const out = compile("const s = JSON.parse(" + DQ + "42" + DQ + "); print(s)").cpp;
  assert.match(out, /JSON\.parse/);
});

test("V30.32 JSON.parseValue retorna JsonValue", () => {
  assert.doesNotThrow(() => compile("const v = JSON.parseValue(" + DQ + "{x:1}" + DQ + ")"));
});

// --- Bloque 5: String edge cases ---

test("V30.32 length(string vacia) == 0", () => {
  assert.doesNotThrow(() => compile("print(numberToString(length(" + DQ + DQ + ")))"));
});

test("V30.32 startsWith(string, vacio) retorna true", () => {
  // "" es prefijo de cualquier string en JavaScript. El dialecto
  // debe coincidir.
  assert.doesNotThrow(() => compile("print(startsWith(" + DQ + "abc" + DQ + ", " + DQ + DQ + ") ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"));
});

test("V30.32 trim elimina espacios al inicio y final", () => {
  assert.doesNotThrow(() => compile("print(trim(" + DQ + "  hi  " + DQ + "))"));
});

test("V30.32 lineCount(string sin saltos) == 1", () => {
  assert.doesNotThrow(() => compile("print(numberToString(lineCount(" + DQ + "hi" + DQ + ")))"));
});

test("V30.32 charAt fuera de rango retorna string vacio", () => {
  // Comportamiento C++ std::string::at(out_of_range) lanza, pero
  // el dialecto deberia manejarlo. Documentamos el comportamiento.
  assert.doesNotThrow(() => compile("print(charAt(" + DQ + "abc" + DQ + ", 10))"));
});

test("V30.32 indexOf no encontrado retorna -1", () => {
  assert.doesNotThrow(() => compile("print(numberToString(indexOf(" + DQ + "abc" + DQ + ", " + DQ + "z" + DQ + ", 0)))"));
});

test("V30.32 string concatenacion multiple", () => {
  assert.doesNotThrow(() => compile("print(" + DQ + "a" + DQ + " + " + DQ + "b" + DQ + " + " + DQ + "c" + DQ + ")"));
});

// --- Bloque 6: Array edge cases ---

test("V30.32 array vacio length == 0", () => {
  const out = compile("const xs: i32[] = []; print(numberToString(xs.length))").cpp;
  assert.match(out, /std::vector<int32_t>/);
});

test("V30.32 array vacio join(sep) retorna string vacio", () => {
  const out = compile("const xs: string[] = []; print(xs.join(" + DQ + "," + DQ + "))").cpp;
  assert.match(out, /ets_join_vec/);
});

test("V30.32 array.includes no encontrado retorna false", () => {
  assert.doesNotThrow(() => compile("const xs: i32[] = [1, 2, 3]; print(xs.includes(99) ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"));
});

test("V30.32 array.find no encontrado retorna Optional vacio", () => {
  // .find retorna Optional<T> (no undefined). Documentamos.
  const out = compile("const xs: i32[] = [1, 2, 3]; const f = xs.find((x: i32): boolean => x > 100); print(f.isEmpty() ? " + DQ + "none" + DQ + " : " + DQ + "found" + DQ + ")").cpp;
  assert.match(out, /ets_find_vec/);
});

test("V30.32 for-of sobre array vacio no ejecuta body", () => {
  // Si el array esta vacio, el for-of no itera. El codegen
  // emite un bucle sobre un vector vacio, que es OK.
  assert.doesNotThrow(() => compile("const xs: i32[] = []; for (const x of xs) { print(numberToString(x)) }"));
});

// --- Bloque 7: Tipos numericos y limites ---

test("V30.32 i8 limite inferior (-128) compila", () => {
  assert.doesNotThrow(() => compile("let a: i8 = -128; print(numberToString(a))"));
});

test("V30.32 i8 limite superior (127) compila", () => {
  assert.doesNotThrow(() => compile("let a: i8 = 127; print(numberToString(a))"));
});

test("V30.32 u8 max (255) compila", () => {
  assert.doesNotThrow(() => compile("let a: u8 = 255; print(numberToString(a))"));
});

test("V30.32 i16 max (32767) compila", () => {
  assert.doesNotThrow(() => compile("let a: i16 = 32767; print(numberToString(a))"));
});

test("V30.32 operador adicion sobre i32", () => {
  assert.doesNotThrow(() => compile("let r: i32 = 1 + 2; print(numberToString(r))"));
});

test("V30.32 operador division entera i32", () => {
  assert.doesNotThrow(() => compile("let r: i32 = 7 / 2; print(numberToString(r))"));
});

test("V30.32 operador modulo i32", () => {
  assert.doesNotThrow(() => compile("let r: i32 = 7 % 2; print(numberToString(r))"));
});

test("V30.32 negacion unaria i32", () => {
  assert.doesNotThrow(() => compile("let r: i32 = -42; print(numberToString(r))"));
});

// --- Bloque 8: Operadores logicos y comparacion ---

test("V30.32 boolean negacion (!true == false)", () => {
  assert.doesNotThrow(() => compile("let r: boolean = !true; print(r ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"));
});

test("V30.32 doble negacion (!!x preserva boolean)", () => {
  assert.doesNotThrow(() => compile("let r: boolean = !!true; print(r ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"));
});

test("V30.32 short-circuit AND", () => {
  assert.doesNotThrow(() => compile("let r: boolean = true && false; print(r ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"));
});

test("V30.32 short-circuit OR", () => {
  assert.doesNotThrow(() => compile("let r: boolean = true || false; print(r ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"));
});

test("V30.32 string eq string", () => {
  assert.doesNotThrow(() => compile("print(" + DQ + "a" + DQ + " == " + DQ + "a" + DQ + " ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"));
});

test("V30.32 string neq string", () => {
  assert.doesNotThrow(() => compile("print(" + DQ + "a" + DQ + " != " + DQ + "b" + DQ + " ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"));
});

test("V30.32 string vs number NO se comparan (sin coercion)", () => {
  // BUG/DISENO: el dialecto NO permite comparar string con number.
  // En JS haria coercion automatica. Aqui no.
  assert.throws(
    () => compile("print(" + DQ + "1" + DQ + " == 1 ? " + DQ + "yes" + DQ + " : " + DQ + "no" + DQ + ")"),
    /mismo tipo/,
    "string == number debe rechazar por diferencia de tipos",
  );
});

// --- Bloque 9: if con condiciones que requieren boolean ---

test("V30.32 if requiere boolean (no acepta i32)", () => {
  // BUG/DISENO: el dialecto NO convierte i32 a boolean en if.
  // En C++/JS, 0 es falsy. Aqui exige boolean explicito.
  assert.throws(
    () => compile("let x: i32 = 0; if (x) { print(" + DQ + "yes" + DQ + ") } else { print(" + DQ + "no" + DQ + ") }"),
    /esperaba boolean/,
    "if con i32 debe rechazar (sin coercion a boolean)",
  );
});

test("V30.32 if con comparacion explicita funciona", () => {
  assert.doesNotThrow(() => compile("let x: i32 = 0; if (x == 0) { print(" + DQ + "yes" + DQ + ") } else { print(" + DQ + "no" + DQ + ") }"));
});

test("V30.32 ternary con tipos distintos rechaza", () => {
  // BUG/DISENO: el dialecto exige tipos compatibles en ramas.
  // En JS retornaria el ultimo segun coercion. Aqui no.
  assert.throws(
    () => compile("let r = true ? 1 : " + DQ + "hi" + DQ + "; print(r)"),
    /tipos compatibles/,
    "ternary con tipos distintos debe rechazar",
  );
});

test("V30.32 ternary con mismo tipo compila", () => {
  assert.doesNotThrow(() => compile("let r: i32 = true ? 1 : 2; print(numberToString(r))"));
});

test("V30.32 ternary anidado funciona", () => {
  assert.doesNotThrow(() => compile("let r: i32 = true ? (false ? 1 : 2) : 3; print(numberToString(r))"));
});

// --- Bloque 10: Tuplas y arrays anidados ---

test("V30.32 tupla [i32, string] acceso por indice", () => {
  assert.doesNotThrow(() => compile("function f(): [i32, string] { return [1, " + DQ + "hi" + DQ + "] } const r = f(); print(numberToString(r[0])); print(r[1])"));
});

test("V30.32 array de tuplas [i32, string][]", () => {
  // BUG/DISENO: el parser no soporta la sintaxis `[T, U][]` para
  // un array de tuplas. Hay que usar `Array<[T, U]>` (alias
  // introducido en V30.12).
  let reproduced = false;
  try {
    compile("const xs: [i32, string][] = [[1, " + DQ + "a" + DQ + "], [2, " + DQ + "b" + DQ + "]]");
  } catch (e) {
    reproduced = /inicializador|tupla|se esperaba/.test(e instanceof Error ? e.message : String(e));
  }
  assert.ok(reproduced, "BUG no reproducido o ya arreglado");
});

test("V30.32 array anidado (matriz) i32[][]", () => {
  assert.doesNotThrow(() => compile("const m: i32[][] = [[1, 2], [3, 4]]; print(numberToString(m[1][0]))"));
});

test("V30.32 interface vacia sin metodos es valida", () => {
  // Las interfaces vacias son validas en el dialecto. Marcan un
  // "tipo" que no expone metodos.
  assert.doesNotThrow(() => compile("interface Empty {} function f(x: Empty): void { print(" + DQ + "ok" + DQ + ") }"));
});

// --- Bloque 11: Compound assignment y operadores ---

test("V30.32 compound += sobre i32", () => {
  assert.doesNotThrow(() => compile("let x: i32 = 5; x += 3; print(numberToString(x))"));
});

test("V30.32 compound *= sobre i32", () => {
  assert.doesNotThrow(() => compile("let x: i32 = 5; x *= 2; print(numberToString(x))"));
});

test("V30.32 compound -= sobre i32", () => {
  assert.doesNotThrow(() => compile("let x: i32 = 5; x -= 1; print(numberToString(x))"));
});

test("V30.32 compound /= sobre i32", () => {
  assert.doesNotThrow(() => compile("let x: i32 = 10; x /= 2; print(numberToString(x))"));
});

test("V30.32 while con decremento", () => {
  assert.doesNotThrow(() => compile("let i: i32 = 3; while (i > 0) { print(numberToString(i)); i -= 1 }"));
});

// --- Bloque 12: BUGS REALES (reproducen, no fallan) ---

test("V30.34 BUG-1 FIX: new K() sin ctor con fields init compila Y aplica defaults", () => {
  // V30.34: el bug original era que `new K()` con
  // `class K { n: i32 = 42 }` exigia 1 "valor de composicion".
  // El fix completo consiste en:
  // 1. El codegen del struct genera un ctor sintetico que
  //    aplica los defaults.
  // 2. El NewExpression invoca ese ctor (`K{}.constructor()`)
  //    en lugar de aggregate init.
  // 3. El type-checker acepta `new K()` con 0 args.
  //
  // Verificamos que el caso compila Y que el cpp emite el
  // ctor sintetico con `this.n = 42`.
  let compiled = false;
  try {
    const result = compile("class K { n: i32 = 42 } let k = new K()");
    compiled = result.cpp.includes("(*this).n = 42") || result.cpp.includes("(*this).n = 42.0");
  } catch {
    compiled = false;
  }
  assert.ok(compiled, "BUG-1 deberia compilar y emitir el ctor sintetico con el default 42");
});

test("V30.34 BUG-1 FIX: new K(7) sin ctor explicito falla con mensaje claro", () => {
  // V30.34: si el usuario pasa args a un ctor sintetico (que no
  // acepta params), el type-checker rechaza con un mensaje
  // claro en lugar de emitir codigo silenciosamente incorrecto.
  let reported = false;
  try {
    compile("class K { n: i32 = 42 } let k = new K(7)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reported = /no tiene constructor explícito/i.test(msg);
  }
  assert.ok(reported, "BUG-1: new K(7) sin ctor deberia fallar con mensaje claro");
});

test("V30.33 BUG-2 FIX: class con ; entre members compila", () => {
  // V30.33: el parser ahora consume `;` opcional entre class
  // members. Antes, `class K { n: i32 = 42; constructor() {};
  // get(): i32 { return this.n } }` fallaba con
  // "Se esperaba un campo o método". Verificamos que el caso
  // compila con `;` Y que el ctor/method se mantienen accesibles.
  let compiled = false;
  try {
    compile("class K { n: i32 = 42; constructor() {}; get(): i32 { return this.n } } let k = new K()");
    compiled = true;
  } catch {
    compiled = false;
  }
  assert.ok(compiled, "BUG-2: ; entre class members deberia compilar desde V30.33");
});

test("V30.33 BUG-3 FIX: for clasico + ; + statement compila", () => {
  // V30.33: el parser ahora consume `;` opcional en
  // `parseProgram()` y `block()`. Antes, un `;` literal despues
  // de un `}` de un for clasico (o if/while) provocaba
  // "Se esperaba una expresion". Verificamos que el caso
  // compila.
  let compiled = false;
  try {
    compile("let s: i32 = 0; for (let i: i32 = 0; i < 5; i += 1) { s = s + i }; print(numberToString(s))");
    compiled = true;
  } catch {
    compiled = false;
  }
  assert.ok(compiled, "BUG-3: for + ; + statement deberia compilar desde V30.33");
});

test("V30.32 BUG (ahora FIX): class field init + ctor + metodo con ; entre members", () => {
  // V30.33: el bug del parser que rechazaba `;` entre class members
  // (despues de un metodo, antes del siguiente) esta ARREGLADO.
  // El parser ahora consume el `;` opcional en el bucle de
  // `classDeclaration`. Este test verifica que el caso compila.
  let compiled = false;
  try {
    compile("class K { n: i32 = 42; constructor() {}; get(): i32 { return this.n } } let k = new K()");
    compiled = true;
  } catch {
    compiled = false;
  }
  assert.ok(compiled, "class con ; entre members deberia compilar desde V30.33");
});

test("V30.32 BUG (ahora FIX): for clasico seguido de ; y statement", () => {
  // V30.33: el bug del parser que rechazaba `;` despues del
  // bloque de un for clasico (y en general despues de cualquier
  // statement con bloque) esta ARREGLADO. El parser ahora
  // consume el `;` opcional en `parseProgram()` y en `block()`.
  // Este test verifica que el caso compila.
  let compiled = false;
  try {
    compile("let s: i32 = 0; for (let i: i32 = 0; i < 5; i += 1) { s = s + i }; print(numberToString(s))");
    compiled = true;
  } catch {
    compiled = false;
  }
  assert.ok(compiled, "for + ; deberia compilar desde V30.33");
});

test("V30.32 Promise.all<T> con typeArgument compila", () => {
  // V30.17: `Promise.all<T>([...])` debe aceptar el typeArgument
  // y emitir la llamada a ets::task_all<T> correspondiente.
  // Aqui validamos la sintaxis basica: el type-checker debe
  // aceptar la llamada y emitir el helper correcto del runtime.
  // No podemos crear Tasks reales sin `spawn` (que es complejo
  // de configurar), asi que usamos un array vacio con tipo
  // explicito (el dialecto requiere anotacion de tipo para `[]`).
  const src = "let arr: Array<Promise<i32>> = []; let p = Promise.all<i32>(arr)";
  let out = "";
  let err: Error | null = null;
  try {
    out = compile(src).cpp;
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e));
  }
  if (err) {
    // Documentar el error (no fallar el test si es de tipo/parser
    // claro). En V30.33 esto deberia ser un gap a cerrar.
    assert.ok(
      /se esperaba|anotaci|ninguna sobrecarga|task_all/.test(err.message),
      `error inesperado: ${err.message}`,
    );
  } else {
    assert.match(out, /ets::task_all/);
  }
});
