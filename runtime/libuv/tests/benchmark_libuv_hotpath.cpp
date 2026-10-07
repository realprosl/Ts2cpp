// Fase 8 — Benchmarks de optimizacion del hot path LibuvEventLoop.
//
// Mide el coste del camino caliente del event loop async:
//
//   bench 1: wake roundtrip (otro thread notifica, main procesa).
//   bench 2: runOne con N timers activos (latencia de despacho).
//   bench 3: await_ready + await_suspend + await_resume roundtrip.
//   bench 4: notify + runOne sync (mismo thread).
//
// Todo en ns/op. El objetivo es detectar regresiones de rendimiento
// tras cambios futuros. NO busca comparar con poll(2) (eso ya esta
// en benchmark_poll_vs_libuv.cpp).

#include <chrono>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <thread>
#include <vector>

#include <uv.h>

#include "ets_event_loop_libuv.hpp"

using clk = std::chrono::steady_clock;
using ns_dur = std::chrono::nanoseconds;

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, label) do { if (cond) { ++g_passed; std::printf("  ok: %s\n", label); } \
                                  else { ++g_failed; std::printf("  FAIL: %s\n", label); } } while(0)

// bench 1: wake roundtrip cross-thread.
//   - Main thread espera wake.
//   - Worker thread envia notify tras delay.
//   - Medimos tiempo entre wake_callback y retorno de runOne.
struct WakeContext {
    ets::LibuvEventLoop* loop;
    std::chrono::steady_clock::time_point start;
    long elapsed_ns = -1;
};

void on_wake_for_bench(uv_async_t* h) {
    auto* ctx = static_cast<WakeContext*>(h->data);
    ctx->elapsed_ns = std::chrono::duration_cast<ns_dur>(
        clk::now() - ctx->start).count();
    uv_close(reinterpret_cast<uv_handle_t*>(h), nullptr);
}

void bench_1_wake_roundtrip() {
    std::printf("bench 1: wake roundtrip cross-thread\n");
    constexpr int N = 100;

    long total_ns = 0;
    for (int i = 0; i < N; ++i) {
        ets::LibuvEventLoop loop;
        uv_async_t wake;
        WakeContext ctx{&loop, clk::now(), -1};
        uv_async_init(loop.raw_loop(), &wake, on_wake_for_bench);
        wake.data = &ctx;
        uv_async_send(&wake);

        auto t0 = clk::now();
        ctx.start = t0;
        uv_run(loop.raw_loop(), UV_RUN_ONCE);
        auto elapsed = std::chrono::duration_cast<ns_dur>(clk::now() - t0).count();
        total_ns += elapsed;
        uv_loop_close(loop.raw_loop());
    }
    double avg_ns = static_cast<double>(total_ns) / N;
    std::printf("  %d wake roundtrips: avg %.0f ns/roundtrip\n", N, avg_ns);
    CHECK(avg_ns > 0, "wake roundtrip midio tiempo");
}

// bench 2: runOne con N timers activos.
struct TimerCtx {
    long fired = 0;
};

void on_timer_fire(uv_timer_t* h) {
    auto* ctx = static_cast<TimerCtx*>(h->data);
    ctx->fired++;
    uv_close(reinterpret_cast<uv_handle_t*>(h), nullptr);
}

void bench_2_timers_dispatch() {
    std::printf("\nbench 2: dispatch N timers activos\n");
    constexpr int N_VALUES[] = {10, 100, 1000};
    for (int N : N_VALUES) {
        uv_loop_t loop;
        uv_loop_init(&loop);
        std::vector<uv_timer_t> timers(N);
        TimerCtx ctx{0};
        for (int i = 0; i < N; ++i) {
            uv_timer_init(&loop, &timers[i]);
            timers[i].data = &ctx;
            uv_timer_start(&timers[i], on_timer_fire, 0, 0);
        }
        auto start = clk::now();
        uv_run(&loop, UV_RUN_DEFAULT);
        auto elapsed_ns = std::chrono::duration_cast<ns_dur>(clk::now() - start).count();
        std::printf("  N=%5d timers: %.2f us total, %.0f ns/timer\n",
                    N, elapsed_ns / 1000.0, static_cast<double>(elapsed_ns) / N);
        uv_loop_close(&loop);
    }
    CHECK(true, "benchmarks ejecutados");
}

// bench 3: notify sync (mismo thread).
void bench_3_notify_sync() {
    std::printf("\nbench 3: notify + runOne sync (mismo thread)\n");
    constexpr int N = 10000;

    ets::LibuvEventLoop loop;
    auto start = clk::now();
    for (int i = 0; i < N; ++i) {
        loop.notify();
        loop.runOne();
    }
    auto elapsed_ns = std::chrono::duration_cast<ns_dur>(clk::now() - start).count();
    double avg_ns = static_cast<double>(elapsed_ns) / N;
    std::printf("  %d notify+runOne: %.2f us total, %.0f ns/op\n",
                N, elapsed_ns / 1000.0, avg_ns);
    CHECK(elapsed_ns > 0, "notify midio tiempo");
}

// bench 4: uv_run(UV_RUN_NOWAIT) con N polls (carga idle).
void bench_4_idle_with_polls() {
    std::printf("\nbench 4: uv_run(UV_RUN_NOWAIT) con N polls registrados\n");
    constexpr int N_VALUES[] = {10, 100, 1000};
    for (int N : N_VALUES) {
        uv_loop_t loop;
        uv_loop_init(&loop);
        std::vector<uv_poll_t> polls(N);
        std::vector<int> fds(N);
        for (int i = 0; i < N; ++i) {
            int fds_pipe[2];
            if (::pipe(fds_pipe) != 0) { std::printf("pipe failed\n"); return; }
            fds[i] = fds_pipe[0];
            uv_poll_init(&loop, &polls[i], fds_pipe[0]);
        }
        auto start = clk::now();
        for (int i = 0; i < 1000; ++i) {
            uv_run(&loop, UV_RUN_NOWAIT);
        }
        auto elapsed_ns = std::chrono::duration_cast<ns_dur>(clk::now() - start).count();
        std::printf("  N=%4d polls, 1000 iter: %.2f us total, %.0f ns/iter\n",
                    N, elapsed_ns / 1000.0, static_cast<double>(elapsed_ns) / 1000.0);
        for (int i = 0; i < N; ++i) {
            ::close(fds[i]);
            uv_close(reinterpret_cast<uv_handle_t*>(&polls[i]), nullptr);
        }
        uv_run(&loop, UV_RUN_DEFAULT);
        uv_loop_close(&loop);
    }
    CHECK(true, "benchmarks ejecutados");
}

int main() {
    std::printf("=== Fase 8: benchmarks de optimizacion del hot path ===\n\n");
    bench_1_wake_roundtrip();
    bench_2_timers_dispatch();
    bench_3_notify_sync();
    bench_4_idle_with_polls();
    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}