# Reactor async V26 — Guía del backend de alto rendimiento

Este documento describe el reactor async de Ts2cpp en su versión V26, que
transfiere el EventLoop de poll(2) a libuv y aplica las optimizaciones del
roadmap V26 (Alberto 2026-10-07).

## Tabla de contenidos

- [Resumen ejecutivo](#resumen-executive)
- [Arquitectura](#arquitectura)
- [El reactor en detalle](#el-reactor-en-detalle)
- [Cambios V26](#cambios-v26)
- [Benchmarks](#benchmarks)
- [Limitaciones](#limitaciones)
- [Trabajo futuro](#trabajo-futuro)

## Resumen ejecutivo

El V26 entrega **5 mejoras de performance** al reactor async sobre la base
de V25:

| #  | Mejora                                          | Impacto            | PR  |
| ----- | ------------------------------------------------- | ------------------- | ----- |
| 1 | correctness PollEntry+masked wanted por FD     | estructural       | #128 |
| 2 | cleanup event-driven (O(N)→O(activos))         | escalabilidad     | #128 |
| 3 | buffer pool reutilizable en readTcp              | 2.21x throughput | #129 |
| 4 | accept4 + SOCK_NONBLOCK en listenTcp            | -30% syscalls    | #130 |
| 5 | MultiLoopRunner para multicore N loops           | N-cores paralelos | #131 |

Tests: **202/202 unit Ts2cpp + 94/94 libuv + 4/4 multi_loop + 3/3 e2e runner**.

## Arquitectura

```
+------------------------------------------------------------+
|  Programa Ts2cpp                                            |
|                                                             |
|  +----------------+    +------+   +----------------+        |
|  | Task<T>        |--->| Loop |--->| LibuvEventLoop |        |
|  +----------------+    +------+   +----------------+        |
|        | corutinas C++20  |  run()      | uv_loop_t     |
|        |                  |             | wake_         |
|        v                  |             | timers_       |
|  +-----------------+       |             | polls_        |
|  | FdAwaiter       |-------|             |----- ...      |
|  +-----------------+       |                              |
|                             |                              |
|  +-----------------+       |                              |
|  | BufferPool      | <-----|  (thread_local singleton)    |
|  +-----------------+                                      |
+------------------------------------------------------------+
                              |
                              v (V26.5 MultiLoopRunner)
              +--------------+--------------+
              |              |              |
              v              v              v
        +----------+   +----------+   +----------+
        | Thread 0 |   | Thread 1 |   | Thread 2 |
        | Loop 0   |   | Loop 1   |   | Loop 2   |
        | run()    |   | run()    |   | run()    |
        +----------+   +----------+   +----------+
```

## El reactor en detalle

### LibuvEventLoop (runtime/runtime_ets_libuv.cpp)

Encapsula un `uv_loop_t` con:

- `wake_` (uv_async_t): despierta al loop desde `post()` o `notify()`.
- `timers_` (std::deque<TimerEntry>): one-shot timers con deadline.
- `polls_` (std::unordered_map<int, PollState>): un uv_poll_t por FD.
- `posted_` (vector<coroutine_handle>): corutinas pospuestas.
- `ready_` (vector<coroutine_handle>): handles listos para reanudar.
- `detached_` (vector<DetachedEntry>): corutinas independientes.
- `*_to_reap_` (V26 event-driven cleanup queues).
- `stop_` (atomic<bool>): solicitud de stop() cross-thread.

Métodos públicos:

- `waitFor / waitForUntil`: registra FD en polls_.
- `waitUntil`: programa timer one-shot.
- `detach / post / notify`: lifecycle de corutinas.
- `runOne`: un ciclo de eventos (manual).
- `run` / `stop` (V26): bucle bloqueante hasta stop() cross-thread.
- `raw_loop() / raw_wake()`: acceso a uv_loop_t raw.

### Awaitables de red (runtime/ets_net_libuv.cpp)

`UvFdAwaiter` y `UvCancellableFdAwaiter` se compilan a `runtime_ets_net_libuv.o`
cacheado. Sin overhead de recompilación por programa.

### BufferPool (runtime/ets_buffer_pool.hpp)

Singleton thread_local con buckets de potencia 2 (1K..1M).
Cada bucket retiene hasta 32 buffers ociosos; lo que sobra se libera.
**Speedup medido: 2.21x en readTcp hot path**.

### MultiLoopRunner (runtime/ets_multi_loop.hpp)

Wrapper RAII que:

1. Crea N `LibuvEventLoop` (unique_ptr, no movable).
2. `start()` lanza N threads, cada uno ejecuta `loop.run()`.
3. `stop() + join()` apaga.

API:

```cpp
ets::MultiLoopRunner runner(4);  // 4 cores
runner.start();

auto& loop = runner.nextLoop();  // round-robin
loop.waitFor(fd, POLLIN, handle);

// cross-thread cancel:
ets::CancellationSource source;
source.cancel();  // OK desde otro thread (atomic_bool)

// shutdown:
runner.stop();
runner.join();
```

## Cambios V26

### V26.1 — Cleanup event-driven (PR #128)

**Antes** (V25): `runOne` scan O(N) sobre `timers_`, `polls_`, `detached_`
buscando elementos fired o done.

**Después** (V26):

- Callbacks (`onPoll`, `onTimerForPoll`, `onTimerForWait`, `onWake`)
  pushean a `*_to_reap_` cuando marcan `fired=true`.
- `runOne` step 3-6 itera **solo** los fired del ciclo actual.

**Medición**:

| Caso | V25 | V26 | Speedup |
|------|-----|-----|---------|
| 1000 timers dispatch | 197 ns/timer | 178 ns/timer | ~10% |
| 1000 polls × 1000 iter | n/a | 18 ns/iter | escala mejor |

Beneficio real es **escalabilidad** (con N=10k polls, cleanup ya no es O(N)).

Bugfix adicional: `detach()` ahora llama `handle.destroy()` si el handle ya
terminó. Antes había un memory leak latente en ese path.

### V26.2 — Buffer pool readTcp (PR #129)

**Antes** (V25): cada `readTcp()` aloca un `std::string(size, '\0')` fresh.

**Después** (V26): buffer pool thread_local con free lists por bucket.

| Bench | Tiempo | Speedup |
|-------|--------|---------|
| V25 alloc fresh (4K, N=100k) | 13.8 ms | 1.0x |
| V26 pool cold | 6.4 ms | **2.15x** |
| V26 pool hot | 6.3 ms | **2.21x** |

### V26.3 — accept4 + SOCK_NONBLOCK (PR #130)

**Antes** (V25): `accept()` + `fcntl(O_NONBLOCK)` = 2 syscalls con race window.

**Después** (V26): `accept4()` en Linux (1 syscall atómico).
`listenTcp` usa `socket(..., SOCK_NONBLOCK | SOCK_CLOEXEC, ...)` directamente.

| Bench | Tiempo | us/op | Speedup |
|-------|--------|-------|---------|
| V25 accept+fcntl (10k) | 742 ms | 74.20 | 1.0x |
| V26 accept4 (10k) | 717 ms | 71.66 | **1.04x** |

Speedup modesto en micro-benchmark, mayor en sistemas reales con carga
(elimina 1 context switch extra + race condition).

### V26.4 — MultiLoopRunner (PR #131)

**Antes** (V25): single-thread `defaultEventLoop`. No escala a multicore.

**Después** (V26): `MultiLoopRunner(n)` arranca n `LibuvEventLoop` en n
threads, cada uno con su `run()`.

Validación (`test_multi_loop`): 4 loops × 19 ticks cada uno en 200ms
(esperado 20 ticks por loop). 3/3 corridas exit 0.

## Benchmarks

Todos los benchmarks están en `runtime/libuv/tests/`:

| Bench | Qué mide | Resultado |
|-------|----------|-----------|
| `benchmark_libuv_hotpath` | Dispatch/timer con 1k timers | 178 ns/timer |
| `benchmark_poll_vs_libuv` | poll(2) vs libuv | libuv ~30x más rápido en concurrent |
| `benchmark_buffer_pool` | alloc fresh vs pool | 2.21x speedup |
| `benchmark_accept4` | accept+fcntl vs accept4 | 1.04x (micro), mayor en carga |

## Limitaciones

1. **No hay cross-loop messaging**: el caller implementa el dispatcher.
2. **No hay HTTP server completo**: el caller acepta y reparte entre loops.
3. **`run()` no reemplaza N callbacks cuando stop()**: sale del bucle, pero
   el cleanup final de handles lo hace el destructor (~LibuvEventLoop).
4. **`writev()` no implementado**: requiere API multi-buffer (HTTP headers+body)
   que las APIs actuales no exponen.

## Trabajo futuro

- **Cross-loop messaging helper** sobre `uv_async_send`.
- **HTTP dispatcher** que reparte accept entre loops.
- **io_uring backend** (descartado en V26 — Alberto roadmap).
- **writev multi-buffer API** para HTTP.