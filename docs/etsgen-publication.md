# Publicación, módulo de definición y archivos de @etsgen

El contrato sigue siendo Estatic generado → parser → AST normal → checker →
C++. Estas APIs se escriben en el texto ETS retornado por el generador.

## 1. Publicar un nombre en el ámbito de la llamada

`@etsPublish` conserva deliberadamente el nombre de una declaración directa
del fragmento. El resto de los bindings continúa recibiendo nombres frescos.

```ts
@etsgen function emit(): string {
  return "@etsPublish function answer(value: number): number { return value + 1; }";
}
emit();
print(answer(value: 41));
```

Admite declaraciones simples de variable, función, clase e interface. No recibe
argumentos y se retira antes del checker. Los parámetros de una función pública
conservan sus etiquetas para argumentos nombrados. Las variables mantienen
`let`/`const`, orden de declaración y ámbito habituales. La identidad del binding
sigue registrada aunque el nombre emitido coincida con el original.

Una publicación puede colisionar con una declaración del caller; el checker
rechaza duplicados y firmas repetidas. Las sobrecargas válidas se conservan.
Los privados siguen ocultos. No se admite publicar destructuring ni declaraciones
de bloques interiores. Un `@etsPublish` escrito fuera del texto generado es error.

Publicar en el caller no equivale a `export` de un módulo. Para importar nombres que solo
serán declarados por una expansión, el productor debe anunciarlos con
`export { nombre }` en la fuente. Ver
[generated-module-exports.md](./generated-module-exports.md). `export` dentro
del fragmento sigue rechazado. La visibilidad y las colisiones entre módulos
se comprueban también después de expandir.

## 2. Comprobar el programa después de publicar

Los chequeos intermedios resuelven sobrecargas y pueden aplazar errores de
nombres que introducirán expansiones posteriores. Los errores dentro de los
argumentos de las llamadas generadoras son fatales antes de borrar esas llamadas.
El punto fijo de expansión se valida estrictamente antes de evaluar `comptime`.
Se conserva también el chequeo final del programa evaluado.

Esto permite que el código fuente use la publicación de una expansión hija y
que un fragmento padre use un nombre que publica su hijo. No se acepta el
programa si quedan referencias sin resolver ni se borran errores de mutabilidad
o tipos dentro de un arrow `comptime`. Las comprobaciones intermedias conservan
las etiquetas inválidas de argumentos nombrados para que no desaparezca su error.

Los argumentos siguen sujetos al subset del mini-evaluador de `@etsgen`. Esta
fase no añade evaluación runtime ni permite que cualquier expresión pase a ser
constante. Una publicación necesaria para tipar la fuente debe poder expandirse
sin depender de la evaluación posterior de un arrow `comptime`.

## 3. Referirse al módulo del generador

`etsDefinition("nombre")` lee una variable de nivel superior visible desde el
módulo donde se define el generador. `etsDefinition("función", argumentos...)`
invoca una función de ese entorno. Los argumentos se resuelven en el ámbito
léxico del fragmento/caller, manteniendo sus tipos y las reglas de sobrecarga.

```ts
// lib.ets
const base: number = 7;
function helper(value: number): number { return value + 1; }
@etsgen export function emit(): string {
  return "print(etsDefinition(\"helper\", etsCapture(\"value\"))); print(etsDefinition(\"base\"));";
}
```

Aunque el caller tenga un `helper` o `base` local, estos marcadores usan los
símbolos del módulo de definición. Los helpers privados necesarios reciben
linkage C++ entre unidades sin convertirse en exports del dialecto. Se conserva
su visibilidad semántica; un acceso ordinario desde otro módulo sigue rechazado.
El registro de capturas identifica estas referencias con `kind: "definition"`.

El nombre debe ser un identificador literal y pertenecer al módulo del generador
o a sus imports explícitos. No se accede a módulos ajenos por coincidencia de
nombre. La primera versión cubre variables simples y funciones de nivel superior;
no tipos ni scopes locales de definición. Las funciones genéricas entre módulos
ya reciben su cuerpo en el header, junto con las declaraciones de sus dependencias
privadas. La búsqueda continúa sobre helpers genéricos transitivos. Ver
[import-aliases.md](./import-aliases.md). Las sobrecargas mantienen el linkage necesario.

Se mantiene la protección temporal frente a homónimos top-level entre módulos.
Las referencias libres legacy continúan resolviéndose desde el caller;
`etsCapture` selecciona el caller explícitamente. Por tanto, esta API mejora el
acceso de definición explícito y no promete higiene modular completa.

## 4. Guardar los fragmentos ETS para depurarlos

```bash
node --experimental-strip-types src/cli.ts examples/etsgen-publication/main.ets \
  -o build/publication.cpp --emit-etsgen build/generated-ets
```

El directorio recibe `etsgen-0.ets`, `etsgen-1.ets`, etc. y un `manifest.json`
versionado. Cada archivo contiene exactamente el ETS original, con sus nombres
y espacios, sin el wrapper del parser ni los nombres internos de higiene.
El manifiesto relaciona archivo, id, generador, llamada, módulo de definición,
parentId, bindings y capturas. Solo sus entradas describen la ejecución actual;
archivos anteriores no referenciados no se eliminan.

La opción funciona en unity y `--multi`. Si hay configuración incremental se
usa el recorrido completo para obtener los fragmentos de esta ejecución. En
errores de generación se guardan los fragmentos presentes en los diagnósticos,
no se promete un volcado completo de una compilación fallida. La API Node
equivalente es `writeGeneratedSources(program.generatedSources ?? [], directory)`.

El volcado se integra con directivas `#line` y mapas de tramos C++ en el CLI,
que también lo produce automáticamente cuando hay expansiones. Ver
[etsgen-cpp-source-maps.md](./etsgen-cpp-source-maps.md) para alcance y precisión.
Los stacks de runtime siguen pendientes.

## Verificación

`test/unit/etsgen-publication.test.ts` cubre publicación, ámbitos, mutabilidad,
sobrecargas, preservación de errores fuente, hijos, definición, límites de
visibilidad y CLI. Dos pruebas compilan y ejecutan C++20; una enlaza dos unidades
de traducción independientes. El ejemplo de dos módulos imprime `42`, `8`, `7`.
