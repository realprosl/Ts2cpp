// filesystem/append — añade contenido a un archivo existente.
//
// Verifica que fileAppend concatena al final del archivo.

let path: string = "filesystem-append.txt";
let contents: string = "";
fileWrite(path, "primera");
fileAppend(path, " segunda");
fileAppend(path, " tercera");
contents = fileRead(path);
print("contenido:[" + contents + "]");
fileRemove(path);