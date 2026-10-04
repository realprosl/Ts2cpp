#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Lexer } from "../lexer/lexer.ts";
import { Parser } from "../parser/parser.ts";
import { DiagnosticError, formatDiagnostic } from "../core/diagnostic.ts";
import type {
  Program, Statement, Expression, Parameter, ClassField, ClassMethod,
  InterfaceMethod, VariableDeclaration, FunctionDeclaration, ClassDeclaration,
  InterfaceDeclaration, BlockStatement, IfStatement, WhileStatement, ForStatement,
} from "../ast/nodes.ts";

// Formateador puro basado en AST. No toca el codegen ni la semántica: tokeniza,
// parsea y vuelve a emitir el código en una forma canónica estable. Si hay errores
// de parseo, los reporta y sale con código 1 sin tocar el archivo.

const INDENT = "  ";

function indent(level: number): string {
  return INDENT.repeat(level);
}

function passingKeyword(passing: Parameter["passing"]): string {
  // V22 (Memory Model v2): solo "value" y "out" existen. "value" no se
  // imprime (es el default); "out" se imprime como prefijo.
  if (passing === "out") return "out ";
  return "";
}

function formatParameter(parameter: Parameter): string {
  const prefix = passingKeyword(parameter.passing);
  const variadic = parameter.variadic ? "..." : "";
  const out = parameter.out ? "out " : "";
  // `out` y `passing` son ortogonales en la práctica: si out=true, el parser
  // ya marca passing="automatic" pero la keyword visible es `out`.
  const visible = parameter.out ? "out " : prefix;
  return `${visible}${variadic}${parameter.name}: ${parameter.type}`;
}

function formatExpression(expression: Expression): string {
  switch (expression.kind) {
    case "LiteralExpression":
      if (expression.literalType === "string") return JSON.stringify(expression.value);
      return String(expression.value);
    case "IdentifierExpression":
      return expression.name;
    case "ArrayLiteralExpression":
      return `[${expression.elements.map(formatExpression).join(", ")}]`;
    case "ArrowFunctionExpression": {
      const params = expression.params.map(formatParameter).join(", ");
      const ret = expression.returnType ? `: ${expression.returnType}` : "";
      const body = expression.body.kind === "BlockStatement"
        ? ` ${formatBlock(expression.body, 0, true)}`
        : ` ${formatExpression(expression.body)}`;
      return `(${params})${ret} =>${body}`;
    }
    case "UnaryExpression":
      return `${expression.operator}${formatExpression(expression.operand)}`;
    case "AwaitExpression":
      return `await ${formatExpression(expression.operand)}`;
    case "BinaryExpression":
      return `${formatExpression(expression.left)} ${expression.operator} ${formatExpression(expression.right)}`;
    case "CallExpression": {
      const typeArgs = expression.typeArguments.length ? `<${expression.typeArguments.join(", ")}>` : "";
      const args = expression.args.map(formatExpression).join(", ");
      return `${expression.callee}${typeArgs}(${args})`;
    }
    case "MemberExpression":
      return `${formatExpression(expression.object)}.${expression.member}`;
    case "MemberCallExpression": {
      const typeArgs = expression.typeArguments.length ? `<${expression.typeArguments.join(", ")}>` : "";
      const args = expression.args.map(formatExpression).join(", ");
      return `${formatExpression(expression.object)}.${expression.method}${typeArgs}(${args})`;
    }
    case "IndexExpression":
      return `${formatExpression(expression.object)}[${formatExpression(expression.index)}]`;
    case "NewExpression":
      return `new ${expression.className}(${expression.args.map(formatExpression).join(", ")})`;
    case "AssignmentExpression":
      return `${formatExpression(expression.target)} = ${formatExpression(expression.value)}`;
  }
}

function formatBlock(block: BlockStatement, level: number, inline = false): string {
  const head = inline ? "" : `\n`;
  const tail = inline ? "" : `\n${indent(level)}`;
  const body = block.statements.map(stmt => formatStatement(stmt, level + 1)).join("\n");
  return `{${head}${body}${tail}}`;
}

function formatStatement(statement: Statement, level: number): string {
  const prefix = indent(level);
  switch (statement.kind) {
    case "VariableDeclaration": {
      const exported = statement.exported ? "export " : "";
      const keyword = statement.mutable ? "let" : "const";
      const decl = statement.declaredType ? `: ${statement.declaredType}` : "";
      return `${prefix}${exported}${keyword} ${statement.name}${decl} = ${formatExpression(statement.initializer)};`;
    }
    case "FunctionDeclaration":
      return `${prefix}${formatFunctionDeclaration(statement)}`;
    case "InterfaceDeclaration":
      return `${prefix}${formatInterfaceDeclaration(statement)}`;
    case "ClassDeclaration":
      return `${prefix}${formatClassDeclaration(statement)}`;
    case "BlockStatement":
      return `${prefix}${formatBlock(statement, level)}`;
    case "ExpressionStatement":
      return `${prefix}${formatExpression(statement.expression)};`;
    case "IfStatement":
      return `${prefix}${formatIf(statement, level)}`;
    case "WhileStatement":
      return `${prefix}while (${formatExpression(statement.condition)}) ${formatStatement(statement.body, level).trimStart()}`;
    case "ForStatement":
      return `${prefix}${formatFor(statement, level)}`;
    case "BreakStatement":
      return `${prefix}break;`;
    case "ContinueStatement":
      return `${prefix}continue;`;
    case "ReturnStatement":
      return `${prefix}${statement.value ? `return ${formatExpression(statement.value)};` : "return;"}`;
  }
}

function formatFunctionDeclaration(declaration: FunctionDeclaration, method = false): string {
  const exported = !method && declaration.exported ? "export " : "";
  const asyncKeyword = declaration.async ? "async " : "";
  const typeParams = declaration.typeParameters.length ? `<${declaration.typeParameters.map(p => `${p.name}${p.constraint ? ` extends ${p.constraint}` : ""}${p.default ? ` = ${p.default}` : ""}`).join(", ")}>` : "";
  const params = declaration.params.map(formatParameter).join(", ");
  return `${exported}${asyncKeyword}function ${declaration.name}${typeParams}(${params}): ${declaration.returnType} ${formatBlock(declaration.body, 0)}`;
}

function formatInterfaceDeclaration(declaration: InterfaceDeclaration): string {
  const exported = declaration.exported ? "export " : "";
  const methods = declaration.methods.map((method: InterfaceMethod) => {
    const typeParams = method.typeParameters?.length ? `<${method.typeParameters.map(p => `${p.name}${p.constraint ? ` extends ${p.constraint}` : ""}${p.default ? ` = ${p.default}` : ""}`).join(", ")}>` : "";
    const params = method.params.map(formatParameter).join(", ");
    return `${INDENT}${method.name}${typeParams}(${params}): ${method.returnType};`;
  });
  return `${exported}interface ${declaration.name} {\n${methods.join("\n")}\n}`;
}

function formatClassDeclaration(declaration: ClassDeclaration): string {
  const exported = declaration.exported ? "export " : "";
  const typeParams = declaration.typeParameters.length ? `<${declaration.typeParameters.map(p => `${p.name}${p.constraint ? ` extends ${p.constraint}` : ""}${p.default ? ` = ${p.default}` : ""}`).join(", ")}>` : "";
  const fields = declaration.fields.map((field: ClassField) => `${INDENT}${field.name}: ${field.type};`);
  const methods = declaration.methods.map((method: ClassMethod) => {
    const tp = method.typeParameters?.length ? `<${method.typeParameters.map(p => `${p.name}${p.constraint ? ` extends ${p.constraint}` : ""}${p.default ? ` = ${p.default}` : ""}`).join(", ")}>` : "";
    const params = method.params.map(formatParameter).join(", ");
    return `${INDENT}${method.name}${tp}(${params}): ${method.returnType} ${formatBlock(method.body, 1)}`;
  });
  const body = [...fields, ...methods].join("\n");
  return `${exported}class ${declaration.name}${typeParams} {\n${body}\n}`;
}

function formatIf(statement: IfStatement, level: number): string {
  const cond = `if (${formatExpression(statement.condition)}) `;
  const then = formatStatement(statement.thenBranch, level).trimStart();
  if (!statement.elseBranch) return `${cond}${then}`;
  const elseBody = formatStatement(statement.elseBranch, level).trimStart();
  return `${cond}${then} else ${elseBody}`;
}

function formatFor(statement: ForStatement, level: number): string {
  const init = statement.initializer
    ? statement.initializer.kind === "VariableDeclaration"
      ? `${statement.initializer.mutable ? "let" : "const"} ${statement.initializer.name}${statement.initializer.declaredType ? `: ${statement.initializer.declaredType}` : ""} = ${formatExpression(statement.initializer.initializer)}`
      : formatExpression(statement.initializer.expression)
    : "";
  const cond = statement.condition ? formatExpression(statement.condition) : "";
  const inc = statement.increment ? formatExpression(statement.increment) : "";
  return `for (${init}; ${cond}; ${inc}) ${formatStatement(statement.body, level).trimStart()}`;
}

function formatProgram(program: Program): string {
  return program.statements.map(stmt => formatStatement(stmt, 0)).join("\n\n") + "\n";
}

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
  const tokens = new Lexer(source).tokenize();
  const program = new Parser(tokens).parseProgram();
  process.stdout.write(formatProgram(program));
} catch (error) {
  if (error instanceof DiagnosticError) {
    for (const diagnostic of error.diagnostics) console.error(formatDiagnostic(sourceName, source, diagnostic));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
