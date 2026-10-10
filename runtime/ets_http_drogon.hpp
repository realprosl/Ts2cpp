// runtime/ets_http_drogon.hpp — Server HTTP/1.1 sobre Drogon.
//
// Drogon es un framework HTTP C++17 de alto rendimiento basado en
// trantor (event loop propio sobre epoll/kqueue/IOCP). ~150-200k req/s
// con el setup por defecto. Lo activamos cuando el usuario anade
// el decorator `@cpp_drogon` en su .ets, o configura el flag
// `cpp_drogon = true` en su tsconfig. Sin el flag, el builder usa
// runtime/ets_http_httplib.hpp (ver PR #150).
//
// Compilacion:
//   g++ -std=c++20 -I. programa.cpp \
//       -ldrogon -ltrantor -ljsoncpp -lpthread -lssl -lcrypto -lresolv \
//       -I/usr/include/jsoncpp -o programa
//
// El json/cpp include path es necesario porque Drogon 1.8.x en
// Ubuntu/Debian instala jsoncpp en /usr/include/jsoncpp (no
// /usr/include). El Makefile del builder lo gestiona.
//
// API del dialecto: IDENTICA a la del wrapper httplib. Mismos tipos
// ets::HttpRequest, ets::HttpResponse, ets::Server. Mismos helpers
// ets::http_param/query/header. El codegen del dialecto no sabe que
// backend esta usando; solo ve Server y sus metodos.

#pragma once

#include <drogon/drogon.h>

#include <cstddef>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace ets {

// ----------------------------------------------------------------------------
// HttpRequest / HttpResponse — structs planos con la misma forma que
// los del wrapper httplib, para que el codegen del dialecto no note
// la diferencia. Se construyen desde los pointers de Drogon.
// ----------------------------------------------------------------------------
struct HttpRequest {
    // Path params (Drogon los expone via getParameter con claves "1", "2"...)
    // y query params (via getParameter con el nombre del param). En este
    // wrapper los unificamos en un solo map con claves string.
    std::map<std::string, std::string> params;
    // Query string cruda (sin parsear) por si la quiere el usuario.
    std::string rawQuery;
    // Headers normalizados a minusculas para lookup case-insensitive.
    std::map<std::string, std::string> headers;
    // Body como string (Drogon devuelve string_view, lo copiamos).
    std::string body;
    // Metodo HTTP en mayusculas ("GET", "POST", ...).
    std::string method;
    // Path sin query string.
    std::string path;
};

struct HttpResponse {
    int statusCode = 200;
    std::map<std::string, std::string> headers;
    std::string body;

    // API encadenable estilo express. Devuelven *this para que el
    // usuario pueda hacer res.status(201).header("X","Y").send("ok").
    HttpResponse& status(int code) { statusCode = code; return *this; }
    HttpResponse& header(const std::string& name, const std::string& value) {
        headers[name] = value;
        return *this;
    }
    // send(body) envia la respuesta. En Drogon esto se hace via callback;
    // aqui lo marcamos en el body y dejamos que el wrapper lo envie al
    // final del handler.
    HttpResponse& send(const std::string& b) { body = b; return *this; }
    HttpResponse& json(const std::string& j) { body = j; headers["Content-Type"] = "application/json"; return *this; }
};

// Tipo del handler que el codegen del dialecto registra. Misma firma
// que el wrapper httplib: recibe (const HttpRequest&, HttpResponse&).
using RouteHandler = std::function<void(const HttpRequest&, HttpResponse&)>;

// ----------------------------------------------------------------------------
// Server — clase con API express-style. En Drogon no podemos tener
// multiples servers en el mismo proceso (es un singleton global,
// `drogon::app()`), asi que esta clase solo guarda configuracion y
// los handlers. El listen() los registra en drogon::app() y llama a
// run() bloqueante.
// ----------------------------------------------------------------------------
class Server {
public:
    Server() = default;
    ~Server() = default;
    Server(Server&&) = default;
    Server& operator=(Server&&) = default;
    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    // Cada metodo HTTP se registra con un handler independiente en
    // Drogon (Drogon no soporta un handler unico para multiples
    // metodos en la misma ruta, salvo via registerHandlerViaRegex
    // que es mas complejo). La traduccion del patron del dialecto
    // (/users/:id) al patron de Drogon (/users/{1}) es trivial.
    Server& get(const std::string& path, RouteHandler handler) {
        return add(drogon::Get, path, std::move(handler));
    }
    Server& post(const std::string& path, RouteHandler handler) {
        return add(drogon::Post, path, std::move(handler));
    }
    Server& put(const std::string& path, RouteHandler handler) {
        return add(drogon::Put, path, std::move(handler));
    }
    Server& patch(const std::string& path, RouteHandler handler) {
        return add(drogon::Patch, path, std::move(handler));
    }
    Server& del(const std::string& path, RouteHandler handler) {
        return add(drogon::Delete, path, std::move(handler));
    }

    // Arranca el server. Bloquea hasta SIGINT.
    void listen(int port) { listen("0.0.0.0", port); }
    void listen(const std::string& host, int port) {
        auto& app = drogon::app();
        app.addListener(host, port);
        // Drogon 1.8.x loggea a stdout por defecto. Para tests
        // silenciosos podemos desactivarlo:
        app.setLogLevel(trantor::Logger::kWarn);
        app.run();
    }

private:
    // Convierte `/users/:id` -> `/users/{1}`. Tambien recoge los
    // nombres de los params en orden para mapearlos en invokeHandler.
    static std::string toDrogonPattern(const std::string& path,
                                       std::vector<std::string>& outNames) {
        std::string out;
        out.reserve(path.size() + 8);
        std::string currentName;
        bool inParam = false;
        for (char c : path) {
            if (c == ':' && !inParam) {
                inParam = true;
                currentName.clear();
            } else if (c == '/' && inParam) {
                if (!currentName.empty()) {
                    outNames.push_back(currentName);
                    out += '{';
                    out += std::to_string(outNames.size());
                    out += '}';
                }
                inParam = false;
                out += '/';
            } else if (inParam) {
                currentName.push_back(c);
            } else {
                out += c;
            }
        }
        if (inParam && !currentName.empty()) {
            outNames.push_back(currentName);
            out += '{';
            out += std::to_string(outNames.size());
            out += '}';
        }
        return out;
    }

    Server& add(drogon::HttpMethod method, const std::string& path,
                RouteHandler handler) {
        std::vector<std::string> names;
        std::string drogonPath = toDrogonPattern(path, names);
        if (names.empty()) {
            // Sin placeholders: registerHandler normal.
            registerSimple_(method, drogonPath, names, std::move(handler));
        } else {
            // Con placeholders: regex que captura los segmentos
            // variables. drogonPath tiene {1}..{N}; los cambiamos por
            // ([^/]+) para capturar el valor.
            std::string regex = drogonPath;
            for (std::size_t i = names.size(); i >= 1; --i) {
                std::string token = "{" + std::to_string(i) + "}";
                std::size_t pos = regex.find(token);
                if (pos != std::string::npos) {
                    regex.replace(pos, token.size(), "([^/]+)");
                }
            }
            registerSimple_(method, regex, names, std::move(handler));
        }
        return *this;
    }

    // Wrapper comun para registerHandler sin/con placeholders.
    // Si names.empty() (sin placeholders), la lambda NO tiene
    // parametros extra; Drogon no intentara bindear nada.
    // Si names.size() == N, la lambda tiene N parametros extra
    // que Drogon llena con los captures del regex.
    void registerSimple_(drogon::HttpMethod method,
                         const std::string& path,
                         const std::vector<std::string>& names,
                         RouteHandler handler) {
        // Si no hay placeholders usamos registerHandler (path literal).
        // Si hay placeholders usamos registerHandlerViaRegex con
        // un regex que captura los segmentos variables.
        const bool isRegex = !names.empty();
        auto& app = drogon::app();
        if (!isRegex) {
            app.registerHandler(
                path,
                [h = std::move(handler)]
                (const drogon::HttpRequestPtr& dreq,
                 std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
                    cb(invokeHandler_(dreq, h));
                },
                {method});
        } else if (names.size() == 1) {
            app.registerHandlerViaRegex(
                path,
                [h = std::move(handler), n0 = names[0]]
                (const drogon::HttpRequestPtr& dreq,
                 std::function<void(const drogon::HttpResponsePtr&)>&& cb,
                 const std::string& p0) {
                    cb(invokeHandler_(dreq, h, {{n0, p0}}));
                },
                {method});
        } else if (names.size() == 2) {
            app.registerHandlerViaRegex(
                path,
                [h = std::move(handler), n0 = names[0], n1 = names[1]]
                (const drogon::HttpRequestPtr& dreq,
                 std::function<void(const drogon::HttpResponsePtr&)>&& cb,
                 const std::string& p0, const std::string& p1) {
                    cb(invokeHandler_(dreq, h, {{n0, p0}, {n1, p1}}));
                },
                {method});
        } else if (names.size() == 3) {
            app.registerHandlerViaRegex(
                path,
                [h = std::move(handler), n0 = names[0], n1 = names[1], n2 = names[2]]
                (const drogon::HttpRequestPtr& dreq,
                 std::function<void(const drogon::HttpResponsePtr&)>&& cb,
                 const std::string& p0, const std::string& p1, const std::string& p2) {
                    cb(invokeHandler_(dreq, h, {{n0, p0}, {n1, p1}, {n2, p2}}));
                },
                {method});
        } else {
            // Para >3 placeholders: error en runtime (no deberia
            // pasar en programas reales).
            throw std::runtime_error("ets_http_drogon: max 3 path params por ruta");
        }
    }

    // Adapta una peticion Drogon a HttpRequest del dialecto, invoca
    // el handler, y convierte la HttpResponse resultante en una
    // Drogon HttpResponsePtr.
    static drogon::HttpResponsePtr invokeHandler_(
        const drogon::HttpRequestPtr& dreq,
        const RouteHandler& h,
        std::initializer_list<std::pair<const std::string, std::string>> pathParams = {}) {
        HttpRequest req;
        for (const auto& kv : pathParams) req.params.insert(kv);
        req.rawQuery = std::string(dreq->getQuery());
        for (const auto& kv : dreq->getHeaders()) {
            std::string lower = kv.first;
            for (auto& c : lower) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
            req.headers[lower] = kv.second;
        }
        req.body = std::string(dreq->getBody());
        req.method = dreq->getMethodString();
        req.path = dreq->getPath();
        HttpResponse res;
        h(req, res);
        auto dres = drogon::HttpResponse::newHttpResponse();
        dres->setStatusCode(static_cast<drogon::HttpStatusCode>(res.statusCode));
        if (!res.body.empty()) dres->setBody(std::move(res.body));
        // Drogon pone un Content-Type por defecto (text/html). Si el
        // usuario lo sobreescribe via res.header("Content-Type", ...),
        // tenemos que quitar el default para que no se duplique.
        bool hasContentType = false;
        for (const auto& kv : res.headers) {
            if (kv.first == "Content-Type" || kv.first == "content-type") {
                hasContentType = true; break;
            }
        }
        if (hasContentType) {
            dres->setContentTypeString("");  // limpia el default
        }
        for (auto& kv : res.headers) dres->addHeader(kv.first, kv.second);
        return dres;
    }
};

// ----------------------------------------------------------------------------
// Helpers expuestos al dialecto via `http.param(req, name)` etc.
// Misma firma que el wrapper httplib. Para query string tenemos que
// parsear `req.rawQuery` porque Drogon no la expone parseada (aunque
// getParameter() busca en query, no nos da el listado completo).
// ----------------------------------------------------------------------------

// Parsea una query string tipo "a=3&b=4" en un map. No URL-decodea
// por simplicidad (los handlers del dialecto testean valores literales).
inline std::map<std::string, std::string> parseQueryString(const std::string& qs) {
    std::map<std::string, std::string> out;
    std::string key, value;
    bool inKey = true;
    for (char c : qs) {
        if (c == '&') {
            if (!key.empty()) out[key] = value;
            key.clear(); value.clear(); inKey = true;
        } else if (c == '=' && inKey) {
            inKey = false;
        } else if (inKey) {
            key.push_back(c);
        } else {
            value.push_back(c);
        }
    }
    if (!key.empty()) out[key] = value;
    return out;
}

inline std::string http_param(const HttpRequest& req, const std::string& name) {
    const auto it = req.params.find(name);
    return it == req.params.end() ? std::string() : it->second;
}

inline std::string http_query(const HttpRequest& req, const std::string& name) {
    static thread_local std::map<std::string, std::map<std::string, std::string>> cache;
    const auto& parsed = cache[req.rawQuery];
    if (!parsed.empty() || req.rawQuery.empty()) {
        const auto it = parsed.find(name);
        return it == parsed.end() ? std::string() : it->second;
    }
    // Cache miss: parseamos y guardamos
    auto fresh = parseQueryString(req.rawQuery);
    const auto it = fresh.find(name);
    const std::string value = (it == fresh.end()) ? std::string() : it->second;
    cache[req.rawQuery] = std::move(fresh);
    return value;
}

inline std::string http_header(const HttpRequest& req, const std::string& name) {
    std::string lower = name;
    for (auto& c : lower) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
    const auto it = req.headers.find(lower);
    return it == req.headers.end() ? std::string() : it->second;
}

}  // namespace ets
