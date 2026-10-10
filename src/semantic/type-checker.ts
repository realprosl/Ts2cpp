import type { Program, Statement, Expression, TypeName, Parameter, FunctionDeclaration, InterfaceDeclaration, InterfaceMethod, ClassDeclaration, ClassMethod, ArrowFunctionExpression, TypeAliasDeclaration, EnumDeclaration, UnionDeclaration, EnumMember, MatchExpression, LiteralExpression } from "../ast/nodes.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import { Scope, type FunctionSignature, type FunctionSymbol, type SymbolInfo } from "./symbols.ts";
import { arrayElement, arrayType, fixedArrayElement, fixedArraySize, functionParameters, functionResult, functionType, genericArguments, genericBase, genericType, intersectionMembers, isArrayType, isFixedArrayType, isFunctionType, isGenericType, isIntersectionType, isMapType, isNumericType, isPrimitive, isPromiseType, isReadonlyType, isSetType, isTupleType, isTypeofType, isUnionType, numericBitWidth, numericKind, numericSign, promiseResult, readonlyInner, readonlyType, registerFixedArray, resolvedTypeToTypeName, toResolvedRuntimeType, toResolvedType, tupleElements, tupleType, typeMatches, typeofTarget, unionMembers } from "../types/type-system.ts";
import { HELPER_METADATA } from "./helpers.ts";

// Tabla de métodos del built-in `fs` (estilo Node). Las versiones `*Sync`
// devuelven `Result<T>` o `boolean`; las versiones sin sufijo son asíncronas y
// devuelven `Promise<Result<T>>`. El runtime mapea cada llamada al overload
// correspondiente de `readFile`/`writeFile`/.../`*Async`.
const FILESYSTEM_METHODS: Record<string, { params: TypeName[]; returnType: TypeName }> = {
  readFileSync:   { params: ["string"], returnType: "Result<string>" },
  writeFileSync:  { params: ["string", "string"], returnType: "Result<boolean>" },
  appendFileSync: { params: ["string", "string"], returnType: "Result<boolean>" },
  copyFileSync:   { params: ["string", "string"], returnType: "Result<boolean>" },
  renameSync:     { params: ["string", "string"], returnType: "Result<boolean>" },
  unlinkSync:     { params: ["string"], returnType: "Result<boolean>" },
  existsSync:     { params: ["string"], returnType: "boolean" },
  readFile:       { params: ["string"], returnType: "Promise<Result<string>>" },
  writeFile:      { params: ["string", "string"], returnType: "Promise<Result<boolean>>" },
  appendFile:     { params: ["string", "string"], returnType: "Promise<Result<boolean>>" },
  copyFile:       { params: ["string", "string"], returnType: "Promise<Result<boolean>>" },
  rename:         { params: ["string", "string"], returnType: "Promise<Result<boolean>>" },
  unlink:         { params: ["string"], returnType: "Promise<Result<boolean>>" },
};

// Tabla de métodos del built-in `path`. Delega en `std::filesystem`. Las
// funciones que en Node reciben rest args (`join`, `resolve`) aquí toman un
// `string[]` para mantener tipos concretos.
const PATH_METHODS: Record<string, { params: TypeName[]; returnType: TypeName }> = {
  dirname:    { params: ["string"], returnType: "string" },
  basename:   { params: ["string"], returnType: "string" },
  extname:    { params: ["string"], returnType: "string" },
  isAbsolute: { params: ["string"], returnType: "boolean" },
  normalize:  { params: ["string"], returnType: "string" },
  join:       { params: ["string[]"], returnType: "string" },
  resolve:    { params: ["string[]"], returnType: "string" },
};

// Tabla de métodos del built-in `process`. Mapea a `argument`, `argumentCount`,
// `exitProcess` y `std::filesystem::current_path`.
const PROCESS_METHODS: Record<string, { params: TypeName[]; returnType: TypeName }> = {
  argc: { params: [], returnType: "number" },
  argv: { params: [], returnType: "string[]" },
  cwd:  { params: [], returnType: "string" },
  exit: { params: ["number"], returnType: "void" },
};

// Tabla de métodos del built-in `JSON`. `parse` (legacy) devuelve `string`
// y solo maneja escalares JSON. `parseValue` (nuevo) devuelve `JsonValue`,
// un tipo opaco (variant) que el usuario manipula con helpers globales
// (jsonIsString, jsonAsString, jsonArrayGet, etc.). Ambos coexisten para
// mantener compatibilidad: código existente con `JSON.parse(s): string`
// sigue funcionando.
const JSON_METHODS: Record<string, { params: TypeName[]; returnType: TypeName }> = {
  stringify: { params: ["string"], returnType: "string" },
  stringifyNumber: { params: ["number"], returnType: "string" },
  stringifyBool: { params: ["boolean"], returnType: "string" },
  stringifyValue: { params: ["JsonValue"], returnType: "string" },
  // `parse` legacy: devuelve `std::string` con la representación textual
  // canónica del escalar JSON. Para datos estructurados, usar `parseValue`.
  parse: { params: ["string"], returnType: "string" },
  // `parseValue` nuevo: devuelve el árbol completo (recursivo).
  parseValue: { params: ["string"], returnType: "JsonValue" },
};

// Funciones helper globales para manipular JsonValue. El dialecto no tiene
// `Object`/`any`/`unknown`, así que se accede a campos vía funciones libres.
// Todas devuelven tipos primitivos (string/number/boolean) excepto las que
// devuelven JsonValue (array/object get).
const JSON_HELPERS: Record<string, { params: TypeName[]; returnType: TypeName }> = Object.assign(Object.create(null), {
  jsonIsString: { params: ["JsonValue"], returnType: "boolean" },
  jsonIsNumber: { params: ["JsonValue"], returnType: "boolean" },
  jsonIsBool: { params: ["JsonValue"], returnType: "boolean" },
  jsonIsArray: { params: ["JsonValue"], returnType: "boolean" },
  jsonIsObject: { params: ["JsonValue"], returnType: "boolean" },
  jsonIsNull: { params: ["JsonValue"], returnType: "boolean" },
  jsonAsString: { params: ["JsonValue"], returnType: "string" },
  jsonAsNumber: { params: ["JsonValue"], returnType: "number" },
  jsonAsBool: { params: ["JsonValue"], returnType: "boolean" },
  jsonArrayLength: { params: ["JsonValue"], returnType: "number" },
  jsonArrayGet: { params: ["JsonValue", "number"], returnType: "JsonValue" },
  jsonObjectGet: { params: ["JsonValue", "string"], returnType: "JsonValue" },
});

// Helpers para filesystem (Issue #13). Exponen runtime/ets_file.hpp como
// funciones globales del dialecto. Sin tipos ricos (Result<FileContent,
// FileError>) — eso llega en V1 (tagged unions). Por ahora devuelven
// primitivos: string/boolean.
const FILE_HELPERS: Record<string, { minParams: number; paramTypes?: TypeName[]; returnType: TypeName }> = Object.assign(Object.create(null), {
  fileRead:    { minParams: 1, paramTypes: ["string"],         returnType: "string"  },  // (path) -> string
  fileWrite:   { minParams: 2, paramTypes: ["string", "string"], returnType: "boolean" },  // (path, content) -> boolean
  fileAppend:  { minParams: 2, paramTypes: ["string", "string"], returnType: "boolean" },
  fileExists:  { minParams: 1, paramTypes: ["string"],         returnType: "boolean" },
  fileCopy:    { minParams: 2, paramTypes: ["string", "string"], returnType: "boolean" },
  fileMove:    { minParams: 2, paramTypes: ["string", "string"], returnType: "boolean" },
  fileRemove:  { minParams: 1, paramTypes: ["string"],         returnType: "boolean" },
  // V26: factory de FileReader. Devuelve un reader (puntero raw en C++)
  // que mantiene el descriptor abierto. Aborta con stderr+exit si el
  // archivo no existe; para error handling explicito, hacer check con
  // fileExists() antes.
  openFileReader: { minParams: 1, paramTypes: ["string"],    returnType: "FileReader" },
});

// Helpers para networking (Issue #14). Wrappers síncronos sobre POSIX sockets
// (runtime/ets_net_sync.hpp). Devuelven fd numéricos o string vacío en error.
// V1 (tagged unions) reemplazará estos por `Result<TcpConn, NetError>`.
const NET_HELPERS: Record<string, { minParams: number; paramTypes?: TypeName[]; returnType: TypeName }> = Object.assign(Object.create(null), {
  tcpListen:        { minParams: 2, paramTypes: ["string", "number"], returnType: "number"  },  // (host, port) -> fd
  tcpAccept:        { minParams: 1, paramTypes: ["number"],          returnType: "number"  },  // (listenerFd) -> clientFd
  tcpConnect:       { minParams: 2, paramTypes: ["string", "number"], returnType: "number"  },  // (host, port) -> fd
  tcpRead:          { minParams: 2, paramTypes: ["number", "number"], returnType: "string"  },  // (fd, maxBytes) -> data
  tcpWrite:         { minParams: 2, paramTypes: ["number", "string"], returnType: "boolean" },  // (fd, data) -> ok
  tcpClose:         { minParams: 1, paramTypes: ["number"],          returnType: "void"    },  // (fd)
  // Helper de alto nivel: server en background + cliente en foreground.
  // Usado por los tests E2E hasta que V1 introduzca tagged unions.
  etsNetSyncEcho:   { minParams: 4, paramTypes: ["string", "number", "string", "number"], returnType: "string" },  // (host, port, request, maxBytes) -> response
  etsNetSyncLarge:  { minParams: 3, paramTypes: ["string", "number", "number"], returnType: "string" },  // (host, port, payloadBytes) -> response
});
// Helpers para `Optional<T>`. El dialecto aún no soporta métodos sobre
// tipos genéricos como `Optional<T>.some(...)`, así que se exponen como
// funciones libres. Cada helper preserva el tipo genérico a través
// de la firma del type-checker (que infiere del contexto).
const OPTIONAL_HELPERS: Record<string, { minParams: number; returnsGeneric: boolean }> = Object.assign(Object.create(null), {
  optionalSome: { minParams: 1, returnsGeneric: true },        // (T) → Optional<T>
  optionalNone: { minParams: 0, returnsGeneric: true },        // <T>() → Optional<T>
  optionalIsPresent: { minParams: 1, returnsGeneric: false },  // (Optional<T>) → boolean
  optionalValueOr: { minParams: 2, returnsGeneric: false },    // (Optional<T>, T) → T
  optionalMap: { minParams: 2, returnsGeneric: true },         // (Optional<T>, T→U) → Optional<U>
  optionalAndThen: { minParams: 2, returnsGeneric: true },     // (Optional<T>, T→Optional<U>) → Optional<U>
  optionalOrElse: { minParams: 2, returnsGeneric: true },      // (Optional<T>, Optional<T>) → Optional<T>
});

// Helpers sobre `Un<T>` (unique_ptr). Mismo patrón que OPTIONAL_HELPERS:
// helpers globales para evitar `Un<T>.some(...)` que el dialecto no soporta
// en genéricos. `unSome` y `unNone` requieren un `expected` contextual para
// inferir T. `unIsSome` devuelve boolean; `unValue` devuelve T& (asume no vacío).
const UN_HELPERS: Record<string, { minParams: number; returnsGeneric: boolean }> = Object.assign(Object.create(null), {
  unSome: { minParams: 1, returnsGeneric: true },              // (T) → Un<T>
  unNone: { minParams: 0, returnsGeneric: true },              // <T>() → Un<T>
  unIsSome: { minParams: 1, returnsGeneric: false },           // (Un<T>) → boolean
  unValue: { minParams: 1, returnsGeneric: false },            // (Un<T>) → T
});

// Helpers sobre `Rc<T>` (shared_ptr).
const RC_HELPERS: Record<string, { minParams: number; returnsGeneric: boolean }> = Object.assign(Object.create(null), {
  rcShare: { minParams: 1, returnsGeneric: true },             // (T) → Rc<T>
  rcStrongCount: { minParams: 1, returnsGeneric: false },      // (Rc<T>) → number
  rcValue: { minParams: 1, returnsGeneric: false },            // (Rc<T>) → T
});

// Helpers sobre `MutRef<T>` (referencia mutable) y `Mut<T>` (puntero crudo
// mutable constante). Solo constructores; el dialecto no tiene métodos sobre
// estos (la sintaxis `ptr.some()` no funciona para genéricos).
// NOTA: desde Issue #3-mut-as-modifier, `Mut<T>` y `MutRef<T>` se
// resuelven directamente a `T*` y `T&` en el codegen (sin envoltorios).
// Los helpers `mutOf`, `mutFrom`, `mutValue`, `mutIsSome`, `mutRefOf`,
// `mutRefFrom`, `mutRefValue` ya no existen — el user usa `&x` directamente.
// Esta tabla queda vacía por compat histórica.
const REF_HELPERS: Record<string, { minParams: number; returnsGeneric: boolean; returnsRef?: boolean }> = Object.assign(Object.create(null), {
});

// Helpers sobre `Task<T>[]` (Promise-like arrays). El dialecto expone
// `all(tasks)` y `race(tasks)` que devuelven el T del array (o `T[]` para
// `all`). Se modelan con un tipo contextual: el user declara `const x: T =
// race([delay(1), delay(2)])` y el helper propaga `T` desde el array.
const ASYNC_HELPERS: Record<string, { returnsElement: boolean; returnsArray: boolean }> = Object.assign(Object.create(null), {
  all: { returnsElement: false, returnsArray: true },
  race: { returnsElement: true, returnsArray: false },
});

// `sleep` y `spawn` ya están registradas en runtime como funciones top-level.
const ASYNC_PRIMITIVE_HELPERS: Record<string, { params: TypeName[]; returnType: TypeName }> = Object.assign(Object.create(null), {
  sleep: { params: ["number"], returnType: "Promise<void>" },
  spawn: { params: ["Promise<void>"], returnType: "void" },
});

// Bloque E: tabla de métodos de `Math`. Todos reciben y devuelven `number`
// (mapeado a `double` en C++). Las funciones que en JavaScript aceptan
// número variable de argumentos (`Math.max(...args)`) se limitan a dos
// argumentos aquí por la restricción del dialecto (variadics no uniformes).
const MATH_METHODS: Record<string, { params: TypeName[]; returnType: TypeName }> = {
  floor: { params: ["number"], returnType: "number" },
  ceil:  { params: ["number"], returnType: "number" },
  round: { params: ["number"], returnType: "number" },
  abs:   { params: ["number"], returnType: "number" },
  sqrt:  { params: ["number"], returnType: "number" },
  pow:   { params: ["number", "number"], returnType: "number" },
  min:   { params: ["number", "number"], returnType: "number" },
  max:   { params: ["number", "number"], returnType: "number" },
};

// Bloque E: tabla de métodos de `Date`. La API es mínima: solo timestamps.
// Fechas estructuradas (year/month/day getters, formatos) requieren tipos
// compuestos que este dialecto evita por ahora.
const DATE_METHODS: Record<string, { params: TypeName[]; returnType: TypeName }> = {
  now: { params: [], returnType: "number" },
  utc: { params: ["number", "number", "number"], returnType: "number" },
};

// Tabla de métodos de `Map<K, V>`. Las firmas son plantillas que se materializan
// sustituyendo `K`/`V` por los argumentos de tipo reales del objeto en cada llamada.
// `get` devuelve `V | void` porque un valor ausente se representa como `void` en
// este lenguaje (no hay `undefined`/`null`).
const MAP_METHODS: Record<string, { params: (typeArgs: TypeName[]) => TypeName[]; returnType: (typeArgs: TypeName[]) => TypeName }> = {
  get:     { params: ([K]) => [K],                                          returnType: ([, V]) => `${V} | void` },
  set:     { params: ([K, V]) => [K, V],                                    returnType: () => "void" },
  has:     { params: ([K]) => [K],                                          returnType: () => "boolean" },
  delete:  { params: ([K]) => [K],                                          returnType: () => "boolean" },
  size:    { params: () => [],                                              returnType: () => "number" },
  clear:   { params: () => [],                                              returnType: () => "void" },
  forEach: { params: ([K, V]) => [`(${V},${K})=>void`],                     returnType: () => "void" },
};

// Tabla de métodos de `Set<T>` con el mismo patrón. `forEach` recibe un callback
// `(value)` ya que no hay par clave/valor.
const SET_METHODS: Record<string, { params: (typeArgs: TypeName[]) => TypeName[]; returnType: (typeArgs: TypeName[]) => TypeName }> = {
  add:     { params: ([T]) => [T],                                          returnType: () => "boolean" },
  has:     { params: ([T]) => [T],                                          returnType: () => "boolean" },
  delete:  { params: ([T]) => [T],                                          returnType: () => "boolean" },
  size:    { params: () => [],                                              returnType: () => "number" },
  clear:   { params: () => [],                                              returnType: () => "void" },
  forEach: { params: ([T]) => [`(${T})=>void`],                             returnType: () => "void" },
};

// V7: tabla de métodos sobre `T[]` (arrays). `typeArgs = [T]` (elemento del
// array). Para `map`/`reduce` se introduce un parámetro de tipo adicional `U`
// (tipo de retorno o acumulador). El primer typeArgument declarado por el
// usuario, si lo hay, lo propagamos al codegen vía `inferredCallTypeArguments`
// para que la llamada C++ se materialice con los tipos correctos. Esto
// habilita las cadenas `arr.filter(p).map(f).reduce(init, op)` que V7.1
// fusionará en un único bucle.
const ARRAY_METHODS: Record<string, { arity: number; paramKinds: ("array" | "fn" | "value")[]; returnType: (typeArgs: TypeName[]) => TypeName; userTypeArgument?: number }> = {
  filter: { arity: 1, paramKinds: ["fn"], returnType: ([T]) => `${T}[]` },
  map:    { arity: 1, paramKinds: ["fn"], returnType: () => "void[]", userTypeArgument: 0 },
  reduce: { arity: 2, paramKinds: ["value", "fn"], returnType: () => "void", userTypeArgument: 0 },
  // Métodos añadidos en V11: predicados y extracción.
  forEach: { arity: 1, paramKinds: ["fn"], returnType: () => "void" },
  // V22-gap-#2: `push` añade un elemento al final del array (muta in-place).
  // Devuelve `void` (estilo JS, aunque TS lo tipa como `number` opcional).
  // El elemento es del mismo tipo que el array.
  push:    { arity: 1, paramKinds: ["value"], returnType: () => "void" },
  // V22-gap-#2: `length` es propiedad, no método. La manejamos aquí
  // por compatibilidad — el codegen emitirá `obj.size()` en C++.
  // Devuelve `number`.
  // (Ver dispatch en cpp-generator para esta rama.)
// V13: `find` devuelve `Optional<T>` (puede no haber resultado). El usuario
// debe discriminar con `?.`, `match` o `value()` (que aborta si vacío).
  find:    { arity: 1, paramKinds: ["fn"], returnType: ([T]) => `Optional<${T}>` },
  some:    { arity: 1, paramKinds: ["fn"], returnType: () => "boolean" },
  every:   { arity: 1, paramKinds: ["fn"], returnType: () => "boolean" },
  // V14: métodos adicionales.
  slice:   { arity: 2, paramKinds: ["value", "value"], returnType: ([T]) => `${T}[]` },
  // `sort` muta in-place y devuelve el mismo array (estilo Array.prototype.sort).
  sort:    { arity: 1, paramKinds: ["fn"], returnType: ([T]) => `${T}[]` },
  // `flatMap` aplica una función que devuelve arrays y los concatena (1 nivel).
  flatMap: { arity: 1, paramKinds: ["fn"], returnType: () => "void[]", userTypeArgument: 0 },
  // `includes` busca por igualdad.
  includes: { arity: 1, paramKinds: ["value"], returnType: () => "boolean" },
};

/** Distancia Levenshtein entre dos strings (número mínimo de inserciones,
 *  borrados o sustituciones para convertir `a` en `b`). Implementación
 *  iterativa con matriz 2D; O(|a|·|b|) tiempo, O(min(|a|,|b|)) espacio. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous: number[] = new Array(b.length + 1).fill(0);
  const current: number[] = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

export class TypeChecker {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly types = new WeakMap<Expression, TypeName>();
  // V22: mapa de variables locales `ptr<T>` que han sido movidas (`moved` o
  // `maybe-moved`). Cualquier uso posterior genera un diagnóstico E4102 o
  // E4103. El mapa se rellena al procesar `move(x)` y se consulta en
  // `expression()` cuando se referencia un identificador. El mapa es
  // mutable (no readonly) porque IfStatement hace snapshots y los restaura
  // para implementar el join de estados entre ramas.
  private moved = new Map<string, "moved" | "maybe-moved">();
  // V22 PR#134: stack de borrows activos por scope. Cada entrada es un
  // Map<nombre-de-la-fuente, modo> ("mut" para ref<T>, "shared" para
  // constRef<T>). push/pop en cada BlockStatement. Las declaraciones
  // `ref(x)` y `constRef(x)` consultan y actualizan el stack.
  private borrowStack: Map<string, "mut" | "shared">[] = [new Map()];
  private currentReturn: TypeName | undefined;
  private currentAsync: boolean | undefined;
  private inConstructor = false;
  // V19: nombre de la clase/método actual para detectar accesos privados.
  // El checker usa esto para enforzar `private` y `protected`.
  private currentClass: string | undefined;
  private currentMethod: string | undefined;
  private readonly interfaces = new Map<string, InterfaceDeclaration>();
  private readonly classes = new Map<string, ClassDeclaration>();
  private readonly aliases = new Map<string, TypeAliasDeclaration>();
  private readonly enums = new Map<string, EnumDeclaration>();
  private readonly unions = new Map<string, UnionDeclaration>();
  // V1.4: mapa de narrowing para tagged unions. Cuando entramos en un
  // `thenBranch` con condición `expr.tag == literal`, marcamos el nombre
  // `expr` como "narrowed" con la lista de variantes que cumplen el
  // discriminador. `MemberExpression` consulta esto para разрешar
  // campos exclusivos de la variante. Se restaura al salir del bloque.
  private narrowed = new Map<string, { unionType: TypeName; discriminator: { field: string; value: string | number | boolean }; variants: string[] }>();
  // V0.2: nombres de variables que colisionan con singletons globales del
  // runtime C++ (definidos en `runtime/ets_runtime.hpp`). Si el usuario
  // declara un símbolo local con uno de estos nombres, el codegen lo
  // renombra para evitar colisiones.
  private static readonly RUNTIME_GLOBAL_NAMES = new Set(["console", "fs", "path", "process", "JSON"]);
  // V6: si `type` es un array fijo `T[N]` con `N` siendo un identificador
  // ligado a un `const` con valor literal conocido, reescribe el tamaño a
  // ese valor literal. Si no, devuelve el tipo sin cambios.
  private propagateConstantArraySize(type: TypeName, scope: Scope): TypeName {
    const match = type.match(/^([^\s\[\]]+)\[([^\]]+)\]$/);
    if (!match) return type;
    const element = match[1];
    const sizeExpr = match[2];
    // El lexer parsea N como identifier (no como número). Lo buscamos en el scope.
    const symbol = scope.resolve(sizeExpr);
    if (!symbol || symbol.kind !== "variable" || symbol.mutable || !("constValue" in symbol)) return type;
    const constValue = (symbol as { constValue?: number | string | boolean | null }).constValue;
    if (typeof constValue !== "number" || !Number.isInteger(constValue) || constValue <= 0) return type;
    return `${element}[${constValue}]`;
  }

  // V0.2: helper para registrar un símbolo variable. Marca `fromRuntime=true`
  // si el nombre coincide con un singleton del runtime C++; el codegen usa
  // este flag para renombrar y evitar colisiones de identificadores.
  // También anota el AST si el `target` es VariableDeclaration o Parameter.
  private defineVariable(scope: Scope, name: string, type: TypeName, mutable: boolean, extra: { variadic?: boolean; mutableReference?: boolean; constValue?: number | string | boolean | null } = {}, target?: { fromRuntime?: boolean; constValue?: number | string | boolean | null }): boolean {
    const symbol: import("./symbols.ts").VariableSymbol = { kind: "variable", type, mutable, ...extra };
    if (TypeChecker.RUNTIME_GLOBAL_NAMES.has(name)) {
      symbol.fromRuntime = true;
      if (target) target.fromRuntime = true;
    }
    if (extra.constValue !== undefined && target) {
      // V6: propagamos el valor literal del initializer al symbol para que
      // las referencias posteriores (tamaños de arrays, branches constantes)
      // puedan consultarlo en compile-time.
      target.constValue = extra.constValue;
      symbol.constValue = extra.constValue;
    }
    return scope.define(name, symbol);
  }
  private activeTypeParameters = new Set<string>();
  private activeTypeConstraints = new Map<string, TypeName>();
  private activeTypeDefaults = new Map<string, TypeName>();
  private readonly variadicExpressions = new WeakSet<Expression>();
  private readonly inferredCallTypeArguments = new WeakMap<Expression, TypeName[]>();
  private currentClosure: { node: ArrowFunctionExpression; parentScope: Scope } | undefined;
  private loopDepth = 0;

  // Construye el mapa nombre→constraint a partir de los `TypeParameter[]` que
  // vienen del parser. Solo los parámetros con `constraint` definido entran al
  // mapa; el resto se ignora (no restringen nada).
  private static constraintsOf(parameters: TypeParameter[]): Record<string, TypeName> {
    const result: Record<string, TypeName> = {};
    for (const parameter of parameters) if (parameter.constraint) result[parameter.name] = parameter.constraint;
    return result;
  }

  // Construye el mapa nombre→default a partir de los `TypeParameter[]`. Solo
  // los parámetros con `default` definido entran al mapa.
  private static defaultsOf(parameters: TypeParameter[]): Record<string, TypeName> {
    const result: Record<string, TypeName> = {};
    for (const parameter of parameters) if (parameter.default) result[parameter.name] = parameter.default;
    return result;
  }

  // Extrae los nombres de los parámetros para alimentar las estructuras internas
  // (FunctionSignature, etc.) que siguen trabajando con `string[]`.
  private static namesOf(parameters: TypeParameter[]): string[] {
    return parameters.map(parameter => parameter.name);
  }

  check(program: Program): void {
    const global = new Scope();
    const input = (type: TypeName) => ({ type, out: false });
    const output = (type: TypeName) => ({ type, out: true });
    const fn = (params: Array<{ type: TypeName; out: boolean }>, returnType: TypeName): FunctionSymbol => ({ kind: "function", overloads: [{ typeParameters: [], variadicTypeParameters: [], params, returnType }] });
    global.define("print", fn([], "void"));
    global.define("write", fn([], "void"));
    global.define("printError", fn([], "void"));
    global.define("writeError", fn([], "void"));
    // V9.1: awaiters io_uring. Mapean al runtime/ets_io_uring_async.hpp.
    // Versión async: Promise<Result<T>>; versión sync: Result<T>.
    global.define("asyncIoUringRead", fn([input("string")], "Promise<Result<string>>"));
    global.define("asyncIoUringWrite", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
    global.define("ioUringRead", fn([input("string")], "Result<string>"));
    global.define("ioUringWrite", fn([input("string"), input("string")], "Result<boolean>"));
    global.define("length", fn([input("string")], "number"));
    global.define("numberToString", fn([input("number")], "string"));
    global.define("charAt", fn([input("string"), input("number")], "string"));
    global.define("substring", fn([input("string"), input("number"), input("number")], "string"));
    global.define("indexOf", fn([input("string"), input("string"), input("number")], "number"));
    global.define("startsWith", fn([input("string"), input("string")], "boolean"));
    global.define("trim", fn([input("string")], "string"));
    global.define("lineCount", fn([input("string")], "number"));
    global.define("lineAt", fn([input("string"), input("number")], "string"));
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
    global.define("writeFileAsync", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
    global.define("appendFileAsync", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
    global.define("fileExistsAsync", fn([input("string")], "Promise<Result<boolean>>"));
    global.define("copyFileAsync", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
    global.define("moveFileAsync", fn([input("string"), input("string")], "Promise<Result<boolean>>"));
    global.define("removeFileAsync", fn([input("string")], "Promise<Result<boolean>>"));
    global.define("ioUringAvailable", fn([], "boolean"));
    global.define("readFileUntil", fn([input("string"), input("number"), input("CancellationToken")], "Promise<Result<string>>"));
    global.define("writeFileUntil", fn([input("string"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
    global.define("appendFileUntil", fn([input("string"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
    global.define("copyFileUntil", fn([input("string"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
    global.define("moveFileUntil", fn([input("string"), input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
    global.define("removeFileUntil", fn([input("string"), input("number"), input("CancellationToken")], "Promise<Result<boolean>>"));
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
    global.define("sleep", fn([input("number")], "Promise<void>"));
    global.define("spawn", fn([input("Promise<void>")], "void"));
    global.define("ok", { kind: "function", overloads: [{ typeParameters: ["T"], variadicTypeParameters: [], params: [input("T")], returnType: "Result<T>" }] });
    global.define("err", { kind: "function", overloads: [{ typeParameters: ["T"], variadicTypeParameters: [], params: [input("string")], returnType: "Result<T>" }] });
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
    // V1.4: `Result<T, E = string>` se modela como una tagged union sintética
    // del runtime con dos variantes:
    //   { ok: true,  value: T }
    //   { ok: false, error: E }
    // El discriminador es el campo `ok` (boolean). Esto REEMPLAZA el wrapper
    // `ets::Result<T>` como type alias real: el codegen emite el mismo
    // `std::variant` que cualquier tagged union del dialecto. La clase
    // `ets::Result<T>` del runtime queda marcada deprecated pero se conserva
    // para no romper callers que aún la usen como tipo C++ directo.
    this.declareResultSyntheticUnion(global);
    for (const statement of program.statements) if (statement.kind === "ClassDeclaration") this.declareClassName(statement, global);
    for (const statement of program.statements) if (statement.kind === "InterfaceDeclaration") this.declareInterface(statement, global);
    for (const statement of program.statements) if (statement.kind === "TypeAliasDeclaration") this.declareTypeAlias(statement, global);
    for (const statement of program.statements) if (statement.kind === "EnumDeclaration") this.declareEnum(statement, global);
    for (const statement of program.statements) if (statement.kind === "UnionDeclaration") this.declareUnion(statement, global);
    // Tras declarar los alias, expandimos en el AST cualquier referencia a un
    // nombre de alias (o a su instanciación genérica) por su forma canónica.
    // Así codegen ve directamente `number[]` en vez de `NumberArray`.
    this.expandAliasesInProgram(program);
    // `export default` envuelve una declaración; hacemos unwrap para que las
    // declaraciones internas se declaren igual que las top-level.
    const unwrap = (stmt: Statement): Statement => stmt.kind === "ExportDefaultDeclaration" ? unwrap(stmt.declaration as Statement) : stmt;
    for (const statement of program.statements) if (statement.kind === "ClassDeclaration") this.validateClass(statement, global);
    for (const statement of program.statements) if (unwrap(statement).kind === "FunctionDeclaration") this.declareFunction(unwrap(statement) as FunctionDeclaration, global);
    for (const statement of program.statements) this.statement(statement, global);
    if (this.diagnostics.length) throw new DiagnosticError(this.diagnostics);
  }

  typeOf(expression: Expression): TypeName | undefined {
    // V0.1: si el nodo tiene `resolvedType` adjuntado, lo usamos directamente
    // y lo convertimos a `TypeName` para mantener la API existente.
    if (expression.resolvedType) {
      const resolvedAsString = resolvedTypeToTypeName(expression.resolvedType);
      if (resolvedAsString) return this.unwrapMutLike(resolvedAsString);
    }
    const stored = this.types.get(expression);
    if (!stored) return undefined;
    return this.unwrapMutLike(stored);
  }

  /**
   * Devuelve el `ResolvedType` de una expresión, sin convertir a string.
   * Usado por el codegen cuando quiere inspeccionar estructura (genéricos,
   * argumentos, etc.) sin parsear.
   */
  resolvedTypeOf(expression: Expression): import("../types/type-system.ts").ResolvedType | undefined {
    return expression.resolvedType ?? toResolvedType(this.types.get(expression));
  }

  private unwrapMutLike(stored: TypeName): TypeName {
    // V22 (Memory Model v2): `Mut<T>` y `MutRef<T>` ya no existen en el
    // dialecto. El type-checker los rechaza con E4401/E4402 antes de
    // llegar aquí, así que esta función es ahora un pass-through.
    return stored;
  }
  isVariadic(expression: Expression): boolean { return this.variadicExpressions.has(expression); }
  typeArgumentsOf(expression: Expression): TypeName[] { return this.inferredCallTypeArguments.get(expression) ?? []; }

  private dispatchBuiltin(global: string, methods: Record<string, { params: TypeName[]; returnType: TypeName }>, node: { method: string; args: Expression[]; span: import("../core/span.ts").Span }, scope: Scope): TypeName {
    const signature = methods[node.method];
    if (!signature) {
      this.report(node, `${global}.${node.method} no es una API válida (usa ${Object.keys(methods).join(", ")})`);
      node.args.forEach(arg => this.expression(arg, scope));
      return "void";
    }
    if (node.args.length !== signature.params.length) this.report(node, `${global}.${node.method} espera ${signature.params.length} argumentos, recibió ${node.args.length}`);
    node.args.forEach((arg, index) => this.require(this.expression(arg, scope, signature.params[index]), signature.params[index], arg));
    return signature.returnType;
  }

  // Variante de `dispatchBuiltin` para tipos genéricos (`Map<K,V>`, `Set<T>`): la firma
  // se materializa a partir de los argumentos de tipo reales del objeto receptor.
  private dispatchGenericBuiltin(global: string, methods: Record<string, { params: (typeArgs: TypeName[]) => TypeName[]; returnType: (typeArgs: TypeName[]) => TypeName }>, node: { method: string; args: Expression[]; span: import("../core/span.ts").Span }, scope: Scope, typeArgs: TypeName[]): TypeName {
    const signature = methods[node.method];
    if (!signature) {
      this.report(node, `${global}.${node.method} no es una API válida (usa ${Object.keys(methods).join(", ")})`);
      node.args.forEach(arg => this.expression(arg, scope));
      return "void";
    }
    const params = signature.params(typeArgs);
    const returnType = signature.returnType(typeArgs);
    if (node.args.length !== params.length) this.report(node, `${global}.${node.method} espera ${params.length} argumentos, recibió ${node.args.length}`);
    node.args.forEach((arg, index) => this.require(this.expression(arg, scope, params[index]), params[index], arg));
    return returnType;
  }

  // Resuelve una llamada a método cuando el receptor es un parámetro genérico `T`
  // con constraint intersección `A & B & ...`. Los métodos se obtienen de TODAS
  // las interfaces miembro y se emparejan contra los argumentos reales.
  private resolveInterfaceMethodCall(methods: InterfaceMethod[], node: { method: string; args: Expression[]; typeArguments: TypeName[]; span: import("../core/span.ts").Span }, scope: Scope, expected?: TypeName): TypeName | undefined {
    const argumentTypes = node.args.map(arg => this.expression(arg, scope));
    const matches = methods.map(method => {
      const signature: FunctionSignature = {
        typeParameters: TypeChecker.namesOf(method.typeParameters ?? []),
        variadicTypeParameters: [],
        typeConstraints: TypeChecker.constraintsOf(method.typeParameters ?? []),
        defaults: TypeChecker.defaultsOf(method.typeParameters ?? []),
        params: method.params.map(parameter => ({ type: parameter.type, out: parameter.out, mutableReference: parameter.passing === "mut", variadic: parameter.variadic, defaultValue: parameter.defaultValue, optional: parameter.optional })),
        returnType: method.returnType
      };
      const match = this.matchOverload(signature, argumentTypes, node.typeArguments, expected);
      return match ? { match, method } : undefined;
    }).filter((candidate): candidate is { match: NonNullable<ReturnType<TypeChecker["matchOverload"]>>; method: InterfaceMethod } => !!candidate)
      .sort((left, right) => right.match.score - left.match.score);
    if (methods.length && !matches.length) this.report(node, `Ninguna sobrecarga de método '${node.method}' acepta (${argumentTypes.join(", ")})`);
    if (matches.length > 1 && matches[0].match.score === matches[1].match.score) this.report(node, `Llamada ambigua al método '${node.method}'`);
    if (!matches.length) return undefined;
    const selected = matches[0].match;
    node.typeArguments.forEach(argument => this.validateType(argument, node, false, false, scope));
    node.args.forEach((argument, index) => {
      const selectedParameter = selected.signature.params[index];
      if (!selectedParameter?.out && !selectedParameter?.mutableReference) return;
      const mode = selectedParameter.out ? "out" : "mut";
      if (argument.kind !== "IdentifierExpression") this.report(argument, `Un argumento ${mode} debe ser una variable mutable`);
      else { const target = scope.resolve(argument.name); if (!target || target.kind !== "variable" || !target.mutable) this.report(argument, `Un argumento ${mode} debe ser una variable mutable`); else this.markCapturedMutation(argument, scope); }
    });
    const inferred = selected.signature.typeParameters.map(parameter => selected.substitutions.get(parameter));
    if (!node.typeArguments.length && inferred.length && inferred.every((type): type is TypeName => !!type)) this.inferredCallTypeArguments.set(node, inferred);
    return this.substituteType(selected.signature.returnType, selected.substitutions);
  }

  private declareFunction(node: FunctionDeclaration, scope: Scope): void {
    this.withTypeParameters(node.typeParameters, () => {
      for (const parameter of node.params) this.validateType(parameter.type, parameter, true, false, scope);
      this.validateType(node.returnType, node, false, false, scope);
      this.validateConstraints(node.typeParameters, node);
      this.validateParameterDefaults(node.params, node);
    });
    if (node.async && !isPromiseType(node.returnType)) this.report(node, `Una función async debe retornar Promise<T>, no '${node.returnType}'`);
    if (node.async && node.params.some(parameter => parameter.out)) this.report(node, "Las funciones async no admiten parámetros out sin análisis de duración");
    if (node.async && node.params.some(parameter => parameter.passing === "mut")) this.report(node, "Las funciones async no admiten parámetros mut sin análisis de duración");
    const restIndex = node.params.findIndex(parameter => parameter.variadic);
    if (restIndex >= 0 && restIndex !== node.params.length - 1) this.report(node.params[restIndex], "El parámetro variádico debe ser el último");
    if (node.params.filter(parameter => parameter.variadic).length > 1) this.report(node, "Solo se permite un parámetro variádico");
    if (restIndex >= 0 && !node.variadicTypeParameters.includes(node.params[restIndex].type)) this.report(node.params[restIndex], "El parámetro rest debe usar un pack genérico variádico");
    for (const pack of node.variadicTypeParameters) {
      if (!node.params.some(parameter => parameter.variadic && parameter.type === pack)) this.report(node, `El pack genérico '${pack}' necesita un parámetro rest correspondiente`);
    }
    const signature: FunctionSignature = {
      typeParameters: TypeChecker.namesOf(node.typeParameters),
      variadicTypeParameters: node.variadicTypeParameters,
      typeConstraints: TypeChecker.constraintsOf(node.typeParameters),
      defaults: TypeChecker.defaultsOf(node.typeParameters),
      params: node.params.map(p => ({ type: p.type, out: p.out, mutableReference: p.passing === "mut", variadic: p.variadic, defaultValue: p.defaultValue, optional: p.optional })),
      returnType: node.returnType
    };
    // V0.3: huella estructural resuelta sobre el nodo. Permite al codegen
    // comparar firmas sin parsear strings y generar SFINAE constraints.
    node.resolvedSignature = {
      parameters: node.params.map(p => ({
        name: p.name,
        type: toResolvedType(p.type) ?? { kind: "any" },
        optional: p.optional ?? false,
        variadic: p.variadic ?? false,
        hasDefault: p.defaultValue !== undefined,
      })),
      returnType: toResolvedType(node.returnType) ?? { kind: "any" },
      typeParameters: TypeChecker.namesOf(node.typeParameters),
      async: node.async,
    };
    const existing = scope.resolveLocal(node.name);
    if (!existing) scope.define(node.name, { kind: "function", overloads: [signature] });
    else if (existing.kind !== "function") this.report(node, `Símbolo duplicado '${node.name}'`);
    else if (existing.overloads.some(candidate => this.sameSignature(candidate, signature))) this.report(node, `Sobrecarga duplicada '${node.name}'`);
    else existing.overloads.push(signature);
  }

  private declareInterface(node: InterfaceDeclaration, scope: Scope): void {
    if (this.interfaces.has(node.name) || !scope.define(node.name, { kind: "type", type: node.name })) {
      this.report(node, `Símbolo duplicado '${node.name}'`); return;
    }
    this.interfaces.set(node.name, node);
    // V0.4: interfaces se emiten como `struct` C++ con métodos virtuales puros.
    node.resolvedRuntimeType = { kind: "passthrough", cppName: node.name };
    const methods = new Set<string>();
    for (const method of node.methods) {
      const signature = `${method.name}(${method.params.map(parameter => parameter.type).join(",")})`;
      if (methods.has(signature)) this.report(method, `Sobrecarga de método duplicada '${method.name}'`);
      methods.add(signature);
      this.validateType(method.returnType, method, false, true, scope);
      for (const parameter of method.params) this.validateType(parameter.type, parameter, false, true, scope);
      this.validateParameterDefaults(method.params, method);
      // V22: ref<T>/constRef<T> no se permiten como return type en métodos
      // de interface (misma regla que en FunctionDeclaration/ClassMethod).
      if (isGenericType(method.returnType) && (genericBase(method.returnType) === "ref" || genericBase(method.returnType) === "constRef")) {
        this.report(method, `E42xx: borrowed references cannot be returned yet. Returning ref<T> or constRef<T> requires lifetime analysis that is not supported by the current ownership model.`);
      }
      // V0.3: huella estructural resuelta del método de interfaz.
      method.resolvedSignature = {
        parameters: method.params.map(p => ({
          name: p.name,
          type: toResolvedType(p.type) ?? { kind: "any" },
          optional: p.optional ?? false,
          variadic: p.variadic ?? false,
          hasDefault: p.defaultValue !== undefined,
        })),
        returnType: toResolvedType(method.returnType) ?? { kind: "any" },
        typeParameters: TypeChecker.namesOf(method.typeParameters ?? []),
        async: false,
      };
    }
  }

  // Declara un alias de tipo y valida su RHS (con detección de ciclos). Los
  // parámetros de tipo se añaden al ámbito activo mientras se valida el RHS,
  // para que `type Box<T> = T[]` acepte `T` como tipo dentro del cuerpo.
  private declareTypeAlias(node: TypeAliasDeclaration, scope: Scope): void {
    if (this.aliases.has(node.name) || !scope.define(node.name, { kind: "type", type: node.name })) {
      this.report(node, `Símbolo duplicado '${node.name}'`); return;
    }
    this.aliases.set(node.name, node);
    // V0.4: pre-computa el ResolvedRuntimeType del RHS del alias. Esto
    // permite que el codegen consuma directamente la forma resuelta sin
    // tener que parsear `node.type` cada vez.
    node.resolvedRuntimeType = { kind: "alias", target: toResolvedRuntimeType(node.type) };
    this.withTypeParameters(node.typeParameters, () => {
      const visited = new Set<string>([node.name]);
      this.validateType(node.type, node, false, false, scope, visited);
    });
  }

  // Recorre el programa y reemplaza en el AST cualquier referencia a un alias
  // (simple o genérico) por su forma expandida. Sin esta mutación, codegen
  // emitiría literalmente `NumberArray ns = ...;` y el binario no compilaría.
  private expandAliasesInProgram(program: Program): void {
    const rewriteConstraints = (parameters: TypeParameter[]): void => {
      for (const parameter of parameters) {
        if (parameter.constraint) parameter.constraint = this.expandType(parameter.constraint);
        if (parameter.default) parameter.default = this.expandType(parameter.default);
      }
    };
    const rewriteParameter = (parameter: Parameter): void => { parameter.type = this.expandType(parameter.type); };
    const rewriteArrow = (params: Parameter[], returnType: TypeName | undefined): void => {
      params.forEach(rewriteParameter);
      if (returnType) returnType = this.expandType(returnType);
    };
    const walk = (statement: Statement | undefined): void => {
      if (!statement) return;
      switch (statement.kind) {
        case "VariableDeclaration":
          if (statement.declaredType) statement.declaredType = this.expandType(statement.declaredType);
          break;
        case "FunctionDeclaration":
          statement.params.forEach(rewriteParameter);
          statement.returnType = this.expandType(statement.returnType);
          rewriteConstraints(statement.typeParameters);
          break;
        case "InterfaceDeclaration":
          statement.methods.forEach(method => {
            method.params.forEach(rewriteParameter);
            method.returnType = this.expandType(method.returnType);
            rewriteConstraints(method.typeParameters ?? []);
          });
          break;
        case "ClassDeclaration":
          statement.fields.forEach(field => { field.type = this.expandType(field.type); });
          statement.methods.forEach(method => {
            method.params.forEach(rewriteParameter);
            method.returnType = this.expandType(method.returnType);
            rewriteConstraints(method.typeParameters ?? []);
          });
          rewriteConstraints(statement.typeParameters);
          break;
        case "TypeAliasDeclaration":
          statement.type = this.expandType(statement.type);
          statement.typeParameters.forEach(parameter => {
            if (parameter.constraint) parameter.constraint = this.expandType(parameter.constraint);
            if (parameter.default) parameter.default = this.expandType(parameter.default);
          });
          break;
        case "BlockStatement": statement.statements.forEach(walk); break;
        case "IfStatement":
          walk(statement.thenBranch); if (statement.elseBranch) walk(statement.elseBranch); break;
        case "WhileStatement": walk(statement.body); break;
        case "ForStatement": walk(statement.body); if (statement.initializer && statement.initializer.kind === "BlockStatement") walk(statement.initializer); break;
        case "ForOfStatement": walk(statement.body); break;
        case "ForInStatement": walk(statement.body); break;
        case "ReturnStatement": break;
        case "BreakStatement": case "ContinueStatement": case "DeleteStatement": case "SwitchStatement": case "ExpressionStatement": break;
        case "EnumDeclaration": break;
      }
    };
    program.statements.forEach(walk);
  }

  private declareClassName(node: ClassDeclaration, scope: Scope): void {
    if (node.name === "Promise" || this.classes.has(node.name) || !scope.define(node.name, { kind: "type", type: node.name })) {
      this.report(node, `Símbolo duplicado '${node.name}'`); return;
    }
    this.classes.set(node.name, node);
    // V0.4: tipo concreto en runtime C++.
    if (node.typeParameters.length) node.resolvedRuntimeType = { kind: "polymorphic", typeParameters: TypeChecker.namesOf(node.typeParameters) };
    else node.resolvedRuntimeType = { kind: "passthrough", cppName: node.name };
  }

  private declareEnum(node: EnumDeclaration, scope: Scope): void {
    if (this.enums.has(node.name) || !scope.define(node.name, { kind: "type", type: node.name })) {
      this.report(node, `Símbolo duplicado '${node.name}'`); return;
    }
    this.enums.set(node.name, node);
    // V0.4: enums se emiten como un struct C++.
    node.resolvedRuntimeType = { kind: "passthrough", cppName: node.name };
    const seen = new Set<string>();
    for (const member of node.members) {
      if (seen.has(member.name)) this.report(member, `Miembro de enum duplicado '${member.name}'`);
      seen.add(member.name);
      this.defineVariable(scope, member.name, node.name, false);
    }
  }

  // V1.4: registra `Result<T, E = string>` como unión sintética del
  // runtime. Dos variantes con discriminador booleano en el campo `ok`:
  //   { ok: true,  value: T }
  //   { ok: false, error: E }
  // Tras este registro, todo el flujo (validateType, match, narrowing)
  // trata `Result<T>` y `Result<T, E>` como tagged union nativa.
  private declareResultSyntheticUnion(scope: Scope): void {
    // Span sintético para nodos sin posición real (no aparecen en código).
    const synthSpan = { start: { offset: 0, line: 0, column: 0 }, end: { offset: 0, line: 0, column: 0 } };
    const resultNode: UnionDeclaration = {
      kind: "UnionDeclaration",
      exported: true,
      name: "Result",
      typeParameters: [
        { name: "T", span: synthSpan },
        { name: "E", span: synthSpan, default: "string" },
      ],
      variants: [
        { name: "Ok",  payload: "T", discriminator: { field: "ok", value: true  }, span: synthSpan },
        { name: "Err", payload: "E", discriminator: { field: "ok", value: false }, span: synthSpan },
      ],
      resolvedRuntimeType: { kind: "passthrough", cppName: "Result" },
      span: synthSpan,
    };
    // Marcamos para que NO entre en `expandAliasesInProgram` ni en la fase de
    // validación de payloads (los nombres T/E son type parameters, no tipos
    // reales). `declareUnion` los maneja correctamente vía `withTypeParameters`.
    this.unions.set(resultNode.name, resultNode);
    scope.define(resultNode.name, { kind: "type", type: resultNode.name });
  }

  // V1: tagged unions nativas del dialecto. Se emiten como `std::variant<...>`
  // con discriminador. Cada variante es accesible vía `match` (V1.2 introducirá
  // exhaustividad).
  private declareUnion(node: UnionDeclaration, scope: Scope): void {
    if (this.classes.has(node.name) || this.enums.has(node.name) || this.unions.has(node.name) || !scope.define(node.name, { kind: "type", type: node.name })) {
      this.report(node, `Símbolo duplicado '${node.name}'`); return;
    }
    this.unions.set(node.name, node);
    // V0.4: pre-computamos el ResolvedRuntimeType para que el codegen lo
    // consuma directamente. Una unión sin parámetros genéricos se emite
    // como passthrough (std::variant) en C++.
    node.resolvedRuntimeType = { kind: "passthrough", cppName: node.name };
    this.withTypeParameters(node.typeParameters, () => {
      const seen = new Set<string>();
      for (const variant of node.variants) {
        if (seen.has(variant.name)) this.report(variant, `Variante de unión duplicada '${variant.name}'`);
        seen.add(variant.name);
        if (variant.payload) this.validateType(variant.payload, variant, false, false, scope);
      }
    });
  }

  private validateClass(node: ClassDeclaration, scope: Scope): void {
    if (node.variadicTypeParameters.length) this.report(node, "Los packs genéricos en clases todavía no están soportados");
    this.withTypeParameters(node.typeParameters, () => { this.validateConstraints(node.typeParameters, node); this.validateClassMembers(node, scope); });
  }

  private validateClassMembers(node: ClassDeclaration, scope: Scope): void {
    const members = new Set<string>();
    const methodSignatures = new Set<string>();
    for (const field of node.fields) {
      if (members.has(field.name)) this.report(field, `Miembro duplicado '${field.name}'`);
      members.add(field.name);
      this.validateType(field.type, field, false, false, scope);
      if (field.type === "void" || this.interfaces.has(field.type)) this.report(field, `El campo '${field.name}' necesita un tipo concreto`);
      // V22 (Memory Model v2): ref<T> y constRef<T> son préstamos que no
      // pueden almacenarse en un campo. E4203.
      if (isGenericType(field.type) && (genericBase(field.type) === "ref" || genericBase(field.type) === "constRef")) {
        this.report(field, `E4203: borrowed references cannot be stored in class fields. Use T (value), ptr<T> (exclusive owner), or constPtr<T> (readonly owner) for the field '${field.name}'.`);
      }
    }
    for (const method of node.methods) {
      if (members.has(method.name)) this.report(method, `El método '${method.name}' entra en conflicto con un campo`);
      const signature = `${method.name}(${method.params.map(parameter => parameter.type).join(",")})`;
      if (methodSignatures.has(signature)) this.report(method, `Sobrecarga de método duplicada '${method.name}'`);
      methodSignatures.add(signature);
      this.withTypeParameters(method.typeParameters ?? [], () => {
        this.validateConstraints(method.typeParameters ?? [], method);
        for (const parameter of method.params) this.validateType(parameter.type, parameter, true, false, scope);
        this.validateType(method.returnType, method, false, false, scope);
        this.validateParameterDefaults(method.params, method);
      });
    }
  }

  private validateConstraints(parameters: TypeParameter[], node: { span: import("../core/span.ts").Span }): void {
    for (const parameter of parameters) {
      if (!parameter.constraint) continue;
      // El constraint puede ser una intersección `A & B & ...`: cada miembro debe ser una interfaz.
      const members = isIntersectionType(parameter.constraint) ? intersectionMembers(parameter.constraint) : [parameter.constraint];
      for (const member of members) if (!this.interfaces.has(member)) this.report(node, `El constraint '${member}' debe ser una interfaz`);
    }
    // TS-style: los defaults deben venir después de los parámetros sin default.
    let seenDefault = false;
    for (const parameter of parameters) {
      if (parameter.default) {
        seenDefault = true;
      } else if (seenDefault) {
        this.report(node, `El parámetro '${parameter.name}' necesita un valor por defecto porque los siguientes lo tienen`);
      }
    }
    // Si un parámetro tiene default y constraint, el default debe satisfacer el constraint.
    for (const parameter of parameters) {
      if (!parameter.default || !parameter.constraint) continue;
      if (!this.satisfiesInterface(parameter.default, parameter.constraint)) this.report(node, `El valor por defecto '${parameter.default}' no satisface el constraint '${parameter.constraint}'`);
    }
  }

  // Valida los valores por defecto de los parámetros: cada uno se evalúa en un
  // scope temporal que contiene los parámetros anteriores (los defaults pueden
  // referenciar parámetros previos como `function f(x: number, y: number = x * 2)`).
  private validateParameterDefaults(params: Parameter[], node: { span: import("../core/span.ts").Span }): void {
    const local = new Scope();
    for (const parameter of params) {
      if (parameter.defaultValue) {
        const actual = this.expression(parameter.defaultValue, local, parameter.type);
        this.require(actual, parameter.type, parameter.defaultValue);
        // V3: idem VariableDeclaration, validamos rango de literales numéricos
        // concretos en defaults de parámetros (acepta `-N` / `+N` unarios).
        this.validateNumericExpression(parameter.defaultValue, parameter.type);
      }
      // V22: los parámetros de función son siempre mutables localmente (el
      // callee puede asignar a `b` o a `b.x` libremente). La inmutabilidad
      // se enforce en runtime cuando el tipo es `readonly<T>` o `constRef<T>`.
      // Las arrow functions (1685) sí restringen a false para evitar mutar
      // capturas.
      // V22: los parámetros de función son siempre mutables localmente (el
      // callee puede asignar a `b` o a `b.x` libremente). La inmutabilidad
      // se enforce en runtime cuando el tipo es `readonly<T>` o `constRef<T>`.
      this.defineVariable(local, parameter.name, parameter.type, true, { variadic: parameter.variadic, mutableReference: this.parameterIsMutableReference(parameter.type) }, parameter);
    }
  }

  private validateExhaustiveMatch(node: MatchExpression, subjectUnion: UnionDeclaration, scope: Scope): void {
    // Conjunto de variantes cubiertas explícitamente y bandera de wildcard.
    const covered = new Set<string>();
    let hasWildcard = false;
    for (const arm of node.arms) {
      if (!arm.variantMatch) {
        // Arm legacy (`when (...)`); en un match V2 no lo aceptamos: el
        // codegen V2 emite `switch` sobre `kind` y necesita la metadata.
        this.report(arm, "Un 'match' exhaustivo solo admite arms 'case'; los arms 'when' pertenecen al flujo TC39 stage 2");
        continue;
      }
      if (arm.variantMatch.isWildcard) { hasWildcard = true; continue; }
      const variantName = arm.variantMatch.variantName;
      const variant = subjectUnion.variants.find(v => v.name === variantName);
      if (!variant) {
        this.report(arm, `La unión '${subjectUnion.name}' no tiene variante '${variantName}' (variantes: ${subjectUnion.variants.map(v => v.name).join(", ")})`);
        continue;
      }
      if (covered.has(variantName)) this.report(arm, `La variante '${variantName}' ya estaba cubierta por un arm anterior`);
      covered.add(variantName);
      // Verificar el número de bindings contra el payload de la variante.
      const payloadFields = variant.payload ? 1 : 0;
      if (arm.variantMatch.bindings.length !== payloadFields) {
        this.report(arm, `La variante '${variantName}' tiene ${payloadFields} payload(s); el pattern declara ${arm.variantMatch.bindings.length} binding(s)`);
        continue;
      }
      // Los bindings deben ser identifiers no reservados (no shadowean
      // símbolos en el scope actual — basta con detectar keywords del
      // dialecto que también son names de variable frecuentes).
      for (const binding of arm.variantMatch.bindings) {
        if (!binding) continue;
        if (binding === "_") this.report(arm, `El binding '${binding}' es un identificador inválido (reservado como wildcard)`);
      }
    }
    if (hasWildcard) return; // el wildcard cubre cualquier variante restante
    const missing = subjectUnion.variants.filter(v => !covered.has(v.name)).map(v => v.name);
    if (missing.length) this.report(node, `'match' no es exhaustivo: faltan variantes ${missing.join(", ")}`);
  }
  // V3: rango de un literal numérico contra un tipo numérico concreto (i8..u64, f32, f64).
  // Se invoca cuando una declaración anota explícitamente el tipo numérico y el
  // initializer es un literal numérico (con posible prefijo `-` o `+`). Reporta
  // diagnóstico si el valor no cabe en el rango del tipo destino. Las reglas:
  //   - i*/u* (enteros): Number.isSafeInteger(value) + rango [-2^(n-1), 2^(n-1)-1] para signed,
  //     [0, 2^n-1] para unsigned. Para unsigned, valor negativo => error.
  //   - f32/f64 (flotantes): sólo se rechaza que no sea finito (no validamos precisión).
  private validateNumericLiteral(node: LiteralExpression, expectedType: TypeName): void {
    if (!isNumericType(expectedType)) return;
    if (node.literalType !== "number") return; // sólo literales numéricos
    const raw = node.value;
    const kind = numericKind(expectedType);
    const bits = numericBitWidth(expectedType);
    const sign = numericSign(expectedType);
    if (kind === "integer" && bits !== null) {
      // Para u* (unsigned), el valor negativo es siempre un error.
      if (sign === "unsigned" && typeof raw === "number" && raw < 0) {
        this.report(node, `El literal ${raw} no cabe en ${expectedType} (rango 0..${(2 ** bits) - 1})`);
        return;
      }
      if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
        this.report(node, `El literal ${raw} no cabe en ${expectedType} (se esperaba un entero)`);
        return;
      }
      if (!Number.isSafeInteger(raw)) {
        this.report(node, `El literal ${raw} no cabe en ${expectedType} (no es un entero seguro de JavaScript)`);
        return;
      }
      const max = sign === "unsigned" ? (2 ** bits) - 1 : (2 ** (bits - 1)) - 1;
      const min = sign === "unsigned" ? 0 : -(2 ** (bits - 1));
      if (raw < min || raw > max) {
        this.report(node, `El literal ${raw} no cabe en ${expectedType} (rango ${min}..${max})`);
      }
    } else if (kind === "float" && bits !== null) {
      // Para f32/f64: cualquier número finito cabe (rango muy laxo; no
      // validamos precisión). NaN/Infinity no caben — un literal parseado
      // rara vez es NaN/Inf, pero defenderse si el lexer lo produce.
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        this.report(node, `El literal ${raw} no es un número finito válido para ${expectedType}`);
      }
    }
  }

  // V4: helper para extraer un valor entero literal de una expresión (o
  // `undefined` si no es un literal entero). Soporta tanto LiteralExpression
  // como UnaryExpression con `-`/`+` sobre LiteralExpression.
  private literalIntValue(node: Expression): number | undefined {
    if (node.kind === "LiteralExpression" && node.literalType === "number" && Number.isInteger(Number(node.value))) return Number(node.value);
    if (node.kind === "UnaryExpression" && (node.operator === "-" || node.operator === "+") && node.operand.kind === "LiteralExpression" && node.operand.literalType === "number" && Number.isInteger(Number(node.operand.value))) return node.operator === "-" ? -Number(node.operand.value) : Number(node.operand.value);
    return undefined;
  }

  // V3: helper público-equivalente para casos donde el initializer es un
  // UnaryExpression con un literal numérico (p.ej. `-129`). Lo desempaqueta y
  // delega en `validateNumericLiteral` con el signo aplicado.
  private validateNumericExpression(node: Expression, expectedType: TypeName): void {
    if (!isNumericType(expectedType)) return;
    // Acepta LiteralExpression directo.
    if (node.kind === "LiteralExpression") { this.validateNumericLiteral(node, expectedType); return; }
    // O UnaryExpression con operador `-`/`+` y operando literal numérico.
    if (node.kind === "UnaryExpression" && (node.operator === "-" || node.operator === "+") && node.operand.kind === "LiteralExpression") {
      const operand = node.operand;
      if (operand.literalType !== "number") return;
      const signed = node.operator === "-" ? -Number(operand.value) : Number(operand.value);
      const synthetic: LiteralExpression = { ...operand, value: signed };
      this.validateNumericLiteral(synthetic, expectedType);
    }
  }

  private validateType(type: TypeName, node: { span: import("../core/span.ts").Span }, interfaceAllowed: boolean, primitiveOnly = false, scope?: Scope, visited?: Set<string>): TypeName {
    // Resolver cualquier `typeof X` en posición de tipo antes de validar.
    // Devolvemos el tipo ya resuelto para que el llamador pueda reescribirlo
    // en su AST (e.g. `node.declaredType = resolved`) y no quede la marca
    // `$typeof$x` colgando para comparaciones y generación de código.
    if (isTypeofType(type)) {
      if (!scope) { this.report(node, `typeof tipo requiere un ámbito activo para resolver '${typeofTarget(type)}'`); return type; }
      const name = typeofTarget(type);
      const sym = scope.resolve(name);
      if (!sym) { this.report(node, `typeof tipo: '${name}' no está definido en este ámbito`); return type; }
      if (sym.kind === "variable" || sym.kind === "type") {
        const resolvedType = sym.type;
        // Si el tipo resuelto es a su vez un `typeof`, seguimos resolviendo.
        return this.validateType(resolvedType, node, interfaceAllowed, primitiveOnly, scope, visited);
      }
      this.report(node, `typeof tipo: '${name}' no tiene un tipo resoluble`);
      return type;
    }
    // Alias de tipo: `type X = ...`. El alias es transparente: expandimos el
    // RHS y validamos contra ese. `visited` evita ciclos como
    // `type A = B; type B = A;`.
    if (this.aliases.has(type)) {
      const next = visited ?? new Set<string>();
      if (next.has(type)) { this.report(node, `Ciclo en alias de tipo '${type}'`); return type; }
      next.add(type);
      return this.validateType(this.aliases.get(type)!.type, node, interfaceAllowed, primitiveOnly, scope, next);
    }
    if (this.activeTypeParameters.has(type)) return type;
    // V1.2: las uniones no-genéricas (e.g. `Direction`) son tipos concretos válidos.
    if (this.unions.has(type)) {
      const unionNode = this.unions.get(type)!;
      if (unionNode.typeParameters.length) this.report(node, `'${type}' espera ${unionNode.typeParameters.length} argumento(s) de tipo, no lleva ninguno`);
      return type;
    }
    if (isUnionType(type)) { for (const member of unionMembers(type)) this.validateType(member, node, interfaceAllowed, primitiveOnly, scope); return type; }
    if (isIntersectionType(type)) { for (const member of intersectionMembers(type)) this.validateType(member, node, true, true, scope); return type; }
    // V5: readonly<T> es un decorador. Validamos recursivamente el tipo interno.
    if (isReadonlyType(type)) {
      const inner = readonlyInner(type);
      if (inner) this.validateType(inner, node, interfaceAllowed, primitiveOnly, scope);
      return type;
    }
    if (isArrayType(type)) {
      const element = arrayElement(type);
      if (element === "void" || this.interfaces.has(element)) this.report(node, `El array necesita un tipo de elemento concreto, no '${element}'`);
      this.validateType(element, node, false, primitiveOnly, scope);
      return type;
    }
    // V4: arrays de tamaño fijo `T[N]`. Validamos que T es concreto y N
    // es positivo. Registramos en el cache indexado por el nombre canónico
    // para que codegen y bounds-check puedan consultar element/size sin
    // re-parsear el string (regla del dialecto: nada de regex sobre tipos).
    const fixedMatch = type.match(/^([^\s\[\]]+)\[(\d+)\]$/);
    if (fixedMatch) {
      const element = fixedMatch[1];
      const size = Number(fixedMatch[2]);
      if (element === "void" || this.interfaces.has(element)) this.report(node, `El array fijo necesita un tipo de elemento concreto, no '${element}'`);
      if (!Number.isInteger(size) || size <= 0) this.report(node, `El tamaño del array fijo debe ser un literal entero positivo, no '${size}'`);
      this.validateType(element, node, false, primitiveOnly, scope);
      return registerFixedArray(element, size);
    }
    if (isTupleType(type)) {
      const elements = tupleElements(type);
      if (!elements.length) this.report(node, "Una tupla debe tener al menos un elemento");
      for (const element of elements) {
        if (element === "void" || this.interfaces.has(element)) this.report(node, `La tupla necesita tipos concretos, no '${element}'`);
        this.validateType(element, node, false, primitiveOnly, scope);
      }
      return type;
    }
    if (isFunctionType(type)) {
      for (const parameter of functionParameters(type)) {
        if (parameter === "void" || this.interfaces.has(parameter)) this.report(node, `Una closure necesita parámetros concretos, no '${parameter}'`);
        this.validateType(parameter, node, false, primitiveOnly, scope);
      }
      const result = functionResult(type);
      if (this.interfaces.has(result)) this.report(node, `Una closure necesita un retorno concreto, no '${result}'`);
      this.validateType(result, node, false, primitiveOnly, scope);
      return type;
    }
    if (isGenericType(type)) {
      const base = genericBase(type); const owner = this.classes.get(base);
      // V1.2: las uniones son tipos válidos aunque no estén en classes.
      if (!owner && this.unions.has(base)) {
        const unionNode = this.unions.get(base)!;
        // V1.4: defaults en typeParameters (e.g. `Result<T>` → E="string").
        if (genericArguments(type).length > unionNode.typeParameters.length) this.report(node, `'${base}' espera ${unionNode.typeParameters.length} argumento(s) de tipo como máximo, recibió ${genericArguments(type).length}`);
        else if (genericArguments(type).length < unionNode.typeParameters.length) {
          const missing = unionNode.typeParameters.slice(genericArguments(type).length);
          if (missing.some(p => p.default === undefined)) {
            const required = unionNode.typeParameters.length - missing.filter(p => p.default !== undefined).length;
            this.report(node, `'${base}' espera al menos ${required} argumento(s) de tipo, recibió ${genericArguments(type).length}`);
          }
        }
        genericArguments(type).forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      } const arguments_ = genericArguments(type);
      // V22 (Memory Model v2): ref<T> y constRef<T> no se permiten como
      // argumentos de tipo en genéricos (e.g. `Array<ref<Counter>>` no
      // tiene sentido porque las referencias no son valores). E4205.
      for (const arg of arguments_) {
        if (isGenericType(arg) && (genericBase(arg) === "ref" || genericBase(arg) === "constRef")) {
          this.report(node, `E4205: borrowed references (ref<T>/constRef<T>) cannot be used as type arguments in generic instantiations.`);
        }
      }
      // Instanciación de alias genérico: `type Box<T> = T[]` + `Box<number>`.
      if (!owner && this.aliases.has(base)) {
        const alias = this.aliases.get(base)!;
        const next = visited ?? new Set<string>();
        if (next.has(base)) { this.report(node, `Ciclo en alias de tipo '${base}'`); return; }
        if (arguments_.length !== alias.typeParameters.length) { this.report(node, `'${base}' espera ${alias.typeParameters.length} argumentos de tipo, recibió ${arguments_.length}`); return; }
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        const aliasConstraints = TypeChecker.constraintsOf(alias.typeParameters);
        for (const [parameter, constraint] of Object.entries(aliasConstraints)) {
          const index = alias.typeParameters.findIndex(parameter_ => parameter_.name === parameter);
          const actual = arguments_[index];
          if (actual && constraint && !this.satisfiesInterface(actual, constraint)) this.report(node, `El tipo '${actual}' no satisface el constraint '${constraint}' de '${parameter}'`);
        }
        const next2 = new Set(next); next2.add(base);
        const subs = new Map<string, TypeName>();
        alias.typeParameters.forEach((parameter, index) => { if (arguments_[index]) subs.set(parameter.name, arguments_[index]); });
        const expanded = this.substituteType(alias.type, subs);
        this.withTypeParameters(alias.typeParameters, () => {
          this.validateType(expanded, node, interfaceAllowed, primitiveOnly, scope, next2);
        });
        return type;
      }
      if (base === "Promise") {
        if (arguments_.length !== 1) this.report(node, `'Promise' espera 1 argumento de tipo, recibió ${arguments_.length}`);
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      }
      if (base === "Result") {
        // V1.4: `Result<T>` (1 arg, E por defecto = string) o `Result<T, E>`.
        // Se delega en la rama de uniones (sintética, registrada por
        // declareResultSyntheticUnion) que ya valida nº de typeArgs y
        // procesa defaults. Solo añadimos aquí la restricción legacy
        // de que T ≠ void (que el flujo de unions no conoce).
        if (arguments_.length < 1 || arguments_.length > 2) this.report(node, `'Result' espera 1 o 2 argumentos de tipo, recibió ${arguments_.length}`);
        if (arguments_[0] === "void") this.report(node, "Result<void> no está soportado; usa Result<boolean> o Promise<void>");
        // Si no es la unión sintética (p.ej. alguien redeclaró `Result`),
        // caemos al path genérico inferior para no romper su semántica.
        if (this.unions.has(base) && this.unions.get(base)!.typeParameters.length) {
          const unionNode = this.unions.get(base)!;
          // V1.4: la unión sintética declara 2 typeParameters (T, E) pero
          // E tiene default. Permitir 1 o 2 argumentos; los defaults se
          // resuelven en la rama genérica inferior.
          if (arguments_.length > unionNode.typeParameters.length) this.report(node, `'${base}' espera ${unionNode.typeParameters.length} argumento(s) de tipo como máximo, recibió ${arguments_.length}`);
          else if (arguments_.length < unionNode.typeParameters.length) {
            const missing = unionNode.typeParameters.slice(arguments_.length);
            if (missing.some(p => p.default === undefined)) {
              const required = unionNode.typeParameters.length - missing.filter(p => p.default !== undefined).length;
              this.report(node, `'${base}' espera al menos ${required} argumento(s) de tipo, recibió ${arguments_.length}`);
            }
          }
          arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
          return type;
        }
        // Si no hay unión sintética (caso patológico), validamos igual.
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      }
      if (base === "Map") {
        if (arguments_.length !== 2) this.report(node, `'Map' espera 2 argumentos de tipo (K, V), recibió ${arguments_.length}`);
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      }
      if (base === "Optional") {
        if (arguments_.length !== 1) this.report(node, `'Optional' espera 1 argumento de tipo, recibió ${arguments_.length}`);
        this.validateType(arguments_[0], node, false, primitiveOnly, scope);
        return type;
      }
      // Issue #3: smart pointers. Aceptan exactamente 1 argumento de tipo,
      // que NO puede ser primitivo (los primitivos van siempre por valor).
      if (base === "Unq" || base === "Rc" || base === "MutRef" || base === "Mut") {
        if (arguments_.length !== 1) this.report(node, `'${base}' espera 1 argumento de tipo, recibió ${arguments_.length}`);
        const inner = arguments_[0];
        if (inner && isPrimitive(inner)) this.report(node, `'${base}<${inner}>' no soporta primitivos (los primitivos van por valor)`);
        this.validateType(inner, node, false, primitiveOnly, scope);
        // V22 PR#9a: E4404 - deprecation warning para Rc<T>. Se debe migrar
        // a ptr<T> (unique ownership) o weak<T> (shared ownership circular,
        // PR#9b). Reportamos como warning (no error) para no romper código
        // existente durante la migracion.
        if (base === "Rc") {
          this.report(node, `E4404: 'Rc<T>' is deprecated. Use 'ptr<T>' for unique ownership or 'weak<T>' for shared ownership that breaks cycles (V22 PR#9b).`);
        }
        return type;
      }
      if (base === "Set") {
        if (arguments_.length !== 1) this.report(node, `'Set' espera 1 argumento de tipo, recibió ${arguments_.length}`);
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      }
      // V1.2: las uniones también son tipos genéricos. Aceptan el número
      // declarado de typeParameters. V1.4: si los parámetros que faltan
      // tienen `default`, se omiten sin error (e.g. `Result<T>` → E="string").
      if (this.unions.has(base)) {
        const unionNode = this.unions.get(base)!;
        if (arguments_.length > unionNode.typeParameters.length) this.report(node, `'${base}' espera ${unionNode.typeParameters.length} argumento(s) de tipo como máximo, recibió ${arguments_.length}`);
        else if (arguments_.length < unionNode.typeParameters.length) {
          // ¿Todos los parámetros que faltan tienen default?
          const missing = unionNode.typeParameters.slice(arguments_.length);
          if (missing.some(p => p.default === undefined)) {
            const required = unionNode.typeParameters.length - missing.filter(p => p.default !== undefined).length;
            this.report(node, `'${base}' espera al menos ${required} argumento(s) de tipo, recibió ${arguments_.length}`);
          }
        }
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      }
      // V22 (Memory Model v2): ptr<T>, constPtr<T>, ref<T>, constRef<T> son
      // modificadores intrínsecos de paso, no tipos genéricos definidos por
      // el usuario. Aceptamos exactamente 1 argumento (T) y seguimos.
      if (base === "ptr" || base === "constPtr" || base === "ref" || base === "constRef") {
        if (arguments_.length !== 1) this.report(node, `'${base}<T>' espera 1 argumento de tipo, recibió ${arguments_.length}`);
        else arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      }
      if (!owner) { this.report(node, `Tipo genérico no definido '${base}'`); return type; }
      if (arguments_.length !== owner.typeParameters.length) this.report(node, `'${base}' espera ${owner.typeParameters.length} argumentos de tipo, recibió ${arguments_.length}`);
      arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
      owner.typeParameters.forEach((parameter, index) => {
        const constraint = parameter.constraint; const actual = arguments_[index];
        if (constraint && actual && !this.satisfiesInterface(actual, constraint)) this.report(node, `El tipo '${actual}' no satisface el constraint '${constraint}' de '${parameter.name}'`);
      });
      return type;
    }
    const primitive = isPrimitive(type);
    const concrete = this.classes.has(type) || this.aliases.has(type) || this.enums.has(type) || ["TcpListener", "TcpConnection", "TlsContext", "TlsConnection", "CancellationSource", "CancellationToken", "JsonValue", "FileReader"].includes(type);
    const contract = interfaceAllowed && this.interfaces.has(type);
    // Los tipos genéricos `Promise<T>`, `Result<T, E>`, `Map<K, V>`, `Set<T>`,
    // `Optional<T>` se aceptan siempre (son tipos del runtime).
    const genericBaseName = type.includes("<") ? type.slice(0, type.indexOf("<")) : "";
    const genericConcrete = ["Promise", "Result", "Map", "Set", "Optional"].includes(genericBaseName);
    if (!primitive && (primitiveOnly || (!concrete && !contract && !genericConcrete))) this.report(node, `Tipo no definido o no permitido '${type}'`);
  }

  private statement(node: Statement, scope: Scope): void {
    switch (node.kind) {
      case "VariableDeclaration": {
        // V6: si el tipo es `T[N]` con `N` siendo un IdentifierExpression
        // que referencia un `const` con valor literal conocido, propagamos el
        // valor antes de validateType (que registra el cache). Sin esto, el
        // bounds-check y el codegen ven `u8[N]` con `N` simbólico y no
        // pueden emitir `std::array<T, 4>` constexpr.
        if (node.declaredType) {
          node.declaredType = this.propagateConstantArraySize(node.declaredType, scope);
        }
        const expandedDeclared = node.declaredType ? this.expandType(node.declaredType, scope) : undefined;
        // V4: validateType() registra el array fijo en los caches de
        // type-system.ts ANTES de evaluar el initializer. Sin esto, el
        // initializer no recibe `expected = T[N]` correctamente.
        if (node.declaredType) this.validateType(node.declaredType, node, true, false, scope);
        const actual = this.expression(node.initializer, scope, expandedDeclared);
        const expected = expandedDeclared ?? actual;
        if (node.declaredType) {
          // Reescribimos el AST con el tipo ya expandido (`typeof` resuelto
          // incluido) para que codegen vea directamente `number` y no la
          // marca `$typeof$x`. validateType ya se llamó antes para registrar
          // arrays fijos en los caches; no lo repetimos aquí.
          node.declaredType = expandedDeclared;
          // V3: si el tipo es un numérico concreto (i8..u64, f32, f64) y el
          // initializer es un literal numérico (con posible signo unario),
          // verificamos que el valor quepa en el rango del tipo destino.
          this.validateNumericExpression(node.initializer, node.declaredType);
        }
        if (expected === "void") this.report(node, "Una variable no puede ser de tipo void");
        // V22: si el expected es `ptr<T>`/`constPtr<T>` y el actual es `T`,
        // aceptamos (inferencia de ownership). El codegen usará
        // make_unique<T>(...) si el initializer es un NewExpression.
        const isPtrImplicit = expected && isGenericType(expected)
          && (genericBase(expected) === "ptr" || genericBase(expected) === "constPtr")
          && genericArguments(expected)[0] === actual
          && this.classes.has(actual)
          && actual !== "void";
        if (!typeMatches(actual, expected) && !isPtrImplicit) this.report(node, `Se esperaba ${expected}, pero se obtuvo ${actual}`);
        // V22 PR#134: detectar borrow conflicts. Si el tipo declarado es
        // `ref<T>`/`constRef<T>` y el initializer es `ref(x)`/`constRef(x)`,
        // registramos el borrow sobre la fuente `x` y comprobamos aliasing
        // con borrows activos en el scope actual.
        if (expected && isGenericType(expected)
            && (genericBase(expected) === "ref" || genericBase(expected) === "constRef")
            && node.initializer.kind === "CallExpression"
            && (node.initializer.callee === "ref" || node.initializer.callee === "constRef")
            && node.initializer.args.length === 1
            && node.initializer.args[0].kind === "IdentifierExpression") {
          const sourceName = node.initializer.args[0].name;
          const newMode: "mut" | "shared" = node.initializer.callee === "ref" ? "mut" : "shared";
          // Buscar borrows activos en el scope actual sobre la misma fuente.
          const currentScope = this.borrowStack[this.borrowStack.length - 1];
          const existing = currentScope.get(sourceName);
          if (existing !== undefined) {
            if (existing === "mut" || newMode === "mut") {
              // Cualquier combinacion que incluya un "mut" es conflicto.
              // E4206: mut+mut. E4207: mut+shared (cualquier orden).
              const code = existing === "mut" && newMode === "mut" ? "E4206" : "E4207";
              const msg = existing === "mut" && newMode === "mut"
                ? `E4206: mutable borrow conflict. '${sourceName}' is already borrowed as 'ref<T>' in this scope; cannot borrow again as 'ref<T>' (would create two mutable references). Use 'constRef(${sourceName})' if shared access is enough.`
                : `E4207: mutable/shared borrow conflict. '${sourceName}' is already borrowed ${existing === "mut" ? "as 'ref<T>' (mutable)" : "as 'constRef<T>' (shared)"} in this scope; cannot borrow ${newMode === "mut" ? "as 'ref<T>' (mutable)" : "as 'constRef<T>' (shared)"} because it would violate Rust-like aliasing rules.`;
              this.report(node.initializer, msg);
            }
          }
          // Registrar este borrow en el scope actual.
          currentScope.set(sourceName, newMode);
        }
        // V6: si es `const` y el initializer es un literal puro, anotamos el
        // valor para que el codegen pueda emitir `constexpr` y propagar el
        // valor a usos posteriores (tamaños de arrays fijos, branches con
        // condición constante). Limitación: solo literales simples; no
        // evaluamos expresiones (eso sería constant folding completo).
        if (!node.mutable && node.initializer.kind === "LiteralExpression") {
          const lit = node.initializer;
          node.constValue = typeof lit.value === "bigint" ? null : lit.value as number | string | boolean | null;
        }
        if (node.arrayBindings && node.arrayBindings.length > 0) {
          // Destructuring de arrays: cada binding hereda el tipo del elemento
          // del initializer (no del array completo). Si el initializer es
          // `string[]`, los bindings son `string`. Si el binding declara su
          // propio tipo, lo respetamos.
          const elementType = (actual && actual.endsWith("[]")) ? actual.slice(0, -2) : actual;
          for (const binding of node.arrayBindings) {
            const bindingType = binding.declaredType ? this.expandType(binding.declaredType, scope) : elementType;
            // Default value: si lo hay, su tipo debe ser compatible con el binding.
            // Si el initializer tiene menos elementos que bindings, los que tengan
            // default obtienen ese default; el resto produce error en runtime.
            if (binding.defaultValue) {
              const defaultType = this.expression(binding.defaultValue, scope, bindingType);
              if (!typeMatches(defaultType, bindingType)) this.report(binding.defaultValue, `Default value de '${binding.name}': se esperaba ${bindingType}, se obtuvo ${defaultType}`);
            }
            if (!this.defineVariable(scope, binding.name, bindingType, node.mutable)) this.report(node, `Símbolo duplicado '${binding.name}'`);
          }
        } else if (!this.defineVariable(scope, node.name, expected, node.mutable, { constValue: node.constValue }, node)) this.report(node, `Símbolo duplicado '${node.name}'`);
        break;
      }
      case "UsingDeclaration": {
        // `using name = expr;` se type-checkea igual que `let name = expr`,
        // con el matiz de que el binding es siempre inmutable (los recursos
        // RAII no se reasignan) y se permite cualquier tipo Disposable o con
        // destructor C++. Por ahora aceptamos cualquier tipo.
        const expandedDeclared = node.declaredType ? this.expandType(node.declaredType, scope) : undefined;
        const actual = this.expression(node.initializer, scope, expandedDeclared);
        const expected = expandedDeclared ?? actual;
        if (expandedDeclared) this.validateType(expandedDeclared, node, true, false, scope);
        // V3: rango literal para tipos numéricos concretos (idem VariableDeclaration).
        if (expandedDeclared) this.validateNumericExpression(node.initializer, expandedDeclared);
        if (expected === "void") this.report(node, "Un recurso 'using' no puede ser de tipo void");
        if (!typeMatches(actual, expected)) this.report(node, `Se esperaba ${expected}, pero se obtuvo ${actual}`);
        if (!this.defineVariable(scope, node.name, expected, false)) this.report(node, `Símbolo duplicado '${node.name}'`);
        break;
      }
      case "ExportDefaultDeclaration": {
        // `export default <decl-or-expr>` parsea una declaración completa
        // (class/function/let/const) o una expresión. Se type-checkea
        // normalmente; el codegen emite un marcador pero compila igual.
        this.statement(node.declaration as Statement, scope);
        break;
      }
      case "ExportNamedDeclaration": {
        // `export { name1, name2 as alias2 }` re-exporta bindings ya
        // declarados arriba. Verificamos que existan; el alias es opcional
        // y se registra en el scope para que pueda usarse como nombre local.
        for (const spec of node.specifiers) {
          const original = scope.resolve(spec.name);
          if (!original) { this.report(spec, `Símbolo no definido '${spec.name}'`); continue; }
          if (spec.alias) scope.define(spec.alias, { ...original, name: spec.alias } as unknown as SymbolInfo);
        }
        break;
      }
      case "FunctionDeclaration": {
        // V22 (Memory Model v2): ref<T>/constRef<T> no se permiten como
        // return type en V1 (no hay análisis de lifetimes). E42xx.
        if (isGenericType(node.returnType) && (genericBase(node.returnType) === "ref" || genericBase(node.returnType) === "constRef")) {
          this.report(node, `E42xx: borrowed references cannot be returned yet. Returning ref<T> or constRef<T> requires lifetime analysis that is not supported by the current ownership model.`);
        }
        // V22: ref<T>/constRef<T> no se permiten en funciones `async`
        // (podrían quedar colgando durante una suspensión). E4204.
        if (node.async) {
          for (const p of node.params) {
            if (isGenericType(p.type) && (genericBase(p.type) === "ref" || genericBase(p.type) === "constRef")) {
              this.report(p, `E4204: borrowed parameters (ref<T>/constRef<T>) are not allowed in async functions. Receive the value by copy (T) or by ownership (ptr<T>).`);
            }
          }
        }
        this.withTypeParameters(node.typeParameters, () => {
          const local = new Scope(scope);
          for (const p of node.params) {
            // `p?: T` se modela como `Optional<T>` en el scope. Si el user
            // ya escribió `Optional<T>` no duplicamos el envoltorio.
            const effectiveType = p.optional
              ? (isGenericType(p.type) && genericBase(p.type) === "Optional" ? p.type : genericType("Optional", [p.type]))
              : p.type;
            if (!this.defineVariable(local, p.name, effectiveType, true, { variadic: p.variadic, mutableReference: this.parameterIsMutableReference(p.type) }, p)) this.report(node, `Parámetro duplicado '${p.name}'`);
          }
          const previousReturn = this.currentReturn; const previousAsync = this.currentAsync;
          this.currentReturn = node.async && isPromiseType(node.returnType) ? promiseResult(node.returnType) : node.returnType;
          this.currentAsync = node.async;
          this.statement(node.body, local);
          this.currentReturn = previousReturn; this.currentAsync = previousAsync;
        });
        break;
      }
      case "InterfaceDeclaration": break;
      case "TypeAliasDeclaration": break;
      case "ClassDeclaration": {
        // V19: registramos la clase actual. Cuando visitamos los métodos,
        // `currentClass` les permite enforzar `private`/`protected` sobre
        // accesos a campos/métodos de la misma clase.
        const previousClass = this.currentClass;
        this.currentClass = node.name;
        this.withTypeParameters(node.typeParameters, () => { for (const method of node.methods) this.classMethod(method, node, scope); });
        this.currentClass = previousClass;
        break;
      }
      case "EnumDeclaration": break;
      case "BlockStatement": {
        const child = new Scope(scope);
        // V22 PR#134: push borrow scope. Las declaraciones ref()/constRef()
        // dentro de este bloque se registran en el nuevo nivel y se limpian
        // al hacer pop (lexical end-of-block).
        this.borrowStack.push(new Map());
        for (const s of node.statements) this.statement(s, child);
        this.borrowStack.pop();
        break;
      }
      case "ExpressionStatement": this.expression(node.expression, scope); break;
      case "IfStatement": {
        const condType = this.expression(node.condition, scope);
        this.require(condType, "boolean", node.condition);
        // V1.4: detectar narrowing de tagged unions. Patrones reconocidos:
        //   if (expr.tag == lit) / === lit
        //   if (expr.tag != lit) / !== lit
        // `expr` debe ser `IdentifierExpression` con tipo union con
        // variantes que tengan discriminador declarado.
        const narrowInfo = this.parseNarrowingCondition(node.condition, scope);
        // V22: snapshot del estado `moved` antes de cada rama. Si ambas
        // ramas mueven la misma variable, queda `moved`. Si solo una, queda
        // `maybe-moved`. La implementación V1 conservadora hace un join
        // por intersección: si una rama no toca una variable, conserva el
        // estado previo (que podría ser `Available` o `moved`).
        const previousMoved = new Map(this.moved);
        if (narrowInfo) {
          const thenVariants = narrowInfo.discriminator
            ? this.variantsMatchingDiscriminator(narrowInfo.unionType, narrowInfo.discriminator)
            : undefined;
          const elseVariants = narrowInfo.discriminator && thenVariants
            ? this.variantsExcludingDiscriminator(narrowInfo.unionType, narrowInfo.discriminator)
            : undefined;
          const previousNarrowed = new Map(this.narrowed);
          if (thenVariants) this.narrowed.set(narrowInfo.name, { unionType: narrowInfo.unionType, discriminator: narrowInfo.discriminator, variants: thenVariants });
          const thenMoved = new Map(this.moved);
          this.statement(node.thenBranch, scope);
          const afterThen = new Map(this.moved);
          // Restauramos para que el `else` empiece desde el mismo snapshot.
          this.moved = thenMoved;
          this.narrowed = previousNarrowed;
          if (node.elseBranch) {
            const previousNarrowed2 = new Map(this.narrowed);
            if (elseVariants) this.narrowed.set(narrowInfo.name, { unionType: narrowInfo.unionType, discriminator: narrowInfo.discriminator, variants: elseVariants });
            this.statement(node.elseBranch, scope);
            // V22 join: una variable queda `moved` si está `moved` en
            // AMBAS ramas. Si está `moved` solo en una, queda `maybe-moved`.
            // Si está `maybe-moved` en una y `moved` en la otra, queda
            // `maybe-moved` (puede que no se haya movido).
            for (const [name, state] of this.moved) {
              const other = afterThen.get(name) ?? previousMoved.get(name);
              if (other === "moved" && state === "moved") this.moved.set(name, "moved");
              else if (other === "moved" || state === "moved") this.moved.set(name, "maybe-moved");
              else this.moved.set(name, state);
            }
            this.narrowed = previousNarrowed2;
          } else {
            // Sin else: si la rama `then` movió la variable, ahora es
            // `maybe-moved` (puede que no se haya ejecutado el then).
            for (const [name, state] of afterThen) {
              if (state === "moved" && !this.moved.has(name)) this.moved.set(name, "maybe-moved");
            }
          }
        } else {
          const thenMoved = new Map(this.moved);
          this.statement(node.thenBranch, scope);
          const afterThen = new Map(this.moved);
          this.moved = thenMoved;
          if (node.elseBranch) {
            this.statement(node.elseBranch, scope);
            for (const [name, state] of this.moved) {
              const other = afterThen.get(name) ?? previousMoved.get(name);
              if (other === "moved" && state === "moved") this.moved.set(name, "moved");
              else if (other === "moved" || state === "moved") this.moved.set(name, "maybe-moved");
              else this.moved.set(name, state);
            }
          } else {
            for (const [name, state] of afterThen) {
              if (state === "moved" && !this.moved.has(name)) this.moved.set(name, "maybe-moved");
            }
          }
        }
        break;
      }
      case "WhileStatement":
        this.require(this.expression(node.condition, scope), "boolean", node.condition);
        this.loopDepth++; this.statement(node.body, scope); this.loopDepth--; break;
      case "ForStatement": {
        const local = new Scope(scope);
        if (node.initializer) this.statement(node.initializer, local);
        if (node.condition) this.require(this.expression(node.condition, local), "boolean", node.condition);
        if (node.increment) this.expression(node.increment, local);
        this.loopDepth++; this.statement(node.body, local); this.loopDepth--; break;
      }
      case "BreakStatement": if (this.loopDepth === 0) this.report(node, "break solo es válido dentro de un bucle"); break;
      case "ContinueStatement": if (this.loopDepth === 0) this.report(node, "continue solo es válido dentro de un bucle"); break;
      case "ForOfStatement": {
        const iterableType = this.expression(node.iterable, scope);
        // Determina el tipo del elemento en función del iterable.
        let elementType: TypeName;
        if (isArrayType(iterableType)) elementType = arrayElement(iterableType);
        else if (isTupleType(iterableType)) elementType = iterableType;
        else if (iterableType === "string") elementType = "string";
        else if (isMapType(iterableType)) elementType = tupleType(genericArguments(iterableType));
        else if (isSetType(iterableType)) elementType = genericArguments(iterableType)[0] ?? "void";
        else { this.report(node.iterable, `El tipo '${iterableType}' no es iterable en for..of`); elementType = "void"; }
        // `for await (const x of arr)`: el elemento debe ser Promise<T> y el
        // binding tiene tipo T. Es la inversa de `Promise.all`-like pero
        // secuencial: `await` cada elemento.
        if (node.await) {
          if (!isPromiseType(elementType)) { this.report(node.iterable, `'for await' requiere un iterable de Promise<T>, no '${elementType}'`); }
          else elementType = promiseResult(elementType);
        }
        const local = new Scope(scope);
        if (!this.defineVariable(local, node.binding.name, elementType, node.binding.mutable)) this.report(node.binding, `Símbolo duplicado '${node.binding.name}'`);
        this.loopDepth++; this.statement(node.body, local); this.loopDepth--; break;
      }
      case "ForInStatement": {
        const targetType = this.expression(node.target, scope);
        // Determina el tipo de la clave/índice a partir del objetivo.
        let keyType: TypeName;
        if (isArrayType(targetType)) keyType = "number";
        else if (isMapType(targetType)) keyType = genericArguments(targetType)[0] ?? "void";
        else { this.report(node.target, `El tipo '${targetType}' no es iterable en for..in`); keyType = "void"; }
        const local = new Scope(scope);
        if (!this.defineVariable(local, node.binding.name, keyType, node.binding.mutable)) this.report(node.binding, `Símbolo duplicado '${node.binding.name}'`);
        this.loopDepth++; this.statement(node.body, local); this.loopDepth--; break;
      }
      case "DeleteStatement": {
        const objectType = this.expression(node.target.object, scope);
        if (!this.mutableTarget(node.target, scope)) this.report(node, "delete requiere un receptor mutable (no se puede borrar de una constante)");
        else this.markCapturedMutation(node.target, scope);
        if (isMapType(objectType)) {
          const keyType = genericArguments(objectType)[0] ?? "void";
          const actual = this.expression(node.target.index, scope, keyType);
          this.require(actual, keyType, node.target.index);
        } else if (isSetType(objectType)) {
          const valueType = genericArguments(objectType)[0] ?? "void";
          const actual = this.expression(node.target.index, scope, valueType);
          this.require(actual, valueType, node.target.index);
        } else if (isArrayType(objectType)) {
          this.require(this.expression(node.target.index, scope, "number"), "number", node.target.index);
        } else {
          this.expression(node.target.index, scope);
          this.report(node.target.object, `delete solo es válido sobre Map<K,V>, Set<T> o T[] (se obtuvo '${objectType}')`);
        }
        break;
      }
      case "ReturnStatement": {
        if (!this.currentReturn) this.report(node, "return solo es válido dentro de una función");
        const actual = node.value ? this.expression(node.value, scope, this.currentReturn) : "void";
        const flattenedAsyncReturn = this.currentAsync === true && isPromiseType(actual) && promiseResult(actual) === this.currentReturn;
        // V8.0: si el retorno es `Unq<T>` / `Rc<T>` y el valor es de tipo
        // `T` (la clase), допускаем como válido — el codegen envolverá con
        // `unSome<T>` / `rcShare<T>`. La inferencia es intraprocedural.
        const v8ImplicitWrap = node.value && this.currentReturn && isGenericType(this.currentReturn)
          && (genericBase(this.currentReturn) === "Unq" || genericBase(this.currentReturn) === "Rc")
          && this.classes.has(actual)
          && actual !== "void";
        // V22: si el retorno es `ptr<T>` o `constPtr<T>` y el valor es `T`
        // (por ejemplo `new T(...)` o un identificador de tipo T), aceptamos
        // — el codegen emite `std::make_unique<T>(...)` o convierte al
        // `std::unique_ptr<T>` correcto. La inferencia es intraprocedural
        // y solo aplica cuando el actual es exactamente T (la clase del
        // modifier, sin genéricos).
        const v22PtrImplicitWrap = node.value && this.currentReturn && isGenericType(this.currentReturn)
          && (genericBase(this.currentReturn) === "ptr" || genericBase(this.currentReturn) === "constPtr")
          && genericArguments(this.currentReturn)[0] === actual
          && this.classes.has(actual)
          && actual !== "void";
        if (this.currentReturn && !typeMatches(actual, this.currentReturn) && !flattenedAsyncReturn && !v8ImplicitWrap && !v22PtrImplicitWrap) this.report(node, `La función retorna ${this.currentReturn}, no ${actual}`);
        break;
      }
    }
  }

  private classMethod(method: ClassMethod, owner: ClassDeclaration, scope: Scope): void {
    this.withTypeParameters(method.typeParameters ?? [], () => {
      const local = new Scope(scope);
      const ownerType = owner.typeParameters.length ? genericType(owner.name, TypeChecker.namesOf(owner.typeParameters)) : owner.name;
      this.defineVariable(local, "this", ownerType, true);
      for (const parameter of method.params) if (!this.defineVariable(local, parameter.name, parameter.type, true, { mutableReference: this.parameterIsMutableReference(parameter.type) }, parameter)) this.report(parameter, `Parámetro duplicado '${parameter.name}'`);
      // V20: parameter properties. Si el parámetro del constructor tiene
      // modificador (acceso o readonly), también lo añadimos como campo
      // accesible en `this.x`. Lo hacemos después de los params para no
      // colisionar.
      if (method.name === "constructor") {
        for (const p of method.params) {
          if (p.access !== undefined || p.readonly === true) {
            // `this.x` debe estar disponible; no necesitamos definirlo en el
            // scope (accesos son `this.x` no `x`). Pero el campo debe ser
            // reconocido por el acceso a miembros.
          }
        }
      }
      // V22 (Memory Model v2): mismas reglas que para FunctionDeclaration
      // aplicadas a los métodos de clase.
      if (isGenericType(method.returnType) && (genericBase(method.returnType) === "ref" || genericBase(method.returnType) === "constRef")) {
        this.report(method, `E42xx: borrowed references cannot be returned yet. Returning ref<T> or constRef<T> requires lifetime analysis that is not supported by the current ownership model.`);
      }
      // V0.3: huella estructural resuelta del método.
      method.resolvedSignature = {
        parameters: method.params.map(p => ({
          name: p.name,
          type: toResolvedType(p.type) ?? { kind: "any" },
          optional: p.optional ?? false,
          variadic: p.variadic ?? false,
          hasDefault: p.defaultValue !== undefined,
        })),
        returnType: toResolvedType(method.returnType) ?? { kind: "any" },
        typeParameters: TypeChecker.namesOf(method.typeParameters ?? []),
        async: false,
      };
      const previous = this.currentReturn; const previousAsync = this.currentAsync; const previousCtor = this.inConstructor;
      // V19: registramos la clase/método actual para enforzar encapsulación.
      // Usamos el nombre del field `this.currentClass` de la closure padre
      // (este método está dentro de un classStatement).
      this.currentReturn = method.returnType; this.currentAsync = false; this.inConstructor = method.name === "constructor";
      this.currentMethod = method.name;
      this.statement(method.body, local);
      this.currentReturn = previous; this.currentAsync = previousAsync; this.inConstructor = previousCtor;
    });
  }

  private expression(node: Expression, scope: Scope, expected?: TypeName): TypeName {
    let result: TypeName = "void";
    switch (node.kind) {
      case "LiteralExpression": result = node.literalType; break;
      case "TemplateLiteralExpression": {
        // Las expresiones interpoladas se evalúan y se confía en `ets::concat`
        // (en C++) para convertirlas a texto. Cualquier tipo con `operator<<`
        // funciona; aquí solo necesitamos propagar los tipos para el análisis.
        for (const expr of node.expressions) this.expression(expr, scope);
        result = "string";
        break;
      }
      case "MatchExpression": {
        // Cada arm devuelve un valor; todos deben compartir tipo. El subject
        // y los patterns se evalúan para propagar tipos; el type-check de
        // pattern == subject se hace en codegen (runtime), no aquí.
        //
        // V2: cuando algún arm trae `variantMatch`, el subject debe ser una
        // tagged union y verificamos:
        //   - el kind declarado de cada arm corresponde a una variante real
        //   - los bindings se registran como variables locales antes de
        //     evaluar el resultado (path/message/etc. extraen el payload)
        //   - la suma de variantes cubiertas + un wildcard cubre TODAS
        //     las variantes declaradas (exhaustividad)
        const subjectType = this.expression(node.subject, scope);
        const subjectUnion = this.unions.get(genericBase(subjectType));
        const hasV2Arms = node.arms.some(arm => arm.variantMatch);
        if (hasV2Arms) {
          if (!subjectUnion) this.report(node, "El 'match' exhaustivo solo aplica a tagged unions; el sujeto no es ninguna unión declarada");
          else this.validateExhaustiveMatch(node, subjectUnion, scope);
        }
        let resultType: TypeName | undefined;
        for (const arm of node.arms) {
          const isWildcard = arm.pattern.kind === "IdentifierExpression" && arm.pattern.name === "_";
          // V2: el `pattern` es metadata (variantMatch), NO se evalúa como
          // expresión normal; solo se procesa via validateExhaustiveMatch.
          if (!arm.variantMatch && !isWildcard) this.expression(arm.pattern, scope, subjectType);
          // V2: registramos los bindings en un sub-scope antes de evaluar el
          // resultado, para que `case { kind: "NotFound", path }: path + ...`
          // vea `path` como variable local del arm.
          const armScope = scope;
          if (arm.variantMatch && !arm.variantMatch.isWildcard && subjectUnion) {
            const variant = subjectUnion.variants.find(v => v.name === arm.variantMatch!.variantName);
            const payloadType = variant?.payload;
            const local = new Scope(scope);
            arm.variantMatch.bindings.forEach((name, index) => {
              if (payloadType) this.defineVariable(local, name, payloadType, false);
            });
            // Re-evaluamos el resultado dentro del sub-scope.
            const armResultType = this.expression(arm.result, local, expected);
            if (!resultType && armResultType !== "void") resultType = armResultType;
            else if (resultType && !typeMatches(armResultType, resultType)) this.report(arm.result, `El arm devuelve '${armResultType}', se esperaba '${resultType}'`);
            continue;
          }
          const armResultType = this.expression(arm.result, armScope, expected);
          if (!resultType && armResultType !== "void") resultType = armResultType;
          else if (resultType && !typeMatches(armResultType, resultType)) this.report(arm.result, `El arm devuelve '${armResultType}', se esperaba '${resultType}'`);
        }
        result = resultType ?? "void";
        break;
      }
      case "SatisfiesExpression": {
        // `expr satisfies T`: type-check que expr sea asignable a T. Pasamos
        // el tipo declarado como `expected` para que `optionalSome(value)` y
        // helpers similares puedan propagar T desde el contexto.
        const operandType = this.expression(node.operand, scope, node.declaredType);
        if (!typeMatches(operandType, node.declaredType)) this.report(node, `Tipo '${operandType}' no satisface '${node.declaredType}'`);
        result = node.declaredType;
        break;
      }
      case "ArrayLiteralExpression": {
        if (expected && isArrayType(expected)) {
          const element = arrayElement(expected);
          for (const item of node.elements) {
            if (item.kind === "SpreadElement") {
              // Para un spread, el tipo del operando debe ser compatible con el
              // `element` (otro vector del mismo tipo, una tupla del mismo tipo, o el propio `element`).
              const actual = this.expression(item.expression, scope);
              if (actual === element || actual === `${element}[]` || isTupleType(actual)) {
                // ok
              } else this.report(item, `Spread: se esperaba vector de ${element}, se obtuvo ${actual}`);
            } else this.require(this.expression(item, scope, element), element, item);
          }
          result = expected;
        } else if (expected && isFixedArrayType(expected)) {
          // V4: arrays de tamaño fijo. Validamos el número de elementos y el
          // tipo de cada uno. El `expected` se pasa a cada item para que el
          // type-checker propague conversiones (p.ej. `let buf: u8[3] = [1,2,3];`
          // donde los literales son `number` y se castean a `u8`).
          const fixedElement = fixedArrayElement(expected)!;
          const fixedSize = fixedArraySize(expected)!;
          if (node.elements.length !== fixedSize) {
            this.report(node, `El array fijo espera ${fixedSize} elementos, recibió ${node.elements.length}`);
            result = expected;
            break;
          }
          for (const item of node.elements) {
            if (item.kind === "SpreadElement") this.report(item, "Spread no se admite en arrays fijos (tamaño estático)");
            else this.require(this.expression(item, scope, fixedElement), fixedElement, item);
          }
          result = expected;
        } else if (expected && isTupleType(expected)) {
          const items = tupleElements(expected);
          if (items.length !== node.elements.length) this.report(node, `La tupla espera ${items.length} elementos, recibió ${node.elements.length}`);
          node.elements.forEach((item, index) => {
            if (item.kind === "SpreadElement") this.report(item, "Spread no se admite en tuplas (tamaño fijo)");
            else { const itemType = items[index]; const actual = this.expression(item, scope, itemType); if (itemType) this.require(actual, itemType, item); }
          });
          result = expected;
        } else {
          const items = node.elements.map(item => {
            if (item.kind === "SpreadElement") return this.expression(item.expression, scope);
            return this.expression(item, scope);
          });
          if (!items.length) { this.report(node, "Un array vacío necesita una anotación de tipo"); result = "void[]"; }
          else result = items.every(item => item === items[0]) ? arrayType(items[0]) : tupleType(items);
        }
        break;
      }
      case "ObjectLiteralExpression": {
        // V1.4: object literal como constructor inline de object-variant.
        // El primer property debe ser el discriminador (literal primitivo);
        // los demás son bindings del payload. Necesitamos `expected` apuntando
        // a la unión declarada para resolver la variante.
        if (!expected || !this.unions.has(genericBase(expected))) {
          this.report(node, "El object literal solo se admite como constructor de una object-variant; el contexto no provee una unión esperada");
          result = "void";
          break;
        }
        const unionType = genericBase(expected);
        const unionNode = this.unions.get(unionType)!;
        if (node.properties.length === 0) {
          this.report(node, "El object literal debe tener al menos el discriminador");
          result = expected;
          break;
        }
        const discProp = node.properties[0];
        if (discProp.value.kind !== "LiteralExpression") {
          this.report(discProp.value, "El primer campo de un object literal debe ser el discriminador (literal primitivo)");
          result = expected;
          break;
        }
        const discValue = discProp.value.value;
        // Buscar la variante cuyo discriminador coincide con `discProp.key = discValue`.
        const variant = unionNode.variants.find(v => v.discriminator && v.discriminator.field === discProp.key && v.discriminator.value === discValue);
        if (!variant) {
          this.report(discProp.value, `'${unionType}' no tiene variante con discriminador ${discProp.key} = ${JSON.stringify(discValue)}`);
          result = expected;
          break;
        }
        // Validar el resto de propiedades como bindings del payload.
        // El payload de la variante es `T` (si un solo binding) o `tupleType([...])` (varios).
        // Para object-variants, el payload es `T` (un solo binding) o `void` (sin bindings).
        const bindings = node.properties.slice(1);
        if (variant.payload === "void" || !variant.payload) {
          if (bindings.length > 0) this.report(node, `La variante '${variant.name}' no espera bindings`);
        } else if (bindings.length === 1 && !isTupleType(variant.payload)) {
          const bindingValue = bindings[0].value;
          this.require(this.expression(bindingValue, scope, variant.payload), variant.payload, bindingValue);
        } else {
          // Tupla de tipos — debe coincidir con bindings.length.
          const tupleItems = tupleElements(variant.payload);
          if (tupleItems.length !== bindings.length) this.report(node, `La variante '${variant.name}' espera ${tupleItems.length} bindings, recibió ${bindings.length}`);
          else bindings.forEach((b, i) => this.require(this.expression(b.value, scope, tupleItems[i]), tupleItems[i], b.value));
        }
        result = expected;
        break;
      }
      case "ArrowFunctionExpression": {
        if (node.params.some(parameter => parameter.passing === "mut")) this.report(node, "Los parámetros mut en closures necesitan un tipo de función con efectos; use una función declarada");
        const expectedParameters = expected && isFunctionType(expected) ? functionParameters(expected) : undefined;
        const expectedResult = expected && isFunctionType(expected) ? functionResult(expected) : undefined;
        if (expectedParameters && expectedParameters.length !== node.params.length) this.report(node, `La closure espera ${expectedParameters.length} parámetros, recibió ${node.params.length}`);
        const local = new Scope(scope);
        node.params.forEach((parameter, index) => {
          this.validateType(parameter.type, parameter, false, false, local);
          if (expectedParameters?.[index]) this.require(parameter.type, expectedParameters[index], parameter);
          if (!this.defineVariable(local, parameter.name, parameter.type, false, {}, parameter)) this.report(parameter, `Parámetro duplicado '${parameter.name}'`);
        });
        const declaredResult = node.returnType ?? expectedResult;
        let resultType: TypeName;
        const previousAsync = this.currentAsync; this.currentAsync = false;
        const previousClosure = this.currentClosure; this.currentClosure = { node, parentScope: scope };
        node.mutatesCapturedState = false;
        // V10: detectar nombres capturados del scope padre. Recorremos el
        // cuerpo y anotamos los `IdentifierExpression` que NO estén en el
        // scope local. Esto habilita al codegen a saber qué variables
        // externas toca el lambda (útil para captura explícita en C++).
        const captured = new Set<string>();
        const collectCaptured = (target: import("../ast/nodes.ts").Expression | import("../ast/nodes.ts").Statement): void => {
          if (!target || typeof target !== "object") return;
          const t = target as { kind?: string; name?: string; object?: unknown; left?: unknown; right?: unknown; body?: unknown; operand?: unknown; args?: unknown[]; statements?: unknown[]; initializer?: unknown; elements?: unknown[]; params?: unknown[]; members?: unknown[]; cases?: unknown[]; fields?: unknown[]; methods?: unknown[]; condition?: unknown; thenBranch?: unknown; elseBranch?: unknown; subject?: unknown; arms?: unknown[]; expression?: unknown; target?: unknown; value?: unknown; iterable?: unknown; binding?: unknown; declarations?: unknown[]; declaration?: unknown };
          if (t.kind === "IdentifierExpression" && typeof t.name === "string" && !local.resolveLocal(t.name) && !node.params.some(p => p.name === t.name)) captured.add(t.name);
          for (const key of Object.keys(t)) {
            const child = (t as Record<string, unknown>)[key];
            if (Array.isArray(child)) { for (const item of child) if (item && typeof item === "object") collectCaptured(item as import("../ast/nodes.ts").Expression); }
            else if (child && typeof child === "object") collectCaptured(child as import("../ast/nodes.ts").Expression);
          }
        };
        collectCaptured(node.body);
        // V10.1: filtrar capturas que sean top-level (accesibles directamente
        // desde cualquier lambda sin necesidad de captura explícita en C++,
        // porque el codegen las declara como `static`/globales). Solo nos
        // interesan las variables que viven en un scope intermedio y que
        // realmente requieren captura en C++.
        const rootScope = scope.root();
        const isGlobalSymbol = (name: string): boolean => !!rootScope.resolveLocal(name);
        const capturedList = Array.from(captured).filter(name => !isGlobalSymbol(name));
        node.capturedSymbols = capturedList;
        // V22 PR#7: E4209 - closure que captura una variable ref<T>/constRef<T>.
        // Una closure no puede "escapar" con un borrow porque el borrow
        // esta atado al scope local del caller. Por ahora, TODA captura de
        // ref<T>/constRef<T> en una closure reporta E4209 (conservador;
        // escape analysis vendra en una fase posterior).
        for (const capturedName of capturedList) {
          const symbol = scope.resolve(capturedName);
          if (symbol && symbol.kind === "variable" && isGenericType(symbol.type)
              && (genericBase(symbol.type) === "ref" || genericBase(symbol.type) === "constRef")) {
            this.report(node, `E4209: closure captures borrowed reference '${capturedName}' (${symbol.type}). Borrowed references cannot escape their scope via closures. Pass the value explicitly as a closure parameter.`);
          }
        }
        if (node.body.kind === "BlockStatement") {
          if (!declaredResult) this.report(node, "Una función flecha con bloque necesita tipo de retorno");
          const previous = this.currentReturn; this.currentReturn = declaredResult ?? "void";
          this.statement(node.body, local); this.currentReturn = previous;
          resultType = declaredResult ?? "void";
        } else {
          const actual = this.expression(node.body, local, declaredResult);
          if (declaredResult) this.require(actual, declaredResult, node.body);
          resultType = declaredResult ?? actual;
        }
        this.currentClosure = previousClosure; this.currentAsync = previousAsync;
        if (node.returnType) this.validateType(node.returnType, node, false, false, local);
        result = functionType(node.params.map(parameter => parameter.type), resultType);
        break;
      }
      case "IdentifierExpression": {
        // Los enums se referencian por nombre (`Color.Green`); permitimos el identificador
        // desnudo como valor y devolvemos el nombre del enum como tipo de la expresión.
        // Comprobamos esto ANTES del scope porque `Color` está registrado como
        // TypeSymbol (no como variable), y sin este atajo el type-checker diría
        // que `Color` no es un valor.
        if (this.enums.has(node.name)) { result = node.name; break; }
        // V1.2: las uniones también son espacios de nombres para sus variantes.
        // `Outcome.Ok(...)` se trata como llamada válida aunque `Outcome` esté
        // registrado como TypeSymbol. El tipo de la expresión es la unión misma.
        if (this.unions.has(node.name)) { result = node.name; break; }
        // Luego buscamos en el scope: una declaración local (variable,
        // parámetro) debe ganar sobre el tipo builtin del mismo nombre. Esto
        // permite `const path: string = argument(1); path + ".ext"` sin que
        // el type-checker reclame "Path" donde se espera "string".
        const symbol = scope.resolve(node.name);
        if (symbol) {
          if (symbol.kind !== "variable") this.report(node, `'${node.name}' es un símbolo de tipo o función, no un valor`);
          else {
            // V22 (Memory Model v2): si la variable fue movida con move(x),
            // cualquier lectura posterior es diagnóstico E4102 o E4103.
            if (this.moved.has(node.name)) {
              const state = this.moved.get(node.name);
              this.report(node, `E410${state === "moved" ? "2" : "3"}: use of ${state} value '${node.name}'`);
            }
            result = this.expandType(symbol.type); if (symbol.variadic) this.variadicExpressions.add(node);
          }
          break;
        }
        if (node.name === "console") { result = "Console"; break; }
        if (node.name === "fs") { result = "Filesystem"; break; }
        if (node.name === "path") { result = "Path"; break; }
        if (node.name === "process") { result = "Process"; break; }
        if (node.name === "JSON") { result = "Json"; break; }
        if (node.name === "Math") { result = "Math"; break; }
        if (node.name === "Date") { result = "Date"; break; }
        this.report(node, `Símbolo no definido '${node.name}'`, this.suggestSimilar(node.name, scope.names()));
        break;
      }
      case "GenericIdentifierExpression": {
        // V1.2: `Name<T1, T2>` antes de un member access. Devolvemos el
        // tipo genérico instanciado para que `typeMatches` lo compare
        // correctamente con el esperado.
        result = genericType(node.name, node.typeArguments);
        break;
      }
      case "UnaryExpression": {
        if (node.operator === "typeof") {
          // `typeof` acepta cualquier operando (incluido `void`) y siempre
          // produce un literal `string` en C++. Se type-checkea el operando
          // para validar referencias, pero el resultado se descarta.
          this.expression(node.operand, scope);
          result = "string";
          break;
        }
        const operand = this.expression(node.operand, scope);
        const expected = node.operator === "!" ? "boolean" : "number";
        this.require(operand, expected, node.operand); result = expected; break;
      }
      case "AwaitExpression": {
        if (this.currentAsync === false) this.report(node, "await solo es válido dentro de una función async o en el nivel superior");
        const operand = this.expression(node.operand, scope);
        if (!isPromiseType(operand)) this.report(node.operand, `await requiere Promise<T>, no '${operand}'`);
        // V22 PR#8: E4210 - cualquier borrow activo (ref<T>/constRef<T>)
        // que sobreviva a un await es potencialmente dangling. Reportamos
        // el error en el momento del await (no en la declaracion) para no
        // quejarnos de borrows que solo viven despues del await.
        for (const frame of this.borrowStack) {
          for (const [sourceName, mode] of frame.entries()) {
            this.report(node, `E4210: borrowed reference '${sourceName}' (${mode}) cannot cross an await point in an async function. Move ownership into the function (ptr<T>) or refactor to avoid the await.`);
          }
        }
        result = promiseResult(operand);
        break;
      }
      case "BinaryExpression": {
        const left = this.expression(node.left, scope);
        if (node.operator === "instanceof") {
          // El parser mete el tipo del lado derecho en un `IdentifierExpression`
          // sintético (porque `string`/`number`/`boolean` no son identificadores
          // para el lexer). Extraemos el nombre directamente y lo usamos como
          // tipo. Validamos sin invocar `expression()` para no fallar al
          // resolver el identificador contra el scope.
          const right = node.right.kind === "IdentifierExpression" ? node.right.name : "void";
          if (isUnionType(left)) {
            const members = unionMembers(left);
            if (!members.includes(right)) this.report(node.right, `instanceof: '${right}' no es miembro de la unión '${left}'`);
          } else if (!this.classes.has(right) && right !== "string" && right !== "number" && right !== "boolean") {
            this.report(node.right, `instanceof: '${right}' no es una clase ni un tipo primitivo`);
          }
          result = "boolean";
          break;
        }
        const right = this.expression(node.right, scope);
        if (node.operator === "+" && left === "string" && right === "string") result = "string";
        else if (node.operator === "??") {
          // `??` (nullish coalescing) sobre `Optional<T>`. El operando izquierdo
          // debe ser `Optional<T>` y el derecho debe ser de tipo `T` (el
          // default). Resultado: `T`.
          if (!isGenericType(left) || genericBase(left) !== "Optional") {
            this.report(node.left, `El operador '??' requiere un Optional<T> a la izquierda, se obtuvo '${left}'`);
          } else {
            const element = genericArguments(left)[0] ?? "void";
            this.require(right, element, node.right);
            result = element;
          }
        }
        else if (["+", "-", "*", "/", "%"].includes(node.operator)) { this.requireNumericOperand(left, node.left); this.requireNumericOperand(right, node.right); result = "number"; }
        else if (["|", "&", "^", "<<", ">>"].includes(node.operator)) { this.requireNumericOperand(left, node.left); this.requireNumericOperand(right, node.right); result = "number"; }
        else if (["<", "<=", ">", ">="].includes(node.operator)) { this.requireNumericOperand(left, node.left); this.requireNumericOperand(right, node.right); result = "boolean"; }
        else if (["==", "!="].includes(node.operator)) { if (!this.sameNumericFamily(left, right)) this.report(node, "Los operandos comparados deben tener el mismo tipo"); result = "boolean"; }
        else { this.require(left, "boolean", node.left); this.require(right, "boolean", node.right); result = "boolean"; }
        break;
      }
      case "CallExpression": {
        // V3: `i32(x)`, `u64(y)`, `f32(z)`, etc. son casts a tipos numéricos
        // concretos (10 primitivos). El parser los desazucara como
        // CallExpression con callee=identifier; aquí reconocemos ese patrón y
        // emitimos el tipo destino. La validación de rango del argumento
        // ocurre si el argumento es un literal (idem VariableDeclaration).
        if (isNumericType(node.callee) && node.typeArguments.length === 0) {
          if (node.args.length !== 1) this.report(node, `'${node.callee}' espera 1 argumento, recibió ${node.args.length}`);
          const arg = node.args[0];
          if (arg) {
            const expected = node.callee;
            const actual = this.expression(arg, scope, expected);
            this.require(actual, expected, arg);
            // Validación de rango si el argumento es un literal numérico
            // (con o sin signo unario). Mismas reglas que en VariableDeclaration.
            this.validateNumericExpression(arg, expected);
          }
          result = node.callee;
          break;
        }
        if (ASYNC_PRIMITIVE_HELPERS[node.callee]) {
          const signature = ASYNC_PRIMITIVE_HELPERS[node.callee];
          if (node.args.length !== signature.params.length) this.report(node, `'${node.callee}' espera ${signature.params.length} argumentos, recibió ${node.args.length}`);
          node.args.forEach((arg, index) => { const expectedType = signature.params[index]; const actual = this.expression(arg, scope, expectedType); if (expectedType) this.require(actual, expectedType, arg); });
          result = signature.returnType; break;
        }
        if (FILE_HELPERS[node.callee]) {
          const helper = FILE_HELPERS[node.callee];
          if (node.args.length < helper.minParams) this.report(node, `'${node.callee}' espera al menos ${helper.minParams} argumentos, recibió ${node.args.length}`);
          if (helper.paramTypes) node.args.forEach((arg, index) => { if (helper.paramTypes![index]) this.require(this.expression(arg, scope, helper.paramTypes![index]), helper.paramTypes![index], arg); });
          else node.args.forEach(arg => this.expression(arg, scope));
          result = helper.returnType; break;
        }
        if (NET_HELPERS[node.callee]) {
          const helper = NET_HELPERS[node.callee];
          if (node.args.length < helper.minParams) this.report(node, `'${node.callee}' espera al menos ${helper.minParams} argumentos, recibió ${node.args.length}`);
          if (helper.paramTypes) node.args.forEach((arg, index) => { if (helper.paramTypes![index]) this.require(this.expression(arg, scope, helper.paramTypes![index]), helper.paramTypes![index], arg); });
          else node.args.forEach(arg => this.expression(arg, scope));
          result = helper.returnType; break;
        }
        if (ASYNC_HELPERS[node.callee]) {
          const helper = ASYNC_HELPERS[node.callee];
          if (node.args.length !== 1) this.report(node, `'${node.callee}' espera 1 argumento, recibió ${node.args.length}`);
          const argType = node.args[0] ? this.expression(node.args[0], scope) : "void";
          if (!isArrayType(argType) || !isGenericType(arrayElement(argType)) || genericBase(arrayElement(argType)) !== "Promise") {
            this.report(node.args[0] ?? node, `'${node.callee}' requiere un array de Promise<T> (Task<T>[])`);
            result = "void"; break;
          }
          const elementType = genericArguments(arrayElement(argType))[0] ?? "unknown";
          if (helper.returnsArray) result = arrayType(elementType);
          else result = elementType;
          break;
        }
        // V22 (Memory Model v2): `ref(x)` transfiere ownership de un ptr<T>.
                // El argumento debe ser un identificador declarado como `ptr<T>` o
                // `constPtr<T>`. Marcamos la variable como `moved` para que cualquier
                // uso posterior sea diagnóstico E4102/E4103.
                if (node.callee === "move" && node.args.length === 1) {
                  const innerExpr = node.args[0];
                  if (innerExpr.kind === "IdentifierExpression") {
                    const symbol = scope.resolve(innerExpr.name);
                    if (!symbol || symbol.kind !== "variable") this.report(innerExpr, `move: símbolo no definido '${innerExpr.name}'`);
                    else if (!isGenericType(symbol.type) || (genericBase(symbol.type) !== "ptr" && genericBase(symbol.type) !== "constPtr")) {
                      this.report(innerExpr, `E4100: copy of non-move-only value '${innerExpr.name}'. move(x) is only valid on ptr<T> or constPtr<T>.`);
                    } else {
                      this.expression(innerExpr, scope, symbol.type);
                      this.moved.set(innerExpr.name, "moved");
                      result = symbol.type;
                    }
                  } else {
                    this.report(innerExpr, `E4101: ownership transfer requires move(identifier). Direct move of a temporary is not supported.`);
                    result = this.expression(innerExpr, scope);
                  }
                  break;
                }
                // V22 (Memory Model v2): `ref(x)` y `constRef(x)` crean un borrow de
                // un lvalue. El argumento debe ser un lvalue (IdentifierExpression,
                // MemberExpression, IndexExpression). El tipo retornado es `ref<T>`
                // o `constRef<T>` donde T es el tipo del lvalue. Si el expected
                // contextual es `ref<T>`/`constRef<T>`, lo usamos para inferir T.
                if ((node.callee === "ref" || node.callee === "constRef") && node.args.length === 1) {
                  const innerExpr = node.args[0];
                  // Validar que es un lvalue.
                  if (innerExpr.kind !== "IdentifierExpression"
                      && innerExpr.kind !== "MemberExpression"
                      && innerExpr.kind !== "IndexExpression") {
                    this.report(innerExpr, `E4208: ${node.callee}(x) requires an lvalue (variable, member access, or index). Got ${innerExpr.kind}.`);
                    result = "void";
                    break;
                  }
                  // Inferir T del expected contextual o del tipo del lvalue.
                  let innerType: TypeName;
                  if (expected && isGenericType(expected)
                      && (genericBase(expected) === "ref" || genericBase(expected) === "constRef")) {
                    innerType = genericArguments(expected)[0] ?? this.expression(innerExpr, scope);
                  } else {
                    innerType = this.expression(innerExpr, scope);
                  }
                  // Validar que el tipo del lvalue coincide con T (si lo tenemos).
                  if (expected && isGenericType(expected)
                      && (genericBase(expected) === "ref" || genericBase(expected) === "constRef")) {
                    const expectedInner = genericArguments(expected)[0];
                    if (expectedInner && innerType !== expectedInner) {
                      // OK en algunos casos (subtipado), no error por ahora.
                    }
                  }
                  result = node.callee === "ref" ? genericType("ref", [innerType]) : genericType("constRef", [innerType]);
                  break;
                }
        // V23: `match(value, [...])` o `match(value, "discriminator", [...])`.
        // El primer argumento es el subject. El segundo (sin discriminator) es
        // el array de cases. Con discriminator, args[1] es la clave string y
        // args[2] es el array de cases.
        if (node.callee === "match" && (node.args.length === 2 || node.args.length === 3)) {
          const subject = node.args[0];
          const subjectType = this.expression(subject, scope);
          // Determinar dónde está el array de cases.
          let caseList: Expression;
          if (node.args.length === 3) {
            const discArg = node.args[1];
            const casesArg = node.args[2];
            if (discArg.kind !== "LiteralExpression" || discArg.literalType !== "string") {
              this.report(discArg, `E4403: 'match' with 3 arguments expects a string discriminator as the second argument, got ${discArg.kind}`);
              result = "void";
              break;
            }
            node.matchedDiscriminator = discArg.value as string;
            this.expression(discArg, scope, "string");
            caseList = casesArg;
          } else {
            caseList = node.args[1];
          }
          if (caseList.kind !== "ArrayLiteralExpression") {
            this.report(caseList, `E4402: 'match' expects an array of cases as ${node.args.length === 3 ? "third" : "second"} argument, got ${caseList.kind}`);
            result = "void";
            break;
          }
          // Validamos cada elemento del array.
          const returnTypes: TypeName[] = [];
          let hasOtherwise = false;
          for (const element of caseList.elements) {
            if (element.kind !== "SpreadElement" && (element as any).kind === "CallExpression" && (element as any).callee === "when") {
              const caseCall = element as any;
              if (caseCall.args.length !== 2) {
                this.report(caseCall, `E4404: 'when' expects 2 arguments (pattern, callback), got ${caseCall.args.length}`);
                continue;
              }
              const [pattern, callback] = caseCall.args;
              // Pattern se valida contra el subject type.
              this.expression(pattern, scope, subjectType);
              // Callback puede tener 0 o 1 params (0 si no usa el subject, 1 si sí).
              if (callback.params.length > 1) {
                this.report(callback, `E4406: 'when' callback must have at most 1 parameter, got ${callback.params.length}`);
                continue;
              }
              const _unused = this.expression(callback, scope);
              // V23: el checker sobre una ArrowFunctionExpression devuelve el tipo
              // function (`(T) => R`), no el `R` del body. Para el resultado del
              // match queremos el `R` real. Si el lambda tiene returnType declarado
              // lo usamos; si no, inferimos del body.
              let callbackReturnType: TypeName;
              if (callback.returnType) {
                callbackReturnType = callback.returnType;
              } else if (callback.body.kind !== "BlockStatement") {
                callbackReturnType = this.expression(callback.body, scope);
              } else {
                callbackReturnType = "void";
              }
              returnTypes.push(callbackReturnType);
            } else if (element.kind !== "SpreadElement" && (element as any).kind === "CallExpression" && (element as any).callee === "whenType") {
              const caseCall = element as any;
              if (caseCall.args.length !== 1) {
                this.report(caseCall, `E4404: 'whenType' expects 1 argument (callback), got ${caseCall.args.length}`);
                continue;
              }
              const callback = caseCall.args[0];
              if (callback.kind !== "ArrowFunctionExpression") {
                this.report(callback, `E4405: 'whenType' callback must be an arrow function`);
                continue;
              }
              if (callback.params.length > 1) {
                this.report(callback, `E4406: 'whenType' callback must have exactly 1 parameter`);
                continue;
              }
              // El tipo T viene de los typeArguments del whenType<T>.
              if (caseCall.typeArguments.length !== 1) {
                this.report(caseCall, `E4407: 'whenType<T>' requires exactly 1 type argument, got ${caseCall.typeArguments.length}`);
                continue;
              }
              this.expression(callback, scope);
              let callbackReturnType: TypeName;
              if (callback.returnType) callbackReturnType = callback.returnType;
              else if (callback.body.kind !== "BlockStatement") callbackReturnType = this.expression(callback.body, scope);
              else callbackReturnType = "void";
              returnTypes.push(callbackReturnType);
            } else if (element.kind !== "SpreadElement" && (element as any).kind === "CallExpression" && (element as any).callee === "otherwise") {
              const caseCall = element as any;
              if (caseCall.args.length !== 1) {
                this.report(caseCall, `E4404: 'otherwise' expects 1 argument (callback), got ${caseCall.args.length}`);
                continue;
              }
              hasOtherwise = true;
              const callback = caseCall.args[0];
              if (callback.kind !== "ArrowFunctionExpression") {
                this.report(callback, `E4405: 'otherwise' callback must be an arrow function`);
                continue;
              }
              // `otherwise` callback may have 0 or 1 params.
              if (callback.params.length > 1) {
                this.report(callback, `E4406: 'otherwise' callback must have at most 1 parameter, got ${callback.params.length}`);
                continue;
              }
              const _unused = this.expression(callback, scope);
              // V23: el checker sobre una ArrowFunctionExpression devuelve el tipo
              // function (`(T) => R`), no el `R` del body. Para el resultado del
              // match queremos el `R` real. Si el lambda tiene returnType declarado
              // lo usamos; si no, inferimos del body.
              let callbackReturnType: TypeName;
              if (callback.returnType) {
                callbackReturnType = callback.returnType;
              } else if (callback.body.kind !== "BlockStatement") {
                callbackReturnType = this.expression(callback.body, scope);
              } else {
                callbackReturnType = "void";
              }
              returnTypes.push(callbackReturnType);
            } else if (element.kind === "SpreadElement") {
              this.report(element, `E4408: 'match' cases cannot use spread elements`);
            } else {
              this.report(element, `E4409: 'match' cases must be calls to 'when', 'whenType' or 'otherwise', got ${(element as any).kind}`);
            }
          }
          // Calculamos el tipo del resultado: unión de los retornos.
          node.matchedKind = "match";
          if (returnTypes.length > 0) {
            // Simplificación: si todos los retornos son el mismo tipo, usar ese.
            // Si hay variación, usamos union. Para V1, usamos el primer tipo si todos
            // son iguales; si no, usamos un unionType genérico.
            const first = returnTypes[0];
            const allSame = returnTypes.every(t => t === first);
            if (allSame) result = first;
            else {
              // Para V1: union pipe-delimited ("A|B|C"). Deduplicamos.
              const unique = Array.from(new Set(returnTypes));
              result = unique.join("|") as TypeName;
            }
            node.matchedResultType = result;
          } else {
            result = "void";
            node.matchedResultType = "void";
          }
          // Si no hay otherwise y el subject es union, advertencia: puede no matchear.
          if (!hasOtherwise) {
            // V1: no enforce exhaustividad para la nueva forma. Solo informativo.
            // (El V2 keyword sí enforce exhaustividad con `validateExhaustiveMatch`.)
          }
          break;
        }
        // V23: `when(...)` / `whenType(...)` / `otherwise(...)` SUELTOS (fuera de un `match`).
        // El checker deja pasar la validación normal (los trata como CallExpression)
        // pero reporta un warning si aparecen sin estar dentro de un match.
        // Para V1, lo dejamos pasar sin warning — el codegen emitirá la llamada
        // normal y el linker fallará. Si quieres warning estricto, podemos añadirlo.
        // Por ahora solo validamos que coincidan con el metadata:
        if (node.callee === "when" || node.callee === "whenType" || node.callee === "otherwise") {
          const meta = HELPER_METADATA[node.callee];
          if (meta && node.args.length < meta.minParams) {
            this.report(node, `'${node.callee}' expects at least ${meta.minParams} argument(s), got ${node.args.length}`);
          }
          // No marcamos matchedKind: serán tratados como CallExpression normal.
          // El codegen + linker fallarán en runtime si están fuera de match().
        }
        if (OPTIONAL_HELPERS[node.callee]) {
          const helper = OPTIONAL_HELPERS[node.callee];
          if (node.args.length < helper.minParams) this.report(node, `'${node.callee}' espera al menos ${helper.minParams} argumentos`);
          // Inferimos T a partir del `expected` contextual. Por ejemplo,
          // `const x: Optional<number> = optionalSome(5)` propaga `number` como
          // tipo esperado del argumento, lo que hace que `5` se type-checkee
          // contra `number`.
          const expectedElement = expected && isGenericType(expected) && genericBase(expected) === "Optional" ? genericArguments(expected)[0] : undefined;
          if (helper.returnsGeneric && expectedElement) {
            // Helper que devuelve Optional<T>: tipamos cada argumento con T.
            if (node.callee === "optionalNone") result = genericType("Optional", [expectedElement]);
            else if (node.callee === "optionalSome" && node.args[0]) { this.require(this.expression(node.args[0], scope, expectedElement), expectedElement, node.args[0]); result = genericType("Optional", [expectedElement]); }
            else if (node.callee === "optionalOrElse") {
              node.args.forEach(arg => this.expression(arg, scope));
              result = genericType("Optional", [expectedElement]);
            }
          } else if (!helper.returnsGeneric) {
            // Helpers que devuelven primitivos.
            node.args.forEach((arg, index) => {
              if (index === 0 && expectedElement) this.require(this.expression(arg, scope, genericType("Optional", [expectedElement])), genericType("Optional", [expectedElement]), arg);
              else this.expression(arg, scope);
            });
            if (node.callee === "optionalIsPresent") result = "boolean";
            else if (node.callee === "optionalValueOr") result = expectedElement ?? "void";
          }
          // `optionalMap` y `optionalAndThen` se manejan SIEMPRE (con o sin
          // expected contextual) porque pueden inferir el tipo por sí solos.
          if (node.callee === "optionalMap") {
            const arg0Type = node.args[0] ? this.expression(node.args[0], scope) : "void";
            const arg1Type = node.args[1] ? this.expression(node.args[1], scope) : "void";
            if (!isGenericType(arg0Type) || genericBase(arg0Type) !== "Optional") {
              this.report(node.args[0], `optionalMap: primer argumento debe ser Optional<T>, se obtuvo '${arg0Type}'`);
              result = "void";
            } else if (!isFunctionType(arg1Type)) {
              this.report(node.args[1], `optionalMap: segundo argumento debe ser una función T → U`);
              result = "void";
            } else {
              result = genericType("Optional", [functionResult(arg1Type)]);
            }
            break;
          }
          if (node.callee === "optionalAndThen") {
            const arg1Type = node.args[1] ? this.expression(node.args[1], scope) : "void";
            if (isFunctionType(arg1Type)) {
              const lambdaReturn = functionResult(arg1Type);
              if (node.args[0]) this.expression(node.args[0], scope, lambdaReturn);
              result = lambdaReturn;
            } else {
              if (node.args[0]) this.expression(node.args[0], scope);
              this.report(node.args[1], `optionalAndThen: segundo argumento debe ser una función T → Optional<U>`);
              result = "void";
            }
            break;
          }
          if (result === undefined) { result = "void"; node.args.forEach(arg => this.expression(arg, scope)); }
          break;
        }
        // Helpers de smart pointers (Issue #3): Un<T>, Rc<T>, MutRef<T>, Mut<T>.
        // Patrón idéntico a OPTIONAL_HELPERS pero con detección del base genérico
        // correspondiente. Los 4 helpers `unSome`, `unNone`, `rcShare` esperan un
        // `expected` contextual (e.g. `const x: Un<Counter> = unSome(...)`) para
        // inferir T.
        if (UN_HELPERS[node.callee] || RC_HELPERS[node.callee] || REF_HELPERS[node.callee]) {
          const isMutRef = node.callee === "mutRefOf" || node.callee === "mutRefFrom" || node.callee === "mutRefValue";
          const smartBase = UN_HELPERS[node.callee] ? "Unq" : RC_HELPERS[node.callee] ? "Rc" : isMutRef ? "MutRef" : "Mut";
          // Para constructores (unSome, unNone, rcShare, mutRefOf, etc.) usamos
          // el `expected` contextual. Para inspectors (unIsSome, unValue,
          // rcStrongCount, rcValue) inferimos desde el tipo del primer argumento.
          const isInspector = node.callee === "unIsSome" || node.callee === "unValue" || node.callee === "rcStrongCount" || node.callee === "rcValue" || node.callee === "mutRefValue" || node.callee === "mutValue" || node.callee === "mutIsSome";
          let expectedElement: TypeName | undefined;
          if (isInspector && node.args[0]) {
            const arg0Type = this.expression(node.args[0], scope);
            expectedElement = isGenericType(arg0Type) && genericBase(arg0Type) === smartBase ? genericArguments(arg0Type)[0] : undefined;
            if (!expectedElement) this.report(node, `'${node.callee}' espera ${smartBase}<T>, se obtuvo '${arg0Type}'`);
          } else {
            expectedElement = expected && isGenericType(expected) && genericBase(expected) === smartBase ? genericArguments(expected)[0] : undefined;
          }
          if (expectedElement) {
            if (node.callee === "unSome" && node.args[0]) { this.require(this.expression(node.args[0], scope, expectedElement), expectedElement, node.args[0]); result = genericType("Unq", [expectedElement]); }
            else if (node.callee === "unNone") result = genericType("Unq", [expectedElement]);
            else if (node.callee === "unIsSome") { result = "boolean"; }
            else if (node.callee === "unValue") { result = expectedElement; }
            else if (node.callee === "rcShare" && node.args[0]) { this.require(this.expression(node.args[0], scope, expectedElement), expectedElement, node.args[0]); result = genericType("Rc", [expectedElement]); }
            else if (node.callee === "rcStrongCount") { result = "number"; }
            else if (node.callee === "rcValue") { result = expectedElement; }
            else if ((node.callee === "mutRefOf" || node.callee === "mutRefFrom") && node.args[0]) { this.require(this.expression(node.args[0], scope, expectedElement), expectedElement, node.args[0]); result = genericType("MutRef", [expectedElement]); }
            else if (node.callee === "mutRefValue") { result = expectedElement; }
            else if ((node.callee === "mutOf" || node.callee === "mutFrom") && node.args[0]) { this.require(this.expression(node.args[0], scope, expectedElement), expectedElement, node.args[0]); result = genericType("Mut", [expectedElement]); }
            else if (node.callee === "mutValue") { result = expectedElement; }
            else if (node.callee === "mutIsSome") { result = "boolean"; }
            else { result = "void"; node.args.forEach(arg => this.expression(arg, scope)); }
          } else {
            // Sin expected ni tipo inferible: reportamos.
            this.report(node, `'${node.callee}' requiere contexto de tipo ${smartBase}<T>`);
            node.args.forEach(arg => this.expression(arg, scope));
            result = "void";
          }
          break;
        }
        if (JSON_HELPERS[node.callee]) {
          const signature = JSON_HELPERS[node.callee];
          if (!signature || !signature.params) { result = "void"; node.args.forEach(a => this.expression(a, scope)); break; }
          if (node.args.length !== signature.params.length) this.report(node, `'${node.callee}' espera ${signature.params.length} argumentos, recibió ${node.args.length}`);
          node.args.forEach((arg, index) => { const expectedType = signature.params[index]; const actual = this.expression(arg, scope, expectedType); if (expectedType) this.require(actual, expectedType, arg); });
          result = signature.returnType; break;
        }
        const symbol = scope.resolve(node.callee);
        if (!symbol) { this.report(node, `Función no definida '${node.callee}'`, this.suggestSimilar(node.callee, scope.names())); node.args.forEach(a => this.expression(a, scope)); break; }
        if (symbol.kind === "variable" && isFunctionType(symbol.type)) {
          const parameters = functionParameters(symbol.type);
          if (node.args.length !== parameters.length) this.report(node, `'${node.callee}' espera ${parameters.length} argumentos, recibió ${node.args.length}`);
          node.args.forEach((arg, index) => { const expectedType = parameters[index]; const actual = this.expression(arg, scope, expectedType); if (expectedType) this.require(actual, expectedType, arg); });
          result = functionResult(symbol.type); break;
        }
        if (symbol.kind !== "function") { this.report(node, `'${node.callee}' no es invocable`); node.args.forEach(a => this.expression(a, scope)); break; }
        if (node.callee === "length") {
          if (node.args.length !== 1) this.report(node, "'length' espera un argumento");
          const argument = node.args[0]; const actual = argument ? this.expression(argument, scope) : "void";
          if (argument && actual !== "string" && !isArrayType(actual) && !isTupleType(actual)) this.report(argument, "length requiere string, array o tupla");
          result = "number"; break;
        }
        if (["print", "write", "printError", "writeError"].includes(node.callee)) { node.args.forEach(arg => this.expression(arg, scope)); result = "void"; break; }
        // Propagamos el `expected` contextual a cada argumento cuando TODAS las sobrecargas
        // coinciden en el tipo del parámetro en esa posición. Esto permite, por ejemplo,
        // que una closure interna reciba como `expected` el tipo función declarado en la
        // firma y así inferir su tipo de retorno.
        const contextualArgTypes = node.args.map((_, index) => {
          const candidates = symbol.overloads
            .map(signature => signature.params[Math.min(index, signature.params.length - (signature.params.at(-1)?.variadic ? 1 : 0))]?.type)
            .filter((type): type is TypeName => !!type);
          if (!candidates.length) return undefined;
          if (candidates.every(type => type === candidates[0])) return candidates[0];
          return undefined;
        });
        // V10: marcar lambdas pasadas directamente como argumento. Esto
        // habilita la emisión inline en C++ sin envolver en `std::function`
        // cuando el codegen decide hacerlo. La marca se setea antes de
        // procesar el argumento para que `expression()` la vea al final.
        node.args.forEach((arg, index) => { if (arg.kind === "ArrowFunctionExpression" && !arg.singleUseSite) arg.singleUseSite = { kind: "CallExpression", argumentIndex: index }; });
        const argumentTypes = node.args.map((arg, index) => this.expression(arg, scope, contextualArgTypes[index]));
        const matches = symbol.overloads.map(signature => this.matchOverload(signature, argumentTypes, node.typeArguments, expected)).filter(match => !!match).sort((a, b) => b.score - a.score);
        if (!matches.length) { this.report(node, `Ninguna sobrecarga de '${node.callee}' acepta (${argumentTypes.join(", ")})`); break; }
        if (matches.length > 1 && matches[0].score === matches[1].score) this.report(node, `Llamada ambigua a '${node.callee}'`);
        const selected = matches[0]; const signature = selected.signature;
        if (!node.typeArguments.length) {
          const inferred = signature.typeParameters.filter(parameter => !signature.variadicTypeParameters.includes(parameter)).map(parameter => selected.substitutions.get(parameter));
          if (inferred.length && inferred.every((type): type is TypeName => !!type)) this.inferredCallTypeArguments.set(node, inferred);
        }
        node.typeArguments.forEach(argument => this.validateType(argument, node, false, false, scope));
        node.args.forEach((arg, index) => {
          const parameter = signature.params[Math.min(index, signature.params.length - 1)];
          if (parameter?.out || parameter?.mutableReference) {
            const mode = parameter.out ? "out" : "mut";
            if (arg.kind !== "IdentifierExpression") this.report(arg, `Un argumento ${mode} debe ser una variable mutable`);
            else { const target = scope.resolve(arg.name); if (!target || target.kind !== "variable" || !target.mutable) this.report(arg, `Un argumento ${mode} debe ser una variable mutable`); else this.markCapturedMutation(arg, scope); }
          }
        });
        result = this.substituteType(signature.returnType, selected.substitutions); break;
      }
      case "MemberCallExpression": {
        const objectType = this.expression(node.object, scope);
        // V1.2: `Union<T1, T2>.Variant(args)` o `Union.Variant(args)`. Si la
        // unión existe y la variante está declarada, el resultado es el tipo
        // de la unión instanciado (o simple si no hay genéricos).
        if (node.object.kind === "IdentifierExpression" || node.object.kind === "GenericIdentifierExpression") {
          const unionName = node.object.name;
          if (this.unions.has(unionName)) {
            const unionNode = this.unions.get(unionName)!;
            const variant = unionNode.variants.find(v => v.name === node.method);
            if (!variant) {
              this.report(node, `La unión '${unionName}' no tiene variante '${node.method}' (variantes: ${unionNode.variants.map(v => v.name).join(", ")})`);
              result = unionNode.typeParameters.length ? genericType(unionName, node.object.kind === "GenericIdentifierExpression" ? node.object.typeArguments : TypeChecker.namesOf(unionNode.typeParameters)) : unionName;
              break;
            }
            if ((variant.payload ? 1 : 0) !== node.args.length) {
              this.report(node, `La variante '${unionName}' espera ${variant.payload ? 1 : 0} argumento(s), recibió ${node.args.length}`);
              result = unionNode.typeParameters.length ? genericType(unionName, node.object.kind === "GenericIdentifierExpression" ? node.object.typeArguments : TypeChecker.namesOf(unionNode.typeParameters)) : unionName;
              break;
            }
            const args_ = node.object.kind === "GenericIdentifierExpression" ? node.object.typeArguments : TypeChecker.namesOf(unionNode.typeParameters);
            if (variant.payload) this.expression(node.args[0]!, scope, variant.payload);
            result = unionNode.typeParameters.length ? genericType(unionName, args_) : unionName;
            break;
          }
        }
        if (objectType === "Filesystem") {
          result = this.dispatchBuiltin("fs", FILESYSTEM_METHODS, node, scope);
          break;
        }
        if (objectType === "Path") {
          result = this.dispatchBuiltin("path", PATH_METHODS, node, scope);
          break;
        }
        if (objectType === "Process") {
          result = this.dispatchBuiltin("process", PROCESS_METHODS, node, scope);
          break;
        }
        if (objectType === "Math") {
          result = this.dispatchBuiltin("Math", MATH_METHODS, node, scope);
          break;
        }
        if (objectType === "Date") {
          result = this.dispatchBuiltin("Date", DATE_METHODS, node, scope);
          break;
        }
        if (objectType === "Json") {
          result = this.dispatchBuiltin("JSON", JSON_METHODS, node, scope);
          break;
        }
        // FileReader: lector streaming por descriptor. Los metodos se
        // dispatchan con un set hardcoded igual que Console porque el
        // checker no parsea `estatic.d.ts` (es un template string del CLI).
        if (objectType === "FileReader") {
          const validMethods = new Set(["readChar", "read", "readLine", "peekChar", "peek", "eof", "close"]);
          if (!validMethods.has(node.method)) this.report(node, `FileReader.${node.method} no es un metodo valido (usa readChar/peekChar/peek/read/readLine/eof/close)`);
          node.args.forEach(arg => this.expression(arg, scope));
          if (node.method === "readChar") result = "number";
          else if (node.method === "peekChar") result = "number";
          else if (node.method === "eof") result = "boolean";
          else if (node.method === "readLine") result = "string";
          else if (node.method === "read" || node.method === "peek") result = "string";
          else if (node.method === "close") result = "void";
          else result = "void";
          break;
        }
        if (objectType === "Console") {
          const validMethods = new Set(["log", "info", "debug", "trace", "warn", "error"]);
          if (!validMethods.has(node.method)) this.report(node, `console.${node.method} no es una API válida (usa log/info/debug/trace/warn/error)`);
          node.args.forEach(arg => this.expression(arg, scope));
          result = "void";
          break;
        }
        // Para un parámetro genérico `T` con constraint `A & B`, reunimos los métodos
        // de todas las interfaces miembro para resolver la llamada.
        const constraint = this.activeTypeConstraints.get(objectType);
        if (constraint && isIntersectionType(constraint) && this.activeTypeParameters.has(objectType)) {
          const memberMethods = intersectionMembers(constraint).flatMap(member => this.interfaces.get(member)?.methods ?? []);
          const methods = memberMethods.filter(candidate => candidate.name === node.method);
          if (!methods.length) this.report(node, `El constraint '${constraint}' no declara '${node.method}'`);
          result = this.resolveInterfaceMethodCall(methods, node, scope, expected) ?? "void";
          break;
        }
        if (isGenericType(objectType) && genericBase(objectType) === "Result") {
          const valueType = genericArguments(objectType)[0] ?? "void";
          if (node.args.length) this.report(node, `'${node.method}' no acepta argumentos`);
          node.args.forEach(arg => this.expression(arg, scope));
          if (node.method === "isOk") result = "boolean";
          else if (node.method === "value") result = valueType;
          else if (node.method === "error") result = "string";
          else this.report(node, `Result no declara '${node.method}'`);
          break;
        }
        if (isGenericType(objectType) && genericBase(objectType) === "Map") {
          const typeArgs = genericArguments(objectType);
          if (typeArgs.length !== 2) { this.report(node, `Map espera 2 argumentos de tipo, recibió ${typeArgs.length}`); break; }
          result = this.dispatchGenericBuiltin("Map", MAP_METHODS, node, scope, typeArgs);
          break;
        }
        if (isGenericType(objectType) && genericBase(objectType) === "Set") {
          const typeArgs = genericArguments(objectType);
          if (typeArgs.length !== 1) { this.report(node, `Set espera 1 argumento de tipo, recibió ${typeArgs.length}`); break; }
          result = this.dispatchGenericBuiltin("Set", SET_METHODS, node, scope, typeArgs);
          break;
        }
        // V7: métodos sobre arrays `T[]`. Las firmas se materializan con
        // `typeArgs = [T]` (elemento del array). Para `map<U>(f)` y
        // `reduce<U>(init, op)`, el parámetro `U` puede declararse
        // explícitamente o inferirse del tipo de retorno de la lambda o del
        // valor `init`; el resultado se guarda en `inferredCallTypeArguments`
        // para que el codegen emita la llamada C++ con los tipos correctos.
        if (isArrayType(objectType)) {
          const method = ARRAY_METHODS[node.method];
          if (!method) {
            this.report(node, `El tipo '${objectType}' no declara '${node.method}' (usa ${Object.keys(ARRAY_METHODS).join(", ")})`);
            node.args.forEach(arg => this.expression(arg, scope));
            result = "void[]";
            break;
          }
          if (node.args.length !== method.arity) this.report(node, `Array.${node.method} espera ${method.arity} argumento(s), recibió ${node.args.length}`);
          const T = arrayElement(objectType);
          if (node.method === "filter") {
            const expected = functionType([T], "boolean");
            if (node.args[0]) this.require(this.expression(node.args[0], scope, expected), expected, node.args[0]);
            result = objectType;
            break;
          }
          if (node.method === "map") {
            // `arr.map<U>(f)`: `f` debe ser `(T) => U`. `U` se obtiene en
            // este orden de prioridad: typeArgument explícito, expected
            // (p.ej. `let r: string[] = arr.map(...)`), tipo de retorno del
            // lambda. Si nada de eso aplica, dejamos `U = undefined` y el
            // codegen usará `auto` para el vector de salida (caso raro; lo
            // común es que el dialecto siempre reciba `expected` por la
            // anotación del LHS o por el contexto de llamada).
            const userU = node.typeArguments[0];
            let U: TypeName | undefined = userU;
            if (!U && expected && isArrayType(expected)) {
              const innerExpected = arrayElement(expected);
              if (innerExpected !== "void") U = innerExpected;
            }
            if (!U && node.args[0] && node.args[0].kind === "ArrowFunctionExpression") {
              // Inferencia desde el retorno del lambda (modo conservativo:
              // no pasamos `expected` para no contaminar la inferencia del
              // cuerpo; el usuario debe anotar `U` si la lambda no tiene
              // un tipo de retorno concreto).
              const fnType = this.expression(node.args[0], scope);
              if (fnType && isFunctionType(fnType)) {
                const r = functionResult(fnType);
                if (r && r !== "void") U = r;
              }
            }
            const fnExpected = functionType([T], U ?? "void");
            // V10: la lambda es argumento directo de `.filter` o `.map`,
            // марка `singleUseSite` para que el codegen la inline.
            if (node.args[0] && node.args[0].kind === "ArrowFunctionExpression") node.args[0].singleUseSite = { kind: "MemberCallExpression", argumentIndex: 0 };
            if (node.args[0]) this.require(this.expression(node.args[0], scope, fnExpected), fnExpected, node.args[0]);
            if (U) this.inferredCallTypeArguments.set(node, [U]);
            result = U ? `${U}[]` : "void[]";
            break;
          }
          if (node.method === "reduce") {
            // `arr.reduce<U>(init, op)`: `init: U`, `op: (U, T) => U`.
            // `U` se deduce del typeArgument explícito o del tipo de `init`
            // (primer argumento). Sin uno de los dos no podemos validar la
            // firma del operador.
            const userU = node.typeArguments[0];
            let U: TypeName | undefined = userU;
            if (!U && node.args[0]) {
              const initType = this.expression(node.args[0], scope);
              if (initType) U = initType;
            }
            if (!U) this.report(node.args[0] ?? node, `Array.reduce requiere tipo del acumulador U (anota arr.reduce<U>(init, op) o da un tipo a init)`);
            const fnExpected = functionType([U ?? "void", T], U ?? "void");
            // V10: el operador de reduce es argumento directo, марка `singleUseSite`.
            if (node.args[1] && node.args[1].kind === "ArrowFunctionExpression") node.args[1].singleUseSite = { kind: "MemberCallExpression", argumentIndex: 1 };
            if (node.args[1]) this.require(this.expression(node.args[1], scope, fnExpected), fnExpected, node.args[1]);
            if (U) this.inferredCallTypeArguments.set(node, [U]);
            result = U ?? "void";
            break;
          }
          // V11: métodos adicionales sobre arrays. La firma del lambda se
          // valida según `paramKinds` y el returnType se computa con la
          // tabla ARRAY_METHODS.
          if (node.method === "forEach") {
            const fnExpected = functionType([T], "void");
            // V10: lambda directa es singleUseSite.
            if (node.args[0] && node.args[0].kind === "ArrowFunctionExpression") node.args[0].singleUseSite = { kind: "MemberCallExpression", argumentIndex: 0 };
            if (node.args[0]) this.require(this.expression(node.args[0], scope, fnExpected), fnExpected, node.args[0]);
            result = "void";
            break;
          }
          if (node.method === "find") {
            const fnExpected = functionType([T], "boolean");
            if (node.args[0] && node.args[0].kind === "ArrowFunctionExpression") node.args[0].singleUseSite = { kind: "MemberCallExpression", argumentIndex: 0 };
            if (node.args[0]) this.require(this.expression(node.args[0], scope, fnExpected), fnExpected, node.args[0]);
            result = `Optional<${T}>`;
            break;
          }
          if (node.method === "some" || node.method === "every") {
            const fnExpected = functionType([T], "boolean");
            if (node.args[0] && node.args[0].kind === "ArrowFunctionExpression") node.args[0].singleUseSite = { kind: "MemberCallExpression", argumentIndex: 0 };
            if (node.args[0]) this.require(this.expression(node.args[0], scope, fnExpected), fnExpected, node.args[0]);
            result = "boolean";
            break;
          }
          if (node.method === "slice") {
            if (node.args[0]) this.require(this.expression(node.args[0], scope), "number", node.args[0]);
            if (node.args[1]) this.require(this.expression(node.args[1], scope), "number", node.args[1]);
            result = objectType;
            break;
          }
          // V14: `sort(cmp)` — `cmp: (T, T) => number` (negativo si a<b).
          if (node.method === "sort") {
            const fnExpected = functionType([T, T], "number");
            if (node.args[0] && node.args[0].kind === "ArrowFunctionExpression") node.args[0].singleUseSite = { kind: "MemberCallExpression", argumentIndex: 0 };
            if (node.args[0]) this.require(this.expression(node.args[0], scope, fnExpected), fnExpected, node.args[0]);
            result = objectType;
            break;
          }
          // V14: `flatMap<U>(f)` — `f: (T) => U[]`, devuelve `U[]`.
          if (node.method === "flatMap") {
            const userU = node.typeArguments[0];
            let U: TypeName | undefined = userU;
            if (!U && expected && isGenericType(expected) && genericBase(expected).startsWith("U")) U = genericArguments(expected)[0];
            if (!U) this.report(node, `Array.flatMap requiere tipo U (anota arr.flatMap<U>(f))`);
            const fnExpected = functionType([T], U ? `${U}[]` : "void[]");
            if (node.args[0] && node.args[0].kind === "ArrowFunctionExpression") node.args[0].singleUseSite = { kind: "MemberCallExpression", argumentIndex: 0 };
            if (node.args[0]) this.require(this.expression(node.args[0], scope, fnExpected), fnExpected, node.args[0]);
            if (U) this.inferredCallTypeArguments.set(node, [U]);
            result = U ? `${U}[]` : "void[]";
            break;
          }
          // V14: `includes(value)` — compara por `operator==`.
          if (node.method === "includes") {
            if (node.args[0]) this.require(this.expression(node.args[0], scope, T), T, node.args[0]);
            result = "boolean";
            break;
          }
          break;
        }
        // V14: Optional<T> tiene métodos intrínsecos conocidos por el dialecto
        // (estilo Rust Option::is_some, Option::unwrap). NO son magia del
        // compilador: el programador los ve y decide cuándo usarlos. Si
        // llama `o.value()` sin verificar, aborta — el programador DEBE
        // gestionar el caso vacío explícitamente.
        if (objectType && isGenericType(objectType) && genericBase(objectType) === "Optional") {
          const T = genericArguments(objectType)[0] ?? "void";
          const method = node.method;
          if (method === "isPresent" || method === "isEmpty") {
            if (node.args.length !== 0) this.report(node, `Optional.${method} espera 0 argumentos`);
            result = "boolean";
            break;
          }
          if (method === "value") {
            if (node.args.length !== 0) this.report(node, `Optional.value espera 0 argumentos`);
            result = T;
            break;
          }
          if (method === "valueOr") {
            if (node.args.length !== 1) this.report(node, `Optional.valueOr espera 1 argumento`);
            else this.require(this.expression(node.args[0], scope, T), T, node.args[0]);
            result = T;
            break;
          }
          if (method === "map") {
            if (node.args.length !== 1) this.report(node, `Optional.map espera 1 argumento`);
            else {
              const innerExpected = expected && isGenericType(expected) && genericBase(expected) === "Optional" ? genericArguments(expected)[0] ?? "void" : "void";
              const fnExpected = functionType([T], innerExpected);
              this.require(this.expression(node.args[0], scope, fnExpected), fnExpected, node.args[0]);
            }
            result = expected ?? `Optional<${T}>`;
            break;
          }
          if (method === "andThen") {
            if (node.args.length !== 1) this.report(node, `Optional.andThen espera 1 argumento`);
            else this.require(this.expression(node.args[0], scope), functionType([T], `Optional<void>`), node.args[0]);
            result = expected ?? `Optional<${T}>`;
            break;
          }
          if (method === "orElse") {
            if (node.args.length !== 1) this.report(node, `Optional.orElse espera 1 argumento`);
            else this.require(this.expression(node.args[0], scope, objectType), objectType, node.args[0]);
            result = objectType;
            break;
          }
          this.report(node, `Optional no tiene el método '${method}'`);
          result = objectType;
          break;
        }
        const resolvedClass = this.resolveClass(objectType);
        const constrainedInterface = this.activeTypeConstraints.get(objectType);
        const owner = this.interfaces.get(constrainedInterface ?? objectType) ?? resolvedClass?.owner;
        const methods = owner?.methods.filter(candidate => candidate.name === node.method) ?? [];
        if (!owner) this.report(node.object, `El tipo '${objectType}' no tiene métodos`);
        else if (!methods.length) this.report(node, `El tipo '${objectType}' no declara '${node.method}'`);
        // V19: encapsulación de métodos. Si el método es `private` y el
        // acceso viene desde fuera de la clase, error. Solo se chequea
        // si el owner es un ClassDeclaration (las interfaces son públicas
        // por contrato).
        const methodOwnerName = owner && "name" in owner ? owner.name : undefined;
        const offendingMethod = methods.find(m => "access" in m) as ClassMethod | undefined;
        if (offendingMethod?.access === "private" && methodOwnerName !== this.currentClass) {
          this.report(node, `El método '${node.method}' es privado en '${methodOwnerName}' y no se puede llamar desde fuera`);
          result = "void";
          break;
        }
        if (offendingMethod?.access === "protected" && methodOwnerName !== this.currentClass) {
          this.report(node, `El método '${node.method}' es protegido en '${methodOwnerName}' y no se puede llamar desde fuera`);
          result = "void";
          break;
        }
        const argumentTypes = node.args.map(arg => this.expression(arg, scope));
        const classSubstitutions = resolvedClass?.substitutions ?? new Map<string, TypeName>();
        const matches = methods.map(method => {
          const signature: FunctionSignature = {
            typeParameters: TypeChecker.namesOf(method.typeParameters ?? []), variadicTypeParameters: [], typeConstraints: TypeChecker.constraintsOf(method.typeParameters ?? []), defaults: TypeChecker.defaultsOf(method.typeParameters ?? []),
            params: method.params.map(parameter => ({ type: this.substituteType(parameter.type, classSubstitutions), out: parameter.out, mutableReference: parameter.passing === "mut", defaultValue: parameter.defaultValue, optional: parameter.optional })),
            returnType: this.substituteType(method.returnType, classSubstitutions)
          };
          const match = this.matchOverload(signature, argumentTypes, node.typeArguments, expected);
          return match ? { match, method } : undefined;
        }).filter((candidate): candidate is { match: NonNullable<ReturnType<TypeChecker["matchOverload"]>>; method: ClassMethod } => !!candidate)
          .sort((left, right) => right.match.score - left.match.score);
        if (methods.length && !matches.length) this.report(node, `Ninguna sobrecarga de método '${node.method}' acepta (${argumentTypes.join(", ")})`);
        if (matches.length > 1 && matches[0].match.score === matches[1].match.score) this.report(node, `Llamada ambigua al método '${node.method}'`);
        if (matches.length) {
          const selected = matches[0].match;
          if (resolvedClass && this.methodMutates(matches[0].method)) {
            if (!this.mutableTarget(node.object, scope)) this.report(node.object, `El método '${node.method}' modifica el objeto y necesita un receptor mutable`);
            else this.markCapturedMutation(node.object, scope);
          }
          node.typeArguments.forEach(argument => this.validateType(argument, node, false, false, scope));
          node.args.forEach((argument, index) => {
            const selectedParameter = selected.signature.params[index];
            if (!selectedParameter?.out && !selectedParameter?.mutableReference) return;
            const mode = selectedParameter.out ? "out" : "mut";
            if (argument.kind !== "IdentifierExpression") this.report(argument, `Un argumento ${mode} debe ser una variable mutable`);
            else { const target = scope.resolve(argument.name); if (!target || target.kind !== "variable" || !target.mutable) this.report(argument, `Un argumento ${mode} debe ser una variable mutable`); else this.markCapturedMutation(argument, scope); }
          });
          const inferred = selected.signature.typeParameters.map(parameter => selected.substitutions.get(parameter));
          if (!node.typeArguments.length && inferred.length && inferred.every((type): type is TypeName => !!type)) this.inferredCallTypeArguments.set(node, inferred);
          result = this.substituteType(selected.signature.returnType, selected.substitutions);
        }
        break;
      }
      case "MemberExpression": {
        const objectType = this.expression(node.object, scope);
        // V1.4: si el object es una expresión narrowada por un if anterior,
        // devolvemos el payload de la variante narrowada. Si solo hay una
        // variante activa y tiene payload, ese es el tipo. Si no,
        // разреша el acceso devolviendo la unión misma (el codegen emitirá
        // std::get_if o similar).
        if (node.object.kind === "IdentifierExpression" && this.narrowed.has(node.object.name)) {
          const narrow = this.narrowed.get(node.object.name)!;
          const unionNode = this.unions.get(narrow.unionType);
          if (unionNode) {
            const activeVariants = unionNode.variants.filter(v => narrow.variants.includes(v.name));
            if (activeVariants.length === 1 && activeVariants[0].payload) {
              // Si la unión es genérica (e.g. `Result<T,E>`), sustituimos
              // los type parameters con los argumentos reales del tipo del
              // identificador narrowado. Si faltan argumentos, usamos el
              // default declarado en el type parameter (e.g. `E` tiene
              // default `string` en `Result<T, E>`).
              const exprSymbol = scope.resolve(node.object.name);
              if (exprSymbol && exprSymbol.kind === "variable") {
                const exprType = exprSymbol.type;
                if (isGenericType(exprType)) {
                  const args = genericArguments(exprType);
                  const params = unionNode.typeParameters;
                  const subs = new Map<string, TypeName>();
                  params.forEach((p, i) => {
                    if (args[i]) subs.set(p.name, args[i]);
                    else if (p.default) subs.set(p.name, p.default);
                  });
                  result = this.substituteType(activeVariants[0].payload, subs);
                  break;
                }
              }
              result = activeVariants[0].payload;
              break;
            }
            if (activeVariants.length > 0) { result = narrow.unionType; break; }
          }
        }
        // V1.4: acceso al campo discriminador de una unión siempre разрешен
        // aunque la unión no tenga clase. El tipo del campo es el del
        // literal declarado en la primera variante con discriminador.
        if (!isGenericType(objectType) && this.unions.has(objectType)) {
          const unionNode = this.unions.get(objectType)!;
          const disc = unionNode.variants.find(v => v.discriminator)?.discriminator;
          if (disc && disc.field === node.member) {
            result = typeof disc.value === "boolean" ? "boolean" : typeof disc.value === "number" ? "number" : "string";
            break;
          }
        }
        if (isGenericType(objectType) && this.unions.has(genericBase(objectType))) {
          const unionNode = this.unions.get(genericBase(objectType))!;
          const disc = unionNode.variants.find(v => v.discriminator)?.discriminator;
          if (disc && disc.field === node.member) {
            result = typeof disc.value === "boolean" ? "boolean" : typeof disc.value === "number" ? "number" : "string";
            break;
          }
        }
        // Acceso a miembro de enum: `Color.Green` se evalúa al tipo del enum, no al subyacente.
        // La conversión al subyacente ocurre en el codegen cuando se necesita (p.ej. `print(c)`).
        if (node.object.kind === "IdentifierExpression" && this.enums.has(node.object.name)) {
          const enumNode = this.enums.get(node.object.name)!;
          const member = enumNode.members.find(candidate => candidate.name === node.member);
          if (!member) this.report(node, `El enum '${node.object.name}' no declara el miembro '${node.member}'`);
          result = node.object.name;
          break;
        }
        if (node.optional) {
          // `?.`: el operando debe ser `Optional<T>`; el resultado es
          // `Optional<field_type>`. Se valida contra el nombre del campo en
          // la clase T.
          if (!isGenericType(objectType) || genericBase(objectType) !== "Optional") {
            this.report(node.object, `Optional chaining '?.': el operando debe ser Optional<T>, se obtuvo '${objectType}'`);
            result = "void";
            break;
          }
          const element = genericArguments(objectType)[0] ?? "void";
          const resolvedInner = this.resolveClass(element); const ownerInner = resolvedInner?.owner;
          if (!ownerInner) {
            this.report(node.object, `Optional chaining '?.': '${element}' no es una clase concreta`);
            result = "void";
            break;
          }
          const fieldInner = ownerInner.fields.find(candidate => candidate.name === node.member);
          if (!fieldInner) {
            this.report(node, `La clase '${element}' no declara el campo '${node.member}'`);
            result = "void";
            break;
          }
          const fieldInnerType = this.substituteType(fieldInner.type, resolvedInner?.substitutions ?? new Map());
          result = genericType("Optional", [fieldInnerType]);
          break;
        }
        // V22 (Memory Model v2): ptr<T>, constPtr<T>, ref<T>, constRef<T>
        // son modificadores de paso. El member access desempaca al tipo
        // interno T antes de buscar la clase.
        let classLookupType = objectType;
        if (isGenericType(classLookupType)) {
          const memBase = genericBase(classLookupType);
          if (memBase === "ptr" || memBase === "constPtr" || memBase === "ref" || memBase === "constRef") {
            const innerArg = genericArguments(classLookupType)[0];
            if (innerArg) classLookupType = innerArg;
          }
        }
        const resolved = this.resolveClass(classLookupType); const owner = resolved?.owner;
        const field = owner?.fields.find(candidate => candidate.name === node.member);
        // V1.2: los miembros de una unión (variantes) se acceden como `Direction.North`.
        // Si el objeto es un nombre de unión, el miembro es una variante.
        if (!owner && this.unions.has(objectType)) {
          const unionNode = this.unions.get(objectType)!;
          const variant = unionNode.variants.find(v => v.name === node.member);
          if (variant) { result = objectType; break; }
          this.report(node, `La unión '${objectType}' no tiene variante '${node.member}'`);
          break;
        }
        // V22-gap-#2: `length` es propiedad virtual sobre `Array<T>` / `T[]`.
        // Devuelve `number` y se compila a `obj.size()` en C++.
        if (node.member === "length" && (objectType.endsWith("[]") || (isGenericType(objectType) && genericBase(objectType) === "Array"))) {
          result = "number";
          break;
        }
        if (!owner) this.report(node.object, `El tipo '${classLookupType}' no es una clase concreta`);
        // V19: chequeo de encapsulación. Si el campo es `private` y el
        // acceso viene desde fuera de la clase, error.
        const ownerName = owner?.name;
        if (field && field.access === "private" && ownerName !== this.currentClass) {
          this.report(node, `El campo '${node.member}' es privado en '${ownerName}' y no se puede acceder desde fuera`);
          result = "void";
          break;
        }
        if (field && field.access === "protected" && ownerName !== this.currentClass) {
          // V19: protected sin herencia todavía = equivalente a private.
          // Cuando llegue herencia (#29), se aflojará la restricción.
          this.report(node, `El campo '${node.member}' es protegido en '${ownerName}' y no se puede acceder desde fuera`);
          result = "void";
          break;
        }
        // V20: parameter properties — si el campo no está declarado pero hay
        // un parámetro del constructor con ese nombre + modificador, también
        // se considera un campo válido (implícito).
        if (!field && owner) {
          const ctor = owner.methods.find(m => m.name === "constructor");
          if (ctor) {
            const paramProp = ctor.params.find(p => p.name === node.member && (p.access !== undefined || p.readonly === true));
            if (paramProp) {
              result = this.substituteType(paramProp.type, resolved?.substitutions ?? new Map());
              break;
            }
          }
          this.report(node, `La clase '${objectType}' no declara el campo '${node.member}'`);
        }
        if (field) result = this.substituteType(field.type, resolved?.substitutions ?? new Map());
        break;
      }
      case "IndexExpression": {
        const objectType = this.expression(node.object, scope);
        this.require(this.expression(node.index, scope, "number"), "number", node.index);
        // V5: readonly<T[]> y readonly<T[N]> permiten indexación de solo lectura.
        // El resultado es readonly del element (no se puede reasignar a través del index).
        if (isReadonlyType(objectType)) {
          const inner = readonlyInner(objectType);
          if (inner && isArrayType(inner)) result = readonlyType(arrayElement(inner));
          else if (inner && isFixedArrayType(inner)) result = readonlyType(fixedArrayElement(inner)!);
          else this.report(node.object, `El tipo '${objectType}' no se puede indexar`);
        }
        else if (isArrayType(objectType)) result = arrayElement(objectType);
        else if (isFixedArrayType(objectType)) {
          // V4: bounds check en compilación cuando el índice es literal entero.
          // Soportamos tanto `LiteralExpression` (p.ej. `buf[3]`) como
          // `UnaryExpression` con `-` sobre LiteralExpression (p.ej. `buf[-1]`).
          const size = fixedArraySize(objectType)!;
          const elementType = fixedArrayElement(objectType)!;
          const literalValue = this.literalIntValue(node.index);
          if (literalValue !== undefined && (literalValue < 0 || literalValue >= size)) this.report(node.index, `Índice de array fijo fuera de rango: ${literalValue} (tamaño ${size})`);
          result = elementType;
        }
        else if (isTupleType(objectType)) {
          const items = tupleElements(objectType);
          if (node.index.kind !== "LiteralExpression" || node.index.literalType !== "number" || !Number.isInteger(node.index.value)) {
            this.report(node.index, "El índice de una tupla debe ser un literal entero");
          } else {
            const index = Number(node.index.value);
            if (index < 0 || index >= items.length) this.report(node.index, `Índice de tupla fuera de rango: ${index}`);
            else result = items[index];
          }
        } else this.report(node.object, `El tipo '${objectType}' no se puede indexar`);
        break;
      }
      case "NewExpression": {
        // `Map<K,V>` y `Set<T>` no son clases declaradas por el usuario pero sí
        // constructibles: se permite `new Map<K,V>()` / `new Set<T>()` sin args.
        const baseName = isGenericType(node.className) ? genericBase(node.className) : node.className;
        if (baseName === "Map" || baseName === "Set") {
          if (node.args.length) this.report(node, `${baseName} no toma argumentos de construcción, recibió ${node.args.length}`);
          this.validateType(node.className, node, false, false, scope);
          result = node.className; break;
        }
        const resolved = this.resolveClass(node.className); const owner = resolved?.owner;
        if (!owner) { this.report(node, `Clase no definida '${node.className}'`); node.args.forEach(arg => this.expression(arg, scope)); break; }
        if (owner.typeParameters.length && !isGenericType(node.className)) this.report(node, `La clase genérica '${owner.name}' necesita ${owner.typeParameters.length} argumentos de tipo`);
        // V19: si la clase tiene constructor explícito, el `new T(...)` llama
        // al constructor (no aggregate-init). El número de args debe
        // coincidir con los params del constructor.
        const hasConstructor = owner.methods.some(m => m.name === "constructor");
        if (hasConstructor) {
          const ctor = owner.methods.find(m => m.name === "constructor")!;
          // Validamos args contra los params del constructor (sin defaults).
          const requiredParams = ctor.params.filter(p => p.defaultValue === undefined).length;
          if (node.args.length < requiredParams) this.report(node, `'${node.className}' espera al menos ${requiredParams} argumento(s) en el constructor, recibió ${node.args.length}`);
          // Validamos tipos de cada argumento contra el param.
          const classSubstitutions = resolved?.substitutions ?? new Map();
          node.args.forEach((arg, i) => {
            const param = ctor.params[i];
            if (!param) return;
            const expected = this.substituteType(param.type, classSubstitutions);
            const actual = this.expression(arg, scope, expected);
            this.require(actual, expected, arg);
          });
          result = node.className;
          break;
        }
        if (node.args.length !== owner.fields.length) this.report(node, `'${node.className}' espera ${owner.fields.length} valores de composición, recibió ${node.args.length}`);
        node.args.forEach((arg, i) => { const field = owner.fields[i]; const expectedType = field ? this.substituteType(field.type, resolved?.substitutions ?? new Map()) : undefined; const actual = this.expression(arg, scope, expectedType); if (expectedType) this.require(actual, expectedType, arg); });
        result = node.className; break;
      }
      case "AssignmentExpression": {
        const targetType = this.expression(node.target, scope); const value = this.expression(node.value, scope, targetType);
        if (!this.mutableTarget(node.target, scope)) this.report(node, "No se puede modificar una constante ni uno de sus campos");
        else {
          // Rechaza asignaciones a campos `readonly` fuera del constructor:
          // el dialecto exige que se inicialicen una sola vez en el cuerpo
          // del constructor. Esto se modela como "mutable solo dentro del
          // método `constructor` de la misma clase".
          if (!this.inConstructor) {
            const readonlyField = this.findReadonlyFieldAccess(node.target);
            if (readonlyField) this.report(node, `El campo readonly '${readonlyField}' solo puede asignarse dentro del constructor`);
          }
          this.markCapturedMutation(node.target, scope);
        }
        this.require(value, targetType, node.value); result = targetType;
        break;
      }
      case "TernaryExpression": {
        // `cond ? then : else`. La condición debe ser booleana; las dos
        // ramas deben producir tipos compatibles (uno asignable al otro).
        this.require(this.expression(node.condition, scope, "boolean"), "boolean", node.condition);
        const thenType = this.expression(node.thenBranch, scope);
        const elseType = this.expression(node.elseBranch, scope, thenType);
        if (!typeMatches(elseType, thenType) && !typeMatches(thenType, elseType)) this.report(node, "Las ramas del ternario deben tener tipos compatibles");
        result = thenType;
        break;
      }
    }
    // V0.1: anotar `resolvedType` directamente sobre el nodo además de
    // (durante la transición) mantener el mapa paralelo. Las llamadas a
    // `typeOf` consultan primero `resolvedType` para que la transición sea
    // transparente.
    node.resolvedType = toResolvedType(result);
    this.types.set(node, result); return result;
  }

  private findReadonlyFieldAccess(node: Expression): string | undefined {
    // Devuelve el nombre del campo si `node` es un acceso a un campo
    // `readonly` de la clase actualmente en checkeo (`this.field = ...`).
    // Devuelve `undefined` si no aplica.
    if (node.kind !== "MemberExpression") return undefined;
    const object = node.object;
    if (object.kind !== "IdentifierExpression" || object.name !== "this") return undefined;
    const ownerType = this.currentReturn; // pista: el currentReturn de un método no es el de this; usamos una búsqueda explícita
    // Buscamos en todas las clases registradas si alguna tiene un campo con
    // ese nombre y es readonly. Es una simplificación: no comprobamos que la
    // clase del `this` actual sea la misma, pero como el dialecto no tiene
    // herencia, cada `this.field` solo puede referirse a la clase del método
    // envolvente. El constructor del flujo correcto garantiza que el campo
    // existe; si la asignación es a un campo que no es readonly, devuelve
    // undefined y se permite.
    for (const cls of this.classes.values()) {
      const field = cls.fields.find(f => f.name === node.member && f.readonly);
      if (field) return field.name;
    }
    return undefined;
  }

  private mutableTarget(node: Expression, scope: Scope): boolean {
    if (node.kind === "MemberExpression") {
      // V22: si el objeto es `constRef<T>` o `constPtr<T>`, no se puede mutar.
      // E4300/E4301.
      const objectType = this.expression(node.object, scope);
      if (isGenericType(objectType) && (genericBase(objectType) === "constRef" || genericBase(objectType) === "constPtr")) return false;
      return this.mutableTarget(node.object, scope);
    }
    if (node.kind === "IndexExpression") {
      // V5: si el objeto indexado es `readonly<T[]>`, no se puede mutar
      // a través de un index assignment (`xs[0] = 99`).
      const objectType = this.expression(node.object, scope);
      if (isReadonlyType(objectType)) return false;
      // V22: constRef<T[]> o constPtr<T[]> también bloquean index assignment.
      if (isGenericType(objectType) && (genericBase(objectType) === "constRef" || genericBase(objectType) === "constPtr")) return false;
      return this.mutableTarget(node.object, scope);
    }
    if (node.kind !== "IdentifierExpression") return false;
    const symbol = scope.resolve(node.name);
    if (!symbol) return false;
    if (symbol.kind !== "variable") return false;
    // V22 (Memory Model v2): los parámetros `out T` o con modifier `ref<T>`
    // son mutables (T&). Esto se marca con `mutableReference: true` en el
    // FunctionParameterSymbol. Variables `let` ya tienen `mutable: true`.
    if (symbol.mutableReference) return true;
    // V5: si el tipo del símbolo es `readonly<T>`, el target es inmutable.
    if (isReadonlyType(symbol.type)) return false;
    return symbol.mutable;
  }

  private markCapturedMutation(node: Expression, scope: Scope): void {
    if (!this.currentClosure) return;
    let target = node;
    while (target.kind === "MemberExpression" || target.kind === "IndexExpression") target = target.object;
    if (target.kind !== "IdentifierExpression" || target.name === "this") return;
    const resolved = scope.resolve(target.name);
    const captured = this.currentClosure.parentScope.resolve(target.name);
    if (resolved && captured && resolved === captured) this.currentClosure.node.mutatesCapturedState = true;
  }

  private methodMutates(method: ClassMethod): boolean {
    const expressionMutates = (expression: Expression): boolean => {
      if (expression.kind === "AssignmentExpression") {
        let target: Expression = expression.target;
        while (target.kind === "MemberExpression" || target.kind === "IndexExpression") target = target.object;
        return target.kind === "IdentifierExpression" && target.name === "this";
      }
      if (expression.kind === "BinaryExpression") return expressionMutates(expression.left) || expressionMutates(expression.right);
      if (expression.kind === "UnaryExpression" || expression.kind === "AwaitExpression") return expressionMutates(expression.operand);
      if (expression.kind === "CallExpression" || expression.kind === "NewExpression") return expression.args.some(expressionMutates);
      if (expression.kind === "MemberCallExpression") return expressionMutates(expression.object) || expression.args.some(expressionMutates);
      if (expression.kind === "MemberExpression") return expressionMutates(expression.object);
      if (expression.kind === "IndexExpression") return expressionMutates(expression.object) || expressionMutates(expression.index);
      if (expression.kind === "ArrayLiteralExpression") return expression.elements.some(item => item.kind === "SpreadElement" ? expressionMutates(item.expression) : expressionMutates(item));
      return false;
    };
    const statementMutates = (statement: Statement): boolean => {
      if (statement.kind === "VariableDeclaration") return expressionMutates(statement.initializer);
      if (statement.kind === "ExpressionStatement") return expressionMutates(statement.expression);
      if (statement.kind === "ReturnStatement") return !!statement.value && expressionMutates(statement.value);
      if (statement.kind === "BlockStatement") return statement.statements.some(statementMutates);
      if (statement.kind === "IfStatement") return expressionMutates(statement.condition) || statementMutates(statement.thenBranch) || (!!statement.elseBranch && statementMutates(statement.elseBranch));
      if (statement.kind === "WhileStatement") return expressionMutates(statement.condition) || statementMutates(statement.body);
      if (statement.kind === "ForStatement") return (!!statement.initializer && statementMutates(statement.initializer)) || (!!statement.condition && expressionMutates(statement.condition)) || (!!statement.increment && expressionMutates(statement.increment)) || statementMutates(statement.body);
      return false;
    };
    return statementMutates(method.body);
  }

  private require(actual: TypeName, expected: TypeName, node: { span: import("../core/span.ts").Span }): void {
    if (this.enumCompatible(actual, expected)) return;
    if (!typeMatches(actual, expected) && !this.satisfiesInterface(actual, expected)) this.report(node, `Se esperaba ${expected}, pero se obtuvo ${actual}`);
  }

  // V3: variante de `require` que acepta tipos numéricos concretos (i8..u64,
  // f32, f64) además de `number`. Usada por los operadores binarios
  // aritméticos y de comparación: cualquier tipo numérico es admisible y se
  // promueve a `number` para la operación.
  private requireNumericOperand(actual: TypeName, node: { span: import("../core/span.ts").Span }): void {
    if (actual === "number" || isNumericType(actual)) return;
    this.report(node, `Se esperaba un operando numérico, se obtuvo '${actual}'`);
  }

  // V3: dos operandos pertenecen a la "misma familia numérica" si ambos son
  // numéricos (incluyendo `number`) o si son iguales. Usada por `==`/`!=`.
  private sameNumericFamily(left: TypeName, right: TypeName): boolean {
    if (left === right) return true;
    const leftIsNumeric = left === "number" || isNumericType(left);
    const rightIsNumeric = right === "number" || isNumericType(right);
    return leftIsNumeric && rightIsNumeric;
  }
  // Un enum numérico es intercambiable con `number` (y un enum de cadena con `string`)
  // en cualquier posición: asignación, paso de argumento, etc. El codegen hace el cast
  // explícito a `double` para los enums numéricos porque `enum class` no convierte
  // implícitamente en C++.
  private enumCompatible(actual: TypeName, expected: TypeName): boolean {
    if (actual === expected) return false;
    const actualEnum = this.enums.get(actual);
    if (!actualEnum) return false;
    if (actualEnum.underlying === "number" && expected === "number") return true;
    if (actualEnum.underlying === "string" && expected === "string") return true;
    return false;
  }
  private satisfiesInterface(actual: TypeName, expected: TypeName): boolean {
    if (this.activeTypeConstraints.get(actual) === expected) return true;
    // Intersección `A & B & ...`: el tipo debe satisfacer TODAS las interfaces.
    if (isIntersectionType(expected)) return intersectionMembers(expected).every(member => this.satisfiesInterface(actual, member));
    const resolved = this.resolveClass(actual); const concrete = resolved?.owner; const contract = this.interfaces.get(expected);
    if (!concrete || !contract) return false;
    return contract.methods.every(required => {
      return concrete.methods.some(method => method.name === required.name && this.substituteType(method.returnType, resolved?.substitutions ?? new Map()) === required.returnType && method.params.length === required.params.length &&
        method.params.every((parameter, index) => this.substituteType(parameter.type, resolved?.substitutions ?? new Map()) === required.params[index].type && parameter.out === required.params[index].out && parameter.passing === required.params[index].passing));
    });
  }
  private sameSignature(left: FunctionSignature, right: FunctionSignature): boolean {
    const normalize = (signature: FunctionSignature): string[] => {
      const substitutions = new Map<string, TypeName>();
      signature.typeParameters.forEach((parameter, index) => substitutions.set(parameter, `$${index}`));
      return signature.params.map(parameter => `${parameter.variadic ? "..." : ""}${this.substituteType(parameter.type, substitutions)}`);
    };
    const leftTypes = normalize(left); const rightTypes = normalize(right);
    return leftTypes.length === rightTypes.length && leftTypes.every((type, index) => type === rightTypes[index]);
  }
  private matchOverload(signature: FunctionSignature, actuals: TypeName[], explicit: TypeName[], contextualReturn?: TypeName): { signature: FunctionSignature; substitutions: Map<string, TypeName>; score: number } | undefined {
    const rest = signature.params.at(-1)?.variadic ? signature.params.at(-1) : undefined;
    const fixedCount = signature.params.length - (rest ? 1 : 0);
    // Cuenta de parámetros obligatorios (sin `defaultValue`); los parámetros con
    // valor por defecto pueden omitirse en la llamada.
    const requiredCount = signature.params.filter(parameter => !parameter.defaultValue && !parameter.variadic && !parameter.optional).length;
    if ((!rest && (actuals.length < requiredCount || actuals.length > signature.params.length)) || (rest && actuals.length < fixedCount)) return undefined;
    const normalTypeParameters = signature.typeParameters.filter(parameter => !signature.variadicTypeParameters.includes(parameter));
    if (explicit.length) {
      if ((!signature.variadicTypeParameters.length && explicit.length !== normalTypeParameters.length) || (signature.variadicTypeParameters.length && explicit.length < normalTypeParameters.length)) return undefined;
    }
    const substitutions = new Map<string, TypeName>();
    const defaults = signature.defaults ?? {};
    // Los argumentos explícitos tienen prioridad absoluta. Sin ellos, los
    // defaults NO se aplican todavía — primero dejamos que la inferencia
    // (actuales, returnType contextual) intente llenar los huecos; los
    // defaults solo cubren los parámetros que queden sin inferir al final
    // (estilo TS).
    normalTypeParameters.forEach((parameter, index) => { if (explicit[index]) substitutions.set(parameter, explicit[index]); });
    const parameters = new Set(signature.typeParameters); let score = rest ? -1 : 0;
    for (let index = 0; index < actuals.length; index++) {
      const parameter = index < fixedCount ? signature.params[index] : rest;
      if (!parameter) return undefined;
      if (rest && signature.variadicTypeParameters.includes(parameter.type)) { score += 1; continue; }
      if (!this.tryInferType(parameter.type, actuals[index], parameters, substitutions)) return undefined;
      const expected = this.substituteType(parameter.type, substitutions);
      if (this.enumCompatible(actuals[index], expected) || typeMatches(actuals[index], expected) || this.satisfiesInterface(actuals[index], expected)) score += parameters.has(parameter.type) ? 2 : 4;
      else return undefined;
    }
    if (contextualReturn && normalTypeParameters.some(parameter => !substitutions.has(parameter))) {
      if (!this.tryInferType(signature.returnType, contextualReturn, parameters, substitutions)) return undefined;
    }
    // Tras la inferencia, cualquier parámetro aún sin ligar cae a su `default`
    // declarado (si lo tiene). Si sigue sin ligar, el overload no aplica.
    if (normalTypeParameters.some(parameter => !substitutions.has(parameter))) {
      for (const parameter of normalTypeParameters) {
        if (substitutions.has(parameter)) continue;
        const fallback = defaults[parameter];
        if (fallback) substitutions.set(parameter, fallback);
      }
      if (normalTypeParameters.some(parameter => !substitutions.has(parameter))) return undefined;
    }
    for (const [parameter, constraint] of Object.entries(signature.typeConstraints ?? {})) {
      const actual = substitutions.get(parameter);
      if (!actual || !this.satisfiesInterface(actual, constraint)) return undefined;
    }
    return { signature, substitutions, score };
  }
  private tryInferType(pattern: TypeName, actual: TypeName, parameters: Set<string>, substitutions: Map<string, TypeName>): boolean {
    if (parameters.has(pattern)) {
      const previous = substitutions.get(pattern);
      if (previous && previous !== actual) return false;
      substitutions.set(pattern, actual); return true;
    }
    // Union types: `actual` cubre `pattern` si cada miembro del union es uno de los tipos
    // esperados (covarianza). Permite pasar un `string` a un parámetro `string | number`.
    if (typeMatches(actual, pattern)) return true;
    if (pattern === actual) return true;
    // Enums numéricos/de cadena son intercambiables con su subyacente (`number`/`string`)
    // para argumentos. El codegen emite el cast explícito a `double` para los numéricos.
    if (this.enumCompatible(actual, pattern)) return true;
    if (isArrayType(pattern) && isArrayType(actual)) return this.tryInferType(arrayElement(pattern), arrayElement(actual), parameters, substitutions);
    if (isTupleType(pattern) && isTupleType(actual)) {
      const expected = tupleElements(pattern); const received = tupleElements(actual);
      return expected.length === received.length && expected.every((item, index) => this.tryInferType(item, received[index], parameters, substitutions));
    }
    if (isFunctionType(pattern) && isFunctionType(actual)) {
      const expected = functionParameters(pattern); const received = functionParameters(actual);
      return expected.length === received.length && expected.every((item, index) => this.tryInferType(item, received[index], parameters, substitutions)) && this.tryInferType(functionResult(pattern), functionResult(actual), parameters, substitutions);
    }
    if (isGenericType(pattern) && isGenericType(actual) && genericBase(pattern) === genericBase(actual)) {
      const expected = genericArguments(pattern); const received = genericArguments(actual);
      return expected.length === received.length && expected.every((item, index) => this.tryInferType(item, received[index], parameters, substitutions));
    }
    return this.satisfiesInterface(actual, pattern);
  }
  private resolveClass(type: TypeName): { owner: ClassDeclaration; substitutions: Map<string, TypeName> } | undefined {
    // `Mut<T>` y `MutRef<T>` son modificadores: se resuelven al tipo base T.
    if (isGenericType(type)) {
      const base = genericBase(type);
      if (base === "Mut" || base === "MutRef") {
        const inner = genericArguments(type)[0];
        if (inner) return this.resolveClass(inner);
      }
    }
    const base = isGenericType(type) ? genericBase(type) : type; const owner = this.classes.get(base);
    if (!owner) return undefined;
    const substitutions = new Map<string, TypeName>(); const arguments_ = isGenericType(type) ? genericArguments(type) : [];
    owner.typeParameters.forEach((parameter, index) => { if (arguments_[index]) substitutions.set(parameter.name, arguments_[index]); });
    return { owner, substitutions };
  }

  /**
   * Devuelve true si el tipo del parámetro es `Mut<T>` o `MutRef<T>`.
   * En ese caso el parámetro es una referencia mutable (T* o T& en C++)
   * y debe permitirse la asignación a sus campos.
   */
  private parameterIsMutableReference(type: TypeName): boolean {
    // V22 (Memory Model v2): solo `ref<T>` (T&) es mutable por referencia.
    // `ptr<T>` y `constPtr<T>` no se modifican directamente (se usa `move()`
    // para transferir ownership). `constRef<T>` y `readonly<T>` son inmutables.
    if (isReadonlyType(type)) return false;
    if (!isGenericType(type)) return false;
    return genericBase(type) === "ref";
  }
  private substituteType(type: TypeName, substitutions: Map<string, TypeName>): TypeName {
    return this.substituteTypeInternal(type, substitutions, new Set());
  }

  // Variante interna de `substituteType` que también expande alias. Mantiene
  // `visited` para detectar ciclos a través de cadenas de alias (p. ej.
  // `type A = B; type B = A`) y para evitar bucle en expansiones recursivas.
  private substituteTypeInternal(type: TypeName, substitutions: Map<string, TypeName>, visited: Set<string>): TypeName {
    // Alias simple: `type X = ...`. Reemplaza por el RHS y recurre.
    const alias = this.aliases.get(type);
    if (alias) {
      if (visited.has(type)) return type;
      visited.add(type);
      return this.substituteTypeInternal(alias.type, substitutions, visited);
    }
    // Instanciación de alias genérico: `type Box<T> = T[]` usado como `Box<U>`.
    if (isGenericType(type)) {
      const base = genericBase(type);
      const aliasInstance = this.aliases.get(base);
      if (aliasInstance) {
        if (visited.has(base)) return type;
        visited.add(base);
        const args = genericArguments(type);
        const subs = new Map<string, TypeName>();
        aliasInstance.typeParameters.forEach((parameter, index) => { if (args[index]) subs.set(parameter.name, args[index]); });
        return this.substituteTypeInternal(aliasInstance.type, subs, visited);
      }
    }
    if (substitutions.has(type)) return substitutions.get(type)!;
    if (isUnionType(type)) return unionMembers(type).map(member => this.substituteTypeInternal(member, substitutions, visited)).join(" | ");
    if (isIntersectionType(type)) return intersectionMembers(type).map(member => this.substituteTypeInternal(member, substitutions, visited)).join(" & ");
    if (isArrayType(type)) return arrayType(this.substituteTypeInternal(arrayElement(type), substitutions, visited));
    if (isTupleType(type)) return tupleType(tupleElements(type).map(item => this.substituteTypeInternal(item, substitutions, visited)));
    if (isFunctionType(type)) return functionType(functionParameters(type).map(item => this.substituteTypeInternal(item, substitutions, visited)), this.substituteTypeInternal(functionResult(type), substitutions, visited));
    if (isGenericType(type)) return genericType(genericBase(type), genericArguments(type).map(item => this.substituteTypeInternal(item, substitutions, visited)));
    return type;
  }

  // Expande un tipo hasta su forma canónica (sin alias ni `typeof`). Usado por
  // los sitios que almacenan el tipo en el símbolo (`VariableDeclaration`) o lo
  // devuelven al usuario (`IdentifierExpression`), donde tanto el alias como
  // la marca `typeof X` deben desaparecer para que el resto del análisis
  // trabaje contra tipos reales. `scope` es opcional: sin él, las marcas
  // `typeof X` se devuelven tal cual (p.ej. durante `expandAliasesInProgram`,
  // antes de entrar a un ámbito).
  private expandType(type: TypeName, scope?: Scope): TypeName {
    const visited = new Set<string>();
    let current = type;
    while (true) {
      // V4: los arrays fijos tienen caches indexados por nombre canónico en
      // type-system.ts. expandType() puebla el cache aquí para que el
      // type-checker pueda detectar `T[N]` antes de pasar por validateType.
      const fixedMatch = current.match(/^([^\s\[\]]+)\[(\d+)\]$/);
      if (fixedMatch) {
        registerFixedArray(fixedMatch[1], Number(fixedMatch[2]));
      }
      const alias = this.aliases.get(current);
      if (alias) {
        if (visited.has(current)) break;
        visited.add(current);
        current = alias.type;
        continue;
      }
      if (isGenericType(current)) {
        const base = genericBase(current);
        const aliasInstance = this.aliases.get(base);
        if (aliasInstance) {
          if (visited.has(base)) break;
          visited.add(base);
          const args = genericArguments(current);
          const subs = new Map<string, TypeName>();
          aliasInstance.typeParameters.forEach((parameter, index) => { if (args[index]) subs.set(parameter.name, args[index]); });
          current = this.substituteType(aliasInstance.type, subs);
          continue;
        }
      }
      if (isTypeofType(current) && scope) {
        const name = typeofTarget(current);
        const sym = scope.resolve(name);
        if (!sym) break;
        if (sym.kind === "variable" || sym.kind === "type") { current = sym.type; continue; }
        break;
      }
      break;
    }
    return current;
  }
  private withTypeParameters(parameters: TypeParameter[], action: () => void): void {
    const previous = this.activeTypeParameters; const previousConstraints = this.activeTypeConstraints; const previousDefaults = this.activeTypeDefaults;
    const names = parameters.map(parameter => parameter.name);
    const entries = parameters.filter(parameter => parameter.constraint).map(parameter => [parameter.name, parameter.constraint] as const);
    const defaults = parameters.filter(parameter => parameter.default).map(parameter => [parameter.name, parameter.default] as const);
    this.activeTypeParameters = new Set([...previous, ...names]);
    this.activeTypeConstraints = new Map([...previousConstraints, ...entries]);
    this.activeTypeDefaults = new Map([...previousDefaults, ...defaults]);
    action();
    this.activeTypeParameters = previous; this.activeTypeConstraints = previousConstraints; this.activeTypeDefaults = previousDefaults;
  }
  private report(node: { span: import("../core/span.ts").Span }, message: string): void;
  private report(node: { span: import("../core/span.ts").Span }, message: string, hint?: string, notes?: string[]): void;
  private report(node: { span: import("../core/span.ts").Span }, message: string, hint?: string, notes?: string[]): void {
    const diagnostic: import("../core/diagnostic.ts").Diagnostic = { phase: "semantic", message, span: node.span };
    if (hint) diagnostic.hint = hint;
    if (notes) diagnostic.notes = notes;
    this.diagnostics.push(diagnostic);
  }
  /** Sugiere un nombre cercano (distancia Levenshtein ≤ 2) para errores tipo
   *  "Símbolo no definido 'X'". Devuelve el mensaje de hint o undefined si
   *  no encuentra candidato razonable. */
  private suggestSimilar(name: string, candidates: Iterable<string>): string | undefined {
    let best: { candidate: string; distance: number } | undefined;
    for (const candidate of candidates) {
      const distance = levenshtein(name, candidate);
      if (distance <= 2 && (!best || distance < best.distance)) best = { candidate, distance };
    }
    return best ? `¿Quisiste decir '${best.candidate}'?` : undefined;
  }

  // V1.4: analiza una condición de IfStatement buscando un patrón de
  // narrowing de tagged union: `expr.tag op literal`. Devuelve el nombre
  // de la expresión, su tipo union, el operador y el discriminador.
  // Si no encaja, devuelve undefined.
  private parseNarrowingCondition(
    condition: Expression,
    scope: Scope,
  ): { name: string; unionType: TypeName; discriminator: { field: string; value: string | number | boolean } } | undefined {
    if (condition.kind !== "BinaryExpression") return undefined;
    if (!["==", "===", "!=", "!=="].includes(condition.operator)) return undefined;
    // Forma esperada: `expr.tag op literal`. El lado izquierdo debe ser
    // `MemberExpression` con object = IdentifierExpression.
    const memberAccess = condition.left.kind === "MemberExpression" ? condition.left : condition.right.kind === "MemberExpression" ? condition.right : undefined;
    const literalSide = condition.left.kind === "MemberExpression" ? condition.right : condition.left;
    if (!memberAccess || memberAccess.kind !== "MemberExpression") return undefined;
    if (memberAccess.object.kind !== "IdentifierExpression") return undefined;
    const exprName = memberAccess.object.name;
    const exprType = scope.resolve(exprName);
    if (!exprType || exprType.kind !== "variable") return undefined;
    // El tipo puede ser el union directamente (e.g. `Result<number>`) o
    // un wrapper genérico del union sintético (e.g. `Result<T,E>`).
    // En ambos casos, el union base es lo que buscamos.
    const unionType = isGenericType(exprType.type) ? genericBase(exprType.type) : exprType.type;
    if (!this.unions.has(unionType)) return undefined;
    // Extraer literal del lado derecho.
    if (literalSide.kind !== "LiteralExpression") return undefined;
    let literalValue: string | number | boolean;
    if (literalSide.literalType === "string") literalValue = String(literalSide.value);
    else if (literalSide.literalType === "number") literalValue = Number(literalSide.value);
    else if (literalSide.literalType === "boolean") literalValue = Boolean(literalSide.value);
    else return undefined;
    return { name: exprName, unionType, discriminator: { field: memberAccess.member, value: literalValue } };
  }

  // V1.4: variantes de un union cuyo discriminador coincide con el literal.
  // Si la unión no tiene discriminador declarado, devuelve undefined
  // (no se puede narrowar de forma segura).
  private variantsMatchingDiscriminator(
    unionType: TypeName,
    discriminator: { field: string; value: string | number | boolean },
  ): string[] | undefined {
    const union = this.unions.get(unionType);
    if (!union) return undefined;
    const matching = union.variants.filter(v => v.discriminator && v.discriminator.field === discriminator.field && v.discriminator.value === discriminator.value);
    if (matching.length === 0) return undefined;
    return matching.map(v => v.name);
  }

  // V1.4: variantes que NO cumplen el discriminador (para el else).
  private variantsExcludingDiscriminator(
    unionType: TypeName,
    discriminator: { field: string; value: string | number | boolean },
  ): string[] | undefined {
    const union = this.unions.get(unionType);
    if (!union) return undefined;
    const matching = union.variants.filter(v => v.discriminator && v.discriminator.field === discriminator.field && v.discriminator.value === discriminator.value);
    return union.variants.filter(v => !matching.includes(v)).map(v => v.name);
  }
}
