import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { ResolvedConfig } from "../config/project-config.ts";
import { compileFile, loadModuleGraph } from "../modules/module-loader.ts";
import { computeModuleId, assertUniqueIdentities } from "../modules/module-identity.ts";

declare const process: { stderr: { write: (data: string) => void }; env: Record<string, string | undefined>; stdout: { write: (data: string) => void } };
declare const Buffer: { byteLength: (data: string) => number };
declare const setTimeout: (callback: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

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
  /** Tiempo total del build en milisegundos. */
  durationMs: number;
  /** Resultado de la caché: 'hit' (todo reutilizado), 'miss' (regenerado), 'partial' (algunos módulos). */
  cacheResult: "hit" | "miss" | "partial";
}

/** Opciones del build incremental. */
export interface IncrementalBuildOptions {
  /** Si es true, imprime cada fase con su tiempo al stderr (estilo cargo). */
  verbose?: boolean;
}

/**
 * Reporter de progreso del build. Cuando verbose=true emite mensajes con
 * timing a stderr; cuando verbose=false es silencioso. Los tiempos se
 * pueden consultar externamente vía `lastElapsed()`.
 */
class BuildProgress {
  private readonly verbose: boolean;
  private phaseStart: number;
  private readonly startTime: number;
  constructor(verbose: boolean) {
    this.verbose = verbose;
    this.startTime = Date.now();
    this.phaseStart = this.startTime;
  }
  beginPhase(name: string): void {
    if (!this.verbose) return;
    const elapsed = ((Date.now() - this.phaseStart) / 1000).toFixed(2);
    process.stderr.write(`       ${name}... ${elapsed}s\n`);
    this.phaseStart = Date.now();
  }
  log(message: string): void { if (this.verbose) process.stderr.write(`       ${message}\n`); }
  warn(message: string): void { process.stderr.write(`warning: ${message}\n`); }
  error(message: string): void { process.stderr.write(`error: ${message}\n`); }
  totalElapsed(): number { return Date.now() - this.startTime; }
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
 * Huella ligera del runtime: SHA-256 + longitud de cada cabecera y
 * .cpp del runtime. Si cambia runtime/, el digest cambia y la caché
 * se invalida.
 *
 * V30.6.1 (H-04): antes solo enumeraba 10 cabeceras hardcodeadas
 * (ets_runtime.hpp, ets_async.hpp, ...). Faltan 27 cabeceras reales
 * (ets_core.hpp, ets_buffer_pool.hpp, ets_dns.hpp, ets_http_curl_async.hpp,
 * ets_runtime_full.hpp, ets_event_loop.hpp, ets_event_loop_iface.hpp,
 * ets_event_loop_libuv.hpp, ets_net_libuv.hpp, ets_net_libuv_api.hpp,
 * ets_net_sync.hpp, ets_optional.hpp, ets_string.hpp, ets_timer.hpp,
 * ets_unq.hpp, ets_rc.hpp, ets_collections.hpp, ets_io.hpp,
 * ets_http_client.hpp, ets_http_curl_client.hpp, ets_http_drogon.hpp,
 * ets_http_httplib.hpp, ets_io_uring.hpp, ets_io_uring_async.hpp,
 * ets_buffer_pool.hpp, ets_fs_watcher.hpp, ets_http_server.hpp,
 * ets_process.hpp, ets_ast.hpp, ets_syntax.hpp, ets_runtime_minimal.hpp,
 * ets_file.hpp, ets_event_loop_libuv_api.hpp, ets_multi_loop.hpp, ...).
 * Un cambio en una no enumerada podia dejar objetos compilados contra
 * codigo anterior.
 *
 * Ahora: iteramos todos los `*.hpp` y `*.cpp` del directorio runtime/
 * en orden estable, mas el ejecutable del compilador y los flags (que
 * ya entran via `digest` en buildIncremental). El orden estable es
 * alfabetico por nombre de archivo para que la huella sea
 * determinista entre ejecuciones.
 */
async function digestRuntime(compilerRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const runtimeDir = join(compilerRoot, "runtime");
  let entries: string[];
  try {
    const all = await readdir(runtimeDir);
    entries = all.filter(f => f.endsWith(".hpp") || f.endsWith(".h") || f.endsWith(".cpp")).sort();
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    // Fallback al comportamiento previo si la lectura falla, para no
    // tirar el build en maquinas sin permisos (mejor un digest debil
    // que un crash). El assertUniqueIdentities en module-identity.ts
    // no depende de este digest.
    const legacy = [
      "ets_runtime.hpp", "ets_async.hpp", "ets_file.hpp", "ets_net.hpp",
      "ets_tls.hpp", "ets_io_uring.hpp", "ets_syntax.hpp", "ets_process.hpp",
      "ets_string.hpp", "ets_ast.hpp",
    ];
    for (const name of legacy) {
      try {
        const content = await readFile(join(runtimeDir, name), "utf8");
        hash.update(name + ":" + content.length + ":" + createHash("sha256").update(content).digest("hex") + "\x00");
      } catch {
        hash.update(name + ":missing\x00");
      }
    }
    return hash.digest("hex").slice(0, 16);
  }
  for (const name of entries) {
    try {
      const content = await readFile(join(runtimeDir, name), "utf8");
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
 *
 * V30.6.1 (H-07): cap de 1 MiB en stdout y stderr cada uno (los ultimos
 * 1 MiB; lo anterior se descarta para evitar OOM si el compilador
 * emite diagnosticos masivos). Anade timeout por defecto de 5 minutos
 * para evitar que un build se cuelgue indefinidamente.
 */
const RUN_NATIVE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
const RUN_NATIVE_OUTPUT_CAP = 1024 * 1024; // 1 MiB
function runNative(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? RUN_NATIVE_TIMEOUT_MS;
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutDropped = 0;
    let stderrDropped = 0;
    const trimTo = (current: string, dropped: number, chunk: string): { kept: string; dropped: number } => {
      const combined = current + chunk;
      if (combined.length <= RUN_NATIVE_OUTPUT_CAP) return { kept: combined, dropped };
      // Mantener los ultimos RUN_NATIVE_OUTPUT_CAP bytes.
      const sliced = combined.slice(combined.length - RUN_NATIVE_OUTPUT_CAP);
      return { kept: sliced, dropped: dropped + (combined.length - RUN_NATIVE_OUTPUT_CAP) };
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} excedio el timeout de ${timeoutMs}ms y fue terminado`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { const r = trimTo(stdout, stdoutDropped, chunk); stdout = r.kept; stdoutDropped = r.dropped; });
    child.stderr.on("data", (chunk: string) => { const r = trimTo(stderr, stderrDropped, chunk); stderr = r.kept; stderrDropped = r.dropped; });
    child.once("error", (error: Error) => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) fulfill();
      else {
        const dropped = (n: number) => n > 0 ? ` (+${n.toLocaleString()} bytes descartados por cap de ${RUN_NATIVE_OUTPUT_CAP.toLocaleString()})` : "";
        reject(new Error(`${command} salió con código ${code}\n${stderr || stdout}${dropped(stdoutDropped + stderrDropped)}`));
      }
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
export async function buildIncremental(config: ResolvedConfig, compilerRoot: string, options: IncrementalBuildOptions = {}): Promise<IncrementalBuildResult> {
  const progress = new BuildProgress(options.verbose ?? false);
  if (options.verbose) process.stderr.write(`   Cargando grafo de módulos...\n`);

  // V30.6.0: el pre-compile de los .o del runtime ahora lo hace
  // `scripts/postinstall.sh` (llamado por `npm install` automaticamente).
  // El incremental ya no intenta compilar nada del runtime — eso es
  // responsabilidad del postinstall. Si los .o no existen, fallamos
  // rapido con un mensaje claro en vez de intentar compilarlos aqui
  // (lo cual era fragil y duplicaba logica).
  const runtimeObjDir = join(compilerRoot, "build");
  if (!existsSync(runtimeObjDir) || !existsSync(join(runtimeObjDir, "runtime_ets_libuv.o"))) {
    throw new Error(
      `Los .o del runtime no se encontraron en ${runtimeObjDir}/.\n` +
      `Esto ocurre tras un clone fresco. Ejecuta 'npm install' en ${compilerRoot}\n` +
      `para compilar el runtime, o 'bash scripts/postinstall.sh --skip-sysdeps' si\n` +
      `ya tienes libuv-dev/libcurl-dev/libssl-dev instalados.`
    );
  }
  // 1) Cargamos el grafo (esto también valida resolución de imports y
  // visibilidad nominal). Cualquier error aquí aborta antes de tocar la
  // caché.
  const graph = await loadModuleGraph(config.entry, {
    moduleRoots: config.moduleRoots,
    aliases: config.aliases,
    baseDirectory: config.baseDirectory,
  });
  if (options.verbose) progress.log(`${graph.modules.length} módulo(s) cargado(s)`);

  const generatedDir = config.incremental.generatedDirectory;
  const cacheDir = config.incremental.cacheDirectory;
  await mkdir(generatedDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  // 2) Digests: el del runtime depende del árbol runtime/ del compilador,
  // y el global mezcla flags + runtime. Cambia ⇒ toda la caché se invalida.
  progress.beginPhase("Calculando digests (runtime + flags)");
  const runtimeDigest = await digestRuntime(compilerRoot);
  const digest = globalDigest(config, runtimeDigest);
  if (options.verbose) progress.log(`runtime digest: ${runtimeDigest}, global digest: ${digest}`);

  const cppPath = config.output.cpp;
  const binaryPath = config.output.binary;
  const manifestPath = join(cacheDir, `app.manifest`);
  const globalManifestPath = join(cacheDir, `global.manifest`);
  const headerPath = join(generatedDir, "estatic_common.hpp");

  // V17: pre-compiled headers. Generamos `runtime.gch` la primera vez y lo
  // reusamos con `-include` mientras el hash del header runtime no cambie.
  // Esto reduce el tiempo de compilación ~30-50% en programas con runtime
  // pesado (hello: 3.5s → ~1.8s en la segunda compilación).
  const pchDir = join(cacheDir, "..", "pch");
  await mkdir(pchDir, { recursive: true });
  const pchFile = join(pchDir, `runtime-${runtimeDigest}.gch`);
  const needsPch = config.compiler.flags.some((flag: string) => !flag.startsWith("-flto"));
  if (needsPch && !existsSync(pchFile)) {
    progress.beginPhase(`Generando PCH (runtime-${runtimeDigest}.gch)`);
    const pchSource = join(compilerRoot, "runtime", "ets_runtime.hpp");
    const pchArgs = [
      ...config.compiler.flags.filter((flag: string) => flag !== "-c"),
      `-I${config.baseDirectory}`,
      `-I${compilerRoot}`,
      "-x", "c++-header",
      pchSource,
      "-o", pchFile,
    ];
    try { await runNative(config.compiler.command, pchArgs); }
    catch (error) { progress.warn(`No se pudo generar PCH: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const pchFlag = existsSync(pchFile) ? ["-include", pchFile] : [];

  // Si el digest global (runtime + flags + comando) cambió desde el último
  // build, hay que invalidar TODO el cache. Lo persistimos en `global.manifest`.
  const previousGlobalDigest = await readFile(globalManifestPath, "utf8").catch(() => "");
  const globalDigestChanged = previousGlobalDigest !== digest;
  if (globalDigestChanged && previousGlobalDigest) {
    progress.warn(`Cache global invalidado (runtime/flags cambiaron: ${previousGlobalDigest.slice(0, 8)}... → ${digest.slice(0, 8)}...)`);
  }
  await writeFile(globalManifestPath, digest, "utf8");

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
  // V15: el cache hit ahora es "todos los .o reutilizados". Si llegamos aquí
  // con `globalDigestChanged=false` y el `app.manifest` (huella de programa)
  // coincide, podemos reutilizar TODOS los .o sin recompilar nada. En otro
  // caso, seguimos al pipeline principal que compara por-módulo.
  if (!globalDigestChanged && previousManifest === programFingerprint) {
    // V30.6.1 (H-03): antes de devolver cache hit, verificar que el
    // binario y los .o de los modulos todavia existen en disco. Si se
    // borro el binario (o un .o) conservando el manifest, la compilacion
    // se declaraba exitosa sin generar ejecutable. Ahora regeneramos.
    const binaryStillExists = await fileExists(binaryPath);
    let allObjectsPresent = true;
    for (const module of graph.modules) {
      const identity = computeModuleId(module.file, config.baseDirectory);
      const objPath = join(cacheDir, `${identity.moduleBase}.o`);
      if (!(await fileExists(objPath))) { allObjectsPresent = false; break; }
    }
    if (binaryStillExists && allObjectsPresent) {
      if (options.verbose) progress.log(`Cache hit: huella del programa coincide, todos los .o reutilizados`);
      return {
        compiled: [],
        reused: graph.modules.map(m => m.file),
        linked: false,
        binary: binaryPath,
        header: headerPath,
        durationMs: progress.totalElapsed(),
        cacheResult: "hit",
      };
    }
    if (options.verbose) progress.warn(`Cache hit pero artefactos ausentes (binary=${binaryStillExists}, objects=${allObjectsPresent}); regenerando`);
  }

  // Diagnóstico claro cuando la caché falla por una razón concreta.
  if (previousManifest && previousManifest !== programFingerprint) {
    progress.warn(`Cache miss: huella del programa cambió (anterior ${previousManifest.slice(0, 8)}..., nueva ${programFingerprint.slice(0, 8)}...)`);
  }

  // 4) Regenerar el header + `.cpp` por módulo mediante el pipeline canónico.
  //    Esto vuelve a parsear + chequear tipos + emitir código. Cualquier
  //    diagnóstico se propaga como `DiagnosticError` antes de tocar la
  //    caché, así un error de tipos no deja un `.o` a medias.
  progress.beginPhase("Regenerando .cpp (parse + type-check + codegen)");
  const result = await compileFile(config.entry, {
    moduleRoots: config.moduleRoots,
    aliases: config.aliases,
    baseDirectory: config.baseDirectory,
  });
  await mkdir(dirname(cppPath), { recursive: true });
  // V15: escribimos el header común + un `.cpp` por módulo (modo multi).
  await writeFile(headerPath, result.header, "utf8");
  const compiled: string[] = [];
  const reused: string[] = [];
  // Cacheamos un .o por módulo. La ruta del cache depende SOLO del hash del
  // módulo (.cpp generado), no del digest global. Si runtime/flags cambian,
  // invalidamos TODOS los caches abajo (`globalDigestChanged`).
  // V30.6.1 (H-01): nombre estable derivado de la ruta completa + hash,
  // no del basename. Antes `src/users/index.ts` y `src/admin/index.ts`
  // colisionaban en `index.cpp/index.o/index.manifest`.
  const moduleIdentities = result.modules.map(m => computeModuleId(m.name, config.baseDirectory));
  assertUniqueIdentities(moduleIdentities);
  const moduleIdByName = new Map(moduleIdentities.map(id => [id.file, id]));
  for (const module of result.modules) {
    const identity = moduleIdByName.get(module.name);
    if (!identity) throw new Error(`Identidad no encontrada para ${module.name}`);
    const moduleBase = identity.moduleBase;
    const moduleCppPath = join(dirname(cppPath), `${moduleBase}.cpp`);
    const moduleObjectPath = join(cacheDir, `${moduleBase}.o`);
    const moduleManifestPath = join(cacheDir, `${moduleBase}.manifest`);
    await writeFile(moduleCppPath, module.cpp, "utf8");
    if (options.verbose) progress.log(`${moduleBase}.cpp escrito (${Buffer.byteLength(module.cpp).toLocaleString()} bytes)`);
    const moduleCppHash = createHash("sha256").update(module.cpp).digest("hex").slice(0, 16);
    const previousModuleManifest = await readFile(moduleManifestPath, "utf8").catch(() => "");
    const objectExists = await fileExists(moduleObjectPath);
    // Reutilizamos el .o SOLO si (a) el hash del .cpp no cambió Y (b) el
    // digest global no cambió. Si runtime o flags cambiaron, todo a la basura.
    if (!globalDigestChanged && previousModuleManifest === moduleCppHash && objectExists) {
      reused.push(module.name);
      if (options.verbose) progress.log(`Reutilizado ${moduleBase}.o (manifest coincide)`);
      continue;
    }
    // Compilamos este módulo a .o.
    progress.beginPhase(`Compilando ${moduleBase}.cpp → ${moduleBase}.o`);
    const compileArgs = [
      ...config.compiler.flags,
      `-I${config.baseDirectory}`,
      `-I${compilerRoot}`,
      `-I${dirname(headerPath)}`,
      "-c",
      moduleCppPath,
      "-o",
      moduleObjectPath,
    ];
    try { await runNative(config.compiler.command, compileArgs); }
    catch (error) { throw new Error(`Falló la compilación de ${moduleCppPath} a objeto:\n${error instanceof Error ? error.message : String(error)}\nSugerencia: revisa que las flags de compilación en estatic.config.ts sean correctas y que runtime/ esté accesible.`); }
    await writeFile(moduleManifestPath, moduleCppHash, "utf8");
    compiled.push(module.name);
  }
  if (options.verbose) progress.log(`${compiled.length} módulo(s) compilado(s), ${reused.length} reutilizado(s)`);

  // 5) Enlazar TODOS los .o al binario. Si ya tenemos un binario cacheado
  // válido (mismo fingerprint del programa entero), podríamos reusarlo, pero
  // por simplicidad siempre re-enlazamos cuando hay cambios.
  const linkFlagsChanged = previousManifest !== "" && previousManifest !== programFingerprint;
  let linked = false;
  const binaryExists = await fileExists(binaryPath);
  const allObjects = result.modules.map(module => {
    const identity = moduleIdByName.get(module.name);
    if (!identity) throw new Error(`Identidad no encontrada para ${module.name} (link)`);
    return join(cacheDir, `${identity.moduleBase}.o`);
  });
  if (!binaryExists || linkFlagsChanged || compiled.length > 0) {
    progress.beginPhase(`Enlazando binario (${config.compiler.command})`);
    // V30.6.0: deteccion declarativa desde el AST, no escaneo de
    // includes del cpp. Cubre libuv, tls y curl con una sola fuente de
    // verdad (runtime-backends.ts) y elimina la heuristica fragil.
    const needsLibuv = result.runtimeBackends.libuv;
    const needsTls   = result.runtimeBackends.tls;
    const needsCurl  = result.runtimeBackends.curl;
    const tlsLibraries  = needsTls  ? ["-lssl", "-lcrypto"] : [];
    const curlLibraries = needsCurl ? ["-lcurl"] : [];
    const runtimeObjDir = join(compilerRoot, "build");
    const libuvObjectPaths = [
      join(runtimeObjDir, "runtime_ets_libuv.o"),
      join(runtimeObjDir, "runtime_ets_net_libuv.o"),
    ];
    const libuvObjects = needsLibuv ? libuvObjectPaths.filter(p => existsSync(p)) : [];
    const libuvLinkArgs = libuvObjects.length > 0 ? [...libuvObjects, "-luv"] : (needsLibuv ? ["-luv"] : []);
    const linkArgs = [
      ...config.compiler.flags.filter(flag => flag !== "-c" && flag !== "-flto" && !flag.startsWith("-Wl,")),
      ...allObjects,
      "-o", binaryPath,
      ...config.compiler.linkFlags,
      ...config.linkLibraries.map(lib => lib.startsWith("-") ? lib : `-l${lib}`),
      ...tlsLibraries,
      ...curlLibraries,
      ...libuvLinkArgs,
    ];
    await mkdir(dirname(binaryPath), { recursive: true });
    try { await runNative(config.compiler.command, linkArgs); }
    catch (error) { throw new Error(`Falló el enlazado de ${binaryPath}:\n${error instanceof Error ? error.message : String(error)}\nSugerencia: revisa linkFlags y linkLibraries en estatic.config.ts.`); }
    linked = true;
  } else if (options.verbose) {
    progress.log(`Enlace reutilizado (binario ${binaryPath} ya válido)`);
  }

  await writeFile(manifestPath, programFingerprint, "utf8");

  // Resumen final con tamaño del binario.
  let binarySize = 0;
  try { binarySize = (await stat(binaryPath)).size; } catch { /* binario no existe */ }
  if (options.verbose) progress.log(`Binario: ${binaryPath} (${binarySize.toLocaleString()} bytes)`);

  return {
    compiled,
    reused,
    linked,
    binary: binaryPath,
    header: headerPath,
    durationMs: progress.totalElapsed(),
    cacheResult: compiled.length === 0 && !linked ? "hit" : (reused.length > 0 ? "partial" : "miss"),
  };
}