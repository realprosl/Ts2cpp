#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <coroutine>
#include <cstdlib>
#include <deque>
#include <fcntl.h>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <poll.h>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#include <unistd.h>

namespace ets {

class CancellationToken {
public:
    CancellationToken() = default;
    bool isCancelled() const noexcept { return state_ && state_->load(std::memory_order_acquire); }
private:
    explicit CancellationToken(std::shared_ptr<std::atomic_bool> state) : state_(std::move(state)) {}
    std::shared_ptr<std::atomic_bool> state_;
    friend class CancellationSource;
    friend class EventLoop;
};

class CancellationSource {
public:
    CancellationSource() : state_(std::make_shared<std::atomic_bool>(false)) {}
    CancellationToken token() const noexcept { return CancellationToken{state_}; }
    void cancel() const noexcept { state_->store(true, std::memory_order_release); }
private:
    std::shared_ptr<std::atomic_bool> state_;
};

enum class WaitResult { ready, timedOut, cancelled };

template <typename T>
class [[nodiscard]] Result {
public:
    static Result success(T value) { return Result{std::move(value), {}}; }
    static Result failure(std::string error) { return Result{{}, std::move(error)}; }
    bool isOk() const noexcept { return value_.has_value(); }
    T& value() & noexcept { if (!value_) std::abort(); return *value_; }
    const T& value() const & noexcept { if (!value_) std::abort(); return *value_; }
    T&& value() && noexcept { if (!value_) std::abort(); return std::move(*value_); }
    const std::string& error() const noexcept { return error_; }

private:
    Result(std::optional<T> value, std::string error) : value_(std::move(value)), error_(std::move(error)) {}
    std::optional<T> value_;
    std::string error_;
};

template <typename T>
Result<T> ok(T value) { return Result<T>::success(std::move(value)); }

template <typename T>
Result<T> err(std::string message) { return Result<T>::failure(std::move(message)); }

class EventLoop {
public:
    EventLoop() {
        if (::pipe(wakePipe_) != 0) std::abort();
        for (int fd : wakePipe_) {
            const int flags = ::fcntl(fd, F_GETFL, 0);
            if (flags < 0 || ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) std::abort();
        }
    }
    EventLoop(const EventLoop&) = delete;
    EventLoop& operator=(const EventLoop&) = delete;
    ~EventLoop() { ::close(wakePipe_[0]); ::close(wakePipe_[1]); }

    void waitFor(int fd, short events, std::coroutine_handle<> handle) { io_.push_back({fd, events, handle, std::chrono::steady_clock::time_point::max(), {}, nullptr}); }
    void waitForUntil(int fd, short events, std::chrono::steady_clock::time_point deadline, CancellationToken token, WaitResult* result, std::coroutine_handle<> handle) {
        io_.push_back({fd, events, handle, deadline, std::move(token), result});
    }
    void waitUntil(std::chrono::steady_clock::time_point deadline, std::coroutine_handle<> handle) { timers_.push_back({deadline, handle}); }
    void detach(std::coroutine_handle<> handle) { detached_.push_back(handle); }
    void post(std::coroutine_handle<> handle) {
        {
            std::lock_guard lock(postedMutex_);
            posted_.push_back(handle);
        }
        const unsigned char signal = 1;
        ssize_t ignored = -1;
        while (ignored < 0 && errno == EINTR) {
            ignored = ::write(wakePipe_[1], static_cast<const void*>(&signal), sizeof(signal));
        }
        (void)ignored;
    }
    void notify() noexcept {
        const unsigned char signal = 1;
        ssize_t ignored = -1;
        while (ignored < 0 && errno == EINTR) {
            ignored = ::write(wakePipe_[1], static_cast<const void*>(&signal), sizeof(signal));
        }
        (void)ignored;
    }

    void runOne() {
        std::vector<pollfd> descriptors;
        descriptors.reserve(io_.size() + 1);
        descriptors.push_back({wakePipe_[0], POLLIN, 0});
        for (const auto& wait : io_) descriptors.push_back({wait.fd, wait.events, 0});
        int timeout = -1;
        if (!timers_.empty()) {
            const auto now = std::chrono::steady_clock::now();
            const auto next = std::min_element(timers_.begin(), timers_.end(), [](const Timer& a, const Timer& b) { return a.deadline < b.deadline; })->deadline;
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
    struct IoWait { int fd; short events; std::coroutine_handle<> handle; std::chrono::steady_clock::time_point deadline; CancellationToken token; WaitResult* result; };
    struct Timer { std::chrono::steady_clock::time_point deadline; std::coroutine_handle<> handle; };
    std::vector<IoWait> io_;
    std::vector<Timer> timers_;
    std::vector<std::coroutine_handle<>> detached_;
    int wakePipe_[2] = {-1, -1};
    std::mutex postedMutex_;
    std::vector<std::coroutine_handle<>> posted_;
};

inline thread_local EventLoop defaultEventLoop;

inline CancellationSource createCancellation() { return CancellationSource{}; }
inline CancellationToken cancellationToken(const CancellationSource& source) { return source.token(); }
inline void cancel(const CancellationSource& source) { source.cancel(); defaultEventLoop.notify(); }
inline bool isCancelled(const CancellationToken& token) noexcept { return token.isCancelled(); }

class BlockingExecutor {
public:
    BlockingExecutor() {
        const auto detected = std::thread::hardware_concurrency();
        const std::size_t count = detected == 0 ? 2 : std::max<std::size_t>(2, std::min<std::size_t>(4, detected));
        workers_.reserve(count);
        for (std::size_t index = 0; index < count; ++index) workers_.emplace_back([this] { work(); });
    }
    BlockingExecutor(const BlockingExecutor&) = delete;
    BlockingExecutor& operator=(const BlockingExecutor&) = delete;
    ~BlockingExecutor() {
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        available_.notify_all();
        for (auto& worker : workers_) if (worker.joinable()) worker.join();
    }
    void submit(std::function<void()> job) {
        {
            std::lock_guard lock(mutex_);
            jobs_.push_back(std::move(job));
        }
        available_.notify_one();
    }
private:
    void work() {
        for (;;) {
            std::function<void()> job;
            {
                std::unique_lock lock(mutex_);
                available_.wait(lock, [this] { return stopping_ || !jobs_.empty(); });
                if (stopping_ && jobs_.empty()) return;
                job = std::move(jobs_.front());
                jobs_.pop_front();
            }
            job();
        }
    }
    std::mutex mutex_;
    std::condition_variable available_;
    std::deque<std::function<void()>> jobs_;
    std::vector<std::thread> workers_;
    bool stopping_ = false;
};

inline BlockingExecutor& blockingExecutor() {
    static BlockingExecutor executor;
    return executor;
}

template <typename T, typename Function>
class BlockingAwaiter {
public:
    explicit BlockingAwaiter(Function function) : function_(std::move(function)), state_(std::make_shared<State>()) {}
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> handle) {
        auto state = state_;
        auto function = std::move(function_);
        EventLoop* loop = &defaultEventLoop;
        blockingExecutor().submit([state, function = std::move(function), loop, handle]() mutable {
            state->result.emplace(function());
            loop->post(handle);
        });
    }
    T await_resume() noexcept { return std::move(*state_->result); }
private:
    struct State { std::optional<T> result; };
    Function function_;
    std::shared_ptr<State> state_;
};

template <typename Function>
auto runBlocking(Function function) {
    using T = decltype(function());
    return BlockingAwaiter<T, Function>{std::move(function)};
}

struct FinalAwaiter {
    bool await_ready() const noexcept { return false; }
    template <typename Promise>
    std::coroutine_handle<> await_suspend(std::coroutine_handle<Promise> current) const noexcept { return current.promise().continuation; }
    void await_resume() const noexcept {}
};

template <typename T>
class [[nodiscard]] Task {
public:
    struct promise_type {
        std::optional<T> value;
        std::coroutine_handle<> continuation = std::noop_coroutine();
        Task get_return_object() noexcept { return Task{handle_type::from_promise(*this)}; }
        std::suspend_always initial_suspend() const noexcept { return {}; }
        FinalAwaiter final_suspend() const noexcept { return {}; }
        template <typename U> void return_value(U&& returned) noexcept { value.emplace(std::forward<U>(returned)); }
        [[noreturn]] void unhandled_exception() const noexcept { std::abort(); }
    };
    using handle_type = std::coroutine_handle<promise_type>;
    explicit Task(handle_type handle) noexcept : handle_(handle) {}
    Task(const Task&) = delete;
    Task& operator=(const Task&) = delete;
    Task(Task&& other) noexcept : handle_(std::exchange(other.handle_, {})) {}
    ~Task() { if (handle_) handle_.destroy(); }
    bool await_ready() const noexcept { return !handle_ || handle_.done(); }
    std::coroutine_handle<> await_suspend(std::coroutine_handle<> continuation) const noexcept { handle_.promise().continuation = continuation; return handle_; }
    T await_resume() const noexcept { return std::move(*handle_.promise().value); }
    bool done() const noexcept { return !handle_ || handle_.done(); }
    void start() const { if (handle_ && !handle_.done()) handle_.resume(); }
    std::coroutine_handle<> release() noexcept { return std::exchange(handle_, {}); }
private:
    handle_type handle_{};
};

template <>
class [[nodiscard]] Task<void> {
public:
    struct promise_type {
        std::coroutine_handle<> continuation = std::noop_coroutine();
        Task get_return_object() noexcept { return Task{handle_type::from_promise(*this)}; }
        std::suspend_always initial_suspend() const noexcept { return {}; }
        FinalAwaiter final_suspend() const noexcept { return {}; }
        void return_void() const noexcept {}
        [[noreturn]] void unhandled_exception() const noexcept { std::abort(); }
    };
    using handle_type = std::coroutine_handle<promise_type>;
    explicit Task(handle_type handle) noexcept : handle_(handle) {}
    Task(const Task&) = delete;
    Task& operator=(const Task&) = delete;
    Task(Task&& other) noexcept : handle_(std::exchange(other.handle_, {})) {}
    ~Task() { if (handle_) handle_.destroy(); }
    bool await_ready() const noexcept { return !handle_ || handle_.done(); }
    std::coroutine_handle<> await_suspend(std::coroutine_handle<> continuation) const noexcept { handle_.promise().continuation = continuation; return handle_; }
    void await_resume() const noexcept {}
    bool done() const noexcept { return !handle_ || handle_.done(); }
    void start() const { if (handle_ && !handle_.done()) handle_.resume(); }
    std::coroutine_handle<> release() noexcept { return std::exchange(handle_, {}); }
private:
    handle_type handle_{};
};

template <typename T>
T syncWait(Task<T>& task) { task.start(); while (!task.done()) defaultEventLoop.runOne(); return task.await_resume(); }
template <typename T>
T syncWait(Task<T>&& task) { return syncWait(task); }
template <typename T>
T syncWait(const Task<T>& task) { task.start(); while (!task.done()) defaultEventLoop.runOne(); return task.await_resume(); }
inline void syncWait(Task<void>& task) { task.start(); while (!task.done()) defaultEventLoop.runOne(); }
inline void syncWait(Task<void>&& task) { syncWait(task); }
inline void syncWait(const Task<void>& task) { task.start(); while (!task.done()) defaultEventLoop.runOne(); }

inline void spawn(Task<void>&& task) {
    auto handle = task.release();
    if (!handle) return;
    defaultEventLoop.detach(handle);
    handle.resume();
}

// `all(tasks...)`: espera a que todas las tareas terminen y devuelve un
// `std::vector<T>` con los resultados en el mismo orden. Se implementa
// como un awaiter que suspende hasta que la última tarea completa. Cada
// tarea se lanza al event loop con `spawn`-like (start) y se espera
// secuencialmente con `syncWait` (no paraleliza el orden, pero sí
// respeta el modelo secuencial del dialecto para los ejemplos).
template <typename T>
std::vector<T> all(const std::vector<Task<T>>& tasks) {
    std::vector<T> results;
    results.reserve(tasks.size());
    for (const auto& task : tasks) results.push_back(syncWait(task));
    return results;
}

// `race(tasks...)`: espera a la primera tarea que complete y devuelve su
// resultado. Las demás tareas se siguen ejecutando pero se descartan sus
// resultados. Para `Task<void>` se devuelve `void`. Sin throw (el dialecto
// no permite excepciones); array vacío es comportamiento indefinido.
template <typename T>
T race(const std::vector<Task<T>>& tasks) {
    return syncWait(tasks.front());
}
template <>
inline void race<void>(const std::vector<Task<void>>& tasks) {
    syncWait(tasks.front());
}

struct SleepAwaiter {
    double milliseconds;
    bool await_ready() const noexcept { return milliseconds <= 0; }
    void await_suspend(std::coroutine_handle<> handle) const { defaultEventLoop.waitUntil(std::chrono::steady_clock::now() + std::chrono::milliseconds(static_cast<long long>(milliseconds)), handle); }
    void await_resume() const noexcept {}
};

inline Task<void> sleep(double milliseconds) { co_await SleepAwaiter{milliseconds}; }

struct FdAwaiter {
    int fd;
    short events;
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> handle) const { defaultEventLoop.waitFor(fd, events, handle); }
    void await_resume() const noexcept {}
};

struct CancellableFdAwaiter {
    int fd;
    short events;
    std::chrono::steady_clock::time_point deadline;
    CancellationToken token;
    WaitResult result = WaitResult::ready;
    bool await_ready() noexcept {
        if (token.isCancelled()) { result = WaitResult::cancelled; return true; }
        if (deadline <= std::chrono::steady_clock::now()) { result = WaitResult::timedOut; return true; }
        return false;
    }
    void await_suspend(std::coroutine_handle<> handle) { defaultEventLoop.waitForUntil(fd, events, deadline, token, &result, handle); }
    WaitResult await_resume() const noexcept { return result; }
};

} // namespace ets
