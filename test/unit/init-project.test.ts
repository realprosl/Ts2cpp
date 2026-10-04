// Tests del generador de proyectos `estatic init`.
//
// Verifica:
//  1. `initializeProject` crea los 6 archivos esperados
//     (src/main.ts, estatic.config.ts, tsconfig.json, types/estatic.d.ts,
//      .gitignore, README.md).
//  2. `tsconfig.json` tiene `lib: ["es2022"]` y `types: []` (sin DOM ni
//     @types/node implícitos) y `moduleResolution: "bundler"`.
//  3. `types/estatic.d.ts` declara los built-ins del dialecto que el
//     type-checker reconoce (Unq, Rc, Optional, Result, Promise, Map,
//     Set, Mut, MutRef, readonly, numéricos i8..f64, console, fs.*Sync,
//     path.*, process.*, JSON, print, numberToString).
//  4. Si algún archivo del template ya existe, `initializeProject` aborta
//     (decisión confirmada: no se sobrescribe nada).
//  5. Si `tsc` está disponible, el proyecto generado pasa `tsc --noEmit`
//     (el `.d.ts`, el config y el main tipan correctamente).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject } from "../../src/project/init-project.ts";

const compilerRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

const expectedFiles = [
  "src/main.ts",
  "estatic.config.ts",
  "tsconfig.json",
  "types/estatic.d.ts",
  ".gitignore",
  "README.md",
] as const;

test("init-project: crea los 6 archivos del template", async () => {
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  const result = await initializeProject(directory);
  assert.equal(result.directory, directory);
  const basenames = result.files.map(path => path.slice(directory.length + 1)).sort();
  assert.deepEqual(basenames, [...expectedFiles].sort());
  for (const relative of expectedFiles) {
    assert.ok(existsSync(join(directory, relative)), `falta ${relative}`);
  }
});

test("init-project: tsconfig.json desactiva DOM y @types/node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const tsconfig = JSON.parse(readFileSync(join(directory, "tsconfig.json"), "utf8"));
  // Sin `lib: []` (rompería Array/Boolean globales); con `es2022` solo.
  assert.deepEqual(tsconfig.compilerOptions.lib, ["es2022"]);
  // `types: []` es la pieza clave: excluye @types/node implícitos.
  assert.deepEqual(tsconfig.compilerOptions.types, []);
  // moduleResolution: bundler (no asume resolución Node).
  assert.equal(tsconfig.compilerOptions.moduleResolution, "bundler");
  // strict + noEmit: es solo para el editor, el código real lo compila Estatic.
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noEmit, true);
  // include cubre src + types + el config.
  assert.ok(tsconfig.include.includes("types/**/*"));
  assert.ok(tsconfig.include.includes("src/**/*"));
  assert.ok(tsconfig.include.includes("estatic.config.ts"));
});

test("init-project: estatic.d.ts declara los built-ins del dialecto", async () => {
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const dts = readFileSync(join(directory, "types/estatic.d.ts"), "utf8");
  // Envoltorios genéricos del runtime.
  for (const symbol of ["Unq", "Rc", "Optional", "Result", "Promise", "Map", "Set"]) {
    assert.match(dts, new RegExp(`\\bclass\\s+${symbol}\\b`), `falta class ${symbol}`);
  }
  // Modificadores / decoradores de tipo.
  for (const symbol of ["Mut", "MutRef", "readonly"]) {
    assert.match(dts, new RegExp(`\\btype\\s+${symbol}\\b`), `falta type ${symbol}`);
  }
  // Numéricos concretos (V3).
  for (const num of ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64"]) {
    assert.match(dts, new RegExp(`\\btype\\s+${num}\\b`), `falta numérico ${num}`);
  }
  // Globales de runtime (RUNTIME_GLOBAL_NAMES en type-checker).
  assert.match(dts, /\bnamespace\s+console\b/);
  assert.match(dts, /\bnamespace\s+fs\b/);
  assert.match(dts, /\bnamespace\s+path\b/);
  assert.match(dts, /\bnamespace\s+process\b/);
  assert.match(dts, /\bnamespace\s+JSON\b/);
  // fs.*Sync (versiones síncronas que devuelve Result<...> o boolean).
  assert.match(dts, /\breadFileSync\b/);
  assert.match(dts, /\bwriteFileSync\b/);
  assert.match(dts, /\bexistsSync\b/);
  // Helpers del runtime que usan los ejemplos.
  assert.match(dts, /\bfunction\s+print\b/);
  assert.match(dts, /\bfunction\s+numberToString\b/);
  // declare global para que estén disponibles sin imports.
  assert.match(dts, /declare\s+global\s*\{/);
});

test("init-project: aborta si algún archivo del template ya existe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  // Pre-creamos tsconfig.json para forzar el conflicto.
  writeFileSync(join(directory, "tsconfig.json"), "{}\n");
  await assert.rejects(
    () => initializeProject(directory),
    /No se inicializó el proyecto para no sobrescribir/,
  );
  // El archivo conflictivo NO se modifica.
  assert.equal(readFileSync(join(directory, "tsconfig.json"), "utf8"), "{}\n");
});

test("init-project: el proyecto generado pasa tsc --noEmit si tsc está disponible", async () => {
  // Buscamos `tsc` en PATH; si no está, el test se salta sin fallar.
  // La intención es CI con typescript instalado; en máquinas sin él,
  // este test no rompe.
  const which = spawnSync("which", ["tsc"], { encoding: "utf8" });
  if (which.status !== 0 || !which.stdout.trim()) return;
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const result = spawnSync("tsc", ["-p", "tsconfig.json", "--noEmit"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `tsc -p tsconfig.json --noEmit falló en proyecto generado:\n` +
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
});
