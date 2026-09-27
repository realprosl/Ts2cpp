# `src/` — el transpilador

Implementación canónica y única del transpilador Estatic. Todo es TypeScript sin
dependencias npm: se ejecuta con `node --experimental-strip-types`.

## Punto de entrada

- **`cli.ts`** — Entry point. Despacha `init`, modo unitario y modo `buildIncremental`.
- **`compiler.ts`** — Fachada de un solo módulo: `parse → analyze → generate`.

## Estructura

```
src/
├── lexer/                texto → tokens
│   ├── lexer.ts          lexer manual (soporta templates ${...} y "delete")
│   └── token.ts          ~30 TokenKinds + tabla KEYWORDS
├── parser/               tokens → AST
│   └── parser.ts         recursive-descent con diagnósticos acumulados
├── ast/                  contratos neutrales (nodes.ts)
├── types/                álgebra de tipos — TypeName es un string
│   └── type-system.ts    helpers para arrays, tuplas, generics, uniones, intersecciones
├── semantic/             type-checker
│   ├── type-checker.ts   visitor recursivo explícito; memoización por WeakMap
│   └── symbols.ts        scopes encadenados + tabla de símbolos
├── modules/              grafo de imports
│   ├── module-loader.ts  carga topológica, alias, moduleRoots, .ts/.ets
│   └── module-visibility.ts valida `export`/`import`
├── codegen/              AST → C++
│   ├── cpp-generator.ts  CppGenerator: concepts, structs, templates, coroutines
│   ├── cpp-types.ts      tabla TypeName → C++ (Promise→Task, Result, Map/Set…)
│   └── cpp-parameters.ts reglas out/mut/move/automatic
├── build/                compilador incremental
│   └── incremental-builder.ts  cabecera común + .cpp por módulo + cache SHA-256
├── config/               carga de estatic.config.ts
│   └── project-config.ts EstaticConfig + ResolvedConfig + defaults
├── project/              scaffolding
│   └── init-project.ts   `estatic init [dir]`
├── core/                 tipos comunes
│   ├── span.ts           Span + Position
│   ├── diagnostic.ts     DiagnosticError + formatDiagnostic
│   └── build-logger.ts   transpiler-report.json incremental
├── tools/                CLIs auxiliares expuestos en `package.json` bin
│   ├── lexer.ts          `estatic-lexer`
│   ├── parser.ts         `estatic-parser`
│   ├── semantic.ts       `estatic-semantic`
│   ├── codegen.ts        `estatic-codegen`
│   ├── format.ts         `estatic-format`
│   └── doc.ts            `estatic-doc`
└── compiler.ts           fachada `compile(source)`
```

## Flujo

```
.ets / .ts
   │
   ▼  lexer/
tokens
   │
   ▼  parser/
AST (Program)
   │
   ▼  semantic/
AST + tipos por expresión + diagnósticos
   │
   ▼  codegen/
.cpp + cabecera común (incremental) o un solo .cpp (unitario)
   │
   ▼  g++ por módulo (cache por SHA-256)
binario
```

## Cómo tocar el código

- **Nueva palabra del lenguaje** → `token.ts` (kind + keyword) + `parser.ts`
  (parsear) + `type-checker.ts` (validar) + `cpp-generator.ts` (emitir).
- **Nuevo builtin de runtime** → `runtime/*.hpp` + tabla en `type-checker.ts:124-211`.
- **Nueva opción de config** → `project-config.ts` (`EstaticConfig` + `ResolvedConfig`)
  + sitio de uso (cli.ts/incremental-builder.ts).

## Verificación de documentación

`scripts/check-docs-sync.ts` cruza automáticamente el estado del código
con `LIMITATIONS.md`. Detecta:

- **Contradicciones** — el doc marca X como rechazado pero X existe como
  nodo AST, keyword, TokenKind o ejemplo.
- **Referencias rotas** — el doc menciona `examples/<name>.ets` pero el
  archivo no existe.

Ejecutar manualmente:

```bash
node --experimental-strip-types scripts/check-docs-sync.ts
```

El test `test/unit/docs-sync.test.ts` lo invoca automáticamente en
`npm test`. Si añades un nodo AST o keyword nuevo, ejecuta el check
manualmente y actualiza `LIMITATIONS.md` si reporta problemas.

## Lo que NO está aquí

- Runtime C++ → `runtime/`.
- Gramática para editores → `editors/tree-sitter-estatic/`.
- Programas de prueba → `examples/`.
- Cabeceras C++ que consume el código generado.
