# Roadmap Estatic v2

Plan de ejecución derivado de [`vision.md`](./vision.md). Cada fase produce código commiteado en su propia rama, con tests pasando y PR abierto. La numeración V0-V10 es **orden de ejecución**, no prioridad estética: V0 es prerrequisito de todo lo demás.

## Regla de dependencia

Antes de la V1, **toda la información semántica debe vivir en el AST**, no en mapas paralelos ni en string-matching del codegen. Las fases V1-V10 se apoyan en ese cimiento.

Sin V0 completada, las features de visión son casts en el vacío: el compilador no tiene acceso a la información que necesita para tomar decisiones.

---

## V0 — Cimiento semántico

Refactor interno, no añade funcionalidad visible. Multiplica lo que las fases siguientes pueden hacer.

### V0.1 — Anotar el AST con tipos resueltos

**Problema actual**: `TypeChecker.types: Map<Expression, TypeName>` es un mapa aparte. Los tipos se serializan a strings para hacer lookups (`"Result<string, IOError>"`, `"Optional<number>"`).

**Objetivo**: cada `Expression` lleva su `resolvedType` como propiedad del nodo. Las lookups son accesos directos, no búsquedas en strings.

**Alcance**:
- Añadir campo `resolvedType?: ResolvedType` a `Expression` en `src/ast/nodes.ts`.
- `ResolvedType` es un tipo discriminado (no string):
  ```ts
  type ResolvedType =
    | { kind: "primitive"; name: "number" | "string" | "boolean" | "void" }
    | { kind: "class"; name: string; substitutions: Map<string, ResolvedType> }
    | { kind: "optional"; inner: ResolvedType }
    | { kind: "result"; ok: ResolvedType; err: ResolvedType }
    | { kind: "task"; inner: ResolvedType }
    | { kind: "array"; element: ResolvedType; size?: number }
    | { kind: "function"; params: ResolvedType[]; returns: ResolvedType };
  ```
- `TypeChecker` deja de usar `this.types.set(...)` y escribe en `expr.resolvedType`.
- `cppType` consume `expr.resolvedType.kind === "class"` en lugar de hacer match sobre strings.
- `typeMatches` consume `resolvedType` directamente.

**Done cuando**:
- Todos los tests unit (138/138) siguen verdes sin cambios funcionales.
- `grep -rn "Map<Expression, TypeName>" src/` retorna 0 ocurrencias.
- `grep -rn "isGenericType\|genericBase" src/codegen/` solo aparece donde realmente hay genéricos (no en cada llamada a `cppType`).

### V0.2 — Atributos semánticos en `Symbol`

**Problema actual**: `runtimeGlobals: Set<string>` en `cpp-generator.ts` decide renombrar variables con string-match.

**Objetivo**: los símbolos saben si vienen del runtime, si son exportados, su modo de paso, etc.

**Alcance**:
- Extender `VariableSymbol` con `fromRuntime?: boolean`, `passing?: "in" | "out" | "mut" | "move"`.
- `SymbolTable` se rellena durante el semantic; el codegen solo lee.
- Eliminar `runtimeGlobals` del codegen.

**Done cuando**:
- `grep -rn "runtimeGlobals" src/codegen/` retorna 0 ocurrencias.
- Los tests siguen verdes.

### V0.3 — Includes decididos por visitor, no por regex

**Problema actual**:
```ts
private usesTls(program: Program): boolean {
  return /\b(?:TlsContext|TlsConnection|createTlsServer|...)\b/.test(JSON.stringify(program));
}
```

**Objetivo**: un visitor recorre el AST preguntando a cada `CallExpression` qué helper global invoca. `Set<RuntimeModule>` se construye por estructura.

**Alcance**:
- `walkProgram(program, visitor)` que visita todos los `CallExpression`.
- `needsIncludes(program): Set<RuntimeModule>` reemplaza `usesTls` + `usesCompilerAst`.
- Mantener compatibilidad: el CLI sigue invocando los mismos `runtime/ets_*.hpp`.

**Done cuando**:
- `grep -rn "JSON.stringify(program)" src/` retorna 0 ocurrencias.
- Tests verdes.

### V0.4 — Helpers declaran su módulo runtime

**Problema actual**: `HELPER_METADATA` solo tiene `minParams`, `returnsGeneric`, `returnsRef`. No sabe qué include necesita cada helper.

**Objetivo**: añadir `requires: RuntimeModule[]` a cada helper.

**Alcance**:
- `RuntimeModule` es unión cerrada: `"ets_async"`, `"ets_file"`, `"ets_net"`, `"ets_tls"`, `"ets_ast"`, etc.
- `HELPER_METADATA.fileRead = { minParams: 1, requires: ["ets_file"] }`.
- `HELPER_METADATA.tcpListen = { minParams: 2, requires: ["ets_net"] }`.
- `needsIncludes` consume estos metadatos en lugar de hardcodear nombres.

**Done cuando**:
- Tests verdes.
- La lista de includes para un programa dado es **idéntica** a la que producía el regex antes del refactor (verificación por snapshot de un test E2E).

---

## V1 — Uniones discriminadas y narrowing

**Issue propuesta**: parent "Visión Estatic v2" con sub-issue `#19`.

Tipos de datos algebraicos (tagged unions): el AST sabe que un valor puede ser uno de varios casos etiquetados. El narrowing asegura que dentro de cada rama solo se accede al miembro correcto.

**Alcance**:
- Sintaxis de declaración:
  ```ts
  type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
  type FileError = { kind: "NotFound"; path: string } | { kind: "PermissionDenied" } | { kind: "IOError"; message: string };
  ```
- Narrowing por `if (result.ok) { result.value } else { result.error }`.
- Eliminar el `Result<T,E>` temporal del Bloque B (#8) y rehacerlo como tagged union real.
- Codegen: cada caso se representa como struct C++ con tag enum; `match` se traduce a `switch` con `[[unlikely]]` en la rama de error.

**Depende de**: V0.1 (resolvedType), V0.4 (includes declarativos).

**Riesgo**: medio — la sintaxis de tipos suma puede romper otros tests.

**Done cuando**:
- `Result<T,E>` con dos casos funciona end-to-end.
- Tests E2E: `result-ok`, `result-err`, `narrowing-ok`, `narrowing-err`.
- Suite completa sigue verde.

---

## V2 — Pattern matching exhaustivo

`match(expr) { case ... }`. El compilador verifica que **todas** las posibilidades están cubiertas. Si falta un caso, error de compilación.

**Alcance**:
- Sintaxis:
  ```ts
  const message: string = match(fileError) {
    case { kind: "NotFound", path }: "missing: " + path;
    case { kind: "PermissionDenied" }: "denied";
    case { kind: "IOError", message }: "io: " + message;
    // <- sin este caso: error de compilación
  };
  ```
- Verificación de exhaustividad en compilación: el AST de `match` tiene la lista de `MatchArm` y el `ResolvedType` del subject. Si `ResolvedType.kind === "taggedUnion"` y los arms no cubren todas las variantes, error.
- Wildcard `_` como "no me importa".

**Depende de**: V1 (necesitamos tagged unions para que tenga sentido).

**Riesgo**: bajo si V1 está bien hecha.

**Done cuando**:
- Match exhaustivo funciona con `Result<T,E>`, `FileError`, y un nuevo tipo de prueba con 3+ casos.
- Tests E2E: `match-exhaustive-ok`, `match-exhaustive-missing-case-error`.
- Suite verde.

---

## V3 — Tipos numéricos concretos

`i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `f32`, `f64`.

**Alcance**:
- Sintaxis: `let x: i32 = 42;`, `let y: f64 = 3.14;`.
- Inferencia: literales `42` siguen siendo `i32` por defecto; `3.14` es `f64`.
- Conversiones explícitas: `i32(x)` casts.
- Codegen: cada tipo mapea directamente a `int8_t`, `int16_t`, ..., `float`, `double`.
- Validación de rangos en compilación para literales.

**Depende de**: V0.1 (resolvedType). Independiente de V1-V2.

**Riesgo**: medio — interactúa con operadores aritméticos (promoción de tipos).

**Done cuando**:
- Tests E2E: `i8-overflow-error`, `u32-unsigned-overflow`, `f32-precision`, `numeric-types-cast`.
- Suite verde.

---

## V4 — Arrays de tamaño fijo

`[T; N]` con N literal conocido en compilación.

**Alcance**:
- Sintaxis: `const buf: u8[4] = [1, 2, 3, 4];`
- Codegen: `std::array<u8, 4>` en pila, sin heap.
- Indexación con verificación de bounds en compilación si el índice es literal.
- Operadores sobre arrays: `.length`, `.map`, `.filter`, `.reduce` con tamaño estático (fusionables).

**Depende de**: V3 (necesitamos tipos numéricos para que N sea algo distinto de `number`).

**Riesgo**: bajo si V3 está hecha.

**Done cuando**:
- Tests E2E: `array-fixed-size`, `array-fixed-index-bounds`, `array-fixed-as-struct-field`.
- Suite verde.

---

## V5 — Readonly profundo

`readonly T`, `readonly T[]`, `readonly [T; N]`.

**Alcance**:
- Sintaxis: `function f(arr: readonly number[]) { ... }`.
- Codegen: `const std::vector<...>&` o `std::span<const T>` según corresponda.
- Validación en semantic: no se puede mutar dentro de la función.

**Depende de**: V0.2 (símbolos con `passing`).

**Riesgo**: bajo.

**Done cuando**:
- Tests E2E: `readonly-array`, `readonly-fixed-array`, `readonly-rejected-mutation-error`.
- Suite verde.

---

## V6 — Constantes propagadas (`constexpr`)

`const N: i32 = 1024`. El valor se conoce en compilación y se propaga al codegen.

**Alcance**:
- Marcar `VariableDeclaration` con `isConstExpr: true` cuando el initializer es un literal o expresión de constantes.
- Codegen: emitir `constexpr` en C++ cuando es posible.
- Detectar arrays de tamaño constante derivado de constantes (`const buf: u8[N]`).
- Detección de branches con condición constante para eliminar ramas en emit.

**Depende de**: V0.1, V3.

**Riesgo**: bajo — `constexpr` es un superconjunto de lo que ya generamos.

**Done cuando**:
- Tests E2E: `const-expr-array-size`, `const-expr-branch-elimination`, `const-expr-struct-size`.
- Suite verde.

---

## V7 — Fusión automática de operaciones sobre colecciones

**Feature estrella**.

`arr.filter(p).map(f).reduce(init, op)` se transforma en el AST (no en strings) a un único `for` que itera la colección original y aplica `p`, `f`, `op` en cada paso.

**Alcance**:
- Visitor que detecta patrones `filter → map → reduce` y reescribe el AST a `for`.
- Pattern recognition en el AST: encadenamiento de `CallExpression` sobre `MemberExpression` sobre `CallExpression` con `.filter`/`.map`/`.reduce`.
- Conserva semántica: orden de evaluación, side effects en `f`/`p`.
- Si la cadena tiene elementos no fusibles (p. ej. `.sort()` en medio), no fusiona — cae al comportamiento actual.

**Depende de**: V0.1 (AST con tipos resueltos para entender qué hace cada operación).

**Riesgo**: alto — la detección de patrones es delicada. Empezar con `filter+map+reduce` y expandir.

**Done cuando**:
- Tests E2E: `pipeline-fuse-filter-map-reduce`, `pipeline-no-fuse-with-sort`, `pipeline-side-effects-preserved`.
- Verificación: el C++ emitido tiene un único bucle en casos fusibles.
- Suite verde.

---

## V8 — Análisis de escape implícito

Visitor que clasifica cada `new T()` (o equivalente):
- **Escapa**: vive en heap.
- **No escapa, un solo dueño**: vive por valor o en `Unq<T>`.
- **Compartido**: `Rc<T>`.

**Alcance**:
- Algoritmo: para cada `new T()` en una expresión, ver si el resultado cruza el límite de la función.
- Si solo se usa localmente → por valor (stack o registro).
- Si se devuelve o se guarda en un campo con un solo dueño → `Unq<T>` (que ya tenemos).
- Si se comparte (sale como parámetro de una función que toma `Rc<T>`, o se guarda en un campo de tipo `Rc`) → `Rc<T>`.
- Inferencia opcional con anotación explícita del user: `Unq<Foo>` fuerza unique_ptr; `Rc<Foo>` fuerza shared.

**Depende de**: V0.1 (AST con tipos).

**Riesgo**: alto — análisis interprocedural es complejo. Empezar con casos simples (no escape) y expandir.

**Done cuando**:
- Tests E2E: `escape-stays-on-stack`, `escape-to-return-unique`, `escape-to-shared-refcount`.
- Suite verde.

---

## V9 — Async nativo (verificación)

Confirmar que el runtime `ets_async.hpp` realmente usa corutinas C++20 + io_uring.

**Alcance**:
- Auditoría de `runtime/ets_async.hpp` y `runtime/ets_io_uring.hpp`.
- Si no usan corutinas: refactor.
- Benchmarks E2E: servidor TCP con 1000 conexiones concurrentes.

**Depende de**: nada (ya hay runtime, falta verificar la cadena).

**Riesgo**: bajo (verificación), alto (si hay que reescribir).

**Done cuando**:
- Benchmark documentado: throughput vs `std::thread` baseline.
- Tests E2E de networking siguen verdes.

---

## V10 — Closures específicas en AST

Si el AST sabe exactamente qué lambda es y dónde se usa, generar lambda C++ inlineable en lugar de `std::function`.

**Alcance**:
- Visitor que marca `ArrowFunction` con `capturedSymbols: Symbol[]`, `singleUseSite: NodeId | undefined`.
- Si `singleUseSite` existe → emitir lambda C++ en el sitio de uso (puede ser inlined por Clang).
- Si no → `std::function` (lo que ya hacemos).

**Depende de**: V0.1.

**Riesgo**: bajo.

**Done cuando**:
- Tests E2E: `closure-inline`, `closure-std-function`.
- Suite verde.

---

## Cierre del Bloque C (mientras se ejecuta V0)

Los buckets #11 modules, #13 filesystem, #14 networking se cierran **antes** de V0 para mantener issues limpios. Pero el alcance se reduce: **solo exposición runtime sin tipos ricos**. Las versiones "típadas" se rehacen en V1-V3.

### C0.1 — Modules (#11)

Solo tests E2E multi-archivo. El module loader ya existe.

### C0.2 — Filesystem (#13)

Exponer `fileRead`/`fileWrite`/`fileExists`/etc. como helpers globales, con metadatos `requires: ["ets_file"]`. Sin `Result<T, FileError>` rico — devuelve booleano o string vacío en errores. Se rehará en V1.

### C0.3 — Networking (#14)

Exponer `tcpListen`/`tcpAccept`/`tcpRead`/`tcpWrite` similar. Tests con `SKIP_NETWORK=1`. Se enriquecerá con `Result<T, NetError>` en V1.

---

## Estrategia de ejecución

1. **Bloque C primero** (C0.1-C0.3): 3 PRs pequeños, workers paralelos en worktrees disjuntos.
2. **V0 en serie** (V0.1-V0.4): refactor central, no se puede paralelizar. Lo hago yo. Cada paso es un PR.
3. **V1-V10 en paralelo donde sea posible**:
   - V3 + V5 + V6 + V10 son **independientes** entre sí → workers paralelos.
   - V1 → V2 → V4 → V7 → V8 tienen dependencias secuenciales.
4. **Un PR grande al final** que consolida todo (V0 + V1 + V3 + V5 + ...).

## Criterios de éxito del roadmap completo

- [ ] Visión escrita y firmada por Alberto (`docs/vision.md`).
- [ ] Roadmap publicado y revisado (`docs/roadmap.md`).
- [ ] Suite E2E ≥ 200 tests verde.
- [ ] `grep -rn "JSON.stringify(program)" src/` retorna 0.
- [ ] `grep -rn "Map<Expression, TypeName>" src/` retorna 0.
- [ ] `grep -rn "runtimeGlobals" src/codegen/` retorna 0.
- [ ] `Result<T,E>` funciona como tagged union con narrowing y match exhaustivo.
- [ ] `i32`, `f64`, `[u8; 4]` producen `int32_t`, `double`, `std::array<u8, 4>` en el C++ generado.
- [ ] `arr.filter().map().reduce()` produce un único bucle en C++.
- [ ] Un PR grande integra todo en main con la suite verde.
