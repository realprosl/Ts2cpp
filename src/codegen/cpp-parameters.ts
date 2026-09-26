import type { Parameter, ParameterPassing, TypeName } from "../ast/nodes.ts";

export function automaticParameterUsesValue(type: TypeName, asynchronous: boolean): boolean {
  return asynchronous || type === "number" || type === "boolean";
}

export function cppInputType(type: TypeName, renderedType: string): string {
  return automaticParameterUsesValue(type, false) ? renderedType : `const ${renderedType}&`;
}

export function cppParameterDeclaration(parameter: Parameter, renderedType: string, asynchronous: boolean, defaultText?: string): string {
  const mode: ParameterPassing = parameter.passing ?? (parameter.out ? "out" : "automatic");
  let type: string;
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
