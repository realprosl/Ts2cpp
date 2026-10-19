# Default, reexports e imports multilínea

`compileFile` y el CLI resuelven una tabla de nombres públicos antes de combinar
los AST. Cada export apunta a su declaración original o a un namespace estático.
Los barrels no crean copias de símbolos ni convierten reexports en imports locales.

| Sintaxis | Comportamiento |
| --- | --- |
| `export default function named(...)` | Publica la función como `default`; su nombre interno no se exporta automáticamente |
| `export default function(...)` / `class {...}` | Admite funciones, genéricos y clases anónimas; el parser asigna un nombre interno reservado |
| `export default expresión` | Infiere el tipo y evalúa una vez la expresión al llegar a esa sentencia durante la inicialización del módulo |
| `import Default, { name as local } from "./lib"` | Resuelve default y nombres explícitos independientemente |
| `export { local as publicName }` | Publica la identidad local; también puede reenviar un import local o un namespace |
| `export { original as renamed } from "./lib"` | Reenvía el export de origen conservando identidad, tipo y sobrecargas |
| `export { default as Name } from "./lib"` | Reenvía el default como nombre; también admite reenviarlo como default |
| `export * from "./lib"` | Reenvía exports nombrados; excluye default |
| `export * as model from "./lib"` | Publica un namespace estático, incluidos sus tipos y default |

## Multilínea y posiciones

El descubrimiento de dependencias utiliza tokens del lexer. Admite listas
multilínea, comentarios, imports mixtos, trailing commas y varias declaraciones
en una línea. No confunde strings ni comentarios con imports. Los caracteres
retirados para el parser se sustituyen por espacios; se conservan saltos de
línea y offsets, incluidos CRLF.

```ts
import Default, {
  original as renamed,
} from "./lib";
```

Las formas `import type` y `export type` conservan la semántica previa del
dialecto para tipos: no añaden la distinción completa de borrado de TypeScript.

## Snapshot y binding vivo

```ts
let current: number = 7;
current = 8;
export default current;
export { current as live };
current = 9;
```

El consumidor recibe default=8 y live=9. El default de una expresión conserva
el resultado tomado en esa sentencia; el export nombrado sigue vinculado al
almacenamiento original. Las funciones y clases default declaradas conservan su
identidad. Los imports continúan sujetos a las reglas de mutabilidad del dialecto.

Las declaraciones nombradas exportadas siguen requiriendo anotación explícita
para variables. La inferencia nueva corresponde al valor default sintetizado;
la validación pública posterior también comprueba que no exponga tipos privados.

## Identidad y errores

Las cadenas de reexports y diamantes conservan el mismo símbolo. La dependencia
se carga e inicializa una sola vez. Los destinos que requieren normalización
reciben nombres internos frescos antes del checker y de `comptime`, incluyendo
los exports alcanzados por reexports y los homónimos fuente privados. Se
conserva una protección para publicaciones generadas sin reserva explícita.
Ver [module-symbols.md](./module-symbols.md).

Un reexport no permite usar el nombre en el código del barrel: para eso también
debe importarse explícitamente. Los exports privados/inexistentes y duplicados
son errores. Dos estrellas que aportan el mismo nombre desde destinos distintos
producen `MODULE_EXPORT_AMBIGUOUS`; un export explícito con ese nombre resuelve
la selección. Dos caminos al mismo destino no producen esa ambigüedad.

Los namespaces pueden reenviarse y anidarse, por ejemplo `top.api.Box` o
`new model.default(7)`. Siguen siendo estáticos: no son objetos runtime ni
admiten acceso por índice calculado.

## Generación y límites

Se pueden importar y reenviar generadores `@etsgen` default. Los imports del
módulo de definición siguen disponibles para `etsDefinition`, incluso si llegan
por un barrel. Los fragmentos generados conservan aliases, namespaces y procedencia.

Los nombres introducidos por una expansión se pueden importar con una lista
fuente `export { nombre }` y `@etsPublish`; ver
[generated-module-exports.md](./generated-module-exports.md). Siguen pendientes
el aislamiento universal de símbolos, los módulos cíclicos y completar los mapas por token/runtime. Los primeros
mapas C++ por tramos se describen en
[etsgen-cpp-source-maps.md](./etsgen-cpp-source-maps.md).
La resolución de módulos descrita aquí pertenece a `compileFile`/CLI; las APIs
de parseo y análisis de AST aislado no cargan grafos de dependencias.

## Verificación

`test/unit/module-exports.test.ts` aporta 29 pruebas. Cinco compilan y ejecutan
proyectos con unidades C++ separadas: defaults, snapshot/binding vivo,
reexports en diamante, namespaces anidados y generación ETS mediante barrels.
Incluyen errores de exports y posiciones tras imports multilínea.

Ejemplo: `examples/module-exports/main.ets`, imprime `8`, `8`, `9`.
