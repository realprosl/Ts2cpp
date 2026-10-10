// runtime_ets_net_libuv.cpp — UvFdAwaiter y UvCancellableFdAwaiter (libuv).
//
// V29.3: libuv es el unico backend soportado. El archivo se compila
// siempre (sin -DETS_EVENT_BACKEND_LIBUV). El .o cacheado vive en
// build/runtime_ets_net_libuv.o.
//
// Compilado una vez a build/runtime_ets_net_libuv.o (cacheado).
//
// Uso:
//   g++ -c runtime/runtime_ets_net_libuv.cpp -o build/runtime_ets_net_libuv.o \
//       -std=c++20 -I/root/Ts2cpp
//   g++ build/runtime_ets_net_libuv.o programa.cpp -luv -pthread -o programa

#include "ets_net_libuv_api.hpp"

// Incluimos ets_async.hpp para visibilidad de defaultEventLoop.
#include "runtime/ets_async.hpp"

#include <chrono>
#include <coroutine>

namespace ets {

// --- UvFdAwaiter ---

UvFdAwaiter::UvFdAwaiter(int fd, short events)
    : loop_(&defaultEventLoop), fd_(fd), events_(events) {}

UvFdAwaiter::UvFdAwaiter(ets::EventLoop& loop, int fd, short events)
    : loop_(&loop), fd_(fd), events_(events) {}

UvFdAwaiter::UvFdAwaiter(ets::EventLoop* loop, int fd, short events)
    : loop_(loop), fd_(fd), events_(events) {}

bool UvFdAwaiter::await_ready() const noexcept { return false; }
void UvFdAwaiter::await_suspend(std::coroutine_handle<> h) noexcept {
    loop_->waitForUntil(fd_, events_,
                        std::chrono::steady_clock::time_point::max(),
                        ets::CancellationToken{}, nullptr, h);
}
void UvFdAwaiter::await_resume() const noexcept {}

// --- UvCancellableFdAwaiter ---

UvCancellableFdAwaiter::UvCancellableFdAwaiter(int fd, short events,
                                               std::chrono::steady_clock::time_point deadline,
                                               ets::CancellationToken token)
    : loop_(&defaultEventLoop), fd_(fd), events_(events),
      deadline_(deadline), token_(std::move(token)) {}

UvCancellableFdAwaiter::UvCancellableFdAwaiter(ets::EventLoop& loop, int fd, short events,
                                               std::chrono::steady_clock::time_point deadline,
                                               ets::CancellationToken token)
    : loop_(&loop), fd_(fd), events_(events),
      deadline_(deadline), token_(std::move(token)) {}

UvCancellableFdAwaiter::UvCancellableFdAwaiter(ets::EventLoop* loop, int fd, short events,
                                               std::chrono::steady_clock::time_point deadline,
                                               ets::CancellationToken token)
    : loop_(loop), fd_(fd), events_(events),
      deadline_(deadline), token_(std::move(token)) {}

bool UvCancellableFdAwaiter::await_ready() noexcept { return false; }
void UvCancellableFdAwaiter::await_suspend(std::coroutine_handle<> h) noexcept {
    loop_->waitForUntil(fd_, events_, deadline_, token_, &result_, h);
}
ets::WaitResult UvCancellableFdAwaiter::await_resume() noexcept { return result_; }

}  // namespace ets