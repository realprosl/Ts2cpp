# `runtime/` — runtime C++ consumido por el código generado

Cabeceras `inline` (`namespace ets`) sin enlace separado: el código generado las
incluye directamente. Compilan con `-std=c++20 -pthread -fno-exceptions`. Linux
y macOS; no hay backend Windows/IOCP.

## Cabeceras

| Fichero | Qué aporta |
|---|---|
| `ets_runtime.hpp` | Umbrella + `Map<K,V>`/`Set<T>` (envoltorios sobre STL); facades estilo Node (`console`, `fs`, `path`, `process`, `JSON`); `print`/`write`/`printError`/`writeError` variádicos; `typeofOf<T>()`; helpers argv/imports. |
| `ets_string.hpp` | `concat(...)` fold-template, `numberToString` (`std::to_chars`), `length`, `substring`, `indexOf`, `trim`, etc. |
| `ets_async.hpp` | `Task<T>` (coroutine promise C++20), `EventLoop` con `::poll` + self-pipe para wake, `CancellationToken/Source`, `syncWait`, `spawn`, `runBlocking`, `BlockingExecutor` (pool 2-4 hilos). |
| `ets_file.hpp` | `readFile/writeFile/appendFile/...` con overloads `Result<T>` y `out error`; versiones `*Async` (vía `runBlocking`) y `*Until` (deadline + cancellation). |
| `ets_net.hpp` | `listenTcp`/`acceptTcp`/`readTcp`/`writeTcp`/`closeTcp` no bloqueantes; `*Until` con timeout y `CancellationToken`. |
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
