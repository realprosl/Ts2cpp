# V7 — Fusión automática de operaciones sobre colecciones (Issue #40)

## Estado actual (verificado)

- **filter/map/reduce NO están implementados** como helpers globales en el dialecto.
- No hay funciones runtime (`ets_filter`, `ets_map`, `ets_reduce`) en `runtime/`.
- No hay despacho en `type-checker.ts` para `arr.filter(...)`.

Esto significa que V7 tiene **dos bloques**:

1. **V7.0 — Soporte básico**: implementar filter/map/reduce como helpers del runtime.
2. **V7.1 — Fusión AST**: visitor que detecta cadenas `filter → map → reduce` y las reescribe a un único `for`.

El alcance original de #40 era V7.1 directamente, pero al no existir V7.0, hay que hacerlo primero.

## V7.0 — Helpers filter/map/reduce

### API del dialecto

```ets
arr.filter(predicate: (item: T) => boolean): T[]
arr.map<U>(transform: (item: T) => U): U[]
arr.reduce<U>(init: U, op: (acc: U, item: T) => U): U
```

`arr` es `T[]`. La lambda se compila como `std::function` o lambda inline (ver V10).

### Codegen

Para V7.0 emitimos el código C++ directo (sin fusión). En V7.1 lo reescribimos.

```cpp
// filter:
std::vector<T> ets_filter_vec_T(const std::vector<T>& src, std::function<bool(const T&)> pred) {
  std::vector<T> out;
  out.reserve(src.size());
  for (const auto& item : src) if (pred(item)) out.push_back(item);
  return out;
}

// map:
std::vector<U> ets_map_vec_T_to_U(const std::vector<T>& src, std::function<U(const T&)> f) {
  std::vector<U> out;
  out.reserve(src.size());
  for (const auto& item : src) out.push_back(f(item));
  return out;
}

// reduce:
template<typename U, typename T, typename Op>
U ets_reduce_vec_T(U init, const std::vector<T>& src, Op op) {
  U acc = init;
  for (const auto& item : src) acc = op(acc, item);
  return acc;
}
```

### Archivos a tocar

- `runtime/ets_collections.hpp` (nuevo)
- `src/semantic/type-checker.ts` — registrar dispatch para `arr.filter/map/reduce`
- `src/codegen/cpp-generator.ts` — emitir la llamada correcta
- `test/unit/type-checker.test.ts` — tests de tipado
- `test/unit/codegen.test.ts` — tests de emisión
- `examples/collections-pipeline.ets` (nuevo)

## V7.1 — Fusión AST

Visitor que detecta el patrón:

```
CallExpression { method: "reduce", args: [init, op],
                 object: CallExpression { method: "map", args: [f],
                                          object: CallExpression { method: "filter", args: [p], object: arr } } }
```

Lo reescribe a un único `for`:

```ets
{
  const out: U = init;
  for (const item of arr) {
    if (p(item)) {
      const mapped = f(item);
      out = op(out, mapped);
    }
  }
  out;
}
```

### Conservación de semántica

- **Orden**: filter → map → reduce es secuencial. El bucle respeta el orden.
- **Side effects**: si `f` o `p` tienen side effects, se ejecutan en el mismo orden que la versión no fusionada.
- **Empty**: si `arr` está vacío, `init` se devuelve sin tocar `op`.

### No fusionar si

- La cadena tiene elementos distintos de filter/map/reduce (e.g. `.sort()`).
- Hay un `.slice()` o `.concat()` en medio (cambia semántica).
- Las lambdas no son simples (capturan variables, son complejas).

## Plan de ejecución

1. **V7.0 primero** — sin esto V7.1 no tiene a qué fusionar.
2. **Tests E2E** — verificar runtime correcto antes de fusionar.
3. **V7.1** — añadir el visitor y verificar que el C++ emitido tiene un solo bucle.

## Dependencias

- ✅ V0.1 (resolvedType en AST)
- ✅ V1 (narrowing, no afecta directamente)
- ❌ V10 (closures específicas) sería nice-to-have para no usar `std::function` en V7.1

## Done criteria

- [ ] `arr.filter(p).map(f).reduce(init, op)` se puede escribir y compila
- [ ] V7.1: el C++ emitido tiene exactamente 1 bucle en el caso fusible
- [ ] V7.1: si la cadena no es fusible, cae al comportamiento V7.0 (múltiples pasadas)
- [ ] Tests E2E: `pipeline-fuse-filter-map-reduce`, `pipeline-no-fuse-with-sort`, `pipeline-side-effects-preserved`
- [ ] Suite verde
