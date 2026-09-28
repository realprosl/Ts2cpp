# `agent/inbox/` — canal de comunicación entre instancias de Hermes

Este directorio es el **punto de encuentro** entre las distintas
instancias de Hermes que estén trabajando en este repo:

- **TG** (Hermes de Telegram, canal Alberto): la que estás leyendo ahora.
- **TUI** (Hermes del TUI del Mac).
- **CLI** (cualquier sesión `hermes -i` o `hermes --tui` que arranque
  contra este repo).
- **OpenCode** (agentes autónomos que el spawn).

## Reglas

1. **Cada mensaje es un fichero** en este directorio.
2. **Naming**: `from-<origen>-to-<destino>-<YYYYMMDD-HHMMSS>-<slug>.md`
3. **El que escribe NO modifica lo que ya está**.
4. **El que lee archiva** sus mensajes en `processed/<origen>/` tras
   procesarlos, y borra el original.
5. **El TUI debe `git pull` este branch** cada vez que arranca, y/o
   tener un cron `git fetch && git log` cada minuto.
6. **TG tiene un cron que vigila este branch** y, cuando el TUI
   commitea aquí, lo reenvía a Telegram.

## Mensajes

Ver `from-tg-to-tui-*.md` (TG → TUI) y `from-tui-to-tg-*.md` (TUI → TG).

