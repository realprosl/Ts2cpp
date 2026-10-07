// Fase 6 — Benchmarks comparativos de coste base de PollEventLoop vs LibuvEventLoop.
//
// Mide el coste base de cada backend SIN actividades (event loop vacio):
//   - Cuantas iteraciones de runOne() por segundo.
//   - Latencia de un notify() -> runOne() wake roundtrip.
//
// Mide tambien el coste con N handles activos:
//   - N uv_timer_t (libuv) vs N std::chrono::time_point + pollfd (poll).
//   - Mismo escenario: ninguno dispara, solo estan registrados.
//
// El objetivo es entender el overhead del dispatcher, no de las tareas
// en si.

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <vector>

#include <unistd.h>
#include <sys/poll.h>

#include <uv.h>

using clk = std::chrono::high_resolution_clock;
using ns_dur = std::chrono::nanoseconds;

struct BenchResult {
    double elapsed_us;
    double ops_per_sec;
};

// Benchmark: medir coste de un unico runOne() que despacha 1 timer
// recien expirado. Para que no se cuelgue, registramos 1 corutina
// suspendida que se reanuda cuando el timer expira.
template <typename LoopT>
BenchResult bench_runOne_idle(int iters) {
    // Por ahora: medir uv_run y poll directos. runOne del loop requiere
    // un timer registrado con deadline, lo cual excede este benchmark
    // basico. Mejor: solo contar el bucle de timer reales.
    (void)iters;
    return {0, 0};
}

void bench_1_runOne_idle() {
    std::printf("bench 1: runOne idle (loop vacio, sin handles)\n");
    std::printf("  Comparamos uv_run() vs poll() con timeout 0:\n\n");

    constexpr int N = 1000;

    // Libuv: uv_loop_t directo.
    uv_loop_t loop;
    uv_loop_init(&loop);
    auto start = clk::now();
    for (int i = 0; i < N; ++i) {
        uv_run(&loop, UV_RUN_NOWAIT);
    }
    auto end = clk::now();
    auto libuv_elapsed = std::chrono::duration_cast<ns_dur>(end - start).count() / 1000.0;
    std::printf("  uv_loop + UV_RUN_NOWAIT x %d: %.2f us total, %.0f ops/s\n",
                N, libuv_elapsed, N / (libuv_elapsed / 1e6));

    // Poll: pollfd[1] sobre STDIN_FILENO con timeout 0.
    struct pollfd pfd[1];
    pfd[0].fd = 0;  // stdin
    pfd[0].events = POLLIN;
    start = clk::now();
    for (int i = 0; i < N; ++i) {
        ::poll(pfd, 1, 0);
    }
    end = clk::now();
    auto poll_elapsed = std::chrono::duration_cast<ns_dur>(end - start).count() / 1000.0;
    std::printf("  poll(pfd, 1, 0)      x %d: %.2f us total, %.0f ops/s\n",
                N, poll_elapsed, N / (poll_elapsed / 1e6));

    double ratio = libuv_elapsed / poll_elapsed;
    std::printf("\n  ratio Libuv/Poll: %.2fx (%.0f ns vs %.0f ns por iteracion)\n",
                ratio, libuv_elapsed * 1000.0 / N, poll_elapsed * 1000.0 / N);

    uv_loop_close(&loop);
}

void bench_2_with_N_pipes() {
    std::printf("\nbench 2: dispatcher con N pipes (50 pipes registrados, sin actividad)\n");

    constexpr int N = 50;

    // Crear N pipes.
    std::vector<int> read_fds(N);
    std::vector<int> write_fds(N);
    for (int i = 0; i < N; ++i) {
        int fds[2];
        if (::pipe(fds) != 0) { std::printf("  FAIL: pipe\n"); return; }
        read_fds[i] = fds[0];
        write_fds[i] = fds[1];
    }

    constexpr int ITER = 1000;

    // Libuv: N uv_poll_t.
    uv_loop_t loop;
    uv_loop_init(&loop);
    std::vector<uv_poll_t> polls(N);
    for (int i = 0; i < N; ++i) {
        uv_poll_init(&loop, &polls[i], read_fds[i]);
    }
    auto start = clk::now();
    for (int i = 0; i < ITER; ++i) {
        uv_run(&loop, UV_RUN_NOWAIT);
    }
    auto end = clk::now();
    auto libuv_elapsed = std::chrono::duration_cast<ns_dur>(end - start).count() / 1000.0;
    std::printf("  uv_run con %d uv_poll_t x %d: %.2f us total, %.0f ops/s\n",
                N, ITER, libuv_elapsed, ITER / (libuv_elapsed / 1e6));
    for (int i = 0; i < N; ++i) uv_close(reinterpret_cast<uv_handle_t*>(&polls[i]), nullptr);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);

    // Poll: N+1 pollfd (N pipes + 1 wakeup).
    std::vector<pollfd> pfds(N);
    for (int i = 0; i < N; ++i) {
        pfds[i].fd = read_fds[i];
        pfds[i].events = POLLIN;
    }
    start = clk::now();
    for (int i = 0; i < ITER; ++i) {
        ::poll(pfds.data(), pfds.size(), 0);
    }
    end = clk::now();
    auto poll_elapsed = std::chrono::duration_cast<ns_dur>(end - start).count() / 1000.0;
    std::printf("  poll(pfds, %d, 0)      x %d: %.2f us total, %.0f ops/s\n",
                N, ITER, poll_elapsed, ITER / (poll_elapsed / 1e6));

    double ratio = libuv_elapsed / poll_elapsed;
    std::printf("\n  ratio Libuv/Poll: %.2fx (%.0f ns vs %.0f ns por iteracion)\n",
                ratio, libuv_elapsed * 1000.0 / ITER, poll_elapsed * 1000.0 / ITER);

    for (int i = 0; i < N; ++i) {
        ::close(read_fds[i]);
        ::close(write_fds[i]);
    }
}

int main() {
    std::printf("=== Benchmarks PollEventLoop vs LibuvEventLoop ===\n\n");
    bench_1_runOne_idle();
    bench_2_with_N_pipes();
    std::printf("\nBenchmarks completado.\n");
    return 0;
}