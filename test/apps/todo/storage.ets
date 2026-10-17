// V30.53: Storage in-memory (no persistente en V30.53).
// El dialecto soporta file I/O via Result<string> pero requiere
// tagged unions para destructurar. En V30.53 el bash script hace
// el load/save del JSON antes/despues de ejecutar el binario; aqui
// trabajamos con un array in-memory que se inicializa vacio.

export class Task {
  id: number;
  text: string;
  done: boolean;
  priority: number;

  constructor(id: number, text: string, done: boolean, priority: number) {
    this.id = id;
    this.text = text;
    this.done = done;
    this.priority = priority;
  }
}

let _tasks: Array<Task> = [];

export function getTasks(): Array<Task> {
  return _tasks;
}

export function setTasks(tasks: Array<Task>): void {
  _tasks = tasks;
}

export function addTask(t: Task): void {
  _tasks.push(t);
}

export function removeAt(idx: number): void {
  let newTasks: Array<Task> = [];
  let i: number = 0;
  let j: number = 0;
  let len: number = length(_tasks);
  while (i < len) {
    if (i != idx) {
      newTasks[j] = _tasks[i];
      j = j + 1;
    }
    i = i + 1;
  }
  _tasks = newTasks;
}

export function nextId(tasks: Array<Task>): number {
  let max: number = 0;
  let i: number = 0;
  let len: number = length(tasks);
  while (i < len) {
    let t: Task = tasks[i];
    if (t.id > max) {
      max = t.id;
    }
    i = i + 1;
  }
  return max + 1;
}

export function findById(tasks: Array<Task>, id: number): number {
  let i: number = 0;
  let len: number = length(tasks);
  while (i < len) {
    if (tasks[i].id == id) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}
