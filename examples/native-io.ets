let error: string = "";
const source: string = argument(1);
const copy: string = source + ".copy";
const moved: string = source + ".moved";

if (writeFile(source, "hello", error) == false) {
  printError(error);
} else {
  if (appendFile(source, " native", error) == false) {
    printError(error);
  }
}

let contents: string = "";
if (readFile(source, contents, error)) {
  write("Contenido: ");
  print(contents);
}

if (copyFile(source, copy, error) && moveFile(copy, moved, error)) {
  print("Movido: ", fileExists(moved));
}

if (removeFile(source, error) == false) { printError(error); }
if (removeFile(moved, error) == false) { printError(error); }

if (fail("error controlado", error) == false && hasError(error)) {
  writeError("Diagnóstico: ");
  printError(error);
}
clearError(error);
