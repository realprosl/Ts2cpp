// un-none — unNone<T>(), unIsSome devuelve false.

class Item { value: number; constructor(v: number) { this.value = v; } }

const empty: Un<Item> = unNone<Item>();
print(unIsSome(empty) ? "some" : "none");
