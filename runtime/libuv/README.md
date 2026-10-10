# Ts2cpp + libuv — Backend de event loop (V29.3: unico backend)

V29.3 (PR #157): libuv es el **unico backend de event loop** soportado.
Antes habia un backend alternativo basado en `poll(2)` que se
mantenia por compatibilidad. La suite e2e pasa identica con libuv
(67/67 sin red, 64/65 con red, 1 flake pre-existente), asi que el
backend poll se elimino en este PR para simplificar el codepath.

Este directorio contiene los **tests standalone** del backend libuv
(13 tests + 2 benchmarks, 94/94 escenarios verde). Los tests NO se
inyectan al codigo generado del dialecto: son validacion
arquitectonica del backend.

## Lo que aporta libuv

- **1 solo epoll/kqueue/IOCP por loop** (libuv abstrae el backend
  nativo del SO) en lugar de N descriptores copiados a cada
  `poll(2)` call.
- **Cross-platform**: libuv abstrae epoll (Linux), kqueue
  (BSD/macOS), IOCP (Windows).
- **Cancelacion distribuida** integrada.
- **Benchmarks medidos** (`benchmark_poll_vs_libuv.cpp`):
  - dispatcher idle (1 fd): libuv ~32x mas rapido.
  - dispatcher con 50 pipes: libuv ~430x mas rapido.

## Compilacion

El dialecto (V29.3 en adelante) requiere libuv siempre. El runtime
se pre-compila a `.o` cacheados:

```bash
# 1. Compilar el runtime libuv
cd runtime/libuv
make
# (los .o se generan en build/)

# 2. El runner e2e del dialecto los linka automaticamente
cd ../..
npm run test:e2e
```

`libuv` debe estar enlazado con `-luv`. El sistema requiere libuv
1.40+ (probado con 1.48, `apt install libuv1-dev`).

## API publica

La API del dialecto **no cambia** entre el backend poll antiguo y
libuv. `listenTcp`, `acceptTcp`, `readTcp`, `writeTcp`,
`acceptTcpUntil`, `readTcpUntil`, `writeTcpUntil` son identicos.
Solo cambia el awaiter interno: `UvFdAwaiter` basado en
`uv_poll_t`.

## Tests standalone

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
| `tests/test_cancel_network.cpp` | Cancelacion distributed |
| `tests/test_curl_fetch.cpp` | HTTP fetch con libcurl easy interface |
| `tests/benchmark_poll_vs_libuv.cpp` | dispatcher base libuv vs poll(2) |
| `tests/benchmark_libuv_hotpath.cpp` | hot path LibuvEventLoop |
| `tests/test_multi_loop.cpp` | MultiLoopRunner con N loops (4 fases V26) |

**Total: 14 tests + 2 benchmarks, 94/94 escenarios verde**.

## Migracion: 17 PRs (V25)

Las 17 PRs #101-#117 (V25) implementaron el backend libuv desde
cero (spike arquitectonico, refactor `IEventLoop`, UvFdAwaiter,
TCP client sobre libuv, cancelacion, benchmarks). V29.3 elimina
el backend poll que manteniamos en paralelo.

## Coste del dispatcher (medido en este hardware)

| Escenario | uv_run | poll(2) | Ratio |
|-----------|--------|---------|-------|
| dispatcher idle (1 fd) | 17 ns/iter | 544 ns/iter | **32x** |
| dispatcher con 50 pipes | 23 ns/iter | 9883 ns/iter | **430x** |
| dispatch 1000 timers | 197 ns/timer | n/a | n/a |
| wake roundtrip cross-thread | 23.7 us | n/a | n/a |
| notify + runOne mismo thread | 4.8 us | n/a | n/a |
| uv_run(NOWAIT) con 1000 polls idle | 19 ns/iter | n/a | n/a |

## Notas para mantenedores

- **Cero Dockerfile**, integracion por flag de compilacion.
- `raw_loop()` y `raw_wake()` en `LibuvEventLoop` exponen el
  `uv_loop_t` raw para integracion con APIs libuv externas
  (DNS, TCP, etc.).
- El cleanup de timers fired se hace **antes** de `uv_run`
  (no despues) para evitar que libuv los cuente como handles
  activos y bloquee `UV_RUN_ONCE`.
- `std::deque<TimerEntry>` (no `std::vector`) para que las
  direcciones guardadas en `uv_handle_t::data` sean estables
  tras `push_back`.
- Los tests se compilan con `-O0` por bug latente con `-O2`
  en `test_integration` test 3 (waitUntil). No es bloqueante
  para produccion.
- V25 Fase 4: el runtime se pre-compila a `.o` cacheados en
  `build/runtime_ets_libuv.o` y `build/runtime_ets_net_libuv.o`.
  Las definiciones no-template de la `LibuvEventLoop` estan en
  `runtime/runtime_ets_libuv.cpp`; el header
  `runtime/ets_event_loop_libuv_api.hpp` solo contiene
  declaraciones.
