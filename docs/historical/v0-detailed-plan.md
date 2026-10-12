# V0 — Plan de ejecución detallado

Plan paso a paso para V0.1-V0.4, con archivos a tocar, transformaciones y criterios de aceptación.

## Principio

Antes de V0, el codegen trabaja sobre strings. V0 lleva la información al AST. Esto desbloquea V1-V10.

No hay cambios funcionales visibles. Suite sigue verde durante todo el refactor.

---

## V0.1 — Anotar AST con `resolvedType`

### Diagnóstico

`src/semantic/type-checker.ts` mantiene:
```ts
private types = new Map<ASTNode, TypeName>();
```

`TypeName` es un `string`. El codegen lo parsea con `genericBase(type)`, `genericArguments(type)`, `isUnionType(type)` para hacer decisiones.

Problema: si el tipo es `Result<string, IOError>`, hay que parsearlo como string. Si es un genérico anidado (`Optional<Result<string, IOError>>`), se complica.

### Objetivo

Cada `Expression` lleva su `resolvedType: ResolvedType` como propiedad del nodo. `ResolvedType` es una unión discriminada (no string).

### Archivos a tocar

| Archivo | Cambio |
|---|---|
| `src/ast/nodes.ts` | Añadir `resolvedType?: ResolvedType` al tipo `Expression` (o a una interfaz base). Definir `ResolvedType`. |
| `src/types/type-system.ts` | Añadir definición de `ResolvedType` con helpers de acceso (`unwrap`, `classOf`, etc.). |
| `src/semantic/type-checker.ts` | Reemplazar `this.types.set(node, typeName)` por `node.resolvedType = toResolvedType(typeName)`. Reemplazar lookups por acceso directo. |
| `src/codegen/cpp-generator.ts` | Reemplazar `this.checker.typeOf(expr)` por `expr.resolvedType` cuando esté disponible; mantener fallback transitorio. |
| `src/semantic/helpers.ts` | Ningún cambio (los metadatos siguen iguales). |

### Tipo `ResolvedType`

```ts
// src/types/type-system.ts
export type ResolvedType =
  | { kind: "primitive"; name: "number" | "string" | "boolean" | "void" }
  | { kind: "class"; name: string; substitutions: Map<string, ResolvedType> }
  | { kind: "generic"; base: string; args: ResolvedType[] }  // Optional<T>, Task<T>, Result<T,E>, Array<T>, Map<K,V>, Set<T>
  | { kind: "array"; element: ResolvedType; size?: number }   // size opcional para [T; N] (V4)
  | { kind: "function"; params: ResolvedType[]; returns: ResolvedType }
  | { kind: "union"; members: ResolvedType[] }
  | { kind: "taggedUnion"; tag: string; cases: Map<string, { fields: Map<string, ResolvedType> }> }  // V1
  | { kind: "any" };  // solo cuando se permite (no en V0.1)
```

### Conversión de `TypeName` a `ResolvedType`

```ts
function toResolvedType(typeName: TypeName): ResolvedType {
  if (isPrimitive(typeName)) return { kind: "primitive", name: typeName };
  if (isUnionType(typeName)) return { kind: "union", members: unionMembers(typeName).map(toResolvedType) };
  if (isGenericType(typeName)) {
    const base = genericBase(typeName);
    const args = genericArguments(typeName).map(toResolvedType);
    return { kind: "generic", base, args };
  }
  return { kind: "class", name: typeName, substitutions: new Map() };
}
```

### Cambios en `cppType`

```ts
// ANTES (en src/codegen/cpp-types.ts)
export function cppType(type: TypeName): string {
  if (isGenericType(type)) {
    const base = genericBase(type);  // string parse
    if (base === "Promise") return "ets::Task<...>";
    // ...
  }
  // ...
}

// DESPUÉS
export function cppType(type: ResolvedType | TypeName): string {
  if (typeof type === "string") type = toResolvedType(type);  // transición
  switch (type.kind) {
    case "primitive": return cppPrimitive(type.name);
    case "generic":
      if (type.base === "Promise") return `ets::Task<${type.args.map(cppType).join(", ")}>`;
      // ...
      return `${type.base}<${type.args.map(cppType).join(", ")}>`;
    case "class": return type.name;
    // ...
  }
}
```

### Criterios de done

- [ ] Todos los tests existentes (138 unit + 49 E2E) siguen verdes sin cambios.
- [ ] `grep -n "this.types.set" src/semantic/type-checker.ts` retorna 0 ocurrencias (salvo comentarios).
- [ ] `grep -n "this.types.get" src/semantic/type-checker.ts` retorna 0 ocurrencias (salvo comentarios).
- [ ] `grep -n "isGenericType\|genericBase\|genericArguments" src/codegen/cpp-types.ts` se reduce a las funciones de conversión (no en `cppType` mismo).

### Riesgo

Medio. Hay que mantener compatibilidad con código que asume `TypeName` string durante la transición. Estrategia: `cppType` acepta `ResolvedType | TypeName` y convierte strings cuando vienen del checker. Cuando todo el checker use `resolvedType`, se elimina el fallback.

---

## V0.2 — Atributos en `Symbol`

### Diagnóstico

`src/codegen/cpp-generator.ts` línea 35:
```ts
private readonly runtimeGlobals = new Set(["console", "fs", "path", "process", "JSON"]);
```

Línea 124:
```ts
const cppName = this.runtimeGlobals.has(variable.name)
  ? (this.localRenames.set(variable.name, `ets_local_${variable.name}`), `ets_local_${variable.name}`)
  : variable.name;
```

Decisión por string-match. Si el user declara `const fs = ...`, el codegen lo renombra.

### Objetivo

Los `VariableSymbol` saben si vienen del runtime, su modo de paso, su tipo de ownership, etc.

### Archivos a tocar

| Archivo | Cambio |
|---|---|
| `src/semantic/symbols.ts` | Extender `VariableSymbol` con campos opcionales (`fromRuntime`, `passing`, `ownership`, etc.). |
| `src/semantic/type-checker.ts` | Marcar `fromRuntime` cuando se define una variable que colisiona con un global del runtime. |
| `src/codegen/cpp-generator.ts` | Eliminar `runtimeGlobals: Set<string>`. Consumir `symbol.fromRuntime`. |

### Extensión de `VariableSymbol`

```ts
export interface VariableSymbol {
  kind: "variable";
  name: string;
  type: TypeName;
  mutable: boolean;
  variadic?: boolean;
  // Nuevos:
  fromRuntime?: boolean;  // nombre colisiona con global del runtime (console, fs, path, ...)
  passing?: "in" | "out" | "mut" | "move";  // modo de paso (V0.2 ya tiene 'out' y 'mut')
  ownership?: "value" | "unq" | "rc";  // cómo se gestiona la memoria
}
```

### Cambios en codegen

```ts
// ANTES
const cppName = this.runtimeGlobals.has(variable.name) ? `ets_local_${variable.name}` : variable.name;

// DESPUÉS
const symbol = this.lookupSymbol(variable.name);
const cppName = symbol?.fromRuntime ? `ets_local_${variable.name}` : variable.name;
```

### Criterios de done

- [ ] Tests verdes.
- [ ] `grep -n "runtimeGlobals" src/codegen/` retorna 0 ocurrencias.

### Riesgo

Bajo. Es un refactor directo: leer atributo en vez de string-match.

---

## V0.3 — Includes por visitor, no por regex

### Diagnóstico

`src/codegen/cpp-generator.ts` líneas 80-82:
```ts
private usesTls(program: Program): boolean {
  return /\b(?:TlsContext|TlsConnection|createTlsServer|acceptTls|readTls|writeTls|closeTls)\b/.test(JSON.stringify(program));
}
```

Serializa el AST entero a JSON, pasa regex, decide includes. Pierde estructura.

### Objetivo

Visitor que recorre el AST preguntando a cada `CallExpression` qué helper global invoca. `Set<RuntimeModule>` se construye por estructura.

### Archivos a tocar

| Archivo | Cambio |
|---|---|
| `src/codegen/cpp-generator.ts` | Reemplazar `usesTls` y `usesCompilerAst` por `needsIncludes(program): Set<RuntimeModule>`. |
| `src/runtime-modules.ts` (nuevo) | Tabla centralizada de `RuntimeModule` y helpers. |
| `src/semantic/helpers.ts` | Añadir `requires: RuntimeModule[]` a cada helper (preparación para V0.4). |

### Visitor

```ts
// src/codegen/cpp-generator.ts
private needsIncludes(program: Program): Set<RuntimeModule> {
  const modules = new Set<RuntimeModule>();
  walkProgram(program, node => {
    if (node.kind === "CallExpression" && isGlobalHelper(node.callee)) {
      const helperModule = HELPER_RUNTIME_MODULE[node.callee];
      if (helperModule) modules.add(helperModule);
    }
    // También si una variable se usa con un nombre de runtime
  });
  return modules;
}
```

### Criterios de done

- [ ] Tests verdes.
- [ ] `grep -n "JSON.stringify(program)" src/` retorna 0 ocurrencias.
- [ ] El conjunto de includes para un programa dado es **idéntico** al que producía el regex. Verificar con un test de snapshot sobre `examples/un-demo.ets`, `examples/http-server.ets`, `examples/syntax-tree-demo.ets`.

### Riesgo

Medio. La equivalencia exacta con el regex es delicada. Plan: implementar el visitor, comparar su output contra el regex sobre TODOS los ejemplos. Cuando coincidan 100%, eliminar el regex.

---

## V0.4 — Helpers declaran su módulo runtime

### Diagnóstico

`HELPER_METADATA` solo tiene `minParams`, `returnsGeneric`, `returnsRef`. No sabe qué include necesita cada helper.

### Objetivo

Cada helper declara `requires: RuntimeModule[]`.

### Archivos a tocar

| Archivo | Cambio |
|---|---|
| `src/semantic/helpers.ts` | Añadir `requires: RuntimeModule[]` a cada helper. |
| `src/runtime-modules.ts` | Definir `RuntimeModule` como unión cerrada. |

### Tipo `RuntimeModule`

```ts
// src/runtime-modules.ts
export type RuntimeModule =
  | "ets_async"
  | "ets_file"
  | "ets_net"
  | "ets_tls"
  | "ets_ast"
  | "ets_process"
  | "ets_optional"
  | "ets_rc"
  | "ets_unq";

export const RUNTIME_INCLUDES: Record<RuntimeModule, string> = {
  ets_async: "runtime/ets_async.hpp",
  ets_file: "runtime/ets_file.hpp",
  ets_net: "runtime/ets_net.hpp",
  ets_tls: "runtime/ets_tls.hpp",
  ets_ast: "runtime/ets_ast.hpp",
  ets_process: "runtime/ets_process.hpp",
  ets_optional: "runtime/ets_optional.hpp",
  ets_rc: "runtime/ets_rc.hpp",
  ets_unq: "runtime/ets_unq.hpp",
};
```

### Cambios en `HELPER_METADATA`

```ts
export const HELPER_METADATA: Record<string, HelperInfo> = Object.assign(Object.create(null), {
  optionalSome:      { minParams: 1, returnsGeneric: true, requires: ["ets_optional"] },
  optionalNone:      { minParams: 0, returnsGeneric: true, requires: ["ets_optional"] },
  optionalIsPresent: { minParams: 1, requires: ["ets_optional"] },
  optionalValueOr:   { minParams: 2, requires: ["ets_optional"] },
  // ...
  unSome:            { minParams: 1, returnsGeneric: true, requires: ["ets_unq"] },
  // ...
  rcShare:           { minParams: 1, returnsGeneric: true, requires: ["ets_rc"] },
  // ...
  tcpListen:         { minParams: 2, requires: ["ets_net"] },  // nuevo en Bloque C
  tcpAccept:         { minParams: 1, requires: ["ets_net"] },
  tcpRead:           { minParams: 2, requires: ["ets_net"] },
  tcpWrite:          { minParams: 2, requires: ["ets_net"] },
  tcpClose:          { minParams: 1, requires: ["ets_net"] },
  fileRead:          { minParams: 1, requires: ["ets_file"] },
  fileWrite:         { minParams: 2, requires: ["ets_file"] },
  // ...
});
```

### Criterios de done

- [ ] Tests verdes.
- [ ] `needsIncludes()` consume `HELPER_METADATA` completamente.
- [ ] Ningún helper con `requires` faltante.

### Riesgo

Bajo. Es metadatos puros.

---

## Orden de ejecución

1. **V0.1** solo. Commit. Verificar suite. PR.
2. **V0.2** solo. Commit. Verificar suite. PR.
3. **V0.3** solo. Commit. Verificar suite con snapshot test. PR.
4. **V0.4** solo. Commit. Verificar suite. PR.

Cada V0.X es **backward compatible** durante la transición (mantiene fallback a string-match mientras convive). Eliminar el fallback solo cuando el nuevo código está estable.

## Tiempo estimado

- V0.1: 2-3 horas (más complejo).
- V0.2: 30 min.
- V0.3: 1 hora (más el snapshot test).
- V0.4: 30 min.

Total V0: ~5 horas, ejecutado en serie.
