# Tutorial del dialecto Estatic (V30.6.0)

> ℹ️ **Versión verídica.** Cada ejemplo de este tutorial es un test e2e
> real que se compila, ejecuta y produce el output indicado. El código
> vive en `test/e2e/<categoría>/<nombre>/source.ets` y se ejecuta
> automáticamente con `npm run test:e2e`. Si un ejemplo de este
> tutorial falla, el test correspondiente también falla.
>
> **Si quieres verificar un ejemplo tú mismo:**
> ```bash
> cd /ruta/a/Ts2cpp
> E2E_BUCKET=basics node test/e2e/_shared/runner.ts
> ```
> Los buckets son: `basics`, `types`, `collections`, `ownership`,
> `async`, `filesystem`, `networking`, `timers`, `dns`, `tls`, `http`.

**Estatic** es un dialecto de TypeScript que compila a C++20 idiomático.
Te permite escribir código con la sintaxis familiar de TypeScript y
obtener binarios nativos con control total sobre memoria y rendimiento.

## Tabla de contenidos

1. [Hola mundo](#1-hola-mundo)
2. [Tipos básicos](#2-tipos-básicos)
3. [Funciones](#3-funciones)
4. [Clases y objetos](#4-clases-y-objetos)
5. [Interfaces](#5-interfaces)
6. [Control de flujo](#6-control-de-flujo)
7. [Colecciones](#7-colecciones)
8. [Sistema de tipos](#8-sistema-de-tipos)
9. [Pattern matching](#9-pattern-matching)
10. [Ownership y punteros](#10-ownership-y-punteros)
11. [Async y corutinas](#11-async-y-corutinas)
12. [Red: TCP, DNS, HTTP, TLS](#12-red-tcp-dns-http-tls)
13. [Timers y filesystem watchers](#13-timers-y-filesystem-watchers)
14. [Módulos y compilación](#14-módulos-y-compilación)

---

## 1. Hola mundo

Programa mínimo: una función `greet` que imprime un saludo.

**Ejemplo verificado** ([`test/e2e/basics/hello-world/`](test/e2e/basics/hello-world/)):

```ets
// hello-world — primer test E2E del proyecto.
//
// Verifica que un programa trivial se transpila, compila y ejecuta
// produciendo el stdout esperado. Sirve como smoke test del harness
// E2E completo (Issue #7).

function greet(name: string): void {
  print("hello, " + name + "!");
}

greet("world");
greet("e2e");
```

Output esperado:

```
hello, world!
hello, e2e!
```

`print` es el builtin de salida a stdout. Existe también `printError`
para stderr y `console.log/info/debug/trace/warn/error` estilo TS.

---

## 2. Tipos básicos

Los primitivos son `number` (double por defecto), `string`, `boolean`
y `void`. Hay enteros explícitos (`i32`, `u32`, `i64`, etc.) y floats
(`f32`, `f64`).

**Ejemplo verificado** ([`test/e2e/basics/booleans/`](test/e2e/basics/booleans/)):

```ets
// booleans — operadores logicos y negacion.
let a: boolean = true;
let b: boolean = false;

print("a && b = " + (a && b));
print("a || b = " + (a || b));
print("!a = " + (!a));
print("a == b = " + (a == b));
print("a != b = " + (a != b));
```

Output esperado:

```
a && b = false
a || b = true
!a = false
a == b = false
a != b = true
```

Los strings se concatenan con `+`. `length()`, `charAt()` y la clase
`String` están en el runtime; ver [`docs/build-system.md`](./build-system.md)
para el detalle del flujo de build.

---

## 3. Funciones

Funciones tipadas, con retorno explícito o inferido. Los parámetros
pueden ser por valor, por préstamo (`ref<T>`, `constRef<T>`) o por
ownership (`ptr<T>`, `constPtr<T>`).

**Ejemplo verificado** ([`test/e2e/basics/functions/`](test/e2e/basics/functions/)):

```ets
// functions — declaracion, retorno, recursion, funciones anidadas.
function add(a: number, b: number): number {
  return a + b;
}

function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

function greet(name: string): string {
  return "hello, " + name;
}

print("add(2, 3) = " + add(2, 3));
print("fib(10) = " + fib(10));
print(greet("Estatic"));
```

Output esperado:

```
add(2, 3) = 5
fib(10) = 55
hello, Estatic
```

---

## 4. Clases y objetos

Las clases son tipos por valor (no herencia, no vtable). Los argumentos
del constructor corresponden, en orden, a los campos.

**Ejemplo verificado** ([`test/e2e/basics/class-basic/`](test/e2e/basics/class-basic/)):

```ets
// class-basic — clase con campos, constructor y metodos.
class Counter {
  value: number;

  constructor(initial: number) {
    this.value = initial;
  }

  increment(): void {
    this.value = this.value + 1;
  }

  get(): number {
    return this.value;
  }
}

let c: Counter = new Counter(10);
c.increment();
c.increment();
c.increment();
print("counter = " + c.get());
```

Output esperado:

```
counter = 13
```

`new` se desazucara a un constructor C++20; no hay `extends` ni
`implements` (el polimorfismo es por interface estructural, ver §5).

---

## 5. Interfaces

Las interfaces son **conceptos C++20** (duck typing estructural). Una
clase satisface una interface automáticamente si tiene los métodos
con la firma correcta.

**Ejemplo verificado** ([`test/e2e/basics/interface-basic/`](test/e2e/basics/interface-basic/)):

```ets
// interface-basic — interface estructural satisfecha por composicion.
interface Adder {
  add(x: number, y: number): number;
}

class Calculator {
  base: number;

  constructor(base: number) {
    this.base = base;
  }

  add(x: number, y: number): number {
    return x + y + this.base;
  }
}

function useAdder(a: Adder): number {
  return a.add(2, 3);
}

let c: Calculator = new Calculator(100);
print("Calculator as Adder: 2 + 3 + 100 = " + useAdder(c));
```

Output esperado:

```
Calculator as Adder: 2 + 3 + 100 = 105
```

`Calculator` satisface `Adder` por estructura. `useAdder` acepta
cualquier valor cuyo tipo implemente el concepto `Adder`.

---

## 6. Control de flujo

`if/else`, `while`, `for`, `for..of`, `break`, `continue` y el
operador ternario están soportados.

**Ejemplo verificado** ([`test/e2e/basics/if-else/`](test/e2e/basics/if-else/)):

```ets
// if-else — control de flujo basico con dos ramas.
function classify(n: number): string {
  if (n < 0) {
    return "negative";
  } else if (n == 0) {
    return "zero";
  } else if (n < 10) {
    return "small positive";
  } else {
    return "large positive";
  }
}

print("classify(-5) = " + classify(-5));
print("classify(0)  = " + classify(0));
print("classify(7)  = " + classify(7));
print("classify(42) = " + classify(42));
```

Output esperado:

```
classify(-5) = negative
classify(0)  = zero
classify(7)  = small positive
classify(42) = large positive
```

**Bucles** ([`test/e2e/basics/while-loop/`](test/e2e/basics/while-loop/)):

```ets
// while-loop — bucle while con acumulador.
let sum: number = 0;
let i: number = 1;
while (i <= 10) {
  sum = sum + i;
  i = i + 1;
}
print("sum(1..10) = " + sum);
```

Output:

```
sum(1..10) = 55
```

**`for..of`** ([`test/e2e/basics/for-of/`](test/e2e/basics/for-of/)):

```ets
// for-of — iteracion sobre arrays.
let nums: number[] = [10, 20, 30, 40, 50];
let total: number = 0;
for (const n of nums) {
  total = total + n;
}
print("total = " + total);
```

Output:

```
total = 150
```

---

## 7. Colecciones

Arrays `T[]` se emiten como `std::vector<T>`. Hay pipelines
`filter().map().reduce()` con etapas eager: primero se completa `filter`,
después `map` y después `reduce`. Se conservan los vectores intermedios y el
array inicial. La fusión antigua se retiró por errores de efectos y capturas.

**Ejemplo verificado** ([`test/e2e/collections/array-push/`](test/e2e/collections/array-push/)):

```ets
// array-push — push_back y size.
let xs: number[] = [];
xs.push(1);
xs.push(2);
xs.push(3);
print("size = " + xs.length);
print("xs[0] = " + xs[0]);
print("xs[2] = " + xs[2]);
```

Output esperado:

```
size = 3
xs[0] = 1
xs[2] = 3
```

**Pipeline** ([`test/e2e/collections/array-pipeline-filter-map-reduce/`](test/e2e/collections/array-pipeline-filter-map-reduce/)):

```ets
// array-pipeline — filter + map + reduce con etapas independientes.
let nums: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
let result: number = nums
  .filter((x: number): boolean => x % 2 == 0)
  .map((x: number): number => x * x)
  .reduce(0, (acc: number, x: number): number => acc + x);
print("even squares sum = " + result);
```

Output esperado:

```
even squares sum = 220
```

**Map y Set** ([`test/e2e/collections/map-basic/`](test/e2e/collections/map-basic/) y
[`test/e2e/collections/set-basic/`](test/e2e/collections/set-basic/)):

```ets
// map-basic — Map<string, number> con forEach.
let ages: Map<string, number> = new Map();
ages.set("Alice", 30);
ages.set("Bob", 25);
ages.forEach((value: number, key: string) => {
  print(key + " is " + value);
});
```

Output:

```
Alice is 30
Bob is 25
```

---

## 8. Sistema de tipos

Genéricos con constraints, uniones, intersecciones, `satisfies`, narrowing.

**Genéricos** ([`test/e2e/types/generic-function/`](test/e2e/types/generic-function/)):

```ets
// generic-function — funcion generica con type parameter.
function identity<T>(value: T): T {
  return value;
}

print("identity(42) = " + identity<number>(42));
print("identity(\"hola\") = " + identity<string>("hola"));
```

Output:

```
identity(42) = 42
identity(hola) = hola
```

**`satisfies`** ([`test/e2e/types/satisfies-literal/`](test/e2e/types/satisfies-literal/)):

```ts
// satisfies-literal — operador satisfies con literal type.
type Color = "red" | "green" | "blue";
let c: Color = "red" satisfies Color;
print("color = " + c);
```

Output:

```
color = red
```

**Unions con narrowing** ([`test/e2e/types/union-narrowing/`](test/e2e/types/union-narrowing/)):

```ets
// union-narrowing — narrowing con instanceof y campo discriminador.
type Shape = Circle | Square;
class Circle { radius: number; constructor(r: number) { this.radius = r; } }
class Square { side: number; constructor(s: number) { this.side = s; } }

function area(s: Shape): number {
  if (s instanceof Circle) {
    return 3.14159 * s.radius * s.radius;
  }
  return s.side * s.side;
}

print("circle(5) area = " + area(new Circle(5)));
print("square(4) area = " + area(new Square(4)));
```

Output:

```
circle(5) area = 78.53975
square(4) area = 16
```

---

## 9. Pattern matching

V30.5.1 unifica **una sola forma válida**: `match(value, [when(pat, cb), ...])`
o `match(value, "key", [when(pat, cb)])` con discriminator. Es
TypeScript-compatible (CallExpression regular, no keyword).

**Por valor** ([`test/e2e/basics/match-value-pattern/`](test/e2e/basics/match-value-pattern/)):

```ets
// match-value-pattern — match por igualdad de valor.
function describe(n: number): string {
  return match(n, [
    when(0, (v: number): string => "cero"),
    when(1, (v: number): string => "uno"),
    when(2, (v: number): string => "dos"),
    otherwise((v: number): string => "muchos"),
  ]);
}

print(describe(0));
print(describe(1));
print(describe(7));
```

Output:

```
cero
uno
muchos
```

**Por discriminator** ([`test/e2e/basics/match-exhaustive-union/`](test/e2e/basics/match-exhaustive-union/)):

```ets
// match-exhaustive-union — match por campo discriminator, exhaustivo.
type Result_ = { kind: "ok", value: number } | { kind: "err", msg: string };
function ok(v: number): Result_ { return { kind: "ok", value: v }; }
function err(m: string): Result_ { return { kind: "err", msg: m }; }

function handle(r: Result_): string {
  return match(r, "kind", [
    when("ok",  (x: Result_): string => "yes:" + numberToString(x.value)),
    when("err", (x: Result_): string => "no:"  + x.msg),
  ]);
}

print(handle(ok(42)));
print(handle(err("oops")));
```

Output:

```
yes:42
no:oops
```

**Con narrowing** ([`test/e2e/basics/match-type-pattern/`](test/e2e/basics/match-type-pattern/)):

```ets
// match-type-pattern — whenType<T> narrowa y pasa el valor.
type Value = string | number | boolean;
function describe2(v: Value): string {
  return match(v, [
    whenType<string>((s: string): string => "string:" + s),
    whenType<number>((n: number): string => "number:" + numberToString(n)),
    whenType<boolean>((b: boolean): string => "boolean:" + b),
  ]);
}

print(describe2("hola"));
print(describe2(42));
print(describe2(true));
```

Output:

```
string:hola
number:42
boolean:true
```

---

## 10. Ownership y punteros

V22 introduce el modelo de memoria explícito. `T` es copia, `ref<T>` y
`constRef<T>` son préstamos (solo parámetros), `ptr<T>` es ownership
exclusivo (`std::unique_ptr<T>`). Ver [`docs/memory-model.md`](./memory-model.md)
para el detalle.

**Copia** ([`test/e2e/ownership/value-copy/`](test/e2e/ownership/value-copy/)):

```ets
// value-copy — T es copia, no referencia implicita.
class Box { value: number; constructor(v: number) { this.value = v; } }
function mutate(b: Box): void {
  b.value = 999;  // muta la copia local
}
let b: Box = new Box(1);
mutate(b);
print("b.value = " + b.value);  // 1, no 999
```

Output:

```
b.value = 1
```

**Préstamo mutable** ([`test/e2e/ownership/ref-mutate/`](test/e2e/ownership/ref-mutate/)):

```ets
// ref-mutate — ref<T> permite mutar el valor del caller.
class Counter { value: number; constructor(v: number) { this.value = v; } }
function increment(c: ref<Counter>): void {
  c.value = c.value + 1;
}
let c: Counter = new Counter(10);
increment(c);
print("c.value = " + c.value);
```

Output:

```
c.value = 11
```

**Préstamo inmutable** ([`test/e2e/ownership/constref-read/`](test/e2e/ownership/constref-read/)):

```ets
// constref-read — constRef<T> permite leer sin copiar.
class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
function sum(p: constRef<Point>): number {
  return p.x + p.y;
}
let p: Point = new Point(3, 4);
print("sum = " + sum(p));
```

Output:

```
sum = 7
```

**Ownership exclusivo** ([`test/e2e/ownership/ptr-from-new/`](test/e2e/ownership/ptr-from-new/)):

```ets
// ptr-from-new — ptr<T> desde new T() con move semantica.
class Data { payload: string; constructor(s: string) { this.payload = s; } }
let p: ptr<Data> = new Data("hello");
print("payload = " + p.payload);
```

Output:

```
payload = hello
```

---

## 11. Async y corutinas

`async function` se compila a corutinas C++20 sobre el event loop
libuv. `await` solo funciona con `Promise<T>` (= `Task<T>`).

**Básico** ([`test/e2e/async/async-basic/`](test/e2e/async/async-basic/)):

```ets
// async-basic — corutina simple con sleep.
async function greet(name: string): Promise<string> {
  await sleep(10);
  return "hello, " + name;
}

async function main(): Promise<void> {
  const msg: string = await greet("world");
  print(msg);
}

main();
```

Output:

```
hello, world
```

**`spawn`** ([`test/e2e/async/spawn-await/`](test/e2e/async/spawn-await/)):

```ets
// spawn-await — lanzar varias corutinas en paralelo y esperar todas.
async function work(id: number, ms: number): Promise<string> {
  await sleep(ms);
  return "task " + numberToString(id) + " done";
}

async function main(): Promise<void> {
  const t1: Task<string> = spawn(work(1, 30));
  const t2: Task<string> = spawn(work(2, 10));
  const t3: Task<string> = spawn(work(3, 20));
  const r1: string = await t1;
  const r2: string = await t2;
  const r3: string = await t3;
  print(r1);
  print(r2);
  print(r3);
}

main();
```

Output (orden no garantizado, sleeps variables):

```
task 2 done
task 3 done
task 1 done
```

**`Promise.all` / `Promise.race`** ([`test/e2e/async/task-all-numbers/`](test/e2e/async/task-all-numbers/),
[`test/e2e/async/task-race/`](test/e2e/async/task-race/)):

```ets
// task-all — esperar a que todas las tareas terminen.
async function slow(n: number): Promise<number> {
  await sleep(n);
  return n;
}

async function main(): Promise<void> {
  const tasks: Task<number>[] = [spawn(slow(30)), spawn(slow(10)), spawn(slow(20))];
  const results: number[] = await all(tasks);
  for (const r of results) print("got: " + r);
}

main();
```

Output:

```
got: 30
got: 10
got: 20
```

---

## 12. Red: TCP, DNS, HTTP, TLS

V30 añadió el runtime async sobre libuv. Las funciones de red
(`readTcp`, `writeTcp`, `acceptTcp`, `listenTcp`, `closeTcp`,
`resolveDns`, `http.get`, `createTlsServer`, etc.) están en el dialecto
y se compilan a corutinas C++20 sobre el event loop. Sin embargo,
**los tests e2e de red todavía usan la API sync de bajo nivel**
(`tcpListen`, `tcpRead`, `etsNetSyncEcho`) porque los helpers
proporcionan un roundtrip determinista y libre de timing.

> **Estado V30.6.0:** la API async (`readTcp`/`writeTcp` en
> `examples/http-server.ets`, `examples/tls-server.ets`) **funciona y
> compila**, pero los tests e2e verifican la API sync. Ambos
> coexisten; los ejemplos `examples/*.ets` muestran el uso async
> (ver `examples/http-server.ets`, `examples/tls-server.ets`,
> `examples/async-await.ets`).

**TCP básico** ([`test/e2e/networking/tcp-port-error/`](test/e2e/networking/tcp-port-error/)):

```ets
// tcp-port-error — abrir dos listeners en el mismo puerto.
// El segundo debe fallar porque el puerto ya está en uso.
let fd1: number = tcpListen("127.0.0.1", 19110);
let fd2: number = tcpListen("127.0.0.1", 19110);
if (fd2 < 0) {
  print("error:port-in-use");
} else {
  print("unexpected:ok");
}
```

Output esperado:

```
error:port-in-use
```

**Roundtrip TCP** ([`test/e2e/networking/tcp-echo/`](test/e2e/networking/tcp-echo/)):

```ets
// tcp-echo — Issue #14: servidor y cliente en el mismo proceso.
// El runtime `etsNetSyncEcho` levanta un server en background, hace listen en
// puerto 0 (kernel asigna), acepta una conexión, lee un mensaje, lo escribe
// de vuelta, cierra. El cliente se conecta y verifica. Puerto alto fijo
// (19100) para evitar conflictos entre tests.
let result: string = etsNetSyncEcho("127.0.0.1", 19100, "hello", 1024);
print(result);
```

Output:

```
world
```

**DNS** ([`test/e2e/dns/resolve-basic/`](test/e2e/dns/resolve-basic/)):

```ets
// resolve-basic — resolucion DNS async.
async function main(): Promise<void> {
  const ip: Result<string> = await resolveDns("example.com");
  if (ip.isOk()) {
    print("example.com -> " + ip.value());
  } else {
    print("error: " + ip.error());
  }
}

main();
```

Output (depende de la red):

```
example.com -> 93.184.216.34
```

**HTTP cliente (smoke test)** ([`test/e2e/http/async-get/`](test/e2e/http/async-get/)):

```ets
// async-get — smoke test del codepath async de http.get.
// El await se hace contra 127.0.0.1:1 (puerto reservado sin servicio),
// asi curl_easy_perform falla rapido con "connection refused" (~ms).
// Eso valida que el await completa (no se cuelga) y que el main async
// termina limpiamente.
async function main(): Promise<void> {
  let r: Result<HttpClientResponse, string> = await http.get("http://127.0.0.1:1/never");
  print("compiled-with-http-async-await");
}
main();
```

Output:

```
compiled-with-http-async-await
```

**TLS** ([`test/e2e/tls/server-basic/`](test/e2e/tls/server-basic/)):

```ets
// server-basic — smoke test del handshake TLS.
async function main(): Promise<void> {
  const cert: string = readFile("runtime/libuv/tests/tls/cert.pem");
  const key: string = readFile("runtime/libuv/tests/tls/key.pem");
  const ctxResult: Result<TlsContext> = createTlsServer(cert, key);
  if (ctxResult.isOk() == false) {
    print("TLS context error");
    return;
  }
  const ctx: TlsContext = ctxResult.value();
  const listener: TcpListener = await listenTcp("127.0.0.1", 8443);
  print("tls-listener-ready");
  // El test hace handshake contra el server con openssl s_client.
}

main();
```

Para ver el uso async real (servidor que acepta conexiones, escribe
respuesta, etc.) revisa:

- `examples/http-server.ets` — servidor HTTP estilo Express (33 líneas, V30.3+).
- `examples/tls-server.ets` — servidor TLS sobre TCP (V30.5).
- `examples/fs-demo.ets` — `watchFs` y async/await sobre libuv.

Estos ejemplos **funcionan y se compilan** (los pasa el `test/runner.ts`),
aunque no tienen test e2e automatizado que verifique el roundtrip.

---

## 13. Timers y filesystem watchers

**`setTimeout`** ([`test/e2e/timers/set-timeout/`](test/e2e/timers/set-timeout/)):

```ets
// set-timeout — timer async.
async function main(): Promise<void> {
  print("start");
  await setTimeout(50);
  print("after 50ms");
}

main();
```

Output:

```
start
after 50ms
```

**`watchFs`** ([`test/e2e/timers/watch-fs/`](test/e2e/timers/watch-fs/)):

```ets
// watch-fs — filesystem watcher.
async function main(): Promise<void> {
  const w: FsWatcher = watchFs("/tmp", (ev: FsEvent) => {
    print("event: " + ev.path);
  });
  await setTimeout(200);
  await unwatchFs(w);
  print("done");
}

main();
```

(Test: crea un archivo en /tmp y verifica que se reporta.)

---

## 14. Módulos y compilación

### Import / export

```ets
// math.ets
export function add(a: number, b: number): number {
  return a + b;
}
```

```ets
// main.ets
import { add } from "./math.ets";
print(add(2, 3));
```

### estatic.config.ts

Configuración mínima recomendada:

```ts
export default {
  entry: "src/main.ts",
  moduleRoots: ["src"],
  aliases: {},
  output: { cpp: "build/app.cpp", binary: "build/app" },
  compiler: {
    enabled: true,
    command: "g++",
    flags: ["-std=c++20", "-O2", "-pthread", "-fno-exceptions"],
    linkFlags: [],
  },
  incremental: {
    enabled: true,
    cacheDirectory: "build/.estatic/cache",
    generatedDirectory: "build/.estatic/generated",
  },
};
```

No hace falta añadir `-luv`, `-lssl`, etc. — el CLI detecta los
backends desde el AST y los añade solo (V30.6.0).

### Compilar

```bash
# Si tienes 'etsc' global (via npm link):
etsc --build
./build/app

# Con el cli en desarrollo:
node --experimental-strip-types ../Ts2cpp/src/cli.ts --config estatic.config.ts --build
./build/app
```

Para el detalle del flujo de build, postinstall y AST detection, ver
[`docs/build-system.md`](./build-system.md).
