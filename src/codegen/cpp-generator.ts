import type { Program, Statement, Expression, TypeName, FunctionDeclaration, InterfaceDeclaration, ClassDeclaration, ClassMethod, BlockStatement, VariableDeclaration, EnumDeclaration, UnionDeclaration, TypeParameter, CallExpression } from "../ast/nodes.ts";
import { cppType, collectTypeParameterNames } from "./cpp-types.ts";
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
  private readonly aliasNames: Set<string> = new Set();
  private readonly enumNames: Set<string> = new Set();
  private readonly enumUnderlying = new Map<string, "number" | "string">();
  private readonly unionNames: Set<string> = new Set();
  private readonly unionsMap: Map<string, UnionDeclaration> = new Map();
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
  private inClassMethod = false;
  private inStaticInit = false;
  private inAsyncFunction = false;
  // V8.0: tipo declarado del retorno de la función actual. Se setea en
  // `function()` antes de emitir el cuerpo y se restaura al salir.
  // `undefined` cuando no estamos dentro de una función.
  private currentReturn: TypeName | undefined = undefined;
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
  private destructuringCounter = 0;
  constructor(expressionType?: (node: Expression) => TypeName | undefined, expressionIsVariadic?: (node: Expression) => boolean, callTypeArguments?: (node: Expression) => TypeName[]) {
    this.expressionType = expressionType ?? (() => undefined); this.expressionIsVariadic = expressionIsVariadic ?? (() => false);
    this.callTypeArguments = callTypeArguments ?? (() => []);
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
    return this.localRenames.get(name) ?? name;
  }
  /** V15: setup del generador a partir del AST combinado del programa. */
  prepareModules(program: Program): void { this.prepare(program); }
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
    // Escaneamos el programa para detectar alias de export (`export { x as y }`)
    // y registrarlos en `exportAliases` para que el codegen los resuelva.
    this.exportAliases.clear();
    for (const stmt of unwrapped) if (stmt.kind === "ExportNamedDeclaration") for (const spec of stmt.specifiers) if (spec.alias) this.exportAliases.set(spec.alias, spec.name);
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
    ]));
  }
  private usesNetworking(program: Program): boolean {
    return this.usesAnyCall(program, new Set([
      "tcpListen", "tcpAccept", "tcpConnect", "tcpRead", "tcpWrite", "tcpClose",
      "etsNetSyncEcho", "etsNetSyncLarge",
    ]));
  }
  // V7: detecta si el programa usa los helpers de colecciones sobre `T[]`
  // (`arr.filter`, `arr.map`, `arr.reduce`). Recorremos el AST buscando
  // `MemberCallExpression` cuyo método es uno de los tres. Solo lo hacemos
  // para evitar el `#include` cuando no se usa (los templates no penalizan
  // tiempo de compilación si quedan sin instanciar, pero los headers
  // crecen y el include explícito documenta la dependencia).
  private usesCollections(program: Program): boolean {
    const target = new Set(["filter", "map", "reduce", "forEach", "find", "some", "every", "slice", "sort", "flatMap", "includes"]);
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
  // V1.3: dado un TypeName resuelto por el type-checker, devuelve el
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
      ...(usesIoUringAsync ? ["#include \"runtime/ets_io_uring.hpp\"", "#include \"runtime/ets_io_uring_async.hpp\""] : []),
    ];
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
    const lines = ["// Generated by estatic-ts-cpp. Do not edit.", ...this.includes(this.usesTls(program), this.usesCompilerAst(program), this.usesFilesystem(program), this.usesNetworking(program), this.usesUnions(program), this.usesFixedArrays(program), this.usesCollections(program), this.usesIoUringAsync(program), this.usesNodeGlobals(program), this.usesFunctional(program)), ""];
    for (const contract of interfaces) lines.push(this.interfaceConcept(contract), "");
    for (const node of enums) lines.push(this.enumDeclaration(node), "");
    for (const node of unions) lines.push(this.unionDeclaration(node), "");
    for (const node of classes) lines.push(this.classDeclaration(node), "");
    for (const fn of functions) lines.push(this.signature(fn) + ";");
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
      let initializer = this.emitExpression(variable.initializer);
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
      lines.push(`static ${canBeConstexpr && variable.constValue !== undefined ? "constexpr " : ""}${cppType(type)} ${cppName} = ${initializer};`);
    }
    if (simpleTopLevel.length) lines.push("");
    for (const fn of functions) lines.push(this.function(fn), "");
    lines.push("int main(int argc, char** argv) {"); this.indent++;
    lines.push(this.pad() + "ets_argc = argc;");
    lines.push(this.pad() + "ets_argv = argv;");
    for (const statement of destructuringTopLevel) lines.push(this.emitStatement(statement));
    for (const statement of topLevelOther) lines.push(this.emitStatement(statement));
    lines.push(this.pad() + "return 0;"); this.indent--; lines.push("}", "");
    return lines.join("\n");
  }
  generateHeader(program: Program, moduleInitializers: string[]): string {
    this.prepare(program);
    const functions = program.statements.filter((statement): statement is FunctionDeclaration => statement.kind === "FunctionDeclaration" && !!statement.exported);
    const interfaces = program.statements.filter((statement): statement is InterfaceDeclaration => statement.kind === "InterfaceDeclaration" && !!statement.exported);
    const classes = program.statements.filter((statement): statement is ClassDeclaration => statement.kind === "ClassDeclaration" && !!statement.exported);
    const variables = program.statements.filter((statement): statement is VariableDeclaration => statement.kind === "VariableDeclaration" && !!statement.exported);
    // V15: el header debe contener TODAS las definiciones de tipos que
    // cualquier módulo puede necesitar (no solo las exportadas). Enums y
    // unions son visibles en todo el programa — si un módulo los declara y
    // otro los usa, los necesitamos en el header común.
    const enums = program.statements.filter((statement): statement is EnumDeclaration => statement.kind === "EnumDeclaration");
    const unions = program.statements.filter((statement): statement is UnionDeclaration => statement.kind === "UnionDeclaration");
    const allClasses = program.statements.filter((statement): statement is ClassDeclaration => statement.kind === "ClassDeclaration");
    const lines = ["// Generated declarations. Do not edit.", "#pragma once", ...this.includes(this.usesTls(program), this.usesCompilerAst(program), this.usesFilesystem(program), this.usesNetworking(program), this.usesUnions(program), this.usesFixedArrays(program), this.usesCollections(program), this.usesIoUringAsync(program), this.usesNodeGlobals(program), this.usesFunctional(program)), ""];
    for (const contract of interfaces) lines.push(this.interfaceConcept(contract), "");
    for (const node of enums) lines.push(this.enumDeclaration(node), "");
    for (const node of unions) lines.push(this.unionDeclaration(node), "");
    for (const node of allClasses) lines.push(this.classForward(node, false /* includeDefaults: el forward decl no repite el default */));
    if (allClasses.length) lines.push("");
    for (const fn of functions) lines.push(this.signature(fn) + ";");
    if (functions.length) lines.push("");
    for (const node of allClasses) lines.push(this.classDeclaration(node), "");
    for (const fn of functions.filter(candidate => candidate.typeParameters.length > 0)) lines.push(this.function(fn), "");
    // V15: si la variable es `const` con initializer literal, el header
      // usa `extern const` (no `extern constexpr` — eso requiere definición
      // inline). La definición en el .cpp usa `constexpr`. Para tipos no
      // literales usamos solo `extern`.
      for (const variable of variables) {
        const isLiteralConst = !variable.mutable && variable.constValue !== undefined && typeof variable.constValue !== "string";
        const cppT = cppType(variable.declaredType ?? this.expressionType(variable.initializer) ?? "void");
        lines.push(`extern${isLiteralConst ? " const" : ""} ${cppT} ${variable.name};`);
      }
    if (variables.length) lines.push("");
    for (const initializer of moduleInitializers) lines.push(`void ${initializer}();`);
    lines.push("");
    return lines.join("\n");
  }
  generateModule(program: Program, combinedProgram: Program, headerName: string, initializer: string, entryInitializers?: string[]): string {
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
    for (const contract of privateInterfaces) lines.push(this.interfaceConcept(contract), "");
    for (const node of privateClasses) lines.push(this.classForward(node, false /* includeDefaults: el default va solo en la definición */));
    if (privateClasses.length) lines.push("");
    // V15: el forward decl va SIN defaults (los defaults solo pueden aparecer
    // una vez en C++; van en la definición, no en la forward).
    for (const fn of privateFunctions) lines.push(this.signature(fn, true, false, false) + ";");
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
      let initializerText = this.emitExpression(variable.initializer);
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
      lines.push(`${exportLinkage}${canBeConstexpr && variable.constValue !== undefined ? "constexpr " : ""}${cppType(type)} ${cppName} = ${initializerText};`);
    }
    if (variables.length) lines.push("");
    // V15: las funciones EXPORTADAS deben tener linkage externo para que el
    // header (signature + ";") y esta definición coincidan. Las no exportadas
    // usan linkage interno (`static`) para evitar choques entre módulos.
    for (const fn of functions) {
      const exported = fn.exported;
      lines.push(this.function(fn, !exported), "");
    }
    lines.push(`void ${initializer}() {`); this.indent++;
    // V15: solo reasignamos variables mutables. Las `const` ya están inicializadas
    // en su declaración (línea 360) y reasignarlas daría error de compilación.
    for (const variable of variables) {
      if (variable.mutable) lines.push(this.pad() + `${variable.name} = ${this.emitExpression(variable.initializer)};`);
    }
    for (const statement of destructuringTopLevel) lines.push(this.emitStatement(statement));
    for (const statement of topLevel) lines.push(this.emitStatement(statement));
    this.indent--; lines.push("}", "");
    if (entryInitializers) {
      lines.push("int main(int argc, char** argv) {"); this.indent++;
      lines.push(this.pad() + "ets_argc = argc;", this.pad() + "ets_argv = argv;");
      for (const name of entryInitializers) lines.push(this.pad() + `${name}();`);
      lines.push(this.pad() + "return 0;"); this.indent--; lines.push("}", "");
    }
    return lines.join("\n");
  }
  private signature(fn: FunctionDeclaration, internal = false, includeDefaults = true, includeValueDefaults = true): string {
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
    }), ...constrained.map(({ p, i }) => `${p.type} T${i}`), ...functionParams.map(({ i }) => `typename F${i}`)];
    const template = templateParts.length ? `template <${templateParts.join(", ")}>\n` : "";
    const requiresClauses = fn.typeParameters.filter(parameter => parameter.constraint).map(parameter => `requires ${cppRequires(parameter.constraint!, parameter.name)}`);
    const requires = requiresClauses.length ? `${requiresClauses.join("\n")}\n` : "";
    // C++ no permite defaults en la definición si ya están en la declaración;
    // pasamos `false` al emitir el cuerpo.
    // `p?: T` se traduce a `Optional<T>` en C++. Si el user ya escribió
    // `Optional<T>` no duplicamos el envoltorio.
    // Detección automática de modificadores de paso por puntero/referencia:
    // `Mut<T>` → T* (puntero mutable), `MutRef<T>` → T& (referencia mutable).
    // `Un<T>` y `Rc<T>` mantienen su envoltorio (tienen semántica de ownership).
    const params = fn.params.map((p, i) => {
      const baseType = this.cppParameterType(p.type);
      const effectiveType = p.optional && !(isGenericType(p.type) && genericBase(p.type) === "Optional") ? `ets::Optional<${cppType(p.type)}>` : (this.interfaceNames.has(p.type) ? `T${i}` : baseType);
      // V10.2: si el parámetro es una función, usar el template param `F${i}`
      // (forwarding reference con deducción automática) en lugar del tipo
      // concreto (que sería `std::function<...>`). Esto permite que el
      // compilador C++ inline la lambda sin overhead.
      const isFunction = isFunctionType(p.type) && !this.interfaceNames.has(p.type);
      const paramType = isFunction ? `F${i}&&` : (this.interfaceNames.has(p.type) ? `T${i}` : effectiveType);
      const cppParamName = p.fromRuntime ? (this.localRenames.set(p.name, `ets_local_${p.name}`), `ets_local_${p.name}`) : undefined;
      return cppParameterDeclaration(p, paramType, fn.async, includeValueDefaults && p.defaultValue ? this.emitExpression(p.defaultValue) : undefined, cppParamName);
    }).join(", ");
    return `${template}${requires}${internal ? "static " : ""}${cppType(fn.returnType)} ${fn.name}(${params})`;
  }
  private classDeclaration(node: ClassDeclaration): string {
    const templatePart = node.typeParameters.length ? `template <${node.typeParameters.map(parameter => {
      const base = `typename ${parameter.name}`;
      return parameter.default ? `${base} = ${cppType(parameter.default)}` : base;
    }).join(", ")}>\n` : "";
    const requiresPart = node.typeParameters.filter(parameter => parameter.constraint).map(parameter => `requires ${cppRequires(parameter.constraint!, parameter.name)}`).join("\n");
    const header = `${templatePart}${requiresPart ? requiresPart + "\n" : ""}struct ${node.name} {`;
    const lines = [header]; this.indent++;
    // C++ no permite reasignar campos `const` en el cuerpo del constructor.
    // Si la clase declara un constructor, los `readonly` se emiten SIN `const`
    // y el semantic checker rechaza asignaciones fuera del constructor. Si no
    // hay constructor, los `readonly` se emiten como `const` (solo se pueden
    // inicializar aggregate-style).
    const hasConstructor = node.methods.some(method => method.name === "constructor");
    for (const field of node.fields) lines.push(`${this.pad()}${cppType(field.type)}${field.readonly && !hasConstructor ? " const" : ""} ${field.name};`);
    if (node.fields.length && node.methods.length) lines.push("");
    for (const method of node.methods) lines.push(this.pad() + this.classMethod(method), "");
    if (lines.at(-1) === "") lines.pop();
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
  private classMethod(method: ClassMethod): string {
    const declaration: FunctionDeclaration = { kind: "FunctionDeclaration", name: method.name, async: false, typeParameters: method.typeParameters ?? [], variadicTypeParameters: [], params: method.params, returnType: method.returnType, body: method.body, span: method.span };
    const previous = this.inClassMethod; this.inClassMethod = true;
    const body = this.emitBlock(method.body);
    const deprecated = this.decoratorWarning(method.decorators, method.name);
    // `deprecated` se inyecta inmediatamente después de `{` del cuerpo, no entre
    // la firma y el `{`. Para eso, troceamos el bloque en dos.
    let bodyWithWarning = body;
    if (deprecated) {
      const openBrace = body.indexOf("{");
      const afterBrace = body.indexOf("\n", openBrace) + 1;
      bodyWithWarning = body.slice(0, afterBrace) + deprecated + body.slice(afterBrace);
    }
    const result = `${this.signature(declaration)}${this.methodMutates(method) ? "" : " const"} ${bodyWithWarning}`;
    this.inClassMethod = previous; return result;
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
  private methodMutates(method: ClassMethod): boolean { return method.body.statements.some(statement => this.statementMutatesThis(statement)); }
  private statementMutatesThis(node: Statement): boolean {
    switch (node.kind) {
      case "VariableDeclaration": return this.expressionMutatesThis(node.initializer);
      case "ExpressionStatement": return this.expressionMutatesThis(node.expression);
      case "ReturnStatement": return !!node.value && this.expressionMutatesThis(node.value);
      case "BlockStatement": return node.statements.some(statement => this.statementMutatesThis(statement));
      case "IfStatement": return this.expressionMutatesThis(node.condition) || this.statementMutatesThis(node.thenBranch) || (!!node.elseBranch && this.statementMutatesThis(node.elseBranch));
      case "WhileStatement": return this.expressionMutatesThis(node.condition) || this.statementMutatesThis(node.body);
      case "ForStatement": return (!!node.initializer && this.statementMutatesThis(node.initializer)) || (!!node.condition && this.expressionMutatesThis(node.condition)) || (!!node.increment && this.expressionMutatesThis(node.increment)) || this.statementMutatesThis(node.body);
      default: return false;
    }
  }
  private expressionMutatesThis(node: Expression): boolean {
    if (node.kind === "AssignmentExpression") {
      let target: Expression = node.target;
      while (target.kind === "MemberExpression") target = target.object;
      return target.kind === "IdentifierExpression" && target.name === "this";
    }
    if (node.kind === "BinaryExpression") return this.expressionMutatesThis(node.left) || this.expressionMutatesThis(node.right);
    if (node.kind === "UnaryExpression") return this.expressionMutatesThis(node.operand);
    if (node.kind === "AwaitExpression") return this.expressionMutatesThis(node.operand);
    if (node.kind === "CallExpression" || node.kind === "NewExpression") return node.args.some(arg => this.expressionMutatesThis(arg));
    if (node.kind === "ArrayLiteralExpression") return node.elements.some(item => item.kind === "SpreadElement" ? this.expressionMutatesThis(item.expression) : this.expressionMutatesThis(item));
    if (node.kind === "ArrowFunctionExpression") return node.body.kind === "BlockStatement" ? node.body.statements.some(statement => this.statementMutatesThis(statement)) : this.expressionMutatesThis(node.body);
    if (node.kind === "MemberCallExpression") return this.expressionMutatesThis(node.object) || node.args.some(arg => this.expressionMutatesThis(arg));
    if (node.kind === "MemberExpression") return this.expressionMutatesThis(node.object);
    if (node.kind === "IndexExpression") return this.expressionMutatesThis(node.object) || this.expressionMutatesThis(node.index);
    return false;
  }
  private interfaceConcept(node: InterfaceDeclaration): string {
    const requirements = node.methods.map(method => {
      const args = method.params.map(p => `std::declval<${cppType(p.type)}${p.out || p.passing === "mut" ? "&" : ""}>()`).join(", ");
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
  private unionDeclaration(node: UnionDeclaration): string {
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
      // ensombrecía `T`). Usamos un prefijo estable basado en el nombre de la
      // variante.
      const paramName = `ets_${variant.name.toLowerCase()}_value`;
      if (!variant.payload) {
        return `${tparamSpec} inline ${node.name}${tnamesSpec} ${variant.name}() { ${node.name}${tnamesSpec} u; u.kind = ${variantIndexEnum}::${variant.name}; return u; }`;
      }
      const payloadType = cppType(variant.payload);
      return `${tparamSpec} inline ${node.name}${tnamesSpec} ${variant.name}(${payloadType} ${paramName}) { ${node.name}${tnamesSpec} u; u.payload.template emplace<${index}>(static_cast<${payloadType}&&>(${paramName})); u.kind = ${variantIndexEnum}::${variant.name}; return u; }`;
    }).join("\n");
    const variantPayloads = node.variants.map(variant => variant.payload ? cppType(variant.payload) : "std::monostate").join(", ");
    // `operator<<` para `print(union)` (V1.3). Cada variante se imprime como
    // `Variant(payload)`; las variantes nulas como `Variant`. El prefijo
    // `template <...>` se reusa para que coincida con la declaración del
    // struct (GCC exige que las plantillas friend coincidan exactamente).
    const printerBranches = node.variants.map((variant, index) => {
      const access = `std::get<${index}>(u.payload)`;
      return `        case ${variantIndexEnum}::${variant.name}: ${variant.payload ? `std::cout << "${variant.name}(" << ${access} << ")"; break;` : `std::cout << "${variant.name}"; break;`}`;
    }).join("\n");
    const printerDef = `${tparamSpec}\ninline std::ostream& operator<<(std::ostream& os, const ${node.name}${tnamesSpec}& u) {\n    switch (u.kind) {\n${printerBranches}\n    }\n    return os;\n}`;
    // V1.3: `operator==` contextual para tagged unions. `std::variant` no
    // ofrece comparación por defecto; emitimos uno que dispatcha por
    // discriminador y compara payload solo si los kinds coinciden.
    const eqBranches = node.variants.map((variant, index) =>
      `    (a.kind == ${variantIndexEnum}::${variant.name} && b.kind == ${variantIndexEnum}::${variant.name} && std::get<${index}>(a.payload) == std::get<${index}>(b.payload))`
    ).join(" ||\n");
    const eqDef = `${tparamSpec}\ninline bool operator==(const ${node.name}${tnamesSpec}& a, const ${node.name}${tnamesSpec}& b) {\n    return\n${eqBranches};\n}`;
    // El prefijo `template <...>` ya se emite arriba; el nombre del struct
    // NO lleva los angle brackets (eso es lo que provocaba el error
    // "'Outcome' is not a class template" de GCC).
    return `enum class ${variantIndexEnum} : int {\n${variantKindFields}\n};\n${tparamSpec ? tparamSpec + "\n" : ""}struct ${node.name} {\n    ${variantIndexEnum} kind;\n    std::variant<${variantPayloads}> payload;\n};\n${constructorDefs}\n${printerDef}\n${eqDef}`;
  }
  private function(fn: FunctionDeclaration, internal = false): string {
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
        let initializerExpr = this.emitExpression(node.initializer);
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
        let returnText = node.value ? this.emitExpression(node.value) : "";
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
          if ((returnBase === "Unq" || returnBase === "Rc") && valueType && this.classNames.has(valueType) && valueType !== "void") {
            returnText = `${returnBase === "Unq" ? "unSome" : "rcShare"}<${cppType(valueType)}>(${returnText})`;
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
        return `${this.pad()}for (${initializer}; ${node.condition ? this.emitExpression(node.condition) : ""}; ${node.increment ? this.emitExpression(node.increment) : ""}) ${this.statementBody(node.body)}`;
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

  // Emite `match (subject) { ... }`. Dos codegen posibles:
  //   - V2 (algún arm trae `variantMatch`): `switch (subject.kind) { case
  //     Variant: ...; default: <wildcard> }`. Cada arm con bindings extrae
  //     el payload con `std::get<index>`. La exhaustividad ya fue
  //     verificada en el type-checker; aquí solo emitimos.
  //   - Legacy TC39 `when`: cadena de ternarios `(subject == pattern ?
  //     result : ...)`.
  private emitMatch(node: { subject: Expression; arms: { pattern: Expression; result: Expression; variantMatch?: { variantName: string; bindings: string[]; isWildcard?: boolean } }[] }): string {
    if (node.arms.length === 0) return "/* empty match */";
    if (node.arms.some(arm => arm.variantMatch)) return this.emitV2Match(node);
    const subject = this.emitExpression(node.subject);
    const last = node.arms[node.arms.length - 1];
    let result = this.emitExpression(last.result);
    for (let index = node.arms.length - 2; index >= 0; index--) {
      const arm = node.arms[index];
      const patternText = this.emitExpression(arm.pattern);
      const isWildcard = arm.pattern.kind === "IdentifierExpression" && arm.pattern.name === "_";
      if (isWildcard) result = this.emitExpression(arm.result);
      else result = `(${subject} == ${patternText} ? ${this.emitExpression(arm.result)} : ${result})`;
    }
    return result;
  }
  private emitV2Match(node: { subject: Expression; arms: { pattern: Expression; result: Expression; variantMatch?: { variantName: string; bindings: string[]; isWildcard?: boolean } }[] }): string {
    const subjectType = this.expressionType(node.subject);
    const subjectUnion = subjectType ? this.unionFromType(subjectType) : undefined;
    if (!subjectUnion) return "/* V2 match: subject no es union */";
    const kindEnum = `${subjectUnion.name}_Kind`;
    const subjectStr = this.emitExpression(node.subject);
    const arms = node.arms.filter(arm => arm.variantMatch);
    const wildcard = arms.find(arm => arm.variantMatch!.isWildcard);
    const resultType = this.cppTypeForMatchReturn(arms);
    // Sin IIFE: declaramos el resultado en el scope del call site y le
    // asignamos desde cada case. La exhaustividad está garantizada por el
    // type-checker; el `default` aborta si la lógica se rompe en runtime.
    const cases = arms.filter(arm => !arm.variantMatch!.isWildcard).map(arm => {
      const vm = arm.variantMatch!;
      const variant = subjectUnion.variants.find(v => v.name === vm.variantName)!;
      const index = subjectUnion.variants.indexOf(variant);
      const payloadAccess = variant.payload ? `std::get<${index}>(${subjectStr}.payload)` : undefined;
      const bindings = vm.bindings.map((bindingName) =>
        `            const auto& ${this.cppName(bindingName)} = ${payloadAccess};`
      ).join("\n");
      const resultExpr = this.emitExpression(arm.result);
      const bindingsBlock = bindings ? `\n${bindings}` : "";
      return `        case ${kindEnum}::${vm.variantName}: {${bindingsBlock}\n            __ets_match_result = ${resultExpr};\n            break;\n        }`;
    }).join("\n");
    const defaultExpr = wildcard
      ? `__ets_match_result = ${this.emitExpression(wildcard.result)}; break;`
      : `[[unlikely]] std::abort();`;
    return `([&]() -> ${resultType} {\n    auto&& __ets_match_subject = (${subjectStr});\n    ${resultType} __ets_match_result{};\n    switch (__ets_match_subject.kind) {\n${cases}\n        default: ${defaultExpr}\n    }\n    return __ets_match_result;\n}())`;
  }
  // Tipo de retorno del lambda que evalúa el match V2. Usa el primer arm no
  // wildcard (su tipo de resultado es el del match completo). El wildcard
  // debe coincidir (verificado por el type-checker con `typeMatches`).
  private cppTypeForMatchReturn(arms: { result: Expression; variantMatch?: { variantName: string; bindings: string[]; isWildcard?: boolean } }[]): string {
    const first = arms.find(arm => arm.variantMatch && !arm.variantMatch.isWildcard) ?? arms[0];
    if (!first) return "void";
    const t = this.expressionType(first.result);
    return t ? cppType(t) : "auto";
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
    if (isGenericType(type)) {
      const base = genericBase(type);
      if (base === "Mut" || base === "MutRef") {
        const inner = genericArguments(type)[0];
        return cppType(inner);
      }
    }
    return cppType(type);
  }

  /**
   * Devuelve true si el argumento `index` de la llamada `call` espera un
   * parámetro de tipo `Mut<T>`. En ese caso el codegen debe prefijar `&`
   * al lvalue pasado como argumento.
   */
  private argumentExpectsMutPointer(call: { callee: string; args: Expression[] }, index: number, _argument: Expression): boolean {
    const overloads = this.topLevelFunctions.get(call.callee);
    if (!overloads || overloads.length === 0) return false;
    const signature = overloads[0];
    const parameter = signature.params[index];
    if (!parameter) return false;
    if (!isGenericType(parameter.type)) return false;
    return genericBase(parameter.type) === "Mut";
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
  private identifierIsMutPointer(name: string): boolean {
    // Buscamos en todos los overloads top-level si alguno tiene un parámetro
    // con ese nombre y tipo `Mut<T>`.
    for (const overloads of this.topLevelFunctions.values()) {
      for (const signature of overloads) {
        for (const parameter of signature.params) {
          if (parameter.name === name && isGenericType(parameter.type) && genericBase(parameter.type) === "Mut") return true;
        }
      }
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
  private emitExpression(node: Expression): string {
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
          // spread. La sintaxis `[](auto dst) -> decltype(dst) { ... return dst; }(T{})`
          // deja el resultado como una expresión de tipo T (copy elision).
          const cpp = cppType(type ?? "void[]");
          const items: string[] = [];
          for (const item of node.elements) {
            if (item.kind === "SpreadElement") {
              items.push(`dst.insert(dst.end(), (${this.emitExpression(item.expression)}).begin(), (${this.emitExpression(item.expression)}).end());`);
            } else {
              items.push(`dst.push_back(${this.emitExpression(item)});`);
            }
          }
          return `([](${cpp} dst) -> ${cpp} { ${items.join(" ")} return dst; })(${cpp}{})`;
        }
        // Para arrays con tipos move-only (Task<T>, Optional<T>, Result<T>), el
        // initializer_list de std::vector siempre copia, así que generamos un
        // lambda que hace push_back por movimiento. Para tipos copiables,
        // `std::vector<T>{...}` funciona directamente.
        const valueType = cppType(type ?? "void[]");
        const values = node.elements.map(item => this.emitExpression(item as import("../ast/nodes.ts").Expression));
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
        else if (this.inClassMethod) capture = "[=, this]";
        else if (node.capturedSymbols !== undefined) {
          // Captura explícita solo de los símbolos externos que la lambda usa.
          // La sintaxis de captura explícita en C++ es solo el nombre: `[x, y]`
          // (sin el `=`; el `=` solo se usa para captura-por-defecto de TODAS).
          // Si `mutatesCapturedState` está activo, capturamos por referencia
          // usando `[&]` con la lista; si no, por copia usando `[]` con la lista.
          if (node.capturedSymbols.length === 0) capture = "[]";
          else if (node.mutatesCapturedState) capture = `[&${node.capturedSymbols.join(", ")}]`;
          else capture = `[${node.capturedSymbols.join(", ")}]`;
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
        // V3: si el target es un numérico concreto y el value es de otro tipo
        // numérico (o `number`), emitir `static_cast<Target>` para evitar
        // narrowing warnings del compilador C++.
        let valueText = this.emitExpression(node.value);
        const targetType = this.expressionType(node.target);
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
        const args = node.args.map((argument, index) => {
          let text = this.emitExpression(argument);
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
          // `Mut<T>` espera un puntero: si el argumento es un lvalue (identificador,
          // member access, index), le añadimos `&` para que C++ lo acepte.
          if (this.argumentExpectsMutPointer(node, index, argument)) {
            if (this.isLvalue(argument)) text = `&(${text})`;
          }
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
        // V14: cuando el objeto es `Optional<T>`, los métodos intrínsecos
        // (isPresent, isEmpty, value, valueOr, map, andThen, orElse)
        // se emiten como llamadas a métodos sobre `ets::Optional<T>`.
        if (node.object.kind === "IdentifierExpression") {
          const objType = this.expressionType(node.object);
          if (objType && isGenericType(objType) && genericBase(objType) === "Optional") {
            return `${this.emitExpression(node.object)}.${node.method}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${node.args.map(a => this.emitExpression(a)).join(", ")})`;
          }
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
          const objStr = this.emitExpression(node.object);
          const argStrs = node.args.map(arg => this.emitExpression(arg));
          if (method === "reduce") {
            // V7.1: ¿el object es `.map(...).filter(...)`?
            const fused = this.tryFusePipeline(node, T);
            if (fused) return fused;
          }
          if (method === "filter") {
            return `ets_filter_vec<${cppType(T)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "map") {
            // `U` viene del typeArgument explícito o del `inferredCallTypeArguments`
            // (que el type-checker puebla a partir del typeArgument del usuario
            // o del expected de la llamada).
            const U = typeArguments[0];
            if (!U) return `${objStr}.map(${argStrs[0]})`;
            return `ets_map_vec<${cppType(T)}, ${cppType(U)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "reduce") {
            const U = typeArguments[0];
            if (!U) return `${objStr}.reduce(${argStrs.join(", ")})`;
            return `ets_reduce<${cppType(U)}, ${cppType(T)}>(${argStrs[0]}, ${objStr}, ${argStrs[1]})`;
          }
          // V11: métodos adicionales sobre arrays.
          if (method === "forEach") {
            return `ets_for_each_vec<${cppType(T)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "find") {
            return `ets_find_vec<${cppType(T)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "some") {
            return `ets_some_vec<${cppType(T)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "every") {
            return `ets_every_vec<${cppType(T)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "slice") {
            return `ets_slice_vec<${cppType(T)}>(${objStr}, ${argStrs[0]}, ${argStrs[1]})`;
          }
          // V14: métodos adicionales.
          if (node.method === "sort") {
            // V14: `sort(cmp)` modifica el array in-place. En el dialecto, si
            // el receptor es un lvalue (identificador), emitimos una asignación
            // al resultado para que el ordenamiento se vea. Si es una
            // expresión más compleja, copiamos primero.
            const arrVar = node.object.kind === "IdentifierExpression" ? node.object.name : null;
            const sortCall = `ets_sort_vec<${cppType(T)}>(${objStr}, ${argStrs[0]})`;
            if (arrVar) return `(${arrVar} = ${sortCall})`;
            // Para arrays anónimos (temporales), devolvemos el resultado directo.
            return sortCall;
          }
          if (method === "flatMap") {
            const U = typeArguments[0];
            if (!U) return `${objStr}.flatMap(${argStrs[0]})`;
            return `ets_flat_map_vec<${cppType(T)}, ${cppType(U)}>(${objStr}, ${argStrs[0]})`;
          }
          if (method === "includes") {
            return `ets_includes_vec<${cppType(T)}>(${objStr}, ${argStrs[0]})`;
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
              if (node.object.kind === "IdentifierExpression" && this.identifierIsMutPointer(node.object.name)) {
                return `${this.emitExpression(node.object)}->${node.member}`;
              }
              return `${this.emitExpression(node.object)}.${node.member}`;
            }
      case "IndexExpression": {
        const object = this.emitExpression(node.object); const objectType = this.expressionType(node.object);
        const tupleIndex = node.index.kind === "LiteralExpression" && typeof node.index.value === "number" ? String(node.index.value) : this.emitExpression(node.index);
        return objectType && isTupleType(objectType) ? `std::get<${tupleIndex}>(${object})` : `${object}[static_cast<std::size_t>(${this.emitExpression(node.index)})]`;
      }
      case "NewExpression": return `${cppType(node.className)}{${node.args.map(a => this.emitExpression(a)).join(", ")}}`;
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
