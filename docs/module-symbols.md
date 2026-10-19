# Identidad de bindings entre módulos

`compileFile` aísla los nombres fuente top-level que aparecen en varios módulos
antes de combinar los AST y ejecutar checker, `comptime` o `@etsgen`.

Dos módulos pueden declarar su propio `helper`, incluso con la misma firma.
Cada declaración y sus referencias reciben un nombre interno distinto. Las
sobrecargas del mismo módulo comparten identidad y siguen siendo sobrecargas.
Los nombres sin ambigüedad se conservan para mantener compatibilidad con tooling.

## Alcance

- Funciones, variables, recursos `using`, clases, interfaces, aliases, enums y
  unions top-level, con independencia de su visibilidad.
- Bindings reales de destructuring de array y objeto, manteniendo los nombres
  de propiedades del objeto. Los temporales del parser no son bindings públicos.
- Referencias en cuerpos, capturas de closures, tipos, parámetros genéricos,
  valores por defecto y argumentos de tipo. Los scopes locales siguen sombreando
  las declaraciones del módulo y las etiquetas de argumentos conservan su nombre.
- Imports normales, con aliases, namespaces y reexports apuntan al propietario
  original. Una dependencia compartida se carga e inicializa una vez.
- El entorno de `etsCapture` y `etsDefinition` conserva los nombres fuente y
  resuelve la identidad de la declaración correcta.

La normalización se realiza sobre el AST. No reescribe strings, fragmentos ETS
retornados ni propiedades. Los diagnósticos recuperan los nombres fuente y la
ubicación original de cada archivo.

## Generación C++

Los constructores de unions normalizadas incluyen la identidad de la unión en
su nombre C++; dos `Outcome.Ok(number)` no generan la misma función global.
Las variantes y sus etiquetas públicas permanecen iguales.

Los bindings de destructuring top-level modular tienen almacenamiento en su
unidad C++, visible desde sus funciones. La expresión se evalúa una vez durante
la inicialización del módulo y luego se asigna cada binding. `decltype` permite
deducir su almacenamiento sin evaluar anticipadamente la expresión. El temporal
solo vive durante el init; no se retiene el objeto original durante todo el
programa. El checker
mantiene las restricciones de mutación de `const`.

## Visibilidad y límites

Esta identidad no concede permisos: usar un símbolo ajeno sin importarlo o
exponer tipos privados en una API sigue siendo error. Los duplicados dentro del
mismo módulo también lo son.

El frontend continúa usando un AST combinado y nombres internos, no una identidad
universal compartida por todas las APIs. El asignador garantiza unicidad en la
compilación actual; no promete nombres estables al cambiar el grafo. Las APIs
que reciben AST aislados mediante `analyze` no cargan ni aíslan módulos.

Las publicaciones generadas tienen identidad modular cuando se anuncian mediante
`export { nombre }` y se publican con `@etsPublish`. Una publicación no anunciada
puede seguir chocando con otra declaración; `MODULE_SYMBOL_COLLISION` permanece
como protección antes de que checker o evaluadores mezclen ambas. Ver
[generated-module-exports.md](./generated-module-exports.md).

Los ciclos de imports siguen pendientes. Los fragmentos generados ya tienen
mapas C++ por tramos; ver [etsgen-cpp-source-maps.md](./etsgen-cpp-source-maps.md).
`@cppgen` y nombres C++ externos explícitos siguen siendo responsabilidad de su
autor: este recorrido no reescribe fragmentos C++ opacos.

## Verificación

`test/unit/module-symbol-collisions.test.ts` contiene 27 pruebas. Cinco compilan,
enlazan y ejecutan unidades C++ separadas para comprobar estado mutable,
closures, sobrecargas, comptime, tipos homónimos, enums, unions, destructuring,
generadores y helpers de definición, y plantillas exportadas con helpers privados.

Ejemplo ejecutable: `examples/module-private-symbols/main.ets`.
