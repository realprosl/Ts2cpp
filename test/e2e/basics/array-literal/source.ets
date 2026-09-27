// array-literal — literales, acceso por índice, longitud con `length()`.

const nums: number[] = [10, 20, 30, 40, 50];

print("nums[0] = " + numberToString(nums[0]));
print("nums[2] = " + numberToString(nums[2]));
print("nums[4] = " + numberToString(nums[4]));

// Longitud.
print("length(nums) = " + numberToString(length(nums)));

// Suma por acceso directo.
const sum: number = nums[0] + nums[1] + nums[2];
print("sum = " + numberToString(sum));

// Array vacío.
const empty: number[] = [];
print("length(empty) = " + numberToString(length(empty)));

// Array de strings.
const words: string[] = ["uno", "dos", "tres"];
print("words[1] = " + words[1]);
print("length(words) = " + numberToString(length(words)));

// Reasignación de un elemento con `let`.
let values: number[] = [1, 2, 3];
print("values antes = " + numberToString(values[1]));
values[1] = 99;
print("values despues = " + numberToString(values[1]));

// Array inferido (sin anotación explícita).
const implicit = [7, 8, 9];
print("implicit[0] = " + numberToString(implicit[0]));
print("length(implicit) = " + numberToString(length(implicit)));
