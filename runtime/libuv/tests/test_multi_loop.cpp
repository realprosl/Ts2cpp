// test_multi_loop.cpp — valida que MultiLoopRunner arranca N
// LibuvEventLoop en N threads, y que cada uno procesa eventos de
// forma independiente.
//
// Setup:
//   - Crea MultiLoopRunner(4).
//   - start() -> 4 threads.
//   - Cada loop tiene 1 timer uv_timer_t de 10ms que incrementa su
//     counter.
//   - sleep 200ms.
//   - stop() + join().
//   - Verifica que los 4 counters estan cerca de 20 (200ms / 10ms).

#include <atomic>
#include <cstdio>
#include <thread>
#include <vector>

#include "ets_event_loop_libuv_api.hpp"
#include "ets_multi_loop.hpp"

struct TimerCtx {
    std::atomic<int>* counter;
    uv_timer_t timer;
};

int main() {
    constexpr std::size_t N = 4;
    constexpr auto wait_ms = 200;

    ets::MultiLoopRunner runner(N);
    if (runner.size() != N) { std::printf("FAIL: size != N\n"); return 1; }

    std::vector<std::atomic<int>> counters(N);
    for (auto& c : counters) c.store(0, std::memory_order_release);

    std::vector<std::unique_ptr<TimerCtx>> ctxs;
    for (std::size_t i = 0; i < N; ++i) {
        auto& loop = runner.loop(i);
        auto c = std::make_unique<TimerCtx>();
        c->counter = &counters[i];
        uv_timer_init(loop.raw_loop(), &c->timer);
        c->timer.data = c.get();
        uv_timer_start(&c->timer, [](uv_timer_t* h) {
            auto* ctx = static_cast<TimerCtx*>(h->data);
            ctx->counter->fetch_add(1, std::memory_order_acq_rel);
        }, 10, 10);  // 10ms, repetidamente
        ctxs.push_back(std::move(c));
    }

    runner.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(wait_ms));
    runner.stop();
    runner.join();

    // Cerrar los timers antes de liberar el runner (orden importante).
    for (auto& c : ctxs) {
        uv_timer_stop(&c->timer);
    }

    int total = 0;
    int min_count = 1 << 30;
    int max_count = 0;
    for (std::size_t i = 0; i < N; ++i) {
        const int c = counters[i].load(std::memory_order_acquire);
        total += c;
        if (c < min_count) min_count = c;
        if (c > max_count) max_count = c;
        std::printf("Loop %zu: %d ticks\n", i, c);
    }
    std::printf("Total: %d, min=%d, max=%d\n", total, min_count, max_count);

    // Tolerancia: cada loop deberia estar cerca de wait_ms/10 = 20. Permitimos
    // variacion amplia (>= 5 ticks cada uno) por scheduling.
    const int min_expected = 5;
    bool ok = min_count >= min_expected;
    if (ok) {
        std::printf("PASS: MultiLoopRunner con %zu loops (%d ticks totales)\n", N, total);
        return 0;
    } else {
        std::printf("FAIL: min_count %d < %d\n", min_count, min_expected);
        return 1;
    }
}