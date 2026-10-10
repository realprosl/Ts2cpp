// runtime/ets_http_curl_client.hpp — Cliente HTTP/1.1+ sobre libcurl.
//
// Sustituye al cliente sobre TCP plano de runtime/ets_http_client.hpp
// (V28). libcurl nos da HTTP/1.1, HTTPS, HTTP/2, redirects automaticos,
// connection pooling, timeouts, decompression, todo built-in y
// battle-tested (es lo que usan git, docker, slack, aws-cli, etc).
//
// API del dialecto: IDENTICA a la del cliente V28. El codegen del
// dialecto NO nota la diferencia:
//
//   let r = http.get("http://example.com/path")
//   match (r) {
//     Result.Ok(v) => print("status=" + numberToString(v.status()))
//     Result.Err(e) => print("error: " + e)
//   }
//
// Compilacion:
//   g++ -std=c++20 -I. programa.cpp -lcurl -o programa
//
// El link con -lcurl es automatico. Para HTTPS no hay que hacer
// nada extra: libcurl-openssl-dev ya esta linkado por defecto.

#pragma once

#include <curl/curl.h>

#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace ets {

// ----------------------------------------------------------------------------
// HttpClientResponse — struct plano con el resultado de un request.
// Accesores estilo metodo (status_code(), body_str(), header(name))
// para que el codegen del dialecto pueda traducir status()/body()/header()
// sin ambiguedad con campos.
// ----------------------------------------------------------------------------
struct HttpClientResponse {
    int status_code() const { return status_; }
    const std::string& body_str() const { return body_; }
    std::string header(const std::string& name) const {
        // Headers en libcurl son case-insensitive en lookup: el user
        // puede pedir "Content-Type" o "content-type" indistintamente.
        for (const auto& kv : headers_) {
            if (strcasecmp(kv.first.c_str(), name.c_str()) == 0) {
                return kv.second;
            }
        }
        return std::string();
    }

    int status_ = 0;
    std::string body_;
    std::vector<std::pair<std::string, std::string>> headers_;
};

// ----------------------------------------------------------------------------
// libcurl global init/cleanup. Una vez por proceso. RAII via CurLGlobal_.
// ----------------------------------------------------------------------------
namespace detail {
inline void ensureCurlGlobalInit() {
    static std::once_flag once;
    std::call_once(once, []() { curl_global_init(CURL_GLOBAL_DEFAULT); });
}
}  // namespace detail

// ----------------------------------------------------------------------------
// httpClientGet / httpClientPost — envuelven curl_easy. Bloqueantes
// (mismo modelo que el V28). Para async real usar curl_multi, que
// sera un PR siguiente si hace falta.
// ----------------------------------------------------------------------------
namespace detail {

// Buffer de escritura que crece con cada llamada al callback.
struct WriteBuf {
    std::string data;
};
inline size_t curlWriteCb(char* p, size_t s, size_t n, void* ud) {
    auto* b = static_cast<WriteBuf*>(ud);
    b->data.append(p, s * n);
    return s * n;
}

// Header callback: cada header llega como una linea "Name: Value\r\n".
// Guardamos todos en el response para que header(name) funcione.
inline size_t curlHeaderCb(char* p, size_t s, size_t n, void* ud) {
    auto* out = static_cast<HttpClientResponse*>(ud);
    const std::size_t total = s * n;
    std::string line(p, total);
    // Quita \r\n al final si los tiene.
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) {
        line.pop_back();
    }
    // Ignora lineas de status (HTTP/1.1 200 OK) y lineas vacias.
    if (line.empty()) return total;
    if (line.compare(0, 5, "HTTP/") == 0) return total;
    const auto colon = line.find(':');
    if (colon == std::string::npos) return total;
    std::string name = line.substr(0, colon);
    std::string value = line.substr(colon + 1);
    // Trim leading whitespace del value.
    std::size_t vs = 0;
    while (vs < value.size() && (value[vs] == ' ' || value[vs] == '\t')) ++vs;
    value = value.substr(vs);
    out->headers_.emplace_back(std::move(name), std::move(value));
    return total;
}

inline CURL* makeEasyHandle(const std::string& url, long timeoutSec = 10) {
    CURL* h = curl_easy_init();
    if (!h) throw std::runtime_error("curl_easy_init failed");
    curl_easy_setopt(h, CURLOPT_URL, url.c_str());
    curl_easy_setopt(h, CURLOPT_TIMEOUT, timeoutSec);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT, timeoutSec);
    curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);  // thread-safe
    curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 1L);  // redirects
    curl_easy_setopt(h, CURLOPT_MAXREDIRS, 5L);
    curl_easy_setopt(h, CURLOPT_ACCEPT_ENCODING, "");  // gzip/deflate
    return h;
}

}  // namespace detail

// Result<T> en namespace ets. Mismo nombre que el de ets_async.hpp
// para mantener compatibilidad con el codegen del dialecto. El
// `ETS_RESULT_DEFINED` evita redefinition cuando el dialecto ya
// incluye ets_async.hpp (via ets_runtime_full.hpp).
#ifndef ETS_RESULT_DEFINED
#define ETS_RESULT_DEFINED 1
namespace ets {
template <typename T>
class [[nodiscard]] Result {
public:
    static Result success(T value) { return Result{std::move(value), {}}; }
    static Result failure(std::string error) { return Result{{}, std::move(error)}; }
    bool isOk() const noexcept { return value_.has_value(); }
    T& value() & { if (!value_) std::abort(); return *value_; }
    const T& value() const & { if (!value_) std::abort(); return *value_; }
    T&& value() && { if (!value_) std::abort(); return std::move(*value_); }
    const std::string& error() const noexcept { return error_; }

private:
    Result(std::optional<T> value, std::string error) : value_(std::move(value)), error_(std::move(error)) {}
    std::optional<T> value_;
    std::string error_;
};
}  // namespace ets
#endif

inline Result<HttpClientResponse> httpClientGet(const std::string& url) {
    detail::ensureCurlGlobalInit();
    CURL* h = nullptr;
    try {
        h = detail::makeEasyHandle(url);
    } catch (const std::exception& e) {
        return Result<HttpClientResponse>::failure(std::string("curl init: ") + e.what());
    }
    detail::WriteBuf wb;
    HttpClientResponse resp;
    curl_easy_setopt(h, CURLOPT_HTTPGET, 1L);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, detail::curlWriteCb);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &wb);
    curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, detail::curlHeaderCb);
    curl_easy_setopt(h, CURLOPT_HEADERDATA, &resp);
    CURLcode rc = curl_easy_perform(h);
    if (rc != CURLE_OK) {
        std::string err = "GET " + url + " failed: ";
        err += curl_easy_strerror(rc);
        curl_easy_cleanup(h);
        return Result<HttpClientResponse>::failure(std::move(err));
    }
    long status = 0;
    curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &status);
    resp.status_ = static_cast<int>(status);
    resp.body_ = std::move(wb.data);
    curl_easy_cleanup(h);
    return Result<HttpClientResponse>::success(std::move(resp));
}

inline Result<HttpClientResponse> httpClientPost(const std::string& url,
                                                const std::string& body,
                                                const std::string& contentType) {
    detail::ensureCurlGlobalInit();
    CURL* h = nullptr;
    try {
        h = detail::makeEasyHandle(url);
    } catch (const std::exception& e) {
        return Result<HttpClientResponse>::failure(std::string("curl init: ") + e.what());
    }
    detail::WriteBuf wb;
    HttpClientResponse resp;
    curl_easy_setopt(h, CURLOPT_POST, 1L);
    curl_easy_setopt(h, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    struct curl_slist* headers = nullptr;
    if (!contentType.empty()) {
        const std::string h = "Content-Type: " + contentType;
        headers = curl_slist_append(headers, h.c_str());
    }
    if (headers) curl_easy_setopt(h, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, detail::curlWriteCb);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &wb);
    curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, detail::curlHeaderCb);
    curl_easy_setopt(h, CURLOPT_HEADERDATA, &resp);
    CURLcode rc = curl_easy_perform(h);
    if (headers) curl_slist_free_all(headers);
    if (rc != CURLE_OK) {
        std::string err = "POST " + url + " failed: ";
        err += curl_easy_strerror(rc);
        curl_easy_cleanup(h);
        return Result<HttpClientResponse>::failure(std::move(err));
    }
    long status = 0;
    curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &status);
    resp.status_ = static_cast<int>(status);
    resp.body_ = std::move(wb.data);
    curl_easy_cleanup(h);
    return Result<HttpClientResponse>::success(std::move(resp));
}

}  // namespace ets
