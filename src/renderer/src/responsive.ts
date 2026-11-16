import { useCallback, useEffect, useRef, useState } from 'react';

/** Viewport at or below which the left sidebar transitions from persistent column to slide-over navigation drawer. */
export const SIDEBAR_DRAWER_BP = 900;

/** Viewport at or below which the right coding workbench transitions from split column to full-screen sheet. */
export const WORKBENCH_SHEET_BP = 820;

/** True when running inside a phone/tablet/desktop browser connected over Relay or Local HTTP (`bridge.ts`). */
export function isRemoteBrowser(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__olympusRemote || (window as any).__OLYMPUS_REMOTE__);
}

export function readStoredNumber(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Tracks `window.innerWidth` coalesced to at most one state update per animation frame. */
export function useViewportWidth(): number {
  const [winW, setWinW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setWinW(window.innerWidth);
      });
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return winW;
}

const SIDEBAR_MIN = 200;

/** Drag-to-resize state for the desktop sidebar and right workbench column. */
export function usePanelResizers(winW: number, sbCollapsed: boolean) {
  const [sbWidth, setSbWidth] = useState(() => readStoredNumber('olympus.sbWidth', 268));
  const [wbWidth, setWbWidth] = useState(() => readStoredNumber('olympus.wbWidth', 560));

  const isDrawerSidebar = winW <= SIDEBAR_DRAWER_BP;
  const isSheetWorkbench = winW <= WORKBENCH_SHEET_BP;
  const sidebarW = isDrawerSidebar || sbCollapsed ? 0 : Math.round(Math.min(Math.max(SIDEBAR_MIN, sbWidth), winW * 0.5));
  const panelWidth = isSheetWorkbench ? winW : Math.max(340, Math.min(wbWidth, winW - sidebarW - 420));

  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = sidebarW;
      const clamp = (w: number) => Math.round(Math.min(Math.max(SIDEBAR_MIN, w), window.innerWidth * 0.5));
      const move = (ev: MouseEvent) => setSbWidth(clamp(start + (ev.clientX - startX)));
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        setSbWidth((w) => {
          try {
            localStorage.setItem('olympus.sbWidth', String(w));
          } catch {
            /* storage unavailable */
          }
          return w;
        });
      };
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [sidebarW],
  );

  const startWorkbenchResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = wbWidth;
      const move = (ev: MouseEvent) => setWbWidth(Math.min(Math.max(340, start - (ev.clientX - startX)), window.innerWidth - sidebarW - 420));
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        setWbWidth((w) => {
          try {
            localStorage.setItem('olympus.wbWidth', String(w));
          } catch {
            /* storage unavailable */
          }
          return w;
        });
      };
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [wbWidth, sidebarW],
  );

  return { isDrawerSidebar, isSheetWorkbench, sidebarW, panelWidth, startSidebarResize, startWorkbenchResize };
}

/**
 * Manages adaptive sidebar drawer and workbench sheet open/collapse transitions across
 * mobile, tablet, and desktop breakpoints.
 */
export function useResponsiveShell() {
  const winW = useViewportWidth();
  const [wbOpen, setWbOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth > WORKBENCH_SHEET_BP : true));
  const [sbCollapsed, setSbCollapsed] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= SIDEBAR_DRAWER_BP) return true;
    try {
      return localStorage.getItem('olympus.sbCollapsed') === '1';
    } catch {
      return false;
    }
  });

  const toggleSidebar = useCallback(() => {
    setSbCollapsed((c) => {
      const next = !c;
      if (typeof window === 'undefined' || window.innerWidth > SIDEBAR_DRAWER_BP) {
        try {
          localStorage.setItem('olympus.sbCollapsed', next ? '1' : '0');
        } catch {
          /* storage unavailable */
        }
      }
      return next;
    });
  }, []);

  const resizers = usePanelResizers(winW, sbCollapsed);

  const prevDrawerRef = useRef(resizers.isDrawerSidebar);
  useEffect(() => {
    if (resizers.isDrawerSidebar && !prevDrawerRef.current) setSbCollapsed(true);
    // Leaving drawer mode (phone → wider window): go back to the user's saved desktop choice instead of staying hidden.
    if (!resizers.isDrawerSidebar && prevDrawerRef.current) {
      let saved = false;
      try {
        saved = localStorage.getItem('olympus.sbCollapsed') === '1';
      } catch {
        /* storage unavailable */
      }
      setSbCollapsed(saved);
    }
    prevDrawerRef.current = resizers.isDrawerSidebar;
  }, [resizers.isDrawerSidebar]);

  const prevSheetRef = useRef(resizers.isSheetWorkbench);
  useEffect(() => {
    if (resizers.isSheetWorkbench && !prevSheetRef.current) setWbOpen(false);
    prevSheetRef.current = resizers.isSheetWorkbench;
  }, [resizers.isSheetWorkbench]);

  return { wbOpen, setWbOpen, sbCollapsed, setSbCollapsed, toggleSidebar, ...resizers };
}
