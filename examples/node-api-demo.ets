// Demo de los built-ins estilo Node añadidos tras console y fs.

console.log("--- path ---");
console.log("dirname('/tmp/a/b.txt') =", path.dirname("/tmp/a/b.txt"));
console.log("basename('/tmp/a/b.txt') =", path.basename("/tmp/a/b.txt"));
console.log("extname('/tmp/a/b.txt') =", path.extname("/tmp/a/b.txt"));
console.log("isAbsolute('/tmp/a') =", path.isAbsolute("/tmp/a"));
console.log("isAbsolute('relativo') =", path.isAbsolute("relativo"));
console.log("normalize('/tmp/a/../b//c') =", path.normalize("/tmp/a/../b//c"));
console.log("join(['/tmp','a','b','c.txt']) =", path.join(["/tmp", "a", "b", "c.txt"]));
console.log("resolve(['.','build','app']) =", path.resolve([".", "build", "app"]));

console.log("--- process ---");
console.log("argc =", process.argc());
const args: string[] = process.argv();
console.log("argv length =", length(args));
if (length(args) > 0) console.log("argv[0] =", args[0]);
console.log("cwd =", process.cwd());

console.log("--- JSON ---");
const escaped: string = JSON.stringify("hola\nmundo\t\"!\"");
console.log("stringify =", escaped);
