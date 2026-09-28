// filesystem/copy-move — copia y luego mueve un archivo.
//
// Tras fileCopy el original sigue existiendo; tras fileMove el origen
// desaparece y aparece el destino.

let original: string = "filesystem-copy-move-orig.txt";
let copy: string = "filesystem-copy-move-copy.txt";
let moved: string = "filesystem-copy-move-dest.txt";
let existsOrig: boolean = false;
let existsCopy: boolean = false;
let existsCopyAfterMove: boolean = false;
let existsMoved: boolean = false;
let movedContent: string = "";

fileWrite(original, "contenido X");

fileCopy(original, copy);
existsOrig = fileExists(original);
existsCopy = fileExists(copy);

fileMove(copy, moved);
existsCopyAfterMove = fileExists(copy);
existsMoved = fileExists(moved);
movedContent = fileRead(moved);

print("existe_original=" + numberToString(existsOrig ? 1 : 0));
print("existe_copia=" + numberToString(existsCopy ? 1 : 0));
print("copia_tras_mover=" + numberToString(existsCopyAfterMove ? 1 : 0));
print("existe_destino=" + numberToString(existsMoved ? 1 : 0));
print("destino_contenido:[" + movedContent + "]");

fileRemove(original);
fileRemove(moved);