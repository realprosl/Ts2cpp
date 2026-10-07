// Backend libuv del EventLoop.
//
// Implementacion alternativa al PollEventLoop basada en libuv.
// Se compila solo si ETS_EVENT_BACKEND_LIBUV esta definido, y la
// aplicacion debe enlazar contra libuv (-luv).
//
// NO incluir directamente. Usar runtime/ets_event_loop.hpp.
//
// Patron validado en runtime/libuv/tests/:
//   - std::deque<TimerEntry> con &back() para que uv_handle_t::data
//     apunte a una direccion estable (no a un local del stack).
//   - cleanup antes y despues de uv_run para que libuv no vea
//     handles zombie como activos (UV_RUN_ONCE bloquearia).
//   - UV_RUN_NOWAIT cuando no hay handles que esperar.
//   - CancellationToken chequeado en runOne al inicio (idem Fase 2B.3).

#include <atomic>
#include <chrono>
#include <coroutine>
#include <deque>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#include <uv.h>

#include "ets_event_loop_iface.hpp"

namespace ets {

class LibuvEventLoop final : public IEventLoop {
public:
    LibuvEventLoop() {
        if (uv_loop_init(&loop_) != 0) std::abort();
        if (uv_async_init(&loop_, &wake_, onWake) != 0) std::abort();
        wake_.data = this;
    }
    LibuvEventLoop(const LibuvEventLoop&) = delete;
    LibuvEventLoop& operator=(const LibuvEventLoop&) = delete;
    ~LibuvEventLoop() override {
        // Destruir detached pendientes (final_suspend=always, el
        // compilador no destruye el frame solo).
        for (auto& d : detached_) {
            if (d.handle && !d.handle.done()) d.handle.destroy();
        }
        detached_.clear();
        // Cerrar timers y polls restantes antes de uv_loop_close.
        // Ojo, runOne puede haber dejado handles con closed=true
        // pero todavia en el contenedor; uv_close en un handle ya
        // cerrado provoca assertion.
        for (auto& t : timers_) {
            if (!t.closed) {
                uv_close(reinterpret_cast<uv_handle_t*>(&t.handle), nullptr);
                t.closed = true;
            }
        }
        timers_.clear();
        for (auto& [fd, ps] : polls_) {
            uv_poll_stop(&ps.poll);
            // En libuv, uv_close es idempotente si NO se llama dos
            // veces seguidas. Para evitar el double-close usamos
            // una bandera local.
            static_cast<void>(fd);
            if (!ps.closed) {
                uv_close(reinterpret_cast<uv_handle_t*>(&ps.poll), nullptr);
                ps.closed = true;
            }
        }
        polls_.clear();
        uv_close(reinterpret_cast<uv_handle_t*>(&wake_), nullptr);
        uv_run(&loop_, UV_RUN_DEFAULT);
        uv_loop_close(&loop_);
    }

    void waitFor(int fd, short events, std::coroutine_handle<> handle) override {
        // Sin deadline = waitFor con deadline max.
        waitForUntil(fd, events, std::chrono::steady_clock::time_point::max(), CancellationToken{}, nullptr, handle);
    }
    void waitForUntil(int fd, short events, std::chrono::steady_clock::time_point deadline, CancellationToken token, WaitResult* result, std::coroutine_handle<> handle) override {
        auto& ps = polls_[fd];
        PollEntry e;
        e.fd = fd;
        e.events = events;
        e.handle = handle;
        e.deadline = deadline;
        e.token = std::move(token);
        e.result = result;
        e.closed = false;
        e.fired = false;
        // Crear uv_poll si es el primer entry para este fd.
        if (ps.entries.empty()) {
            if (uv_poll_init(&loop_, &ps.poll, fd) != 0) std::abort();
            ps.poll.data = &ps;
        }
        ps.entries.push_back(e);
        auto& back = ps.entries.back();
        back.pollPtr = &back;  // direccion estable dentro del vector
        ps.poll.data = &ps;
        uv_poll_start(&ps.poll, events, onPoll);
        // Programar timer si hay deadline.
        if (deadline != std::chrono::steady_clock::time_point::max()) {
            const auto now = std::chrono::steady_clock::now();
            const auto ms = deadline <= now ? 0 : std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
            timers_.emplace_back();
            auto& t = timers_.back();
            uv_timer_init(&loop_, &t.handle);
            t.handle.data = &t;
            t.coroutine = nullptr;  // no se usa; onPoll se encarga
            t.pollPtr = &back;
            t.fired = false;
            t.closed = false;
            back.timeoutTimer = &t;
            uv_timer_start(&t.handle, onTimerForPoll, ms, 0);
        }
    }
    void waitUntil(std::chrono::steady_clock::time_point deadline, std::coroutine_handle<> handle) override {
        timers_.emplace_back();
        auto& t = timers_.back();
        uv_timer_init(&loop_, &t.handle);
        t.handle.data = &t;
        t.coroutine = handle;
        t.pollPtr = nullptr;
        t.fired = false;
        t.closed = false;
        const auto now = std::chrono::steady_clock::now();
        const auto ms = deadline <= now ? 0 : std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
        uv_timer_start(&t.handle, onTimerForWait, ms, 0);
    }
    void detach(std::coroutine_handle<> handle) override {
        if (!handle || handle.done()) return;
        detached_.push_back({handle, false});
    }
    void post(std::coroutine_handle<> handle) override {
        {
            std::lock_guard lock(postedMutex_);
            posted_.push_back(handle);
        }
        uv_async_send(&wake_);
    }
    void notify() noexcept override { uv_async_send(&wake_); }

    // Acceso al uv_loop_t raw. Para integracion con APIs y event loop
    // externos (e.g. uv_getaddrinfo directo). El caller es responsable
    // de no corromper el estado interno.
    uv_loop_t* raw_loop() noexcept { return &loop_; }
    uv_async_t* raw_wake() noexcept { return &wake_; }

    void runOne() override {
        // 1. Limpiar timers fired antes de uv_run.
        for (auto it = timers_.begin(); it != timers_.end(); ) {
            if (it->fired) {
                if (!it->closed) {
                    uv_close(reinterpret_cast<uv_handle_t*>(&it->handle), nullptr);
                    it->closed = true;
                }
                it = timers_.erase(it);
            } else ++it;
        }
        // 3. uv_run segun el estado.
        bool hasPosted;
        { std::lock_guard lock(postedMutex_); hasPosted = !posted_.empty(); }
        bool hasTimers = !timers_.empty();
        bool hasPolls = !polls_.empty();
        if (hasPosted) uv_run(&loop_, UV_RUN_NOWAIT);
        else if (hasTimers || hasPolls) uv_run(&loop_, UV_RUN_ONCE);
        else uv_run(&loop_, UV_RUN_NOWAIT);
        // 4. Chequear cancelaciones en polls DESPUES del uv_run
        // (idem Fase 2B.3). El wake async que llego durante uv_run
        // ya proceso cualquier notify() del caller; aqui marcamos
        // los polls cancelados.
        for (auto& [fd, ps] : polls_) {
            for (auto& e : ps.entries) {
                if (!e.fired && e.token.isCancelled()) {
                    e.fired = true;
                    if (e.result) *e.result = WaitResult::cancelled;
                    ready_.push_back(e.handle);
                    // Cerrar el timer de deadline si existe.
                    if (e.timeoutTimer) {
                        uv_timer_stop(&e.timeoutTimer->handle);
                        if (!e.timeoutTimer->closed) {
                            uv_close(reinterpret_cast<uv_handle_t*>(&e.timeoutTimer->handle), nullptr);
                            e.timeoutTimer->closed = true;
                        }
                    }
                }
            }
        }
        // Despertar el wake para que procese ready_ y posted_.
        uv_async_send(&wake_);
        uv_run(&loop_, UV_RUN_NOWAIT);
        // 6. Limpiar timers fired tras uv_run.
        for (auto it = timers_.begin(); it != timers_.end(); ) {
            if (it->fired) {
                if (!it->closed) {
                    uv_close(reinterpret_cast<uv_handle_t*>(&it->handle), nullptr);
                    it->closed = true;
                }
                it = timers_.erase(it);
            } else ++it;
        }
        // 7. Limpiar entries de polls fired.
        std::vector<int> pollsToClose;
        for (auto& [fd, ps] : polls_) {
            for (auto it = ps.entries.begin(); it != ps.entries.end(); ) {
                if (it->fired) it = ps.entries.erase(it);
                else ++it;
            }
            if (ps.entries.empty()) pollsToClose.push_back(fd);
        }
        for (int fd : pollsToClose) {
            auto& ps = polls_[fd];
            uv_poll_stop(&ps.poll);
            if (!ps.closed) {
                uv_close(reinterpret_cast<uv_handle_t*>(&ps.poll), nullptr);
                ps.closed = true;
            }
            polls_.erase(fd);
        }
        // 8. Limpiar detached terminados.
        for (auto it = detached_.begin(); it != detached_.end(); ) {
            if (it->handle.done()) {
                it->handle.destroy();
                it = detached_.erase(it);
            } else ++it;
        }
    }

struct TimerEntry;   // forward decl (PollEntry lo usa)
struct PollEntry {
        int fd = -1;
        short events = 0;
        std::coroutine_handle<> handle;
        std::chrono::steady_clock::time_point deadline;
        CancellationToken token;
        WaitResult* result = nullptr;
        bool fired = false;
        bool closed = false;
        PollEntry* pollPtr = nullptr;
        TimerEntry* timeoutTimer = nullptr;
    };
    struct PollState {
        uv_poll_t poll{};
        std::vector<PollEntry> entries;
        bool closed = false;
    };
    struct TimerEntry {
        uv_timer_t handle{};
        std::coroutine_handle<> coroutine;
        PollEntry* pollPtr = nullptr;
        bool fired = false;
        bool closed = false;
    };
    struct DetachedEntry { std::coroutine_handle<> handle; bool fired; };

    static void onPoll(uv_poll_t* h, int status, int events) {
        (void)status; (void)events;
        auto* ps = static_cast<PollState*>(h->data);
        for (auto& e : ps->entries) {
            if (!e.fired) {
                e.fired = true;
                if (e.result) *e.result = WaitResult::ready;
                if (e.handle && !e.handle.done()) e.handle.resume();
            }
        }
    }
    static void onTimerForPoll(uv_timer_t* h) {
        auto* t = static_cast<TimerEntry*>(h->data);
        if (t->fired) return;
        t->fired = true;
        if (t->pollPtr && !t->pollPtr->fired) {
            t->pollPtr->fired = true;
            if (t->pollPtr->result) *t->pollPtr->result = WaitResult::timedOut;
            if (t->pollPtr->handle && !t->pollPtr->handle.done()) t->pollPtr->handle.resume();
        }
    }
    static void onTimerForWait(uv_timer_t* h) {
        auto* t = static_cast<TimerEntry*>(h->data);
        if (t->fired) return;
        t->fired = true;
        if (t->coroutine && !t->coroutine.done()) t->coroutine.resume();
    }
    static void onWake(uv_async_t* h) {
        auto* self = static_cast<LibuvEventLoop*>(h->data);
        // Procesar posted (corutinas que se encolaron via post()).
        std::vector<std::coroutine_handle<>> rp;
        { std::lock_guard lk(self->postedMutex_); rp.swap(self->posted_); }
        for (auto hh : rp) if (hh && !hh.done()) hh.resume();
        // Procesar ready_ (polls y timers que dispararon).
        std::vector<std::coroutine_handle<>> rt;
        rt.swap(self->ready_);
        for (auto hh : rt) if (hh && !hh.done()) hh.resume();
    }

    uv_loop_t loop_{};
    uv_async_t wake_{};
    std::unordered_map<int, PollState> polls_;
    std::deque<TimerEntry> timers_;
    std::vector<DetachedEntry> detached_;
    std::mutex postedMutex_;
    std::vector<std::coroutine_handle<>> posted_;
    std::vector<std::coroutine_handle<>> ready_;
};

}  // namespace ets