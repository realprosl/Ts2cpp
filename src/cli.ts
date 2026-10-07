#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, basename, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
// V16: `--minimal` omite el header de IO básico (`ets_io.hpp` con print,
// console, Math, Date) para binarios ultra-ligeros. El usuario debe usar
// `std::cout` directamente si no incluye `ets_io.hpp`.
const minimalMode = args.indexOf("--minimal") >= 0;
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
    await logger?.record("info", "transpile", "started", { input, mode: "multi", minimal: minimalMode });
    const result = await compileFile(input, { moduleRoots: config?.moduleRoots, aliases: config?.aliases, minimal: minimalMode });
    const outDir = output.endsWith(".cpp") ? dirname(output) : output;
    await mkdir(outDir, { recursive: true });
    const headerPath = join(outDir, "estatic_common.hpp");
    await writeFile(headerPath, result.header, "utf8");
    for (const module of result.modules) {
      const safeName = basename(module.name).replace(/\.(ets|ts)$/, "") + ".cpp";
      await writeFile(join(outDir, safeName), module.cpp, "utf8");
    }
    console.log(`Generados ${result.modules.length} módulo(s) en ${outDir} (+ header)${minimalMode ? " [minimal]" : ""}`);
    await logger?.record("info", "transpile", "cpp-generated", { input, modules: result.modules.length, bytes: Buffer.byteLength(result.header) });
    await logger?.flush();
    process.exit(0);
  }
  await logger?.record("info", "transpile", "started", { input, output, unity: true });
  // V15: para el modo unitario, concatenamos header + módulos en un solo .cpp.
  // OJO: los módulos individuales emiten `#include "estatic_common.hpp"` que
  // solo tiene sentido en modo multi (donde el header está en disco). Aquí
  // tenemos que quitarlos para producir un .cpp monolítico válido.
  const result = await compileFile(input, { moduleRoots: config?.moduleRoots, aliases: config?.aliases, minimal: minimalMode });
  await mkdir(dirname(output), { recursive: true });
  const headerLines = result.header.split("\n");
  // En modo unitario (un solo .cpp) el `#pragma once` no tiene sentido.
  const headerForUnity = headerLines.filter(line => line.trim() !== "#pragma once");
    // V18: headers externos solicitados por `@include("stdio.h")` en un
    // `.lib.ets`. El codegen ya los entrega como `#include "stdio.h"` listos
    // para insertar. Se añaden tras el header (que ya trae `<iostream>` etc.)
    // y antes del cuerpo del módulo, en orden de aparición.
    const externalIncludes = (result.externalHeaders ?? []);
  const moduleCppLines = result.modules.flatMap((m, i) => {
    // Quitamos `#include "estatic_common.hpp"` y el include de runtime si está duplicado
    const cleaned = m.cpp
      .split("\n")
      .filter(line => !line.includes('#include "estatic_common.hpp"'))
      .join("\n");
    // Insertamos el contenido del módulo (separado por `// --- end of module ---`)
    return [cleaned];
  });
  const unified = [...headerForUnity, ...externalIncludes, "", ...moduleCppLines].join("\n");
  await writeFile(output, unified, "utf8");
  console.log(`Generado ${output}`);
  await logger?.record("info", "transpile", "cpp-generated", { input, output, modules: result.modules.length, bytes: Buffer.byteLength(unified) });
  if (config && nativeBuild) {
    await mkdir(dirname(config.output.binary), { recursive: true });
    // V17: pre-compiled headers. Compilamos `ets_runtime.hpp` (o
    // `ets_runtime_minimal.hpp` en modo --minimal) una sola vez a .gch y
    // luego lo inyectamos en cada compilación con `-include`. El .gch se
    // invalida cuando el hash del header runtime cambia (guardado en
    // build/.estatic/pch/runtime.hash).
    const pchDir = join(dirname(config.output.binary), ".estatic.pch");
    await mkdir(pchDir, { recursive: true });
    const runtimeHeader = minimalMode ? "ets_runtime_minimal.hpp" : "ets_runtime.hpp";
    const pchFile = join(pchDir, `runtime-${minimalMode ? "minimal" : "full"}.gch`);
    const hashFile = join(pchDir, `runtime-${minimalMode ? "minimal" : "full"}.hash`);
    const runtimeSourcePath = join(compilerRoot, "runtime", runtimeHeader);
    let runtimeSha = "";
    try { runtimeSha = createHash("sha256").update(await readFile(runtimeSourcePath)).digest("hex"); } catch { /* ignore */ }
    let cachedSha = "";
    try { cachedSha = await readFile(hashFile, "utf8"); } catch { /* ignore */ }
    if (runtimeSha !== cachedSha || !existsSync(pchFile)) {
      console.log(`[PCH] Generando ${pchFile}...`);
      try {
        await command(config.compiler.command, [...config.compiler.flags, `-I${config.baseDirectory}`, `-I${compilerRoot}`, "-x", "c++-header", runtimeSourcePath, "-o", pchFile], logger);
        await writeFile(hashFile, runtimeSha, "utf8");
      } catch (e) {
        // Si la generación del PCH falla, seguimos sin él.
        console.warn(`[PCH] Aviso: no se pudo generar PCH (${e}). Continuando sin pre-compiled header.`);
      }
    }
    const pchFlag = existsSync(pchFile) ? ["-include", pchFile] : [];
    const tlsLibraries = unified.includes("runtime/ets_tls.hpp") ? ["-lssl", "-lcrypto"] : [];
    // V25 Fase 4.6: si el .o del runtime esta pre-compilado en
    // build/runtime_ets_libuv.o (Fase 4 lo genera scripts/build-runtime.sh),
    // lo enlazamos directamente en lugar de recompilar el codigo inline
    // de ets_event_loop_libuv.hpp. Esto evita el coste de re-procesar
    // las 300+ lineas del header en cada build.
    //
    // V25 Fase 5: cache global en ~/.cache/etsc/runtime/<ver>/<backend>/<hash>/
    // ademas del local build/. El cache global se consulta primero (es el
    // compartido entre todos los proyectos del usuario). Si existe, se
    // copia al build/ local y se usa. Si no, fallback al local.
    //
    // Deteccion:
    //   - Si unified contiene "runtime/ets_event_loop_libuv", el programa
    //     usa LibuvEventLoop -> necesitamos runtime_ets_libuv.o.
    //   - PollEventLoop siempre (selector lo incluye via poll como fallback).
    //
    // Si los .o no existen (caso fresh install), caemos al path inline
    // de back-compat: el header los define y se compilan en cada TU.
    const useLibuvBackend = unified.includes("runtime/ets_event_loop_libuv");

    // Lee la version de Ts2cpp desde package.json (cacheado para no
    // leerlo cada build).
    const ts2cppVersion = (await import("./core/ts2cpp-version.ts" as string)).getTs2cppVersion();

    // Hash del cache: incluye version Ts2cpp + backend + subset de flags
    // que afectan la ABI de cargo/runtime (-std=, -fno-exceptions, etc).
    // Flags como -O2 o -march=native NO afectan la ABI, no entran al hash.
    const flagHashInput = config.compiler.flags
      .filter(f => /^-std=|-fno-exceptions|-fexceptions|-DETS_/.test(f))
      .sort()
      .join("\n");
    const backend = useLibuvBackend ? "libuv" : "poll";
    const cacheKey = createHash("sha256")
      .update(`${ts2cppVersion}\n${backend}\n${flagHashInput}`)
      .digest("hex")
      .slice(0, 16);
    const globalCacheDir = join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".cache", "etsc", "runtime", ts2cppVersion, backend, cacheKey);
    const runtimeObjDir = join(compilerRoot, "build");
    const runtimeLibuvObj = join(runtimeObjDir, "runtime_ets_libuv.o");
    const runtimePollObj = join(runtimeObjDir, "runtime_ets_poll.o");
    const globalLibuvObj = join(globalCacheDir, "runtime_ets_libuv.o");
    const globalPollObj = join(globalCacheDir, "runtime_ets_poll.o");

    // Resolucion de cache: si no esta en build/, intenta copiar desde
    // ~/.cache/etsc/. Si tampoco esta, llama a scripts/build-runtime.sh
    // (best-effort; si falla, sigue con fallback inline).
    const { copyFile } = await import("node:fs/promises");
    const { execFileSync } = await import("node:child_process");
    async function ensureRuntimeObj(localPath: string, globalPath: string): Promise<void> {
      if (existsSync(localPath)) return;
      if (existsSync(globalPath)) {
        await mkdir(dirname(localPath), { recursive: true });
        await copyFile(globalPath, localPath);
        return;
      }
      // Cache MISS completo. Llamamos a scripts/build-runtime.sh para
      // poblar build/ y luego copiar a ~/.cache/etsc/.
      try {
        execFileSync("bash", [join(compilerRoot, "scripts", "build-runtime.sh")], { stdio: "ignore" });
        if (existsSync(localPath)) {
          // Poblar cache global para futuros proyectos.
          await mkdir(globalCacheDir, { recursive: true });
          await copyFile(localPath, globalPath);
        }
      } catch (e) {
        // build-runtime.sh fallo: caer al path inline (header re-compilado).
        console.warn(`[runtime-cache] Aviso: build-runtime.sh fallo (${e}). Continuando con fallback inline.`);
      }
    }
    await ensureRuntimeObj(runtimeLibuvObj, globalLibuvObj);
    await ensureRuntimeObj(runtimePollObj, globalPollObj);

    const runtimeObjs: string[] = [];
    if (useLibuvBackend && existsSync(runtimeLibuvObj)) {
      runtimeObjs.push(runtimeLibuvObj);
    }
    if (existsSync(runtimePollObj)) {
      runtimeObjs.push(runtimePollObj);
    }
    // V25 Fase 6: si el usuario pide una libreria que tenemos
    // vendoreada (libuv hoy; libcurl/openssl en Fases 2-3), la
    // auto-construimos desde fuentes con scripts/build-<lib>.sh y la
    // enlazamos en lugar de la version del sistema. Asi el usuario
    // no necesita `apt install libuv-dev` etc.
    //
    // Lista de librerias con auto-vendoring. Cada entrada mapea el
    // nombre que el usuario pone en linkLibraries al script que lo
    // construye. Vacío por defecto; se iran anadiendo conforme las
    // Fases 1-3 se mergeen.
    const vendoredLibs: Record<string, { script: string; libPath: () => string }> = {
      // Fase 1: libuv vendoreada.
      // Si el usuario pone linkLibraries: ["uv"], el CLI resuelve
      // build/libs/libuv/lib/libuv.a y lo usa en lugar de -luv.
      uv: {
        script: "build-libuv.sh",
        libPath: () => join(compilerRoot, "build", "libs", "libuv", "lib", "libuv.a"),
      },
      // Fase 2: BoringSSL vendoreada.
      // linkLibraries: ["ssl", "crypto"] resuelve a los .a estaticos
      // de BoringSSL (libssl.a + libcrypto.a). Mantener el orden:
      // crypto antes de ssl (algunos simbolos de ssl llaman a crypto).
      ssl: {
        script: "build-boringssl.sh",
        libPath: () => join(compilerRoot, "build", "libs", "boringssl", "lib", "libssl.a"),
      },
      crypto: {
        script: "build-boringssl.sh",
        libPath: () => join(compilerRoot, "build", "libs", "boringssl", "lib", "libcrypto.a"),
      },
    };

    async function ensureVendoredLib(name: string): Promise<string | null> {
      const vendored = vendoredLibs[name];
      if (!vendored) return null;
      const libPath = vendored.libPath();
      if (existsSync(libPath)) return libPath;
      // Cache MISS: build la libreria desde fuentes.
      try {
        console.log(`[vendoring] Primera vez usando ${name}; compilando desde fuentes...`);
        execFileSync("bash", [join(compilerRoot, "scripts", vendored.script)], { stdio: "inherit" });
        if (existsSync(libPath)) return libPath;
      } catch (e) {
        console.warn(`[vendoring] Aviso: ${vendored.script} fallo (${e}). Usando -l${name} del sistema como fallback.`);
      }
      return null;
    }

    const libraries: string[] = [];
    for (const rawLib of config.linkLibraries) {
      if (rawLib.startsWith("-")) { libraries.push(rawLib); continue; }
      // Quitar 'l' o '-l' prefix si lo tiene
      const libName = rawLib.replace(/^-l/, "");
      const vendoredPath = await ensureVendoredLib(libName);
      if (vendoredPath) {
        libraries.push(vendoredPath);
      } else {
        libraries.push(`-l${libName}`);
      }
    }
    libraries.push(...(result.linkFlags ?? []));
    // Con `-flto` (Link-Time Optimization) el orden importa: las librerías
    // DEBEN ir después del archivo objeto. g++ con LTO necesita ver primero
    // el objeto para resolver símbolos externos en las libs.
    await command(config.compiler.command, [...pchFlag, ...config.compiler.flags, `-I${config.baseDirectory}`, `-I${compilerRoot}`, "-o", config.output.binary, ...config.compiler.linkFlags, output, ...runtimeObjs, ...libraries, ...tlsLibraries], logger);
    console.log(`Compilado ${config.output.binary}${existsSync(pchFile) ? " (con PCH)" : ""}${runtimeObjs.length ? ` (+ ${runtimeObjs.length} runtime .o)` : ""}`);
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
