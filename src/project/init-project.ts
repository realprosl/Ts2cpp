import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface InitializedProject {
  directory: string;
  files: string[];
}

const templates: ReadonlyArray<readonly [string, string]> = [
  ["src/main.ts", `print("Hola desde Estatic");
`],
  ["estatic.config.ts", `export default {
  entry: "src/main.ts",
  moduleRoots: ["src"],
  aliases: {},
  output: {
    cpp: "build/app.cpp",
    binary: "build/app"
  },
  compiler: {
    enabled: true,
    command: "g++",
    flags: ["-std=c++20", "-O2", "-pthread", "-fno-exceptions", "-ffunction-sections", "-fdata-sections"],
    linkFlags: ["-Wl,--gc-sections", "-Wl,--as-needed", "-s"]
  },
  incremental: {
    enabled: true,
    cacheDirectory: "build/.estatic/cache",
    generatedDirectory: "build/.estatic/generated"
  },
  logging: {
    enabled: true,
    file: "build/.estatic/transpiler-report.json",
    level: "debug"
  }
};
`],
  [".gitignore", `build/
`],
  ["README.md", `# Proyecto Estatic

Compila el proyecto desde este directorio:

\`\`\`bash
estatic --config estatic.config.ts
./build/app
\`\`\`

Durante el desarrollo, si ejecutas el CLI desde el repositorio del compilador:

\`\`\`bash
npm start -- --config /ruta/al/proyecto/estatic.config.ts
\`\`\`
`]
];

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

export async function initializeProject(target = "."): Promise<InitializedProject> {
  const directory = resolve(target);
  const files = templates.map(([relative]) => join(directory, relative));
  const conflicts = (await Promise.all(files.map(async file => ({ file, exists: await exists(file) })))).filter(item => item.exists);
  if (conflicts.length > 0) {
    throw new Error(`No se inicializó el proyecto para no sobrescribir: ${conflicts.map(item => item.file).join(", ")}`);
  }
  for (const [relative, contents] of templates) {
    const file = join(directory, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents, { encoding: "utf8", flag: "wx" });
  }
  return { directory, files };
}
