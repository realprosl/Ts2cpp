# `runtime/` — runtime C++ consumido por el código generado

Cabeceras `inline` (`namespace ets`) sin enlace separado: el código generado las
incluye directamente. Compilan con `-std=c++20 -pthread -fno-exceptions`. Linux
y macOS; no hay backend Windows/IOCP.

## Cabeceras

| Fichero | Qué aporta |
|---|---|
| `ets_runtime.hpp` | Umbrella + `Map<K,V>`/`Set<T>` (envoltorios sobre STL); facades estilo Node (`console`, `fs`, `path`, `process`, `JSON`); `print`/`write`/`printError`/`writeError` variádicos; `typeofOf<T>()`; helpers argv/imports. |
| `ets_string.hpp` | `concat(...)` fold-template, `numberToString` (`std::to_chars`), `length`, `substring`, `indexOf`, `trim`, etc. |
| `ets_async.hpp` | `Task<T>` (coroutine promise C++20), `EventLoop` (selector entre `PollEventLoop` y `LibuvEventLoop`), `CancellationToken/Source`, `syncWait`, `spawn`, `runBlocking`, `BlockingExecutor` (pool 2-4 hilos). |
| `ets_file.hpp` | `readFile/writeFile/appendFile/...` con overloads `Result<T>` y `out error`; versiones `*Async` (vía `runBlocking`) y `*Until` (deadline + cancellation). |
| `ets_net.hpp` | `listenTcp`/`acceptTcp`/`readTcp`/`writeTcp`/`closeTcp` no bloqueantes; `*Until` con timeout y `CancellationToken`. Backend unico: libuv (`UvFdAwaiter`/`UvCancellableFdAwaiter`, ver `libuv/`). |
| `libuv/` | Backend de `EventLoop` basado en libuv (unico backend, V29.3). Migración completa de poll(2) a libuv (PRs V25 #101-#117, V29 #156-#157). V25 Fase 4: el runtime se pre-compila a `.o` cacheados (`scripts/build-runtime.sh`). |
| `ets_tls.hpp` | `createTlsServer`/`acceptTls`/`readTls`/`writeTls`/`closeTls` sobre OpenSSL; TLS ≥ 1.2; encola solo si el programa usa tipos TLS. |
| `ets_io_uring.hpp` | Linux-only (`__NR_io_uring_*`), ring reusado por worker; usado por fs async cuando disponible, fallback POSIX. |
| `ets_syntax.hpp` | Validación sintáctica paralela con Tree-sitter; rechaza `throw`/`try`/`extends` (consistente con `Result<T>`-sin-excepciones). |
| `ets_process.hpp` | Driver de proceso usado por el compilador: `compileCpp`, `runNativeProcess`, `sourceUsesTreeSitter`. |
| `ets_ast.hpp` + `ast/*.hpp` | Header AST de Tree-sitter; expone `estaticTypedAstJson` / `estaticTypedAstRecords`. |

## Cómo se incluyen

`CppGenerator.includes()` (`src/codegen/cpp-generator.ts:47-49`) decide según el
AST:

- `runtime/ets_runtime.hpp` siempre.
- `runtime/ets_tls.hpp` solo si detecta usos de `TlsContext`/`TlsConnection`/
  `createTlsServer`/`acceptTls`/`readTls`/`writeTls`/`closeTls` por regex sobre
  el JSON del programa.
- `runtime/ets_ast.hpp` solo si el programa usa la API AST
  (`estaticTypedAstJson`, `syntaxTreeJson`, etc.).

Si la cabecera TLS aparece en la salida, el CLI añade `-lssl -lcrypto` al enlace
(`src/cli.ts:77`, `src/build/incremental-builder.ts:122`).

## Núcleo de tipos

- **`ets::Result<T>`** (`ets_async.hpp:46-61`) — `std::optional<T>` + `std::string error`.
  Construido por `ok<T>()`, `err<T>()`.
- **`ets::Task<T>`** — coroutine wrapper (move-only, `[[nodiscard]]`).
- **`ets::Map<K,V>` / `ets::Set<T>`** — wrapper STL; `delete` se renombra a
  `removeKey` para esquivar la keyword de C++; el codegen mapea
  `node.method === "delete"` → `removeKey`.
- **`ets::CancellationToken/Source`** — `shared_ptr<atomic_bool>`; `cancel()`
  activa el bit y despierta el event loop.

## Decisiones de ABI

- `#pragma once` en todos.
- Funciones libres `inline`, singletons `inline thread_local` (`defaultEventLoop`,
  `ring`, `blockingExecutor`) → todo en cabecera, sin librerías.
- `[[nodiscard]]` en `Result`, `Task`; `[[noreturn]]` en `exitProcess`.
- El codegen referencia identificadores sin prefijo (`spawn`, `cancel`, `ok`,
  `err`, `sleep`, `acceptTcp`, …) gracias a los `using ets::...` en
  `ets_runtime.hpp:112-128`.
- io_uring se compila solo si `__linux__ && __NR_io_uring_setup && __NR_io_uring_enter`.

## Optimizaciones V26 sobre libuv (rendimiento)

Las optimizaciones del V26 (Alberto 2026-10-07) se entregan **sobre
libuv** (el único backend desde V29.3). No hay un reactor intermedio:

- **Cleanup event-driven** (V26.2): callbacks pushean a colas `*_to_reap_`;
  `runOne` ya no hace scans O(N) sobre timers/polls/detached. ~10% mejora en
  hot path; escala bien a N=10k polls.
- **Buffer pool reutilizable** (V26.3): `ets::BufferPool` thread_local con
  buckets de potencia-2. `readTcp()` lo usa. **Speedup 2.21x** medido en
  `benchmark_buffer_pool`.
- **accept4 + SOCK_NONBLOCK** (V26.4): `listenTcp` y `acceptTcp` usan
  `accept4(fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC)` en Linux. 1 syscall
  en lugar de 2, sin race window.
- **MultiLoopRunner** (V26.5): `ets::MultiLoopRunner(n)` arranca n
  `LibuvEventLoop` en n threads, cada uno con su `run()`. API: `start()`,
  `stop()`, `join()`, `nextLoop()` round-robin. Validado en
  `runtime/libuv/tests/test_multi_loop.cpp`.

Más detalle en `docs/runtime-async-libuv.md`.

## Cómo añadir una función nueva al runtime (workflow paso a paso)

Esta sección documenta el camino que sigue una función desde "quiero
exponer `foo(x)` en el dialecto" hasta "el test e2e pasa verde". El
proceso se ha estabilizado tras el PR #183 (V30.10.1); antes había
pasos implícitos que solo conocían los commits previos.

### 1. Decide la capa

- **Función libre global**: p.ej. `length(s)`, `indexOf(s, needle, fromIndex)`.
  Va en `runtime/<área>.hpp` y se expone en el dialecto como
  `foo(args...)`.
- **Método de un tipo existente**: p.ej. `ets::Server::get(...)`,
  `ets::HttpResponse::status(...)`. Va como miembro de la clase en el
  header. El dialecto lo invoca con la sintaxis habitual
  (`server.get(...)`).
- **Tipo nuevo**: clase completa. Requiere además registrar su
  constructor en el type-checker.

### 2. Implementa en C++

- Función simple/inline: en `runtime/ets_<área>.hpp` (header-only).
- Función pesada o con estado: declara en `.hpp`, define en
  `runtime/ets_<área>.cpp`. El pre-compilado del runtime
  (`scripts/build-runtime.sh` y `scripts/postinstall.sh`) se encarga
  de generar `build/runtime_ets_<área>.o`.

Convenciones (V26+, válidas en todo el runtime):

- `namespace ets` en todo el código.
- Funciones libres `inline` en headers; clases/struct sin linkage
  externo salvo `.cpp` con `runtime_ets_<área>`.
- `[[nodiscard]]` en `Result`, `Task`, y todo lo que devuelve un valor
  que no debería ignorarse.
- Naming: snake_case en C++ (`http_param`), PascalCase en el dialecto
  (`http.param`). El `cpp-generator.ts` hace el mapping.
- Sin `throw` salvo en wrappers de terceros (httplib, OpenSSL). Si
  necesitas excepciones, el runner lo detectará por el include y
  añadirá `-fexceptions` (ver paso 5).

### 3. Expón al dialecto en `src/semantic/type-checker.ts`

- **Global libre**: añadir a la lista/map de builtins. La forma
  concreta depende de la versión — busca el array `BUILTINS` o el
  `Map<string, Type>` cerca de las definiciones de tipos primitivos.
  Especifica `paramTypes` y `returnType` exactamente como los quieres
  en el dialecto.
- **Método**: registrar la firma en la tabla correspondiente:
  `STRING_METHODS`, `ARRAY_METHODS`, `SERVER_METHODS`, etc. Cada
  tabla tiene `paramTypes: string[]` y `returnType: string`. Si tu
  método tiene un parámetro cuyo nombre cambia entre el dialecto y
  C++ (p.ej. `indexOf(needle, fromIndex)` → `indexOf(s, needle, fromIndex)`
  global), necesitas el workaround documentado en
  [Bugs conocidos](#bugs-conocidos).
- **Tipo nuevo**: añade el `class` a la lista de tipos permitidos
  (puede requerir varias tablas si tiene métodos builtin).

### 4. Verifica que el codegen la emite

El codegen (`src/codegen/cpp-generator.ts`) ya sabe traducir las
llamadas que pasan por las tablas del paso 3. Si tu función sigue el
patrón, no hay que tocarlo.

Para verificar:

```bash
node --experimental-strip-types --no-warnings \
  src/cli.ts examples/<demo>.ets -o /tmp/x.cpp
# Mira /tmp/x.cpp y comprueba que la llamada se traduce a
# ::ets::<nombre>(...) o <objeto>.<método>(...)
```

Si la firma es especial (parámetro de tipo función, varargs,
genéricos), puede que el codegen necesite un `case` específico. El
más común es `ArrayMethodCall` y `StringMethodCall`.

### 5. Headers y flags de compilación

- Si tu header **no está en `runtime/ets_runtime_full.hpp`**,
  añádelo. El bundle arrastra todo en los tests; sin él, el
  programa no compila y la culpa parece del usuario.
- Si tu header usa `throw` (httplib, OpenSSL, futuros wrappers):
  - Añade el nombre del header al detector de `exceptionFlags` en
    `test/runner.ts` y `test/e2e/_shared/runner.ts`. El
    mecanismo actual busca `runtime/ets_http_httplib.hpp` en el
    `cppText`; si tu header es nuevo, extiende la lista.
- Si usas **libuv** (cualquier API async, timers, fs, net, dns): el
  runner ya enlaza `build/runtime_ets_libuv.o` y
  `build/runtime_ets_net_libuv.o` cuando detecta headers de async.
- Si usas **OpenSSL/TLS**: el runner añade `-lssl -lcrypto`
  automáticamente cuando ve `runtime/ets_tls.hpp` en el `cppText`.
- Si usas **Drogon**: pre-procesa con
  `etsc <demo>.ets --cpp-drogon` y el codegen emite includes/llamadas
  a Drogon en vez de httplib.

### 6. Tests

Mínimo recomendado:

- `test/unit/type-checker.test.ts` — verifica que el dialecto
  acepta la nueva firma. Un test típico:
  ```ts
  test("V_NEW: nueva funcion global X", () => {
    const { checker } = check(`
      function main(): void {
        const r: string = myFunc("hello");
        print(r);
      }
    `);
    assert.ok(checker, "myFunc debe type-checkear");
  });
  ```
- `test/unit/parser.test.ts` — solo si introdujiste sintaxis nueva.
- `examples/<nombre>.ets` o `test/e2e/<área>/<caso>/` — test
  end-to-end que compila con `g++` y se ejecuta. Es el que
  asegura que el header, el codegen, el type-checker y el flag
  `-fexceptions` (si toca) están todos bien alineados.

Corre los suites:

```bash
node --experimental-strip-types --no-warnings --test \
  test/unit/parser.test.ts test/unit/type-checker.test.ts \
  test/unit/runtime-backends.test.ts test/unit/module-identity.test.ts \
  test/unit/import-regex.test.ts
node test/runner.ts
```

### 7. Workflow de PR

**Importante (lección V30.10.1)**: crea SIEMPRE la rama desde
`origin/main`, no desde una spike ya mergeada. Las spikes
mergeadas a main arrastran commits viejos y tu PR mostrará
conflictos al comparar contra main.

```bash
git fetch origin main
git checkout -b spike/vY-X-<slug> origin/main
# ...trabajo...
git add -A
git commit -m "V_Y.X: <resumen>"
git push -u origin spike/vY-X-<slug>
gh pr create --base main --head spike/vY-X-<slug> --title "..." --body "..."
```

Tras mergear, actualiza la memoria con el número de PR y un resumen
de una línea de lo que aporta.

### Bugs conocidos

- **`indexOf` member vs global** (V30.10.1 y anteriores): la tabla
  `STRING_METHODS` define `s.indexOf(needle, fromIndex)` con
  `paramTypes: ["string", "number"]`. Si el usuario escribe
  `s.indexOf(needle)` (sin `fromIndex`), el type-checker lo acepta
  con un warning implícito y el codegen pasa el segundo arg como
  basura. Workaround: usar la función global
  `indexOf(s, needle, 0)` con `fromIndex=0` explícito.
- **`Response` colisión con builtin**: el runtime tiene una clase
  `Response` con `status`/`header`/`send`/`json`. Si tu programa
  declara `class Response`, colisiona. Renombra a `HttpResponse` o
  similar. Aplica a cualquier nombre de tipo del runtime.
- **`const` local en arrow se marca como captura** (V30.10.1 fix):
  ya resuelto, pero si reaparece en otra rama, ver PR #183.
- **`listenTcp` es síncrono, no `Promise<Result<...>>`**: a
  diferencia de `acceptTcp`/`readTcp`/`writeTcp` que sí son
  async, `listenTcp` retorna `Result<TcpListener>` directamente.
  No le pongas `await`.
