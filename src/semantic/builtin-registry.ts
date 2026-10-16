// V30.30: BuiltinRegistry.
//
// Antes, los built-ins del dialecto (funciones globales como `print`,
// `length`, `setTimeout`, `readFile`, `Server`, `Promise`, `Math`, etc.)
// se registraban inline dentro de `TypeChecker.check()`. Esto mezclaba
// el analisis semantico con la lista concreta de APIs disponibles y
// obligaba a tocar el type-checker cada vez que se anadia un builtin.
//
// Este modulo aísla esos registros. `TypeChecker.check()` invoca
// `registerBuiltins(global, interfaces, classes)` una sola vez; el
// resto del analisis semantico (reglas de tipos, flujo, narrowing,
// moves, borrows) sigue siendo responsabilidad del TypeChecker.
//
// Lo que se movio aqui:
//   - Helpers de declaracion de simbolos `input`/`output`/`fn`.
//   - Registros de funciones globales (`print`, `length`,
//     `setTimeout`, `readFile`, `readFileAsync`, `listenTcp`, etc.).
//   - Registros de interfaces built-in (`Request`, `Response`,
//     `Timer`, `Promise`, `FsWatcher`, `FsEvent`).
//   - Registros de clases built-in (`Server`).
//
// Lo que sigue en TypeChecker:
//   - Las tablas `FILESYSTEM_METHODS`, `PATH_METHODS`, etc. son
//     consultadas por `dispatchBuiltin()` en medio de `expression()`.
//     Moverlas ahora obligaria a reorganizar `expression()` y eso
//     es un refactor de mas riesgo. Se quedan en type-checker.ts
//     hasta que se aborde esa extraccion.
//   - `registerBuiltinInterface`/`registerBuiltinClass` /
//     `fakeSpan` se quedaron como helpers privados del TypeChecker
//     porque solo este los necesita; si en el futuro se quiere
//     reutilizarlos desde fuera se extraen a este archivo.

import type { ClassDeclaration, InterfaceDeclaration, TypeName, BlockStatement } from "../ast/nodes.ts";
import type { FunctionSymbol } from "./symbols.ts";
import { genericType } from "../types/type-system.ts";
import { Scope } from "./symbols.ts";

export function registerBuiltins(
  global: Scope,
  interfaces: Map<string, InterfaceDeclaration>,
  classes: Map<string, ClassDeclaration>,
): void {
  // Helpers locales. Mismo comportamiento que en el `check()` previo.
  const input = (type: TypeName) => ({ type, out: false });
  const output = (type: TypeName) => ({ type, out: true });
  const fn = (params: Array<{ type: TypeName; out: boolean }>, returnType: TypeName): FunctionSymbol => ({
    kind: "function",
    overloads: [{ typeParameters: [], variadicTypeParameters: [], params, returnType }],
  });

  // --- I/O basico ---
  global.define("print", fn([], "void"));
  global.define("write", fn([], "void"));
  global.define("printError", fn([], "void"));
  global.define("writeError", fn([], "void"));

  // V30.41: comptime() — evalua la arrow function en transpilacion
  // y devuelve su resultado como literal. El type-checker no la
  // intercepta; el codegen la sustituye ANTES de procesar el AST.
  // El parametro se registra como `any` porque el dialecto no tiene
  // inferencia de tipos para function types en `typeMatches` (limitación
  // preexistente), y de todos modos queremos aceptar cualquier arrow.
  global.define("comptime", fn([input("any")], "any"));

  // V9.1: awaiters io_uring. Mapean al runtime/ets_io_uring_async.hpp.
  // Version async: Promise<Result<T>>; version sync: Result<T>.
  global.define("asyncIoUringRead", fn([input("string")], "Promise<Result<string>>"));
  global.define("asyncIoUringWrite", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
  global.define("ioUringRead", fn([input("string")], "Result<string>"));
  global.define("ioUringWrite", fn([input("string"), input("string")], "Result<boolean>"));
  global.define("ioUringAvailable", fn([], "boolean"));

  // --- Strings ---
  global.define("length", fn([input("string")], "number"));
  global.define("numberToString", fn([input("number")], "string"));
  global.define("charAt", fn([input("string"), input("number")], "string"));
  global.define("substring", fn([input("string"), input("number"), input("number")], "string"));
  global.define("indexOf", fn([input("string"), input("string"), input("number")], "number"));
  global.define("startsWith", fn([input("string"), input("string")], "boolean"));
  global.define("trim", fn([input("string")], "string"));
  global.define("lineCount", fn([input("string")], "number"));
  global.define("lineAt", fn([input("string"), input("number")], "string"));

  // --- V28: tipos built-in del server HTTP ---
  // El type-checker NO parsea estatic.d.ts, asi que registramos a mano
  // las interfaces y la clase Server. Sin esto, declarar un parametro
  // como http.Request o http.Response da "Tipo no definido".
  //
  // V28: el dialecto expone los tipos del request/response. El d.ts
  // los declara como `Request` y `Response` dentro del namespace
  // `http`, pero el type-checker NO parsea el d.ts y los usuarios no
  // pueden usar el qualifier `http.X` en la firma del handler todavia
  // (limitacion del parser), asi que los registramos con los nombres
  // PLANOS `Request` y `Response` para que el codigo del usuario
  // funcione sin mas. El codegen traduce `Request` a `ets::HttpRequest`
  // en cpp-types.
  registerBuiltinInterface(interfaces, "Request", [
    { name: "method", returnType: "string", params: [] },
    { name: "path", returnType: "string", params: [] },
    { name: "rawQuery", returnType: "string", params: [] },
    { name: "body", returnType: "string", params: [] },
  ]);
  registerBuiltinInterface(interfaces, "Response", [
    { name: "status", returnType: "Response", params: [{ name: "code", type: "number" }] },
    { name: "header", returnType: "Response", params: [{ name: "name", type: "string" }, { name: "value", type: "string" }] },
    { name: "send", returnType: "Response", params: [{ name: "body", type: "string" }] },
    { name: "json", returnType: "Response", params: [{ name: "jsonString", type: "string" }] },
  ]);

  // V28: HttpClientResponse. Resultado de http.get(url) / http.post(url, body).
  // El dialecto no soporta campos en struct, asi que se accede a status/body/header
  // como metodos. `status()` devuelve number, `body()` devuelve string,
  // `header(name)` devuelve string.
  registerBuiltinInterface(interfaces, "HttpClientResponse", [
    { name: "status", returnType: "number", params: [] },
    { name: "body", returnType: "string", params: [] },
    { name: "header", returnType: "string", params: [{ name: "name", type: "string" }] },
  ]);

  registerBuiltinClass(classes, "Server", [
    { name: "get", returnType: "void", params: [{ name: "path", type: "string" }, { name: "handler", type: "any" }] },
    { name: "post", returnType: "void", params: [{ name: "path", type: "string" }, { name: "handler", type: "any" }] },
    { name: "put", returnType: "void", params: [{ name: "path", type: "string" }, { name: "handler", type: "any" }] },
    { name: "patch", returnType: "void", params: [{ name: "path", type: "string" }, { name: "handler", type: "any" }] },
    { name: "delete", returnType: "void", params: [{ name: "path", type: "string" }, { name: "handler", type: "any" }] },
    { name: "listen", returnType: "void", params: [{ name: "port", type: "number" }] },
  ]);

  // --- V30.1: Timer ---
  // Handle opaco a un uv_timer_t. Devuelto por
  // setTimeout/setInterval. Mantener vivo mientras se quiera
  // que el callback siga programado; cancelTimer(handle) lo
  // cierra y libera.
  registerBuiltinInterface(interfaces, "Timer", [
    { name: "valid", returnType: "boolean", params: [] },
  ]);

  // Funciones globales para timers. setTimeout/setInterval toman
  // un callback `()=>void` (lambda sin args que devuelve void);
  // el codegen lo emite como lambda C++ convertible a
  // std::function<void()>. Devuelven un Timer. cancelTimer toma
  // un Timer.
  const timerCallback = { type: "()=>void" as TypeName, out: false };
  global.define("setTimeout", fn([timerCallback, input("number")], "Timer"));
  global.define("setInterval", fn([timerCallback, input("number")], "Timer"));
  global.define("cancelTimer", fn([input("Timer")], "void"));

  // --- V30.17: Promise ---
  // Interface builtin vacia. Se usa como tipo de retorno de funciones
  // async (Promise<T> en la practica se trata como ets::Task<T>). Los
  // generics type parameters son opcionales: `Promise<T>` se permite
  // pero el dialecto trata el `T` como `any` para type-checking (la
  // conversion a C++ se hace en codegen).
  registerBuiltinInterface(interfaces, "Promise", []);

  // V30.17: `Promise.all([...])` y `Promise.race([...])` como funciones
  // globales. `promiseAll(arr: any[]): Promise<any[]>` espera a todas
  // las tasks del array en paralelo y devuelve un array con los
  // resultados. `promiseRace(arr: any[]): Promise<any>` devuelve el
  // primer resultado. El codegen las trata como case especial (emiten
  // llamadas a ets::when_all/ets::when_race).
  global.define("promiseAll", fn([{ type: "any[]", out: false }], "Promise"));
  global.define("promiseRace", fn([{ type: "any[]", out: false }], "Promise"));

  // V30.18: combinators async. `timeout<T>(task, ms, sentinel)`:
  // espera a la task con un timeout. Si no completa en `ms`
  // milisegundos, devuelve `sentinel` (por default 0).
  // `retry<T>(fn, times, delayMs, sentinel)`: invoca `fn` (que
  // retorna Task<T>), y si el resultado es `sentinel`, reintenta
  // hasta `times` veces con un delay de `delayMs` entre intentos.
  // Los type parameters <T> son obligatorios. NOTA: no exportamos
  // `delay` como builtin porque choca con funciones del usuario
  // que se llamen `delay`. Los usuarios pueden usar `sleep` (que
  // ya existe) o definir su propio `delay`.
  {
    const sym: FunctionSymbol = {
      kind: "function",
      overloads: [{
        typeParameters: ["T"],
        variadicTypeParameters: [],
        params: [{ type: "any", out: false }, { type: "number", out: false }, { type: "number", out: false }],
        returnType: genericType("Promise", ["T"]),
      }],
    };
    global.define("timeout", sym);
  }
  {
    const sym: FunctionSymbol = {
      kind: "function",
      overloads: [{
        typeParameters: ["T"],
        variadicTypeParameters: [],
        params: [{ type: "any", out: false }, { type: "number", out: false }, { type: "number", out: false }, { type: "number", out: false }],
        returnType: genericType("Promise", ["T"]),
      }],
    };
    global.define("retry", sym);
  }

  // V30.2: stopLoop() cierra el event loop actual (lo saca de
  // run() sin matar el proceso). Util para auto-cancelar
  // setInterval: el callback compara un contador y llama a
  // stopLoop() cuando ha disparado N veces. El main entra en
  // run() automaticamente si detecta watchFs o setInterval.
  global.define("stopLoop", fn([], "void"));

  // V30.2: FsWatcher / FsEvent. Handle opaco a un uv_fs_event_t
  // que vigila un directorio. El callback se invoca con un
  // FsEvent { path: string, flags: number } cada vez que hay
  // un cambio. Mantener el FsWatcher vivo mientras se quiera
  // recibir eventos; unwatchFs(handle) lo cierra.
  registerBuiltinInterface(interfaces, "FsWatcher", [
    { name: "valid", returnType: "boolean", params: [] },
  ]);

  // FsEvent es un struct con dos campos: path (string) y flags
  // (number). El dialecto accede a ellos como metodos.
  registerBuiltinInterface(interfaces, "FsEvent", [
    { name: "path", returnType: "string", params: [] },
    { name: "flags", returnType: "number", params: [] },
  ]);

  // watchFs(path, callback, recursive?) -> FsWatcher. El callback
  // toma un FsEvent y devuelve void. recursive es opcional (default
  // false). unwatchFs(handle) cierra el watcher.
  const fsCallback = { type: "(FsEvent)=>void" as TypeName, out: false };
  global.define("watchFs", fn([input("string"), fsCallback, input("boolean")], "FsWatcher"));
  global.define("unwatchFs", fn([input("FsWatcher")], "void"));

  // --- Filesystem (sync + async + cancellation) ---
  const readFile = fn([input("string"), output("string"), output("string")], "boolean");
  readFile.overloads.push({ typeParameters: [], variadicTypeParameters: [], params: [input("string")], returnType: "Result<string>" });
  global.define("readFile", readFile);
  const writeFile = fn([input("string"), input("string"), output("string")], "boolean");
  writeFile.overloads.push({ typeParameters: [], variadicTypeParameters: [], params: [input("string"), input("string")], returnType: "Result<boolean>" });
  global.define("writeFile", writeFile);
  const appendFile = fn([input("string"), input("string"), output("string")], "boolean");
  appendFile.overloads.push({ typeParameters: [], variadicTypeParameters: [], params: [input("string"), input("string")], returnType: "Result<boolean>" });
  global.define("appendFile", appendFile);
  global.define("fileExists", fn([input("string")], "boolean"));
  const copyFile = fn([input("string"), input("string"), output("string")], "boolean");
  copyFile.overloads.push({ typeParameters: [], variadicTypeParameters: [], params: [input("string"), input("string")], returnType: "Result<boolean>" });
  global.define("copyFile", copyFile);
  const moveFile = fn([input("string"), input("string"), output("string")], "boolean");
  moveFile.overloads.push({ typeParameters: [], variadicTypeParameters: [], params: [input("string"), input("string")], returnType: "Result<boolean>" });
  global.define("moveFile", moveFile);
  const removeFile = fn([input("string"), output("string")], "boolean");
  removeFile.overloads.push({ typeParameters: [], variadicTypeParameters: [], params: [input("string")], returnType: "Result<boolean>" });
  global.define("removeFile", removeFile);

  global.define("readFileAsync", fn([input("string")], "Promise<Result<string>>"));
  global.define("resolveDns", fn([input("string")], "Promise<string>"));
  global.define("writeFileAsync", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
  global.define("appendFileAsync", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
  global.define("fileExistsAsync", fn([input("string")], "Promise<Result<boolean>>"));
  global.define("copyFileAsync", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
  global.define("moveFileAsync", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
  global.define("removeFileAsync", fn([input("string")], "Promise<Result<boolean>>"));

  global.define("readFileUntil", fn([input("string"), input("number"), input("CancellationToken")], "Promise<Result<string>>"));
  global.define("writeFileUntil", fn([input("string"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
  global.define("appendFileUntil", fn([input("string"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
  global.define("copyFileUntil", fn([input("string"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
  global.define("moveFileUntil", fn([input("string"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
  global.define("removeFileUntil", fn([input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));

  // --- Errors, process, fs metadata ---
  global.define("fail", fn([input("string"), output("string")], "boolean"));
  global.define("clearError", fn([output("string")], "void"));
  global.define("hasError", fn([input("string")], "boolean"));
  global.define("argumentCount", fn([], "number"));
  global.define("argument", fn([input("number")], "string"));
  global.define("exitProcess", fn([input("number")], "void"));
  global.define("jsonEscape", fn([input("string")], "string"));
  global.define("normalizePath", fn([input("string")], "string"));
  global.define("compilerRoot", fn([], "string"));
  global.define("resolveImportPath", fn([input("string"), input("string")], "string"));
  global.define("compileCpp", fn([input("string"), input("string"), input("string"), input("string"), input("string"), output("string")], "boolean"));
  global.define("pathDirectory", fn([input("string")], "string"));
  global.define("resolveProjectPath", fn([input("string"), input("string")], "string"));
  global.define("ensureParentDirectory", fn([input("string"), output("string")], "boolean"));
  global.define("validateSyntax", fn([input("string"), output("string")], "boolean"));
  global.define("syntaxTreeJson", fn([input("string"), output("string"), output("string")], "boolean"));
  global.define("syntaxTreeRecords", fn([input("string"), output("string"), output("string")], "boolean"));
  global.define("estaticAstRecords", fn([input("string"), output("string"), output("string")], "boolean"));
  global.define("estaticTypedAstJson", fn([input("string"), output("string"), output("string")], "boolean"));
  global.define("estaticTypedAstRecords", fn([input("string"), output("string"), output("string")], "boolean"));

  // --- Async helpers ---
  global.define("sleep", fn([input("number")], "Promise<void>"));
  global.define("spawn", fn([input("Promise<void>")], "void"));
  global.define("ok", { kind: "function", overloads: [{ typeParameters: ["T"], variadicTypeParameters: [], params: [input("T")], returnType: "Result<T>" }] });
  global.define("err", { kind: "function", overloads: [{ typeParameters: ["T"], variadicTypeParameters: [], params: [input("string")], returnType: "Result<T>" }] });

  // --- TCP / TLS ---
  global.define("listenTcp", fn([input("string"), input("number")], "Result<TcpListener>"));
  global.define("acceptTcp", fn([input("TcpListener")], "Promise<Result<TcpConnection>>"));
  global.define("readTcp", fn([input("TcpConnection"), input("number")], "Promise<Result<string>>"));
  global.define("writeTcp", fn([input("TcpConnection"), input("string")], "Promise<Result<number>>"));
  global.define("createCancellation", fn([], "CancellationSource"));
  global.define("cancellationToken", fn([input("CancellationSource")], "CancellationToken"));
  global.define("cancel", fn([input("CancellationSource")], "void"));
  global.define("isCancelled", fn([input("CancellationToken")], "boolean"));
  global.define("acceptTcpUntil", fn([input("TcpListener"), input("number"), input("CancellationToken")], "Promise<Result<TcpConnection>>"));
  global.define("readTcpUntil", fn([input("TcpConnection"), input("number"), input("number"), input("CancellationToken")], "Promise<Result<string>>"));
  global.define("writeTcpUntil", fn([input("TcpConnection"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<number>>"));
  global.define("createTlsServer", fn([input("string"), input("string")], "Result<TlsContext>"));
  global.define("acceptTls", fn([input("TcpListener"), input("TlsContext"), input("number"), input("CancellationToken")], "Promise<Result<TlsConnection>>"));
  global.define("readTls", fn([input("TlsConnection"), input("number"), input("number"), input("CancellationToken")], "Promise<Result<string>>"));
  global.define("writeTls", fn([input("TlsConnection"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<number>>"));
  global.define("closeTls", fn([input("TlsConnection")], "void"));
  const closeTcp = fn([input("TcpListener")], "void");
  closeTcp.overloads.push({ typeParameters: [], variadicTypeParameters: [], params: [input("TcpConnection")], returnType: "void" });
  global.define("closeTcp", closeTcp);
}

// Helpers standalone para registrar interfaces y clases built-in.
// Antes eran metodos privados de TypeChecker; ahora viven aqui para
// que el registry no dependa de la clase. La logica es identica a la
// de los metodos originales.

function fakeSpan() {
  return { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } };
}

function registerBuiltinInterface(
  interfaces: Map<string, InterfaceDeclaration>,
  name: string,
  methods: { name: string; returnType: string; params: { name: string; type: string }[] }[],
): void {
  const decl: InterfaceDeclaration = {
    kind: "InterfaceDeclaration",
    name,
    exported: true,
    methods: methods.map(m => ({
      kind: "InterfaceMethod" as const,
      name: m.name,
      params: m.params.map(p => ({
        kind: "Parameter" as const,
        name: p.name,
        type: p.type,
        out: false,
        passing: "value" as const,
        optional: false,
        span: fakeSpan(),
      })),
      returnType: m.returnType,
      decorators: [],
      span: fakeSpan(),
    })),
    // V30.11: las interfaces built-in no declaran campos (son contratos
    // puros de metodos, igual que antes). Solo las interfaces declaradas
    // en .ets pueden tener `fields`.
    fields: [],
    decorators: [],
    span: fakeSpan(),
  };
  interfaces.set(name, decl);
}

function registerBuiltinClass(
  classes: Map<string, ClassDeclaration>,
  name: string,
  methods: { name: string; returnType: string; params: { name: string; type: string }[] }[],
): void {
  const decl: ClassDeclaration = {
    kind: "ClassDeclaration",
    name,
    exported: true,
    typeParameters: [],
    variadicTypeParameters: [],
    fields: [],
    methods: methods.map(m => ({
      kind: "ClassMethod" as const,
      name: m.name,
      params: m.params.map(p => ({
        kind: "Parameter" as const,
        name: p.name,
        type: p.type,
        out: false,
        passing: "value" as const,
        optional: false,
        span: fakeSpan(),
      })),
      returnType: m.returnType,
      body: null as unknown as BlockStatement,
      decorators: [],
      access: "public" as const,
      span: fakeSpan(),
    })),
    decorators: [],
    span: fakeSpan(),
  };
  classes.set(name, decl);
}
