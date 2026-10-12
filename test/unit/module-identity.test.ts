// test/unit/module-identity.test.ts — V30.6.1: regresion H-01/H-02
// (informe de revision tecnica 2026-10-12).
//
// Verifica que `computeModuleId` produce identidades unicas para
// modulos con el mismo basename, y que un modulo con caracteres
// C++-inseguros en el nombre no colisiona con uno normalizado.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeModuleId, assertUniqueIdentities } from "../../src/modules/module-identity.ts";

const BASE = "/home/user/proj";

test("module-identity: dos index.ts en carpetas distintas NO colisionan (H-01)", () => {
  const a = computeModuleId(`${BASE}/src/users/index.ts`, BASE);
  const b = computeModuleId(`${BASE}/src/admin/index.ts`, BASE);
  assert.notEqual(a.id, b.id, `Esperaba ids distintos, obtuve ${a.id} para ambos`);
  assert.notEqual(a.moduleBase, b.moduleBase);
  assert.notEqual(a.initName, b.initName);
  assert.equal(a.relativePath, "src/users/index.ts");
  assert.equal(b.relativePath, "src/admin/index.ts");
});

test("module-identity: a-b.ts y a_b.ts NO colisionan tras sanitizar (H-02)", () => {
  // Antes del fix, ambos producian `ets_init_a_b` y colisionaban.
  const dash = computeModuleId(`${BASE}/src/a-b.ts`, BASE);
  const under = computeModuleId(`${BASE}/src/a_b.ts`, BASE);
  assert.notEqual(dash.id, under.id, `Esperaba ids distintos, obtuve ${dash.id} para ambos`);
  assert.notEqual(dash.initName, under.initName);
});

test("module-identity: rutas absolutas fuera de baseDirectory usan basename + hash", () => {
  const a = computeModuleId("/opt/external/lib.ts", BASE);
  assert.match(a.id, /^lib_[0-9a-f]{8}$/);
});

test("module-identity: caracteres no-C++-seguros se reemplazan por _", () => {
  // Espacios, puntos, simbolos -> _
  const id = computeModuleId(`${BASE}/src/foo bar.baz.ts`, BASE);
  assert.match(id.id, /^[A-Za-z0-9_]+_[0-9a-f]{8}$/);
  assert.ok(!id.id.includes(" "));
  assert.ok(!id.id.includes("."));
});

test("module-identity: assertUniqueIdentities lanza si hay colision", () => {
  // Forzamos una colision con el mismo file (no puede pasar en la realidad
  // porque el hash es del path, pero verificamos la funcion de validacion).
  const fake = { file: "x", relativePath: "x", id: "same", cacheKey: "same", moduleBase: "same", initName: "ets_init_same", pathHash: "12345678" };
  assert.throws(() => assertUniqueIdentities([fake, fake]), /Colision de identidad/);
});

test("module-identity: assertUniqueIdentities acepta un set de ids unicas", () => {
  const a = computeModuleId(`${BASE}/src/a.ts`, BASE);
  const b = computeModuleId(`${BASE}/src/b.ts`, BASE);
  assert.doesNotThrow(() => assertUniqueIdentities([a, b]));
});

test("module-identity: el initName tiene la forma ets_init_*", () => {
  const id = computeModuleId(`${BASE}/src/main.ts`, BASE);
  assert.match(id.initName, /^ets_init_[A-Za-z0-9_]+$/);
});

test("module-identity: el pathHash es SHA-256 truncado a 8 hex", () => {
  const id = computeModuleId(`${BASE}/src/main.ts`, BASE);
  assert.match(id.pathHash, /^[0-9a-f]{8}$/);
});
