import type { Span } from "../core/span.ts";

export type PrimitiveType = "number" | "string" | "boolean" | "void" | "undefined" | "object";
export type TypeName = string;
export type ParameterPassing = "value" | "out";
// V22 (Memory Model v2): los antiguos `automatic`, `mut`, `move` ya no
// existen. Ver src/semantic/diagnostics.ts E4400-E4405.
export interface Program { kind: "Program"; statements: Statement[]; span: Span }
// V18: declaración de cabecera de archivo para `.lib.ets`. Un `.lib.ets`
// empieza por cero o más declaraciones `ModuleHeader` (decoradores
// como `@link("-lraylib")` o `@include("raylib.h")` a nivel de archivo).
// El codegen los extrae en `prepare()` y los aplica al binario final.
export interface ModuleHeaderDeclaration { kind: "ModuleHeaderDeclaration"; decorators: Decorator[]; span: Span }
export type Statement = VariableDeclaration | FunctionDeclaration | InterfaceDeclaration | ClassDeclaration | BlockStatement | ExpressionStatement | IfStatement | WhileStatement | ForStatement | BreakStatement | ContinueStatement | ReturnStatement | TypeAliasDeclaration | EnumDeclaration | UnionDeclaration | SwitchStatement | ForOfStatement | ForInStatement | DeleteStatement | UsingDeclaration | ExportDefaultDeclaration | ExportNamedDeclaration | ModuleHeaderDeclaration;
export interface VariableDeclaration { kind: "VariableDeclaration"; exported?: boolean; mutable: boolean; name: string; declaredType?: TypeName; initializer: Expression; arrayBindings?: ArrayBinding[]; span: Span; /** V0.2: anotación opcional que el type-checker escribe si el nombre colisiona con un singleton del runtime. El codegen lo consulta para renombrar el símbolo en C++. */ fromRuntime?: boolean; /** V6: si el initializer es un literal, el checker anota el valor aquí. El codegen lo usa para emitir `constexpr` y propagar el valor a usos posteriores (p.ej. tamaño de array fijo). */ constValue?: number | string | boolean | null }
// `using name = expr;` (TC39 stage 3): declara un recurso cuyo destructor se
// invoca al salir del bloque. En el dialecto es syntactic sugar sobre
// `let name = expr` con la garantía de que el destructor C++ del tipo se llama
// al final del bloque contenedor (RAII automático). Si el tipo define un método
// `dispose()`, también se invoca explícitamente.
export interface UsingDeclaration { kind: "UsingDeclaration"; exported?: boolean; name: string; declaredType?: TypeName; initializer: Expression; span: Span }
export interface ExportDefaultDeclaration { kind: "ExportDefaultDeclaration"; declaration: Statement | Expression; span: Span }
export interface ExportSpecifier { kind: "ExportSpecifier"; name: string; alias?: string; span: Span }
export interface ExportNamedDeclaration { kind: "ExportNamedDeclaration"; specifiers: ExportSpecifier[]; source?: string; span: Span }
// `ArrayBinding` representa un binding de destructuring de arrays del estilo
// `const [a, b, c] = arr;`. Cada elemento es el nombre de una variable local
// (y opcionalmente su tipo declarado). No hay default values ni rest
// patterns por ahora; el dialecto favorece el acceso explícito por índice
// (`arr[0]`, `arr[1]`) cuando hace falta más azúcar.
export interface ArrayBinding { name: string; declaredType?: TypeName; defaultValue?: Expression }
export interface Parameter { name: string; type: TypeName; out: boolean; passing: ParameterPassing; variadic?: boolean; defaultValue?: Expression; optional?: boolean; /** V19: modificador (private/public/protected) — convierte el parámetro en "parameter property". */ access?: AccessModifier; /** V19: anota si el campo debe ser readonly (true cuando es parameter property con readonly). */ readonly?: boolean; /** V0.1: tipo resuelto adjuntado por el semantic checker. */ resolvedType?: import("../types/type-system.ts").ResolvedType; /** V0.2: el type-checker anota si el nombre del parámetro colisiona con un singleton del runtime. */ fromRuntime?: boolean; span: Span }
export interface FunctionDeclaration { kind: "FunctionDeclaration"; exported?: boolean; name: string; async: boolean; typeParameters: TypeParameter[]; variadicTypeParameters: string[]; params: Parameter[]; returnType: TypeName; /** V0.3: huella estructural resuelta por el semantic checker. */ resolvedSignature?: import("../types/type-system.ts").ResolvedSignature; body: BlockStatement; /** V18: decoradores (`@cpp_name(...)`, `@cpp_header(...)`, etc.) */ decorators?: Decorator[]; span: Span }
export interface InterfaceMethod { name: string; typeParameters?: TypeParameter[]; params: Parameter[]; returnType: TypeName; /** V0.3 */ resolvedSignature?: import("../types/type-system.ts").ResolvedSignature; /** V18 */ decorators?: Decorator[]; span: Span }
export interface InterfaceDeclaration { kind: "InterfaceDeclaration"; exported?: boolean; name: string; methods: InterfaceMethod[]; /** V0.4: tipo concreto en runtime C++. */ resolvedRuntimeType?: import("../types/type-system.ts").ResolvedRuntimeType; /** V18: decoradores sobre la interface en sí (`@cpp_type(...)`). */ decorators?: Decorator[]; span: Span }
export type Decorator = { name: string; args: Expression[] };

// V19: modificador de encapsulación. "public" es el default si se omite.
export type AccessModifier = "public" | "private" | "protected";
export interface ClassField { name: string; type: TypeName; readonly?: boolean; /** V19 */ access?: AccessModifier; decorators?: Decorator[]; span: Span }
export interface ClassMethod { name: string; typeParameters?: TypeParameter[]; params: Parameter[]; returnType: TypeName; /** V0.3 */ resolvedSignature?: import("../types/type-system.ts").ResolvedSignature; body: BlockStatement; decorators?: Decorator[]; /** V19 */ access?: AccessModifier; span: Span }
export interface ClassDeclaration { kind: "ClassDeclaration"; exported?: boolean; name: string; typeParameters: TypeParameter[]; variadicTypeParameters: string[]; fields: ClassField[]; methods: ClassMethod[]; decorators?: Decorator[]; /** V0.4 */ resolvedRuntimeType?: import("../types/type-system.ts").ResolvedRuntimeType; span: Span }
export interface BlockStatement { kind: "BlockStatement"; statements: Statement[]; span: Span }
export interface ExpressionStatement { kind: "ExpressionStatement"; expression: Expression; span: Span }
export interface IfStatement { kind: "IfStatement"; condition: Expression; thenBranch: Statement; elseBranch?: Statement; span: Span }
export interface WhileStatement { kind: "WhileStatement"; condition: Expression; body: Statement; span: Span }
export interface ForStatement { kind: "ForStatement"; initializer?: VariableDeclaration | ExpressionStatement; condition?: Expression; increment?: Expression; body: Statement; span: Span }
export interface BreakStatement { kind: "BreakStatement"; span: Span }
export interface ContinueStatement { kind: "ContinueStatement"; span: Span }
export interface ReturnStatement { kind: "ReturnStatement"; value?: Expression; span: Span }

export interface TypeParameter { name: string; constraint?: TypeName; default?: TypeName; span: Span }
export interface TypeAliasDeclaration { kind: "TypeAliasDeclaration"; exported?: boolean; name: string; typeParameters: TypeParameter[]; type: TypeName; /** V0.4 */ resolvedRuntimeType?: import("../types/type-system.ts").ResolvedRuntimeType; span: Span }
export interface EnumMember { name: string; value?: LiteralExpression; span: Span }
export interface EnumDeclaration { kind: "EnumDeclaration"; exported?: boolean; name: string; members: EnumMember[]; underlying: "number" | "string"; /** V0.4 */ resolvedRuntimeType?: import("../types/type-system.ts").ResolvedRuntimeType; span: Span }

// V1: tagged unions. Una unión discriminada tiene un conjunto de
// variantes, cada una con su nombre y su payload (un tipo). Se emite en
// C++ como `std::variant<T1, T2, ...>` con un discriminador (índice).
// V1.4: `discriminator` se popula cuando la variante se declara como
// object-literal `{ kind: "A"; <bindings> }`. El campo discriminador y su
// valor primitivo (string/number/boolean) son los que el narrowing en
// `if` consulta para estrechar el tipo de la unión.
export interface UnionVariant {
  name: string;
  payload?: TypeName;
  /**
   * V1.4: metadata del discriminador cuando la sintaxis fuente fue un
   * object-literal `{ field: literal; ... }`. Ausente para la forma
   * legacy `A(T)` (sin discriminador literal: el discriminador es el
   * índice de la variante, no un campo del payload).
   */
  discriminator?: { field: string; value: string | number | boolean };
  span: Span;
}
export interface UnionDeclaration { kind: "UnionDeclaration"; exported?: boolean; name: string; typeParameters: TypeParameter[]; variants: UnionVariant[]; /** V0.4 */ resolvedRuntimeType?: import("../types/type-system.ts").ResolvedRuntimeType; span: Span }
export interface CaseClause { labels: Expression[]; body: Statement[]; span: Span }
export interface DefaultClause { body: Statement[]; span: Span }
export interface SwitchStatement { kind: "SwitchStatement"; discriminant: Expression; cases: CaseClause[]; defaultClause?: DefaultClause; span: Span }
export interface ForOfStatement { kind: "ForOfStatement"; binding: VariableDeclaration; iterable: Expression; await?: boolean; body: Statement; span: Span }
export interface ForInStatement { kind: "ForInStatement"; binding: VariableDeclaration; target: Expression; body: Statement; span: Span }
export interface DeleteStatement { kind: "DeleteStatement"; target: IndexExpression; span: Span }

export type Expression = (LiteralExpression | IdentifierExpression | GenericIdentifierExpression | ArrayLiteralExpression | ObjectLiteralExpression | ArrowFunctionExpression | UnaryExpression | AwaitExpression | BinaryExpression | CallExpression | MemberExpression | MemberCallExpression | IndexExpression | NewExpression | AssignmentExpression | TemplateLiteralExpression | TernaryExpression | MatchExpression | SatisfiesExpression) & {
  /**
   * V0.1: tipo resuelto adjuntado al nodo por el semantic checker.
   * El codegen consume este campo directamente en lugar de parsear
   * strings de tipo. Si no está presente (p.ej. nodos sintéticos de
   * tests unitarios del AST), el codegen cae al comportamiento previo
   * basado en `TypeName`.
   */
  resolvedType?: import("../types/type-system.ts").ResolvedType;
};
export interface LiteralExpression { kind: "LiteralExpression"; value: number | string | boolean; literalType: PrimitiveType; raw?: string; span: Span }
export interface IdentifierExpression { kind: "IdentifierExpression"; name: string; span: Span }
// V1.2: `Name<T, U>.Member(...)` modela el identificador parametrizado
// antes de un member access.
export interface GenericIdentifierExpression { kind: "GenericIdentifierExpression"; name: string; typeArguments: TypeName[]; span: Span }
export interface ArrayLiteralExpression { kind: "ArrayLiteralExpression"; elements: ArrayElement[]; span: Span }
/** V1.4: object literal `{ ok: true, value: x }` se usa como constructor inline
 *  de una object-variant. El primer `property` debe ser el discriminador (un
 *  literal primitivo); el resto son bindings del payload. El type-checker
 *  conecta el literal con la unión esperada por contexto. */
export interface ObjectLiteralExpression { kind: "ObjectLiteralExpression"; properties: { key: string; value: Expression }[]; span: Span }
// Un `ArrayElement` puede ser una expresión normal o un spread (`...expr`).
// El spread se aplica como `insert`/`push_back` sobre el `std::vector` del
// literal resultante. El dialecto no soporta `...[a, b, ...rest]` con varios
// spreads anidados; el primer spread debe ser el último elemento.
export type ArrayElement = Expression | SpreadElement;
export interface SpreadElement { kind: "SpreadElement"; expression: Expression; span: Span }
export interface ArrowFunctionExpression { kind: "ArrowFunctionExpression"; params: Parameter[]; returnType?: TypeName; /** V0.3 */ resolvedSignature?: import("../types/type-system.ts").ResolvedSignature; body: Expression | BlockStatement; mutatesCapturedState?: boolean; /** V10: nombres de variables capturadas del scope exterior (no parámetros). Lo rellena el type-checker recorriendo el cuerpo. Permite al codegen saber si el lambda tiene dependencias externas. */ capturedSymbols?: string[]; /** V10: si este lambda se pasa directamente como argumento a una sola llamada (no se guarda en una variable), apunta al `CallExpression`/`MemberCallExpression` que lo recibe. Cuando está presente, el codegen puede emitir la lambda inline en C++ sin envolver en `std::function`. */ singleUseSite?: { kind: "CallExpression" | "MemberCallExpression"; argumentIndex: number }; span: Span }
export interface SatisfiesExpression { kind: "SatisfiesExpression"; operand: Expression; declaredType: TypeName; span: Span }
export interface MatchArm { pattern: Expression; result: Expression; /** V2: pattern destructuring sobre tagged unions. Cuando está presente, el
 *  parser lo pobló a partir de `case { kind: "<Variant>", <bindings>? }:` o
 *  `case _: <expr>;`. `pattern` (legacy) queda para el flujo `when (...)`
 *  y para exponer `_` como `IdentifierExpression("_")` en consumos que aún
 *  no soportan exhaustividad. */ variantMatch?: { variantName: string; bindings: string[]; isWildcard?: boolean }; span: Span }
export interface MatchExpression { kind: "MatchExpression"; subject: Expression; arms: MatchArm[]; span: Span }
// `parts` y `expressions` tienen la misma longitud menos 1 (siempre hay un
// parte más que expresiones). Las partes son los trozos literales; las
// expresiones se intercalan entre ellas y se evalúan para producir texto.
export interface TemplateLiteralExpression { kind: "TemplateLiteralExpression"; parts: string[]; expressions: Expression[]; span: Span }
export interface UnaryExpression { kind: "UnaryExpression"; operator: "!" | "-" | "+" | "typeof"; operand: Expression; span: Span }
export interface AwaitExpression { kind: "AwaitExpression"; operand: Expression; span: Span }
export interface BinaryExpression { kind: "BinaryExpression"; operator: string; left: Expression; right: Expression; span: Span }
export interface CallExpression { kind: "CallExpression"; callee: string; typeArguments: TypeName[]; args: Expression[]; /** V23 (match new syntax): cuando `callee === "match"` y la llamada se validó
 *  con la nueva forma `match(v, [...])`, el codegen intercepta y emite un
 *  if/else chain. Sin esto, sería una llamada a función normal. */
  matchedKind?: "match"; /** V23: discriminador para `match` de 3 args (`match(v, "key", [...])`). */
  matchedDiscriminator?: string; /** V23: tipo del resultado del match (R | R | R | ...) calculado
   *  por el checker uniendo los retornos de cada callback. */
  matchedResultType?: TypeName; span: Span }
export interface MemberExpression { kind: "MemberExpression"; object: Expression; member: string; optional?: boolean; span: Span }
export interface MemberCallExpression { kind: "MemberCallExpression"; object: Expression; method: string; typeArguments: TypeName[]; args: Expression[]; optional?: boolean; span: Span }
export interface IndexExpression { kind: "IndexExpression"; object: Expression; index: Expression; span: Span }
export interface NewExpression { kind: "NewExpression"; className: string; args: Expression[]; span: Span }
export interface AssignmentExpression { kind: "AssignmentExpression"; target: IdentifierExpression | MemberExpression | IndexExpression; value: Expression; span: Span }
export interface TernaryExpression { kind: "TernaryExpression"; condition: Expression; thenBranch: Expression; elseBranch: Expression; span: Span }
