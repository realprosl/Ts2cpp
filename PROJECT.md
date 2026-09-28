# Estatic — Proyecto Ts2cpp

Documento de referencia para retomar el trabajo en cualquier sesión. Léelo completo antes de empezar tras un reset de contexto.

## 1. Qué construimos

**Ts2cpp** es un transpilador TypeScript→C++20 ubicado en `/root/Ts2cpp`. El dialecto que extiende se llama **Estatic**: TypeScript-like en superficie, C++20 nativo en salida, con el lema *"escribir como TS, conocerlo todo en compilación, pagar en ejecución como C++"*.

### Reglas del dialecto Estatic (NO ROMPER)

- **Sin excepciones**, **sin herencia**, **sin `Object`/`any`/`unknown`**.
- **Sin conversiones implícitas** fuera de `Path → string`.
- **Primitivos siempre por valor**: `Unq<number>`, `Rc<string>` no compilan.
- **Smart pointers** (envoltorios C++):
  - `Unq<T>` → `ets::Unq<T>` envuelve `std::unique_ptr<T>`
  - `Rc<T>` → `ets::Rc<T>` envuelve `std::shared_ptr<T>`
- **Modificadores de acceso** (NO envoltorios):
  - `MutRef<T>` → `T&` directo
  - `Mut<T>` → `T*` directo
- **Tagged unions** nativas: `union Outcome<T, E> = Ok(T) | Err(E);` se emite como `std::variant` + discriminador.
- Mantener firma de `compile(source)` y AST de `src/ast/nodes.ts`.

### Restricciones operativas

- **Cero deps npm**: corre con `node --experimental-strip-types`. Tests con `node:test` nativo + `assert/strict`.
- OpenCode NO escribir en `/tmp/*` (sandbox bloquea). Usar `build/.estatic/scratch/` o `examples/_scratch/` o `/root/Ts2cpp/.scratch/`. Backups en `/root/.hermes/cache/scratch/`.
- `git` config: `user.name "Alberto Prado Gil"`, `user.email "alberto@pradogil.dev"`.
- **Main branch protegida**: trabajo siempre en `feature/*`, `agent/*` o `refactor/*` → PR.
- **Telegram**: notificar solo hitos (PRs mergeables, suite verde, bloqueador).
- **NO filtrar tokens**: nunca pegar API keys/tokens en mensajes o logs.

## 2. Cómo trabajamos

### Roles
- **Alberto (humano)**: dicta prioridad, revisa PRs, mergea.
- **Hermes (yo)**: orquesto, depuro localmente, escribo código pequeño.
- **OpenCode (worker)**: delego faenas grandes con contexto explícito. Configurado con MiniMax como provider Anthropic-compatible en `~/.config/opencode/opencode.json` (baseURL `https://api.minimax.io/anthropic/v1`, API key desde `/root/.hermes/.env` como `ANTHROPIC_API_KEY`).

### Flujo por faena
1. **Rama de feature** desde `origin/main` (no clones ni worktrees sucios):
   ```bash
   cd /root/Ts2cpp
   git fetch origin main
   git checkout main && git reset --hard origin/main
   git checkout -b refactor/<nombre-corto>
   ```
2. **Trabajo**: tests + compilación manual con `node --experimental-strip-types src/cli.ts ...` y `g++ -std=c++20 ...`.
3. **Suite verde**: `npm test` debe pasar (típicamente 2-3 min).
4. **Commit + push + PR**:
   ```bash
   git commit -m "refactor(<bloque>): <descripción> (Issue #N)"
   git push -u origin refactor/<nombre-corto>
   gh pr create --base main --head refactor/<nombre-corto> --title "..." --body "..."
   ```
5. **Notificación Telegram** (hitos solamente):
   ```bash
   curl -s -X POST "https://api.telegram.org/bot$(grep '^TELEGRAM_BOT_TOKEN=' /root/.hermes/.env | cut -d= -f2)/sendMessage" -d "chat_id=6940722717" -d "text=..."
   ```
   Token nunca debe aparecer en logs visibles (Alberto explícito).

### Comandos de verificación rápida

```bash
# Compilar un .ets
cd /root/Ts2cpp
node --experimental-strip-types src/cli.ts examples/un-demo.ets -o /tmp/un.cpp --unity
g++ -std=c++20 -O2 -pthread -fno-exceptions -I/root/Ts2cpp -o /tmp/un /tmp/un.cpp
/tmp/un

# Suite completa
npm test                          # 168+ tests, ~2 min
E2E_BUCKET=filesystem npm run test:e2e
E2E_BUCKET=networking npm run test:e2e
```

### Skill de trabajo paralelo
Para faenas con múltiples issues independientes, cargar `skill_view(name='parallel-development-skill')` antes de empezar. Flujo típico:
- Bloque C (limpieza) → V0 (refactors cimiento) → V1-V10 (features).

## 3. Roadmap actual

| Faena | Estado | PR |
|---|---|---|
| **Bloque C**: cleanup filesystem + networking | ✅ mergeado | #45, #46 |
| **V0.1** ResolvedType AST (intersección en Expression union) | ✅ mergeado | #47 |
| **V0.2** cppType polimórfico `TypeName \| ResolvedType` | ✅ mergeado | #48 |
| **V0.3** resolvedSignature en funciones/métodos | ✅ mergeado | #49 |
| **V0.4** ResolvedRuntimeType en declaraciones top-level | ✅ ABIERTO | #50 |
| **V1.1** tagged unions en AST (parser + AST + codegen básico) | ✅ mergeado | #51 |
| **V1.2** constructores `Union<T>.Variant(args)` + match destructuring básico | ✅ ABIERTO | #52 |
| V1.3 | `print(union)` + dispatch contextual por discriminador (comparaciones) | pendiente |
| V2 | tagged unions con exhaustividad en `match` | pendiente |
| V3-V10 | según `docs/roadmap.md` | pendiente |

### Detalles del Roadmap

- **`docs/roadmap.md`**: lista completa V0-V10 con dependencias.
- **`docs/v0-detailed-plan.md`**: V0.1-V0.4 con criterios de aceptación.
- **`docs/vision.md`**: filosofía del dialecto Estatic v2.
- **`docs/demos.html`**: 50 demos de uso.
- **`LIMITATIONS.md`**: 149 líneas de qué NO funciona aún.

## 4. Estado técnico del repo (a fecha del último reset)

### Estructura
```
/root/Ts2cpp/
├── src/
│   ├── ast/nodes.ts                   # AST (Expression union, etc.)
│   ├── parser/parser.ts               # Parser con GenericIdentifierExpression (V1.2)
│   ├── lexer/{token.ts,lexer.ts}      # Lexer, keywords
│   ├── semantic/
│   │   ├── type-checker.ts            # Checker principal
│   │   └── helpers.ts                 # HELPER_METADATA (file/net helpers)
│   ├── types/type-system.ts           # ResolvedType, ResolvedSignature, ResolvedRuntimeType
│   ├── codegen/
│   │   ├── cpp-generator.ts           # Generador C++ principal
│   │   ├── cpp-types.ts               # cppType, collectTypeParameterNames
│   │   └── cpp-parameters.ts          # cppParameterDeclaration
│   ├── compiler.ts                    # compile() entrypoint
│   └── cli.ts                         # CLI con --unity
├── runtime/
│   ├── ets_runtime.hpp                # Globals (print, etc.)
│   ├── ets_unq.hpp, ets_rc.hpp        # Smart pointers
│   ├── ets_optional.hpp               # ets::Optional<T>
│   ├── ets_async.hpp                  # Task<T>, Result<T> (1 param — bloquea Result<T,E>)
│   ├── ets_file.hpp                   # File helpers (etsFs*)
│   ├── ets_net_sync.hpp               # Networking síncrono (V1.2)
│   └── ets_process.hpp                # process spawn
├── test/
│   ├── unit/
│   │   ├── type-checker.test.ts       # +3 V0.1, +4 V0.3, +4 V0.4
│   │   ├── cpp-types.test.ts          # +14 V0.2
│   │   └── codegen.test.ts            # base
│   ├── e2e/_shared/runner.ts          # Runner paralelo
│   └── runner.ts                      # Worker pool, REPO_ROOT 3 niveles
├── examples/                          # Demos con golden files en test/golden/
├── docs/                              # vision, roadmap, v0-detailed-plan, demos.html
├── PROJECT.md                         # ESTE ARCHIVO
├── README.md
├── LIMITATIONS.md
├── status.md                          # Plan completo
└── package.json                       # version "0.26.0", scripts test:e2e
```

### Smart pointers — mapeo confirmado (NO cambiar)
| Dialecto | C++ |
|---|---|
| `Unq<T>` | `ets::Unq<T>` (envuelve `std::unique_ptr`) |
| `Rc<T>` | `ets::Rc<T>` (envuelve `std::shared_ptr`) |
| `MutRef<T>` | `T&` directo |
| `Mut<T>` | `T*` directo |

Const-correctness automático (Alberto 2026-09-27):
- Parámetro `T` (clase) → `const T&` o `const T*`
- Parámetro `MutRef<T>` → `T&`
- Parámetro `Mut<T>` → `T*`
- Parámetro `Rc<T>` → `const Rc<T>&`
- Parámetro `Unq<T>` → `const Unq<T>&`

### Tagged unions — mapeo confirmado
```ts
union Outcome<T, E> = Ok(T) | Err(E);
```
→
```cpp
template <typename T, typename E>
struct Outcome {
    Outcome_Kind kind;
    std::variant<T, E> payload;
};
// Constructores globales: Ok<T,E>(value), Err<T,E>(value)
// Acceso variantes: Outcome_Kind::Ok, Outcome_Kind::Err
```

**Gotcha crítico (V1.2 causa raíz)**: GCC rechaza `template <...> struct Name<T,E>` con doble template. El prefijo ya cubre; el nombre NO lleva `<T,E>`.

## 5. Sesión tras reset de contexto — checklist

Cuando retomes (yo o el modelo):

1. **Lee este PROJECT.md completo**. Confirma que el roadmap y las reglas siguen vigentes.
2. **Verifica el estado del repo**:
   ```bash
   cd /root/Ts2cpp
   git log --oneline -10
   git status
   gh pr list --state open
   ```
   Identifica: ¿se mergeó algo nuevo? ¿hay PRs pendientes? ¿la rama actual es la correcta?
3. **Confirma suite verde** antes de empezar:
   ```bash
   npm test                          # Debe pasar ~168+ tests
   ```
   Si falla, no asumas causa: ejecuta, lee el error, depura.
4. **Comprueba OpenCode auth** (si vas a delegar):
   ```bash
   opencode --version
   export ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' /root/.hermes/.env | cut -d= -f2)
   timeout 30 opencode run "Respond with exactly: OK"
   ```
   Si falla, verifica `~/.config/opencode/opencode.json` y que el baseURL sea `https://api.minimax.io/anthropic/v1`.
5. **Comprueba Telegram** (si vas a notificar):
   ```bash
   curl -s -X POST "https://api.telegram.org/bot$(grep '^TELEGRAM_BOT_TOKEN=' /root/.hermes/.env | cut -d= -f2)/sendMessage" -d "chat_id=6940722717" -d "text=ping"
   ```
6. **Pide a Alberto qué faena sigue** (o propón según el roadmap). No asumas.
7. **Trabaja en rama nueva** desde `origin/main`, no en ramas viejas.

## 6. Decisiones y pitfalls frecuentes

| Caso | Decisión |
|---|---|
| OpenCode y MiniMax | Provider `anthropic`, baseURL `https://api.minimax.io/anthropic/v1`, env `ANTHROPIC_API_KEY`. NO usar `api.minimaxi.com` (devuelve 401). |
| Tokens en logs | Alberto explícito "no quiero que aparezca el token". Filtrar con env vars, nunca `echo`. |
| Overloads C++ colisionando | Usar prefijo `etsFs*`, `etsNetSync*` para wrappers; no se permite overload solo por tipo de retorno. |
| `::write` colisión | `runtime/ets_runtime.hpp:148` define `inline void write(...)` global que oculta `::write` POSIX. Solución: `ets::net_sync::posix::rawRead/rawWrite`. |
| Golden files con paths absolutos | `test/runner.ts` y `test/e2e/_shared/runner.ts` tienen `/root/Ts2cpp` hardcoded. NO clonar el repo. |
| REPO_ROOT en E2E | 3 niveles arriba desde `test/e2e/_shared/`. |
| Result<T,E> | BLOQUEADO por colisión con `ets::Result<T>` (1 param). Workaround: usar `union Outcome<T,E> = Ok(T) | Err(E)` en su lugar. |
| Sanitizers ASan/UBSan | No investigados (Issue #16). Diferido. |
| Worker pool E2E | `TEST_CONCURRENCY=N` env var (default 4). Workers en `test/scratch/wN/`. |
| Flakes conocidos | `exports-demo`, `overloads-variadics`, `destructuring-default`: race en stdout del runner, pre-existentes, no son regresión. |
| OpenCode workers fiables | NO para cambios cross-cutting en runtime+codegen+type-checker. Sí para fixes localizados (como el bug GCC de V1.2). |

## 7. Skills cargadas en esta sesión

- `productivity/google-workspace` — auto-cargada. Útil para Gmail/Calendar/Drive.
- `hermes-telegram-setup` — creada durante la sesión, procedimiento verificado.
- `parallel-development-skill` — flujo main → integration → agent/*.
- `autonomous-ai-agents/opencode` — para delegar al worker.

## 8. Contacto

- **Alberto**: chat_id `6940722717` (Telegram), español (es-ES), prefiere confirmación entre fases, paso a paso.
- **Bot**: `@Ian_prado_bot` id `8812626539` (Telegram).
- **Repo**: https://github.com/realprosl/Ts2cpp

## 9. Si te pierdes

1. **Lee PROJECT.md** (este archivo).
2. **Lee `docs/vision.md`** para entender el "por qué".
3. **Lee `docs/roadmap.md`** para saber "qué falta".
4. **Mira `gh pr list --state open`** para saber "qué hay pendiente".
5. **Pregunta a Alberto** — prefiere interacción explícita antes que autonomous runs largos.
