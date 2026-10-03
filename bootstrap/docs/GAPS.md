# Gaps del dialecto durante la migración

**Wave 0**: archivo inicial (sin gaps detectados aún).

---

## Cómo documentar un gap

Cuando un archivo .ts no se puede migrar a .ets, o cuando el .ets migrado
produce output diferente al TS, documentarlo aquí con:

```
### [Wave X] archivo: src/foo/bar.ts

**Problema**: descripción concisa.
**Output esperado**: ...
**Output actual**: ...
**Posible causa**: feature del dialecto faltante o buggy.
**Workaround**: ...
**Prioridad**: alta / media / baja.
```

Y crear un issue en https://github.com/realprosl/Ts2cpp/issues con label `bootstrap-gap`.

---

## Wave 0 — sin gaps detectados

A llenar durante waves 1-6.
### [Wave 0] feature: `import type { ... }` desde "..."

**Problema**: el dialecto no reconoce `import type` como sintaxis. Es
crítico para migrar el código TS porque todos los archivos .ts empiezan con
`import type { ... }`.

**Output esperado**: el compilador trata `import type` como un import
regular (solo tipos) — al ejecutar el código no se necesita el import,
pero el compilador debe resolver los nombres para type-checking.

**Output actual**: error de parser "Import no válido 'type ResolvedType'".

**Posible causa**: parser solo conoce `import { ... }` (con o sin `from`),
no `import type { ... }`.

**Workaround**: cambiar todos los `import type` por `import` regular. Es
factible porque el dialecto ya emite tipos en runtime (no se borran).

**Prioridad**: alta (bloquea Wave 1 inmediatamente).

### [Wave 0] feature: `import type { ... }`

**Problema**: el dialecto no reconoce `import type` como sintaxis. Bloquea
Wave 1 inmediatamente (todos los .ts empiezan con `import type`).

**Workaround**: usar `import { ... }` regular. Factible.

**Prioridad**: alta.

### [Wave 0] feature: `class Tree<T>[]` con `push`

**Problema**: `array.push(x)` no es un método built-in del dialecto. Solo
están `map`, `filter`, `reduce`, `forEach`, `find`, `some`, `every`, `slice`,
`sort`, `flatMap`, `includes`. `push` es básico en JS/TS y se usa en TODOS los
códigos con arrays dinámicos.

**Output actual**: error "El tipo 'Tree<T>[]' no declara 'push'".

**Workaround**: usar `append` (si existe) o iterar con for. O añadir `push`
como built-in (1-2 horas).

**Prioridad**: alta.

### [Wave 0] feature: object literal spread `{ ...obj1, ...obj2 }`

**Problema**: el dialecto no soporta `{ ...a, x: 10 }`. Solo object literals
con pares clave:valor explícitos.

**Output actual**: "Se esperaba un tipo primitivo, clase, interfaz, array o tupla".

**Workaround**: usar constructores explícitos o `Object.assign(a, { x: 10 })`.

**Prioridad**: media (el codegen TS usa spread en `parseProgram()`).

### [Wave 0] feature: generic constraint `<T extends Addable>`

**Problema**: el parser permite `<T extends Addable>` pero el type-checker
no resuelve la constraint. El método `add` no se encuentra en `T` porque
el checker no sabe que `T extends Addable`.

**Output actual**: "Tipo no definido o no permitido 'Addable'".

**Workaround**: usar duck-typing (verificar la presencia del método).

**Prioridad**: media (se usa en el type-system).

### [Wave 0] feature: union con payload complejo `union Result = Ok(value: number) | Err(msg: string)`

**Problema**: el parser no acepta `(payload)` en variantes. Solo `union Name
= A | B` sin payloads.

**Output actual**: "Se esperaba ')' después del payload de la variante".

**Workaround**: usar `class` con discriminated enums (`Result<T>` ya está implementado).

**Prioridad**: baja (tenemos alternativa).
