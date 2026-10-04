import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface InitializedProject {
  directory: string;
  files: string[];
}

// Plantilla de `tsconfig.json` para el proyecto generado. La clave de todo
// el cambio es `lib: ["es2022"]` y `types: []`:
//   - `lib: []` no funciona: sin un lib mínimo, hasta los tipos globales
//     básicos (Array, Boolean, Number, IArguments) se pierden, y eso
//     rompe los `.d.ts` que importan `string[]`, `unknown[]`, etc.
//   - `lib: ["es2022"]` da JS moderno sin DOM, que es lo que queremos.
//   - `types: []` excluye `@types/node` y compañía, que es lo que de
//     verdad no soporta el dialecto (no hay `Buffer`, `__dirname`, etc.).
// `moduleResolution: "bundler"` es lo que usan Vite/Deno y no asume
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

// Plantilla de `types/estatic.d.ts`. Declara al editor los built-ins del
// dialecto (ptr/constPtr/ref/constRef como modificadores de memoria;
// Optional, Result, Promise, Map, Set; readonly; numéricos i8..f64)
// y los globales (console, fs, path, process, JSON) más los helpers de
// runtime que usan los ejemplos (print, numberToString, move). El bloque
// `declare global` evita que el usuario tenga que importar nada. NO
// incluye las versiones async de `fs.*` que devuelven `Promise<...>`
// (decisión de scope confirmada).
//
// V22 (Memory Model v2) eliminó `Mut<T>`, `MutRef<T>`, `Unq<T>` y deprecó
// `Rc<T>` — los cuatro se reemplazan por modificadores más explícitos
// (`ptr<T>` para unique_ptr, `ref<T>`/`constRef<T>` para préstamos, etc.).
// Esta plantilla refleja el dialecto V22; los proyectos generados antes
// de V22 deben regenerarse o actualizar `types/estatic.d.ts` a mano.
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
  type ptr<T> = T;
  type constPtr<T> = T;
  type ref<T> = T;
  type constRef<T> = T;

  // ─── Inmutabilidad (existente desde antes de V22) ────────────────────
  // 'readonlyT' marca inmutabilidad. En el dialecto el checker rechaza
  // reasignaciones; aquí es alias cosmético para que el editor no marque
  // error de tipo inexistente.
  type readonly<T> = T;

  // ─── Envoltorios genéricos del runtime ──────────────────────────────
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
  class Optional<T> {
    _brand: string;
    static some<T>(value: T): Optional<T>;
    static none<T>(): Optional<T>;
    // Métodos de instancia (helpers globales en runtime):
    isPresent(): boolean;
    isEmpty(): boolean;
    value(): T;
    valueOr(defaultValue: T): T;
  }
  class Result<T, E = string> {
    private readonly _brand: symbol;
    // El dialecto trata Result<T, E> como tagged union sintética; los
    // métodos isOk/value/error se infieren desde el tag 'ok'. Ver
    // type-checker.ts:2100-2108.
    isOk(): boolean;
    value(): T;
    error(): E;
  }
  class Promise<T> {
    private readonly _brand: symbol;
  }
  class Map<K, V> {
    private readonly _brand: symbol;
    // MAP_METHODS en type-checker.ts:199-205.
    get(key: K): V | void;
    set(key: K, value: V): void;
    has(key: K): boolean;
    delete(key: K): boolean;
    readonly size: number;
  }
  class Set<T> {
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
  function print(...values: unknown[]): void;
  function numberToString(n: number): string;

  // ─── Transferencia de ownership (V22 Memory Model v2) ───────────────
  // move(x) es la única forma de transferir ownership de un 'ptrT' sin
  // copia. El argumento debe ser un identificador declarado como ptrT
  // o constPtrT (de lo contrario el type-checker emite E4100). Tras
  // la llamada, el uso de 'x' es diagnóstico E4102 (uso moved) o E4103
  // (uso maybe-moved, p.ej. dentro de una rama if sin else).
  function move<T>(x: ptr<T>): ptr<T>;
  function move<T>(x: constPtr<T>): constPtr<T>;

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
    function error(...values: unknown[]): void;
    function warn(...values: unknown[]): void;
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
