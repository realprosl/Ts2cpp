// Harness de tests del Bloque F.
//
// Ejecuta los ejemplos `examples/*.ets` (los 34, sin recursión) contra los
// golden files en `test/golden/<name>.expected.txt`. Los ejemplos listados en
// `test/skip-network.json` solo se compilan y enlazan; el resto se ejecutan y
// se compara stdout+exit-code con su golden.
//
// Sin dependencias npm: usa solo `node:test`, `node:fs`, `node:child_process`,
// `node:path`. Se invoca con `npm test` (que añade `--experimental-strip-types`).
//
// Categorías:
//   - Deterministas (27):  transpile + compile + run + diff contra golden.
//   - Skip-network (7):    transpile + compile + link (sin ejecutar).
//
// Layout scratch (todo en `test/scratch/`, NUNCA en /tmp):
//   <name>.cpp    código C++ generado
//   <name>        binario (cuando aplica)
//
// Salida node:test:
//   - PASS       stdout + exit code coinciden con el golden
//   - PASS (compile-only)   skip-network
//   - INFO       golden no existía; se creó baseline
//   - FAIL       divergencia en stdout, exit code no cero, o error de compile/link
//
// Criterios de aceptación cubiertos:
//   1. npm test exit 0 cuando todo pasa
//   2. Los 34 ejemplos aparecen (27 deterministas + 7 skip-network)
//   3. Borrar un golden => se regenera y se reporta INFO: baseline created
//   4. Modificar un ejemplo => diff claro y FAIL
//   5. test/scratch/ está en .gitignore; sólo se trackean
//      runner.ts, skip-network.json y test/golden/*.expected.txt

import { test } from "node:test";
import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

// -------------------------------------------------------------------------
// Constantes de paths (todas relativas a la raíz del repo)
// -------------------------------------------------------------------------
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = join(REPO_ROOT, "examples");
const GOLDEN_DIR = join(REPO_ROOT, "test", "golden");
const SKIP_FILE = join(REPO_ROOT, "test", "skip-network.json");
const SCRATCH_DIR = join(REPO_ROOT, "test", "scratch");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");

// Flags equivalentes al smoke test del Bloque A, pero apuntando a test/scratch/
// y con I=REPO_ROOT para resolver `runtime/ets_*.hpp`.
const GXX_FLAGS = [
  "-std=c++20", "-O3", "-march=native", "-flto", "-pthread",
  "-fno-exceptions", "-ffunction-sections", "-fdata-sections",
];
const LINK_FLAGS = ["-Wl,--gc-sections", "-Wl,--as-needed", "-s"];

// -------------------------------------------------------------------------
// Utilidades
// -------------------------------------------------------------------------

/** Lee `skip-network.json` y devuelve el conjunto de nombres a saltar.
 *  Si la variable de entorno `SKIP_NETWORK=1` está activa, devuelve un
 *  conjunto con TODOS los ejemplos para forzar compile-only (útil en CI). */
async function loadSkipList(): Promise<Set<string>> {
  const raw = await readFile(SKIP_FILE, "utf8");
  const parsed = JSON.parse(raw) as { skip: string[] };
  if (process.env.SKIP_NETWORK === "1") {
    const allExamples = await discoverExamples();
    return new Set(allExamples);
  }
  return new Set(parsed.skip);
}

/** Descubre los ejemplos de primer nivel en `examples/` (no recursivo). */
async function discoverExamples(): Promise<string[]> {
  const entries = await readdir(EXAMPLES_DIR, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".ets"))
    .map(entry => entry.name.replace(/\.ets$/, ""))
    .sort();
}

/**
 * Ejecuta un comando externo y devuelve { code, stdout, stderr }.
 * Si el proceso falla al arrancar (no se encuentra binario) lo reporta
 * con `code = -1`.
 */
function runProcess(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, { cwd: SCRATCH_DIR });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", () => { resolvePromise({ code: -1, stdout, stderr }); });
    child.once("exit", code => { resolvePromise({ code: code ?? -1, stdout, stderr }); });
  });
}

/** Devuelve un diff unificado mínimo (estilo diff -u) entre dos strings. */
function unifiedDiff(expected: string, actual: string, label: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  const out: string[] = [];
  out.push(`--- ${label}.expected.txt`);
  out.push(`+++ ${label}.actual.txt`);
  out.push(`@@ expected ${expectedLines.length} lines, actual ${actualLines.length} lines @@`);
  for (let i = 0; i < max; i++) {
    const e = expectedLines[i];
    const a = actualLines[i];
    if (e === undefined) out.push(`+${a ?? ""}`);
    else if (a === undefined) out.push(`-${e}`);
    else if (e !== a) {
      out.push(`-${e}`);
      out.push(`+${a}`);
    }
  }
  return out.join("\n");
}

// -------------------------------------------------------------------------
// Pipeline por ejemplo
// -------------------------------------------------------------------------

interface CompileResult {
  ok: boolean;
  cppPath: string;
  binPath: string;
  stdout: string;
  stderr: string;
}

/**
 * Transpila y compila un ejemplo. NO ejecuta.
 * Devuelve los paths generados y los buffers de stdout/stderr de cada paso.
 *
 * Importante: los buffers de stdout NO se mezclan con el del proceso del
 * harness porque `cli.ts` solo escribe en stdout cosas como "Generado ...".
 * Esos mensajes son ruido aceptable para el test: el harness los agrega
 * al campo `stdout` para que el fallo, si lo hay, los muestre.
 */
async function transpileAndCompile(name: string): Promise<CompileResult> {
  const cppPath = join(SCRATCH_DIR, `${name}.cpp`);
  const binPath = join(SCRATCH_DIR, name);
  const sourcePath = join(EXAMPLES_DIR, `${name}.ets`);

  // Paso 1: transpilar con `src/cli.ts` en modo unitario (--unity).
  // Capturamos stdout/stderr pero dejamos que cli.ts imprima en pantalla
  // para ver progreso. Sin embargo, para no contaminar la salida de
  // node:test, silenciamos temporalmente stdout/stderr del proceso y los
  // guardamos por separado para mostrar en caso de fallo.
  const transpile = await runProcess("node", [
    "--experimental-strip-types",
    CLI_PATH,
    sourcePath,
    "-o", cppPath,
    "--unity",
  ]);
  if (transpile.code !== 0) {
    return {
      ok: false,
      cppPath,
      binPath,
      stdout: transpile.stdout,
      stderr: transpile.stderr,
    };
  }

  // Paso 2: compilar. Detectamos TLS igual que cli.ts.
  const cppSource = await readFile(cppPath, "utf8");
  const needsTls = cppSource.includes("runtime/ets_tls.hpp");
  const compileArgs = [
    ...GXX_FLAGS,
    `-I${REPO_ROOT}`,
    "-o", binPath,
    ...LINK_FLAGS,
    cppPath,
    ...(needsTls ? ["-lssl", "-lcrypto"] : []),
  ];
  const compile = await runProcess("g++", compileArgs);
  if (compile.code !== 0) {
    return {
      ok: false,
      cppPath,
      binPath,
      stdout: compile.stdout,
      stderr: compile.stderr,
    };
  }

  return { ok: true, cppPath, binPath, stdout: "", stderr: "" };
}

/** Ejecuta el binario compilado y devuelve stdout + exit code. */
async function executeBinary(binPath: string): Promise<{ stdout: string; code: number }> {
  const result = await runProcess(binPath, []);
  return { stdout: result.stdout, code: result.code };
}

// -------------------------------------------------------------------------
// Bootstrap
// -------------------------------------------------------------------------

await mkdir(SCRATCH_DIR, { recursive: true });

// Limpiamos scratch para empezar de cero (binarios viejos, .cpp viejos,
// outputs viejos). Los golden files NUNCA se tocan.
if (existsSync(SCRATCH_DIR)) {
  for (const entry of await readdir(SCRATCH_DIR)) {
    await rm(join(SCRATCH_DIR, entry), { recursive: true, force: true });
  }
}

const skipList = await loadSkipList();
const examples = await discoverExamples();

// Cabecera de contexto: una sola vez, antes de los tests.
test("harness setup", t => {
  t.diagnostic(`examples=${examples.length} skip=${skipList.size} deterministic=${examples.length - skipList.size}`);
  t.diagnostic(`scratch dir: ${SCRATCH_DIR}`);
});

// -------------------------------------------------------------------------
// Tests (uno por ejemplo)
//
// Importante: serializados. node:test por defecto ejecuta subtests en serie
// siempre que estén dentro de un único `test()` contenedor; si los
// declarásemos como `test()` top-level separados, node:test intentaría
// paralelizar y como todos escriben en `test/scratch/<name>` se pisarían.
// Por eso los anidamos con `t.test(name, ...)` dentro de un solo `test()`
// contenedor: la API de node:test garantiza orden secuencial.
// -------------------------------------------------------------------------

test("examples", { concurrency: false }, async t => {
  for (const name of examples) {
    if (skipList.has(name)) {
      await t.test(`${name} (compile-only)`, async sub => {
        sub.diagnostic(`skip-network: solo transpile + compile + link`);
        const result = await transpileAndCompile(name);
        if (!result.ok) {
          if (result.stdout) sub.diagnostic(`stdout:\n${result.stdout}`);
          if (result.stderr) sub.diagnostic(`stderr:\n${result.stderr}`);
          throw new Error(`${name}: fallo en transpile/compile (exit != 0)`);
        }
        sub.diagnostic(`compiló: ${result.binPath}`);
      });
      continue;
    }

    await t.test(name, async sub => {
      const compiled = await transpileAndCompile(name);
      if (!compiled.ok) {
        if (compiled.stdout) sub.diagnostic(`stdout:\n${compiled.stdout}`);
        if (compiled.stderr) sub.diagnostic(`stderr:\n${compiled.stderr}`);
        throw new Error(`${name}: fallo en transpile/compile (exit != 0)`);
      }

      const { stdout, code } = await executeBinary(compiled.binPath);
      const goldenPath = join(GOLDEN_DIR, `${name}.expected.txt`);

      if (code !== 0) {
        sub.diagnostic(`stdout capturado:\n${stdout || "(vacío)"}`);
        throw new Error(`${name}: exit code = ${code} (esperado 0)`);
      }

      if (!existsSync(goldenPath)) {
        await mkdir(GOLDEN_DIR, { recursive: true });
        await writeFile(goldenPath, stdout, "utf8");
        sub.diagnostic(`INFO: baseline created (golden no existía)`);
        return;
      }

      const expected = await readFile(goldenPath, "utf8");
      if (expected !== stdout) {
        sub.diagnostic(unifiedDiff(expected, stdout, name));
        throw new Error(`${name}: stdout no coincide con ${basename(goldenPath)}`);
      }
    });
  }
});