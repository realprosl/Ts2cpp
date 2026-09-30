# V1 — Plan de ejecución detallado

Plan paso a paso para cerrar el issue #34 "V1 — Tagged unions + narrowing".
Cubre el tramo final del milestone V1 que ya tiene V1.1 (AST), V1.2
(constructores `Union<T>.Variant`) y V1.3 (print legible + `operator==`)
mergeadas.

## Principio

V1 ya tiene la **infraestructura** de tagged unions (`UnionDeclaration`,
`UnionVariant`, `union X = A | B(T);`, constructores `Union.Ok(...)`,
match exhaustivo con `case { kind: "V", bindings }:`). Falta cerrar el
bucle de **narrowing** en flujo de control y reescribir `Result<T,E>`
como type alias real para reemplazar el wrapper `ets::Result<T>` del
runtime.

No hay cambios funcionales visibles fuera de los nuevos casos cubiertos.
Suite debe seguir verde durante el refactor.

---

## Diagnóstico del estado actual

### Lo que YA está (V1.1 / V1.2 / V1.3 mergeadas)

- `UnionDeclaration` y `UnionVariant` en `src/ast/nodes.ts`.
- Parser `union X<T> = A | B(T);` en `src/parser/parser.ts`.
- Checker registra uniones en `this.unions`, anota `resolvedRuntimeType`.
- Codegen emite struct C++ con `enum class X_Kind` + `std::variant<...>`
  + constructores `Ok(...)` / `Err(...)` + `operator<<` + `operator==`
  por discriminador.
- Match exhaustivo V2: `case { kind: "Variant", <bindings> }: <expr>;`
  con verificación estática de cobertura y `case _:` wildcard.

### Lo que FALTA (este issue)

1. **Sintaxis `type` con object literals como variantes**: el plan V1 del
   roadmap dice literalmente
   ```ts
   type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
   type FileError = { kind: "NotFound"; path: string } | ...;
   ```
   Hoy esto se modela con la keyword `union X = Ok(T) | Err(E);` (que
   no encaja con la idea de "type alias" del roadmap). Hay que **añadir
   un parser y checker** que entiendan object literals como variantes y
   las conviertan al mismo `std::variant` del codegen.
2. **Narrowing por discriminador en `if (r.ok)`**: hoy el dialecto
   soporta narrowing solo en `match (x) { case { kind: "V", ... }: ... }`.
   El plan V1 dice `if (result.ok) { result.value } else { result.error }`.
   El narrowing por nombre de campo requiere saber que `r.ok` es
   discriminador y que `r.value` solo existe en la rama verdadera.
3. **Property access narrowado**: una vez estrechado el tipo en la rama,
   `result.value` debe emitir `std::get<index>(r.payload)` directamente
   (no `r.value`, que no existe como campo).
4. **Reescribir `Result<T,E>` como type alias real sin helper custom**:
   hoy `Result<T>` es la clase `ets::Result<T>` (`std::optional<T>` +
   `std::string error`). Hay que reescribirla como type alias real
   (`type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }`)
   para que sea una tagged union nativa del dialecto. El runtime
   conserva `ets::Result<T>` solo si los callers existentes lo requieren
   (ver migración más abajo).

---

## Decisiones de diseño

### Modelar las object-variants

Una object-variant `{ ok: true; value: T }` se traduce a una variant de
UnionDeclaration con:

- nombre: el nombre del campo discriminador (`"Ok"` si el campo es `ok: true`
  literal, o el nombre del variant externo si lo hay).
- payload: el tipo del primer campo no-discriminador (`T`).
- discriminador: el nombre del campo (`"ok"` en el caso anterior) y el
  valor literal (`true`).

Para no romper el AST, **se mantiene `UnionVariant` con su shape actual**
y se añade un campo opcional `discriminator?: { field: string; value: string | boolean | number }`.
El codegen lo consume si está presente (naming field/value-based); si no,
usa el ya existente `name` para el enum (variant-based, V1.1).

### Representación C++

Misma estructura `enum class X_Kind { ... } + std::variant<...>` que ya
emite `unionDeclaration()`. La diferencia:

- El nombre del enum puede ser `X_Kind` (variant name) o `{Field}_Value`
  (discriminator field), pero el C++ interno lo seguimos llamando
  `X_Kind` para no romper el `match` codegen.
- El constructor es `Ok(true_value, T value)` o `{ ok: true, value }`
  literal-positional — el codegen lo decide según la sintaxis fuente.

### Narrowing por discriminador

Para `if (r.ok) { ... } else { ... }`:

- Si `r` es una tagged union (registrada en `unions` o detectada como
  `type Result<...> = ...`) **y** el campo accedido (`r.ok`) es el
  discriminador declarado de la unión, la condición es
  `r.kind == X_Kind::BranchTrue` (rama verdadera) o
  `r.kind != X_Kind::BranchTrue` (rama falsa).
- En la rama verdadera (thenBranch) la unión queda narrowada al variant
  que tiene `discriminator.value === true` (e.g. el Ok). En la rama
  falsa (elseBranch) queda narrowada al resto (e.g. Err).
- El codegen emite cada MemberExpression en cada rama con el payload
  correcto: `r.value` → `std::get<0>(r.payload)`, `r.error` →
  `std::get<1>(r.payload)` (si esas son las variantes estrechas).

### Representación del narrowing en el AST

Para no tocar el AST del checker, **el narrowing vive en el codegen**.
El type-checker no necesita saber qué ramas narrowean qué; basta con que
el codegen sepa:

1. Qué variable es union (resuelto por su tipo declarado).
2. Qué campo es discriminador (declarado en la UnionDeclaration).
3. Qué `if` lo usa como condición.

El codegen lleva un stack de narrowings locales (`Map<name, narrowedKind>`)
durante `emitStatement` y `emitExpression`. Entra al `thenBranch` con el
narrow del valor-verdadero, al `elseBranch` con el resto, y se descartan
al salir del `if`.

### Reescribir Result<T, E>

`Result<T, E>` se reescribe como type alias declarado por el runtime
helper. La forma más limpia es declararlo en el prelude del runtime
mediante un type alias generado por el codegen automáticamente cuando
se detecta el uso de `Result<T>`. Alternativa pragmática (más alineada
con la arquitectura actual): **registrar `Result` como UnionDeclaration
sintética en el type-checker** con dos variantes `Ok(T)` y `Err(E)`
donde el campo discriminador es `ok` con valores `true`/`false`. Esto
encaja con los tests E2E pedidos (`result-ok`, `result-err`,
`narrowing-ok`, `narrowing-err`).

---

## Archivos a tocar

| Archivo | Cambio |
|---|---|
| `src/parser/parser.ts` | Aceptar `{ field: literal; ... }` como variante en `unionDeclaration()`. El discriminador es el primer campo con literal primitivo. |
| `src/ast/nodes.ts` | Añadir `discriminator?: { field: string; value: string \| boolean \| number }` a `UnionVariant`. |
| `src/semantic/type-checker.ts` | Registrar `Result<T, E = string>` como unión sintética (`Ok(T)` / `Err(E)` con discriminador `ok`). Validar que el primer campo de una object-variant sea discriminador y los demás formen el payload. |
| `src/types/type-system.ts` | Helper `isObjectVariantType(type: TypeName): boolean` y `objectVariantFields(type): Map<field, TypeName>` para extraer la metadata del type alias. |
| `src/codegen/cpp-generator.ts` | (a) `unionDeclaration` honra `discriminator` al emitir nombres de variant y el prefijo del Kind enum. (b) `ifStatement` con condición sobre campo discriminador aplica narrowing local. (c) `MemberExpression` consulta el stack de narrowing para emitir `std::get<i>(payload)` cuando el campo no existe literalmente. |
| `runtime/ets_runtime.hpp` | Eliminar o marcar deprecated el `class Result<T>` (mantener para no romper el wrapper mientras V2 lo necesita como puente). |
| `test/e2e/types/result-ok/` | nuevo test E2E: `Result<number>` con caso Ok. |
| `test/e2e/types/result-err/` | nuevo test E2E: `Result<number>` con caso Err. |
| `test/e2e/types/narrowing-ok/` | nuevo test E2E: `if (r.ok) { ... }` accede a `r.value`. |
| `test/e2e/types/narrowing-err/` | nuevo test E2E: `else { ... }` accede a `r.error`. |
| `test/unit/type-checker.test.ts` | añadir tests V1: object-variant en type alias, Result como union sintético, narrowing por discriminador. |
| `test/unit/codegen.test.ts` | añadir tests V1: codegen de union con object-variant, narrowing en if. |
| `docs/v1-detailed-plan.md` | este documento. |

---

## Cambios concretos (orden de implementación)

### 1. AST: añadir `discriminator` a `UnionVariant`

```ts
// src/ast/nodes.ts
export interface UnionVariant {
  name: string;
  payload?: TypeName;
  /** V1.4: campo que actúa como discriminador en object-variants.
   *  Cuando está presente, la sintaxis fuente fue `{ field: value, ... }`
   *  y `name` se infiere del nombre externo (o de `value` si es string). */
  discriminator?: { field: string; value: string | boolean | number };
  span: Span;
}
```

### 2. Parser: aceptar object-variants

```ts
// src/parser/parser.ts dentro de unionDeclaration()
do {
  let variantName = "";
  let payload: TypeName | undefined;
  let discriminator: { field: string; value: string | boolean | number } | undefined;
  if (this.check("{")) {
    // Object-variant: { field: literal; ...<bindings> }
    this.advance();
    const firstField = this.consume("identifier", "Se esperaba un campo");
    this.consume(":", "Se esperaba ':' tras el campo");
    const lit = this.consume("string|number|true|false", "El primer campo debe ser un literal");
    discriminator = { field: firstField.lexeme, value: literalValue(lit) };
    if (lit.kind === "string") variantName = lit.lexeme; // "NotFound" → NotFound
    else variantName = discriminator.field === "ok" ? (lit.kind === "true" ? "Ok" : "Err") : discriminator.field;
    // Campos adicionales opcionales (bindings): `name: T`
    const bindings = new Map<string, TypeName>();
    while (this.match(",")) {
      const b = this.consume("identifier", "Se esperaba un binding");
      this.consume(":", "Se esperaba ':'");
      const t = this.typeName();
      bindings.set(b.lexeme, t);
    }
    this.consume("}", "Se esperaba '}' cerrando la object-variant");
    // Si hay un solo binding, es el payload.
    if (bindings.size === 1) payload = [...bindings.values()][0];
    else if (bindings.size > 1) {
      // Tupla de bindings como payload: emitimos un tipo tupla.
      payload = tupleType([...bindings.values()]);
    }
  } else {
    variantName = this.consume("identifier", "Se esperaba el nombre de la variante").lexeme;
    if (this.match("(")) { payload = this.typeName(); this.consume(")", "Se esperaba ')'"); }
  }
  variants.push({
    name: variantName,
    payload,
    discriminator,
    span: span(/*...*/),
  });
} while (this.match("|"));
```

### 3. Type-checker: registrar `Result<T, E>` como unión sintética

```ts
// src/semantic/type-checker.ts (en el setup global, después de declarar Promise/Optional/...)
// V1.4: `Result<T, E = string>` es una tagged union sintética del runtime
// con dos variantes:
//   { ok: true,  value: T }
//   { ok: false, error: E }
// La modelamos como UnionDeclaration interna para que el codegen la trate
// igual que cualquier tagged union.
const resultUnion: UnionDeclaration = {
  kind: "UnionDeclaration",
  name: "Result",
  exported: true,
  typeParameters: [
    { name: "T", span: syntheticSpan },
    { name: "E", default: "string", span: syntheticSpan },
  ],
  variants: [
    { name: "Ok",  payload: "T", discriminator: { field: "ok", value: true  }, span: syntheticSpan },
    { name: "Err", payload: "E", discriminator: { field: "ok", value: false }, span: syntheticSpan },
  ],
  resolvedRuntimeType: { kind: "passthrough", cppName: "Result" },
  span: syntheticSpan,
};
this.unions.set("Result", resultUnion);
this.aliases.set("Result", { /* no es alias, lo manejamos por unions */ } as any);
```

Y en `validateType`, cuando se ve `Result<T>` o `Result<T, E>`, se valida
contra la unión sintética.

### 4. Codegen: unionDeclaration honra `discriminator`

```ts
// src/codegen/cpp-generator.ts en unionDeclaration()
const variantKindFields = node.variants.map((variant, index) => {
  const name = variant.discriminator
    ? `${variant.name}`  // mismo nombre, el discriminador se aplica en runtime
    : variant.name;
  return `    ${name} = ${index}`;
}).join(",\n");
```

Para la construcción, si el discriminador está presente, el constructor
acepta los argumentos posicionales:

```ts
if (variant.discriminator) {
  // Constructor Ok(T value) o Err(E error) — no cambia la signatura externa.
  return `${tparamSpec} inline ${node.name}${tnamesSpec} ${variant.name}(${payloadType} ${paramName}) { ... }`;
}
```

### 5. Codegen: narrowing en `if`

```ts
// src/codegen/cpp-generator.ts: nueva variable de instancia
private narrowingStack: Map<string, { union: string; thenBranchKind: number; elseBranchKind: number }> = new Map();
private inNarrowedBranch: { name: string; kind: number } | null = null;
```

Cuando entramos al `thenBranch` y la condición es `r.ok` (campo
discriminador), registramos que `r` está narrowada al kind `Ok`. En el
`elseBranch` registramos el kind `Err`. El MemberExpression consulta
`inNarrowedBranch` y emite `std::get<index>(r.payload)` en vez de
`r.field` cuando el campo no existe en el struct C++.

### 6. Codegen: member access narrowado

```ts
case "MemberExpression": {
  // V1.4: si estamos en un if narrowed y el campo no existe como tal
  // en el struct C++, lo emitimos como `std::get<i>(obj.payload)`.
  if (this.inNarrowedBranch && node.object.kind === "IdentifierExpression") {
    const narrowed = this.narrowingStack.get(node.object.name);
    if (narrowed && narrowed.thenBranchKind === this.inNarrowedBranch.kind) {
      const unionNode = this.unionsMap.get(narrowed.union);
      if (unionNode) {
        const variant = unionNode.variants[this.inNarrowedBranch.kind];
        if (variant?.discriminator) {
          // El campo pedido es uno de los bindings del variant narrowado.
          // Si es `value` o `error`, emitimos std::get<i>(obj.payload).
          return `std::get<${this.inNarrowedBranch.kind}>(${node.object.name}.payload)`;
        }
      }
    }
  }
  // ... resto igual ...
}
```

### 7. Tests E2E nuevos

`test/e2e/types/result-ok/`:
```ets
function divide(a: number, b: number): Result<number> {
  if (b == 0) return Err<number>("div by zero");
  return Ok(a / b);
}
const r: Result<number> = divide(10, 2);
if (r.ok) { print("ok=" + numberToString(r.value)); }
```

`test/e2e/types/result-err/`:
```ets
function divide(a: number, b: number): Result<number> {
  if (b == 0) return Err<number>("div by zero");
  return Ok(a / b);
}
const r: Result<number> = divide(10, 0);
if (r.ok == false) { print("err=" + r.error); }
```

`test/e2e/types/narrowing-ok/`:
```ets
function maybe(flag: boolean): Result<string> {
  return flag ? Ok("yes") : Err<string>("no");
}
const r: Result<string> = maybe(true);
if (r.ok) { print("got: " + r.value); } else { print("missing"); }
```

`test/e2e/types/narrowing-err/`:
```ets
function maybe(flag: boolean): Result<string> {
  return flag ? Ok("yes") : Err<string>("no");
}
const r: Result<string> = maybe(false);
if (r.ok) { print("got: " + r.value); } else { print("err: " + r.error); }
```

---

## Criterios de done

- [ ] `type X = { kind: "A"; p: string } | { kind: "B"; q: number };` se
  parsea como UnionDeclaration con object-variants y discriminadores.
- [ ] `if (r.ok) { r.value } else { r.error }` se emite como switch sobre
  `r.kind` con access via `std::get<index>(r.payload)`.
- [ ] `Result<T>` se modela como tagged union sintética (no más helper
  custom `ets::Result`).
- [ ] Tests E2E `result-ok`, `result-err`, `narrowing-ok`, `narrowing-err`
  pasan.
- [ ] Suite completa sigue verde (salvo el path-related `node-api-demo`
  preexistente).
- [ ] `result-files.ets` sigue funcionando (migración transparente).
- [ ] Sin cambios en el CLI ni en `runtime/ets_runtime.hpp` (la clase
  `Result` se mantiene para no romper callers que aún la usen).

---

## Riesgos

- **Medio**: la unión sintética `Result<T>` debe coexistir con el
  helper `ets::Result<T>` mientras los callers existentes no migren.
  Plan: en el codegen, cuando el tipo es `Result<T>`, NO usar
  `cppTypeFromGenericString` (que mapea a `ets::Result<T>`), sino tratar
  la unión como cualquier otra.
- **Bajo**: el cambio en `unionDeclaration` para object-variants es
  backwards-compatible (campo opcional). Los unions V1.1 siguen
  funcionando.
- **Bajo**: el narrowing en `if` no afecta a `match` (que ya tiene su
  propio flujo V2). Conviven.
- **Bajo**: tests que dependan de `ets::Result<T>` directo en runtime
  (no del type alias) siguen funcionando porque la clase sigue
  existiendo en `ets_async.hpp`.

---

## Orden de ejecución

1. AST + Parser para object-variants (sin tocar codegen).
2. Type-checker: registrar `Result<T, E>` como unión sintética.
3. Codegen: `unionDeclaration` honra `discriminator`.
4. Codegen: narrowing en `if` + member access narrowado.
5. Tests E2E nuevos.
6. Migración de `result-files.ets` (si requiere cambios).

Cada paso es incrementalmente verificable: la suite actual sigue verde.
