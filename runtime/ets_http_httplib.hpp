// runtime/ets_http_httplib.hpp — Servidor HTTP/1.1 sobre cpp-httplib.
//
// cpp-httplib es una libreria C++11 header-only que implementa HTTP/1.1
// server + client. La vendoreamos en runtime/external/httplib/httplib.h
// y la usamos como **backend default** del dialecto (cuando el usuario
// no anade el decorator @cpp_drogon). El backend Drogon (alto
// rendimiento) vive en runtime/ets_http_drogon.hpp.
//
// API del dialecto: identica a la del backend V28 (ets_http_server.hpp).
// Internamente traduce cada handler a un svr.Get/Post/... de cpp-httplib
// con un adapter entre la HttpRequest/HttpResponse del dialecto y la
// httplib::Request/Response de la lib.
//
// Compilacion:
//   g++ -std=c++20 -I. programa.cpp \
//       runtime/external/httplib/httplib.cc \
//       -lpthread -o programa
//
// HTTPS (opcional):
//   Define CPPHTTPLIB_OPENSSL_SUPPORT antes del include y anade
//   -lssl -lcrypto al link. Ver runtime/ets_http_httplib_tls.hpp
//   (en un PR aparte) para una API que active TLS segun el decorator
//   del dialecto.

#pragma once

// Antes de incluir httplib, garantizamos que split-compile funciona
// correctamente cuando el usuario nos usa header-only sin definir la
// macro: usamos la propia macro de la lib (HTTPLIB_DETAIL_NS_BEGIN)
// para auto-detectar. En este caso, dado que el runner e2e linka
// httplib.cc, este header no emite codigo; solo declaraciones.
#include "external/httplib/httplib.h"

#include <cctype>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <regex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
namespace ets {

// ----------------------------------------------------------------------------
// HttpRequest — datos del request HTTP pre-parseados. Identica a la del
// backend V28, para que el dialecto no note la diferencia.
// ----------------------------------------------------------------------------
struct HttpRequest {
    std::string method;                                  // "GET", "POST", ...
    std::string path;                                    // "/api/users"
    std::string rawQuery;                                // "id=42&name=alice"
    std::map<std::string, std::string> params;           // path params
    std::map<std::string, std::string> query;            // query string
    std::map<std::string, std::string> headers;          // lowercase keys
    std::string body;
};

// ----------------------------------------------------------------------------
// HttpResponse — builder encadenable. Identica a la del backend V28.
// ----------------------------------------------------------------------------
class HttpResponse {
public:
    HttpResponse() = default;

    HttpResponse& status(int code) { status_ = code; return *this; }
    HttpResponse& header(const std::string& name, const std::string& value) {
        std::string lower = name;
        for (auto& c : lower) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
        headers_[lower] = value;
        return *this;
    }
    HttpResponse& send(const std::string& body) {
        body_ = body;
        if (headers_.find("content-type") == headers_.end()) {
            header("Content-Type", "text/plain; charset=utf-8");
        }
        return *this;
    }
    HttpResponse& json(const std::string& jsonString) {
        body_ = jsonString;
        if (headers_.find("content-type") == headers_.end()) {
            header("Content-Type", "application/json");
        }
        return *this;
    }

    int status_code() const { return status_; }
    const std::string& body_str() const { return body_; }
    const std::map<std::string, std::string>& headers_map() const { return headers_; }

private:
    int status_ = 200;
    std::string body_;
    std::map<std::string, std::string> headers_;
};

// ----------------------------------------------------------------------------
// Server — clase con API express-style. Envuelve httplib::Server.
// Se llama `Server` (no `Server`) para que el codegen del dialecto
// (que mapea "Server" -> "ets::Server" en cpp-types) no necesite cambios.
//
// httplib::Server NO es copiable (su threadpool interno no lo permite),
// asi que lo mantenemos en un unique_ptr para que `ets::Server` tampoco
// lo sea implicitamente, pero el codegen (que emite `server = Server()`)
// pueda asignar moviendolo. Constructor por defecto -> heap alloc.
// ----------------------------------------------------------------------------
class Server {
public:
    Server() : impl_(std::make_unique<httplib::Server>()) {}
    ~Server() = default;
    Server(Server&& other) noexcept = default;
    Server& operator=(Server&& other) noexcept = default;
    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    // GET / POST / PUT / PATCH / DELETE con handler estilo express.
    using RouteHandler = std::function<void(const HttpRequest&, HttpResponse&)>;

    Server& get(const std::string& path, RouteHandler handler) {
        registerRoute("GET", path, std::move(handler));
        return *this;
    }
    Server& post(const std::string& path, RouteHandler handler) {
        registerRoute("POST", path, std::move(handler));
        return *this;
    }
    Server& put(const std::string& path, RouteHandler handler) {
        registerRoute("PUT", path, std::move(handler));
        return *this;
    }
    Server& patch(const std::string& path, RouteHandler handler) {
        registerRoute("PATCH", path, std::move(handler));
        return *this;
    }
    Server& del(const std::string& path, RouteHandler handler) {
        registerRoute("DELETE", path, std::move(handler));
        return *this;
    }

    // Arranca el server en host:port. Bloquea hasta SIGINT.
    void listen(int port) { listen("0.0.0.0", port); }
    void listen(const std::string& host, int port) {
        impl_->listen(host.c_str(), port);
    }

    // Acceso al impl para tests / integracion.
    httplib::Server& impl() { return *impl_; }

private:
    // Convierte el patron del dialecto (`/users/:id`) a regex de cpp-httplib
    // (`/users/([^/]+)`) y registra los nombres de path params para extraer
    // despues del match.
    void registerRoute(const std::string& method,
                       const std::string& path,
                       RouteHandler handler) {
        std::string regex = pathToRegex(path, &paramNames_);
        auto methodLower = method;
        for (auto& c : methodLower) c = ::tolower(c);

        // Captura por valor: cada handler se queda con su propia lista
        // de param names.
        auto names = paramNames_;
        auto h = std::move(handler);

        if (methodLower == "get") {
            impl_->Get(regex, [h, names](const httplib::Request& req, httplib::Response& res) {
                invokeHandler("GET", req, res, h, names);
            });
        } else if (methodLower == "post") {
            impl_->Post(regex, [h, names](const httplib::Request& req, httplib::Response& res) {
                invokeHandler("POST", req, res, h, names);
            });
        } else if (methodLower == "put") {
            impl_->Put(regex, [h, names](const httplib::Request& req, httplib::Response& res) {
                invokeHandler("PUT", req, res, h, names);
            });
        } else if (methodLower == "patch") {
            impl_->Patch(regex, [h, names](const httplib::Request& req, httplib::Response& res) {
                invokeHandler("PATCH", req, res, h, names);
            });
        } else if (methodLower == "delete") {
            impl_->Delete(regex, [h, names](const httplib::Request& req, httplib::Response& res) {
                invokeHandler("DELETE", req, res, h, names);
            });
        }
    }

    static void invokeHandler(const std::string& method,
                              const httplib::Request& httpreq,
                              httplib::Response& httpres,
                              const RouteHandler& h,
                              const std::vector<std::string>& paramNames) {
        // Adaptador httplib::Request -> HttpRequest.
        HttpRequest req;
        req.method = method;
        // cpp-httplib separa path/query en `path` y `params`. `path` ya
        // viene sin query string.
        req.path = httpreq.path;
        // Reconstruimos rawQuery a partir de httpreq.params para que el
        // dialecto siga teniendo el string original.
        if (!httpreq.params.empty()) {
            std::string q;
            bool first = true;
            for (const auto& kv : httpreq.params) {
                if (!first) q += "&";
                q += urlEncode(kv.first) + "=" + urlEncode(kv.second);
                first = false;
            }
            req.rawQuery = q;
        }
        // Path params (capturados por el regex del routing).
        for (std::size_t i = 0; i < paramNames.size() && i + 1 < httpreq.matches.size(); ++i) {
            req.params[paramNames[i]] = httpreq.matches[i + 1].str();
        }
        // Query params (cpp-httplib ya los parseo).
        for (const auto& kv : httpreq.params) {
            req.query.emplace(kv.first, kv.second);
        }
        // Headers (lowercase keys)
        for (const auto& kv : httpreq.headers) {
            std::string lower = kv.first;
            for (auto& c : lower) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
            req.headers[lower] = kv.second;
        }
        req.body = httpreq.body;

        // Invoca el handler.
        HttpResponse res;
        h(req, res);

        // Adaptador HttpResponse -> httplib::Response.
        httpres.status = res.status_code();
        for (const auto& kv : res.headers_map()) {
            httpres.set_header(kv.first, kv.second);
        }
        httpres.body = res.body_str();
    }

    // Convierte `/users/:id/posts/:postId` -> `/users/([^/]+)/posts/([^/]+)`.
    // Los nombres (`:id`, `:postId`) se devuelven en `paramNames` en orden.
    static std::string pathToRegex(const std::string& path,
                                   std::vector<std::string>* paramNames) {
        std::string out = "^";
        for (std::size_t i = 0; i < path.size(); ++i) {
            if (path[i] == ':' && i + 1 < path.size() && path[i + 1] != '/') {
                std::size_t end = i + 1;
                while (end < path.size() && path[end] != '/') ++end;
                paramNames->push_back(path.substr(i + 1, end - i - 1));
                out += "([^/]+)";
                i = end - 1;
            } else {
                // Escapa metacaracteres de regex.
                if (std::string(".+*?()[]{}|^$\\").find(path[i]) != std::string::npos) {
                    out.push_back('\\');
                }
                out.push_back(path[i]);
            }
        }
        out += "$";
        return out;
    }

    static std::string urlDecode(const std::string& s) {
        std::string out;
        out.reserve(s.size());
        for (std::size_t i = 0; i < s.size(); ++i) {
            if (s[i] == '%' && i + 2 < s.size()) {
                auto hex = [](char c) -> int {
                    if (c >= '0' && c <= '9') return c - '0';
                    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                    return -1;
                };
                const int hi = hex(s[i + 1]);
                const int lo = hex(s[i + 2]);
                if (hi >= 0 && lo >= 0) {
                    out.push_back(static_cast<char>((hi << 4) | lo));
                    i += 2;
                    continue;
                }
            }
            if (s[i] == '+') out.push_back(' ');
            else out.push_back(s[i]);
        }
        return out;
    }

    static std::string urlEncode(const std::string& s) {
        std::string out;
        out.reserve(s.size());
        for (unsigned char c : s) {
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
                out.push_back(static_cast<char>(c));
            } else {
                static const char hex[] = "0123456789ABCDEF";
                out.push_back('%');
                out.push_back(hex[c >> 4]);
                out.push_back(hex[c & 0xF]);
            }
        }
        return out;
    }

    std::unique_ptr<httplib::Server> impl_;
    std::vector<std::string> paramNames_;
};

// ----------------------------------------------------------------------------
// Helpers expuestos al dialecto via `http.param(req, name)` etc.
// Mantienen la misma firma que la version V28 para que el codegen no
// necesite cambiar.
// ----------------------------------------------------------------------------
inline std::string http_param(const HttpRequest& req, const std::string& name) {
    const auto it = req.params.find(name);
    return it == req.params.end() ? std::string() : it->second;
}

inline std::string http_query(const HttpRequest& req, const std::string& name) {
    const auto it = req.query.find(name);
    return it == req.query.end() ? std::string() : it->second;
}

inline std::string http_header(const HttpRequest& req, const std::string& name) {
    const auto it = req.headers.find(name);
    return it == req.headers.end() ? std::string() : it->second;
}

}  // namespace ets
