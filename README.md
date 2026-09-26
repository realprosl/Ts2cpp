# Estatic TS → C++

Transpilador modular escrito en TypeScript de un lenguaje con sintaxis inspirada en TypeScript, tipado estático y salida C++20. La implementación canónica vive en `src/`.

## Uso rápido

Requiere Node.js 22.6+ y, para compilar la salida, un compilador C++20.

Para crear un proyecto nuevo con configuración, entrada, `.gitignore` y documentación:

```bash
npm start -- init mi-proyecto
cd mi-proyecto
node --experimental-strip-types /ruta/a/etsc/src/cli.ts --config estatic.config.ts
./build/app
```

`init` no sobrescribe ninguno de esos archivos si el directorio ya contiene un proyecto.

Compilación directa de un ejemplo:

```bash
npm start -- examples/hello.ets -o hello.cpp
g++ -std=c++20 -fno-exceptions -pthread -I. hello.cpp -o hello
./hello
```

Ejemplo integral de clases, composición e interfaces estructurales:

```bash
npm start -- examples/complete-demo.ets -o complete-demo.cpp
g++ -std=c++20 -fno-exceptions -pthread -I. complete-demo.cpp -o complete-demo
./complete-demo
```

No requiere instalar dependencias npm: usa el soporte nativo de TypeScript de Node. Los binarios nativos enlazan las cabeceras de `runtime/` y los objetos Tree-sitter desde `third_party/`. No se utiliza CMake.

## Configuración del proyecto

`estatic.config.ts` centraliza la entrada, roots y aliases de módulos, salidas y compilación nativa directa. No utiliza CMake.

```typescript
import type { EstaticConfig } from "./src/config/project-config.ts";

export default {
  entry: "src/main.ts",
  moduleRoots: ["src", "packages"],
  aliases: { "@core": "src/core" },
  output: { cpp: "build/app.cpp", binary: "build/app" },
  compiler: {
    enabled: true,
    command: "clang++", // También g++ u otro compilador C++20.
    flags: ["-std=c++20", "-O3", "-march=native", "-flto", "-pthread", "-fno-exceptions", "-ffunction-sections", "-fdata-sections"],
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
} satisfies EstaticConfig;
```

Sin argumentos, el CLI localiza la configuración y, si `compiler.enabled` es `true`, genera C++ y ejecuta directamente el compilador indicado:

```bash
npm start
npm start -- --config otra.config.ts --build
npm start -- --config otra.config.ts --build --unity
```

Con la compilación incremental activa, cada módulo `.ts` o `.ets` produce su propia unidad C++ y su propio objeto `.o`. Los objetos se identifican por el contenido del módulo, las declaraciones compartidas, el runtime, el compilador y sus flags. Una segunda compilación reutiliza los objetos válidos y también evita el enlace cuando nada ha cambiado. `--unity` fuerza la salida histórica de un único `.cpp`, útil para inspección y depuración. Un archivo de entrada y `-o` continúan disponibles para compilaciones puntuales y usan ese modo unitario.

En perfiles de release se separan funciones y datos por sección, el enlazador elimina secciones y bibliotecas no utilizadas y el binario se entrega sin símbolos internos. Tree-sitter y la gramática TypeScript solo se enlazan cuando el ejecutable utiliza las APIs de sintaxis o AST; una aplicación normal no incorpora el parser del compilador. Para conservar símbolos durante la depuración, utilice el perfil `debug` y retire `-s` de `linkFlags`.

## Lenguaje implementado

- Tipos `number`, `string`, `boolean` y `void`.
- `let` y `const`, con anotación explícita o inferencia desde el inicializador.
- Funciones tipadas, bloques, `return`, `if/else` y `while`.
- Bucles `for`, junto con `break` y `continue` validados por contexto.
- Operadores aritméticos, relacionales, igualdad y lógica booleana.
- Salida variádica separada por `stdout` y `stderr`.
- Diagnósticos con archivo, línea, columna y fragmento de código.
- Biblioteca estándar mínima para strings, archivos y argumentos de proceso.
- Interfaces estructurales emitidas como conceptos de C++20, sin herencia ni vtables.
- Clases por valor emitidas como `struct`; se relacionan mediante composición de campos.
- Arrays homogéneos `T[]` emitidos como `std::vector<T>`.
- Tuplas heterogéneas `[A, B, ...]` emitidas como `std::tuple<A, B, ...>`.
- Funciones flecha y closures emitidas como lambdas y `std::function`.
- Funciones y clases genéricas emitidas como templates de C++20.
- Sobrecargas de funciones libres y métodos resueltas estáticamente por firma.
- Constraints genéricos `T extends Interface` emitidos como concepts.
- Packs genéricos heterogéneos y parámetros rest emitidos como parameter packs de C++20.
- Funciones `async`, `Promise<T>` y `await` emitidos como corutinas C++20.
- Event loop cooperativo, temporizadores, tareas desacopladas y sockets TCP no bloqueantes.
- Parámetros síncronos no triviales prestados automáticamente como referencias constantes.
- Préstamos mutables explícitos mediante parámetros `mut`, emitidos como `T&`.
- Errores explícitos mediante `Result<T>` o parámetros `out` compatibles; el runtime no lanza excepciones.
- Imports relativos, roots y aliases resueltos mediante un grafo de módulos.
- Visibilidad nominal entre módulos mediante `export` e imports explícitos.
- Informe JSON cronológico de cada transpilación y compilación.

```typescript
interface Named {
  name(): string;
}

function show(value: Named): void {
  print(value.name());
}
```

La interfaz anterior se convierte en un `concept Named` y `show` en una función plantilla restringida. `interface` no admite `extends`: la reutilización de comportamiento se diseña mediante composición.

## Clases mediante composición

Las clases son tipos concretos por valor. Sus argumentos de construcción corresponden, en orden, a sus campos. No existe `extends`, clase base, método virtual ni conversión descendente.

```typescript
class Motor {
  power: number;
}

class Car {
  motor: Motor;
  name: string;

  power(): number {
    return this.motor.power;
  }
}

let motor: Motor = new Motor(120);
let car: Car = new Car(motor, "Coupe");
print(car.power());
```

El backend genera `struct Motor` y `struct Car`, donde `Car` contiene un `Motor`. Una clase satisface una interfaz automáticamente cuando sus métodos coinciden; no se escribe `implements`.

## Control de flujo

```typescript
let total: number = 0;
for (let index: number = 0; index < 10; index = index + 1) {
  if (index == 2) { continue; }
  if (index == 8) { break; }
  total = total + index;
}
```

El inicializador del `for` tiene su propio scope. El analizador rechaza `break` y `continue` fuera de `for` o `while`.

Las operaciones que pueden fallar devuelven `Result<T>`:

```typescript
const contents: Result<string> = readFile("input.ets");
if (contents.isOk()) {
  print(contents.value());
} else {
  printError(contents.error());
}
```

## Archivos, consola y errores nativos

Las funciones de archivo tienen sobrecargas que devuelven `Result<T>`. `isOk()` indica éxito, `value()` entrega el valor y `error()` contiene el diagnóstico. No lanzan excepciones. Las firmas anteriores con `out error` se conservan para compatibilidad y para el frontend autoalojado.

| Función | Resultado |
| --- | --- |
| `fileExists(path)` | Indica si existe un archivo regular. |
| `readFile(path)` | Lee en binario y retorna `Result<string>`. |
| `writeFile(path, contents)` | Crea o reemplaza y retorna `Result<boolean>`. |
| `appendFile(path, contents)` | Crea o añade y retorna `Result<boolean>`. |
| `copyFile(source, destination)` | Copia y retorna `Result<boolean>`. |
| `moveFile(source, destination)` | Mueve o renombra y retorna `Result<boolean>`. |
| `removeFile(path)` | Elimina y retorna `Result<boolean>`. |

Todas las operaciones disponen además de una variante que se ejecuta en el pool de trabajo del runtime y devuelve una corutina:

| API asíncrona | Tipo de retorno |
| --- | --- |
| `readFileAsync(path)` | `Promise<Result<string>>` |
| `writeFileAsync(path, contents)` | `Promise<Result<boolean>>` |
| `appendFileAsync(path, contents)` | `Promise<Result<boolean>>` |
| `fileExistsAsync(path)` | `Promise<Result<boolean>>` |
| `copyFileAsync(source, destination)` | `Promise<Result<boolean>>` |
| `moveFileAsync(source, destination)` | `Promise<Result<boolean>>` |
| `removeFileAsync(source, destination)` | `Promise<Result<boolean>>` |

```typescript
async function load(path: string): Promise<Result<string>> {
  return readFileAsync(path);
}

const contents: Result<string> = await load("input.txt");
```

Estas variantes no ejecutan una llamada de disco bloqueante en el hilo del event loop. El trabajo se envía a un pool acotado de 2 a 4 workers y su finalización despierta el `poll` mediante una tubería interna.

Las variantes compatibles añaden sus salidas al final: `readFile(path, out contents, out error)` y, para las demás, `operación(..., out error)`. Retornan `boolean` y limpian `error` cuando tienen éxito.

`Result<T>` también puede utilizarse en cualquier función síncrona propia. `ok(value)` infiere `T` desde el valor; `err(message)` lo infiere desde el retorno o la variable destino. Sin contexto debe indicarse el tipo: `err<number>("mensaje")`.

```typescript
function divide(left: number, right: number): Result<number> {
  if (right == 0) { return err("division by zero"); }
  return ok(left / right);
}
```

La salida de consola está separada por canal y por uso de salto de línea:

- `print(...)` escribe en `stdout` y termina la línea.
- `write(...)` escribe en `stdout` sin salto y vacía el buffer.
- `printError(...)` escribe en `stderr` y termina la línea.
- `writeError(...)` escribe en `stderr` sin salto y vacía el buffer.

Las utilidades `fail(message, out error)`, `hasError(error)` y `clearError(out error)` permiten construir errores explícitos en funciones propias.

### API estilo Node (`console.*`)

El identificador global `console` expone la misma forma que en Node, mapeado por debajo a las funciones planas de arriba:

| API | Canal | Implementación |
| --- | --- | --- |
| `console.log(...)` | stdout (con salto de línea) | `print(...)` |
| `console.info(...)` | stdout (con salto de línea) | `print(...)` |
| `console.debug(...)` | stdout (con salto de línea) | `print(...)` |
| `console.trace(...)` | stdout (con salto de línea) | `print(...)` |
| `console.warn(...)` | stderr (con salto de línea) | `printError(...)` |
| `console.error(...)` | stderr (con salto de línea) | `printError(...)` |

Todas las firmas son variádicas y aceptan `string`, `number` y `boolean` mezclados en una sola llamada. El analizador rechaza cualquier otro método con un diagnóstico explícito. Ver [examples/console-demo.ets](examples/console-demo.ets).

```typescript
console.log("Hola desde console.log");
console.info("Info:", 42, true);
console.warn("Esto sale por stderr");
console.error("Error grave:", "fallo X");
```

### API estilo Node (`fs.*`)

El identificador global `fs` agrupa las operaciones de archivo bajo la misma forma que en Node. Las versiones sin sufijo son asíncronas y devuelven `Promise<Result<T>>`; las versiones `Sync` son síncronas y devuelven `Result<T>` (o `boolean` para `existsSync`). Por debajo delegan en las funciones libres de `runtime/ets_file.hpp`.

| API | Firma | Equivalente interno |
| --- | --- | --- |
| `fs.readFile(path)` | `Promise<Result<string>>` | `readFileAsync(path)` |
| `fs.writeFile(path, contents)` | `Promise<Result<boolean>>` | `writeFileAsync(path, contents)` |
| `fs.appendFile(path, contents)` | `Promise<Result<boolean>>` | `appendFileAsync(path, contents)` |
| `fs.copyFile(source, destination)` | `Promise<Result<boolean>>` | `copyFileAsync(source, destination)` |
| `fs.rename(oldPath, newPath)` | `Promise<Result<boolean>>` | `moveFileAsync(oldPath, newPath)` |
| `fs.unlink(path)` | `Promise<Result<boolean>>` | `removeFileAsync(path)` |
| `fs.readFileSync(path)` | `Result<string>` | `readFile(path)` (overload `Result`) |
| `fs.writeFileSync(path, contents)` | `Result<boolean>` | `writeFile(path, contents)` (overload `Result`) |
| `fs.appendFileSync(path, contents)` | `Result<boolean>` | `appendFile(path, contents)` (overload `Result`) |
| `fs.copyFileSync(source, destination)` | `Result<boolean>` | `copyFile(source, destination)` (overload `Result`) |
| `fs.renameSync(oldPath, newPath)` | `Result<boolean>` | `moveFile(oldPath, newPath)` (overload `Result`) |
| `fs.unlinkSync(path)` | `Result<boolean>` | `removeFile(path)` (overload `Result`) |
| `fs.existsSync(path)` | `boolean` | `fileExists(path)` |

El analizador rechaza cualquier otro método con un diagnóstico que lista las APIs válidas. Ver [examples/fs-demo.ets](examples/fs-demo.ets).

```typescript
if (fs.existsSync("/tmp/cache.txt")) {
  const removed: Result<boolean> = fs.unlinkSync("/tmp/cache.txt");
  if (removed.isOk() == false) { console.error(removed.error()); }
}
const written: Result<boolean> = fs.writeFileSync("/tmp/cache.txt", "v1");
if (written.isOk()) {
  const contents: Result<string> = fs.readFileSync("/tmp/cache.txt");
  if (contents.isOk()) console.log(contents.value());
}

const asyncRead: Promise<Result<string>> = fs.readFile("/tmp/cache.txt");
const data: Result<string> = await asyncRead;
```

`await` a nivel superior se traduce a `ets::syncWait` porque la función `main` de C++ no puede ser corutina. Dentro de una `async function` se convierte en `co_await` como cualquier otra promesa.

## Paso de parámetros sin copias

Los parámetros normales son inmutables en el lenguaje. El backend aprovecha esa garantía y selecciona automáticamente un ABI eficiente sin cambiar la firma lógica:

```typescript
function inspect(values: number[], label: string, count: number): number {
  print(label);
  return count + length(values);
}
```

```cpp
double inspect(
    const std::vector<double>& values,
    const std::string& label,
    double count
);
```

| Parámetro fuente | C++ generado |
| --- | --- |
| `number`, `boolean` | Por valor |
| Strings, arrays, tuplas y clases | `const T&` |
| Interfaces y tipos genéricos | `const T&` |
| Firmas de closures | Referencias constantes para tipos no triviales |
| Pack variádico síncrono | `const T&...` |
| `mut value: T` | `T&` con lectura y escritura |
| `out value: T` | `T&` |
| Parámetro de función `async` | Por valor dentro del frame de corutina |

Los retornos siguen siendo valores y aprovechan RVO, NRVO y movimiento de C++. Las corutinas conservan parámetros por valor porque una referencia podría quedar colgando durante una suspensión. Por el mismo motivo, las funciones `async` rechazan parámetros `mut` y `out` hasta disponer de análisis de duración.

`Result<T>::value()` devuelve ahora una referencia al valor almacenado cuando el `Result` sigue vivo, por lo que consultar o imprimir un `Result<string>` ya no copia todo el texto. Al mover un `Result` temporal, C++ puede mover también su contenido.

El AST representa los modos `automatic`, `mut`, `out` y `move`. Sin modificador, los escalares pasan por valor y los objetos por referencia constante. `mut` exige una variable mutable —no una constante ni un temporal— y permite modificarla. `out` conserva su significado de resultado por argumento.

```typescript
class Counter { value: number; }

function inspect(counter: Counter): number {
  return counter.value;
}

function increment(mut counter: Counter): void {
  counter.value = counter.value + 1;
}
```

## Arrays y tuplas

```typescript
let values: number[] = [10, 20, 30];
values[1] = 25;

const metadata: [string, boolean] = ["active", true];

print(length(values));
print(values[1]);
print(metadata[0]);
```

Los arrays requieren un único tipo de elemento y admiten índices numéricos. Las tuplas conservan el tipo de cada posición; por eso su índice debe ser un literal entero conocido durante la compilación. Los arrays vacíos necesitan anotación, por ejemplo `let values: number[] = [];`.

## Funciones flecha y closures

```typescript
function makeAdder(amount: number): (value: number) => number {
  return (value: number): number => value + amount;
}

function makeCounter(start: number): () => number {
  let count: number = start;
  return (): number => {
    count = count + 1;
    return count;
  };
}

const addTen = makeAdder(10);
const counter = makeCounter(100);

print(addTen(5));
print(counter());
print(counter());
```

Los tipos de función usan la sintaxis TypeScript `(parametro: Tipo) => Retorno` y se emiten como `std::function`. Las variables externas se capturan por valor en una lambda `mutable`, por lo que una closure puede conservar estado privado entre llamadas. Una función flecha con cuerpo de bloque necesita declarar su retorno; las de expresión pueden inferirlo.

## Genéricos

```typescript
function identity<T>(value: T): T {
  return value;
}

function first<T>(values: T[]): T {
  return values[0];
}

class Box<T> {
  value: T;

  get(): T {
    return this.value;
  }
}

const inferred = identity("hello");
const explicit = identity<number>(7);
const box: Box<number> = new Box<number>(42);
```

Los argumentos de tipo de funciones se infieren recorriendo arrays, tuplas, firmas de función y clases genéricas anidadas. También pueden indicarse explícitamente. El analizador detecta conflictos de inferencia y aridad incorrecta. El backend genera `template <typename T>` y deja que C++ realice la instanciación.

Actualmente los genéricos declarables se limitan a funciones y clases. Aún no existen parámetros predeterminados, especializaciones ni restricciones genéricas escritas por el usuario; las interfaces continúan funcionando como `concepts` estructurales sobre las instancias resultantes.

## Sobrecargas y genéricos variádicos

```typescript
function describe(value: number): string {
  return "number=" + numberToString(value);
}

function describe(value: string): string {
  return "string=" + value;
}

function describe<T>(value: T): string {
  return "generic";
}

function logAll<...T>(...values: T): void {
  print(values);
}

print(describe(42.0));       // elige number
print(describe("hello"));    // elige string
print(describe(true));       // elige T
logAll("mixed: ", 10, true);
logAll<number, string>(7, " explicit");
```

Una función puede tener varias declaraciones con el mismo nombre si sus parámetros forman firmas distintas; el tipo de retorno no basta para sobrecargar. Las firmas concretas tienen prioridad sobre las genéricas y el compilador informa cuando no hay coincidencia, existe ambigüedad o se repite una firma equivalente. La sintaxis `<...T>` declara un pack de tipos y `...values: T` su parámetro rest, que debe ser el último. En C++ se generan `template <typename... T>` y `T... values`; al usar el pack como argumento se emite `values...`.

Las clases e interfaces pueden declarar varias firmas del mismo método. Los constraints usan una interfaz estructural y no introducen herencia:

```typescript
function display<T extends Named>(value: T): string {
  return value.name();
}
```

En C++ se genera `template <Named T>`. Limitaciones actuales: no hay sobrecargas de closures, los packs solo pueden declararse en funciones y no hay valores genéricos predeterminados ni especializaciones. La resolución es estática y no introduce coerciones implícitas.

## Async/await con corutinas C++20

```typescript
async function loadValue(): Promise<number> {
  return 21;
}

async function calculate(): Promise<number> {
  const value: number = await loadValue();
  return value * 2;
}

async function notify(message: string): Promise<void> {
  print(message);
  return;
}

const pending: Promise<number> = calculate();
const result: number = await pending;
await notify("async complete");
print(result);
```

`Promise<T>` se emite como el tipo move-only `ets::Task<T>` del runtime. Una función `async` genera una corutina con `co_return`; dentro de ella, `await` genera `co_await`. El retorno puede ser un valor `T` o directamente otro `Promise<T>`, que se aplana mediante `co_await`. En el nivel superior, `await` utiliza `ets::syncWait` porque la función `main` de C++ no puede ser una corutina.

El analizador rechaza `await` dentro de funciones síncronas, operandos que no sean `Promise<T>`, retornos incompatibles y funciones `async` sin retorno `Promise<T>`. El runtime sigue compilándose con `-fno-exceptions` y no emplea `throw` ni `try/catch`.

Las corutinas se integran con un event loop, temporizadores, red TCP no bloqueante y un pool acotado para operaciones de archivos. Las continuaciones vuelven al hilo del event loop. `CancellationSource`/`CancellationToken` permiten cancelar esperas y las APIs `*Until` reciben un deadline relativo en milisegundos. Todavía no existe `Promise.all`; métodos y funciones flecha asíncronos quedan para una extensión posterior.

## Rendimiento de strings y archivos

- Una cadena `a + b + c + d` se emite como `ets::concat(a, b, c, d)`: calcula el tamaño total, reserva una vez y evita las cadenas temporales intermedias.
- `numberToString` utiliza `std::to_chars` en lugar de construir un stream.
- `readFile` consulta el tamaño del archivo, dimensiona directamente el `string` final y lee sobre su buffer. Conserva un camino por bloques de 64 KiB para pipes y archivos cuyo tamaño cambia durante la lectura.
- `writeFile` y `appendFile` manejan escrituras parciales e interrupciones; append utiliza `O_APPEND`.
- Las APIs síncronas siguen siendo apropiadas para herramientas secuenciales. En servidores debe preferirse la variante `Async` para no detener sockets, timers ni otras corutinas.
- En Linux, lectura, escritura y append asíncronos intentan usar `io_uring` mediante syscalls directas y anillos reutilizados por worker. `ioUringAvailable()` permite consultar la capacidad; si el kernel o sandbox la bloquea, el runtime usa automáticamente las operaciones POSIX del pool.

## Servidores y red asíncrona

El runtime incorpora un event loop cooperativo basado en `poll`. Las corutinas se suspenden cuando un socket no está listo y se reanudan únicamente cuando el descriptor permite continuar. `spawn` mantiene tareas concurrentes dentro del mismo hilo sin crear un thread por conexión.

```typescript
async function handleClient(connection: TcpConnection): Promise<void> {
  const request: Result<string> = await readTcp(connection, 16384);
  if (request.isOk()) {
    const response: string = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHello";
    const written: Result<number> = await writeTcp(connection, response);
    if (written.isOk() == false) { printError(written.error()); }
  }
  closeTcp(connection);
  return;
}

async function serve(): Promise<void> {
  const opened: Result<TcpListener> = listenTcp("0.0.0.0", 8080);
  if (opened.isOk() == false) { printError(opened.error()); return; }
  const listener: TcpListener = opened.value();
  while (true) {
    const accepted: Result<TcpConnection> = await acceptTcp(listener);
    if (accepted.isOk()) { spawn(handleClient(accepted.value())); }
    else { printError(accepted.error()); }
  }
}

await serve();
```

| API | Función |
| --- | --- |
| `listenTcp(host, port)` | Abre un listener no bloqueante y devuelve `Result<TcpListener>`. |
| `acceptTcp(listener)` | Espera una conexión sin bloquear el hilo. |
| `readTcp(connection, maxBytes)` | Lee hasta 1 MiB por operación. |
| `writeTcp(connection, data)` | Escribe todo el buffer respetando backpressure del socket. |
| `closeTcp(resource)` | Cierra una conexión o listener compartido. |
| `sleep(milliseconds)` | Suspende una corutina mediante temporizador. |
| `spawn(task)` | Desacopla un `Promise<void>` para atender trabajo concurrente. |

Las variantes `acceptTcpUntil`, `readTcpUntil` y `writeTcpUntil` añaden timeout y `CancellationToken`. La cancelación despierta inmediatamente el `poll`; no necesita esperar actividad del socket.

## TLS

El módulo `runtime/ets_tls.hpp` usa OpenSSL, exige como mínimo TLS 1.2 y conserva sockets/contextos mediante RAII. Solo se incluye cuando el AST utiliza tipos o funciones TLS, por lo que un programa normal no necesita enlazar OpenSSL.

| API | Función |
| --- | --- |
| `createTlsServer(certificate, privateKey)` | Carga el contexto de servidor. |
| `acceptTls(listener, context, timeout, token)` | Acepta TCP y completa el handshake sin bloquear. |
| `readTls(connection, bytes, timeout, token)` | Lee respetando WANT_READ/WANT_WRITE. |
| `writeTls(connection, data, timeout, token)` | Escribe con backpressure, deadline y cancelación. |
| `closeTls(connection)` | Cierra la sesión y el socket RAII. |

Compilación manual de un programa TLS:

```bash
g++ -std=c++20 -O3 -pthread -fno-exceptions -I. server.cpp -o server -lssl -lcrypto
```

El compilador configurado añade estas dos librerías automáticamente al detectar TLS.

Los fallos síncronos y asíncronos utilizan el mismo `Result<T>` en lugar de excepciones. Antes de llamar a `value()` debe comprobarse `isOk()`; `error()` contiene el diagnóstico. Los handles TCP son valores RAII compartidos: el descriptor se cierra explícitamente con `closeTcp` o cuando desaparece su último propietario.

El backend está dirigido a POSIX. `poll`, TLS y el pool funcionan en Linux/macOS; `io_uring` se activa únicamente en Linux. Por decisión de diseño actual no se incluye backend Windows/IOCP. Todavía faltan resolución DNS asíncrona y una implementación HTTP completa. Los ejemplos [http-server.ets](examples/http-server.ets) y [tls-server.ets](examples/tls-server.ets) muestran ambos transportes.

## Imports y grafo de módulos

```typescript
import { sumRange, Calculator } from "./math.ets";
import "@core/runtime.ets";
```

El CLI recorre dependencias en orden topológico, analiza el programa completo y genera una unidad C++ independiente por módulo. La cabecera común contiene únicamente la API marcada con `export`: concepts, clases, templates, declaraciones de funciones y variables `extern`. Las funciones privadas se declaran y definen como `static` exclusivamente dentro del `.cpp` propietario; las clases e interfaces privadas tampoco aparecen en la cabecera. Después, el compilador nativo crea un `.o` cacheado para cada unidad y el linker construye el ejecutable final. Los imports no relativos se resuelven mediante `aliases` y después `moduleRoots` de la configuración.

Las funciones, clases, interfaces y variables son privadas al módulo por defecto. Para utilizarlas desde otro archivo deben marcarse con `export` e importarse por nombre:

```typescript
// math.ets
export const base: number = 10;
export function sum(value: number): number { return base + value; }
function internalCheck(): boolean { return true; }

// main.ets
import { base, sum } from "./math.ets";
print(sum(base));
```

Importar `internalCheck`, usar `sum` sin incluirlo en el import o importar un nombre inexistente produce un diagnóstico en el archivo y línea del import. Todas las sobrecargas de una función deben compartir la misma visibilidad. Un import sin nombres únicamente incorpora y ejecuta el módulo por sus efectos laterales.

Un cambio interno que conserva las firmas públicas solo recompila el módulo modificado. Como las declaraciones C++ todavía residen en una cabecera común, un cambio de API pública invalida conservadoramente todos los objetos. Cuando existan cabeceras C++ individuales por módulo, esa invalidación podrá limitarse a sus dependientes transitivos. Las sentencias de nivel superior se ejecutan una sola vez en orden topológico; las variables compartidas deben marcarse con `export` e importarse explícitamente.

## Informe de compilación

Cada ejecución configurada actualiza `build/.estatic/transpiler-report.json`. Es JSON estándar y queda disponible aunque la compilación falle. Su estructura principal es:

```json
{
  "schemaVersion": 1,
  "build": { "id": "...", "status": "succeeded", "durationMs": 29 },
  "dependencyGraph": { "entry": "...", "modules": [] },
  "summary": { "compiled": [], "reused": [], "linked": false },
  "error": null,
  "timeline": []
}
```

El timeline registra resolución de dependencias e imports, parseo por módulo, validación de visibilidad, análisis semántico, generación de la cabecera y los `.cpp`, claves y aciertos de caché, comandos del compilador, `stdout`, `stderr`, código de salida y enlace. `level` puede ser `debug`, `info` o `error`; el nivel mínimo y la ruta se controlan desde `logging` en la configuración.

Estatic admite `.ts` y `.ets`. Los proyectos nuevos usan `.ts`; `.ets` se mantiene para compatibilidad y para distinguir explícitamente Estatic de TypeScript convencional. En imports sin extensión se busca primero `.ts` y después `.ets`; una extensión escrita explícitamente siempre se respeta. Aunque use `.ts`, no se intenta aceptar todo TypeScript: cada feature se incorpora explícitamente al lexer, AST, parser, análisis semántico y backend.

## Arquitectura

```text
src/
├── lexer/       # texto → tokens
├── parser/      # tokens → AST
├── ast/         # contratos neutrales del árbol
├── types/       # representación y operaciones de tipos compuestos
├── semantic/    # símbolos, scopes y comprobación de tipos
├── modules/     # imports, aliases, grafo y detección de ciclos
├── config/      # carga tipada de estatic.config.ts
├── build/       # unidades C++, caché de objetos y enlace incremental
├── codegen/     # AST válido → C++20, tipos y política aislada de parámetros
├── core/        # posiciones, diagnósticos e informe JSON de compilación
├── compiler.ts  # fachada/pipeline
└── cli.ts       # interfaz de línea de comandos
runtime/
├── ets_runtime.hpp # fachada y utilidades C++ compartidas
├── ets_syntax.hpp  # puente Tree-sitter, arena y serialización
├── ets_ast.hpp     # API agregada y compatibilidad del AST
├── ast/            # nodos, tipos, builder, inferencia y serialización
├── ets_async.hpp   # Result, Task, event loop, workers, timers y spawn
├── ets_file.hpp    # archivos síncronos optimizados y corutinas de archivo
├── ets_io_uring.hpp # backend Linux y fallback por capacidad
├── ets_string.hpp  # strings, concat con reserva y conversiones
├── ets_tls.hpp     # TLS 1.2+ mediante OpenSSL
└── ets_net.hpp     # sockets TCP POSIX no bloqueantes
scripts/
├── build-tree-sitter.sh # objetos C cacheados, sin CMake
└── build-ast-dump.sh    # herramienta de inspección del AST
third_party/
├── tree-sitter/            # runtime C fijado y licencia MIT
└── tree-sitter-typescript/ # gramática y parser generado fijados
```

Cada fase depende de contratos de la fase anterior, y el generador solo recibe un AST que ya pasó el análisis semántico. Esto permite añadir arrays, clases o módulos sin mezclar parsing con emisión C++.

Las reglas de arrays, tuplas, firmas de función e instancias genéricas están centralizadas en `src/types/type-system.ts`. Su representación C++ vive en `src/codegen/cpp-types.ts`; el parser solo construye tipos, el analizador semántico valida firmas, capturas, sustituciones e inferencia, y el backend únicamente emite las construcciones C++ correspondientes. Esto permite reparar o ampliar cada responsabilidad por separado.

## Añadir una feature

1. Agregar tokens, si hacen falta, en `src/lexer`.
2. Modelar nodos sin lógica de backend en `src/ast/nodes.ts`.
3. Reconocer la sintaxis en `src/parser/parser.ts`.
4. Definir reglas de tipos y scopes en `src/semantic`.
5. Traducir únicamente nodos válidos en `src/codegen/cpp-generator.ts`.
6. Añadir pruebas positivas y negativas para validar el cambio.

## Editor

- `editors/neovim`: filetype `.ts`/`.ets`, registro del parser y queries de resaltado, scopes, folding, indentación y text objects.
- `editors/vscode`: extensión de lenguaje, resaltado TypeScript con `mut`/`out`, configuración de edición y snippets.

Las instrucciones de instalación se encuentran en el `README.md` de cada integración. Diagnósticos, navegación y autocompletado se compartirán más adelante mediante `estatic-lsp`.

El AST de cualquier archivo puede inspeccionarse sin Node:

```bash
scripts/build-ast-dump.sh
build/tools/ets-ast-dump examples/hello.ets
build/tools/ets-ast-dump examples/hello.ets --records
build/tools/ets-ast-dump examples/hello.ets --syntax
```

## Próximas extensiones recomendadas

- Cabeceras individuales por módulo para invalidación ABI precisa de dependientes transitivos.
- Cancelación dura de trabajos de archivo ya iniciados mediante `IORING_OP_ASYNC_CANCEL`.
- Resolución DNS asíncrona y una capa HTTP completa.
- Source maps entre `.ets` y C++.
- Backend abstracto para generar C++ u otros destinos.
