import type { Span } from "../core/span.ts";

export type PrimitiveType = "number" | "string" | "boolean" | "void" | "undefined" | "object";
export type TypeName = string;
export type ParameterPassing = "automatic" | "mut" | "out" | "move";
export interface Program { kind: "Program"; statements: Statement[]; span: Span }
export type Statement = VariableDeclaration | FunctionDeclaration | InterfaceDeclaration | ClassDeclaration | BlockStatement | ExpressionStatement | IfStatement | WhileStatement | ForStatement | BreakStatement | ContinueStatement | ReturnStatement | TypeAliasDeclaration | EnumDeclaration | SwitchStatement | ForOfStatement | ForInStatement | DeleteStatement | UsingDeclaration;
export interface VariableDeclaration { kind: "VariableDeclaration"; exported?: boolean; mutable: boolean; name: string; declaredType?: TypeName; initializer: Expression; arrayBindings?: ArrayBinding[]; span: Span }
// `using name = expr;` (TC39 stage 3): declara un recurso cuyo destructor se
// invoca al salir del bloque. En el dialecto es syntactic sugar sobre
// `let name = expr` con la garantía de que el destructor C++ del tipo se llama
// al final del bloque contenedor (RAII automático). Si el tipo define un método
// `dispose()`, también se invoca explícitamente.
export interface UsingDeclaration { kind: "UsingDeclaration"; exported?: boolean; name: string; declaredType?: TypeName; initializer: Expression; span: Span }
// `ArrayBinding` representa un binding de destructuring de arrays del estilo
// `const [a, b, c] = arr;`. Cada elemento es el nombre de una variable local
// (y opcionalmente su tipo declarado). No hay default values ni rest
// patterns por ahora; el dialecto favorece el acceso explícito por índice
// (`arr[0]`, `arr[1]`) cuando hace falta más azúcar.
export interface ArrayBinding { name: string; declaredType?: TypeName; defaultValue?: Expression }
export interface Parameter { name: string; type: TypeName; out: boolean; passing: ParameterPassing; variadic?: boolean; defaultValue?: Expression; optional?: boolean; span: Span }
export interface FunctionDeclaration { kind: "FunctionDeclaration"; exported?: boolean; name: string; async: boolean; typeParameters: TypeParameter[]; variadicTypeParameters: string[]; params: Parameter[]; returnType: TypeName; body: BlockStatement; span: Span }
export interface InterfaceMethod { name: string; typeParameters?: TypeParameter[]; params: Parameter[]; returnType: TypeName; span: Span }
export interface InterfaceDeclaration { kind: "InterfaceDeclaration"; exported?: boolean; name: string; methods: InterfaceMethod[]; span: Span }
export type Decorator = { name: string; args: Expression[] };

export interface ClassField { name: string; type: TypeName; readonly?: boolean; decorators?: Decorator[]; span: Span }
export interface ClassMethod { name: string; typeParameters?: TypeParameter[]; params: Parameter[]; returnType: TypeName; body: BlockStatement; decorators?: Decorator[]; span: Span }
export interface ClassDeclaration { kind: "ClassDeclaration"; exported?: boolean; name: string; typeParameters: TypeParameter[]; variadicTypeParameters: string[]; fields: ClassField[]; methods: ClassMethod[]; decorators?: Decorator[]; span: Span }
export interface BlockStatement { kind: "BlockStatement"; statements: Statement[]; span: Span }
export interface ExpressionStatement { kind: "ExpressionStatement"; expression: Expression; span: Span }
export interface IfStatement { kind: "IfStatement"; condition: Expression; thenBranch: Statement; elseBranch?: Statement; span: Span }
export interface WhileStatement { kind: "WhileStatement"; condition: Expression; body: Statement; span: Span }
export interface ForStatement { kind: "ForStatement"; initializer?: VariableDeclaration | ExpressionStatement; condition?: Expression; increment?: Expression; body: Statement; span: Span }
export interface BreakStatement { kind: "BreakStatement"; span: Span }
export interface ContinueStatement { kind: "ContinueStatement"; span: Span }
export interface ReturnStatement { kind: "ReturnStatement"; value?: Expression; span: Span }

export interface TypeParameter { name: string; constraint?: TypeName; default?: TypeName; span: Span }
export interface TypeAliasDeclaration { kind: "TypeAliasDeclaration"; exported?: boolean; name: string; typeParameters: TypeParameter[]; type: TypeName; span: Span }
export interface EnumMember { name: string; value?: LiteralExpression; span: Span }
export interface EnumDeclaration { kind: "EnumDeclaration"; exported?: boolean; name: string; members: EnumMember[]; underlying: "number" | "string"; span: Span }
export interface CaseClause { labels: Expression[]; body: Statement[]; span: Span }
export interface DefaultClause { body: Statement[]; span: Span }
export interface SwitchStatement { kind: "SwitchStatement"; discriminant: Expression; cases: CaseClause[]; defaultClause?: DefaultClause; span: Span }
export interface ForOfStatement { kind: "ForOfStatement"; binding: VariableDeclaration; iterable: Expression; await?: boolean; body: Statement; span: Span }
export interface ForInStatement { kind: "ForInStatement"; binding: VariableDeclaration; target: Expression; body: Statement; span: Span }
export interface DeleteStatement { kind: "DeleteStatement"; target: IndexExpression; span: Span }

export type Expression = LiteralExpression | IdentifierExpression | ArrayLiteralExpression | ArrowFunctionExpression | UnaryExpression | AwaitExpression | BinaryExpression | CallExpression | MemberExpression | MemberCallExpression | IndexExpression | NewExpression | AssignmentExpression | TemplateLiteralExpression | TernaryExpression | MatchExpression;
export interface LiteralExpression { kind: "LiteralExpression"; value: number | string | boolean; literalType: PrimitiveType; raw?: string; span: Span }
export interface IdentifierExpression { kind: "IdentifierExpression"; name: string; span: Span }
export interface ArrayLiteralExpression { kind: "ArrayLiteralExpression"; elements: ArrayElement[]; span: Span }
// Un `ArrayElement` puede ser una expresión normal o un spread (`...expr`).
// El spread se aplica como `insert`/`push_back` sobre el `std::vector` del
// literal resultante. El dialecto no soporta `...[a, b, ...rest]` con varios
// spreads anidados; el primer spread debe ser el último elemento.
export type ArrayElement = Expression | SpreadElement;
export interface SpreadElement { kind: "SpreadElement"; expression: Expression; span: Span }
export interface ArrowFunctionExpression { kind: "ArrowFunctionExpression"; params: Parameter[]; returnType?: TypeName; body: Expression | BlockStatement; mutatesCapturedState?: boolean; span: Span }
export interface MatchArm { pattern: Expression; result: Expression; span: Span }
export interface MatchExpression { kind: "MatchExpression"; subject: Expression; arms: MatchArm[]; span: Span }
// `parts` y `expressions` tienen la misma longitud menos 1 (siempre hay un
// parte más que expresiones). Las partes son los trozos literales; las
// expresiones se intercalan entre ellas y se evalúan para producir texto.
export interface TemplateLiteralExpression { kind: "TemplateLiteralExpression"; parts: string[]; expressions: Expression[]; span: Span }
export interface UnaryExpression { kind: "UnaryExpression"; operator: "!" | "-" | "+" | "typeof"; operand: Expression; span: Span }
export interface AwaitExpression { kind: "AwaitExpression"; operand: Expression; span: Span }
export interface BinaryExpression { kind: "BinaryExpression"; operator: string; left: Expression; right: Expression; span: Span }
export interface CallExpression { kind: "CallExpression"; callee: string; typeArguments: TypeName[]; args: Expression[]; span: Span }
export interface MemberExpression { kind: "MemberExpression"; object: Expression; member: string; optional?: boolean; span: Span }
export interface MemberCallExpression { kind: "MemberCallExpression"; object: Expression; method: string; typeArguments: TypeName[]; args: Expression[]; optional?: boolean; span: Span }
export interface IndexExpression { kind: "IndexExpression"; object: Expression; index: Expression; span: Span }
export interface NewExpression { kind: "NewExpression"; className: string; args: Expression[]; span: Span }
export interface AssignmentExpression { kind: "AssignmentExpression"; target: IdentifierExpression | MemberExpression | IndexExpression; value: Expression; span: Span }
export interface TernaryExpression { kind: "TernaryExpression"; condition: Expression; thenBranch: Expression; elseBranch: Expression; span: Span }
