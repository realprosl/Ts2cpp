#!/usr/bin/env node
// Genera una página HTML con todos los ejemplos del dialecto como demos.
// Cada demo muestra el archivo .ets y su salida golden (si existe).
// Estilo minimalista con CSS embebido (sin deps).
//
// Uso: node scripts/build-demo-page.ts [salida.html]
// Salida por defecto: docs/demos.html

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

// Categorías: cada demo se asigna por nombre (string match). El orden de las
// claves define el orden en la página.
const CATEGORIES: { name: string; icon: string; examples: string[] }[] = [
  {
    name: "Hola mundo y básicos",
    icon: "👋",
    examples: ["hello"],
  },
  {
    name: "Constructores y clases",
    icon: "🏛️",
    examples: ["constructor-demo", "complete-demo", "composition", "interface", "mutable-borrows", "default-args-demo"],
  },
  {
    name: "Genéricos y tipos",
    icon: "🧬",
    examples: ["generics", "overloads-variadics", "union-demo", "intersection-demo", "type-aliases", "default-type-params", "typeof-type", "typeof-value", "function-type-demo"],
  },
  {
    name: "Colecciones y arrays",
    icon: "📚",
    examples: ["collections", "map-set-demo", "spread-array-demo", "destructuring-demo", "destructuring-default"],
  },
  {
    name: "Async y promesas",
    icon: "⚡",
    examples: ["async-await", "async-files", "cancellation", "for-await-demo"],
  },
  {
    name: "Closures y funciones",
    icon: "🔁",
    examples: ["closures", "for-of-demo", "for-in-demo", "match-demo", "using-demo"],
  },
  {
    name: "Stdlib runtime",
    icon: "🔧",
    examples: ["math-date-demo", "numeric-literal", "enum-demo", "delete-demo", "instanceof-demo"],
  },
  {
    name: "JSON y strings",
    icon: "📝",
    examples: ["json-tree-demo", "template-strings-demo"],
  },
  {
    name: "Tipos nullish (Fase 1)",
    icon: "❓",
    examples: ["optional-demo", "nullish-coalescing-demo", "optional-chaining-demo", "optional-parameter-demo"],
  },
  {
    name: "Decoradores (Fase 1)",
    icon: "🎨",
    examples: ["decorator-demo"],
  },
  {
    name: "Módulos (Fase 1)",
    icon: "📦",
    examples: ["exports-demo"],
  },
  {
    name: "I/O nativo",
    icon: "💾",
    examples: ["native-io", "fs-demo", "result-files", "node-api-demo", "console-demo"],
  },
  {
    name: "Red y TLS",
    icon: "🌐",
    examples: ["http-server", "tls-server"],
  },
];

interface Demo {
  name: string;
  category: string;
  categoryIcon: string;
  source: string;
  output: string | null; // null si no hay golden (ej. abre puertos de red)
  hasOutput: boolean;
}

async function loadDemo(name: string, category: string, icon: string): Promise<Demo> {
  const sourcePath = join("examples", `${name}.ets`);
  const goldenPath = join("test", "golden", `${name}.expected.txt`);
  const source = await readFile(sourcePath, "utf8");
  let output: string | null = null;
  try { output = await readFile(goldenPath, "utf8"); } catch { /* sin golden */ }
  return { name, category, categoryIcon: icon, source, output, hasOutput: output !== null };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderDemo(demo: Demo): string {
  const outputBlock = demo.hasOutput
    ? `<pre class="output" aria-label="Salida del programa">${escapeHtml(demo.output ?? "")}</pre>`
    : `<p class="no-output">Sin golden file (ejemplo abre puertos de red o sale con código no verificable).</p>`;
  return `<article class="demo">
  <header>
    <h3>${escapeHtml(demo.name)}</h3>
    ${demo.hasOutput ? `<span class="badge ok" title="Tiene golden file">✓ output</span>` : `<span class="badge warn" title="Sin golden file">⚠ sin golden</span>`}
  </header>
  <details>
    <summary>Ver código fuente</summary>
    <pre class="source" aria-label="Código fuente">${escapeHtml(demo.source)}</pre>
  </details>
  <details open>
    <summary>Salida del programa</summary>
    ${outputBlock}
  </details>
</article>`;
}

function renderCategory(category: { name: string; icon: string; examples: string[] }, demos: Demo[]): string {
  const categoryDemos = demos.filter(d => category.examples.includes(d.name));
  if (categoryDemos.length === 0) return "";
  const totalWithOutput = categoryDemos.filter(d => d.hasOutput).length;
  return `<section class="category">
  <h2><span class="icon">${category.icon}</span> ${escapeHtml(category.name)} <span class="count">${totalWithOutput}/${categoryDemos.length}</span></h2>
  ${categoryDemos.map(renderDemo).join("\n")}
</section>`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outPath = args[0] ?? "docs/demos.html";

  // Carga todos los demos referenciados en categorías.
  const demos: Demo[] = [];
  for (const category of CATEGORIES) for (const name of category.examples) demos.push(await loadDemo(name, category.name, category.icon));

  // Detecta demos huérfanos (no listados en categorías) para mostrarlos al final.
  const listedNames = new Set(demos.map(d => d.name));
  const allExamples = (await readdir("examples")).filter(f => f.endsWith(".ets")).map(f => basename(f, ".ets"));
  const orphans = allExamples.filter(name => !listedNames.has(name));
  if (orphans.length > 0) {
    console.warn(`⚠ ${orphans.length} demo(s) no listados en CATEGORIES:`);
    for (const name of orphans) console.warn(`   - ${name}`);
  }

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Estatic · Demos</title>
<style>
:root {
  --bg: #1e1e2e;
  --bg-elev: #28283a;
  --fg: #cdd6f4;
  --fg-dim: #a6adc8;
  --accent: #89b4fa;
  --ok: #a6e3a1;
  --warn: #f9e2af;
  --err: #f38ba8;
  --border: #45475a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.5;
}
header.banner {
  padding: 2rem 1.5rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
header.banner h1 {
  margin: 0 0 0.5rem;
  font-size: 1.8rem;
  color: var(--accent);
}
header.banner p {
  margin: 0;
  color: var(--fg-dim);
  font-size: 0.95rem;
}
header.banner code {
  background: var(--bg);
  padding: 0.1em 0.4em;
  border-radius: 4px;
  font-size: 0.85em;
  border: 1px solid var(--border);
}
nav.toc {
  padding: 1rem 1.5rem;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}
nav.toc a {
  color: var(--accent);
  text-decoration: none;
}
nav.toc a:hover { text-decoration: underline; }
main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1.5rem;
}
section.category {
  margin-bottom: 2.5rem;
  scroll-margin-top: 1rem;
}
section.category h2 {
  font-size: 1.3rem;
  margin: 0 0 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
section.category h2 .icon { font-size: 1.2rem; }
section.category h2 .count {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--fg-dim);
  background: var(--bg-elev);
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border);
}
article.demo {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 1rem;
}
article.demo header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
article.demo h3 {
  margin: 0;
  font-size: 1rem;
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", monospace;
  color: var(--accent);
}
.badge {
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.badge.ok { background: rgba(166, 227, 161, 0.15); color: var(--ok); border: 1px solid rgba(166, 227, 161, 0.3); }
.badge.warn { background: rgba(249, 226, 175, 0.15); color: var(--warn); border: 1px solid rgba(249, 226, 175, 0.3); }
details {
  margin-top: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
details summary {
  cursor: pointer;
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
  color: var(--fg-dim);
  user-select: none;
}
details summary:hover { color: var(--fg); }
details[open] summary { color: var(--accent); border-bottom: 1px solid var(--border); }
pre {
  margin: 0;
  padding: 0.75rem;
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", monospace;
  font-size: 0.8rem;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
}
pre.source { color: var(--fg); }
pre.output { color: var(--ok); background: rgba(166, 227, 161, 0.05); }
.no-output {
  margin: 0;
  padding: 0.75rem;
  font-size: 0.85rem;
  color: var(--warn);
  font-style: italic;
}
footer {
  padding: 2rem 1.5rem;
  text-align: center;
  color: var(--fg-dim);
  font-size: 0.85rem;
  border-top: 1px solid var(--border);
}
footer a { color: var(--accent); }
</style>
</head>
<body>
<header class="banner">
  <h1>Estatic TS → C++ · Demos</h1>
  <p>${demos.length} ejemplos del dialecto, organizados por categoría. Cada demo incluye el código fuente (en <code>.ets</code>) y la salida esperada (golden file). Los demos marcados con <code>⚠ sin golden</code> abren puertos de red o tienen salida no determinista; verifica manualmente.</p>
</header>
<nav class="toc">
  ${CATEGORIES.filter(c => c.examples.some(n => demos.find(d => d.name === n))).map(c => `<a href="#cat-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}">${c.icon} ${escapeHtml(c.name)}</a>`).join("\n  ")}
</nav>
<main>
${CATEGORIES.map(c => renderCategory(c, demos).replace(`<section class="category">`, `<section class="category" id="cat-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}">`)).filter(s => s.length > 0).join("\n")}
</main>
<footer>
  Generado automáticamente por <code>scripts/build-demo-page.ts</code> · <a href="./">Volver al repo</a>
</footer>
</body>
</html>
`;

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  console.log(`Generado ${outPath} (${demos.length} demos en ${CATEGORIES.filter(c => c.examples.some(n => demos.find(d => d.name === n))).length} categorías)`);
}

main().catch(error => { console.error(error); process.exit(1); });
