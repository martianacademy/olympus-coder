/**
 * Height of the phone page when it runs as an iOS home-screen app (standalone, translucent status bar).
 *
 * iOS reports the visible height (`visualViewport.height`, `innerHeight`) short by the status bar there, so the app
 * stopped ~60pt above the bottom. That shortfall is constant, so it is measured once per orientation from the
 * tallest height seen (keyboard closed) and added back. The keyboard is NOT added back: when it opens, the visible
 * height drops and the app shrinks to sit right above it, instead of staying full-screen and letting iOS scroll the
 * whole page up (which hid the header and left a band between the composer and the keyboard).
 */
export interface FitInput {
  /** Visible height now (visualViewport.height, else innerHeight). */
  visible: number;
  innerWidth: number;
  /** screen.width / screen.height: iOS keeps them in portrait terms whatever the rotation. */
  screenWidth: number;
  screenHeight: number;
}

export interface FitState {
  orientation: 'portrait' | 'landscape' | '';
  /** Tallest visible height seen in this orientation (keyboard closed). */
  base: number;
  /**
   * Stable status-bar shortfall measured while keyboard is closed (`screenH - visible`).
   * Kept separately so a transient 1-frame `visible === screenH` spike during iOS keyboard dismissal
   * never zeroes out the shortfall and leaves a 59pt bottom gap after tapping Send.
   */
  shortfall?: number;
}

export interface Fit {
  height: number;
  keyboard: boolean;
  state: FitState;
}

/** A height drop bigger than this is the on-screen keyboard (not a bar or rounding). */
const KEYBOARD_MIN = 120;

export function fitHeight(input: FitInput, prev: FitState): Fit {
  const short = Math.min(input.screenWidth, input.screenHeight);
  const long = Math.max(input.screenWidth, input.screenHeight);
  // Width does not change with the keyboard, height does: decide the orientation from the width.
  const orientation = input.innerWidth > short + 1 ? 'landscape' : 'portrait';
  const sameOrient = orientation === prev.orientation;
  const base = Math.max(sameOrient ? prev.base : 0, input.visible);
  const screenW = orientation === 'landscape' ? long : short;
  const screenH = orientation === 'landscape' ? short : long;
  // Only a window as wide as the screen fills it (not an iPad split / Slide Over window).
  const fillsScreen = Math.abs(input.innerWidth - screenW) <= 1;
  if (!fillsScreen) {
    return {
      height: Math.round(input.visible),
      keyboard: base - input.visible > KEYBOARD_MIN,
      state: { orientation, base, shortfall: 0 },
    };
  }
  const keyboard = screenH - input.visible > KEYBOARD_MIN;
  const prevShortfall = sameOrient ? (prev.shortfall ?? 0) : 0;
  const shortfall = !keyboard && input.visible < screenH ? Math.max(prevShortfall, screenH - input.visible) : prevShortfall;
  return {
    height: Math.round(keyboard ? input.visible + shortfall : screenH),
    keyboard,
    state: { orientation, base, shortfall },
  };
}
