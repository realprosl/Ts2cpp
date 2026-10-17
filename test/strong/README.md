# V30.52: Tests fuertes multi-módulo

Esta carpeta contiene proyectos complejos que combinan múltiples features
del dialecto Ts2cpp para validar la pipeline completa (analyze + codegen
+ compile + run).

## Proyectos

- **`comptime_lib/`** — Librería de funciones comptime (factorial, fib,
  isPrime, gcd, pow). Demuestra `@comptime`, recursion comptime, y bucles
  comptime.

- **`app_basic/`** — App que importa `comptime_lib/math.ets` y usa
  cross-module `@comptime`. Demuestra comptime cross-module, captura
  de globals, y `comptime()` inline.

- **`app_generated/`** — App con generadores de código cross-module.
  Demuestra `@cppgen` (C++ literal) y `@etsgen` (código del dialecto)
  en módulos separados.

- **`app_collections/`** — App con utilidades de strings y arrays
  cross-module. Demuestra arrays, strings, funciones regulares, y
  `comptime()` con arrays literales.
- **`app_string_ops/`** (V30.55) — Builtins de string (`charAt`,
  `indexOf`, `substring`), `as` cast narrowing, y `arr[i] = x` con
  auto-resize. Verifica que el codegen emite las llamadas correctas
  al runtime.

## Cómo ejecutar

```bash
bash test/strong/run.sh
```

El script compila cada proyecto con `etsc`, lo compila con `g++`, lo
ejecuta y compara el output con el esperado. Output esperado:

```
--- test/strong/app_basic ---
PASS: app_basic
--- test/strong/app_generated ---
PASS: app_generated
--- test/strong/app_collections ---
PASS: app_collections

=== test/strong summary ===
PASS: 4
FAIL: 0
```

## Features probadas

| Feature | app_basic | app_generated | app_collections | app_string_ops |
|---|---|---|---|---|
| `@comptime` | ✅ | | | |
| Cross-module | ✅ | ✅ | ✅ | |
| `comptime()` inline | ✅ | | ✅ | |
| `@cppgen` | | ✅ | | |
| `@etsgen` | | ✅ | | |
| Recursion comptime | ✅ | | | |
| Bucles comptime | ✅ | | ✅ | |
| Captura de globals | | | | |
| Arrays | | | ✅ | ✅ |
| Strings | | | ✅ | ✅ |
| Funciones regulares | ✅ | | ✅ | |
| `charAt`/`indexOf`/`substring` (V30.55) | | | | ✅ |
| `as` cast narrowing (V30.55) | | | | ✅ |
| `arr[i] = x` auto-resize (V30.55) | | | | ✅ |
| Multi-call | ✅ | ✅ | ✅ |

## Notas

- Los proyectos NO usan `function main()` — las statements top-level
  se ejecutan en el `ets_init_*` (igual que los tests e2e existentes).
  Esto evita un bug del codegen donde `int main` no llama a
  `ets_user_main()` para funciones sync (V30.4 lo arregla solo para
  async).
