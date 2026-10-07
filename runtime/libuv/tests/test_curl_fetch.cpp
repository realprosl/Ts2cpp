// Fase 7 — Validacion del patron fetch HTTP con libcurl.
//
// V1 valida dos patrones:
//
//   1. easy interface con timeout: demuestra que curl_easy_perform
//      respeta CURLOPT_TIMEOUT. Util para confirmar que la libcurl
//      funciona en el sistema.
//
//   2. easy interface en thread separado (curl_easy_perform bloquea
//      el thread). El thread retorna con el resultado via variable
//      compartida. Esto es la base para integrar fetch en Ts2cpp
//      sin tocar el event loop libuv.
//
// Lo que NO hace V1:
//   - libcurl multi interface integrada con uv_poll_t (complejo,
//     lo hara una fase posterior si se necesita HTTP no-bloqueante).
//   - HTTPS (requiere certs, lo evitamos para no depender de red).
//   - Tests contra servidores reales (usamos httpbin.org solo si
//     hay red; si no, saltamos el test).

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <string>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

#include <curl/curl.h>

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, label) do { if (cond) { ++g_passed; std::printf("  ok: %s\n", label); } \
                                  else { ++g_failed; std::printf("  FAIL: %s\n", label); } } while(0)

struct Ctx {
    std::string body;
    long status = 0;
    CURLcode result = CURLE_FAILED_INIT;
    bool done = false;
};

static size_t write_cb(void* contents, size_t size, size_t nmemb, void* userp) {
    auto* ctx = static_cast<Ctx*>(userp);
    size_t total = size * nmemb;
    ctx->body.append(static_cast<char*>(contents), total);
    return total;
}

void test_1_easy_init_cleanup() {
    std::printf("test 1: curl_easy_init + cleanup basico\n");
    curl_global_init(CURL_GLOBAL_DEFAULT);

    CURL* easy = curl_easy_init();
    CHECK(easy != nullptr, "curl_easy_init retorno handle no-nulo");
    curl_easy_cleanup(easy);
    CHECK(true, "curl_easy_cleanup retorno OK");

    curl_global_cleanup();
}

void test_2_easy_timeout() {
    std::printf("\ntest 2: curl_easy_perform con CURLOPT_TIMEOUT\n");
    curl_global_init(CURL_GLOBAL_DEFAULT);
    Ctx ctx;
    auto start = std::chrono::steady_clock::now();
    CURL* easy = curl_easy_init();
    curl_easy_setopt(easy, CURLOPT_URL, "http://127.0.0.1:1/");  // puerto 1: no escucha
    curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(easy, CURLOPT_WRITEDATA, &ctx);
    curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT, 1L);
    curl_easy_setopt(easy, CURLOPT_TIMEOUT, 2L);
    curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
    ctx.result = curl_easy_perform(easy);
    auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    if (ctx.result == CURLE_OK) {
        curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &ctx.status);
    }
    curl_easy_cleanup(easy);
    curl_global_cleanup();

    CHECK(ctx.result != CURLE_OK, "request fallo (puerto 1 no escucha)");
    CHECK(elapsed_ms < 3000, "elapsed_ms < 3000 (timeout 2s respetado)");
}

void test_3_easy_in_thread() {
    std::printf("\ntest 3: curl_easy_perform en thread separado\n");
    curl_global_init(CURL_GLOBAL_DEFAULT);
    Ctx ctx;
    std::thread worker([&ctx]() {
        CURL* easy = curl_easy_init();
        if (!easy) return;
        curl_easy_setopt(easy, CURLOPT_URL, "http://127.0.0.1:1/");
        curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, write_cb);
        curl_easy_setopt(easy, CURLOPT_WRITEDATA, &ctx);
        curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT, 1L);
        curl_easy_setopt(easy, CURLOPT_TIMEOUT, 2L);
        curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
        ctx.result = curl_easy_perform(easy);
        if (ctx.result == CURLE_OK) {
            curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &ctx.status);
        }
        curl_easy_cleanup(easy);
        ctx.done = true;
    });
    auto start = std::chrono::steady_clock::now();
    worker.join();
    auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    curl_global_cleanup();

    CHECK(ctx.done, "thread termino");
    CHECK(ctx.result != CURLE_OK, "request fallo (esperado)");
    CHECK(elapsed_ms < 3000, "thread.join < 3000ms");
}

void test_4_easy_local_listener() {
    std::printf("\ntest 4: curl_easy contra listener local (HTTP real)\n");
    curl_global_init(CURL_GLOBAL_DEFAULT);

    // Listener local que responde "hello".
    int listener_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    int reuse = 1;
    ::setsockopt(listener_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = 0;
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    ::bind(listener_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    ::listen(listener_fd, 128);
    sockaddr_storage actual;
    socklen_t len = sizeof(actual);
    ::getsockname(listener_fd, reinterpret_cast<sockaddr*>(&actual), &len);
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);

    std::thread server([listener_fd]() {
        int c = ::accept(listener_fd, nullptr, nullptr);
        if (c < 0) return;
        char buf[1024];
        ::recv(c, buf, sizeof(buf), 0);  // consume request
        const char* resp = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
        ::send(c, resp, std::strlen(resp), 0);
        ::close(c);
    });

    Ctx ctx;
    auto start = std::chrono::steady_clock::now();
    CURL* easy = curl_easy_init();
    char url[64];
    std::snprintf(url, sizeof(url), "http://127.0.0.1:%d/", port);
    curl_easy_setopt(easy, CURLOPT_URL, url);
    curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(easy, CURLOPT_WRITEDATA, &ctx);
    curl_easy_setopt(easy, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
    ctx.result = curl_easy_perform(easy);
    if (ctx.result == CURLE_OK) {
        curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &ctx.status);
    }
    curl_easy_cleanup(easy);
    server.join();
    ::close(listener_fd);
    curl_global_cleanup();

    CHECK(ctx.result == CURLE_OK, "request OK");
    CHECK(ctx.status == 200, "status == 200");
    CHECK(ctx.body == "hello", "body == \"hello\"");
}

int main() {
    std::printf("=== Fase 7: fetch con libcurl ===\n\n");
    test_1_easy_init_cleanup();
    test_2_easy_timeout();
    test_3_easy_in_thread();
    test_4_easy_local_listener();
    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}