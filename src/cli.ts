#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, basename, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { compileFile } from "./modules/module-loader.ts";
import { DiagnosticError, formatDiagnostic } from "./core/diagnostic.ts";
import { loadConfig } from "./config/project-config.ts";
import { buildIncremental } from "./build/incremental-builder.ts";
import { BuildLogger } from "./core/build-logger.ts";
import { initializeProject } from "./project/init-project.ts";

function usage(): never {
  console.error("Uso:\n  estatic init [directorio]\n  estatic [entrada.ts|entrada.ets] [-o salida.cpp] [--config estatic.config.ts] [--build] [--unity]");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage();
if (args[0] === "init") {
  if (args.length > 2 || args[1]?.startsWith("-")) usage();
  try {
    const initialized = await initializeProject(args[1] ?? ".");
    console.log(`Proyecto Estatic creado en ${initialized.directory}`);
    for (const file of initialized.files) console.log(`  ${file.slice(initialized.directory.length + 1)}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
const compilerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const valueAfter = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const configPath = valueAfter("--config");
const optionValues = new Set([valueAfter("--config"), valueAfter("-o")].filter((value): value is string => !!value));
const positional = args.find(argument => !argument.startsWith("-") && !optionValues.has(argument));
const config = configPath ? await loadConfig(configPath) : positional ? undefined : await loadConfig();
if (!positional && !config) usage();
const input = positional ? resolve(positional) : config!.entry;
// V15: si el usuario pasa `--multi`, escribe el header + un `.cpp` por módulo.
const multiFlag = args.indexOf("--multi");
const multiMode = multiFlag >= 0;
const outputFlag = args.indexOf("-o");
const output = resolve(outputFlag >= 0 ? (args[outputFlag + 1] ?? usage()) : (config?.output.cpp ?? basename(input, extname(input)) + ".cpp"));

async function command(executable: string, commandArgs: string[], logger?: BuildLogger): Promise<void> {
  await logger?.record("info", "compile", "native-command-started", { command: executable, args: commandArgs });
  await new Promise<void>((fulfill, reject) => {
    const child = spawn(executable, commandArgs, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); }); child.stderr.on("data", chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.once("error", error => { void logger?.error("compile", error); reject(error); });
    child.once("exit", code => {
      const recorded = logger ? logger.record(code === 0 ? "info" : "error", "compile", "native-command-finished", { command: executable, exitCode: code, stdout, stderr }) : Promise.resolve();
      void recorded.then(() => code === 0 ? fulfill() : reject(new Error(`${executable} terminó con código ${code}`)));
    });
  });
}

const nativeBuild = !!config && (config.compiler.enabled || args.includes("--build"));
const incrementalBuild = !!config?.incremental.enabled && nativeBuild && !args.includes("--unity");
const verbose = args.includes("--verbose") || args.includes("-v");
const logger = incrementalBuild ? undefined : await BuildLogger.create(config);
try {
  if (incrementalBuild) {
    const result = await buildIncremental(config, compilerRoot, { verbose });
    console.log(`Build incremental (${result.cacheResult}): ${result.compiled.length} módulo(s) compilado(s), ${result.reused.length} reutilizado(s)${result.linked ? ", re-enlazado" : ""}, ${result.durationMs}ms`);
    if (!verbose) for (const module of result.compiled) console.log(`  Compilado módulo ${module}`);
    process.exit(0);
  }
  // V15: si el usuario pasa `--multi`, escribimos header + un `.cpp` por módulo.
  if (multiMode) {
    await logger?.record("info", "transpile", "started", { input, mode: "multi" });
    const result = await compileFile(input, { moduleRoots: config?.moduleRoots, aliases: config?.aliases });
    const outDir = output.endsWith(".cpp") ? dirname(output) : output;
    await mkdir(outDir, { recursive: true });
    const headerPath = join(outDir, "estatic_common.hpp");
    await writeFile(headerPath, result.header, "utf8");
    for (const module of result.modules) {
      const safeName = basename(module.name).replace(/\.(ets|ts)$/, "") + ".cpp";
      await writeFile(join(outDir, safeName), module.cpp, "utf8");
    }
    console.log(`Generados ${result.modules.length} módulo(s) en ${outDir} (+ header)`);
    await logger?.record("info", "transpile", "cpp-generated", { input, modules: result.modules.length, bytes: Buffer.byteLength(result.header) });
    await logger?.flush();
    process.exit(0);
  }
  await logger?.record("info", "transpile", "started", { input, output, unity: true });
  // V15: para el modo unitario, concatenamos header + módulos en un solo .cpp.
  // OJO: los módulos individuales emiten `#include "estatic_common.hpp"` que
  // solo tiene sentido en modo multi (donde el header está en disco). Aquí
  // tenemos que quitarlos para producir un .cpp monolítico válido.
  const result = await compileFile(input, { moduleRoots: config?.moduleRoots, aliases: config?.aliases });
  await mkdir(dirname(output), { recursive: true });
  const headerLines = result.header.split("\n");
  // En modo unitario (un solo .cpp) el `#pragma once` no tiene sentido.
  const headerForUnity = headerLines.filter(line => line.trim() !== "#pragma once");
  const moduleCppLines = result.modules.flatMap((m, i) => {
    // Quitamos `#include "estatic_common.hpp"` y el include de runtime si está duplicado
    const cleaned = m.cpp
      .split("\n")
      .filter(line => !line.includes('#include "estatic_common.hpp"'))
      .join("\n");
    // Insertamos el contenido del módulo (separado por `// --- end of module ---`)
    return [cleaned];
  });
  const unified = [...headerForUnity, ...moduleCppLines].join("\n");
  await writeFile(output, unified, "utf8");
  console.log(`Generado ${output}`);
  await logger?.record("info", "transpile", "cpp-generated", { input, output, modules: result.modules.length, bytes: Buffer.byteLength(unified) });
  if (config && nativeBuild) {
    await mkdir(dirname(config.output.binary), { recursive: true });
    const tlsLibraries = unified.includes("runtime/ets_tls.hpp") ? ["-lssl", "-lcrypto"] : [];
    const libraries = config.linkLibraries.map(library => library.startsWith("-") ? library : `-l${library}`);
    // Con `-flto` (Link-Time Optimization) el orden importa: las librerías
    // DEBEN ir después del archivo objeto. g++ con LTO necesita ver primero
    // el objeto para resolver símbolos externos en las libs.
    await command(config.compiler.command, [...config.compiler.flags, `-I${config.baseDirectory}`, `-I${compilerRoot}`, "-o", config.output.binary, ...config.compiler.linkFlags, output, ...libraries, ...tlsLibraries], logger);
    console.log(`Compilado ${config.output.binary}`);
  }
  await logger?.record("info", "transpile", "finished", { output, binary: nativeBuild ? config?.output.binary : undefined });
  await logger?.flush();
} catch (error) {
  await logger?.error("transpile", error); await logger?.flush();
  if (error instanceof DiagnosticError) {
    const source = await readFile(input, "utf8").catch(() => "");
    const { formatDiagnostics } = await import("./core/diagnostic.ts");
    console.error(formatDiagnostics(input, source, error.diagnostics));
  } else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
