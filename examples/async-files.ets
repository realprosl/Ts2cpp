async function processFile(path: string): Promise<void> {
  const copy: string = path + ".copy";

  const written: Result<boolean> = await writeFileAsync(path, "hello");
  if (written.isOk() == false) { printError(written.error()); }

  const appended: Result<boolean> = await appendFileAsync(path, " async files");
  if (appended.isOk() == false) { printError(appended.error()); }

  const contents: Result<string> = await readFileAsync(path);
  if (contents.isOk()) { print(contents.value()); }
  else { printError(contents.error()); }

  const copied: Result<boolean> = await copyFileAsync(path, copy);
  if (copied.isOk() == false) { printError(copied.error()); }

  const exists: Result<boolean> = await fileExistsAsync(copy);
  if (exists.isOk()) { print("copy exists=", exists.value()); }

  const removedPath: Result<boolean> = await removeFileAsync(path);
  const removedCopy: Result<boolean> = await removeFileAsync(copy);
  if (removedPath.isOk() == false) { printError(removedPath.error()); }
  if (removedCopy.isOk() == false) { printError(removedCopy.error()); }
  return;
}

await processFile(argument(1));
