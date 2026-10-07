// runtime_ets_net.cpp — FdAwaiter y CancellableFdAwaiter (backend poll).
//
// Compilado una vez a build/runtime_ets_net.o (cacheado). El usuario
// enlaza este .o con su programa generado sin recompilar el runtime.
//
// Uso:
//   g++ -c runtime/runtime_ets_net.cpp -o build/runtime_ets_net.o \
//       -std=c++20 -I/root/Ts2cpp
//   g++ build/runtime_ets_net.o programa.cpp -lpthread -o programa

#include "ets_net_poll_api.hpp"

#include <chrono>

namespace ets {

bool FdAwaiter::await_ready() const noexcept { return false; }
void FdAwaiter::await_suspend(std::coroutine_handle<> handle) const {
    defaultEventLoop.waitFor(fd, events, handle);
}
void FdAwaiter::await_resume() const noexcept {}

bool CancellableFdAwaiter::await_ready() noexcept {
    if (token.isCancelled()) { result = WaitResult::cancelled; return true; }
    if (deadline <= std::chrono::steady_clock::now()) { result = WaitResult::timedOut; return true; }
    return false;
}
void CancellableFdAwaiter::await_suspend(std::coroutine_handle<> handle) {
    defaultEventLoop.waitForUntil(fd, events, deadline, token, &result, handle);
}
WaitResult CancellableFdAwaiter::await_resume() const noexcept { return result; }

}  // namespace ets