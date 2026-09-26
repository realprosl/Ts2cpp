import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface NativeCompilerConfig {
  enabled?: boolean;
  command?: string;
  flags?: string[];
  linkFlags?: string[];
}

export interface IncrementalConfig {
  enabled?: boolean;
  cacheDirectory?: string;
  generatedDirectory?: string;
}

export interface LoggingConfig {
  enabled?: boolean;
  file?: string;
  level?: "debug" | "info" | "error";
}

export interface EstaticConfig {
  entry: string;
  moduleRoots?: string[];
  aliases?: Record<string, string>;
  output?: { cpp?: string; binary?: string };
  linkLibraries?: string[];
  compiler?: NativeCompilerConfig;
  incremental?: IncrementalConfig;
  logging?: LoggingConfig;
}

export interface ResolvedConfig extends EstaticConfig {
  configFile?: string;
  baseDirectory: string;
  entry: string;
  moduleRoots: string[];
  aliases: Record<string, string>;
  output: { cpp: string; binary: string };
  linkLibraries: string[];
  compiler: Required<NativeCompilerConfig>;
  incremental: Required<IncrementalConfig>;
  logging: Required<LoggingConfig>;
}

export async function findConfig(start = process.cwd()): Promise<string | undefined> {
  const candidate = resolve(start, "estatic.config.ts");
  try { await access(candidate); return candidate; } catch { return undefined; }
}

export async function loadConfig(configFile?: string): Promise<ResolvedConfig | undefined> {
  const selected = configFile ? resolve(configFile) : await findConfig();
  if (!selected) return undefined;
  const imported = await import(`${pathToFileURL(selected).href}?version=${Date.now()}`);
  const value = imported.default as EstaticConfig;
  if (!value || typeof value.entry !== "string") throw new Error(`La configuración ${selected} necesita 'entry'`);
  const baseDirectory = dirname(selected);
  const cpp = resolve(baseDirectory, value.output?.cpp ?? "build/app.cpp");
  const binary = resolve(baseDirectory, value.output?.binary ?? "build/app");
  return {
    ...value, configFile: selected, baseDirectory,
    entry: resolve(baseDirectory, value.entry),
    moduleRoots: (value.moduleRoots ?? []).map(root => resolve(baseDirectory, root)),
    aliases: Object.fromEntries(Object.entries(value.aliases ?? {}).map(([name, target]) => [name, resolve(baseDirectory, target)])),
    output: { cpp, binary },
    linkLibraries: value.linkLibraries ?? [],
    compiler: {
      enabled: value.compiler?.enabled ?? false,
      command: value.compiler?.command ?? "g++",
      flags: value.compiler?.flags ?? ["-std=c++20", "-O2", "-pthread", "-fno-exceptions", "-ffunction-sections", "-fdata-sections"],
      linkFlags: value.compiler?.linkFlags ?? ["-Wl,--gc-sections", "-Wl,--as-needed", "-s"]
    },
    incremental: {
      enabled: value.incremental?.enabled ?? true,
      cacheDirectory: resolve(baseDirectory, value.incremental?.cacheDirectory ?? "build/.estatic/cache"),
      generatedDirectory: resolve(baseDirectory, value.incremental?.generatedDirectory ?? "build/.estatic/generated")
    },
    logging: {
      enabled: value.logging?.enabled ?? true,
      file: resolve(baseDirectory, value.logging?.file ?? "build/.estatic/transpiler-report.json"),
      level: value.logging?.level ?? "debug"
    }
  };
}
