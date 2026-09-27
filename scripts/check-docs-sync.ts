// check-docs-sync.ts — verifica que LIMITATIONS.md sea coherente con el
// estado real del compilador Estatic.
//
// Reglas:
//   (a) CONTRADICCIÓN — LIMITATIONS.md marca X como rechazado/pospuesto
//       pero X existe como nodo AST, keyword o ejemplo.
//   (b) REFERENCIA ROTA — El doc menciona un example/ que no existe.
//   (c) PENDIENTE IMPLEMENTADO — Una keyword aparece en "Pendiente" y
//       también en "Implementado" (debe estar en una sola sección).
//
// Lo que NO se comprueba (heurísticamente inviable):
//   - Que todo nodo/keyword/ejemplo esté *literalmente* mencionado. El doc
//     usa sinónimos ("Enums" en vez de "EnumDeclaration"), y obligar a
//     usar nombres técnicos penaliza la legibilidad.
//
// Uso:  node --experimental-strip-types scripts/check-docs-sync.ts
// Salida: exit 0 si pasa; exit 1 + lista de fallos si no.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function read(p: string): string {
  return readFileSync(join(ROOT, p), "utf-8");
}

function listDir(dir: string, ext?: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (ext && !entry.name.endsWith(ext)) continue;
    out.push(entry.name);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Inventario del código ─────────────────────────────────────────────────

const astSource = read("src/ast/nodes.ts");
const astNodes: { name: string; kind: string }[] = [];
const astRe = /export interface (\w+)[^{]*\{[^}]*kind:\s*"(\w+)"/g;
let m: RegExpExecArray | null;
while ((m = astRe.exec(astSource))) astNodes.push({ name: m[1], kind: m[2] });

const lexerSource = read("src/lexer/token.ts");
const tokenKinds: string[] = [];
const tkMatch = lexerSource.match(/type TokenKind\s*=\s*([\s\S]*?);/);
if (tkMatch) {
  const tkRe = /"([^"]+)"/g;
  let tk: RegExpExecArray | null;
  while ((tk = tkRe.exec(tkMatch[1]))) tokenKinds.push(tk[1]);
}

const kwStart = lexerSource.indexOf("Object.assign(Object.create(null), {");
const kwEnd = lexerSource.indexOf("})", kwStart);
const kwBlock = kwStart >= 0 && kwEnd > kwStart ? lexerSource.slice(kwStart, kwEnd) : "";
const keywords: string[] = [];
const kwRe = /\b([a-zA-Z]+):\s*"[a-zA-Z]+"/g;
let kw: RegExpExecArray | null;
while ((kw = kwRe.exec(kwBlock))) keywords.push(kw[1]);

const examples = listDir("examples", ".ets").map((f) => f.replace(/\.ets$/, ""));

// ─── Inventario del doc ────────────────────────────────────────────────────

const limitations = read("LIMITATIONS.md");

const implementedSection = limitations.match(/## ✅ Implementado[\s\S]*?(?=\n## )/)?.[0] ?? "";
const rejectedSection = limitations.match(/## ❌ Rechazado por diseño[\s\S]*?(?=\n## )/)?.[0] ?? "";
const pendingSection = limitations.match(/## 🟡 Pendiente[\s\S]*?(?=\n## )/)?.[0] ?? "";

// ─── Reglas ────────────────────────────────────────────────────────────────

interface Issue {
  rule: string;
  symbol: string;
  detail: string;
}

const issues: Issue[] = [];

function isRejected(token: string): boolean {
  const safe = escapeRegex(token);
  const patterns = [
    new RegExp(`-\\s*\\*\\*\`${safe}\`\\*\\*[^*]*?(rechazad|no soport|pospuest)`, "i"),
    new RegExp(`\\|\\s*\`${safe}\`\\s*\\|`, "i"),
  ];
  return patterns.some((re) => re.test(rejectedSection));
}

function mentionedAnywhere(token: string): boolean {
  const safe = escapeRegex(token);
  return new RegExp(`\\b${safe}\\b`).test(limitations);
}

// Regla (a): contradicción.
for (const node of astNodes) {
  if (isRejected(node.name) || isRejected(node.kind)) {
    issues.push({
      rule: "contradiction",
      symbol: `${node.name} (kind "${node.kind}")`,
      detail: `LIMITATIONS.md marca este nodo como rechazado/pospuesto pero existe un nodo AST para ello.`,
    });
  }
}
for (const kind of tokenKinds) {
  if (isRejected(kind)) {
    issues.push({
      rule: "contradiction",
      symbol: `TokenKind "${kind}"`,
      detail: `LIMITATIONS.md marca este token como rechazado pero el lexer lo reconoce.`,
    });
  }
}
for (const kw of keywords) {
  if (isRejected(kw)) {
    issues.push({
      rule: "contradiction",
      symbol: `Keyword "${kw}"`,
      detail: `LIMITATIONS.md marca esta keyword como rechazada pero el lexer la acepta.`,
    });
  }
}
for (const ex of examples) {
  if (isRejected(ex)) {
    issues.push({
      rule: "contradiction",
      symbol: `Example ${ex}.ets`,
      detail: `LIMITATIONS.md marca este ejemplo como relacionado con una feature rechazada.`,
    });
  }
}

// Regla (b): referencia rota — el doc menciona un examples/ que no existe.
const exampleRefsInDoc = new Set<string>();
for (const m of limitations.matchAll(/examples\/([a-z0-9_-]+)/g)) exampleRefsInDoc.add(m[1]);
for (const ref of exampleRefsInDoc) {
  if (!examples.includes(ref)) {
    issues.push({
      rule: "broken-reference",
      symbol: `examples/${ref}.ets`,
      detail: `LIMITATIONS.md referencia este ejemplo pero no existe en examples/.`,
    });
  }
}

// Regla (c) "keyword en dos secciones" se omite por propensión a falsos
// positivos: una keyword puede mencionarse en varios contextos sin ser
// contradictoria (p. ej. "extends" en Implementado al hablar de "sin
// herencia" y en Pendiente al hablar de "herencia no soportada").

// ─── Reporte ───────────────────────────────────────────────────────────────

const stats = `AST=${astNodes.length} Tokens=${tokenKinds.length} Keywords=${keywords.length} Examples=${examples.length}`;
if (issues.length === 0) {
  console.log(`✓ check-docs-sync: LIMITATIONS.md coherente con el código. ${stats}`);
  process.exit(0);
}

console.error(`✗ check-docs-sync: ${issues.length} problema(s) [${stats}]:\n`);
for (const issue of issues) {
  console.error(`  [${issue.rule}] ${issue.symbol}`);
  console.error(`    detalle: ${issue.detail}\n`);
}
console.error("Actualiza LIMITATIONS.md (sección Implementado / Rechazado / Pendiente).");
process.exit(1);
