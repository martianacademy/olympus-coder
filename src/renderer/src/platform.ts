/** Platform-aware keyboard labels: ⌘ on macOS, Ctrl on Windows and Linux. */
export const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Turns a Mac shortcut label like "⌘S" or "⌘Enter" into "Ctrl+S" / "Ctrl+Enter" off macOS. */
export function keys(label: string): string {
  if (isMac) return label;
  return label.replace(/⌘\s?/g, 'Ctrl+').replace(/⌥\s?/g, 'Alt+').replace(/⇧\s?/g, 'Shift+');
}

/**
 * Only a touch screen (phone, tablet without trackpad/mouse): its keyboard has no Shift+Enter, so there Enter adds
 * a new line and only the Send button sends. With any fine pointer (a computer, an iPad with a trackpad) Enter sends.
 */
export function touchOnly(): boolean {
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
}

/** Whether this Enter keydown should send the message: Enter without Shift or an open IME, on a computer keyboard. */
export function enterSends(e: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean } }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touchOnly();
}
