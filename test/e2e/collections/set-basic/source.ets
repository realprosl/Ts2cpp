// set-basic — ciclo completo de un `Set<T>`.
//
// Crea un conjunto, añade elementos, comprueba pertenencia y reporta
// el tamaño. Es el equivalente "solo-claves" del test `map-basic`.

let tags: Set<string> = new Set<string>();
tags.add("red");
tags.add("green");
tags.add("blue");

let hasGreen: string = "no";
if (tags.has("green")) { hasGreen = "yes"; }
print(hasGreen);

let hasPurple: string = "no";
if (tags.has("purple")) { hasPurple = "yes"; }
print(hasPurple);

print(numberToString(tags.size()));
