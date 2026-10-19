# Auditoría de memoria del runtime

Fecha: 2026-10-17

## Resultado

La revisión encontró una fuga reproducible en timers y errores de lifetime en
watchers, el event loop y `Promise.race`. Las cuatro rutas quedaron corregidas
y cubiertas por pruebas de regresión. También se eliminó la retención ilimitada
de queries del backend Drogon. Todavía falta ejecutar la suite nativa
completa con sanitizers y añadir cancelación cooperativa a los combinadores
antes de considerar el runtime listo para producción concurrente.

## Corregido

### 1. Callback de `Timer` retenido después del cierre — alta

`makeTimer` reservaba un `std::function<void()>` en `uv_timer_t::data`, pero el
callback de `uv_close` solo destruía el handle. Cada timer filtraba la función y
todo lo capturado por ella.

La ruta de cierre ahora destruye primero la función, limpia `data` y después
destruye el `uv_timer_t`. La misma regla se aplica si `uv_timer_start` falla.

### 2. `FsWatcher::data` apuntaba a un objeto movible — crítica

`watchFs` guardaba `&w`, la dirección de una variable local, en
`uv_fs_event_t::data`. El retorno o cualquier movimiento del `FsWatcher` podía
dejar un puntero obsoleto. El resultado era callback perdido o uso después de
liberar.

El callback vive ahora en un estado estable reservado en heap y propiedad del
handle libuv. El callback de cierre libera estado y handle. La prueba nativa
mueve expresamente el watcher antes de recibir el evento.

### 3. Handles libuv destruidos antes del callback de cierre — crítica

`runtime_ets_libuv.cpp` llamaba a `uv_close` sobre handles embebidos en
contenedores y borraba o reconstruía inmediatamente esos contenedores. Libuv
exige que la memoria del handle siga válida hasta ejecutar el callback de
cierre. Los casos corregidos eran:

- `timers_.erase(...)` inmediatamente después de `uv_close`;
- reconstrucción completa de `timers_`, que mueve handles aún activos;
- `polls_.erase(fd)` inmediatamente después de cerrar `uv_poll_t`;
- `clear()` de timers y polls en el destructor antes de drenar el loop.

Además, `PollEntry*` apunta a elementos de `std::vector`; un `push_back` puede
realocar el vector e invalidar `TimerEntry::pollPtr`.

Corregido: timers y polls poseen estado estable en heap mediante `unique_ptr`;
las esperas de cada descriptor usan `std::list`; los objetos se conservan
hasta `onTimerClosed`/`onPollClosed`. Los timers asociados se desarman cuando
gana el poll, evitando que conserven un `PollEntry*` borrado. La regresión
`test_event_loop_lifetime.cpp` fuerza crecimiento de colecciones, 2.048 timers,
512 esperas sobre el mismo fd y destrucción con operaciones pendientes.

La compilación sintáctica C++ y las pruebas estructurales pasan. Falta ejecutar
esta regresión con ASan/UBSan en un entorno que disponga de libuv.

### 4. Frames perdedores de `race` destruidos prematuramente — crítica

`race` inicia todas las corutinas y retorna cuando una termina. Al destruir el
vector se destruyen también los frames perdedores, aunque timers, polls, DNS o
trabajos del pool todavía pueden contener sus handles de corutina. El callback
posterior puede reanudar memoria liberada.

Esto no era una fuga clásica, sino un error de lifetime que podía manifestarse
como corrupción o crash. `race` transfiere ahora al event loop el ownership de
cada frame perdedor. Los timers, polls y trabajos bloqueantes pueden completar
sin apuntar a memoria liberada; el loop destruye el frame una vez terminado.
La regresión `test_race_lifetime.cpp` cubre `race<T>`, `race<void>` y `timeout`.

La compilación sintáctica C++ de esa regresión pasa. Falta ejecutarla con
ASan/UBSan en un entorno que disponga de libuv.

### 5. Caché ilimitada de query strings en Drogon — alta

`http_query` conservaba un mapa `thread_local` con una entrada por cada query
distinta recibida. El crecimiento dependía del tráfico y no había límite ni
expulsión. Cada hilo podía retener indefinidamente strings y mapas completos.

El lookup usa ahora `detail::rawQueryValue`, una búsqueda sin estado sobre la
query de la petición. No reserva mapas ni conserva datos entre llamadas y copia
únicamente el valor devuelto. Su coste es lineal en la longitud de la query por
consulta; conserva la semántica previa (último duplicado gana, claves vacías
ignoradas y valores sin URL-decode).

`runtime/tests/test_http_query.cpp` compara casos límite con el parser anterior,
comprueba que el resultado posee su memoria y procesa 100.000 queries únicas
en cuatro hilos. Pasa con `-O2 -fno-exceptions` y con UBSan. La ejecución con
ASan/LeakSanitizer quedó bloqueada por el acceso restringido a `/proc` del
contenedor; esto no equivale a una comprobación de fugas completada. El wrapper
completo requiere todavía compilar y ejecutar con las dependencias de Drogon.

### 6. Cola de conexiones sin límite en cpp-httplib — alta

El wrapper dejaba activa la cola ilimitada por defecto y el límite de cuerpo
de 100 MiB de la librería. Ahora fija 8 workers, 128 conexiones pendientes y
1 MiB por cuerpo, además de timeouts explícitos. La regresión nativa verifica
el rechazo del exceso de cola y una respuesta `413` real para cuerpos mayores
que el límite configurado. No equivale a un techo total de memoria ni a una
prueba de capacidad. La política equivalente en Drogon sigue pendiente.

Contrato y configuración: [`http-limits.md`](./http-limits.md).

## Pendiente

### 7. `race` no cancela operaciones perdedoras — media

La transferencia de ownership elimina el uso después de liberar, pero no
cancela la operación. Un perdedor que termina se drena y libera normalmente;
uno que nunca termina puede permanecer retenido hasta destruir el event loop.
La cancelación estructurada requiere que cada awaitable acepte un token y pueda
desregistrarse de su backend antes de liberar el frame.

## Retención intencional

- `BufferPool` conserva buffers por hilo, pero está acotado a 32 entradas por
  cada uno de 11 buckets. Es caché, no crecimiento ilimitado.
- `BlockingExecutor` conserva de 2 a 4 threads hasta finalizar el proceso; el
  singleton los detiene y une en su destructor.
- `Rc<T>` puede filtrar ciclos porque no existe `weak<T>`. Está deprecado; el
  código nuevo debe usar `ptr<T>` y ownership exclusivo.

## Verificación

La suite TypeScript se ejecuta con `npm test`. Para la comprobación nativa con
ASan, UBSan y LeakSanitizer:

```bash
npm run test:memory
```

El script ejecuta primero las regresiones de queries, límites y routing HTTP, que no
dependen de Drogon ni de libuv. Las regresiones restantes requieren headers y
librería de libuv. Si esas pruebas pasan pero falta `uv.h`, el script termina con un
mensaje explícito y código 2. Si LeakSanitizer no puede inspeccionar los hilos
del proceso (por ejemplo, bajo ciertas restricciones de `/proc`), esa ejecución
no constituye una validación completa de memoria.
