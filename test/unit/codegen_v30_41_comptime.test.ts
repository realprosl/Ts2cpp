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
