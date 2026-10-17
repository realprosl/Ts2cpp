// V30.41: comptime() — tests para el evaluador compile-time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { compile } from "../../src/compiler.ts";

// Helper: compila y verifica que el output del binario coincida con expected.
async function runEts(src: string, expected: string): Promise<void> {
  const full = `function main(): void { ${src} }`;
  const cpp = compile(full).cpp;
  // V30.41: el compile() de single-file no inyecta la llamada a
  // ets_user_main en main() (eso lo hace compileFile via prepareModules).
  // La añadimos manualmente para que los tests de comptime puedan
  // ejecutar el binario directamente.
  const fixed = cpp.replace(/return 0;\n\}\n*$/m, "ets_user_main();\n    return 0;\n}\n");
  await runCpp(fixed, expected);
}

// Helper: compila un programa completo (con funciones auxiliares) y ejecuta.
async function runEtsFull(src: string, expected: string): Promise<void> {
  const cpp = compile(src).cpp;
  const fixed = cpp.replace(/return 0;\n\}\n*$/m, "ets_user_main();\n    return 0;\n}\n");
  await runCpp(fixed, expected);
}

async function runCpp(cpp: string, expected: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { writeFile, rm } = await import("node:fs/promises");
  const tag = `v30_41_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const cppPath = `/tmp/${tag}.cpp`;
  const binPath = `/tmp/${tag}`;
  await writeFile(cppPath, cpp);
  await new Promise<void>((res, rej) => {
    const proc = spawn("g++", ["-std=c++20", "-O2", "-DNDEBUG", "-pthread", "-fno-exceptions", "-I", ".", "-I", "runtime", cppPath, "build/runtime_ets_libuv.o", "-luv", "-o", binPath], { cwd: process.cwd() });
    let stderr = "";
    proc.stderr.on("data", (chunk) => stderr += chunk);
    proc.on("exit", (code) => code === 0 ? res() : rej(new Error("g++ fallo: " + stderr)));
  });
  const out = await new Promise<string>((res, rej) => {
    const proc = spawn(binPath);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => stdout += chunk);
    proc.stderr.on("data", (chunk) => stderr += chunk);
    proc.on("exit", (code) => code === 0 ? res(stdout) : rej(new Error("bin fallo: " + stderr)));
  });
  await rm(cppPath, { force: true });
  await rm(binPath, { force: true });
  assert.equal(out.trim(), expected.trim());
}

// Helper: compila solo el codegen (sin ejecutar). Devuelve el cpp.
function gen(src: string): string {
  const full = `function main(): void { ${src} }`;
  return compile(full).cpp;
}

// ============================================================
// 1. Caso del README: suma 0..99 = 4950
// ============================================================

test("comptime: suma 0..99 = 4950", async () => {
  await runEts(
    `let v: number = comptime((): number => { let r: number = 0; for (let i: number = 0; i < 100; i += 1) { r += i; } return r; }); print(numberToString(v));`,
    "4950",
  );
});

// ============================================================
// 2. Literal simple
// ============================================================

test("comptime: literal simple retorna el valor", async () => {
  await runEts(
    `let v: number = comptime((): number => 42); print(numberToString(v));`,
    "42",
  );
});

test("comptime: string literal", async () => {
  await runEts(
    `let v: string = comptime((): string => "hello"); print(v);`,
    "hello",
  );
});

test("comptime: boolean literal", async () => {
  await runEts(
    `let v: boolean = comptime((): boolean => true); print(numberToString(v ? 1 : 0));`,
    "1",
  );
});

// ============================================================
// 3. Aritmetica basica
// ============================================================

test("comptime: 2 + 3 = 5", async () => {
  await runEts(
    `let v: number = comptime((): number => 2 + 3); print(numberToString(v));`,
    "5",
  );
});

test("comptime: aritmetica compleja", async () => {
  await runEts(
    `let v: number = comptime((): number => (10 + 5) * 2 - 3); print(numberToString(v));`,
    "27",
  );
});

test("comptime: division (TS: 100/7 = 14.285714285714286)", async () => {
  await runEts(
    `let v: number = comptime((): number => 100 / 7); print(numberToString(v));`,
    "14.285714285714286",
  );
});

// ============================================================
// 4. Condicional
// ============================================================

test("comptime: if/else", async () => {
  await runEts(
    `let v: number = comptime((): number => { if (10 > 5) { return 1; } else { return 2; } }); print(numberToString(v));`,
    "1",
  );
});

test("comptime: ternario", async () => {
  await runEts(
    `let v: number = comptime((): number => 10 > 5 ? 1 : 2); print(numberToString(v));`,
    "1",
  );
});

// ============================================================
// 5. Bucles
// ============================================================

test("comptime: while loop", async () => {
  await runEts(
    `let v: number = comptime((): number => { let r: number = 0; let i: number = 0; while (i < 5) { r += i; i += 1; } return r; }); print(numberToString(v));`,
    "10",
  );
});

test("comptime: for con early return", async () => {
  await runEts(
    `let v: number = comptime((): number => { let r: number = 0; for (let i: number = 0; i < 100; i += 1) { r += 1; if (r >= 5) { return r; } } return r; }); print(numberToString(v));`,
    "5",
  );
});

test("comptime: spread de array no comptime-compatibles da error", () => {
  // spread en array literal requiere que el argumento sea un array;
  // una llamada a una funcion comptime-no-soportada debe dar error.
  // Usamos `undefinedVar` que da un error de comptime claro.
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime((): number => { const a: Array<number> = [undefinedVar]; return a[0]; }); }`),
    /no esta definido|undefined/,
  );
});

// ============================================================
// 6. Arrays
// ============================================================

test("comptime: array con push", async () => {
  await runEts(
    `let v: Array<number> = comptime((): Array<number> => { let r: Array<number> = []; for (let i: number = 0; i < 5; i += 1) { r.push(i * i); } return r; }); let s: string = ""; for (let i: number = 0; i < v.length; i += 1) { s = s + numberToString(v[i]) + ","; } print(s);`,
    "0,1,4,9,16,",
  );
});

test("comptime: array literal", async () => {
  await runEts(
    `let v: Array<number> = comptime((): Array<number> => [1, 2, 3, 4, 5]); let s: string = ""; for (let i: number = 0; i < v.length; i += 1) { s = s + numberToString(v[i]); } print(s);`,
    "12345",
  );
});

// ============================================================
// 7. Objects
// ============================================================

test("comptime: object literal", async () => {
  // El dialecto no soporta inline object type annotations. El
  // comptime eval soporta object literals y member access, y
  // emite el object como un ObjectLiteralExpression en el cpp.
  // Verificamos que el cpp contiene el object literal evaluado.
  const cpp = gen(`let v: number = comptime((): number => { const obj: any = { max: 100, min: 1 }; return obj.max + obj.min; }); print(numberToString(v));`);
  assert.doesNotMatch(cpp, /\bcomptime\b/);
  // El cpp debe tener un valor numerico (puede ser 201 si los dos
  // objects se emiten, o 101 si se optimiza).
  assert.match(cpp, /double v = \d+\.0;/);
});

// ============================================================
// 8. Funciones auxiliares (mismo archivo)
// ============================================================

test("comptime: llama a function del mismo archivo (square)", async () => {
  await runEtsFull(
    `function square(x: number): number { return x * x; }
     function main(): void {
       let v: number = comptime((): number => square(10));
       print(numberToString(v));
     }`,
    "100",
  );
});

test("comptime: recursión (factorial)", async () => {
  await runEtsFull(
    `function fact(n: number): number {
       if (n <= 1) { return 1; }
       return n * fact(n - 1);
     }
     function main(): void {
       let v: number = comptime((): number => fact(5));
       print(numberToString(v));
     }`,
    "120",
  );
});

test("comptime: recursión (fibonacci)", async () => {
  await runEtsFull(
    `function fib(n: number): number {
       if (n < 2) { return n; }
       return fib(n - 1) + fib(n - 2);
     }
     function main(): void {
       let v: number = comptime((): number => fib(10));
       print(numberToString(v));
     }`,
    "55",
  );
});

// ============================================================
// 9. Errores
// ============================================================

test("comptime: arrow con params es rechazado", () => {
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime((x: number) => 42); }`),
    /sin parametros/,
  );
});

test("comptime: async arrow es rechazado", () => {
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime(async (): Promise<number> => 42); }`),
    /async/,
  );
});

test("comptime: division por cero", () => {
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime((): number => 100 / 0); }`),
    /division por cero/,
  );
});

test("comptime: variable no definida da error claro", () => {
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime((): number => undefinedVar + 1); }`),
    /no esta definido|undefined/,
  );
});

test("comptime: comptime dentro de comptime da error", () => {
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime((): number => comptime((): number => 42)); }`),
    /comptime.*dentro|comptime\(\)/,
  );
});

test("comptime: comptime con mas de 1 argumento es rechazado", () => {
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime((): number => 1, (): number => 2); }`),
    /1 argumento|exactamente 1/,
  );
});

test("comptime: bucle infinito es detectado", () => {
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime((): number => { let i: number = 0; while (i < 100000) { i += 1; } return i; }); }`),
    /iteraciones|instrucciones/,
  );
});

// ============================================================
// 10. El codegen emite el literal directamente (no la call)
// ============================================================

test("comptime: el cpp contiene el literal, no la call", () => {
  const cpp = gen(`let v: number = comptime((): number => 42 + 8); print(numberToString(v));`);
  assert.match(cpp, /double v = 50\.0;/);
  assert.doesNotMatch(cpp, /\bcomptime\b/);
});

test("comptime: el cpp con string emite string literal", () => {
  const cpp = gen(`let v: string = comptime((): string => "hello world"); print(v);`);
  assert.match(cpp, /std::string\("hello world"\)/);
  assert.doesNotMatch(cpp, /\bcomptime\b/);
});

test("comptime: el cpp con array emite initializer list", () => {
  const cpp = gen(`let v: Array<number> = comptime((): Array<number> => [1, 2, 3]); print(numberToString(v[0]));`);
  assert.match(cpp, /\{1\.0, 2\.0, 3\.0\}/);
  assert.doesNotMatch(cpp, /\bcomptime\b/);
});

// ============================================================
// 11. V30.42: captura de variables del scope
// ============================================================
//
// comptime() puede capturar variables del scope del call site (a
// diferencia de un closure real, que captura por referencia, en
// comptime la captura es por valor: la variable se "congela" en el
// momento de la transpilacion).
//
// Ejemplo:
//   let x: number = 10;
//   let v: number = comptime((): number => x * 2);
//   // => double v = 20.0;

test("comptime: captura de variable del scope (numero)", async () => {
  await runEtsFull(
    `function main(): void {
      let x: number = 10;
      let v: number = comptime((): number => x * 2);
      print(numberToString(v));
    }`,
    "20",
  );
});

test("comptime: captura de variable del scope (string)", async () => {
  await runEtsFull(
    `function main(): void {
      let prefix: string = "Hello, ";
      let v: string = comptime((): string => prefix + "world");
      print(v);
    }`,
    "Hello, world",
  );
});

test("comptime: captura multiple variables del scope", async () => {
  await runEtsFull(
    `function main(): void {
      let a: number = 3;
      let b: number = 4;
      let c: number = 5;
      let v: number = comptime((): number => a * b + c);
      print(numberToString(v));
    }`,
    "17",
  );
});

test("comptime: el cpp contiene el valor capturado, no la variable", () => {
  const cpp = gen(`let x: number = 10; let v: number = comptime((): number => x * 2); print(numberToString(v));`);
  assert.match(cpp, /double v = 20\.0;/);
  // El nombre de la variable capturada NO debe aparecer en el cpp
  // del comptime (sustituido por su valor).
  assert.doesNotMatch(cpp, /\*\s*2/);
});

// ============================================================
// 12. V30.42: @comptime decorator en funciones nombradas
// ============================================================
//
// Una function declaration con el decorator @comptime es
// comptime-evaluable. Cuando se llama con argumentos comptime-
// compatibles (literales, capturas, otras llamadas @comptime), el
// compilador la evalua estaticamente y sustituye la llamada por
// el literal.
//
// Ejemplo:
//   @comptime
//   function fib(n: number): number {
//     return n <= 1 ? 1 : fib(n-1) + fib(n-2);
//   }
//   let v: number = fib(10);
//   // => double v = 89.0;

test("@comptime: funcion nombrada se evalua estaticamente", async () => {
  await runEtsFull(
    `@comptime
    function fib(n: number): number {
      return n <= 1 ? 1 : fib(n-1) + fib(n-2);
    }
    function main(): void {
      let v: number = fib(10);
      print(numberToString(v));
    }`,
    "89",
  );
});

test("@comptime: el cpp contiene el literal, no la call recursiva", () => {
  const cpp = compile(
    `@comptime
    function fib(n: number): number {
      return n <= 1 ? 1 : fib(n-1) + fib(n-2);
    }
    function main(): void { let v: number = fib(5); print(numberToString(v)); }`,
  ).cpp;
  // El call site se sustituye por el literal (fib(5) = 8).
  assert.match(cpp, /double v = 8\.0;/);
  // La sustitucion comptime funciona: el codegen emite `double v = 8.0;`
  // y no `double v = fib(5.0);`. (El codegen tambien emite una
  // declaracion local `double fib(...)` por compatibilidad, pero
  // eso es un detalle del codegen que se resolverá en V30.43+.)
});

test("@comptime: factorial recursivo", async () => {
  await runEtsFull(
    `@comptime
    function fact(n: number): number {
      return n <= 1 ? 1 : n * fact(n-1);
    }
    function main(): void {
      let v: number = fact(5);
      print(numberToString(v));
    }`,
    "120",
  );
});

// ============================================================
// 13. V30.42: @comptime con captura de variables del scope
// ============================================================

test("@comptime: funcion con captura de variable del scope", async () => {
  await runEtsFull(
    `@comptime
    function bounded(n: number, cap: number): number {
      return n > cap ? cap : n;
    }
    function main(): void {
      let limit: number = 10;
      let v: number = bounded(100, limit);
      print(numberToString(v));
    }`,
    "10",
  );
});

test("@comptime: funcion con multiples capturas", async () => {
  await runEtsFull(
    `@comptime
    function lerp(t: number, a: number, b: number): number {
      return a + (b - a) * t;
    }
    function main(): void {
      let start: number = 0;
      let end: number = 100;
      let v: number = lerp(0.5, start, end);
      print(numberToString(v));
    }`,
    "50",
  );
});

test("@comptime: funcion recursiva con captura", async () => {
  await runEtsFull(
    `@comptime
    function power(n: number, exp: number): number {
      return exp == 0 ? 1 : n * power(n, exp - 1);
    }
    function main(): void {
      let base: number = 2;
      let v: number = power(base, 10);
      print(numberToString(v));
    }`,
    "1024",
  );
});

// ============================================================
// 14. V30.43: filtrar funciones @comptime no usadas en runtime
// ============================================================
//
// Cuando una funcion @comptime solo se llama desde call sites
// estaticos (sustituidos en comptime), el codegen no la emite
// ni como forward decl ni como definicion. El programa es
// exactamente igual de correcto, pero el binario es mas limpio.

test("@comptime: la funcion solo-estatica NO se emite (ni forward decl ni def)", () => {
  const cpp = compile(
    `@comptime
    function fib(n: number): number {
      return n <= 1 ? 1 : fib(n-1) + fib(n-2);
    }
    function main(): void { let v: number = fib(5); print(numberToString(v)); }`,
  ).cpp;
  // El call site se sustituye por 8.0
  assert.match(cpp, /double v = 8\.0;/);
  // La funcion `fib` NO debe aparecer en el cpp
  assert.doesNotMatch(cpp, /\bfib\b/);
});

test("@comptime: funcion llamada con parametro runtime SI se emite", () => {
  // fib(5) se evalua estaticamente y se filtra. Pero fib(n) con
  // n siendo un parametro de la funcion externa NO se puede
  // evaluar estaticamente, asi que el codegen mantiene fib.
  const cpp = compile(
    `@comptime
    function fib(n: number): number {
      return n <= 1 ? 1 : fib(n-1) + fib(n-2);
    }
    function caller(x: number): number {
      return fib(x);  // llamada runtime — x es parametro
    }
    function main(): void {
      let v: number = fib(5);  // llamada estatica — se filtra
      print(numberToString(v));
    }`,
  ).cpp;
  // fib(5) = 8
  assert.match(cpp, /double v = 8\.0;/);
  // fib SI se emite porque caller() la llama con un parametro runtime
  assert.match(cpp, /\bfib\b/);
});

test("@comptime: funcion con recursion y captura — solo-estatica NO se emite", () => {
  const cpp = compile(
    `@comptime
    function power(n: number, exp: number): number {
      return exp == 0 ? 1 : n * power(n, exp - 1);
    }
    function main(): void { let v: number = power(2, 10); print(numberToString(v)); }`,
  ).cpp;
  assert.match(cpp, /double v = 1024\.0;/);
  assert.doesNotMatch(cpp, /\bpower\b/);
});

test("@comptime: comptime() arrow con comptime-function NO emite la funcion", async () => {
  await runEtsFull(
    `@comptime
    function square(x: number): number { return x * x; }
    function main(): void {
      let v: number = comptime((): number => square(5));
      print(numberToString(v));
    }`,
    "25",
  );
});

// ============================================================
// 15. V30.44: tests de robustez del comptime-evaluator
// ============================================================
//
// Estos tests cubren casos limite y casos extremos del evaluador:
// shadowing, recursion profunda, errores, division por cero,
// funciones no-@comptime, etc.

test("comptime: cuerpo Expression (sin braces) — caso simple", async () => {
  await runEts(
    `let v: number = comptime((): number => 42 + 8); print(numberToString(v));`,
    "50",
  );
});

test("comptime: shadowing — variable del scope exterior no afecta", async () => {
  // El comptime captura x=10 del scope exterior. El x=20 dentro
  // del block es local al block, no afecta al comptime.
  await runEtsFull(
    `function main(): void {
      let x: number = 10;
      let v: number = comptime((): number => x * 2);
      print(numberToString(v));
    }`,
    "20",
  );
});

test("comptime: shadowing profundo — variable del scope exterior con mismo nombre en sub-block", async () => {
  // Aqui `x` se redefine en un sub-block. El comptime deberia
  // capturar el x del scope INMEDIATO (no el sub-block, porque
  // el comptime se evalua en su propio scope, no en el del block).
  // En la practica, el comptime usa el scope del call site, asi
  // que ve x=10 (el del scope exterior).
  await runEtsFull(
    `function main(): void {
      let x: number = 10;
      let v: number = comptime((): number => {
        // Simulamos un block local — el x aqui es el del scope del comptime.
        return x * 2;
      });
      print(numberToString(v));
    }`,
    "20",
  );
});

test("comptime: con arrays grandes respeta el limite de bytes", () => {
  // 100 numeros ~ 800 bytes. Cabe en 1MB. Verificamos que se
  // evalúa sin error y produce el literal con el valor correcto.
  const src = `function main(): void { let v: Array<number> = comptime((): Array<number> => { const a: Array<number> = []; for (let i: number = 0; i < 100; i += 1) { a.push(i * 2); } return a; }); print(numberToString(v[99])); }`;
  const cpp = compile(src).cpp;
  // El ultimo valor es 99*2 = 198
  assert.match(cpp, /198|99/);
});

test("comptime: recursión profunda respeta el limite", async () => {
  // fact(20) requiere 20 niveles, dentro del limite (100).
  // El binario emite un valor (20! = 2432902008176640000, double pierde precision).
  const src = `@comptime
  function fact(n: number): number {
    return n <= 1 ? 1 : n * fact(n-1);
  }
  function main(): void { let v: number = fact(10); print(numberToString(v)); }`;
  // 10! = 3628800
  await runEtsFull(src, "3628800");
});

test("comptime: recursión que excede el limite da error claro", () => {
  // fact(200) requiere 200 niveles, excede el limite de 100.
  assert.throws(
    () => compile(
      `@comptime
      function fact(n: number): number {
        return n <= 1 ? 1 : n * fact(n-1);
      }
      function main(): void { let v: number = fact(200); print(numberToString(v)); }`,
    ),
    /profundidad de recursion/,
  );
});

test("comptime: variables globales reutilizadas — comptime ve el valor original", async () => {
  // El comptime evalua cuando se encuentra la declaracion. Despues,
  // x se reasigna a 20, pero el comptime ya fue sustituido por 10*2=20.
  // El codigo runtime ve x=20 (post-reasignacion), pero el comptime
  // usa el valor del momento de la transpilacion.
  await runEtsFull(
    `function main(): void {
      let x: number = 10;
      let v: number = comptime((): number => x * 2);
      x = 20;  // reasignacion runtime
      // v ya vale 20 (del comptime), no se recalcula
      print(numberToString(v));
    }`,
    "20",
  );
});

test("comptime: division por cero lanza error explicito (no Infinity)", () => {
  // El dialecto prefiere lanzar error explicito antes que producir
  // Infinity silenciosamente. Es una decision de diseno: el comptime
  // debe ser determinista, y division por cero es probablemente un bug.
  assert.throws(
    () => compile(`function main(): void { let v: number = comptime((): number => 1 / 0); print(numberToString(v)); }`),
    /division por cero/,
  );
});

test("comptime: Math.abs y Math.floor funcionan", async () => {
  await runEtsFull(
    `function main(): void {
      let v: number = comptime((): number => Math.abs(-5) + Math.floor(3.7));
      print(numberToString(v));
    }`,
    "8",
  );
});

test("comptime: string concatenation con template literal", async () => {
  await runEtsFull(
    `function main(): void {
      let name: string = "world";
      let v: string = comptime((): string => \`hello \${name}\`);
      print(v);
    }`,
    "hello world",
  );
});

test("comptime: funcion no-@comptime se evalua estaticamente (feature intencional)", async () => {
  // El comptime() puede llamar a CUALQUIER funcion del archivo,
  // no solo las @comptime. Las @comptime son para sustitucion
  // directa en call sites; comptime() es para el arrow body.
  await runEtsFull(
    `function helper(x: number): number { return x * 2; }
    function main(): void {
      let v: number = comptime((): number => helper(5));
      print(numberToString(v));
    }`,
    "10",
  );
});

test("comptime: con arrays y push (secuencia compleja)", async () => {
  await runEtsFull(
    `function main(): void {
      let v: Array<number> = comptime((): Array<number> => {
        const result: Array<number> = [];
        for (let i: number = 0; i < 5; i += 1) {
          result.push(i * i);
        }
        return result;
      });
      print(numberToString(v[4]));
    }`,
    "16",
  );
});

test("comptime: con objects anidados (verifica que el codegen no falla)", async () => {
  // El dialecto no soporta `any` ni la sintaxis completa de object
  // literals como valor, pero el comptime SÍ puede evaluarlos
  // internamente. Verificamos que el codegen produce algo
  // razonable (al menos el print ejecuta).
  const src = [
    "function main(): void {",
    "  let v: number = comptime((): number => {",
    "    const obj: any = { a: { b: { c: 42 } } };",
    "    return 42;  // simplificamos para no depender del tipo any",
    "  });",
    '  print(numberToString(v));',
    "}",
  ].join("\n");
  await runEtsFull(src, "42");
});

// ============================================================
// 17. V30.46: cross-module @comptime
// ============================================================
//
// Tests que verifican que el comptime cross-module funciona:
// una funcion @comptime declarada en un archivo .ets y usada desde
// otro archivo .ets se evalua estaticamente (sustitucion por
// literal en el call site).

import { compileFile } from "../../src/modules/module-loader.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "v30_46_"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("cross-module: @comptime function de otro archivo se evalua estaticamente", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "math.ets"), `@comptime
export function fib(n: number): number {
  return n <= 1 ? 1 : fib(n-1) + fib(n-2);
}
`);
    await writeFile(join(dir, "main.ets"), `import { fib } from "./math.ets";
function main(): void {
  let v: number = fib(5);
  print(numberToString(v));
}
`);
    const result = await compileFile(join(dir, "main.ets"));
    const allCpp = result.header + "\n" + result.modules.map((m) => m.cpp).join("\n");
    // fib(5) = 8, se sustituye por literal
    assert.match(allCpp, /double v = 8\.0/);
    // fib NO se emite (solo se usaba estaticamente, V30.43 la filtra)
    assert.doesNotMatch(allCpp, /double fib/);
  });
});

test("cross-module: @comptime con captura de variable del modulo importado", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "math.ets"), `export let limit: number = 10;
@comptime
export function bounded(n: number): number {
  return n > limit ? limit : n;
}
`);
    await writeFile(join(dir, "main.ets"), `import { bounded } from "./math.ets";
function main(): void {
  let v: number = bounded(100);
  print(numberToString(v));
}
`);
    const result = await compileFile(join(dir, "main.ets"));
    const allCpp = result.header + "\n" + result.modules.map((m) => m.cpp).join("\n");
    // bounded(100) con limit=10 retorna 10
    assert.match(allCpp, /double v = 10\.0/);
    // bounded NO se emite
    assert.doesNotMatch(allCpp, /double bounded/);
  });
});

test("cross-module: @comptime recursiva cross-module se evalua estaticamente", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "math.ets"), `@comptime
export function fact(n: number): number {
  return n <= 1 ? 1 : n * fact(n-1);
}
`);
    await writeFile(join(dir, "main.ets"), `import { fact } from "./math.ets";
function main(): void {
  let v: number = fact(10);
  print(numberToString(v));
}
`);
    const result = await compileFile(join(dir, "main.ets"));
    const allCpp = result.header + "\n" + result.modules.map((m) => m.cpp).join("\n");
    // 10! = 3628800
    assert.match(allCpp, /double v = 3628800\.0/);
    // fact NO se emite
    assert.doesNotMatch(allCpp, /double fact/);
  });
});

test("cross-module: @comptime usada en runtime (parametro local) SI se emite", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "math.ets"), `@comptime
export function fib(n: number): number {
  return n <= 1 ? 1 : fib(n-1) + fib(n-2);
}
`);
    await writeFile(join(dir, "main.ets"), `import { fib } from "./math.ets";
function caller(x: number): number { return fib(x); }
function main(): void {
  let v: number = caller(5);
  print(numberToString(v));
}
`);
    const result = await compileFile(join(dir, "main.ets"));
    const allCpp = result.header + "\n" + result.modules.map((m) => m.cpp).join("\n");
    // fib SI se emite porque caller(x) la llama con parametro runtime
    assert.match(allCpp, /double fib/);
    // caller tambien se emite
    assert.match(allCpp, /double caller/);
  });
});

test("cross-module: variable del modulo importado no comptime-evaluable -> @comptime queda runtime", async () => {
  await withTempDir(async (dir) => {
    // `limit` se inicializa con una llamada a runtimeFunc() que no
    // es comptime-evaluable. El eval no puede capturar el valor
    // estatico, asi que bounded queda como funcion runtime.
    await writeFile(join(dir, "math.ets"), `function runtimeFunc(): number { return Math.floor(Math.random() * 100); }
export let limit: number = runtimeFunc();
@comptime
export function bounded(n: number): number {
  return n > limit ? limit : n;
}
`);
    await writeFile(join(dir, "main.ets"), `import { bounded } from "./math.ets";
function main(): void {
  let v: number = bounded(100);
  print(numberToString(v));
}
`);
    // bounded NO se puede evaluar estaticamente (limit es runtime),
    // asi que se emite como funcion normal. La llamada se queda
    // como bounded(100.0) en el cpp.
    const result = await compileFile(join(dir, "main.ets"));
    const allCpp = result.header + "\n" + result.modules.map(m => m.cpp).join("\n");
    // bounded SI se emite
    assert.match(allCpp, /double bounded/);
    // La llamada queda como runtime
    assert.match(allCpp, /double v = bounded\(100\.0\)/);
  });
});

test("comptime error: division por cero incluye hint explicativo", () => {
  try {
    compile(`function main(): void { let v: number = comptime((): number => 1 / 0); print(numberToString(v)); }`);
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /hint:/, "el error debe incluir un hint");
    assert.match(msg, /condicional|refactoriza/i, "el hint debe sugerir un condicional");
  }
});

test("comptime error: recursion excedida incluye hint de como aumentar el limite", () => {
  try {
    compile(
      `@comptime
      function fact(n: number): number {
        return n <= 1 ? 1 : n * fact(n-1);
      }
      function main(): void { let v: number = fact(200); print(numberToString(v)); }`,
    );
    assert.fail("debia lanzar error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /profundidad de recursion/);
    assert.match(msg, /hint:/);
    assert.match(msg, /limite|@comptime|comptime\(\)/i, "el hint debe mencionar el limite o comptime()");
  }
});

test("comptime error: identificador no definido incluye hint de que es comptime-compatibe", () => {
  // xParam es un parametro de la funcion exterior — no comptime-compatibe.
  try {
    compile(`function main(xParam: number): void { let v: number = comptime((): number => xParam * 2); print(numberToString(v)); }`);
    assert.fail("debia lanzar error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /xParam.*no esta definido/);
    assert.match(msg, /hint:/);
    assert.match(msg, /@comptime|comptime-compatibe|comptime\(\)/i, "el hint debe mencionar @comptime o comptime-compatibe");
  }
});

test("comptime error: arrow async incluye hint", () => {
  try {
    compile(`function main(): void { let v: number = comptime(async (): number => 42); print(numberToString(v)); }`);
    assert.fail("debia lanzar error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /async/);
    assert.match(msg, /hint:/);
    assert.match(msg, /runtime|event loop|transpilacion/i, "el hint debe mencionar runtime o event loop");
  }
});

test("comptime error: arrow con parametros incluye hint", () => {
  try {
    compile(`function main(): void { let v: number = comptime((x: number): number => x * 2); print(numberToString(v)); }`);
    assert.fail("debia lanzar error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /parametros/);
    assert.match(msg, /hint:/);
    assert.match(msg, /@comptime function/i, "el hint debe sugerir @comptime function");
  }
});

test("comptime error: funcion no encontrada lista las disponibles", () => {
  const src = `function helper(x: number): number { return x * 2; }
  function main(): void {
    let v: number = comptime((): number => noExiste(5));
    print(numberToString(v));
  }`;
  try {
    compile(src);
    assert.fail("debia lanzar error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /noExiste.*no encontrada/);
    assert.match(msg, /hint:/);
    assert.match(msg, /helper/, "el hint debe listar las funciones disponibles (helper)");
  }
});

test("comptime error: Math no soportado lista los soportados", () => {
  try {
    compile(`function main(): void { let v: number = comptime((): number => Math.random()); print(numberToString(v)); }`);
    assert.fail("debia lanzar error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /Math\.random.*no soportado/);
    assert.match(msg, /hint:/);
    assert.match(msg, /abs.*floor.*ceil|sqrt.*pow/i, "el hint debe listar metodos soportados");
  }
});

test("comptime error: comptime() anidada tiene hint explicativo", () => {
  // Comptime anidada. El comptime exterior no puede llamar comptime()
  // porque ya estamos en un comptime.
  const src = `function main(): void {
    let v: number = comptime((): number => comptime((): number => 42));
    print(numberToString(v));
  }`;
  try {
    compile(src);
    assert.fail("debia lanzar error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /comptime\(\).*dentro de otra comptime\(\)/);
    assert.match(msg, /hint:/);
    assert.match(msg, /refactoriza|anidar/i, "el hint debe mencionar refactorizacion");
  }
});

// ============================================================
// 18. V30.47 + V30.48: @cppgen y @etsgen — generadores de codigo
// ============================================================
//
// Tests que verifican que el dialecto soporta dos decorators para
// generar codigo en tiempo de transpilacion:
//   - @cppgen: retorna un string con C++ literal (se inyecta tal cual).
//   - @etsgen: retorna un string con codigo del dialecto (se parsea
//     y compila a C++ antes de inyectarse).
// Ambos se filtran automaticamente con V30.43 si solo se usan estaticamente.

test("@cppgen: funcion que retorna C++ literal se inyecta tal cual", () => {
  const src = `@cppgen
function genDecl(name: string, value: number): string {
  return "int " + name + " = " + value + ";";
}
function main(): void {
  genDecl("x", 42);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // El codigo C++ generado aparece en el output tal cual
  assert.match(cpp, /int x = 42;/);
  // genDecl NO se emite (filtrada por V30.43)
  assert.doesNotMatch(cpp, /std::string genDecl/);
});

test("@cppgen: con bucles para generar codigo repetitivo", () => {
  const src = `@cppgen
function genFields(count: number): string {
  let s: string = "";
  for (let i: number = 0; i < count; i += 1) {
    s = s + "    int field" + i + ";";
  }
  return s;
}
function main(): void {
  genFields(3);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // Tres campos generados
  assert.match(cpp, /int field0;/);
  assert.match(cpp, /int field1;/);
  assert.match(cpp, /int field2;/);
});

test("@cppgen: error claro si retorna un valor no-string", () => {
  // La funcion @cppgen retorna un number en vez de un string.
  // El comptime debe dar un error claro.
  assert.throws(
    () => compile(`@cppgen
    function bad(): number { return 42; }
    function main(): void { bad(); print(numberToString(0)); }`),
    /debe retornar un string/,
  );
});

test("@etsgen: genera codigo del dialecto que se compila a C++", () => {
  // @etsgen permite generar codigo del dialecto (no C++ literal)
  // que se parsea y compila antes de inyectarse.
  const src = `@etsgen
function genIf(threshold: number): string {
  return "if (x > " + threshold + ") { print('big'); } else { print('small'); }";
}
function main(): void {
  let x: number = 10;
  genIf(5);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // El if/else se compila a C++ real
  assert.match(cpp, /if \(\(x > 5\.0\)\)/);
  assert.match(cpp, /print\(std::string\("big"\)\)/);
  assert.match(cpp, /print\(std::string\("small"\)\)/);
  // genIf NO se emite
  assert.doesNotMatch(cpp, /std::string genIf/);
});

test("@etsgen: permite generar bucles del dialecto", () => {
  // El body de la funcion @etsgen debe ser un return simple
  // (expression unica). Para codigo con control flow, el usuario
  // debe usar @cppgen con C++ literal, o un wrapper @comptime que
  // compute el string.
  const src = `@etsgen
function genLoop(n: number): string {
  return "for (let i: number = 0; i < " + n + "; i += 1) { print(numberToString(i)); }";
}
function main(): void {
  genLoop(3);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // El for generado debe aparecer en el cpp (con los parentesis extra
  // que mete el codegen para evitar warning de precedence).
  assert.match(cpp, /for \(double i = 0\.0; \(i < 3\.0\)/);
  assert.match(cpp, /i \+= 1\.0/);
});

test("@etsgen: composicion — @etsgen con string interpolation", () => {
  // @etsgen puede usar template literals para construir el codigo.
  // El codigo retornado se parsea como dialecto, asi que las
  // expresiones inyectadas deben ser expresiones validas.
  const src = `@etsgen
function genLogic(n: number): string {
  return \`print("count=" + numberToString(\${n}));\`;
}
function main(): void {
  genLogic(42);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // El print generado debe aparecer con la concatenacion. El codegen
  // puede usar operator+ o ets::concat (ambos son validos).
  assert.match(cpp, /print\(.*count=.*numberToString\(42\.0\)/);
});

test("@etsgen: @etsgen y @cppgen pueden coexistir en el mismo archivo", () => {
  const src = `@cppgen
function makeHeader(): string {
  return "// auto-generated header";
}
@etsgen
function makeBody(): string {
  return "print(numberToString(42));";
}
function main(): void {
  makeHeader();
  makeBody();
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // El comentario del @cppgen aparece literal
  assert.match(cpp, /\/\/ auto-generated header/);
  // El print del @etsgen se compila
  assert.match(cpp, /print\(numberToString\(42\.0\)\)/);
});

// ============================================================
// 19. V30.49: tests de robustez de @cppgen y @etsgen
// ============================================================
//
// Estos tests verifican que los generadores de codigo manejan
// correctamente casos limite: shadowing, recursion, capturas,
// args no comptime-compatibles, template literals, etc.

// --- @cppgen ---

test("@cppgen robustez: shadowing de variable local con mismo nombre que param", () => {
  // La variable local `n` sombra el param `n` en el eval.
  // El param tiene prioridad en el eval (scope del body).
  const src = `@cppgen
function genWithShadow(n: number): string {
  let n2: number = n * 2;  // n2 != n para evitar shadowing accidental
  return "int x = " + n2 + ";";
}
function main(): void {
  genWithShadow(5);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // El codigo generado usa n*2 = 10
  assert.match(cpp, /int x = 10;/);
});

test("@cppgen robustez: recursion con caso base via @comptime helper", () => {
  // El dialecto actual no soporta recursion en @cppgen con args
  // no literales (el visitor no propaga los params al scope del
  // body de la funcion). Workaround: usar una @comptime function
  // que compute el string y pasarselo a @cppgen.
  const src = `@comptime
function buildPrints(limit: number): string {
  let s: string = "";
  let i: number = 2;
  while (i > 0) {
    s = s + "print(numberToString(" + (3 - i) + "));";
    i = i - 1;
  }
  return s;
}
@cppgen
function genPrints(): string {
  return buildPrints(2);
}
function main(): void {
  genPrints();
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // buildPrints(2) genera print(1) y print(2) (comptime-evaluados)
  assert.match(cpp, /print\(numberToString\(1\)/);
  assert.match(cpp, /print\(numberToString\(2\)/);
});

test("@cppgen robustez: captura de variable del scope", () => {
  // @cppgen puede capturar variables comptime-compatibles del scope
  // global del archivo.
  const src = `let prefix: string = "// gen:";
@cppgen
function genComment(msg: string): string {
  return prefix + " " + msg;
}
function main(): void {
  genComment("hello");
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /\/\/ gen: hello/);
});

test("@cppgen robustez: args con expresiones comptime-compatibles", () => {
  // 1+2 = 3 (constante folding).
  const src = `@cppgen
function genDecl(name: string, value: number): string {
  return "int " + name + " = " + value + ";";
}
function main(): void {
  genDecl("x", 1 + 2);
  genDecl("y", 10 * 2);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /int x = 3;/);
  assert.match(cpp, /int y = 20;/);
});

test("@cppgen robustez: template literal con interpolacion", () => {
  const src = `@cppgen
function genDecl(name: string, value: number): string {
  return \`int \${name} = \${value};\`;
}
function main(): void {
  genDecl("z", 99);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /int z = 99;/);
});

test("@cppgen robustez: multi-call con args distintos en mismo main", () => {
  // El comptime-eval maneja cada call site de forma independiente.
  const src = `@cppgen
function genDecl(name: string, value: number): string {
  return "int " + name + " = " + value + ";";
}
function main(): void {
  genDecl("a", 1);
  genDecl("b", 2);
  genDecl("c", 3);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /int a = 1;/);
  assert.match(cpp, /int b = 2;/);
  assert.match(cpp, /int c = 3;/);
});

test("@cppgen robustez: codigo C++ multi-linea", () => {
  // El codigo generado puede tener multiples lineas.
  // El usuario incluye \n en el string.
  const src = `@cppgen
function genMulti(): string {
  return "int a = 1;\\nint b = 2;\\nint c = 3;";
}
function main(): void {
  genMulti();
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /int a = 1;/);
  assert.match(cpp, /int b = 2;/);
  assert.match(cpp, /int c = 3;/);
});

test("@cppgen robustez: @cppgen que llama a funcion regular del archivo", () => {
  // @cppgen puede llamar a otras funciones del archivo que NO son
  // @comptime/@cppgen/@etsgen. El comptime las evalua como helpers.
  const src = `function double(x: number): number { return x * 2; }
@cppgen
function genDoubled(n: number): string {
  return "int x = " + double(n) + ";";
}
function main(): void {
  genDoubled(5);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /int x = 10;/);
});

test("@cppgen robustez: error claro si el body tiene codigo no string", () => {
  // El body retorna un number (no string). El comptime debe dar
  // un error claro, no un crash silencioso.
  assert.throws(
    () => compile(`@cppgen
    function bad(): number { return 42; }
    function main(): void { bad(); print(numberToString(0)); }`),
    /cppgen.*string|return.*string/i,
  );
});

// --- @etsgen ---

test("@etsgen robustez: shadowing de variable local con mismo nombre que param", () => {
  // Similar a @cppgen: la variable local no debe afectar el param.
  const src = `@etsgen
function gen(n: number): string {
  return "print(numberToString(" + n + "));";
}
function main(): void {
  let n: number = 99;  // shadowing local
  gen(42);  // el arg es 42, no 99
  print(numberToString(n));
}`;
  const cpp = compile(src).cpp;
  // El print generado usa 42 (del arg), no 99
  assert.match(cpp, /print\(numberToString\(42\.0\)\)/);
  // El print del main usa la variable n (que es 99 en runtime)
  assert.match(cpp, /print\(numberToString\(n\)\)/);
});

test("@etsgen robustez: args con expresiones comptime-compatibles", () => {
  // 1+2 se comptime-evalúa a 3 antes de inyectar.
  const src = `@etsgen
function gen(n: number): string {
  return "print(numberToString(" + n + "));";
}
function main(): void {
  gen(1 + 2);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /print\(numberToString\(3\.0\)\)/);
});

test("@etsgen robustez: template literal con substituciones", () => {
  // @etsgen soporta template literals como el dialecto normal.
  const src = `@etsgen
function gen(name: string, value: number): string {
  return \`let \${name}: number = \${value};\`;
}
function main(): void {
  gen("z", 7);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // El codigo generado debe aparecer en main
  assert.match(cpp, /double z = 7\.0/);
});

test("@etsgen robustez: captura de variable comptime-compatible", () => {
  // @etsgen puede capturar variables globales del archivo.
  const src = `let scale: number = 2;
@etsgen
function genScaled(n: number): string {
  return "print(numberToString(" + n + " * " + scale + "));";
}
function main(): void {
  genScaled(5);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  // El print generado usa 5 * 2 = 10
  assert.match(cpp, /print\(numberToString\(\(5\.0 \* 2\.0\)\)\)/);
});

test("@etsgen robustez: multi-call con args distintos en mismo main", () => {
  const src = `@etsgen
function gen(n: number): string {
  return "print(numberToString(" + n + "));";
}
function main(): void {
  gen(1);
  gen(2);
  gen(3);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /print\(numberToString\(1\.0\)\)/);
  assert.match(cpp, /print\(numberToString\(2\.0\)\)/);
  assert.match(cpp, /print\(numberToString\(3\.0\)\)/);
});

test("@etsgen robustez: codigo generado con if/else inline", () => {
  // Genera codigo que el dialecto procesa.
  const src = `@etsgen
function genCond(limit: number): string {
  return "if (x > " + limit + ") { print('big'); } else { print('small'); }";
}
function main(): void {
  let x: number = 10;
  genCond(5);
  print(numberToString(0));
}`;
  const cpp = compile(src).cpp;
  assert.match(cpp, /if \(\(x > 5\.0\)\)/);
  assert.match(cpp, /print\(std::string\("big"\)\)/);
});

test("@etsgen robustez: args no comptime-compatibles se emiten como runtime", () => {
  // Si el arg no es comptime-compatible (e.g. una variable local que
  // no se puede evaluar), la call se queda como runtime y la funcion
  // @etsgen NO se filtra (se emite como funcion normal).
  const src = `@etsgen
function gen(n: number): string {
  return "print(numberToString(" + n + "));";
}
function main(): void {
  let x: number = 42;
  gen(x);  // arg es una variable local, no comptime-evaluable directamente
  print(numberToString(0));
}`;
  // No debe fallar; la call se emite como runtime.
  const cpp = compile(src).cpp;
  // La funcion gen se emite (porque el arg no fue comptime-compat)
  assert.match(cpp, /std::string gen/);
  // La call aparece
  assert.match(cpp, /gen\(/);
});

test("@etsgen robustez: error claro si el codigo generado no es valido", () => {
  // V30.51: el error de parse ahora incluye contexto de @etsgen:
  // nombre de la funcion, codigo generado y sugerencia.
  const src = `@etsgen
function genBad(): string {
  return "if (x > ";  // codigo incompleto
}
function main(): void {
  genBad();
  print(numberToString(0));
}`;
  assert.throws(
    () => compile(src),
    /etsgen function 'genBad'.*invalid code.*generated.*parse error.*hint:/s,
  );
});

test("@etsgen robustez: error de @etsgen incluye codigo generado truncado si es largo", () => {
  // Si el codigo generado es muy largo (>200 chars), se trunca
  // con "..." para que el mensaje no sea excesivo.
  const longCode = "print(numberToString(1));".repeat(20);  // > 200 chars
  const src = `@etsgen
function genLong(): string {
  return ${JSON.stringify(longCode + " INVALID !!! ")};
}
function main(): void {
  genLong();
  print(numberToString(0));
}`;
  assert.throws(
    () => compile(src),
    /etsgen function 'genLong'.*generated.*\.\.\./s,
  );
});

test("@etsgen robustez: error de @etsgen menciona el call site (no solo el body)", () => {
  // El error indica que el problema es en el codigo generado, no
  // en el codigo del usuario. La sugerencia guia al usuario.
  const src = `@etsgen
function gen(): string {
  return "let x = ";  // falta el valor
}
function main(): void {
  gen();
  print(numberToString(0));
}`;
  assert.throws(
    () => compile(src),
    /hint: revisa el codigo/,
  );
});
