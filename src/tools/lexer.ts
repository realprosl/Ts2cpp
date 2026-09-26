#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Lexer } from "../lexer/lexer.ts";
import { DiagnosticError, formatDiagnostic } from "../core/diagnostic.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Uso: estatic-lexer <archivo.ets|.ts>");
  process.exit(2);
}

try {
  const source = await readFile(inputPath, "utf8");
  const tokens = new Lexer(source).tokenize();
  process.stdout.write(JSON.stringify(tokens, null, 2));
  process.stdout.write("\n");
} catch (error) {
  if (error instanceof DiagnosticError) {
    const source = await readFile(inputPath, "utf8").catch(() => "");
    for (const diagnostic of error.diagnostics) console.error(formatDiagnostic(inputPath, source, diagnostic));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
