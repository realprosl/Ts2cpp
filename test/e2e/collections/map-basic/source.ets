// map-basic — ciclo completo de un `Map<K, V>`.
//
// Crea un mapa, inserta varias entradas y demuestra:
//   - `set` para asignar
//   - `has` para comprobar pertenencia
//   - `size` para el conteo
//   - `forEach(value, key)` para iterar entradas y leer valores
//
// `Map.get(key)` no se usa porque devuelve `V | void` (no hay narrowing
// por flujo de control en el dialecto, ver LIMITATIONS.md). El iterador
// `forEach` permite acceder a cada valor sin esa fricción.

let scores: Map<string, number> = new Map<string, number>();
scores.set("alice", 10);
scores.set("bob", 20);
scores.set("carol", 30);

let hasAlice: string = "no";
if (scores.has("alice")) { hasAlice = "yes"; }
print(hasAlice);

let hasDave: string = "no";
if (scores.has("dave")) { hasDave = "yes"; }
print(hasDave);

print(numberToString(scores.size()));

// `forEach` itera como `(value, key)`. Acumulamos los valores en una
// variable capturada para verificar que la iteración visita todas las
// entradas y entrega el valor correcto.
let total: number = 0;
let seenKeys: number = 0;
scores.forEach((value: number, key: string) => {
  total = total + value;
  seenKeys = seenKeys + 1;
});

print(numberToString(total));
print(numberToString(seenKeys));
