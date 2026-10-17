// V30.53: Comandos del CLI (add, list, done, remove, clear, search).
// Demuestra funciones regulares con side-effects (storage) + @comptime.

import { Task, getTasks, setTasks, addTask, removeAt, nextId, findById } from "./storage.ets";
import { isValidText, isValidId, isValidPriority, stringToPriority } from "./validators.ets";
import { formatTask, formatHeader, formatSeparator } from "./formatter.ets";

// Resultado de un comando.
export class CommandResult {
  ok: boolean;
  message: string;

  constructor(ok: boolean, message: string) {
    this.ok = ok;
    this.message = message;
  }
}

// add <text> [priority]
export function cmdAdd(text: string, priority: number): CommandResult {
  if (!isValidText(text)) {
    return new CommandResult(false, "error: texto invalido");
  }
  if (!isValidPriority(priority)) {
    return new CommandResult(false, "error: prioridad invalida");
  }
  let tasks: Array<Task> = getTasks();
  let id: number = nextId(tasks);
  let t: Task = new Task(id, text, false, priority);
  addTask(t);
  return new CommandResult(true, "added: " + numberToString(id));
}

// list [filter]: "all" (default), "pending", "done"
export function cmdList(filter: string): CommandResult {
  let tasks: Array<Task> = getTasks();
  print(formatHeader());
  print(formatSeparator());
  let i: number = 0;
  let len: number = length(tasks);
  let shown: number = 0;
  while (i < len) {
    let t: Task = tasks[i];
    let include: boolean = false;
    if (filter == "all") {
      include = true;
    } else if (filter == "pending") {
      include = !t.done;
    } else if (filter == "done") {
      include = t.done;
    }
    if (include) {
      print(formatTask(t));
      shown = shown + 1;
    }
    i = i + 1;
  }
  return new CommandResult(true, "shown: " + numberToString(shown));
}

// done <id>
export function cmdDone(id: number): CommandResult {
  if (!isValidId(id)) {
    return new CommandResult(false, "error: id invalido");
  }
  let tasks: Array<Task> = getTasks();
  let idx: number = findById(tasks, id);
  if (idx < 0) {
    return new CommandResult(false, "error: id no encontrado");
  }
  tasks[idx].done = true;
  return new CommandResult(true, "done: " + numberToString(id));
}

// remove <id>
export function cmdRemove(id: number): CommandResult {
  if (!isValidId(id)) {
    return new CommandResult(false, "error: id invalido");
  }
  let tasks: Array<Task> = getTasks();
  let idx: number = findById(tasks, id);
  if (idx < 0) {
    return new CommandResult(false, "error: id no encontrado");
  }
  removeAt(idx);
  return new CommandResult(true, "removed: " + numberToString(id));
}

// clear: borra todas las tareas
export function cmdClear(): CommandResult {
  setTasks([]);
  return new CommandResult(true, "cleared");
}
