import type { Program, Statement, Expression, TypeName, FunctionDeclaration, InterfaceDeclaration, ClassDeclaration, ClassMethod, BlockStatement, VariableDeclaration, EnumDeclaration, TypeParameter } from "../ast/nodes.ts";
import { cppType } from "./cpp-types.ts";
import { cppParameterDeclaration } from "./cpp-parameters.ts";
import { functionResult, genericArguments, genericBase, intersectionMembers, isArrayType, isFunctionType, isGenericType, isIntersectionType, isMapType, isPromiseType, isSetType, isTupleType, isUnionType, promiseResult } from "../types/type-system.ts";

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
  // Mapa de funciones top-level indexadas por nombre, usado para rellenar
  // argumentos opcionales omitidos en call sites con `optionalNone<T>()`.
  private readonly topLevelFunctions = new Map<string, FunctionDeclaration[]>();
  private readonly expressionType: (node: Expression) => TypeName | undefined;
  private readonly expressionIsVariadic: (node: Expression) => boolean;
  private readonly callTypeArguments: (node: Expression) => TypeName[];
  private inClassMethod = false;
  private inStaticInit = false;
  private inAsyncFunction = false;
  // Renombrados de variables que colisionan con singletons globales del runtime
  // (`console`, `fs`, `path`, `process`, `JSON`). Se prefijan con `ets_local_`
  // en C++ para evitar la colisión con `inline ets_path path{}` etc. Las
  // referencias en el código generado se reescriben al pasar por `cppName`.
  private readonly runtimeGlobals = new Set(["console", "fs", "path", "process", "JSON"]);
  private readonly localRenames = new Map<string, string>();
  private destructuringCounter = 0;
  constructor(expressionType?: (node: Expression) => TypeName | undefined, expressionIsVariadic?: (node: Expression) => boolean, callTypeArguments?: (node: Expression) => TypeName[]) {
    this.expressionType = expressionType ?? (() => undefined); this.expressionIsVariadic = expressionIsVariadic ?? (() => false);
    this.callTypeArguments = callTypeArguments ?? (() => []);
  }
  // Devuelve el nombre C++ para un identificador del programa. Si fue renombrado
  // por colisión con un global del runtime, devuelve el nombre prefijado.
  private cppName(name: string): string {
    return this.localRenames.get(name) ?? name;
  }
  private prepare(program: Program): void {
    const interfaces = program.statements.filter((s): s is InterfaceDeclaration => s.kind === "InterfaceDeclaration");
    const classes = program.statements.filter((s): s is ClassDeclaration => s.kind === "ClassDeclaration");
    this.interfaceNames.clear(); interfaces.forEach(contract => this.interfaceNames.add(contract.name));
    this.classNames.clear(); classes.forEach(node => this.classNames.add(node.name));
    this.aliasNames.clear();
    this.enumNames.clear();
    this.enumUnderlying.clear();
    this.topLevelFunctions.clear();
    for (const stmt of program.statements) {
      if (stmt.kind === "TypeAliasDeclaration") this.aliasNames.add(stmt.name);
      if (stmt.kind === "EnumDeclaration") { this.enumNames.add(stmt.name); this.enumUnderlying.set(stmt.name, stmt.underlying); }
      if (stmt.kind === "FunctionDeclaration") {
        const list = this.topLevelFunctions.get(stmt.name) ?? [];
        list.push(stmt);
        this.topLevelFunctions.set(stmt.name, list);
      }
    }
    this.indent = 0;
  }
  private usesTls(program: Program): boolean { return /\b(?:TlsContext|TlsConnection|createTlsServer|acceptTls|readTls|writeTls|closeTls)\b/.test(JSON.stringify(program)); }
  private usesCompilerAst(program: Program): boolean { return /\b(?:validateSyntax|syntaxTreeJson|syntaxTreeRecords|estaticAstRecords|estaticTypedAstJson|estaticTypedAstRecords)\b/.test(JSON.stringify(program)); }
  private includes(usesTls: boolean, usesCompilerAst: boolean): string[] {
    return ["#include <iostream>", "#include <string>", "#include <vector>", "#include <tuple>", "#include <functional>", "#include <cmath>", "#include <concepts>", "#include <utility>", "#include \"runtime/ets_runtime.hpp\"", ...(usesCompilerAst ? ["#include \"runtime/ets_ast.hpp\""] : []), ...(usesTls ? ["#include \"runtime/ets_tls.hpp\""] : [])];
  }
  generate(program: Program): string {
    const functions = program.statements.filter((s): s is FunctionDeclaration => s.kind === "FunctionDeclaration");
    const interfaces = program.statements.filter((s): s is InterfaceDeclaration => s.kind === "InterfaceDeclaration");
    const classes = program.statements.filter((s): s is ClassDeclaration => s.kind === "ClassDeclaration");
    const enums = program.statements.filter((s): s is EnumDeclaration => s.kind === "EnumDeclaration");
    this.prepare(program);
    const topLevelVariables = program.statements.filter((s): s is VariableDeclaration => s.kind === "VariableDeclaration");
    const topLevelOther = program.statements.filter(s =>
      s.kind !== "FunctionDeclaration" && s.kind !== "InterfaceDeclaration" &&
      s.kind !== "ClassDeclaration" && s.kind !== "VariableDeclaration" &&
      s.kind !== "TypeAliasDeclaration" && s.kind !== "EnumDeclaration"
    );
    const lines = ["// Generated by estatic-ts-cpp. Do not edit.", ...this.includes(this.usesTls(program), this.usesCompilerAst(program)), ""];
    for (const contract of interfaces) lines.push(this.interfaceConcept(contract), "");
    for (const node of enums) lines.push(this.enumDeclaration(node), "");
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
      const initializer = this.emitExpression(variable.initializer);
      this.inStaticInit = previous;
      // Si el nombre colisiona con un singleton global del runtime, lo
      // renombramos en C++ y registramos el rename para que las referencias
      // posteriores se emitan con el nombre canónico.
      const cppName = this.runtimeGlobals.has(variable.name)
        ? (this.localRenames.set(variable.name, `ets_local_${variable.name}`), `ets_local_${variable.name}`)
        : variable.name;
      lines.push(`static ${cppType(type)} ${cppName} = ${initializer};`);
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
    const lines = ["// Generated declarations. Do not edit.", "#pragma once", ...this.includes(this.usesTls(program), this.usesCompilerAst(program)), ""];
    for (const contract of interfaces) lines.push(this.interfaceConcept(contract), "");
    for (const node of classes) lines.push(this.classForward(node));
    if (classes.length) lines.push("");
    for (const fn of functions) lines.push(this.signature(fn) + ";");
    if (functions.length) lines.push("");
    for (const node of classes) lines.push(this.classDeclaration(node), "");
    for (const fn of functions.filter(candidate => candidate.typeParameters.length > 0)) lines.push(this.function(fn), "");
    for (const variable of variables) lines.push(`extern ${cppType(variable.declaredType ?? this.expressionType(variable.initializer) ?? "void")} ${variable.name};`);
    if (variables.length) lines.push("");
    for (const initializer of moduleInitializers) lines.push(`void ${initializer}();`);
    lines.push("");
    return lines.join("\n");
  }
  generateModule(program: Program, combinedProgram: Program, headerName: string, initializer: string, entryInitializers?: string[]): string {
    this.prepare(combinedProgram);
    const allFunctions = program.statements.filter((statement): statement is FunctionDeclaration => statement.kind === "FunctionDeclaration");
    const functions = allFunctions.filter(statement => statement.typeParameters.length === 0);
    const privateFunctions = allFunctions.filter(statement => !statement.exported);
    const privateInterfaces = program.statements.filter((statement): statement is InterfaceDeclaration => statement.kind === "InterfaceDeclaration" && !statement.exported);
    const privateClasses = program.statements.filter((statement): statement is ClassDeclaration => statement.kind === "ClassDeclaration" && !statement.exported);
    const variables = program.statements.filter((statement): statement is VariableDeclaration => statement.kind === "VariableDeclaration");
    const topLevel = program.statements.filter(statement => statement.kind !== "FunctionDeclaration" && statement.kind !== "InterfaceDeclaration" && statement.kind !== "ClassDeclaration" && statement.kind !== "VariableDeclaration");
    const lines = ["// Generated module. Do not edit.", `#include ${JSON.stringify(headerName)}`, ""];
    for (const contract of privateInterfaces) lines.push(this.interfaceConcept(contract), "");
    for (const node of privateClasses) lines.push(this.classForward(node));
    if (privateClasses.length) lines.push("");
    for (const fn of privateFunctions) lines.push(this.signature(fn, true) + ";");
    if (privateFunctions.length) lines.push("");
    for (const node of privateClasses) lines.push(this.classDeclaration(node), "");
    for (const fn of privateFunctions.filter(candidate => candidate.typeParameters.length > 0)) lines.push(this.function(fn, true), "");
    for (const variable of variables) lines.push(`${variable.exported ? "" : "static "}${cppType(variable.declaredType ?? this.expressionType(variable.initializer) ?? "void")} ${variable.name}{};`);
    if (variables.length) lines.push("");
    for (const fn of functions) lines.push(this.function(fn, !fn.exported), "");
    lines.push(`void ${initializer}() {`); this.indent++;
    for (const variable of variables) lines.push(this.pad() + `${variable.name} = ${this.emitExpression(variable.initializer)};`);
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
  private signature(fn: FunctionDeclaration, internal = false, includeDefaults = true): string {
    const constrained = fn.params.map((p, i) => ({ p, i })).filter(({ p }) => this.interfaceNames.has(p.type));
    const templateParts = [...fn.typeParameters.map(parameter => {
      const base = fn.variadicTypeParameters.includes(parameter.name) ? `typename... ${parameter.name}` : `typename ${parameter.name}`;
      // En C++ los defaults de los parámetros de plantilla solo van en la declaración
      // adelantada; el cuerpo de la función los omite (igual que los defaults de los
      // parámetros de valor). El flag `includeDefaults` controla ambos.
      return includeDefaults && parameter.default ? `${base} = ${cppType(parameter.default)}` : base;
    }), ...constrained.map(({ p, i }) => `${p.type} T${i}`)];
    const template = templateParts.length ? `template <${templateParts.join(", ")}>\n` : "";
    const requiresClauses = fn.typeParameters.filter(parameter => parameter.constraint).map(parameter => `requires ${cppRequires(parameter.constraint!, parameter.name)}`);
    const requires = requiresClauses.length ? `${requiresClauses.join("\n")}\n` : "";
    // C++ no permite defaults en la definición si ya están en la declaración;
    // pasamos `false` al emitir el cuerpo.
    // `p?: T` se traduce a `Optional<T>` en C++. Si el user ya escribió
    // `Optional<T>` no duplicamos el envoltorio.
    const params = fn.params.map((p, i) => {
      const baseType = cppType(p.type);
      const effectiveType = p.optional && !(isGenericType(p.type) && genericBase(p.type) === "Optional") ? `ets::Optional<${cppType(p.type)}>` : (this.interfaceNames.has(p.type) ? `T${i}` : baseType);
      return cppParameterDeclaration(p, this.interfaceNames.has(p.type) ? `T${i}` : effectiveType, fn.async, includeDefaults && p.defaultValue ? this.emitExpression(p.defaultValue) : undefined);
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
  private classForward(node: ClassDeclaration): string {
    const template = node.typeParameters.length ? `template <${node.typeParameters.map(parameter => {
      const base = `typename ${parameter.name}`;
      return parameter.default ? `${base} = ${cppType(parameter.default)}` : base;
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
  private function(fn: FunctionDeclaration, internal = false): string {
    const previous = this.inAsyncFunction; this.inAsyncFunction = fn.async;
    const appendCoReturn = fn.async && isPromiseType(fn.returnType) && promiseResult(fn.returnType) === "void" && fn.body.statements.at(-1)?.kind !== "ReturnStatement";
    const output = `${this.signature(fn, internal, false)} ${this.emitBlock(fn.body, appendCoReturn)}`;
    this.inAsyncFunction = previous; return output;
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
        return `${this.pad()}${this.variableIsConst(node) ? "const " : ""}${node.declaredType && !this.interfaceNames.has(node.declaredType) ? cppType(node.declaredType) : "auto"} ${this.cppName(node.name)} = ${this.emitExpression(node.initializer)};`;
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
        return `${this.pad()}${this.inAsyncFunction ? "co_return" : "return"}${node.value ? " " + this.emitExpression(node.value) : ""};`;
      }
      case "IfStatement": { let out = `${this.pad()}if (${this.emitExpression(node.condition)}) ${this.statementBody(node.thenBranch)}`; if (node.elseBranch) out += ` else ${this.statementBody(node.elseBranch)}`; return out; }
      case "WhileStatement": return `${this.pad()}while (${this.emitExpression(node.condition)}) ${this.statementBody(node.body)}`;
      case "ForStatement": {
        let initializer = "";
        if (node.initializer?.kind === "VariableDeclaration") initializer = `${this.variableIsConst(node.initializer) ? "const " : ""}${node.initializer.declaredType ? cppType(node.initializer.declaredType) : "auto"} ${this.cppName(node.initializer.name)} = ${this.emitExpression(node.initializer.initializer)}`;
        else if (node.initializer?.kind === "ExpressionStatement") initializer = this.emitExpression(node.initializer.expression);
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
    }
  }

  // Emite `for (const auto& name : iterable)` para arrays y strings, envuelve
  // tuplas en un bloque con una única iteración, y proyecta pares de Map<K,V>
  // en tuplas `[K,V]` para mantener la semántica de indexación.
  private emitForOf(node: { binding: { name: string; mutable: boolean }; iterable: Expression; body: Statement; span: import("../core/span.ts").Span }): string {
    const iterableType = this.expressionType(node.iterable);
    const name = node.binding.name;
    const iter = this.emitExpression(node.iterable);
    const bodyStr = this.bodyInBlock(node.body);
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
  private variableIsConst(node: VariableDeclaration): boolean { return !node.mutable && !(node.initializer.kind === "ArrowFunctionExpression" && node.initializer.mutatesCapturedState); }
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
      case "IdentifierExpression": return node.name === "this" ? "(*this)" : this.cppName(node.name);
      case "ArrayLiteralExpression": {
        const type = this.expressionType(node);
        if (type && isTupleType(type)) {
          const values = node.elements.map(item => this.emitExpression(item));
          return `std::make_tuple(${values.join(", ")})`;
        }
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
        const values = node.elements.map(item => this.emitExpression(item)).join(", ");
        return `${cppType(type ?? "void[]")}{${values}}`;
      }
      case "ArrowFunctionExpression": {
        const type = this.expressionType(node); const result = type && isFunctionType(type) ? functionResult(type) : (node.returnType ?? "void");
        const params = node.params.map(parameter => cppParameterDeclaration(parameter, cppType(parameter.type), false, parameter.defaultValue ? this.emitExpression(parameter.defaultValue) : undefined)).join(", ");
        // Las lambdas a nivel de archivo (estáticas) no admiten capture-default; usamos `[]`
        // y dependeremos de `mutatesCapturedState` para forzar `mutable` si hace falta.
        // Si la closure muta estado capturado, capturamos por referencia (`[&]`) para
        // que las mutaciones sean visibles fuera de la lambda.
        const capture = this.inStaticInit ? "[]"
          : this.inClassMethod ? "[=, this]"
          : node.mutatesCapturedState ? "[&]"
          : "[=]";
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
        // Operadores bitwise: el dialecto modela `number` como `double`, pero
        // C++ rechaza `|`/`&`/`^`/etc. entre doubles. Hacemos cast explícito
        // a `std::int64_t` para la operación y devolvemos `double`.
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
        return node.operator === "%" ? `std::fmod(${this.emitExpression(node.left)}, ${this.emitExpression(node.right)})` : `(${this.emitExpression(node.left)} ${node.operator} ${this.emitExpression(node.right)})`;
      }
      case "AssignmentExpression": return `(${this.emitExpression(node.target)} = ${this.emitExpression(node.value)})`;
      case "TernaryExpression": return `(${this.emitExpression(node.condition)} ? ${this.emitExpression(node.thenBranch)} : ${this.emitExpression(node.elseBranch)})`;
      case "CallExpression": {
        const args = node.args.map(argument => {
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
        return node.callee === "print" ? `print(${args.join(", ")})` : `${node.callee}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${args.join(", ")})`;
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
        return `${this.emitExpression(node.object)}.${method}${typeArguments.length ? `<${typeArguments.map(cppType).join(", ")}>` : ""}(${node.args.map(a => this.emitExpression(a)).join(", ")})`;
      }
      case "MemberExpression": {
        // Los miembros de un enum se acceden como `Name::Member` en C++ (no `Name.Member`),
        // porque los enums numéricos se emiten como `enum class` y los de cadena como struct
        // con miembros estáticos, ninguno de los cuales admite el operador `.` desde fuera.
        if (node.object.kind === "IdentifierExpression" && this.enumNames.has(node.object.name)) return `${node.object.name}::${node.member}`;
        // `?.` desazucara a `optionalAndThen(obj, [](auto _e) { return optionalSome(_e.member); })`.
        // El type-checker garantiza que `obj` es `Optional<T>` y `T` tiene el campo.
        if (node.optional) {
          const obj = this.emitExpression(node.object);
          return `optionalAndThen(${obj}, [](auto _ets_optional_chain) { return optionalSome(_ets_optional_chain.${node.member}); })`;
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
}
