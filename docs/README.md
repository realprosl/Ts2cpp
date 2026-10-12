# Documentación de Ts2cpp

Esta carpeta contiene la documentación técnica de Ts2cpp.

## Estado actual (V30.6.0+)

| Doc | Para qué |
|---|---|
| [`build-system.md`](./build-system.md) | Flujo de build actual: `npm install` (postinstall), `etsc --build`, AST detection, linkado. **Este es el doc de referencia para "cómo se compila hoy".** |
| [`match-syntax.md`](./match-syntax.md) | Sintaxis V23 única de `match` (V30.5.1+). |
| [`memory-model.md`](./memory-model.md) | ⚠️ Histórico V22. Mantenido con banner; ver `examples/memory-*.ets` para los patrones vigentes. |
| [`reactor-async.md`](./reactor-async.md) | ⚠️ Histórico V26. Mantenido con banner; la realidad es V30.6.0 (libuv-only). |
| [`TUTORIAL.md`](./TUTORIAL.md) | Tutorial con ejemplos ejecutables. Secciones 17+ (V28+) están al día. La intro/flujo de build es **antiguo** — leer [`build-system.md`](./build-system.md) primero. |
| [`vision.md`](./vision.md) | Visión a largo plazo. Aspiracional, no refleja el estado actual. |

## Históricos (V0..V10)

Ver [`historical/`](./historical/). Contiene planes detallados de versiones
anteriores. Útil para entender cómo se llegó a la arquitectura actual,
pero **no refleja el estado presente**. Para saber qué está implementado
hoy, consulta [`CHANGELOG.md`](../CHANGELOG.md) y `examples/`.

## Política

Cuando algo cambia (PR mergeado, deprecation, etc.):

1. Si es una corrección: actualizar el doc activo relevante.
2. Si el doc activo describe una versión anterior: añadir banner "⚠️ HISTÓRICO (Vxx)" al inicio.
3. Si el cambio invalida completamente el doc: moverlo a `historical/`.

`scripts/check-docs-sync.ts` ejecuta verificaciones automáticas (lo que
puede). El check no es exhaustivo; la revisión final es manual.
