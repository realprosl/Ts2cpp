# `examples/` — programas de prueba

Cada `.ets` aquí es un *smoke test* de una característica del lenguaje o del
runtime. Útiles como referencia y como entrada rápida para experimentar.

## Cómo correr uno

```bash
npm start -- examples/hello.ets -o /tmp/hello.cpp
g++ -std=c++20 -fno-exceptions -pthread -I. /tmp/hello.cpp -o /tmp/hello
/tmp/hello
```

O con la configuración del proyecto (modo incremental):

```bash
npm start -- --config estatic.config.ts
```

## Índice por característica

| Fichero | Qué demuestra |
|---|---|
| `hello.ets` | Mínimo: `function`, `let`, `while`, inferencia, `print`. |
| `closures.ets` | Funciones flecha + capturas (`makeAdder`, `makeCounter`). |
| `generics.ets` | Funciones genéricas `<T>`, clases genéricas `Box<T>`, inferencia y argumentos explícitos. |
| `complete-demo.ets` | Interfaces + clases por composición + tipado estructural. |
| `composition.ets` | Composición de clases como alternativa a herencia. |
| `interface.ets` | Interface aislada y satisfacción estructural. |
| `instanceof-demo.ets` | `instanceof` con clases, uniones y primitivos. |
| `memory-values.ets` | **V22**: `T` significa copia (value semantics). |
| `memory-borrows.ets` | **V22**: `ref<T>` y `constRef<T>` modelan préstamos. |
| `memory-ownership.ets` | **V22**: `ptr<T>` para ownership exclusivo. |
| `mut-demo.ets` | **V22** (antes `Mut<T>`): `ref<T>` es una referencia mutable. |
| `mutref-demo.ets` | **V22** (antes `MutRef<T>`): `ref<T>` es T&. |
| `rc-demo.ets` | **V22** (antes `Rc<T>`): ownership exclusivo vía `ptr<T>`. |
| `un-demo.ets` | **V22** (antes `Unq<T>`): ownership exclusivo. |
| `type-aliases.ets` | `type X = …`. |
| `typeof-value.ets` / `typeof-type.ets` | `typeof` como valor y como tipo. |
| `default-type-params.ets` | Parámetros de tipo con `= default`. |
| `default-args-demo.ets` | `function f(x: T = expr)` — defaults solo en declaración. |
| `overloads-variadics.ets` | Sobrecargas por firma y packs `<...T>` + `...values`. |
| `union-demo.ets` | Tipos unión `A \| B`. |
| `intersection-demo.ets` | Genéricos con constraint `T extends A & B`. |
| `map-set-demo.ets` | `Map<K,V>` y `Set<T>` estilo JS. |
| `collections.ets` | Recorrido de arrays con `for..of`. |
| `for-of-demo.ets` / `for-in-demo.ets` | Bucles `for..of` y `for..in`. |
| `template-strings-demo.ets` | Template literals con `${…}`. |
| `mutable-borrows.ets` | Parámetros `mut`. |
| `delete-demo.ets` | `delete` sobre map/array. |
| `enum-demo.ets` | `enum` con subyacente `number`/`string`. |
| `console-demo.ets` | Facade `console.{log,info,debug,trace,warn,error}`. |
| `fs-demo.ets` | Facade `fs.*` (sync + async). |
| `result-files.ets` | API clásica `readFile(..., out contents, out error)`. |
| `async-await.ets` | `async`/`await` mínimo, top-level await. |
| `async-files.ets` | `readFileAsync` y compañía. |
| `cancellation.ets` | `CancellationSource`/`CancellationToken` con `*Until`. |
| `native-io.ets` | `printError`/`writeError` por stderr. |
| `http-server.ets` | Servidor HTTP/1.1 no bloqueante con `listenTcp`+`acceptTcp`+`spawn`. |
| `tls-server.ets` | Servidor TLS sobre OpenSSL. |
| `node-api-demo.ets` | Varias facades Node-style juntas. |

## Aplicación modular de referencia

`modules/main.ets` + `modules/math.ets` ejercitan el sistema de imports +
visibilidad `export`. La verificación canónica (`estatic.config.ts`
configurado) imprime `26`:

```
build/configured-app → 26   # sumRange(10) con break/continue
```
