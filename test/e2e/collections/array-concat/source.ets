// V30.8: `concat(b, c, ...)` une este array con N arrays y devuelve uno nuevo.
let a: number[] = [1, 2];
let b: number[] = [3, 4];
let c: number[] = [5, 6];
let unidos: number[] = a.concat(b, c);
print(numberToString(length(unidos)));   // 6
print(numberToString(unidos[0]));        // 1
print(numberToString(unidos[5]));        // 6
// concat con un solo argumento
let solo: number[] = [1, 2].concat([3]);
print(numberToString(solo[2]));   // 3
