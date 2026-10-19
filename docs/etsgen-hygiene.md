# Higiene léxica de bindings de @etsgen

El generador sigue devolviendo Estatic. Después del parseo, una pasada asigna
identidades a sus bindings y nombres frescos antes de insertar el AST en el
caller. El checker y el backend continúan procesando nodos ordinarios.

Las expansiones repetidas pueden declarar una variable con el mismo nombre,
incluso si existe otra en el caller. Cada binding conserva un id propio y sus
referencias se actualizan según el ámbito léxico: bloques, funciones, parámetros,
arrows, bucles y destructuring. Las declaraciones de tipos, clases y funciones
generadas conservan sus reglas de contexto del dialecto; por ejemplo, no se
añade soporte general de funciones C++ anidadas.

No se sustituyen ocurrencias textuales. Strings, nombres de campos, propiedades
y métodos se conservan. El destructuring de objetos mantiene la propiedad
original y renombra su binding local. Las etiquetas de parámetros de métodos
se conservan; los bindings mantienen identidades por ámbito. Los duplicados
dentro del mismo ámbito siguen siendo errores.

## Capturas

Las referencias libres existentes conservan la resolución desde el caller por
compatibilidad y se registran como externas. Dentro del Estatic generado,
`etsCapture("nombre")` pide explícitamente el binding del caller:

```ts
// Texto devuelto por el generador:
const value: number = etsCapture("value") + 1;
print(value);
```

Si el caller tiene value=10, el fragmento imprime 11 y el value original sigue
valiendo 10. El binding generado value tiene un nombre fresco; la captura no
se confunde con él. El marcador solo acepta un identificador literal y se
elimina del AST antes del chequeo. No es una función runtime ni evalúa texto.
La mutabilidad del caller sigue siendo comprobada por el checker.

## Expansiones anidadas

Las llamadas @etsgen incluidas en el Estatic generado se expanden en pasadas
posteriores, con sobrecargas resueltas por el checker. El hijo recibe el entorno
léxico del punto de llamada con las identidades ya renombradas del padre. Una
captura value del hijo encuentra el value del padre, si es visible allí.

Cada árbol raíz tiene límites acumulativos de bytes generados y cantidad de
expansiones, además de profundidad. Se reutilizan maxGeneratedBytes,
maxInstructions y maxRecursion respectivamente. Las raíces independientes
conservan presupuestos independientes. Los códigos son ETSGEN_GENERATED_LIMIT,
ETSGEN_EXPANSION_LIMIT y ETSGEN_RECURSION_LIMIT. No son límites duros de CPU o RSS.

Los cuerpos de los generadores se componen en el mini-evaluador y no se tratan
como callers runtime al recorrer el AST.

## Procedencia y límites

Program.generatedSources conserva bindings (id, nombre original, nombre emitido,
tipo de binding y posición), capturas (nombre, destino y modo explícito) y
parentId para expansiones hijas. Los spans enlazan bindings y referencias por
id. Los diagnósticos conservan el Estatic original y presentan sus nombres,
incluidos errores de fragmentos hijos. El AST sigue siendo serializable.

Las referencias externas legacy siguen resolviéndose en el caller. La API
`etsDefinition` permite referencias explícitas al módulo de definición y
`@etsPublish` publica declaraciones para el caller; ver
[etsgen-publication.md](./etsgen-publication.md). No es higiene modular completa.
Las declaraciones `export` generadas siguen rechazadas con ETSGEN_GENERATED_HYGIENE.
Tampoco se admiten todavía parameter properties generadas ni C++ opaco en esta pasada.
Los decoradores que fijan nombres C++ o ABI quedan fuera de esta garantía.

Los chequeos intermedios permiten publicaciones pendientes; el programa
expandido se valida estrictamente antes de ejecutar comptime. Se preservan
los errores en argumentos que desaparecerán durante la expansión.

## Verificación

etsgen-hygiene.test.ts aporta 20 pruebas; 15 fallan contra v34. Tres verificaciones
nativas cubren 12 casos de ámbitos/tipos, captura hija y un proyecto de dos
módulos compilado y enlazado. Incluyen expansiones repetidas, shadowing, closures,
bucles, destructuring, clases, aliases, genéricos, argumentos nombrados, errores
con procedencia y límites de expansión recursiva.

Ejemplo: examples/etsgen-hygiene/main.ets. Imprime 8 cuatro veces y después 99.
