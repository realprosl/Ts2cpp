// V30.53: Formateo de output (tabla).
// Demuestra funciones regulares con @comptime inline.

import { Task } from "./storage.ets";
import { priorityToString } from "./validators.ets";

export function pad(s: string, width: number): string {
  let result: string = s;
  while (length(result) < width) {
    result = result + " ";
  }
  return result;
}

export function formatTask(t: Task): string {
  let idStr: string = numberToString(t.id);
  let prioStr: string = priorityToString(t.priority);
  let statusStr: string = t.done ? "[x]" : "[ ]";
  return pad(idStr, 4) + pad(prioStr, 6) + pad(statusStr, 8) + t.text;
}

export function formatHeader(): string {
  return pad("ID", 4) + pad("PRIO", 6) + pad("STATUS", 8) + "TEXT";
}

export function formatSeparator(): string {
  return pad("--", 4) + pad("----", 6) + pad("------", 8) + "----";
}
