// Backend poll del EventLoop — header ligero (pre-compilable).
//
// Este header SOLO contiene DECLARACIONES. Las definiciones estan en
// runtime_ets_poll.cpp, que se compila una vez a un .o cacheado.
//
// NO incluir directamente. Usar runtime/ets_event_loop.hpp.

#pragma once

#include <chrono>
#include <coroutine>
#include <mutex>
#include <vector>

#include "ets_event_loop_iface.hpp"

namespace ets {

class PollEventLoop final : public IEventLoop {
public:
    PollEventLoop();
    PollEventLoop(const PollEventLoop&) = delete;
    PollEventLoop& operator=(const PollEventLoop&) = delete;
    ~PollEventLoop() override;

    void waitFor(int fd, short events, std::coroutine_handle<> handle) override;
    void waitForUntil(int fd, short events, std::chrono::steady_clock::time_point deadline,
                      CancellationToken token, WaitResult* result,
                      std::coroutine_handle<> handle) override;
    void waitUntil(std::chrono::steady_clock::time_point deadline,
                   std::coroutine_handle<> handle) override;
    void detach(std::coroutine_handle<> handle) override;
    void post(std::coroutine_handle<> handle) override;
    void notify() noexcept override;
    void runOne() override;

private:
    void writeWake() noexcept;

    struct IoWait {
        int fd;
        short events;
        std::coroutine_handle<> handle;
        std::chrono::steady_clock::time_point deadline;
        CancellationToken token;
        WaitResult* result;
    };
    struct TimerEntry {
        std::chrono::steady_clock::time_point deadline;
        std::coroutine_handle<> handle;
    };

    std::vector<IoWait> io_;
    std::vector<TimerEntry> timers_;
    std::vector<std::coroutine_handle<>> detached_;
    int wakePipe_[2] = {-1, -1};
    std::mutex postedMutex_;
    std::vector<std::coroutine_handle<>> posted_;
};

}  // namespace ets