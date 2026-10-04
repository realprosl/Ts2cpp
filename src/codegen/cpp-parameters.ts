import type { Parameter, ParameterPassing, TypeName } from "../ast/nodes.ts";
import { isGenericType, genericBase, genericArguments, isReadonlyType, type ResolvedType } from "../types/type-system.ts";
import { cppType, cppMemoryType } from "./cpp-types.ts";

// V22 (Memory Model v2): los 4 modificadores de paso son ptr<T>,
// constPtr<T>, ref<T>, constRef<T>. El codegen los traduce directamente
// a su tipo C++ (T*, const T*, T&, const T&) sin heurística.
//
// `T` (sin modifier) significa copia: T se pasa por valor. El dialecto
// ya no convierte T en const T& implícitamente.
//
// `out T` (parameter-level) se mantiene por compatibilidad con el
// mecanismo de resultados existente; se trata como T&.

export function automaticParameterUsesValue(type: TypeName, asynchronous: boolean): boolean {
  // V22: T siempre se pasa por valor (sin lowering implícito a const T&).
  // Solo los modifiers explícitos eligen T*, T&, etc.
  return true;
}

/**
 * V22: inspecciona un `ResolvedType` para detectar los 4 modificadores de
 * paso. Devuelve `{ kind, inner, ownership, access }` si aplica; `null`
 * en caso contrario. Esta función es la única fuente de verdad para
 * distinguir modificadores: el codegen la consume directamente en lugar
 * de parsear strings.
 */
export type ModifierKind = "ptr" | "constPtr" | "ref" | "constRef";

export type ModifierResolution =
  | { kind: ModifierKind; inner: ResolvedType }
  | null;

const MEMORY_MODIFIER_NAMES = new Set(["ptr", "constPtr", "ref", "constRef"]);

export function resolveParameterModifier(resolved: ResolvedType | undefined): ModifierResolution {
  if (!resolved || resolved.kind !== "generic") return null;
  if (!MEMORY_MODIFIER_NAMES.has(resolved.base as string)) return null;
  if (!resolved.args[0]) return null;
  return { kind: resolved.base as ModifierKind, inner: resolved.args[0] };
}

/**
 * Compatibilidad: misma operación sobre `TypeName` (string). Conserva el
 * comportamiento histórico mientras se completa la migración.
 */
export function resolveParameterModifierFromString(type: TypeName): ModifierResolution {
  if (!isGenericType(type)) return null;
  const base = genericBase(type);
  if (!MEMORY_MODIFIER_NAMES.has(base)) return null;
  const argName = genericArguments(type)[0];
  if (!argName) return null;
  return { kind: base as ModifierKind, inner: { kind: "class", name: argName } };
}

/**
 * Devuelve el tipo C++ de entrada para un parámetro. V22: T siempre se
 * pasa por valor. Solo los modifiers explícitos (ptr/constPtr/ref/
 * constRef) eligen T*, T&, o std::unique_ptr<T>.
 */
export function cppInputType(type: TypeName, renderedType: string): string {
  // V22: T significa copia. No lowering implícito.
  return renderedType;
}

export function cppParameterDeclaration(parameter: Parameter, renderedType: string, asynchronous: boolean, defaultText?: string, cppName?: string): string {
  const mode: ParameterPassing = parameter.passing ?? (parameter.out ? "out" : "value");
  let type: string;
  // V22: los modifiers de paso (ptr/ref/constPtr/constRef) se traducen
  // directamente a su tipo C++. Vienen como parte del TypeName, no como
  // `passing`. La resolución prefiere el ResolvedType estructurado; cae
  // al parsing de string si el checker no lo pobló.
  const modifier = resolveParameterModifier(parameter.resolvedType) ?? resolveParameterModifierFromString(parameter.type);
  // V0.2: si el nombre colisiona con un singleton del runtime, usamos el
  // nombre prefijado `cppName` (pasado por el codegen) en lugar del original.
  const name = cppName ?? parameter.name;
  if (modifier) {
    const innerTypeName = parameter.type.includes("<")
      ? genericArguments(parameter.type)[0] ?? "void"
      : "void";
    type = cppMemoryType(modifier.kind, innerTypeName);
    if (parameter.variadic) type += "...";
    return `${type} ${name}${defaultText ? ` = ${defaultText}` : ""}`;
  }
  if (mode === "out") type = `${renderedType}&`;
  else type = renderedType; // V22: T siempre por valor.
  if (parameter.variadic) {
    if (type.endsWith("&") || type.endsWith(">")) type += "...";
    else type += "...";
  }
  return `${type} ${name}${defaultText ? ` = ${defaultText}` : ""}`;
}
