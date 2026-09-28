// filesystem/exists — fileExists devuelve true/false según presencia.
//
// Crea un archivo, comprueba que existe, lo borra, comprueba que no existe.

let path: string = "filesystem-exists.txt";
let beforeCreate: boolean = false;
let afterCreate: boolean = false;
let afterRemove: boolean = false;

beforeCreate = fileExists(path);
fileWrite(path, "datos");
afterCreate = fileExists(path);
fileRemove(path);
afterRemove = fileExists(path);

print("antes=" + numberToString(beforeCreate ? 1 : 0));
print("despues_crear=" + numberToString(afterCreate ? 1 : 0));
print("despues_borrar=" + numberToString(afterRemove ? 1 : 0));