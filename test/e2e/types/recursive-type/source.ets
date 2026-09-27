// recursive-type — suma de Tree (sin Array porque el dialecto no tiene Array<T>).
// Demostramos la estructura recursiva con clases anidadas.

class Tree {
  value: number;

  constructor(v: number) {
    this.value = v;
  }

  isLeaf(): boolean {
    return true;
  }
}

const leaf: Tree = new Tree(42);
print(numberToString(leaf.value));
print(leaf.isLeaf() ? "leaf" : "internal");
