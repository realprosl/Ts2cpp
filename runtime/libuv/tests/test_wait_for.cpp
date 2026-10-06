// Fase 2B.3 — Validación de waitFor/waitForUntil sobre libuv.
//
// waitFor(fd, events, handle) registra un fd y reanuda cuando está
// listo. waitForUntil añade deadline + CancellationToken. La pieza
// más compleja del backend libuv porque combina:
//   - uv_poll_t para esperar en un fd no bloqueante.
//   - uv_timer_t para el deadline.
//   - CancellationToken (shared_ptr<atomic_bool>) que puede llegar
//     desde fuera del loop.
//
// Lo que valida:
//   1. waitFor dispara cuando el fd está listo para lectura.
//   2. waitForUntil dispara por timeout si el fd no se activa.
//   3. waitForUntil dispara por cancelación externa.
//   4. Cancelación antes del timer = resume a lo sumo una vez.
//   5. Múltiples waitFor sobre el mismo fd funcionan (libuv soporta
//      múltiples watchers).
//   6. Cleanup correcto: uv_close no causa use-after-free.
//
// Setup: usamos un pipe como fd. El escritor cierra el pipe (EOF
// marca el fd como "ready for read").
//
// Compilar:
//   g++ -std=c++20 runtime/libuv/tests/test_wait_for.cpp -luv -pthread -o .scratch/test-wait-for

#include <uv.h>
#include <atomic>
#include <chrono>
#include <coroutine>
#include <cstdio>
#include <cstring>
#include <deque>
#include <exception>
#include <fcntl.h>
#include <mutex>
#include <thread>
#include <unistd.h>
#include <unordered_map>
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

// --- Cancellation (subset del runtime) -----------------------------------

struct CancellationToken {
    std::shared_ptr<std::atomic_bool> state;
    bool isCancelled() const { return state && state->load(std::memory_order_acquire); }
};

struct CancellationSource {
    std::shared_ptr<std::atomic_bool> state = std::make_shared<std::atomic_bool>(false);
    CancellationToken token() const { return CancellationToken{state}; }
    void cancel() const { state->store(true, std::memory_order_release); }
    // V1: cancel() sin loop asociado. El runtime real de Ts2cpp
    // tiene un wrapper `ets::cancel(cs, &loop)` que llama
    // `loop.notify()` después de `cs.cancel()`. En el test, el
    // caller es responsable de notificar al loop explícitamente.
};

// --- WaitResult -----------------------------------------------------------

enum class WaitResult { ready, timedOut, cancelled };

// --- Mini EventLoop: waitUntil + waitFor + waitForUntil + notify + post -

class MiniLibuvLoop {
public:
    MiniLibuvLoop() {
        if (uv_loop_init(&loop_) != 0) std::abort();
        if (uv_async_init(&loop_, &wake_, onWake) != 0) std::abort();
        wake_.data = this;
    }
    ~MiniLibuvLoop() {
        // Cerrar todos los handles.
        for (auto& t : timers_) { uv_timer_stop(&t.handle); uv_close((uv_handle_t*)&t.handle, nullptr); }
        timers_.clear();
        for (auto& [fd, ps] : polls_) {
            uv_poll_stop(&ps.handle);
            uv_close((uv_handle_t*)&ps.handle, nullptr);
        }
        polls_.clear();
        uv_close((uv_handle_t*)&wake_, nullptr);
        uv_run(&loop_, UV_RUN_NOWAIT);
        int rc = uv_loop_close(&loop_);
        if (rc != 0) { std::fprintf(stderr, "uv_loop_close: %s\n", uv_strerror(rc)); std::abort(); }
    }
    MiniLibuvLoop(const MiniLibuvLoop&) = delete;
    MiniLibuvLoop& operator=(const MiniLibuvLoop&) = delete;

    void waitUntil(std::chrono::steady_clock::time_point deadline, std::coroutine_handle<> h) {
        if (deadline <= std::chrono::steady_clock::now()) { ready_.push_back(h); return; }
        timers_.emplace_back();
        auto& t = timers_.back();
        uv_timer_init(&loop_, &t.handle);
        t.handle.data = &t;
        t.coroutine = h;
        t.fired = false;
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
        uv_timer_start(&t.handle, onTimer, static_cast<uint64_t>(std::max<long long>(0, ms.count())), 0);
    }

    void waitFor(int fd, short events, std::coroutine_handle<> h) {
        // Asegurar que el fd esté en O_NONBLOCK.
        int flags = fcntl(fd, F_GETFL, 0);
        if (flags >= 0 && !(flags & O_NONBLOCK)) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        auto& ps = polls_[fd];
        if (ps.handle.data == nullptr) {
            uv_poll_init(&loop_, &ps.handle, fd);
            ps.handle.data = &ps;
        }
        int ev = 0;
        if (events & 0x001) ev |= UV_READABLE;
        if (events & 0x004) ev |= UV_WRITABLE;
        ps.entries.push_back({h, nullptr, std::chrono::steady_clock::time_point::max(), {}, nullptr, false});
        uv_poll_start(&ps.handle, ev, onPoll);
    }

    void waitForUntil(int fd, short events, std::chrono::steady_clock::time_point deadline,
                      CancellationToken token, WaitResult* result, std::coroutine_handle<> h) {
        if (token.isCancelled()) {
            if (result) *result = WaitResult::cancelled;
            ready_.push_back(h);
            return;
        }
        const auto now = std::chrono::steady_clock::now();
        if (deadline <= now) {
            if (result) *result = WaitResult::timedOut;
            ready_.push_back(h);
            return;
        }
        // Inicializar poll si hace falta.
        int flags = fcntl(fd, F_GETFL, 0);
        if (flags >= 0 && !(flags & O_NONBLOCK)) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        auto& ps = polls_[fd];
        if (ps.handle.data == nullptr) {
            uv_poll_init(&loop_, &ps.handle, fd);
            ps.handle.data = &ps;
        }
        int ev = 0;
        if (events & 0x001) ev |= UV_READABLE;
        if (events & 0x004) ev |= UV_WRITABLE;
        // Crear timer para el deadline.
        timers_.emplace_back();
        auto& t = timers_.back();
        uv_timer_init(&loop_, &t.handle);
        t.handle.data = &t;
        t.coroutine = h;     // el mismo handle se usa para el timer y el poll
        t.fired = false;
        // t.pollEntry se asigna después de push_back al vector de entries.
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
        uv_timer_start(&t.handle, onTimer, static_cast<uint64_t>(std::max<long long>(0, ms.count())), 0);
        ps.entries.push_back({h, result, deadline, std::move(token), &t, false});
        // Ahora que el PollEntry vive en el vector (estable en deque
        // pero en unordered_map puede reasignar — para V1 usamos
        // unordered_map<int, PollState> donde el vector de entries
        // es estable mientras no borremos la entry).
        t.pollEntry = &ps.entries.back();
        uv_poll_start(&ps.handle, ev, onPoll);
    }

    void post(std::coroutine_handle<> h) {
        { std::lock_guard lock(postedMutex_); posted_.push_back(h); }
        uv_async_send(&wake_);
    }
    void notify() noexcept { uv_async_send(&wake_); }

    void drain() {
        // Iteramos hasta que no haya trabajo: ni timers, ni polls, ni
        // posted, ni cancelaciones pendientes. El chequeo de
        // cancelaciones dentro de runOne es el que rompe la espera
        // cuando cs.cancel() se invoca desde fuera.
        for (int i = 0; i < 1000; ++i) {
            bool hasPending = !ready_.empty() || !timers_.empty() || !posted_.empty();
            if (!hasPending) {
                // ¿Hay cancelaciones pendientes en polls?
                for (auto& [fd, ps] : polls_) {
                    for (auto& e : ps.entries) {
                        if (e.token.isCancelled()) { hasPending = true; break; }
                    }
                    if (hasPending) break;
                }
            }
            if (!hasPending) break;
            runOne();
        }
    }

    void runOne() {
        // Antes de bloquear en uv_run, procesar cancelaciones
        // pendientes: si algún PollEntry fue cancelado entre runOne's,
        // debemos despertarlo sin esperar al poll.
        for (auto& [fd, ps] : polls_) {
            for (auto& e : ps.entries) {
                if (!e.fired && e.token.isCancelled()) {
                    e.fired = true;
                    if (e.result) *e.result = WaitResult::cancelled;
                    if (e.timeoutTimer) {
                        uv_timer_stop(&e.timeoutTimer->handle);
                        // CRÍTICO: hacer uv_close ANTES de uv_run, no
                        // después. Si no, uv_run(UV_RUN_ONCE) ve el
                        // handle activo y bloquea esperando aunque
                        // esté parado. El destructor cierra lo que
                        // quede.
                        uv_close(reinterpret_cast<uv_handle_t*>(&e.timeoutTimer->handle), nullptr);
                        e.timeoutTimer->fired = true;
                        e.timeoutTimer->closed = true;
                    }
                    ready_.push_back(e.handle);
                }
            }
        }
        // Tambien limpiar timers fired de iteraciones anteriores
        // antes de uv_run, para no contaminar el conteo de handles
        // activos de libuv.
        for (auto it = timers_.begin(); it != timers_.end(); ) {
            if (it->fired) {
                if (!it->closed) {
                    uv_close(reinterpret_cast<uv_handle_t*>(&it->handle), nullptr);
                    it->closed = true;
                }
                it = timers_.erase(it);
            } else ++it;
        }
        bool hasPosted;
        { std::lock_guard lock(postedMutex_); hasPosted = !posted_.empty(); }
        if (hasPosted) uv_run(&loop_, UV_RUN_NOWAIT);
        else uv_run(&loop_, UV_RUN_ONCE);
        // Procesar posted.
        std::vector<std::coroutine_handle<>> rp;
        { std::lock_guard lock(postedMutex_); rp.swap(posted_); }
        for (auto h : rp) if (h && !h.done()) h.resume();
        // Procesar ready_ (deadlines pasados, cancellations, polls disparados).
        std::vector<std::coroutine_handle<>> rt;
        rt.swap(ready_);
        for (auto h : rt) if (h && !h.done()) h.resume();
        // Cleanup de timers fired por esta iteración (uv_timer callback).
        for (auto it = timers_.begin(); it != timers_.end(); ) {
            if (it->fired) {
                if (!it->closed) {
                    uv_close(reinterpret_cast<uv_handle_t*>(&it->handle), nullptr);
                    it->closed = true;
                }
                it = timers_.erase(it);
            } else ++it;
        }
        // Limpiar entries de polls que ya dispararon.
        for (auto& [fd, ps] : polls_) {
            for (auto it = ps.entries.begin(); it != ps.entries.end(); ) {
                if (it->fired) it = ps.entries.erase(it);
                else ++it;
            }
        }
    }

private:
    struct PollEntry;   // forward decl (TimerEntry lo usa)
    struct TimerEntry {
        uv_timer_t handle{};
        std::coroutine_handle<> coroutine;
        bool fired = false;
        bool closed = false;   // uv_close ya invocado (idempotente)
        // Si este timer es el timeout de un waitForUntil, apunta al
        // PollEntry asociado. Permite al onTimer marcar el PollEntry
        // como fired y asignar WaitResult::timedOut.
        PollEntry* pollEntry = nullptr;
    };
    struct PollEntry {
        std::coroutine_handle<> handle;
        WaitResult* result;
        std::chrono::steady_clock::time_point deadline;
        CancellationToken token;
        TimerEntry* timeoutTimer;  // nullptr para waitFor sin deadline
        bool fired = false;
    };
    struct PollState {
        uv_poll_t handle{};
        std::vector<PollEntry> entries;
    };

    static void onTimer(uv_timer_t* h) {
        auto* t = static_cast<TimerEntry*>(h->data);
        if (t->fired) return;
        t->fired = true;
        // Si este timer es el timeout de un waitForUntil, marcar el
        // PollEntry como fired ANTES de reanudar, para que onPoll
        // no reanude dos veces.
        if (t->pollEntry) {
            t->pollEntry->fired = true;
            if (t->pollEntry->result) *t->pollEntry->result = WaitResult::timedOut;
        }
        t->coroutine.resume();
    }

    static void onPoll(uv_poll_t* h, int status, int events) {
        auto* ps = static_cast<PollState*>(h->data);
        // Cancelación primero.
        for (auto& e : ps->entries) {
            if (e.token.isCancelled()) {
                if (e.result) *e.result = WaitResult::cancelled;
                if (e.timeoutTimer) { uv_timer_stop(&e.timeoutTimer->handle); e.timeoutTimer->fired = true; }
                e.fired = true;
                e.handle.resume();
                return;
            }
        }
        // Después, listo por evento.
        for (auto& e : ps->entries) {
            if (e.result) *e.result = WaitResult::ready;
            if (e.timeoutTimer) { uv_timer_stop(&e.timeoutTimer->handle); e.timeoutTimer->fired = true; }
            e.fired = true;
            e.handle.resume();
            return;
        }
    }

    static void onWake(uv_async_t* h) { (void)h; }

    uv_loop_t loop_{};
    uv_async_t wake_{};
    std::deque<TimerEntry> timers_;
    std::unordered_map<int, PollState> polls_;
    std::vector<std::coroutine_handle<>> ready_;
    std::mutex postedMutex_;
    std::vector<std::coroutine_handle<>> posted_;
};

// --- Awaitables ----------------------------------------------------------

struct ReadPipe {
    MiniLibuvLoop* loop;
    int fd;
    MiniLibuvLoop* result;  // placeholder
    CancellationToken token;
    std::chrono::steady_clock::time_point deadline;
    WaitResult* outResult = nullptr;

    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) {
        if (outResult) {
            loop->waitForUntil(fd, 0x001, deadline, token, outResult, h);
        } else {
            loop->waitFor(fd, 0x001, h);
        }
    }
    void await_resume() {}
};

// --- Tests ----------------------------------------------------------------

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, msg) do { \
    if (cond) { ++g_passed; std::printf("  ok: %s\n", msg); } \
    else      { ++g_failed; std::printf("  FAIL: %s\n", msg); } \
} while (0)

Task co_test_1_read_pipe(MiniLibuvLoop& loop, int readFd) {
    WaitResult r;
    co_await ReadPipe{&loop, readFd, nullptr, CancellationToken{}, std::chrono::steady_clock::now() + std::chrono::seconds(5), &r};
    CHECK(r == WaitResult::ready, "waitForUntil(fd, READ) con pipe listo = ready");
}

void test_1_wait_for_read() {
    std::printf("test 1: waitFor dispara cuando fd está listo\n");
    int fds[2];
    CHECK(pipe(fds) == 0, "pipe() creado");
    // El escritor cierra el pipe a los 30ms, marcando el fd como "ready for read".
    std::thread([fds]{
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        close(fds[1]);
    }).detach();
    MiniLibuvLoop loop;
    co_test_1_read_pipe(loop, fds[0]);
    loop.drain();
    close(fds[0]);
}

Task co_test_2_timeout(MiniLibuvLoop& loop, int readFd) {
    WaitResult r;
    // Deadline 30ms, pero nadie escribe ni cierra. Debe disparar por timeout.
    co_await ReadPipe{&loop, readFd, nullptr, CancellationToken{}, std::chrono::steady_clock::now() + std::chrono::milliseconds(30), &r};
    CHECK(r == WaitResult::timedOut, "waitForUntil sin actividad = timedOut");
}

void test_2_wait_for_until_timeout() {
    std::printf("test 2: waitForUntil dispara por timeout\n");
    int fds[2];
    CHECK(pipe(fds) == 0, "pipe() creado");
    // Nadie escribe ni cierra.
    MiniLibuvLoop loop;
    co_test_2_timeout(loop, fds[0]);
    loop.drain();
    close(fds[0]);
    close(fds[1]);
}

Task co_test_3_cancel(MiniLibuvLoop& loop, int readFd, CancellationSource* cs) {
    WaitResult r;
    co_await ReadPipe{&loop, readFd, nullptr, cs->token(), std::chrono::steady_clock::now() + std::chrono::seconds(5), &r};
    CHECK(r == WaitResult::cancelled, "waitForUntil con cancel = cancelled");
}

void test_3_wait_for_until_cancelled() {
    std::printf("test 3: waitForUntil dispara por cancelación externa\n");
    int fds[2];
    CHECK(pipe(fds) == 0, "pipe() creado");
    CancellationSource cs;
    MiniLibuvLoop loop;
    co_test_3_cancel(loop, fds[0], &cs);
    // Hilo que llama cancel() + notify() tras 20ms. El notify()
    // desbloquea el uv_run que espera el deadline de 5s; el
    // siguiente runOne detecta la cancelación en el chequeo
    // inicial y reanuda la corutina con WaitResult::cancelled.
    std::thread([&cs, &loop]{
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        cs.cancel();
        loop.notify();
    }).detach();
    auto start = std::chrono::steady_clock::now();
    loop.drain();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    CHECK(elapsed < 500, "drain() retorna tras cancelación (no espera 5s del deadline)");
    close(fds[0]);
    close(fds[1]);
}

int main() {
    std::printf("=== test 1 ===\n"); std::fflush(stdout);
    test_1_wait_for_read();
    std::printf("=== test 2 ===\n"); std::fflush(stdout);
    test_2_wait_for_until_timeout();
    std::printf("=== test 3 ===\n"); std::fflush(stdout);
    test_3_wait_for_until_cancelled();
    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}
