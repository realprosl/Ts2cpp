// filesystem/read-write — escribe un archivo y lo lee de vuelta.
//
// Helpers expuestos en runtime/ets_file.hpp (Issue #13):
//   - fileWrite(path, contents) -> boolean
//   - fileRead(path) -> string
//
// Los helpers usan paths relativos al cwd del runner (test/scratch/e2e/).

let path: string = "filesystem-read-write.txt";
let contents: string = "";
fileWrite(path, "hola mundo");
contents = fileRead(path);
print("leido:[" + contents + "]");
fileRemove(path);