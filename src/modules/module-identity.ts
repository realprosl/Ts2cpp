// src/modules/module-identity.ts — Identidad estable de un módulo.
//
// V30.6.1: H-01/H-02 del informe de revision tecnica (2026-10-12).
// El nombre de archivo estable NO puede derivarse solo del basename
// porque dos archivos `index.ts` en carpetas distintas colisionan
// (index.cpp / index.o / index.manifest / ets_init_index). Tampoco
// vale sustituir caracteres no-ASCII por `_` porque `a-b.ts` y
// `a_b.ts` colisionan.
//
// Regla: derivar el nombre de la ruta completa normalizada, hasheada
// para evitar colisiones de caracteres C++-inseguros y para mantener
// longitud acotada.
//
// Uso:
//   const id = computeModuleId("/abs/path/to/src/users/index.ts", "/abs/path/to");
//   // id.moduleBase = "users_index_<hash8>"  -> nombre de archivo estable
//   // id.initName   = "ets_init_users_index_<hash8>"
//   // id.cacheKey   = "users_index_<hash8>"   -> para .o / .manifest
//   // id.uniqueId   = "users_index_<hash8>"   -> mismo, alias semantico
//
// Si dos archivos tuvieran el mismo id (colision en el hash), el codigo
// que llama debe detectarlo con un Set antes de empezar el build.

import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export interface ModuleIdentity {
  /** Ruta canónica del archivo (realpath). */
  file: string;
  /** Ruta relativa a `baseDirectory` con `/` como separador. */
  relativePath: string;
  /** Identificador único estable: nombre C++-seguro + hash corto. */
  id: string;
  /** Alias de `id`. Mismo valor, para que el codigo sea legible. */
  cacheKey: string;
  /** Nombre de archivo estable (sin extension) para `.cpp` / `.o`. */
  moduleBase: string;
  /** Nombre del inicializador C++ (ets_init_*). */
  initName: string;
  /** Hash corto (16 hex) del path canónico, para diagnosticos. */
  pathHash: string;
}

/**
 * Normaliza una ruta a una representacion canonica estable frente a
 * representaciones equivalentes del mismo archivo (relativas vs
 * absolutas, `./` prefix, separadores Windows/Unix, symlinks).
 * V30.6.2 (P-02 del informe de revision, 2026-10-12).
 *
 * Pasos:
 *  1. `resolve(baseDirectory, file)` para obtener una ruta absoluta.
 *  2. `realpath` para resolver symlinks (best-effort).
 *  3. Normalizar separadores a `/`.
 *
 * Esto garantiza que `./src/a.ts`, `src/a.ts` y `/abs/proj/src/a.ts`
 * produzcan el MISMO hash.
 */
function normalizePath(file: string, baseDirectory: string): { rel: string; abs: string } {
  const resolved = resolve(baseDirectory, file);
  let abs: string;
  try {
    // best-effort: si falla (e.g. el archivo no existe todavia),
    // usamos la ruta resuelta sin realpath.
    abs = realpathSync(resolved);
  } catch {
    abs = resolved;
  }
  abs = abs.split(sep).join("/");
  let rel: string;
  try {
    const r = relative(baseDirectory, abs);
    if (r && !r.startsWith("..") && !isAbsolute(r)) rel = r.split(sep).join("/");
    else rel = basename(abs);
  } catch {
    rel = basename(abs);
  }
  return { rel, abs };
}

export function computeModuleId(file: string, baseDirectory: string): ModuleIdentity {
  const { rel, abs } = normalizePath(file, baseDirectory);
  // Quitar extension
  const withoutExt = rel.replace(/\.(ets|ts)$/, "");
  // Separadores a `_`, caracteres no-C++-seguros a `_`
  const sanitized = withoutExt.replace(/[^A-Za-z0-9_]/g, "_");
  // Hash corto de la ruta absoluta (no de la relativa, para detectar
  // movimientos entre carpetas con la misma ruta relativa).
  const pathHash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
  const id = `${sanitized}_${pathHash}`;
  return {
    file: abs,
    relativePath: rel,
    id,
    cacheKey: id,
    moduleBase: id,
    initName: `ets_init_${id}`,
    pathHash,
  };
}

/**
 * Verifica que un conjunto de identidades no tiene colisiones.
 * Lanza `Error` si dos módulos diferentes tienen el mismo `id`.
 */
export function assertUniqueIdentities(identities: ModuleIdentity[]): void {
  const seen = new Map<string, string>();
  for (const identity of identities) {
    const existing = seen.get(identity.id);
    if (existing) {
      throw new Error(
        `Colision de identidad de modulo:\n` +
        `  ${identity.id} <- ${identity.file}\n` +
        `  ${identity.id} <- ${existing}\n` +
        `Esto no deberia ocurrir (la identidad incluye un hash del path). ` +
        `Probablemente hay un bug en computeModuleId o un filesystem ` +
        `que normaliza rutas distintas al mismo realpath.`
      );
    }
    seen.set(identity.id, identity.file);
  }
}
