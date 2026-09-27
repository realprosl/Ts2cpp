import type { Parameter, ParameterPassing, TypeName } from "../ast/nodes.ts";
import { isGenericType, genericBase, genericArguments } from "../types/type-system.ts";
import { cppType } from "./cpp-types.ts";

export function automaticParameterUsesValue(type: TypeName, asynchronous: boolean): boolean {
  return asynchronous || type === "number" || type === "boolean";
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
  if (isGenericType(parameter.type)) {
    const base = genericBase(parameter.type);
    if (base === "Mut") {
      // T* (puntero mutable, no-owning). El user debe pasar `&x`.
      const inner = genericArguments(parameter.type)[0];
      const innerType = inner ? cppType(inner) : renderedType;
      type = `${innerType}*`;
      if (parameter.variadic) type += "...";
      return `${type} ${parameter.name}${defaultText ? ` = ${defaultText}` : ""}`;
    }
    if (base === "MutRef") {
      // T& (referencia mutable). El user debe pasar `&x`.
      const inner = genericArguments(parameter.type)[0];
      const innerType = inner ? cppType(inner) : renderedType;
      type = `${innerType}&`;
      return `${type} ${parameter.name}${defaultText ? ` = ${defaultText}` : ""}`;
    }
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
