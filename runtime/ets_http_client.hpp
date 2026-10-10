#pragma once

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <map>
#include <netdb.h>
#include <netinet/in.h>
#include <string>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include "runtime/ets_async.hpp"   // Result<T, string>
#include "runtime/ets_net_sync.hpp"  // tcpConnectSync, tcpWriteSync, tcpReadSync, tcpCloseSync

// Cliente HTTP bloqueante estilo fetch() sobre TCP plano (HTTP/1.1, sin
// HTTPS, sin streaming, sin cookies). Vive separado del server
// (runtime/ets_http_server.hpp) para no colisionar con el builder
// HttpResponse del server. La API del dialecto expone las funciones
// libres como namespace `http` (http.get, http.post) y el struct
// HttpClientResponse para acceder al resultado.

namespace ets {

// ----------------------------------------------------------------------------
// HttpClientResponse — respuesta HTTP plana (no builder). El user accede
// a los campos con sintaxis method-style del dialecto:
//   let r: HttpClientResponse = match (res) { ok(r) => r.value(), err(_) => ... };
//   print("status: " + numberToString(r.status()));
//   print("body: " + r.body());
//   print("content-type: " + r.header("Content-Type"));
//
// Se usa un struct con metodos en vez de campos publicos para evitar
// choques con el resto del dialecto (los miembros de struct se acceden
// como metodos en la API expuesta).
// ----------------------------------------------------------------------------
struct HttpClientResponse {
    int status = 0;                                  // HTTP status code (200, 404, ...)
    std::string body;                                // cuerpo de la respuesta
    std::map<std::string, std::string> headers;      // headers case-insensitive

    // accessors method-style (el dialecto no soporta campos en struct)
    double status_code() const { return static_cast<double>(status); }
    const std::string& body_str() const { return body; }
    // header(name) -> "" si no existe, valor del header si esta
    std::string header(const std::string& name) const {
        for (const auto& kv : headers) {
            if (kv.first.size() == name.size()) {
                bool match = true;
                for (std::size_t i = 0; i < kv.first.size(); ++i) {
                    char a = kv.first[i];
                    char b = name[i];
                    if (a >= 'A' && a <= 'Z') a = static_cast<char>(a + 32);
                    if (b >= 'A' && b <= 'Z') b = static_cast<char>(b + 32);
                    if (a != b) { match = false; break; }
                }
                if (match) return kv.second;
            }
        }
        return std::string();
    }
};

namespace http_client_detail {

// Parsea una URL "http://host[:port][/path][?query]". Devuelve ok/failure.
struct ParsedUrl {
    std::string host;
    int port = 80;
    std::string path;
};

inline Result<ParsedUrl> parseUrl(const std::string& url) {
    constexpr const char* scheme = "http://";
    constexpr std::size_t schemeLen = 7;
    if (url.size() < schemeLen || url.compare(0, schemeLen, scheme) != 0) {
        return Result<ParsedUrl>::failure(std::string("URL debe empezar por http:// (HTTPS no soportado): ") + url);
    }
    ParsedUrl out;
    std::size_t i = schemeLen;
    // host hasta ':' o '/' o '?' o fin
    while (i < url.size() && url[i] != ':' && url[i] != '/' && url[i] != '?') {
        out.host.push_back(url[i]);
        ++i;
    }
    if (out.host.empty()) return Result<ParsedUrl>::failure("URL sin host");

    if (i < url.size() && url[i] == ':') {
        ++i;
        int port = 0;
        while (i < url.size() && std::isdigit(static_cast<unsigned char>(url[i]))) {
            port = port * 10 + (url[i] - '0');
            ++i;
        }
        if (port == 0 || port > 65535) return Result<ParsedUrl>::failure("Puerto invalido en URL");
        out.port = port;
    }

    if (i < url.size() && url[i] == '?') {
        out.path = "/";
    } else if (i >= url.size() || url[i] != '/') {
        out.path = "/";
    } else {
        // path incluye query string si lo hay
        out.path = url.substr(i);
    }
    return Result<ParsedUrl>::success(std::move(out));
}

// Resuelve el host via getaddrinfo y devuelve el primer sockaddr_in. Sync.
inline Result<int> resolveAndConnect(const std::string& host, int port, double timeoutMs) {
    struct addrinfo hints;
    std::memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    struct addrinfo* result = nullptr;
    const std::string portStr = std::to_string(port);
    const int gai = ::getaddrinfo(host.c_str(), portStr.c_str(), &hints, &result);
    if (gai != 0 || result == nullptr) {
        return Result<int>::failure(std::string("getaddrinfo fallo: ") + ::gai_strerror(gai));
    }
    int fd = -1;
    for (struct addrinfo* p = result; p != nullptr; p = p->ai_next) {
        fd = ::socket(p->ai_family, p->ai_socktype, p->ai_protocol);
        if (fd < 0) continue;
        // Set non-blocking para timeout via select.
        const int flags = ::fcntl(fd, F_GETFL, 0);
        ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);

        int rc = ::connect(fd, p->ai_addr, p->ai_addrlen);
        if (rc == 0) break;
        if (errno != EINPROGRESS) {
            ::close(fd);
            fd = -1;
            continue;
        }
        // esperar con select
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(fd, &wfds);
        struct timeval tv;
        tv.tv_sec = static_cast<long>(timeoutMs / 1000.0);
        tv.tv_usec = static_cast<long>((timeoutMs - tv.tv_sec * 1000.0) * 1000.0);
        const int sel = ::select(fd + 1, nullptr, &wfds, nullptr, &tv);
        if (sel <= 0) {
            ::close(fd);
            fd = -1;
            continue;
        }
        int so_err = 0;
        socklen_t len = sizeof(so_err);
        ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &so_err, &len);
        if (so_err != 0) {
            ::close(fd);
            fd = -1;
            continue;
        }
        break;
    }
    ::freeaddrinfo(result);
    if (fd < 0) return Result<int>::failure(std::string("No se pudo conectar a ") + host + ":" + std::to_string(port));
    // Volver a blocking
    const int flags = ::fcntl(fd, F_GETFL, 0);
    ::fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
    // Set send/recv timeout
    struct timeval tv;
    tv.tv_sec = static_cast<long>(timeoutMs / 1000.0);
    tv.tv_usec = static_cast<long>((timeoutMs - tv.tv_sec * 1000.0) * 1000.0);
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    return Result<int>::success(fd);
}

// Lee hasta encontrar \r\n\r\n (fin de headers), luego lee Content-Length
// bytes del body. Devuelve el resultado completo.
inline Result<HttpClientResponse> readHttpResponse(int fd) {
    std::string raw;
    char buf[4096];
    std::size_t headerEnd = std::string::npos;
    // Fase 1: leer hasta \r\n\r\n.
    while (true) {
        const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) {
            if (n < 0) return Result<HttpClientResponse>::failure(std::string("recv fallo: ") + std::strerror(errno));
            return Result<HttpClientResponse>::failure(std::string("Conexion cerrada prematuramente por el server"));
        }
        raw.append(buf, static_cast<std::size_t>(n));
        headerEnd = raw.find("\r\n\r\n");
        if (headerEnd != std::string::npos) break;
        if (raw.size() > 1 * 1024 * 1024) {
            return Result<HttpClientResponse>::failure("Headers HTTP exceden 1MB");
        }
    }
    // Parsear status line
    HttpClientResponse out;
    std::size_t lineEnd = raw.find("\r\n");
    if (lineEnd == std::string::npos) return Result<HttpClientResponse>::failure("Status line malformado");
    const std::string statusLine = raw.substr(0, lineEnd);
    const std::size_t sp1 = statusLine.find(' ');
    if (sp1 == std::string::npos) return Result<HttpClientResponse>::failure("Status line sin espacios");
    std::size_t sp2 = statusLine.find(' ', sp1 + 1);
    if (sp2 == std::string::npos) sp2 = statusLine.size();
    const std::string codeStr = statusLine.substr(sp1 + 1, sp2 - sp1 - 1);
    try { out.status = std::stoi(codeStr); }
    catch (...) { return Result<HttpClientResponse>::failure("Status code no numerico: " + codeStr); }

    // Parsear headers
    std::size_t headerStart = lineEnd + 2;
    while (headerStart < headerEnd) {
        std::size_t next = raw.find("\r\n", headerStart);
        if (next == std::string::npos || next > headerEnd) break;
        const std::string line = raw.substr(headerStart, next - headerStart);
        const std::size_t colon = line.find(':');
        if (colon != std::string::npos) {
            std::string name = line.substr(0, colon);
            std::string value = line.substr(colon + 1);
            std::size_t vs = 0;
            while (vs < value.size() && (value[vs] == ' ' || value[vs] == '\t')) ++vs;
            value = value.substr(vs);
            out.headers.emplace(std::move(name), std::move(value));
        }
        headerStart = next + 2;
    }

    // Body empieza despues de \r\n\r\n. Cuanto hemos leido ya del body?
    std::size_t bodyOffset = headerEnd + 4;
    std::size_t bodyAlreadyRead = (bodyOffset <= raw.size()) ? raw.size() - bodyOffset : 0;

    // Content-Length?
    std::size_t expectedBody = 0;
    bool hasContentLength = false;
    for (const auto& kv : out.headers) {
        std::string lname = kv.first;
        for (auto& c : lname) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
        if (lname == "content-length") {
            try { expectedBody = std::stoul(kv.second); hasContentLength = true; } catch (...) {}
            break;
        }
    }
    // Connection: close -> leer hasta EOF
    bool isConnectionClose = false;
    for (const auto& kv : out.headers) {
        std::string lname = kv.first;
        for (auto& c : lname) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
        if (lname == "connection") {
            std::string lval = kv.second;
            for (auto& c : lval) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
            if (lval == "close") isConnectionClose = true;
            break;
        }
    }

    out.body = raw.substr(bodyOffset);
    if (hasContentLength) {
        // Seguir leyendo hasta completar Content-Length
        while (out.body.size() < expectedBody) {
            const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
            if (n <= 0) break;  // EOF o error: devolvemos lo que tengamos
            out.body.append(buf, static_cast<std::size_t>(n));
        }
        // Si leimos de mas, truncar
        if (out.body.size() > expectedBody) out.body.resize(expectedBody);
    } else if (isConnectionClose) {
        // Leer hasta EOF
        while (true) {
            const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
            if (n <= 0) break;
            out.body.append(buf, static_cast<std::size_t>(n));
        }
    }
    // Sin Content-Length ni Connection: close -> chunked o HTTP/1.0 (no soportado)

    return Result<HttpClientResponse>::success(std::move(out));
}

}  // namespace http_client_detail

// ----------------------------------------------------------------------------
// httpClientGet(url, timeoutMs=30000) -> Result<HttpClientResponse, string>
//   url: "http://host[:puerto][/path][?query]"
//   Errores: URL malformada, conexion fallida, timeout.
// ----------------------------------------------------------------------------
inline Result<HttpClientResponse> httpClientGet(const std::string& url, double timeoutMs = 30000.0) {
    const auto parsed = http_client_detail::parseUrl(url);
    if (!parsed.isOk()) return Result<HttpClientResponse>::failure(parsed.error());
    const auto& u = parsed.value();

    const auto conn = http_client_detail::resolveAndConnect(u.host, u.port, timeoutMs);
    if (!conn.isOk()) return Result<HttpClientResponse>::failure(conn.error());
    const int fd = conn.value();

    // Construir request
    const std::string request =
        "GET " + u.path + " HTTP/1.1\r\n"
        "Host: " + u.host + "\r\n"
        "Connection: close\r\n"
        "User-Agent: Ts2cpp/0.5\r\n"
        "\r\n";

    const ssize_t sent = ::send(fd, request.data(), request.size(), 0);
    if (sent < 0 || static_cast<std::size_t>(sent) != request.size()) {
        ::close(fd);
        return Result<HttpClientResponse>::failure(std::string("send fallo: ") + std::strerror(errno));
    }

    auto resp = http_client_detail::readHttpResponse(fd);
    ::close(fd);
    return resp;
}

// ----------------------------------------------------------------------------
// httpClientPost(url, body, contentType, timeoutMs=30000) -> Result<HttpClientResponse, string>
//   url: "http://host[:puerto][/path]"
//   body: cuerpo del POST
//   contentType: "application/json" por defecto si vacio
// ----------------------------------------------------------------------------
inline Result<HttpClientResponse> httpClientPost(const std::string& url, const std::string& body, const std::string& contentType, double timeoutMs = 30000.0) {
    const auto parsed = http_client_detail::parseUrl(url);
    if (!parsed.isOk()) return Result<HttpClientResponse>::failure(parsed.error());
    const auto& u = parsed.value();

    const auto conn = http_client_detail::resolveAndConnect(u.host, u.port, timeoutMs);
    if (!conn.isOk()) return Result<HttpClientResponse>::failure(conn.error());
    const int fd = conn.value();

    const std::string actualContentType = contentType.empty() ? std::string("application/json") : contentType;
    const std::string request =
        "POST " + u.path + " HTTP/1.1\r\n"
        "Host: " + u.host + "\r\n"
        "Content-Type: " + actualContentType + "\r\n"
        "Content-Length: " + std::to_string(body.size()) + "\r\n"
        "Connection: close\r\n"
        "User-Agent: Ts2cpp/0.5\r\n"
        "\r\n" + body;

    const ssize_t sent = ::send(fd, request.data(), request.size(), 0);
    if (sent < 0 || static_cast<std::size_t>(sent) != request.size()) {
        ::close(fd);
        return Result<HttpClientResponse>::failure(std::string("send fallo: ") + std::strerror(errno));
    }

    auto resp = http_client_detail::readHttpResponse(fd);
    ::close(fd);
    return resp;
}

}  // namespace ets
