# `scripts/` — utilidades de build

Scripts bash y TypeScript. Algunos se invocan manualmente, otros los llama el
CLI (`src/cli.ts`) automáticamente (V25).

## Scripts de V25 (Build System — ver `docs/build-system.md`)

Estos scripts son invocados **manualmente** por el usuario la primera vez,
y **automáticamente por el CLI** cuando detecta que faltan `.a`/`.o` en el
build local.

### `build-libuv.sh`

Compila libuv estáticamente desde `third_party/libuv/` (submódulo git) hacia
`build/libs/libuv/`.

```
scripts/build-libuv.sh [VERSION]    # default v1.48.0
```

Salidas:

- `build/libs/libuv/lib/libuv.a` (~364 KB)
- `build/libs/libuv/include/uv.h` (cabeceras)

Cache HIT/MISS por presencia de `libuv.a`. Cold compile: ~35s. Warm: 28ms.
Requiere `cmake`.

### `build-boringssl.sh`

Compila BoringSSL estáticamente desde `third_party/boringssl/` (submódulo git)
hacia `build/libs/boringssl/`.

```
scripts/build-boringssl.sh
```

Salidas:

- `build/libs/boringssl/lib/libssl.a` (~14 MB)
- `build/libs/boringssl/lib/libcrypto.a` (~39 MB)
- `build/libs/boringssl/include/openssl/*.h`

Cache HIT/MISS por presencia de `libssl.a` + `libcrypto.a`. Cold compile:
~2 min. Warm: 2s. Requiere `cmake`.

### `build-curl.sh`

Compila libcurl estáticamente desde `third_party/curl/` (submódulo git),
**enlazando contra la BoringSSL vendoreada** (no contra OpenSSL del sistema).

```
scripts/build-curl.sh
```

Salidas:

- `build/libs/curl/lib/libcurl.a` (~6 MB)
- `build/libs/curl/include/curl/*.h` (12 headers)

Cache HIT/MISS por presencia de `libcurl.a`. Cold compile: ~30s. Warm: 1s.
Requiere `cmake`.

### `build-runtime.sh`

Pre-compila el runtime C++ de Ts2cpp (`runtime/runtime_ets_*.cpp`) a `.o`
cacheados en `build/`.

```
scripts/build-runtime.sh
```

Salidas:

- `build/runtime_ets_poll.o` (~24 KB) — siempre
- `build/runtime_ets_libuv.o` (~36 KB) — si libuv está disponible

Cache HIT/MISS por timestamp del `.o` vs `.cpp`. Cold compile: ~6s.
Warm: 40ms (150x speedup).

## Scripts pre-V25 (Tree-sitter + AST)

Tres scripts bash invocados manualmente (no los usa `npm start`). Tratan solo
las dependencias externas (`third_party/`) y el dumper de AST.

## `build-tree-sitter.sh`

Compila los tres objetos `.o` de Tree-sitter con `gcc` (o el equivalente del
`cxx`):

```
build-tree-sitter.sh [output_dir] [cxx]   # por defecto build/.estatic/native, g++
```

Salidas:

- `tree-sitter-runtime.o`
- `tree-sitter-typescript-parser.o`
- `tree-sitter-typescript-scanner.o`

Solo recompila si el `.c` es más nuevo que el `.o` correspondiente.

Usado por `build-ast-dump.sh` y, en la mayoría de builds, por el compilador
de Tree-sitter que enlaza contra `runtime/ets_syntax.hpp`.

## `regenerate-tree-sitter.sh`

Refresca la copia local de la grammar Estatic cuando cambia
`third_party/tree-sitter-typescript/`:

1. Copia `define-grammar.js` y `scanner.h` desde el vendoreado a
   `editors/tree-sitter-estatic/`.
2. Genera el parser con `tree-sitter generate`.
3. Corre el corpus `tree-sitter test`.

Requiere `tree-sitter` CLI (global o `npm install` en
`editors/tree-sitter-estatic/`).

## `build-ast-dump.sh`

> **Estado actual:** roto. El script referencia `tools/ets-ast-dump.cpp`, que
> no existe en el repositorio. Mantenerlo documentado por si se reactiva.

Iba a compilar una herramienta `ets-ast-dump` reutilizando los `.o` de
`build-tree-sitter.sh`. Si se necesita dumper de AST a futuro, hay que:

- Añadir `tools/ets-ast-dump.cpp` con un `main()` que use
  `runtime/ets_syntax.hpp`.
- Reajustar flags para reflejar el código real.
