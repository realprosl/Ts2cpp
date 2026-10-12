// V30.8: `sort(cmp)` ordena in-place. El comparator debe devolver
// un numero (negativo si a<b) o un bool; el runtime lo adapta a bool.
let arr: number[] = [10, 2, 5, 1, 8];
arr.sort((a: number, b: number): number => a - b);
print(numberToString(arr[0]));   // 1
print(numberToString(arr[1]));   // 2
print(numberToString(arr[2]));   // 5
print(numberToString(arr[3]));   // 8
print(numberToString(arr[4]));   // 10
