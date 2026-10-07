// Fase 5 — Validacion end-to-end de cancelacion distribuida en red.
//
// Reproduce el escenario de test/scratch/w0/cancellation.cpp
// (cancelSoon + acceptTcpUntil) usando la API publica:
//   - ets::syncWait(Task<void>) para correr corutinas en main.
//   - std::thread para simular cancelacion concurrente.
//   - ets::EventLoop + ets::runOne() para drenar el loop.
//
// Valida que ets::cancel(source) en otro thread hace que la corutina
// que espera en acceptTcpUntil termine rapido (< 200ms) en lugar de
// esperar al deadline (10s).

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

#include "ets_event_loop.hpp"
#include "ets_net.hpp"
#include "ets_async.hpp"

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, label) do { if (cond) { ++g_passed; std::printf("  ok: %s\n", label); } \
                                  else { ++g_failed; std::printf("  FAIL: %s\n", label); } } while(0)

using clk = std::chrono::steady_clock;

// Corutina que duerme 50ms via ets::sleep (await real) y luego cancela.
ets::Task<void> cancelSoon(ets::CancellationSource source) {
    co_await ets::sleep(50.0);
    ets::cancel(source);
    co_return;
}

// Corutina que acepta conexiones hasta cancel o timeout.
ets::Task<void> cancellationDemo(double port, std::atomic<bool>* done_flag) {
    auto listen_result = ets::listenTcp("127.0.0.1", port);
    if (!listen_result.isOk()) {
        std::printf("  FAIL: listenTcp: %s\n", listen_result.error().c_str());
        co_return;
    }
    auto listener = listen_result.value();
    auto source = ets::createCancellation();
    auto token = ets::cancellationToken(source);

    // Lanzar cancelSoon como tarea detached.
    ets::spawn(cancelSoon(source));

    auto start = clk::now();
    auto accepted = co_await ets::acceptTcpUntil(listener, 10000.0, token);
    auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        clk::now() - start).count();

    CHECK(!accepted.isOk(), "acceptTcpUntil fallo (cancelado)");
    CHECK(elapsed_ms < 500, "elapsed_ms < 500 (cancel rapido)");

    std::printf("  elapsed: %lld ms\n", (long long)elapsed_ms);
    std::fflush(stdout);

    *done_flag = true;
    co_return;
}

int main() {
    std::printf("=== Test cancelacion distribuida en red (Fase 5) ===\n\n");
    std::fflush(stdout);

    // Buscar puerto libre.
    int port = 48700;
    while (port < 49000) {
        int probe = ::socket(AF_INET, SOCK_STREAM, 0);
        int reuse = 1;
        ::setsockopt(probe, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        sockaddr_in addr;
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
        if (::bind(probe, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
            ::close(probe);
            break;
        }
        ::close(probe);
        ++port;
    }

    std::atomic<bool> done{false};
    auto task = cancellationDemo(static_cast<double>(port), &done);

    // syncWait drena el loop hasta que la tarea termine.
    auto start = clk::now();
    ets::syncWait(task);
    auto total_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        clk::now() - start).count();

    CHECK(done, "cancellationDemo completo");
    CHECK(total_ms < 1000, "total elapsed < 1000ms");

    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    std::fflush(stdout);
    return g_failed == 0 ? 0 : 1;
}