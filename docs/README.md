# Documentación de Ts2cpp

Esta carpeta contiene la documentación técnica de Ts2cpp.

## Estado actual (V30.6.0+)

| Doc | Para qué |
|---|---|
| [`build-system.md`](./build-system.md) | Flujo de build actual: `npm install` (postinstall), `etsc --build`, AST detection, linkado. **Doc de referencia para "cómo se compila hoy".** |
| [`runtime-async-libuv.md`](./runtime-async-libuv.md) | Cómo se mapea el dialecto a corutinas sobre libuv (único backend V30+). Sustituye al antiguo "reactor". |
| [`memory-model.md`](./memory-model.md) | Ownership, préstamos, punteros V22. Verificado contra `src/semantic/type-checker.ts`. |
| [`match-syntax.md`](./match-syntax.md) | Sintaxis V23 única de `match` (V30.5.1+). |
| [`TUTORIAL.md`](./TUTORIAL.md) | Tutorial del dialecto. Cada ejemplo es un test e2e real (`test/e2e/<bucket>/<name>/`). |
| [`vision.md`](./vision.md) | Visión a largo plazo. Aspiracional, no refleja el estado actual. |

## Históricos (V0..V10)

Ver [`historical/`](./historical/). Contiene planes detallados de
versiones anteriores. Útil para entender cómo se llegó a la
arquitectura actual, pero **no refleja el estado presente**. Para
saber qué está implementado hoy, consulta [`CHANGELOG.md`](../CHANGELOG.md),
`examples/` y los tests e2e.

## Política

Cuando algo cambia (PR mergeado, deprecation, etc.):

1. Si es una corrección: actualizar el doc activo relevante.
2. Si el doc activo describe una versión anterior: añadir banner "⚠️ HISTÓRICO (Vxx)" al inicio.
3. Si el cambio invalida completamente el doc: moverlo a `historical/`.

> **Nota:** desde V29.3 el "reactor" ya no existe como abstracción
> propia — el alias `ets::EventLoop = LibuvEventLoop` significa que
> el event loop ES libuv. No confundir el header `runtime/ets_event_loop.hpp`
> (que es solo un selector de backend) con un reactor estilo V26.
