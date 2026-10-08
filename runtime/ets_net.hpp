#pragma once

#include "runtime/ets_async.hpp"
#include "runtime/ets_buffer_pool.hpp"
#include <cerrno>
#include <cmath>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <netdb.h>
#include <poll.h>
#include <string>
#include <sys/socket.h>
#include <unistd.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

// Selector de awaitables de red: por defecto usa FdAwaiter /
// CancellableFdAwaiter basados en poll(2). Bajo
// -DETS_EVENT_BACKEND_LIBUV usa UvFdAwaiter / UvCancellableFdAwaiter
// basados en libuv (uv_poll_t). V1 mantiene la API publica intacta:
// acceptTcp, readTcp, writeTcp, etc. siguen funcionando igual, solo
// cambia el backend de espera interna.
//
// Las definiciones de los awaitables viven en runtime_ets_net.cpp o
// runtime_ets_net_libuv.cpp (pre-compilados a .o cacheados por V25
// Fase 4.3). Aqui solo se re-exportan los tipos via el _api.hpp.
#ifdef ETS_EVENT_BACKEND_LIBUV
  #include "runtime/ets_net_libuv_api.hpp"
  namespace ets {
      using NetFdAwaiter = UvFdAwaiter;
      using NetCancellableFdAwaiter = UvCancellableFdAwaiter;
  }
#else
  #include "runtime/ets_net_poll_api.hpp"
  namespace ets {
      using NetFdAwaiter = FdAwaiter;
      using NetCancellableFdAwaiter = CancellableFdAwaiter;
  }
#endif

namespace ets {

struct SocketState {
    explicit SocketState(int descriptor) : fd(descriptor) {}
    ~SocketState() { if (fd >= 0) ::close(fd); }
    int fd = -1;
};

class TcpListener {
public:
    TcpListener() = default;
    explicit TcpListener(int fd) : state_(std::make_shared<SocketState>(fd)) {}
    bool valid() const noexcept { return state_ && state_->fd >= 0; }
    int fd() const noexcept { return valid() ? state_->fd : -1; }
    void close() const noexcept { if (valid()) { ::close(state_->fd); state_->fd = -1; } }
private:
    std::shared_ptr<SocketState> state_;
};

class TcpConnection {
public:
    TcpConnection() = default;
    explicit TcpConnection(int fd) : state_(std::make_shared<SocketState>(fd)) {}
    bool valid() const noexcept { return state_ && state_->fd >= 0; }
    int fd() const noexcept { return valid() ? state_->fd : -1; }
    void close() const noexcept { if (valid()) { ::close(state_->fd); state_->fd = -1; } }
private:
    std::shared_ptr<SocketState> state_;
};

inline std::string socketError(const std::string& operation) { return operation + ": " + std::strerror(errno); }

inline bool makeNonBlocking(int fd) {
    const int flags = ::fcntl(fd, F_GETFL, 0);
    return flags >= 0 && ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

inline Result<TcpListener> listenTcp(const std::string& host, double requestedPort) {
    if (requestedPort < 1 || requestedPort > 65535 || std::floor(requestedPort) != requestedPort) return Result<TcpListener>::failure("El puerto TCP debe ser un entero entre 1 y 65535");
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    addrinfo* addresses = nullptr;
    const std::string port = std::to_string(static_cast<unsigned short>(requestedPort));
    const char* node = host.empty() || host == "0.0.0.0" ? nullptr : host.c_str();
    const int lookup = ::getaddrinfo(node, port.c_str(), &hints, &addresses);
    if (lookup != 0) return Result<TcpListener>::failure(std::string("No se puede resolver la dirección: ") + ::gai_strerror(lookup));
    int listener = -1;
    for (addrinfo* address = addresses; address; address = address->ai_next) {
        listener = ::socket(address->ai_family, address->ai_socktype, address->ai_protocol);
        if (listener < 0) continue;
        int reuse = 1;
        ::setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        if (::bind(listener, address->ai_addr, address->ai_addrlen) == 0 && ::listen(listener, SOMAXCONN) == 0 && makeNonBlocking(listener)) break;
        ::close(listener);
        listener = -1;
    }
    ::freeaddrinfo(addresses);
    if (listener < 0) return Result<TcpListener>::failure(socketError("No se puede abrir el listener TCP"));
    return Result<TcpListener>::success(TcpListener{listener});
}

inline Task<Result<TcpConnection>> acceptTcp(TcpListener listener) {
    if (!listener.valid()) co_return Result<TcpConnection>::failure("Listener TCP cerrado");
    for (;;) {
        const int client = ::accept(listener.fd(), nullptr, nullptr);
        if (client >= 0) {
            if (!makeNonBlocking(client)) { ::close(client); co_return Result<TcpConnection>::failure(socketError("No se puede configurar el cliente")); }
            co_return Result<TcpConnection>::success(TcpConnection{client});
        }
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) co_return Result<TcpConnection>::failure(socketError("Error aceptando conexión"));
        if (errno == EINTR) continue;
        co_await NetFdAwaiter{listener.fd(), POLLIN};
    }
}

inline Task<Result<std::string>> readTcp(TcpConnection connection, double requestedBytes) {
    if (!connection.valid()) co_return Result<std::string>::failure("Conexión TCP cerrada");
    std::size_t size = requestedBytes <= 0 ? 1 : static_cast<std::size_t>(requestedBytes);
    if (size > 1024 * 1024) size = 1024 * 1024;
    // V26: buffer pool reutilizable en vez de alocar fresh cada vez.
    // NOTA: capacity >= size, y recv escribe hasta `capacity` bytes. El
    // resultado final es un std::string del tamano exacto leido; el
    // buffer del pool se devuelve al pool (no se transfiere al caller,
    // porque el caller recibe por valor y debe poder mantener el string
    // tras la siguiente llamada a readTcp).
    std::string buffer = ets::BufferPool::instance().acquire(size);
    const std::size_t capacity = buffer.capacity();
    for (;;) {
        const ssize_t received = ::recv(connection.fd(), buffer.data(), capacity, 0);
        if (received >= 0) {
            std::string result(received, '\0');
            std::memcpy(result.data(), buffer.data(), static_cast<std::size_t>(received));
            ets::BufferPool::instance().release(std::move(buffer));
            co_return Result<std::string>::success(std::move(result));
        }
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
            ets::BufferPool::instance().release(std::move(buffer));
            co_return Result<std::string>::failure(socketError("Error leyendo conexión"));
        }
        if (errno == EINTR) continue;
        co_await NetFdAwaiter{connection.fd(), POLLIN};
    }
}

inline Task<Result<double>> writeTcp(TcpConnection connection, std::string data) {
    if (!connection.valid()) co_return Result<double>::failure("Conexión TCP cerrada");
    std::size_t written = 0;
    while (written < data.size()) {
        const ssize_t sent = ::send(connection.fd(), data.data() + written, data.size() - written, MSG_NOSIGNAL);
        if (sent > 0) { written += static_cast<std::size_t>(sent); continue; }
        if (sent < 0 && errno == EINTR) continue;
        if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) { co_await NetFdAwaiter{connection.fd(), POLLOUT}; continue; }
        co_return Result<double>::failure(socketError("Error escribiendo conexión"));
    }
    co_return Result<double>::success(static_cast<double>(written));
}

inline std::chrono::steady_clock::time_point networkDeadline(double milliseconds) {
    const auto duration = std::chrono::milliseconds(static_cast<long long>(milliseconds < 0 ? 0 : milliseconds));
    return std::chrono::steady_clock::now() + duration;
}

inline std::string waitError(WaitResult result, const std::string& operation) {
    return result == WaitResult::cancelled ? operation + " cancelada" : operation + " excedió el deadline";
}

inline Task<Result<TcpConnection>> acceptTcpUntil(TcpListener listener, double timeoutMilliseconds, CancellationToken token) {
    if (!listener.valid()) co_return Result<TcpConnection>::failure("Listener TCP cerrado");
    const auto deadline = networkDeadline(timeoutMilliseconds);
    for (;;) {
        const int client = ::accept(listener.fd(), nullptr, nullptr);
        if (client >= 0) {
            if (!makeNonBlocking(client)) { ::close(client); co_return Result<TcpConnection>::failure(socketError("No se puede configurar el cliente")); }
            co_return Result<TcpConnection>::success(TcpConnection{client});
        }
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) co_return Result<TcpConnection>::failure(socketError("Error aceptando conexión"));
        if (errno == EINTR) continue;
        const auto waited = co_await NetCancellableFdAwaiter{listener.fd(), POLLIN, deadline, token};
        if (waited != WaitResult::ready) co_return Result<TcpConnection>::failure(waitError(waited, "Accept TCP"));
    }
}

inline Task<Result<std::string>> readTcpUntil(TcpConnection connection, double requestedBytes, double timeoutMilliseconds, CancellationToken token) {
    if (!connection.valid()) co_return Result<std::string>::failure("Conexión TCP cerrada");
    std::size_t size = requestedBytes <= 0 ? 1 : static_cast<std::size_t>(requestedBytes);
    if (size > 1024 * 1024) size = 1024 * 1024;
    std::string buffer(size, '\0');
    const auto deadline = networkDeadline(timeoutMilliseconds);
    for (;;) {
        const ssize_t received = ::recv(connection.fd(), buffer.data(), buffer.size(), 0);
        if (received >= 0) { buffer.resize(static_cast<std::size_t>(received)); co_return Result<std::string>::success(std::move(buffer)); }
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) co_return Result<std::string>::failure(socketError("Error leyendo conexión"));
        if (errno == EINTR) continue;
        const auto waited = co_await NetCancellableFdAwaiter{connection.fd(), POLLIN, deadline, token};
        if (waited != WaitResult::ready) co_return Result<std::string>::failure(waitError(waited, "Lectura TCP"));
    }
}

inline Task<Result<double>> writeTcpUntil(TcpConnection connection, std::string data, double timeoutMilliseconds, CancellationToken token) {
    if (!connection.valid()) co_return Result<double>::failure("Conexión TCP cerrada");
    std::size_t written = 0;
    const auto deadline = networkDeadline(timeoutMilliseconds);
    while (written < data.size()) {
        const ssize_t sent = ::send(connection.fd(), data.data() + written, data.size() - written, MSG_NOSIGNAL);
        if (sent > 0) { written += static_cast<std::size_t>(sent); continue; }
        if (sent < 0 && errno == EINTR) continue;
        if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            const auto waited = co_await NetCancellableFdAwaiter{connection.fd(), POLLOUT, deadline, token};
            if (waited != WaitResult::ready) co_return Result<double>::failure(waitError(waited, "Escritura TCP"));
            continue;
        }
        co_return Result<double>::failure(socketError("Error escribiendo conexión"));
    }
    co_return Result<double>::success(static_cast<double>(written));
}

inline void closeTcp(const TcpListener& listener) noexcept { listener.close(); }
inline void closeTcp(const TcpConnection& connection) noexcept { connection.close(); }

} // namespace ets
