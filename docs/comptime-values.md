# Presupuesto de valores de `comptime`

El límite `maxValueBytes` del intérprete principal ya no trata cualquier string
como una constante de ocho bytes. Cuenta su payload UTF-8 y el de las claves de
objetos. También comprueba argumentos, resultados y crecimiento de colecciones,
incluidos valores que una función calcula y luego descarta.

## Modelo lógico

Cada comprobación suma al presupuesto de la evaluación raíz:

| Valor inspeccionado | Cargo lógico |
|---|---|
| Escalar no string | 8 bytes |
| String | 8 bytes + payload UTF-8 |
| Array | 8 bytes + cargos de sus elementos |
| Objeto | 8 bytes + payload UTF-8 de claves + cargos de valores |

El recorrido comprueba el límite incrementalmente, sin esperar a recorrer todo
el valor. Usa la ruta activa para detectar ciclos: dos referencias al mismo
objeto sin ciclo son válidas, aunque su contenido se facture de nuevo.

Concatenaciones, templates y `join` calculan un cargo por partes, incluidos los
separadores, antes de construir el string final. Este cálculo puede ser
conservador cuando un par sustituto UTF-16 está partido entre dos strings.

`push` factura cada valor añadido, no una copia lógica del array completo en
cada inserción. Una asignación fuera del array factura los huecos antes de
ampliarlo. Los índices inválidos producen `COMPTIME_INVALID_INDEX`. Las
asignaciones a campos cuentan el valor y la clave si es nueva.

Los checks de mutación rechazan ciclos antes de modificar el destino. Los
resultados de helpers, funciones decoradas, arrows y operaciones de array se
comprueban antes de continuar o de convertirse en literales.

Los errores usan códigos estables:

- `COMPTIME_VALUE_LIMIT`: presupuesto de valores agotado.
- `COMPTIME_CYCLIC_VALUE`: el valor introduce un ciclo no representable como
  literal del dialecto.

No son errores aplazables de valores runtime. Los presupuestos siguen siendo
independientes entre raíces y compartidos por sus llamadas anidadas.

## Límites de esta garantía

Es un presupuesto acumulativo de valores lógicos, no un contador de bytes
reales del heap JavaScript. Una variable, un argumento y un resultado pueden
facturar de nuevo el mismo contenido. Liberar una variable, sobrescribirla o
hacer `pop` no devuelve presupuesto. Los ocho bytes estructurales son una
convención del modelo, no el tamaño real de objetos, arrays o referencias.

No se limita el tamaño del código fuente ni el AST ya parseado, toda asignación
interna del motor JavaScript, la memoria retenida entre raíces ni el RSS total.
Las operaciones que producen arrays todavía pueden crear un temporal antes de
comprobarlo. El mini-evaluador de `@etsgen` tiene ahora presupuestos propios,
descritos en [`etsgen-limits.md`](./etsgen-limits.md).
Esto no certifica ausencia de fugas ni seguridad de memoria del runtime C++.

## Verificación

`test/unit/comptime-values.test.ts` aporta 28 regresiones; 24 fallan contra v19.
Incluye fronteras ASCII y UTF-8, emoji, strings superiores a 1 MiB, resultados
descartados, argumentos, claves, índices dispersos, ciclos y aliases válidos.
También cubre `array.length`: la rama existente era inalcanzable porque el
guard de objetos se ejecutaba antes de reconocer arrays.

Ejemplo nativo verificado:

```bash
mkdir -p build
node --experimental-strip-types src/cli.ts examples/comptime-values/main.ets -o build/comptime-values.cpp
g++ -std=c++20 -O2 -DNDEBUG -pthread -fno-exceptions -I. build/comptime-values.cpp -o build/comptime-values
./build/comptime-values
```

Salida esperada: `España 🙂` y `100`, en líneas separadas.
