class Inventory {
  quantities: number[];
  metadata: [string, boolean];

  first(): number {
    return this.quantities[0];
  }
}

let values: number[] = [10, 20, 30];
values[1] = 25;

const metadata: [string, boolean] = ["active", true];
let inventory: Inventory = new Inventory(values, metadata);

print("Elementos: ", length(values));
print("Segundo: ", values[1]);
print("Etiqueta: ", metadata[0]);
print("Primer inventario: ", inventory.first());
