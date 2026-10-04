// Unit tests para V0.2 + V22 — consumo de ResolvedType en codegen.
//
// V0.2 introduce:
// - `cppType(TypeName | ResolvedType)`: dispatch polimórfico que evita
//   parsear strings cuando el checker ya pobló `resolvedType`.
// - `resolveParameterModifier(ResolvedType)`: detecta los 4 modificadores
//   de paso directamente desde la estructura, sin regex.
//
// V22 (Memory Model v2) reemplaza `Mut<T>` y `MutRef<T>` por los
// modificadores `ptr<T>`, `constPtr<T>`, `ref<T>`, `constRef<T>`. Cada uno
// se traduce a T*, const T*, T&, const T& respectivamente.
// `Unq<T>` y `Rc<T>` ya no existen en el dialecto.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cppType, cppMemoryType } from "../../src/codegen/cpp-types.ts";
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

test("cppType: dispatch sobre ResolvedType generic Promise<number>", () => {
  const r: ResolvedType = { kind: "generic", base: "Promise", args: [{ kind: "primitive", name: "number" }] };
  assert.equal(cppType(r), "ets::Task<double>");
});

test("cppType: dispatch sobre ResolvedType array", () => {
  const r: ResolvedType = { kind: "array", element: { kind: "primitive", name: "number" } };
  assert.equal(cppType(r), "std::vector<double>");
});

test("cppType: dispatch sobre ResolvedType union", () => {
  const r: ResolvedType = { kind: "union", members: [{ kind: "primitive", name: "number" }, { kind: "primitive", name: "string" }] };
  assert.equal(cppType(r), "std::variant<double, std::string>");
});

test("V22: resolveParameterModifier detecta ptr<T> como ptr", () => {
  const r: ResolvedType = { kind: "generic", base: "ptr", args: [{ kind: "class", name: "Counter" }] };
  const result = resolveParameterModifier(r);
  assert.ok(result);
  assert.equal(result?.kind, "ptr");
});

test("V22: resolveParameterModifier detecta constPtr<T> como constPtr", () => {
  const r: ResolvedType = { kind: "generic", base: "constPtr", args: [{ kind: "class", name: "Counter" }] };
  const result = resolveParameterModifier(r);
  assert.ok(result);
  assert.equal(result?.kind, "constPtr");
});

test("V22: resolveParameterModifier detecta ref<T> como ref", () => {
  const r: ResolvedType = { kind: "generic", base: "ref", args: [{ kind: "class", name: "Counter" }] };
  const result = resolveParameterModifier(r);
  assert.ok(result);
  assert.equal(result?.kind, "ref");
});

test("V22: resolveParameterModifier detecta constRef<T> como constRef", () => {
  const r: ResolvedType = { kind: "generic", base: "constRef", args: [{ kind: "class", name: "Counter" }] };
  const result = resolveParameterModifier(r);
  assert.ok(result);
  assert.equal(result?.kind, "constRef");
});

test("V22: resolveParameterModifier ignora otros genéricos (Promise, Result)", () => {
  for (const base of ["Promise", "Result", "Map", "Set", "Optional"]) {
    const r: ResolvedType = { kind: "generic", base, args: [{ kind: "class", name: "Counter" }] };
    assert.equal(resolveParameterModifier(r), null, `expected null for ${base}`);
  }
});

test("V22: resolveParameterModifier ignora tipos no-genéricos", () => {
  const r: ResolvedType = { kind: "class", name: "Counter" };
  assert.equal(resolveParameterModifier(r), null);
});

test("V22: resolveParameterModifier ignora nombres legacy (Mut, MutRef, Unq, Rc)", () => {
  for (const base of ["Mut", "MutRef", "Unq", "Rc"]) {
    const r: ResolvedType = { kind: "generic", base, args: [{ kind: "class", name: "Counter" }] };
    assert.equal(resolveParameterModifier(r), null, `legacy ${base} should be ignored`);
  }
});

test("V22: resolveParameterModifierFromString detecta ptr<Counter>", () => {
  const result = resolveParameterModifierFromString("ptr<Counter>");
  assert.ok(result);
  assert.equal(result?.kind, "ptr");
  if (result?.inner.kind === "class") assert.equal(result.inner.name, "Counter");
});

test("V22: resolveParameterModifierFromString detecta constRef<Counter>", () => {
  const result = resolveParameterModifierFromString("constRef<Counter>");
  assert.ok(result);
  assert.equal(result?.kind, "constRef");
});

test("V22: resolveParameterModifierFromString ignora Mut<Counter> legacy", () => {
  assert.equal(resolveParameterModifierFromString("Mut<Counter>"), null);
});

test("V22: cppMemoryType produce std::unique_ptr<T> para ptr<T>", () => {
  assert.equal(cppMemoryType("ptr", "Counter"), "std::unique_ptr<Counter>");
});

test("V22: cppMemoryType produce std::unique_ptr<const T> para constPtr<T>", () => {
  assert.equal(cppMemoryType("constPtr", "Counter"), "std::unique_ptr<const Counter>");
});

test("V22: cppMemoryType produce T& para ref<T>", () => {
  assert.equal(cppMemoryType("ref", "Counter"), "Counter&");
});

test("V22: cppMemoryType produce const T& para constRef<T>", () => {
  assert.equal(cppMemoryType("constRef", "Counter"), "const Counter&");
});

test("V22 paridad: cppType con string y ResolvedType producen mismo resultado", () => {
  // Arrays: number[] (tipo sintaxis con corchetes)
  const arrayFromString = cppType("number[]");
  const arrayFromResolved: ResolvedType = { kind: "array", element: { kind: "primitive", name: "number" } };
  assert.equal(cppType(arrayFromResolved), arrayFromString);

  // Primitives
  for (const name of ["number", "string", "boolean"] as const) {
    assert.equal(cppType(name), cppType({ kind: "primitive", name }));
  }
});
