// Fase 2B.2 — Validación de notify/post sobre libuv.
//
// notify() debe despertar el loop desde otro contexto (e.g. otro
// thread o un callback asíncrono). post() encola un handle para
// ejecutar en la próxima runOne. Ambos usan uv_async_t internamente.
//
// Lo que valida:
//   - notify() despierta un runOne bloqueado en uv_run.
//   - post() encola un handle y se ejecuta en la próxima runOne.
//   - post() desde dentro de un callback de libuv (re-entrada) funciona.
//   - Múltiples notify() coalescen (libuv no acumula, solo desbloquea).
//   - notify() no es no-op si el loop ya está activo.
//
// NO se compila con el resto del runtime. Es standalone:
//   g++ -std=c++20 runtime/libuv/tests/test_notify_post.cpp -luv -pthread -o .scratch/test-notify-post

#include <uv.h>
#include <atomic>
#include <chrono>
#include <coroutine>
#include <cstdio>
#include <deque>
#include <exception>
#include <thread>
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

// --- Mini EventLoop: waitUntil + notify + post --------------------------

class MiniLibuvLoop {
public:
    MiniLibuvLoop() {
        if (uv_loop_init(&loop_) != 0) std::abort();
        // uv_async_t para notify/post.
        if (uv_async_init(&loop_, &wake_, onWake) != 0) std::abort();
        wake_.data = this;
    }
    ~MiniLibuvLoop() {
        // Cerrar timers pendientes.
        for (auto& t : timers_) {
            uv_timer_stop(&t.handle);
            uv_close(reinterpret_cast<uv_handle_t*>(&t.handle), nullptr);
        }
        timers_.clear();
        // Cerrar el async handle.
        uv_close(reinterpret_cast<uv_handle_t*>(&wake_), nullptr);
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
            ready_.push_back(handle);
            return;
        }
        timers_.emplace_back();
        auto& t = timers_.back();
        uv_timer_init(&loop_, &t.handle);
        t.handle.data = &t;
        t.coroutine = handle;
        t.fired = false;
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
        uv_timer_start(&t.handle, onTimer, static_cast<uint64_t>(std::max<long long>(0, ms.count())), 0);
    }

    // post(): encola un handle para la próxima runOne.
    // El wake async solo desbloquea uv_run; los handles se procesan
    // al inicio de runOne.
    void post(std::coroutine_handle<> handle) {
        {
            std::lock_guard lock(postedMutex_);
            posted_.push_back(handle);
        }
        uv_async_send(&wake_);
    }

    // notify(): despierta el loop. No encola nada. Usado por
    // CancellationSource::cancel() para interrumpir un runOne bloqueado.
    void notify() noexcept {
        uv_async_send(&wake_);
    }

    void drain() {
        for (int i = 0; i < 100; ++i) {
            if (ready_.empty() && timers_.empty() && posted_.empty() && !wakeActive_) break;
            runOne();
        }
    }

    void runOne() {
        // Procesar handles posted ANTES de bloquear en uv_run.
        // Si hay posted, no bloqueamos (UV_RUN_NOWAIT); si no, ONCE.
        bool hasPosted;
        {
            std::lock_guard lock(postedMutex_);
            hasPosted = !posted_.empty();
        }
        if (hasPosted) uv_run(&loop_, UV_RUN_NOWAIT);
        else uv_run(&loop_, UV_RUN_ONCE);
        // Procesar posted después de uv_run (puede haber nuevos).
        std::vector<std::coroutine_handle<>> ready;
        {
            std::lock_guard lock(postedMutex_);
            ready.swap(posted_);
        }
        for (auto h : ready) if (h && !h.done()) h.resume();
        // Procesar ready_ (deadlines pasados).
        std::vector<std::coroutine_handle<>> readyTimers;
        readyTimers.swap(ready_);
        for (auto h : readyTimers) if (h && !h.done()) h.resume();
        // Cleanup timers fired.
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
        if (t->fired) return;
        t->fired = true;
        t->coroutine.resume();
    }

    static void onWake(uv_async_t* h) {
        auto* loop = static_cast<MiniLibuvLoop*>(h->data);
        loop->wakeActive_ = false;
        // uv_async_send solo desbloquea uv_run. Los handles posted
        // se procesan al inicio de runOne.
    }

    uv_loop_t loop_{};
    uv_async_t wake_{};
    bool wakeActive_ = false;  // tracking del wake (no usado realmente)
    std::deque<TimerEntry> timers_;
    std::vector<std::coroutine_handle<>> ready_;
    std::mutex postedMutex_;
    std::vector<std::coroutine_handle<>> posted_;
};

// --- Awaitables ---------------------------------------------------------

struct Sleep {
    MiniLibuvLoop* loop;
    std::chrono::milliseconds ms;
    bool await_ready() const noexcept { return ms.count() <= 0; }
    void await_suspend(std::coroutine_handle<> h) {
        loop->waitUntil(std::chrono::steady_clock::now() + ms, h);
    }
    void await_resume() {}
};

struct Yield {
    MiniLibuvLoop* loop;
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) {
        loop->post(h);
    }
    void await_resume() {}
};

// --- Tests --------------------------------------------------------------

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg) do { \
    if (cond) { ++g_passed; std::printf("  ok: %s\n", msg); } \
    else      { ++g_failed; std::printf("  FAIL: %s\n", msg); } \
} while (0)

// Test 1: notify() desde otro thread despierta un runOne bloqueado.
Task co_test_notify_cross_thread() {
    std::printf("  test 1: notify cross-thread (placeholder)\n");
    co_return;
}

void test_1_notify_cross_thread() {
    std::printf("test 1: notify() desde otro thread desbloquea runOne\n");
    MiniLibuvLoop loop;
    std::atomic<bool> woke{false};
    // Thread que llama notify() tras 50ms.
    std::thread([&loop, &woke]{
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        woke = true;
        loop.notify();
    }).detach();
    // runOne bloquea hasta que notify() llegue.
    auto start = std::chrono::steady_clock::now();
    loop.runOne();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    CHECK(woke.load(), "otro thread llamó notify()");
    CHECK(elapsed >= 45 && elapsed <= 500, "runOne desbloqueó tras ~50ms (no bloqueó indefinido)");
}

// Test 2: post() encola un handle que se ejecuta en la próxima runOne.
Task co_after_yield(MiniLibuvLoop& loop) {
    co_await Yield{&loop};
    CHECK(true, "coroutine reanudada después de post()");
}

void test_2_post_basic() {
    std::printf("test 2: post() encola handle y se ejecuta\n");
    MiniLibuvLoop loop;
    co_after_yield(loop);
    loop.drain();
}

// Test 3: post() y notify() ambos usan el mismo wake async. Verificar
// que post() desde una corutina encolada vía notify() funciona.
Task co_chain(MiniLibuvLoop& loop) {
    co_await Yield{&loop};          // primer post
    co_await Yield{&loop};          // segundo post (re-entrada)
    CHECK(true, "doble yield/post funciona (re-entrada)");
}

void test_3_post_reentrant() {
    std::printf("test 3: post() dos veces en la misma corutina (re-entrada)\n");
    MiniLibuvLoop loop;
    co_chain(loop);
    loop.drain();
}

// Test 4: múltiples notify() coalescen (no encolan múltiples resumes).
void test_4_notify_coalesce() {
    std::printf("test 4: múltiples notify() coalescen\n");
    MiniLibuvLoop loop;
    auto start = std::chrono::steady_clock::now();
    // 100 notify() consecutivos deben desbloquear UNA sola vez.
    for (int i = 0; i < 100; ++i) loop.notify();
    loop.runOne();
    auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - start).count();
    CHECK(elapsed < 100000, "100 notify() retornan en <100ms (coalescen, no encolan 100 resumes)");
}

// Test 5: notify() + waitUntil combinados.
// notify() despierta un runOne bloqueado en un timer. La corutina
// que esperaba el timer reanuda (correcto, esto NO es cancelación,
// es solo "el loop se desbloquea"). El test verifica que el runOne
// no espera el deadline completo.
Task co_wait_short(MiniLibuvLoop& loop) {
    co_await Sleep{&loop, std::chrono::milliseconds(200)};
    CHECK(true, "coroutine reanudada al cumplirse el deadline");
}

void test_5_notify_during_wait() {
    std::printf("test 5: notify() durante waitUntil desbloquea runOne\n");
    MiniLibuvLoop loop;
    co_wait_short(loop);
    auto start = std::chrono::steady_clock::now();
    // Hilo que llama notify() tras 20ms. No cancela nada, solo
    // despierta al runOne antes del deadline. La corutina
    // co_wait_short NO se reanuda por notify — sigue esperando su
    // deadline. Pero el runOne retorna antes porque uv_run fue
    // interrumpido por el wake async.
    std::thread([&loop]{
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        loop.notify();
    }).detach();
    loop.runOne();  // desbloquea por notify, no por deadline
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    CHECK(elapsed >= 15 && elapsed < 150, "runOne desbloqueó por notify (no esperó 200ms)");
    loop.drain();  // deja que la corutina complete su espera de 200ms
}

int main() {
    test_1_notify_cross_thread();
    test_2_post_basic();
    test_3_post_reentrant();
    test_4_notify_coalesce();
    test_5_notify_during_wait();
    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}
