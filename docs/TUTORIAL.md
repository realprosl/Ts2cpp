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

## Resumen de versiones

- **V15**: compilación incremental por módulos
- **V16**: includes selectivos + `--minimal`
- **V17**: pre-compiled headers + includes granularizados
- **V18**: librerías externas vía `@link`/`@include`/`@cpp_name`/`@cpp_type`
- **V19**: encapsulación `private`/`public`/`protected`
- **V20**: parameter properties (sintaxis abreviada)