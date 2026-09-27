import type { Parameter, ParameterPassing, TypeName } from "../ast/nodes.ts";
import { isGenericType, genericBase, genericArguments, type ResolvedType } from "../types/type-system.ts";
import { cppType } from "./cpp-types.ts";

export function automaticParameterUsesValue(type: TypeName, asynchronous: boolean): boolean {
  return asynchronous || type === "number" || type === "boolean";
}

/**
 * V0.2: inspecciona un `ResolvedType` para detectar los modificadores de paso
 * `Mut<T>` (T*) y `MutRef<T>` (T&). Devuelve `{ kind, inner }` si aplica;
 * `null` en caso contrario. Esta función es la única fuente de verdad para
 * distinguir modificadores: el codegen la consume directamente en lugar de
 * parsear strings.
 */
export type ModifierResolution =
  | { kind: "pointer"; inner: ResolvedType }
  | { kind: "reference"; inner: ResolvedType }
  | null;

export function resolveParameterModifier(resolved: ResolvedType | undefined): ModifierResolution {
  if (!resolved || resolved.kind !== "generic") return null;
  if (resolved.base === "Mut") return resolved.args[0] ? { kind: "pointer", inner: resolved.args[0] } : null;
  if (resolved.base === "MutRef") return resolved.args[0] ? { kind: "reference", inner: resolved.args[0] } : null;
  return null;
}

/**
 * Compatibilidad: misma operación sobre `TypeName` (string). Conserva el
 * comportamiento histórico mientras se completa la migración.
 */
export function resolveParameterModifierFromString(type: TypeName): ModifierResolution {
  if (!isGenericType(type)) return null;
  const base = genericBase(type);
  if (base === "Mut" || base === "MutRef") {
    const argName = genericArguments(type)[0];
    if (!argName) return null;
    // Reconstruimos un ResolvedType mínimo. El caller usará solo el cppType(inner).
    return { kind: base === "Mut" ? "pointer" : "reference", inner: { kind: "class", name: argName } };
  }
  return null;
}

/**
 * Devuelve el tipo C++ y el modo de paso para un parámetro, considerando
 * los modificadores `Mut<T>` (→ T*, puntero mutable) y `MutRef<T>` (→ T&,
 * referencia mutable).
 *
 * Para el resto de tipos, delega en la lógica automática.
 */
export function cppInputType(type: TypeName, renderedType: string): string {
  return automaticParameterUsesValue(type, false) ? renderedType : `const ${renderedType}&`;
}

export function cppParameterDeclaration(parameter: Parameter, renderedType: string, asynchronous: boolean, defaultText?: string): string {
  const mode: ParameterPassing = parameter.passing ?? (parameter.out ? "out" : "automatic");
  let type: string;
  // `Mut<T>` y `MutRef<T>` son modificadores: se traducen directamente a
  // `T*` y `T&` respectivamente, sin generar una clase envoltorio.
  // V0.2: primero intentamos con `resolvedType` (estructurado); caemos al
  // string parsing solo si el checker aún no lo pobló.
  const modifier = resolveParameterModifier(parameter.resolvedType) ?? resolveParameterModifierFromString(parameter.type);
  if (modifier) {
    const innerType = cppType(modifier.inner);
    type = modifier.kind === "pointer" ? `${innerType}*` : `${innerType}&`;
    if (parameter.variadic) type += "...";
    return `${type} ${parameter.name}${defaultText ? ` = ${defaultText}` : ""}`;
  }
  if (mode === "out" || mode === "mut") type = `${renderedType}&`;
  else if (mode === "move") type = `${renderedType}&&`;
  else if (automaticParameterUsesValue(parameter.type, asynchronous)) type = renderedType;
  else type = `const ${renderedType}&`;
  if (parameter.variadic) {
    if (type.endsWith("&")) type += "...";
    else type += "...";
  }
  return `${type} ${parameter.name}${defaultText ? ` = ${defaultText}` : ""}`;
}
