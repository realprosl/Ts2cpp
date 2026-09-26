import type { EstaticConfig } from "./src/config/project-config.ts";

export default {
  entry: "examples/modules/main.ets",
  moduleRoots: ["examples/modules"],
  aliases: { "@modules": "examples/modules" },
  output: { cpp: "build/configured-app.cpp", binary: "build/configured-app" },
  compiler: {
    enabled: true,
    command: "g++", // Puede cambiarse por clang++ u otro compilador compatible con C++20.
    flags: ["-std=c++20", "-O3", "-march=native", "-flto", "-pthread", "-fno-exceptions", "-ffunction-sections", "-fdata-sections"],
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
} satisfies EstaticConfig;
