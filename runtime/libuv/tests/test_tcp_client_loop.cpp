// Fase 4.2 — Validación end-to-end de TCP client con DNS sobre LibuvEventLoop.
//
// Combina uv_getaddrinfo + uv_tcp_connect + uv_read + uv_write usando
// ets::EventLoop (LibuvEventLoop backend), no uv_loop_t crudo.
//
// Valida 3 escenarios:
//   1. DNS async via uv_getaddrinfo integrado en el loop.
//   2. TCP connect async a un listener raw pre-levantado.
//   3. Read+write bidireccional tras connect.

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

#include <uv.h>

#include "ets_event_loop.hpp"

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, label) do { if (cond) { ++g_passed; std::printf("  ok: %s\n", label); } \
                                  else { ++g_failed; std::printf("  FAIL: %s\n", label); } } while(0)

struct DnsCtx {
    ets::EventLoop* loop;
    bool resolved = false;
    addrinfo* result = nullptr;
};

static void on_dns(uv_getaddrinfo_t* req, int status, struct addrinfo* res) {
    auto* c = static_cast<DnsCtx*>(req->data);
    c->resolved = (status == 0 && res != nullptr);
    c->result = res;
    uv_async_send(c->loop->raw_wake());
}

struct ConnectCtx {
    bool done = false;
    int status = -1;
};

static void on_connect(uv_connect_t* req, int status) {
    auto* c = static_cast<ConnectCtx*>(req->data);
    c->status = status;
    c->done = true;
}

void test_1_dns_on_libuv_loop() {
    std::printf("test 1: DNS async sobre LibuvEventLoop\n");
    ets::EventLoop loop;
    DnsCtx ctx{&loop};
    uv_getaddrinfo_t req;
    req.data = &ctx;

    struct addrinfo hints;
    std::memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    int r = uv_getaddrinfo(loop.raw_loop(), &req, on_dns,
                            "localhost", nullptr, &hints);
    CHECK(r == 0, "uv_getaddrinfo retorno 0");

    int safety = 0;
    while (!ctx.resolved && safety++ < 1000) {
        loop.runOne();
    }
    CHECK(ctx.resolved, "DNS resolved");
    if (ctx.result) {
        CHECK(ctx.result->ai_family == AF_INET, "addrinfo es AF_INET");
        CHECK(ctx.result->ai_socktype == SOCK_STREAM, "addrinfo es SOCK_STREAM");
        uv_freeaddrinfo(ctx.result);
    }
}

void test_2_connect_on_libuv_loop() {
    std::printf("test 2: TCP connect async sobre LibuvEventLoop\n");
    // Listener raw.
    int raw = ::socket(AF_INET, SOCK_STREAM, 0);
    int reuse = 1;
    ::setsockopt(raw, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = 0;
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    ::bind(raw, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    ::listen(raw, 128);
    sockaddr_storage actual;
    socklen_t len = sizeof(actual);
    ::getsockname(raw, reinterpret_cast<sockaddr*>(&actual), &len);
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);

    ets::EventLoop loop;
    uv_tcp_t client;
    uv_tcp_init(loop.raw_loop(), &client);

    sockaddr_in dest;
    dest.sin_family = AF_INET;
    dest.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &dest.sin_addr);

    uv_connect_t conn_req;
    ConnectCtx cctx;
    conn_req.data = &cctx;
    int r = uv_tcp_connect(&conn_req, &client,
                            reinterpret_cast<sockaddr*>(&dest), on_connect);
    CHECK(r == 0, "uv_tcp_connect retorno 0");

    int safety = 0;
    while (!cctx.done && safety++ < 1000) {
        loop.runOne();
    }
    CHECK(cctx.done, "connect callback fue llamado");
    CHECK(cctx.status == 0, "connect status == 0 (exito)");

    uv_close(reinterpret_cast<uv_handle_t*>(&client), nullptr);
    ::close(raw);
    int safety2 = 0;
    while (loop.raw_loop()->active_handles > 0 && safety2++ < 100) {
        loop.runOne();
    }
}

void test_3_bidir_comm() {
    std::printf("test 3: read+write bidireccional via LibuvEventLoop\n");
    // Listener raw que lee "ping" y responde "pong".
    int raw = ::socket(AF_INET, SOCK_STREAM, 0);
    int reuse = 1;
    ::setsockopt(raw, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = 0;
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    ::bind(raw, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    ::listen(raw, 128);
    sockaddr_storage actual;
    socklen_t len = sizeof(actual);
    ::getsockname(raw, reinterpret_cast<sockaddr*>(&actual), &len);
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);

    // Hilo que acepta y responde.
    std::thread([raw]{
        int server = ::accept(raw, nullptr, nullptr);
        char buf[64] = {0};
        ssize_t n = ::recv(server, buf, sizeof(buf) - 1, 0);
        if (n > 0 && std::string(buf).substr(0, 4) == "ping") {
            ::send(server, "pong", 4, 0);
        }
        ::close(server);
    }).detach();

    ets::EventLoop loop;
    uv_tcp_t client;
    uv_tcp_init(loop.raw_loop(), &client);

    sockaddr_in dest;
    dest.sin_family = AF_INET;
    dest.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &dest.sin_addr);

    uv_connect_t conn_req;
    ConnectCtx cctx;
    conn_req.data = &cctx;
    uv_tcp_connect(&conn_req, &client,
                    reinterpret_cast<sockaddr*>(&dest), on_connect);

    int safety = 0;
    while (!cctx.done && safety++ < 1000) loop.runOne();
    CHECK(cctx.done, "connect completed");
    CHECK(cctx.status == 0, "connect status == 0");

    if (cctx.status == 0) {
        // Enviar "ping" via uv_write.
        uv_write_t wr;
        const char* msg = "ping";
        uv_buf_t buf = uv_buf_init(const_cast<char*>(msg), 4);
        uv_write(&wr, reinterpret_cast<uv_stream_t*>(&client), &buf, 1, nullptr);

        // Leer respuesta.
        char rx[64] = {0};
        ssize_t total = 0;
        int safety2 = 0;
        uv_os_fd_t fd;
        uv_fileno(reinterpret_cast<uv_handle_t*>(&client), &fd);
        while (total < 4 && safety2++ < 100) {
            loop.runOne();
            ssize_t n = ::recv(fd, &rx[total], sizeof(rx) - total, 0);
            if (n > 0) total += n;
        }
        CHECK(total == 4, "recibi 4 bytes del servidor");
        CHECK(std::memcmp(rx, "pong", 4) == 0, "contenido == pong");
    }

    uv_close(reinterpret_cast<uv_handle_t*>(&client), nullptr);
    ::close(raw);
    int safety3 = 0;
    while (loop.raw_loop()->active_handles > 0 && safety3++ < 100) {
        loop.runOne();
    }
}

int main() {
    test_1_dns_on_libuv_loop();
    test_2_connect_on_libuv_loop();
    test_3_bidir_comm();
    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}