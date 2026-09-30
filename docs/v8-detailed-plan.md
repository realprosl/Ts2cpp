# V8 — Análisis de escape implícito (Issue #41)

## Objetivo

Cuando el usuario escribe `let x = new Counter()` sin tipo declarado:
- Si `x` no escapa la función → emitir `T` por valor (sin smart pointer).
- Si `x` se retorna o se guarda en `Rc<T>` → emitir `Unq<T>` (ownership único).
- Si `x` se comparte (assigned a `Rc`, multiple owners) → emitir `Rc<T>`.

## Alcance V8.0 (mínimo viable)

**Solo análisis intraprocedural**. Sin interprocedural (no miramos el cuerpo de funciones llamadas).

Reglas de escape:
1. `return new T()` o `return x` (donde x es el new) → escapa (Unq).
2. `let y: Rc<T> = new T()` → escapa como Rc (Rc).
3. `foo(new T())` o `foo(x)` donde `foo` toma `T&` o `MutRef<T>` → escapa por referencia (Unq con std::move o Mut).
4. Cualquier otro uso → **por valor**.

## Lo que ya hace V0.4

- `new T()` se emite como `T{args}` en el codegen (línea 1272 de cpp-generator.ts).
- `let x: Unq<T> = new T()` requiere envoltorio explícito (`unSome<T>(...)`).
- El type-checker actual devuelve el nombre de la clase como tipo del `new T()`.

**Esto significa que V8.0 no necesita cambiar el codegen si la regla de "valor" ya se cumple cuando no se declara tipo**. Pero hay un problema: si no se declara tipo, hoy el `let x = new T()` infiere `T`, que **ya es por valor**. La regla solo cambia cuando el usuario **esperaba** Unq y se olvida de ponerlo.

**Mejor interpretación de V8**: el caso interesante es **`let x: T = new T()` no compila** porque `T` no tiene constructor por defecto — `new T()` retorna `T` por valor, no `Unq<T>`. El usuario debe escribir `let x: Unq<T> = new T()` (envuelto).

V8.0 debe permitir `let x = new T()` y `let x: T = new T()` cuando no hay escape, evitando al usuario tener que envolver en `Unq<T>`.

## Plan

### Type-checker

1. En `NewExpression`, devolver tipo `T` (nombre de la clase) como hasta ahora.
2. En `VariableDeclaration`, cuando:
   - `declaredType` es undefined
   - El initializer es `NewExpression`
   - El nombre de la variable no aparece en ninguna expresión de escape (return, asignación a Rc, etc.)
   → Marcar la variable con `inferredByV8: "value"`.

### Visitor de escape

Método privado `analyzeEscape(name, body)`:
- Recorre `body` (BlockStatement).
- Si encuentra `return identifier` donde identifier.name === name → "escapes".
- Si encuentra `AssignmentExpression` donde el target es de tipo `Rc<T>` → "escapes".
- Si encuentra `CallExpression`/`MemberCallExpression` donde algún argumento es `identifier` → "may escape" (no resolvemos la firma en V8.0, lo dejamos como Unq).

### Codegen

Sin cambios. La inferencia del type-checker propaga el tipo `T` directamente.

## Tests

```
test("V8.0: new T() sin tipo declarado infiere T por valor", () => {
  const src = `class Counter { value: number; constructor(v: number) { this.value = v; } }
               function make(): void {
                 let c = new Counter(42);
                 print(numberToString(c.value));
               }`;
  // El codegen debe emitir `Counter c{42};` (no `Unq<Counter>`)
  assert.match(out, /Counter\s+c\s*\{/);
});

test("V8.0: return new T() mantiene Unq<T> en el retorno", () => {
  const src = `class Counter { value: number; constructor(v: number) { this.value = v; } }
               function make(): Unq<Counter> {
                 let c = new Counter(42);
                 return c;
               }`;
  // El return type es Unq<Counter>; la inferencia detecta el escape.
  // Como el tipo de retorno es Unq, debe envolver.
  assert.match(out, /unSome<Counter>\(Counter\{42\}\)/);
});
```

## Limitaciones V8.0

- Sin interprocedural: si `make()` retorna `T` y se asigna a `Rc<T>` fuera, no lo detectamos.
- Sin análisis de captura por lambdas (V10).
- Si el usuario quiere forzar Unq, debe declararlo explícitamente: `let x: Unq<T> = ...`.

## Done criteria

- [ ] `let x = new T()` en función que no retorna `x` → emite `T` por valor
- [ ] `return x` o `return new T()` → mantiene `Unq<T>` cuando el tipo de retorno lo exige
- [ ] Sin cambios en tests existentes (no regresión)
