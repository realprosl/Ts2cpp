// Test runtime: httpClientGetAsync contra un server local.
// Spawn un thread que arranca un cpp-httplib server en :18090,
// espera a que esté listo, y luego corre una coroutine que hace
// httpClientGetAsync("http://127.0.0.1:18090/") y verifica el resultado.
#include <cstdio>
#include <chrono>
#include <thread>
#include <atomic>
#include <string>
#include <coroutine>  // para coroutine_handle en BlockingAwaiter
#include "runtime/external/httplib/httplib.h"
#include "runtime/ets_http_curl_async.hpp"
#include "runtime/ets_async.hpp"
#include "runtime/ets_event_loop.hpp"
#include "runtime/ets_event_loop_libuv_api.hpp"

std::atomic<bool> ready{false};

int main() {
    // 1. Server local en thread separado.
    std::thread srv([&]() {
        httplib::Server s;
        s.Get("/", [](const httplib::Request&, httplib::Response& res) {
            res.set_content("hello-from-server", "text/plain");
        });
        s.Get("/json", [](const httplib::Request&, httplib::Response& res) {
            res.set_content("{\"a\":1}", "application/json");
        });
        ready.store(true);
        s.listen("127.0.0.1", 18090);
    });
    // Espera a que esté listo
    while (!ready.load()) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    std::this_thread::sleep_for(std::chrono::milliseconds(100));

    // 2. Coroutine que hace http.get asíncrono (lambda para evitar vexing parse).
    auto getTask = []() -> ets::Task<ets::Result<ets::HttpClientResponse>> {
        std::fprintf(stderr, "[coroutine] before await\n");
        auto r = co_await ets::httpClientGetAsync(std::string("http://127.0.0.1:18090/"));
        co_return r;
    };
    auto task = getTask();
    std::fprintf(stderr, "[main] syncWait\n");
    auto result = ets::syncWait(std::move(task));
    std::fprintf(stderr, "[main] syncWait returned\n");

    // 3. Verifica
    if (!result.isOk()) {
        std::fprintf(stderr, "FAIL: result is error: %s\n", result.error().c_str());
        srv.detach();
        return 1;
    }
    const auto& resp = result.value();
    std::fprintf(stderr, "[main] status=%d body=%s\n", resp.status_code(), resp.body_str().c_str());
    if (resp.status_code() != 200) {
        std::fprintf(stderr, "FAIL: status != 200\n");
        srv.detach();
        return 1;
    }
    if (resp.body_str() != "hello-from-server") {
        std::fprintf(stderr, "FAIL: body != 'hello-from-server'\n");
        srv.detach();
        return 1;
    }
    std::fprintf(stderr, "ok:async-get-basic\n");

    // 4. Test con /json
    auto getJsonTask = []() -> ets::Task<ets::Result<ets::HttpClientResponse>> {
        co_return co_await ets::httpClientGetAsync(std::string("http://127.0.0.1:18090/json"));
    };
    auto task2 = getJsonTask();
    auto r2 = ets::syncWait(std::move(task2));
    if (!r2.isOk() || r2.value().status_code() != 200 || r2.value().body_str() != "{\"a\":1}") {
        std::fprintf(stderr, "FAIL: json test\n");
        srv.detach();
        return 1;
    }
    auto ct = r2.value().header("Content-Type");
    std::fprintf(stderr, "[main] content-type=%s\n", ct.c_str());
    std::fprintf(stderr, "ok:async-get-json\n");

    // 5. Test de fallo: URL inválida
    auto getFailTask = []() -> ets::Task<ets::Result<ets::HttpClientResponse>> {
        co_return co_await ets::httpClientGetAsync(std::string("http://127.0.0.1:1/never"));
    };
    auto task3 = getFailTask();
    auto r3 = ets::syncWait(std::move(task3));
    if (r3.isOk()) {
        std::fprintf(stderr, "FAIL: expected error but got ok\n");
        srv.detach();
        return 1;
    }
    std::fprintf(stderr, "[main] error (expected): %s\n", r3.error().c_str());
    std::fprintf(stderr, "ok:async-get-fail\n");

    srv.detach();
    return 0;
}
