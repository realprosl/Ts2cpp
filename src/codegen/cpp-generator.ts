import type { Program, Statement, Expression, TypeName, FunctionDeclaration, InterfaceDeclaration, ClassDeclaration, ClassMethod, BlockStatement, ExpressionStatement, VariableDeclaration, EnumDeclaration, UnionDeclaration, UnionVariant, TypeParameter, CallExpression } from "../ast/nodes.ts";
import { cppType, collectTypeParameterNames, registerExternalType, clearExternalTypes } from "./cpp-types.ts";
import { cppParameterDeclaration } from "./cpp-parameters.ts";
import { arrayElement, fixedArrayElement, fixedArraySize, functionParameters, functionResult, genericArguments, genericBase, intersectionMembers, isArrayType, isFixedArrayType, isFunctionType, isGenericType, isIntersectionType, isMapType, isNumericType, isPromiseType, isSetType, isTupleType, isUnionType, promiseResult, tupleElements, unionMembers } from "../types/type-system.ts";
import { HELPER_METADATA } from "../semantic/helpers.ts";

// V16: nombres de funciones runtime que requieren `ets_runtime_full.hpp`
// (cualquier programa que las use debe arrastrar `ets_async.hpp` y
// posiblemente `ets_net.hpp`). El codegen decide incluir el header
// completo cuando detecta uno de estos símbolos en el AST.
const ASYNC_NETWORK_FUNCTIONS = new Set([
  "spawn", "sleep", "cancel", "cancellationToken",
  "createCancellation", "isCancelled", "ioUringAvailable",
  "tcpListen", "tcpAccept", "tcpConnect", "tcpRead", "tcpWrite", "tcpClose",
  "readTcp", "readTcpUntil", "writeTcp", "writeTcpUntil", "acceptTcp", "acceptTcpUntil", "listenTcp", "closeTcp",
]);

// Genera el lado derecho de una cláusula `requires`: `Concept<P>` (intersección ->
// `Concept1<P> && Concept2<P>`). Las restricciones concept siempre se aplican al
// parámetro declarado, no a un `T` fijo.
function cppRequires(type: TypeName, parameter: TypeName): string {
  if (isIntersectionType(type)) return intersectionMembers(type).map(member => `${cppType(member)}<${parameter}>`).join(" && ");
  return `${cppType(type)}<${parameter}>`;
}

export class CppGenerator {
  private indent = 0;
  private readonly interfaceNames = new Set<string>();
  private readonly classNames = new Set<string>();
  // Mapa nombre → declaración, para que el codegen de NewExpression
  // (y futuras piezas) pueda resolver la firma del constructor o el
  // orden de los campos aggregate sin re-escanear el programa.
  private readonly classesByName = new Map<string, ClassDeclaration>();
  private readonly aliasNames: Set<string> = new Set();
  private readonly enumNames: Set<string> = new Set();
  private readonly enumUnderlying = new Map<string, "number" | "string">();
  private readonly unionNames: Set<string> = new Set();
  private readonly unionsMap: Map<string, UnionDeclaration> = new Map();
  // V30.12.2: auto-unions sintetizados para `Array<Interface>`. Cada
  // interface que aparece como elemento de un array tiene un union con las
  // clases concretas que tengan campo `kind: string`.
  private readonly autoUnions: Map<string, UnionDeclaration> = new Map();
  // Conjunto de interfaces cuyo auto-union ya se emitió en este archivo
  // (header / module / single-TU). Evita redeclaraciones.
  private readonly autoUnionsEmitted: Set<string> = new Set();
  // Interfaces que necesitan auto-union porque algún tipo `Array<I>`
  // aparece en el programa (detectado en `prepare()`).
  private readonly interfacesNeedingAutoUnion: Set<string> = new Set();
  // Mapa de funciones top-level indexadas por nombre, usado para rellenar
  // argumentos opcionales omitidos en call sites con `optionalNone<T>()`.
  private readonly topLevelFunctions = new Map<string, FunctionDeclaration[]>();
  private readonly expressionType: (node: Expression) => TypeName | undefined;
  private readonly expressionIsVariadic: (node: Expression) => boolean;
  private readonly callTypeArguments: (node: Expression) => TypeName[];
  // V16: en modo minimal (`--minimal`), el codegen no incluye
  // `ets_io.hpp` en el header. El usuario es responsable de usar
  // `std::cout` directamente o incluir el header por su cuenta.
  public minimal = false;
  // V18: librería(s) C++ externa(s) que el CLI pasará a g++.
  // Configurable desde `estatic.config.ts` con `libraries: { raylib: { link: "-lraylib" } }`
  // o desde decoradores `@cpp_link("-lraylib")` en el .lib.ets.
  public linkFlags: string[] = [];
  // V18: headers externos solicitados por decoradores/config (ej. `#include "raylib.h"`).
  public externalHeaders: string[] = [];
  // V17: Set dinámico de headers requeridos por los nodos AST emitidos.
  // Cada nodo que necesita un include (lambda → <functional>, union →
  // <variant>, lambda captura → <functional>, etc.) lo añade aquí. Al
  // final del generate, emitimos los includes acumulados en lugar de
  // adivinarlos globalmente. Esto permite un binario más pequeño porque
  // un programa con un Optional<T> no paga por todo <variant>/<concepts>.
  private readonly _requiredHeaders = new Set<string>();
  // V18: nombre CPP exacto al que se traduce un símbolo del dialecto. Se
  // puebla desde los decoradores `@cpp_name("InitWindow")` que aparecen
  // sobre funciones, métodos o variables del programa o del header.
  private readonly _cppNames = new Map<string, string>();
  // V18: alias de tipos CPP (`@cpp_type("Vector2")`).
  private readonly _cppTypes = new Map<string, string>();
  // V18: link flags adicionales (decorador `@cpp_link("-lraylib")` o
  // `libraries` en el config). El CLI los añade al comando g++.
  private readonly _linkFlags = new Set<string>();
  // V18: headers adicionales solicitados por declaraciones decoradas.
  // Igual que `_requiredHeaders` pero para los que aporta el config de
  // librerías o el decorador `@cpp_header("raylib.h")`.
  private readonly _externalHeaders = new Set<string>();
  private requiredIncludes() { return this._requiredHeaders; }
  // Helper para registrar un header (idempotente, lo añade al set). El
  // valor guardado es la forma completa `#include <xxx>` para que la
  // lista final del .cpp no necesite post-procesado.
  private requireHeader(name: string): void {
    const trimmed = name.startsWith("#include") ? name : `#include ${name}`;
    this._requiredHeaders.add(trimmed);
  }
  // Recorre un subárbol AST y registra headers requeridos. Llamado antes
  // de emitir declaraciones que usan tipos complejos.
  private collectRequiredHeadersForStatement(stmt: Statement): void {
    const visit = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      const obj = n as { kind?: string; capturedSymbols?: unknown[]; optional?: boolean; elementType?: unknown; declaredType?: unknown; returnType?: unknown; type?: unknown; method?: string; object?: unknown };
      // Discriminated unions (UnionDeclaration): necesitan <variant>.
      if (obj.kind === "UnionDeclaration") this.requireHeader("<variant>");
      // Lambdas / FunctionType / capturas: necesitan <functional>.
      if (obj.kind === "FunctionType" || obj.kind === "LambdaExpression" || obj.kind === "ClosureExpression") this.requireHeader("<functional>");
      if (Array.isArray(obj.capturedSymbols) && obj.capturedSymbols.length > 0) this.requireHeader("<functional>");
      // Optional<T>: vive en ets_optional.hpp (incluido por ets_runtime.hpp).
      if (obj.kind === "MatchExpression" || obj.kind === "MatchStatement") this.requireHeader("<variant>");
      // await re-visita el operando (ya cubierto por el visitor recursivo).
      for (const key of Object.keys(n)) {
        const child = (n as Record<string, unknown>)[key];
        if (Array.isArray(child)) for (const item of child) visit(item);
        else if (child && typeof child === "object") visit(child);
      }
    };
    visit(stmt);
  }
  private inClassMethod = false;
  private currentClassMethodParams: string[] = [];
  private inStaticInit = false;
  private inAsyncFunction = false;
  // V30.12.1: true mientras se emite el callback de un `when`/`whenType`/`otherwise`
  // dentro de `emitNewMatch`. Hace que las lambdas anidadas capturen `this` por
  // referencia (`[&, this]`) en lugar de por valor (`[=, this]`), evitando
  // "passing const T as 'this' argument discards qualifiers" cuando el método
  // exterior fue marcado `const` pero el callback llama a métodos no-const de
  // `this` (p.ej. `apply(m).match(m, "kind", [when("drawLine", (x)=>this.modX(x.x))])`).
  private inMatchCallback = false;
  // V8.0: tipo declarado del retorno de la función actual. Se setea en
  // `function()` antes de emitir el cuerpo y se restaura al salir.
  // `undefined` cuando no estamos dentro de una función.
  private currentReturn: TypeName | undefined = undefined;
  // V28: AST raiz del programa que estamos emitiendo. Necesario para
  // helpers como `usesHttpServer` que se llaman desde `includes()` sin
  // acceso directo al programa.
  private currentProgram: Program | undefined = undefined;
  // Renombrados de variables que colisionan con singletons globales del runtime
  // (`console`, `fs`, `path`, `process`, `JSON`). Se prefijan con `ets_local_`
  // en C++ para evitar la colisión con `inline ets_path path{}` etc. Las
  // referencias en el código generado se reescriben al pasar por `cppName`.
  // V0.2: las colisiones con singletons del runtime (console, fs, path,
  // process, JSON) se detectan ahora en el type-checker y se anotan en el
  // AST con `fromRuntime`. El codegen consulta ese flag directamente; este
  // Set queda eliminado.
  private readonly localRenames = new Map<string, string>();
  // Map de alias introducidos por `export { x as y }` para que el codegen
  // resuelva `y` al símbolo original `x`. Se rellena desde type-checker.
  private readonly exportAliases = new Map<string, string>();
  // V22: tipos inferidos de los identificadores locales (nombre → TypeName).
  // Permite al codegen decidir entre `.` y `->` en member access cuando el
  // tipo es `ptr<T>`.
  // V30.14.1: resolver de type aliases (pasado por el TypeChecker).
  // Usado para expandir type arguments en generic types.
  private resolveTypeAlias: ((name: string) => string | undefined) | undefined;
  // V30.14.2: callback para resolver un union literal (`Line | Circle`)
  // de vuelta a su nombre de type alias original (`SvgChild`). Usado por
  // `cppT` cuando el type-checker ya expandio el alias.
  private resolveUnionAliasName?: (union: TypeName) => string | undefined;
  // V30.14.2: variables top-level cuyo tipo es un auto-union de type alias.
  // Se emiten como `static <Union>` (default-init) en el header y la
  // inicializacion real va al bloque `ets_init_*()` (despues de los
  // globals). Asi evitamos problemas de orden de inicializacion con
  // `make_X` y el std::variant del auto-union.
  private _deferredInitVars: { variable: VariableDeclaration; cppName: string; initializer: string }[] | undefined = undefined;
  private readonly identifierTypes = new Map<string, TypeName>();
  private destructuringCounter = 0;
  constructor(expressionType?: (node: Expression) => TypeName | undefined, expressionIsVariadic?: (node: Expression) => boolean, callTypeArguments?: (node: Expression) => TypeName[], resolveTypeAlias?: (name: string) => string | undefined, resolveUnionAliasName?: (union: TypeName) => string | undefined) {
    this.expressionType = expressionType ?? (() => undefined); this.expressionIsVariadic = expressionIsVariadic ?? (() => false);
    this.callTypeArguments = callTypeArguments ?? (() => []);
    this.resolveTypeAlias = resolveTypeAlias;
    this.resolveUnionAliasName = resolveUnionAliasName;
  }
  // Devuelve el nombre C++ para un identificador del programa. Si fue renombrado
  // por colisión con un global del runtime, devuelve el nombre prefijado.
  // V3: emite la representación textual de un operando numérico para uso en
  // expresiones binarias aritméticas/de comparación. Si el operando es un
  // tipo numérico concreto (i8..u64, f32, f64), lo envuelve en `static_cast<double>`;
  // si es `number` lo deja tal cual. Si es otro tipo, lo emite sin tocar (el
  // type-checker garantiza que llegamos aquí solo con operandos válidos).
  private numericOperandAsDouble(node: Expression): string {
    const text = this.emitExpression(node);
    const type = this.expressionType(node);
    if (type && isNumericType(type)) return `static_cast<double>(${text})`;
    return text;
  }
  // V3: ambos operandos son de la familia numérica (number o numérico concreto).
  private sameNumericExprType(left: Expression, right: Expression): boolean {
    const lType = this.expressionType(left);
    const rType = this.expressionType(right);
    if (!lType || !rType) return false;
    const leftNum = lType === "number" || isNumericType(lType);
    const rightNum = rType === "number" || isNumericType(rType);
    return leftNum && rightNum;
  }
  private resolveAlias(name: string): string { return this.exportAliases.get(name) ?? name; }
  private cppName(name: string): string {
    // V18: si el nombre tiene un alias CPP externo (decorador
    // `@cpp_name("InitWindow")`), resolvemos al nombre C++ exacto.
    // Si no, caemos al renombre local (de colisión con runtime).
    const aliased = this._cppNames.get(name);
    if (aliased) return aliased;
    return this.localRenames.get(name) ?? name;
  }
  /** V15: setup del generador a partir del AST combinado del programa. */
  prepareModules(program: Program): void {
    // V18: el primer prepare (llamado una sola vez por `compileFile`) limpia
    // los sets de link/include para empezar de cero. Las llamadas internas
    // (desde `generateHeader`/`generateModule`) NO limpian — preservan los
    // `@link`/`@include` recogidos del AST combinado.
    this._linkFlags.clear();
    this._externalHeaders.clear();
    this.prepare(program);
  }
  prepare(program: Program): void {
    // `export default` envuelve una declaración; el dialecto es single-
    // translation-unit, así que la declaración se procesa como si fuera
    // top-level directa. Unwrap para que `prepare` la vea igual que las demás.
    const unwrap = (stmt: Statement): Statement => stmt.kind === "ExportDefaultDeclaration" ? unwrap(stmt.declaration as Statement) : stmt;
    const unwrapped = program.statements.map(unwrap);
    const interfaces = unwrapped.filter((s): s is InterfaceDeclaration => s.kind === "InterfaceDeclaration");
    const classes = unwrapped.filter((s): s is ClassDeclaration => s.kind === "ClassDeclaration");
    this.interfaceNames.clear(); interfaces.forEach(contract => this.interfaceNames.add(contract.name));
    this.classNames.clear(); classes.forEach(node => this.classNames.add(node.name));
    this.classesByName.clear();
    for (const node of classes) this.classesByName.set(node.name, node);
    this.aliasNames.clear();
    this.enumNames.clear();
    this.enumUnderlying.clear();
    this.topLevelFunctions.clear();
    for (const stmt of unwrapped) {
      if (stmt.kind === "TypeAliasDeclaration") this.aliasNames.add(stmt.name);
      if (stmt.kind === "EnumDeclaration") { this.enumNames.add(stmt.name); this.enumUnderlying.set(stmt.name, stmt.underlying); }
      if (stmt.kind === "UnionDeclaration") { this.unionNames.add(stmt.name); this.unionsMap.set(stmt.name, stmt); }
      if (stmt.kind === "FunctionDeclaration") {
        const list = this.topLevelFunctions.get(stmt.name) ?? [];
        list.push(stmt);
        this.topLevelFunctions.set(stmt.name, list);
      }
    }
    this.indent = 0;
    // V18: pre-pasada de decoradores para popular `_cppNames`, `_cppTypes`,
    // `_linkFlags` y `_externalHeaders`. Esto se hace en prepare() para que
    // `generate()` y `generateHeader()` consulten los mapas al emitir.
    // NO limpiamos los sets aquí — `prepare()` se llama múltiples veces
    // (una por `generateModule()`, más una por el header). Si limpiamos
    // cada vez, perdemos los `@include`/`@link` de los `.lib.ets` que no
    // son el módulo actual. En su lugar, el primer `prepare()` los limpia
    // (eso es `prepareModules`).
    this._cppNames.clear();
    this._cppTypes.clear();
    clearExternalTypes();
    const argValue = (decorator: { name: string; args: Expression[] }, index: number): string | undefined => {
      const arg = decorator.args[index];
      if (!arg || arg.kind !== "LiteralExpression" || arg.literalType !== "string") return undefined;
      const v = (arg as Extract<Expression, { kind: "LiteralExpression" }>).value;
      return typeof v === "string" ? v : undefined;
    };
    for (const stmt of unwrapped) {
      if (stmt.kind === "FunctionDeclaration" && stmt.decorators) {
        for (const dec of stmt.decorators) {
          const v = argValue(dec, 0);
          if (dec.name === "cpp_name" && v) this._cppNames.set(stmt.name, v);
        }
      }
      if (stmt.kind === "ModuleHeaderDeclaration" && stmt.decorators) {
        // V18: el `.lib.ets` declara a nivel de archivo qué librería C/C++
        // estamos enlazando. Cada archivo `.lib.ets` representa UNA librería,
        // así que `@link`/`@include` se declaran una sola vez en el header
        // del archivo, no por función.
        for (const dec of stmt.decorators) {
          const v = argValue(dec, 0);
          if (dec.name === "link" && v) this._linkFlags.add(v);
          if (dec.name === "include" && v) {
            // Si el usuario puso `<stdio.h>` o `"stdio.h"` lo respetamos;
            // si puso `stdio.h` sin delimitadores, asumimos `<stdio.h>`
            // (header estándar) y lo emitimos como `#include <stdio.h>`.
            let header = v.trim();
            if (!header.startsWith("<") && !header.startsWith('"')) header = `<${header}>`;
            if (!header.startsWith("#include")) header = `#include ${header}`;
            this._externalHeaders.add(header);
          }
        }
      }
      if (stmt.kind === "InterfaceDeclaration" && stmt.decorators) {
        for (const dec of stmt.decorators) {
          const v = argValue(dec, 0);
          if (dec.name === "cpp_type" && v) { this._cppTypes.set(stmt.name, v); registerExternalType(stmt.name, v); }
        }
        // Decoradores a nivel método (alias de funciones de la interface).
        for (const method of stmt.methods) {
          if (!method.decorators) continue;
          for (const dec of method.decorators) {
            const v = argValue(dec, 0);
            if (dec.name === "cpp_name" && v) this._cppNames.set(`${stmt.name}.${method.name}`, v);
          }
        }
      }
    }
    // V18: vuelco los sets al final de la pre-pasada para que el CLI/builder
    // pueda leer `linkFlags` y `externalHeaders` tras `prepare()`.
    this.linkFlags = Array.from(this._linkFlags);
    this.externalHeaders = Array.from(this._externalHeaders);
    // Escaneamos el programa para detectar alias de export (`export { x as y }`)
    // y registrarlos en `exportAliases` para que el codegen los resuelva.
    this.exportAliases.clear();
    for (const stmt of unwrapped) if (stmt.kind === "ExportNamedDeclaration") for (const spec of stmt.specifiers) if (spec.alias) this.exportAliases.set(spec.alias, spec.name);
    // V30.12.2: detectar interfaces usadas en `Array<I>` y construir el
    // union auto-generado con las clases concretas que tengan `kind: string`.
    this.interfacesNeedingAutoUnion.clear();
    // V30.14.2: limpiar tambien el set de type aliases union y la cola
    // de init diferido (entre módulos no deben acumularse).
    this.typeAliasesNeedingUnion.clear();
    if (this._deferredInitVars) this._deferredInitVars.length = 0;
    this.collectInterfacesNeedingAutoUnion(unwrapped);
    this.buildAutoUnions();
  }
  // V16: visitor genérico que detecta si el programa contiene un
  // `CallExpression` o `MemberCallExpression` cuyo nombre (callee o
  // método) está en `targets`. Reemplaza las antiguas detecciones basadas
  // en regex sobre `JSON.stringify(program)`, que eran propensas a falsos
  // positivos por literales de string conteniendo esos nombres.
  private usesAnyCall(program: Program, targets: Set<string>): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; callee?: unknown; method?: unknown };
      if ((obj.kind === "CallExpression" && typeof obj.callee === "string" && targets.has(obj.callee)) ||
          (obj.kind === "MemberCallExpression" && typeof obj.method === "string" && targets.has(obj.method))) return true;
      for (const key of Object.keys(node)) {
        if (key === "callee" || key === "method") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  private usesTls(program: Program): boolean {
    return this.usesAnyCall(program, new Set([
      "createTlsServer", "acceptTls", "readTls", "writeTls", "closeTls",
      "TlsContext", "TcpConnection",
    ]));
  }
  private usesCompilerAst(program: Program): boolean {
    return this.usesAnyCall(program, new Set([
      "validateSyntax", "syntaxTreeJson", "syntaxTreeRecords",
      "estaticAstRecords", "estaticTypedAstJson", "estaticTypedAstRecords",
    ]));
  }
  private usesFilesystem(program: Program): boolean {
    return this.usesAnyCall(program, new Set([
      "fileRead", "fileWrite", "fileAppend", "fileExists",
      "fileCopy", "fileMove", "fileRemove",
      // V26: factory del lector streaming. Tambien requiere
      // runtime/ets_file.hpp (donde esta declarado FileReader).
      "openFileReader",
    ]));
  }
  private usesNetworking(program: Program): boolean {
    return this.usesAnyCall(program, new Set([
      "tcpListen", "tcpAccept", "tcpConnect", "tcpRead", "tcpWrite", "tcpClose",
      "etsNetSyncEcho", "etsNetSyncLarge",
    ]));
  }
  // V28: detecta `http.createServer()` para incluir el header del server.
  // Tambien detecta `server.listen(...)` y metodos del Server. Lo separamos
  // de `usesAnyCall` porque `get`/`post` son nombres demasiado genericos
  // para estar en un set plano (falsos positivos con `arr.get(...)` etc).
  private usesHttpServer(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; object?: { kind?: string; type?: string; name?: string }; method?: string };
      if (obj.kind === "MemberCallExpression") {
        if (obj.object?.kind === "IdentifierExpression" && obj.object.name === "http" && obj.method === "createServer") return true;
      }
      for (const key of Object.keys(node)) {
        if (key === "callee") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }

  // V28: devuelve el backend HTTP a usar segun el decorator @cpp_drogon
  // sobre la declaracion `let server: Server = http.createServer()`.
  // Sin decorator: "httplib" (default). Con @cpp_drogon: "drogon".
  private httpBackend(program: Program): "httplib" | "drogon" {
    let found = "httplib" as "httplib" | "drogon";
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; name?: string; declaredType?: { name?: string } | string; decorators?: { name: string }[] };
      // declaredType es un string (TypeName) no un objeto.
      const typeName = typeof obj.declaredType === "string"
        ? obj.declaredType
        : obj.declaredType?.name;
      if (obj.kind === "VariableDeclaration"
          && obj.name === "server"
          && typeName === "Server"
          && obj.decorators?.some(d => d.name === "cpp_drogon")) {
        found = "drogon";
        return true;
      }
      for (const key of Object.keys(node)) {
        if (key === "callee") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    visit(program);
    return found;
  }
  // V28: detecta si el programa usa el cliente HTTP (http.get / http.post).
  // Igual patron que usesHttpServer, pero para los nombres de metodo del
  // cliente. Si lo encuentra, fuerza el include de runtime/ets_http_client.hpp.
  private usesHttpClient(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; object?: { kind?: string; type?: string; name?: string }; method?: string };
      if (obj.kind === "MemberCallExpression") {
        if (obj.object?.kind === "IdentifierExpression" && obj.object.name === "http" && (obj.method === "get" || obj.method === "post")) return true;
      }
      for (const key of Object.keys(node)) {
        if (key === "callee") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  // V30.1: detecta si el programa usa timers (setTimeout/setInterval/
  // cancelTimer). Si lo encuentra, fuerza el include de
  // runtime/ets_timer.hpp. Mismo patron que usesHttpClient.
  // Importante: en el AST, CallExpression.callee es un STRING
  // (no un IdentifierExpression node), asi que se compara directo.
  private usesTimer(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; callee?: unknown };
      if (obj.kind === "CallExpression" && typeof obj.callee === "string") {
        if (obj.callee === "setTimeout" || obj.callee === "setInterval" || obj.callee === "cancelTimer") return true;
      }
      for (const key of Object.keys(node)) {
        if (key === "callee") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  // V30.2: detecta si el programa usa filesystem watchers
  // (watchFs/unwatchFs). Si lo encuentra, fuerza el include
  // de runtime/ets_fs_watcher.hpp.
  private usesFsWatcher(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; callee?: unknown };
      if (obj.kind === "CallExpression" && typeof obj.callee === "string") {
        if (obj.callee === "watchFs" || obj.callee === "unwatchFs") return true;
      }
      for (const key of Object.keys(node)) {
        if (key === "callee") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  // V30.4: detecta si un statement es una call expression a `main`
  // (ExpressionStatement con callee === "main"). El codegen
  // renombra la funcion a `ets_user_main` (ver generate()) para
  // evitar colision con la funcion global, asi que aqui
  // comparamos contra el nombre original.
  private isMainCallExpression(statement: unknown): boolean {
    if (!statement || typeof statement !== "object") return false;
    const obj = statement as { kind?: string; expression?: { kind?: string; callee?: unknown } };
    return obj.kind === "ExpressionStatement" &&
      obj.expression !== undefined &&
      obj.expression.kind === "CallExpression" &&
      obj.expression.callee === "main";
  }
  // V30.2: detecta si el programa usa setInterval (no setTimeout,
  // porque setTimeout el callback ya dispara y termina solo).
  // Si lo encuentra, el codegen anyade ets::defaultEventLoop.run()
  // al final del main para que el loop siga vivo mientras el
  // callback se ejecuta periodicamente.
  private usesSetInterval(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; callee?: unknown };
      if (obj.kind === "CallExpression" && typeof obj.callee === "string") {
        if (obj.callee === "setInterval") return true;
      }
      for (const key of Object.keys(node)) {
        if (key === "callee") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  // V30.4: detecta si el main del programa es async (Promise<void>).
  // Si lo es, el codegen anyade ets::defaultEventLoop.run() al final
  // del main para que el event loop siga vivo mientras la coroutine
  // main se ejecuta. Sin esto, el main retorna antes de que las
  // awaits (resolveDns, etc.) se completen.
  private mainIsAsync(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; async?: boolean; name?: string; returnType?: unknown };
      if (obj.kind === "FunctionDeclaration" && obj.async === true && obj.name === "main") {
        return true;
      }
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  // V7: detecta si el programa usa los helpers de colecciones sobre `T[]`
  // (`arr.filter`, `arr.map`, `arr.reduce`). Recorremos el AST buscando
  // `MemberCallExpression` cuyo método es uno de los tres. Solo lo hacemos
  // para evitar el `#include` cuando no se usa (los templates no penalizan
  // tiempo de compilación si quedan sin instanciar, pero los headers
  // crecen y el include explícito documenta la dependencia).
  private usesCollections(program: Program): boolean {
    const target = new Set(["filter", "map", "reduce", "forEach", "find", "some", "every", "slice", "sort", "flatMap", "concat", "includes", "push"]);
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; method?: string; object?: unknown; args?: unknown[]; body?: unknown; statements?: unknown[]; init?: unknown; condition?: unknown; increment?: unknown; thenBranch?: unknown; elseBranch?: unknown; expression?: unknown; target?: unknown; iterable?: unknown; value?: unknown; operand?: unknown; left?: unknown; right?: unknown; binding?: unknown; initializer?: unknown; declarations?: unknown[]; arms?: unknown[]; subject?: unknown; parts?: unknown[]; expressions?: unknown[]; elements?: unknown[]; params?: unknown[]; typeParameters?: unknown[]; specifiers?: unknown[]; declaration?: unknown; variants?: unknown[]; members?: unknown[]; fields?: unknown[]; methods?: unknown[] };
      if (obj.kind === "MemberCallExpression" && obj.method && target.has(obj.method)) return true;
      for (const key of Object.keys(obj)) {
        const child = obj[key as keyof typeof obj];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  // V0.3/V4: regex pre-existente para detectar helpers runtime (filesystem/
  // networking). V4 introduce usesFixedArrays por visitor: recorremos las
  // declaraciones de tipo buscando `T[N]` con N literal. NO usamos regex
  // sobre el AST — el helper `isFixedArrayType` consulta los caches
  // poblados por el type-checker (type-system.ts), no strings del AST.
  // V9.1: nuevo visitor `usesIoUringAsync` que detecta llamadas a
  // `asyncIoUringRead` / `asyncIoUringWrite` (también via visitor, sin regex).
  // Limitación actual: solo inspecciona expresiones top-level y dentro de
  // bloques simples. V0.3 ampliará esto cuando los includes migren a visitor
  // genérico.
  private usesIoUringAsync(program: Program): boolean {
    const visitExpr = (node: Expression): boolean => {
      switch (node.kind) {
        case "CallExpression":
          if (node.callee === "asyncIoUringRead" || node.callee === "asyncIoUringWrite") return true;
          return node.args.some(arg => visitExpr(arg));
        case "MemberCallExpression":
          if (node.method === "asyncIoUringRead" || node.method === "asyncIoUringWrite") return true;
          return visitExpr(node.object) || node.args.some(arg => visitExpr(arg));
        case "AwaitExpression": return visitExpr(node.operand);
        case "BinaryExpression": return visitExpr(node.left) || visitExpr(node.right);
        case "UnaryExpression": return visitExpr(node.operand);
        case "MemberExpression": return visitExpr(node.object);
        case "AssignmentExpression": return visitExpr(node.value);
        case "ArrayLiteralExpression":
          return node.elements.some(item => item.kind === "SpreadElement" ? visitExpr(item.expression) : visitExpr(item));
        case "IndexExpression": return visitExpr(node.object) || visitExpr(node.index);
        case "TemplateLiteralExpression": return node.expressions.some(visitExpr);
        case "TernaryExpression": return visitExpr(node.condition) || visitExpr(node.thenBranch) || visitExpr(node.elseBranch);
        case "SatisfiesExpression": return visitExpr(node.operand);
        case "MatchExpression": return visitExpr(node.subject) || node.arms.some(arm => visitExpr(arm.pattern) || visitExpr(arm.result));
        default: return false;
      }
    };
    const visitBlock = (block: BlockStatement): boolean => {
      for (const node of block.statements) {
        switch (node.kind) {
          case "ExpressionStatement": if (visitExpr(node.expression)) return true; break;
          case "VariableDeclaration": if (visitExpr(node.initializer)) return true; break;
          case "ReturnStatement": if (node.value && visitExpr(node.value)) return true; break;
          case "IfStatement":
            if (visitExpr(node.condition)) return true;
            if (node.thenBranch.kind === "BlockStatement" && visitBlock(node.thenBranch)) return true;
            if (node.elseBranch && node.elseBranch.kind === "BlockStatement" && visitBlock(node.elseBranch)) return true;
            break;
          case "WhileStatement":
            if (visitExpr(node.condition)) return true;
            if (node.body.kind === "BlockStatement" && visitBlock(node.body)) return true;
            break;
          case "ForStatement":
            if (node.initializer && visitExpr(node.initializer.kind === "VariableDeclaration" ? node.initializer.initializer : node.initializer.expression)) return true;
            if (node.condition && visitExpr(node.condition)) return true;
            if (node.increment && visitExpr(node.increment)) return true;
            if (node.body.kind === "BlockStatement" && visitBlock(node.body)) return true;
            break;
          case "ForOfStatement":
            if (visitExpr(node.iterable)) return true;
            if (node.body.kind === "BlockStatement" && visitBlock(node.body)) return true;
            break;
          case "ForInStatement":
            if (visitExpr(node.target)) return true;
            if (node.body.kind === "BlockStatement" && visitBlock(node.body)) return true;
            break;
          case "BlockStatement":
            if (visitBlock(node)) return true;
            break;
          case "FunctionDeclaration":
            if (visitBlock(node.body)) return true;
            break;
          }
      }
      return false;
    };
    const syntheticProgram: BlockStatement = { kind: "BlockStatement", statements: program.statements, span: program.span };
    return visitBlock(syntheticProgram);
  }
  private usesFixedArrays(program: Program): boolean {
    const visit = (type: TypeName): boolean => {
      if (isFixedArrayType(type)) return true;
      if (isGenericType(type)) return genericArguments(type).some(visit);
      if (isArrayType(type)) return visit(arrayElement(type));
      if (isTupleType(type)) return tupleElements(type).some(visit);
      if (isFunctionType(type)) return visit(functionResult(type)) || functionParameters(type).some(visit);
      if (isUnionType(type)) return unionMembers(type).some(visit);
      return false;
    };
    for (const stmt of program.statements) {
      if (stmt.kind === "VariableDeclaration" && stmt.declaredType && visit(stmt.declaredType)) return true;
      if (stmt.kind === "FunctionDeclaration" && (visit(stmt.returnType) || stmt.params.some(p => visit(p.type)))) return true;
      if (stmt.kind === "ClassDeclaration" && (stmt.fields.some(f => visit(f.type)) || stmt.methods.some(m => visit(m.returnType) || m.params.some(p => visit(p.type))))) return true;
      if (stmt.kind === "InterfaceDeclaration" && (stmt.methods.some(m => visit(m.returnType) || m.params.some(p => visit(p.type))))) return true;
      if (stmt.kind === "TypeAliasDeclaration" && visit(stmt.type)) return true;
    }
    return false;
  }
  private usesUnions(program: Program): boolean { return program.statements.some(s => s.kind === "UnionDeclaration"); }
  // V30.12.2: nombre C++ del auto-union de una interface. El sufijo
  // `_AutoUnion` es estable — `emitNewMatch` lo consulta para detectar
  // si el subject de un match es un auto-union.
  private autoUnionName(interfaceName: string): string { return `${interfaceName}_AutoUnion`; }
  // V30.14.2: type aliases que necesitan auto-union (no solo interfaces).
  // `type X = A | B` (sin ser un array) genera un `X_Union` struct
  // con la misma semantica que el `_AutoUnion` de las interfaces.
  private typeAliasesNeedingUnion: Set<string> = new Set();
  private typeAliasUnionName(aliasName: string): string { return `${aliasName}_Union`; }
  private typeAliasUnionKey(aliasName: string): string { return `__typealias_${aliasName}`; }
  // V30.14.2: type alias union name helper (consulta el `resolveUnionAliasName`
  // para resolver una union expandida a su nombre de type alias).
  private typeAliasUnionType(typeName: TypeName | undefined): TypeName | undefined {
    if (!typeName) return undefined;
    if (isUnionType(typeName) && this.resolveUnionAliasName) {
      const alias = this.resolveUnionAliasName(typeName);
      if (alias && this.typeAliasesNeedingUnion.has(alias)) return this.typeAliasUnionName(alias);
    }
    if (typeof typeName === "string" && this.typeAliasesNeedingUnion.has(typeName)) return this.typeAliasUnionName(typeName);
    return undefined;
  }
  // V30.14.2: helper unificado para resolver un tipo a su representacion
  // C++ post-union-expansion. Cubre: `Array<I>` (auto-union), `type X = A | B`
  // (union alias), `Array<typeAlias>` (expand + array), y fallback a
  // `cppType` estatico.
  private cppT(type: TypeName | undefined): string {
    if (!type) return "void";
    const ta = this.typeAliasUnionType(type);
    if (ta) return ta;
    if (isGenericType(type) && genericBase(type) === "Array") {
      const arg = genericArguments(type)[0];
      if (arg) {
        const argExpanded = this.typeAliasUnionType(arg);
        if (argExpanded) return `std::vector<${argExpanded}>`;
      }
    }
    return cppType(type);
  }
  // V30.14.2: detecta si el type es un auto-union (interface o type alias).
  // Usado por `NewExpression` y `AssignmentExpression` para envolver
  // con `make_X(...)` cuando el target lo requiere.
  private isAutoUnionTarget(type: TypeName | undefined): boolean {
    if (!type) return false;
    if (this.interfaceNames.has(type) && this.interfacesNeedingAutoUnion.has(type)) return true;
    if (typeof type === "string" && this.typeAliasesNeedingUnion.has(type)) return true;
    if (isUnionType(type) && this.resolveUnionAliasName) {
      const alias = this.resolveUnionAliasName(type);
      if (alias && this.typeAliasesNeedingUnion.has(alias)) return true;
    }
    return false;
  }
  // V30.15: dado un type, devuelve el UnionDeclaration del auto-union
  // correspondiente. Usado por `emitNewMatch` para narrowar el subject.
  // Acepta: nombre de interface auto-union (`SvgChild`), type-alias
  // union (`SvgChild` o el type expandido `Line | Circle`).
  private findAutoUnionForType(type: TypeName | undefined): UnionDeclaration | undefined {
    if (!type) return undefined;
    // Direct lookup en el map de auto-unions (interface path).
    if (typeof type === "string" && this.autoUnions.has(type)) return this.autoUnions.get(type);
    // Type-alias union path: el type puede ser el alias name o la expansion.
    if (typeof type === "string" && this.typeAliasesNeedingUnion.has(type)) {
      const key = this.typeAliasUnionKey(type);
      return this.autoUnions.get(key);
    }
    // V30.15: `typeOf` puede retornar el union SIN espacios
    // (`Line|Circle`) mientras que el map se lleno CON espacios
    // (`Line | Circle`). Chequeamos con un test laxo.
    if (typeof type === "string" && type.includes("|") && this.resolveUnionAliasName) {
      const alias = this.resolveUnionAliasName(type)
        ?? this.resolveUnionAliasName(type.replace(/\|/g, " | ") as TypeName)
        ?? this.resolveUnionAliasName(type.replace(/ \| /g, "|") as TypeName);
      if (alias && this.typeAliasesNeedingUnion.has(alias)) {
        return this.autoUnions.get(this.typeAliasUnionKey(alias));
      }
    }
    return undefined;
  }
  // V30.12.2: dada un nombre de tipo, es el nombre del auto-union de
  // una interface registrada en este programa? Se consulta desde
  // `emitNewMatch`.
  private isAutoUnionType(typeName: TypeName | undefined): boolean {
    if (!typeName) return false;
    for (const name of this.autoUnions.keys()) if (this.autoUnionName(name) === typeName) return true;
    // V30.14.2: type aliases tambien pueden ser auto-unions.
    for (const alias of this.typeAliasesNeedingUnion) if (this.typeAliasUnionName(alias) === typeName) return true;
    return false;
  }
  // V30.12.2: recorre los `declaredType` de variables y los tipos de
  // campos de clase/interface para encontrar interfaces I tales que
  // aparece `I[]` (o `Array<I>`). El dialecto no tiene sintaxis
  // explícita `implements`, así que después, en `buildAutoUnions`,
  // decidimos qué clases implementan cada interface.
  private collectInterfacesNeedingAutoUnion(statements: Statement[]): void {
    const visit = (type: TypeName | undefined): void => {
      if (!type) return;
      if (isArrayType(type)) {
        const inner = arrayElement(type);
        if (this.interfaceNames.has(inner)) this.interfacesNeedingAutoUnion.add(inner);
        return;
      }
      if (isGenericType(type) && genericBase(type) === "Array") {
        const arg = genericArguments(type)[0];
        if (arg && this.interfaceNames.has(arg)) this.interfacesNeedingAutoUnion.add(arg);
      }
    };
    for (const stmt of statements) {
      if (stmt.kind === "VariableDeclaration" && stmt.declaredType) visit(stmt.declaredType);
      if (stmt.kind === "ClassDeclaration") for (const field of stmt.fields) visit(field.type);
      if (stmt.kind === "InterfaceDeclaration") for (const field of stmt.fields) visit(field.type);
      // V30.14.2: parametros de funciones y returns tambien pueden
      // requerir auto-union. `function f(x: SvgChild)` debe despachar
      // igual que `let c: SvgChild`.
      if (stmt.kind === "FunctionDeclaration") {
        for (const p of stmt.params) visit(p.type);
        if (stmt.returnType) visit(stmt.returnType);
      }
      // V30.14.2: `let c: SvgChild` (SvgChild es type alias) tambien
      // necesita un auto-union. Detectamos el caso: el type-checker
      // expandio el alias a `Line | Circle` antes de llegar aqui, asi
      // que tenemos que consultar el mapa inverso.
      if (stmt.kind === "VariableDeclaration" && stmt.declaredType) {
        if (isUnionType(stmt.declaredType) && this.resolveUnionAliasName) {
          const alias = this.resolveUnionAliasName(stmt.declaredType);
          if (alias) {
            // V30.14.4: solo registramos el alias si TODAS las variantes
            // son clases del dialecto. Para uniones con tipos built-in
            // (e.g. `type Maybe = string | number`), el auto-union no
            // tiene sentido (no podemos hacer `make_string` sobre
            // std::string porque no tiene `kind` field).
            const expansion = this.resolveTypeAlias?.(alias);
            if (expansion && isUnionType(expansion)) {
              const variants = unionMembers(expansion);
              if (variants.every(v => this.classesByName.has(v))) {
                this.typeAliasesNeedingUnion.add(alias);
              }
            }
          }
        }
        // V30.14.2: si el type es directamente un nombre de type alias
        // registrado (no expandido), lo añadimos tambien.
        if (typeof stmt.declaredType === "string" && this.aliasNames.has(stmt.declaredType)) {
          if (this.resolveTypeAlias) {
            const expansion = this.resolveTypeAlias(stmt.declaredType);
            if (expansion && isUnionType(expansion)) {
              const variants = unionMembers(expansion);
              if (variants.every(v => this.classesByName.has(v))) {
                this.typeAliasesNeedingUnion.add(stmt.declaredType);
              }
            }
          }
        }
      }
      // V30.14.2: parametros de funciones con tipo type alias union.
      if (stmt.kind === "FunctionDeclaration") {
        for (const p of stmt.params) {
          if (typeof p.type === "string" && this.aliasNames.has(p.type) && this.resolveTypeAlias) {
            const expansion = this.resolveTypeAlias(p.type);
            if (expansion && isUnionType(expansion)) {
              // V30.14.4: solo si todas las variantes son clases.
              const variants = unionMembers(expansion);
              if (variants.every(v => this.classesByName.has(v))) {
                this.typeAliasesNeedingUnion.add(p.type);
              }
            }
          }
        }
      }
    }
  }
  // V30.12.2: sintetiza un `UnionDeclaration` por cada interface en
  // `interfacesNeedingAutoUnion`. Una clase cuenta como "implementadora"
  // si tiene campo `kind: string`. Se ordenan alfabéticamente para
  // emisión determinista. El union NO se emite aquí — solo se registra;
  // la emisión ocurre en `emitAutoUnionDeclarations()`.
  private buildAutoUnions(): void {
    const taggedClasses = Array.from(this.classesByName.values())
      .filter(cls => cls.fields.some(field => field.name === "kind" && field.type === "string"))
      .map(cls => cls.name)
      .sort();
    for (const ifaceName of this.interfacesNeedingAutoUnion) {
      if (this.autoUnions.has(ifaceName)) continue;
      const variants = taggedClasses.map((className): UnionVariant => ({
        name: className,
        payload: className,
        span: { start: { offset: 0, line: 0, column: 0 }, end: { offset: 0, line: 0, column: 0 } },
      }));
      const union: UnionDeclaration = {
        kind: "UnionDeclaration",
        name: this.autoUnionName(ifaceName),
        typeParameters: [],
        variants,
        span: { start: { offset: 0, line: 0, column: 0 }, end: { offset: 0, line: 0, column: 0 } },
      };
      this.autoUnions.set(ifaceName, union);
    }
    // V30.14.2: registra tambien cada type alias union como un auto-union
    // con prefijo `__typealias_`. La estructura es identica al caso
    // interface, pero el struct emite `kind: std::string` + `_kindIndex`
    // (campo privado) en vez de `kind: enum` solo.
    for (const aliasName of this.typeAliasesNeedingUnion) {
      const key = this.typeAliasUnionKey(aliasName);
      if (this.autoUnions.has(key)) continue;
      if (!this.resolveTypeAlias) continue;
      const expansion = this.resolveTypeAlias(aliasName);
      if (!expansion || !isUnionType(expansion)) continue;
      const variants = unionMembers(expansion).map((name): UnionVariant => {
        // V30.14.2: el type-checker marca `union_alias::SvgChild` en las
        // clases que son parte de un union type-alias. Filtramos por
        // este sentinel.
        return { name, payload: name, span: { start: { offset: 0, line: 0, column: 0 }, end: { offset: 0, line: 0, column: 0 } } };
      });
      const union: UnionDeclaration = {
        kind: "UnionDeclaration",
        name: this.typeAliasUnionName(aliasName),
        typeParameters: [],
        variants,
        span: { start: { offset: 0, line: 0, column: 0 }, end: { offset: 0, line: 0, column: 0 } },
      };
      this.autoUnions.set(key, union);
    }
  }
  // V30.13: emite los auto-unions pendientes. Se llama una vez por
  // archivo (header, module, single-TU), tras los unions del usuario
  // y antes de las clases (los payloads referencian tipos de clase).
  private emitAutoUnionDeclarations(): string[] {
    const out: string[] = [];
    for (const [key, union] of this.autoUnions) {
      if (this.autoUnionsEmitted.has(key)) continue;
      // V30.14.2: si el key es un type alias (empieza con __typealias_),
      // el comentario es distinto y los forwarded methods se extraen
      // de la primera variante (no de una interface, que no existe).
      const isTypeAlias = key.startsWith("__typealias_");
      // V30.14.2: para interfaces, usar `methodsForInterface` (que lee
      // los metodos del InterfaceDeclaration); para type aliases usar
      // `forwardedMethodsForTypeAlias` (que los extrae de las clases).
      const forwardedMethods = isTypeAlias
        ? this.forwardedMethodsForTypeAlias(key)
        : this.methodsForInterface(key);
      const comment = isTypeAlias
        ? `// V30.14.2: auto-union generado para type alias ${key.slice("__typealias_".length)}.`
        : `// V30.12.2: auto-union generado para Array<${key}>.`;
      out.push(comment, this.unionDeclaration(union, forwardedMethods, isTypeAlias), "");
      this.autoUnionsEmitted.add(key);
    }
    return out;
  }
  // V30.14.2: forwarded methods para el auto-union de un type alias.
  // Se extraen de las clases payload: la interseccion de los metodos
  // que tienen TODAS las variantes con la misma firma.
  private forwardedMethodsForTypeAlias(key: string): { name: string; returnType: string; params: { name: string; type: string }[] }[] {
    if (!key.startsWith("__typealias_")) return [];
    const union = this.autoUnions.get(key);
    if (!union) return [];
    for (const variant of union.variants) {
      const cls = this.classesByName.get(variant.payload ?? "");
      if (!cls) continue;
      return cls.methods
        .filter(m => m.name !== "constructor")
        .map(m => ({
          name: m.name,
          returnType: cppType(m.returnType ?? "void"),
          params: m.params.map(p => ({ name: p.name, type: cppType(p.type) })),
        }));
    }
    return [];
  }
  // V30.13: lee los métodos de una interface declarada en el programa.
  // Usado para emitir dispatch automático en el struct del auto-union.
  private methodsForInterface(ifaceName: string): { name: string; returnType: string; params: { name: string; type: string }[] }[] {
    if (!this.currentProgram) return [];
    for (const stmt of this.currentProgram.statements) {
      if (stmt.kind === "InterfaceDeclaration" && stmt.name === ifaceName) {
        return stmt.methods.map(method => ({
          name: method.name,
          returnType: cppType(method.returnType),
          params: method.params.map(p => ({ name: p.name, type: cppType(p.type) })),
        }));
      }
    }
    return [];
  }
  // V30.13: emite forward declarations de los auto-unions. Se usa ANTES
  // de las definiciones de clase para que un campo tipo
  // `Array<Interface>` (que se traduce a `std::vector<I_AutoUnion>`)
  // pueda mencionarlo sin requerir el ordenamiento topológico estricto.
  // La definición completa (con `std::variant`) se emite DESPUÉS con
  // `emitAutoUnionDeclarations()`.
  private emitAutoUnionForwardDeclarations(): string[] {
    const out: string[] = [];
    for (const [, union] of this.autoUnions) {
      out.push(`struct ${union.name};`);
    }
    return out;
  }
  // V30.12.2: traduce el tipo del elemento de un array. Si es una
  // interface registrada con auto-union, devuelve el nombre del
  // auto-union. Si es una interface sin auto-union, lanza error claro.
  private arrayElementCppType(elementType: TypeName): string {
    // V30.14.1: expandir type aliases primero (e.g. `SvgChild` -> `Line | MultiLine`).
    const expanded = this.expandTypeInCodegen(elementType);
    // V30.14.1: union types (provenientes de `type X = A | B` o `A | B` directo)
    // se traducen a `std::variant<...>` directamente, sin auto-union. Es
    // mas simple que la interface, pero funciona end-to-end.
    if (isUnionType(expanded)) return cppType(expanded);
    if (this.interfaceNames.has(expanded)) {
      const union = this.autoUnions.get(expanded);
      if (!union) throw new Error(`Array<${expanded}>: la interface ${expanded} no tiene clases concretas con campo \`kind: string\` para generar el auto-union. Define una clase \`class ${expanded}_Impl { kind: string; ... }\` o usa un tipo concreto.`);
      if (union.variants.length === 0) throw new Error(`Array<${expanded}>: la interface ${expanded} no tiene variantes en su auto-union (ninguna clase concreta con campo \`kind: string\`).`);
      return this.autoUnionName(expanded);
    }
    return cppType(expanded);
  }
  // V30.12.2: tipo C++ de un array, sustituyendo el elemento si es
  // una interface registrada.
  private arrayCppType(type: TypeName): string {
    // V30.14.1: expandir aliases en el type argument (e.g. `Array<SvgChild>`
    // donde `type SvgChild = Line | MultiLine`).
    if (isArrayType(type)) {
      const elem = arrayElement(type);
      const expanded = this.expandTypeInCodegen(elem);
      return `std::vector<${this.arrayElementCppType(expanded)}>`;
    }
    if (isGenericType(type) && genericBase(type) === "Array") {
      const arg = genericArguments(type)[0];
      if (arg) {
        const expanded = this.expandTypeInCodegen(arg);
        return `std::vector<${this.arrayElementCppType(expanded)}>`;
      }
    }
    return cppType(type);
  }
  // V30.14.1: helper para expandir type aliases en el codegen. Si el
  // tipo es un alias conocido, lo expande recursivamente. Esto es
  // necesario porque `expandAliasesInProgram` del type-checker no
  // desciende en generic types (e.g. `Array<SvgChild>` queda como
  // `Array<SvgChild>`, no `Array<Line | MultiLine>`).
  private expandTypeInCodegen(type: TypeName): TypeName {
    if (!this.resolveTypeAlias) return type;
    // Expansion recursiva con deteccion de ciclos.
    const visited = new Set<string>();
    let current = type;
    while (true) {
      // Si es un generic type, expandir el type argument
      if (isGenericType(current)) {
        const base = genericBase(current);
        const args = genericArguments(current);
        if (args.length > 0) {
          const expandedArgs = args.map(arg => this.expandTypeInCodegen(arg));
          current = `${base}<${expandedArgs.join(", ")}>`;
          // break despues de reconstruir para evitar bucle infinito
          // (e.g. `Array<number>` -> `Array<number>`).
          break;
        }
      }
      // Si es un tipo simple, ver si es un alias
      if (visited.has(current)) break;
      visited.add(current);
      const resolved = this.resolveTypeAlias(current);
      if (!resolved) break;
      current = resolved;
    }
    return current;
  }
  // V1.3: dado un TypeName resuelto por el type-checker, devuelve la
  // UnionDeclaration si representa una tagged union declarada en el
  // programa. Usa los helpers de `type-system.ts` (`isGenericType` +
  // `genericBase`) en lugar de parsear strings manualmente: el dialecto
  // no admite regex ni string-matching mágico, solo operaciones sobre la
  // representación estructurada del tipo.
  private unionFromType(type: TypeName): UnionDeclaration | undefined {
    const base = isGenericType(type) ? genericBase(type) : type;
    return this.unionsMap.get(base);
  }
  // V16: detecta si el programa usa APIs estilo Node que viven en
  // `ets_runtime_full.hpp` (filesystem struct, process struct, path
  // struct, JSON, async/Task/Result, net). Activan la inclusión de
  // `ets_runtime_full.hpp` para arrastrar ets_async.hpp, ets_file.hpp,
  // ets_net.hpp, etc.
  private usesNodeGlobals(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; object?: unknown; callee?: unknown; method?: unknown; type?: unknown; declaredType?: unknown; returnType?: unknown; elementType?: unknown; expressions?: unknown[]; name?: unknown };
      const objName = (n: unknown): string | undefined => {
        if (typeof n === "string") return n;
        if (n && typeof n === "object") {
          const o = n as { kind?: string; name?: unknown };
          if (o.kind === "IdentifierExpression" && typeof o.name === "string") return o.name;
        }
        return undefined;
      };
      // `process.argv()`, `fs.readFile(...)`, `path.join(...)`,
      // `JSON.stringify(...)` se emiten como MemberCallExpression con
      // `object` siendo un IdentifierExpression (no string).
      if (obj.kind === "MemberCallExpression" || obj.kind === "MemberExpression") {
        const name = objName(obj.object);
        if (name === "fs" || name === "process" || name === "path" || name === "JSON" || name === "console") return true;
      }
      // `console.log(...)` también requiere el header completo (usa `ets_console`).
      if (obj.kind === "MemberCallExpression" && objName(obj.object) === "console") return true;
      // `await` implica runtime async (Task, spawn, sleep).
      if (obj.kind === "AwaitExpression") return true;
      // Llamadas a funciones async conocidas (spawn, sleep, cancel,
      // cancellationToken, acceptTcp, readTcp, writeTcp, listenTcp,
      // closeTcp, etc.) requieren ets_async.hpp.
      if (obj.kind === "CallExpression" && typeof obj.callee === "string" && ASYNC_NETWORK_FUNCTIONS.has(obj.callee)) return true;
      // Tipos que requieren ets_async.hpp: Task<T>, Result<T>, Promise<T>,
      // CancellationToken, TcpListener, TcpStream, IpcStream. El
      // type-checker expone `nodeType`/`declaredType`/`returnType` con
      // strings como "Task<double>", "Result<int>".
      const typeStr = (obj.type ?? obj.declaredType ?? obj.returnType ?? obj.elementType) as unknown;
      if (typeof typeStr === "string" && /^(?:Task|Result|Promise|CancellationToken|TcpListener|TcpStream|IpcStream)<.*>$/.test(typeStr)) return true;
      for (const key of Object.keys(node)) {
        if (key === "object") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  // V16: includes selectivos. Solo se incluyen los headers que el programa
  // realmente necesita (detectados por visitor). Los headers base
  // (`<iostream>`, `<string>`, `<vector>`) se incluyen casi siempre porque
  // `print` y `console.log` son muy comunes. `<functional>` se incluye
  // cuando hay lambdas (closures, captures) o colecciones que las usan.
  private includes(usesTls: boolean, usesCompilerAst: boolean, usesFilesystem: boolean, usesNetworking: boolean, usesUnions: boolean, usesFixedArrays: boolean, usesCollections: boolean, usesIoUringAsync: boolean, usesNodeGlobals: boolean, usesFunctional: boolean): string[] {
    return [
      "#include <iostream>",
      "#include <string>",
      "#include <vector>",
      ...(usesCollections || usesFilesystem || usesNodeGlobals ? ["#include <functional>"] : []),
      ...(usesFunctional && !usesCollections && !usesFilesystem && !usesNodeGlobals ? ["#include <functional>"] : []),
      ...(usesCollections ? ["#include <cmath>"] : []),
      ...(usesUnions ? ["#include <concepts>", "#include <variant>", "#include <type_traits>"] : []),
      ...(usesFixedArrays ? ["#include <array>"] : []),
      ...(usesFilesystem || usesNetworking ? ["#include <tuple>"] : []),
      ...(usesNetworking ? ["#include <utility>"] : []),
      usesNodeGlobals ? "#include \"runtime/ets_runtime_full.hpp\"" : (this.minimal ? "#include \"runtime/ets_runtime_minimal.hpp\"" : "#include \"runtime/ets_runtime.hpp\""),
      ...(usesCollections ? ["#include \"runtime/ets_collections.hpp\""] : []),
      ...(usesCompilerAst ? ["#include \"runtime/ets_ast.hpp\""] : []),
      ...(usesTls ? ["#include \"runtime/ets_tls.hpp\""] : []),
      ...(usesFilesystem ? ["#include \"runtime/ets_file.hpp\""] : []),
      ...(usesNetworking ? ["#include \"runtime/ets_net_sync.hpp\""] : []),
      // V28: backend HTTP server. Default = cpp-httplib. Con decorator
      // @cpp_drogon sobre `let server: Server = http.createServer()`,
      // emitimos el wrapper de Drogon (PR #151) en lugar de httplib (PR #150).
      ...(this.currentProgram !== undefined && this.usesHttpServer(this.currentProgram)
          ? [this.httpBackend(this.currentProgram) === "drogon"
                ? "#include \"runtime/ets_http_drogon.hpp\""
                : "#include \"runtime/ets_http_httplib.hpp\""]
          : []),
      // V29: cliente HTTP sobre libcurl (sustituye al TCP plano de V28).
      // libcurl nos da HTTPS, HTTP/2, redirects, timeouts, decompression
      // built-in. Ver runtime/ets_http_curl_client.hpp.
      // V30.3: para await http.get/post, se incluye tambien el wrapper async
      // (runtime/ets_http_curl_async.hpp) que usa BlockingAwaiter + worker
      // thread. El include se hace siempre que el programa use el cliente;
      // el wrapper async define httpClientGetAsync/Post que retornan
      // Task<Result<HttpClientResponse>> y se usan con `co_await`.
      ...(this.currentProgram !== undefined && this.usesHttpClient(this.currentProgram) ? ["#include \"runtime/ets_http_curl_async.hpp\""] : []),
      // V30.1: timers sobre libuv. Ver runtime/ets_timer.hpp.
      ...(this.currentProgram !== undefined && this.usesTimer(this.currentProgram) ? ["#include \"runtime/ets_timer.hpp\""] : []),
      // V30.2: filesystem watchers sobre libuv. Ver runtime/ets_fs_watcher.hpp.
      ...(this.currentProgram !== undefined && this.usesFsWatcher(this.currentProgram) ? ["#include \"runtime/ets_fs_watcher.hpp\""] : []),
      // V30.4: DNS async sobre uv_getaddrinfo. Ver runtime/ets_dns.hpp.
      ...(this.currentProgram !== undefined && this.usesDns(this.currentProgram) ? ["#include \"runtime/ets_dns.hpp\""] : []),
      ...(usesIoUringAsync ? ["#include \"runtime/ets_io_uring.hpp\"", "#include \"runtime/ets_io_uring_async.hpp\""] : []),
    ];
  }
  // V30.4: detecta si el programa usa resolveDns(). Si lo encuentra,
  // fuerza el include de runtime/ets_dns.hpp. Patron identico a
  // usesTimer/usesHttpClient. CallExpression.callee es un STRING
  // (no un IdentifierExpression node).
  private usesDns(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; callee?: unknown };
      if (obj.kind === "CallExpression" && typeof obj.callee === "string") {
        if (obj.callee === "resolveDns") return true;
      }
      for (const key of Object.keys(node)) {
        if (key === "callee") continue;
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  // V16: detecta si el programa tiene alguna lambda (FunctionType, captura,
  // closures). Esto fuerza la inclusión de `<functional>`.
  private usesFunctional(program: Program): boolean {
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const obj = node as { kind?: string; type?: unknown; capturedSymbols?: unknown[]; singleUseSite?: unknown };
      if (obj.kind === "FunctionType" || obj.kind === "LambdaExpression" || obj.kind === "ClosureExpression") return true;
      if (Array.isArray(obj.capturedSymbols) && obj.capturedSymbols.length > 0) return true;
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (Array.isArray(child)) { for (const item of child) if (visit(item)) return true; }
        else if (child && typeof child === "object") { if (visit(child)) return true; }
      }
      return false;
    };
    return visit(program);
  }
  generate(program: Program): string {
    this.currentProgram = program;
    // `export default` envuelve una declaración; hacemos unwrap para que el
    // dialecto (single-translation-unit) las procese como top-level directas.
    const unwrap = (stmt: Statement): Statement => stmt.kind === "ExportDefaultDeclaration" ? unwrap(stmt.declaration as Statement) : stmt;
    const unwrapped = { ...program, statements: program.statements.map(unwrap) };
    const functions = unwrapped.statements.filter((s): s is FunctionDeclaration => s.kind === "FunctionDeclaration");
    const interfaces = unwrapped.statements.filter((s): s is InterfaceDeclaration => s.kind === "InterfaceDeclaration");
    const classes = unwrapped.statements.filter((s): s is ClassDeclaration => s.kind === "ClassDeclaration");
    const enums = unwrapped.statements.filter((s): s is EnumDeclaration => s.kind === "EnumDeclaration");
    const unions = unwrapped.statements.filter((s): s is UnionDeclaration => s.kind === "UnionDeclaration");
    this.prepare(unwrapped);
    const topLevelVariables = unwrapped.statements.filter((s): s is VariableDeclaration => s.kind === "VariableDeclaration");
    const topLevelOther = unwrapped.statements.filter(s =>
      s.kind !== "FunctionDeclaration" && s.kind !== "InterfaceDeclaration" &&
      s.kind !== "ClassDeclaration" && s.kind !== "VariableDeclaration" &&
      s.kind !== "TypeAliasDeclaration" && s.kind !== "EnumDeclaration" &&
      s.kind !== "UnionDeclaration" &&
      s.kind !== "ExportNamedDeclaration"
    );
    // V17: pre-pasada para acumular headers requeridos por cada statement.
    // Cada statement declara qué include(s) necesita (union → <variant>,
    // lambda → <functional>, match → <variant>, etc.). Esto es mucho más
    // granular que el `usesX` global, que solo mira el AST entero.
    this._requiredHeaders.clear();
    for (const stmt of unwrapped.statements) this.collectRequiredHeadersForStatement(stmt);
    // Mezcla con los headers derivados por los visitors globales (los
    // `usesTls`/`usesFilesystem` siguen siendo útiles para headers runtime).
    // Filtramos duplicados contra los ya añadidos por `includes()`.
    const baseIncludes = this.includes(this.usesTls(program), this.usesCompilerAst(program), this.usesFilesystem(program), this.usesNetworking(program), this.usesUnions(program), this.usesFixedArrays(program), this.usesCollections(program), this.usesIoUringAsync(program), this.usesNodeGlobals(program), this.usesFunctional(program));
    const baseSet = new Set(baseIncludes);
    const stdHeaderFromRequired = Array.from(this._requiredHeaders).filter(h => !baseSet.has(h));
    const lines = ["// Generated by estatic-ts-cpp. Do not edit.\n// V17: includes granularizados por statement (AST-aware).", ...baseIncludes, ...stdHeaderFromRequired, ""];
    for (const contract of interfaces) lines.push(this.interfaceConcept(contract), "");
    for (const node of enums) lines.push(this.enumDeclaration(node), "");
    for (const node of unions) lines.push(this.unionDeclaration(node), "");
    // V30.12.3: emitir las definiciones de clase en orden topológico para
    // que cada clase esté completa cuando otra la mencione por valor.
    // Sin esto, `class Holder { a: A }` antes de `class A { x: i8 }` hace
    // que g++ se queje con "field 'a' has incomplete type 'A'".
    // V30.12.2: forward decls de clase ANTES del auto-union (los payloads
    // son tipos de clase concretos).
    const singleClassOrder = this.topoSortClasses(classes);
    if (singleClassOrder.cyclicNames.length) this.reportClassCycle(singleClassOrder.cyclicNames);
    // V30.13: forward decls de clase para romper referencias circulares.
    for (const node of singleClassOrder.ordered) lines.push(this.classForward(node, false), "");
    // V30.13: forward decls de los auto-unions ANTES de cualquier clase
    // para que un campo tipo `Array<Interface>` (que se traduce a
    // `std::vector<I_AutoUnion>`) compile cuando la clase aparece antes
    // que la interface en el AST.
    for (const line of this.emitAutoUnionForwardDeclarations()) lines.push(line);
    // V30.13: emisión intercalada de clases y auto-unions para respetar
    // el orden topológico extendido. Una clase con campo `Array<Interface>`
    // depende del auto-union (que a su vez depende de los payload classes).
    // El patrón esperado es:
    //   1. clases que NO usan auto-unions (en orden topológico)
    //   2. auto-unions (sus dependencias son los payload classes, ya emitidos)
    //   3. clases que SÍ usan auto-unions (en orden topológico)
    // No podemos meter los auto-unions dentro del `topoSortClasses` (no
    // son ClassDeclaration), así que partimos la lista en dos. La detección
    // es por inspección de los campos de cada clase.
    const usesAutoUnion = new Set<string>();
    for (const cls of classes) {
      for (const field of cls.fields) {
        let element: TypeName | undefined;
        if (isArrayType(field.type)) element = arrayElement(field.type);
        else if (isGenericType(field.type) && genericBase(field.type) === "Array") element = genericArguments(field.type)[0];
        if (element && this.autoUnions.has(element)) { usesAutoUnion.add(cls.name); break; }
      }
    }
    const classesPre = singleClassOrder.ordered.filter(node => !usesAutoUnion.has(node.name));
    const classesPost = singleClassOrder.ordered.filter(node => usesAutoUnion.has(node.name));
    // Fase 1: clases que NO usan auto-unions.
    for (const node of classesPre) lines.push(this.classDeclaration(node), "");
    // Fase 2: auto-unions (necesitan los payloads completos, ya emitidos).
    for (const line of this.emitAutoUnionDeclarations()) lines.push(line);
    // Fase 3: clases que usan auto-unions (necesitan los auto-unions
    // completos, ya emitidos).
    for (const node of classesPost) lines.push(this.classDeclaration(node), "");
    for (const fn of functions) {
      // V30.4: renombrar `main` -> `ets_user_main` en la forward
      // declaration.
      if (fn.name === "main") {
        const renamed = { ...fn, name: "ets_user_main" };
        lines.push(this.signature(renamed) + ";");
      } else {
        lines.push(this.signature(fn) + ";");
      }
    }
    if (functions.length) lines.push("");
    // Declaramos las variables top-level a nivel de archivo (con internal linkage) para
    // que cualquier función declarada después pueda verlas. La inicialización ocurre en
    // la fase de static init, así que tipos sin constructor por defecto (Result, etc.)
    // siguen funcionando porque la inicialización forma parte de la declaración.
    // Separamos las top-level: las que tienen destructuring se emiten en main()
// (no son static-init válidas), el resto va al bloque de static init.
    const simpleTopLevel = topLevelVariables.filter(variable => !variable.arrayBindings || variable.arrayBindings.length === 0);
    const destructuringTopLevel = topLevelVariables.filter(variable => !!variable.arrayBindings && variable.arrayBindings.length > 0);
    for (const variable of simpleTopLevel) {
      const type = variable.declaredType ?? this.expressionType(variable.initializer) ?? "auto";
      const previous = this.inStaticInit; this.inStaticInit = true;
      // V30.14.2: propagamos el target type al emit del initializer para
      // que `new Line()` sepa que el target es un auto-union y envuelva
      // con `make_Line(...)`.
      let initializer = variable.declaredType ? this.emitExpression(variable.initializer, variable.declaredType) : this.emitExpression(variable.initializer);
      // V3: idem VariableDeclaration; emitir `static_cast<target>` cuando el
      // tipo declarado es un numérico concreto y el initializer es de otro tipo
      // numérico (o `number` literal). Esto cubre el caso de top-level.
      if (variable.declaredType && isNumericType(variable.declaredType)) {
        const initType = this.expressionType(variable.initializer);
        const needsCast = initType === "number" || (initType !== undefined && isNumericType(initType) && initType !== variable.declaredType);
        if (needsCast) initializer = `static_cast<${cppType(variable.declaredType)}>(${initializer})`;
      }
      this.inStaticInit = previous;
      // Si el nombre colisiona con un singleton global del runtime, lo
      // renombramos en C++ y registramos el rename para que las referencias
      // posteriores se emitan con el nombre canónico.
      const cppName = variable.fromRuntime
        ? (this.localRenames.set(variable.name, `ets_local_${variable.name}`), `ets_local_${variable.name}`)
        : variable.name;
      // V6: `const` con initializer literal → `static constexpr`. Esto permite
      // usar la variable como tamaño de array fijo (`std::array<T, N>`) y como
      // condición de branch constante (propagación manual). Pero solo aplica
      // a tipos primitivos (i8..u64, f32, f64, number, boolean); los strings
      // usan heap y no son `constexpr` en C++ estándar (el ctor de std::string
      // no es literal type). Los arrays/objects tampoco lo son aquí.
      const canBeConstexpr = typeof variable.constValue !== "string" && variable.constValue !== null;
      // V30.12.2: usar `arrayCppType` para que `Array<Interface>` se emita
      // como `std::vector<I_AutoUnion>`. Si no, fallback a `cppType`.
      // V30.14.2: usar `cppT` helper que tambien cubre `type X = A | B`
      // suelto (no solo dentro de Array<...>).
      const cppTypeText = this.cppT(type);
      // V30.14.2: si la variable tiene tipo auto-union struct (interface
      // o type alias), el initializer no puede ir en static-init porque
      // `make_X(...)` puede no existir aún. Lo difiere al bloque
      // `ets_init_*()` que emite el codegen después de los globals.
      if (this.isAutoUnionTarget(type)) {
        if (!this._deferredInitVars) this._deferredInitVars = [];
        this._deferredInitVars.push({ variable, cppName, initializer });
        lines.push(`static ${cppTypeText} ${cppName};`);
        continue;
      }
      lines.push(`static ${canBeConstexpr && variable.constValue !== undefined ? "constexpr " : ""}${cppTypeText} ${cppName} = ${initializer};`);
    }
    if (simpleTopLevel.length) lines.push("");
    // V18: las funciones con `@cpp_name` se emiten como `extern "C"` en lugar
    // de con cuerpo (linker resuelve contra la librería enlazada).
    const externalFunctions = functions.filter(fn => fn.decorators?.some(d => d.name === "cpp_name"));
    const regularFunctions = functions.filter(fn => !fn.decorators?.some(d => d.name === "cpp_name"));
    for (const fn of externalFunctions) lines.push(this.function(fn), "");
    // V30.4: si el user define `function main` (no async, void
    // return), renombramos a `ets_user_main` para evitar colision
    // con `int main(int, char**)` que el codegen emite al final.
    // El codegen transforma las calls top-level a `main` y
    // `spawn(main)`/`syncWait(main)` en consecuencia. Patron
    // mantenido para que el codigo del dialecto no choque con
    // la funcion global.
    for (const fn of regularFunctions) {
      if (fn.name === "main") {
        const renamed = { ...fn, name: "ets_user_main" };
        lines.push(this.function(renamed), "");
      } else {
        lines.push(this.function(fn), "");
      }
    }
    lines.push("int main(int argc, char** argv) {"); this.indent++;
    lines.push(this.pad() + "ets_argc = argc;");
    lines.push(this.pad() + "ets_argv = argv;");
    // V30.14.2: deferred init para variables top-level con tipo auto-union
    // struct. El static-init ya se hizo (declaracion `static T name;`) y
    // aqui asignamos el valor real (que envuelve con `make_X(...)`).
    if (this._deferredInitVars && this._deferredInitVars.length > 0) {
      for (const { cppName, initializer } of this._deferredInitVars) {
        lines.push(this.pad() + `${cppName} = ${initializer};`);
      }
    }
    for (const statement of destructuringTopLevel) lines.push(this.emitStatement(statement));
    for (const statement of topLevelOther) lines.push(this.emitStatement(statement));
    lines.push(this.pad() + "return 0;"); this.indent--; lines.push("}", "");
    return lines.join("\n");
  }
  generateHeader(program: Program, moduleInitializers: string[]): string {
    this.currentProgram = program;
    this.prepare(program);
    const functions = program.statements.filter((statement): statement is FunctionDeclaration => statement.kind === "FunctionDeclaration" && !!statement.exported);
    // V30.13.4: las interfaces privadas tambien van al header porque
    // un metodo de clase exportada puede tener un parametro de tipo
    // `Interface` (no exportada) y el codegen emite `requires I<T0>`
    // en la declaracion del metodo, que debe resolverse en el header.
    const interfaces = program.statements.filter((statement): statement is InterfaceDeclaration => statement.kind === "InterfaceDeclaration");
    const classes = program.statements.filter((statement): statement is ClassDeclaration => statement.kind === "ClassDeclaration" && !!statement.exported);
    const variables = program.statements.filter((statement): statement is VariableDeclaration => statement.kind === "VariableDeclaration" && !!statement.exported);
    // V15: el header debe contener TODAS las definiciones de tipos que
    // cualquier módulo puede necesitar (no solo las exportadas). Enums y
    // unions son visibles en todo el programa — si un módulo los declara y
    // otro los usa, los necesitamos en el header común.
    const enums = program.statements.filter((statement): statement is EnumDeclaration => statement.kind === "EnumDeclaration");
    const unions = program.statements.filter((statement): statement is UnionDeclaration => statement.kind === "UnionDeclaration");
    const allClasses = program.statements.filter((statement): statement is ClassDeclaration => statement.kind === "ClassDeclaration");
    // V17: pre-pasada de headers requeridos por cada statement (AST-aware).
    this._requiredHeaders.clear();
    for (const stmt of program.statements) this.collectRequiredHeadersForStatement(stmt);
    const stdHeaderFromRequired = Array.from(this._requiredHeaders);
    const lines = ["// Generated declarations. Do not edit.\n// V17: includes granularizados por statement (AST-aware).", "#pragma once", ...this.includes(this.usesTls(program), this.usesCompilerAst(program), this.usesFilesystem(program), this.usesNetworking(program), this.usesUnions(program), this.usesFixedArrays(program), this.usesCollections(program), this.usesIoUringAsync(program), this.usesNodeGlobals(program), this.usesFunctional(program)), ...stdHeaderFromRequired, ""];
    for (const contract of interfaces) lines.push(this.interfaceConcept(contract), "");
    for (const node of enums) lines.push(this.enumDeclaration(node), "");
    for (const node of unions) lines.push(this.unionDeclaration(node), "");
    // V30.12.3: orden topológico para los forward decls de clase (consistente
    // con las definiciones más abajo).
    const headerTopoResult = this.topoSortClasses(allClasses);
    if (headerTopoResult.cyclicNames.length) this.reportClassCycle(headerTopoResult.cyclicNames);
    for (const node of headerTopoResult.ordered) lines.push(this.classForward(node, false /* includeDefaults: el forward decl no repite el default */));
    if (allClasses.length) lines.push("");
    // V30.13: forward decls de los auto-unions ANTES de las clases.
    for (const line of this.emitAutoUnionForwardDeclarations()) lines.push(line);
    // V30.13: emisión intercalada de clases y auto-unions (igual que en
    // `generate()`). Una clase con campo `Array<Interface>` se emite
    // DESPUÉS del auto-union porque el tipo del campo es
    // `std::vector<I_AutoUnion>`, que necesita el struct completo.
    const headerUsesAutoUnion = new Set<string>();
    for (const cls of allClasses) {
      for (const field of cls.fields) {
        let element: TypeName | undefined;
        if (isArrayType(field.type)) element = arrayElement(field.type);
        else if (isGenericType(field.type) && genericBase(field.type) === "Array") element = genericArguments(field.type)[0];
        if (element && this.autoUnions.has(element)) { headerUsesAutoUnion.add(cls.name); break; }
      }
    }
    const headerClassesPre = headerTopoResult.ordered.filter(node => !headerUsesAutoUnion.has(node.name));
    const headerClassesPost = headerTopoResult.ordered.filter(node => headerUsesAutoUnion.has(node.name));
    for (const node of headerClassesPre) lines.push(this.classDeclaration(node), "");
    // V30.12.2: auto-unions en el header. Van DESPUÉS de las definiciones
    // de clase que NO los necesitan (los payloads son tipos de clase
    // concretos) y ANTES de las clases que sí los necesitan.
    for (const line of this.emitAutoUnionDeclarations()) lines.push(line);
    // V30.13: clases que necesitan auto-unions van DESPUÉS de los
    // auto-unions (sus campos `Array<I>` se traducen a
    // `std::vector<I_AutoUnion>` que requiere la definición completa).
    for (const node of headerClassesPost) lines.push(this.classDeclaration(node), "");
    // V18: omitimos del header las funciones con `@cpp_name` (enlazadas
    // externamente). El cpp emite `extern "C" <sig>;` y el linker las
    // resuelve contra la librería.
    const headerFunctions = functions.filter(fn => !fn.decorators?.some(d => d.name === "cpp_name"));
    for (const fn of headerFunctions) {
      // V30.4: renombrar `main` -> `ets_user_main` en la forward
      // declaration para evitar colision con la funcion global.
      if (fn.name === "main") {
        const renamed = { ...fn, name: "ets_user_main" };
        lines.push(this.signature(renamed) + ";");
      } else {
        lines.push(this.signature(fn) + ";");
      }
    }
    if (headerFunctions.length) lines.push("");
    for (const fn of headerFunctions.filter(candidate => candidate.typeParameters.length > 0)) lines.push(this.function(fn), "");
    // V15: si la variable es `const` con initializer literal, el header
      // usa `extern const` (no `extern constexpr` — eso requiere definición
      // inline). La definición en el .cpp usa `constexpr`. Para tipos no
      // literales usamos solo `extern`.
      for (const variable of variables) {
        const isLiteralConst = !variable.mutable && variable.constValue !== undefined && typeof variable.constValue !== "string";
        // V30.12.2: usar `arrayCppType` para `Array<Interface>`.
        const varType = variable.declaredType ?? this.expressionType(variable.initializer) ?? "void";
        const cppT = (isArrayType(varType) || (isGenericType(varType) && genericBase(varType) === "Array")) ? this.arrayCppType(varType) : cppType(varType);
        lines.push(`extern${isLiteralConst ? " const" : ""} ${cppT} ${variable.name};`);
      }
    if (variables.length) lines.push("");
    for (const initializer of moduleInitializers) lines.push(`void ${initializer}();`);
    lines.push("");
    return lines.join("\n");
  }
  generateModule(program: Program, combinedProgram: Program, headerName: string, initializer: string, entryInitializers?: string[]): string {
    this.currentProgram = combinedProgram;
    // `export default` envuelve una declaración; el dialecto es single-
    // translation-unit, así que la declaración se procesa como si fuera
    // top-level directa. Unwrap antes del flujo principal.
    const unwrap = (stmt: Statement): Statement => stmt.kind === "ExportDefaultDeclaration" ? unwrap(stmt.declaration as Statement) : stmt;
    const unwrappedProgram = { ...program, statements: program.statements.map(unwrap) };
    this.prepare(combinedProgram);
    const allFunctions = unwrappedProgram.statements.filter((statement): statement is FunctionDeclaration => statement.kind === "FunctionDeclaration");
    const functions = allFunctions.filter(statement => statement.typeParameters.length === 0);
    const privateFunctions = allFunctions.filter(statement => !statement.exported);
    const privateInterfaces = unwrappedProgram.statements.filter((statement): statement is InterfaceDeclaration => statement.kind === "InterfaceDeclaration" && !statement.exported);
    const privateClasses = unwrappedProgram.statements.filter((statement): statement is ClassDeclaration => statement.kind === "ClassDeclaration" && !statement.exported);
    const variables = unwrappedProgram.statements.filter((statement): statement is VariableDeclaration => statement.kind === "VariableDeclaration" && (!statement.arrayBindings || statement.arrayBindings.length === 0));
    const topLevel = unwrappedProgram.statements.filter(statement => statement.kind !== "FunctionDeclaration" && statement.kind !== "InterfaceDeclaration" && statement.kind !== "ClassDeclaration" && statement.kind !== "VariableDeclaration" && statement.kind !== "ExportNamedDeclaration");
    const destructuringTopLevel = unwrappedProgram.statements.filter((statement): statement is VariableDeclaration => statement.kind === "VariableDeclaration" && !!statement.arrayBindings && statement.arrayBindings.length > 0);
    const lines = ["// Generated module. Do not edit.", `#include ${JSON.stringify(headerName)}`, ""];
    // V30.13.4: el header ya tiene los `interfaceConcept` para todas
    // las interfaces (incluidas las privadas). Aqui no los
    // re-emitimos para evitar redefinicion.
    // V30.12.3: orden topológico para las forward decls de clases privadas.
    const privateTopoResult = this.topoSortClasses(privateClasses);
    if (privateTopoResult.cyclicNames.length) this.reportClassCycle(privateTopoResult.cyclicNames);
    for (const node of privateTopoResult.ordered) lines.push(this.classForward(node, false /* includeDefaults: el default va solo en la definición */));
    if (privateClasses.length) lines.push("");
    // V30.12.2: auto-unions en el module. Van DESPUES de los forward decls.
    for (const line of this.emitAutoUnionDeclarations()) lines.push(line);
    // V15: el forward decl va SIN defaults (los defaults solo pueden aparecer
    // una vez en C++; van en la definición, no en la forward).
    for (const fn of privateFunctions) {
      // V30.4: renombrar `main` -> `ets_user_main` en las forward
      // declarations static.
      if (fn.name === "main") {
        const renamed = { ...fn, name: "ets_user_main" };
        lines.push(this.signature(renamed, true, false, false) + ";");
      } else {
        lines.push(this.signature(fn, true, false, false) + ";");
      }
    }
    if (privateFunctions.length) lines.push("");
    // V15: las clases NO se redeclaran en el cpp si ya están en el header
    // (sería "redefinition"). Solo emitimos las definiciones de clases en el
    // header y omitimos aquí.
    for (const fn of privateFunctions.filter(candidate => candidate.typeParameters.length > 0)) lines.push(this.function(fn, true), "");
    // V15: las forward decls no repiten el default de template parameters
    // (eso iría en la definición), pero SÍ incluyen los defaults de los
    // parámetros de valor (eso es lo que permite llamarlas con menos args
    // en otros módulos).
    for (const variable of variables) {
      // V15: declaramos la top-level variable con su initializer literal
      // (igual que `generate` hace). Si no tiene initializer literal, usamos
      // `auto` para que C++ deduzca, y emitimos la asignación en el init.
      const type = variable.declaredType ?? this.expressionType(variable.initializer) ?? "auto";
      const previous = this.inStaticInit; this.inStaticInit = true;
      // V22: si el declaredType es ptr<T>/constPtr<T>, pasamos ese target al
      // emitExpression para que el NewExpression use make_unique.
      let initializerText = this.emitExpression(variable.initializer, variable.declaredType);
      if (variable.declaredType && isNumericType(variable.declaredType)) {
        const initType = this.expressionType(variable.initializer);
        const needsCast = initType === "number" || (initType !== undefined && isNumericType(initType) && initType !== variable.declaredType);
        if (needsCast) initializerText = `static_cast<${cppType(variable.declaredType)}>(${initializerText})`;
      }
      this.inStaticInit = previous;
      const cppName = variable.fromRuntime
        ? (this.localRenames.set(variable.name, `ets_local_${variable.name}`), `ets_local_${variable.name}`)
        : variable.name;
      const canBeConstexpr = typeof variable.constValue !== "string" && variable.constValue !== null;
      // V15: las variables EXPORTADAS se declaran con linkage externo (sin `static`)
      // para que el header `extern` y esta definición coincidan. Las no exportadas
      // usan `static` para no contaminar el namespace global entre módulos.
      const exportLinkage = variable.exported ? "" : "static ";
      // V30.12.2: usar `arrayCppType` para `Array<Interface>`.
      // V30.14.2: usar `cppT` helper que tambien cubre `type X = A | B`.
      const cppTypeText = this.cppT(type);
      // V30.14.2: deferir la inicializacion al init() si es auto-union.
      if (this.isAutoUnionTarget(type)) {
        if (!this._deferredInitVars) this._deferredInitVars = [];
        this._deferredInitVars.push({ variable, cppName, initializer: initializerText });
        lines.push(`${exportLinkage}${cppTypeText} ${cppName};`);
        continue;
      }
      lines.push(`${exportLinkage}${canBeConstexpr && variable.constValue !== undefined ? "constexpr " : ""}${cppTypeText} ${cppName} = ${initializerText};`);
    }
    if (variables.length) lines.push("");
    // V15: las funciones EXPORTADAS deben tener linkage externo para que el
    // header (signature + ";") y esta definición coincidan. Las no exportadas
    // usan linkage interno (`static`) para evitar choques entre módulos.
    // V18: si la función tiene `@cpp_name`, solo emitimos el `extern "C"`
    // (no el cuerpo). El linker resolverá contra la librería enlazada.
    const externalFunctions = functions.filter(fn => fn.decorators?.some(d => d.name === "cpp_name"));
    const regularFunctions = functions.filter(fn => !fn.decorators?.some(d => d.name === "cpp_name"));
    for (const fn of externalFunctions) lines.push(this.function(fn), "");
    for (const fn of regularFunctions) {
      const exported = fn.exported;
      // V30.4: renombrar `main` -> `ets_user_main` para evitar
      // colision con la funcion global.
      if (fn.name === "main") {
        const renamed = { ...fn, name: "ets_user_main" };
        lines.push(this.function(renamed, !exported), "");
      } else {
        lines.push(this.function(fn, !exported), "");
      }
    }
    lines.push(`void ${initializer}() {`); this.indent++;
    // V15: solo reasignamos variables mutables. Las `const` ya están inicializadas
    // en su declaración (línea 360) y reasignarlas daría error de compilación.
    // Si la variable colisiona con un singleton del runtime (path, fs, console,
    // process, JSON), también la renombramos aquí para que coincida con la
    // declaración de la línea 351.
    // V30.14.2: primero emitimos el deferred init (variables auto-union
    // que NO se pudieron inicializar en static-init). Despues las
    // reasignaciones normales de las variables mutables.
    if (this._deferredInitVars && this._deferredInitVars.length > 0) {
      for (const { cppName, initializer: deferredInit } of this._deferredInitVars) {
        lines.push(this.pad() + `${cppName} = ${deferredInit};`);
      }
    }
    for (const variable of variables) {
      // V30.14.2: si esta variable fue diferida al ets_init_*() (por ser
      // auto-union struct), su inicializacion ya se emitio arriba desde
      // `_deferredInitVars`. Aqui solo reasignamos las que NO fueron
      // diferidas (las const/mutables no-union, o las que se reasignan).
      if (this._deferredInitVars && this._deferredInitVars.some(entry => entry.variable === variable)) continue;
      if (variable.mutable) {
        const targetName = this.cppName(this.resolveAlias(variable.name));
        lines.push(this.pad() + `${targetName} = ${this.emitExpression(variable.initializer, variable.declaredType)};`);
      }
    }
    for (const statement of destructuringTopLevel) lines.push(this.emitStatement(statement));
    // V30.4: si main es async, las calls top-level a `main();` se
    // envuelven en ets::syncWait() para que el event loop itere
    // hasta que la coroutine main termine. Patron: el user
    // escribe `main();` al final del archivo; lo transformamos
    // a `ets::syncWait(ets_user_main());` (la funcion renombrada
    // por el codegen para evitar colision con la int main global).
    const programIsAsync = this.currentProgram !== undefined && this.mainIsAsync(this.currentProgram);
    for (const statement of topLevel) {
      if (programIsAsync && this.isMainCallExpression(statement)) {
        const expr = (statement as unknown as { expression?: unknown }).expression;
        const call = expr as { callee?: unknown };
        lines.push(this.pad() + `ets::syncWait(ets_user_main());`);
      } else {
        lines.push(this.emitStatement(statement));
      }
    }
    this.indent--; lines.push("}", "");
    if (entryInitializers) {
      lines.push("int main(int argc, char** argv) {"); this.indent++;
      lines.push(this.pad() + "ets_argc = argc;", this.pad() + "ets_argv = argv;");
      // V30.4: si main es async, el call site debe spawnarlo
      // (ets::spawn arranca la coroutine en el event loop). Si
      // main es sync, se llama directamente.
      const mainIsAsync = this.currentProgram !== undefined && this.mainIsAsync(this.currentProgram);
      for (const name of entryInitializers) {
        if (mainIsAsync && name === "main") {
          lines.push(this.pad() + `ets::spawn(${name}());`);
        } else {
          lines.push(this.pad() + `${name}();`);
        }
      }
      // V30.2: si el codigo usa watchFs o setInterval (callbacks
      // async que necesitan que el event loop siga vivo), entramos
      // en el loop al final del main. Sin esto, el main retorna
      // inmediatamente y los callbacks nunca se ejecutan. NO se
      // anyade para setTimeout puro (el callback ya dispara y el
      // loop termina solo).
      // V30.2 / V30.4: si el codigo usa watchFs o setInterval
      // (callbacks async que necesitan que el event loop siga
      // vivo), entramos en el loop al final del main. Sin esto,
      // el main retorna inmediatamente y los callbacks nunca se
      // ejecutan. NO se anyade para setTimeout puro (el callback
      // ya dispara y el loop termina solo). Tampoco se anyade
      // para main async: en ese caso, el `ets::syncWait(...)`
      // que añadimos al top-level ya itera el loop hasta que
      // la coroutine main termina, asi que un `run()` adicional
      // bloquearía el main para siempre (los uv_getaddrinfo
      // internos mantienen handles activos).
      const programUsesAsyncMain = this.currentProgram !== undefined &&
        (this.usesFsWatcher(this.currentProgram) ||
         this.usesSetInterval(this.currentProgram));
      if (programUsesAsyncMain) {
        lines.push(this.pad() + "ets::defaultEventLoop.run();");
      }
      lines.push(this.pad() + "return 0;"); this.indent--; lines.push("}", "");
    }
    return lines.join("\n");
  }
  // V18: mapa de tipos C estándar para declaraciones con `@cpp_name`. El
  // dialecto no puede garantizar que `int32_t` coincida con `int` en libc
  // (depende de la plataforma: en algunas es `long`). Para evitar errores
  // de conflicto con `<cstdio>` y similares, usamos los tipos C exactos en
  // las forward declarations externas.
  private static readonly C_LINKAGE_TYPES: Record<string, string> = {
    i8: "char", i16: "short", i32: "int", i64: "long long",
    u8: "unsigned char", u16: "unsigned short", u32: "unsigned int", u64: "unsigned long long",
    f32: "float", f64: "double",
    number: "double", boolean: "bool", string: "const char*",
  };
  private signature(fn: FunctionDeclaration, internal = false, includeDefaults = true, includeValueDefaults = true, useCLinkageTypes = false): string {
    // V18: cuando se emite la firma de una declaración externa
    // (`@cpp_name`), usamos los tipos C estándar en lugar de los tipos
    // del dialecto. p.ej., `i32` → `int` (no `int32_t`).
    const typeFor = (type: TypeName): string => useCLinkageTypes ? (CppGenerator.C_LINKAGE_TYPES[type] ?? cppType(type)) : cppType(type);
    const constrained = fn.params.map((p, i) => ({ p, i })).filter(({ p }) => this.interfaceNames.has(p.type));
    // V10.2: si algún parámetro es `(A, B) => R` (tipo función) y NO tiene
    // default value, lo tratamos como plantilla C++ (`F&&` con deducción
    // automática). Esto elimina el `std::function` que el codegen normal
    // añadiría y permite al compilador inlinear la lambda in situ.
    const functionParams = fn.params.map((p, i) => ({ p, i })).filter(({ p, i }) => isFunctionType(p.type) && !this.interfaceNames.has(p.type));
    const templateParts = [...fn.typeParameters.map(parameter => {
      const base = fn.variadicTypeParameters.includes(parameter.name) ? `typename... ${parameter.name}` : `typename ${parameter.name}`;
      // En C++ los defaults de los parámetros de plantilla solo van en la declaración
      // adelantada; el cuerpo de la función los omite (igual que los defaults de los
      // parámetros de valor). El flag `includeDefaults` controla ambos.
      return includeDefaults && parameter.default ? `${base} = ${cppType(parameter.default)}` : base;
    }), ...constrained.map(({ p, i }) => {
      // V30.13.4: en C++ un concept como `template <SvgChild T0>` no
      // compila porque `SvgChild` no es typename. Hay que anteponer
      // `typename` y dejar que la deducción del concept se haga en el
      // `requires SvgChild<T0>` posterior. Asi el codegen queda:
      //   template <typename T0> requires SvgChild<T0>
      //   void add(T0 child) const
      return `typename T${i}`;
    }), ...functionParams.map(({ i }) => `typename F${i}`)];
    const template = templateParts.length ? `template <${templateParts.join(", ")}>\n` : "";
    const requiresClauses = fn.typeParameters.filter(parameter => parameter.constraint).map(parameter => `requires ${cppRequires(parameter.constraint!, parameter.name)}`);
    // V30.13.4: añadir `requires I<T0>` para cada parametro constrained
    // (el codegen ya añade `requires ...` para typeParameters con constraint,
    // pero los `constrained` derivan de `fn.params` y necesitan lo mismo).
    const constrainedRequires = constrained.map(({ p, i }) => `requires ${p.type}<T${i}>`);
    const allRequires = [...requiresClauses, ...constrainedRequires];
    const requires = allRequires.length ? `${allRequires.join("\n")}\n` : "";
    // C++ no permite defaults en la definición si ya están en la declaración;
    // pasamos `false` al emitir el cuerpo.
    // `p?: T` se traduce a `Optional<T>` en C++. Si el user ya escribió
    // `Optional<T>` no duplicamos el envoltorio.
    // Detección automática de modificadores de paso por puntero/referencia:
    // `Mut<T>` → T* (puntero mutable), `MutRef<T>` → T& (referencia mutable).
    // `Un<T>` y `Rc<T>` mantienen su envoltorio (tienen semántica de ownership).
    const params = fn.params.map((p, i) => {
      // V18: en modo C-linkage, los parámetros usan tipos C exactos (sin
      // `const&` automático, sin `ets::Optional<...>`). Para mantener
      // la paridad con la firma C esperada.
      const baseType = useCLinkageTypes ? typeFor(p.type) : this.cppParameterType(p.type);
      const effectiveType = useCLinkageTypes ? baseType : (p.optional && !(isGenericType(p.type) && genericBase(p.type) === "Optional") ? `ets::Optional<${cppType(p.type)}>` : (this.interfaceNames.has(p.type) ? `T${i}` : baseType));
      // V10.2: si el parámetro es una función, usar el template param `F${i}`
      // (forwarding reference con deducción automática) en lugar del tipo
      // concreto (que sería `std::function<...>`). Esto permite que el
      // compilador C++ inline la lambda sin overhead.
      const isFunction = isFunctionType(p.type) && !this.interfaceNames.has(p.type);
      const paramType = isFunction ? `F${i}&&` : (this.interfaceNames.has(p.type) ? `T${i}` : effectiveType);
      // V18: en modo C-linkage, emitimos `int c` (sin `const&`). La librería C
      // tiene su propia firma; no añadimos modificadores de paso del dialecto.
      if (useCLinkageTypes) {
        const pName = p.fromRuntime ? (this.localRenames.set(p.name, `ets_local_${p.name}`), `ets_local_${p.name}`) : p.name;
        return `${typeFor(p.type)} ${pName}`;
      }
      const cppParamName = p.fromRuntime ? (this.localRenames.set(p.name, `ets_local_${p.name}`), `ets_local_${p.name}`) : undefined;
      return cppParameterDeclaration(p, paramType, fn.async, includeValueDefaults && p.defaultValue ? this.emitExpression(p.defaultValue) : undefined, cppParamName);
    }).join(", ");
    return `${template}${requires}${internal ? "static " : ""}${typeFor(fn.returnType)} ${fn.name}(${params})`;
  }
  private classDeclaration(node: ClassDeclaration): string {
    const templatePart = node.typeParameters.length ? `template <${node.typeParameters.map(parameter => {
      const base = `typename ${parameter.name}`;
      return parameter.default ? `${base} = ${cppType(parameter.default)}` : base;
    }).join(", ")}>\n` : "";
    const requiresPart = node.typeParameters.filter(parameter => parameter.constraint).map(parameter => `requires ${cppRequires(parameter.constraint!, parameter.name)}`).join("\n");
    const header = `${templatePart}${requiresPart ? requiresPart + "\n" : ""}struct ${node.name} {`;
    const lines = [header]; this.indent++;
    // V20: parameter properties — los parámetros del constructor que tengan
    // modificador de acceso o readonly se convierten en campos implícitos
    // de la clase. Si el user ya declaró el campo aparte, NO lo duplicamos.
    const constructor = node.methods.find(m => m.name === "constructor");
    const paramProps = constructor ? constructor.params.filter(p => p.access !== undefined || p.readonly === true) : [];
    const existingFieldNames = new Set(node.fields.map(f => f.name));
    const newFields = paramProps.filter(p => !existingFieldNames.has(p.name));
    const hasConstructor = !!constructor;
    // V30.12.2: los campos tipo `Array<Interface>` o `T[]` deben emitirse como
    // `std::vector<Interface_AutoUnion>` (mapeo que hace `arrayCppType`).
    // Sin esto, `children: Array<SvgChild>` se emite como
    // `std::vector<SvgChild>` y g++ falla porque SvgChild es solo un
    // concept, no un tipo concreto.
    const cppFieldType = (type: TypeName): string => {
      if (isArrayType(type) || (isGenericType(type) && genericBase(type) === "Array")) return this.arrayCppType(type);
      return cppType(type);
    };
    for (const field of node.fields) lines.push(`${this.pad()}${cppFieldType(field.type)}${field.readonly && !hasConstructor ? " const" : ""} ${field.name};`);
    // V20: emitimos los campos implícitos de parameter properties.
    for (const p of newFields) lines.push(`${this.pad()}${cppFieldType(p.type)}${p.readonly ? "" : ""} ${p.name};`);
    if ((node.fields.length || newFields.length) && node.methods.length) lines.push("");
    for (const method of node.methods) lines.push(this.pad() + this.classMethod(method, node), "");
    if (lines.at(-1) === "") lines.pop();
    // V30.13: si la clase tiene constructor con parámetros, añadimos un
    // `default_constructor()` que inicializa todos los campos a sus valores
    // neutros (`0`, `false`, `""`). Esto es necesario para que `std::variant<Line,MultiLine>`
    // sea default-constructible (lo requiere el auto-union de `Array<Interface>`
    // de V30.12.2): sin esto, g++ aborta con "no matching constructor for
    // initialization of 'std::variant<Line, MultiLine>'". Para clases SIN
    // constructor explícito o con un constructor `()` sin parámetros, ya son
    // default-constructibles y no hace falta.
    if (constructor && constructor.params.length > 0) {
      const defaultFieldInitializers = node.fields.map(field => {
        const ftype = field.type;
        if (isNumericType(ftype)) return `(*this).${field.name} = static_cast<${cppType(ftype)}>(0);`;
        if (ftype === "boolean") return `(*this).${field.name} = false;`;
        if (ftype === "string") return `(*this).${field.name} = std::string{};`;
        // Para tipos no primitivos (clases, arrays) dejamos la inicialización al
        // propio default del miembro. Si el tipo es default-constructible, el
        // member default funciona; si no lo es, el código fallaría igualmente al
        // construir la clase (no podemos construir un objeto incompleto desde
        // un default_ctor — eso requeriría casos más complejos que V30.13 no
        // aborda todavía).
        return `(*this).${field.name} = ${cppType(ftype)}{};`;
      });
      if (defaultFieldInitializers.length) {
        // Emite un separador antes (los métodos terminan con `}` sin blank) y
        // deja el último elemento NO-vacío para que el `};` final salga pegado.
        lines.push("", `${this.pad()}void default_constructor() {`, `${this.pad()}    ${defaultFieldInitializers.join("\n" + this.pad() + "    ")}`, `${this.pad()}}`);
      }
    }
    // V30.13: si la clase aparece como variante de un auto-union, le
    // añadimos `operator==` y `operator<<` para que el struct del
    // auto-union pueda compilar (sus `operator==` / `operator<<` llaman a
    // `==` / `<<` sobre cada `std::get<i>(payload)`).
    const autoUnionClasses = this.classesInAutoUnion();
    if (autoUnionClasses.has(node.name)) {
      lines.push("");
      // Emitimos `equals(const&)` que el `operator==` del auto-union
      // llama desde `std::get<i>(a.payload).equals(...)` (payload `const&`).
      // Marcamos los operadores como `friend` para que vivan fuera del
      // struct pero puedan tocar miembros privados. El dialecto no usa
      // privacy para clases (todas las clases son públicas por defecto),
      // así que emitir como `inline` libre es suficiente.
      lines.push(`${this.pad()}// V30.13: equals() para que el operator== del auto-union (V30.12.2) compile.`);
      lines.push(`${this.pad()}bool equals(const ${node.name}& other) const { return ${node.fields.map(f => `((*this).${f.name} == other.${f.name})`).join(" && ") || "true"}; }`);
    }
    this.indent--; lines.push("};");
    return lines.join("\n");
  }
  private classForward(node: ClassDeclaration, includeDefaults = true): string {
    const template = node.typeParameters.length ? `template <${node.typeParameters.map(parameter => {
      const base = `typename ${parameter.name}`;
      return includeDefaults && parameter.default ? `${base} = ${cppType(parameter.default)}` : base;
    }).join(", ")}>\n` : "";
    const requiresPart = node.typeParameters.filter(parameter => parameter.constraint).map(parameter => `requires ${cppRequires(parameter.constraint!, parameter.name)}`).join("\n");
    return `${template}${requiresPart ? requiresPart + "\n" : ""}struct ${node.name};`;
  }
  private classMethod(method: ClassMethod, classDecl: ClassDeclaration): string {
    const declaration: FunctionDeclaration = { kind: "FunctionDeclaration", name: method.name, async: false, typeParameters: method.typeParameters ?? [], variadicTypeParameters: [], params: method.params, returnType: method.returnType, body: method.body, span: method.span };
    // V30.13: el metodo `constructor` (constructor del dialecto) debe devolver
    // una referencia a la clase (`*this`), no void, para que la expresion
    // `MultiLine{}.constructor(10, 20)` se pueda usar como rvalue. Esto es
    // necesario para envolver la clase en un auto-union:
    //   make_MultiLine(MultiLine{}.constructor(10, 20))
    // Sin `*this`, la expresion es `void` y el compilador rechaza
    // `std::vector<...>{...make_MultiLine(void)...}`. El cambio es seguro
    // porque el cuerpo del constructor en el dialecto no usa `return X;`
    // y la devolucion de `*this` es convencional en constructores C++.
    if (method.name === "constructor" && declaration.returnType === "void") {
      declaration.returnType = `${classDecl.name}&`;
    }
    const previous = this.inClassMethod; this.inClassMethod = true;
    const previousParams = this.currentClassMethodParams;
    this.currentClassMethodParams = method.params.map(p => p.name);
    let body = this.emitBlock(method.body);
    // V30.13: si el constructor ahora devuelve `ClassName&` (no void),
    // hay que añadir `return *this;` al final del body para que el
    // método C++ efectivamente devuelva una referencia. Sin esto, g++
    // emite un warning ("control reaches end of non-void function") y
    // la rvalue temporal es UB, lo que se manifiesta como `free():
    // invalid pointer` al destruir el std::variant del auto-union.
    const isReturningClassRef = method.name === "constructor" && declaration.returnType === `${classDecl.name}&`;
    if (isReturningClassRef) {
      // Insertar `return *this;` antes del `}` final del body.
      const closeBrace = body.lastIndexOf("}");
      if (closeBrace > 0) {
        const beforeClose = body.slice(0, closeBrace);
        const afterClose = body.slice(closeBrace);
        body = beforeClose + "    return *this;\n" + afterClose;
      }
    }
    if (method.name === "constructor") {
      const paramProps = method.params.filter(p => p.access !== undefined || p.readonly === true);
      if (paramProps.length > 0) {
        const assignments = paramProps.map(p => `(*this).${p.name} = ${p.name};`).join("\n");
        const openBrace = body.indexOf("{");
        const afterBrace = body.indexOf("\n", openBrace) + 1;
        body = body.slice(0, afterBrace) + assignments + "\n" + body.slice(afterBrace);
      }
    }
    const deprecated = this.decoratorWarning(method.decorators, method.name);
    // `deprecated` se inyecta inmediatamente después de `{` del cuerpo, no entre
    // la firma y el `{`. Para eso, troceamos el bloque en dos.
    let bodyWithWarning = body;
    if (deprecated) {
      const openBrace = body.indexOf("{");
      const afterBrace = body.indexOf("\n", openBrace) + 1;
      bodyWithWarning = body.slice(0, afterBrace) + deprecated + body.slice(afterBrace);
    }
    // V30.13.1: si es constructor que devuelve `ClassName&` (auto-union),
    // NUNCA puede ser `const` porque `return *this` requiere una referencia
    // mutable. El analisis inter-procedimental de mutacion (#187) puede
    // incorrectamente reportar que un constructor vacio no muta, lo que
    // pone `const` en la firma y rompe el `return *this`.
    // V30.13.4: tracking de `currentClassMethodParams` para que las
    // lambdas generadas dentro del metodo (e.g. ...spread) puedan
    // capturar los parametros por referencia.
    const isConstructorRef = method.name === "constructor" && declaration.returnType === `${classDecl.name}&`;
    const mutates = isConstructorRef || this.methodMutates(method, classDecl, new Set<string>());
    const result = `${this.signature(declaration)}${mutates ? "" : " const"} ${bodyWithWarning}`;
    this.inClassMethod = previous; this.currentClassMethodParams = previousParams; return result;
  }

  /**
   * Si la lista de decoradores contiene `@deprecated("msg")` o `@deprecated()`,
   * devuelve un statement C++ que imprime el warning a stderr. En caso
   * contrario devuelve una cadena vacía. Solo se aplica a decoradores de
   * métodos (la advertencia se emite al principio del cuerpo).
   */
  private decoratorWarning(decorators: { name: string; args: Expression[] }[] | undefined, memberName: string): string {
    if (!decorators) return "";
    const deprecated = decorators.find(decorator => decorator.name === "deprecated");
    if (!deprecated) return "";
    let message = "deprecated";
    if (deprecated.args.length) {
      const first = deprecated.args[0];
      if (first.kind === "LiteralExpression" && typeof first.value === "string") message = first.value;
    }
    // Emitimos `std::cerr << "WARN: ...\n";` al principio del cuerpo.
    return `std::cerr << "WARN: '${memberName}' is deprecated: ${message}\\n"; `;
  }
  /**
   * V30.11.1: ¿el método muta `this` (directa o transitivamente)?
   *
   * Antes (V30.11.0 y anteriores) solo mirábamos si el cuerpo del método
   * asignaba directamente a `this.campo`. Eso era incorrecto en cuanto una
   * clase tiene métodos helpers: un método `run()` que no toca `this` pero
   * llama a `this.modX()` (que sí muta) se marcaba `const` en C++ y g++
   * reventaba con "passing const Svg as 'this' argument discards qualifiers".
   *
   * Ahora, además del análisis intra-procedimental, recorremos las llamadas
   * `this.otroMetodo(...)` y, por cada una, preguntamos recursivamente a
   * `methodMutates` sobre ese método de la misma clase. Si alguno de los
   * métodos transitivos muta, este también se considera mutador. El parámetro
   * `visited` es un conjunto de métodos ya en la cadena de llamadas: evita
   * que un ciclo A↔B caiga en recursión infinita. Si una llamada ya está en
   * `visited` la tratamos conservadoramente como "puede mutar" (true) porque
   * no queremos perder precisión cuando hay ciclos reales; en la práctica,
   * los métodos que se llaman entre sí en una clase suelen ser helpers que
   * sí mutan.
   */
  private methodMutates(method: ClassMethod, classDecl: ClassDeclaration, visited: Set<string>): boolean {
    // V20: parameter properties en el constructor implican asignación
    // automática a `this.x`. Eso es una mutación de `this`, así que el
    // constructor nunca es const.
    if (method.name === "constructor" && method.params.some(p => p.access !== undefined || p.readonly === true)) return true;
    return method.body.statements.some(statement => this.statementMutatesThis(statement, classDecl, visited));
  }
  private statementMutatesThis(node: Statement, classDecl: ClassDeclaration, visited: Set<string>): boolean {
    switch (node.kind) {
      case "VariableDeclaration": return this.expressionMutatesThis(node.initializer, classDecl, visited);
      case "ExpressionStatement": return this.expressionMutatesThis(node.expression, classDecl, visited);
      case "ReturnStatement": return !!node.value && this.expressionMutatesThis(node.value, classDecl, visited);
      case "BlockStatement": return node.statements.some(statement => this.statementMutatesThis(statement, classDecl, visited));
      case "IfStatement": return this.expressionMutatesThis(node.condition, classDecl, visited) || this.statementMutatesThis(node.thenBranch, classDecl, visited) || (!!node.elseBranch && this.statementMutatesThis(node.elseBranch, classDecl, visited));
      case "WhileStatement": return this.expressionMutatesThis(node.condition, classDecl, visited) || this.statementMutatesThis(node.body, classDecl, visited);
      case "ForStatement": return (!!node.initializer && this.statementMutatesThis(node.initializer, classDecl, visited)) || (!!node.condition && this.expressionMutatesThis(node.condition, classDecl, visited)) || (!!node.increment && this.expressionMutatesThis(node.increment, classDecl, visited)) || this.statementMutatesThis(node.body, classDecl, visited);
      default: return false;
    }
  }
  private expressionMutatesThis(node: Expression, classDecl: ClassDeclaration, visited: Set<string>): boolean {
    if (node.kind === "AssignmentExpression") {
      let target: Expression = node.target;
      while (target.kind === "MemberExpression") target = target.object;
      return target.kind === "IdentifierExpression" && target.name === "this";
    }
    // V30.13.4: `this.field.method()` puede mutar `this` (side-effect sobre
    // un sub-objeto de this). Sin embargo, marcar TODO `this.algo()` como
    // mutacion rompe el caso V30.11.1 (sum() llama a getX()/getY() const y
    // debe seguir siendo const). La heuristica correcta: solo marcar como
    // mutacion si el metodo llamado es uno de los que mutan in-place en
    // el runtime (`push`, `pop`, `insert`, `clear`, `remove`, etc.).
    // V30.14.4: unifico los dos bloques de MemberCallExpression que
    // existian duplicados (V30.13.4 anadio el chequeo de MUTATING pero
    // sin `return` explicito, lo que impedia que el analisis
    // inter-procedimental del segundo bloque se ejecutara para
    // `this.metodo()` donde metodo no es MUTATING).
    if (node.kind === "MemberCallExpression") {
      // V30.13.4: `this.field.method()` puede mutar `this` (side-effect sobre
      // un sub-objeto de this). Sin embargo, marcar TODO `this.algo()` como
      // mutacion rompe el caso V30.11.1 (sum() llama a getX()/getY() const y
      // debe seguir siendo const). La heuristica correcta: solo marcar como
      // mutacion si el metodo llamado es uno de los que mutan in-place en
      // el runtime (`push`, `pop`, `insert`, `clear`, `remove`, etc.).
      const startsFromThis = (e: Expression): boolean => {
        if (e.kind === "IdentifierExpression") return e.name === "this";
        if (e.kind === "MemberExpression") return startsFromThis(e.object);
        return false;
      };
      // Metodos del runtime que mutan el receptor in-place.
      const MUTATING_RUNTIME_METHODS = new Set([
        "push", "pop", "insert", "erase", "clear", "remove", "removeKey",
        "resize", "reserve", "shrink_to_fit", "swap", "assign", "append",
        "set", "setChildren", "addChildren", "removeAll",
      ]);
      if (startsFromThis(node.object) && MUTATING_RUNTIME_METHODS.has(node.method)) {
        return true;
      }
      // V30.11.1: analisis inter-procedimental. Si vemos `this.otroMetodo(...)`
      // y `otroMetodo` pertenece a esta misma clase, preguntamos recursivamente
      // si muta. Esto cubre el caso Svg.run() que solo llama a modX/modY y
      // antes se marcaba `const` aunque modX/modY muten `this`.
      if (this.expressionMutatesThis(node.object, classDecl, visited)) return true;
      if (node.args.some(arg => this.expressionMutatesThis(arg, classDecl, visited))) return true;
      const calledOnThis = node.object.kind === "IdentifierExpression" && (node.object as { name: string }).name === "this";
      if (calledOnThis && classDecl) {
        const target = classDecl.methods.find(m => m.name === node.method);
        if (target && !visited.has(target.name)) {
          const next = new Set(visited);
          next.add(target.name);
          if (this.methodMutates(target, classDecl, next)) return true;
        }
      }
      return false;
    }
    if (node.kind === "BinaryExpression") return this.expressionMutatesThis(node.left, classDecl, visited) || this.expressionMutatesThis(node.right, classDecl, visited);
    if (node.kind === "UnaryExpression") return this.expressionMutatesThis(node.operand, classDecl, visited);
    if (node.kind === "AwaitExpression") return this.expressionMutatesThis(node.operand, classDecl, visited);
    if (node.kind === "CallExpression" || node.kind === "NewExpression") return node.args.some(arg => this.expressionMutatesThis(arg, classDecl, visited));
    if (node.kind === "ArrayLiteralExpression") return node.elements.some(item => item.kind === "SpreadElement" ? this.expressionMutatesThis(item.expression, classDecl, visited) : this.expressionMutatesThis(item, classDecl, visited));
    // V30.14.4: template strings interpolan expressions que pueden mutar
    // `this` (e.g. `print(`${this.modX(x.x)}`)`. Sin este case, el visit
    // caia al default `return false` y no detectaba la mutacion.
    if (node.kind === "TemplateLiteralExpression") return node.expressions.some(e => this.expressionMutatesThis(e, classDecl, visited));
    if (node.kind === "ArrowFunctionExpression") return node.body.kind === "BlockStatement" ? node.body.statements.some(statement => this.statementMutatesThis(statement, classDecl, visited)) : this.expressionMutatesThis(node.body, classDecl, visited);
    // V30.11.1: análisis inter-procedimental. Si vemos `this.otroMetodo(...)`
    // y `otroMetodo` pertenece a esta misma clase, preguntamos recursivamente
    // si muta. Esto cubre el caso Svg.run() que solo llama a modX/modY y
    if (node.kind === "MemberExpression") return this.expressionMutatesThis(node.object, classDecl, visited);
    if (node.kind === "IndexExpression") return this.expressionMutatesThis(node.object, classDecl, visited) || this.expressionMutatesThis(node.index, classDecl, visited);
    return false;
  }
  private interfaceConcept(node: InterfaceDeclaration): string {
    // V30.13.4: si la interface no tiene metodos, no podemos emitir
    // un concept C++ valido (`concept X = requires(T) {};` no compila
    // porque requires no acepta cuerpo vacio). En ese caso, emitimos
    // un concept trivial con `true` que siempre se cumple, y los
    // callers no rompen.
    if (node.methods.length === 0) {
      return [`template <typename T>`, `concept ${node.name} = true;`].join("\n");
    }
    const requirements = node.methods.map(method => {
      const args = method.params.map(p => `std::declval<${cppType(p.type)}${p.out ? "&" : ""}>()`).join(", ");
      return `    { value.${method.name}(${args}) } -> std::same_as<${cppType(method.returnType)}>;`;
    });
    return [`template <typename T>`, `concept ${node.name} = requires(T value) {`, ...requirements, `};`].join("\n");
  }
  // Enums numéricos → `enum class Name : int { ... }` (los miembros son `Name::Member`).
  // Enums de cadena → struct con un valor interno convertible a `std::string`; los miembros
  // estáticos se declaran dentro del struct y se inicializan fuera (el constructor no está
  // disponible dentro del cuerpo de la clase). Los miembros se acceden como `Name::Member`.
  private enumDeclaration(node: EnumDeclaration): string {
    if (node.underlying === "number") {
      const members = node.members.map(member => {
        if (!member.value || member.value.kind !== "LiteralExpression") return `    ${member.name}`;
        const literal = member.value;
        // Los enteros del enum se emiten como literales enteros (no como `5.0`) porque el
        // tipo subyacente es `int`, no `double` (que es como se imprimen los `number`).
        const valueText = typeof literal.value === "number" ? String(literal.value) : this.emitExpression(literal);
        return `    ${member.name} = ${valueText}`;
      });
      return `enum class ${node.name} : int {\n${members.join(",\n")}\n};`;
    }
    const name = node.name;
    const declarations = node.members.map(member => `    static const ${name} ${member.name};`).join("\n");
    const definitions = node.members.map(member => {
      const literal = member.value;
      const valueText = literal && literal.kind === "LiteralExpression" && typeof literal.value === "string" ? JSON.stringify(literal.value) : `""`;
      return `inline const ${name} ${name}::${member.name} = ${name}(${valueText});`;
    }).join("\n");
    return `struct ${name} {\n    std::string value;\n    ${name}() = default;\n    ${name}(std::string v) : value(std::move(v)) {}\n    operator const std::string&() const { return value; }\n${declarations}\n};\n${definitions}`;
  }
  // V1: tagged unions nativas del dialecto. Se emiten como un struct C++
  // con un discriminador (índice de la variante) y un `std::variant` que
  // contiene los payloads. Esto permite pattern matching exhaustivo en V1.2.
  private unionDeclaration(node: UnionDeclaration, forwardedMethods: { name: string; returnType: string; params: { name: string; type: string }[] }[] = [], isTypeAlias = false): string {
    const variantIndexEnum = `${node.name}_Kind`;
    const variantKindFields = node.variants.map((variant, index) => `    ${variant.name} = ${index}`).join(",\n");
    const isGeneric = node.typeParameters.length > 0;
    // Renombramos los parámetros de plantilla de los constructores para que NO
    // colisionen con los nombres de los payloads (`Ok(T)` daba lugar a un
    // parámetro de valor `T value` que ensombrecía el type parameter `T` del
    // template del constructor, generando errores sutiles al instanciar).
    const tparamNames = isGeneric ? node.typeParameters.map(p => p.name) : [];
    const tparamSpec = isGeneric ? `template <${node.typeParameters.map(p => "typename " + p.name).join(", ")}>` : "";
    const tnamesSpec = isGeneric ? `<${tparamNames.join(", ")}>` : "";
    // Para evitar ambigüedad en `std::variant` cuando dos variantes tienen el
    // mismo tipo concreto, cada constructor usa `emplace<índice>` que es
    // inequívoco.
    const constructorDefs = node.variants.map((variant, index) => {
          // Renombramos el parámetro de valor para que no choque con un type
          // parameter del template del constructor (p.ej. `Ok(T)` → `Ok(T value)`
          // ensombrecía `T`). Usamos un prefijo estable basado en el nombre de
          // la variante.
          const paramName = `ets_${variant.name.toLowerCase()}_value`;
          // V30.13: cuando el nombre de la variante coincide con el del payload
          // (escenario típico de auto-union: `variant Line -> payload Line`,
          // `variant MultiLine -> payload MultiLine`), declarar una función
          // `Line(...)` ensombrece el nombre del tipo `Line` dentro de su
          // propio cuerpo y, peor, hace que cualquier `Line(args)` sea
          // ambiguo: g++ trata `Line{}` como la llamada a la función con
          // lista vacía (que no matchea la firma) en vez de aggregate-init
          // del struct. Para evitar esto, cuando variant.name === payload,
          // renombramos el constructor C++ a `make_<Variant>`. El codegen
          // detecta esta convención al emitir `new Line(...)` y envuelve
          // la llamada con `make_Line(Line{...})` (ver `NewExpression`).
          const fnName = (variant.name === variant.payload) ? `make_${variant.name}` : variant.name;
          if (!variant.payload) {
            return `${tparamSpec} inline ${node.name}${tnamesSpec} ${fnName}() { ${node.name}${tnamesSpec} u; u.kind = ${variantIndexEnum}::${variant.name}; return u; }`;
          }
          // Para las variantes con nombre distinto al payload, también usamos
          // `static_cast<struct T&&>` cuando coincide, pero solo si la
          // función NO coincide con el nombre del payload.
          const payloadType = cppType(variant.payload);
          const castType = variant.name === variant.payload ? `struct ${payloadType}` : payloadType;
          // V30.14.2: para type aliases, el campo `kind` publico es el
          // `kind` del payload (string), y el campo `_kindIndex` es el
          // enum interno. El codegen usa `_kindIndex` para los switches.
          // Tambien capturamos el kind en un string local ANTES del move
          // (use-after-move es UB y el kind queda vacio).
          const kindInit = isTypeAlias
            ? `u.kind = kindCapture; u._kindIndex = ${variantIndexEnum}::${variant.name};`
            : `u.kind = ${variantIndexEnum}::${variant.name};`;
          const kindCapture = isTypeAlias ? `std::string kindCapture = ${paramName}.kind;` : "";
          return `${tparamSpec} inline ${node.name}${tnamesSpec} ${fnName}(${payloadType} ${paramName}) { ${node.name}${tnamesSpec} u; ${kindCapture} u.payload.template emplace<${index}>(static_cast<${castType}&&>(${paramName})); ${kindInit} return u; }`;
        }).join("\n");
    const variantPayloads = node.variants.map(variant => variant.payload ? cppType(variant.payload) : "std::monostate").join(", ");
    // `operator<<` para `print(union)` (V1.3). Cada variante se imprime como
    // `Variant(payload)`; las variantes nulas como `Variant`. El prefijo
    // `template <...>` se reusa para que coincida con la declaración del
    // struct (GCC exige que las plantillas friend coincidan exactamente).
    const printerBranches = node.variants.map((variant, index) => {
      // V30.13: solo intentamos imprimir el payload si tiene `operator<<`
      // definido (el dialecto no garantiza que las clases tengan
      // `operator<<`, especialmente los payload classes de un auto-union).
      // Imprimir solo el nombre de la variante es suficiente para
      // diagnóstico y nunca falla en compilación. Si el programador
      // quiere imprimir el payload, puede añadir un método `toString()`
      // a la clase y llamarlo explícitamente.
      const printer = `std::cout << "${variant.name}"; break;`;
      return `        case ${variantIndexEnum}::${variant.name}: ${printer}`;
    }).join("\n");
    const printerKindField = isTypeAlias ? "_kindIndex" : "kind";
    const printerDef = `${tparamSpec}\ninline std::ostream& operator<<(std::ostream& os, const ${node.name}${tnamesSpec}& u) {\n    switch (u.${printerKindField}) {\n${printerBranches}\n    }\n    return os;\n}`;
    // V1.3: `operator==` contextual para tagged unions. `std::variant` no
    // ofrece comparación por defecto; emitimos uno que dispatcha por
    // discriminador y compara payload solo si los kinds coinciden.
    // V30.13: usamos `v.equals(other)` (definido por el codegen en cada
    // payload class) en lugar de `==`, porque las clases del dialecto
    // NO generan `operator==` automáticamente y el `operator==` del
    // auto-union necesita poder comparar payloads.
    const eqKindField = isTypeAlias ? "_kindIndex" : "kind";
    // V30.14.4: en vez de llamar `.equals()` (que solo existe en clases
    // del dialecto, no en std::string ni std::monostate), usamos `==`
    // para tipos built-in y `.equals()` para clases del dialecto.
    // El helper `equalsDispatch(i, T)` elige en compile-time.
    const eqBranchesTyped = node.variants.map((variant, index) => {
      const T = variant.payload ?? "void";
      const isClass = variant.payload ? this.classesByName.has(variant.payload) : false;
      const cmp = isClass
        ? `std::get<${index}>(a.payload).equals(std::get<${index}>(b.payload))`
        : `(std::get<${index}>(a.payload) == std::get<${index}>(b.payload))`;
      return `    (a.${eqKindField} == ${variantIndexEnum}::${variant.name} && b.${eqKindField} == ${variantIndexEnum}::${variant.name} && ${cmp})`;
    }).join(" ||\n");
    const eqDef = `${tparamSpec}\ninline bool operator==(const ${node.name}${tnamesSpec}& a, const ${node.name}${tnamesSpec}& b) {\n    return\n${eqBranchesTyped};\n}`;
    // V30.13: dispatch methods para auto-unions. Cada método declarado en
    // la interface original se reescribe como un `switch (kind)` que
    // llama al método del payload concreto. Esto permite que el código
    // usuario haga `arr[i].build()` sobre un `Array<Interface>` (donde el
    // elemento es un auto-union struct) sin que el codegen tenga que
    // saber qué variante está activa en tiempo de compilación.
    const dispatchMethodDefs = forwardedMethods.map(method => {
      const params = method.params.map(p => `${p.type} ${p.name}`).join(", ");
      const args = method.params.map(p => p.name).join(", ");
      if (method.returnType === "void") {
        const voidBranches = node.variants.map((variant, index) => `case ${variantIndexEnum}::${variant.name}: std::get<${index}>(payload).${method.name}(${args}); return;`).join("\n            ");
        return `    void ${method.name}(${params}) { switch (${eqKindField}) {\n            ${voidBranches}\n        } }`;
      }
      // V30.14.2: si el method retorna un valor, añadimos un default
      // vacio para que GCC no emita warning de "control reaches end of
      // non-void function" (todos los casos ya tienen return; el
      // default es unreachable pero suprime el warning).
      const defaultReturn = `return ${method.returnType}();`;
      const branches = node.variants.map((variant, index) => `case ${variantIndexEnum}::${variant.name}: return std::get<${index}>(payload).${method.name}(${args});`).join("\n            ");
      return `    ${method.returnType} ${method.name}(${params}) const { switch (${eqKindField}) {\n            ${branches}\n        default: ${defaultReturn} } }`;
    }).join("\n");
    // V30.14.2: para type aliases, el campo `kind` publico es `std::string`
    // (compatibilidad con la API declarada por el usuario), pero el
    // dispatch interno usa un campo separado `_kindIndex` (enum).
    const kindFieldDecl = isTypeAlias
      ? `std::string kind;\n    ${variantIndexEnum} _kindIndex;`
      : `${variantIndexEnum} kind;`;
    // El prefijo `template <...>` ya se emite arriba; el nombre del struct
    // NO lleva los angle brackets (eso es lo que provocaba el error
    // "'Outcome' is not a class template" de GCC).
    return `enum class ${variantIndexEnum} : int {\n${variantKindFields}\n};\n${tparamSpec ? tparamSpec + "\n" : ""}struct ${node.name} {\n    ${kindFieldDecl}\n    std::variant<${variantPayloads}> payload;\n${dispatchMethodDefs}\n};\n${constructorDefs}\n${printerDef}\n${eqDef}`;
  }
  private function(fn: FunctionDeclaration, internal = false): string {
    // V18: si la función está mapeada a un símbolo C/C++ externo
    // (decorador `@cpp_name("InitWindow")`), emitimos solo la declaración
    // sin cuerpo, con linkage externo. El dialecto **siempre** usa
    // `extern "C"` para `.lib.ets` (un archivo de declaraciones siempre
    // mapea a una librería C o C++, no a código del programa).
    if (fn.decorators?.some(d => d.name === "cpp_name")) {
      const cppName = this._cppNames.get(fn.name) ?? fn.name;
      // V18: usaCLinkageTypes=true → tipos C estándar (int, double, void),
      // no `int32_t`/etc. Esto evita conflictos con `<cstdio>` y similares.
      const sig = this.signature(fn, internal, false, true, true);
      return `extern "C" ${sig.replace(fn.name + "(", cppName + "(")};`;
    }
    const signature = this.signature(fn, internal, false);
    const appendCoReturn = fn.async && isPromiseType(fn.returnType) && promiseResult(fn.returnType) === "void" && fn.body.statements.at(-1)?.kind !== "ReturnStatement";
    // V8.0: el codegen necesita conocer el tipo declarado del retorno
    // para envolver automáticamente `return new T()` cuando la firma es
    // `: Unq<T>`. Lo seteamos como estado temporal y lo restauramos al
    // salir del cuerpo (soporte de funciones anidadas).
    const previousReturn = this.currentReturn;
    const previousAsync = this.inAsyncFunction;
    this.inAsyncFunction = fn.async;
    this.currentReturn = fn.async && isPromiseType(fn.returnType) ? promiseResult(fn.returnType) : fn.returnType;
    const output = `${signature} ${this.emitBlock(fn.body, appendCoReturn)}`;
    this.currentReturn = previousReturn;
    this.inAsyncFunction = previousAsync;
    return output;
  }
  private emitStatement(node: Statement): string {
    switch (node.kind) {
      case "VariableDeclaration": {
        // Array destructuring: `const [a, b, c] = expr;` se desazucara a una
        // variable temporal oculta + N declaraciones `const T x = tmp[i];`.
        // El tipo declarado (si lo hay) se aplica a los bindings que no tengan
        // tipo propio; el del temporal es el del initializer (lo deduce `auto`).
        if (node.arrayBindings && node.arrayBindings.length > 0) {
          const counter = ++this.destructuringCounter;
          const tmpName = `__ets_destructure_${counter}`;
          const tmpType = node.declaredType ? cppType(node.declaredType) : "auto";
          const initType = this.expressionType(node.initializer);
          const initIsArray = initType && isArrayType(initType);
          const lines: string[] = [];
          lines.push(`${this.pad()}${this.variableIsConst(node) ? "const " : ""}${tmpType} ${tmpName} = ${this.emitExpression(node.initializer)};`);
          for (let index = 0; index < node.arrayBindings.length; ++index) {
            const binding = node.arrayBindings[index];
            const type = binding.declaredType ? cppType(binding.declaredType) : "auto";
            const mutable = node.mutable ? "" : "const ";
            const access = `${tmpName}[${index}]`;
            const value = (binding.defaultValue && initIsArray)
              ? `(${tmpName}.size() > ${index} ? ${access} : (${this.emitExpression(binding.defaultValue)}))`
              : access;
            lines.push(`${this.pad()}${mutable}${type} ${this.cppName(binding.name)} = ${value};`);
          }
          return lines.join("\n");
        }
        // Si el initializer es una llamada a un helper que retorna por
        // referencia (MutRef<T>, Un<T>, Rc<T>, Mut<T>), emitimos `T& x = ...`
        // para evitar la copia. El type-checker garantiza que el tipo
        // declarado coincide con el tipo del valor retornado.
        const typeRef = this.expressionReturnsRef(node.initializer) ? "&" : "";
        // V3: si el tipo declarado es un numérico concreto y el initializer
        // tiene un tipo numérico distinto (o es `number` literal), insertamos
        // `static_cast<Target>` para que el C++ no se queje de la conversión
        // (p.ej. `int32_t x = 42.0` es narrowing implícito y emite warning).
        // V22: pasamos el declaredType al emitExpression para que
        // NewExpression use make_unique cuando el destino es ptr<T>/constPtr<T>.
        let initializerExpr = this.emitExpression(node.initializer, node.declaredType);
        // V22: registramos el tipo del identifier para que member access use ->.
        if (node.declaredType) this.identifierTypes.set(node.name, node.declaredType);
        if (node.declaredType && isNumericType(node.declaredType)) {
          const initType = this.expressionType(node.initializer);
          const needsCast = initType === "number" || (initType !== undefined && isNumericType(initType) && initType !== node.declaredType);
          if (needsCast) initializerExpr = `static_cast<${cppType(node.declaredType)}>(${initializerExpr})`;
        }
        return `${this.pad()}${this.variableIsConst(node) ? "const " : ""}${node.declaredType && !this.interfaceNames.has(node.declaredType) ? cppType(node.declaredType) + typeRef : "auto"} ${this.cppName(node.name)} = ${initializerExpr};`;
      }
      case "FunctionDeclaration": return "";
      case "InterfaceDeclaration": return "";
      case "ClassDeclaration": return "";
      case "BlockStatement": return this.pad() + this.emitBlock(node);
      case "ExpressionStatement": return `${this.pad()}${this.emitExpression(node.expression)};`;
      case "ReturnStatement": {
        if (this.inAsyncFunction && node.value) {
          const valueType = this.expressionType(node.value);
          if (valueType && isPromiseType(valueType)) {
            const awaited = `co_await ${this.emitExpression(node.value)}`;
            return promiseResult(valueType) === "void" ? `${this.pad()}${awaited};\n${this.pad()}co_return;` : `${this.pad()}co_return ${awaited};`;
          }
        }
        // V3: emitir static_cast si el tipo declarado del retorno es un
        // numérico concreto y el valor es de otro tipo numérico.
        // V22: pasamos this.currentReturn como targetType para que el
        // NewExpression use make_unique cuando la firma es ptr<T>/constPtr<T>.
        let returnText = node.value ? this.emitExpression(node.value, this.currentReturn) : "";
        if (node.value && this.currentReturn && isNumericType(this.currentReturn)) {
          const valueType = this.expressionType(node.value);
          if (valueType && (valueType === "number" || isNumericType(valueType)) && valueType !== this.currentReturn) {
            returnText = `static_cast<${cppType(this.currentReturn)}>(${returnText})`;
          }
        }
        // V8.0: si el tipo declarado del retorno es `Unq<T>` y el valor es
        // de tipo `T` (sin envolver), envolver automáticamente con
        // `unSome<T>(...)`. Esto permite `return new Counter(42)` cuando
        // la firma es `: Unq<Counter>`, sin obligar al usuario a escribir
        // el envoltorio manualmente. La inferencia es local (un solo nivel):
        // el usuario sigue necesitando `unSome` explícito si el retorno es
        // transitivo (e.g. `Unq<Unq<T>>`).
        if (node.value && this.currentReturn && isGenericType(this.currentReturn)) {
          const returnBase = genericBase(this.currentReturn);
          const valueType = this.expressionType(node.value);
          // V22 (Memory Model v2): Unq<T> y Rc<T> ya no existen en el
          // dialecto. Si el type-checker los rechazó, este path nunca se
          // ejecuta; pero conservamos el bloque para `Optional<T>` (que
          // sigue siendo válido como mecanismo de resultados).
          if (returnBase === "Optional" && valueType && this.classNames.has(valueType) && valueType !== "void") {
            returnText = `ets::Optional<${cppType(valueType)}>::some(${returnText})`;
          }
        }
        return `${this.pad()}${this.inAsyncFunction ? "co_return" : "return"}${returnText ? " " + returnText : ""};`;
      }
      case "IfStatement": { let out = `${this.pad()}if (${this.emitExpression(node.condition)}) ${this.statementBody(node.thenBranch)}`; if (node.elseBranch) out += ` else ${this.statementBody(node.elseBranch)}`; return out; }
      case "WhileStatement": return `${this.pad()}while (${this.emitExpression(node.condition)}) ${this.statementBody(node.body)}`;
      case "ForStatement": {
        let initializer = "";
        if (node.initializer?.kind === "VariableDeclaration") {
          // V3: static_cast en for-init si el tipo es numérico concreto.
          let init = this.emitExpression(node.initializer.initializer);
          if (node.initializer.declaredType && isNumericType(node.initializer.declaredType)) {
            const initType = this.expressionType(node.initializer.initializer);
            const needsCast = initType === "number" || (initType !== undefined && isNumericType(initType) && initType !== node.initializer.declaredType);
            if (needsCast) init = `static_cast<${cppType(node.initializer.declaredType)}>(${init})`;
          }
          initializer = `${this.variableIsConst(node.initializer) ? "const " : ""}${node.initializer.declaredType ? cppType(node.initializer.declaredType) : "auto"} ${this.cppName(node.initializer.name)} = ${init}`;
        } else if (node.initializer?.kind === "ExpressionStatement") initializer = this.emitExpression(node.initializer.expression);

        // V30.1: deteccion de patron "loop with push_back". Si el body es
        // un unico `arr.push(expr)` y la condition tiene la forma `i < N`
        // donde N es una cota superior conocida, emitimos `arr.reserve(N)`
        // antes del for. Esto evita las 14 reallocaciones que hace
        // `std::vector` por su growth exponencial cuando el usuario no
        // llama a `reserve` explicitamente. Es una optimizacion segura
        // porque `reserve` es un no-op si el vector ya tiene >= N capacidad.
        const reserveHint = this.detectPushBackReserveHint(node);
        const prefix = reserveHint ? `${this.pad()}${reserveHint};\n` : "";

        return `${prefix}${this.pad()}for (${initializer}; ${node.condition ? this.emitExpression(node.condition) : ""}; ${node.increment ? this.emitExpression(node.increment) : ""}) ${this.statementBody(node.body)}`;
      }
      case "BreakStatement": return `${this.pad()}break;`;
      case "ContinueStatement": return `${this.pad()}continue;`;
      case "TypeAliasDeclaration":
      case "EnumDeclaration":
      case "SwitchStatement":
        return "";
      case "DeleteStatement": {
        const objType = this.expressionType(node.target.object);
        const objStr = this.emitExpression(node.target.object);
        const idxStr = this.emitExpression(node.target.index);
        if (objType && (isMapType(objType) || isSetType(objType))) {
          return `${this.pad()}${objStr}.removeKey(${idxStr});`;
        }
        if (objType && isArrayType(objType)) {
          const eraseExpr = `${objStr}.erase(${objStr}.begin() + static_cast<std::ptrdiff_t>(${idxStr}))`;
          const isLiteral = node.target.index.kind === "LiteralExpression";
          return isLiteral
            ? `${this.pad()}${eraseExpr};`
            : `${this.pad()}if (${idxStr} < ${objStr}.size()) ${eraseExpr};`;
        }
        return `${this.pad()}/* delete: tipo no soportado */;`;
      }
      case "ForOfStatement": return this.emitForOf(node);
      case "ForInStatement": return this.emitForIn(node);
      case "UsingDeclaration": {
        // `using name = expr` se desazucara a `T name = expr` con RAII
        // automático: el destructor C++ del tipo se invoca al salir del
        // bloque contenedor. Por ahora dejamos que C++ haga RAII solo;
        // cuando se definan clases con `dispose()`, el codegen lo invocará.
        const declaredType = node.declaredType ? cppType(node.declaredType) : "auto";
        return `${this.pad()}${declaredType} ${node.name} = ${this.emitExpression(node.initializer)};`;
      }
      case "ExportDefaultDeclaration": {
        // Marcador en C++ + emite la declaración subyacente. El dialecto es
        // single-translation-unit, así que `export default` no genera
        // dispatch runtime; solo registramos la intención para tooling.
        return `// export default: ${node.declaration.kind}\n` + this.emitStatement(node.declaration as Statement);
      }
      case "ExportNamedDeclaration": {
        // `export { x as y }` no genera código nuevo (las declaraciones ya
        // están emitidas). Solo añadimos un marcador para tooling.
        const names = node.specifiers.map(s => s.alias ? `${s.name} as ${s.alias}` : s.name).join(", ");
        return `// export { ${names}${node.source ? ` } from "${node.source}"` : "}"}`;
      }
    }
  }

  // V30: la forma V2 de match (`match (subject) { ... }`) se elimino.
  // El match V30 es siempre una `CallExpression` con `callee === "match"`,
  // parseada por `assignment()`. Si llegamos aqui (caso degenerado
  // despues de un error E4410 del parser), emitimos un comentario y void
  // para no romper el resto del codegen.
  private emitMatch(node: { subject: Expression; arms: { pattern: Expression; result: Expression }[] }): string {
    void node;
    return "/* E4410: match V2 eliminado en V30; usa match(value, [when(pat, cb), otherwise(cb)]) */";
  }
  // V30: dead code (V2 match eliminado). Queda por seguridad.
  private emitV2Match(node: { subject: Expression; arms: { pattern: Expression; result: Expression }[] }): string {
    void node;
    return "/* E4410: match V2 eliminado en V30 */";
  }
  // V30: dead code (V2 match eliminado). Queda por seguridad.
  private cppTypeForMatchReturn(arms: { result: Expression }[]): string {
    void arms;
    return "void";
  }

  // V23: codegen de la nueva forma `match(value, [when(...), otherwise(...)])`
  // o `match(value, "discriminator", [when(...), otherwise(...)])`.
  //
  // Estrategia: emitir un IIFE que capture el subject en una variable local y
  // construya un if/else chain. Es estructuralmente análogo al V2 destructurado
  // (`emitNewMatch` en V23) pero más simple: cada arm tiene una condición de igualdad
  // directa, no hay extracción de `std::get<i>`.
  //
  // Limitaciones documentadas (issue #95):
  //   - `whenType<T>(cb)` NO narrowa el tipo del subject en V23.1. El
  //     callback se trata como "siempre matchea" y se emite como rama
  //     fallback (else). Si hay varios `whenType` consecutivos sin
  //     `otherwise`, solo el ÚLTIMO se usa como fallback real; los
  //     anteriores reciben un comentario `// unreachable` porque no
  //     podemos emitir `if constexpr` sin información de tipo del
  //     checker. Esto es un compromiso explícito del diseño V23.1.
  //   - Si no hay `otherwise` ni `whenType`, el else final aborta con
  //     `std::abort()`. La exhaustividad NO se valida en la nueva forma
  //     (solo V2 destructurado la enforce con `validateExhaustiveMatch`).
  private emitNewMatch(node: { args: Expression[]; matchedDiscriminator?: string; matchedDiscriminatorType?: string; matchedResultType?: TypeName }): string {
    // El checker garantiza `args.length ∈ {2, 3}`. args[0] es el subject;
    // args[1] (o args[2] con discriminator) es el array literal de cases.
    const subject = node.args[0]!;
    const caseList = (node.args.length === 3 ? node.args[2] : node.args[1]) as { kind: "ArrayLiteralExpression"; elements: Expression[] };
    const discriminator = node.matchedDiscriminator;
    // Si el checker reportó un error y no tenemos `ArrayLiteralExpression`,
    // emitimos un comentario para que el .cpp siga siendo parseable y los
    // demás errores se vean en cascada.
    if (!caseList || caseList.kind !== "ArrayLiteralExpression") return "/* match: case list inválida */";
    // Clasificamos cada elemento. `when` produce una rama if; `whenType` y
    // `otherwise` son fallbacks. Solo el PRIMER fallback que encontremos
    // (recorriendo en orden) es el `else` real; los siguientes son
    // unreachable (per #95 — sin narrowing).
    type When = { kind: "when"; pattern: Expression; callback: Expression };
    type Fallback = { kind: "whenType" | "otherwise"; callback: Expression };
    const whens: When[] = [];
    const fallbacks: Fallback[] = [];
    for (const element of caseList.elements) {
      if (element.kind === "CallExpression") {
        const callee = (element as { callee: string }).callee;
        const args = (element as { args: Expression[] }).args;
        if (callee === "when" && args.length === 2) whens.push({ kind: "when", pattern: args[0]!, callback: args[1]! });
        else if (callee === "whenType" && args.length === 1) fallbacks.push({ kind: "whenType", callback: args[0]! });
        else if (callee === "otherwise" && args.length === 1) fallbacks.push({ kind: "otherwise", callback: args[0]! });
        // Otros elementos (los que dispararon E4404–E4409) se ignoran aquí;
        // el checker ya reportó el error, así que no emitimos nada.
      }
    }
    // Tipo de retorno: lo que calculó el checker uniendo los retornos de los
    // callbacks. Si todos coinciden, ese; si no, unión pipe-delimited. Aquí
    // simplemente emitimos el tipo C++ correspondiente. Si el checker no
    // dejó `matchedResultType` (caso degenerado sin arms), usamos `void`.
    const resultType = node.matchedResultType ? cppType(node.matchedResultType) : "void";
    const subjectText = this.emitExpression(subject);
    // Acceso al subject: con discriminator se hace `subj.<key>`, sin él se
    // usa el subject directamente. En ambos casos, el callback recibe el
    // subject por valor (los callbacks declaran su parámetro como copia
    // por valor o por referencia según el dialecto — el codegen del
    // `ArrowFunctionExpression` ya emite la firma correcta).
    const subjectAccess = discriminator ? `${subjectText}.${this.cppName(discriminator)}` : subjectText;
    // Patrón textual para comparar. Como el `emitExpression` ya envuelve
    // strings en `std::string(...)` y numéricos como literales C++ válidos,
    // la comparación `subjAccess == patternText` funciona tal cual para
    // los tipos de caso comunes.
    const whensLines = whens.map(w => {
      // V30.5.2: si el discriminator tiene un tipo anotado (el type-checker
      // lo setea cuando el subject es una union y el discriminator es el
      // campo `kind`), emitimos el pattern como `EnumType::Variant` en vez
      // de `std::string("Variant")`. Esto permite que la comparacion
      // `r.kind == R_Kind::Success` compile.
      let patternText: string;
      if (node.matchedDiscriminatorType) {
        const variantName = w.pattern.kind === "LiteralExpression" && w.pattern.literalType === "string" ? String(w.pattern.value) : null;
        if (variantName) {
          patternText = `${node.matchedDiscriminatorType}::${variantName}`;
        } else {
          patternText = this.emitExpression(w.pattern);
        }
      } else {
        patternText = this.emitExpression(w.pattern);
      }
      // V30.15: el callback puede tener 0 o 1 parámetro. Si tiene 1 y el
      // subject es un auto-union struct (interface o type alias) y el
      // pattern es un string literal, narrowamos el subject via
      // `std::holds_alternative<T>(subj.payload)` + `std::get<T>(subj.payload)`
      // y pasamos la variante narrowed al callback.
      // V30.15: subjectType se declara mas abajo (despues de procesar
      // los whens). Lo computamos aqui bajo demanda via expressionType.
      const cb = w.callback;
      let callArgs = "";
      if (cb.kind === "ArrowFunctionExpression" && cb.params.length === 1) {
        // Detectar si podemos narrowar.
        const subjT = this.expressionType(subject);
        const subjectAutoUnion = this.findAutoUnionForType(subjT);
        const patternName = w.pattern.kind === "LiteralExpression" && w.pattern.literalType === "string" ? String(w.pattern.value) : null;
        if (subjectAutoUnion && patternName) {
          const variant = subjectAutoUnion.variants.find((v: UnionVariant) => v.name === patternName);
          if (variant && variant.payload) {
            const index = subjectAutoUnion.variants.indexOf(variant);
            // Narrow via holds_alternative + std::get.
            const narrowName = `__ets_narrow_${index}`;
            const condBlock = `if (std::holds_alternative<${variant.payload}>(${subjectText}.payload)) { ${variant.payload} ${narrowName} = std::get<${variant.payload}>(${subjectText}.payload);`;
            this.inMatchCallback = true;
            let callbackCall: string;
            try { callbackCall = `${this.emitExpression(cb)}(${narrowName})`; }
            finally { this.inMatchCallback = false; }
            return `        ${condBlock} return ${callbackCall}; }`;
          }
        }
        callArgs = subjectText;
      }
      // V30.12.1: capturar `this` por referencia en callbacks de match para
      // permitir llamadas a métodos no-const de `this` aunque el método
      // exterior sea `const`. Restauramos el flag en finally por si la
      // emisión lanza (defensa).
      this.inMatchCallback = true;
      let callbackCall: string;
      try { callbackCall = `${this.emitExpression(cb)}(${callArgs})`; }
      finally { this.inMatchCallback = false; }
      return `        if ((${subjectAccess}) == (${patternText})) { return ${callbackCall}; }`;
    });
    // Forma del fallback según haya `whens` o no. Si hay `whens`, el
    // fallback es un `else`; si no, se ejecuta directamente (sin `else`
    // huérfano). Si no hay fallback en absoluto y tampoco `whens`, el
    // IIFE no tiene cuerpo útil: emitimos un comentario.
    //
    // `whenType<T>(cb)` SI narrowa el subject en V23.2 cuando el subject
    // es una union: emitimos `if (std::holds_alternative<T>(subj)) {
    // auto narrowed = std::get<T>(subj); return cb(narrowed); }`. Esto
    // corrige el comportamiento de V23.1 (que dejaba el narrowing fuera
    // de alcance y producía "is string" para los 3 inputs) sin
    // necesidad de tocar el LSP — el narrowing ocurre en el codegen,
    // que sí tiene la información de tipos. Para unions con N
    // variantes, los `whenType` se encadenan como `if/else if`, cada
    // uno con su `holds_alternative<T_i>`. El primero que matchea
    // ejecuta su callback con el valor narrowed.
    //
    // Si el subject NO es union (caso degenerado: el tipo del subject
    // no se puede narrowar), `whenType` cae al comportamiento legacy
    // de V23.1: solo el PRIMER `whenType` se emite como rama "siempre
    // matchea" y los siguientes quedan como comentarios `unreachable`.
    // Documentamos esto explícitamente.
    const subjectType = this.expressionType(subject);
    // V30.15.1: el subject puede ser un auto-union struct (`SvgChild_Union`)
    // o un union type string (`Line | Circle`). Ambos deben activar el
    // narrowing en `whenType`. `isUnionType` falla con el type string
    // sin espacios que retorna `typeOf`, asi que tambien chequeamos via
    // findAutoUnionForType.
    const subjectIsUnion = subjectType !== undefined
      && (isUnionType(subjectType) || this.findAutoUnionForType(subjectType) !== undefined);
    const liveFallback = fallbacks.find(f => f.kind === "otherwise");
    const whenTypeElements = fallbacks.filter(f => f.kind === "whenType");
    const unreachableComments: string[] = [];
    // Comentarios unreachable: si NO narrowing (subject no es union),
    // solo el primer whenType es activo. Si hay narrowing, todos
    // participan (cada uno con su T_i). `otherwise` extra: solo el
    // primero es activo (los siguientes son redundantes).
    if (!subjectIsUnion) {
      for (let i = 1; i < whenTypeElements.length; i++) {
        unreachableComments.push("whenType (unreachable: hay un whenType anterior que ya matchea siempre — V23.2 solo narrowa con unions)");
      }
    }
    if (liveFallback) {
      // Si hay un otherwise y también un whenType activo (con
      // narrowing), el otherwise es el `else` final. Sin narrowing
      // (subject no es union), el primer whenType se emite como
      // `else` directamente, por lo que un otherwise posterior
      // sería unreachable.
      if (!subjectIsUnion && whenTypeElements.length > 0) {
        for (const f of fallbacks) {
          if (f === liveFallback) continue;
          if (f.kind === "otherwise") unreachableComments.push("otherwise (unreachable: ya hay un whenType que matchea siempre)");
        }
      } else {
        for (const f of fallbacks) {
          if (f === liveFallback) continue;
          if (f.kind === "otherwise") unreachableComments.push("otherwise (unreachable: ya hay un otherwise anterior)");
        }
      }
    }
    let body: string;
    // Construimos las ramas en orden: primero las `when`, luego los
    // `whenType` (con narrowing via std::holds_alternative si el
    // subject es union, o comportamiento legacy si no lo es), y
    // finalmente el `otherwise` (que es el fallback definitivo).
    const whenTypeBranches: string[] = [];
    if (subjectIsUnion) {
      // Emite TODOS los whenType como if/else if, cada uno con su T_i.
      // V30.15.1: si el subject es un auto-union struct (type-alias union
      // o interface auto-union), el variant está en `subject.payload`,
      // no en `subject` directo. Detectamos via findAutoUnionForType.
      const subjAutoUnion = this.findAutoUnionForType(subjectType);
      const subjAccess = subjAutoUnion ? `${subjectText}.payload` : subjectText;
      for (let i = 0; i < whenTypeElements.length; i++) {
        const w = whenTypeElements[i]!;
        const whenTypeCall = caseList.elements.find(el =>
          el.kind === "CallExpression" && (el as { callee: string }).callee === "whenType"
            && (el as { callee: string }) === (whenTypeElements as unknown as Expression[])[i]
        ) as { typeArguments: TypeName[] } | undefined;
        // Fallback: si no encontramos el call por referencia, buscamos
        // el i-ésimo whenType.
        const allWhenTypeCalls = caseList.elements.filter(el =>
          el.kind === "CallExpression" && (el as { callee: string }).callee === "whenType"
        ) as { typeArguments: TypeName[] }[];
        const call = whenTypeCall ?? allWhenTypeCalls[i];
        const tArg = call?.typeArguments[0];
        if (!tArg) continue;
        const tCpp = cppType(tArg);
        const cb = w.callback;
        const hasCb = cb.kind === "ArrowFunctionExpression" && cb.params.length === 1;
        const prefix = i === 0 ? "if" : "else if";
        if (hasCb) {
          // V30.12.1: see note above — capture `this` by reference in match
          // callbacks so they can call non-const methods on `this`.
          this.inMatchCallback = true;
          let callbackCall: string;
          try { callbackCall = `${this.emitExpression(cb)}(__ets_match_narrowed_${this.cppName(tArg)})`; }
          finally { this.inMatchCallback = false; }
          whenTypeBranches.push(`        ${prefix} (std::holds_alternative<${tCpp}>(${subjAccess})) { auto __ets_match_narrowed_${this.cppName(tArg)} = std::get<${tCpp}>(${subjAccess}); return ${callbackCall}; }`);
        } else {
          // V30.12.1: mismo tratamiento para el callback sin params.
          this.inMatchCallback = true;
          let callbackCall: string;
          try { callbackCall = `${this.emitExpression(cb)}()`; }
          finally { this.inMatchCallback = false; }
          whenTypeBranches.push(`        ${prefix} (std::holds_alternative<${tCpp}>(${subjAccess})) { return ${callbackCall}; }`);
        }
      }
    } else if (whenTypeElements.length > 0) {
      // Comportamiento legacy: solo el primer whenType es activo.
      const cb = whenTypeElements[0]!.callback;
      // V30.12.1: capturar `this` por referencia en callbacks de match.
      this.inMatchCallback = true;
      let callbackCall: string;
      try { callbackCall = `${this.emitExpression(cb)}()`; }
      finally { this.inMatchCallback = false; }
      whenTypeBranches.push(`        else { return ${callbackCall}; }`);
    }
    let otherwiseBranch: string | undefined;
    if (liveFallback) {
      const cb = liveFallback.callback;
      let callArgs = "";
      if (cb.kind === "ArrowFunctionExpression" && cb.params.length === 1) callArgs = subjectText;
      // V30.12.1: capturar `this` por referencia en callbacks de match.
      this.inMatchCallback = true;
      let callbackCall: string;
      try { callbackCall = `${this.emitExpression(cb)}(${callArgs})`; }
      finally { this.inMatchCallback = false; }
      otherwiseBranch = `        else { return ${callbackCall}; }`;
    }
    // Encadenamos: `whens` con `if`/`else if`, luego `whenType` (que
    // actúa como un `else if (true) { ... }`), luego `otherwise` como
    // el `else` final. Si no hay nada antes, el `else` se convierte en
    // un bloque directo para evitar `else` huérfano.
    const allBranches: string[] = [];
    for (let i = 0; i < whensLines.length; i++) {
      const w = whensLines[i]!;
      // Reemplazamos el `if` por `else if` para todos los whens
      // excepto el primero, evitando el `else` huérfano cuando solo
      // hay un when.
      if (i === 0) allBranches.push(w);
      else allBranches.push(w.replace(/^        if \(/, "        else if ("));
    }
    for (const wt of whenTypeBranches) allBranches.push(wt);
    if (otherwiseBranch) allBranches.push(otherwiseBranch);
    if (allBranches.length === 0) {
      // Array vacío o todos los elementos eran inválidos. El checker
      // ya reportó el error; emitimos un comentario para no romper el
      // .cpp.
      body = `        // match: sin cases válidos`;
    } else if (allBranches.length === 1 && !liveFallback && whenTypeElements.length === 0) {
      // Solo hay `whens` (sin fallback). El último `if` no debe tener
      // `else` colgando — añadimos un else con `std::abort()`.
      const last = allBranches[0]!;
      body = `${last}\n        else { [[unlikely]] std::abort(); }`;
    } else if (allBranches.length === 1) {
      // Solo hay un fallback (whenType u otherwise) sin whens. Lo
      // emitimos como bloque directo sin `if/else`.
      const last = allBranches[0]!;
      body = last.replace(/^        (else )?\{/, "        {");
    } else {
      body = allBranches.join("\n");
    }
    if (unreachableComments.length > 0) {
      body = unreachableComments.map(c => `        // ${c}`).join("\n") + "\n" + body;
    }
    const allLines = body;
    // IIFE estilo V23: captura por referencia `[&]`, deduce
    // tipo de retorno con `-> R`, y devuelve el resultado. Si el tipo de
    // retorno es `void`, omitimos la flecha y los returns.
    if (resultType === "void") {
      return `([&]() { ${allLines} }())`;
    }
    return `([&]() -> ${resultType} { ${allLines} }())`;
  }

  // Emite `for (const auto& name : iterable)` para arrays y strings, envuelve
  // tuplas en un bloque con una única iteración, y proyecta pares de Map<K,V>
  // en tuplas `[K,V]` para mantener la semántica de indexación.
  private emitForOf(node: { binding: { name: string; mutable: boolean }; iterable: Expression; await?: boolean; body: Statement; span: import("../core/span.ts").Span }): string {
    const iterableType = this.expressionType(node.iterable);
    const name = node.binding.name;
    const iter = this.emitExpression(node.iterable);
    const bodyStr = this.bodyInBlock(node.body);
    // `for await (const x of arr)`: el iterable es `Promise<T>[]` y cada
    // elemento se desempaqueta con `co_await` (o `ets::syncWait` si no estamos
    // en una función async). La variable de iteración queda como `T`.
    if (node.await && iterableType && isArrayType(iterableType) && isGenericType(arrayElement(iterableType)) && genericBase(arrayElement(iterableType)) === "Promise") {
      const awaiter = this.inAsyncFunction ? "co_await" : "ets::syncWait";
      const itName = `${name}_iter`;
      const awaitedName = `${name}_awaited`;
      const unpack = `${this.pad()}auto ${awaitedName} = ${awaiter}(${itName});`;
      const innerBind = `${this.pad()}auto ${name} = ${awaitedName};`;
      const header = `${this.pad()}for (const auto& ${itName} : ${iter}) {\n${unpack}\n${innerBind}`;
      return `${header}\n${bodyStr}\n${this.pad()}}`;
    }
    if (iterableType && isArrayType(iterableType)) {
      return `${this.pad()}for (${node.binding.mutable ? "auto& " : "const auto& "}${name} : ${iter}) {\n${bodyStr}\n${this.pad()}}`;
    }
    if (iterableType === "string") {
      return `${this.pad()}for (char ${name} : ${iter}) {\n${bodyStr}\n${this.pad()}}`;
    }
    if (iterableType && isSetType(iterableType)) {
      return `${this.pad()}for (const auto& ${name} : (${iter}).data()) {\n${bodyStr}\n${this.pad()}}`;
    }
    if (iterableType && isMapType(iterableType)) {
      this.indent++;
      const tupleLine = `${this.pad()}auto ${name} = std::make_tuple(${name}_pair.first, ${name}_pair.second);`;
      this.indent--;
      return `${this.pad()}for (const auto& ${name}_pair : (${iter}).data()) {\n${tupleLine}\n${bodyStr}\n${this.pad()}}`;
    }
    if (iterableType && isTupleType(iterableType)) {
      this.indent++;
      const tupleLine = `${this.pad()}const auto& ${name} = ${iter};`;
      this.indent--;
      return `${this.pad()}{\n${tupleLine}\n${bodyStr}\n${this.pad()}}`;
    }
    return `${this.pad()}/* for..of: tipo iterable no soportado */`;
  }

  // V30.1: deteccion de patron "loop with push_back". Devuelve la
  // expresion a emitir como `reserve(N)` antes del for, o null si el
  // patron no aplica.
  //
  // Patron reconocido:
  //   for (let i = 0; i < N; i = i + 1) {
  //     arr.push(expr);
  //   }
  // o
  //   for (let i: number = 0; i < N; i = i + 1) {
  //     arr.push(expr);
  //   }
  // o
  //   for (let i = 0; i < N; i = i + 1) arr.push(expr);
  //
  // Devuelve `${arrStr}.reserve(${N})` si aplica, o null.
  private detectPushBackReserveHint(node: {
    initializer?: VariableDeclaration | ExpressionStatement;
    condition?: Expression;
    increment?: Expression;
    body: Statement;
  }): string | null {
    // 1. El initializer debe ser una declaracion de variable numerica
    //    (el counter del loop). Aceptamos tanto los tipos numericos
    //    concretos (i32, f64, ...) como el alias `number` del dialecto.
    if (!node.initializer || node.initializer.kind !== "VariableDeclaration") return null;
    const initVar = node.initializer;
    if (!initVar.declaredType) return null;
    const isNum = initVar.declaredType === "number" || isNumericType(initVar.declaredType);
    if (!isNum) return null;

    // 2. La condition debe ser `counter < N` (BinaryExpression con `<`).
    if (!node.condition || node.condition.kind !== "BinaryExpression") return null;
    const cond = node.condition;
    if (cond.operator !== "<") return null;
    const condLhsIsCounter =
      cond.left.kind === "IdentifierExpression" && cond.left.name === initVar.name;
    const condRhsIsCounter =
      cond.right.kind === "IdentifierExpression" && cond.right.name === initVar.name;
    if (!condLhsIsCounter && !condRhsIsCounter) return null;
    // El N (cota superior) es el lado que NO es el counter.
    const upperBoundExpr = condLhsIsCounter ? cond.right : cond.left;
    // N debe ser un LiteralExpression o IdentifierExpression.
    if (upperBoundExpr.kind !== "LiteralExpression" &&
        upperBoundExpr.kind !== "IdentifierExpression") {
      return null;
    }

    // 3. El increment debe ser algo tipo `i = i + 1` o `i++` (o el
    //    equivalente). Si no, es muy arriesgado asumir monotonia.
    //    Aceptamos varios patrones comunes:
    //    - AssignmentExpression con target == counter
    //    - UpdateExpression (++i o i++) — no tenemos nodo explicito;
    //      el codegen lo emite como assignment.
    if (!node.increment) return null;
    if (node.increment.kind !== "AssignmentExpression") return null;
    const inc = node.increment;
    if (inc.target.kind !== "IdentifierExpression" || inc.target.name !== initVar.name) return null;

    // 4. El body debe ser un unico push_back.
    const pushStmt = this.extractSinglePushBack(node.body);
    if (!pushStmt) return null;

    // 5. Emite el reserve. upperBoundExpr se emite como CPP.
    const upperStr = this.emitExpression(upperBoundExpr);
    const arrStr = this.emitExpression(pushStmt.object);
    return `${arrStr}.reserve(${upperStr})`;
  }

  // Extrae el push_back unico del body de un for, si existe y el
  // body no hace nada mas que ese push_back. Devuelve el push_back
  // (MemberCallExpression) o null.
  private extractSinglePushBack(
    body: Statement,
  ): { object: Expression; method: string; args: Expression[] } | null {
    // Caso 1: body es directamente el push_back (sin block).
    if (body.kind === "ExpressionStatement" && body.expression.kind === "MemberCallExpression") {
      const mc = body.expression;
      if (mc.method === "push" && isArrayType(this.expressionType(mc.object))) {
        return mc;
      }
      return null;
    }
    // Caso 2: body es un BlockStatement con exactamente un push_back.
    if (body.kind === "BlockStatement") {
      const stmts = body.statements;
      if (stmts.length !== 1) return null;
      if (stmts[0].kind !== "ExpressionStatement") return null;
      const inner = stmts[0].expression;
      if (inner.kind !== "MemberCallExpression") return null;
      const mc = inner;
      if (mc.method !== "push") return null;
      if (!isArrayType(this.expressionType(mc.object))) return null;
      // Seguridad: el push debe usar el counter de alguna forma
      // (o un valor independiente). Si usa una variable que el for
      // declara/modifica, no podemos asumir que solo se hace push.
      // Por simplicidad, aceptamos cualquier push.
      return mc;
    }
    return null;
  }

  // Emite bucles de índice para arrays y proyecciones de clave para Map<K,V>.
  private emitForIn(node: { binding: { name: string; mutable: boolean }; target: Expression; body: Statement; span: import("../core/span.ts").Span }): string {
    const targetType = this.expressionType(node.target);
    const name = node.binding.name;
    const target = this.emitExpression(node.target);
    const bodyStr = this.bodyInBlock(node.body);
    if (targetType && isArrayType(targetType)) {
      this.indent++;
      const declLine = `${this.pad()}double ${name} = static_cast<double>(${name}_i);`;
      this.indent--;
      return `${this.pad()}for (std::size_t ${name}_i = 0; ${name}_i < (${target}).size(); ++${name}_i) {\n${declLine}\n${bodyStr}\n${this.pad()}}`;
    }
    if (targetType && isMapType(targetType)) {
      this.indent++;
      const declLine = `${this.pad()}auto ${name} = ${name}_pair.first;`;
      this.indent--;
      return `${this.pad()}for (const auto& ${name}_pair : (${target}).data()) {\n${declLine}\n${bodyStr}\n${this.pad()}}`;
    }
    return `${this.pad()}/* for..in: tipo no soportado */`;
  }

  // Emite el cuerpo de un bucle garantizando que cada enunciado salga indentado
  // un nivel más que el bloque contenedor. Si `body` es un bloque, lo "aplana"
  // (emite solo sus enunciados internos); si es un enunciado único, lo emite
  // tal cual. El llamador se encarga de envolver el resultado en sus propias
  // llaves.
  private bodyInBlock(body: Statement): string {
    if (body.kind === "BlockStatement") {
      this.indent++;
      const lines = body.statements.map(statement => this.emitStatement(statement));
      this.indent--;
      return lines.join("\n");
    }
    this.indent++;
    const line = this.emitStatement(body);
    this.indent--;
    return line;
  }
  /**
   * Devuelve el tipo C++ para un parámetro de función, teniendo en cuenta
   * los modificadores de paso:
   *
   * - `Mut<T>` → `T*`    (puntero mutable, no-owning).
   * - `MutRef<T>` → `T&` (referencia mutable, no-owning).
   * - Otros tipos → cppType normal.
   *
   * `Un<T>` y `Rc<T>` mantienen su envoltorio (`ets::Un<T>`, `ets::Rc<T>`)
   * porque tienen semántica de ownership distinta (move y refcount).
   *
   * El caller detecta estos casos y ajusta el modo de paso (parameter.passing)
   * para que cppParameterDeclaration emita el puntero/referencia en lugar
   * de `const T&` automático.
   */
  private cppParameterType(type: TypeName): string {
    // V22 (Memory Model v2): los modificadores ptr/ref/constPtr/constRef
    // ya se traducen en cppParameterDeclaration a través de
    // resolveParameterModifier. Esta función es un pass-through.
    // V30.12.2: los parámetros tipo `Array<Interface>` deben mapearse al
    // auto-union concreto (`std::vector<I_AutoUnion>`), igual que los campos.
    if (isArrayType(type) || (isGenericType(type) && genericBase(type) === "Array")) return this.arrayCppType(type);
    // V30.15: type-alias union (no en array) -> `Alias_Union`.
    const ta = this.typeAliasUnionType(type);
    if (ta) return ta;
    return cppType(type);
  }

  /**
   * Devuelve false en V22 (Memory Model v2): el codegen ya NO añade `&`
   * automático a lvalues pasados a parámetros, porque:
   *
   *   - `ptr<T>` / `constPtr<T>` esperan `std::unique_ptr<T>` por valor
   *     (ownership). Pasar `&(x)` daría un `unique_ptr*` y no compila.
   *     El call site pasa `x` directamente y C++ lo mueve.
   *
   *   - `ref<T>` / `constRef<T>` esperan `T&` / `const T&` por referencia.
   *     C++ ya vincula lvalues a referencias automáticamente (no hace
   *     falta `&` explícito). Pasar `&(x)` daría `T*` que no es
   *     convertible a `T&` (es la razón por la que un fix inicial que
   *     añadía `&` para `ref`/`constRef` rompía la compilación de
   *     tests como `constref-read` y `ref-mutate`).
   *
   * El único caso pre-V22 que necesitaba `&` era `Mut<T>` → `T*`. Pero
   * `Mut<T>` se eliminó en V22, así que la función ahora siempre
   * devuelve false y queda como hook histórico por si un futuro
   * modificador "raw pointer" reaparece.
   */
  private argumentExpectsPtrPointer(_call: { callee: string; args: Expression[] }, _index: number, _argument: Expression): boolean {
    return false;
  }

  /**
   * Devuelve true si la expresión es un lvalue (puede tomar su dirección).
   * En el dialecto: identificadores, member access, index.
   */
  private isLvalue(expr: Expression): boolean {
    return expr.kind === "IdentifierExpression"
      || expr.kind === "MemberExpression"
      || expr.kind === "IndexExpression";
  }

  /**
   * Devuelve true si el identificador corresponde a un parámetro declarado
   * como `Mut<T>`. En ese caso el codegen debe usar `->` para acceder a
   * miembros (porque en C++ es `T*`).
   */
  private identifierIsPtrPointer(name: string): boolean {
    // V22 (Memory Model v2): un identificador es un puntero (ptr<T>) si:
    //   (a) algún parámetro top-level con ese nombre fue declarado como ptr<T>, o
    //   (b) el checker lo marcó como ptr<T> en su resolvedType.
    // En cualquier caso, el codegen usa `->` para acceder a miembros.
    for (const overloads of this.topLevelFunctions.values()) {
      for (const signature of overloads) {
        for (const parameter of signature.params) {
          if (parameter.name === name && isGenericType(parameter.type) && genericBase(parameter.type) === "ptr") return true;
        }
      }
    }
    // Variables locales: usamos el tipo de la expresión para detectar ptr<T>.
    // Esta es una heurística: si el nombre es una variable y su tipo es
    // `ptr<T>`, tratamos sus accesos como `->`.
    if (this.identifierTypes.has(name)) {
      const t = this.identifierTypes.get(name);
      if (t && isGenericType(t) && genericBase(t) === "ptr") return true;
    }
    return false;
  }

  private variableIsConst(node: VariableDeclaration): boolean { return !node.mutable && !(node.initializer.kind === "ArrowFunctionExpression" && node.initializer.mutatesCapturedState); }

  /**
   * Devuelve true si el initializer es una llamada a un helper que retorna
   * por referencia (`returnsRef: true` en HELPER_METADATA). En ese caso el
   * codegen emite `T& x = ...` en lugar de `T x = ...` para evitar la copia.
   *
   * Ejemplos:
   *   let holder: Counter = mutRefValue(ref);     // holder es Counter&
   *   let inner: T = unValue(u);                  // inner es T&
   *   let x: Counter = counter;                   // x es Counter (copia)
   */
  private expressionReturnsRef(node: Expression): boolean {
    if (node.kind === "CallExpression") {
      const call = node as CallExpression;
      const meta = HELPER_METADATA[call.callee];
      return !!(meta && meta.returnsRef);
    }
    return false;
  }
  private statementBody(node: Statement): string { if (node.kind === "BlockStatement") return this.emitBlock(node); this.indent++; const body = `{\n${this.emitStatement(node)}\n`; this.indent--; return body + this.pad() + "}"; }
  private emitBlock(node: BlockStatement, appendCoReturn = false): string { const lines = ["{"]; this.indent++; for (const s of node.statements) lines.push(this.emitStatement(s)); if (appendCoReturn) lines.push(this.pad() + "co_return;"); this.indent--; lines.push(this.pad() + "}"); return lines.join("\n"); }
  private emitExpression(node: Expression, targetType?: TypeName): string {
    switch (node.kind) {
      case "LiteralExpression": {
        if (typeof node.value === "string") return `std::string(${JSON.stringify(node.value)})`;
        if (typeof node.value === "boolean") return String(node.value);
        // Para números: si el parser guardó el lexema original con un prefijo
        // no decimal (`0x`/`0o`/`0b` de TS), lo emitimos tal cual (limpiando
        // los `_` separadores) para preservar la forma legible. C++ acepta
        // los mismos prefijos que TS, así que la traducción es directa.
        // Para números: si el parser guardó el lexema original con un prefijo no
        // decimal, lo emitimos como literal C++ válido.
        //   - `0x`/`0X` (hex): se preserva porque C++ lo soporta nativamente.
        //     Para forzar el tipo `double` (el dialecto modela `number` como
        //     `double`), añadimos `p0` que es el exponente binario C++.
        //   - `0o`/`0O` (octal) y `0b`/`0B` (binario): C++ NO los soporta como
        //     literales estándar, así que los convertimos a decimal. El
        //     resultado es funcionalmente equivalente y evita requerir
        //     `-fext-numeric-literals` (extensión GCC).
        if (node.raw && /^0[xXoObB]/.test(node.raw)) {
          const cleaned = node.raw.replace(/_/g, "");
          if (/^0[xX]/.test(cleaned)) return `${cleaned}.0p0`;
          return `${node.value}.0`;
        }
        return Number.isInteger(node.value) ? `${node.value}.0` : String(node.value);
      }
      case "TemplateLiteralExpression": {
        // Emitimos cada parte como literal y cada expresión tal cual; `ets::concat`
        // usa `operator<<` para que cualquier tipo (number, boolean, string, etc.)
        // se serialice correctamente.
        const parts: string[] = [];
        for (let i = 0; i < node.parts.length; i++) {
          if (node.parts[i].length) parts.push(`std::string(${JSON.stringify(node.parts[i])})`);
          if (i < node.expressions.length) parts.push(this.emitExpression(node.expressions[i]));
        }
        return parts.length ? `ets::concat(${parts.join(", ")})` : `std::string("")`;
      }
      case "IdentifierExpression": return node.name === "this" ? "(*this)" : this.cppName(this.resolveAlias(node.name));
      case "GenericIdentifierExpression": {
        // V1.2: `Name<T1, T2>` antes de un member access en constructor de
        // unión. Se emite como `Name<T1, T2>` (no se llama como valor).
        const args = node.typeArguments.map(t => cppType(t)).join(", ");
        return `${node.name}<${args}>`;
      }
      case "ObjectLiteralExpression": {
        // V1.4: object literal como constructor inline. Se emite como llamada
        // al constructor de la variante con el payload. Ej:
        //   `{ ok: true, value: x }` → `Ok(x)`
        //   `{ ok: false, error: e }` → `Err(e)`
        // El type-checker ya validó que el literal coincide con una variante
        // del union esperado.
        const type = this.expressionType(node);
        if (!type) return "{}";
        const unionName = isGenericType(type) ? genericBase(type) : type;
        const unionNode = this.unionsMap.get(unionName);
        if (!unionNode) return "{}";
        const discProp = node.properties[0];
        const discValue = discProp.value.kind === "LiteralExpression" ? discProp.value.value : null;
        const variant = unionNode.variants.find(v => v.discriminator && v.discriminator.field === discProp.key && v.discriminator.value === discValue);
        if (!variant) return "{}";
        const bindings = node.properties.slice(1);
        if (!variant.payload) return `${variant.name}()`;
        const values = bindings.map(b => this.emitExpression(b.value));
        return `${variant.name}(${values.join(", ")})`;
      }
      case "ArrayLiteralExpression": {
        const type = this.expressionType(node);
        // V30.13: los arrays `Array<Interface>` deben mapearse al auto-union
        // concreto (`std::vector<I_AutoUnion>`), no quedarse en
        // `std::vector<SvgChild>` que es solo un concept.
        const cppArrayType = (t: TypeName): string => (isArrayType(t) || (isGenericType(t) && genericBase(t) === "Array")) ? this.arrayCppType(t) : cppType(t);
        if (type && isTupleType(type)) {
          const values = node.elements.map(item => this.emitExpression(item));
          return `std::make_tuple(${values.join(", ")})`;
        }
        // V4: arrays de tamaño fijo. Cada elemento se emite con static_cast
        // al tipo del elemento, así el compilador C++ no se queja de
        // narrowing (p.ej. `uint8_t` desde `double` literal).
        if (type && isFixedArrayType(type)) {
          const elementCppType = cppType(fixedArrayElement(type)!);
          const values = node.elements.map(item => `static_cast<${elementCppType}>(${this.emitExpression(item as import("../ast/nodes.ts").Expression)})`);
          return `std::array<${elementCppType}, ${fixedArraySize(type)!}>{${values.join(", ")}}`;
        }
        // Envoltorio en `std::move(...)` para que el initializer_list acepte
        // tipos move-only (Task<T>, Optional<T>, Result<T>). Para tipos copiables
        // es equivalente (mover es una opción, copiar es la otra).
        const moveValues = (items: string[]) => items.map(item => `std::move(${item})`).join(", ");
        if (node.elements.some(item => item.kind === "SpreadElement")) {
          // Spread en array literal: generamos un lambda inmediato que toma
          // el vector destino por valor (RVO al final) y va `push_back` para
          // cada elemento y `insert(end, src.begin(), src.end())` para cada
          // spread. La sintaxis `[capture](auto dst) -> decltype(dst) { ... return dst; }(T{})`
          // deja el resultado como una expresión de tipo T (copy elision).
          // V30.13.4: si los spreads o elementos usan `this` o variables
          // locales del metodo, hay que capturarlas.
          // V30.13.4 (match callback): si estamos dentro de un metodo de
          // clase, capturamos `this` por defecto (igual que en match
          // callbacks, ver V30.12.1). Tambien capturamos cualquier
          // parametro o variable local que el type-checker reporte.
          const captureSet = new Set<string>();
          if (this.inClassMethod) {
            captureSet.add("this");
            // Capturar tambien los parametros del metodo actual
            // (necesarios para spread que los use, e.g.
            // `this.children = [...this.children, ...more]`).
            for (const param of this.currentClassMethodParams) captureSet.add(param);
          }
          const collectCaptures = (e: import("../ast/nodes.ts").Expression): void => {
            for (const symbol of (e as { capturedSymbols?: string[] }).capturedSymbols ?? []) {
              captureSet.add(symbol);
            }
          };
          for (const item of node.elements) {
            if (item.kind === "SpreadElement") collectCaptures(item.expression);
            else collectCaptures(item);
          }
          const cpp = cppArrayType(type ?? "void[]");
          const items: string[] = [];
          for (const item of node.elements) {
            if (item.kind === "SpreadElement") {
              items.push(`dst.insert(dst.end(), (${this.emitExpression(item.expression)}).begin(), (${this.emitExpression(item.expression)}).end());`);
            } else {
              items.push(`dst.push_back(${this.emitExpression(item as import("../ast/nodes.ts").Expression)});`);
            }
          }
          // Construir el lambda con su captura. La sintaxis C++ requiere
          // que los corchetes esten siempre: `[]` para captura vacia,
          // `[this, x]` para captura con valores. No se puede tener
          // `[this][]` ni nada parecido.
          const captureList = Array.from(captureSet).join(", ");
          const lambda = captureList
            ? `[${captureList}](${cpp} dst) -> ${cpp} { ${items.join(" ")} return dst; }`
            : `[](${cpp} dst) -> ${cpp} { ${items.join(" ")} return dst; }`;
          return `(${lambda})(${cpp}{})`;
        }
        // Para arrays con tipos move-only (Task<T>, Optional<T>, Result<T>), el
        // initializer_list de std::vector siempre copia, así que generamos un
        // lambda que hace push_back por movimiento. Para tipos copiables,
        // `std::vector<T>{...}` funciona directamente.
        const valueType = cppArrayType(type ?? "void[]");
        // V30.14.2: propagamos el element type al emit de cada item
        // para que `new Line()` dentro de un array sepa que el target
        // es un auto-union y aplique el wrap con `make_X`.
        const elementType = (type && (isArrayType(type) || (isGenericType(type) && genericBase(type) === "Array"))) ? genericArguments(type)[0] ?? (isArrayType(type) ? arrayElement(type) : undefined) : undefined;
        const values = node.elements.map(item => {
          if (item.kind === "SpreadElement") return this.emitExpression(item as unknown as import("../ast/nodes.ts").Expression);
          return this.emitExpression(item as import("../ast/nodes.ts").Expression, elementType);
        });
        if (node.elements.some(item => item.kind === "SpreadElement")) {
          // (spread path) - ver bloque arriba
        }
        if (values.length === 0) return `${valueType}()`;
        // Detectar tipos move-only por inspección del nombre del tipo (heurística
        // simple). Para esos tipos, generar una lambda constructora con push_back.
        const isMoveOnlyType = /ets::Task<|ets::Optional<|ets::Result</.test(valueType);
        if (isMoveOnlyType) {
          const pushes = values.map(value => `dst.push_back(std::move(${value}));`).join(" ");
          return `([](${valueType} dst) -> ${valueType} { ${pushes} return dst; })(${valueType}())`;
        }
        return `${valueType}{${moveValues(values)}}`;
      }
      case "ArrowFunctionExpression": {
        const type = this.expressionType(node); const result = type && isFunctionType(type) ? functionResult(type) : (node.returnType ?? "void");
        const params = node.params.map(parameter => cppParameterDeclaration(parameter, cppType(parameter.type), false, parameter.defaultValue ? this.emitExpression(parameter.defaultValue) : undefined)).join(", ");
        // Las lambdas a nivel de archivo (estáticas) no admiten capture-default; usamos `[]`
        // y dependeremos de `mutatesCapturedState` para forzar `mutable` si hace falta.
        // Si la closure muta estado capturado, capturamos por referencia (`[&]`) para
        // que las mutaciones sean visibles fuera de la lambda.
        // V10: si el type-checker marcó `capturedSymbols`, emitimos captura
        // explícita solo de esos nombres en lugar de `[=]`. Esto permite al
        // optimizador de C++ inlinificar el lambda con menos carga (las variables
        // que no se usan no entran en el closure object). Si `capturedSymbols`
        // está vacío, la lambda no captura nada: usamos `[]`.
        let capture: string;
        if (this.inStaticInit) capture = "[]";
        else if (this.inClassMethod) capture = this.inMatchCallback ? "[&, this]" : "[=, this]";
        else if (node.capturedSymbols !== undefined) {
          // V28: filtramos los namespaces globales que NO son variables
          // (http, Math, Date, console, fs, path, process, JSON, FileReader,
          // etc). Si el type-checker los marcó como capturados, es un
          // falso positivo: el codegen traduce `http.param(req, x)` a
          // `::ets::http_param(req, x)`, que es una llamada libre sin
          // captura. Sin este filtro, el lambda intenta capturar `http`
          // que no existe como variable y g++ falla.
          const NAMESPACES_NOT_CAPTURED = new Set([
            "http", "Math", "Date", "console", "fs", "path", "process",
            "JSON", "Math2", "FileReader", "Server",
          ]);
          const filtered = node.capturedSymbols.filter(s => !NAMESPACES_NOT_CAPTURED.has(s));
          if (filtered.length === 0) capture = "[]";
          else if (node.mutatesCapturedState) capture = `[&${filtered.join(", ")}]`;
          else capture = `[${filtered.join(", ")}]`;
        }
        else capture = node.mutatesCapturedState ? "[&]" : "[=]";
        const mutable = node.mutatesCapturedState ? " mutable" : "";
        if (node.body.kind === "BlockStatement") return `${capture}(${params})${mutable} -> ${cppType(result)} ${this.emitBlock(node.body)}`;
        return `${capture}(${params})${mutable} -> ${cppType(result)} { return ${this.emitExpression(node.body)}; }`;
      }
      case "UnaryExpression": {
        if (node.operator === "typeof") {
          // Resolvemos el tipo canónico del operando para pasarlo al template
          // `ets::typeofOf<T>()`. `cppType` añade referencias/const cuando el
          // operando es un parámetro mut/out; el helper usa `std::decay_t`
          // para reducirlas al tipo base.
          const operandType = this.expressionType(node.operand) ?? "void";
          return `ets::typeofOf<${cppType(operandType)}>()`;
        }
        return `(${node.operator}${this.emitExpression(node.operand)})`;
      }
      case "AwaitExpression": return this.inAsyncFunction ? `(co_await ${this.emitExpression(node.operand)})` : `ets::syncWait(${this.emitExpression(node.operand)})`;
      case "BinaryExpression": {
        if (node.operator === "instanceof") {
          // Para unions se valida en runtime con `std::holds_alternative`.
          // Para clases o primitivos no hay herencia dinámica en etsc, así
          // que la verificación es estática y siempre verdadera: emitimos
          // `true`. Documentado en el ejemplo.
          const leftStr = this.emitExpression(node.left);
          const leftType = this.expressionType(node.left);
          if (leftType && isUnionType(leftType)) {
            // El parser empaqueta el tipo derecho en un IdentifierExpression
            // sintético; extraemos el nombre directamente.
            const rightName = node.right.kind === "IdentifierExpression" ? node.right.name : "void";
            return `std::holds_alternative<${cppType(rightName)}>(${leftStr})`;
          }
          return `true /* instanceof sobre tipo no-union: etsc no tiene herencia */`;
        }
        if (node.operator === "+" && this.expressionType(node) === "string") return `ets::concat(${this.stringConcatParts(node).map(part => this.emitExpression(part)).join(", ")})`;
        // V1.3: las tagged unions declaran su propio `operator==` (en
        // `unionDeclaration`) que dispatcha por discriminador, así que
        // C++ resuelve la comparación de forma natural cuando ambos
        // operandos son la MISMA tagged union. No inyectamos código
        // extra aquí: si `operator==` no existiera el compilador ya
        // habría rechazado el programa al verificar el tipo. Esto
        // evita lambdas IIFE con bloques GCC-extension y mantiene el
        // codegen declarativo.
        if ((node.operator === "==" || node.operator === "!=") && this.unionNames.size > 0) {
          const leftType = this.expressionType(node.left);
          const rightType = this.expressionType(node.right);
          const leftUnion = leftType ? this.unionFromType(leftType) : undefined;
          const rightUnion = rightType ? this.unionFromType(rightType) : undefined;
          if (leftUnion && leftUnion === rightUnion) {
            return `(${this.emitExpression(node.left)} ${node.operator} ${this.emitExpression(node.right)})`;
          }
        }
        // V3: comparación entre tipos numéricos concretos se promueve a
        // `double` (idem aritmética) para evitar narrowing warnings.
        if ((node.operator === "==" || node.operator === "!=") && this.sameNumericExprType(node.left, node.right)) {
          const leftText = this.numericOperandAsDouble(node.left);
          const rightText = this.numericOperandAsDouble(node.right);
          return `(${leftText} ${node.operator} ${rightText})`;
        }
        // Operadores bitwise: el dialecto modela `number` como `double`, pero
        // C++ rechaza `|`/`&`/`^`/etc. entre doubles. Hacemos cast explícito
        // a `std::int64_t` para la operación y devolvemos `double`. V3: los
        // tipos numéricos concretos (i8..u64) también se promueven a int64
        // para bitwise; f32/f64 no se admiten en bitwise (rechazado por el
        // type-checker en requireNumericOperand).
        if (["|", "&", "^", "<<", ">>"].includes(node.operator)) {
          return `(static_cast<std::int64_t>(${this.emitExpression(node.left)}) ${node.operator} static_cast<std::int64_t>(${this.emitExpression(node.right)}))`;
        }
        // `??` (nullish coalescing) está rechazado semánticamente por el type-checker;
        // dejamos una rama aquí por si en el futuro se re-introduce con una
        // representación de "ausente" mejor (p.ej. `std::optional`).
        if (node.operator === "??") {
          // `??` se desazucara a `optionalValueOr(lhs, default)`. El type-checker
          // garantiza que lhs es `Optional<T>` y default es `T`.
          return `optionalValueOr(${this.emitExpression(node.left)}, ${this.emitExpression(node.right)})`;
        }
        // V3: aritmética y comparación entre numéricos concretos se promueven
        // a `double` (mismo tratamiento que `number`). Si el operando ya es
        // `number` no añadimos el cast (sería redundante).
        const leftText = this.numericOperandAsDouble(node.left);
        const rightText = this.numericOperandAsDouble(node.right);
        return node.operator === "%" ? `std::fmod(${leftText}, ${rightText})` : `(${leftText} ${node.operator} ${rightText})`;
      }
      case "AssignmentExpression": {
        // V30.14.2: propagamos el target type al emit del value para
        // que el NewExpression (en el RHS) sepa que el target es un
        // auto-union y aplique el wrap con `make_X`.
        const targetType = this.expressionType(node.target);
        let valueText = this.emitExpression(node.value, targetType);
        if (targetType && isNumericType(targetType)) {
          const valueType = this.expressionType(node.value);
          if (valueType && (valueType === "number" || isNumericType(valueType)) && valueType !== targetType) {
            valueText = `static_cast<${cppType(targetType)}>(${valueText})`;
          }
        }
        return `(${this.emitExpression(node.target)} = ${valueText})`;
      }
      case "TernaryExpression": return `(${this.emitExpression(node.condition)} ? ${this.emitExpression(node.thenBranch)} : ${this.emitExpression(node.elseBranch)})`;
      case "MatchExpression": return this.emitMatch(node);
      case "SatisfiesExpression": return this.emitExpression(node.operand);
      case "CallExpression": {
        // V23: si el type-checker validó este nodo como `match(value, [...])`
        // o `match(value, "key", [...])`, NO emitimos una llamada normal. En
        // su lugar generamos un IIFE con un if/else chain equivalente al
        // `MatchExpression` V2. Esto evita que se intente enlazar con una
        // función `match`/`when`/`whenType`/`otherwise` que no existe en el
        // runtime. El checker deja `node.matchedKind = "match"` y
        // `node.matchedDiscriminator?` / `node.matchedResultType?` como
        // metadata para que esta función decida el formato.
        if (node.matchedKind === "match") return this.emitNewMatch(node);
        // V3: cast explícito entre tipos numéricos concretos. `i32(x)` se
        // reescribe a `static_cast<int32_t>(x)`. El callee es uno de los
        // 10 primitivos numéricos (i8..u64, f32, f64) y debe tener exactamente
        // un argumento. Esto es azúcar sobre `CallExpression` para no añadir
        // un nuevo tipo de nodo AST (cumple "AST estable: solo campos aditivos").
        if (isNumericType(node.callee) && node.args.length === 1 && node.typeArguments.length === 0) {
          const arg = node.args[0]!;
          let text = this.emitExpression(arg);
          // Enums: el resultado del cast debe pasar por el subyacente (id. resto de casts).
          const argType = this.expressionType(arg);
          const underlying = argType && this.enumUnderlying.get(argType);
          if (underlying === "number") text = `static_cast<double>(${text})`;
          else if (underlying === "string") text = `static_cast<std::string>(${text})`;
          return `static_cast<${cppType(node.callee)}>(${text})`;
        }
        // V22: pasamos el tipo esperado del parámetro como targetType para
        // que el NewExpression use make_unique cuando el parámetro es
        // ptr<T>/constPtr<T>. Usamos la primera sobrecarga top-level si existe.
        let expectedParamTypes: TypeName[] = [];
        if (node.callee && this.topLevelFunctions.has(node.callee)) {
          const overloads = this.topLevelFunctions.get(node.callee)!;
          if (overloads.length > 0) expectedParamTypes = overloads[0].params.map(p => p.type);
        }
        // V22 (Memory Model v2): `move(x)` se traduce a `std::move(x)`.
        // El type-checker se encarga de trackear el estado Moved; aquí
        // solo emitimos el código C++.
        if (node.callee === "move" && node.args.length === 1) {
          return `std::move(${this.emitExpression(node.args[0])})`;
        }
        // V22 (Memory Model v2): `ref(x)` y `constRef(x)` se traducen al
        // lvalue directo. El "&" en el tipo declarado lo añade
        // `expressionReturnsRef()` (HELPER_METADATA.returnsRef = true).
        // Aqui solo emitimos el argumento sin transformar.
        if ((node.callee === "ref" || node.callee === "constRef") && node.args.length === 1) {
          return this.emitExpression(node.args[0]);
        }
        // V28: `length(x)` builtin (string | array | tuple) -> number.
        // Para arrays/tuplas usa .size() del std::vector; para strings
        // usa ets::string_length.
        if (node.callee === "length" && node.args.length === 1) {
          const arg = node.args[0]!;
          const argText = this.emitExpression(arg);
          const argType = this.expressionType(arg);
          if (argType === "string") return `::ets::string_length(${argText})`;
          if (argType && (isArrayType(argType) || isTupleType(argType))) return `(${argText}).size()`;
          // Fallback: emite como llamada normal (deberia fallar el type-check).
          return `${argText}.size()`;
        }
        const args = node.args.map((argument, index) => {
          let text = this.emitExpression(argument, expectedParamTypes[index]);
          if (this.expressionIsVariadic(argument)) text += "...";
          else {
            // Enums: ni `enum class` ni el struct de cadena convierten implícitamente
            // al tipo subyacente en contextos como `print()` (que usa `operator<<`) o
            // funciones que esperan `number`/`string`. Forzamos la conversión aquí.
            const argType = this.expressionType(argument);
            const underlying = argType && this.enumUnderlying.get(argType);
            if (underlying === "number") text = `static_cast<double>(${text})`;
            else if (underlying === "string") text = `static_cast<std::string>(${text})`;
            // V3: tipos numéricos concretos también requieren cast explícito
            // cuando se pasan a APIs que esperan `double` (p.ej. `numberToString`,
            // `print`). Sin el cast, `int8_t`/`uint8_t` se imprimirían como char.
            else if (argType && isNumericType(argType)) text = `static_cast<double>(${text})`;
          }
          // V22 (Memory Model v2): ningún modificador requiere prefijar `&` al
          // call site. `ref<T>`/`constRef<T>` ya aceptan lvalues por la
          // regla C++ de vinculación lvalue→referencia, y `ptr<T>`/
          // `constPtr<T>` esperan `std::unique_ptr<T>` por valor. Ver
          // `argumentExpectsPtrPointer` (siempre false).
          return text;
        });
        // Si la función tiene exactamente una sobrecarga y el call site omitió
        // argumentos opcionales, los rellenamos con `optionalNone<T>()` para
        // mantener la firma C++ consistente.
        if (node.callee) {
          const overloads = this.topLevelFunctions.get(node.callee);
          if (overloads && overloads.length === 1) {
            const params = overloads[0].params;
            for (let index = args.length; index < params.length; index++) {
              const parameter = params[index];
              if (!parameter.optional) break;
              const innerType = parameter.type;
              // Si el user ya escribió `Optional<T>`, no envolver.
              if (isGenericType(innerType) && genericBase(innerType) === "Optional") args.push(`ets::Optional<${cppType(genericArguments(innerType)[0] ?? "void")}>::none()`);
              else args.push(`ets::Optional<${cppType(innerType)}>::none()`);
            }
          }
        }
        const typeArguments = node.typeArguments.length ? node.typeArguments : this.callTypeArguments(node);
        const callee = this.resolveAlias(node.callee);
        // Mapeo de helpers del dialecto a wrappers runtime. Tanto filesystem
        // (fileRead → etsFsRead) como networking (tcpListen → etsNetListen)
        // usan el prefijo `ets` para evitar colisión con posibles APIs
        // futuras del runtime.
        const fileCalleeMap: Record<string, string> = {
          fileRead:   "etsFsRead",
          fileWrite:  "etsFsWrite",
          fileAppend: "etsFsAppend",
          fileCopy:   "etsFsCopy",
          fileMove:   "etsFsMove",
          fileRemove: "etsFsRemove",
        };
        const netCalleeMap: Record<string, string> = {
          tcpListen:  "etsNetListen",
          tcpAccept:  "etsNetAccept",
          tcpConnect: "etsNetConnect",
          tcpRead:    "etsNetRead",
          tcpWrite:   "etsNetWrite",
          tcpClose:   "etsNetClose",
        };
        // V16: helpers async y de cancelación viven en el namespace `ets::`
        // (definidos en `runtime/ets_async.hpp`). Sin el prefijo, el linker
        // no los encuentra.
        const asyncCalleeMap: Record<string, string> = {
          spawn:               "ets::spawn",
          sleep:               "ets::sleep",
          cancel:              "ets::cancel",
          cancellationToken:   "ets::cancellationToken",
          createCancellation:  "ets::createCancellation",
          isCancelled:         "ets::isCancelled",
          ioUringAvailable:    "ets::ioUringAvailable",
          // V30.4: DNS async sobre uv_getaddrinfo. La funcion toma
          // un host (string) y devuelve Task<string> (= Promise<string>
          // en el dialecto). Definida en runtime/ets_dns.hpp.
          resolveDns:          "ets::resolveDns",
        };
        // V16: las funciones de red del dialecto (`listenTcp`, `acceptTcp`,
        // `readTcp`, `writeTcp`, `closeTcp`) viven en `ets::` (definidas en
        // `runtime/ets_net.hpp`). Sin el prefijo el linker no las encuentra.
        const etsNetworkCalleeMap: Record<string, string> = {
          listenTcp:      "ets::listenTcp",
          acceptTcp:      "ets::acceptTcp",
          acceptTcpUntil: "ets::acceptTcpUntil",
          readTcp:        "ets::readTcp",
          readTcpUntil:   "ets::readTcpUntil",
          writeTcp:       "ets::writeTcp",
          writeTcpUntil:  "ets::writeTcpUntil",
          closeTcp:       "ets::closeTcp",
          createTlsServer:"ets::createTlsServer",
          acceptTls:      "ets::acceptTls",
          readTls:        "ets::readTls",
          writeTls:       "ets::writeTls",
          closeTls:       "ets::closeTls",
        };
        // V16: constructores `ok<T>(t)` / `err<T>(e)` viven en `ets::`.
        const resultCalleeMap: Record<string, string> = {
          ok:  "ets::ok",
          err: "ets::err",
        };
        const finalCallee = fileCalleeMap[callee] ?? netCalleeMap[callee] ?? callee;
        if (asyncCalleeMap[finalCallee]) {
          return `${asyncCalleeMap[finalCallee]}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${args.join(", ")})`;
        }
        if (resultCalleeMap[finalCallee]) {
          const ta = typeArguments.length ? typeArguments.map(cppType).join(", ") : "void";
          return `${resultCalleeMap[finalCallee]}<${ta}>(${args.join(", ")})`;
        }
        // V16: emitir `listenTcp(...)` como `ets::listenTcp(...)`.
        if (etsNetworkCalleeMap[finalCallee]) {
          return `${etsNetworkCalleeMap[finalCallee]}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${args.join(", ")})`;
        }
        // V9.1: awaiters io_uring viven en `ets::` (header runtime/ets_io_uring_async.hpp).
        if (finalCallee === "asyncIoUringRead" || finalCallee === "asyncIoUringWrite" ||
            finalCallee === "ioUringRead" || finalCallee === "ioUringWrite") {
          return `ets::${finalCallee}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${args.join(", ")})`;
        }
        // V30.1: timers sobre libuv. setTimeout/setInterval/cancelTimer
        // se traducen a las funciones libres ets::setTimeout/...
        // declaradas en runtime/ets_timer.hpp. El callback se emite
        // como una lambda del dialecto (que es convertible a
        // std::function<void()> por el prefijo [=]/[&]).
        if (finalCallee === "setTimeout" || finalCallee === "setInterval" || finalCallee === "cancelTimer") {
          return `ets::${finalCallee}(${args.join(", ")})`;
        }
        // V30.2: filesystem watchers sobre libuv. watchFs/unwatchFs
        // se traducen a las funciones libres ets::watchFs/...
        // declaradas en runtime/ets_fs_watcher.hpp. El callback
        // toma un FsEvent (struct) y devuelve void; el codegen
        // lo emite como una lambda con un parametro `const FsEvent&`
        // (pasada por referencia para evitar copia).
        if (finalCallee === "watchFs" || finalCallee === "unwatchFs") {
          return `ets::${finalCallee}(${args.join(", ")})`;
        }
        // V30.2: stopLoop() cierra el event loop actual. La
        // implementacion es ets::defaultEventLoop.stop() (libuv).
        if (finalCallee === "stopLoop") {
          return `ets::defaultEventLoop.stop()`;
        }
        return finalCallee === "print" ? `print(${args.join(", ")})` : `${finalCallee}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${args.join(", ")})`;
      }
      case "MemberCallExpression": {
        const typeArguments = node.typeArguments.length ? node.typeArguments : this.callTypeArguments(node);
        // `delete` es keyword en C++; los wrappers `ets::Map`/`ets::Set` exponen el
        // método como `removeKey` y mapeamos aquí la llamada del lenguaje fuente.
        const objectType = this.expressionType(node.object);
        const isContainer = objectType && isGenericType(objectType) && (genericBase(objectType) === "Map" || genericBase(objectType) === "Set");
        const method = isContainer && node.method === "delete" ? "removeKey" : node.method;
        // `JSON.parse` (legacy) devuelve `std::string`. La versión que el dialecto
        // expone como `parse: string → JsonValue` se mapea a `parseValue` en C++.
        // También distinguimos `stringify(string/number/bool/JsonValue)` por el tipo
        // del argumento para que el overload correcto del runtime se elija.
        const isJsonGlobal = node.object.kind === "IdentifierExpression" && node.object.name === "JSON";
        if (isJsonGlobal) {
          // `JSON.parse` (legacy, retorna string) y `JSON.parseValue` (nuevo,
          // retorna JsonValue) coexisten. El dialecto decide cuál emitir por el
          // nombre del método en el AST; el type-checker valida el tipo de
          // retorno esperado por el llamador.
          if (method === "parse") return `JSON.parse(${node.args.map(a => this.emitExpression(a)).join(", ")})`;
          if (method === "parseValue") return `JSON.parseValue(${node.args.map(a => this.emitExpression(a)).join(", ")})`;
          if (method === "stringify") {
            const argType = node.args[0] ? this.expressionType(node.args[0]) : undefined;
            // El overload de C++ se elige por el tipo del argumento; los nombres
            // de método en el dialecto son los mismos (`stringify`) en todos los casos.
            return `JSON.stringify(${node.args.map(a => this.emitExpression(a)).join(", ")})`;
          }
        }
        // V30.13.2: reescritura de metodos de array (`arr.push(x)`,
        // `arr.length`, `arr.map(f)`, `arr.filter(p)`, etc.) a llamadas a
        // los helpers del runtime `ets_*_vec<T>(...)`. Sin esta
        // reescritura, el parser falla porque las clases del dialecto
        // no exponen metodos en std::vector (no hay inheritance ni
        // extension methods). El dialecto es conservador: solo estos
        // metodos se soportan, todos los demas producen un error de
        // codegen claro.
        const arrayType = this.expressionType(node.object);
        if (arrayType && (isArrayType(arrayType) || (isGenericType(arrayType) && genericBase(arrayType) === "Array"))) {
          const arrayObj = this.emitExpression(node.object);
          // .length -> .size()
          if (method === "length" && node.args.length === 0 && node.typeArguments.length === 0) {
            return `(${arrayObj}).size()`;
          }
          // .push(value) -> ets_push_vec<T>(arr, value)
          if (method === "push" && node.args.length === 1) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            return `ets_push_vec<${cppElement}>(${arrayObj}, ${node.args.map(a => this.emitExpression(a)).join(", ")})`;
          }
          // .pop() -> ets_pop_vec<T>(arr)
          if (method === "pop" && node.args.length === 0) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            return `ets_pop_vec<${cppElement}>(${arrayObj})`;
          }
          // .map(f) -> ets_map_vec<T, U>(arr, f)
          // Si el usuario declaro el tipo destino (arr.map<U>(f)),
          // lo propagamos al template C++; si no, usamos `auto` para
          // que el compilador C++ lo deduzca del lambda.
          if (method === "map" && node.args.length === 1) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            // El typeArgument explicito del usuario (si lo hay) es
            // el tipo destino del map (U), no T.
            const userU = node.typeArguments.length > 0 ? cppType(node.typeArguments[0]) : "auto";
            return `ets_map_vec<${cppElement}, ${userU}>(${arrayObj}, ${this.emitExpression(node.args[0])})`;
          }
          // .filter(p) -> ets_filter_vec<T>(arr, p)
          if (method === "filter" && node.args.length === 1) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            return `ets_filter_vec<${cppElement}>(${arrayObj}, ${this.emitExpression(node.args[0])})`;
          }
          // .forEach(f) -> ets_for_each_vec<T>(arr, f)
          if (method === "forEach" && node.args.length === 1) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            return `ets_for_each_vec<${cppElement}>(${arrayObj}, ${this.emitExpression(node.args[0])})`;
          }
          // .slice(start, end) -> ets_slice_vec<T>(arr, start, end)
          if (method === "slice" && (node.args.length === 1 || node.args.length === 2)) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            return `ets_slice_vec<${cppElement}>(${arrayObj}, ${node.args.map(a => this.emitExpression(a)).join(", ")})`;
          }
          // .find(p) -> ets_find_vec<T>(arr, p)
          if (method === "find" && node.args.length === 1) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            return `ets_find_vec<${cppElement}>(${arrayObj}, ${this.emitExpression(node.args[0])})`;
          }
          // .includes(v) -> ets_includes_vec<T>(arr, v)
          if (method === "includes" && node.args.length === 1) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            return `ets_includes_vec<${cppElement}>(${arrayObj}, ${this.emitExpression(node.args[0])})`;
          }
          // .concat(other) -> ets_concat_vec<T>({arr, other}) (ya existe)
          if (method === "concat" && node.args.length === 1) {
            const elementType = isArrayType(arrayType) ? arrayElement(arrayType) : genericArguments(arrayType)[0];
            const cppElement = this.arrayElementCppType(elementType);
            return `ets_concat_vec<${cppElement}>({${arrayObj}, ${this.emitExpression(node.args[0])}})`;
          }
        }
        // `http.get(url)` y `http.post(url, body, contentType?)` se traducen a
        // llamadas a las funciones libres ets::httpGet/ets::httpPost (declaradas
        // en runtime/ets_http.hpp). Como el type-checker ya valido la forma,
        // aqui solo emitimos el call. El prefijo `::` fuerza el lookup en
        // el namespace global por si el usuario declaro una variable local
        // llamada `http` (improbable, pero seguro).
        if (node.object.kind === "IdentifierExpression" && node.object.name === "http") {
          const argList = node.args.map(a => this.emitExpression(a)).join(", ");
          if (method === "createServer") return `::ets::Server()`;
          if (method === "param") return `::ets::http_param(${argList})`;
          if (method === "query") return `::ets::http_query(${argList})`;
          if (method === "header") return `::ets::http_header(${argList})`;
          // V28: cliente HTTP. http.get(url) / http.post(url, body, contentType?)
          // -> ets::httpClientGet / ets::httpClientPost (decl en
          // runtime/ets_http_curl_client.hpp). Devuelven Result<HttpClientResponse>.
          // V30.3: ahora el type-checker marca como Promise<Result<...>>, asi que
          // emitimos httpClientGetAsync / httpClientPostAsync (decl en
          // runtime/ets_http_curl_async.hpp) que retornan Task<Result<HttpClientResponse>>
          // y se pueden usar con `await`. El `await` se traduce a `co_await` en
          // el dialecto (ver emitStatement/AwaitExpression).
          if (method === "get") return `::ets::httpClientGetAsync(${argList})`;
          if (method === "post") return `::ets::httpClientPostAsync(${argList})`;
          // No deberiamos llegar aqui: el type-checker ya reporto el error.
          return `/* http.${method} no soportado */`;
        }
        // `server.get/post/put/patch/delete(path, handler)`: el Server es
        // una clase C++ con esos metodos exactos, asi que la traduccion
        // es 1:1. La variable que tenga tipo Server se emite tal cual.
        if (this.expressionType(node.object) === "Server") {
          const obj = this.emitExpression(node.object);
          const args = node.args.map(a => this.emitExpression(a)).join(", ");
          const routed = new Set(["get", "post", "put", "patch", "delete"]);
          if (routed.has(method)) return `${obj}.${method}(${args})`;
          if (method === "listen") {
            // server.listen(port) -> server.listen("0.0.0.0", port) sobre el
            // wrapper de cpp-httplib (V28+). El wrapper acepta tanto
            // listen(port) como listen(host, port).
            if (node.args.length === 1) return `${obj}.listen("0.0.0.0", ${args})`;
            return `${obj}.listen(${args})`;
          }
          return `/* server.${method} no soportado */`;
        }
        // `res.status/header/send/json` se traducen directamente a
        // `res.status(...)` etc. porque la C++ API los expone con el
        // mismo nombre. No hay que hacer wrapping.
        if (this.expressionType(node.object) === "Response") {
          const obj = this.emitExpression(node.object);
          const args = node.args.map(a => this.emitExpression(a)).join(", ");
          return `${obj}.${method}(${args})`;
        }
        // V28: HttpClientResponse. status() -> number, body() -> string,
        // header(name) -> string. El struct C++ tiene los accesores
        // status_code() / body_str() / header(name), pero los renombramos
        // a status() / body() / header() en el dialecto para consistencia
        // con el resto de la API.
        if (this.expressionType(node.object) === "HttpClientResponse") {
          const obj = this.emitExpression(node.object);
          const args = node.args.map(a => this.emitExpression(a)).join(", ");
          // Mapear nombres del dialecto a nombres del struct C++.
          const cppMethod = method === "status" ? "status_code" : method === "body" ? "body_str" : method;
          return `${obj}.${cppMethod}(${args})`;
        }
        // V30.2: FsEvent. El struct C++ tiene campos publicos (path,
        // flags), no metodos. El dialecto los expone como metodos
        // (ev.path(), ev.flags()) para consistencia con el resto de
        // la API. Aqui los emitimos como accesos a campo.
        if (this.expressionType(node.object) === "FsEvent") {
          const obj = this.emitExpression(node.object);
          const args = node.args.map(a => this.emitExpression(a)).join(", ");
          return `${obj}.${method}(${args})`;
        }
        // Codepath legacy de `HttpResponse` (cliente HTTP antiguo, struct
        // plano). El cliente HTTP reescrito en V28 vive en
        // runtime/ets_http_client.hpp como HttpClientResponse; este ya
        // no se usa. Lo dejamos por si quedan tests viejos.
        if (node.object.kind === "IdentifierExpression" && node.object.name === "HttpResponse") {
          return `/* HttpResponse.${method} no soportado */`;
        }
        // V14: cuando el objeto es `Optional<T>`, los métodos intrínsecos
        // (isPresent, isEmpty, value, valueOr, map, andThen, orElse)
        // se emiten como llamadas a métodos sobre `ets::Optional<T>`.
        if (node.object.kind === "IdentifierExpression") {
          const objType = this.expressionType(node.object);
          if (objType && isGenericType(objType) && genericBase(objType) === "Optional") {
            return `${this.emitExpression(node.object)}.${node.method}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${node.args.map(a => this.emitExpression(a)).join(", ")})`;
          }
        }
        // V28: metodos de string estilo TypeScript. El type-checker ya
        // valido aridad y tipos contra STRING_METHODS; aqui solo
        // emitimos la llamada a la funcion libre ets::string_*.
        // El receptor va como primer argumento (no como metodo).
        if (objectType === "string") {
          const objStr = this.emitExpression(node.object);
          const argStrs = node.args.map(a => this.emitExpression(a));
          return `::ets::string_${method}(${[objStr, ...argStrs].join(", ")})`;
        }
        // V1.2: `Union.Variant(args)` o `Union<T>.Variant(args)` se reescribe
        // a la llamada al constructor `Variant<T_payload>(value)` que el
        // codegen de la declaración emite (con `template <typename T, typename E>`
        // propio). Sólo pasamos el typeArgument que el payload de la variante
        // realmente usa (no todos los de la unión).
        if ((node.object.kind === "IdentifierExpression" || node.object.kind === "GenericIdentifierExpression") && this.unionNames.has(node.object.name)) {
          let callArgs = "";
          if (node.object.kind === "GenericIdentifierExpression") {
            const unionNode = this.unionsMap.get(node.object.name);
            const object_ = node.object;
            if (unionNode && unionNode.typeParameters.length) {
              // Pasar TODOS los typeArguments del union para que C++ pueda
              // deducir todos los parámetros de template del constructor.
              const argMap = new Map(unionNode.typeParameters.map((p, i) => [p.name, object_.typeArguments[i] ?? p.name]));
              const concreteArgs = unionNode.typeParameters.map(p => cppType(argMap.get(p.name) ?? p.name)).join(", ");
              callArgs = `<${concreteArgs}>`;
            }
          }
          return `${method}${callArgs}(${node.args.map(a => this.emitExpression(a)).join(", ")})`;
        }
        // V7.1: fusión AST. Detecta la cadena `arr.filter(p).map(f).reduce(init, op)`
        // y la reescribe a un único `for`. Conserva semántica: orden estable,
        // side-effects de `p` y `f` en el orden del array, `init` se respeta si
        // `arr` está vacío. Si la cadena no es fusible (otro método en medio,
        // lambdas que capturan state compleja, etc.) cae al path no-fusionado
        // de V7.0 que llama a las plantillas.
        if (objectType && isArrayType(objectType)) {
          const T = arrayElement(objectType);
          // V30.12.2: el elemento de un array puede ser una interface con
          // auto-union; `cppType(T)` solo emitiría el nombre de la interface
          // (que es solo un concept), pero el C++ real necesita
          // `InterfaceName_AutoUnion`. Usamos `arrayElementCppType` que sí
          // conoce el mapeo.
          const Tcpp = this.arrayElementCppType(T);
          const objStr = this.emitExpression(node.object);
          const argStrs = node.args.map(arg => this.emitExpression(arg));
          if (method === "reduce") {
            // V7.1: ¿el object es `.map(...).filter(...)`?
            const fused = this.tryFusePipeline(node, T);
            if (fused) return fused;
          }
          if (method === "filter") {
            return `ets_filter_vec<${Tcpp}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "map") {
            // `U` viene del typeArgument explícito o del `inferredCallTypeArguments`
            // (que el type-checker puebla a partir del typeArgument del usuario
            // o del expected de la llamada).
            const U = typeArguments[0];
            if (!U) return `${objStr}.map(${argStrs[0]})`;
            return `ets_map_vec<${Tcpp}, ${cppType(U)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "reduce") {
            const U = typeArguments[0];
            if (!U) return `${objStr}.reduce(${argStrs.join(", ")})`;
            return `ets_reduce<${cppType(U)}, ${Tcpp}>(${argStrs[0]}, ${objStr}, ${argStrs[1]})`;
          }
          // V11: métodos adicionales sobre arrays.
          if (method === "forEach") {
            return `ets_for_each_vec<${Tcpp}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "find") {
            return `ets_find_vec<${Tcpp}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "some") {
            return `ets_some_vec<${Tcpp}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "every") {
            return `ets_every_vec<${Tcpp}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "slice") {
            return `ets_slice_vec<${Tcpp}>(${objStr}, ${argStrs[0]}, ${argStrs[1]})`;
          }
          // V14: métodos adicionales.
          if (node.method === "sort") {
            // V14: `sort(cmp)` modifica el array in-place. En el dialecto, si
            // el receptor es un lvalue (identificador), emitimos una asignación
            // al resultado para que el ordenamiento se vea. Si es una
            // expresión más compleja, copiamos primero.
            const arrVar = node.object.kind === "IdentifierExpression" ? node.object.name : null;
            const sortCall = `ets_sort_vec<${Tcpp}>(${objStr}, ${argStrs[0]})`;
            if (arrVar) return `(${arrVar} = ${sortCall})`;
            // Para arrays anónimos (temporales), devolvemos el resultado directo.
            return sortCall;
          }
          if (method === "flatMap") {
            const U = typeArguments[0];
            if (!U) return `${objStr}.flatMap(${argStrs[0]})`;
            return `ets_flat_map_vec<${Tcpp}, ${cppType(U)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "concat") {
            // V30.8: `arr.concat(b, c, d, ...)` une 1..N arrays.
            // Devuelve un nuevo vector. El helper runtime es variadico
            // y acepta std::initializer_list<std::vector<T>>. El
            // codegen emite la lista a partir de los args del call.
            return `ets_concat_vec<${Tcpp}>({${objStr}${argStrs.length ? ", " + argStrs.join(", ") : ""}})`;
          }
          if (method === "includes") {
            return `ets_includes_vec<${Tcpp}>(${objStr}, ${argStrs[0]})`;
          }
          // V22-gap-#2: `push` muta in-place. Como std::vector ya tiene
          // `push_back`, lo emitimos directamente. No es necesario un helper
          // de runtime porque la sintaxis coincide.
          if (method === "push") {
            return `${objStr}.push_back(${argStrs[0]})`;
          }
        }
        // V30.14.3: si el método es de una clase y tiene un param con tipo
        // interface auto-union (no array), envolvemos el arg con `make_X`
        // en el call site. Sin esto, el signature genera un template
        // `<typename T0> requires I<T0> void add(T0 child)` y el call site
        // pasa el tipo crudo (T0 deduce como Line), lo que produce UB
        // cuando el codegen mete un Line en un std::variant<SvgChild_AutoUnion>.
        const objClass = objectType ? this.classesByName.get(objectType) : undefined;
        if (objClass) {
          const method_ = objClass.methods.find(m => m.name === method);
          if (method_) {
            const argTexts = node.args.map((arg, index) => {
              const param = method_.params[index];
              if (param && this.interfaceNames.has(param.type) && this.interfacesNeedingAutoUnion.has(param.type)) {
                // V30.14.3: envolver con make_X. El arg es un nombre
                // de clase directa (Line, Circle, etc.) — el user lo
                // construyó con `new Line()` y se lo pasa al método.
                const argType = this.expressionType(arg);
                if (argType && typeof argType === "string" && !this.aliasNames.has(argType)) {
                  const argClass = this.classesByName.get(argType);
                  if (argClass) return `make_${argClass.name}(${this.emitExpression(arg)})`;
                }
              }
              return this.emitExpression(arg);
            });
            return `${this.emitExpression(node.object)}.${method}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${argTexts.join(", ")})`;
          }
        }
        return `${this.emitExpression(node.object)}.${method}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${node.args.map(a => this.emitExpression(a)).join(", ")})`;
      }
      case "MemberExpression": {
              // Los miembros de un enum se acceden como `Name::Member` en C++ (no `Name.Member`),
              // porque los enums numéricos se emiten como `enum class` y los de cadena como struct
              // con miembros estáticos, ninguno de los cuales admite el operador `.` desde fuera.
              if (node.object.kind === "IdentifierExpression" && this.enumNames.has(node.object.name)) return `${node.object.name}::${node.member}`;
              // V1.2: las variantes de una unión se acceden como llamadas al constructor
              // global `Variant()` (no `Name.Variant` ni `Name::Variant`), porque la
              // declaración emite constructores en el namespace global con el nombre
              // de la variante. Esto produce `Direction::North()` → `North()`.
              if (node.object.kind === "IdentifierExpression" && this.unionNames.has(node.object.name)) {
                const unionNode = this.unionsMap.get(node.object.name);
                const variant = unionNode?.variants.find(v => v.name === node.member);
                if (variant) return variant.payload ? `${node.member}(${variant.payload})` : `${node.member}()`;
              }
              // V28: `s.length` -> ets::string_length(s). El unico field-style
              // de la API de string; el resto son metodos (dispatch arriba).
              if (node.member === "length" && this.expressionType(node.object) === "string") {
                return `::ets::string_length(${this.emitExpression(node.object)})`;
              }
              // V1.4: Result<T> no es un `std::variant` real, sino el tipo del runtime
                            // (`ets::Result<T>`) que tiene métodos `isOk()`, `value()`, `error()`.
                            // Cuando el usuario accede a `r.ok` (discriminador del AST de Result),
                            // emitimos `r.isOk()`; `r.value` → `r.value()`; `r.error` → `r.error()`.
                            if (node.object.kind === "IdentifierExpression") {
                              const objType = this.expressionType(node.object);
                              if (objType && isGenericType(objType) && genericBase(objType) === "Result") {
                                if (node.member === "ok") return `${this.emitExpression(node.object)}.isOk()`;
                                if (node.member === "value") return `${this.emitExpression(node.object)}.value()`;
                                if (node.member === "error") return `${this.emitExpression(node.object)}.error()`;
                              }
                            }
                            // `?.` desazucara a `optionalAndThen(obj, [](auto _e) { return optionalSome(_e.member); })`.
                            // El type-checker garantiza que `obj` es `Optional<T>` y `T` tiene el campo.
                            if (node.optional) {
                              const obj = this.emitExpression(node.object);
                              return `optionalAndThen(${obj}, [](auto _ets_optional_chain) { return optionalSome(_ets_optional_chain.${node.member}); })`;
                            }
                            // Si el objeto es un parámetro `Mut<T>`, en C++ es `T*` y debemos usar `->`.
              // Si es `MutRef<T>`, es `T&` y debemos usar `.` (que ya es el comportamiento por defecto).
              if (node.object.kind === "IdentifierExpression" && this.identifierIsPtrPointer(node.object.name)) {
                return `${this.emitExpression(node.object)}->${node.member}`;
              }
              // V22-gap-#2: `xs.length` (propiedad) sobre `Array<T>` se mapea a
              // `xs.size()` en std::vector. Detectamos que el objeto es array
              // mirando su tipo (debe terminar en `[]` o ser `GenericType` con
              // base `Array`).
              if (node.member === "length") {
                const objType = this.expressionType(node.object);
                if (objType && (objType.endsWith("[]") || (isGenericType(objType) && genericBase(objType) === "Array"))) {
                  return `${this.emitExpression(node.object)}.size()`;
                }
              }
              return `${this.emitExpression(node.object)}.${node.member}`;
            }
      case "IndexExpression": {
        const object = this.emitExpression(node.object); const objectType = this.expressionType(node.object);
        const tupleIndex = node.index.kind === "LiteralExpression" && typeof node.index.value === "number" ? String(node.index.value) : this.emitExpression(node.index);
        return objectType && isTupleType(objectType) ? `std::get<${tupleIndex}>(${object})` : `${object}[static_cast<std::size_t>(${this.emitExpression(node.index)})]`;
      }
      case "NewExpression": {
        // V3 (fix narrowing en NewExpression): los argumentos posicionales
        // de `new T(...)` deben respetar el tipo del parámetro del
        // constructor (o el tipo del campo, si la clase no tiene
        // constructor explícito y se inicializa aggregate-style). Sin
        // esto, `new Person("Alberto", 42.0)` con `age: i32` emite
        // `Person{..., 42.0}` y g++ falla con `-Wnarrowing`.
        // La misma lógica V3 ya existía para variables, fixed arrays y
        // assignments; aquí faltaba.
        const cls = this.classesByName.get(node.className);
        const paramTypes: TypeName[] = cls
          ? (() => {
              const ctor = cls.methods.find(m => m.name === "constructor");
              if (ctor) return ctor.params.map(p => p.type);
              // Aggregate init: el orden posicional sigue el orden de
              // declaración de los campos. Solo el subconjunto con valor
              // por defecto omitido se inicializa; aquí simplificamos
              // y emitimos el cast para los primeros N args.
              return cls.fields.map(f => f.type);
            })()
          : [];
        const args = node.args.map((arg, index) => {
          // V30.14.2: propagamos el target type del argumento al sub-emit
          // para que `make_X` wrapping se anide correctamente.
          const argTarget = paramTypes[index];
          let text = argTarget ? this.emitExpression(arg, argTarget) : this.emitExpression(arg);
          const target = argTarget;
          if (target && isNumericType(target)) {
            const argType = this.expressionType(arg);
            const needsCast = argType === "number" || (argType !== undefined && isNumericType(argType) && argType !== target);
            if (needsCast) text = `static_cast<${cppType(target)}>(${text})`;
          }
          return text;
        });
        // V22 (Memory Model v2): si el contexto propietario es `ptr<T>` o
        // `constPtr<T>` (targetType), emitimos `std::make_unique<T>(...)`
        // en lugar de construcción por valor. El tipo de retorno C++ es
        // `std::unique_ptr<T>` (el typeName ptr<T> ya está mapeado en cppType).
        if (targetType && isGenericType(targetType)) {
          const memBase = genericBase(targetType);
          if (memBase === "ptr" || memBase === "constPtr") {
            return `std::make_unique<${cppType(node.className)}>(${args.join(", ")})`;
          }
        }
        // V30.13: si la clase aparece como variante de un auto-union, el
        // struct del auto-union emite una función CONSTRUCTOR con el
        // mismo nombre que la clase (p.ej. `inline SvgChild_AutoUnion
        // Line(Line ets_line_value)`). Llamar `Line{}` sería ambiguo
        // (g++ no sabe si es la función o aggregate-init del struct) y
        // el resultado NO sería del tipo del auto-union. Lo envolvemos
        // explícitamente: `Line(Line{...})` invoca la función variante
        // sobre un Line construido aggregate-style, devolviendo un
        // SvgChild_AutoUnion.
        // V30.14.2: si el target es un auto-union (interface o type alias
        // registrado), envolvemos con `make_X`. La condicion ya no es
        // `classesInAutoUnion().has(className)` (eso siempre era true
        // para variantes de union), sino `isAutoUnionTarget(targetType)`.
        const targetIsAutoUnion = this.isAutoUnionTarget(targetType);
        const ctor = cls ? cls.methods.find(m => m.name === "constructor") : undefined;
        if (ctor && cls) {
          // V30.13.3: el constructor del dialecto SIEMPRE debe invocarse
          // explicito, aunque no tenga parametros. Aggregate-init (Foo{})
          // deja los miembros sin inicializar (kind, name, etc. quedan
          // como default-construct de std::string que es vacio, no como
          // lo que el constructor del dialecto les asigna). El `constructor`
          // del dialecto devuelve `*this` (V30.13) para que la
          // expresion sea usable como rvalue.
          const callExpr = `${cppType(node.className)}{}`;
          if (targetIsAutoUnion) return `make_${node.className}(${callExpr}.constructor(${args.join(", ")}))`;
          return `${callExpr}.constructor(${args.join(", ")})`;
        }
        const innerExpr = `${cppType(node.className)}{${args.join(", ")}}`;
        if (targetIsAutoUnion) return `(make_${node.className}(${innerExpr}))`;
        return innerExpr;
      }
    }
  }
  private stringConcatParts(node: Expression): Expression[] {
    if (node.kind === "BinaryExpression" && node.operator === "+" && this.expressionType(node) === "string") return [...this.stringConcatParts(node.left), ...this.stringConcatParts(node.right)];
    return [node];
  }
  private pad(): string { return "    ".repeat(this.indent); }

  // V7.1: intenta fusionar la cadena `arr.filter(p).map(f).reduce(init, op)` a
  // un único `for`. Devuelve el código C++ del bucle si la reconoce, o
  // `undefined` si la cadena no es fusible (cae al path V7.0 con llamadas a
  // las plantillas).
  //
  // Cadena reconocida (en orden estricto):
  //   reduce( init, op )
  //     └─ map( f )
  //          └─ filter( p )
  //               └─ arr  (cualquier expresión que evalúe a T[])
  //
  // Restricciones de fusibilidad:
  //   - Solo filter → map → reduce (orden estricto, sin elementos intermedios).
  //   - Cada lambda tiene exactamente 1 parámetro (los predicados/funciones
  //     de V7.0 ya exigen esto).
  //   - `arr` debe ser una expresión simple (Identifier, MemberCall que no
  //     sea filter/map/reduce, o MemberExpression). Si es una llamada
  //     arbitraria, no fusionamos (podría tener side effects no obvios).
  private tryFusePipeline(reduceCall: import("../ast/nodes.ts").MemberCallExpression, T: import("../ast/nodes.ts").TypeName): string | undefined {
    if (reduceCall.method !== "reduce") return undefined;
    if (reduceCall.args.length !== 2) return undefined;
    const mapCall = reduceCall.object;
    if (mapCall.kind !== "MemberCallExpression" || mapCall.method !== "map") return undefined;
    if (mapCall.args.length !== 1) return undefined;
    const filterCall = mapCall.object;
    if (filterCall.kind !== "MemberCallExpression" || filterCall.method !== "filter") return undefined;
    if (filterCall.args.length !== 1) return undefined;
    const arr = filterCall.object;
    // `arr` debe ser simple para evitar side effects raros.
    if (!this.isFuseableSource(arr)) return undefined;
    // `T` debe ser primitivo o string/copyable. Para V7.1 solo fusionamos
    // tipos primitivos (number, string, boolean) — los tipos no triviales
    // pueden tener destructores y romper la fusión si los movemos dos veces.
    if (!["number", "string", "boolean", "void"].includes(T)) return undefined;
    // U viene del typeArgument explícito del `reduce`.
    const U = reduceCall.typeArguments[0];
    if (!U) return undefined;
    const initStr = this.emitExpression(reduceCall.args[0]);
    const opStr = this.emitExpression(reduceCall.args[1]);
    const filterLambda = this.emitExpression(filterCall.args[0]);
    const mapLambda = this.emitExpression(mapCall.args[0]);
    const arrStr = this.emitExpression(arr);
    // Emisión C++20: lambda genérico `[]() -> U { ... }()` que itera `arr`,
    // aplica `filterLambda`/`mapLambda` y acumula con `opLambda`. Usamos `[]`
    // (sin captura) porque el lambda va dentro de una expresión initializer
    // estática donde C++ no permite captura por defecto. Las variables
    // externas que el lambda usa (p.ej. `numbers` global) se acceden por
    // nombre directamente; las locales se capturan explícitamente en V7.2+.
    return `[]() -> ${cppType(U)} { ${cppType(U)} _ets_acc = ${initStr}; for (const auto& _ets_item : ${arrStr}) { if (${filterLambda}(_ets_item)) { _ets_acc = (${opStr})(_ets_acc, (${mapLambda})(_ets_item)); } } return _ets_acc; }()`;
  }

  // V30.12.3: topological ordering for class definitions.
  //
  // El dialecto permite clases que se referencian entre sí mediante forward
  // declarations (#188), pero una definición `struct Holder { A a; }` requiere
  // que `A` ya esté completo. Emitir las clases en el orden del AST falla
  // cuando el usuario declara `Holder` antes que `A` (escenario realista en
  // archivos grandes con dependencias one-way).
  //
  // Construimos un grafo dirigido `C -> D` cuando la definición de `C`
  // menciona `D` en un campo, parámetro de método o tipo de retorno de método
  // (recursivo a través de uniones, genéricos `Array<D>`/`Promise<D>`,
  // intersections, function types, tuplas, arrays fijos, mapas, sets). Las
  // menciones en cuerpos de método, variables locales, o comentarios, NO
  // crean aristas (esos usos solo necesitan un forward decl, ya satisfecho).
  //
  // Devolvemos:
  //   - `ordered`: clases en orden topológico (sin ciclos).
  //   - `cyclicNames`: nombres de clases en SCCs cíclicas (size > 1 o self-
  //     loop). Las clases del ciclo se devuelven al final preservando el
  //     orden del AST; el codegen las deja solo como forward decl y emite
  //     un warning claro (g++ se quejará de "incomplete type" — el dialecto
  //     no soporta referencias circulares por valor; habría que usar `ptr<D>`
  //     o `weak<D>` para romper el ciclo).
  private topoSortClasses(classes: ClassDeclaration[]): {
    ordered: ClassDeclaration[];
    cyclicNames: string[];
  } {
    // `deps[C]` = clases de las que C depende (campos/params/retornos que
    // son tipos de clase). El grafo de dependencias es: "si C está en
    // deps[D], entonces D tiene que estar definido antes que C". El orden
    // topológico coloca primero las clases sin dependencias (no esperan
    // a nadie), luego las que sólo dependen de las ya emitidas.
    const deps = new Map<string, Set<string>>();
    for (const node of classes) {
      const refs = new Set<string>();
      for (const field of node.fields) this.collectClassRefs(field.type, refs);
      for (const method of node.methods) {
        for (const param of method.params) this.collectClassRefs(param.type, refs);
        this.collectClassRefs(method.returnType, refs);
      }
      // Self-loops no cuentan (la propia clase aparece porque el tipo es `C`).
      refs.delete(node.name);
      // Sólo aristas a clases declaradas en este programa (lo demás se
      // asume completo — builtins, stdlib, runtime).
      const filtered = new Set<string>();
      for (const ref of refs) if (this.classNames.has(ref)) filtered.add(ref);
      // V30.13: los campos tipo `Array<Interface>` con auto-union
      // dependen también del auto-union. NO añadimos la arista en
      // `topoSortClasses` porque los auto-unions NO son ClassDeclaration
      // (la emisión intercalada se hace en `generate()` con
      // `usesAutoUnion`). Marcar la arista aquí haría que el Kahn
      // mandara la clase al bucket `unplaced` (el auto-union no se
      // puede satisfacer como dep) y la reordenaría fuera del orden
      // AST estable.
      deps.set(node.name, filtered);
    }
    const byName = new Map<string, ClassDeclaration>();
    for (const node of classes) byName.set(node.name, node);
    // Kahn's en el grafo "reverse-deps": un nodo está listo cuando TODAS
    // sus deps ya están emitidas. `unsatisfied[C]` = deps que aún no se
    // emitieron; arrancamos con el total y decrementamos cuando emitimos.
    const unsatisfied = new Map<string, number>();
    for (const node of classes) unsatisfied.set(node.name, (deps.get(node.name) ?? new Set()).size);
    const ready: ClassDeclaration[] = [];
    for (const node of classes) if ((unsatisfied.get(node.name) ?? 0) === 0) ready.push(node);
    const ordered: ClassDeclaration[] = [];
    const placed = new Set<string>();
    while (ready.length) {
      // Tomar el primero del AST order entre los ready (estabilidad).
      ready.sort((a, b) => classes.indexOf(a) - classes.indexOf(b));
      const next = ready.shift()!;
      ordered.push(next);
      placed.add(next.name);
      // Para cada clase C que dependía de `next`, decrementar unsatisfied.
      for (const [cName, cDeps] of deps) {
        if (!cDeps.has(next.name)) continue;
        if (placed.has(cName)) continue;
        const newCount = (unsatisfied.get(cName) ?? 0) - 1;
        unsatisfied.set(cName, newCount);
        if (newCount === 0) ready.push(byName.get(cName)!);
      }
    }
    // Lo que quedó sin colocar pertenece a SCCs cíclicas. Preservar orden
    // del AST (revertimos `ready` para que los ready-with-cycles se emitan
    // primero, manteniendo el orden AST de los colocados).
    const unplaced = classes.filter(node => !placed.has(node.name));
    const cyclicNames = unplaced.map(node => node.name);
    return { ordered: [...ordered, ...unplaced], cyclicNames };
  }
  // V30.13: detecta si una clase aparece como variante de un auto-union
  // (V30.12.2). Si lo es, el codegen emite `operator==` y `operator<<`
  // para que el struct del auto-union pueda compilar (sus `operator==`
  // y `operator<<` comparan/imprimen los payloads). Sin esto, los
  // ejemplos con `Array<Interface>` rompen en link con "no match for
  // operator==" sobre los tipos payload.
  private classesInAutoUnion(): Set<string> {
    const out = new Set<string>();
    for (const union of this.autoUnions.values()) {
      for (const variant of union.variants) if (variant.payload && this.classNames.has(variant.payload)) out.add(variant.payload);
    }
    return out;
  }
  // V30.13: emite un `operator==` trivial para una clase (compara
  // campo-por-campo). El dialecto no requiere `operator==` para clases
  // declaradas por el usuario (es opcional), pero los payload classes
  // de un auto-union lo necesitan porque el `operator==` del struct
  // del auto-union llama `==` sobre cada `std::get<i>(payload)`.
  private emitClassOperatorEq(node: ClassDeclaration): string {
    const eqs = node.fields.map(field => {
      const cppFieldT = (type: TypeName): string => (isArrayType(type) || (isGenericType(type) && genericBase(type) === "Array")) ? this.arrayCppType(type) : cppType(type);
      return `(this->${field.name} == other.${field.name})`;
    });
    if (!eqs.length) return `inline bool operator==(const ${node.name}&, const ${node.name}&) { return true; }\n`;
    return `inline bool operator==(const ${node.name}& this_ets, const ${node.name}& other) { return (${eqs.join(" && ")}); }\n`;
  }
  // V30.13: emite un `operator<<` para una clase que imprime todos los
  // campos (formato `ClassName(field1=value1, field2=value2, ...)`).
  // El dialecto no requiere `operator<<` para clases declaradas por el
  // usuario, pero los payload classes de un auto-union lo necesitan
  // para que el `operator<<` del struct del auto-union compile cuando
  // quiere imprimir el payload.
  private emitClassOperatorStream(node: ClassDeclaration): string {
    const pieces = node.fields.map(field => {
      const cppFieldT = (type: TypeName): string => (isArrayType(type) || (isGenericType(type) && genericBase(type) === "Array")) ? this.arrayCppType(type) : cppType(type);
      // Para `std::string`, `<< x` ya funciona via el operator<< de ostream.
      // Para arrays/vectors, no hay operator<< portable (no imprimimos vectores
      // recursivamente; emitimos un placeholder `[...]` que evita el error
      // de compilación). El objetivo NO es producir una salida bonita, sino
      // que el struct del auto-union compile cuando se use con `print()`.
      return `"${field.name}="`;
    });
    return `inline std::ostream& operator<<(std::ostream& os, const ${node.name}& v) { os << "${node.name}("; bool _ets_first = true; ${node.fields.map(f => `if (!_ets_first) os << ", "; os << "${f.name}=" << v.${f.name}; _ets_first = false;`).join("; ")}; os << ")"; return os; }\n`;
  }
  // V30.12.3: warning al usuario cuando se detectan referencias circulares
  // entre clases por valor (no por indirección `ptr<X>`). El dialecto no las
  // soporta: el compilador C++ emitirá "field has incomplete type" sobre las
  // clases del SCC. La solución es romper el ciclo con `ptr<D>` o `weak<D>`.
  // Emitimos por stderr para que sea visible en CI; el codegen no aborta
  // (queremos que el programa compile lo máximo posible y que g++ reporte
  // el error concreto en la posición correcta).
  private reportClassCycle(cyclicNames: string[]): void {
    if (!cyclicNames.length) return;
    const list = cyclicNames.map(n => "`" + n + "`").join(", ");
    const proc = (globalThis as { process?: { stderr: { write: (s: string) => void } } }).process;
    proc?.stderr.write(
      "warning(V30.12.3): ciclo de dependencias entre clases detectado: " + list + ". " +
      "El dialecto no soporta referencias circulares por valor — usa `ptr<T>` o `weak<T>` para romper el ciclo.\n",
    );
  }
  // V30.12.3: walker recursivo de TypeName que extrae referencias a clases
  // del dialecto. Recorre unions/intersections, genéricos (incluido `Array<T>`
  // / `Promise<T>` / `ptr<T>` / `Set<T>` / `Map<K,V>`), function types,
  // tuplas, arrays fijos. Las menciones a primitivos, stdlib o tipos runtime
  // se ignoran — sólo conservamos las que aparecen en `this.classNames` (que
  // es lo que `prepare()` pobló con las clases declaradas en el programa).
  private collectClassRefs(type: TypeName, refs: Set<string>): void {
    if (!type) return;
    if (isUnionType(type)) { for (const m of unionMembers(type)) this.collectClassRefs(m, refs); return; }
    if (isIntersectionType(type)) { for (const m of intersectionMembers(type)) this.collectClassRefs(m, refs); return; }
    if (isTupleType(type)) { for (const e of tupleElements(type)) this.collectClassRefs(e, refs); return; }
    if (isArrayType(type)) { this.collectClassRefs(arrayElement(type), refs); return; }
    if (isFixedArrayType(type)) {
      const el = fixedArrayElement(type);
      if (el) this.collectClassRefs(el, refs);
      return;
    }
    if (isFunctionType(type)) {
      for (const p of functionParameters(type)) this.collectClassRefs(p, refs);
      this.collectClassRefs(functionResult(type), refs);
      return;
    }
    if (isMapType(type)) {
      if (isGenericType(type)) {
        const args = genericArguments(type);
        if (args.length >= 1) this.collectClassRefs(args[0], refs);
        if (args.length >= 2) this.collectClassRefs(args[1], refs);
      }
      return;
    }
    if (isSetType(type)) {
      if (isGenericType(type)) {
        const args = genericArguments(type);
        if (args.length >= 1) this.collectClassRefs(args[0], refs);
      }
      return;
    }
    if (isPromiseType(type)) { this.collectClassRefs(promiseResult(type), refs); return; }
    if (isGenericType(type)) {
      const base = genericBase(type);
      // ptr<T>, weak<T>, constPtr<T>, ref<T>, constRef<T>, readonly<T> se
      // resuelven por indirección (T&) y NO requieren T completo → skip.
      if (["ptr", "weak", "constPtr", "ref", "constRef"].includes(base)) return;
      if (base === "readonly") return;
      // Para genéricos "tipo de dato" (Array<T>) seguimos al argumento; pero
      // si el base genérico NO es una clase del dialecto, no nos interesa.
      for (const arg of genericArguments(type)) this.collectClassRefs(arg, refs);
      return;
    }
    // Caso base: un TypeName "plano". Si es una clase declarada en el
    // programa, agregala. Ignorar primitivos, void, unknown.
    if (this.classNames.has(type)) refs.add(type);
  }
  // V7.1: ¿`expr` es una fuente fusible para `arr.filter(...).map(...).reduce(...)`?
  // Acepta identificadores, accesos a miembro simples, llamadas a funciones
  // puras (no filter/map/reduce), y literales de array.
  private isFuseableSource(expr: import("../ast/nodes.ts").Expression): boolean {
    switch (expr.kind) {
      case "IdentifierExpression":
      case "MemberExpression":
      case "ArrayLiteralExpression":
      case "IndexExpression":
        return true;
      case "CallExpression":
      case "MemberCallExpression": {
        if (expr.kind === "MemberCallExpression") return !["filter", "map", "reduce"].includes(expr.method);
        return true;
      }
      default:
        return false;
    }
  }
}
