// ets_net_poll_api.hpp — declaraciones ligeras (pre-compilable).
//
// Este header SOLO contiene DECLARACIONES. Las definiciones estan en
// runtime_ets_net.cpp (compilado a .o cacheado).
//
// Se incluye desde ets_net.hpp cuando NO se define
// -DETS_EVENT_BACKEND_LIBUV. Bajo libuv, ets_net.hpp incluye
// runtime_ets_net_libuv_api.hpp en su lugar.

#pragma once

#include <chrono>
#include <coroutine>

#include "runtime/ets_event_loop.hpp"

// Incluimos ets_async.hpp para visibilidad de defaultEventLoop
// (thread_local inline). En runtime_ets_net.cpp no se instancia nada
// async, solo se referencian awaitables.
#include "runtime/ets_async.hpp"

namespace ets {

struct FdAwaiter {
    int fd;
    short events;
    bool await_ready() const noexcept;
    void await_suspend(std::coroutine_handle<> handle) const;
    void await_resume() const noexcept;
};

// CancellableFdAwaiter: FdAwaiter con deadline + CancellationToken.
struct CancellableFdAwaiter {
    int fd;
    short events;
    std::chrono::steady_clock::time_point deadline;
    CancellationToken token;
    WaitResult result = WaitResult::ready;
    bool await_ready() noexcept;
    void await_suspend(std::coroutine_handle<> handle);
    WaitResult await_resume() const noexcept;
};

}  // namespace ets