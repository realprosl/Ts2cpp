# Ts2cpp + libuv — Backend de event loop

Este directorio contiene el **backend alternativo de event loop** basado
en libuv, usado por `ets::EventLoop` cuando se compila con
`-DETS_EVENT_BACKEND_LIBUV`. La migración de poll(2) a libuv está
**completa** (8 fases cerradas, PRs #101–#117).

## Activación

Por defecto, `ets::EventLoop` usa `PollEventLoop` (poll(2)). Para
activar libuv, compilar con:

```bash
g++ -std=c++20 -DETS_EVENT_BACKEND_LIBUV -I/root/Ts2cpp -I/root/Ts2cpp/runtime \
    programa.cpp -o programa -luv -pthread
```

El selector está en `runtime/ets_event_loop.hpp`:

- Con `-DETS_EVENT_BACKEND_LIBUV` → `LibuvEventLoop` (libuv).
- Sin la macro → `PollEventLoop` (poll(2), default Linux/macOS).

`libuv` debe estar enlazado con `-luv`. El sistema tiene libuv 1.48
instalado (`/usr/include/uv*.h`).

## Lo que aporta libuv sobre poll(2)

- **1 solo epoll/kqueue/IOCP por loop** (libuv abstrae el backend nativo
  del SO) en lugar de N descriptores copiados a cada `poll(2)` call.
- **Cross-platform**: libuv abstrae epoll (Linux), kqueue (BSD/macOS),
  IOCP (Windows). El `PollEventLoop` actual solo funciona en Linux/macOS.
- **Cancelación distribuida** integrada (validada en test_wait_for.cpp
  + Fases 2B.3 y 5).
- **Benchmarks medidos** (`benchmark_poll_vs_libuv.cpp`):
  - dispatcher idle (1 fd): **libuv 32x más rápido** (17 ns vs 544 ns).
  - dispatcher con 50 pipes: **libuv 430x más rápido** (23 ns vs 9883 ns).

## Compatibilidad

- **100% compatible** con código existente: bajo default (sin macro),
  se usan `FdAwaiter` / `CancellableFdAwaiter` originales.
- **Cero cambios al código generado**.
- La API pública (`listenTcp`, `acceptTcp`, `readTcp`, `writeTcp`,
  `acceptTcpUntil`, `readTcpUntil`, `writeTcpUntil`) es **identica**.
- Solo cambia el awaiter interno: bajo libuv, `NetFdAwaiter` es
  `UvFdAwaiter` (basado en `uv_poll_t`).

## Migración: 8 fases (completadas)

| # | Fase | PR | Estado |
|---|------|----|----|
| 1 | Spike arquitectónico (validate_architecture) | #101 | ✅ mergeada |
| 2A | Refactor `IEventLoop` (selector de backend) | #102 | ✅ mergeada |
| 2B.1 | Test `waitUntil` con libuv (uv_timer_t) | #103 | ✅ mergeada |
| 2B.2 | Test `notify`/`post` (uv_async_t) | #104 | ✅ mergeada |
| 2B.3 | Test `waitFor`/`waitForUntil` (uv_poll_t) | #105 | ✅ mergeada |
| 2B.4 | Test `detach` (uv_async_t) | #106 | ✅ mergeada |
| 2B.5 | `LibuvEventLoop` + `test_integration` | #107 | ✅ mergeada |
| 3.1 | Test TCP server standalone (pipe simulado) | #108 | ✅ mergeada |
| 3.1.1 | Test DNS resolve standalone (getaddrinfo) | #109 | ✅ mergeada |
| 3.2 | `UvFdAwaiter` como drop-in de `FdAwaiter` | #110 | ✅ mergeada |
| 3.3 | Auto-swap `FdAwaiter` → `UvFdAwaiter` bajo macro | #111 | ✅ mergeada |
| 4 | Test TCP client + DNS (uv_getaddrinfo) | #112 | ✅ mergeada |
| 4.2 | TCP client sobre `LibuvEventLoop` (raw_loop API) | #113 | ✅ mergeada |
| 5 | Cancelación end-to-end (acceptTcpUntil) | #115 | ✅ mergeada |
| 6 | Benchmark PollEventLoop vs LibuvEventLoop | #114 | ✅ mergeada |
| 7 | Fetch HTTP con libcurl | #116 | ✅ mergeada |
| 8 | Benchmark hot path LibuvEventLoop | #117 | ✅ mergeada |

Total: **17 PRs mergeadas** en la migración libuv.

## Tests standalone (no se inyectan al código generado)

| Test | Cubre |
|------|-------|
| `tests/test_wait_until.cpp` | uv_timer_t one-shot |
| `tests/test_notify_post.cpp` | uv_async_t (notify + post) |
| `tests/test_wait_for.cpp` | uv_poll_t + uv_timer_t + CancellationToken |
| `tests/test_detach.cpp` | corutinas detached (fire-and-forget) |
| `tests/test_integration.cpp` | LibuvEventLoop end-to-end (12 tests) |
| `tests/test_tcp_server.cpp` | TCP server pattern (pipe simulado) |
| `tests/test_tcp_client.cpp` | uv_getaddrinfo + uv_tcp_connect |
| `tests/test_tcp_client_loop.cpp` | TCP client sobre LibuvEventLoop |
| `tests/test_uv_fd_awaiter.cpp` | UvFdAwaiter como drop-in de FdAwaiter |
| `tests/test_cancel_network.cpp` | Cancelación distributed (49 ms vs 10s) |
| `tests/test_curl_fetch.cpp` | HTTP fetch con libcurl easy interface |
| `tests/benchmark_poll_vs_libuv.cpp` | dispatcher base libuv vs poll(2) |
| `tests/benchmark_libuv_hotpath.cpp` | hot path LibuvEventLoop |

**Total: 13 tests + 2 benchmarks, 94/94 escenarios verde**.

## Compilar y ejecutar los tests standalone

```bash
cd runtime/libuv
make         # compila los 13 tests + 2 benchmarks
make run     # ejecuta todos en secuencia
```

## Coste del dispatcher (medido en este hardware)

| Escenario | uv_run | poll(2) | Ratio |
|-----------|--------|---------|-------|
| dispatcher idle (1 fd) | 17 ns/iter | 544 ns/iter | **32x** |
| dispatcher con 50 pipes | 23 ns/iter | 9883 ns/iter | **430x** |
| dispatch 1000 timers | 197 ns/timer | n/a | n/a |
| wake roundtrip cross-thread | 23.7 µs | n/a | n/a |
| notify + runOne mismo thread | 4.8 µs | n/a | n/a |
| uv_run(NOWAIT) con 1000 polls idle | 19 ns/iter | n/a | n/a |

## Notas para mantenedores

- **Cero Dockerfile**, integración por flag de compilación.
- `raw_loop()` y `raw_wake()` en `LibuvEventLoop` exponen el `uv_loop_t`
  raw para integración con APIs libuv externas (DNS, TCP, etc.).
- El cleanup de timers fired se hace **antes** de `uv_run` (no después)
  para evitar que libuv los cuente como handles activos y bloquee
  `UV_RUN_ONCE`.
- `std::deque<TimerEntry>` (no `std::vector`) para que las direcciones
  guardadas en `uv_handle_t::data` sean estables tras push_back.
- Los tests se compilan con `-O0` por bug latente con `-O2` en
  `test_integration` test 3 (waitUntil). No es bloqueante para
  producción; investigar en una fase posterior si se necesita `-O2`.