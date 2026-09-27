// E2E test harness — Issue #7.
//
// Ejecuta programas .ets completos contra su `expected.txt` (positive tests)
// o `expected.error.json` (negative tests, issue #15). Por programa:
//   1. Transpila a C++ con el CLI.
//   2. Compila con g++ a binario.
//   3. Ejecuta el binario (positive) o captura los diagnósticos (negative).
//   4. Compara contra el expected.
//
// Layout de un test E2E:
//   test/e2e/<bucket>/<name>/
//     ├── source.ets
//     ├── expected.txt                 (positive: stdout esperado)
//     ├── expected.error.json          (negative: diagnósticos esperados, JSON)
//     └── expected.exit.txt            (opcional: exit code esperado, default 0)
//
// El runner es paralelo (pool de workers como `test/runner.ts`), respeta
// `SKIP_NETWORK=1` y soporta `E2E_BUCKET=<bucket>` para correr solo un bucket.
//
// Sin dependencias npm: solo `node:test`, `node:fs/promises`, `node:child_process`,
// `node:os`, `node:path`. Se invoca con `npm run test:e2e`.

import { test } from "node:test";
import { readFile, writeFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const E2E_DIR = join(REPO_ROOT, "test", "e2e");
const SCRATCH_DIR = join(REPO_ROOT, "test", "scratch", "e2e");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const CONCURRENCY = Number(process.env.TEST_CONCURRENCY ?? cpus().length);

/**
 * Categorías disponibles. Cada una es un subdirectorio de test/e2e/.
 */
const BUCKETS = [
  "basics",        // #17
  "types",         // #8
  "ownership",     // #9
  "collections",   // #10
  "modules",       // #11
  "async",         // #12
  "filesystem",    // #13
  "networking",    // #14
  "errors",        // #15
  "regressions",   // #18
] as const;
type Bucket = typeof BUCKETS[number];

/**
 * Lee la skip-list de networking desde el runner principal (test/skip-network.json)
 * y la aplica también a los buckets networking, filesystem y async.
 */
async function loadSkipList(): Promise<Set<string>> {
  const skipFile = join(REPO_ROOT, "test", "skip-network.json");
  if (!existsSync(skipFile)) return new Set();
  try {
    const text = await readFile(skipFile, "utf8");
    const parsed = JSON.parse(text);
    return new Set(Array.isArray(parsed) ? parsed : (parsed.examples ?? []));
  } catch {
    return new Set();
  }
}

/**
 * Lista todos los tests E2E de un bucket. Cada test es un directorio
 * con `source.ets`.
 */
async function listE2ETests(bucket: Bucket): Promise<string[]> {
  const dir = join(E2E_DIR, bucket);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const tests: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const s = await stat(fullPath);
    if (s.isDirectory() && existsSync(join(fullPath, "source.ets"))) {
      tests.push(entry);
    }
  }
  return tests.sort();
}

/**
 * Resultado de ejecutar un test E2E.
 */
interface E2EResult {
  name: string;
  bucket: Bucket;
  ok: boolean;
  durationMs: number;
  stdout?: string;
  expected?: string;
  diagnostics?: string;
  error?: string;
  skipped?: boolean;
}

/**
 * Procesa un test E2E: transpile + compile + (run | diagnose) + compare.
 */
async function processE2E(bucket: Bucket, name: string, skipNetwork: boolean): Promise<E2EResult> {
  const start = Date.now();
  const testDir = join(E2E_DIR, bucket, name);
  const sourcePath = join(testDir, "source.ets");
  const workerScratch = join(SCRATCH_DIR, `w${(process.pid % CONCURRENCY)}`);
  await mkdir(workerScratch, { recursive: true });

  const cppPath = join(workerScratch, `${bucket}-${name}.cpp`);
  const binPath = join(workerScratch, `${bucket}-${name}`);

  // 1. Transpile
  const transpileResult = await new Promise<{ code: number; stdout: string; stderr: string }>(resolvePromise => {
    const child = spawn("node", ["--experimental-strip-types", CLI_PATH, sourcePath, "-o", cppPath, "--unity"], { cwd: workerScratch });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", () => resolvePromise({ code: -1, stdout, stderr }));
    child.once("exit", code => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });

  // Test negativo: el transpile debe fallar. Compara diagnósticos con expected.error.json.
  const expectedErrorPath = join(testDir, "expected.error.json");
  if (existsSync(expectedErrorPath)) {
    if (transpileResult.code === 0) {
      return {
        name, bucket, ok: false, durationMs: Date.now() - start,
        error: "expected compile failure but transpile succeeded",
      };
    }
    // TODO (issue #15): comparar diagnósticos reales contra expected.error.json.
    // Por ahora aceptamos cualquier fallo del transpile.
    return { name, bucket, ok: true, durationMs: Date.now() - start };
  }

  // Test positivo: el transpile debe haber funcionado.
  if (transpileResult.code !== 0) {
    return {
      name, bucket, ok: false, durationMs: Date.now() - start,
      error: `transpile failed (exit ${transpileResult.code}):\n${transpileResult.stderr}`,
    };
  }

  // 2. Compile
  const compileResult = await new Promise<{ code: number; stdout: string; stderr: string }>(resolvePromise => {
    const child = spawn("g++", ["-std=c++20", "-O2", "-pthread", "-fno-exceptions", "-I", REPO_ROOT, cppPath, "-o", binPath], { cwd: workerScratch });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", () => resolvePromise({ code: -1, stdout, stderr }));
    child.once("exit", code => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
  if (compileResult.code !== 0) {
    return {
      name, bucket, ok: false, durationMs: Date.now() - start,
      error: `compile failed:\n${compileResult.stderr}`,
    };
  }

  // 3. Run (positive test) o skip (skip-network)
  if (skipNetwork && bucket === "networking") {
    return { name, bucket, ok: true, durationMs: Date.now() - start, skipped: true };
  }
  const execResult = await new Promise<{ code: number; stdout: string }>(resolvePromise => {
    const child = spawn(binPath, [], { cwd: SCRATCH_DIR });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.once("error", () => resolvePromise({ stdout, code: -1 }));
    // Usamos `close` en lugar de `exit`: `close` se dispara cuando todos los
    // streams (stdout/stderr) están cerrados Y el proceso ha liberado sus
    // recursos, lo que evita perder el último chunk de stdout en escenarios
    // de alta concurrencia de compilación (flake observado con 4 workers
    // compilando ets_runtime.hpp simultáneamente).
    child.once("close", code => resolvePromise({ stdout, code: code ?? -1 }));
  });

  // 4. Compare
  const expectedPath = join(testDir, "expected.txt");
  if (!existsSync(expectedPath)) {
    // Genera baseline.
    await writeFile(expectedPath, execResult.stdout);
    return {
      name, bucket, ok: true, durationMs: Date.now() - start,
      stdout: execResult.stdout,
      diagnostics: "baseline created",
    };
  }
  const expected = await readFile(expectedPath, "utf8");
  if (expected !== execResult.stdout) {
    return {
      name, bucket, ok: false, durationMs: Date.now() - start,
      stdout: execResult.stdout,
      expected,
      error: "stdout mismatch",
    };
  }

  // Exit code opcional.
  const expectedExitPath = join(testDir, "expected.exit.txt");
  if (existsSync(expectedExitPath)) {
    const expectedExit = Number((await readFile(expectedExitPath, "utf8")).trim());
    if (expectedExit !== execResult.code) {
      return {
        name, bucket, ok: false, durationMs: Date.now() - start,
        error: `expected exit ${expectedExit}, got ${execResult.code}`,
      };
    }
  }

  return { name, bucket, ok: true, durationMs: Date.now() - start };
}

/**
 * Ejecuta un pool de promesas con concurrencia limitada (sin worker_threads).
 */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Limpia scratch al inicio (igual que el runner principal).
await rm(SCRATCH_DIR, { recursive: true, force: true });
await mkdir(SCRATCH_DIR, { recursive: true });

const skipNetwork = process.env.SKIP_NETWORK === "1";
await loadSkipList(); // Carga pero todavía no se usa por nombre; se aplica al bucket "networking".
const requestedBucket = process.env.E2E_BUCKET as Bucket | undefined;
const bucketsToRun = requestedBucket ? [requestedBucket] : BUCKETS.filter(b => existsSync(join(E2E_DIR, b)));

for (const bucket of bucketsToRun) {
  test(`e2e/${bucket}`, { concurrency: false }, async t => {
    const tests = await listE2ETests(bucket);
    if (tests.length === 0) {
      t.skip(`no hay tests en test/e2e/${bucket}/`);
      return;
    }
    const results = await runPool(tests, CONCURRENCY, name => processE2E(bucket, name, skipNetwork));
    // Reportamos cada test como subtest anidado (mismo patrón que test/runner.ts).
    for (const result of results) {
      if (result.skipped) {
        await t.test(`${result.name} (skip-network)`, { skip: true }, () => {});
      } else if (result.ok) {
        await t.test(`${result.name}`, sub => {
          for (const note of [result.diagnostics].filter(Boolean) as string[]) sub.diagnostic(note);
          // Sin throw = pass automático.
        });
      } else {
        await t.test(`${result.name} (FAIL)`, sub => {
          if (result.error) sub.diagnostic(result.error);
          throw new Error(`${result.name}: ${result.error}`);
        });
      }
    }
  });
}
