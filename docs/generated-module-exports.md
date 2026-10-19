# Importar publicaciones de @etsgen

Un módulo puede exportar nombres que todavía no existen en el código fuente y
que una expansión `@etsgen` publicará después. Debe declarar explícitamente
su API con una lista de exports:

```ts
@etsgen function emit(): string {
  return "@etsPublish function answer(value: number): number { return value + 1; }";
}

emit();
export { answer };
```

Otro módulo puede usarla normalmente:

```ts
import { answer as add } from "./producer";
print(add(value: 7));
```

El generador sigue produciendo ETS. El parser crea sus nodos ordinarios; el
checker valida los tipos reales y C++ recibe declaraciones normales.
No se introducen firmas ficticias ni tipos `any` para aceptar el import.

## Declaración y confirmación de la API

La tabla de exports reserva una identidad por módulo para el nombre anunciado.
Se permite reservar nombres pendientes cuando el módulo define o importa un
generador `@etsgen`, incluso uno que también está pendiente de generación.
Los imports, aliases y namespaces se vinculan a esa misma identidad.

Al terminar la expansión, cada nombre pendiente debe corresponder a una
declaración `@etsPublish` generada en el nivel superior del módulo productor.
Se confirma antes del chequeo estricto del punto fijo y antes de continuar con
`comptime`. La ausencia produce `MODULE_GENERATED_EXPORT_MISSING`, aunque el
consumidor no utilice el import. El diagnóstico señala la lista de exports.

Una declaración privada generada, una publicación local a una función/bloque
o un generador que nunca se llama no satisfacen la reserva. Los duplicados y
las colisiones con bindings del módulo o imports siguen siendo errores.
Publicar con `@etsPublish` sin una lista de exports no expone automáticamente el
nombre al resto de módulos.

## Alcance comprobado

- Funciones, sobrecargas, variables, clases, interfaces y clases/funciones genéricas.
- Imports con `as`, imports de tipos y acceso mediante namespaces estáticos.
- Exportar la publicación con otro nombre o como default mediante
  `export { answer as default }`.
- Reexports transitivos, estrellas, diamantes y namespaces anidados.
- Generadores importados y expansiones hijas que publican en el módulo caller.
- Generadores generados, exportados e invocados desde otro módulo en pasadas posteriores.

Las variables exportadas mantienen `let`/`const`, un único almacenamiento y la
obligación de anotar explícitamente su tipo. El checker valida los argumentos
del consumidor, los parámetros nombrados y las APIs que exponen tipos privados.
Las identidades por módulo evitan mezclar publicaciones homónimas.

## Procedencia y visibilidad

Las capturas, nombres originales, identidades y `parentId` siguen disponibles
en `Program.generatedSources`. `--emit-etsgen` conserva el ETS original en disco.
La API pública usa nombres internos vinculados; el texto devuelto no se reescribe.

También se comprueba la visibilidad de las llamadas generadoras que ya fueron
eliminadas del AST. Una expansión no puede borrar el error de llamar un generador
ajeno sin importarlo. Si un fragmento necesita un helper del módulo donde se
define el generador, debe usar `etsDefinition("helper", argumentos...)`.
Ese marcador conserva el entorno y las reservas de exports al invocar otra
expansión hija desde el módulo caller.

## Límites

La reserva no ejecuta generadores por anticipado ni repite expansiones. Se
mantienen los límites de profundidad, cantidad y bytes por árbol de expansión.
Los argumentos siguen sujetos al subset estático del mini-evaluador de `@etsgen`.
Cuando la fuente necesita la API para tiparse, la expansión debe poder producirla
antes de evaluar los arrows `comptime` posteriores.

No se acepta `export` escrito dentro del fragmento: se usa `@etsPublish` en el
ETS generado y `export { nombre }` en el módulo fuente. Permanecen pendientes
el aislamiento universal de símbolos, los módulos cíclicos y completar los mapas por token/runtime. Los primeros
mapas C++ por tramos se describen en
[etsgen-cpp-source-maps.md](./etsgen-cpp-source-maps.md).

## Verificación

`test/unit/generated-module-exports.test.ts` aporta 28 pruebas. Cinco compilan,
enlazan y ejecutan unidades C++ separadas. Cubren publicaciones importadas,
tipos, genéricos, estado mutable, hijos, generadores generados, errores,
visibilidad y confirmación obligatoria de exports no utilizados.

Ejemplo: `examples/generated-module-exports/main.ets`, salida `7`, `ok`.
