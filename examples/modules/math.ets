export function sumRange(limit: number): number {
  let total: number = 0;
  for (let index: number = 0; index < limit; index = index + 1) {
    if (index == 2) { continue; }
    if (index == 8) { break; }
    total = total + index;
  }
  return total;
}
