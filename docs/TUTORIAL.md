# Tutorial del dialecto Estatic

**Estatic** es un dialecto de TypeScript que compila a C++20 idiomático. Te
permite escribir código con la sintaxis familiar de TypeScript y obtener
binarios nativos con control total sobre memoria y rendimiento.

Cada ejemplo de este tutorial es **ejecutable**. Copia el código a un
archivo `.ets` y compílalo con:

```bash
node src/cli.ts mi-archivo.ets -o /tmp/salida.cpp
g++ -O2 -std=c++20 -I. /tmp/salida.cpp -o /tmp/binario
/tmp/binario
```

## Tabla de contenidos

1. [Hola mundo](#1-hola-mundo)
3. [Tipos básicos](#2-tipos-básicos)
5. [Funciones](#3-funciones)
7. [Clases y objetos](#4-clases-y-objetos)
9. [Encapsulación](#5-encapsulación) (V19)
11. [Parameter properties](#6-parameter-properties) (V20)
13. [Ownership y punteros](#7-ownership-y-punteros)
15. [Colecciones](#8-colecciones)
17. [Manejo de errores](#9-manejo-de-errores)
19. [Sistema de tipos](#10-sistema-de-tipos)
21. [Módulos y compilación](#11-módulos-y-compilación)
23. [Librerías externas](#12-librerías-externas) (V18)
25. [Closures y lambdas](#13-closures-y-lambdas)
27. [Runtime y rendimiento](#14-runtime-y-rendimiento)
28. [String API completa](#15-string-api-completa) (V28)
29. [Servidor HTTP Express-style](#16-servidor-http-express-style) (V28)
30. [Backend HTTP dual: cpp-httplib vs Drogon](#17-backend-http-dual-cpp-httplib-vs-drogon) (V28)

---

## 1. Hola mundo

```ets
// hello.ets
print("Hola, mundo desde Estatic!");
```

**Output**: `Hola, mundo desde Estatic!`

`print()` es una función global que escribe a `stdout`. Internamente llama
a `std::cout`.

---

## 2. Tipos básicos

### Primitivos

```ets
// types.ets
let n: number = 42;          // C++: double
let s: string = "texto";     // C++: std::string
let b: boolean = true;       // C++: bool
let v: void = undefined;     // solo para anotaciones de retorno
print(n, s, b);
```

### Tipos numéricos concretos

```ets
let i: i32 = -42;            // C++: int32_t
let u: u32 = 42;             // C++: uint32_t
let f: f32 = 3.14;           // C++: float
let d: f64 = 3.14159;        // C++: double
print(i, u, f, d);
```

Tipos disponibles: `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `f32`, `f64`.

### Arrays

```ets
// arrays.ets
let xs: number[] = [1, 2, 3, 4, 5];   // C++: std::vector<double>
let buf: [i32, 8] = [0, 0, 0, 0, 0, 0, 0, 0]; // C++: std::array<int32_t, 8>
print(xs[0], buf[0]);
```

### Optionals (estilo Rust)

```ets
// optional-demo.ets
function describe(name: string, age: number?): string {
  if (age.isPresent()) return name + " tiene " + age.value().toString() + " años";
  return name + " sin edad registrada";
}
print(describe("Ana", 30));
print(describe("Luis"));
```

Un `T?` se traduce a `Optional<T>` en C++.

### Tuplas

```ets
// tuples.ets
let point: [number, number] = [3.0, 4.0];
print(point[0], point[1]);
```

### Uniones

```ets
// unions.ets
union Shape = Circle(radius: number) | Rectangle(width: number, height: number);
let c: Shape = Shape.Circle(5.0);
match (c) {
  Circle(r) => print("círculo radio", r),
  Rectangle(w, h) => print("rectángulo", w, h),
}
```

---

## 3. Funciones

### Parámetros y retorno

```ets
function add(a: number, b: number): number {
  return a + b;
}
print(add(2, 3));    // 5
```

### Parámetros opcionales y por defecto

```ets
function greet(name: string, greeting: string = "Hola"): string {
  return greeting + ", " + name;
}
print(greet("Ana"));                // Hola, Ana
print(greet("Ana", "Buenos días")); // Buenos días, Ana
```

### Parámetros mut, out

```ets
function swap(a: mut number, b: mut number): void {
  let t: number = a; a = b; b = t;
}
let x: number = 1; let y: number = 2;
swap(mut x, mut y);
print(x, y);  // 2 1
```

### Async/await

```ets
async function fetch(url: string): Promise<string> {
  // ...
  return "response";
}

async function main(): Promise<void> {
  let r: string = await fetch("https://example.com");
  print(r);
}
```

---

## 4. Clases y objetos

### Clase básica

```ets
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  sum(): number { return this.x + this.y; }
}

let p: Point = new Point(3, 4);
print(p.sum());  // 7
```

### Readonly

```ets
class Vec {
  readonly x: number;
  readonly y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
```

Los `readonly` solo se pueden asignar dentro del constructor.

---

## 5. Encapsulación (V19)

Modificadores: `private`, `public` (default), `protected`.

```ets
class Counter {
  private value: number;
  public label: string;
  private secret(): number { return this.value + 1; }
  constructor(initial: number, label: string) {
    this.value = initial;
    this.label = label;
  }
  public increment(): void { this.value = this.value + 1; }
  public getValue(): number { return this.value; }
}

let c: Counter = new Counter(0, "contador");
c.increment();
print(c.label);     // OK (public)
print(c.getValue()); // OK (accede via método público)
// print(c.value);  // ERROR: 'value' es privado
// c.secret();       // ERROR: 'secret' es privado
```

`private` se enforza en el type-checker; C++ no lo respeta (los structs son
públicos por defecto).

---

## 6. Parameter properties (V20)

Sintaxis abreviada para declarar campos desde parámetros del constructor:

```ets
class Point {
  constructor(readonly x: number, readonly y: number, private label: string) {
  }
  describe(): string { return this.label; }
  getLabel(): string { return this.label; }
}

let p: Point = new Point(3, 4, "origen");
print(p.describe());  // origen
print(p.getLabel());  // origen
```

Equivalente a:
```ets
class Point {
  readonly x: number;
  readonly y: number;
  private label: string;
  constructor(x: number, y: number, label: string) {
    this.x = x;
    this.y = y;
    this.label = label;
  }
  // ...
}
```

---

## 7. Ownership y punteros

`Unq<T>` (unique_ptr) y `Rc<T>` (reference counted).

```ets
class Node {
  value: number;
  next: Unq<Node>;
  constructor(value: number) { this.value = value; this.next = Unq.new(...); }
}

let n: Unq<Node> = Unq.new(new Node(1));
print(n.value);
```

---

## 8. Colecciones

```ets
let xs: number[] = [1, 2, 3, 4, 5];
let sum: number = xs.reduce(0, (acc: number, x: number): number => acc + x);
let evens: number[] = xs.filter((x: number): boolean => x % 2 == 0);
let doubled: number[] = xs.map((x: number): number => x * 2);

let m: Map<string, number> = Map.new();
m.set("a", 1);
print(m.get("a"));
```

Métodos disponibles: `map`, `filter`, `reduce`, `forEach`, `some`, `every`,
`find`, `sort`, `flatMap`, `slice`, `includes`.

---

## 9. Manejo de errores

`Result<T, E>` estilo Rust:

```ets
function divide(a: number, b: number): Result<number, string> {
  if (b == 0) return Result.err("división por cero");
  return Result.ok(a / b);
}

let r: Result<number, string> = divide(10, 2);
match (r) {
  Result.ok(v) => print("ok:", v),
  Result.err(e) => print("error:", e),
}
```

---

## 10. Sistema de tipos

### Inferencia

```ets
let x = 42;        // infiere number
let s = "texto";   // infiere string
```

### Genéricos

```ets
class Box<T> {
  value: T;
  constructor(v: T) { this.value = v; }
  get(): T { return this.value; }
}
let b: Box<number> = new Box(42);
print(b.get());
```

### Type aliases

```ets
type Matrix = number[][];
```

---

## 11. Módulos y compilación

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

```ts
// estatic.config.ts
import type { EstaticConfig } from "ts2cpp/src/config/project-config.ts";

export default {
  entry: "./main.ets",
  output: {
    cpp: "build/out.cpp",
    binary: "build/out",
  },
  compiler: {
    command: "g++",
    flags: ["-O2", "-std=c++20"],
    linkFlags: ["-lm"],
  },
} satisfies EstaticConfig;
```

Compilar:
```bash
node src/cli.ts --build
```

---

## 12. Librerías externas (V18)

### .lib.ets

```ets
// raylib.lib.ets — UNA librería por archivo
@link("-lraylib")
@include("raylib.h")

@cpp_type("Vector2")
export interface Vector2 {
  x(coord: number): number;
  y(coord: number): number;
}

@cpp_name("InitWindow")
export function initWindow(w: number, h: number, title: string): void;
```

### Uso

```ets
import { initWindow } from "./raylib.lib.ets";
initWindow(800, 600, "Mi ventana");
```

El codegen emite:
- `#include "raylib.h"` en el cpp
- Forward decl `extern "C" <sig>;` con el nombre C
- `-lraylib` en el link flags

---

## 13. Closures y lambdas

```ets
let add: (a: number, b: number): number = (a, b) => a + b;
let mul: (a: number) => number = a => a * 2;
print(add(2, 3));    // 5
print(mul(5));       // 10
```

---

## 14. Runtime y rendimiento

### Headers runtime

El dialecto incluye solo lo que el AST necesita:
- `ets_core.hpp` (2KB) — siempre
- `ets_io.hpp` (3KB) — si usas print/console/Math/Date
- `ets_runtime.hpp` (17KB) — si usas Map/Set/JSON/Optional
- `ets_runtime_full.hpp` (10KB) — si usas fs/net/async/process

### Flag --minimal

```bash
node src/cli.ts hello.ets -o /tmp/out.cpp --minimal
```

En modo minimal, el header no incluye `ets_io.hpp`. El binario resultante
no tiene `print`/console; usa `std::cout` directamente.

### Pre-compiled headers (V17)

Los headers se compilan una sola vez a `.gch` (caché en `build/.estatic/pch/`).
La segunda compilación con cambios baja de ~3.7s a ~36ms.

---

## 15. String API completa (V28)

El dialecto expone la API de string completa de TypeScript como llamadas
tipo método (`s.charAt(i)`, `s.length`, etc.) sobre valores `string`.
El codegen traduce 1:1 a las funciones libres `ets::string_*` que viven
en `runtime/ets_string.hpp`. Todo es **byte-level** (UTF-8 bytes): no
hay soporte Unicode multibyte, es coherente con el resto del runtime
que trata `std::string` como secuencia de bytes.

### Atributo

| Propiedad | Tipo | Descripción |
|---|---|---|
| `s.length` | `number` | Número de bytes (= `std::string::size()`). |

### Métodos de acceso

| Método | Retorno | Descripción |
|---|---|---|
| `s.charAt(i)` | `string` | Byte en posición `i` como string de 1 byte, o `""` si fuera de rango. |
| `s.charCodeAt(i)` | `number` | Byte en posición `i` como double (0-255), o `-1` si fuera de rango. |

### Métodos de búsqueda

| Método | Retorno | Descripción |
|---|---|---|
| `s.indexOf(needle, start=0)` | `number` | Primera posición de `needle` desde `start`, o `-1`. |
| `s.lastIndexOf(needle)` | `number` | Última posición de `needle`, o `-1`. |
| `s.includes(needle, start=0)` | `boolean` | `true` si `needle` aparece desde `start`. |
| `s.startsWith(prefix)` | `boolean` | `true` si `s` empieza por `prefix`. |
| `s.endsWith(suffix)` | `boolean` | `true` si `s` termina por `suffix`. |

### Métodos de slicing

| Método | Retorno | Descripción |
|---|---|---|
| `s.slice(start, end=length)` | `string` | Substring. Acepta `start`/`end` negativos (desde el final). |
| `s.substring(start, end=length)` | `string` | Como `slice` pero clamea negativos a 0 e intercambia `start`/`end`. |
| `s.substr(start, length=rest)` | `string` | Legacy: `length` caracteres desde `start`. |
| `s.split(separator)` | `string[]` | Vector de partes separadas por `separator`. |

### Métodos de transformación

| Método | Retorno | Descripción |
|---|---|---|
| `s.trim()` / `trimStart()` / `trimEnd()` | `string` | Quita espacios al ppio/final/ambos. |
| `s.toLowerCase()` / `toUpperCase()` | `string` | ASCII lower/upper-case (byte-level). |
| `s.repeat(count)` | `string` | Repite `count` veces. |
| `s.padStart(len, pad)` / `padEnd(len, pad)` | `string` | Rellena al ppio/final hasta `len`. |
| `s.replace(search, replacement)` | `string` | Primera ocurrencia. |
| `s.replaceAll(search, replacement)` | `string` | Todas las ocurrencias. |

### Comparación y conversión

| Método | Retorno | Descripción |
|---|---|---|
| `s.localeCompare(other)` | `number` | `-1` si menor, `0` si igual, `1` si mayor (byte-level). |
| `s.toString()` | `string` | Identidad. |

### Ejemplo

```ets
// string-api.ets
let s: string = "Hola Mundo"

print("length: " + numberToString(s.length))         // 10
print("charAt(0): " + s.charAt(0))                    // H
print("indexOf(Mundo): " + numberToString(s.indexOf("Mundo", 0)))  // 5
print("slice(-5): " + s.slice(-5.0, 11.0))            // Mundo
print("split size: " + numberToString(s.split(" ").length))  // 2
print("padStart: " + "5".padStart(3, "0"))           // 005
print("replaceAll: " + "foo".replaceAll("o", "X"))   // fXX
```

```bash
node src/cli.ts string-api.ets -o /tmp/out.cpp
g++ -std=c++20 -I. -o /tmp/out /tmp/out.cpp -lpthread
/tmp/out
```

### Notas de implementación

- `split` no soporta regex (es split por string literal, igual que el
  método legacy de TS sin segundo argumento).
- `toLowerCase`/`toUpperCase` usan `std::tolower`/`std::toupper` con
  `unsigned char` para evitar UB con bytes >127. UTF-8 multibyte puede
  no comportarse como esperas con caracteres no-ASCII.
- El type-checker valida aridad y tipos contra `STRING_METHODS` en
  `src/semantic/type-checker.ts`; el codegen emite
  `::ets::string_<método>(s, ...)` directamente.

---

## 16. Servidor HTTP Express-style (V28)

El dialecto trae un servidor HTTP/1.1 estilo Express integrado en el
runtime async (libuv + epoll). La API vive en `runtime/ets_http_server.hpp`
y se compila al binario sin dependencias externas más allá de libuv.

### Hello world

```ets
// hello-server.ets
let server: Server = http.createServer()

server.get("/", (req: Request, res: Response): void => {
  res.status(200)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("hola desde el server de Ts2cpp")
})

server.listen(3000)
```

```bash
node src/cli.ts hello-server.ets -o /tmp/server.cpp
g++ -std=c++20 -I. -o /tmp/server /tmp/server.cpp \
    runtime/runtime_ets_poll.cpp runtime/runtime_ets_net.cpp -lpthread
/tmp/server &  # bloquea hasta SIGINT
curl http://127.0.0.1:3000/
# hola desde el server de Ts2cpp
```

### API de routing

`server.<método>(path, handler)` registra un handler para method + path.
Los métodos disponibles son: `get`, `post`, `put`, `patch`, `delete`.
El `path` admite **path params** con `:nombre` (e.g. `/hola/:name`).

```ets
server.get("/hola/:name", (req: Request, res: Response): void => {
  // http.param(req, "name") devuelve el path param, o "" si no existe.
  res.send("hola " + http.param(req, "name"))
})
```

### Acceso al request

| Campo / helper | Tipo | Descripción |
|---|---|---|
| `req.method` | `string` | `"GET"`, `"POST"`, etc. |
| `req.path` | `string` | Path sin query string. |
| `req.rawQuery` | `string` | Query string cruda. |
| `req.body` | `string` | Cuerpo del request (POST/PUT/PATCH). |
| `http.param(req, "name")` | `string` | Path param `:name`, o `""`. |
| `http.query(req, "name")` | `string` | Query value (URL-decoded), o `""`. |
| `http.header(req, "X-Foo")` | `string` | Header case-insensitive, o `""`. |

### Response encadenable

`res` es un builder que se muta encadenando llamadas. `send()` o `json()`
cierran la cadena y envían.

```ets
server.post("/echo", (req: Request, res: Response): void => {
  res.status(201)
     .header("X-Content-Type", http.header(req, "Content-Type"))
     .send("recibido: " + req.body)
})
```

| Método | Descripción |
|---|---|
| `res.status(code)` | Status code (defecto 200). |
| `res.header(name, value)` | Añade o sobreescribe un header. |
| `res.send(body)` | Envía texto (auto-set `Content-Type: text/plain`). |
| `res.json(jsonString)` | Envía JSON (auto-set `Content-Type: application/json`). |

### Limitaciones conocidas

- **HTTP/1.1 plano**: sin HTTPS, sin middlewares, sin streaming,
  sin cookies, sin compresión.
- **SIGSEGV en shutdown** (exit -11 al SIGINT tras ~5 min arriba):
  anotado en `ts2cpp-pending-features` para diagnosticarlo con gdb.
- **Parser no acepta qualifier `http.X` en la firma del handler**:
  los handlers usan los nombres planos `Request`/`Response`. Cuando
  el parser crezca para `Identifier.Identifier` como type name, los
  handlers podrán escribirse como `(req: http.Request, res: http.Response)`.
- **Cliente HTTP pendiente**: se reescribirá con un nombre distinto
  (`HttpClientResponse`) en `runtime/ets_http_client.hpp` para no
  colisionar con el `Response` del server.

### Ejemplo completo

```ets
let server: Server = http.createServer()

server.get("/", (req: Request, res: Response): void => {
  res.send("hola desde el server de Ts2cpp")
})

server.get("/hola/:name", (req: Request, res: Response): void => {
  res.send("hola " + http.param(req, "name"))
})

server.get("/sumar", (req: Request, res: Response): void => {
  res.send("query: " + req.rawQuery)
})

server.post("/echo", (req: Request, res: Response): void => {
  res.status(201).send("recibido: " + req.body)
})

server.listen(3000)
```

Verificado con curl real: los 4 endpoints responden correctamente
(GET /, GET /hola/:name con path param, GET /sumar?a=3 con query string,
POST /echo con body, y 404 para rutas no registradas).

---

## 17. Backend HTTP dual: cpp-httplib vs Drogon (V28)

El servidor HTTP del dialecto admite **dos backends** intercambiables
sin cambiar el código del usuario: `cpp-httplib` por defecto y
`Drogon` opcional con el decorator `@cpp_drogon`. Ambos exponen la
misma API (`Server`, `Request`, `Response`, `http.param/query/header`),
de modo que la migración es un cambio de una línea.

### ¿Por qué dos backends?

Cada backend resuelve un trade-off distinto:

| Backend | Rendimiento | Dependencias | HTTPS | Tamaño |
|---------|-------------|--------------|-------|--------|
| **cpp-httplib** (default) | ~25-50k req/s | header-only, sin extras (solo `-lpthread`) | opt-in (`-DCPPHTTPLIB_OPENSSL_SUPPORT`) | 23k líneas vendoreadas en `runtime/external/httplib/` |
| **Drogon** (opcional) | ~150-200k req/s | requiere `libdrogon-dev` + `libjsoncpp-dev` (apt) | built-in | 50k+ líneas, **no** vendoreado (submodule futuro) |

**Cuándo usar cpp-httplib** (default): la mayoría de casos, microservicios
ligeros, CLIs con server embebido, prototipos. Sin dependencias externas,
compila rápido, ideal cuando el rendimiento no es crítico.

**Cuándo usar Drogon**: alta concurrencia, APIs públicas con miles de
req/s, microservicios en producción. Requiere instalar las dependencias
en la máquina de desarrollo y de deploy.

### Uso básico (cpp-httplib, default)

Sin hacer nada, el builder usa cpp-httplib:

```ets
let server: Server = http.createServer()

server.get("/", (req: Request, res: Response): void => {
  res.send("hola desde cpp-httplib")
})

server.listen(3000)
```

Compilación:

```bash
g++ -std=c++20 -I. programa.cpp \
    runtime/external/httplib/httplib.cc \
    -lpthread -o programa
```

El builder **solo** arrastra `httplib.h` si el programa usa HTTP
server/client. Programas sin HTTP no pagan el coste de compilación
(verificado: el `.cpp` no contiene `#include "runtime/ets_http_*"`
si no usas `http.createServer()` o `http.get/post`).

### Activar Drogon con `@cpp_drogon`

Pon el decorator `@cpp_drogon` encima de `let server: Server = ...`:

```ets
@cpp_drogon
let server: Server = http.createServer()

server.get("/", (req: Request, res: Response): void => {
  res.send("hola desde drogon")
})

server.listen(3000)
```

El codegen detecta el decorator y emite `runtime/ets_http_drogon.hpp`
en lugar de `runtime/ets_http_httplib.hpp`. El builder del runner
detecta el include y añade los flags de link de Drogon
(`-ldrogon -ltrantor -ljsoncpp -lssl -lcrypto -lresolv`) y
`-I/usr/include/jsoncpp` automáticamente.

### Instalación de Drogon

En Debian/Ubuntu:

```bash
sudo apt install libdrogon-dev libjsoncpp-dev
```

Drogon 1.8+ instala los headers en `/usr/include/drogon/` y la
librería en `/usr/lib/x86_64-linux-gnu/libdrogon.so`. Si no está
instalado, el bucket de tests `http-server-drogon` se skipea con
este mensaje:

```
libdrogon-dev no instalado (apt install libdrogon-dev libjsoncpp-dev)
- bucket http-server-drogon omitido
```

### Compilación manual con Drogon

```bash
g++ -std=c++20 -I. -I/usr/include/jsoncpp programa.cpp \
    -ldrogon -ltrantor -ljsoncpp \
    -lpthread -lssl -lcrypto -lresolv \
    -o programa
```

### Limitaciones conocidas del backend Drogon

- **Drogon no permite múltiples servers en el mismo proceso**
  (`drogon::app()` es un singleton global). Si necesitas varios
  listeners, usa subprocesos o puertos distintos.
- **Drogon no expone query params parseados**: la query string
  llega cruda en `req.rawQuery`. El helper `http.query(req, "x")`
  la parsea internamente.
- **Drogon usa `try/catch`**: si compilas con `-fno-exceptions`
  (como el runner por defecto para programas no-Drogon), el codegen
  emite código que rompe. El runner detecta Drogon y desactiva el
  flag automáticamente.
- **Path params**: máximo 3 por ruta (limite del wrapper; ampliable
  si hace falta).
- **Header `Content-Type: text/html` por defecto**: si el handler
  pone uno custom, el wrapper limpia el default para evitar
  duplicados en la respuesta.

### Verificación end-to-end

El ejemplo `.scratch/ejemplo-server-drogon.ets` (no commiteado,
solo local) cubre los 5 casos típicos:

```
GET  /                  -> 200 (43 bytes)  server: drogon/1.8.7
GET  /hola/alberto      -> 200 (12 bytes)  [path param]
GET  /sumar?a=3&b=4     -> 200 (20 bytes)  [query string]
POST /echo (body=hola)  -> 201 (14 bytes)  [X-Content-Type]
GET  /nada              -> 404
```

Para probarlo manualmente:

```bash
# Terminal 1
node --experimental-strip-types --no-warnings src/cli.ts \
     .scratch/ejemplo-server-drogon.ets \
     -o /tmp/srv.cpp
g++ -std=c++20 -I. -I/usr/include/jsoncpp /tmp/srv.cpp \
    -ldrogon -ltrantor -ljsoncpp -lpthread -lssl -lcrypto -lresolv \
    -o /tmp/srv
/tmp/srv

# Terminal 2
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/hola/alberto
```

### Tests e2e

`test/e2e/http-server-drogon/drogon-decorator-compiles/` verifica
que el codegen emite el include de Drogon y que el runner linka
correctamente. Skipea automáticamente si Drogon no está instalado.
El roundtrip end-to-end (server arranca + cliente HTTP) se valida
manualmente con el ejemplo `.scratch` porque requeriría `fork()` o
`thread` del dialecto, fuera del scope de este PR.

### Roadmap V29+

La dirección acordada con el usuario es:

- **Drogon** para el servidor HTTP (ya integrado opcionalmente).
- **libcurl multi** para el cliente HTTP asíncrono (sustituye el
  cliente actual sobre TCP plano de `runtime/ets_http_client.hpp`).
- **libuv** para el resto del runtime (TCP, TLS, files, async).
- **cpp-httplib** se mantiene como alternativa sencilla por defecto.

### Ejemplo: comparar ambos backends

Mismo programa, dos binarios, sin tocar el código de usuario:

```ets
// ejemplo-backend.ets
let server: Server = http.createServer()

server.get("/", (req: Request, res: Response): void => {
  res.send("hola")
})

server.listen(3000)
```

```bash
# Build 1: cpp-httplib (default, sin decorator)
node src/cli.ts ejemplo-backend.ets -o /tmp/a.cpp
g++ -std=c++20 -I. /tmp/a.cpp runtime/external/httplib/httplib.cc \
    -lpthread -o /tmp/srv-httplib
/tmp/srv-httplib &
curl http://127.0.0.1:3000/  # hola

# Build 2: Drogon (anadiendo @cpp_drogon)
sed -i '1i @cpp_drogon' ejemplo-backend.ets
node src/cli.ts ejemplo-backend.ets -o /tmp/b.cpp
g++ -std=c++20 -I. -I/usr/include/jsoncpp /tmp/b.cpp \
    -ldrogon -ltrantor -ljsoncpp -lpthread -lssl -lcrypto -lresolv \
    -o /tmp/srv-drogon
/tmp/srv-drogon &
curl http://127.0.0.1:3000/  # hola (mismo API, backend distinto)
```

---

## Resumen de versiones

- **V15**: compilación incremental por módulos
- **V16**: includes selectivos + `--minimal`
- **V17**: pre-compiled headers + includes granularizados
- **V18**: librerías externas vía `@link`/`@include`/`@cpp_name`/`@cpp_type`
- **V19**: encapsulación `private`/`public`/`protected`
- **V20**: parameter properties (sintaxis abreviada)
- **V28**: API de string completa estilo TypeScript (24 métodos) + servidor HTTP/1.1 Express-style (`http.createServer()`, `server.get/post/...`, path params, query string, body, response encadenable) + cliente HTTP (`http.get`/`http.post`, `HttpClientResponse`) + backend HTTP dual (cpp-httplib por defecto, Drogon opcional con decorator `@cpp_drogon` para alta carga)