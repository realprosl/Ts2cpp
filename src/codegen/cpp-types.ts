import type { TypeName } from "../ast/nodes.ts";
import { arrayElement, functionParameters, functionResult, genericArguments, genericBase, isArrayType, isFunctionType, isGenericType, isTupleType, isUnionType, tupleElements, unionMembers, type ResolvedType } from "../types/type-system.ts";
import { cppInputType } from "./cpp-parameters.ts";

// TODO Phase 1.A: alias expansion happens in the type-checker (validateType, substituteType)
// before reaching cppType. If a raw alias name ever reaches here, it falls through to the
// passthrough branch and will appear as `Name` in C++ output. This should not happen in practice.

const PRIMITIVE_CPP: Record<string, string> = { number: "double", string: "std::string", boolean: "bool", void: "void" };

/**
 * V0.2: `cppType` acepta `TypeName` o `ResolvedType`. Si recibe `ResolvedType`,
 * evita el round-trip por string y usa los campos estructurados (args, members,
 * elements) directamente. Mantiene compatibilidad con todos los call sites
 * existentes que aún pasan `TypeName`.
 */
export function cppType(type: TypeName | ResolvedType): string {
  if (typeof type === "string") return cppTypeFromString(type);
  return cppTypeFromResolved(type);
}

function cppTypeFromString(type: TypeName): string {
  if (PRIMITIVE_CPP[type]) return PRIMITIVE_CPP[type];
  if (isUnionType(type)) return `std::variant<${unionMembers(type).map(cppType).join(", ")}>`;
  if (isArrayType(type)) return `std::vector<${cppType(arrayElement(type))}>`;
  if (isTupleType(type)) return `std::tuple<${tupleElements(type).map(cppType).join(", ")}>`;
  if (isFunctionType(type)) return `std::function<${cppType(functionResult(type))}(${functionParameters(type).map(parameter => cppInputType(parameter, cppType(parameter))).join(", ")})>`;
  if (isGenericType(type)) return cppTypeFromGenericString(genericBase(type), genericArguments(type));
  if (["TcpListener", "TcpConnection", "TlsContext", "TlsConnection", "CancellationSource", "CancellationToken"].includes(type)) return `ets::${type}`;
  if (type === "JsonValue") return "ets_json::Value";
  return type;
}

function cppTypeFromGenericString(sourceBase: string, args: TypeName[]): string {
  // `Mut<T>` y `MutRef<T>` son modificadores, no tipos envoltorio.
  // Se resuelven al tipo base (T). El cppParameterDeclaration se encarga
  // de emitir T* o T& cuando se usan como parámetro.
  if (sourceBase === "Mut" || sourceBase === "MutRef") {
    const inner = args[0];
    return inner ? cppType(inner) : "void";
  }
  const base = sourceBase === "Promise" ? "ets::Task"
    : sourceBase === "Result" ? "ets::Result"
    : sourceBase === "Map" ? "ets::Map"
    : sourceBase === "Set" ? "ets::Set"
    : sourceBase === "Optional" ? "ets::Optional"
    : sourceBase === "Unq" ? "ets::Unq"
    : sourceBase === "Rc" ? "ets::Rc"
    : sourceBase;
  return `${base}<${args.map(cppType).join(", ")}>`;
}

function cppTypeFromResolved(type: ResolvedType): string {
  switch (type.kind) {
    case "primitive": return PRIMITIVE_CPP[type.name] ?? type.name;
    case "class":     return cppClassName(type.name);
    case "array":     return `std::vector<${cppType(type.element)}>`;
    case "tuple":     return `std::tuple<${type.elements.map(cppType).join(", ")}>`;
    case "function":  return `std::function<${cppType(type.result)}(${type.parameters.map(p => cppType(p)).join(", ")})>`;
    case "union":     return `std::variant<${type.members.map(cppType).join(", ")}>`;
    case "generic":   return cppTypeFromGenericString(type.base, type.args.map(a => classNameOfResolved(a)));
    case "any":       return "auto";
  }
}

function cppClassName(name: string): string {
  if (["TcpListener", "TcpConnection", "TlsContext", "TlsConnection", "CancellationSource", "CancellationToken"].includes(name)) return `ets::${name}`;
  if (name === "JsonValue") return "ets_json::Value";
  return name;
}

function classNameOfResolved(r: ResolvedType): string {
  // Convierte un ResolvedType en su `TypeName` solo para reutilizar la lógica
  // de mapeo de genéricos (Promise→Task, Unq→ets::Unq, etc.). Las primitivas
  // y classes siguen siendo strings válidos; las compuestas se aplanan.
  switch (r.kind) {
    case "primitive": return r.name;
    case "class":     return r.name;
    case "array":     return `Array<${classNameOfResolved(r.element)}>`;
    case "tuple":     return `[${r.elements.map(classNameOfResolved).join(",")}]`;
    case "function":  return `(${r.parameters.map(classNameOfResolved).join(", ")}) => ${classNameOfResolved(r.result)}`;
    case "union":     return r.members.map(classNameOfResolved).join("|");
    case "generic":   return `${r.base}<${r.args.map(classNameOfResolved).join(", ")}>`;
    case "any":       return "any";
  }
}

// V1.2: recorre un `TypeName` (string) y devuelve los type parameter names
// que están declarados en `declared`. Se usa para emitir el prefijo de
// template mínimo en constructores de variantes de uniones genéricas:
// `Ok<T>` para `union Outcome<T, E> = Ok(T) | Err(E);`. Respeta paréntesis,
// corchetes y `<>`.
export function collectTypeParameterNames(type: TypeName, declared: Set<string>): Set<string> {
  const used = new Set<string>();
  let depthRound = 0; let depthSquare = 0; let depthAngle = 0;
  let current = "";
  const flush = () => {
    if (current.length) {
      if (declared.has(current)) used.add(current);
      current = "";
    }
  };
  for (let i = 0; i < type.length; i++) {
    const ch = type[i];
    if (ch === "(") depthRound++;
    else if (ch === ")") depthRound--;
    else if (depthRound > 0) continue;
    else if (ch === "[") depthSquare++;
    else if (ch === "]") depthSquare--;
    else if (depthSquare > 0) continue;
    else if (ch === "<") depthAngle++;
    else if (ch === ">") { depthAngle--; flush(); }
    else if (ch === "," || ch === "|" || ch === "&") { flush(); }
    else if (depthAngle > 0) current += ch;
    else if (/[a-zA-Z0-9_]/.test(ch)) current += ch;
    else flush();
  }
  flush();
  return used;
}
