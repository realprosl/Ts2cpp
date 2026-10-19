# Imports con as: resolución y alcance

La revisión encontró que el loader reconocía la línea `import {x as y}` pero
guardaba únicamente `x`. El uso de `y` no tenía un binding. Las pruebas antiguas
de `import-regex.test.ts` solo comprobaban el patrón de la línea, no compilaban
un proyecto con alias.

Ahora el grafo conserva ambos nombres y una pasada sobre el AST vincula las
referencias antes del checker, los evaluadores estáticos y el backend C++.

| Forma | Alcance comprobado |
| --- | --- |
| `import { f as g } from "./lib"` | Funciones, sobrecargas, variables y tipos exportados |
| `import type { Box as Crate } from "./lib"` | Alias de tipo; conserva la semántica previa del dialecto para `import type` |
| `import * as model from "./lib"` | Accesos estáticos `model.f()`, `model.value`, `model.Mode.High`, `model.Box` y `new model.Box()` |
| `export { f as g } from "./lib"` | Reenvía la identidad de origen; admite cadenas y diamantes |
| `import Default from "./lib"` | Resuelve la clave pública default, independientemente de su nombre interno |
| Imports multilínea | Descubrimiento por tokens, con comentarios y posiciones preservadas |

La resolución de defaults, exports locales, reexports y namespaces anidados se
detalla en [module-exports.md](./module-exports.md).

## Reglas de binding

```ts
import { increment as add, Box as Crate } from "./lib";

function run(): void {
  const increment: number = 99;
  const box: Crate = new Crate(7);
  print(add(value: box.value));
  {
    const add: number = 55;
    print(add);
  }
}
```

`add` invoca el export `increment`, aunque haya un local llamado `increment`.
El bloque interior usa su propio `add`. Se preservan parámetros, arrows,
genéricos, bloques, bucles, switch y destructuring. Los espacios de tipos y
valores se resuelven por separado. No se sustituyen strings, propiedades,+métodos ni etiquetas de argumentos nombrados.

Los destinos importados con alias reciben nombres internos frescos, reservados
frente a los identificadores existentes. Se actualizan también sus declaraciones
y referencias en el módulo propietario, así como sus otros consumidores. Se
mantienen identidad de destino, mutabilidad, sobrecargas y decoradores C++.
No se promete estabilidad de los identificadores C++ internos; un nombre ABI
explícito sigue siendo responsabilidad de los decoradores correspondientes.

Los aliases y namespaces permiten seleccionar exports homónimos de módulos
distintos sin mezclarlos como sobrecargas. Los símbolos restantes sin identidad
normalizada siguen sujetos a `MODULE_SYMBOL_COLLISION`: no se ha eliminado esa
protección ni implementado aislamiento universal de módulos.

Un alias no habilita acceso al nombre original: si solo se importa `f as g`,
el caller usa `g`. Se rechazan exports privados/inexistentes, aliases locales
duplicados y conflictos con declaraciones propias. Los diagnósticos muestran
nombres fuente y conservan archivo/línea. Cambiar solo el alias también modifica
la huella usada por la caché incremental.

## Namespaces estáticos

Un namespace importado no se materializa como objeto runtime. No se admite
pasarlo como valor ni acceder por índice calculado. Los miembros deben estar
exportados y tener un nombre estático. Un local homónimo oculta el namespace
y conserva sus accesos ordinarios a propiedades.

## Comptime y código generado

Los imports se resuelven antes de seleccionar sobrecargas para `@comptime`,
`@etsgen` y `comptime(...)`. Los fragmentos ETS reciben los aliases y namespaces
visibles en su punto de llamada, respetando sombras del caller y bindings
privados generados. `etsDefinition("alias", args...)` encuentra un import
renombrado del módulo de definición. Las posiciones de los strings generados
se conservan; su texto original no se reescribe.

Los nombres publicados por expansiones también admiten imports con alias; el
productor debe anunciarlos con `export { nombre }`. Ver
[generated-module-exports.md](./generated-module-exports.md).
La integración no interpreta ni reescribe fragmentos C++ opacos de `@cppgen`.

## Plantillas entre módulos

Las funciones genéricas exportadas y las privadas alcanzadas mediante
`etsDefinition` reciben su definición en el header común. Sus dependencias
globales se identifican por ámbito; los helpers privados necesarios reciben
linkage entre unidades sin convertirse en exports del dialecto. La búsqueda
continúa sobre dependencias genéricas hasta cerrar el conjunto.

Esto permite compilar y enlazar un helper genérico privado desde el caller,
incluidos helpers genéricos transitivos y funciones que usan constantes privadas.
La visibilidad semántica se valida antes de ajustar el linkage.

## Verificación

`test/unit/import-aliases.test.ts` contiene 31 pruebas. Cinco compilan y ejecutan
C++20 enlazando unidades separadas. Cubren aliases, namespaces, tipos, genéricos,
sobrecargas, parámetros, propiedades, etiquetas, sombras, errores, caché,
expansiones hijas y referencias explícitas al módulo de definición.

Ejemplo: `examples/imports-as/main.ets`, salida `8`, `8`, `7`.
