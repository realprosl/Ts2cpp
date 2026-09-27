// set-deduplication — `add` del mismo elemento no duplica.
//
// Reinsertar un valor ya presente en el Set no debe incrementar el
// tamaño ni cambiar el contenido. Lo verificamos contando entradas
// tras varias inserciones del mismo valor.

let numbers: Set<number> = new Set<number>();
numbers.add(1);
numbers.add(2);
numbers.add(3);
numbers.add(2); // duplicado
numbers.add(1); // duplicado
numbers.add(2); // duplicado

print(numberToString(numbers.size()));

// Re-añadimos otro duplicado por segunda vez.
numbers.add(3);
print(numberToString(numbers.size()));
