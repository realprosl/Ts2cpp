// V30.52: App que prueba arrays, strings, y funciones cross-module.

import { joinStrings, sum, countWhere } from "./utils.ets";

// Arrays y strings.
let words: Array<string> = ["hola", "mundo", "foo", "bar"];
print("joined:");
print(joinStrings(words, ", "));

let numbers: Array<number> = [10, 20, 30, 40, 50];
print("sum:");
print(numberToString(sum(numbers)));

print("count > 25:");
print(numberToString(countWhere(numbers, 25)));

// Comptime inline: comptime() con un array literal.
let comptimeArr: Array<number> = comptime((): Array<number> => [1, 2, 3, 4, 5]);
print("comptime sum:");
print(numberToString(sum(comptimeArr)));
