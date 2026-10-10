import type { TypeName } from "../ast/nodes.ts";
import { arrayElement, fixedArrayElement, fixedArraySize, functionParameters, functionResult, genericArguments, genericBase, isArrayType, isFixedArrayType, isFunctionType, isGenericType, isReadonlyType, isTupleType, isUnionType, readonlyInner, tupleElements, unionMembers, type ResolvedType } from "../types/type-system.ts";
import { cppInputType } from "./cpp-parameters.ts";

// V18: alias de tipos CPP externos (decorador `@cpp_type("Vector2")`).
// El CppGenerator exporta su `externalTypesMap` y se inyecta aquí. Si el
// dialecto tiene un tipo declarado como `@cpp_type("X")`, el codegen
// sustituye "X" en lugar del nombre del dialecto. Esto permite que el
// usuario escriba `Vector2` y el codegen lo mapee al tipo que viven en
// la librería enlazada.
const externalTypeNames = new Map<string, string>();
/** V18: registra los alias CPP externos poblados por decoradores. */
export function registerExternalType(name: string, cppType: string): void {
  externalTypeNames.set(name, cppType);
}
/** V18: limpia el registro entre compilaciones (por-programa). */
export function clearExternalTypes(): void {
  externalTypeNames.clear();
}

// TODO Phase 1.A: alias expansion happens in the type-checker (validateType, substituteType)
// before reaching cppType. If a raw alias name ever reaches here, it falls through to the
// passthrough branch and will appear as `Name` in C++ output. This should not happen in practice.

// V3: 10 tipos numéricos concretos mapeados 1:1 a C++ (i8..u64, f32, f64).
// Los nuevos tipos requieren anotación explícita; los literales siguen
// infiriendo a `number` (= double) para no romper demos existentes.
const PRIMITIVE_CPP: Record<string, string> = {
  number: "double",
  string: "std::string",
  boolean: "bool",
  void: "void",
  i8: "int8_t",
  i16: "int16_t",
  i32: "int32_t",
  i64: "int64_t",
  u8: "uint8_t",
  u16: "uint16_t",
  u32: "uint32_t",
  u64: "uint64_t",
  f32: "float",
  f64: "double",
};

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
  // V18: tipo CPP externo (decorador `@cpp_type("Vector2")`). Si el
  // codegen tiene un mapa con este nombre, devolvemos el alias tal cual.
  const external = externalTypeNames.get(type);
  if (external) return external;
  // V5: readonly<T> se traduce al tipo base sin decoración; la decoración
  // `const T&` la añade cppParameterDeclaration cuando el tipo aparece como
  // parámetro. Eso evita el doble `const const T&&` que se produciría al
  // wrappear dos veces.
  if (isReadonlyType(type)) return cppType(readonlyInner(type)!);
  if (isUnionType(type)) return `std::variant<${unionMembers(type).map(cppType).join(", ")}>`;
  if (isArrayType(type)) return `std::vector<${cppType(arrayElement(type))}>`;
  // V4: arrays de tamaño fijo → std::array<T, N> en pila. Consultamos los
  // caches tipados (no regex sobre el string del tipo).
  if (isFixedArrayType(type)) return `std::array<${cppType(fixedArrayElement(type)!)}, ${fixedArraySize(type)!}>`;
  if (isTupleType(type)) return `std::tuple<${tupleElements(type).map(cppType).join(", ")}>`;
  if (isFunctionType(type)) return `std::function<${cppType(functionResult(type))}(${functionParameters(type).map(parameter => cppInputType(parameter, cppType(parameter))).join(", ")})>`;
  if (isGenericType(type)) return cppTypeFromGenericString(genericBase(type), genericArguments(type));
  if (type === "Request") return "ets::HttpRequest";
  if (type === "Response") return "ets::HttpResponse";
  if (["TcpListener", "TcpConnection", "TlsContext", "TlsConnection", "CancellationSource", "CancellationToken", "FileReader", "Server"].includes(type)) return `ets::${type}`;
  if (type === "JsonValue") return "ets_json::Value";
  return type;
}

function cppTypeFromGenericString(sourceBase: string, args: TypeName[]): string {
  // V22 (Memory Model v2): los modificadores de paso son ptr<T>,
  // constPtr<T>, ref<T>, constRef<T>. Cada uno se traduce directamente a
  // su equivalente C++ (T*, const T*, T&, const T&).
  if (sourceBase === "ptr" || sourceBase === "constPtr" || sourceBase === "ref" || sourceBase === "constRef") {
    const inner = args[0];
    return inner ? cppMemoryType(sourceBase, inner) : "void";
  }
  const base = sourceBase === "Promise" ? "ets::Task"
    : sourceBase === "Result" ? "ets::Result"
    : sourceBase === "Map" ? "ets::Map"
    : sourceBase === "Set" ? "ets::Set"
    : sourceBase === "Optional" ? "ets::Optional"
    : sourceBase;
  return `${base}<${args.map(cppType).join(", ")}>`;
}

// V22 (Memory Model v2): mapa explícito de los 4 modificadores de paso
// a su tipo C++ correspondiente. ptr<T> y constPtr<T> modelan ownership
// exclusivo (std::unique_ptr); ref<T> y constRef<T> modelan préstamos
// no-null (referencias). Ningún modificador incrementa el reference
// count ni participa en ABI oculto.
export function cppMemoryType(name: "ptr" | "constPtr" | "ref" | "constRef", inner: TypeName): string {
  const innerCpp = cppType(inner);
  switch (name) {
    case "ptr":      return `std::unique_ptr<${innerCpp}>`;
    case "constPtr": return `std::unique_ptr<const ${innerCpp}>`;
    case "ref":      return `${innerCpp}&`;
    case "constRef": return `const ${innerCpp}&`;
  }
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
