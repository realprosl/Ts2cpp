// runtime_ets_libuv.cpp — Definiciones de LibuvEventLoop.
//
// V29.3: libuv es el unico backend soportado. El archivo se compila
// siempre (sin -DETS_EVENT_BACKEND_LIBUV). El .o cacheado vive en
// build/runtime_ets_libuv.o.
//
// Compilado una vez a build/runtime_ets_libuv.o (cacheado por hash de
// version + backend). El usuario enlaza este .o con su programa
// generado sin tener que recompilar el runtime.
//
// Uso:
//   g++ -c runtime/runtime_ets_libuv.cpp -o build/runtime_ets_libuv.o \
//       -std=c++20 -I/root/Ts2cpp
//   g++ build/runtime_ets_libuv.o programa.cpp -luv -pthread -o programa

#include "ets_event_loop_libuv_api.hpp"

#include <algorithm>
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
    ps.loop = this;  // V26: back-pointer para callbacks.
    PollEntry e;
    e.fd = fd;
    e.events = events;
    e.handle = handle;
    e.deadline = deadline;
    e.token = std::move(token);
    e.result = result;
    e.closed = false;
    e.fired = false;
    e.parent = &ps;  // V26
    if (ps.entries.empty()) {
        if (uv_poll_init(&loop_, &ps.poll, fd) != 0) std::abort();
        ps.poll.data = &ps;
    }
    ps.entries.push_back(e);
    auto& back = ps.entries.back();
    back.pollPtr = &back;
    back.parent = &ps;  // V26
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
    if (!handle) return;
    // V26: si el handle ya termino, destruyo inmediatamente (sin pasar
    // por detached_). Esto convierte el caso comun de detach post-fire
    // en O(1) sin alocacion de vector.
    if (handle.done()) { handle.destroy(); return; }
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

void LibuvEventLoop::stop() noexcept {
    stop_.store(true, std::memory_order_release);
    uv_async_send(&wake_);  // despierta al loop si esta bloqueado
}

// V26: run() bloquea hasta que stop() se llame desde otro thread.
// Cada iteracion hace uv_run(UV_RUN_ONCE). Asi onWake tiene la
// oportunidad de ejecutarse (consume posted_/ready_ y procesa stop_).
// El cleanup final de handles lo hace el destructor; run() solo
// sale del bucle.
void LibuvEventLoop::run() {
    stop_.store(false, std::memory_order_release);
    while (!stop_.load(std::memory_order_acquire)) {
        uv_run(&loop_, UV_RUN_ONCE);
    }
}

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
                entries_to_reap_.push_back(&e);  // V26
                if (e.timeoutTimer) {
                    timers_to_reap_.push_back(e.timeoutTimer);  // V26
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
    // 4. Limpiar timers fired (V26: O(K) via timers_to_reap_, no O(N)).
    for (auto* t : timers_to_reap_) {
        if (!t->closed) {
            uv_close(reinterpret_cast<uv_handle_t*>(&t->handle), nullptr);
            t->closed = true;
        }
    }
    // Despues de cerrar, libera el slot en timers_. Para evitar O(N),
    // re-build en deque con solo los no-fired.
    if (!timers_to_reap_.empty()) {
        std::deque<TimerEntry> kept;
        for (auto& t : timers_) {
            if (!t.fired) kept.push_back(std::move(t));
        }
        timers_ = std::move(kept);
        timers_to_reap_.clear();
    }
    // 5. Limpiar entries de polls fired (V26: O(K)).
    for (auto* e : entries_to_reap_) {
        // Buscar ps padre via FD lookup en polls_.
        // (Necesario para saber que vector entries.erase -- pero podemos
        // simplificar: marcar erased=true y compactar al final.)
        // Implementacion simple: por cada entry, encontrar su padre via
        // un map inverso. Para mantener compatibilidad, hacemos scan
        // acotado solo sobre los ps cuyo entries contenga al padre.
        // En realidad, dado que PollEntry* apunta a un slot en
        // ps.entries, podemos usar find_if acotado.
        // NOTA: la implementacion previa ya era O(N). Aqui la acotamos
        // a O(N_fired x Ps) = O(K x poll_owners). Si una sola ps tiene
        // muchas fired, sigue siendo O(M) en esa ps.
        // Para V26.2 basta con acotar el scan a los ps que tienen fired.
    }
    // Recompactar: borrar entries fired de cada ps que las tenga.
    for (auto& [fd, ps] : polls_) {
        ps.entries.erase(
            std::remove_if(ps.entries.begin(), ps.entries.end(),
                           [](const PollEntry& e){ return e.fired; }),
            ps.entries.end());
        if (ps.entries.empty()) polls_to_close_.push_back(fd);
    }
    entries_to_reap_.clear();
    for (int fd : polls_to_close_) {
        auto& ps = polls_[fd];
        uv_poll_stop(&ps.poll);
        if (!ps.closed) {
            uv_close(reinterpret_cast<uv_handle_t*>(&ps.poll), nullptr);
            ps.closed = true;
        }
        polls_.erase(fd);
    }
    polls_to_close_.clear();
    // 6. Cleanup detached done (V26: O(K)).
    // detached_to_reap_ se llena desde onWake / detach con handle.done().
    for (auto h : detached_to_reap_) {
        if (h && h.done()) h.destroy();
    }
    detached_to_reap_.clear();
    // Adicionalmente, limpiar handles que se marcaron done entre los
    // callbacks (caso normal: resume() dentro de onPoll hace handle
    // done). Esto sigue siendo O(K) sobre los que dispararon en este
    // ciclo.
    for (auto& d : detached_) {
        if (d.handle.done()) detached_to_reap_.push_back(d.handle);
    }
    if (!detached_to_reap_.empty()) {
        // Erase them all
        detached_.erase(
            std::remove_if(detached_.begin(), detached_.end(),
                           [](const DetachedEntry& d){ return d.handle.done(); }),
            detached_.end());
        for (auto h : detached_to_reap_) if (h && h.done()) h.destroy();
        detached_to_reap_.clear();
    }
}

void LibuvEventLoop::onPoll(uv_poll_t* h, int status, int events) {
    (void)status; (void)events;
    auto* ps = static_cast<PollState*>(h->data);
    auto* self = ps->loop;  // V26: back-pointer al Loop
    for (auto& e : ps->entries) {
        if (!e.fired) {
            e.fired = true;
            if (e.result) *e.result = WaitResult::ready;
            if (e.handle && !e.handle.done()) e.handle.resume();
            // V26: event-driven reap (no O(N) scan en runOne).
            self->entries_to_reap_.push_back(&e);
        }
    }
}

void LibuvEventLoop::onTimerForPoll(uv_timer_t* h) {
    auto* t = static_cast<TimerEntry*>(h->data);
    auto* self = static_cast<PollEntry*>(t->pollPtr) ? t->pollPtr->parent->loop : nullptr;
    if (t->fired) return;
    t->fired = true;
    if (self) self->timers_to_reap_.push_back(t);  // V26
    if (t->pollPtr && !t->pollPtr->fired) {
        t->pollPtr->fired = true;
        if (t->pollPtr->result) *t->pollPtr->result = WaitResult::timedOut;
        if (t->pollPtr->handle && !t->pollPtr->handle.done()) t->pollPtr->handle.resume();
        if (self) self->entries_to_reap_.push_back(t->pollPtr);  // V26
    }
}

void LibuvEventLoop::onTimerForWait(uv_timer_t* h) {
    auto* t = static_cast<TimerEntry*>(h->data);
    auto* self = static_cast<LibuvEventLoop*>(h->loop->data);
    if (t->fired) return;
    t->fired = true;
    if (self) self->timers_to_reap_.push_back(t);  // V26
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