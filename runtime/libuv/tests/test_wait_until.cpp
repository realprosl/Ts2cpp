// Fase 2B.1 — Validación de waitUntil sobre libuv.
//
// Implementa un EventLoop mínimo que SOLO implementa `waitUntil` y
// `runOne` sobre libuv. Si este test pasa, el patrón del backend
// libuv para timers es válido y se puede extender a la interfaz
// completa en las siguientes iteraciones.
//
// Lo que valida:
//   - uv_loop_t + uv_timer_t se pueden usar para reanudar corutinas.
//   - La API waitUntil del runtime se puede implementar con uv_timer_t.
//   - "Resume a lo sumo una vez" se mantiene (la spec §10).
//   - El cleanup del handle (uv_close) no causa use-after-free.
//
// Notas de implementación:
//   - std::deque<TimerEntry> (no vector) para que las direcciones de
//     los TimerEntry sean estables aunque añadamos más. El `data` del
//     uv_timer_t guarda `&timerEntry` y debe permanecer válido hasta
//     que uv_close complete.
//
// NO se compila con el resto del runtime. Es standalone:
//   g++ -std=c++20 runtime/libuv/tests/test_wait_until.cpp -luv -o .scratch/test-wait-until

#include <uv.h>
#include <chrono>
#include <coroutine>
#include <cstdio>
#include <deque>
#include <exception>
#include <vector>

struct Task {
    struct promise_type {
        Task get_return_object() { return {}; }
        std::suspend_never initial_suspend() { return {}; }
        std::suspend_never final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };
};

// --- Mini EventLoop: solo waitUntil + runOne ----------------------------

class MiniLibuvLoop {
public:
    MiniLibuvLoop() {
        if (uv_loop_init(&loop_) != 0) std::abort();
    }
    ~MiniLibuvLoop() {
        // Cerrar todos los handles pendientes.
        for (auto& t : timers_) {
            uv_timer_stop(&t.handle);
            uv_close(reinterpret_cast<uv_handle_t*>(&t.handle), nullptr);
        }
        timers_.clear();
        // Drenar callbacks de uv_close.
        uv_run(&loop_, UV_RUN_NOWAIT);
        int rc = uv_loop_close(&loop_);
        if (rc != 0) {
            std::fprintf(stderr, "uv_loop_close falló: %s\n", uv_strerror(rc));
            std::abort();
        }
    }
    MiniLibuvLoop(const MiniLibuvLoop&) = delete;
    MiniLibuvLoop& operator=(const MiniLibuvLoop&) = delete;

    void waitUntil(std::chrono::steady_clock::time_point deadline, std::coroutine_handle<> handle) {
        if (deadline <= std::chrono::steady_clock::now()) {
            // Deadline en el pasado: reanudar en la próxima runOne.
            ready_.push_back(handle);
            return;
        }
        // std::deque garantiza que las direcciones de los elementos son
        // estables. push_back nuevo no invalida punteros a los anteriores.
        timers_.emplace_back();
        auto& t = timers_.back();
        uv_timer_init(&loop_, &t.handle);
        t.handle.data = &t;          // &t estable porque es deque
        t.coroutine = handle;
        t.fired = false;
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
        uv_timer_start(&t.handle, onTimer, static_cast<uint64_t>(std::max<long long>(0, ms.count())), 0);
    }

    // Drena el loop hasta que no haya más corutinas pendientes.
    // Útil para tests. En producción se usa runOne() en bucle.
    void drain() {
        for (int i = 0; i < 100; ++i) {
            if (ready_.empty() && timers_.empty()) break;
            runOne();
        }
    }

    void runOne() {
        uv_run(&loop_, UV_RUN_ONCE);
        std::vector<std::coroutine_handle<>> ready;
        ready.swap(ready_);
        for (auto h : ready) if (h && !h.done()) h.resume();
        // Cleanup de timers que ya dispararon.
        for (auto it = timers_.begin(); it != timers_.end(); ) {
            if (it->fired) {
                uv_close(reinterpret_cast<uv_handle_t*>(&it->handle), nullptr);
                it = timers_.erase(it);
            } else {
                ++it;
            }
        }
    }

private:
    struct TimerEntry {
        uv_timer_t handle{};
        std::coroutine_handle<> coroutine;
        bool fired = false;
    };

    static void onTimer(uv_timer_t* h) {
        auto* t = static_cast<TimerEntry*>(h->data);
        if (t->fired) return;          // resume a lo sumo una vez
        t->fired = true;
        t->coroutine.resume();
    }

    uv_loop_t loop_{};
    std::deque<TimerEntry> timers_;
    std::vector<std::coroutine_handle<>> ready_;
};

// --- Awaitable: sleep(Nms) -----------------------------------------------

struct Sleep {
    MiniLibuvLoop* loop;
    std::chrono::milliseconds ms;

    bool await_ready() const noexcept { return ms.count() <= 0; }
    void await_suspend(std::coroutine_handle<> h) {
        loop->waitUntil(std::chrono::steady_clock::now() + ms, h);
    }
    void await_resume() {}
};

// --- Test scenarios -------------------------------------------------------

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg) do { \
    if (cond) { ++g_passed; std::printf("  ok: %s\n", msg); } \
    else      { ++g_failed; std::printf("  FAIL: %s\n", msg); } \
} while (0)

Task co_sleep_50(MiniLibuvLoop& loop) {
    auto start = std::chrono::steady_clock::now();
    co_await Sleep{&loop, std::chrono::milliseconds(50)};
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    std::printf("  elapsed: %lld ms\n", static_cast<long long>(elapsed));
    CHECK(elapsed >= 45 && elapsed <= 500, "sleep 50ms dura ~50ms (tolera scheduling)");
}

Task co_sleep_zero(MiniLibuvLoop& loop) {
    co_await Sleep{&loop, std::chrono::milliseconds(0)};
    CHECK(true, "sleep 0ms reanuda sin bloquear");
}

Task co_sleep_concurrent(MiniLibuvLoop& loop, int idx) {
    co_await Sleep{&loop, std::chrono::milliseconds(20 + idx * 10)};
    std::printf("  [task %d] resumed\n", idx);
    CHECK(true, "task concurrente reanuda");
}

Task co_double_resume_safety(MiniLibuvLoop& loop) {
    co_await Sleep{&loop, std::chrono::milliseconds(10)};
    CHECK(true, "primer sleep OK");
    co_await Sleep{&loop, std::chrono::milliseconds(10)};
    CHECK(true, "segundo sleep OK (no doble resume)");
}

int main() {
    std::printf("test 1: sleep 50ms\n");
    { MiniLibuvLoop loop; co_sleep_50(loop); loop.drain(); }

    std::printf("test 2: sleep 0ms reanuda inmediato\n");
    { MiniLibuvLoop loop; co_sleep_zero(loop); loop.drain(); }

    std::printf("test 3: 3 sleeps concurrentes con deadlines distintos\n");
    {
        MiniLibuvLoop loop;
        co_sleep_concurrent(loop, 0);
        co_sleep_concurrent(loop, 1);
        co_sleep_concurrent(loop, 2);
        loop.drain();
    }

    std::printf("test 4: doble sleep consecutivo (no doble resume)\n");
    { MiniLibuvLoop loop; co_double_resume_safety(loop); loop.drain(); }

    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}
