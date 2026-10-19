# Runtime async sobre libuv (V30.6.0)

Este documento describe cómo el dialecto Estatic mapea a operaciones
async sobre **libuv** (el único backend, desde V29.3). A diferencia
de V26 (que tenía un "reactor" propio sobre libuv + poll dual-backend),
V30+ usa **libuv directamente** como event loop: `ets::EventLoop`
es un alias de `LibuvEventLoop` y no hay capa intermedia.

## Estado actual

Desde **V29.3 (PR #157)**, **libuv es el único backend de red**. El backend
`PollEventLoop` (basado en `poll(2)`) fue eliminado. Esto simplifica el
runtime, evita mantener dos implementaciones, y unifica el comportamiento
entre plataformas.

```cpp
// runtime/ets_event_loop.hpp
namespace ets { using EventLoop = LibuvEventLoop; }
```

## Arquitectura

```
+-------------------------------------------------------------+
|  Tu programa (dialecto .ets)                                |
|                                                             |
|  await readTcp(conn, 1024)        <-- dialécto              |
|  await setTimeout(100)            <-- V30.1                 |
|  await resolveDns("example.com")  <-- V30.4                 |
|  await createTlsServer({...})     <-- V30.5                 |
+----------------------------+--------------------------------+
                             |
                             v  (Task<T> = C++20 coroutine)
+----------------------------+--------------------------------+
|  runtime/ets_net_libuv_api.hpp                              |
|  runtime/ets_timer.hpp                                      |
|  runtime/ets_dns.hpp                                        |
|  runtime/ets_tls.hpp                                        |
|  runtime/ets_http_curl_async.hpp   (V30.3 cliente HTTP)     |
+----------------------------+--------------------------------+
                             |
                             v
+----------------------------+--------------------------------+
|  ets::LibuvEventLoop (runtime/ets_event_loop_libuv.hpp)    |
|    uv_loop_t loop_                                          |
|    uv_async_t wake_                                         |
|    std::unordered_map<int, unique_ptr<PollState>> polls_    |
|    std::list<unique_ptr<TimerEntry>> timers_                |
+----------------------------+--------------------------------+
                             |
                             v
+----------------------------+--------------------------------+
|  libuv 1.48+ (paquete libuv1-dev)                           |
+-------------------------------------------------------------+
```

## El event loop en detalle (libuv)

### `LibuvEventLoop`

Implementa la interfaz `IEventLoop` (`runtime/ets_event_loop_iface.hpp`):

| Método | Para qué |
|---|---|
| `waitFor(fd, events, handle)` | Espera actividad en un fd (TCP, file, etc.) |
| `waitForUntil(fd, events, deadline, token, ...)` | waitFor con timeout y cancellation |
| `waitUntil(deadline, handle)` | Timer |
| `detach(handle)` | Adopta un frame y lo destruye cuando termina |
| `post(handle)` | Despacha una corutina en el loop (thread-safe) |
| `notify()` | Despierta el loop desde otro thread |
| `runOne()` | Un ciclo del event loop (modo incremental) |
| `run()` / `stop()` | Loop continuo (V26) — pensado para MultiLoopRunner |

### Patrón de timers

- Cada `TimerEntry` vive en heap bajo `unique_ptr`, con dirección estable.
- `uv_close` conserva el objeto hasta `onTimerClosed`; el callback elimina la
  entrada de la lista.
- `UV_RUN_NOWAIT` cuando no hay handles que esperar.
- CancellationToken chequeado en `runOne` al inicio (Fase 2B.3).

### Patrón de polls

- `std::unordered_map<int, unique_ptr<PollState>>` indexa por fd y mantiene
  cada `uv_poll_t` en una dirección estable hasta su callback de cierre.
- `PollState` guarda las esperas en `std::list<PollEntry>` para que el timer de
  deadline pueda apuntar a una entrada sin que `push_back` la invalide.
- Cada `PollEntry` es un await pendiente sobre ese fd.
- Las entradas disparadas se eliminan antes y después de `uv_run`; cuando un
  poll queda vacío se cierra y permanece en `closingPolls_` hasta
  `onPollClosed`.

### Ownership de `race`

`race` inicia todos los candidatos y devuelve el primero que termina. Los
frames perdedores se transfieren mediante `detach()` al event loop para que un
timer, poll o trabajo bloqueante nunca conserve un handle a memoria liberada.
El loop destruye cada frame al finalizar. Esta ruta todavía no cancela la
operación: un perdedor que nunca termina puede quedar retenido hasta destruir
el loop.

### V26: MultiLoopRunner

Para paralelismo multi-core, el runtime puede crear N loops (uno por
core) y asignar tareas. Cada loop corre en su thread dedicado. La
comunicación entre loops usa `post()` y `notify()` (thread-safe).
PR #131.

## Dialecto → runtime

| Función del dialecto | Header runtime | Backed por |
|---|---|---|
| `readTcp`, `writeTcp`, `acceptTcp`, `listenTcp`, `closeTcp` | `runtime/ets_net_libuv_api.hpp` | `uv_tcp_t` |
| `setTimeout`, `setInterval`, `cancelTimer` | `runtime/ets_timer.hpp` (V30.1, PR #160) | `uv_timer_t` |
| `watchFs`, `unwatchFs` | `runtime/ets_fs_watcher.hpp` (V30.2, PR #161) | `uv_fs_event_t` |
| `resolveDns` | `runtime/ets_dns.hpp` (V30.4, PR #162) | `uv_getaddrinfo` |
| `http.get`, `http.post` | `runtime/ets_http_curl_async.hpp` (V30.3, PR #164) | libcurl + coroutine |
| `createTlsServer`, `acceptTls`, `readTls`, `writeTls`, `closeTls` | `runtime/ets_tls.hpp` (V30.5, PR #165) | OpenSSL sobre `uv_tcp_t` |

Todas son `Task<T>` (= corutina C++20) que devuelve
`Result<T, E>` (= `ets::Result`).

## Cómo se linka

El AST detection (`src/modules/runtime-backends.ts`, V30.6.0) recorre
el AST y declara qué backends usa el programa. El CLI añade:

- `libuv` → `build/runtime_ets_libuv.o`, `build/runtime_ets_net_libuv.o`, `-luv`.
- `tls` → `-lssl -lcrypto`.
- `curl` → `-lcurl`.

No hace falta que el usuario configure nada en `estatic.config.ts`.

## Cambios recientes (resumen)

| Versión | Cambio | PR |
|---|---|---|
| V30.6.0 | AST detection declarativa (reemplaza include-scan) | #172 |
| V30.5 | TLS sobre libuv + OpenSSL | #165 |
| V30.4 | DNS async (`resolveDns`) | #162 |
| V30.3 | Cliente HTTP async (libcurl + corutinas) | #164 |
| V30.2 | Filesystem watchers (`watchFs`) | #161 |
| V30.1 | Timers (`setTimeout`/`setInterval`) | #160 |
| V29.3 | libuv es el único backend (PollEventLoop eliminado) | #157 |
| V26 | MultiLoopRunner, cleanup event-driven, buffer pool, accept4 | #128-#132 |
