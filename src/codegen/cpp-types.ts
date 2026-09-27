import type { TypeName } from "../ast/nodes.ts";
import { arrayElement, functionParameters, functionResult, genericArguments, genericBase, isArrayType, isFunctionType, isGenericType, isTupleType, isUnionType, tupleElements, unionMembers } from "../types/type-system.ts";
import { cppInputType } from "./cpp-parameters.ts";

// TODO Phase 1.A: alias expansion happens in the type-checker (validateType, substituteType)
// before reaching cppType. If a raw alias name ever reaches here, it falls through to the
// passthrough branch and will appear as `Name` in C++ output. This should not happen in practice.

const PRIMITIVE_CPP: Record<string, string> = { number: "double", string: "std::string", boolean: "bool", void: "void" };

export function cppType(type: TypeName): string {
  if (PRIMITIVE_CPP[type]) return PRIMITIVE_CPP[type];
  if (isUnionType(type)) return `std::variant<${unionMembers(type).map(cppType).join(", ")}>`;
  if (isArrayType(type)) return `std::vector<${cppType(arrayElement(type))}>`;
  if (isTupleType(type)) return `std::tuple<${tupleElements(type).map(cppType).join(", ")}>`;
  if (isFunctionType(type)) return `std::function<${cppType(functionResult(type))}(${functionParameters(type).map(parameter => cppInputType(parameter, cppType(parameter))).join(", ")})>`;
  if (isGenericType(type)) {
    const sourceBase = genericBase(type);
    const base = sourceBase === "Promise" ? "ets::Task"
      : sourceBase === "Result" ? "ets::Result"
      : sourceBase === "Map" ? "ets::Map"
      : sourceBase === "Set" ? "ets::Set"
      : sourceBase === "Optional" ? "ets::Optional"
      : sourceBase;
    return `${base}<${genericArguments(type).map(cppType).join(", ")}>`;
  }
  if (["TcpListener", "TcpConnection", "TlsContext", "TlsConnection", "CancellationSource", "CancellationToken"].includes(type)) return `ets::${type}`;
  if (type === "JsonValue") return "ets_json::Value";
  return type;
}
