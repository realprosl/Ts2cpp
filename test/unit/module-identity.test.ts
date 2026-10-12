// test/unit/module-identity.test.ts — V30.6.1: regresion H-01/H-02
// (informe de revision tecnica 2026-10-12).
//
// Verifica que `computeModuleId` produce identidades unicas para
// modulos con el mismo basename, y que un modulo con caracteres
// C++-inseguros en el nombre no colisiona con uno normalizado.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("module-identity (P-02): rutas equivalentes producen el mismo id", () => {
  // V30.6.2 P-02: rutas que apuntan al mismo archivo deben tener
  // el mismo id. Antes del fix, "./src/a.ts", "src/a.ts" y la
  // ruta absoluta daban 3 ids distintos.
  // Usamos un archivo que existe (realpath funciona):
  const dir = mkdtempSync(join(tmpdir(), "mod-ident-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const x = 1;");
  const a = computeModuleId("./src/a.ts", dir);
  const b = computeModuleId("src/a.ts", dir);
  const c = computeModuleId(join(dir, "src/a.ts"), dir);
  rmSync(dir, { recursive: true });
  assert.equal(a.id, b.id, "./src/a.ts y src/a.ts deben coincidir");
  assert.equal(b.id, c.id, "src/a.ts y la absoluta deben coincidir");
  assert.equal(a.relativePath, "src/a.ts");
});

test("module-identity (P-02): symlinks se resuelven a la misma identidad", () => {
  // Dos symlinks al mismo archivo deben dar el mismo id.
  const dir = mkdtempSync(join(tmpdir(), "mod-ident-sym-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/orig.ts"), "export const x = 1;");
  try {
    symlinkSync(join(dir, "src/orig.ts"), join(dir, "src/link.ts"));
  } catch {
    // Algunos sistemas no permiten symlinks; skip.
    rmSync(dir, { recursive: true });
    return;
  }
  const a = computeModuleId(join(dir, "src/orig.ts"), dir);
  const b = computeModuleId(join(dir, "src/link.ts"), dir);
  rmSync(dir, { recursive: true });
  assert.equal(a.id, b.id, "orig y link deben tener el mismo id");
});
