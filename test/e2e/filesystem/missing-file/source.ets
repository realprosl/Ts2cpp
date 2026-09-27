// filesystem/missing-file — leer un archivo inexistente devuelve "".
//
// La versión simple (sin Result<T>) descarta el error y devuelve string vacío.
// fileExists también devuelve false, no aborta.

let path: string = "filesystem-missing-file-no-existe.txt";
let exists: boolean = false;
let content: string = "";
let contentLength: number = 0;

exists = fileExists(path);
content = fileRead(path);
contentLength = length(content);

print("existe=" + numberToString(exists ? 1 : 0));
print("contenido:[" + content + "]");
print("longitud=" + numberToString(contentLength));