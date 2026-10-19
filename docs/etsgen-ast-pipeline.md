# Estatic generado, AST normal y diagnóstico del fragmento

`@etsgen` produce Estatic. Su texto se parsea y el AST resultante se inserta
en el programa, donde el type checker y el backend ordinarios lo gestionan.
El autor sigue escribiendo Estatic; no necesita construir nodos manualmente.

La función sintética usada para parsear un fragmento no llega a C++. Ya no se
compila el fragmento aisladamente, se extrae un cuerpo con regex ni se introduce
un RawCppExpression. Esto permite, por ejemplo, emitir funciones generadas en
el nivel superior real y conservar sus nodos y tipos durante la emisión.

## Procedencia para depuración

Cada expansión conserva un registro en `Program.generatedSources`:

- id único dentro del programa combinado, por ejemplo `etsgen:0`;
- nombre del generador, Estatic generado completo y span de la llamada.

Los spans de los nodos generados contienen `generated.id` y las coordenadas
internas del fragmento. Sus coordenadas primarias apuntan a la llamada para
que el loader mantenga el módulo propietario y las fases posteriores puedan
remapear la ubicación al archivo original. No hay enlaces a padres ni ciclos
en el AST; sigue siendo serializable.

Los diagnósticos de sintaxis y tipos incluyen `Diagnostic.generated`, con la
fuente, el generador, el identificador y el span interno. El formatter muestra
dos ubicaciones: la llamada del usuario y el Estatic del fragmento. El excerpt
interno se limita alrededor del error, aunque el fragmento sea largo.

Por ejemplo, si la segunda línea generada contiene `let bad: string = 1;`,
la salida incluye el contexto siguiente, además del mensaje del checker:

```text
  --> main.ets:3:1
3 | emit();
  | ^^^^^^
  ::: fragmento @etsgen 'emit' [etsgen:0.ets]:2:1
2 | let bad: string = 1;
  | ^^^^^^^^^^^^^^^^^^^^
```

El parser usa `ETSGEN_GENERATED_PARSE`; el chequeo semántico usa
`ETSGEN_GENERATED_SEMANTIC`. Una revalidación posterior del AST conserva esta
procedencia. Un error sobre un nodo original del caller puede conservar su
diagnóstico original, por ejemplo un conflicto atribuido a una declaración
original. No se etiqueta como generado un error ajeno al fragmento.

La fuente virtual se conserva en memoria y en el AST devuelto. La opción
`--emit-etsgen directorio` guarda sus archivos `.ets` originales y un manifiesto.
El CLI ya materializa `#line` y sidecars para diagnósticos C++ por tramos; ver
[etsgen-cpp-source-maps.md](./etsgen-cpp-source-maps.md). Faltan precisión por
token, cobertura total y remapeo de errores runtime.

## Prioridad siguiente

La higiene léxica de bindings privados ya se aplica después del parseo:
identidades, nombres frescos, capturas y expansión anidada acotada. Se describe
en [etsgen-hygiene.md](./etsgen-hygiene.md). La publicación `@etsPublish`, los
chequeos antes de comptime, `etsDefinition` y el volcado de ETS se describen en
[etsgen-publication.md](./etsgen-publication.md). Quedan pendientes identidades
modulares completas y completar los mapas C++ por token y runtime. Los imports
de nombres generados se
describen en [generated-module-exports.md](./generated-module-exports.md). El
mini-evaluador sigue separado; la expansión recursiva ya tiene límites propios.

## Verificación

`etsgen-ast-pipeline.test.ts` añade 12 pruebas, todas fallan contra v33.
Cubren AST real, fragmentos vacíos, identidades independientes, fuente intacta,
errores de parser y checker, CRLF/Unicode, excerpts largos, revalidación y
atribución entre módulos. Una compila y ejecuta una función generada en C++20.

Ejemplo ejecutable: `examples/etsgen-ast-pipeline/main.ets`.

```bash
node --experimental-strip-types src/cli.ts examples/etsgen-ast-pipeline/main.ets -o build/etsgen-ast-pipeline.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/etsgen-ast-pipeline.cpp -o build/etsgen-ast-pipeline
./build/etsgen-ast-pipeline
```

Salida esperada y verificada: `5`.
