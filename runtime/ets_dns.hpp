// runtime/ets_dns.hpp — DNS asíncrono sobre uv_getaddrinfo.
//
// V30.4: expone resolucion DNS al dialecto .ets. La API es:
//
//   let ip: string = await resolveDns("example.com")
//
// Internamente: uv_getaddrinfo (libuv) + coroutine awaiter. El
// event loop principal (libuv) NUNCA se bloquea en getaddrinfo
// bloqueante. Cuando libuv resuelve el nombre, llama al callback,
// que resume la coroutine suspendida.
//
// Misma forma que acceptTcp/readTcp: la funcion devuelve
// Task<string> (= Promise<string> en el dialecto), no
// Task<Result<string, string>>. Si hay error, devuelve string
// vacio (""). Tests pueden verificar `if (ip == "") print("fail")`.
//
// Migracion V30.3 -> V30.4 (no aplica, V30.3 fue abortado):
//   Antes: http.get/post tenia que usar libcurl con DNS bloqueante
//   Ahora: el dialecto puede usar resolveDns() explicitamente para
//   resolucion async antes de hacer el request TCP crudo.
//
// Compilacion:
//   g++ -std=c++20 -I. programa.cpp runtime/runtime_ets_libuv.cpp
//       runtime/runtime_ets_net_libuv.cpp -lpthread -luv -lstdc++fs
//   (uv_getaddrinfo requiere libuv, que ya esta linkado en runtime.)

#pragma once

#include <chrono>
#include <coroutine>
#include <cstring>
#include <string>
#include <utility>

#include <uv.h>

#include "runtime/ets_async.hpp"
#include "runtime/ets_event_loop.hpp"

namespace ets {

// ----------------------------------------------------------------------------
// GetAddrInfoAwaiter — awaiter que suspende la coroutine hasta que
// uv_getaddrinfo completa. Patron: la coroutine hace
// `co_await GetAddrInfoAwaiter{host}`, await_suspend arranca el
// request via uv_getaddrinfo con un callback que resume la coroutine,
// y await_resume devuelve la IP resuelta (o "" si error).
// ----------------------------------------------------------------------------
class GetAddrInfoAwaiter {
public:
    explicit GetAddrInfoAwaiter(std::string host) : host_(std::move(host)) {}

    // Siempre suspende: getaddrinfo puede tardar, no es un hot path
    // que podamos saltarnos.
    bool await_ready() const noexcept { return false; }

    void await_suspend(std::coroutine_handle<> h) noexcept {
        continuation_ = h;
        status_ = -1;
        result_.clear();
        // uv_getaddrinfo usa el loop por defecto. El callback se
        // invoca cuando el resolver del SO completa. En Linux
        // usa getaddrinfo_a / getaddrinfo segun la version.
        // Guardamos `this` en req.data para que el callback pueda
        // recuperar el awaiter.
        req_.data = this;
        struct addrinfo hints {};
        hints.ai_family = AF_INET;  // IPv4 por simplicidad (V30.4)
        hints.ai_socktype = SOCK_STREAM;
        const int rc = uv_getaddrinfo(
            ets::defaultEventLoop.raw_loop(),
            &req_,
            &GetAddrInfoAwaiter::onResolved,
            host_.c_str(),
            nullptr,
            &hints);
        if (rc != 0) {
            // No se pudo arrancar el request: resume inmediatamente
            // con error. continuation_ sigue siendo el handle pasado.
            status_ = rc;
            result_.clear();
            h.resume();
        }
    }

    std::string await_resume() const noexcept {
        if (status_ != 0 || result_.empty()) return std::string();
        return result_;
    }

private:
    static void onResolved(uv_getaddrinfo_t* req, int status, struct addrinfo* res) {
        auto* self = static_cast<GetAddrInfoAwaiter*>(req->data);
        if (!self) {
            if (res) uv_freeaddrinfo(res);
            return;
        }
        self->status_ = status;
        if (status == 0 && res) {
            // Toma la primera IP (res->ai_addr->sa_data). Solo IPv4.
            if (res->ai_family == AF_INET && res->ai_addr) {
                const auto* sin = reinterpret_cast<struct sockaddr_in*>(res->ai_addr);
                char ip[INET_ADDRSTRLEN] = {0};
                if (uv_ip4_name(sin, ip, sizeof(ip)) == 0) {
                    self->result_ = ip;
                }
            } else if (res->ai_family == AF_INET6 && res->ai_addr) {
                const auto* sin6 = reinterpret_cast<struct sockaddr_in6*>(res->ai_addr);
                char ip[INET6_ADDRSTRLEN] = {0};
                if (uv_ip6_name(sin6, ip, sizeof(ip)) == 0) {
                    self->result_ = ip;
                }
            }
        }
        // Libera los resultados de libuv.
        if (res) uv_freeaddrinfo(res);
        // Resume la coroutine. El loop principal la despertara cuando
        // vuelva a iterar (post en el event loop para evitar reentrancy).
        auto cont = self->continuation_;
        if (cont) {
            ets::defaultEventLoop.post(cont);
        }
    }

    std::string host_;
    uv_getaddrinfo_t req_{};
    std::coroutine_handle<> continuation_{};
    std::string result_;
    int status_ = 0;
};

// ----------------------------------------------------------------------------
// resolveDns — punto de entrada del dialecto. Devuelve la primera IP
// (IPv4) resuelta o string vacio si error. Awaitable desde una
// coroutine (Task<string> = Promise<string> en el dialecto).
// ----------------------------------------------------------------------------
inline Task<std::string> resolveDns(std::string host) {
    auto ip = co_await GetAddrInfoAwaiter{std::move(host)};
    co_return std::move(ip);
}

}  // namespace ets
