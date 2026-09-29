import type { TypeName } from "../ast/nodes.ts";

// V3: tipos numéricos concretos mapeados 1:1 a C++ (i8..u64, f32, f64). NO se
// cambian las reglas de inferencia de literales: `42` y `3.14` siguen siendo
// `number`. Los nuevos tipos requieren anotación explícita (`let x: i32 = 42`)
// para preservar la compatibilidad con los 50+ demos existentes.
export const NUMERIC_TYPES = new Set<TypeName>(["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64"]);

const PRIMITIVES = new Set<TypeName>(["number", "string", "boolean", "void", ...NUMERIC_TYPES]);

export function isPrimitive(type: TypeName): boolean { return PRIMITIVES.has(type); }
export function isNumericType(type: TypeName): boolean { return NUMERIC_TYPES.has(type); }
// Devuelve el ancho en bits (8/16/32/64) para i*/u*, o null para f*/no-numéricos.
// Válido solo cuando `isNumericType(type)` es true.
export function numericBitWidth(type: TypeName): number | null {
  if (!NUMERIC_TYPES.has(type)) return null;
  if (type === "f32") return 32;
  if (type === "f64") return 64;
  return Number(type.slice(1)); // "i8" -> 8, "u64" -> 64
}
// Devuelve 'integer' | 'float' para los tipos numéricos V3, o null si no aplica.
export function numericKind(type: TypeName): "integer" | "float" | null {
  if (!NUMERIC_TYPES.has(type)) return null;
  return type.startsWith("f") ? "float" : "integer";
}
// Devuelve 'signed' | 'unsigned' para i*/u*, null para f* o no-numéricos.
export function numericSign(type: TypeName): "signed" | "unsigned" | null {
  if (!NUMERIC_TYPES.has(type)) return null;
  if (type.startsWith("f")) return null;
  return type.startsWith("u") ? "unsigned" : "signed";
}
export function arrayType(element: TypeName): TypeName { return `${element}[]`; }
export function isArrayType(type: TypeName): boolean { return type.endsWith("[]"); }
export function arrayElement(type: TypeName): TypeName { return type.slice(0, -2); }
// V4: arrays de tamaño fijo. La representación canónica es `T[N]` con N
// literal entero positivo. isFixedArrayType distingue entre T[N] (pila,
// std::array) y T[] (heap, std::vector).
//
// Importante: TypeName es un string, pero el dialecto no admite regex ni
// string-matching mágico sobre él. Mantenemos caches indexados por el
// nombre canónico y poblados al validar el tipo. Los consumers consultan
// los caches en vez de re-parsear.
const FIXED_ARRAY_SIZES: Map<TypeName, number> = new Map();
const FIXED_ARRAY_ELEMENTS: Map<TypeName, TypeName> = new Map();
// Registra `T[N]` como array fijo. Llamar una sola vez por combinación
// elemento/tamaño; idempotente. No validamos N (lo hace validateType).
export function registerFixedArray(element: TypeName, size: number): TypeName {
  const key: TypeName = `${element}[${size}]`;
  if (!FIXED_ARRAY_SIZES.has(key)) {
    FIXED_ARRAY_SIZES.set(key, size);
    FIXED_ARRAY_ELEMENTS.set(key, element);
  }
  return key;
}
export function isFixedArrayType(type: TypeName): boolean { return FIXED_ARRAY_SIZES.has(type); }
export function fixedArrayElement(type: TypeName): TypeName | null { return FIXED_ARRAY_ELEMENTS.get(type) ?? null; }
export function fixedArraySize(type: TypeName): number | null { return FIXED_ARRAY_SIZES.get(type) ?? null; }
export function tupleType(elements: TypeName[]): TypeName { return `[${elements.join(",")}]`; }
export function isTupleType(type: TypeName): boolean { return type.startsWith("[") && type.endsWith("]"); }
export function functionType(parameters: TypeName[], result: TypeName): TypeName { return `(${parameters.join(",")})=>${result}`; }
export function isFunctionType(type: TypeName): boolean { return type.startsWith("(") && matchingFunctionClose(type) >= 0; }

// V5: readonly<T>. Decorador de tipo para tipos no-mutables. Codegen lo
// traduce a `const T&` para escalares y a referencias constantes para
// arrays. Representación canónica: `readonly<T>`. Sigue el patrón de
// FIXED_ARRAY (caches indexados por nombre canónico, no regex sobre el
// string del tipo).
const READONLY_INNERS = new Map<string, TypeName>();
const READONLY_TYPE_CACHE = new Set<string>();
export function readonlyType(inner: TypeName): TypeName {
  const key = `readonly<${inner}>`;
  READONLY_INNERS.set(key, inner);
  READONLY_TYPE_CACHE.add(key);
  return key;
}
export function isReadonlyType(type: TypeName): boolean { return READONLY_TYPE_CACHE.has(type); }
export function readonlyInner(type: TypeName): TypeName | null { return READONLY_INNERS.get(type) ?? null; }

export function functionParameters(type: TypeName): TypeName[] {
  const close = matchingFunctionClose(type);
  if (close < 0) return [];
  return splitTopLevel(type.slice(1, close));
}

export function functionResult(type: TypeName): TypeName {
  const close = matchingFunctionClose(type);
  return close < 0 ? "void" : type.slice(close + 3);
}
export function genericType(base: TypeName, arguments_: TypeName[]): TypeName { return `${base}<${arguments_.join(",")}>`; }
export function isGenericType(type: TypeName): boolean { return type.includes("<") && type.endsWith(">"); }
export function genericBase(type: TypeName): TypeName { const open = type.indexOf("<"); return open < 0 ? type : type.slice(0, open); }
export function genericArguments(type: TypeName): TypeName[] {
  const open = type.indexOf("<");
  return open < 0 || !type.endsWith(">") ? [] : splitTopLevel(type.slice(open + 1, -1));
}
export function promiseType(result: TypeName): TypeName { return genericType("Promise", [result]); }
export function isPromiseType(type: TypeName): boolean { return isGenericType(type) && genericBase(type) === "Promise" && genericArguments(type).length === 1; }
export function promiseResult(type: TypeName): TypeName { return isPromiseType(type) ? genericArguments(type)[0] : "void"; }

// Union types: sintaxis `A | B | C` en el lenguaje fuente. La representación
// canónica es la cadena `"A | B | C"`; estas helpers dividen y testean a nivel
// top-level (respetando (), [], <>).
export function isUnionType(type: TypeName): boolean {
  let round = 0; let square = 0; let angle = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === "(") round++; else if (c === ")") round--;
    else if (c === "[") square++; else if (c === "]") square--;
    else if (c === "<") angle++; else if (c === ">") angle--;
    else if (c === "|" && round === 0 && square === 0 && angle === 0) return true;
  }
  return false;
}

export function unionMembers(type: TypeName): TypeName[] {
  if (!isUnionType(type)) return [type];
  const result: TypeName[] = [];
  let round = 0; let square = 0; let angle = 0; let start = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === "(") round++; else if (c === ")") round--;
    else if (c === "[") square++; else if (c === "]") square--;
    else if (c === "<") angle++; else if (c === ">") angle--;
    else if (c === "|" && round === 0 && square === 0 && angle === 0) {
      result.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(type.slice(start).trim());
  return result;
}

// ¿`actual` está cubierto por `expected`? Para tipos simples, igualdad. Para
// unions, `actual` debe ser uno de los miembros. Un union acepta union si los
// miembros del actual están todos cubiertos.
export function typeMatches(actual: TypeName, expected: TypeName): boolean {
  // `Mut<T>` y `MutRef<T>` son modificadores: si el expected es uno de ellos
  // y el actual es T (o viceversa), aceptamos el match.
  if (isGenericType(expected)) {
    const base = genericBase(expected);
    if (base === "Mut" || base === "MutRef") {
      const inner = genericArguments(expected)[0];
      if (inner && typeMatches(actual, inner)) return true;
    }
  }
  if (isGenericType(actual)) {
    const base = genericBase(actual);
    if (base === "Mut" || base === "MutRef") {
      const inner = genericArguments(actual)[0];
      if (inner && typeMatches(inner, expected)) return true;
    }
  }
  // V3: el literal numérico del dialecto siempre se modela como `number`
  // (= double). Cuando el usuario anota un tipo numérico concreto (i8..u64,
  // f32, f64) en la declaración, permitimos la asignación; el rango se
  // verifica en `validateNumericLiteral` y el codegen emite el
  // `static_cast<target>(literal)` correspondiente.
  if (actual === "number" && isNumericType(expected)) return true;
  // V3: dos tipos numéricos concretos son intercambiables para asignación
  // (el C++ emite el static_cast correcto en narrowing). Esto permite
  // `let y: i64 = i32(42);` y similares.
  if (isNumericType(actual) && isNumericType(expected)) return true;
  // V5: readonly<T> acepta un argumento T (covarianza: T es más fuerte que
  // readonly<T> porque puede mutar). Pero readonly<T> NO acepta T porque
  // entonces no podríamos garantizar la inmutabilidad.
  // Si tanto el actual como el expected son readonly<T>, comparamos los
  // inners recursivamente.
  if (isReadonlyType(expected) && isReadonlyType(actual)) {
    const expectedInner = readonlyInner(expected);
    const actualInner = readonlyInner(actual);
    if (expectedInner && actualInner) return typeMatches(actualInner, expectedInner);
    return false;
  }
  if (isReadonlyType(expected)) {
    const inner = readonlyInner(expected);
    if (inner && typeMatches(actual, inner)) return true;
    return false;
  }
  if (expected === actual) return true;
  if (!isUnionType(expected)) return false;
  if (isUnionType(actual)) return unionMembers(actual).every(member => unionMembers(expected).includes(member));
  return unionMembers(expected).includes(actual);
}

// Intersection types: `A & B`. La representación canónica es la cadena
// `"A & B"`; estas helpers dividen y testean a nivel top-level (respetando
// (), [], <>). Las precedencias son: union (`|`) menor que intersección
// (`&`), es decir, `A & B | C` se parsea como `(A & B) | C`.
export function isIntersectionType(type: TypeName): boolean {
  let round = 0; let square = 0; let angle = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === "(") round++; else if (c === ")") round--;
    else if (c === "[") square++; else if (c === "]") square--;
    else if (c === "<") angle++; else if (c === ">") angle--;
    else if (c === "&" && round === 0 && square === 0 && angle === 0) return true;
  }
  return false;
}

export function intersectionMembers(type: TypeName): TypeName[] {
  if (!isIntersectionType(type)) return [type];
  const result: TypeName[] = [];
  let round = 0; let square = 0; let angle = 0; let start = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === "(") round++; else if (c === ")") round--;
    else if (c === "[") square++; else if (c === "]") square--;
    else if (c === "<") angle++; else if (c === ">") angle--;
    else if (c === "&" && round === 0 && square === 0 && angle === 0) {
      result.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(type.slice(start).trim());
  return result;
}

export function tupleElements(type: TypeName): TypeName[] {
  if (!isTupleType(type)) return [];
  const body = type.slice(1, -1);
  if (!body) return [];
  const result: TypeName[] = [];
  let depth = 0; let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "[") depth++;
    else if (char === "]") depth--;
    else if (char === "," && depth === 0) { result.push(body.slice(start, i)); start = i + 1; }
  }
  result.push(body.slice(start));
  return result;
}

function matchingFunctionClose(type: TypeName): number {
  if (!type.startsWith("(")) return -1;
  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    if (type[i] === "(") depth++;
    else if (type[i] === ")") {
      depth--;
      if (depth === 0) return type.slice(i, i + 3) === ")=>" ? i : -1;
    }
  }
  return -1;
}

function splitTopLevel(value: string): TypeName[] {
  if (!value) return [];
  const result: TypeName[] = []; let round = 0; let square = 0; let angle = 0; let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") round++; else if (value[i] === ")") round--;
    else if (value[i] === "[") square++; else if (value[i] === "]") square--;
    else if (value[i] === "<") angle++; else if (value[i] === ">") angle--;
    else if (value[i] === "," && round === 0 && square === 0 && angle === 0) { result.push(value.slice(start, i)); start = i + 1; }
  }
  result.push(value.slice(start)); return result;
}

// Type alias helpers
export function isTypeAlias(name: string, aliasTable: ReadonlyMap<string, TypeName>): boolean {
  return aliasTable.has(name);
}

export function expandAlias(name: string, aliasTable: ReadonlyMap<string, TypeName>, visited: Set<string> = new Set()): TypeName | undefined {
  if (visited.has(name)) return undefined; // cycle guard
  visited.add(name);
  return aliasTable.get(name);
}

// Enum helpers (enumTable: name -> array of { name, value? })
export interface EnumMemberInfo {
  name: string;
  value?: TypeName; // resolved literal type: "number" with value as string, or "string" with the literal
}

export function isEnumType(name: string, enumTable: ReadonlyMap<string, EnumMemberInfo[]>): boolean {
  return enumTable.has(name);
}

// typeof-as-type marker: we use a prefix that doesn't collide with user identifiers
// Format: "$typeof$<NAME>"
export function typeofType(name: string): TypeName {
  return "$typeof$" + name;
}

export function isTypeofType(type: string): boolean {
  return type.startsWith("$typeof$");
}

export function typeofTarget(type: string): string {
  return type.slice("$typeof$".length);
}

// Map / Set detection (used by delete, for..of, for..in)
export function isMapType(type: TypeName): boolean {
  return type.startsWith("Map<") && type.endsWith(">");
}

export function isSetType(type: TypeName): boolean {
  return type.startsWith("Set<") && type.endsWith(">");
}

// ─────────────────────────────────────────────────────────────────────────────
// ResolvedType — representación rica del tipo, adjuntada a cada Expression.
//
// V0.1 lleva la información semántica al AST en lugar de tener un mapa
// paralelo (`Map<Expression, TypeName>`). Las decisiones del codegen (qué
// tipo C++ emitir, si el target es puntero, si es genérico) se toman
// inspeccionando `expr.resolvedType.kind`, no parseando strings.
//
// Esta representación es backward-compatible con `TypeName` (string): el
// helper `toResolvedType(typeName)` convierte cualquier `TypeName` a su forma
// estructurada. El codegen acepta ambos hasta que todo el checker use
// `resolvedType` directamente.
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedPrimitiveName = "number" | "string" | "boolean" | "void" | "i8" | "i16" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" | "f32" | "f64";

export type ResolvedType =
  | { kind: "primitive"; name: ResolvedPrimitiveName }
  | { kind: "class"; name: string }
  | { kind: "generic"; base: string; args: ResolvedType[] }
  | { kind: "array"; element: ResolvedType }
  | { kind: "tuple"; elements: ResolvedType[] }
  | { kind: "function"; parameters: ResolvedType[]; result: ResolvedType }
  | { kind: "union"; members: ResolvedType[] }
  | { kind: "any" };

/**
 * Convierte un `TypeName` (string) a su forma `ResolvedType` estructurada.
 * Útil durante la transición: el checker puede seguir produciendo strings
 * pero el codegen consume `ResolvedType` directamente.
 */
export function toResolvedType(type: TypeName | undefined): ResolvedType | undefined {
  if (type === undefined) return undefined;
  if (isPrimitive(type)) return { kind: "primitive", name: type as ResolvedPrimitiveName };
  if (isUnionType(type)) {
    return { kind: "union", members: unionMembers(type).map(toResolvedType).filter((t): t is ResolvedType => !!t) };
  }
  if (isGenericType(type)) {
    return { kind: "generic", base: genericBase(type), args: genericArguments(type).map(toResolvedType).filter((t): t is ResolvedType => !!t) };
  }
  if (isArrayType(type)) {
    const inner = toResolvedType(arrayElement(type));
    return inner ? { kind: "array", element: inner } : { kind: "any" };
  }
  if (isTupleType(type)) {
    // tuple "T1,T2" inside [...]
    const inner = type.slice(1, -1);
    return { kind: "tuple", elements: splitTopLevel(inner).map(toResolvedType).filter((t): t is ResolvedType => !!t) };
  }
  if (isFunctionType(type)) {
    return { kind: "function", parameters: functionParameters(type).map(toResolvedType).filter((t): t is ResolvedType => !!t), result: toResolvedType(functionResult(type)) ?? { kind: "any" } };
  }
  if (isTypeofType(type)) {
    return { kind: "class", name: typeofTarget(type) };
  }
  // Tipo "class" plano.
  return { kind: "class", name: type };
}

/**
 * `resolvedType` es un campo opcional de Expression. Este tipo helper acota
 * el resultado para que el codegen pueda usar `expr.resolvedType.kind` sin
 * chequeos opcionales en cada call site.
 */
export type ExpressionWithResolvedType = {
  resolvedType?: ResolvedType;
};

/**
 * Obtiene el `ResolvedType` de una expresión, devolviendo `{ kind: "any" }`
 * si no está anotado (compatible con código que aún no haya pasado por el
 * semantic checker, p.ej. tests unit del AST).
 */
export function resolvedTypeOf(expr: ExpressionWithResolvedType): ResolvedType {
  return expr.resolvedType ?? { kind: "any" };
}

/**
 * V0.3: huella estructural de una función/método. Adjuntada a
 * `FunctionDeclaration`, `ClassMethod`, `InterfaceMethod` y
 * `ArrowFunctionExpression` por el semantic checker. Permite al codegen:
 * - Comparar firmas para overload resolution sin parsear strings.
 * - Generar SFINAE constraints para genéricos.
 * - Decidir const-correctness directamente desde los tipos resueltos
 *   en lugar de recaer en regex.
 */
export interface ResolvedParameterSignature {
  name: string;
  type: ResolvedType;
  optional: boolean;
  variadic: boolean;
  hasDefault: boolean;
}

export interface ResolvedSignature {
  parameters: ResolvedParameterSignature[];
  returnType: ResolvedType;
  /** Nombres de los typeParameters declarados (sin sustituir aún). */
  typeParameters: string[];
  /** `true` si la función es async (`async`/`Promise<T>`). */
  async: boolean;
}

/**
 * V0.4: tipo concreto en runtime C++ que se emite para una declaración
 * top-level. Adjuntado a `ClassDeclaration`, `InterfaceDeclaration`,
 * `EnumDeclaration` y `TypeAliasDeclaration`.
 *
 * A diferencia de `ResolvedType` (que describe tipos en el dialecto TS),
 * `ResolvedRuntimeType` describe cómo se materializa en C++: si la clase
 * se emite tal cual, si un alias se sustituye por otro tipo, si un genérico
 * necesita envoltorio `ets::` etc.
 */
export type ResolvedRuntimeType =
  | { kind: "passthrough"; cppName: string }
  | { kind: "ets_envelope"; base: "Unq" | "Rc" | "Optional" | "Task" | "Result" | "Map" | "Set"; args: ResolvedRuntimeType[] }
  | { kind: "alias"; target: ResolvedRuntimeType }
  | { kind: "polymorphic"; typeParameters: string[] }
  | { kind: "builtin"; cppName: string };

/**
 * Convierte `ResolvedType` de vuelta a su `TypeName` (string) para APIs
 * que aún dependen del string. Útil durante la transición: el codegen y
 * los consumidores históricos pueden seguir operando con strings mientras
 * el checker va poblando `resolvedType`.
 */
export function resolvedTypeToTypeName(type: ResolvedType): TypeName {
  switch (type.kind) {
    case "primitive": return type.name;
    case "class":     return type.name;
    case "array":     return arrayType(resolvedTypeToTypeName(type.element));
    case "tuple":     return `[${type.elements.map(resolvedTypeToTypeName).join(",")}]`;
    case "generic":   return genericType(type.base, type.args.map(resolvedTypeToTypeName));
    case "function":  return functionType(type.parameters.map(resolvedTypeToTypeName), resolvedTypeToTypeName(type.result));
    case "union":     return type.members.map(resolvedTypeToTypeName).join("|");
    case "any":       return "any";
  }
}

/**
 * V0.4: convierte un `TypeName` (string) a su `ResolvedRuntimeType`. La
 * conversión es conservadora: tipos que no encajan en las categorías
 * conocidas caen a `passthrough` (se emiten tal cual en C++). Esto
 * preserva la semántica actual mientras el codegen migra.
 */
export function toResolvedRuntimeType(type: TypeName): ResolvedRuntimeType {
  if (isPrimitive(type)) return { kind: "builtin", cppName: type };
  if (isGenericType(type)) {
    const base = genericBase(type);
    const args = genericArguments(type).map(toResolvedRuntimeType);
    if (base === "Unq" || base === "Rc" || base === "Optional" || base === "Promise" || base === "Result" || base === "Map" || base === "Set") {
      const envelopeBase = base === "Promise" ? "Task" : base as "Unq" | "Rc" | "Optional" | "Result" | "Map" | "Set";
      return { kind: "ets_envelope", base: envelopeBase, args };
    }
    return { kind: "passthrough", cppName: type };
  }
  if (isUnionType(type)) return { kind: "passthrough", cppName: type };
  if (isArrayType(type)) return { kind: "passthrough", cppName: type };
  if (isTupleType(type)) return { kind: "passthrough", cppName: type };
  if (isFunctionType(type)) return { kind: "passthrough", cppName: type };
  return { kind: "passthrough", cppName: type };
}
