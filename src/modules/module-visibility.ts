import type { Program, Statement, Expression, TypeName } from "../ast/nodes.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import type { Span } from "../core/span.ts";
import type { LoadedModule } from "./module-loader.ts";

type ModuleProgram = { module: LoadedModule; ast: Program };
type NamedDeclaration = Extract<Statement, { kind: "VariableDeclaration" | "FunctionDeclaration" | "InterfaceDeclaration" | "ClassDeclaration" }>;

function declarationName(statement: Statement): string | undefined {
  return ["VariableDeclaration", "FunctionDeclaration", "InterfaceDeclaration", "ClassDeclaration"].includes(statement.kind)
    ? (statement as NamedDeclaration).name : undefined;
}

function importSpan(line: number): Span {
  return { start: { offset: 0, line, column: 1 }, end: { offset: 0, line, column: 2 } };
}

function typeNames(type: TypeName): string[] {
  return type.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

export function validateModuleVisibility(programs: ModuleProgram[]): void {
  const diagnostics: Diagnostic[] = [];
  const declarations = new Map<string, Map<string, NamedDeclaration[]>>();
  for (const { module, ast } of programs) {
    const own = new Map<string, NamedDeclaration[]>();
    for (const statement of ast.statements) {
      const name = declarationName(statement);
      if (!name) continue;
      const declaration = statement as NamedDeclaration;
      const group = own.get(name) ?? [];
      group.push(declaration); own.set(name, group);
    }
    declarations.set(module.file, own);
    for (const [name, group] of own) {
      if (group.some(item => !!item.exported) && group.some(item => !item.exported)) {
        diagnostics.push({ phase: "semantic", message: `Todas las sobrecargas de '${name}' deben usar la misma visibilidad`, span: group[0].span, file: module.file, source: module.source });
      }
    }
  }

  const owners = new Map<string, string[]>();
  for (const [file, own] of declarations) for (const name of own.keys()) owners.set(name, [...(owners.get(name) ?? []), file]);

  for (const { module, ast } of programs) {
    const own = declarations.get(module.file)!;
    const privateNames = new Set([...own].filter(([, group]) => group.some(item => !item.exported)).map(([name]) => name));
    const reportPrivateType = (type: TypeName, span: Span) => {
      for (const name of typeNames(type)) if (privateNames.has(name)) diagnostics.push({ phase: "semantic", message: `La API exportada no puede exponer el tipo privado '${name}'`, span, file: module.file, source: module.source });
    };
    for (const statement of ast.statements) {
      if (!("exported" in statement) || !statement.exported) continue;
      if (statement.kind === "VariableDeclaration") {
        if (!statement.declaredType) diagnostics.push({ phase: "semantic", message: `La variable exportada '${statement.name}' necesita una anotación de tipo explícita`, span: statement.span, file: module.file, source: module.source });
        else reportPrivateType(statement.declaredType, statement.span);
      } else if (statement.kind === "FunctionDeclaration") {
        statement.params.forEach(parameter => reportPrivateType(parameter.type, parameter.span)); reportPrivateType(statement.returnType, statement.span);
        statement.typeParameters.forEach(parameter => { if (parameter.constraint) reportPrivateType(parameter.constraint, parameter.span); });
      } else if (statement.kind === "InterfaceDeclaration") {
        statement.methods.forEach(method => { method.params.forEach(parameter => reportPrivateType(parameter.type, parameter.span)); reportPrivateType(method.returnType, method.span); });
      } else if (statement.kind === "ClassDeclaration") {
        statement.fields.forEach(field => reportPrivateType(field.type, field.span));
        statement.methods.forEach(method => { method.params.forEach(parameter => reportPrivateType(parameter.type, parameter.span)); reportPrivateType(method.returnType, method.span); });
        statement.typeParameters.forEach(parameter => { if (parameter.constraint) reportPrivateType(parameter.constraint, parameter.span); });
      }
    }
    const imported = new Map<string, string>();
    for (const entry of module.imports) for (const name of entry.names) {
      const dependencyDeclarations = declarations.get(entry.dependency)?.get(name);
      const diagnostic = (message: string) => diagnostics.push({ phase: "semantic", message, span: importSpan(entry.line), file: module.file, source: module.source });
      if (!dependencyDeclarations) { diagnostic(`El módulo importado no declara '${name}'`); continue; }
      if (!dependencyDeclarations.every(item => !!item.exported)) { diagnostic(`El símbolo '${name}' es privado y no puede importarse`); continue; }
      if (own.has(name)) { diagnostic(`El import '${name}' entra en conflicto con una declaración local`); continue; }
      const previous = imported.get(name);
      if (previous && previous !== entry.dependency) { diagnostic(`El símbolo '${name}' se importa desde más de un módulo`); continue; }
      imported.set(name, entry.dependency);
    }

    const topLevel = new Set(own.keys());
    for (const name of imported.keys()) topLevel.add(name);
    const reportInvisible = (name: string, span: Span, locals: Set<string>) => {
      if (locals.has(name) || !owners.has(name)) return;
      diagnostics.push({ phase: "semantic", message: `El símbolo '${name}' pertenece a otro módulo; debe importarse explícitamente`, span, file: module.file, source: module.source });
    };
    const checkType = (type: TypeName, span: Span, locals: Set<string>) => typeNames(type).forEach(name => reportInvisible(name, span, locals));
    const expression = (node: Expression, locals: Set<string>): void => {
      switch (node.kind) {
        case "IdentifierExpression": reportInvisible(node.name, node.span, locals); break;
        case "CallExpression": reportInvisible(node.callee, node.span, locals); node.typeArguments.forEach(type => checkType(type, node.span, locals)); node.args.forEach(arg => expression(arg, locals)); break;
        case "NewExpression": checkType(node.className, node.span, locals); node.args.forEach(arg => expression(arg, locals)); break;
        case "ArrayLiteralExpression": node.elements.forEach(item => expression(item, locals)); break;
        case "ArrowFunctionExpression": {
          const child = new Set(locals); node.params.forEach(parameter => { child.add(parameter.name); checkType(parameter.type, parameter.span, locals); });
          if (node.returnType) checkType(node.returnType, node.span, locals);
          if (node.body.kind === "BlockStatement") statement(node.body, child); else expression(node.body, child);
          break;
        }
        case "UnaryExpression": case "AwaitExpression": expression(node.operand, locals); break;
        case "BinaryExpression": expression(node.left, locals); expression(node.right, locals); break;
        case "AssignmentExpression": expression(node.target, locals); expression(node.value, locals); break;
        case "MemberExpression": expression(node.object, locals); break;
        case "MemberCallExpression": expression(node.object, locals); node.typeArguments.forEach(type => checkType(type, node.span, locals)); node.args.forEach(arg => expression(arg, locals)); break;
        case "IndexExpression": expression(node.object, locals); expression(node.index, locals); break;
        case "LiteralExpression": break;
      }
    };
    const statement = (node: Statement, locals: Set<string>): void => {
      switch (node.kind) {
        case "VariableDeclaration": if (node.declaredType) checkType(node.declaredType, node.span, locals); expression(node.initializer, locals); locals.add(node.name); break;
        case "FunctionDeclaration": {
          const child = new Set(locals); node.typeParameters.forEach(parameter => child.add(parameter.name));
          node.typeParameters.forEach(parameter => { if (parameter.constraint) checkType(parameter.constraint, node.span, child); });
          node.params.forEach(parameter => { checkType(parameter.type, parameter.span, child); child.add(parameter.name); });
          checkType(node.returnType, node.span, child); statement(node.body, child); break;
        }
        case "InterfaceDeclaration": node.methods.forEach(method => { const child = new Set(locals); (method.typeParameters ?? []).forEach(parameter => child.add(parameter.name)); (method.typeParameters ?? []).forEach(parameter => { if (parameter.constraint) checkType(parameter.constraint, method.span, child); }); method.params.forEach(parameter => checkType(parameter.type, parameter.span, child)); checkType(method.returnType, method.span, child); }); break;
        case "ClassDeclaration": {
          const child = new Set(locals); node.typeParameters.forEach(parameter => child.add(parameter.name)); node.typeParameters.forEach(parameter => { if (parameter.constraint) checkType(parameter.constraint, node.span, child); });
          node.fields.forEach(field => checkType(field.type, field.span, child));
          node.methods.forEach(method => { const methodScope = new Set(child); methodScope.add("this"); (method.typeParameters ?? []).forEach(parameter => methodScope.add(parameter.name)); (method.typeParameters ?? []).forEach(parameter => { if (parameter.constraint) checkType(parameter.constraint, method.span, methodScope); }); method.params.forEach(parameter => { checkType(parameter.type, parameter.span, methodScope); methodScope.add(parameter.name); }); checkType(method.returnType, method.span, methodScope); statement(method.body, methodScope); }); break;
        }
        case "BlockStatement": { const child = new Set(locals); node.statements.forEach(item => statement(item, child)); break; }
        case "ExpressionStatement": expression(node.expression, locals); break;
        case "IfStatement": expression(node.condition, locals); statement(node.thenBranch, new Set(locals)); if (node.elseBranch) statement(node.elseBranch, new Set(locals)); break;
        case "WhileStatement": expression(node.condition, locals); statement(node.body, new Set(locals)); break;
        case "ForStatement": { const child = new Set(locals); if (node.initializer) statement(node.initializer, child); if (node.condition) expression(node.condition, child); if (node.increment) expression(node.increment, child); statement(node.body, child); break; }
        case "ReturnStatement": if (node.value) expression(node.value, locals); break;
        case "BreakStatement": case "ContinueStatement": break;
      }
    };
    ast.statements.forEach(node => statement(node, new Set(topLevel)));
  }
  if (diagnostics.length) throw new DiagnosticError(diagnostics);
}
