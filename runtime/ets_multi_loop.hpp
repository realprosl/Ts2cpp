// ets_multi_loop.hpp — pool de LibuvEventLoop ejecutandose en paralelo.
//
// V26: Alberto 2026-10-07 -> "multicore N loops" del V26 roadmap.
// Utilidad opcional (header-only) para escalar el reactor async a
// multiples cores.
//
// Uso:
//
//   #include "runtime/ets_event_loop_libuv_api.hpp"
//   #include "runtime/ets_multi_loop.hpp"
//
//   ets::MultiLoopRunner runner(4);  // 4 LibuvEventLoops
//   runner.start();                  // 4 threads, cada uno con su run()
//
//   // round-robin: cada llamada a nextLoop() retorna un loop distinto.
//   auto& loop = runner.nextLoop();
//   loop.waitFor(fd, POLLIN, handle);
//
// // cuando termina el programa:
//   runner.stop();                   // stop() cada loop y join threads.
//
// Threading model:
//   - Cada loop corre en su propio thread, con run() (UV_RUN_ONCE en bucle).
//   - El loop es thread-affine: las corutines que se posteen a ese loop
//     se ejecutan en su thread.
//   - CancellationSource cancel() es thread-safe (atomic_bool) -> se
//     puede cancelar desde cualquier thread, y el loop origen ve el cambio.
//   - No hay cross-loop state sharing: cada loop tiene su propio uv_loop_t,
//     sus propios polls, timers, etc. Comunicacion entre loops requiere
//     uv_async_send manual (no incluido en este header).
//
// NO es un HTTP server completo: es la infraestructura base. Para un
// servidor HTTP que reparte conexiones entre loops, el caller tiene
// que implementar el dispatcher (accept + write fd al loop destino via
// uv_pipe o async).

#include <atomic>
#include <cstddef>
#include <memory>
#include <thread>
#include <vector>

#include "ets_event_loop_libuv_api.hpp"

namespace ets {

class MultiLoopRunner {
public:
    // Crea N loops. NO los inicia; llamar a start() para que arranquen.
    explicit MultiLoopRunner(std::size_t n) : loops_(), workers_(), next_(0) {
        loops_.reserve(n);
        workers_.reserve(n);
        for (std::size_t i = 0; i < n; ++i) {
            loops_.push_back(std::make_unique<LibuvEventLoop>());
        }
    }

    ~MultiLoopRunner() {
        stop();
        join();
    }

    MultiLoopRunner(const MultiLoopRunner&) = delete;
    MultiLoopRunner& operator=(const MultiLoopRunner&) = delete;

    std::size_t size() const noexcept { return loops_.size(); }

    // Acceso directo a un loop por posicion.
    LibuvEventLoop& loop(std::size_t index) noexcept { return *loops_[index]; }

    // Round-robin: cada llamada retorna el siguiente loop.
    LibuvEventLoop& nextLoop() noexcept {
        const std::size_t i = next_.fetch_add(1, std::memory_order_relaxed) % loops_.size();
        return *loops_[i];
    }

    // Inicia un thread por loop, cada uno ejecuta loop.run().
    void start() {
        if (running_.load(std::memory_order_acquire)) return;
        running_.store(true, std::memory_order_release);
        workers_.clear();
        for (auto& loop : loops_) {
            workers_.emplace_back([&loop]() { loop->run(); });
        }
    }

    // Sincronico: stop() cada loop.
    void stop() {
        if (!running_.load(std::memory_order_acquire)) return;
        for (auto& loop : loops_) loop->stop();
    }

    // Une los threads (debe llamarse tras stop()).
    void join() {
        for (auto& t : workers_) if (t.joinable()) t.join();
        workers_.clear();
        running_.store(false, std::memory_order_release);
    }

private:
    std::vector<std::unique_ptr<LibuvEventLoop>> loops_;
    std::vector<std::thread> workers_;
    std::atomic<std::size_t> next_{0};
    std::atomic<bool> running_{false};
};

}  // namespace ets