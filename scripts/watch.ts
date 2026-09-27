#!/usr/bin/env node
// Watch mode: re-compila (transpile + native build) el entry de estatic.config.ts
// cada vez que un fuente del grafo de módulos cambia.
//
// Uso: node --experimental-strip-types scripts/watch.ts [--config estatic.config.ts]
//
// Limitaciones:
// - No usa el incremental builder (Fase 3.2 podría integrarlo).
// - File events del SO son flaky en Linux con editores que escriben atómico
//   (vim, IntelliJ): debounce de 100ms agrupa cambios.
// - Ctrl+C para terminar.

import { watch } from "node:fs/promises";
import { resolve, dirname, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const compilerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let configPath = "estatic.config.ts";
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--config" || args[index] === "-c") { configPath = args[index + 1] ?? configPath; index++; }
}

interface PendingChange { file: string; timer: NodeJS.Timeout; }
const pending = new Map<string, PendingChange>();
const DEBOUNCE_MS = 100;

function log(message: string): void { process.stderr.write(`${message}\n`); }
function dim(text: string): string { return process.stderr.isTTY ? `\x1b[2m${text}\x1b[0m` : text; }

async function runCompile(): Promise<boolean> {
  const started = Date.now();
  log(dim(`→ re-compilando (${new Date().toLocaleTimeString()})`));
  return new Promise((resolvePromise) => {
    const child = spawn("node", ["--experimental-strip-types", "src/cli.ts", "--config", configPath], { cwd: compilerRoot, stdio: "inherit" });
    child.once("exit", code => {
      const elapsed = ((Date.now() - started) / 1000).toFixed(2);
      if (code === 0) log(dim(`✓ ok en ${elapsed}s`));
      else log(`✗ falló (código ${code}, ${elapsed}s)`);
      resolvePromise(code === 0);
    });
    child.once("error", error => { log(`✗ error al lanzar: ${error.message}`); resolvePromise(false); });
  });
}

function scheduleRebuild(file: string): void {
  const existing = pending.get(file);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(async () => {
    pending.delete(file);
    log(dim(`cambio: ${file}`));
    await runCompile();
  }, DEBOUNCE_MS);
  pending.set(file, { file, timer });
}

async function watchSources(): Promise<void> {
  log(`watch: ${configPath}`);
  log("resolviendo entry...");
  // El CLI resuelve el entry del config; en lugar de duplicar lógica,
  // parseamos el config trivialmente (buscamos `entry:` en el archivo).
  const { readFile } = await import("node:fs/promises");
  const configText = await readFile(configPath, "utf8");
  const entryMatch = configText.match(/entry:\s*["']([^"']+)["']/);
  const moduleRootsMatch = configText.match(/moduleRoots:\s*\[([^\]]*)\]/);
  if (!entryMatch) { log(`error: no se encontró 'entry' en ${configPath}`); process.exit(1); }
  const entry = entryMatch[1];
  const moduleRoots = moduleRootsMatch ? moduleRootsMatch[1].split(",").map(s => s.trim().replace(/["']/g, "")).filter(Boolean) : ["src"];
  const baseDir = resolve(dirname(configPath));
  const watchedDirs = new Set<string>([resolve(baseDir, dirname(entry)), ...moduleRoots.map(rm => resolve(baseDir, rm))]);

  log(`entry: ${entry}`);
  log(`vigilando:`);
  for (const dir of watchedDirs) log(`  ${dir}`);

  // Watch cada directorio (recursive cuando es posible; Linux soporta).
  for (const dir of watchedDirs) {
    try {
      const iterator = watch(dir, { recursive: true });
      (async () => {
        for await (const event of iterator) {
          if (!event.filename) continue;
          if (!event.filename.endsWith(".ets") && !event.filename.endsWith(".ts")) continue;
          if (event.filename.endsWith(".ets.ts")) continue; // false positive
          // Ignora cambios en node_modules y dentro del compilerRoot.
          const absolute = resolve(dir, event.filename);
          if (absolute.includes("/node_modules/")) continue;
          if (absolute.startsWith(compilerRoot)) continue;
          scheduleRebuild(absolute);
        }
      })().catch(error => log(`watch error en ${dir}: ${error.message}`));
    } catch (error) {
      log(`no se pudo vigilar ${dir}: ${(error as Error).message}`);
    }
  }

  // Build inicial.
  await runCompile();
  log(dim("(Ctrl+C para terminar)"));
}

watchSources().catch(error => { log(`fatal: ${error.message}`); process.exit(1); });
