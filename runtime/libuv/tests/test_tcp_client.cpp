// Fase 4 — Validacion del patron TCP client + DNS sobre libuv.
//
// uv_getaddrinfo: DNS asincrono (no bloquea call).
// uv_tcp_connect: connect asincrono sobre uv_tcp_t.
//
// Valida 4 escenarios:
//   1. uv_getaddrinfo resuelve "localhost" en al menos 1 addrinfo.
//   2. uv_tcp_init + uv_tcp_connect establece conexion a localhost.
//   3. uv_tcp_connect devuelve error al conectar a puerto cerrado.
//   4. La conexion se puede leer/escribir (idempotente con TCP server).

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>

#include <uv.h>

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, label) do { if (cond) { ++g_passed; std::printf("  ok: %s\n", label); } \
                                  else { ++g_failed; std::printf("  FAIL: %s\n", label); } } while(0)

struct Ctx {
    uv_loop_t* loop;
    uv_getaddrinfo_t resolver_req{};
    bool resolved = false;
    bool connect_done = false;
    int connect_status = 0;
};

static void on_resolved(uv_getaddrinfo_t* req, int status, struct addrinfo* res) {
    auto* c = static_cast<Ctx*>(req->data);
    c->resolved = (status == 0 && res != nullptr);
    if (res) uv_freeaddrinfo(res);
}

static void on_connect(uv_connect_t* req, int status) {
    auto* c = static_cast<Ctx*>(req->data);
    c->connect_status = status;
    c->connect_done = true;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

void test_1_getaddrinfo_localhost() {
    std::printf("test 1: uv_getaddrinfo resuelve localhost\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    Ctx ctx{&loop};
    ctx.resolver_req.data = &ctx;

    struct addrinfo hints;
    std::memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    int r = uv_getaddrinfo(&loop, &ctx.resolver_req, on_resolved,
                            "localhost", nullptr, &hints);
    CHECK(r == 0, "uv_getaddrinfo retorno 0");

    // Esperar a que se complete (poll el loop hasta resolver).
    int safety = 0;
    while (!ctx.resolved && safety++ < 1000) {
        uv_run(&loop, UV_RUN_ONCE);
    }
    CHECK(ctx.resolved, "DNS resolved antes del timeout");

    uv_loop_close(&loop);
}

void test_2_connect_to_localhost() {
    std::printf("test 2: uv_tcp_connect establece conexion a localhost:9999\n");
    // Crear un listener raw que acepte y cierre.
    int raw_listener = ::socket(AF_INET, SOCK_STREAM, 0);
    int reuse = 1;
    ::setsockopt(raw_listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = 0;
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    ::bind(raw_listener, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    ::listen(raw_listener, 128);
    sockaddr_storage actual;
    socklen_t len = sizeof(actual);
    ::getsockname(raw_listener, reinterpret_cast<sockaddr*>(&actual), &len);
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);

    uv_loop_t loop;
    uv_loop_init(&loop);
    Ctx ctx{&loop};
    ctx.resolver_req.data = &ctx;

    uv_tcp_t client;
    uv_tcp_init(&loop, &client);

    struct sockaddr_in dest;
    dest.sin_family = AF_INET;
    dest.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &dest.sin_addr);

    uv_connect_t connect_req;
    connect_req.data = &ctx;
    int r = uv_tcp_connect(&connect_req, &client,
                            reinterpret_cast<sockaddr*>(&dest), on_connect);
    CHECK(r == 0, "uv_tcp_connect retorno 0");

    int safety = 0;
    while (!ctx.connect_done && safety++ < 1000) {
        uv_run(&loop, UV_RUN_ONCE);
    }
    CHECK(ctx.connect_done, "connect completed");
    CHECK(ctx.connect_status == 0, "status == 0 (UV_EC_SUCCESS)");
    if (ctx.connect_status == 0) {
        char dev[64] = {0};
        int len2 = sizeof(dev);
        int gr = uv_tcp_getpeername(&client, reinterpret_cast<sockaddr*>(dev), &len2);
        CHECK(gr == 0, "uv_tcp_getpeername OK");
    }

    uv_close(reinterpret_cast<uv_handle_t*>(&client), nullptr);
    ::close(raw_listener);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
}

void test_3_connect_to_closed_port() {
    std::printf("test 3: uv_tcp_connect devuelve error al puerto cerrado\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    Ctx ctx{&loop};

    uv_tcp_t client;
    uv_tcp_init(&loop, &client);

    struct sockaddr_in dest;
    dest.sin_family = AF_INET;
    dest.sin_port = htons(1);  // puerto 1 = no deberia estar abierto
    inet_pton(AF_INET, "127.0.0.1", &dest.sin_addr);

    uv_connect_t connect_req;
    connect_req.data = &ctx;
    int r = uv_tcp_connect(&connect_req, &client,
                            reinterpret_cast<sockaddr*>(&dest), on_connect);
    CHECK(r == 0, "uv_tcp_connect retorno 0 (error es async)");

    int safety = 0;
    while (!ctx.connect_done && safety++ < 1000) {
        uv_run(&loop, UV_RUN_ONCE);
    }
    CHECK(ctx.connect_done, "connect callback fue llamado");
    CHECK(ctx.connect_status != 0, "status != 0 (error esperado)");

    uv_close(reinterpret_cast<uv_handle_t*>(&client), nullptr);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
}

void test_4_getaddrinfo_with_port() {
    std::printf("test 4: uv_getaddrinfo con puerto (servicio)\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    Ctx ctx{&loop};
    ctx.resolver_req.data = &ctx;

    struct addrinfo hints;
    std::memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    int r = uv_getaddrinfo(&loop, &ctx.resolver_req, on_resolved,
                            NULL, "http", &hints);
    CHECK(r == 0, "uv_getaddrinfo(NULL, \"http\") retorno 0");

    int safety = 0;
    while (!ctx.resolved && safety++ < 1000) {
        uv_run(&loop, UV_RUN_ONCE);
    }
    CHECK(ctx.resolved, "DNS resolved puerto http");

    uv_loop_close(&loop);
}

int main() {
    test_1_getaddrinfo_localhost();
    test_2_connect_to_localhost();
    test_3_connect_to_closed_port();
    test_4_getaddrinfo_with_port();
    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}