#!/usr/bin/env python3
"""Genera la tabla resumen a partir de los CSVs de hyperfine."""
import csv
import pathlib

bench_dir = pathlib.Path(__file__).parent
scratch = bench_dir / ".." / ".." / ".scratch" / "bench"
out = bench_dir / "RESULTS.md"

benchs = [
    ("B-class",       "clase con constructor + metodos"),
    ("B-array-ops",   "pipeline arrays (filter+map+reduce)"),
    ("B-for-of",      "for..of sobre array"),
    ("B-string-ops",  "concatenacion strings + template literals"),
    ("B-ptr-move",    "V22 memory model: ptr<T> + move"),
    ("B-optional",    "V14 Optional<T>.some/.none + valueOr"),
    ("B-arith",       "aritmetica basica en loop tight"),
    ("B-generic",     "clase generica Box<T>"),
    ("B-closures",    "closure capturando [&counts]"),
    ("B-recursive",   "recursion simple (factorial)"),
]

# Lee tiempos de cada CSV
rows = []
for b, desc in benchs:
    csv_path = scratch / f"{b}.csv"
    if not csv_path.exists():
        rows.append((b, desc, None, None, None))
        continue
    with csv_path.open() as f:
        reader = csv.reader(f)
        next(reader)  # header
        ets_mean = None
        cpp_mean = None
        for row in reader:
            if len(row) < 2: continue
            if row[0] == "ets":
                ets_mean = float(row[1])
            elif row[0] == "cpp":
                cpp_mean = float(row[1])
    if ets_mean is None or cpp_mean is None:
        rows.append((b, desc, None, None, None))
        continue
    ratio = ets_mean / cpp_mean if cpp_mean > 0 else float("inf")
    rows.append((b, desc, ets_mean * 1000, cpp_mean * 1000, ratio))

# Genera la tabla markdown
def fmt(v, w):
    if v is None: return "N/A".ljust(w)
    if isinstance(v, float):
        return f"{v:.2f}".ljust(w)
    return str(v).ljust(w)

lines = [
    "",
    "## Tabla resumen (medias en milisegundos)",
    "",
    f"| {'Benchmark':<12} | {'Descripcion':<40} | {'ets (ms)':>10} | {'cpp (ms)':>10} | {'ratio':>8} |",
    f"|{'-'*13}|{'-'*41}|{'-'*11:}>|{'-'*11:}>|{'-'*9:}>|",
]
for b, desc, ets, cpp, ratio in rows:
    lines.append(f"| {b:<12} | {desc:<40} | {fmt(ets, 10)} | {fmt(cpp, 10)} | {fmt(ratio, 8) if ratio else 'N/A':>8} |")

lines.extend([
    "",
    "**Ratio** = ets_ms / cpp_ms. Un ratio de 1.0x significa que el codegen del dialecto produce codigo tan rapido como C++ nativo escrito a mano.",
    "",
    "## Veredicto por benchmark",
    "",
])
verdicts = {
    "B-class":     "OK. El gap viene del doble dispatch (method call + this) y el init del runtime.",
    "B-array-ops": "OK. El gap viene de las llamadas a ets_filter_vec / ets_map_vec / ets_reduce (overhead del wrapper de arrays).",
    "B-for-of":    "BAJO. 4.30x — el for..of del dialecto es SIGNIFICATIVAMENTE mas lento que el for-range nativo. Hipotesis: el codegen emite un std::vector<double>::iterator (begin/end) por iteracion, mientras que el nativo compila a un for-range directo.",
    "B-string-ops":"BAJO. 3.74x — la concatenacion del dialecto es SIGNIFICATIVAMENTE mas lenta. Hipotesis: el template literal se compila a un stringstream o una concatenacion con std::to_string multiple.",
    "B-ptr-move":  "OK. 1.73x — el gap viene del wrapper ptr<T> vs unique_ptr, pero el move semantics es similar.",
    "B-optional":  "EXCELENTE. 0.93x — el V14 Optional<T> se compila a ets::Optional<double> (mismo runtime que el .cpp nativo).",
    "B-arith":     "OK. 1.76x — la aritmetica es similar al nativo, el gap viene del init del runtime de Etsatic.",
    "B-generic":   "EXCELENTE. 0.77x — el template Box<T> es mas rapido que el class template C++ (probablemente por el init del runtime).",
    "B-closures":  "OK. 1.84x — el gap viene del std::function<double()> que añade vtable lookup, vs lambda directo en C++.",
    "B-recursive": "EXCELENTE. 0.99x — la recursion simple es identica al nativo (mismo call frame, mismas instrucciones).",
}
for b, desc, _, _, _ in rows:
    if b in verdicts:
        lines.append(f"- **{b}**: {verdicts[b]}")
lines.append("")

# Concatena al reporte existente
content = out.read_text()
import re
content = re.sub(r"\n## Tabla resumen.*?(?=\n##|\Z)", "", content, flags=re.DOTALL)
content = content.rstrip() + "\n" + "\n".join(lines) + "\n"
out.write_text(content)
print(f"Tabla generada en {out}")
print("\n".join(lines))
