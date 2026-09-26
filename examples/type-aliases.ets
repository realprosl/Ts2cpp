// Type aliases: `type X = ...`. El alias es transparente — el compilador
// expande `NumberArray` a `number[]` antes de llegar a codegen, así que no
// aparece ningún `using` en el C++ generado.
type NumberArray = number[];
type Maybe = string | number;
type Pair<A, B> = [A, B];
interface Named { name(): string; }
interface Aged { age(): number; }
type Person<T extends Named = Named> = T;
let ns: NumberArray = [1, 2, 3];
let m: Maybe = "hello";
let p: Pair<string, number> = ["a", 1];
print(numberToString(length(ns)));
print(m);
print(p[0]);