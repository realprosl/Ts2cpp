// Fase 2B.5 — Test de integración del backend libuv en ets::EventLoop.
//
// Compila con -DETS_EVENT_BACKEND_LIBUV y enlaza contra libuv.
// Verifica que el alias ets::EventLoop resuelve a LibuvEventLoop
// y que la API publica funciona correctamente con corutinas C++20.
//
// Valida 6 escenarios:
//   1. static_assert que el alias resuelve a LibuvEventLoop.
//   2. runOne sin handles retorna inmediatamente (no bloquea).
//   3. waitUntil dispara una corutina tras su deadline.
//   4. post() ejecuta una corutina en la proxima iteracion.
//   5. waitFor dispara cuando el fd esta listo.
//   6. cancel() interrumpe waitForUntil sin esperar el deadline.

#include <atomic>
#include <chrono>
#include <coroutine>
#include <cstdio>
#include <thread>
#include <type_traits>
#include <unistd.h>

#include "ets_event_loop.hpp"

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, label) do { if (cond) { ++g_passed; std::printf("  ok: %s\n", label); } \
                                  else { ++g_failed; std::printf("  FAIL: %s\n", label); } } while(0)

struct Task {
    struct promise_type {
        std::coroutine_handle<promise_type> handle;
        Task get_return_object() { return Task{handle = std::coroutine_handle<promise_type>::from_promise(*this)}; }
        std::suspend_always initial_suspend() { return {}; }
        std::suspend_never final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };
    std::coroutine_handle<promise_type> handle;
};

struct WaitUntilAwaiter {
    ets::EventLoop* loop;
    std::chrono::steady_clock::time_point deadline;
    bool await_ready() noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) noexcept {
        loop->waitUntil(deadline, h);
    }
    void await_resume() noexcept {}
};

Task test_3_waitUntil(ets::EventLoop& loop, std::atomic<int>& counter) {
    co_await WaitUntilAwaiter{&loop, std::chrono::steady_clock::now() + std::chrono::milliseconds(20)};
    counter.fetch_add(1);
}

struct PostAwaiter {
    ets::EventLoop* loop;
    bool await_ready() noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) noexcept {
        loop->post(h);
    }
    void await_resume() noexcept {}
};

Task test_4_post(ets::EventLoop& loop, std::atomic<int>& counter) {
    counter.fetch_add(10);
    co_await PostAwaiter{&loop};
    counter.fetch_add(1);
}

struct WaitForAwaiter {
    ets::EventLoop* loop;
    int fd;
    short events;
    bool await_ready() noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) noexcept {
        loop->waitFor(fd, events, h);
    }
    void await_resume() noexcept {}
};

Task test_5_waitFor(ets::EventLoop& loop, int fd, std::atomic<int>& counter) {
    co_await WaitForAwaiter{&loop, fd, 1};
    counter.fetch_add(1);
}

struct WaitForUntilAwaiter {
    ets::EventLoop* loop;
    int fd;
    short events;
    ets::CancellationToken token;
    ets::WaitResult* result;
    std::chrono::steady_clock::time_point deadline;
    bool await_ready() noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) noexcept {
        loop->waitForUntil(fd, events, deadline, token, result, h);
    }
    void await_resume() noexcept {}
};

Task test_6_cancel(ets::EventLoop& loop, int fd, ets::CancellationSource& cs, ets::WaitResult* result, std::atomic<int>& counter) {
    co_await WaitForUntilAwaiter{&loop, fd, 1, cs.token(), result,
        std::chrono::steady_clock::now() + std::chrono::seconds(5)};
    counter.fetch_add(1);
}

int main() {
    std::printf("test 1: alias resolution\n");
    static_assert(std::is_same_v<ets::EventLoop, ets::LibuvEventLoop>, "debe ser LibuvEventLoop");
    CHECK(true, "static_assert pasa");

    std::printf("test 2: runOne sin handles retorna rapido\n");
    {
        ets::EventLoop loop;
        auto start = std::chrono::steady_clock::now();
        loop.runOne();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start).count();
        CHECK(elapsed < 100, "runOne retorna < 100ms sin handles");
    }

    std::printf("test 3: waitUntil dispara corutina tras deadline\n");
    {
        std::atomic<int> counter{0};
        ets::EventLoop loop;
        test_3_waitUntil(loop, counter).handle.resume();
        CHECK(counter.load() == 0, "corutina suspendida en waitUntil");
        auto start = std::chrono::steady_clock::now();
        loop.runOne();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start).count();
        CHECK(elapsed >= 10, "runOne espero al deadline (~20ms)");
        CHECK(elapsed < 200, "runOne no espero de mas");
        CHECK(counter.load() == 1, "corutina reanuda tras deadline");
    }

    std::printf("test 4: post() ejecuta corutina\n");
    {
        std::atomic<int> counter{0};
        ets::EventLoop loop;
        test_4_post(loop, counter).handle.resume();
        CHECK(counter.load() == 10, "cuerpo de la corutina ejecuto pre-await");
        loop.runOne();
        CHECK(counter.load() == 11, "post() reanudo la corutina");
    }

    std::printf("test 5: waitFor dispara cuando fd listo\n");
    {
        int fds[2];
        if (pipe(fds) != 0) { std::printf("pipe failed\n"); return 1; }
        std::atomic<int> counter{0};
        ets::EventLoop loop;
        test_5_waitFor(loop, fds[0], counter).handle.resume();
        char b = 'x';
        ssize_t n = write(fds[1], &b, 1);
        (void)n;
        loop.runOne();
        CHECK(counter.load() == 1, "waitFor reanudo cuando fd listo");
        close(fds[0]); close(fds[1]);
    }

    std::printf("test 6: cancel() interrumpe waitForUntil\n");
    {
        int fds[2];
        if (pipe(fds) != 0) { std::printf("pipe failed\n"); return 1; }
        std::atomic<int> counter{0};
        ets::WaitResult result = ets::WaitResult::ready;
        ets::CancellationSource cs;
        ets::EventLoop loop;
        test_6_cancel(loop, fds[0], cs, &result, counter).handle.resume();
        std::thread([&cs, &loop]{
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            cs.cancel();
            loop.notify();
        }).detach();
        auto start = std::chrono::steady_clock::now();
        loop.runOne();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start).count();
        CHECK(counter.load() == 1, "cancel() reanudo la corutina");
        CHECK(result == ets::WaitResult::cancelled, "WaitResult = cancelled");
        CHECK(elapsed < 500, "no espero 5s del deadline (elapsed<500ms)");
        close(fds[0]); close(fds[1]);
    }

    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}