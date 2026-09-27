// Unit tests para V0.2 — consumo de ResolvedType en codegen.
//
// V0.2 introduce:
// - `cppType(TypeName | ResolvedType)`: dispatch polimórfico que evita
//   parsear strings cuando el checker ya pobló `resolvedType`.
// - `resolveParameterModifier(ResolvedType)`: detecta `Mut<T>` y `MutRef<T>`
//   directamente desde la estructura, sin regex.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cppType } from "../../src/codegen/cpp-types.ts";
import { resolveParameterModifier, resolveParameterModifierFromString } from "../../src/codegen/cpp-parameters.ts";
import type { ResolvedType } from "../../src/types/type-system.ts";

test("cppType: dispatch sobre TypeName (string)", () => {
  assert.equal(cppType("number"), "double");
  assert.equal(cppType("string"), "std::string");
  assert.equal(cppType("boolean"), "bool");
  assert.equal(cppType("Counter"), "Counter");
});

test("cppType: dispatch sobre ResolvedType primitive", () => {
  const r: ResolvedType = { kind: "primitive", name: "number" };
  assert.equal(cppType(r), "double");
});

test("cppType: dispatch sobre ResolvedType class", () => {
  const r: ResolvedType = { kind: "class", name: "Counter" };
  assert.equal(cppType(r), "Counter");
});

test("cppType: dispatch sobre ResolvedType generic Unq<Counter>", () => {
  const r: ResolvedType = { kind: "generic", base: "Unq", args: [{ kind: "class", name: "Counter" }] };
  assert.equal(cppType(r), "ets::Unq<Counter>");
});

test("cppType: dispatch sobre ResolvedType array", () => {
  const r: ResolvedType = { kind: "array", element: { kind: "primitive", name: "number" } };
  assert.equal(cppType(r), "std::vector<double>");
});

test("cppType: dispatch sobre ResolvedType union", () => {
  const r: ResolvedType = { kind: "union", members: [{ kind: "primitive", name: "number" }, { kind: "primitive", name: "string" }] };
  assert.equal(cppType(r), "std::variant<double, std::string>");
});

test("resolveParameterModifier: detecta Mut<T> como pointer", () => {
  const r: ResolvedType = { kind: "generic", base: "Mut", args: [{ kind: "class", name: "Counter" }] };
  const result = resolveParameterModifier(r);
  assert.ok(result);
  assert.equal(result?.kind, "pointer");
  if (result?.kind === "pointer") {
    assert.equal(result.inner.kind, "class");
    if (result.inner.kind === "class") assert.equal(result.inner.name, "Counter");
  }
});

test("resolveParameterModifier: detecta MutRef<T> como reference", () => {
  const r: ResolvedType = { kind: "generic", base: "MutRef", args: [{ kind: "class", name: "Counter" }] };
  const result = resolveParameterModifier(r);
  assert.ok(result);
  assert.equal(result?.kind, "reference");
});

test("resolveParameterModifier: ignora otros genéricos", () => {
  const r: ResolvedType = { kind: "generic", base: "Unq", args: [{ kind: "class", name: "Counter" }] };
  assert.equal(resolveParameterModifier(r), null);
});

test("resolveParameterModifier: ignora tipos no-genéricos", () => {
  const r: ResolvedType = { kind: "class", name: "Counter" };
  assert.equal(resolveParameterModifier(r), null);
});

test("resolveParameterModifierFromString: detecta Mut<Counter>", () => {
  const result = resolveParameterModifierFromString("Mut<Counter>");
  assert.ok(result);
  assert.equal(result?.kind, "pointer");
  if (result?.kind === "pointer") {
    if (result.inner.kind === "class") assert.equal(result.inner.name, "Counter");
  }
});

test("resolveParameterModifierFromString: detecta MutRef<Counter>", () => {
  const result = resolveParameterModifierFromString("MutRef<Counter>");
  assert.ok(result);
  assert.equal(result?.kind, "reference");
});

test("resolveParameterModifierFromString: ignora Unq<Counter>", () => {
  assert.equal(resolveParameterModifierFromString("Unq<Counter>"), null);
});

test("V0.2 paridad: cppType produce misma salida con string y ResolvedType", () => {
  // Generics: Unq<Counter>
  const fromString = cppType("Unq<Counter>");
  const fromResolved: ResolvedType = { kind: "generic", base: "Unq", args: [{ kind: "class", name: "Counter" }] };
  assert.equal(cppType(fromResolved), fromString);

  // Arrays: number[] (tipo sintaxis con corchetes)
  const arrayFromString = cppType("number[]");
  const arrayFromResolved: ResolvedType = { kind: "array", element: { kind: "primitive", name: "number" } };
  assert.equal(cppType(arrayFromResolved), arrayFromString);

  // Primitives
  for (const name of ["number", "string", "boolean"] as const) {
    assert.equal(cppType(name), cppType({ kind: "primitive", name }));
  }
});
