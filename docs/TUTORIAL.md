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
   - 1.1 [Terminación de statements](#11-terminación-de-statements)
2. [Tipos básicos](#2-tipos-básicos)
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
28. [Pattern matching con `match`/`when`](#15-pattern-matching-con-matchwhen)
29. [Uniones discriminadas](#16-uniones-discriminadas-union)
30. [Interfaces y `type` aliases](#17-interfaces-y-type-aliases)
31. [Enums](#18-enums)
32. [Control flow: switch, for-of, for-in, while](#19-control-flow-switch-for-of-for-in-while)
33. [Async y await](#20-async-y-await)
34. [Parámetros: default, rest, spread](#21-parámetros-default-rest-spread)
35. [Decoradores](#22-decoradores)
36. [Type narrowing con `instanceof` y `typeof`](#23-type-narrowing-con-instanceof-y-typeof)
37. [Lectura streaming con `FileReader`](#24-lectura-de-archivos-streaming-con-filereader)

---

## 1. Hola mundo

```ets
// hello.ets
print("Hola, mundo desde Estatic!");
```

**Output**: `Hola, mundo desde Estatic!`

`print()` es una función global que escribe a `stdout`. Internamente llama
a `std::cout`.

### 1.1 Terminación de statements

El dialecto acepta **dos formas** de terminar una instrucción: el `;`
explícito estilo C/TypeScript, **o un salto de línea**. Ambas son
igualmente válidas, y se pueden mezclar dentro del mismo archivo.

```ets
// Con ';' explicito (estilo C/TypeScript)
let a: number = 1;
let b: number = 2;
print(a + b);

// Sin ';' — el newline cuenta como terminador
let c: number = 3
let d: number = 4
print(c + d)

// Mezclando ambos estilos
let e: number = 5
let f: number = 6;
let g: number = 7
print(e + f + g)
```

Reglas concretas:

- **El `;` se sigue aceptando siempre** — no hay breaking change, todos
  los ejemplos de este tutorial siguen siendo válidos tal cual.
- **Un newline termina un statement** salvo en estos casos:
  - Dentro de `()`, `[]` o `{}` (el `parenDepth` se trackea en el lexer).
  - Si el siguiente token es un continuador de expresión (`.`, `+`, `-`,
    `*`, `/`, `=`, `(`, `[`, etc.) — esto permite method chains y
    asignaciones multilínea sin necesidad de un marcador especial.
  - Dentro del paréntesis de un `for (init; cond; update)` — los dos
    `;` internos son **separadores**, no terminadores, y siguen siendo
    obligatorios.
- Las **líneas en blanco** se ignoran por completo.
- El **cierre de bloque `}`** también cuenta como terminador natural,
  igual que en JavaScript. `if (x) { f() }` no necesita `;` antes del
  `}`.

Este diseño es deliberadamente determinista (opción A del roadmap): no
hay ASI mágica, no hay heurísticas, no hay casos ambiguos. El
resultado es que el código se ve más limpio sin perder robustez.

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

## 15. Pattern matching con `match`/`when`

`match` es la pieza más distintiva del dialecto: reemplaza cadenas
de `if/else if` con **verificación exhaustiva en compile-time**. El
type-checker rechaza cualquier match que no cubra todas las variantes
posibles del tipo.

### 15.1 Sintaxis básica (estilo TypeScript con intrinsics)

```ets
match(x, [
  when((v: number): boolean => v == 1, (): string => "uno"),
  when((v: number): boolean => v == 2, (): string => "dos"),
  otherwise((): string => "otro"),
])
```

`when(predicate, fn)` registra un arm: si el predicado es true, se
ejecuta `fn` y su valor es el resultado. `otherwise(fn)` es el
fallback (equivalente a `when(_ => true, fn)`).

### 15.2 Sintaxis V2 (keyword-style)

La forma más legible, con keyword `match` y arms de un solo `case`:

```ets
union Shape = Circle | Square | Triangle
function name(s: Shape): string {
  return match (s) {
    case { kind: "Circle" }: "círculo"
    case { kind: "Square" }: "cuadrado"
    case { kind: "Triangle" }: "triángulo"
  }
}
```

Cada `case` usa un **object pattern** con el campo `kind` como
discriminador. El compilador exige que **todas** las variantes estén
cubiertas.

### 15.3 Pattern con bindings

```ets
union FileError = NotFound(string) | PermissionDenied | IOError(string)
function describe(e: FileError): string {
  return match (e) {
    case { kind: "NotFound", path }: "no existe: " + path
    case { kind: "PermissionDenied" }: "sin permisos"
    case { kind: "IOError", message }: "error IO: " + message
  }
}
```

Los **bindings** (`path`, `message`) desempaquetan el payload de la
variante directamente, sin necesidad de `payload.path` o casts.

### 15.4 Wildcard

`case _` (o `otherwise` en la sintaxis intrinsics) matchea cualquier
variante no listada explícitamente:

```ets
match (s) {
  case { kind: "Circle" }: "círculo"
  case _: "otra forma"
}
```

### 15.5 Sin retorno (efecto colateral)

```ets
match (event) {
  case { kind: "Click", x, y }: print("click en", x, y)
  case { kind: "KeyPress", k }: print("tecla", k)
  case _: // no hacer nada
}
```

Si una rama no retorna nada, el match completo se trata como statement.

### 15.6 Exhaustive checking

Si olvidas una variante, el compilador **falla con E4210 ("el match no
es exhaustivo")** listando las variantes que faltan. Si repites una
variante, falla con E4211 ("variante ya estaba cubierta"). Si mencionas
una variante que no existe, falla con E4212 ("la union no tiene
variante X").

---

## 16. Uniones discriminadas (`union`)

Las uniones son **tipos suma con payload**: un valor es exactamente una
de las variantes declaradas. El type-checker hace narrowing automático
dentro de `match`, así que cada variante es seguro de usar sin castear.

### 16.1 Variantes sin payload

```ets
union Shape = Circle | Square | Triangle
let s: Shape = Shape.Circle
```

Una variante sin payload es solo un nombre. Se construye como
`Shape.Circle`.

### 16.2 Variantes con payload

```ets
union FileError = NotFound(string) | IOError(string)
let e: FileError = FileError.NotFound("/tmp/foo.txt")
```

El payload va entre paréntesis. Si son varios, se separan por coma:

```ets
union Pair = Pair(first: number, second: number)
```

### 16.3 Discriminador interno

Aunque el usuario no lo escribe, internamente cada variante tiene un
campo `kind` con el nombre como string. Por eso el pattern es
`case { kind: "Circle" }` en `match`. Esto se llama **discriminador
automático** y es lo que hace el narrowing en compile-time.

### 16.4 Narrowing con `match` (ver §15.3)

La verdadera potencia de las uniones está en combinarlas con `match`.
Dentro de cada `case`, los bindings ya están **desempaquetados** y
son accesibles directamente, sin accesores tipo `payload.radius`.

### 16.5 Sin payload + payload mezclados

```ets
union Event = Click | KeyPress(string) | Resize(width: number, height: number)
```

El orden de declaración no importa para el narrowing.

---

## 17. Interfaces y `type` aliases

### 17.1 Interfaces

`interface` define un **contrato estructural**: cualquier tipo que
tenga esos campos con esos tipos lo satisface automáticamente (duck
typing, sin declaración explícita de `implements`).

```ets
interface Printable {
  toString(): string
}

interface Comparable<T> {
  compareTo(other: T): number
}
```

Los campos pueden ser opcionales con `?` y readonly con `readonly`:

```ets
interface User {
  readonly id: number
  name: string
  email?: string
}
```

### 17.2 `type` aliases

`type` crea un **alias** para un tipo, no un tipo nuevo. Útil para
uniones, tuplas y tipos complejos:

```ets
type NumberList = number[]
type Pair<T, U> = [T, U]
type Callback<T> = (value: T) => void
type StringOrNumber = string | number
```

Los generics funcionan igual que en TypeScript: el alias se instancia
en cada uso.

### 17.3 `satisfies`

`satisfies` verifica que un valor **cumple** un tipo sin cambiar su
tipo inferido (a diferencia de `as`, que es un cast). Útil para
validar literales:

```ets
let config = {
  host: "localhost",
  port: 8080
} satisfies Record<string, string | number>
```

---

## 18. Enums

Los enums son similares a uniones sin payload, pero con semántica de
**constantes con nombre**:

```ets
enum Color { Red, Green, Blue }
let c: Color = Color.Green
```

Con valores explícitos:

```ets
enum Status {
  Ok = 200,
  NotFound = 404,
  Error = 500
}
```

El dialecto los trata como `union` internamente, así que se pueden
usar directamente en `match`:

```ets
match (status) {
  case { kind: "Ok" }: "éxito"
  case { kind: "NotFound" }: "no encontrado"
  case { kind: "Error" }: "fallo"
}
```

---

## 19. Control flow: switch, for-of, for-in, while

### 19.1 `switch/case/default`

Funciona como en C/JavaScript pero con `case` por valor (sin fallthrough
implícito — cada `case` debe terminar con `break` o `return`):

```ets
switch code {
  case 200: print("ok"); break
  case 404: print("not found"); break
  default: print("otro código")
}
```

Para matching más potente, prefiere `match` (§15) con `when` o
`whenType`.

### 19.2 `for...of` (iterables)

Itera sobre los elementos de un array:

```ets
let xs: number[] = [1, 2, 3, 4]
for (const x of xs) print(x)  // 1 2 3 4
```

Se puede romper con `break` o saltar con `continue`:

```ets
for (const x of xs) {
  if (x > 2) break
  print(x)
}
```

### 19.3 `for...in` (claves)

Itera sobre las **claves** de un objeto:

```ets
let obj: Record<string, number> = { a: 1, b: 2 }
for (const k in obj) print(k, obj[k])
```

### 19.4 `while`

```ets
let i: number = 0
while (i < 10) {
  print(i)
  i = i + 1
}
```

El dialecto no tiene `do...while` (considerado harmful por la
comunidad TS).

### 19.5 `break` y `continue`

`break` sale del bucle o switch actual. `continue` salta a la siguiente
iteración:

```ets
for (const x of xs) {
  if (x < 0) continue  // salta negativos
  if (x > 100) break   // sale del bucle
  print(x)
}
```

---

## 20. Async y await

El dialecto soporta **funciones asíncronas** y **await** sobre el
runtime async del V26 (basado en libuv + corutinas C++20).

### 20.1 Funciones async

```ets
async function fetchUser(id: number): Promise<User> {
  let response = await http.get("https://api.example.com/users/" + id.toString())
  return response.json() as User
}
```

Una función marcada `async` siempre retorna `Promise<T>` (o
`Task<T>`). Si declaras `Promise<User>`, debes retornar `User` (el
empaquetado en Promise es implícito).

### 20.2 await

`suspende` la corutina hasta que la promesa se resuelva:

```ets
let r1: Response = await fetch("https://a.com")
let r2: Response = await fetch("https://b.com")  // secuencial
```

Para **paralelizar** varias operaciones, usa `Promise.all`:

```ets
let results: Response[] = await Promise.all([
  fetch("https://a.com"),
  fetch("https://b.com"),
  fetch("https://c.com"),
])
```

### 20.3 `for await...of`

Itera sobre un stream de promesas:

```ets
for await (const chunk of readStream) {
  process(chunk)
}
```

### 20.4 Cancelación con CancellationToken

```ets
async function longRunning(ct: CancellationToken): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (ct.cancelled) return
    await sleep(100)
  }
}

let token = new CancellationToken()
longRunning(token)
token.cancel()  // cancela la corutina
```

---

## 21. Parámetros: default, rest, spread

### 21.1 Parámetros por defecto

```ets
function greet(name: string, greeting: string = "Hola"): string {
  return greeting + ", " + name
}

greet("Ana")              // "Hola, Ana"
greet("Ana", "Adiós")     // "Adiós, Ana"
```

### 21.2 Parámetros rest (`...args`)

```ets
function sum(...nums: number[]): number {
  let total = 0
  for (const n of nums) total = total + n
  return total
}

sum(1, 2, 3, 4)  // 10
```

`...nums` agrupa los argumentos restantes en un array. Debe ser el
**último** parámetro.

### 21.3 Spread en llamadas

```ets
let args: number[] = [1, 2, 3]
sum(...args)  // equivalente a sum(1, 2, 3)
```

### 21.4 Spread en arrays y objetos

```ets
let xs: number[] = [1, 2, 3]
let ys: number[] = [...xs, 4, 5]  // [1, 2, 3, 4, 5]

let user = { name: "Ana", age: 30 }
let admin = { ...user, role: "admin" }  // { name, age, role }
```

### 21.5 Destructuring en parámetros

```ets
function move({ x, y }: Point, dx: number, dy: number): Point {
  return { x: x + dx, y: y + dy }
}
```

---

## 22. Decoradores

Los decoradores son **anotaciones de compile-time** que modifican cómo
se genera el código C++ o cómo el runtime trata un valor. Empiezan
siempre con `@`.

### 22.1 Decoradores predefinidos

```ets
@deprecated("usar fetchUser2 en su lugar")
function fetchUser(id: number): Promise<User> { ... }

@cpp_name("mi_funcion_cpp")
function miFuncion(): void { ... }

@sealed
class Widget { ... }
```

- `@deprecated(msg?)` — emite warning en cada llamada.
- `@cpp_name("...")` — renombra el símbolo C++ generado (útil para
  interoperar con C).
- `@cpp_type("...")` — usa un tipo C++ concreto en lugar del mapeo
  automático.
- `@sealed` — marca la clase como no extensible (ver PR #139).
- `@link("lib")` — añade `-l<lib>` al link (solo en `.lib.ets`).
- `@include("header.h")` — añade `#include <header.h>` al cpp
  generado (solo en `.lib.ets`).

### 22.2 Decoradores personalizados (próximamente)

El mecanismo de decoradores está abierto a user-defined decorators en
versiones futuras (V3+).

### 22.3 Decoradores a nivel de módulo

En archivos `.lib.ets` (librerías), los decoradores `@link` y
`@include` se interpretan como directivas del header generado:

```ets
@link("-lc")
@include("stdio.h")
@cpp_name("putchar")
export function putchar(c: i32): i32;
```

El codegen emite:
```cpp
#include <stdio.h>
// forward decl con el nombre C
extern "C" int putchar(int c);
```

---

## 23. Type narrowing con `instanceof` y `typeof`

### 23.1 `typeof` para primitivos

```ets
match (typeof x) {
  case { kind: "number" }: "es número"
  case { kind: "string" }: "es string"
  case { kind: "boolean" }: "es boolean"
  case _: "otro"
}
```

`typeof` retorna un literal string (`"number"`, `"string"`,
`"boolean"`, `"object"`, `"undefined"`). Funciona en `if` y en
`match` con narrowing.

### 23.2 `instanceof` para clases

```ets
if (animal instanceof Dog) {
  animal.bark()  // narrowed a Dog
} else if (animal instanceof Cat) {
  animal.meow()  // narrowed a Cat
}
```

`instanceof` comprueba el **tipo dinámico exacto** y aplica narrowing
automático. Es seguro de usar con clases (no con interfaces, que son
estructurales).

### 23.3 Type guards con `whenType`

Para narrowing de uniones sin usar `match` (§15.2):

```ets
match (v) {
  when((x: string | number): x is "string" => typeof x == "string",
       (): string => "string de largo " + length(x))
  when((x: string | number): x is "number" => typeof x == "number",
       (): number => x)
}
```

`whenType` actúa como un type guard: dentro de la rama, `x` tiene
el tipo refinado. A diferencia de TypeScript, el predicado debe ser
un type guard demostrable, no una expresión arbitraria.

### 23.4 `delete` para propiedades opcionales

```ets
let user: { name: string, age?: number } = { name: "Ana" }
delete user.age
// ahora user.age es undefined
```

Útil para interfaces con campos opcionales.

---

## 24. Lectura de archivos streaming con `FileReader`

`fileRead(path)` carga el archivo entero en memoria. Para archivos
grandes (logs, CSVs, JSON streams, binarios) eso es prohibitivo en RAM.
`FileReader` resuelve esto: mantiene el descriptor del OS abierto y
permite recorrer el archivo caracter a caracter o por bloques, sin
copiarlo nunca entero a memoria.

### 24.1 Abrir y leer línea a línea

```ets
function countLines(path: string): number {
  let reader: FileReader = openFileReader(path)
  let count: number = 0
  while (!reader.eof()) {
    let line: string = reader.readLine()
    if (line == "") break          // EOF: string vacio
    count = count + 1
  }
  reader.close()
  return count
}

let total: number = countLines("/var/log/syslog")
print("Lineas: ", total)
```

`readLine()` lee hasta el próximo `\n` (incluido) y lo devuelve. Si el
archivo no termina en newline, la última línea se devuelve sin el
terminador. Cuando ya no hay más datos devuelve `""` (string vacío).
Usa `eof()` para distinguir EOF de una línea vacía válida.

### 24.2 Leer por bytes / chunks

```ets
function firstBytes(path: string, n: number): string {
  let reader: FileReader = openFileReader(path)
  let data: string = reader.read(n)      // hasta n bytes
  reader.close()
  return data
}

function readAll(path: string): string {
  let reader: FileReader = openFileReader(path)
  let data: string = reader.read(0)      // 0 = hasta EOF
  reader.close()
  return data
}
```

`read(n)` lee hasta `n` bytes. Si `n` es `0` (o no se pasa), lee hasta
EOF. El cursor avanza tras la lectura.

`readChar()` lee **un byte** y devuelve un `number` (0–255), o `-1` en
EOF. Útil para parsear byte a byte.

### 24.3 Lookahead con `peek` y `peekChar`

Los parsers a menudo necesitan ver el siguiente byte antes de
consumirlo. `peekChar()` y `peek(n)` hacen lookahead **sin avanzar el
cursor**:

```ets
function skipBom(path: string): FileReader {
  let reader: FileReader = openFileReader(path)
  let bom: string = reader.peek(3)
  if (bom == "\u00EF\u00BB\u00BF") {     // UTF-8 BOM
    let trash: string = reader.read(3)   // consume el BOM
  }
  return reader
}
```

Tras `peek(n)`, la siguiente llamada a `read(n)` o `readChar()`
devuelve los mismos bytes. Esto permite dispatchers y detectores de
formato (BOM, magic bytes, primer token) sin riesgo de perder datos.

### 24.4 Cerrar el descriptor

`close()` cierra el descriptor del SO. Tras `close()`, el reader ya no
es usable. El destructor del reader también cierra automáticamente si
te olvidas de llamar `close()` explícitamente — el descriptor no se
fuga.

```ets
let r: FileReader = openFileReader(path)
// ... uso ...
r.close()
```

### 24.5 Manejo de errores

A diferencia de `fileRead` (que devuelve `Result<string, string>`),
`openFileReader` **aborta con exit(1)** si el archivo no existe o no
se tienen permisos. Esto es consistente con la convención "fail fast"
del dialecto en I/O. Si necesitas control explícito, comprueba primero
con `fileExists`:

```ets
if (fileExists(path)) {
  let r: FileReader = openFileReader(path)
  // ... uso seguro ...
  r.close()
} else {
  print("Archivo no encontrado: ", path)
}
```

### 24.6 Resumen de la API

| Método | Devuelve | Avanza cursor |
|---|---|---|
| `openFileReader(path)` | `FileReader` (aborta si falla) | — |
| `readChar()` | `number` (0–255, o -1 en EOF) | sí (+1) |
| `peekChar()` | `number` (0–255, o -1 en EOF) | no |
| `read(n?)` | `string` (hasta n bytes, o hasta EOF si n=0) | sí (+leídos) |
| `peek(n)` | `string` (hasta n bytes, menos si EOF) | no |
| `readLine()` | `string` (`""` en EOF) | sí (+hasta `\n` o EOF) |
| `eof()` | `boolean` | no |
| `close()` | `void` | — |

`FileReader` está marcado como `sealed` (no se puede heredar de él)
y vive en `runtime/ets_file.hpp`. El codegen incluye ese header
automáticamente al detectar el uso de `openFileReader`.

---

## Resumen de versiones

- **V15**: compilación incremental por módulos
- **V16**: includes selectivos + `--minimal`
- **V17**: pre-compiled headers + includes granularizados
- **V18**: librerías externas vía `@link`/`@include`/`@cpp_name`/`@cpp_type`
- **V19**: encapsulación `private`/`public`/`protected`
- **V20**: parameter properties (sintaxis abreviada)