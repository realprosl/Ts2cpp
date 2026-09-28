#pragma once

// Wrappers síncronos sobre POSIX sockets para los tests E2E de networking
// (Issue #14). Viven en runtime/ets_net_sync.hpp porque el runtime principal
// `ets_net.hpp` usa corutinas + Task<Result<T>> que no encajan en los tests
// E2E síncronos.
//
// Estos wrappers NO son parte del dialecto del usuario — son una capa
// auxiliar para que los tests E2E puedan ejercitar comunicación cliente-
// servidor sin tener que manejar el event loop async.
//
// API:
//   tcpListenSync(host: string, port: number) -> number    (fd del listener, -1 en error)
//   tcpAcceptSync(listenerFd: number) -> number            (fd del cliente, -1 en error)
//   tcpConnectSync(host: string, port: number) -> number   (fd del socket, -1 en error)
//   tcpReadSync(fd: number, maxBytes: number) -> string    ("" en error/disconnect)
//   tcpWriteSync(fd: number, data: string) -> boolean      (true en éxito)
//   tcpCloseSync(fd: number) -> void
//
// Issue V1: cuando tagged unions estén disponibles, los wrappers arriba se
// reemplazan por `Result<TcpConn, NetError>` para reportar errores de forma
// estructurada.

#include <arpa/inet.h>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <netinet/in.h>
#include <string>
#include <sys/socket.h>
#include <sys/types.h>
#include <thread>
#include <unistd.h>

// El runtime global define `inline void write(...)` que oculta `::write` de
// unistd.h en todo el translation unit. Para evitarlo usamos punteros a
// función que se inicializan en runtime y llaman directamente a la API POSIX.
namespace ets::net_sync {

namespace posix {
    inline ssize_t (&rawWrite)(int, const void*, size_t) = ::write;
    inline ssize_t (&rawRead)(int, void*, size_t) = ::read;
} // namespace posix

inline int tcpListenSync(const std::string& host, double port) {
    const int server_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) return -1;
    int opt = 1;
    ::setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<uint16_t>(port));
    if (host == "0.0.0.0" || host.empty()) {
        address.sin_addr.s_addr = htonl(INADDR_ANY);
    } else if (::inet_pton(AF_INET, host.c_str(), &address.sin_addr) <= 0) {
        ::close(server_fd);
        return -1;
    }
    if (::bind(server_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
        ::close(server_fd);
        return -1;
    }
    if (::listen(server_fd, 1) < 0) {
        ::close(server_fd);
        return -1;
    }
    return server_fd;
}

inline int tcpAcceptSync(int listener_fd) {
    sockaddr_in address{};
    socklen_t addrlen = sizeof(address);
    const int client_fd = ::accept(listener_fd, reinterpret_cast<sockaddr*>(&address), &addrlen);
    return client_fd;
}

inline int tcpConnectSync(const std::string& host, double port) {
    const int sock_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (sock_fd < 0) return -1;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<uint16_t>(port));
    if (::inet_pton(AF_INET, host.c_str(), &address.sin_addr) <= 0) {
        ::close(sock_fd);
        return -1;
    }
    if (::connect(sock_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
        ::close(sock_fd);
        return -1;
    }
    return sock_fd;
}

inline std::string tcpReadSync(int fd, double max_bytes) {
    std::string buffer(static_cast<std::size_t>(max_bytes), '\0');
    const ssize_t received = ets::net_sync::posix::rawRead(fd, buffer.data(), buffer.size());
    if (received <= 0) return std::string();
    buffer.resize(static_cast<std::size_t>(received));
    return buffer;
}

inline bool tcpWriteSync(int fd, const std::string& data) {
    std::size_t written = 0;
    while (written < data.size()) {
        const ssize_t sent = ets::net_sync::posix::rawWrite(fd, const_cast<char*>(data.data()) + written, data.size() - written);
        if (sent > 0) { written += static_cast<std::size_t>(sent); continue; }
        if (sent < 0 && errno == EINTR) continue;
        return false;
    }
    return true;
}

inline void tcpCloseSync(int fd) { if (fd >= 0) ::close(fd); }

} // namespace ets::net_sync

// Wrappers globales (sin namespace) para que el dialecto los vea directamente.
// Mapeo del dialecto: tcpListen → etsNetListen, etc.
inline int etsNetListen(const std::string& host, double port) { return ets::net_sync::tcpListenSync(host, port); }
inline int etsNetAccept(int listener_fd) { return ets::net_sync::tcpAcceptSync(listener_fd); }
inline int etsNetConnect(const std::string& host, double port) { return ets::net_sync::tcpConnectSync(host, port); }
inline std::string etsNetRead(int fd, double max_bytes) { return ets::net_sync::tcpReadSync(fd, max_bytes); }
inline bool etsNetWrite(int fd, const std::string& data) { return ets::net_sync::tcpWriteSync(fd, data); }
inline void etsNetClose(int fd) { ets::net_sync::tcpCloseSync(fd); }

// Helper de alto nivel para tests E2E: cliente + servidor en el mismo proceso.
// 1. Lanza un thread que escucha en (host, port), acepta UNA conexión, lee
//    hasta max_bytes, escribe "world", cierra.
// 2. Desde el hilo principal se conecta, envía `request`, lee la respuesta.
// 3. Devuelve la respuesta del servidor.
//
// En V1 (tagged unions) este helper se reemplaza por una API más rica.
inline std::string etsNetSyncEcho(const std::string& host, double port, const std::string& request, double max_bytes) {
    const int server_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) return std::string();
    int opt = 1;
    ::setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<uint16_t>(port));
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    if (::bind(server_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) { ::close(server_fd); return std::string(); }
    if (::listen(server_fd, 1) < 0) { ::close(server_fd); return std::string(); }

    std::thread server_thread([server_fd, max_bytes]() {
        sockaddr_in client_addr{};
        socklen_t addrlen = sizeof(client_addr);
        const int client_fd = ::accept(server_fd, reinterpret_cast<sockaddr*>(&client_addr), &addrlen);
        if (client_fd < 0) { ::close(server_fd); return; }
        // Lee request (lo descarta) y responde "world".
        char buf[256];
        ets::net_sync::posix::rawRead(client_fd, buf, sizeof(buf));
        const std::string response = "world";
        ets::net_sync::posix::rawWrite(client_fd, response.data(), response.size());
        ::close(client_fd);
        ::close(server_fd);
    });
    server_thread.detach();

    // Cliente: conecta y envía request.
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    const int client_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (client_fd < 0) return std::string();
    sockaddr_in server_addr{};
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(static_cast<uint16_t>(port));
    ::inet_pton(AF_INET, host.c_str(), &server_addr.sin_addr);
    if (::connect(client_fd, reinterpret_cast<sockaddr*>(&server_addr), sizeof(server_addr)) < 0) { ::close(client_fd); return std::string(); }
    ets::net_sync::posix::rawWrite(client_fd, request.data(), request.size());
    std::string response(static_cast<std::size_t>(max_bytes), '\0');
    const ssize_t received = ets::net_sync::posix::rawRead(client_fd, response.data(), response.size());
    ::close(client_fd);
    if (received <= 0) return std::string();
    response.resize(static_cast<std::size_t>(received));
    return response;
}

// Variante de etsNetSyncEcho para mensajes grandes. El server responde con
// una cadena de `payload_bytes` bytes (rellenada con 'A'). El cliente la lee
// completa y la devuelve.
inline std::string etsNetSyncLarge(const std::string& host, double port, double payload_bytes) {
    const int server_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) return std::string();
    int opt = 1;
    ::setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<uint16_t>(port));
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    if (::bind(server_fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) { ::close(server_fd); return std::string(); }
    if (::listen(server_fd, 1) < 0) { ::close(server_fd); return std::string(); }

    std::thread server_thread([server_fd, payload_bytes]() {
        sockaddr_in client_addr{};
        socklen_t addrlen = sizeof(client_addr);
        const int client_fd = ::accept(server_fd, reinterpret_cast<sockaddr*>(&client_addr), &addrlen);
        if (client_fd < 0) { ::close(server_fd); return; }
        // Lee request (lo descarta) y responde con N bytes 'A'.
        char buf[256];
        ets::net_sync::posix::rawRead(client_fd, buf, sizeof(buf));
        const std::size_t n = static_cast<std::size_t>(payload_bytes);
        std::string response(n, 'A');
        ets::net_sync::posix::rawWrite(client_fd, response.data(), response.size());
        ::close(client_fd);
        ::close(server_fd);
    });
    server_thread.detach();

    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    const int client_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (client_fd < 0) return std::string();
    sockaddr_in server_addr{};
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(static_cast<uint16_t>(port));
    ::inet_pton(AF_INET, host.c_str(), &server_addr.sin_addr);
    if (::connect(client_fd, reinterpret_cast<sockaddr*>(&server_addr), sizeof(server_addr)) < 0) { ::close(client_fd); return std::string(); }
    const std::string ping = "ping";
    ets::net_sync::posix::rawWrite(client_fd, ping.data(), ping.size());

    // Lee hasta payload_bytes.
    const std::size_t target = static_cast<std::size_t>(payload_bytes);
    std::string response;
    response.reserve(target);
    while (response.size() < target) {
        char buf[8192];
        const ssize_t received = ets::net_sync::posix::rawRead(client_fd, buf, std::min(sizeof(buf), target - response.size()));
        if (received <= 0) break;
        response.append(buf, static_cast<std::size_t>(received));
    }
    ::close(client_fd);
    return response;
}
