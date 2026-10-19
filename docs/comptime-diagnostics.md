# Ubicación de errores de `comptime`

El intérprete utiliza el mismo `Span` que el parser: inicio y fin con línea,
columna y offset. Los errores ya no reconstruyen una posición artificial en
línea cero ni utilizan el offset absoluto como columna.

Por ejemplo, una división por cero en la segunda línea muestra el archivo,
la línea del `return` y el fragmento `1 / 0`, en vez de una línea vacía:

```ts
const result = comptime(() => {
  return 1 / 0;
});
```

## Ubicación elegida

- Errores de operaciones, lecturas TDZ o valores no disponibles: el nodo que
  provoca el fallo.
- Presupuesto de instrucciones: el nodo cuya ejecución agota el contador.
- Valores locales y colecciones: el punto donde se comprueba el valor.
- Resultado de una evaluación raíz o de `@cppgen`: el call site que debe
  materializar ese resultado.
- Recursión excesiva: la llamada que sobrepasa la profundidad permitida.

Los códigos estructurados y el criterio de aplazamiento no cambian. Un error
de valores no disponibles conserva `COMPTIME_VALUE_UNAVAILABLE`; un fallo real
de evaluación no pasa a ser aplazable por cambiar su ubicación.

## Varios módulos

`compileFile` conserva rangos de líneas y offsets de cada fragmento del AST
combinado. Al devolver un diagnóstico, selecciona el módulo propietario y
ajusta inicio y fin, archivo y fuente. Un error dentro de una función
importada apunta a la dependencia, no se atribuye al entry.

Los offsets son índices de código UTF-16 de JavaScript, relativos al texto de
`diagnostic.source`, no offsets UTF-8 del archivo en disco. El loader elimina
imports manteniendo sus líneas vacías y normaliza los saltos de línea al
construir ese texto; las posiciones deben interpretarse contra la fuente
incluida en el diagnóstico.

Esto no proporciona source maps para el C++ generado ni una correspondencia
completa con el texto producido por `@etsgen`. Tampoco añade un stack de
llamadas estáticas al diagnóstico.

## Regresiones

`test/unit/comptime-diagnostics.test.ts` contiene 17 pruebas; todas fallaban
antes. Cubren división, TDZ, valores no disponibles, operaciones no soportadas,
`Math`, índices, ciclos, presupuestos, recursión, `@cppgen`, CRLF, Unicode,
formato del fragmento y remapeo del entry y de una dependencia.
