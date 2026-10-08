// Backend libuv del EventLoop — header ligero (pre-compilable).
//
// Este header SOLO contiene DECLARACIONES. Las definiciones estan en
// runtime_ets_libuv.cpp, que se compila una vez a un .o cacheado.
//
// Patron validado en runtime/libuv/tests/:
//   - std::deque<TimerEntry> con &back() para que uv_handle_t::data
//     apunte a una direccion estable (no a un local del stack).
//   - cleanup antes y despues de uv_run para que libuv no vea
//     handles zombie como activos (UV_RUN_ONCE bloquearia).
//   - UV_RUN_NOWAIT cuando no hay handles que esperar.
//   - CancellationToken chequeado en runOne al inicio (idem Fase 2B.3).
//
// NO incluir directamente. Usar runtime/ets_event_loop.hpp.

#pragma once

#include <chrono>
#include <coroutine>
#include <deque>
#include <mutex>
#include <unordered_map>
#include <vector>

#include <uv.h>

#include "ets_event_loop_iface.hpp"

namespace ets {

class LibuvEventLoop final : public IEventLoop {
public:
    LibuvEventLoop();
    LibuvEventLoop(const LibuvEventLoop&) = delete;
    LibuvEventLoop& operator=(const LibuvEventLoop&) = delete;
    ~LibuvEventLoop() override;

    void waitFor(int fd, short events, std::coroutine_handle<> handle) override;
    void waitForUntil(int fd, short events, std::chrono::steady_clock::time_point deadline,
                      CancellationToken token, WaitResult* result,
                      std::coroutine_handle<> handle) override;
    void waitUntil(std::chrono::steady_clock::time_point deadline,
                   std::coroutine_handle<> handle) override;
    void detach(std::coroutine_handle<> handle) override;
    void post(std::coroutine_handle<> handle) override;
    void notify() noexcept override;

    // Acceso al uv_loop_t raw. Para integracion con APIs y event loop
    // externos (e.g. uv_getaddrinfo directo). El caller es responsable
    // de no corromper el estado interno.
    uv_loop_t* raw_loop() noexcept;
    uv_async_t* raw_wake() noexcept;

    void runOne() override;

private:
    struct TimerEntry;
    struct PollState;
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
        PollState* parent = nullptr;  // V26: back-pointer para callback pools
    };
    struct PollState {
        uv_poll_t poll{};
        std::vector<PollEntry> entries;
        bool closed = false;
        LibuvEventLoop* loop = nullptr;  // V26: back-pointer al Loop
    };
    struct TimerEntry {
        uv_timer_t handle{};
        std::coroutine_handle<> coroutine;
        PollEntry* pollPtr = nullptr;
        bool fired = false;
        bool closed = false;
    };
    struct DetachedEntry { std::coroutine_handle<> handle; bool fired; };

    static void onPoll(uv_poll_t* h, int status, int events);
    static void onTimerForPoll(uv_timer_t* h);
    static void onTimerForWait(uv_timer_t* h);
    static void onWake(uv_async_t* h);

    uv_loop_t loop_{};
    uv_async_t wake_{};
    std::unordered_map<int, PollState> polls_;
    std::deque<TimerEntry> timers_;
    std::vector<DetachedEntry> detached_;
    std::mutex postedMutex_;
    std::vector<std::coroutine_handle<>> posted_;
    std::vector<std::coroutine_handle<>> ready_;
    // V26: listas de fired, para cleanup event-driven sin scan O(N).
    std::vector<TimerEntry*> timers_to_reap_;
    std::vector<PollEntry*> entries_to_reap_;
    std::vector<int> polls_to_close_;
    std::vector<std::coroutine_handle<>> detached_to_reap_;
};

}  // namespace ets