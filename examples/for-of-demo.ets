// Demo de `for..of`: itera sobre los elementos de un iterable (array, string,
// tupla, Map<K,V> o Set<T>). El tipo de la variable ligada se infiere a partir
// del iterable y se registra en el ámbito del cuerpo.

let xs: number[] = [1, 2, 3];
for (const x of xs) print(numberToString(x));

for (const c of "ab") print(c);

let m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
m.set("b", 2);
for (const pair of m) print(pair[0] + "=" + numberToString(pair[1]));

let s: Set<string> = new Set<string>();
s.add("x");
s.add("y");
for (const v of s) print(v);
