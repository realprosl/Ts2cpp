// runtime_ets_libuv.cpp — Definiciones de LibuvEventLoop.
//
// Compilado una vez a build/runtime_ets_libuv.o (cacheado por hash de
// version + backend). El usuario enlaza este .o con su programa
// generado sin tener que recompilar el runtime.
//
// Uso:
//   g++ -c runtime/runtime_ets_libuv.cpp -o build/runtime_ets_libuv.o \
//       -std=c++20 -I/root/Ts2cpp
//   g++ build/runtime_ets_libuv.o programa.cpp -luv -pthread -o programa
//
// Compilacion condicional: solo se compila bajo -DETS_EVENT_BACKEND_LIBUV.

#ifdef ETS_EVENT_BACKEND_LIBUV

#include "ets_event_loop_libuv_api.hpp"

#include <cstdlib>

namespace ets {

LibuvEventLoop::LibuvEventLoop() {
    if (uv_loop_init(&loop_) != 0) std::abort();
    if (uv_async_init(&loop_, &wake_, onWake) != 0) std::abort();
    wake_.data = this;
}

LibuvEventLoop::~LibuvEventLoop() {
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

void LibuvEventLoop::waitFor(int fd, short events, std::coroutine_handle<> handle) {
    waitForUntil(fd, events, std::chrono::steady_clock::time_point::max(),
                 CancellationToken{}, nullptr, handle);
}

void LibuvEventLoop::waitForUntil(int fd, short events,
                                   std::chrono::steady_clock::time_point deadline,
                                   CancellationToken token, WaitResult* result,
                                   std::coroutine_handle<> handle) {
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
    if (ps.entries.empty()) {
        if (uv_poll_init(&loop_, &ps.poll, fd) != 0) std::abort();
        ps.poll.data = &ps;
    }
    ps.entries.push_back(e);
    auto& back = ps.entries.back();
    back.pollPtr = &back;
    ps.poll.data = &ps;
    uv_poll_start(&ps.poll, events, onPoll);
    if (deadline != std::chrono::steady_clock::time_point::max()) {
        const auto now = std::chrono::steady_clock::now();
        const auto ms = deadline <= now ? 0
            : std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
        timers_.emplace_back();
        auto& t = timers_.back();
        uv_timer_init(&loop_, &t.handle);
        t.handle.data = &t;
        t.coroutine = nullptr;
        t.pollPtr = &back;
        t.fired = false;
        t.closed = false;
        back.timeoutTimer = &t;
        uv_timer_start(&t.handle, onTimerForPoll, ms, 0);
    }
}

void LibuvEventLoop::waitUntil(std::chrono::steady_clock::time_point deadline,
                                std::coroutine_handle<> handle) {
    timers_.emplace_back();
    auto& t = timers_.back();
    uv_timer_init(&loop_, &t.handle);
    t.handle.data = &t;
    t.coroutine = handle;
    t.pollPtr = nullptr;
    t.fired = false;
    t.closed = false;
    const auto now = std::chrono::steady_clock::now();
    const auto ms = deadline <= now ? 0
        : std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
    uv_timer_start(&t.handle, onTimerForWait, ms, 0);
}

void LibuvEventLoop::detach(std::coroutine_handle<> handle) {
    if (!handle || handle.done()) return;
    detached_.push_back({handle, false});
}

void LibuvEventLoop::post(std::coroutine_handle<> handle) {
    {
        std::lock_guard lock(postedMutex_);
        posted_.push_back(handle);
    }
    uv_async_send(&wake_);
}

void LibuvEventLoop::notify() noexcept { uv_async_send(&wake_); }

uv_loop_t* LibuvEventLoop::raw_loop() noexcept { return &loop_; }
uv_async_t* LibuvEventLoop::raw_wake() noexcept { return &wake_; }

void LibuvEventLoop::runOne() {
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
    // 2. uv_run segun el estado.
    bool hasPosted;
    { std::lock_guard lock(postedMutex_); hasPosted = !posted_.empty(); }
    bool hasTimers = !timers_.empty();
    bool hasPolls = !polls_.empty();
    if (hasPosted) uv_run(&loop_, UV_RUN_NOWAIT);
    else if (hasTimers || hasPolls) uv_run(&loop_, UV_RUN_ONCE);
    else uv_run(&loop_, UV_RUN_NOWAIT);
    // 3. Chequear cancelaciones en polls DESPUES del uv_run.
    for (auto& [fd, ps] : polls_) {
        for (auto& e : ps.entries) {
            if (!e.fired && e.token.isCancelled()) {
                e.fired = true;
                if (e.result) *e.result = WaitResult::cancelled;
                ready_.push_back(e.handle);
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
    uv_async_send(&wake_);
    uv_run(&loop_, UV_RUN_NOWAIT);
    // 4. Limpiar timers fired tras uv_run.
    for (auto it = timers_.begin(); it != timers_.end(); ) {
        if (it->fired) {
            if (!it->closed) {
                uv_close(reinterpret_cast<uv_handle_t*>(&it->handle), nullptr);
                it->closed = true;
            }
            it = timers_.erase(it);
        } else ++it;
    }
    // 5. Limpiar entries de polls fired.
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
    // 6. Limpiar detached terminados.
    for (auto it = detached_.begin(); it != detached_.end(); ) {
        if (it->handle.done()) {
            it->handle.destroy();
            it = detached_.erase(it);
        } else ++it;
    }
}

void LibuvEventLoop::onPoll(uv_poll_t* h, int status, int events) {
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

void LibuvEventLoop::onTimerForPoll(uv_timer_t* h) {
    auto* t = static_cast<TimerEntry*>(h->data);
    if (t->fired) return;
    t->fired = true;
    if (t->pollPtr && !t->pollPtr->fired) {
        t->pollPtr->fired = true;
        if (t->pollPtr->result) *t->pollPtr->result = WaitResult::timedOut;
        if (t->pollPtr->handle && !t->pollPtr->handle.done()) t->pollPtr->handle.resume();
    }
}

void LibuvEventLoop::onTimerForWait(uv_timer_t* h) {
    auto* t = static_cast<TimerEntry*>(h->data);
    if (t->fired) return;
    t->fired = true;
    if (t->coroutine && !t->coroutine.done()) t->coroutine.resume();
}

void LibuvEventLoop::onWake(uv_async_t* h) {
    auto* self = static_cast<LibuvEventLoop*>(h->data);
    std::vector<std::coroutine_handle<>> rp;
    { std::lock_guard lk(self->postedMutex_); rp.swap(self->posted_); }
    for (auto hh : rp) if (hh && !hh.done()) hh.resume();
    std::vector<std::coroutine_handle<>> rt;
    rt.swap(self->ready_);
    for (auto hh : rt) if (hh && !hh.done()) hh.resume();
}

}  // namespace ets

#endif  // ETS_EVENT_BACKEND_LIBUV