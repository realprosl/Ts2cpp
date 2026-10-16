// V30.41: comptime() — evaluador estático para expresiones que se
// resuelven en tiempo de transpilación. El dialecto expone
// `comptime(fn)` como builtin: el codegen detecta la llamada, ejecuta
// el cuerpo de la arrow function en este evaluador controlado, y
// sustituye la llamada por un LiteralExpression con el valor
// calculado. Esto permite que bucles, condicionales y expresiones
// aritméticas que solo se usan para inicializar constantes se
// resuelvan en compile-time, sin coste en runtime.
//
// RESTRICCIONES (validamos con un DiagnosticError claro si no se cumplen):
//   - comptime() recibe exactamente 1 argumento.
//   - El argumento es un ArrowFunctionExpression SIN parámetros.
//   - El ArrowFunctionExpression NO es async.
//   - El cuerpo se evalúa con un AST walker. NO usamos eval() ni
//     new Function() para ejecutar código arbitrario.
//
// OPERACIONES SOPORTADAS:
//   - Literales (number, string, boolean).
//   - Identifiers locales (const/let) del scope de la arrow.
//   - Arrays literales con push/index/length.
//   - Object literals con acceso a propiedades.
//   - Operadores aritméticos, comparación, lógicos, unarios.
//   - Condicionales (if/else, ternario).
//   - Bucles (for, while, do-while).
//   - return.
//   - Llamadas a funciones del mismo archivo (FunctionDeclaration).
//   - Llamadas recursivas con límite de profundidad.
//
// LÍMITES:
//   - maxInstructions: 10000 instrucciones evaluadas.
//   - maxRecursion: 100 niveles de call stack.
//   - maxValueBytes: 1MB de memoria para valores almacenados.

import type {
  Program,
  Statement,
  Expression,
  BlockStatement,
  Parameter,
  FunctionDeclaration,
  ArrowFunctionExpression,
  LiteralExpression,
  IdentifierExpression,
  ArrayLiteralExpression,
  ObjectLiteralExpression,
  UnaryExpression,
  BinaryExpression,
  AssignmentExpression,
  TemplateLiteralExpression,
  TernaryExpression,
  IndexExpression,
  MemberExpression,
  CallExpression,
  ReturnStatement,
  IfStatement,
  WhileStatement,
  DoWhileStatement,
  ForStatement,
  VariableDeclaration,
  ExpressionStatement,
} from "../ast/nodes.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";

/** Wrapper para lanzar errores comptime con un solo mensaje y span.
 * El DiagnosticError normal espera un array de `Diagnostic`, pero
 * para errores puntuales del evaluador es más cómodo pasar un string.
 * Devuelve `never` para que TS sepa que el control no continúa. */
function comptimeError(message: string, span: { start: number; end: number }): never {
  const fullSpan = { start: { line: 0, column: span.start, offset: span.start }, end: { line: 0, column: span.end, offset: span.end } };
  throw new DiagnosticError([{ phase: "semantic" as const, message, span: fullSpan }]);
}

/** Tipos de valores que puede devolver un evaluador comptime. */
export type ComptimeValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | ComptimeArray
  | ComptimeObject;

export interface ComptimeArray extends Array<ComptimeValue> { __comptime: "array" }
export interface ComptimeObject {
  __comptime: "object";
  fields: Map<string, ComptimeValue>;
}

/** Opciones del evaluador (límites configurables). */
export interface ComptimeLimits {
  maxInstructions: number;
  maxRecursion: number;
  maxValueBytes: number;
}

const DEFAULT_LIMITS: ComptimeLimits = {
  maxInstructions: 10000,
  maxRecursion: 100,
  maxValueBytes: 1024 * 1024,
};

/** Resultado de una evaluación comptime. */
export interface ComptimeResult {
  value: ComptimeValue;
  /** El AST del ArrowFunctionExpression evaluado (para reports de error). */
  span: { start: number; end: number };
}

/** Estado mutable del intérprete (instrumenta contadores + scope chain). */
class ComptimeInterpreter {
  private instructions = 0;
  private recursionDepth = 0;
  private bytesUsed = 0;
  private readonly limits: ComptimeLimits;
  /** Tabla de funciones del archivo (FunctionDeclaration). */
  private readonly functions: Map<string, FunctionDeclaration>;
  constructor(
    limits: ComptimeLimits,
    functions: Map<string, FunctionDeclaration>,
  ) {
    this.limits = limits;
    this.functions = functions;
  }

  /** Evalúa una arrow function. Punto de entrada. */
  evalArrow(arrow: ArrowFunctionExpression, at: { start: number; end: number }): ComptimeResult {
    if ((arrow as { isAsync?: boolean }).isAsync || (arrow as { async?: boolean }).async) {
      comptimeError(`comptime() no soporta arrow functions async`, at);
    }
    if (arrow.params.length > 0) {
      comptimeError(
        `comptime() solo acepta arrow functions sin parametros; esta tiene ${arrow.params.length}`,
        at,
      );
    }
    const scope = new Map<string, ComptimeValue>();
    const value = this.evalBlockOrExpr(arrow.body, scope);
    return { value, span: at };
  }

  /** Evalúa un BlockStatement o una Expression (cuerpo de la arrow). */
  private evalBlockOrExpr(node: BlockStatement | Expression, scope: Map<string, ComptimeValue>): ComptimeValue {
    this.tick();
    if (node.kind === "BlockStatement") return this.evalBlock(node, scope);
    return this.evalExpression(node, scope);
  }

  private evalBlock(block: BlockStatement, scope: Map<string, ComptimeValue>): ComptimeValue {
    let lastValue: ComptimeValue = undefined;
    for (const stmt of block.statements) {
      const v = this.evalStatement(stmt, scope);
      if (v && (v as { __comptime?: string }).__comptime === "early-return") {
        return (v as { value: ComptimeValue }).value;
      }
      lastValue = v as ComptimeValue;
    }
    return lastValue;
  }

  private evalStatement(stmt: Statement, scope: Map<string, ComptimeValue>): ComptimeValue | { __comptime: "early-return"; value: ComptimeValue } {
    this.tick();
    switch (stmt.kind) {
      case "ReturnStatement": {
        const value = stmt.value ? this.evalExpression(stmt.value, scope) : undefined;
        return { __comptime: "early-return", value };
      }
      case "VariableDeclaration": {
        if (stmt.initializer) {
          const v = this.evalExpression(stmt.initializer, scope);
          this.boundCheck(v);
          if (stmt.arrayBindings && stmt.arrayBindings.length > 0) {
            // Destructuring: const [a, b] = arr;
            if (!Array.isArray(v)) {
              comptimeError(`comptime: solo se soporta destructuring de arrays`, stmt.span);
            }
            stmt.arrayBindings.forEach((binding, i) => {
              scope.set(binding.name, (v as ComptimeValue[])[i] ?? undefined);
            });
          } else if (stmt.objectBindings && stmt.objectBindings.length > 0) {
            // Destructuring: const {a, b} = obj;
            if (!this.isObject(v)) {
              comptimeError(`comptime: solo se soporta destructuring de objects`, stmt.span);
            }
            stmt.objectBindings.forEach((binding) => {
              const key = binding.property ?? binding.name;
              scope.set(binding.name, v.fields.get(key) ?? undefined);
            });
          } else {
            scope.set(stmt.name, v);
          }
        } else {
          scope.set(stmt.name, undefined);
        }
        return undefined;
      }
      case "ExpressionStatement":
        return this.evalExpression(stmt.expression, scope);
      case "IfStatement": {
        const cond = this.evalExpression(stmt.condition, scope);
        // V30.41: si el then/else es un BlockStatement, iteramos
        // sus statements directamente para propagar el sentinel
        // early-return. Si usamos evalBlock/evalBlockOrExpr, el
        // sentinel se extrae y el evalBlock del caller continua
        // con el siguiente statement (ej. `return n * fact(n-1)`)
        // y la recursion se vuelve infinita.
        const evalBranch = (branch: typeof stmt.thenBranch): ReturnType<typeof this.evalStatement> => {
          if (branch.kind === "BlockStatement") {
            for (const s of branch.statements) {
              const v = this.evalStatement(s, scope);
              if (v && (v as { __comptime?: string }).__comptime === "early-return") {
                return v as { __comptime: "early-return"; value: ComptimeValue };
              }
            }
            return undefined;
          }
          if (branch.kind === "ReturnStatement" || branch.kind === "IfStatement" || branch.kind === "WhileStatement" || branch.kind === "ForStatement" || branch.kind === "VariableDeclaration" || branch.kind === "ExpressionStatement") {
            return this.evalStatement(branch, scope);
          }
          return this.evalExpression(branch as unknown as Expression, scope) as ReturnType<typeof this.evalStatement>;
        };
        if (this.truthy(cond)) return evalBranch(stmt.thenBranch);
        if (stmt.elseBranch) return evalBranch(stmt.elseBranch);
        return undefined;
      }
      case "WhileStatement": {
        let last: ComptimeValue = undefined;
        let iter = 0;
        while (this.truthy(this.evalExpression(stmt.condition, scope))) {
          this.tick();
          iter++;
          if (iter > this.limits.maxInstructions) {
            comptimeError(`comptime: bucle while excedio ${this.limits.maxInstructions} iteraciones`, stmt.span);
          }
          // V30.41: iteramos los statements del body directamente
          // para propagar el sentinel early-return.
          if (stmt.body.kind === "BlockStatement") {
            for (const s of stmt.body.statements) {
              const v = this.evalStatement(s, scope);
              if (v && (v as { __comptime?: string }).__comptime === "early-return") {
                return v as { __comptime: "early-return"; value: ComptimeValue };
              }
              last = v as ComptimeValue;
            }
          } else {
            const v = this.evalExpression(stmt.body, scope);
            if (v && (v as { __comptime?: string }).__comptime === "early-return") {
              return v as { __comptime: "early-return"; value: ComptimeValue };
            }
            last = v as ComptimeValue;
          }
        }
        return last;
      }
      case "DoWhileStatement": {
        let last: ComptimeValue = undefined;
        let iter = 0;
        do {
          this.tick();
          iter++;
          if (iter > this.limits.maxInstructions) {
            comptimeError(`comptime: bucle do-while excedio ${this.limits.maxInstructions} iteraciones`, stmt.span);
          }
          const v = this.evalBlockOrExpr(stmt.body, scope);
          if (v && (v as { __comptime?: string }).__comptime === "early-return") {
            return v as { __comptime: "early-return"; value: ComptimeValue };
          }
          last = v as ComptimeValue;
        } while (this.truthy(this.evalExpression(stmt.condition, scope)));
        return last;
      }
      case "ForStatement": {
        // V30.41: el for no necesita un scope aislado. Las variables
        // declaradas en el initializer (let i: number = 0) deben
        // persistir al scope del padre para que `r += i` (que vive
        // en el scope del arrow, no en un sub-scope) las vea. Por
        // eso usamos `scope` directamente, no `new Map(scope)`.
        let last: ComptimeValue = undefined;
        if (stmt.initializer) {
          // `for (let i: number = 0; ...; ...)` — el initializer
          // es un VariableDeclaration (Statement). Lo evaluamos
          // como statement, no como expression.
          this.evalStatement(stmt.initializer, scope);
        }
        let iter = 0;
        while (!stmt.condition || this.truthy(this.evalExpression(stmt.condition, scope))) {
          this.tick();
          iter++;
          if (iter > this.limits.maxInstructions) {
            comptimeError(`comptime: bucle for excedio ${this.limits.maxInstructions} iteraciones`, stmt.span);
          }
          // V30.41: iteramos los statements del body directamente
          // para propagar el sentinel early-return.
          if (stmt.body.kind === "BlockStatement") {
            for (const s of stmt.body.statements) {
              const v = this.evalStatement(s, scope);
              if (v && (v as { __comptime?: string }).__comptime === "early-return") {
                return v as { __comptime: "early-return"; value: ComptimeValue };
              }
              last = v as ComptimeValue;
            }
          } else {
            const v = this.evalExpression(stmt.body, scope);
            if (v && (v as { __comptime?: string }).__comptime === "early-return") {
              return v as { __comptime: "early-return"; value: ComptimeValue };
            }
            last = v as ComptimeValue;
          }
          if (stmt.increment) this.evalExpression(stmt.increment, scope);
        }
        return last;
      }
      case "BlockStatement":
        return this.evalBlock(stmt, scope);
      case "BreakStatement":
        // Break/continue solo tienen sentido dentro de loops. Aqui
        // signalamos con un sentinel igual que return.
        return { __comptime: "early-return", value: undefined } as { __comptime: "early-return"; value: ComptimeValue };
      case "ContinueStatement":
        return { __comptime: "early-return", value: undefined } as { __comptime: "early-return"; value: ComptimeValue };
      default:
        comptimeError(`comptime: sentencia de tipo '${stmt.kind}' no soportada`, stmt.span);
    }
  }

  private evalExpression(expr: Expression, scope: Map<string, ComptimeValue>): ComptimeValue {
    this.tick();
    switch (expr.kind) {
      case "LiteralExpression": {
        const lit = expr as LiteralExpression;
        if (lit.literalType === "null") return null;
        if (lit.literalType === "undefined") return undefined;
        if (typeof lit.value === "number") return lit.value;
        if (typeof lit.value === "string") return lit.value;
        if (typeof lit.value === "boolean") return lit.value;
        comptimeError(`comptime: literal de tipo ${lit.literalType} no soportado`, expr.span);
      }
      case "IdentifierExpression": {
        const id = expr as IdentifierExpression;
        if (id.name === "undefined") return undefined;
        if (id.name === "NaN") return NaN;
        if (id.name === "Infinity") return Infinity;
        if (!scope.has(id.name)) {
          comptimeError(`comptime: identificador '${id.name}' no esta definido en este scope`, expr.span);
        }
        return scope.get(id.name)!;
      }
      case "ArrayLiteralExpression": {
        const arr = (expr as ArrayLiteralExpression).elements.map((el) => {
          this.tick();
          if (el.kind === "SpreadElement") {
            const v = this.evalExpression(el.expression, scope);
            if (!Array.isArray(v)) {
              comptimeError(`comptime: spread requiere un array`, expr.span);
            }
            return v as ComptimeValue[];
          }
          return this.evalExpression(el as Expression, scope);
        });
        const result: ComptimeArray = [] as ComptimeArray;
        for (const v of arr) {
          if (Array.isArray(v)) {
            for (const x of v) result.push(x);
          } else {
            result.push(v);
          }
        }
        Object.defineProperty(result, "__comptime", { value: "array" });
        this.boundCheck(result);
        return result;
      }
      case "ObjectLiteralExpression": {
        const obj = (expr as ObjectLiteralExpression).properties;
        const fields = new Map<string, ComptimeValue>();
        for (const prop of obj) {
          this.tick();
          if (prop.spread) {
            const v = this.evalExpression(prop.spread, scope);
            if (!this.isObject(v)) {
              comptimeError(`comptime: spread en object requiere un objeto`, expr.span);
            }
            for (const [k, val] of v.fields) fields.set(k, val);
          } else {
            const v = this.evalExpression(prop.value, scope);
            fields.set(prop.key, v);
            if (prop.shorthand && scope.has(prop.key)) fields.set(prop.key, scope.get(prop.key)!);
          }
        }
        const result: ComptimeObject = { __comptime: "object", fields };
        this.boundCheck(result);
        return result;
      }
      case "UnaryExpression": {
        const u = expr as UnaryExpression;
        const v = this.evalExpression(u.operand, scope);
        switch (u.operator) {
          case "-": return -this.toNumber(v, expr);
          case "+": return +this.toNumber(v, expr);
          case "!": return !this.truthy(v);
          case "~": return ~this.toNumber(v, expr);
          default:
            comptimeError(`comptime: operador unario '${u.operator}' no soportado`, expr.span);
        }
      }
      case "BinaryExpression": {
        const b = expr as BinaryExpression;
        const l = this.evalExpression(b.left, scope);
        const r = this.evalExpression(b.right, scope);
        return this.evalBinary(b.operator, l, r, expr);
      }
      case "AssignmentExpression": {
        const a = expr as AssignmentExpression;
        if (a.target.kind === "IdentifierExpression") {
          const v = this.evalExpression(a.value, scope);
          scope.set((a.target as IdentifierExpression).name, v);
          return v;
        }
        if (a.target.kind === "IndexExpression") {
          const idx = a.target as IndexExpression;
          const target = this.evalExpression(idx.object, scope);
          const index = this.evalExpression(idx.index, scope);
          const value = this.evalExpression(a.value, scope);
          if (!Array.isArray(target)) {
            comptimeError(`comptime: index assignment solo soportado en arrays`, a.span);
          }
          (target as ComptimeValue[])[Number(index)] = value;
          return value;
        }
        if (a.target.kind === "MemberExpression") {
          const mem = a.target as MemberExpression;
          const target = this.evalExpression(mem.object, scope);
          if (!this.isObject(target)) {
            comptimeError(`comptime: member assignment solo soportado en objects`, a.span);
          }
          const value = this.evalExpression(a.value, scope);
          target.fields.set(mem.member, value);
          return value;
        }
        comptimeError(`comptime: assignment target de tipo '${a.target.kind}' no soportado`, a.span);
      }
      case "CompoundAssignmentExpression": {
        const a = expr as { kind: "CompoundAssignmentExpression"; target: Expression; operator: string; value: Expression; span: { start: number; end: number } };
        if (a.target.kind !== "IdentifierExpression") {
          comptimeError(`comptime: compound assignment solo soportado en identifiers`, a.span);
        }
        const name = (a.target as IdentifierExpression).name;
        const cur = scope.get(name);
        const rhs = this.evalExpression(a.value, scope);
        const newVal = this.evalBinary(a.operator.slice(0, -1), cur, rhs, a);
        scope.set(name, newVal);
        return newVal;
      }
      case "TemplateLiteralExpression": {
        const t = expr as TemplateLiteralExpression;
        let result = "";
        for (let i = 0; i < t.parts.length; i++) {
          result += t.parts[i]!;
          if (i < t.expressions.length) {
            const v = this.evalExpression(t.expressions[i]!, scope);
            result += this.toString(v);
          }
        }
        return result;
      }
      case "TernaryExpression": {
        const t = expr as TernaryExpression;
        return this.truthy(this.evalExpression(t.condition, scope))
          ? this.evalExpression(t.thenBranch, scope)
          : this.evalExpression(t.elseBranch, scope);
      }
      case "IndexExpression": {
        const i = expr as IndexExpression;
        const target = this.evalExpression(i.object, scope);
        const index = this.evalExpression(i.index, scope);
        if (Array.isArray(target)) return (target as ComptimeValue[])[Number(index)] ?? undefined;
        if (this.isObject(target)) return target.fields.get(String(index)) ?? undefined;
        if (typeof target === "string") return (target as string)[Number(index)] ?? "";
        comptimeError(`comptime: index access no soportado en tipo '${typeof target}'`, expr.span);
      }
      case "MemberExpression": {
        const m = expr as MemberExpression;
        const target = this.evalExpression(m.object, scope);
        if (!this.isObject(target)) {
          comptimeError(`comptime: member access solo soportado en objects`, expr.span);
        }
        // Permitimos .length en arrays.
        if (Array.isArray(target) && m.member === "length") return target.length;
        return target.fields.get(m.member) ?? undefined;
      }
      case "CallExpression": {
        const c = expr as CallExpression;
        if (c.callee === "comptime") {
          comptimeError(`comptime() no se puede llamar dentro de otra comptime()`, expr.span);
        }
        if (c.callee === "Math") {
          // No deberia llegar aqui como CallExpression; lo manejamos en MemberCallExpression.
          comptimeError(`comptime: llamada a Math.${c.args[0]?.kind} no soportada`, expr.span);
        }
        // Builtin de array: .push(x) (llega como MemberCallExpression, ver abajo).
        // Llamada a funcion del archivo.
        const fn = this.functions.get(c.callee);
        if (!fn) {
          comptimeError(
            `comptime: funcion '${c.callee}' no encontrada (solo se permiten funciones del mismo archivo)`,
            expr.span,
          );
        }
        this.recursionDepth++;
        if (this.recursionDepth > this.limits.maxRecursion) {
          comptimeError(
            `comptime: profundidad de recursion excede ${this.limits.maxRecursion}`,
            expr.span,
          );
        }
        try {
          if (fn.params.length !== c.args.length) {
            comptimeError(
              `comptime: '${c.callee}' espera ${fn.params.length} args, recibio ${c.args.length}`,
              expr.span,
            );
          }
          const fnScope = new Map<string, ComptimeValue>();
          for (let i = 0; i < fn.params.length; i++) {
            fnScope.set(fn.params[i]!.name, this.evalExpression(c.args[i]!, scope));
          }
          let result: ComptimeValue = undefined;
          if (fn.body.kind === "BlockStatement") {
            const v = this.evalBlock(fn.body, fnScope);
            if (v && (v as { __comptime?: string }).__comptime === "early-return") {
              result = (v as { value: ComptimeValue }).value;
            } else {
              result = v as ComptimeValue;
            }
          } else {
            result = this.evalExpression(fn.body, fnScope);
          }
          return result;
        } finally {
          this.recursionDepth--;
        }
      }
      case "MemberCallExpression": {
        const mc = expr as MemberCallExpression;
        // Builtin de arrays: arr.push(x), arr.indexOf(x), arr.includes(x), arr.length
        if (mc.object.kind === "IdentifierExpression" || true) {
          const target = this.evalExpression(mc.object, scope);
          if (Array.isArray(target)) {
            return this.evalArrayBuiltin(target, mc.method, mc.args, scope, expr);
          }
          if (target === Math) {
            return this.evalMathBuiltin(mc.method, mc.args, scope, expr);
          }
          if (this.isObject(target)) {
            return this.evalCallOnObject(target, mc.method, mc.args, scope, expr);
          }
        }
        comptimeError(`comptime: member call no soportado`, expr.span);
      }
      case "ArrowFunctionExpression":
        comptimeError(`comptime: arrow functions anidadas no soportadas`, expr.span);
      case "SpreadElement":
        comptimeError(`comptime: spread fuera de array/object literal no soportado`, expr.span);
      case "NewExpression":
        comptimeError(`comptime: 'new' no soportado en comptime`, expr.span);
      case "AwaitExpression":
        comptimeError(`comptime: 'await' no soportado`, expr.span);
      case "MatchExpression":
        comptimeError(`comptime: 'match' no soportado`, expr.span);
      default:
        comptimeError(`comptime: expression de tipo '${expr.kind}' no soportada`, expr.span);
    }
  }

  private evalBinary(op: string, l: ComptimeValue, r: ComptimeValue, node: { span: { start: number; end: number } }): ComptimeValue {
    // Operadores logicos con short-circuit (no evaluan r si no hace falta).
    if (op === "&&") return this.truthy(l) ? r : l;
    if (op === "||") return this.truthy(l) ? l : r;
    if (op === "??") return l !== undefined && l !== null ? l : r;

    // Comparaciones
    if (op === "===") return l === r;
    if (op === "!==") return l !== r;
    if (op === "==") return l == r;
    if (op === "!=") return l != r;
    if (op === "<") return this.toNumber(l, node) < this.toNumber(r, node);
    if (op === ">") return this.toNumber(l, node) > this.toNumber(r, node);
    if (op === "<=") return this.toNumber(l, node) <= this.toNumber(r, node);
    if (op === ">=") return this.toNumber(l, node) >= this.toNumber(r, node);

    // Aritmetica
    if (op === "+") {
      // String concat si alguno es string.
      if (typeof l === "string" || typeof r === "string") {
        return this.toString(l) + this.toString(r);
      }
      return this.toNumber(l, node) + this.toNumber(r, node);
    }
    if (op === "-") return this.toNumber(l, node) - this.toNumber(r, node);
    if (op === "*") return this.toNumber(l, node) * this.toNumber(r, node);
    if (op === "/") {
      const r2 = this.toNumber(r, node);
      if (r2 === 0) comptimeError(`comptime: division por cero`, node.span);
      return this.toNumber(l, node) / r2;
    }
    if (op === "%") return this.toNumber(l, node) % this.toNumber(r, node);
    if (op === "**") return this.toNumber(l, node) ** this.toNumber(r, node);
    if (op === "&") return (this.toNumber(l, node) & this.toNumber(r, node)) | 0;
    if (op === "|") return (this.toNumber(l, node) | this.toNumber(r, node)) | 0;
    if (op === "^") return (this.toNumber(l, node) ^ this.toNumber(r, node)) | 0;
    if (op === "<<") return (this.toNumber(l, node) << this.toNumber(r, node)) | 0;
    if (op === ">>") return (this.toNumber(l, node) >> this.toNumber(r, node)) | 0;
    if (op === ">>>") return (this.toNumber(l, node) >>> this.toNumber(r, node)) | 0;

    comptimeError(`comptime: operador binario '${op}' no soportado`, node.span);
  }

  private evalArrayBuiltin(
    arr: ComptimeValue[],
    method: string,
    args: Expression[],
    scope: Map<string, ComptimeValue>,
    node: { span: { start: number; end: number } },
  ): ComptimeValue {
    switch (method) {
      case "push": {
        for (const a of args) arr.push(this.evalExpression(a, scope));
        return arr.length;
      }
      case "pop": return arr.pop();
      case "length": return arr.length;
      case "indexOf": {
        const needle = this.evalExpression(args[0]!, scope);
        return arr.findIndex((v) => v === needle);
      }
      case "includes": return arr.some((v) => v === this.evalExpression(args[0]!, scope));
      case "slice": {
        const start = args[0] ? Number(this.evalExpression(args[0], scope)) : 0;
        const end = args[1] ? Number(this.evalExpression(args[1], scope)) : arr.length;
        return arr.slice(start, end);
      }
      case "concat": {
        const other = this.evalExpression(args[0]!, scope);
        if (!Array.isArray(other)) comptimeError(`comptime: concat requiere un array`, node.span);
        return [...arr, ...(other as ComptimeValue[])];
      }
      case "map": return arr.map((v) => this.evalCallback(args[0]!, v, 0, arr, scope));
      case "filter": return arr.filter((v) => this.truthy(this.evalCallback(args[0]!, v, 0, arr, scope)));
      case "forEach": {
        arr.forEach((v, i) => this.evalCallback(args[0]!, v, i, arr, scope));
        return undefined;
      }
      case "find": return arr.find((v) => this.truthy(this.evalCallback(args[0]!, v, 0, arr, scope))) ?? undefined;
      case "findIndex": {
        return arr.findIndex((v) => this.truthy(this.evalCallback(args[0]!, v, 0, arr, scope)));
      }
      case "some": return arr.some((v) => this.truthy(this.evalCallback(args[0]!, v, 0, arr, scope)));
      case "every": return arr.every((v) => this.truthy(this.evalCallback(args[0]!, v, 0, arr, scope)));
      case "reduce": {
        const initial = args[1] ? this.evalExpression(args[1], scope) : arr[0];
        let acc = initial;
        for (let i = args[1] ? 0 : 1; i < arr.length; i++) {
          acc = this.evalReduceCallback(args[0]!, acc, arr[i]!, i, arr, scope);
        }
        return acc;
      }
      case "join": {
        const sep = args[0] ? String(this.evalExpression(args[0], scope)) : ",";
        return arr.map((v) => this.toString(v)).join(sep);
      }
      case "reverse": {
        arr.reverse();
        return arr;
      }
      case "sort": {
        const cmp = args[0] ? (a: ComptimeValue, b: ComptimeValue) => {
          return Number(this.evalCallback(args[0]!, a, 0, [a, b], scope) as ComptimeValue) -
            Number(this.evalCallback(args[0]!, b, 1, [a, b], scope) as ComptimeValue);
        } : undefined;
        arr.sort(cmp);
        return arr;
      }
      default:
        comptimeError(`comptime: array.${method}() no soportado`, node.span);
    }
  }

  private evalMathBuiltin(method: string, args: Expression[], scope: Map<string, ComptimeValue>, node: { span: { start: number; end: number } }): ComptimeValue {
    const num = (e: Expression) => Number(this.evalExpression(e, scope));
    switch (method) {
      case "abs": return Math.abs(num(args[0]!));
      case "floor": return Math.floor(num(args[0]!));
      case "ceil": return Math.ceil(num(args[0]!));
      case "round": return Math.round(num(args[0]!));
      case "min": return Math.min(...args.map((a) => num(a)));
      case "max": return Math.max(...args.map((a) => num(a)));
      case "sqrt": return Math.sqrt(num(args[0]!));
      case "pow": return Math.pow(num(args[0]!), num(args[1]!));
      case "log": return Math.log(num(args[0]!));
      case "sin": return Math.sin(num(args[0]!));
      case "cos": return Math.cos(num(args[0]!));
      case "tan": return Math.tan(num(args[0]!));
      case "PI": return Math.PI;
      case "E": return Math.E;
      default: comptimeError(`comptime: Math.${method} no soportado`, node.span);
    }
  }

  private evalCallOnObject(obj: ComptimeObject, method: string, args: Expression[], scope: Map<string, ComptimeValue>, node: { span: { start: number; end: number } }): ComptimeValue {
    const fn = obj.fields.get(method);
    if (typeof fn !== "function") {
      comptimeError(`comptime: object.${method} no es una funcion`, node.span);
    }
    return (fn as (...a: ComptimeValue[]) => ComptimeValue)(...args.map((a) => this.evalExpression(a, scope)));
  }

  private evalCallback(
    cb: Expression,
    currentValue: ComptimeValue,
    index: number,
    arr: ComptimeValue[],
    scope: Map<string, ComptimeValue>,
  ): ComptimeValue {
    if (cb.kind !== "ArrowFunctionExpression") {
      comptimeError(`comptime: callback debe ser arrow function`, cb.span);
    }
    const cbArrow = cb as ArrowFunctionExpression;
    if (cbArrow.params.length > 3) {
      comptimeError(`comptime: callback acepta max 3 params`, cb.span);
    }
    const cbScope = new Map(scope);
    if (cbArrow.params[0]) cbScope.set(cbArrow.params[0].name, currentValue);
    if (cbArrow.params[1]) cbScope.set(cbArrow.params[1].name, index);
    if (cbArrow.params[2]) cbScope.set(cbArrow.params[2].name, arr);
    return this.evalBlockOrExpr(cbArrow.body, cbScope);
  }

  private evalReduceCallback(
    cb: Expression,
    acc: ComptimeValue,
    currentValue: ComptimeValue,
    index: number,
    arr: ComptimeValue[],
    scope: Map<string, ComptimeValue>,
  ): ComptimeValue {
    if (cb.kind !== "ArrowFunctionExpression") {
      comptimeError(`comptime: reduce callback debe ser arrow function`, cb.span);
    }
    const cbArrow = cb as ArrowFunctionExpression;
    const cbScope = new Map(scope);
    if (cbArrow.params[0]) cbScope.set(cbArrow.params[0].name, acc);
    if (cbArrow.params[1]) cbScope.set(cbArrow.params[1].name, currentValue);
    if (cbArrow.params[2]) cbScope.set(cbArrow.params[2].name, index);
    if (cbArrow.params[3]) cbScope.set(cbArrow.params[3].name, arr);
    return this.evalBlockOrExpr(cbArrow.body, cbScope);
  }

  // --- Helpers ---

  private isObject(v: ComptimeValue): v is ComptimeObject {
    return typeof v === "object" && v !== null && !Array.isArray(v) && (v as { __comptime?: string }).__comptime === "object";
  }

  private tick(): void {
    this.instructions++;
    if (this.instructions > this.limits.maxInstructions) {
      comptimeError(
        `comptime: excedio el limite de ${this.limits.maxInstructions} instrucciones`,
        { start: 0, end: 0 },
      );
    }
  }

  private boundCheck(v: ComptimeValue): void {
    let bytes = 0;
    const visit = (x: ComptimeValue): void => {
      if (typeof x === "object" && x !== null) {
        if (Array.isArray(x)) {
          bytes += 8;
          for (const e of x) visit(e);
        } else if (this.isObject(x)) {
          bytes += 8;
          for (const [, val] of x.fields) visit(val);
        }
      } else {
        bytes += 8;
      }
    };
    visit(v);
    this.bytesUsed += bytes;
    if (this.bytesUsed > this.limits.maxValueBytes) {
      comptimeError(
        `comptime: excedio el limite de ${this.limits.maxValueBytes} bytes de valores`,
        { start: 0, end: 0 },
      );
    }
  }

  private truthy(v: ComptimeValue): boolean {
    if (v === undefined || v === null) return false;
    if (v === false || v === 0 || v === "") return false;
    if (typeof v === "number" && Number.isNaN(v)) return false;
    return true;
  }

  private toNumber(v: ComptimeValue, node: { span: { start: number; end: number } }): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isNaN(n)) comptimeError(`comptime: no se puede convertir '${v}' a number`, node.span);
      return n;
    }
    if (v === null) return 0;
    if (v === undefined) return NaN;
    comptimeError(`comptime: no se puede convertir ${typeof v} a number`, node.span);
  }

  private toString(v: ComptimeValue): string {
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return v.map((x) => this.toString(x)).join(",");
    if (this.isObject(v)) {
      const parts: string[] = [];
      for (const [k, val] of v.fields) parts.push(`${k}: ${this.toString(val)}`);
      return `{${parts.join(", ")}}`;
    }
    return String(v);
  }
}

/** Sentinel que representa el global `Math` en el evaluador. */
const Math: unique symbol = Symbol.for("Math") as unknown as unique symbol;

/**
 * Recorre el AST buscando llamadas a `comptime(arrowFn)`, las evalúa, y
 * sustituye cada llamada por un LiteralExpression con el valor calculado.
 * Devuelve una versión transformada del programa (NO muta el original).
 *
 * Si la arrow function no es comptime-compatible, lanza DiagnosticError
 * con la ubicación y motivo.
 */
export function evaluateComptime(program: Program, limits: ComptimeLimits = DEFAULT_LIMITS): Program {
  // Recolectar funciones del archivo para que comptime() pueda llamarlas.
  const functions = new Map<string, FunctionDeclaration>();
  for (const stmt of program.statements) {
    if (stmt.kind === "FunctionDeclaration") {
      functions.set(stmt.name, stmt);
    }
  }

  const interp = new ComptimeInterpreter(limits, functions);

  const visitExpr = (node: Expression): Expression => {
    // Hacemos una copia del nodo para no mutar el AST original.
    // Si el nodo es una llamada a comptime(), lo sustituimos.
    if (node.kind === "CallExpression" && (node as CallExpression).callee === "comptime") {
      return evalComptimeCall(node as CallExpression, interp);
    }
    // Si es un MemberCallExpression tipo `obj.comptime(...)` no es comptime
    // (comptime es global), asi que lo dejamos.
    return node;
  };

  const visitStmt = (stmt: Statement): Statement => {
    // Recorremos recursivamente. El Comptime call puede aparecer en
    // cualquier expression dentro de un statement.
    if (stmt.kind === "FunctionDeclaration") {
      // V30.41: comptime() puede aparecer en el body de una
      // function declaration. FunctionDeclaration.body siempre es
      // BlockStatement, asi que reescribimos sus statements.
      const newBody = walkBlock(stmt.body, visitExpr);
      if (newBody.kind === "BlockStatement") return { ...stmt, body: newBody };
      return stmt;
    }
    if (stmt.kind === "ClassDeclaration") {
      // V30.41: comptime() puede aparecer en los bodies de los
      // metodos de clase.
      const newMethods = stmt.methods.map((method) => {
        const newBody = walkBlock(method.body, visitExpr);
        if (newBody.kind === "BlockStatement") return { ...method, body: newBody };
        return method;
      });
      return { ...stmt, methods: newMethods };
    }
    if (stmt.kind === "VariableDeclaration") {
      if (stmt.initializer) {
        const newInit = visitExpr(stmt.initializer);
        return { ...stmt, initializer: newInit };
      }
      return stmt;
    }
    if (stmt.kind === "ExpressionStatement") {
      return { ...stmt, expression: visitExpr(stmt.expression) };
    }
    if (stmt.kind === "ReturnStatement" && stmt.value) {
      return { ...stmt, value: visitExpr(stmt.value) };
    }
    // Para sentencias complejas (if, while, for), descendemos.
    return walkStatement(stmt, visitExpr);
  };

  return {
    ...program,
    statements: program.statements.map(visitStmt),
  };
}

function evalComptimeCall(call: CallExpression, interp: ComptimeInterpreter): Expression {
  if (call.args.length !== 1) {
    comptimeError(
      `comptime() espera exactamente 1 argumento; recibio ${call.args.length}`,
      call.span,
    );
  }
  const arg = call.args[0]!;
  if (arg.kind !== "ArrowFunctionExpression") {
    comptimeError(
      `comptime() espera una arrow function como argumento; recibio '${arg.kind}'`,
      call.span,
    );
  }
  const result = interp.evalArrow(arg as ArrowFunctionExpression, call.span);
  return valueToLiteral(result.value, call.span);
}

/** Convierte un ComptimeValue a un LiteralExpression (o expresión compleja). */
function valueToLiteral(value: ComptimeValue, span: { start: number; end: number }): Expression {
  if (value === null) {
    return { kind: "LiteralExpression", value: null, literalType: "null", span } as LiteralExpression;
  }
  if (value === undefined) {
    // No tenemos LiteralExpression para undefined. Usamos identifier.
    return { kind: "IdentifierExpression", name: "undefined", span };
  }
  if (typeof value === "boolean") {
    return { kind: "LiteralExpression", value, literalType: "boolean", span } as LiteralExpression;
  }
  if (typeof value === "number") {
    return { kind: "LiteralExpression", value, literalType: "number", span } as LiteralExpression;
  }
  if (typeof value === "string") {
    return { kind: "LiteralExpression", value, literalType: "string", span } as LiteralExpression;
  }
  if (Array.isArray(value)) {
    return {
      kind: "ArrayLiteralExpression",
      elements: (value as ComptimeValue[]).map((v) => valueToLiteral(v, span)),
      span,
    };
  }
  if (typeof value === "object" && (value as ComptimeObject).__comptime === "object") {
    const obj = value as ComptimeObject;
    // ObjectLiteralExpression (V1.4) tiene `properties: {key, value, ...}[]`.
    return {
      kind: "ObjectLiteralExpression",
      properties: Array.from(obj.fields, ([k, v]) => ({
        key: k,
        value: valueToLiteral(v, span),
        shorthand: false,
        computed: false,
      })),
      span,
    } as unknown as Expression;
  }
  comptimeError(`comptime: tipo de valor no soportado en conversion a literal`, span);
}

/** Recorre un statement complejo (if/while/for) buscando comptime() en expressions. */
function walkStatement(stmt: Statement, visitExpr: (e: Expression) => Expression): Statement {
  if (stmt.kind === "IfStatement") {
    return {
      ...stmt,
      condition: visitExpr(stmt.condition),
      thenBranch: walkBlock(stmt.thenBranch, visitExpr),
      elseBranch: stmt.elseBranch ? walkBlock(stmt.elseBranch, visitExpr) : undefined,
    } as Statement;
  }
  if (stmt.kind === "WhileStatement") {
    return { ...stmt, condition: visitExpr(stmt.condition), body: walkBlock(stmt.body, visitExpr) } as Statement;
  }
  if (stmt.kind === "ForStatement") {
    return {
      ...stmt,
      initializer: stmt.initializer ? walkStatement(stmt.initializer, visitExpr) : undefined,
      condition: stmt.condition ? visitExpr(stmt.condition) : undefined,
      increment: stmt.increment ? visitExpr(stmt.increment) : undefined,
      body: walkBlock(stmt.body, visitExpr),
    } as Statement;
  }
  if (stmt.kind === "BlockStatement") {
    return { ...stmt, statements: stmt.statements.map((s) => walkStatement(s, visitExpr)) } as Statement;
  }
  if (stmt.kind === "ReturnStatement" && stmt.value) {
    return { ...stmt, value: visitExpr(stmt.value) } as Statement;
  }
  if (stmt.kind === "ExpressionStatement") {
    return { ...stmt, expression: visitExpr(stmt.expression) } as Statement;
  }
  if (stmt.kind === "VariableDeclaration" && stmt.initializer) {
    return { ...stmt, initializer: visitExpr(stmt.initializer) } as Statement;
  }
  return stmt;
}

function walkBlock(
  block: BlockStatement | Expression,
  visitExpr: (e: Expression) => Expression,
): BlockStatement | Expression {
  if (block.kind !== "BlockStatement") return visitExpr(block);
  return { ...block, statements: block.statements.map((s) => walkStatement(s, visitExpr)) };
}
