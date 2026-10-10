// http-server-drogon/drogon-decorator-compiles — Issue #153.
//
// Verifica que el codegen emite `ets_http_drogon.hpp` cuando se usa
// el decorator `@cpp_drogon` sobre `let server: Server`, y que el
// runner enlaza correctamente con -ldrogon. Si libdrogon-dev no esta
// instalado, el bucket entero se skipea (ver runner.ts).
//
// El test NO arranca el server: solo verifica que el codepath del
// backend Drogon compila. El roundtrip end-to-end se valida con
// `.scratch/ejemplo-server-drogon.ets` (manual).

@cpp_drogon
let server: Server = http.createServer()

server.get("/", (req: Request, res: Response): void => {
  res.status(200)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("hola desde drogon")
})

server.get("/hola/:nombre", (req: Request, res: Response): void => {
  res.status(200)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("hola " + http.param(req, "nombre"))
})

server.post("/echo", (req: Request, res: Response): void => {
  res.status(201)
     .header("Content-Type", "text/plain; charset=utf-8")
     .send("recibido: " + req.body)
})

print("compiled-with-drogon-decorator")
