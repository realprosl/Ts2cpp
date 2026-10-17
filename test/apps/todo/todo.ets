// V30.53: CLI `todo` — entry point.
// Demuestra: file I/O, JSON, multi-modulo, @comptime, @cppgen, @etsgen,
// regex-like search, table formatting, exit codes.

import { genTableHeader, genColumnHeader } from "./generators.ets";
import { cmdAdd, cmdList, cmdDone, cmdRemove, cmdClear, CommandResult } from "./commands.ets";
import { stringToPriority } from "./validators.ets";

// Imprime el usage y retorna.
function printUsage(): void {
  print("uso: todo <comando> [args]");
  print("");
  print("comandos:");
  print("  add <text> [prio]    anade tarea (prio: low|med|high, default med)");
  print("  list [filtro]        lista tareas (filtro: all|pending|done)");
  print("  done <id>            marca como completada");
  print("  remove <id>          elimina tarea");
  print("  clear                borra todas las tareas");
  print("  help                 muestra esta ayuda");
}

// Despacha un comando y retorna el exit code.
function dispatch(): number {
  let argc: number = argumentCount();
  if (argc < 2) {
    printUsage();
    return 1;
  }
  let cmd: string = argument(1);
  let result: CommandResult = new CommandResult(false, "comando desconocido: " + cmd);

  if (cmd == "help" || cmd == "--help" || cmd == "-h") {
    printUsage();
    return 0;
  }

  if (cmd == "add") {
    if (argc < 3) {
      print("error: add requiere <text>");
      return 1;
    }
    let text: string = argument(2);
    let prio: number = 1;  // default med
    if (argc >= 4) {
      prio = stringToPriority(argument(3));
    }
    result = cmdAdd(text, prio);
  } else if (cmd == "list") {
    let filter: string = "all";
    if (argc >= 3) {
      filter = argument(2);
    }
    genTableHeader();   // @cppgen: header de la tabla
    genColumnHeader();  // @etsgen: columnas + separador
    result = cmdList(filter);
  } else if (cmd == "done") {
    if (argc < 3) {
      print("error: done requiere <id>");
      return 1;
    }
    let id: number = singleDigitToNumber(argument(2));
    result = cmdDone(id);
  } else if (cmd == "remove") {
    if (argc < 3) {
      print("error: remove requiere <id>");
      return 1;
    }
    let id: number = singleDigitToNumber(argument(2));
    result = cmdRemove(id);
  } else if (cmd == "clear") {
    result = cmdClear();
  }

  if (result.ok) {
    print(result.message);
    return 0;
  } else {
    print(result.message);
    return 1;
  }
}

// Convierte un string de un solo digito a number. -1 si invalido.
function singleDigitToNumber(s: string): number {
  if (s == "0") { return 0; }
  if (s == "1") { return 1; }
  if (s == "2") { return 2; }
  if (s == "3") { return 3; }
  if (s == "4") { return 4; }
  if (s == "5") { return 5; }
  if (s == "6") { return 6; }
  if (s == "7") { return 7; }
  if (s == "8") { return 8; }
  if (s == "9") { return 9; }
  return -1;
}

// argv viene como parametro. argc y argv son globales del runtime.
let exitCode: number = dispatch();
print("EXIT=" + numberToString(exitCode));
