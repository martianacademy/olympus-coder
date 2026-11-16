/** Platform-aware keyboard labels: ⌘ on macOS, Ctrl on Windows and Linux. */
export const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Turns a Mac shortcut label like "⌘S" or "⌘Enter" into "Ctrl+S" / "Ctrl+Enter" off macOS. */
export function keys(label: string): string {
  if (isMac) return label;
  return label.replace(/⌘\s?/g, 'Ctrl+').replace(/⌥\s?/g, 'Alt+').replace(/⇧\s?/g, 'Shift+');
}
