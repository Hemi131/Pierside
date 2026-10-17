/**
 * Whether a key event comes from an interactive terminal (a container shell, the server shell): page
 * shortcuts such as Ctrl+F must leave those keys to the program running there (vim, less, …). Log views
 * are xterms too, but read-only; they are marked with `data-log-view`.
 */
export function inInteractiveTerminal(target: EventTarget | null): boolean {
  const xterm = (target as HTMLElement | null)?.closest?.(".xterm");
  return !!xterm && !xterm.closest("[data-log-view]");
}
