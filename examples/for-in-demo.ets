// Demo de `for..in`: itera sobre los índices de un array o las claves de un Map.
// La variable ligada es de tipo `number` para arrays y de tipo `K` para Map<K,V>.

let xs: number[] = [10, 20, 30];
for (const i in xs) print("idx=" + numberToString(i));

let m: Map<string, number> = new Map<string, number>();
m.set("alpha", 1);
m.set("beta", 2);
for (const k in m) print("key=" + k);
