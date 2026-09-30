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
import { cpus } from "node:os";
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

// Concurrency: número de demos que se procesan en paralelo. Por defecto el
// número de cores - 1 (deja 1 core para el sistema operativo). Se puede
// sobreescribir con la variable TEST_CONCURRENCY=N (e.g. TEST_CONCURRENCY=1
// para forzar serie si la paralelización causa flakiness).
const TEST_CONCURRENCY = process.env.TEST_CONCURRENCY !== undefined
  ? Math.max(1, Number.parseInt(process.env.TEST_CONCURRENCY, 10) || 1)
  : Math.max(1, cpus().length - 1);

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

/**
 * Pipeline legacy (ya no se usa; reemplazado por processDemo() con worker
 * pool). Se conserva la interfaz CompileResult por si se reactiva desde un
 * test individual en el futuro.
 */
interface CompileResult {
  ok: boolean;
  cppPath: string;
  binPath: string;
  stdout: string;
  stderr: string;
}

/** Stub legacy: redirige a processDemo() con workerId=0 (compatibilidad). */
async function transpileAndCompile(name: string): Promise<CompileResult> {
  const workerScratch = join(SCRATCH_DIR, "w0");
  const cppPath = join(workerScratch, `${name}.cpp`);
  const binPath = join(workerScratch, name);
  const result = await processDemo(name, false, 0);
  return { ok: result.ok, cppPath, binPath, stdout: result.diagnostics.join("\n"), stderr: "" };
}

/** Stub legacy para executeBinary. */
async function executeBinary(binPath: string): Promise<{ stdout: string; code: number }> {
  return { stdout: "", code: 0 };
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
// Worker pool simple
//
// Cada demo se procesa en paralelo hasta TEST_CONCURRENCY a la vez. Cada
// worker escribe en un subdirectorio único de SCRATCH_DIR para que los
// binarios y `.cpp` no se pisen. El orden de las subtests no se garantiza
// (la suite ya era dependiente de orden solo por el scratch compartido).
// -------------------------------------------------------------------------

interface ProcessedDemo { name: string; ok: boolean; error?: string; durationMs: number; diagnostics: string[]; }

async function processDemo(name: string, isSkipNetwork: boolean, workerId: number): Promise<ProcessedDemo> {
  const started = Date.now();
  const diagnostics: string[] = [];
  const workerScratch = join(SCRATCH_DIR, `w${workerId}`);
  await mkdir(workerScratch, { recursive: true });
  const cppPath = join(workerScratch, `${name}.cpp`);
  const binPath = join(workerScratch, name);
  const sourcePath = join(EXAMPLES_DIR, `${name}.ets`);
  const localCli = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
    return new Promise(resolvePromise => {
      const child = spawn("node", ["--experimental-strip-types", CLI_PATH, sourcePath, "-o", cppPath, "--unity"], { cwd: workerScratch });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", () => { resolvePromise({ code: -1, stdout, stderr }); });
      child.once("exit", code => { resolvePromise({ code: code ?? -1, stdout, stderr }); });
    });
  };
  const localGxx = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    return new Promise(resolvePromise => {
      const child = spawn("g++", args, { cwd: workerScratch });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", () => { resolvePromise({ code: -1, stdout, stderr }); });
      child.once("exit", code => { resolvePromise({ code: code ?? -1, stdout, stderr }); });
    });
  };

  // Transpile.
  const transpile = await localCli();
  if (transpile.code !== 0) {
    diagnostics.push(`stdout:\n${transpile.stdout}`);
    diagnostics.push(`stderr:\n${transpile.stderr}`);
    return { name, ok: false, error: `fallo en transpile (exit ${transpile.code})`, durationMs: Date.now() - started, diagnostics };
  }

  // Compile + link.
  const cppSource = await readFile(cppPath, "utf8");
  const needsTls = cppSource.includes("runtime/ets_tls.hpp");
  const compileArgs = [...GXX_FLAGS, `-I${REPO_ROOT}`, "-o", binPath, ...LINK_FLAGS, cppPath, ...(needsTls ? ["-lssl", "-lcrypto"] : [])];
  const compile = await localGxx(compileArgs);
  if (compile.code !== 0) {
    diagnostics.push(`stdout:\n${compile.stdout}`);
    diagnostics.push(`stderr:\n${compile.stderr}`);
    return { name, ok: false, error: `fallo en compile/link (exit ${compile.code})`, durationMs: Date.now() - started, diagnostics };
  }

  if (isSkipNetwork) {
    diagnostics.push(`skip-network: solo transpile + compile + link (${binPath})`);
    return { name, ok: true, durationMs: Date.now() - started, diagnostics };
  }

  // Ejecutar y comparar con golden. El cwd es SCRATCH_DIR raíz (no el
  // worker subdir) para que demos que llaman process.cwd() / path.resolve
  // con paths relativos vean el mismo entorno que en serie.
  const exec = await new Promise<{ stdout: string; code: number }>(resolvePromise => {
    const child = spawn(binPath, [], { cwd: SCRATCH_DIR });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", () => { resolvePromise({ stdout, code: -1 }); });
    child.once("exit", code => { resolvePromise({ stdout, code: code ?? -1 }); });
  });
  const goldenPath = join(GOLDEN_DIR, `${name}.expected.txt`);
  if (exec.code !== 0) {
    diagnostics.push(`stdout capturado:\n${exec.stdout || "(vacío)"}`);
    return { name, ok: false, error: `exit code = ${exec.code} (esperado 0)`, durationMs: Date.now() - started, diagnostics };
  }
  if (!existsSync(goldenPath)) {
    await mkdir(GOLDEN_DIR, { recursive: true });
    await writeFile(goldenPath, exec.stdout, "utf8");
    diagnostics.push(`INFO: baseline created (golden no existía)`);
    return { name, ok: true, durationMs: Date.now() - started, diagnostics };
  }
  const expected = await readFile(goldenPath, "utf8");
  // Normaliza el path absoluto del repo por `<REPO>` para que los golden
  // files con paths hardcodeados (e.g. `cwd =/root/Ts2cpp/test/scratch`)
  // sean portables entre clones. Esto afecta solo a la comparación, no al
  // golden en disco (que mantiene el path tal cual el demo lo emite).
  const normalizePath = (text: string): string => text.split(REPO_ROOT).join("<REPO>");
  const normalizedExpected = normalizePath(expected);
  const normalizedActual = normalizePath(exec.stdout);
  if (normalizedExpected !== normalizedActual) {
    diagnostics.push(unifiedDiff(normalizedExpected, normalizedActual, name));
    return { name, ok: false, error: `stdout no coincide con ${basename(goldenPath)}`, durationMs: Date.now() - started, diagnostics };
  }
  return { name, ok: true, durationMs: Date.now() - started, diagnostics };
}

/** Ejecuta tasks con un pool de N workers. Devuelve resultados en orden
 *  de entrada (preservando el orden de `tasks`). */
async function runPool<T>(items: T[], workerCount: number, fn: (item: T, workerId: number) => Promise<ProcessedDemo>): Promise<ProcessedDemo[]> {
  const results: ProcessedDemo[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(workerId: number): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, workerId);
    }
  }
  const workers = Array.from({ length: Math.min(workerCount, items.length) }, (_, i) => worker(i));
  await Promise.all(workers);
  return results;
}

const concurrency = TEST_CONCURRENCY;

// Cabecera de contexto: una sola vez, antes de los tests.
test("harness setup", t => {
  t.diagnostic(`examples=${examples.length} skip=${skipList.size} deterministic=${examples.length - skipList.size} concurrency=${concurrency}`);
  t.diagnostic(`scratch dir: ${SCRATCH_DIR}`);
});

test("examples", { concurrency: false }, async t => {
  t.diagnostic(`procesando ${examples.length} demos con ${concurrency} worker(s)...`);
  const poolStarted = Date.now();
  const results = await runPool(examples, concurrency, (name, workerId) => processDemo(name, skipList.has(name), workerId));
  const poolElapsed = Date.now() - poolStarted;
  t.diagnostic(`pool terminó en ${poolElapsed}ms (${(poolElapsed / 1000).toFixed(2)}s)`);
  // Reportamos cada demo como subtest (ordenados para diff estable).
  for (const result of results) {
    if (result.ok) {
      await t.test(`${result.name}`, { skip: skipList.has(result.name) ? false : false }, sub => {
        for (const diag of result.diagnostics) sub.diagnostic(diag);
        if (skipList.has(result.name)) sub.diagnostic(`skip-network: solo transpile + compile + link`);
        sub.diagnostic(`${result.durationMs}ms`);
      });
    } else {
      await t.test(`${result.name} (FAIL)`, async sub => {
        for (const diag of result.diagnostics) sub.diagnostic(diag);
        throw new Error(`${result.name}: ${result.error}`);
      });
    }
  }
});