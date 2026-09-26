#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Lexer } from "../lexer/lexer.ts";
import { Parser } from "../parser/parser.ts";
import { DiagnosticError, formatDiagnostic } from "../core/diagnostic.ts";

const inputPath = process.argv[2];
const useStdin = !inputPath;
let source: string;
let sourceName = "<stdin>";

if (useStdin) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  source = Buffer.concat(chunks).toString("utf8");
} else {
  source = await readFile(inputPath, "utf8");
  sourceName = inputPath;
}

try {
  const trimmed = source.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const tokens = JSON.parse(source);
    const program = new Parser(tokens).parseProgram();
    process.stdout.write(JSON.stringify(program, null, 2));
    process.stdout.write("\n");
  } else {
    const tokens = new Lexer(source).tokenize();
    const program = new Parser(tokens).parseProgram();
    process.stdout.write(JSON.stringify(program, null, 2));
    process.stdout.write("\n");
  }
} catch (error) {
  if (error instanceof DiagnosticError) {
    for (const diagnostic of error.diagnostics) console.error(formatDiagnostic(sourceName, source, diagnostic));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
