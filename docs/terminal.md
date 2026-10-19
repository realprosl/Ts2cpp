# Terminal: objeto global console

`console` está disponible directamente desde ETS, sin imports ni instanciación. Los controles amplían sus métodos de logging
existentes; ya no se expone un builtin separado `term`.
Su backend es C++ propio, sin bibliotecas de terceros.

```ts
console.color("cyan");
console.style("bold");
console.writeLine("Hola desde ETS");
console.reset();
console.writeLine(`Tamaño: ${console.columns()} x ${console.rows()}`);
console.flush();
```

## Inclusión bajo demanda

`runtime/ets_terminal.hpp` se incluye solo cuando el AST emitido utiliza
uno de los métodos de terminal de `console`. `log/info/debug/trace/warn/error`
no activan esta cabecera. La detección consulta los tipos del checker: strings, comentarios,
nombres de propiedades y variables de usuario llamadas `console` no activan el
header. Un alias del objeto o una expansión `@etsgen` que lo use sí lo activan.
Las funciones comptime eliminadas tampoco lo activan.

La cabecera no se agrega a los headers generales del runtime. No incorpora
HTTP, libuv ni un event loop, y no añade flags de enlace de bibliotecas externas.
En proyectos multi se incluye desde la cabecera común cuando algún módulo lo
necesita. Se sigue el AST que se emite, sin un análisis adicional de alcanzabilidad
para eliminar funciones runtime no llamadas.

## API de la primera fase

| Método | Resultado | Operación |
|---|---|---|
| `console.write(text: string)` | `boolean` | Escribe texto en stdout, sin flush implícito |
| `console.writeLine(text: string)` | `boolean` | Escribe texto y salto de línea |
| `console.flush()` | `boolean` | Vacía stdout y comprueba su estado |
| `console.isTTY()` | `boolean` | Detecta si stdout es una terminal |
| `console.supportsAnsi()` | `boolean` | Comprueba/prepara controles ANSI |
| `console.columns()` | `number` | Columnas visibles, o `0` si no están disponibles |
| `console.rows()` | `number` | Filas visibles, o `0` si no están disponibles |
| `console.color(name: string)` | `boolean` | Color de primer plano |
| `console.background(name: string)` | `boolean` | Color de fondo |
| `console.style(name: string)` | `boolean` | Aplica un estilo |
| `console.reset()` | `boolean` | Restablece colores y estilos predeterminados |
| `console.clear()` | `boolean` | Limpia pantalla visible y lleva el cursor a 1,1 |
| `console.clearLine()` | `boolean` | Limpia la línea y vuelve a la primera columna |
| `console.moveTo(row: number, column: number)` | `boolean` | Posición absoluta, coordenadas desde 1 |
| `console.moveBy(rows: number, columns: number)` | `boolean` | Movimiento relativo: positivos abajo/derecha |
| `console.hideCursor()` | `boolean` | Oculta el cursor |
| `console.showCursor()` | `boolean` | Muestra el cursor |

Colores: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`
y `default`. Estilos: `bold`, `dim`, `italic`, `underline`, `inverse` y
`strikethrough`. Los estilos admitidos visualmente dependen del emulador.

Las coordenadas deben ser enteros finitos: `moveTo` admite 1..65535 y `moveBy`
-65535..65535. Un nombre o coordenada inválido devuelve `false` sin emitir
secuencias. Los argumentos son posicionales; no se admiten argumentos de tipo,
propiedades ni extracción de métodos como `const write = console.write`.

Se puede conservar un handle inferido: `const output = console; output.write("ok");`.
Todos los handles representan la misma salida y comparten el estado de estilos.
Las operaciones individuales se serializan; una secuencia de varias llamadas
no constituye una transacción entre hilos.

## Pipes, capacidades y errores

Con stdout redirigido, `write` y `writeLine` siguen escribiendo texto; los
controles devuelven `false` sin emitir ANSI. `TERM=dumb` también desactiva
controles. En POSIX se requiere un `TERM` no vacío para habilitarlos.
`NO_COLOR` no vacío desactiva `color` y `background`, conservando cursor y estilos.

`true` indica que se aceptó/escribió la operación, no confirma que el emulador
haya dibujado un estilo concreto. Como la escritura está bufferizada, también
hay que comprobar `flush()` para detectar errores diferidos. El objeto usa stdout;
no controla stdin, stderr ni ventanas arbitrarias.

## Plataformas y restauración

- Linux/macOS: `isatty`, `ioctl(TIOCGWINSZ)` y secuencias ANSI.
- Windows: consola nativa, VT en terminales compatibles y `WriteConsoleW` para
  texto UTF-8 en consola. Con salida redirigida se escribe el flujo normal.
  Si no se puede activar VT, los controles devuelven `false`. Al activar VT se
  conserva el modo anterior para restaurarlo al terminar normalmente.

No se consulta ni conserva un snapshot del estilo/cursor previo en POSIX:
si se aplicaron estilos se restablecen a los predeterminados al salir; si `console`
ocultó el cursor y no se volvió a mostrar, intenta dejarlo visible. La restauración
normal es best effort, no una garantía ante abort, señales o terminación forzada.
No se cambian modos de entrada ni se instala ningún handler de señales.

Esta entrega se ha compilado y ejecutado en Linux, con pipes y pseudoterminales.
Los backends Windows/macOS están implementados pero todavía no se han compilado
ni ejecutado en sus plataformas. No se afirma compatibilidad verificada allí.

## Pendientes

Lectura de teclado, modos raw/echo, pantalla alternativa, sesiones interactivas,
colores RGB y pruebas nativas Windows/macOS. Toda ampliación pública continuará
bajo `console`; no se necesitan helpers globales adicionales.

## Verificación

`test/unit/terminal.test.ts` aporta 53 pruebas, doce con compilación y ejecución
C++ (cuatro usan PTY). Comprueban inclusión condicional, firmas, rechazos,
UTF-8, alias/sombras, pipes, ANSI, dimensiones, defaults de salida, argumentos
inválidos, restauración, ODR entre unidades y módulos ETS separados. La cabecera
standalone también se compila con `-Wall -Wextra -Werror` y sin excepciones.
Ejemplo: `examples/terminal/main.ets`.

Los métodos de logging siguen disponibles en el mismo objeto. Un handle como
`const output = console` puede usar ambos grupos. Los controles son métodos estáticos del mismo `ets_console` de C++. Sus
declaraciones viven en `ets_io.hpp` y sus definiciones inline en
`ets_terminal.hpp`, que se incluye solo al usarlos. La clase conserva la misma
definición en todas las unidades; no hay otro objeto global de terminal ni
reescritura de llamadas a un singleton separado.
`--minimal` incorpora IO cuando se usa `console`; el backend de terminal sigue
condicionado a sus métodos especializados. No se activa el runtime async completo
solo para utilizar `console`.
