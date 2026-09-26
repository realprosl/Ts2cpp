import type { Program, Statement, Expression, TypeName, Parameter, FunctionDeclaration, InterfaceDeclaration, InterfaceMethod, ClassDeclaration, ClassMethod, ArrowFunctionExpression, TypeAliasDeclaration, EnumDeclaration } from "../ast/nodes.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import { Scope, type FunctionSignature, type FunctionSymbol } from "./symbols.ts";
import { arrayElement, arrayType, functionParameters, functionResult, functionType, genericArguments, genericBase, genericType, intersectionMembers, isArrayType, isFunctionType, isGenericType, isIntersectionType, isMapType, isPrimitive, isPromiseType, isSetType, isTupleType, isTypeofType, isUnionType, promiseResult, tupleElements, tupleType, typeMatches, typeofTarget, unionMembers } from "../types/type-system.ts";

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
const JSON_HELPERS: Record<string, { params: TypeName[]; returnType: TypeName }> = {
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
};

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

export class TypeChecker {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly types = new WeakMap<Expression, TypeName>();
  private currentReturn: TypeName | undefined;
  private currentAsync: boolean | undefined;
  private inConstructor = false;
  private readonly interfaces = new Map<string, InterfaceDeclaration>();
  private readonly classes = new Map<string, ClassDeclaration>();
  private readonly aliases = new Map<string, TypeAliasDeclaration>();
  private readonly enums = new Map<string, EnumDeclaration>();
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
    for (const statement of program.statements) if (statement.kind === "ClassDeclaration") this.declareClassName(statement, global);
    for (const statement of program.statements) if (statement.kind === "InterfaceDeclaration") this.declareInterface(statement, global);
    for (const statement of program.statements) if (statement.kind === "TypeAliasDeclaration") this.declareTypeAlias(statement, global);
    for (const statement of program.statements) if (statement.kind === "EnumDeclaration") this.declareEnum(statement, global);
    // Tras declarar los alias, expandimos en el AST cualquier referencia a un
    // nombre de alias (o a su instanciación genérica) por su forma canónica.
    // Así codegen ve directamente `number[]` en vez de `NumberArray`.
    this.expandAliasesInProgram(program);
    for (const statement of program.statements) if (statement.kind === "ClassDeclaration") this.validateClass(statement, global);
    for (const statement of program.statements) if (statement.kind === "FunctionDeclaration") this.declareFunction(statement, global);
    for (const statement of program.statements) this.statement(statement, global);
    if (this.diagnostics.length) throw new DiagnosticError(this.diagnostics);
  }

  typeOf(expression: Expression): TypeName | undefined { return this.types.get(expression); }
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
        params: method.params.map(parameter => ({ type: parameter.type, out: parameter.out, mutableReference: parameter.passing === "mut", variadic: parameter.variadic, defaultValue: parameter.defaultValue })),
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
      params: node.params.map(p => ({ type: p.type, out: p.out, mutableReference: p.passing === "mut", variadic: p.variadic, defaultValue: p.defaultValue })),
      returnType: node.returnType
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
    const methods = new Set<string>();
    for (const method of node.methods) {
      const signature = `${method.name}(${method.params.map(parameter => parameter.type).join(",")})`;
      if (methods.has(signature)) this.report(method, `Sobrecarga de método duplicada '${method.name}'`);
      methods.add(signature);
      this.validateType(method.returnType, method, false, true, scope);
      for (const parameter of method.params) this.validateType(parameter.type, parameter, false, true, scope);
      this.validateParameterDefaults(method.params, method);
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
  }

  private declareEnum(node: EnumDeclaration, scope: Scope): void {
    if (this.enums.has(node.name) || !scope.define(node.name, { kind: "type", type: node.name })) {
      this.report(node, `Símbolo duplicado '${node.name}'`); return;
    }
    this.enums.set(node.name, node);
    const seen = new Set<string>();
    for (const member of node.members) {
      if (seen.has(member.name)) this.report(member, `Miembro de enum duplicado '${member.name}'`);
      seen.add(member.name);
      scope.define(member.name, { kind: "variable", type: node.name, mutable: false });
    }
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
      }
      local.define(parameter.name, { kind: "variable", type: parameter.type, mutable: parameter.out || parameter.passing === "mut", variadic: parameter.variadic });
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
    if (isUnionType(type)) { for (const member of unionMembers(type)) this.validateType(member, node, interfaceAllowed, primitiveOnly, scope); return type; }
    if (isIntersectionType(type)) { for (const member of intersectionMembers(type)) this.validateType(member, node, true, true, scope); return type; }
    if (isArrayType(type)) {
      const element = arrayElement(type);
      if (element === "void" || this.interfaces.has(element)) this.report(node, `El array necesita un tipo de elemento concreto, no '${element}'`);
      this.validateType(element, node, false, primitiveOnly, scope);
      return type;
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
      const base = genericBase(type); const owner = this.classes.get(base); const arguments_ = genericArguments(type);
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
        if (arguments_.length !== 1) this.report(node, `'Result' espera 1 argumento de tipo, recibió ${arguments_.length}`);
        if (arguments_[0] === "void") this.report(node, "Result<void> no está soportado; usa Result<boolean> o Promise<void>");
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      }
      if (base === "Map") {
        if (arguments_.length !== 2) this.report(node, `'Map' espera 2 argumentos de tipo (K, V), recibió ${arguments_.length}`);
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
        return type;
      }
      if (base === "Set") {
        if (arguments_.length !== 1) this.report(node, `'Set' espera 1 argumento de tipo, recibió ${arguments_.length}`);
        arguments_.forEach(argument => this.validateType(argument, node, false, primitiveOnly, scope));
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
    const concrete = this.classes.has(type) || this.aliases.has(type) || this.enums.has(type) || ["TcpListener", "TcpConnection", "TlsContext", "TlsConnection", "CancellationSource", "CancellationToken", "JsonValue"].includes(type);
    const contract = interfaceAllowed && this.interfaces.has(type);
    if (!primitive && (primitiveOnly || (!concrete && !contract))) this.report(node, `Tipo no definido o no permitido '${type}'`);
  }

  private statement(node: Statement, scope: Scope): void {
    switch (node.kind) {
      case "VariableDeclaration": {
        const expandedDeclared = node.declaredType ? this.expandType(node.declaredType, scope) : undefined;
        const actual = this.expression(node.initializer, scope, expandedDeclared);
        const expected = expandedDeclared ?? actual;
        if (node.declaredType) {
          // Reescribimos el AST con el tipo ya expandido (`typeof` resuelto
          // incluido) para que codegen vea directamente `number` y no la
          // marca `$typeof$x`.
          node.declaredType = expandedDeclared;
          this.validateType(node.declaredType, node, true, false, scope);
        }
        if (expected === "void") this.report(node, "Una variable no puede ser de tipo void");
        if (!typeMatches(actual, expected)) this.report(node, `Se esperaba ${expected}, pero se obtuvo ${actual}`);
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
            if (!scope.define(binding.name, { kind: "variable", type: bindingType, mutable: node.mutable })) this.report(node, `Símbolo duplicado '${binding.name}'`);
          }
        } else if (!scope.define(node.name, { kind: "variable", type: expected, mutable: node.mutable })) this.report(node, `Símbolo duplicado '${node.name}'`);
        break;
      }
      case "FunctionDeclaration": {
        this.withTypeParameters(node.typeParameters, () => {
          const local = new Scope(scope);
          for (const p of node.params) if (!local.define(p.name, { kind: "variable", type: p.type, mutable: p.out || p.passing === "mut", variadic: p.variadic })) this.report(node, `Parámetro duplicado '${p.name}'`);
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
        this.withTypeParameters(node.typeParameters, () => { for (const method of node.methods) this.classMethod(method, node, scope); });
        break;
      }
      case "EnumDeclaration": break;
      case "BlockStatement": { const child = new Scope(scope); for (const s of node.statements) this.statement(s, child); break; }
      case "ExpressionStatement": this.expression(node.expression, scope); break;
      case "IfStatement":
        this.require(this.expression(node.condition, scope), "boolean", node.condition); this.statement(node.thenBranch, scope); if (node.elseBranch) this.statement(node.elseBranch, scope); break;
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
        const local = new Scope(scope);
        if (!local.define(node.binding.name, { kind: "variable", type: elementType, mutable: node.binding.mutable })) this.report(node.binding, `Símbolo duplicado '${node.binding.name}'`);
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
        if (!local.define(node.binding.name, { kind: "variable", type: keyType, mutable: node.binding.mutable })) this.report(node.binding, `Símbolo duplicado '${node.binding.name}'`);
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
        if (this.currentReturn && !typeMatches(actual, this.currentReturn) && !flattenedAsyncReturn) this.report(node, `La función retorna ${this.currentReturn}, no ${actual}`);
        break;
      }
    }
  }

  private classMethod(method: ClassMethod, owner: ClassDeclaration, scope: Scope): void {
    this.withTypeParameters(method.typeParameters ?? [], () => {
      const local = new Scope(scope);
      const ownerType = owner.typeParameters.length ? genericType(owner.name, TypeChecker.namesOf(owner.typeParameters)) : owner.name;
      local.define("this", { kind: "variable", type: ownerType, mutable: true });
      for (const parameter of method.params) if (!local.define(parameter.name, { kind: "variable", type: parameter.type, mutable: parameter.out || parameter.passing === "mut" })) this.report(parameter, `Parámetro duplicado '${parameter.name}'`);
      const previous = this.currentReturn; const previousAsync = this.currentAsync; const previousCtor = this.inConstructor;
      this.currentReturn = method.returnType; this.currentAsync = false; this.inConstructor = method.name === "constructor";
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
      case "ArrowFunctionExpression": {
        if (node.params.some(parameter => parameter.passing === "mut")) this.report(node, "Los parámetros mut en closures necesitan un tipo de función con efectos; use una función declarada");
        const expectedParameters = expected && isFunctionType(expected) ? functionParameters(expected) : undefined;
        const expectedResult = expected && isFunctionType(expected) ? functionResult(expected) : undefined;
        if (expectedParameters && expectedParameters.length !== node.params.length) this.report(node, `La closure espera ${expectedParameters.length} parámetros, recibió ${node.params.length}`);
        const local = new Scope(scope);
        node.params.forEach((parameter, index) => {
          this.validateType(parameter.type, parameter, false, false, local);
          if (expectedParameters?.[index]) this.require(parameter.type, expectedParameters[index], parameter);
          if (!local.define(parameter.name, { kind: "variable", type: parameter.type, mutable: false })) this.report(parameter, `Parámetro duplicado '${parameter.name}'`);
        });
        const declaredResult = node.returnType ?? expectedResult;
        let resultType: TypeName;
        const previousAsync = this.currentAsync; this.currentAsync = false;
        const previousClosure = this.currentClosure; this.currentClosure = { node, parentScope: scope };
        node.mutatesCapturedState = false;
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
        // Luego buscamos en el scope: una declaración local (variable,
        // parámetro) debe ganar sobre el tipo builtin del mismo nombre. Esto
        // permite `const path: string = argument(1); path + ".ext"` sin que
        // el type-checker reclame "Path" donde se espera "string".
        const symbol = scope.resolve(node.name);
        if (symbol) {
          if (symbol.kind !== "variable") this.report(node, `'${node.name}' es un símbolo de tipo o función, no un valor`);
          else { result = this.expandType(symbol.type); if (symbol.variadic) this.variadicExpressions.add(node); }
          break;
        }
        if (node.name === "console") { result = "Console"; break; }
        if (node.name === "fs") { result = "Filesystem"; break; }
        if (node.name === "path") { result = "Path"; break; }
        if (node.name === "process") { result = "Process"; break; }
        if (node.name === "JSON") { result = "Json"; break; }
        if (node.name === "Math") { result = "Math"; break; }
        if (node.name === "Date") { result = "Date"; break; }
        this.report(node, `Símbolo no definido '${node.name}'`);
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
          // `??` (nullish coalescing) no se admite en este dialecto: el único
          // ausente sería `void`, pero `void` puro no es un valor reutilizable
          // en C++ (no tiene `.value_or`) y las uniones `T | void` que produce
          // el lenguaje se modelan con `std::variant<T, ets::void_t>`, que
          // tampoco tiene `.value_or`. El dialecto prefiere la API explícita:
          //   - `Map.has(k) ? m.get(k) : default`
          //   - `result.isOk() ? result.value() : default`
          this.report(node, "El operador '??' no se admite; usá la API explícita del tipo (Map.has/get, Result.isOk/value)");
          result = left ?? right;
        }
        else if (["+", "-", "*", "/", "%"].includes(node.operator)) { this.require(left, "number", node.left); this.require(right, "number", node.right); result = "number"; }
        else if (["|", "&", "^", "<<", ">>"].includes(node.operator)) { this.require(left, "number", node.left); this.require(right, "number", node.right); result = "number"; }
        else if (["<", "<=", ">", ">="].includes(node.operator)) { this.require(left, "number", node.left); this.require(right, "number", node.right); result = "boolean"; }
        else if (["==", "!="].includes(node.operator)) { if (left !== right) this.report(node, "Los operandos comparados deben tener el mismo tipo"); result = "boolean"; }
        else { this.require(left, "boolean", node.left); this.require(right, "boolean", node.right); result = "boolean"; }
        break;
      }
      case "CallExpression": {
        if (JSON_HELPERS[node.callee]) {
          const signature = JSON_HELPERS[node.callee];
          if (node.args.length !== signature.params.length) this.report(node, `'${node.callee}' espera ${signature.params.length} argumentos, recibió ${node.args.length}`);
          node.args.forEach((arg, index) => { const expectedType = signature.params[index]; const actual = this.expression(arg, scope, expectedType); if (expectedType) this.require(actual, expectedType, arg); });
          result = signature.returnType; break;
        }
        const symbol = scope.resolve(node.callee);
        if (!symbol) { this.report(node, `Función no definida '${node.callee}'`); node.args.forEach(a => this.expression(a, scope)); break; }
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
        const resolvedClass = this.resolveClass(objectType);
        const constrainedInterface = this.activeTypeConstraints.get(objectType);
        const owner = this.interfaces.get(constrainedInterface ?? objectType) ?? resolvedClass?.owner;
        const methods = owner?.methods.filter(candidate => candidate.name === node.method) ?? [];
        if (!owner) this.report(node.object, `El tipo '${objectType}' no tiene métodos`);
        else if (!methods.length) this.report(node, `El tipo '${objectType}' no declara '${node.method}'`);
        const argumentTypes = node.args.map(arg => this.expression(arg, scope));
        const classSubstitutions = resolvedClass?.substitutions ?? new Map<string, TypeName>();
        const matches = methods.map(method => {
          const signature: FunctionSignature = {
            typeParameters: TypeChecker.namesOf(method.typeParameters ?? []), variadicTypeParameters: [], typeConstraints: TypeChecker.constraintsOf(method.typeParameters ?? []), defaults: TypeChecker.defaultsOf(method.typeParameters ?? []),
            params: method.params.map(parameter => ({ type: this.substituteType(parameter.type, classSubstitutions), out: parameter.out, mutableReference: parameter.passing === "mut", defaultValue: parameter.defaultValue })),
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
        // Acceso a miembro de enum: `Color.Green` se evalúa al tipo del enum, no al subyacente.
        // La conversión al subyacente ocurre en el codegen cuando se necesita (p.ej. `print(c)`).
        if (node.object.kind === "IdentifierExpression" && this.enums.has(node.object.name)) {
          const enumNode = this.enums.get(node.object.name)!;
          const member = enumNode.members.find(candidate => candidate.name === node.member);
          if (!member) this.report(node, `El enum '${node.object.name}' no declara el miembro '${node.member}'`);
          result = node.object.name;
          break;
        }
        const resolved = this.resolveClass(objectType); const owner = resolved?.owner;
        const field = owner?.fields.find(candidate => candidate.name === node.member);
        if (!owner) this.report(node.object, `El tipo '${objectType}' no es una clase concreta`);
        else if (!field) this.report(node, `La clase '${objectType}' no declara el campo '${node.member}'`);
        if (field) result = this.substituteType(field.type, resolved?.substitutions ?? new Map());
        break;
      }
      case "IndexExpression": {
        const objectType = this.expression(node.object, scope);
        this.require(this.expression(node.index, scope, "number"), "number", node.index);
        if (isArrayType(objectType)) result = arrayElement(objectType);
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
    if (node.kind === "MemberExpression") return this.mutableTarget(node.object, scope);
    if (node.kind === "IndexExpression") return this.mutableTarget(node.object, scope);
    if (node.kind !== "IdentifierExpression") return false;
    const symbol = scope.resolve(node.name);
    return !!symbol && symbol.kind === "variable" && symbol.mutable;
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
    const requiredCount = signature.params.filter(parameter => !parameter.defaultValue && !parameter.variadic).length;
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
    const base = isGenericType(type) ? genericBase(type) : type; const owner = this.classes.get(base);
    if (!owner) return undefined;
    const substitutions = new Map<string, TypeName>(); const arguments_ = isGenericType(type) ? genericArguments(type) : [];
    owner.typeParameters.forEach((parameter, index) => { if (arguments_[index]) substitutions.set(parameter.name, arguments_[index]); });
    return { owner, substitutions };
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
  private report(node: { span: import("../core/span.ts").Span }, message: string): void { this.diagnostics.push({ phase: "semantic", message, span: node.span }); }
}
