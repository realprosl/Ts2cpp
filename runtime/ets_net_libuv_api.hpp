// ets_net_libuv_api.hpp — declaraciones ligeras (pre-compilable).
//
// Equivalente libuv de FdAwaiter / CancellableFdAwaiter. Se compila a .o
// bajo -DETS_EVENT_BACKEND_LIBUV.
//
// Las definiciones estan en runtime_ets_net_libuv.cpp.

#pragma once

#include <chrono>
#include <coroutine>
#include <poll.h>

#include "runtime/ets_event_loop.hpp"

namespace ets {

class UvFdAwaiter {
public:
    UvFdAwaiter(int fd, short events);
    UvFdAwaiter(ets::EventLoop& loop, int fd, short events);
    UvFdAwaiter(ets::EventLoop* loop, int fd, short events);
    bool await_ready() const noexcept;
    void await_suspend(std::coroutine_handle<> h) noexcept;
    void await_resume() const noexcept;
private:
    ets::EventLoop* loop_;
    int fd_;
    short events_;
};

class UvCancellableFdAwaiter {
public:
    UvCancellableFdAwaiter(int fd, short events,
                           std::chrono::steady_clock::time_point deadline,
                           ets::CancellationToken token);
    UvCancellableFdAwaiter(ets::EventLoop& loop, int fd, short events,
                           std::chrono::steady_clock::time_point deadline,
                           ets::CancellationToken token);
    UvCancellableFdAwaiter(ets::EventLoop* loop, int fd, short events,
                           std::chrono::steady_clock::time_point deadline,
                           ets::CancellationToken token);
    bool await_ready() noexcept;
    void await_suspend(std::coroutine_handle<> h) noexcept;
    ets::WaitResult await_resume() noexcept;
private:
    ets::EventLoop* loop_;
    int fd_;
    short events_;
    std::chrono::steady_clock::time_point deadline_;
    ets::CancellationToken token_;
    ets::WaitResult result_{ets::WaitResult::ready};
};

}  // namespace ets