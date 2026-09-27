// satisfies-literal — `satisfies` con número (no acepta union en este dialecto).

const x: number = 42 satisfies number;
const y: string = "hola" satisfies string;

print(numberToString(x));
print(y);
