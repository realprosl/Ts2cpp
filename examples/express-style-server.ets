// =====================================================================
// express-style-server.ets
//
// Servidor HTTP con sintaxis "estilo express" sobre el backend
// httplib (por defecto en el dialecto). Inspira en Express.js (Node):
//
//     let server = http.createServer()
//     server.get("/ruta/:param", (req, res) => {
//       res.status(200).header("Content-Type", "text/plain").send("hola")
//     })
//     server.listen(8080)
//
// Este ejemplo usa el API builtin del dialecto (no reinventa la
// rueda). El API vive en runtime/ets_http_server.hpp y esta expuesto
// al TS como:
//   - `http.createServer()`         -> Server
//   - `server.get/post/put/patch/delete(path, handler)` -> void
//   - `server.listen(port)`         -> void (bloquea hasta SIGINT)
//   - `req.method / req.path / req.rawQuery / req.body` -> string
//   - `res.status(n).header(k,v).send(body)` (encadenable)
//   - `res.json(jsonString)` (encadenable, content-type: application/json)
//   - `http.param(req, "name")`     -> string (path param de :name)
//   - `http.query(req, "key")`      -> string (query string URL-decoded)
//   - `http.header(req, "Key")`     -> string (header HTTP, case-insensitive)
//
// Los handlers son **sincronos** (`(req, res) => void`): reciben los
// objetos pre-construidos y solo escriben a res. Si necesitas await,
// abre un `spawn(...)` dentro del handler. Esto es por diseño — el
// event loop es compartido, no tiene sentido bloquear un handler.
//
// Si quieres el backend Drogon (HTTP sobre Drogon framework), anade
// el decorator `@cpp_drogon` sobre la declaracion de `server`.
//
// Probalo:
//
//     $ etsc examples/express-style-server.ets -o /tmp/srv.cpp --build
//     $ /tmp/srv &
//     $ curl http://127.0.0.1:8080/
//     Hola desde Ts2cpp!
//     $ curl http://127.0.0.1:8080/hola/Mundo
//     hola Mundo
//     $ curl -X POST -d 'ping' http://127.0.0.1:8080/echo
//     recibido: ping
//     $ curl 'http://127.0.0.1:8080/info?x=42'
//     query x = 42
//     $ curl http://127.0.0.1:8080/missing
//     404 no encontrado
// =====================================================================

// Crea el server con el backend por defecto (httplib).
// Usa `@cpp_drogon` justo encima para forzar Drogon.
let server: Server = http.createServer();

// --- handlers estilo express --------------------------------------
//
// Cada handler es una arrow sync `(req, res): void => { ... }`.
// El dialecto la pasa al `Server` via template <typename F0> (callback
// sincrono, sin necesidad de V30.10 para callbacks async — esto es
// el path que ya funcionaba antes).

server.get("/", (req: Request, res: Response): void => {
  res.status(200)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("Hola desde Ts2cpp!\nmethod: " + req.method + "\npath: " + req.path + "\n");
});

// Path params: `:nombre` se extrae con http.param(req, "nombre").
server.get("/hola/:nombre", (req: Request, res: Response): void => {
  const nombre: string = http.param(req, "nombre");
  res.status(200)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("hola " + nombre + "\n");
});

// Query string: `?x=42` se extrae con http.query(req, "x").
server.get("/info", (req: Request, res: Response): void => {
  const x: string = http.query(req, "x");
  res.status(200)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("query x = " + x + "\n");
});

// POST con body: `req.body` lo expone como string.
server.post("/echo", (req: Request, res: Response): void => {
  res.status(201)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("recibido: " + req.body + "\n");
});

// Headers HTTP: case-insensitive via http.header(req, "Content-Type").
server.get("/ua", (req: Request, res: Response): void => {
  const ua: string = http.header(req, "User-Agent");
  res.status(200)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("User-Agent = " + ua + "\n");
});

// JSON: res.json(string) serializa con content-type application/json.
server.get("/json", (req: Request, res: Response): void => {
  res.status(200).json("{\"ok\":true,\"ts\":1234567890}");
});

// Arranca el server. listen(port) bloquea hasta SIGINT (Ctrl-C),
// procesando el event loop de libuv.
print("escuchando en http://127.0.0.1:8080");
server.listen(8080);
