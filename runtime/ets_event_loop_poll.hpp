// Backend poll del EventLoop.
//
// Esta es la implementación histórica del EventLoop de Ts2cpp, basada
// en ::poll(2) + self-pipe para wake. Se conserva como backend
// "ETS_EVENT_BACKEND=poll" para no romper programas que dependan de
// su comportamiento exacto.
//
// NO incluir directamente. Usar runtime/ets_event_loop.hpp.

#pragma once

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <coroutine>
#include <cstdio>
#include <fcntl.h>
#include <mutex>
#include <poll.h>
#include <unistd.h>
#include <vector>

#include "ets_event_loop_iface.hpp"

namespace ets {

class PollEventLoop final : public IEventLoop {
public:
    PollEventLoop() {
        if (::pipe(wakePipe_) != 0) std::abort();
        for (int fd : wakePipe_) {
            const int flags = ::fcntl(fd, F_GETFL, 0);
            if (flags < 0 || ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) std::abort();
        }
    }
    PollEventLoop(const PollEventLoop&) = delete;
    PollEventLoop& operator=(const PollEventLoop&) = delete;
    ~PollEventLoop() override { ::close(wakePipe_[0]); ::close(wakePipe_[1]); }

    void waitFor(int fd, short events, std::coroutine_handle<> handle) override {
        io_.push_back({fd, events, handle, std::chrono::steady_clock::time_point::max(), {}, nullptr});
    }
    void waitForUntil(int fd, short events, std::chrono::steady_clock::time_point deadline, CancellationToken token, WaitResult* result, std::coroutine_handle<> handle) override {
        io_.push_back({fd, events, handle, deadline, std::move(token), result});
    }
    void waitUntil(std::chrono::steady_clock::time_point deadline, std::coroutine_handle<> handle) override {
        timers_.push_back({deadline, handle});
    }
    void detach(std::coroutine_handle<> handle) override { detached_.push_back(handle); }
    void post(std::coroutine_handle<> handle) override {
        {
            std::lock_guard lock(postedMutex_);
            posted_.push_back(handle);
        }
        writeWake();
    }
    void notify() noexcept override { writeWake(); }

    void runOne() override {
        std::vector<pollfd> descriptors;
        descriptors.reserve(io_.size() + 1);
        descriptors.push_back({wakePipe_[0], POLLIN, 0});
        for (const auto& wait : io_) descriptors.push_back({wait.fd, wait.events, 0});
        int timeout = -1;
        if (!timers_.empty()) {
            const auto now = std::chrono::steady_clock::now();
            const auto next = std::min_element(timers_.begin(), timers_.end(), [](const TimerEntry& a, const TimerEntry& b) { return a.deadline < b.deadline; })->deadline;
            timeout = next <= now ? 0 : static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(next - now).count());
        }
        for (const auto& wait : io_) {
            if (wait.deadline == std::chrono::steady_clock::time_point::max()) continue;
            const auto now = std::chrono::steady_clock::now();
            const int remaining = wait.deadline <= now ? 0 : static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(wait.deadline - now).count());
            if (timeout < 0 || remaining < timeout) timeout = remaining;
        }
        const int readyCount = ::poll(descriptors.data(), descriptors.size(), timeout);
        std::vector<std::coroutine_handle<>> ready;
        if (readyCount > 0) {
            if (descriptors[0].revents != 0) {
                unsigned char buffer[64];
                while (::read(wakePipe_[0], buffer, sizeof(buffer)) > 0) {}
                std::lock_guard lock(postedMutex_);
                ready.insert(ready.end(), posted_.begin(), posted_.end());
                posted_.clear();
            }
        }
        const auto now = std::chrono::steady_clock::now();
        for (std::size_t index = io_.size(); index > 0; --index) {
            auto& wait = io_[index - 1];
            const bool descriptorReady = descriptors[index].revents != 0;
            const bool cancelled = wait.token.isCancelled();
            const bool timedOut = wait.deadline != std::chrono::steady_clock::time_point::max() && wait.deadline <= now;
            if (!descriptorReady && !cancelled && !timedOut) continue;
            if (wait.result) *wait.result = cancelled ? WaitResult::cancelled : timedOut && !descriptorReady ? WaitResult::timedOut : WaitResult::ready;
            ready.push_back(wait.handle);
            io_.erase(io_.begin() + static_cast<std::ptrdiff_t>(index - 1));
        }
        for (std::size_t index = timers_.size(); index > 0; --index) {
            if (timers_[index - 1].deadline <= now) {
                ready.push_back(timers_[index - 1].handle);
                timers_.erase(timers_.begin() + static_cast<std::ptrdiff_t>(index - 1));
            }
        }
        for (auto handle : ready) if (handle && !handle.done()) handle.resume();
        for (std::size_t index = detached_.size(); index > 0; --index) {
            if (detached_[index - 1].done()) {
                detached_[index - 1].destroy();
                detached_.erase(detached_.begin() + static_cast<std::ptrdiff_t>(index - 1));
            }
        }
    }

private:
    void writeWake() noexcept {
        const unsigned char signal = 1;
        ssize_t ignored = -1;
        while (ignored < 0 && errno == EINTR) {
            ignored = ::write(wakePipe_[1], static_cast<const void*>(&signal), sizeof(signal));
        }
        (void)ignored;
    }

    struct IoWait { int fd; short events; std::coroutine_handle<> handle; std::chrono::steady_clock::time_point deadline; CancellationToken token; WaitResult* result; };
    struct TimerEntry { std::chrono::steady_clock::time_point deadline; std::coroutine_handle<> handle; };
    std::vector<IoWait> io_;
    std::vector<TimerEntry> timers_;
    std::vector<std::coroutine_handle<>> detached_;
    int wakePipe_[2] = {-1, -1};
    std::mutex postedMutex_;
    std::vector<std::coroutine_handle<>> posted_;
};

}  // namespace ets
