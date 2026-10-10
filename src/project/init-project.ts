import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface InitializedProject {
  directory: string;
  files: string[];
}

// Plantilla de tsconfig.json para el proyecto generado. La clave de todo
// el cambio es lib: ["es2022"] y types: []:
//   - lib: [] no funciona: sin un lib mínimo, hasta los tipos globales
//     básicos (Array, Boolean, Number, IArguments) se pierden, y eso
//     rompe los .d.ts que importan string[], unknown[], etc.
//   - lib: ["es2022"] da JS moderno sin DOM, que es lo que queremos.
//   - types: [] excluye @types/node y compañía, que es lo que de
//     verdad no soporta el dialecto (no hay Buffer, __dirname, etc.).
// moduleResolution: "bundler" es lo que usan Vite/Deno y no asume
// resolución estilo Node.
const tsconfigJson = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": [],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowJs": false,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "types/**/*", "estatic.config.ts"]
}
`;

// Plantilla de types/estatic.d.ts. Declara al editor los built-ins del
// dialecto (ptr/constPtr/ref/constRef como modificadores de memoria;
// Optional, Result, Promise, Map, Set; readonly; numéricos i8..f64)
// y los globales (console, fs, path, process, JSON) más los helpers de
// runtime que usan los ejemplos (print, numberToString, move). El bloque
// declare global evita que el usuario tenga que importar nada. NO
// incluye las versiones async de fs.* que devuelven Promise<...>
// (decisión de scope confirmada).
//
// V22 (Memory Model v2) eliminó Mut<T>, MutRef<T>, Unq<T> y deprecó
// Rc<T> — los cuatro se reemplazan por modificadores más explícitos
// (ptr<T> para unique_ptr, ref<T>/constRef<T> para préstamos, etc.).
// Esta plantilla refleja el dialecto V22; los proyectos generados antes
// de V22 deben regenerarse o actualizar types/estatic.d.ts a mano.
const estaticDts = `// Tipos del dialecto Estatic. Cargado por tsconfig.json para que el
// editor conozca los built-ins del dialecto y los helpers del runtime
// sin contaminar el código con imports.

declare global {

  // ─── Tipos numéricos concretos (V3) ──────────────────────────────────
  // El dialecto distingue anchos de bits. Para el editor son alias de
  // \'number\'; el transpilador enforce los rangos al compilar.
  type i8 = number;
  type i16 = number;
  type i32 = number;
  type i64 = number;
  type u8 = number;
  type u16 = number;
  type u32 = number;
  type u64 = number;
  type f32 = number;
  type f64 = number;

  // ─── Modificadores de memoria (V22 Memory Model v2) ──────────────────
  // Los 4 modificadores controlan explícitamente cómo se pasa un valor
  // entre funciones / métodos y cómo se almacenan los datos. El codegen
  // los traduce así (ver src/codegen/cpp-types.ts:cppMemoryType):
  //   ptrT       → std::unique_ptrT        (ownership exclusivo mutable)
  //   constPtrT  → std::unique_ptr<const T>  (ownership exclusivo readonly)
  //   refT       → T&                       (préstamo mutable no-null)
  //   constRefT  → const T&                 (préstamo readonly no-null)
  // Para el editor son alias de T; el type-checker enforce la
  // semántica (no fields refT, no retornos refT, no borrows en async,
  // move() solo sobre ptrT, etc.). Ver docs/memory-model.md.
  //
  // constPtr<T> y constRef<T> se proyectan como readonly profundos para
  // que el LSP muestre los miembros de T como readonly en hover. Asi
  // cuando el usuario escribe constRef sobre una clase Foo, el editor
  // le dice que foo.bar es readonly. Esto NO cambia el codegen (sigue
  // siendo T&) ni la semantica que enforce el type-checker (mensajes
  // E4203..E4207); solo afecta a lo que muestra el editor.
  // Fuente: src/project/init-project.ts:constRefType
  type constPtr<T> = T extends (...args: any[]) => any
    ? T
    : T extends object
      ? { readonly [K in keyof T]: constPtr<T[K]> }
      : T;
  type constRef<T> = T extends (...args: any[]) => any
    ? T
    : T extends object
      ? { readonly [K in keyof T]: constRef<T[K]> }
      : T;
  // ptr<T> y ref<T> son alias de T (mismo tipo que T). El type-checker
  // enforce la semantica de ownership/borrowing (E4100..E4103, E4206..E4210).
  // Distinguirlos como tipos separados seria ideal (para que el LSP marque
  // error si pasas un ptr<T> donde se espera un ref<T>), pero romperia la
  // ergonomia del dialecto (no podrias asignar un T literal a un ptr<T>).
  // Asi que son alias puros. Si necesitas distinguirlos, haz un type guard
  // con isPtr<T>(x) o usa los E4xxx del type-checker.
  type ptr<T> = T;
  type ref<T> = T;
  /** Marcar el tipo de un valor con un fantasma (phantom) para distinguir
   *  ptr<Foo> de un Foo crudo en APIs que lo necesitan. NO cambia el
   *  codegen. Usar solo si sabes lo que haces. */
  type Phantom<T, Brand extends string> = T;

  // ─── Inmutabilidad (existente desde antes de V22) ────────────────────
  // 'readonlyT' marca inmutabilidad. En el dialecto el checker rechaza
  // reasignaciones; aquí es alias cosmético para que el editor no marque
  // error de tipo inexistente.
  type readonly<T> = T;

  // ─── Guards del LSP: bloquear herencia y excepciones ──────────────────
  // Truco: declaramos un símbolo único con tipo never y un campo privado
  // opcional en cada "raíz" que NO debe poder extenderse. El LSP
  // (tsserver, typescript-language-server) marca error en rojo cuando
  // el usuario intenta heredar de una clase sellada o lanzar una
  // excepcion, antes incluso de compilar. El type-checker de Estatic
  // ya rechaza estas cosas a nivel parser, pero con estos guards el
  // feedback es instantáneo (el editor se queja mientras escribes).

  /** Simbolo fantasma que, al aparecer en la firma de un tipo, hace que
   *  TS rechace cualquier intento de extends. NO se puede importar. */
  declare const __noExtend: unique symbol;
  /** Simbolo fantasma que, al aparecer en la firma de un tipo, hace que
   *  TS rechace cualquier intento de 'throw new X()'. NO se puede importar. */
  declare const __noThrow: unique symbol;

  // Helper para que las clases declaradas mas abajo (Map, Set, Optional,
  // Result, Promise, Task) sean sealed. El type-checker de Estatic ya
  // rechaza la herencia en el parser, pero este sello cierra la puerta
  // tambien en el LSP antes de compilar.
  type Sealed = { readonly [__noExtend]?: never };

  // Helper equivalente para throw. Definir una clase 'class MyError extends Error'
  // ya no seria lanzable en el dialecto, aunque Estatic no tiene throw: lo
  // declaramos para que el LSP marque error en cuanto el usuario escribe
  // 'throw new ...'. El type-checker emitira E4xxx equivalente.
  type NonThrowable = { readonly [__noThrow]?: never };

  // Alias de Error y Exception que el dialecto no soporta. Si el usuario
  // intenta usar 'Error', 'Exception' o hacer 'throw new ...', el LSP le
  // marcara rojo inmediatamente. Estatic no tiene excepciones: los
  // errores se modelan con 'Result<T, E>'.
  type Error = NonThrowable & { name: "Error"; message: string };

  // ─── Envoltorios genéricos del runtime ────────────────────────────────
  // Mapean a ets::Optional / Task / Result / Map / Set en runtime/ets_*.hpp.
  // Los métodos de instancia reflejan lo que el type-checker reconoce
  // (ver src/semantic/type-checker.ts: ARRAY_METHODS, MAP_METHODS,
  // SET_METHODS, OPTIONAL_HELPERS y las ramas de Result.isOk/value/error).
  // Sin esto, el editor marca r.isOk() como error porque no está
  // declarado en ninguna parte.
  //
  // V22 eliminó 'UnqT' (era el unique_ptr pre-V22) y deprecó 'RcT'.
  // Ambos se sustituyen por 'ptrT' / 'constPtrT'; un reemplazo de
  // 'RcT' (shared) está planeado en un PR futuro basado en 'weakT'.
  // Por eso ya NO aparecen en esta plantilla.
  //
  // Todas las clases del runtime llevan Sealed para que el LSP bloquee
  // extends. El type-checker de Estatic tambien lo rechaza en parser.
  class Optional<T> extends Sealed {
    _brand: string;
    static some<T>(value: T): Optional<T>;
    static none<T>(): Optional<T>;
    // Métodos de instancia (helpers globales en runtime):
    isPresent(): boolean;
    isEmpty(): boolean;
    value(): T;
    valueOr(defaultValue: T): T;
  }
  class Result<T, E = string> extends Sealed {
    private readonly _brand: symbol;
    // El dialecto trata Result<T, E> como tagged union sintética; los
    // métodos isOk/value/error se infieren desde el tag 'ok'. Ver
    // type-checker.ts:2100-2108.
    isOk(): boolean;
    value(): T;
    error(): E;
  }
  // Lector de archivos por descriptor (streaming, sin copiar el archivo
  // entero en memoria). Vive en runtime/ets_file.hpp. La API permite
  // recorrer un archivo caracter a caracter o linea a linea, manteniendo
  // el fd del OS abierto durante toda la lectura.
  //
  // Patron de uso:
  //   let r: FileReader = openFileReader("/var/log/app.log")
  //   while (!r.eof()) {
  //     let line: string | null = r.readLine()
  //     if (line != null) process(line)
  //   }
  //   r.close()
  //
  // Si el archivo no existe, la funcion aborta con un mensaje de error.
  // Para error handling explicito, hacer el check con fileExists() antes.
  function openFileReader(path: string): FileReader;
  class FileReader extends Sealed {
    private readonly _brand: symbol;
    // Lee un byte y avanza el cursor. Devuelve -1 en EOF.
    readChar(): number;
    // Mira el siguiente byte SIN avanzar el cursor. Devuelve -1 en EOF.
    // Util para parsers que necesitan ver antes de consumir.
    peekChar(): number;
    // Mira los siguientes n bytes SIN avanzar el cursor. Devuelve hasta
    // n bytes (menos si EOF antes). Ideal para detectar BOMs, prefijos,
    // o firmas de archivos.
    peek(n: number): string;
    // Lee hasta n bytes desde el cursor. Si n es 0 o no se pasa, lee
    // hasta EOF. "" indica EOF.
    read(n?: number): string;
    // Lee hasta el proximo newline (incluido) y lo devuelve. Si el
    // archivo no termina en newline, la ultima linea se devuelve sin
    // el terminador. Devuelve string vacio cuando ya no hay mas
    // datos; usa eof() para distinguir EOF de una linea vacia valida.
    readLine(): string;
    // ¿Estamos al final del archivo?
    eof(): boolean;
    // Cierra el descriptor. Despues de esto el reader ya no es usable.
    close(): void;
  }
  class Promise<T> extends Sealed {
    private readonly _brand: symbol;
  }
  class Map<K, V> extends Sealed {
    private readonly _brand: symbol;
    // MAP_METHODS en type-checker.ts:199-205.
    get(key: K): V | void;
    set(key: K, value: V): void;
    has(key: K): boolean;
    delete(key: K): boolean;
    readonly size: number;
  }
  class Set<T> extends Sealed {
    private readonly _brand: symbol;
    // SET_METHODS en type-checker.ts:211-214.
    add(value: T): boolean;
    has(value: T): boolean;
    delete(value: T): boolean;
    readonly size: number;
  }
  // ArrayT es la representación genérica. La forma canónica en el
  // dialecto es T[] (chequea isArrayType en type-checker.ts), pero
  // también se acepta ArrayT como sinónimo. Declaramos ambos.
  interface ArrayLike<T> {
    // ARRAY_METHODS en type-checker.ts:227-254.
    filter<U extends T>(predicate: (value: T) => boolean): T[];
    map<U>(mapper: (value: T) => U): U[];
    reduce<U>(initial: U, reducer: (acc: U, value: T) => U): U;
    forEach(visitor: (value: T) => void): void;
    push(value: T): void;
    find(predicate: (value: T) => boolean): Optional<T>;
    some(predicate: (value: T) => boolean): boolean;
    every(predicate: (value: T) => boolean): boolean;
    slice(start: number, end?: number): T[];
    sort(comparator?: (a: T, b: T) => number): T[];
    flatMap<U>(mapper: (value: T) => U[]): U[];
    includes(value: T): boolean;
    readonly length: number;
  }
  // Tipo opaco para JSON.parseValue. Se manipula vía helpers globales
  // (jsonIsString, jsonAsString, ...).
  type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

  // ─── Helpers de runtime (runtime/ets_core.hpp) ──────────────────────
  /** Imprime los valores en stdout separados por espacios, seguidos de newline. */
  function print(...values: unknown[]): void;
  /** Convierte un numero a su representacion en string. */
  function numberToString(n: number): string;
  /** Sale del proceso con el codigo dado. NUNCA retorna (decorado con @noreturn). */
  function exitProcess(code: number): never;
  /** Reporta un mensaje de error via out-param (estilo C). Usado por el runtime. */
  function fail(message: string, error: string): boolean;
  /** Limpia el buffer de error. */
  function clearError(error: string): void;
  /** true si hay un mensaje de error pendiente. */
  function hasError(error: string): boolean;
  /** Devuelve el numero de argumentos pasados al programa (equivalente a process.argv.length - 1). */
  function argumentCount(): number;
  /** Asegura que el directorio padre del path existe. Crea los directorios necesarios. */
  function ensureParentDirectory(path: string, error: string): boolean;

  // ─── Transferencia de ownership (V22 Memory Model v2) ───────────────
  // move(x) es la única forma de transferir ownership de un 'ptrT' sin
  // copia. El argumento debe ser un identificador declarado como ptrT
  // o constPtrT (de lo contrario el type-checker emite E4100). Tras
  // la llamada, el uso de 'x' es diagnóstico E4102 (uso moved) o E4103
  // (uso maybe-moved, p.ej. dentro de una rama if sin else).
  function move<T>(x: ptr<T>): ptr<T>;
  function move<T>(x: constPtr<T>): constPtr<T>;

  // ─── Match intrinsics (V23) ────────────────────────────────────────
  // El dialecto expone una API declarativa para pattern matching
  // compatible con TypeScript. match(value, [when(pattern, callback),
  // ...]) se compila a un if/else chain (no a una llamada a funcion);
  // los intrinsics when/whenType/otherwise SOLO son validos dentro del
  // array de cases de match.
  //
  // Limitacion V23.1: whenType NO narrowa el tipo del subject. El
  // callback se invoca sin argumentos (usa captura por referencia si
  // necesitas el subject). Issue #95 deja el narrowing fuera de
  // alcance. Para type dispatching real, usa el V2 destructurado:
  //   match (r) { case { kind: "X", x }: ...; case _: ... }
  // que SI enforce exhaustividad.
  interface MatchValueCase<P, R> {
    readonly __matchKind: "value";
    readonly __pattern: P;
    readonly __result: R;
  }
  interface MatchTypeCase<T, R> {
    readonly __matchKind: "type";
    readonly __type: T;
    readonly __result: R;
  }
  interface MatchDefaultCase<R> {
    readonly __matchKind: "default";
    readonly __result: R;
  }
  type MatchCase =
    | MatchValueCase<any, any>
    | MatchTypeCase<any, any>
    | MatchDefaultCase<any>;
  type MatchCaseResult<C> =
    C extends MatchValueCase<any, infer R> ? R
    : C extends MatchTypeCase<any, infer R> ? R
    : C extends MatchDefaultCase<infer R> ? R
    : never;
  type MatchResult<Cases extends readonly MatchCase[]> =
    MatchCaseResult<Cases[number]>;
  function when<const P, R>(
    pattern: P,
    callback: (value: P) => R
  ): MatchValueCase<P, R>;
  function whenType<T, R>(
    callback: (value: T) => R
  ): MatchTypeCase<T, R>;
  function otherwise<R>(
    callback: (value: any) => R
  ): MatchDefaultCase<R>;
  function match<
    T,
    const Cases extends readonly MatchCase[]
  >(
    value: T,
    cases: Cases
  ): MatchResult<Cases>;
  function match<
    T,
    const Cases extends readonly MatchCase[]
  >(
    value: T,
    discriminator: string,
    cases: Cases
  ): MatchResult<Cases>;

  // ─── Helpers async (ASYNC_HELPERS + ASYNC_PRIMITIVE_HELPERS) ────────
  // sleep y spawn son funciones globales del runtime (registradas
  // en type-checker.ts:446-447). all y race se manejan como casos
  // especiales del type-checker (no están en la tabla de helpers, ver
  // type-checker.ts:161-164 y 1869-1880). race en el estado actual
  // del repo es SECUENCIAL: devuelve el primer elemento del array
  // (ver LIMITATIONS.md / test task-race). all sí espera a todos.
  function sleep(ms: number): Promise<void>;
  function spawn(task: Promise<void>): void;
  function all<T>(tasks: Promise<T>[]): T[];
  function race<T>(tasks: Promise<T>[]): T;

  // ─── Helpers de OptionalT ─────────────────────────────────────────
  function optionalSome<T>(value: T): Optional<T>;
  function optionalNone<T>(): Optional<T>;

  // ─── Helpers de filesystem (runtime/ets_file.hpp) ──────────────────
  function fileRead(path: string): string;
  function fileWrite(path: string, content: string): boolean;
  function fileAppend(path: string, content: string): boolean;
  function fileExists(path: string): boolean;
  function fileCopy(src: string, dst: string): boolean;
  function fileMove(src: string, dst: string): boolean;
  function fileRemove(path: string): boolean;

  // ─── Helpers de networking (runtime/ets_net_sync.hpp) ──────────────
  function tcpListen(host: string, port: number): number;
  function tcpAccept(listenerFd: number): number;
  function tcpConnect(host: string, port: number): number;
  function tcpRead(fd: number, maxBytes: number): string;
  function tcpWrite(fd: number, data: string): boolean;
  function tcpClose(fd: number): void;

  // ─── Cliente HTTP/1.1 (runtime/ets_http.hpp) ──────────────────────────
  // Cliente HTTP plano (sin HTTPS todavia). Usa getaddrinfo para DNS y
  // sockets POSIX bloqueantes. Lee el body completo (sin streaming).
  //
  // Limitaciones:
  //   - HTTP/1.1 plano (puerto 80). HTTPS requiere TLS client que aun
  //     no esta implementado en runtime/ets_tls.hpp (solo server).
  //   - Sin redirecciones automaticas. Si status es 3xx, el caller
  //     decide si hace otra peticion.
  //   - Sin timeout por defecto.
  //   - Sin cookies, gzip, autenticacion.
  //
  // Caso de uso: integraciones simples, health checks, webhooks, fetch
  // de JSON publico.
  // ─── Servidor HTTP ─────────────────────────────────────────────────
  // API de routing sin dependencias externas. La implementacion vive
  // en runtime/ets_http_server.hpp y se compila al binario.
  //
  // Cada handler es una funcion sincrona (req, res) => void. El server
  // parsea el request antes de invocar al handler y serializa la
  // response al volver. Para hacer I/O async dentro del handler, el
  // handler puede disparar un spawn(...) y devolver inmediatamente.
  //
  // Limitaciones: HTTP/1.1 plano, sin HTTPS, sin middlewares, sin
  // streaming, sin cookies, sin compresion.
  // Los nombres "Request" y "Response" pertenecen al namespace "http" para
  // evitar choques con cualquier otra cosa del usuario. Se accede a ellos
  // como http.Request y http.Response en los handlers.
  namespace http {
    /** Request HTTP pre-parseado. El server rellena los campos antes de invocar al handler. */
    interface Request {
      /** "GET", "POST", "PUT", "PATCH", "DELETE". */
      readonly method: string;
      /** Path sin query string. "/api/users". */
      readonly path: string;
      /** Query string cruda. "id=42&name=alice". Vacia si no hay. */
      readonly rawQuery: string;
      /** Cuerpo del request (POST/PUT/PATCH). Vacio si no hay body. */
      readonly body: string;
    }

    /** Response HTTP. El handler la muta encadenando status/header/send/json. */
    interface Response {
      /** Cambia el status code. Encadenable. */
      status(code: number): Response;
      /** Anyade un header. Encadenable. Si el header ya existe, lo sobreescribe. */
      header(name: string, value: string): Response;
      /** Envia un body de texto. Auto-set Content-Type: text/plain si no se dio uno. */
      send(body: string): Response;
      /** Envia un body JSON. Auto-set Content-Type: application/json. */
      json(jsonString: string): Response;
    }

    /** Crea un nuevo Server listo para registrar handlers. */
    function createServer(): Server;
    /** Devuelve el path param name del request, o "" si no existe. */
    function param(req: Request, name: string): string;
    /** Devuelve el query string value de name, o "" si no existe. URL-decoded. */
    function query(req: Request, name: string): string;
    /** Devuelve el header name del request (case-insensitive), o "" si no existe. */
    function header(req: Request, name: string): string;
  }

  // Los handlers reciben (req: http.Request, res: http.Response).
  class Server extends Sealed {
    /** Registra un handler para method + path. path puede tener :params. */
    get(path: string, handler: (req: http.Request, res: http.Response) => void): void;
    post(path: string, handler: (req: http.Request, res: http.Response) => void): void;
    put(path: string, handler: (req: http.Request, res: http.Response) => void): void;
    patch(path: string, handler: (req: http.Request, res: http.Response) => void): void;
    delete(path: string, handler: (req: http.Request, res: http.Response) => void): void;
    /** Arranca el server en 0.0.0.0:port. Bloquea hasta SIGINT. */
    listen(port: number): void;
  }

  // ─── Helpers de JsonValue ──────────────────────────────────────────
  function jsonIsString(v: JsonValue): boolean;
  function jsonIsNumber(v: JsonValue): boolean;
  function jsonIsBool(v: JsonValue): boolean;
  function jsonIsArray(v: JsonValue): boolean;
  function jsonIsObject(v: JsonValue): boolean;
  function jsonIsNull(v: JsonValue): boolean;
  function jsonAsString(v: JsonValue): string;
  function jsonAsNumber(v: JsonValue): number;
  function jsonAsBool(v: JsonValue): boolean;
  function jsonArrayLength(v: JsonValue): number;
  function jsonArrayGet(v: JsonValue, index: number): JsonValue;
  function jsonObjectGet(v: JsonValue, key: string): JsonValue;

  // ─── Built-in globals (RUNTIME_GLOBAL_NAMES en type-checker) ───────
  namespace console {
    function log(...values: unknown[]): void;
    function info(...values: unknown[]): void;
    function debug(...values: unknown[]): void;
    function trace(...values: unknown[]): void;
    function warn(...values: unknown[]): void;
    function error(...values: unknown[]): void;
    /** Lanza AssertionError si value es falsy. */
    function assert(value: unknown, message?: string): void;
  }
  /** Funciones matematicas basicas estilo JavaScript (envoltorio de <cmath>). */
  namespace Math {
    function floor(value: number): number;
    function ceil(value: number): number;
    function round(value: number): number;
    function abs(value: number): number;
    function sqrt(value: number): number;
    function pow(base: number, exponent: number): number;
    function min(a: number, b: number): number;
    function max(a: number, b: number): number;
  }
  /** API minima estilo JavaScript para tiempo. */
  namespace Date {
    /** ms desde epoch (1970-01-01T00:00:00Z). */
    function now(): number;
    /** ms UTC desde epoch para (year, month, day). month es 0-based. */
    function utc(year: number, month: number, day: number): number;
  }
  namespace fs {
    // Versiones *Sync (devuelven Result<...> o boolean). Cobertura mínima:
    // las versiones async (que devuelven Promise<...>) se omiten por scope.
    function readFileSync(path: string): Result<string>;
    function writeFileSync(path: string, data: string): Result<boolean>;
    function appendFileSync(path: string, data: string): Result<boolean>;
    function copyFileSync(src: string, dst: string): Result<boolean>;
    function renameSync(oldPath: string, newPath: string): Result<boolean>;
    function unlinkSync(path: string): Result<boolean>;
    function existsSync(path: string): boolean;
  }
  namespace path {
    function dirname(p: string): string;
    function basename(p: string): string;
    function extname(p: string): string;
    function isAbsolute(p: string): boolean;
    function normalize(p: string): string;
    function join(parts: string[]): string;
    function resolve(parts: string[]): string;
  }
  namespace process {
    const argc: number;
    const argv: string[];
    function cwd(): string;
    function exit(code: number): void;
  }
  namespace JSON {
    function stringify(value: string): string;
    function stringifyNumber(value: number): string;
    function stringifyBool(value: boolean): string;
    function stringifyValue(value: JsonValue): string;
    function parse(text: string): string;
    function parseValue(text: string): JsonValue;
  }
}

export {};
`;

const templates: ReadonlyArray<readonly [string, string]> = [
  ["src/main.ts", `print("Hola desde Estatic");
`],
  ["estatic.config.ts", `// Editores (VSCode/Neovim) usan tsconfig.json + types/estatic.d.ts para
// conocer los built-ins del dialecto (Unq, Mut, fs, path, process...).
// No necesitas importar nada: los globales están disponibles vía
// \'declare global\' en el .d.ts.
export default {
  entry: "src/main.ts",
  moduleRoots: ["src"],
  aliases: {},
  output: {
    cpp: "build/app.cpp",
    binary: "build/app"
  },
  compiler: {
    enabled: true,
    command: "g++",
    flags: ["-std=c++20", "-O2", "-pthread", "-fno-exceptions", "-ffunction-sections", "-fdata-sections"],
    linkFlags: ["-Wl,--gc-sections", "-Wl,--as-needed", "-s"]
  },
  incremental: {
    enabled: true,
    cacheDirectory: "build/.estatic/cache",
    generatedDirectory: "build/.estatic/generated"
  },
  logging: {
    enabled: true,
    file: "build/.estatic/transpiler-report.json",
    level: "debug"
  }
};
`],
  ["tsconfig.json", tsconfigJson],
  ["types/estatic.d.ts", estaticDts],
  [".gitignore", `build/
node_modules/
`],
  ["README.md", `# Proyecto Estatic

Compila el proyecto desde este directorio:

\`\`\`bash
estatic --config estatic.config.ts
./build/app
\`\`\`

Durante el desarrollo, si ejecutas el CLI desde el repositorio del compilador:

\`\`\`bash
npm start -- --config /ruta/al/proyecto/estatic.config.ts
\`\`\`

## Soporte del editor

El proyecto incluye:

- \`tsconfig.json\` — configura el editor (VSCode/Neovim) para usar
  \`moduleResolution: "bundler"\` y, sobre todo, \`"lib": ["es2022"]\` y
  \`"types": []\`. Eso evita que tsserver añada APIs de DOM o de Node
  (\`Buffer\`, \`__dirname\`, etc.) que el dialecto no implementa.
- \`types/estatic.d.ts\` — declaraciones de los built-ins del dialecto
  (modificadores de memoria V22 \`ptr<T>\`, \`constPtr<T>\`, \`ref<T>\`,
  \`constRef<T>\`; \`readonly<T>\`; envoltorios \`Optional<T>\`, \`Result\`,
  \`Promise\`, \`Map\`, \`Set\`; \`fs.*Sync\`, \`path.*\`, \`process.*\`,
  \`JSON\`, \`console\`; transferidor \`move<T>(x: ptr<T>)\`) y los helpers
  del runtime (\`print\`, \`numberToString\`, helpers de Optional/JsonValue).
  \`declare global\` los expone sin imports.

Si tu editor sigue marcando errores sobre tipos del dialecto, abre la
paleta de comandos y elige "TypeScript: Restart TS Server".
`]
];

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

export async function initializeProject(target = "."): Promise<InitializedProject> {
  const directory = resolve(target);
  const files = templates.map(([relative]) => join(directory, relative));
  const conflicts = (await Promise.all(files.map(async file => ({ file, exists: await exists(file) })))).filter(item => item.exists);
  if (conflicts.length > 0) {
    throw new Error(`No se inicializó el proyecto para no sobrescribir: ${conflicts.map(item => item.file).join(", ")}`);
  }
  for (const [relative, contents] of templates) {
    const file = join(directory, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents, { encoding: "utf8", flag: "wx" });
  }
  return { directory, files };
}
