# Origen C++ de fragmentos @etsgen

El CLI materializa automáticamente el ETS original y emite directivas C++
`#line` cuando hay expansiones. Los diagnósticos nativos pueden señalar
`etsgen-0.ets`, `etsgen-1.ets`, etc. en vez de quedar únicamente en el C++ final.
Al abandonar un tramo generado se restablecen el archivo C++ real y su línea
física. La concatenación unity se realiza antes de calcular esos retornos.

## Archivos

```sh
node --experimental-strip-types src/cli.ts \
  examples/generated-module-exports/main.ets -o build/generated.cpp

g++ -std=c++20 -pthread -fno-exceptions -I. build/generated.cpp -o build/generated
build/generated
```

El ejemplo imprime `7` y `ok`. Junto al C++ aparecen:

| Archivo | Contenido |
|---|---|
| `build/generated.cpp.map.json` | Rangos físicos del C++ y spans ETS originales |
| `build/generated.cpp.etsgen/etsgen-N.ets` | Texto exacto devuelto por cada generador |
| `build/generated.cpp.etsgen/manifest.json` | Generador, llamada, bindings, capturas y parentesco |

`--emit-etsgen directorio` permite elegir el destino de los fragmentos.
En `--multi`, el header y cada unidad tienen su propio `.map.json`. Si no hay
expansiones no se añaden directivas ni sidecars; al reescribir ese C++ se elimina
su sidecar anterior. Los fragmentos huérfanos no se eliminan automáticamente.

El build incremental guarda los fragmentos en `generatedDirectory/etsgen`.
Los hashes de unidades incluyen las directivas ya materializadas. El cache hit
comprueba los artefactos registrados y, si falta una fuente o mapa, vuelve al
recorrido que los reconstruye, conservando los objetos que aún sean válidos.

## De C++ a la llamada original

El mapa tiene `version: 1`, `cppFile`, `manifest` y `mappings`. Cada entrada
contiene un rango inclusivo `cppStartLine..cppEndLine`, `sourceFile` y
`origin: { id, span }` de ETS. Las líneas del mapa son físicas, aunque `#line`
cambie el nombre/línea que comunica el compilador.

El manifiesto conserva `generator` interno y añade `displayGenerator` con el
alias original cuando está disponible. `callLocation` señala el archivo y span
original de la llamada, corrigiendo las coordenadas del AST modular combinado.
Para expansiones hijas señala el ETS del padre y conserva `parentId`, permitiendo
recorrer la cadena hasta el archivo fuente.

No se altera el código retornado por el generador. Los marcadores de origen en
el C++ proceden de `Span.generated`; no se deducen buscando nombres en strings.
Los marcadores anidados restauran la procedencia del padre antes de salir al C++.

## API

`compile` y `compileFile` devuelven C++ con comentarios de delimitación de origen.
Para usar directivas con archivos físicos desde una integración propia:

```ts
await writeGeneratedSources(result.ast.generatedSources ?? [], directory);
await writeMappedCpp(result.header, headerPath,
  result.ast.generatedSources ?? [], directory);
```

Ambas funciones están en `src/codegen/etsgen-sources.ts`. El caller crea el
directorio del C++ y escribe el layout definitivo. Para unity debe concatenar
primero y materializar después; para multi se materializa cada archivo. La
función pura `mapCppSources` devuelve el texto y sus rangos sin escribir archivos.

## Precisión y límites

Es una primera capa por sentencia/declaración, con cobertura de cuerpos de
funciones, métodos, clases, campos, firmas y variables modulares. El span ETS
del JSON es el del nodo original. Las líneas C++ seguras se vuelven a anclar
al inicio de ese nodo ETS: una firma con `template` ya no desplaza el error a
la línea siguiente del fragmento. Esto también se aplica después de sentencias
anidadas y al salir de una expansión hija.

Un seguimiento léxico evita insertar directivas dentro de strings raw,
comentarios multilínea, strings prolongados con backslash o continuaciones de
macros. El contenido se conserva, incluidos CRLF, prefijos Unicode y comentarios
partidos por splices. Los comentarios con aspecto de marcador que estén dentro
de esos contextos no se interpretan como delimitadores.

Dentro de un payload multilínea que no se puede interrumpir de forma segura,
la numeración nativa todavía avanza con C++; el sidecar conserva el span ETS del
nodo. Las columnas nativas pertenecen al C++, no a la sintaxis ETS.

No es todavía un mapa por token o expresión, ni cubre toda síntesis auxiliar
del codegen. Tampoco convierte mensajes nativos a nombres higiénicos originales,
remapea errores de enlace o reconstruye stacks de runtime. Se conserva el
mensaje original de g++/clang; el manifiesto aporta el contexto de expansión.
Las pruebas nativas de esta entrega se ejecutan con g++.

## Verificación

`test/unit/cpp-source-map.test.ts` contiene 18 pruebas, cinco con g++. Cubren
retorno al archivo/línea C++ real, scopes anidados, rutas escapadas, límites
inválidos, ETS intacto, alias y ubicación local, unity, multi, firmas genéricas,
build incremental sin libuv y recuperación de artefactos borrados.

`test/unit/cpp-source-map-lines.test.ts` añade 15 regresiones, dos con g++:
precisión de líneas en firmas multilínea, preservación de strings/macros y
comentarios, splices CRLF y recuperación ante literales C++ inválidos. La prueba
CLI de firmas exige ahora la línea ETS exacta.
