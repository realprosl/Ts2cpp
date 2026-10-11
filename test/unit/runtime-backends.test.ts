// test/unit/runtime-backends.test.ts
//
// V30.6.0: tests unitarios para la deteccion declarativa de
// backends runtime (libuv, curl, tls, io_uring) desde el AST.
//
// Se compilan snippets .ets a travès de la pipeline real (parser +
// type-checker + detectRuntimeBackends) y se verifica el resultado.
// Asi testeamos que el AST traversal recoge todas las llamadas
// correctamente (incluyendo las que estan dentro de lambdas,
// bloques, condicionales, awaits, etc.).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parse } from "../../src/compiler.ts";
import { detectRuntimeBackends } from "../../src/modules/runtime-backends.ts";
import { analyze } from "../../src/compiler.ts";

function detect(source: string) {
  // Solo parseamos (sin type-check). La deteccion de backends solo
  // necesita el AST, no los tipos. Si hicieramos analyze fallaria con
  // tipos `any` o funciones que no conoce, pero el AST ya tiene la
  // info que necesitamos (CallExpression.callee, etc).
  const ast = parse(source);
  return detectRuntimeBackends(ast);
}

test("runtime-backends: programa vacio no necesita nada", () => {
  const r = detect(`let x: number = 1;`);
  assert.equal(r.libuv, false);
  assert.equal(r.curl, false);
  assert.equal(r.tls, false);
  assert.equal(r.ioUring, false);
});

test("runtime-backends: readTcp marca libuv", () => {
  const r = detect(`
    async function f(c: any): Promise<void> {
      const r = await readTcp(c, 1024);
    }
  `);
  assert.equal(r.libuv, true);
  assert.equal(r.curl, false);
  assert.equal(r.tls, false);
});

test("runtime-backends: setTimeout marca libuv", () => {
  const r = detect(`
    function f(): void {
      setTimeout(() => { print("x"); }, 100);
    }
  `);
  assert.equal(r.libuv, true);
});

test("runtime-backends: watchFs marca libuv", () => {
  const r = detect(`
    function f(): void {
      const w = watchFs("/tmp", (ev: any) => {});
    }
  `);
  assert.equal(r.libuv, true);
});

test("runtime-backends: resolveDns marca libuv", () => {
  const r = detect(`
    async function f(): Promise<string> {
      const ip = await resolveDns("example.com");
      return ip;
    }
  `);
  assert.equal(r.libuv, true);
});

test("runtime-backends: createTlsServer marca tls (y no libuv por si mismo)", () => {
  // createTlsServer esta en TLS_CALLEES pero NO en LIBUV_CALLEES:
  // la implementacion actual no requiere el event loop libuv (V30.5
  // usa el bundle). Esto es importante porque si lo pusieramos en
  // LIBUV_CALLEES por error, programas solo con TLS (sin tcp/timers)
  // linkarian libuv innecesariamente.
  const r = detect(`
    function f(): void {
      createTlsServer({ cert: "c", key: "k" }, (c: any): void => {});
    }
  `);
  assert.equal(r.tls, true);
  assert.equal(r.curl, false);
  assert.equal(r.libuv, false);
});

test("runtime-backends: httpClientGet marca curl", () => {
  const r = detect(`
    async function f(): Promise<string> {
      const r = await httpClientGet("https://example.com");
      return r;
    }
  `);
  assert.equal(r.libuv, false);
  assert.equal(r.curl, true);
  assert.equal(r.tls, false);
});

test("runtime-backends: ioUringRead marca ioUring", () => {
  const r = detect(`
    async function f(): Promise<void> {
      const r = await asyncIoUringRead(0, new Uint8Array(16));
    }
  `);
  assert.equal(r.ioUring, true);
});

test("runtime-backends: llamadas dentro de lambdas se detectan", () => {
  const r = detect(`
    function f(): void {
      [1, 2, 3].forEach((n: number) => {
        setTimeout(() => { print(n); }, 100);
      });
    }
  `);
  assert.equal(r.libuv, true);
});

test("runtime-backends: llamadas dentro de if/else se detectan", () => {
  const r = detect(`
    async function f(b: boolean, c: any): Promise<void> {
      if (b) {
        const r = await readTcp(c, 1024);
      } else {
        setTimeout(() => {}, 0);
      }
    }
  `);
  assert.equal(r.libuv, true);
});

test("runtime-backends: llamadas dentro de bucles se detectan", () => {
  const r = detect(`
    function f(): void {
      for (let i: number = 0; i < 10; i = i + 1) {
        setTimeout(() => {}, 100);
      }
    }
  `);
  assert.equal(r.libuv, true);
});

test("runtime-backends: MemberCallExpression (.method) se detecta", () => {
  // Una llamada estilo `obj.method()` no es un CallExpression sino un
  // MemberCallExpression. Aqui simulamos un escenario donde se llama
  // un metodo que mapea a libuv via member call.
  // (No usamos setTimeout porque es CallExpression, no MemberCallExpression.
  //  Un MemberCallExpression seria p.ej. `console.log(...)` pero eso no
  //  es libuv. Asi que testeamos que MemberCallExpression no causa crash
  //  y que NO marca libuv si el method no esta en LIBUV_CALLEES.)
  const r = detect(`
    function f(): void {
      console.log("hello");
    }
  `);
  assert.equal(r.libuv, false);
  assert.equal(r.curl, false);
  assert.equal(r.tls, false);
});

test("runtime-backends: programa solo con print no marca nada", () => {
  const r = detect(`
    function main(): void {
      print("hello world");
    }
    main();
  `);
  assert.equal(r.libuv, false);
  assert.equal(r.curl, false);
  assert.equal(r.tls, false);
  assert.equal(r.ioUring, false);
});
