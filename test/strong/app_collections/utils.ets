// V30.52: Utilidades de strings y colecciones.

export function joinStrings(parts: string[], sep: string): string {
  let result: string = "";
  let i: number = 0;
  let len: number = length(parts);
  while (i < len) {
    if (i > 0) {
      result = result + sep;
    }
    result = result + parts[i];
    i = i + 1;
  }
  return result;
}

export function sum(numbers: number[]): number {
  let total: number = 0;
  let i: number = 0;
  let len: number = length(numbers);
  while (i < len) {
    total = total + numbers[i];
    i = i + 1;
  }
  return total;
}

export function countWhere(numbers: number[], threshold: number): number {
  let count: number = 0;
  let i: number = 0;
  let len: number = length(numbers);
  while (i < len) {
    if (numbers[i] > threshold) {
      count = count + 1;
    }
    i = i + 1;
  }
  return count;
}
