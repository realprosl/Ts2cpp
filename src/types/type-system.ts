import type { TypeName } from "../ast/nodes.ts";

const PRIMITIVES = new Set<TypeName>(["number", "string", "boolean", "void"]);

export function isPrimitive(type: TypeName): boolean { return PRIMITIVES.has(type); }
export function arrayType(element: TypeName): TypeName { return `${element}[]`; }
export function isArrayType(type: TypeName): boolean { return type.endsWith("[]"); }
export function arrayElement(type: TypeName): TypeName { return type.slice(0, -2); }
export function tupleType(elements: TypeName[]): TypeName { return `[${elements.join(",")}]`; }
export function isTupleType(type: TypeName): boolean { return type.startsWith("[") && type.endsWith("]"); }
export function functionType(parameters: TypeName[], result: TypeName): TypeName { return `(${parameters.join(",")})=>${result}`; }
export function isFunctionType(type: TypeName): boolean { return type.startsWith("(") && matchingFunctionClose(type) >= 0; }

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
