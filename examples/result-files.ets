function safeDivide(left: number, right: number): Result<number> {
  if (right == 0) {
    return err<number>("division by zero");
  }
  return ok(left / right);
}

const path: string = argument(1);
const copy: string = path + ".copy";

const written: Result<boolean> = writeFile(path, "hello");
if (written.isOk() == false) {
  printError(written.error());
}

const appended: Result<boolean> = appendFile(path, " Result");
if (appended.isOk() == false) {
  printError(appended.error());
}

const contents: Result<string> = readFile(path);
if (contents.isOk()) {
  print(contents.value());
} else {
  printError(contents.error());
}

const copied: Result<boolean> = copyFile(path, copy);
if (copied.isOk() == false) {
  printError(copied.error());
}

const calculation: Result<number> = safeDivide(84, 2);
if (calculation.isOk()) {
  print(calculation.value());
}

const removedOriginal: Result<boolean> = removeFile(path);
const removedCopy: Result<boolean> = removeFile(copy);
if (removedOriginal.isOk() == false) { printError(removedOriginal.error()); }
if (removedCopy.isOk() == false) { printError(removedCopy.error()); }
