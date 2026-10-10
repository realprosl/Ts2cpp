// runtime/ets_http_httplib_client.hpp — Cliente HTTP/1.1 sobre cpp-httplib.
//
// Misma API que el cliente del V28 (ets_http_client.hpp) pero respaldado
// por httplib::Client. Ventajas:
//   - HTTPS built-in (solo hay que definir CPPHTTPLIB_OPENSSL_SUPPORT).
//   - Connection pooling automatico (httplib lo gestiona por host).
//   - Parsing HTTP/1.1 conforme a spec (chunked, keep-alive, etc.).
//   - Timeout configurables.
//
// API del dialecto: identica a la del V28.
//
//   let r = http.get("http://example.com/path")
//   match (r) {
//     Result.Ok(v) => print("status=" + numberToString(v.status()))
//     Result.Err(e) => print("error: " + e)
//   }
//
// Compilacion:
//   g++ -std=c++20 -I. programa.cpp \
//       runtime/external/httplib/httplib.cc \
//       -lpthread -o programa

#pragma once

#include "external/httplib/httplib.h"

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace ets {

// ----------------------------------------------------------------------------
// Result<T> — version minima, equivalente a la de ets_async.hpp pero
// header-only. Suficiente para el cliente HTTP. Si el usuario quiere la
// version completa (con Task<T>, etc.), puede seguir incluyendo
// ets_async.hpp desde su .ets.
//
// Para evitar colision cuando el cpp generado por el dialecto ya
// incluye ets_runtime.hpp (que arrastra ets_async.hpp y su Result),
// no definimos el nuestro si ya hay uno en scope.
// ----------------------------------------------------------------------------
#ifndef ETS_RESULT_DEFINED
#define ETS_RESULT_DEFINED 1
template <typename T>
class [[nodiscard]] Result {
public:
    static Result success(T value) { return Result{std::move(value), {}}; }
    static Result failure(std::string error) { return Result{{}, std::move(error)}; }
    bool isOk() const noexcept { return value_.has_value(); }
    T& value() & { if (!value_) std::abort(); return *value_; }
    const T& value() const & { if (!value_) std::abort(); return *value_; }
    const std::string& error() const noexcept { return error_; }

private:
    Result(std::optional<T> value, std::string error) : value_(std::move(value)), error_(std::move(error)) {}
    std::optional<T> value_;
    std::string error_;
};
#endif

// ----------------------------------------------------------------------------
// HttpClientResponse — struct plano con el resultado de un request.
// Accesores estilo metodo (status_code(), body_str(), header(name)) para
// que el codegen del dialecto pueda traducir status() / body() / header()
// sin ambiguedad con campos.
// ----------------------------------------------------------------------------
struct HttpClientResponse {
    int status_code() const { return status_; }
    const std::string& body_str() const { return body_; }
    std::string header(const std::string& name) const {
        // Headers en httplib son case-insensitive en el lookup.
        auto it = headers_.find(name);
        if (it == headers_.end()) return std::string();
        return it->second;
    }

    int status_ = 0;
    std::string body_;
    httplib::Headers headers_;
};

// ----------------------------------------------------------------------------
// URL parsing minimalista. Para nuestro caso (http://host[:port][/path])
// no necesitamos un parser completo. Devuelve {scheme, host, port, path}
// o lanza std::runtime_error si la URL no encaja.
// ----------------------------------------------------------------------------
struct ParsedUrl {
    std::string scheme;
    std::string host;
    int port = 0;
    std::string path;
};

inline ParsedUrl parseUrl(const std::string& url) {
    ParsedUrl out;
    const std::string schemeSep = "://";
    const auto schemeEnd = url.find(schemeSep);
    if (schemeEnd == std::string::npos) {
        throw std::runtime_error("URL sin esquema: " + url);
    }
    out.scheme = url.substr(0, schemeEnd);
    for (auto& c : out.scheme) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
    std::size_t hostStart = schemeEnd + schemeSep.size();
    const auto pathStart = url.find('/', hostStart);
    std::string hostPort = (pathStart == std::string::npos)
        ? url.substr(hostStart)
        : url.substr(hostStart, pathStart - hostStart);
    out.path = (pathStart == std::string::npos) ? std::string("/") : url.substr(pathStart);

    const auto colon = hostPort.find(':');
    if (colon == std::string::npos) {
        out.host = hostPort;
        out.port = (out.scheme == "https") ? 443 : 80;
    } else {
        out.host = hostPort.substr(0, colon);
        out.port = std::stoi(hostPort.substr(colon + 1));
    }
    if (out.host.empty()) {
        throw std::runtime_error("URL sin host: " + url);
    }
    return out;
}

// ----------------------------------------------------------------------------
// httpClientGet / httpClientPost — envuelven httplib::Client. Devuelven
// Result<HttpClientResponse, string> como en el V28.
// ----------------------------------------------------------------------------
inline Result<HttpClientResponse> httpClientGet(const std::string& url) {
    ParsedUrl parsed;
    try {
        parsed = parseUrl(url);
    } catch (const std::exception& e) {
        return Result<HttpClientResponse>::failure(std::string("URL invalida: ") + e.what());
    }
    if (parsed.scheme == "https") {
#ifndef CPPHTTPLIB_OPENSSL_SUPPORT
        return Result<HttpClientResponse>::failure(
            "HTTPS requiere definir CPPHTTPLIB_OPENSSL_SUPPORT antes de incluir "
            "runtime/ets_http_httplib_client.hpp");
#else
        httplib::SSLClient cli(parsed.host, parsed.port);
        cli.set_connection_timeout(10, 0);
        auto res = cli.Get(parsed.path);
        if (!res) return Result<HttpClientResponse>::failure("GET " + url + " fallo (red o timeout)");
        HttpClientResponse out;
        out.status_ = res->status;
        out.body_ = res->body;
        for (const auto& kv : res->headers) out.headers_.insert(kv);
        return Result<HttpClientResponse>::success(std::move(out));
#endif
    } else {
        httplib::Client cli(parsed.host, parsed.port);
        cli.set_connection_timeout(10, 0);
        auto res = cli.Get(parsed.path);
        if (!res) return Result<HttpClientResponse>::failure("GET " + url + " fallo (red o timeout)");
        HttpClientResponse out;
        out.status_ = res->status;
        out.body_ = res->body;
        for (const auto& kv : res->headers) out.headers_.insert(kv);
        return Result<HttpClientResponse>::success(std::move(out));
    }
}

inline Result<HttpClientResponse> httpClientPost(const std::string& url,
                                                const std::string& body,
                                                const std::string& contentType) {
    ParsedUrl parsed;
    try {
        parsed = parseUrl(url);
    } catch (const std::exception& e) {
        return Result<HttpClientResponse>::failure(std::string("URL invalida: ") + e.what());
    }
    const std::string ct = contentType.empty() ? std::string("application/octet-stream") : contentType;
    if (parsed.scheme == "https") {
#ifndef CPPHTTPLIB_OPENSSL_SUPPORT
        return Result<HttpClientResponse>::failure(
            "HTTPS requiere definir CPPHTTPLIB_OPENSSL_SUPPORT");
#else
        httplib::SSLClient cli(parsed.host, parsed.port);
        cli.set_connection_timeout(10, 0);
        auto res = cli.Post(parsed.path, body, ct);
        if (!res) return Result<HttpClientResponse>::failure("POST " + url + " fallo (red o timeout)");
        HttpClientResponse out;
        out.status_ = res->status;
        out.body_ = res->body;
        for (const auto& kv : res->headers) out.headers_.insert(kv);
        return Result<HttpClientResponse>::success(std::move(out));
#endif
    } else {
        httplib::Client cli(parsed.host, parsed.port);
        cli.set_connection_timeout(10, 0);
        auto res = cli.Post(parsed.path, body, ct);
        if (!res) return Result<HttpClientResponse>::failure("POST " + url + " fallo (red o timeout)");
        HttpClientResponse out;
        out.status_ = res->status;
        out.body_ = res->body;
        for (const auto& kv : res->headers) out.headers_.insert(kv);
        return Result<HttpClientResponse>::success(std::move(out));
    }
}

}  // namespace ets
