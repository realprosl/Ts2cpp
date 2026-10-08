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
| `ets_net.hpp` | `listenTcp`/`acceptTcp`/`readTcp`/`writeTcp`/`closeTcp` no bloqueantes; `*Until` con timeout y `CancellationToken`. Bajo `-DETS_EVENT_BACKEND_LIBUV` los awaiterables usan `UvFdAwaiter`/`UvCancellableFdAwaiter` (drop-in libuv). |
| `libuv/` | Backend alternativo de `EventLoop` basado en libuv. Activo bajo `-DETS_EVENT_BACKEND_LIBUV` (ver `libuv/README.md`). Migración completa (PRs #101–#117). V25 Fase 4: el runtime se pre-compila a `.o` cacheados (`scripts/build-runtime.sh`). |
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

## Reactor async V26 (rendimiento)

El reactor sobre libuv entrega las optimizaciones del V26 (Alberto 2026-10-07):

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

Más detalle en `docs/reactor-async.md`.
