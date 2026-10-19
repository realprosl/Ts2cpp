# Validación del texto generado por `@etsgen`

La salida de `@etsgen` sigue siendo texto Estatic. El pipeline actual es:

1. Evaluar el generador y comprobar sus límites.
2. Parsear el Estatic y conservar el AST del fragmento.
3. Insertar las sentencias en el contexto de la llamada y ejecutar el checker.
4. Devolver los nodos Estatic como parte del AST completo.
5. Ejecutar el checker final y emitir C++ mediante el backend ordinario.

No se compila un fragmento C++ por separado ni se extrae el cuerpo de una
función artificial mediante regex. `@etsgen` ya no produce RawCppExpression.
`@cppgen` conserva ese escape específico de C++.

La expansión no añade un scope artificial en listas de sentencias. Por eso
se detectan duplicados internos, referencias inexistentes, tipos incompatibles y
mutaciones de const. El backend y la detección de cabeceras/backends recorren
los nodos reales, sin depender de metadatos generatedAst.

La fuente y la procedencia se conservan para depuración; ver
[etsgen-ast-pipeline.md](./etsgen-ast-pipeline.md).

## Errores

- `ETSGEN_GENERATED_PARSE`: sintaxis inválida en el texto generado.
- `ETSGEN_GENERATED_SEMANTIC`: error de tipos, mutabilidad o resolución en un
  nodo del fragmento generado.
- `ETSGEN_GENERATED_CONTEXT`: uso como expresión con valor, no como sentencia.
- El emisor C++ se ejecuta ahora en la fase ordinaria, sin extracción especial
  ni diagnóstico ETSGEN_GENERATED_CODEGEN propio de esta expansión.

La ubicación principal es la llamada al generador. Se incluye un fragmento del
texto de hasta 200 caracteres y, para errores semánticos del fragmento, una
nota con línea y columna dentro del texto generado. Los diagnósticos incluyen además una fuente estructurada
`generated`, que el formatter muestra con su propio excerpt. `compileFile` atribuye la
llamada al módulo correspondiente. Un conflicto detectado sobre un nodo
original del caller puede conservar el diagnóstico original del checker.

## Lo que sigue pendiente

Los bindings privados se renombran por identidad léxica antes de insertarlos.
Hay `etsCapture("nombre")` para capturas explícitas y se conservan las capturas
libres existentes por compatibilidad. Las expansiones recursivas usan el
entorno renombrado del padre y límites por raíz; ver
[etsgen-hygiene.md](./etsgen-hygiene.md).

La higiene de referencias al módulo de definición, las exportaciones generadas,
los ABI fijados por decoradores y source maps C++ no quedan resueltos por esta
pasada. No se garantizan todos los contextos de métodos, coroutines o retornos
dependientes del caller.

El primer chequeo del AST fuente sigue precediendo a la generación: esta
entrega no permite que el código fuente original use nombres que solo serán
introducidos por un generador posterior. El mini-evaluador, sus fallbacks y
sus límites siguen separados del intérprete principal.

## Verificación

`test/unit/etsgen-semantics.test.ts` aporta 22 regresiones; 16 fallan contra
v22. Cubre errores semánticos ocultos, const y colisiones del caller, capturas,
tipado de arrays y callbacks, cabeceras, backends, diagnóstico modular y una
prueba que impide volver a invocar el emisor de módulos para extraer el cuerpo.
La ruta AST y su procedencia añaden otras 12 regresiones, todas fallan contra v33.

Ejemplo nativo con una captura local y `map` generado:

```bash
mkdir -p build
node --experimental-strip-types src/cli.ts examples/etsgen-semantics/main.ets -o build/etsgen-semantics.cpp
g++ -std=c++20 -O2 -DNDEBUG -pthread -fno-exceptions -I. build/etsgen-semantics.cpp -o build/etsgen-semantics
./build/etsgen-semantics
```

Salida esperada y verificada: `12`. El ejemplo invoca explícitamente `runDemo`.
