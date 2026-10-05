// Failure containment for the interactive TUI. Ink invokes keyboard handlers from a
// stdin event, so a synchronous throw there (lock timeout, fail-closed store mutation,
// I/O error) would escape as an uncaught exception and kill the terminal session.

/** Wrap a keyboard handler so a failed action is reported instead of crashing the TUI. */
export function guardInputHandler<A extends unknown[]>(
  handler: (...args: A) => void,
  onError: (error: unknown) => void,
): (...args: A) => void {
  return (...args: A) => {
    try {
      handler(...args);
    } catch (error) {
      onError(error);
    }
  };
}

/**
 * Reload a provider store after a failed operation. Recovery code often runs inside a
 * `catch` block, where a second throw would become an unhandled rejection; keep the
 * last in-memory snapshot instead so the screen stays usable and nothing is rewritten.
 */
export function reloadOrKeep<T>(load: () => T, current: T, onError: (error: unknown) => void): T {
  try {
    return load();
  } catch (error) {
    onError(error);
    return current;
  }
}
