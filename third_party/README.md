# `third_party/` — dependencias externas vendoreadas

Código fuente de proyectos de terceros copiado al repositorio para que el
transpilador no necesite `npm install`, `git submodule` ni nada similar.

## Contenido

- **`tree-sitter/`** — runtime de Tree-sitter. Compilado a
  `build/.estatic/native/tree-sitter-runtime.o` por `scripts/build-tree-sitter.sh`.
  Alimenta a `runtime/ets_syntax.hpp`.
- **`tree-sitter-typescript/`** — grammar TypeScript de Tree-sitter. Se compila
  a `tree-sitter-typescript-parser.o` + `tree-sitter-typescript-scanner.o`.
- **`libuv/`** — librería de I/O asíncrono (submódulo git). Compilada estáticamente
  a `build/libs/libuv/lib/libuv.a` por `scripts/build-libuv.sh`. Alimenta al
  backend alternativo `LibuvEventLoop` en `runtime/ets_event_loop_libuv.hpp`.
  Ver `libuv/README.md` para detalle del vendoring.
- **`boringssl/`** — fork de OpenSSL mantenido por Google (submódulo git, `--depth 1`).
  Compilado estáticamente a `build/libs/boringssl/lib/{libssl,libcrypto}.a` por
  `scripts/build-boringssl.sh`. Alimenta `runtime/ets_tls.hpp`. Ver
  `boringssl/VENDORED-NOTES.md` para detalle del vendoring.
- **`curl/`** — librería cliente HTTP/HTTPS (submódulo git, `--depth 1`).
  Compilada estáticamente a `build/libs/curl/lib/libcurl.a` por
  `scripts/build-curl.sh`. Enlaza contra BoringSSL vendoreada. Ver
  `curl/VENDORED-NOTES.md` para detalle del vendoring.

## Cómo se mantiene sincronizada

- **`scripts/build-tree-sitter.sh`** — compila los tres `.o` con `gcc` (o
  equivalente al compilador C++ del proyecto). Solo recompila si el `.c` es
  más nuevo que el `.o`.
- **`scripts/regenerate-tree-sitter.sh`** — copia `define-grammar.js` y
  `scanner.h` desde el vendoreado a `editors/tree-sitter-estatic/`, regenera
  el parser con `tree-sitter` CLI y valida el corpus.

## Por qué vendoreada

El runtime (`runtime/ets_syntax.hpp`) usa Tree-sitter para validación
sintáctica paralela y para emitir el AST serializado. Compilar el binario
nativo desde el código generado necesita los `.o` enlazados solo si el
programa resultante usa la API de syntax/ast — `incremental-builder.ts` lo
detecta por búsqueda de identificadores en el C++ emitido y evita el coste en
programas normales.
