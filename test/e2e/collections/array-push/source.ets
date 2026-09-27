// array-push — emula `push` reasignando con spread `...`.
//
// El dialecto no expone métodos sobre `T[]` (arrays), por lo que no
// existe `arr.push(x)` ni `arrayPush`. La forma idiomática de "empujar"
// un elemento es reasignar con spread: `arr = [...arr, x]`. Aquí se
// hace varias veces para verificar que el orden y la longitud son
// correctos.

let arr: number[] = [1, 2, 3];
arr = [...arr, 4];
arr = [...arr, 5];

print(numberToString(length(arr)));
print(numberToString(arr[0]));
print(numberToString(arr[1]));
print(numberToString(arr[2]));
print(numberToString(arr[3]));
print(numberToString(arr[4]));
