// Lee la version de Ts2cpp desde package.json del compiler root.
//
// Se cachea despues de la primera lectura (la mayoria de builds son de
// la misma version; no necesitamos leer package.json cada vez).
//
// Usado por V25 Fase 5 para calcular el hash del cache global de
// runtime .o cacheados en ~/.cache/etsc/runtime/<version>/.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src/core/ts2cpp-version.ts → ../../package.json
const pkgPath = resolve(here, "..", "..", "package.json");

let cached: string | undefined;

export function getTs2cppVersion(): string {
  if (cached !== undefined) return cached;
  if (!existsSync(pkgPath)) {
    cached = "unknown";
    return cached;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}