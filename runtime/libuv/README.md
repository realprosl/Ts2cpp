# Ts2cpp + libuv — Validación arquitectónica

Este directorio contiene la **Fase 1** de la migración del runtime de
Ts2cpp al backend libuv. No forma parte del runtime inyectado a los
programas generados. Es standalone.

## Estado

**Fase 1 (Abstracción) — entregada como spike validado.**

Las 8 fases de la "Especificación de networking sobre libuv" son:

1. **Abstracción** ← *estamos aquí* (validada, no en producción)
2. Event loop libuv
3. TCP servidor
4. TCP cliente y DNS
5. Cancelación y timeouts unificados
6. Benchmarks
7. Fetch (libcurl multi)
8. Optimización

Este spike valida las tres propiedades arquitectónicas más delicadas
de la spec antes de tocar código de producción:

| # | Escenario | Sección spec | Resultado |
|---|-----------|--------------|-----------|
| 1 | Timer one-shot reanuda la corutina una vez | §6 | ✅ |
| 2 | Timer repetitivo: la corutina se reanuda a lo sumo 1 vez aunque el callback dispare múltiples veces | §10 | ✅ |
| 3 | Cancelación externa + timer: la cancelación llega antes, la corutina termina con estado `cancelled` sin reanudar dos veces | §6, §10 | ✅ |

## Lo que NO hace este spike (todavía)

- No sustituye al `EventLoop` actual de `runtime/ets_async.hpp`.
- No toca TCP, DNS, ni `runtime/ets_net.hpp`.
- No se inyecta en los programas generados.
- No cambia ninguna API de Ts2cpp visible al usuario.
- Los 188/188 unit tests y 43/48 e2e tests siguen pasando exactamente
  como antes — porque este código no se compila con el resto.

## Lo que prueba

Que el patrón "callback de libuv reanuda coroutine C++20" es viable
con las restricciones de la spec:

- **§2.1**: libuv es interno. El código de test no expone tipos de libuv
  en su API pública (los tipos `uv_*` viven solo dentro del awaitable).
- **§6**: el callback de libuv no ejecuta lógica de negocio; solo
  actualiza estado y reanuda.
- **§10**: la invariante "resume a lo sumo una vez" se mantiene incluso
  con cancelación + timer + múltiples disparos.

## Próximo paso (Fase 2)

Implementar el `EventLoop` real basado en libuv, manteniendo la
misma API pública. El switch entre backends será mediante un macro
(`ETS_EVENT_BACKEND=poll` por defecto, `libuv` opt-in) para que la
transición sea incremental y reversible.

## Compilar y ejecutar

```bash
cd runtime/libuv
make
./build/validate_architecture
```

Requisitos:

- g++ con C++20.
- libuv 1.x: `apt install libuv1-dev` (Debian/Ubuntu) o
  equivalente. Verificado con libuv 1.48.0.
