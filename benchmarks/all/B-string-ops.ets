// B-string-ops: concatenacion de strings + template literals.
// Mide el coste de std::string + to_string + allocacion.

function buildMessage(name: string, n: number): string {
  return `Hello, ${name}! You are number ${numberToString(n)} on the list.`;
}

let acc: number = 0;
for (let i: number = 0; i < 100000; i = i + 1) {
  const msg: string = buildMessage("Alberto", i);
  // Dummy use para evitar dead-code elimination. Imprimimos
  // 1 sola vez al final para que el compilador no elimine el msg.
  if (i == 0) {
    print(msg);
  }
  acc = acc + i;
}

print(numberToString(acc));
