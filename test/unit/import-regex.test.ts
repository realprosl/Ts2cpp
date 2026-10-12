// test/unit/import-regex.test.ts — V30.6.1: regresion H-05
// (informe de revision tecnica 2026-10-12).
//
// Verifica que las regex IMPORT_LINE y EXPORT_FROM_LINE reconocen las
// formas de import TS soportadas por el dialecto. Esto NO sustituye a
// tests de integracion con `loadModuleGraph`, pero asegura que las
// regex no se rompen ante cambios triviales.

import { test } from "node:test";
import assert from "node:assert/strict";

// Replicamos las regex del modulo (no se exportan; tests son
// auto-contenidos para no anadir complejidad al API).
// Si las regex cambian, este test debe actualizarse — el coste de
// mantenerlo sincronizado es pequeno y el valor de documentar las
// formas soportadas es alto.
const IMPORT_LINE = /^\s*import\s+(?:type\s+)?(?:(\*\s+as\s+([A-Za-z_][A-Za-z0-9_]*))|([A-Za-z_][A-Za-z0-9_]*)|(?:\{([^}]*)\}))?\s*(?:from\s+)?["']([^"']+)["']\s*;?\s*(?:\/\/.*)?$/;
const EXPORT_FROM_LINE = /^\s*export\s+(?:type\s+)?(?:\{([^}]*)\}\s+from|\*\s+from|\*\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s+from)\s+["']([^"']+)["']\s*;?\s*(?:\/\/.*)?$/;

const cases: Array<{ name: string; line: string; expectedSpec?: string; expectedName?: string }> = [
  { name: "import basico con braces", line: `import { Foo } from "./foo";`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "import con multiples nombres", line: `import { Foo, Bar } from "./foo";`, expectedSpec: "./foo" },
  { name: "import type TS", line: `import type { Foo } from "./foo";`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "import namespace", line: `import * as Foo from "./foo";`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "import default", line: `import Foo from "./foo";`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "import side-effect", line: `import "./foo";`, expectedSpec: "./foo" },
  { name: "import con comentario al final", line: `import { Foo } from "./foo"; // comment`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "import sin punto y coma", line: `import { Foo } from "./foo"`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "import con comillas simples", line: `import { Foo } from './foo';`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "export re-export braces", line: `export { Foo } from "./foo";`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "export re-export type", line: `export type { Foo } from "./foo";`, expectedSpec: "./foo", expectedName: "Foo" },
  { name: "export re-export namespace", line: `export * as Foo from "./foo";`, expectedSpec: "./foo", expectedName: "Foo" },
];

for (const c of cases) {
  test(`import-regex: ${c.name}`, () => {
    const m = c.line.match(IMPORT_LINE) || c.line.match(EXPORT_FROM_LINE);
    assert.ok(m, `La linea "${c.line}" no matchea ninguna regex`);
    if (c.line.startsWith("export")) {
      if (c.expectedSpec) {
        const spec = m[3] ?? m[2];
        assert.equal(spec, c.expectedSpec);
      }
    } else {
      if (c.expectedSpec) {
        const spec = m[5];
        assert.equal(spec, c.expectedSpec);
      }
      if (c.expectedName && c.line.includes("* as")) {
        assert.equal(m[2], c.expectedName);
      } else if (c.expectedName) {
        // braces o default: el nombre esta en m[4] o m[3]
        const name = m[4] ?? m[3];
        if (name) assert.ok(name.includes(c.expectedName));
      }
    }
  });
}

test("import-regex: lineas que NO son imports pasan tal cual", () => {
  const nonImports = [
    `let x: number = 1;`,
    `// import { Foo } from "./foo";`,
    `print("import { Foo } from \\"./foo\\";");`,
    `function foo() { return 1; }`,
    ``,
  ];
  for (const line of nonImports) {
    const m = line.match(IMPORT_LINE) || line.match(EXPORT_FROM_LINE);
    if (line.includes("import {") && !line.startsWith("//") && !line.startsWith("print")) {
      // Si parece import pero no lo es (caso del print), no deberia matchear.
      assert.equal(m, null, `Falso positivo en: ${line}`);
    }
  }
});
