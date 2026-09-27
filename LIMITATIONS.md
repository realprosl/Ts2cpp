# Limitaciones del dialecto Estatic

El dialecto "Estatic" es un subset curado de TypeScript con salida a C++20.
NO es un transpilador TS-completo: muchas features de TypeScript se han
rechazado explícitamente para mantener las garantías del dialecto (RAII
puro, sin herencia, sin `Object`/`any`/`unknown`).

Esta lista documenta lo que el dialecto **NO soporta** y por qué. Para ver
lo que SÍ soporta, consultar `README.md`.

## Tipos del sistema

- **`Object`, `any`, `unknown`** — rechazados. Sin tipo "trampolín" para
  valores dinámicos. Si necesitas tipar algo flexible, usa un union
  explícito o un tipo definido por el usuario.
- **`never`** — rechazado. No se distingue de `void` en este dialecto.
- **Implicit conversions** entre tipos no relacionados — rechazadas.
  Excepción: `Path` se convierte a `string` automáticamente en llamadas a
  `path.*` y funciones que esperan string.
- **Type assertions (`as`, `<T>x`)** — no soportados. El dialecto prefiere
  generics y type narrowing. Si necesitas convertir un union a un tipo
  concreto, refactoriza con `match`.

## Inferencia

- **`satisfies` operator** — pospuesto. El dialecto no distingue entre
  tipo inferido y tipo declarado en la misma expresión (siempre es uno).
- **`const` generics** — pospuesto. Sin reificación, no se pueden usar
  tipos como `T extends 1 | 2 | 3` para derivar otros tipos.
- **Conditional types / mapped types / `infer`** — no soportados.
  El dialecto no tiene un sistema de tipos computacional.
- **Template literal types** (`\`hello ${T}\`` como tipo) — no soportados.

## Clases y objetos

- **Herencia (`extends`, `implements`)** — rechazado. Las clases son
  *value types* planos sin vtable. Si necesitas reutilizar comportamiento,
  usa composición + interfaces estructurales.
- **Polimorfismo dinámico** — no soportado. Sin `instanceof` con jerarquía,
  sin despacho virtual, sin override de métodos.
- **Mixins** — no soportados. Misma razón que herencia.
- **Decoradores stage 2 (con metadata reflection)** — solo se soporta
  el subset TC39 stage 3 simple. `@deprecated` emite un warning a stderr
  en cada llamada. `@sealed` es no-op (sin herencia donde aplicarse).
- **Getters / setters** — no soportados como sintaxis TS. El dialecto
  usa métodos `getX()` / `setX()` cuando es necesario.
- **Operador `delete`** — soportado solo para propiedades dinámicas
  (path-keyed maps); no libera memoria como en JS.

## Funciones

- **`this` binding dinámico** — no soportado. El dialecto usa `(*this)`
  explícito en métodos. No hay `Function.prototype.bind`.
- **`arguments`** — no soportado. Usa parámetros rest (`...args`).
- **Funciones generadoras (`function*`)** — no soportadas. Usa async
  functions + promesas.
- **Async iterators (`Symbol.asyncIterator`)** — solo `for await...of`
  sobre arrays de promesas. No hay iteración lazy.

## Arrays y colecciones

- **`Array<T>` como clase** — el dialecto usa `T[]`. No hay métodos
  `Array.prototype.*` dinámicos; solo `length(arr)`, indexing, y loops.
- **`push`, `pop`, `shift`, `unshift`** — no soportados en el dialecto
  source. Para inicializar vectores move-only, usa el literal con lambda
  helper que el codegen emite (Fase 1.8 fix). Para mutación, usa índices.
- **`splice`, `slice`** — no soportados.
- **Spread con arrays grandes** — funciona pero con copia completa; en
  C++ no hay COW.
- **Tuples con spread variádico (`[T, ...U]`)** — pospuesto. Sin
  reificación de tuples, no se puede despachar por aridad dinámica.

## Strings

- **String indexing mutable** — no soportado (`s[0] = "a"`).
- **Template literal types** — ver arriba (en tipos).
- **Tagged templates** — no soportados.

## Errores y control de flujo

- **`throw` / `try` / `catch`** — rechazados. El dialecto usa `Result<T, E>`
  para propagar errores. Esto es por diseño (RAII requiere no saltar
  entre scopes).
- **`Promise.reject`** — la operación sí existe pero no es preferida;
  usa `Result<T, E>` o valores centinela.
- **`process.exit(n)`** — soportado vía runtime, pero no es idiomático.
  En el dialecto se prefiere devolver `Result<...>` y que el caller
  decida.

## Módulos

- **`import`** — no soportado. El dialecto es single-translation-unit
  por diseño. Para multi-archivo, concatena los fuentes antes de
  transpilar o usa el sistema de `moduleRoots`/`aliases` para resolver
  rutas virtuales.
- **`require`** — no soportado (mismo motivo).
- **Dynamic imports** — no soportados.
- **`export default` / `export { x as y }`** — soportados como marcas
  semánticas (AST-level). En runtime se procesan como top-level directas.
  No hay sistema de módulos ES en C++.

## Runtime

- **`setTimeout`, `setInterval`** — soportados vía `runtime/ets_async.hpp`.
  No devuelven `NodeJS.Timeout`, devuelven handles numéricos.
- **`fetch`** — no soportado. Usa el cliente HTTP de la runtime
  (`ets_http.hpp`) o una librería externa.
- **`console.log`** — reconocido como alias de `print`. Todos los métodos
  `log/info/debug/trace/warn/error` funcionan.

## Operadores

- **`===`, `!==`** — usar `==` y `!=`. El dialecto no distingue identidad
  vs igualdad estructural (todo es igualdad por valor).
- **`>>>` (logical right shift)** — rechazado. C++20 tiene `>>` con
  semántica implementation-defined para signed; en el dialecto solo
  soportamos `>>` aritmético.
- **`typeof x === "string"`** — soportado vía operador `typeof`, pero el
  resultado es un tipo (`TypeName`), no un string literal. No hay
  narrowing dinámico como en JS.

## Output C++

- **Sin templates genéricos en user code** — los generics se reifican
  al tipo concreto en el código generado. Si defines `function id<T>(x: T): T`,
  no se emite un template C++; se emite una función no-template (porque
  el dialecto no tiene reificación en runtime).
- **Sin múltiples unidades de traducción** — todo el código se emite
  en un solo `.cpp`. Para multi-archivo, usa `#pragma once` en headers
  pre-compilados o concatena los sources.
- **Sin LTO automático** — el LTO en C++ requiere flags especiales
  (`-flto`). El CLI pasa `config.compiler.flags` tal cual.

## Limitaciones intencionales del dialecto

El dialecto rechaza por diseño estas features porque rompen las
garantías de RAII o pureza funcional:

| Feature rechazada | Razón |
|---|---|
| `Object`, `any`, `unknown` | Sin tipado dinámico |
| `throw`/`try`/`catch` | Rompe RAII |
| Herencia | Polimorfismo dinámico requiere vtable |
| `>>>`, `==` con coerción | Operadores ambiguos en C++ |
| `arguments` | C++ no tiene arguments object |
| `eval` | Seguridad + rendimiento |

Si necesitas una de estas features, considera reescribir el código en
TypeScript nativo o en otro lenguaje con el runtime apropiado.
