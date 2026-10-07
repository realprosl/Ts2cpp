// Fase 3 — Validación del patrón TCP server sobre libuv.
//
// Valida 4 escenarios:
//   1. uv_tcp_bind + uv_listen acepta conexiones entrantes.
//   2. uv_accept devuelve un client stream valido.
//   3. uv_read dispara cuando el cliente escribe.
//   4. uv_write envia datos al cliente.
//
// Test standalone, no se inyecta al codigo generado todavia.

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>
#include <unistd.h>

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include <uv.h>

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, label) do { if (cond) { ++g_passed; std::printf("  ok: %s\n", label); } \
                                  else { ++g_failed; std::printf("  FAIL: %s\n", label); } } while(0)

// ----------------------------------------------------------------------------
// Wrapper minimo de uv_tcp_t + uv_loop_t
// ----------------------------------------------------------------------------

struct Server {
    uv_loop_t* loop;
    uv_tcp_t handle{};
    std::atomic<bool> got_connection{false};
    std::atomic<int> bytes_received{0};

    Server(uv_loop_t* l) : loop(l) {
        uv_tcp_init(loop, &handle);
        handle.data = this;
    }
};

struct Client {
    uv_tcp_t handle{};
    std::atomic<int> bytes_received{0};
    char buffer[64] = {0};

    Client(uv_loop_t* loop) {
        uv_tcp_init(loop, &handle);
        handle.data = this;
    }
};

static void on_new_connection(uv_stream_t* server, int status) {
    if (status < 0) {
        std::printf("  connection error: %s\n", uv_strerror(status));
        return;
    }
    auto* srv = static_cast<Server*>(server->data);
    srv->got_connection = true;
}

static void on_client_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
    auto* c = static_cast<Client*>(stream->data);
    if (nread > 0) {
        c->bytes_received.fetch_add(static_cast<int>(nread));
        std::memcpy(c->buffer, buf->base, std::min(static_cast<size_t>(nread), sizeof(c->buffer) - 1));
    }
    // Si no error, no liberamos buf (es estatico en este test).
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

void test_1_bind_and_listen() {
    std::printf("test 1: uv_tcp_bind + uv_listen\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    Server srv(&loop);

    struct sockaddr_in addr;
    uv_ip4_addr("127.0.0.1", 0, &addr);  // puerto 0 = kernel elige
    int r = uv_tcp_bind(&srv.handle, reinterpret_cast<const sockaddr*>(&addr), 0);
    CHECK(r == 0, "uv_tcp_bind retorno 0");

    r = uv_listen(reinterpret_cast<uv_stream_t*>(&srv.handle), 128, on_new_connection);
    CHECK(r == 0, "uv_listen retorno 0");

    // Obtener el puerto que el kernel eligio.
    sockaddr_storage actual;
    int len = sizeof(actual);
    r = uv_tcp_getsockname(&srv.handle, reinterpret_cast<sockaddr*>(&actual), &len);
    CHECK(r == 0, "uv_tcp_getsockname retorno 0");
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);
    CHECK(port > 0, "kernel eligio un puerto valido");

    uv_close(reinterpret_cast<uv_handle_t*>(&srv.handle), nullptr);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
}

void test_2_accept_connection() {
    std::printf("test 2: accept connection from raw socket\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    Server srv(&loop);

    struct sockaddr_in addr;
    uv_ip4_addr("127.0.0.1", 0, &addr);
    uv_tcp_bind(&srv.handle, reinterpret_cast<const sockaddr*>(&addr), 0);
    uv_listen(reinterpret_cast<uv_stream_t*>(&srv.handle), 128, on_new_connection);

    sockaddr_storage actual;
    int len = sizeof(actual);
    uv_tcp_getsockname(&srv.handle, reinterpret_cast<sockaddr*>(&actual), &len);
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);

    // Conectar como cliente raw (no libuv).
    int raw = ::socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in client_addr;
    client_addr.sin_family = AF_INET;
    client_addr.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &client_addr.sin_addr);
    int rc2 = ::connect(raw, reinterpret_cast<sockaddr*>(&client_addr), sizeof(client_addr));
    CHECK(rc2 == 0, "raw connect retorno 0");

    // uv_run para que on_new_connection se dispare.
    uv_run(&loop, UV_RUN_ONCE);
    CHECK(srv.got_connection.load(), "on_new_connection se llamo");

    ::close(raw);
    uv_close(reinterpret_cast<uv_handle_t*>(&srv.handle), nullptr);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
}

void test_3_read_from_client() {
    std::printf("test 3: uv_read recibe datos del cliente\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    Server srv(&loop);

    struct sockaddr_in addr_in;
    uv_ip4_addr("127.0.0.1", 0, &addr_in);
    uv_tcp_bind(&srv.handle, reinterpret_cast<const sockaddr*>(&addr_in), 0);
    uv_listen(reinterpret_cast<uv_stream_t*>(&srv.handle), 128, on_new_connection);

    sockaddr_storage actual;
    int len = sizeof(actual);
    uv_tcp_getsockname(&srv.handle, reinterpret_cast<sockaddr*>(&actual), &len);
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);

    // Cliente raw.
    int raw = ::socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in client_addr;
    client_addr.sin_family = AF_INET;
    client_addr.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &client_addr.sin_addr);
    ::connect(raw, reinterpret_cast<sockaddr*>(&client_addr), sizeof(client_addr));

    // Esperar a que el server acepte.
    uv_run(&loop, UV_RUN_ONCE);
    CHECK(srv.got_connection.load(), "server acepto la conexion");

    // El server side client (aceptado). Lo creamos con uv_accept.
    Client client_side(&loop);
    int r = uv_accept(reinterpret_cast<uv_stream_t*>(&srv.handle),
                       reinterpret_cast<uv_stream_t*>(&client_side.handle));
    CHECK(r == 0, "uv_accept retorno 0");

    // Empezar a leer en el server side.
    uv_read_start(reinterpret_cast<uv_stream_t*>(&client_side.handle),
                  [](uv_handle_t*, size_t suggested, uv_buf_t* buf){
                      buf->base = new char[suggested];
                      buf->len = suggested;
                  },
                  on_client_read);

    // Cliente envia datos.
    const char* msg = "hola mundo";
    ssize_t n = ::send(raw, msg, std::strlen(msg), 0);
    CHECK(n == static_cast<ssize_t>(std::strlen(msg)), "cliente envio los bytes");

    // uv_run para que on_client_read se dispare.
    uv_run(&loop, UV_RUN_ONCE);
    CHECK(client_side.bytes_received.load() == static_cast<int>(std::strlen(msg)),
          "server recibio los bytes correctos");
    CHECK(std::memcmp(client_side.buffer, msg, std::strlen(msg)) == 0,
          "contenido del buffer correcto");

    uv_close(reinterpret_cast<uv_handle_t*>(&client_side.handle), nullptr);
    uv_close(reinterpret_cast<uv_handle_t*>(&srv.handle), nullptr);
    ::close(raw);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
}

void test_4_write_to_client() {
    std::printf("test 4: uv_write envia datos al cliente\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    Server srv(&loop);

    struct sockaddr_in addr_in;
    uv_ip4_addr("127.0.0.1", 0, &addr_in);
    uv_tcp_bind(&srv.handle, reinterpret_cast<const sockaddr*>(&addr_in), 0);
    uv_listen(reinterpret_cast<uv_stream_t*>(&srv.handle), 128, on_new_connection);

    sockaddr_storage actual;
    int len = sizeof(actual);
    uv_tcp_getsockname(&srv.handle, reinterpret_cast<sockaddr*>(&actual), &len);
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);

    int raw = ::socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in client_addr;
    client_addr.sin_family = AF_INET;
    client_addr.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &client_addr.sin_addr);
    ::connect(raw, reinterpret_cast<sockaddr*>(&client_addr), sizeof(client_addr));

    uv_run(&loop, UV_RUN_ONCE);

    Client client_side(&loop);
    uv_accept(reinterpret_cast<uv_stream_t*>(&srv.handle),
               reinterpret_cast<uv_stream_t*>(&client_side.handle));

    // Server envia datos al cliente.
    const char* msg = "respuesta del server";
    uv_write_t write_req;
    uv_buf_t buf = uv_buf_init(const_cast<char*>(msg), static_cast<unsigned>(std::strlen(msg)));
    int r = uv_write(&write_req, reinterpret_cast<uv_stream_t*>(&client_side.handle), &buf, 1, nullptr);
    CHECK(r == 0, "uv_write retorno 0");

    // Cliente raw lee la respuesta.
    char rx[64] = {0};
    ssize_t n = ::recv(raw, rx, sizeof(rx) - 1, 0);
    CHECK(n == static_cast<ssize_t>(std::strlen(msg)), "cliente recibio los bytes correctos");
    CHECK(std::memcmp(rx, msg, std::strlen(msg)) == 0, "contenido recibido correcto");

    uv_close(reinterpret_cast<uv_handle_t*>(&client_side.handle), nullptr);
    uv_close(reinterpret_cast<uv_handle_t*>(&srv.handle), nullptr);
    ::close(raw);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
}

int main() {
    test_1_bind_and_listen();
    test_2_accept_connection();
    test_3_read_from_client();
    test_4_write_to_client();
    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}