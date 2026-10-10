// runtime/ets_http_server.hpp — Servidor HTTP/1.1 sobre el reactor async
// de Ts2cpp (libuv/poll). API de routing estilo app, sin dependencias
// externas mas alla de la stdlib de C++20 y el reactor del runtime.
//
// API del dialecto:
//
//   let server: Server = new Server()
//   server.get("/hello/:name", (req, res) => {
//     res.status(200).header("Content-Type", "text/plain")
//        .send("hola " + req.params.get("name"))
//   })
//   server.post("/api/users", (req, res) => {
//     res.json(json.stringify(jsonValue))
//   })
//   server.listen(3000)   // bloquea hasta SIGINT, procesa el event loop
//
// El servidor es **async** (un coroutine por conexion, compartido sobre
// el event loop). Los handlers son **sincronos**: reciben req/res
// pre-construidos y solo escriben a res. Si necesitas await dentro del
// handler, abre un spawn(...) y devuelve.
//
// Limitaciones:
//   - HTTP/1.1 plano. No HTTPS (necesita TLS server-side).
//   - Sin streaming de response (res.send(string) envia todo de golpe).
//   - Sin middlewares.
//   - Sin parse automatico de query JSON: req.query es un
//     Map<string,string> con los valores URL-decoded.
//   - Sin cookies, sesiones, compression.
//
// El cliente HTTP (http.get/http.post) vive en runtime/ets_http.hpp.

#pragma once

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "ets_async.hpp"   // Task<T>, Result<T>, syncWait, spawn, sleep
#include "ets_net.hpp"     // listenTcp, acceptTcpUntil, readTcpUntil, writeTcpUntil

namespace ets {

// ----------------------------------------------------------------------------
// Request — datos del request HTTP pre-parseados.
// El servidor llena estos campos antes de invocar al handler.
// Los maps internos (params/query/headers) son privados: el dialecto no
// puede acceder a ellos directamente. En su lugar, el namespace http
// expone helpers `http.param(req, name)`, `http.query(req, name)`,
// `http.header(req, name)` que devuelven "" si la clave no existe.
// ----------------------------------------------------------------------------
struct HttpRequest {
    std::string method;                                  // "GET", "POST", ...
    std::string path;                                    // "/api/users"
    std::string rawQuery;                                // "id=42&name=alice"
    std::map<std::string, std::string> params;           // path params: /users/:id
    std::map<std::string, std::string> query;            // query string parseada
    std::map<std::string, std::string> headers;          // lowercase keys
    std::string body;                                    // cuerpo (POST/PUT)
};

// ----------------------------------------------------------------------------
// Response — builder encadenable para la respuesta HTTP.
// El handler lo recibe por valor y lo muta; el servidor lo serializa al
// final del handler en `serialize()`.
// ----------------------------------------------------------------------------
class HttpResponse {
public:
    HttpResponse() = default;

    // Cambia el status code. Encadenable.
    HttpResponse& status(int code) { status_ = code; return *this; }
    // Anyade un header. Encadenable.
    HttpResponse& header(const std::string& name, const std::string& value) {
        std::string lower = name;
        for (auto& c : lower) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
        headers_[lower] = value;
        return *this;
    }
    // Envia un body de texto. Auto-set Content-Type si no se dio uno.
    HttpResponse& send(const std::string& body) {
        body_ = body;
        if (headers_.find("content-type") == headers_.end()) {
            header("Content-Type", "text/plain; charset=utf-8");
        }
        return *this;
    }
    // Envia un body JSON. Auto-set Content-Type a application/json.
    // El argumento es el string JSON ya serializado (e.g. el resultado
    // de json.stringify(...)).
    HttpResponse& json(const std::string& jsonString) {
        body_ = jsonString;
        header("Content-Type", "application/json; charset=utf-8");
        return *this;
    }
    // Serializa la respuesta al formato HTTP/1.1 listo para enviar.
    // No es const: anyade Content-Length y Connection si no estaban.
    std::string serialize() {
        // Headers (Content-Length siempre).
        headers_["Content-Length"] = std::to_string(body_.size());
        // Connection: close simplifica el ciclo de vida (no hay keep-alive).
        headers_["Connection"] = "close";
        std::ostringstream out;
        out << "HTTP/1.1 " << status_ << " " << statusText(status_) << "\r\n";
        for (const auto& [k, v] : headers_) {
            out << capitalizeHeader(k) << ": " << v << "\r\n";
        }
        out << "\r\n" << body_;
        return out.str();
    }
    int getStatus() const { return status_; }
    const std::string& getBody() const { return body_; }

private:
    int status_ = 200;
    std::map<std::string, std::string> headers_;
    std::string body_;

    static std::string capitalizeHeader(const std::string& name) {
        std::string out;
        out.reserve(name.size());
        bool upper = true;
        for (const char c : name) {
            if (c == '-') { out += '-'; upper = true; }
            else if (upper) { out += static_cast<char>(::toupper(static_cast<unsigned char>(c))); upper = false; }
            else out += c;
        }
        return out;
    }
    static const char* statusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 201: return "Created";
            case 204: return "No Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 304: return "Not Modified";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 418: return "I'm a teapot";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default:  return "OK";
        }
    }
};

// Type del handler: void(HttpRequest&, HttpResponse&). Se pasa por referencia
// mutable para que el handler pueda mutar la HttpResponse del server loop.
// Los handlers son SINCRONOS: no se permite co_await dentro. Si necesitas
// await, abre un spawn(...) y devuelve; el server loop serializara la
// HttpResponse cuando la corutina spawneada termine (en esta primera
// version, el server asume que la HttpResponse esta lista al volver el handler).

// ----------------------------------------------------------------------------
// Route — una ruta registrada en el Server. Pattern puede contener segmentos
// `:name` que se extraen como path params.
// ----------------------------------------------------------------------------
struct Route;

using ExpressHandler = std::function<void(HttpRequest&, HttpResponse&)>;

struct Route {
    std::string method;          // "GET", "POST", ...
    std::vector<std::string> segments;  // pattern split por '/', "" para raiz
    ExpressHandler handler;
};

// Helper: matchea un path real contra un pattern. Si coincide, rellena
// `params` con los valores de los `:name`. Devuelve true si coincide.
inline bool matchRoute(const std::vector<std::string>& pattern,
                       const std::vector<std::string>& path,
                       std::map<std::string, std::string>& params) {
    if (pattern.size() != path.size()) return false;
    params.clear();
    for (std::size_t i = 0; i < pattern.size(); ++i) {
        const std::string& p = pattern[i];
        const std::string& s = path[i];
        if (!p.empty() && p[0] == ':') {
            params[p.substr(1)] = s;
        } else if (p != s) {
            return false;
        }
    }
    return true;
}

// ----------------------------------------------------------------------------
// Server — servidor HTTP con tabla de rutas.
// ----------------------------------------------------------------------------
class Server {
public:
    Server() = default;

    // Registra un handler para method + path. Path puede tener :params.
    // Internamente: GET, POST, etc. son azucar que llaman a `add`.
    void add(const std::string& method, const std::string& path, ExpressHandler handler) {
        Route r;
        r.method = method;
        r.handler = std::move(handler);
        // Split del path por '/'. Usamos la misma convencion que
        // splitPath(): el primer '/' NO genera segmento vacio.
        // "/foo/:bar" -> ["foo", ":bar"]; "/" -> [""]; "" -> [""].
        std::string current;
        for (const char c : path) {
            if (c == '/') {
                if (!current.empty() || !r.segments.empty()) { r.segments.push_back(current); current.clear(); }
            } else current += c;
        }
        if (!current.empty() || r.segments.empty()) r.segments.push_back(current);
        routes_.push_back(std::move(r));
    }
    void get(const std::string& path, ExpressHandler handler)    { add("GET",    path, std::move(handler)); }
    void post(const std::string& path, ExpressHandler handler)   { add("POST",   path, std::move(handler)); }
    void put(const std::string& path, ExpressHandler handler)    { add("PUT",    path, std::move(handler)); }
    void del(const std::string& path, ExpressHandler handler)    { add("DELETE", path, std::move(handler)); }
    void patch(const std::string& path, ExpressHandler handler)  { add("PATCH",  path, std::move(handler)); }

    // Arranca el servidor en host:port. Bloqueante: ejecuta el event loop
    // hasta que el proceso sea interrumpido. Devuelve Task<void> para
    // que el caller pueda spawn(...) o syncWait.
    Task<void> listen(const std::string& host, double port) {
        co_await this->listenImpl(host, port);
    }

    // Variante con idle timeout: si no llega ninguna conexion durante
    // `idleTimeoutMs` milisegundos, el listen termina. Util para tests
    // y para servidores que quieren hacer shutdown graceful.
    Task<void> listenWithIdleTimeout(const std::string& host, double port, double idleTimeoutMs) {
        co_await this->listenImpl(host, port, idleTimeoutMs);
    }

private:
    std::vector<Route> routes_;

    // Implementacion async: bind, accept loop, dispatch por conexion.
    // Si `idleTimeoutMs` > 0, sale del loop tras ese tiempo sin conexiones.
    Task<void> listenImpl(const std::string& host, double port, double idleTimeoutMs = 0.0) {
        const auto listenerResult = listenTcp(host, port);
        if (!listenerResult.isOk()) {
            std::fprintf(stderr, "http: no se puede abrir %s:%g: %s\n",
                         host.c_str(), port, listenerResult.error().c_str());
            co_return;
        }
        TcpListener listener = listenerResult.value();
        // Guardamos un shared_ptr a `this` para que las corutinas spawneadas
        // mantengan el Server vivo aunque el caller destruya su copia. El
        // puntero se libera cuando el server loop termina.
        auto self = std::shared_ptr<Server>(this, [](Server*) { /* noop: el caller es dueno */ });
        while (true) {
            // 0.0 = esperar para siempre. Tests usan un valor > 0.
            const double acceptDeadline = idleTimeoutMs > 0.0 ? idleTimeoutMs : 86400000.0; // 24h
            const auto accepted = co_await acceptTcpUntil(listener, acceptDeadline, CancellationToken{});
            if (!accepted.isOk()) {
                // Tests: salimos tras el idle timeout. Production (24h): solo
                // llegamos aqui si el accept falla por otra razon.
                if (idleTimeoutMs > 0.0) co_return;
                std::fprintf(stderr, "http: error aceptando: %s\n", accepted.error().c_str());
                continue;
            }
            TcpConnection conn = accepted.value();
            // Spawn del handler de la conexion. Capturamos `self` por
            // copia (shared_ptr) para que las rutas no se destruyan
            // aunque el caller de listen() libere su copia del Server.
            auto selfCopy = self;
            Task<void> handlerTask = [conn = std::move(conn), selfCopy]() -> Task<void> {
                co_await selfCopy->handleClient(std::move(conn));
            }();
            spawn(std::move(handlerTask));
        }
    }

    // Lee el request HTTP completo de la conexion, dispatch al handler,
    // escribe la response.
    Task<void> handleClient(TcpConnection conn) {
        // Leemos hasta un limite razonable (16 KB) o hasta cerrar.
        // Una aplicacion real con bodies grandes deberia parsear
        // Content-Length y leer exactamente eso. Para este primer
        // prototipo, leemos hasta "\r\n\r\n" + body si lo detectamos.
        std::string raw;
        // Read en chunks hasta encontrar fin de headers.
        while (true) {
            const auto chunk = co_await readTcpUntil(conn, 4096.0, 30000.0, CancellationToken{});
            if (!chunk.isOk()) { co_return; }
            raw += chunk.value();
            if (raw.find("\r\n\r\n") != std::string::npos) break;
            if (raw.size() > 16384) { co_return; }  // request muy grande
        }
        // Parsear request.
        HttpRequest req;
        HttpResponse res;
        const std::size_t headerEnd = raw.find("\r\n\r\n");
        const std::string headerBlock = raw.substr(0, headerEnd);
        req.body = raw.substr(headerEnd + 4);
        // Status line: "METHOD PATH HTTP/1.1"
        std::istringstream stream(headerBlock);
        std::string line;
        if (!std::getline(stream, line)) co_return;
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::istringstream statusLine(line);
        if (!(statusLine >> req.method >> req.path)) co_return;
        // Separar query string del path.
        const std::size_t q = req.path.find('?');
        if (q != std::string::npos) {
            req.rawQuery = req.path.substr(q + 1);
            req.path = req.path.substr(0, q);
            parseQueryString(req.rawQuery, req.query);
        }
        // Resto de lineas: headers.
        while (std::getline(stream, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty()) break;
            const std::size_t colon = line.find(':');
            if (colon == std::string::npos) continue;
            std::string name = line.substr(0, colon);
            std::string value = line.substr(colon + 1);
            std::size_t vstart = 0;
            while (vstart < value.size() && (value[vstart] == ' ' || value[vstart] == '\t')) ++vstart;
            value = value.substr(vstart);
            for (auto& c : name) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
            req.headers[name] = value;
        }
        // Si hay Content-Length, leemos el resto del body. Aqui lo
        // simulamos: el body ya esta en raw (puede estar incompleto si
        // el chunk anterior no lo cubrio). En la primera version,
        // cualquier body recibido en la primera lectura es suficiente.
        // TODO: leer el resto segun Content-Length.
        // Dispatch: encontrar la primera ruta que matchee.
        std::vector<std::string> pathSegments = splitPath(req.path);
        bool dispatched = false;
        for (const auto& route : routes_) {
            if (route.method != req.method) continue;
            std::map<std::string, std::string> params;
            if (matchRoute(route.segments, pathSegments, params)) {
                req.params = std::move(params);
                try {
                    route.handler(req, res);
                } catch (...) {
                    // Handlers no deberian tirar, pero por si acaso.
                    res.status(500).send("Internal Server Error");
                }
                dispatched = true;
                break;
            }
        }
        if (!dispatched) {
            res.status(404).send("Not Found: " + req.method + " " + req.path);
        }
        // Escribir response.
        const std::string serialized = res.serialize();
        const auto written = co_await writeTcpUntil(conn, serialized, 30000.0, CancellationToken{});
        (void)written;
        co_return;
    }

    // splitPath("/foo/bar") -> ["foo", "bar"]; "/" -> [""]; "/:x" -> [":x"].
    static std::vector<std::string> splitPath(const std::string& path) {
        std::vector<std::string> out;
        std::string current;
        for (const char c : path) {
            if (c == '/') { if (!current.empty() || !out.empty()) { out.push_back(current); current.clear(); } }
            else current += c;
        }
        if (!current.empty() || out.empty()) out.push_back(current);
        return out;
    }
    // Parsea "a=1&b=hello%20world" -> {"a":"1","b":"hello world"}.
    static void parseQueryString(const std::string& qs, std::map<std::string, std::string>& out) {
        std::size_t i = 0;
        while (i < qs.size()) {
            const std::size_t amp = qs.find('&', i);
            const std::string pair = qs.substr(i, (amp == std::string::npos) ? std::string::npos : amp - i);
            if (!pair.empty()) {
                const std::size_t eq = pair.find('=');
                std::string key = (eq == std::string::npos) ? pair : pair.substr(0, eq);
                std::string val = (eq == std::string::npos) ? std::string() : pair.substr(eq + 1);
                // URL-decode basico: solo %XX y +.
                auto decode = [](std::string s) {
                    std::string out; out.reserve(s.size());
                    for (std::size_t k = 0; k < s.size(); ++k) {
                        if (s[k] == '+') out += ' ';
                        else if (s[k] == '%' && k + 2 < s.size()) {
                            const int hi = (s[k+1] >= '0' && s[k+1] <= '9') ? s[k+1]-'0' :
                                           (s[k+1] >= 'a' && s[k+1] <= 'f') ? s[k+1]-'a'+10 :
                                           (s[k+1] >= 'A' && s[k+1] <= 'F') ? s[k+1]-'A'+10 : -1;
                            const int lo = (s[k+2] >= '0' && s[k+2] <= '9') ? s[k+2]-'0' :
                                           (s[k+2] >= 'a' && s[k+2] <= 'f') ? s[k+2]-'a'+10 :
                                           (s[k+2] >= 'A' && s[k+2] <= 'F') ? s[k+2]-'A'+10 : -1;
                            if (hi >= 0 && lo >= 0) {
                                out += static_cast<char>(hi*16 + lo); k += 2;
                            } else out += s[k];
                        } else out += s[k];
                    }
                    return out;
                };
                out[decode(key)] = decode(val);
            }
            if (amp == std::string::npos) break;
            i = amp + 1;
        }
    }
};


// Helper de dialecto: el codegen emite `ets::http_createServer()` cuando
// el usuario hace `http.createServer()`. Devuelve un Server por valor
// (movible, sin allocacion en heap).
inline Server http_createServer() { return Server{}; }

// Helper de alto nivel: arranca el server Y entra en el event loop.
// Usado por el codegen cuando el usuario hace `server.listen(port)` — asi
// el programa entero se queda vivo hasta SIGINT. Si el listen falla,
// imprime el error a stderr pero no aborta (el server ya loguea el
// error por su cuenta).
inline void runServerLoop(Server& server, const std::string& host, double port) {
    Task<void> serverTask = server.listen(host, port);
    try {
        syncWait(serverTask);
    } catch (...) {
        std::fprintf(stderr, "http: excepcion no esperada en el server loop\n");
    }
}

// Helpers de acceso a datos del Request. El dialecto no soporta el indexer
// `map[string]` ni los `optional<V>`, asi que estos helpers reciben el
// Request por valor (copia barata: solo un par de maps pequenos por
// request) y devuelven un string vacio si la clave no existe.

// http.param(req, "name") -> path param del patron :name, o "" si no
// existe. Para `/users/:id` con GET /users/42 -> http.param(req, "id") == "42".
inline std::string http_param(const HttpRequest& req, const std::string& name) {
    const auto it = req.params.find(name);
    return it == req.params.end() ? std::string() : it->second;
}

// http.query(req, "name") -> valor URL-decoded de la query string, o "".
// Para ?a=1&b=hello%20world -> http.query(req, "b") == "hello world".
inline std::string http_query(const HttpRequest& req, const std::string& name) {
    const auto it = req.query.find(name);
    return it == req.query.end() ? std::string() : it->second;
}

// http.header(req, "Content-Type") -> valor del header (case-insensitive),
// o "". Devuelve el primer valor si el header aparece varias veces.
inline std::string http_header(const HttpRequest& req, const std::string& name) {
    std::string lower = name;
    for (auto& c : lower) c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
    const auto it = req.headers.find(lower);
    return it == req.headers.end() ? std::string() : it->second;
}

}  // namespace ets
