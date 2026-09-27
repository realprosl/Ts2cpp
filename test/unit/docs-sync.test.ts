// Test de sincronización docs ↔ código.
//
// Ejecuta scripts/check-docs-sync.ts y verifica que pasa. Si falla, el
// test falla con el mismo mensaje que el script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("docs-sync: LIMITATIONS.md coherente con el código", () => {
  const result = spawnSync(
    "node",
    ["--experimental-strip-types", "scripts/check-docs-sync.ts"],
    { encoding: "utf-8" },
  );
  // El script imprime a stdout cuando pasa, a stderr cuando falla.
  // Lo mostramos en el mensaje de error del test para que se vea claro.
  assert.equal(
    result.status,
    0,
    `check-docs-sync falló:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
  // Sanity: la salida en éxito debe contener la marca de verificación.
  assert.match(result.stdout, /✓ check-docs-sync/);
});
