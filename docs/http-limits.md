# Límites HTTP

## Selección de backend

cpp-httplib es el backend por defecto. `@cpp_drogon` sobre una variable de tipo
`Server` selecciona el wrapper Drogon sin importar cómo se llame la variable.
El tipo puede estar escrito o inferirse del inicializador:

```ets
@cpp_drogon
const api = http.createServer();
```

La selección se hace al generar C++, no por petición. En el programa generado
se incluye un solo wrapper y todas las instancias `Server` usan ese backend;
no se pueden mezclar cpp-httplib y Drogon por instancia. El decorador sobre una
variable que no sea `Server` no selecciona Drogon.

Las pruebas verifican la selección del header por el compilador, no la
ejecución nativa de Drogon: para esta última siguen haciendo falta sus headers
y librerías.

## cpp-httplib

`ets::Server()` aplica esta política antes de empezar a escuchar:

| Recurso | Valor por defecto |
|---|---|
| Workers | 8, sin crecimiento dinámico |
| Cola de conexiones pendientes | 128 |
| Cuerpo de una petición | 1 MiB (1.048.576 bytes) |
| Timeout de lectura | 5 segundos |
| Timeout de escritura | 5 segundos |
| Espera entre peticiones keep-alive | 2 segundos |
| Peticiones por conexión keep-alive | 100 |

La cola contiene conexiones aceptadas, no cuerpos completos ya parseados. Al
llenarse, cpp-httplib cierra la nueva conexión; no garantiza una respuesta
`503`. El backlog del sistema operativo es independiente. Los workers pueden
quedar ocupados por conexiones keep-alive; ocho workers no equivalen a ocho
usuarios ni a una capacidad medida de peticiones por segundo.

El límite de cuerpo se aplica en el backend, antes de copiarlo al request del
dialecto. Una petición que lo supera recibe `413`. Es un cambio deliberado
respecto al default de 100 MiB de la librería vendoreada: aplicaciones que
suban archivos grandes deberán ajustar el límite.

Los timeouts son los de lectura/escritura del backend, no un deadline absoluto
para la petición ni para el handler. Un handler bloqueante no se cancela al
vencerlos. Tampoco se limita aquí el tamaño de respuestas o el estado que
conserve el código del usuario; esta política no fija un techo total de RSS.

Las cabeceras y la URI conservan los límites de compilación de la copia
vendoreada: 8.192 bytes por línea de cabecera, 100 cabeceras y 8.192 bytes de
URI. No se han añadido controles configurables en runtime para esos campos.

### Configuración

El dialecto aplica los defaults automáticamente. Todavía no hay una API `.ets`
para cambiarlos. Para integración C++ existe un constructor explícito:

```cpp
ets::HttplibServerLimits limits;
limits.workers = 4;
limits.queuedConnections = 32;
limits.bodyBytes = 2 * 1024 * 1024;
ets::Server server(limits);
```

La configuración se copia al construir el servidor; modificar el objeto
original después no cambia el servidor. Cualquier valor cero, o timeout
negativo, se considera inválido y aborta: no se permite activar accidentalmente
el comportamiento ilimitado de la librería. El escape `server.impl()` permite
a C++ avanzado sobreescribir la política y queda bajo su responsabilidad.

### Pruebas

```bash
npm run test:http-limits
# Solo cola, sin abrir sockets:
npm run test:http-limits -- --queue-only
```

La regresión compila con C++20 sin excepciones y utiliza la macro requerida
por cpp-httplib para ese modo. Verifica que la cola rechaza el exceso y drena
lo aceptado. La prueba HTTP abre un puerto efímero de loopback y comprueba los
bordes de un límite de cuerpo de 32 bytes: 32 se aceptan, 33 reciben `413` y
no llegan al handler. No requiere libuv ni Drogon.

Estas pruebas pasaron en este entorno. La variante con ASan/UBSan se incluye en
`npm run test:memory`, pero sigue pendiente completarla en un entorno donde
LeakSanitizer pueda inspeccionar `/proc`.

También existe una regresión del adaptador HTTP:

```bash
npm run test:http-routing
```

Verifica mediante seis peticiones reales en loopback que cada ruta conserva
solo sus propios nombres de parámetros, que GET y POST no los mezclan, que
peticiones sucesivas no heredan valores y que `http.header` funciona con
cualquier combinación de mayúsculas/minúsculas. El servidor se mueve después
de registrar las rutas para comprobar que sus handlers no dependen de una
referencia al objeto original. La prueba reproduce cuatro fallos antes de la
corrección y pasa los seis casos después. No requiere libuv ni Drogon.

## Drogon

Los defaults anteriores son exclusivos del wrapper cpp-httplib. No se ha
modificado ni verificado una política equivalente de conexiones, colas y cuerpo
para Drogon; faltan sus dependencias en este entorno. No debe asumirse
que cambiar de backend mediante decorador conserva esta política de recursos.

El antiguo servidor HTTP experimental se ha eliminado. Los únicos backends
del servidor mantenidos son cpp-httplib y Drogon; no hay un tercer fallback.
