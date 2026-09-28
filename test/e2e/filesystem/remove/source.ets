// filesystem/remove — fileRemove borra un archivo y devuelve boolean.
//
// Verifica que tras remove, fileExists devuelve false y que fileRemove
// sobre un archivo inexistente devuelve false (sin abortar).

let path: string = "filesystem-remove.txt";
let existsBefore: boolean = false;
let removed: boolean = false;
let existsAfter: boolean = false;
let secondRemove: boolean = false;

fileWrite(path, "adios");
existsBefore = fileExists(path);
removed = fileRemove(path);
existsAfter = fileExists(path);
secondRemove = fileRemove(path);

print("existe_antes=" + numberToString(existsBefore ? 1 : 0));
print("borrado=" + numberToString(removed ? 1 : 0));
print("existe_despues=" + numberToString(existsAfter ? 1 : 0));
print("segundo_borrado=" + numberToString(secondRemove ? 1 : 0));