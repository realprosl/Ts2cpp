import type { Expression, TypeName } from "../ast/nodes.ts";

export interface VariableSymbol { kind: "variable"; type: TypeName; mutable: boolean; variadic?: boolean; /** V0.2: true si el nombre choca con un singleton del runtime C++ (p.ej. console, fs, path, process, JSON). El codegen lo usa para evitar colisiones de identificadores en lugar de mantener un Set<string> hardcodeado. */ fromRuntime?: boolean; /** V6: valor literal del initializer cuando el símbolo es `const` y el initializer es un LiteralExpression. El type-checker lo propaga a referencias posteriores (tamaños de arrays fijos, branches con condición constante). */ constValue?: number | string | boolean | null }
export interface FunctionParameterSymbol { type: TypeName; out: boolean; mutableReference?: boolean; defaultValue?: Expression; optional?: boolean }
export interface FunctionSignature { typeParameters: string[]; variadicTypeParameters: string[]; typeConstraints?: Record<string, TypeName>; defaults?: Record<string, TypeName>; params: Array<FunctionParameterSymbol & { variadic?: boolean }>; returnType: TypeName }
export interface FunctionSymbol { kind: "function"; overloads: FunctionSignature[] }
export interface TypeSymbol { kind: "type"; type: TypeName }
export type SymbolInfo = VariableSymbol | FunctionSymbol | TypeSymbol;

export class Scope {
  private readonly symbols = new Map<string, SymbolInfo>();
  private readonly parent?: Scope;
  constructor(parent?: Scope) { this.parent = parent; }
  define(name: string, symbol: SymbolInfo): boolean { if (this.symbols.has(name)) return false; this.symbols.set(name, symbol); return true; }
  resolveLocal(name: string): SymbolInfo | undefined { return this.symbols.get(name); }
  resolve(name: string): SymbolInfo | undefined { return this.symbols.get(name) ?? this.parent?.resolve(name); }
  /** Itera todos los nombres visibles desde este scope (incluyendo padres). */
  *names(): IterableIterator<string> {
    for (const key of this.symbols.keys()) yield key;
    if (this.parent) yield* this.parent.names();
  }
  /** V10.1: true si este scope es el raíz (no tiene padre). */
  isRoot(): boolean { return this.parent === undefined; }
  /** V10.1: sube por la cadena de scopes y devuelve el scope raíz. */
  root(): Scope {
    let current: Scope = this;
    while (current.parent !== undefined) current = current.parent;
    return current;
  }
}
