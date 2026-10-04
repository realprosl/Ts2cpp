# Limitaciones del dialecto Estatic

El dialecto "Estatic" es un subset curado de TypeScript con salida a C++20.
NO es un transpilador TS-completo: muchas features de TypeScript se han
rechazado explícitamente para mantener las garantías del dialecto (RAII
puro, sin herencia, sin `Object`/`any`/`unknown`).

Este documento está dividido en tres secciones:

- **✅ Implementado** — features de TS soportadas. Para uso y ejemplos ver `README.md`.
- **❌ Rechazado por diseño** — features que el dialecto NUNCA tendrá (con motivo).
- **🟡 Pendiente / TS no cubierto** — features en TS que aún no están en el dialecto.

> Este doc se sincroniza con el código vía `scripts/check-docs-sync.ts`. Si
> encuentras una feature implementada que no aparece en "Implementado", o una
> limitación que el código ya no aplica, ejecuta el check y abre una PR.

---

## ✅ Implementado

Lista no exhaustiva — ver `README.md`, `examples/` y los nodos AST en
`src/ast/nodes.ts` para la cobertura completa.

### Sistema de tipos

- Tipos primitivos: `number`, `string`, `boolean`, `void`.
- Genéricos con constraints (`<T extends X>`) y parameter packs (`<T...>`).
- Sobrecargas de funciones libres resueltas estáticamente por firma.
- Type aliases (`type X = …`).
- **Unions** (`A | B | C`) e **intersecciones** (`A & B`) de tipos.
- **Satisfies operator** (`expr satisfies T`, TS 4.9).
- `typeof` valor y `typeof` tipo (`T typeof expr`).
- `instanceof` para validar miembros de un union contra una clase.
- `readonly` en campos de clase.
- Optional parameters (`name?: T`).
- Tipos literales numéricos no decimales (`0xFF`, `0b1010`, `0o17`).

### Clases y objetos

- Clases por valor (sin herencia, sin vtable) — `class X { field: T; method(): R }`.
- Constructores (`constructor(params) { this.x = params.x; }`).
- Decoradores simples (`@deprecated` emite warning; `@sealed` no-op).
- Interfaces estructurales (sin `implements` explícito).
- Composición de campos (la clase satisface una interface por estructura).

### Funciones y control de flujo

- `function`, arrow functions, closures, lambdas con `std::function`.
- Parámetros rest (`...args: T[]`) y variádicos genéricos.
- `if/else`, `while`, `for`, `for..in`, `for..of`, `for await..of`.
- `break`, `continue` validados por contexto.
- **Operador ternario** `cond ? then : else`.
- **Match expressions** — V23 introduce la forma TS-compatible
  `match(value, [when(pat, cb), otherwise(cb)])` (compilada a IIFE con
  if/else chain). La forma V2 destructurada `match (r) { case { kind: ... }:
  ...; case _: ... }` se mantiene y es la única con enforcement de
  exhaustividad. La forma TC39 `match (x) { when (pat) => r; }` se
  eliminó en V23. Patrón por igualdad; sin narrowing real en `whenType`
  (issue #95).
- `switch / case / default` sobre enums, strings y números.
- `delete` sobre propiedades dinámicas de Map/Set.
- `await` y `async function` (compilados a corutinas C++20).
- `for await (const x of Promise<T>[])` para iterar arrays de promesas.
- **Narrowing de tagged unions** (V1.4): si `if (r.ok == true)` marca la
  expresión como narrowada y `r.value` resuelve al tipo del payload sin
  cast explícito. Funciona con la sintaxis object-variant
  `{ ok: true; value: T } | { ok: false; error: E }` (V1.4) y con unions
  nombradas (V1.2+).
- **Escape implícito** (V8.0): si la firma de retorno es `Unq<T>` o
  `Rc<T>`, `return new T()` o `return x` se envuelve automáticamente con
  `unSome<T>(...)` o `rcShare<T>(...)`. El usuario no tiene que
  escribir el envoltorio manualmente.

### Strings y literales

- String literals con escapes (`\n`, `\t`, `\"`, etc.).
- **Template literals con interpolación** `` `Hola ${name}` `` y anidamiento.
- Multi-línea literal.

### Colecciones

- **`arr.filter((x: T) => boolean): T[]`** sobre arrays `T[]`. Se emite a
  `ets_filter_vec<T>` (V7.0).
- **`arr.map<U>((x: T) => U): U[]`** — transforma cada elemento. Se emite
  a `ets_map_vec<T, U>` (V7.0).
- **`arr.reduce<U>(init: U, op: (acc: U, x: T) => U): U`** — pliega el
  array respetando `init` si está vacío. Se emite a `ets_reduce<U, T>` (V7.0).
- **Fusión AST** (V7.1): la cadena `arr.filter(p).map(f).reduce(init, op)`
  se reescribe a un único `for` cuando todos los tipos son primitivos
  y la fuente es simple. Sin asignaciones intermedias.
- `arr.length` (alias del builtin `length(arr)`).
- **No hay** `forEach`, `find`, `some`, `every`, `sort`, `slice`,
  `concat`, `flatMap` — pendiente.

### Operadores

- Aritméticos: `+ - * / %`.
- Relacionales: `< <= > >= == !=`.
- Lógicos: `&& || !`.
- Bitwise: `& | ^ ~ << >>` (TS 5.x).
- **Nullish coalescing `??`** sobre `Optional<T>`.
- **Optional chaining `?.`** sobre `Optional<T>`.
- Ternario `cond ? a : b`.

### Módulos

- `export` de declaraciones top-level.
- **`export default`** y **`export { x as y }`**.
- Sistema de módulos con `moduleRoots` y aliases (`src/modules/`).
- `import` interno para resolver referencias (no dinámico).

### Stdlib y runtime (`runtime/`)

- `Result<T>`, `Optional<T>`, `Task<T>` (Promise C++).
- `Map<T>`, `Set<T>` con `forEach`, `has`, `get`, `set`, `delete`, `size`.
- `etS::concat` para strings heterogéneos.
- `numberToString`, `length`, `charAt`, `concat`.
- **Memory Model v2 (V22)**: `ptr<T>` (`std::unique_ptr<T>`),
  `constPtr<T>` (`std::unique_ptr<const T>`), `ref<T>` (`T&`),
  `constRef<T>` (`const T&`). Sustituyen a `Un<T>`, `Rc<T>`, `Mut<T>`,
  `MutRef<T>`. Ver `docs/memory-model.md` para el contrato completo.
- Helpers async: `all(tasks)`, `race(tasks)`, `sleep(ms)`.
- File I/O: `readFile`, `writeFile`, `appendFile`, `copyFile`, `moveFile`,
  `removeFile`, `fileExists` (+ variantes `Async`).
- Console: `print`, `printError`, `write`, `writeError` + `console.log/info/debug/trace/warn/error`.
- HTTP: `http-server.ets` con `TcpListener` y `TcpConnection`.
- TLS: `tls-server.ets` con `TlsContext` y `TlsConnection`.
- JSON.parse con árbol dinámico `JsonValue`.

### Compilador y tooling

- CLI `init` para scaffolding de proyectos.
- Modo incremental con cache SHA-256 por módulo.
- Build unitario con `--unity` para inspección.
- Suite de tests con `node:test` y golden files.
- Informe de compilación JSON (`build/.estatic/transpiler-report.json`).
- Tree-sitter grammar para editores (vendored en `third_party/`).

---

## ❌ Rechazado por diseño

Estas features **no se implementarán** — son incompatibles con las garantías
del dialecto (RAII puro, sin vtable, sin tipado dinámico).

| Feature rechazada | Razón |
|---|---|
| `Object`, `any`, `unknown` | Sin tipado dinámico — sin tipo "trampolín" para valores flexibles |
| `throw` / `try` / `catch` | Rompe RAII — usar `Result<T, E>` |
| Herencia (`extends`, `implements`) | Polimorfismo dinámico requiere vtable |
| `>>>`, `===`, `!==` | Operadores ambiguos o coerción no deseada en C++ |
| `arguments` | C++ no tiene arguments object — usar rest (`...args`) |
| `eval` | Seguridad + rendimiento |
| `function*` (generadores) | Lazy iteration no encaja con RAII — usar async/Promise |
| Tagged templates (`tag\`...\``) | Sin uso idiomático claro en el dialecto |
| Dynamic imports (`import("...")`) | El dialecto es single-translation-unit |

---

## 🟡 Pendiente / TS no cubierto

Features de TypeScript presentes en versiones modernas (TS 3.x+ / 4.x / 5.x)
que el dialecto aún no implementa. **Se aceptan contribuciones** en estas
áreas si no rompen las garantías del dialecto.

### Sistema de tipos avanzado

- `as` / `<T>x` type assertions — se prefiere `match` para narrowing.
- `const` type parameters (`<T const>`).
- Conditional types (`T extends U ? X : Y`) en tipos.
- Mapped types (`{ [K in keyof T]: V }`).
- `keyof T` operator.
- Utility types (`Partial`, `Pick`, `Record`, `Required`, `Omit`).
- Template literal types (`` `prefix_${T}` ``).
- `infer U` en conditional types.
- Variadic tuple types (`[...T, ...U]`).
- Tuples con spread variádico (`[T, ...U]`).
- `if (typeof x === "string") { x.toUpperCase() }` — narrowing por tipo (cubierto por V1.4 para tagged unions con discriminador literal).
- Exhaustiveness checking con `never` — el dialecto no valida la rama `_ =>` por cobertura exhaustiva; sigue siendo pattern matching por igualdad.
- Type predicates `x is T`.

### Clases y objetos

- Getters / setters (`get` / `set`).
- Modificadores `private` / `protected` / `public` / `abstract`.
- `static` en miembros.
- Index signatures `[key: string]: T`.
- Override de métodos (no aplica — sin herencia).

### Memory Model v2 — pendiente

V22 introdujo los 4 modificadores `ptr<T>`, `constPtr<T>`, `ref<T>`,
`constRef<T>` y la semántica de copia para `T`. **PR#1 (tipos),
**PR#2 (value semantics), **PR#4 (make_unique)** y **PR#5 (moves con
tracking completo + E4102/E4103)** están entregados y probados. La
mayor parte de **PR#3 (borrows V1)** está entregada (E4203/E4204/E4205
+ rechazo de retornos `ref<T>`). Las siguientes funcionalidades siguen
pendientes:

- **PR#6 — Borrow conflicts**: aliasing mutable (`ref + ref`, `ref +
  constRef`) no se detecta aún.
- **PR#7 — Async/closures/generics**: las restricciones V1 (no
  capturas escaping de borrows, no copy de move-only en generics, no
  uso de `ptr<T>` post-await) no se enforce completamente.
- **`Rc<T>`** (shared ownership): deprecado en V22. Se rediseñará con
  `weak<T>` en un PR futuro.
- **Nullable ptr explícito**: `let p: ptr<T> = null` no se admite
  todavía. El estado vacío se obtiene únicamente vía `move()`.
- **Lifetime parameters** (`<'a>`): no soportados.
- **Non-lexical lifetimes**: solo se implementará el modelo léxico
  básico (el préstamo termina al salir del bloque).

> Diagnósticos actualmente en uso por el checker: **E4102** (use of moved
> value), **E4103** (use of maybe-moved value), **E4203** (ref/constRef
> en campo), **E4204** (ref/constRef en async), **E4205** (ref/constRef
> como argumento de tipo genérico), **E42xx** (ref/constRef como
> retorno), **E4400-E4406** (APIs legacy `mut`/`Mut`/`MutRef`/`Unq`/
> `Rc`/`out`).

### Módulos y tooling

- Dynamic imports.
- Type-only imports (`import type { X }`).
- Re-exports `export { X } from "..."`.
- Triple-slash directives.
- `globalThis` / `global`.

### Stdlib y runtime

- `fetch` nativo (usar `runtime/ets_net.hpp` o librería externa).
- Streams / `ReadableStream`.
- Workers / `SharedArrayBuffer`.
- `Buffer` (Node-style).

### Compilador

- Source maps entre `.ets` y C++.
- Backend abstracto para generar otros destinos (no solo C++).
- Cabeceras individuales por módulo para ABI precisa.

---

## Cómo se mantiene este doc

`scripts/check-docs-sync.ts` cruza automáticamente:

- Nodos AST exportados en `src/ast/nodes.ts`.
- `TokenKind` y `KEYWORDS` en `src/lexer/token.ts`.
- Ejemplos en `examples/*.ets`.
- Afirmaciones en este `LIMITATIONS.md`.

Si un nodo, keyword o ejemplo **no** aparece mencionado en este doc, el check
falla. Si una afirmación aquí contradice el código (ej. decir "no soportado"
cuando hay un nodo AST para ello), también falla.

Para ejecutarlo:

```bash
node --experimental-strip-types scripts/check-docs-sync.ts
```

El test `test/docs-sync.test.ts` lo invoca automáticamente y falla el build si
la documentación se desincroniza del compilador.
