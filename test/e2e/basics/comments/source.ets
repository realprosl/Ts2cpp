// comments — los comentarios de línea `//` y bloque `/* */` no afectan
// el output del programa. El dialecto los descarta antes del parser.

// Comentario de línea antes de código ejecutable.
print("primera línea"); // comentario al final de la línea

/* Comentario de bloque
   que ocupa varias líneas
   y no produce salida. */

print("segunda línea");

/*
 * Bloque con asteriscos decorativos.
 */
const x: number = 7; // asignación con comentario
print("x = " + numberToString(x));

// Comentario entre statements.
/* Otro comentario */ print("tercera línea");

/* Comentario
   /* anidado
   también debe descartarse */
print("cuarta línea");
