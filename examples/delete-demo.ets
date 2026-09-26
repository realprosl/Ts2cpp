let m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
m.set("b", 2);
delete m["a"];
print(numberToString(m.size()));

let s: Set<string> = new Set<string>();
s.add("x");
s.add("y");
delete s["x"];
print(numberToString(s.size()));

let xs: number[] = [10, 20, 30];
delete xs[1];
print("len=" + numberToString(length(xs)) + " first=" + numberToString(xs[0]) + " second=" + numberToString(xs[1]));