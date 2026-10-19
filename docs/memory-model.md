# Memory Model (V30.6.0) — Estado actual verificado contra el type-checker

> ℹ️ **Versión verificada:** V30.6.0. Cada regla de este doc está respaldada
> por una búsqueda en `src/semantic/type-checker.ts` (commit a la fecha
> de este PR). Si encuentras una discrepancia, el código gana — abre
> un PR para actualizar este doc.

Este documento describe el modelo de memoria del dialecto Estatic:
qué significa cada tipo relacionado con ownership/préstamo, qué
operaciones están permitidas, y qué errores reporta el type-checker.

## Resumen

| Quiero… | Tipo | C++ | Storage | Notas |
|---|---|---|---|---|
| Una copia independiente | `T` | `T` (valor) | sí (field, retorno, arg) | Default |
| Préstamo mutable | `ref<T>` | `T&` | **NO** (E4203) | Solo parámetros |
| Préstamo inmutable | `constRef<T>` | `const T&` | **NO** (E4203) | Solo parámetros |
| Ownership exclusivo | `ptr<T>` | `std::unique_ptr<T>` | sí | V22, preferido |
| Ownership readonly | `constPtr<T>` | `std::unique_ptr<const T>` | sí | V22 |
| Préstamo mutable (legacy) | `Mut<T>`, `MutRef<T>` | `T&` | sí (deprecated pre-V22) | Sin E deprecation, evitar |
| Smart ptr shared (deprecated) | `Rc<T>` | (warning E4404) | sí | Migrar a `ptr<T>` |
| Smart ptr shared (legacy) | `Unq<T>` | `std::unique_ptr<T>` | sí | Equivalente a `ptr<T>`, evitar |
| Shared con cycle break | `weak<T>` | **NO IMPLEMENTADO** | — | Mencionado en E4404 pero no existe aún |

## Reglas (verificadas contra `src/semantic/type-checker.ts`)

### 1. `T` significa copia

El dialecto **no aplica lowering implícito** a `const T&`. Pasar `T` copia.
Esto es V22; antes de V22 el compilador optimizaba a `const T&` y esa
optimización se eliminó para que la semántica sea explícita.

```ets
function foo(value: User): void {
    value.name = "changed";  // copia local
}
let user: User = new User("original");
foo(user);
print(user.name);  // "original" — la copia no afecta al caller
```

### 2. `ref<T>` y `constRef<T>` son SOLO préstamos (no owners)

`ref<T>` modela una referencia C++ mutable (`T&`). `constRef<T>` modela
`const T&`. **No se pueden almacenar**:

```ets
class Holder {
    data: ref<Data> = ...;  // E4203: borrowed references cannot be stored
}
```

**No se pueden usar como type arguments**:

```ets
let arr: Array<ref<Data>> = [];  // E4205
```

**No se pueden devolver** (todavía):

```ets
function get(): ref<Data> { ... }  // E42xx: borrowed references cannot be returned
```

La razón: el type-checker no implementa lifetime analysis. Los préstamos
son válidos solo dentro del scope de la llamada donde se reciben.

### 3. `ptr<T>` y `constPtr<T>` son ownership explícito (V22)

`ptr<T>` se compila a `std::unique_ptr<T>`. Es la forma preferida para
ownership dinámico. El type-checker hace `make_unique<T>(...)` implícito
cuando el destino es `ptr<T>`.

```ets
class Holder {
    data: ptr<Data> = new Data();  // ownership exclusivo
}
let h: Holder = new Holder();
let d: ptr<Data> = h.data;       // move out
```

`constPtr<T>` es `std::unique_ptr<const T>` — posees el objeto pero no
puedes mutarlo a través de este puntero.

### 4. `Rc<T>` está deprecado (E4404)

```ets
let r: Rc<User> = new User();  // WARNING: E4404: 'Rc<T>' is deprecated.
                                //          Use 'ptr<T>' for unique ownership or
                                //          'weak<T>' for shared ownership.
```

El mensaje sugiere `weak<T>` para shared ownership, pero **`weak<T>` aún
no está implementado** (no aparece en el type-checker). La migración
real es a `ptr<T>`.

### 5. `Unq<T>`, `Mut<T>`, `MutRef<T>` son legacy pre-V22

Aceptados por el type-checker (línea ~1360) sin error de deprecation,
pero semánticamente equivalentes a `ptr<T>`, `ref<T>`, `constRef<T>`.
**Evitar en código nuevo**.

## Errores específicos del modelo de memoria

| Código | Significado | Cuándo |
|---|---|---|
| E42xx | `ref<T>`/`constRef<T>` en posición de retorno | Type-checker |
| E4203 | `ref<T>`/`constRef<T>` en class field | Type-checker |
| E4205 | `ref<T>`/`constRef<T>` como type argument | Type-checker |
| E4404 | `Rc<T>` deprecado | Type-checker (warning) |

## Límites y trabajo futuro

- **Lifetime analysis**: permitiría devolver `ref<T>` y almacenarlo en
  fields cuando el checker pueda demostrar su duración. No implementado.
- **`weak<T>` real**: mencionado en E4404 pero no implementado.
- **Lifetimes interprocedurales**: el checker detecta conflictos de aliasing y
  aplica non-lexical lifetimes conservadores dentro de la función, pero no
  modela relaciones de duración entre firmas.
- **Runtime nativo**: el modelo del lenguaje no elimina los riesgos de vida
  útil de handles y corutinas descritos en [`MEMORY-AUDIT.md`](./MEMORY-AUDIT.md).

## Verificación

```bash
# Para verificar cualquier regla de este doc:
grep -n "ref\\|constRef\\|ptr\\|constPtr\\|Rc\\|Unq\\|Mut\\|weak" \
  src/semantic/type-checker.ts
```

Si la regla cambió, este doc debe actualizarse.
