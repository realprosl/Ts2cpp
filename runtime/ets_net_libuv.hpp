// Backend libuv de las funciones de red async de ets_net.hpp.
//
// Este header se incluye en ets_net.hpp solo si
// -DETS_EVENT_BACKEND_LIBUV esta definido. Provee UvFdAwaiter y
// UvCancellableFdAwaiter, que son los reemplazos libuv de los
// FdAwaiter / CancellableFdAwaiter basados en poll(2).
//
// Lo que aporta:
//   - Un solo epoll/kqueue/IOCP por loop (libuv) en vez de N descriptores
//     en poll(2) por cada runOne.
//   - Cross-platform: libuv abstrae epoll (Linux), kqueue (BSD/macOS),
//     IOCP (Windows).
//   - Cancelacion distribuida via CancellationToken integrada con
//     uv_poll_t y uv_timer_t (idem Fase 2B.3).
//
// Lo que NO aporta en V1:
//   - Sustitucion de ::socket/bind/listen/accept/recv/send por
//     uv_tcp_t. Eso sera Fase 3.3 (validado en test_tcp_server.cpp).
//     V1 mantiene los fd-based syscalls para compatibilidad.

#include <chrono>
#include <coroutine>
#include <cstring>
#include <memory>
#include <poll.h>

#include "runtime/ets_event_loop.hpp"

namespace ets {

// UvFdAwaiter: equivalente libuv de FdAwaiter. Usa uv_poll_t internamente
// para esperar a que un fd este listo para lectura/escritura.
class UvFdAwaiter {
public:
    // Constructor 2-arg: usa el defaultEventLoop global (compatible
    // con FdAwaiter{fd, events}).
    UvFdAwaiter(int fd, short events)
        : loop_(&defaultEventLoop), fd_(fd), events_(events) {}
    // Constructor 3-arg: loop custom.
    UvFdAwaiter(ets::EventLoop& loop, int fd, short events)
        : loop_(&loop), fd_(fd), events_(events) {}
    UvFdAwaiter(ets::EventLoop* loop, int fd, short events)
        : loop_(loop), fd_(fd), events_(events) {}
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) noexcept {
        loop_->waitForUntil(fd_, events_,
                            std::chrono::steady_clock::time_point::max(),
                            ets::CancellationToken{}, nullptr, h);
    }
    void await_resume() noexcept {}
private:
    ets::EventLoop* loop_;
    int fd_;
    short events_;
};

// UvCancellableFdAwaiter: equivalente libuv de CancellableFdAwaiter.
// Combina uv_poll_t con deadline + CancellationToken (idem Fase 2B.3).
class UvCancellableFdAwaiter {
public:
    // Constructor 4-arg: usa el defaultEventLoop global (compatible
    // con CancellableFdAwaiter{fd, events, deadline, token}).
    UvCancellableFdAwaiter(int fd, short events,
                           std::chrono::steady_clock::time_point deadline,
                           ets::CancellationToken token)
        : loop_(&defaultEventLoop), fd_(fd), events_(events),
          deadline_(deadline), token_(std::move(token)) {}
    // Constructor 5-arg: loop custom.
    UvCancellableFdAwaiter(ets::EventLoop& loop, int fd, short events,
                           std::chrono::steady_clock::time_point deadline,
                           ets::CancellationToken token)
        : loop_(&loop), fd_(fd), events_(events),
          deadline_(deadline), token_(std::move(token)) {}
    UvCancellableFdAwaiter(ets::EventLoop* loop, int fd, short events,
                           std::chrono::steady_clock::time_point deadline,
                           ets::CancellationToken token)
        : loop_(loop), fd_(fd), events_(events),
          deadline_(deadline), token_(std::move(token)) {}
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) noexcept {
        loop_->waitForUntil(fd_, events_, deadline_, token_, &result_, h);
    }
    ets::WaitResult await_resume() noexcept { return result_; }
private:
    ets::EventLoop* loop_;
    int fd_;
    short events_;
    std::chrono::steady_clock::time_point deadline_;
    ets::CancellationToken token_;
    ets::WaitResult result_{ets::WaitResult::ready};
};

}  // namespace ets