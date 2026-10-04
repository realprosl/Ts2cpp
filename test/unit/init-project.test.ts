// Tests del generador de proyectos `estatic init`.
//
// Verifica:
//  1. `initializeProject` crea los 6 archivos esperados
//     (src/main.ts, estatic.config.ts, tsconfig.json, types/estatic.d.ts,
//      .gitignore, README.md).
//  2. `tsconfig.json` tiene `lib: ["es2022"]` y `types: []` (sin DOM ni
//     @types/node implícitos) y `moduleResolution: "bundler"`.
//  3. `types/estatic.d.ts` declara los built-ins del dialecto que el
//     type-checker reconoce. V22 (Memory Model v2) reemplazó `Mut<T>`,
//     `MutRef<T>`, `Unq<T>` y `Rc<T>` por 4 modificadores explícitos:
//     `ptr<T>`, `constPtr<T>`, `ref<T>`, `constRef<T>`. También incluye
//     `move<T>(x: ptr<T>)` como helper global. El resto de envoltorios
//     (Optional, Result, Promise, Map, Set), numéricos y globales del
//     runtime se mantienen.
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
  // Envoltorios genéricos del runtime. V22 quitó `Unq` y `Rc` del .d.ts
  // (los reemplaza `ptr<T>` y el futuro `weak<T>`); siguen reconociéndose
  // por el codegen para diagnóstico de código legacy, pero el editor ya
  // no debe verlos como tipos del dialecto.
  for (const symbol of ["Optional", "Result", "Promise", "Map", "Set"]) {
    assert.match(dts, new RegExp(`\\bclass\\s+${symbol}\\b`), `falta class ${symbol}`);
  }
  // Modificadores de memoria V22 (4) + readonly (existente).
  for (const symbol of ["ptr", "constPtr", "ref", "constRef", "readonly"]) {
    assert.match(dts, new RegExp(`\\btype\\s+${symbol}\\b`), `falta type ${symbol}`);
  }
  // Símbolos V22 eliminados: NO deben aparecer en el .d.ts.
  for (const removed of ["Unq", "Rc", "Mut", "MutRef"]) {
    assert.doesNotMatch(dts, new RegExp(`\\bclass\\s+${removed}\\b`), `${removed} NO debe declararse como class (eliminado en V22)`);
    assert.doesNotMatch(dts, new RegExp(`\\btype\\s+${removed}\\b`), `${removed} NO debe declararse como type (eliminado/deprecado en V22)`);
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

test("init-project: estatic.d.ts declara métodos de instancia de Result<T, E>", async () => {
  // El type-checker reconoce .isOk(), .value(), .error() sobre
  // Result<T, E> (ver type-checker.ts:2100-2108). Sin estas
  // declaraciones, el editor marca "Property 'isOk' does not exist
  // on type 'Result<string>'" cada vez que el usuario trata un
  // resultado de fs.readFileSync.
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const dts = readFileSync(join(directory, "types/estatic.d.ts"), "utf8");
  assert.match(dts, /class\s+Result<[^>]+>\s*\{[^}]*isOk\(\):\s*boolean/s,
    "Result.isOk() no está declarado");
  assert.match(dts, /class\s+Result<[^>]+>\s*\{[^}]*value\(\):\s*T/s,
    "Result.value() no está declarado");
  assert.match(dts, /class\s+Result<[^>]+>\s*\{[^}]*error\(\):\s*E/s,
    "Result.error() no está declarado");
});

test("init-project: estatic.d.ts declara métodos de instancia de Optional<T>", async () => {
  // OPTIONAL_HELPERS en type-checker.ts:118-126 + ramas en 1896-1897.
  // El dialecto expone .isPresent(), .isEmpty(), .value(), .valueOr().
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const dts = readFileSync(join(directory, "types/estatic.d.ts"), "utf8");
  assert.match(dts, /class\s+Optional<[^>]+>\s*\{[^}]*isPresent\(\):\s*boolean/s,
    "Optional.isPresent() no está declarado");
  assert.match(dts, /class\s+Optional<[^>]+>\s*\{[^}]*isEmpty\(\):\s*boolean/s,
    "Optional.isEmpty() no está declarado");
  assert.match(dts, /class\s+Optional<[^>]+>\s*\{[^}]*value\(\):\s*T/s,
    "Optional.value() no está declarado");
  assert.match(dts, /class\s+Optional<[^>]+>\s*\{[^}]*valueOr\([^)]+\):\s*T/s,
    "Optional.valueOr() no está declarado");
});

test("init-project: estatic.d.ts declara métodos de Map<K, V> y Set<T>", async () => {
  // MAP_METHODS y SET_METHODS en type-checker.ts:199-214.
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const dts = readFileSync(join(directory, "types/estatic.d.ts"), "utf8");
  // Map.
  for (const method of ["get", "set", "has", "delete"]) {
    assert.match(dts, new RegExp(`\\b${method}\\(`), `Map.${method}() no está declarado`);
  }
  assert.match(dts, /readonly\s+size:\s*number/);
  // Set.
  for (const method of ["add", "has", "delete"]) {
    assert.match(dts, new RegExp(`\\b${method}\\(`), `Set.${method}() no está declarado`);
  }
});

test("init-project: estatic.d.ts declara interface con métodos de Array<T>", async () => {
  // ARRAY_METHODS en type-checker.ts:227-254 (12 métodos + length).
  // El dialecto usa la forma canónica T[]; la interface ArrayLike<T>
  // cubre el sinónimo Array<T> y permite al editor hacer hover y
  // completions sobre métodos de instancia de arrays.
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const dts = readFileSync(join(directory, "types/estatic.d.ts"), "utf8");
  assert.match(dts, /\binterface\s+ArrayLike\b/);
  for (const method of [
    "filter", "map", "reduce", "forEach", "push", "find",
    "some", "every", "slice", "sort", "flatMap", "includes",
  ]) {
    // Buscamos el nombre del método como identificador seguido de `<` o `(`.
    // `<` cubre `filter<U extends T>(...)`; `(` cubre `forEach(...)`.
    assert.match(dts, new RegExp(`\\b${method}(?=\\s*[<(])`), `Array.${method}() no está declarado`);
  }
  assert.match(dts, /readonly\s+length:\s*number/);
});

test("init-project: estatic.d.ts declara helpers async (all, race, spawn, sleep)", async () => {
  // sleep y spawn están registradas como funciones globales en
  // type-checker.ts:446-447. all y race son casos especiales del
  // type-checker (ASYNC_HELPERS en type-checker.ts:161-164) que
  // esperan/extraen de un array de Promise<T>.
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const dts = readFileSync(join(directory, "types/estatic.d.ts"), "utf8");
  // sleep y spawn.
  assert.match(dts, /function\s+sleep\s*\(\s*ms\s*:\s*number\s*\)\s*:\s*Promise<void>/,
    "sleep(ms: number) -> Promise<void> no está declarado");
  assert.match(dts, /function\s+spawn\s*\(\s*task\s*:\s*Promise<void>\s*\)\s*:\s*void/,
    "spawn(task: Promise<void>) -> void no está declarado");
  // all<T>(tasks: Promise<T>[]) -> T[].
  assert.match(dts, /function\s+all\s*<T>/,
    "all<T> no está declarado");
  assert.match(dts, /all\s*<T>\s*\(\s*tasks\s*:\s*Promise<T>\[\]\s*\)\s*:\s*T\[\]/,
    "all<T>(tasks: Promise<T>[]) -> T[] no está declarado con la firma correcta");
  // race<T>(tasks: Promise<T>[]) -> T.
  assert.match(dts, /function\s+race\s*<T>/,
    "race<T> no está declarado");
  assert.match(dts, /race\s*<T>\s*\(\s*tasks\s*:\s*Promise<T>\[\]\s*\)\s*:\s*T\b/,
    "race<T>(tasks: Promise<T>[]) -> T no está declarado con la firma correcta");
});

test("init-project (V22): estatic.d.ts declara move<T>() como helper global", async () => {
  // V22 (Memory Model v2) introdujo `move<T>(x: ptr<T>)` como helper
  // global que transfiere ownership. Sin esta declaración el editor
  // marca "Cannot find name 'move'" en cualquier programa que use
  // `let q: std<Counter> = move(p);`. Ver type-checker.ts:rama de
  // `move` en expression() (HELPER_METADATA también lo lista).
  const directory = mkdtempSync(join(tmpdir(), "estatic-init-"));
  await initializeProject(directory);
  const dts = readFileSync(join(directory, "types/estatic.d.ts"), "utf8");
  // move<T>(x: ptr<T>) -> ptr<T>.
  assert.match(dts, /function\s+move\s*<T>/,
    "move<T> no está declarado");
  assert.match(dts, /move\s*<T>\s*\(\s*x\s*:\s*ptr<T>\s*\)\s*:\s*ptr<T>/,
    "move<T>(x: ptr<T>) -> ptr<T> no está declarado con la firma correcta");
  // constPtr<T> también es válido para move(x).
  assert.match(dts, /move\s*<T>\s*\(\s*x\s*:\s*constPtr<T>\s*\)\s*:\s*constPtr<T>/,
    "move<T>(x: constPtr<T>) -> constPtr<T> no está declarado");
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
