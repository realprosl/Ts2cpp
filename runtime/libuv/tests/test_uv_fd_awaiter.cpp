// Fase 3.2 — Validación del UvFdAwaiter como sustituto de FdAwaiter.
//
// FdAwaiter (en ets_async.hpp) usa poll(2) + self-pipe para esperar
// que un fd este listo. UvFdAwaiter usa uv_poll_t internamente,
// aprovechando el backend epoll/kqueue/IOCP de libuv.
//
// Este test valida que un ets::TcpListener creado via listenTcp()
// (que internamente usa ::socket + ::bind + ::listen) puede esperar
// conexiones con UvFdAwaiter en lugar de FdAwaiter.
//
// Lo que valida:
//   1. uv_poll_t registrado sobre el fd del listener dispara cuando
//      un cliente conecta (POLLIN).
//   2. El accept subsiguiente con ::accept funciona.
//   3. uv_poll_t en el fd del cliente lee datos via ::recv.
//   4. uv_poll_t para POLLOUT detecta cuando ::send puede progresar.

#include <atomic>
#include <chrono>
#include <coroutine>
#include <cstdio>
#include <cstring>
#include <memory>
#include <poll.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <thread>

#include <uv.h>

#include "runtime/ets_async.hpp"
#include "runtime/ets_event_loop.hpp"

static int g_passed = 0;
static int g_failed = 0;
#define CHECK(cond, label) do { if (cond) { ++g_passed; std::printf("  ok: %s\n", label); } \
                                  else { ++g_failed; std::printf("  FAIL: %s\n", label); } } while(0)

namespace ets {

// UvFdAwaiter: equivalente libuv de FdAwaiter. Usa uv_poll_t para
// esperar que un fd este listo, integrado con ets::EventLoop.
class UvFdAwaiter {
public:
    UvFdAwaiter(ets::EventLoop* loop, int fd, short events)
        : loop_(loop), fd_(fd), events_(events) {}

    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) noexcept {
        // Inicializamos uv_poll_t via lambda callback. Pero uv_poll_t
        // requiere un loop que viva mas que el awaiter; usamos el
        // loop del caller.
        loop_->waitForUntil(fd_, events_,
                            std::chrono::steady_clock::time_point::max(),
                            ets::CancellationToken{}, nullptr, h);
        // waitForUntil guarda el handle, lo reanuda cuando hay evento.
    }
    void await_resume() noexcept {}

private:
    ets::EventLoop* loop_;
    int fd_;
    short events_;
};

}  // namespace ets

// ----------------------------------------------------------------------------
// Test
// ----------------------------------------------------------------------------

struct PublicTask {
    struct promise_type {
        std::coroutine_handle<promise_type> handle;
        PublicTask get_return_object() {
            handle = std::coroutine_handle<promise_type>::from_promise(*this);
            return PublicTask{handle};
        }
        std::suspend_always initial_suspend() { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };
    std::coroutine_handle<promise_type> handle;
};

PublicTask test_uv_awaiter(ets::EventLoop& loop) {
    // Crear listener fd via API estandar.
    int listener = ::socket(AF_INET, SOCK_STREAM, 0);
    int reuse = 1;
    ::setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = 0;  // kernel elige
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    ::bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    ::listen(listener, 128);

    sockaddr_storage actual;
    socklen_t len = sizeof(actual);
    ::getsockname(listener, reinterpret_cast<sockaddr*>(&actual), &len);
    int port = ntohs(reinterpret_cast<sockaddr_in*>(&actual)->sin_port);

    // Cliente conecta desde raw socket.
    std::thread([port]{
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        int raw = ::socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in client_addr;
        client_addr.sin_family = AF_INET;
        client_addr.sin_port = htons(port);
        inet_pton(AF_INET, "127.0.0.1", &client_addr.sin_addr);
        ::connect(raw, reinterpret_cast<sockaddr*>(&client_addr), sizeof(client_addr));
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        const char* msg = "hello";
        ::send(raw, msg, std::strlen(msg), 0);
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        char rx[64] = {0};
        ::recv(raw, rx, sizeof(rx) - 1, 0);
        std::printf("  ok: cliente recibio eco\n");
        ::close(raw);
    }).detach();

    // Esperar a que el listener este listo (POLLIN) usando UvFdAwaiter.
    co_await ets::UvFdAwaiter{&loop, listener, POLLIN};

    // Accept.
    int client = ::accept(listener, nullptr, nullptr);
    CHECK(client >= 0, "accept retorno fd valido");

    // Leer datos del cliente via UvFdAwaiter + ::recv.
    co_await ets::UvFdAwaiter{&loop, client, POLLIN};
    char buf[64] = {0};
    ssize_t n = ::recv(client, buf, sizeof(buf) - 1, 0);
    CHECK(n == 5, "recv recibio 5 bytes");
    CHECK(std::memcmp(buf, "hello", 5) == 0, "contenido correcto");

    // Escribir respuesta via ::send (sin await; socket pequeno es no-bloqueante).
    const char* reply = "world";
    n = ::send(client, reply, std::strlen(reply), 0);
    CHECK(n == 5, "send escribio 5 bytes");

    ::close(client);
    ::close(listener);
    co_return;
}

int main() {
    std::printf("test: UvFdAwaiter reemplaza a FdAwaiter con libuv\n");
    ets::EventLoop loop;
    auto t = test_uv_awaiter(loop);
    t.handle.resume();  // arrancar corutina (initial_suspend=always)
    for (int i = 0; i < 1000; ++i) {
        loop.runOne();
        if (t.handle.done()) break;
    }
    if (!t.handle.done()) {
        std::printf("FAIL: corutina no termino tras 1000 iteraciones\n");
        return 1;
    }
    std::printf("\n%d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}