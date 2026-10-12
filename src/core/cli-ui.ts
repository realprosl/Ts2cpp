// V30.10: UI de consola para el CLI.
//
// Wrapper ligero sobre stderr/stdout con:
//   - Spinners animados (frames Unicode rotando) para fases largas.
//   - Colores ANSI por nivel (info/ok/warn/error) y por tipo de fase.
//   - Auto-detect TTY: si stderr no es TTY, vuelve a texto plano sin
//     `\r` (para que no se rompa en pipes, archivos, CI).
//   - Respeta NO_COLOR=1 y FORCE_COLOR=1.
//
// 0 dependencias externas. Puro Node + `\x1b[...` ANSI escapes.
// El TTY se detecta con `process.stderr.isTTY` por defecto.

// ──────────────────────────────────────────────────────────────────────
// ANSI helpers
// ──────────────────────────────────────────────────────────────────────

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
// Foreground colors
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const BLUE = `${ESC}[34m`;
const MAGENTA = `${ESC}[35m`;
const CYAN = `${ESC}[36m`;
const GRAY = `${ESC}[90m`;

/**
 * Decide si debemos emitir códigos ANSI. Reglas:
 *   1. Si `FORCE_COLOR=1` (o cualquier valor != "0"), siempre emite.
 *   2. Si `NO_COLOR=1` (o presente sin valor), nunca emite.
 *   3. Si stderr es TTY, emite.
 *   4. Si no es TTY (pipe, archivo, CI), no emite.
 */
function useColors(stream: NodeJS.WriteStream = process.stderr): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "" && noColor !== "0") return false;
  return Boolean(stream.isTTY);
}

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${RESET}` : text;
}

// ──────────────────────────────────────────────────────────────────────
// Spinner
// ──────────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerOptions {
  /** Texto que se muestra a la derecha del spinner. */
  message: string;
  /** Si true, no hace animacion (texto plano). */
  silent?: boolean;
  /** Stream sobre el que pintar (por defecto stderr). */
  stream?: NodeJS.WriteStream;
}

export interface SpinnerHandle {
  /** Cambia el texto del spinner sin reiniciar la animacion. */
  update: (message: string) => void;
  /** Detiene el spinner con un resultado final (ok/error). */
  stop: (status: "ok" | "error" | "info", finalMessage?: string) => void;
}

/**
 * Inicia un spinner animado. Si stderr no es TTY o `silent=true`,
 * devuelve un handle que solo escribe el mensaje una vez.
 *
 * El spinner solo se anima si stderr es TTY. En cualquier otro caso
 * (CI, pipes, redireccion a archivo) escribimos el mensaje y listo.
 */
export function spinner(options: SpinnerOptions): SpinnerHandle {
  const stream = options.stream ?? process.stderr;
  const colors = useColors(stream);
  let message = options.message;
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;

  // Escribe la primera linea: `\r<spinner> message` (en TTY) o
  // `<spinner> message\n` (no-TTY).
  const writeLine = (text: string): void => {
    stream.write(text);
  };

  if (options.silent || !stream.isTTY) {
    // Modo silencioso: una sola linea, sin animacion.
    writeLine(`${paint("●", GRAY, colors)} ${message}\n`);
  } else {
    // Modo animado: pintar frame inicial y arrancar el intervalo.
    const draw = (): void => {
      const frameChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      writeLine(`\r${paint(frameChar, CYAN, colors)} ${message}`);
      frame++;
    };
    draw();
    timer = setInterval(draw, 80);
  }

  return {
    update(next: string): void {
      message = next;
      if (options.silent || !stream.isTTY) {
        // En modo silencioso, replace no aplica (solo escribimos una vez).
        return;
      }
      const frameChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      writeLine(`\r${paint(frameChar, CYAN, colors)} ${message}`);
      frame++;
    },
    stop(status, finalMessage): void {
      if (timer) clearInterval(timer);
      const final = finalMessage ?? message;
      const marker =
        status === "ok" ? paint("✓", GREEN, colors) :
        status === "error" ? paint("✗", RED, colors) :
        paint("●", BLUE, colors);
      if (options.silent || !stream.isTTY) {
        // En modo silencioso, ya escribimos la primera linea. Reescribimos
        // con el marcador final.
        // En modo TTY, sobreescribimos la linea con `\r`.
        writeLine(`\r${marker} ${final}\n`);
      } else {
        writeLine(`\r${marker} ${final}\n`);
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Fases de build
// ──────────────────────────────────────────────────────────────────────

export interface PhaseHandle {
  /** Inicia la fase con un spinner. */
  start: (subMessage?: string) => void;
  /** Termina la fase con un resultado. */
  finish: (status: "ok" | "error" | "info", finalMessage?: string) => void;
}

/**
 * Crea un "phase" logueable: una unidad logica de trabajo que tiene
 * un inicio y un final. Equivalente a `BuildProgress.beginPhase()` +
 * spinner, pero con mejor UX (color, spinner, duracion automatica).
 *
 * Uso:
 *   const phase = phase("Compilando modulo X");
 *   phase.start();
 *   // ... trabajo ...
 *   phase.finish("ok", `Compilado modulo X (45ms)`);
 */
export function phase(label: string, options: { silent?: boolean } = {}): PhaseHandle {
  let handle: SpinnerHandle | undefined;
  return {
    start(subMessage?: string): void {
      handle = spinner({ message: subMessage ? `${label} (${subMessage})` : label, silent: options.silent });
    },
    finish(status, finalMessage): void {
      handle?.stop(status, finalMessage);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Progreso multi-item
// ──────────────────────────────────────────────────────────────────────

export interface ProgressBar {
  /** Actualiza el progreso a `current` de `total`. */
  update: (current: number, total: number, message?: string) => void;
  /** Termina la barra con un resultado final. */
  finish: (status: "ok" | "error" | "info", finalMessage?: string) => void;
}

const BAR_WIDTH = 20;
const BAR_FULL = "█";
const BAR_EMPTY = "░";

/**
 * Barra de progreso `[██████░░░░] 3/10 Compilando modulo X`.
 * Si no es TTY, escribe solo `[3/10] Compilando modulo X` una vez
 * por update significativo (cuando cambia el item).
 */
export function progressBar(label: string, options: { silent?: boolean; stream?: NodeJS.WriteStream } = {}): ProgressBar {
  const stream = options.stream ?? process.stderr;
  const colors = useColors(stream);
  let lastPercent = -1;
  let lastItem = "";
  let timer: NodeJS.Timeout | undefined;
  let current = 0;
  let total = 0;
  let message = label;

  const render = (): void => {
    const percent = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0;
    const filled = Math.floor((percent / 100) * BAR_WIDTH);
    const bar = BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
    const counter = `[${String(current).padStart(String(total).length)}/${total}]`;
    const text = `${paint(bar, CYAN, colors)} ${paint(counter, BOLD, colors)} ${message}`;
    if (stream.isTTY) {
      stream.write(`\r${text}`);
    } else if (percent !== lastPercent || message !== lastItem) {
      // No-TTY: solo escribe cuando cambia algo significativo.
      stream.write(`${text}\n`);
      lastPercent = percent;
      lastItem = message;
    }
  };

  if (!options.silent && stream.isTTY) {
    timer = setInterval(render, 100);
  }

  return {
    update(next, nextTotal, nextMessage): void {
      current = next;
      total = nextTotal;
      if (nextMessage) message = `${label}: ${nextMessage}`;
      render();
    },
    finish(status, finalMessage): void {
      if (timer) clearInterval(timer);
      const final = finalMessage ?? `${label}: ${current}/${total}`;
      const marker =
        status === "ok" ? paint("✓", GREEN, colors) :
        status === "error" ? paint("✗", RED, colors) :
        paint("●", BLUE, colors);
      if (stream.isTTY) {
        stream.write(`\r${marker} ${final}\n`);
      } else {
        stream.write(`${marker} ${final}\n`);
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers de output
// ──────────────────────────────────────────────────────────────────────

/** Imprime un mensaje informativo en azul. */
export function info(message: string, stream: NodeJS.WriteStream = process.stderr): void {
  const c = useColors(stream);
  stream.write(`${paint("ℹ", BLUE, c)} ${message}\n`);
}

/** Imprime un mensaje de exito en verde. */
export function ok(message: string, stream: NodeJS.WriteStream = process.stderr): void {
  const c = useColors(stream);
  stream.write(`${paint("✓", GREEN, c)} ${message}\n`);
}

/** Imprime una advertencia en amarillo. */
export function warn(message: string, stream: NodeJS.WriteStream = process.stderr): void {
  const c = useColors(stream);
  stream.write(`${paint("⚠", YELLOW, c)} ${paint(message, YELLOW, c)}\n`);
}

/** Imprime un error en rojo. */
export function error(message: string, stream: NodeJS.WriteStream = process.stderr): void {
  const c = useColors(stream);
  stream.write(`${paint("✗", RED, c)} ${paint(message, RED, c)}\n`);
}

/** Imprime texto dimmed (gris). Util para subdetalles. */
export function dim(message: string, stream: NodeJS.WriteStream = process.stderr): void {
  const c = useColors(stream);
  stream.write(`${paint(message, GRAY, c)}\n`);
}

/**
 * Banner de inicio. Dibuja una cabecera con el nombre del programa
 * y un subtitulo. Solo se imprime si stderr es TTY O si se fuerza color.
 */
export function banner(title: string, subtitle?: string, stream: NodeJS.WriteStream = process.stderr): void {
  const c = useColors(stream);
  if (!c) return;
  stream.write(`${paint(BOLD + title, MAGENTA, c)}${subtitle ? " " + paint(subtitle, GRAY, c) : ""}\n`);
}

/** Re-exporta los colores por si algun modulo los quiere usar directamente. */
export const COLORS = { RESET, BOLD, DIM, RED, GREEN, YELLOW, BLUE, MAGENTA, CYAN, GRAY };

/** Decide si el stream dado debe pintar con colores. Re-exportado para
 *  modulos que quieran detectar TTY sin reimplementar la logica. */
export { useColors };
