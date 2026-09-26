import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "../config/project-config.ts";
import { compileFile, loadModuleGraph } from "../modules/module-loader.ts";

/**
 * Resultado del pipeline incremental.
 *
 * - `compiled`  módulos cuyo `.cpp` cambió y se recompilaron.
 * - `reused`    módulos cuyo hash coincide con la caché y se reutilizaron tal cual.
 * - `linked`    `true` si se ha vuelto a enlazar el binario en esta ejecución;
 *               `false` si el binario de la caché sigue siendo válido.
 * - `binary`    ruta absoluta del binario producido o reutilizado.
 * - `header`    ruta absoluta de la cabecera común (`estatic_common.hpp`)
 *               que todos los módulos incluyen.
 */
export interface IncrementalBuildResult {
  compiled: string[];
  reused: string[];
  linked: boolean;
  binary: string;
  header: string;
}

/**
 * Digest de los componentes globales al build:
 * flags del compilador y del linker, comando, linkLibraries y runtime.
 * Cambia ⇒ toda la caché se invalida.
 */
function globalDigest(config: ResolvedConfig, runtimeDigest: string): string {
  const hash = createHash("sha256");
  for (const flag of [...config.compiler.flags].sort()) hash.update("C:" + flag + "\x00");
  for (const flag of [...config.compiler.linkFlags].sort()) hash.update("L:" + flag + "\x00");
  for (const lib of [...config.linkLibraries].sort()) hash.update("lib:" + lib + "\x00");
  hash.update(`compiler:${config.compiler.command}\x00`);
  hash.update("runtime:" + runtimeDigest + "\x00");
  return hash.digest("hex").slice(0, 16);
}

/**
 * Huella ligera del runtime: SHA-256 + longitud de cada cabecera de runtime.
 * Si cambia runtime/, el digest cambia y la caché se invalida.
 */
async function digestRuntime(compilerRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const headers = [
    "ets_runtime.hpp", "ets_async.hpp", "ets_file.hpp", "ets_net.hpp",
    "ets_tls.hpp", "ets_io_uring.hpp", "ets_syntax.hpp", "ets_process.hpp",
    "ets_string.hpp", "ets_ast.hpp",
  ];
  for (const name of headers) {
    try {
      const content = await readFile(join(compilerRoot, "runtime", name), "utf8");
      hash.update(name + ":" + content.length + ":" + createHash("sha256").update(content).digest("hex") + "\x00");
    } catch {
      hash.update(name + ":missing\x00");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Compila (o enlaza) con el comando nativo. Captura stderr/stdout para
 * incluirlos en el error si algo falla.
 */
function runNative(command: string, args: string[]): Promise<void> {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) fulfill();
      else reject(new Error(`${command} salió con código ${code}\n${stderr || stdout}`));
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch { return false; }
}

/**
 * Construye (o reutiliza) un proyecto Estatic de forma incremental.
 *
 * Estrategia: idéntica en forma a `compileFile` — un único `.cpp` con todos
 * los módulos concatenados — y caché por **huella del programa entero**.
 * Si nada cambió, todo se reutiliza; si cambia cualquier fuente (o las
 * flags, o el runtime), regeneramos `.cpp`, recompilamos y re-enlazamos.
 *
 * Esto refleja el modelo del pipeline canónico (que también concatena
 * antes de compilar) y evita invalidar transitivos de forma incorrecta.
 * Un futuro `.cpp` por módulo es una extensión natural; aquí se queda el
 * "compile unit" entero porque mantiene la coherencia con el type-checker.
 */
export async function buildIncremental(config: ResolvedConfig, compilerRoot: string): Promise<IncrementalBuildResult> {
  // 1) Cargamos el grafo (esto también valida resolución de imports y
  // visibilidad nominal). Cualquier error aquí aborta antes de tocar la
  // caché.
  const graph = await loadModuleGraph(config.entry, {
    moduleRoots: config.moduleRoots,
    aliases: config.aliases,
  });

  const generatedDir = config.incremental.generatedDirectory;
  const cacheDir = config.incremental.cacheDirectory;
  await mkdir(generatedDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  // 2) Digests: el del runtime depende del árbol runtime/ del compilador,
  // y el global mezcla flags + runtime. Cambia ⇒ toda la caché se invalida.
  const runtimeDigest = await digestRuntime(compilerRoot);
  const digest = globalDigest(config, runtimeDigest);

  const cppPath = config.output.cpp;
  const objectPath = join(cacheDir, `app-${digest}.o`);
  const binaryPath = config.output.binary;
  const manifestPath = join(cacheDir, `app-${digest}.manifest`);
  const headerPath = join(generatedDir, "estatic_common.hpp");

  // Cabecera común: estable mientras el digest global no cambie. La
  // reescribimos siempre (es barata) para reflejar el digest actual.
  await writeFile(headerPath, `// Cabecera común generada por estatic-ts-cpp
// digest=${digest}
#include "ets_runtime.hpp"
`, "utf8");

  // 3) Huella del programa: contenido de cada módulo en orden topológico.
  // Cambio en cualquier fuente (o en el orden) ⇒ huella nueva.
  const programHash = createHash("sha256");
  for (const module of graph.modules) {
    programHash.update("file:" + module.file + "\x00");
    programHash.update(module.source + "\x00");
  }
  programHash.update("global:" + digest + "\x00");
  const programFingerprint = programHash.digest("hex").slice(0, 16);

  const previousManifest = await readFile(manifestPath, "utf8").catch(() => "");
  const cacheHit = previousManifest === programFingerprint
    && await fileExists(objectPath)
    && await fileExists(binaryPath);

  if (cacheHit) {
    return {
      compiled: [],
      reused: graph.modules.map(m => m.file),
      linked: false,
      binary: binaryPath,
      header: headerPath,
    };
  }

  // 4) Regenerar el `.cpp` mediante el pipeline canónico.
  //    Esto vuelve a parsear + chequear tipos + emitir código. Cualquier
  //    diagnóstico se propaga como `DiagnosticError` antes de tocar la
  //    caché, así un error de tipos no deja un `.o` a medias.
  const result = await compileFile(config.entry, {
    moduleRoots: config.moduleRoots,
    aliases: config.aliases,
  });
  await mkdir(dirname(cppPath), { recursive: true });
  await writeFile(cppPath, result.cpp, "utf8");

  // 5) Compilar a .o.
  const compileArgs = [
    ...config.compiler.flags,
    `-I${config.baseDirectory}`,
    `-I${compilerRoot}`,
    `-I${dirname(headerPath)}`,
    "-c",
    cppPath,
    "-o",
    objectPath,
  ];
  await runNative(config.compiler.command, compileArgs);

  // 6) Enlazar. Si el digest global no cambió y el binario ya existe, el
  // enlace se puede reutilizar; en cualquier otro caso re-enlazamos.
  const linkFlagsChanged = previousManifest !== "" && previousManifest !== programFingerprint;
  let linked = false;
  const binaryExists = await fileExists(binaryPath);
  if (!binaryExists || linkFlagsChanged) {
    const linkArgs = [
      ...config.compiler.flags.filter(flag => flag !== "-c" && flag !== "-flto" && !flag.startsWith("-Wl,")),
      objectPath,
      "-o", binaryPath,
      ...config.compiler.linkFlags,
      ...config.linkLibraries.map(lib => lib.startsWith("-") ? lib : `-l${lib}`),
    ];
    await mkdir(dirname(binaryPath), { recursive: true });
    await runNative(config.compiler.command, linkArgs);
    linked = true;
  }

  await writeFile(manifestPath, programFingerprint, "utf8");

  return {
    compiled: graph.modules.map(m => m.file),
    reused: [],
    linked,
    binary: binaryPath,
    header: headerPath,
  };
}