import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Split, X } from 'lucide-react';
import { isPanelTool, PANEL_TITLES, type PanelTool } from '@shared/panels';
import { commitTabReorder, DEFAULT_WB_TABS, getWorkbenchTabOrder, setWorkbenchTabOrder, type CoreWbTab } from '../workbenchTabs';
import type { WorkbenchTab } from './Workbench';

export interface WorkbenchTabDef {
  id: WorkbenchTab;
  label: string;
  icon: React.ReactNode;
}

const CORE_SET = new Set<string>(DEFAULT_WB_TABS);
const isCoreTab = (id: WorkbenchTab): id is CoreWbTab => CORE_SET.has(id);

/** Vertical/horizontal distance (px) outside the tab bar that turns a tab drag into a window pop-out gesture. */
const DETACH_PULL_PX = 36;
/** Pointer movement (px) before a press turns into a drag rather than a normal tab click. */
const DRAG_START_PX = 6;

interface DragState {
  id: WorkbenchTab;
  label: string;
  icon: React.ReactNode;
  mode: 'reorder' | 'detach';
  /** Current pointer coordinates (viewport px). */
  x: number;
  y: number;
  /** Pointer offset inside the grabbed tab so the floating chip stays anchored where the user grabbed it. */
  grabOffsetX: number;
  grabOffsetY: number;
  /** Grabbed tab box size, reused for the empty drop placeholder so the tab bar never shifts width. */
  width: number;
  height: number;
  /** Insertion index among the non-dragged visible core tabs (`0..otherCoreCount`), or `-1` for non-core tabs. */
  insertIdx: number;
  /** Original index of the grabbed core tab before dragging (used to orient the drop indicator line). */
  origIdx: number;
}

interface LaunchAnim {
  key: number;
  label: string;
  icon: React.ReactNode;
  /** Clamped viewport box coordinates for the expanded 360×230 window silhouette. */
  left: number;
  top: number;
  /** Transform origin relative to the box so expansion always originates at the exact cursor/button point. */
  originX: number;
  originY: number;
  stage: 'start' | 'expand' | 'fade';
}

/**
 * Workbench header tab strip:
 * - Pure tab list on the left; dragging a tab horizontally floats a smooth chip under the cursor while showing an
 *   accent drop line + empty placeholder slot at the exact landing position (frozen midpoints = zero jitter).
 * - Pulling a detachable tab outside the strip switches to pop-out mode; releasing (or clicking the far-right
 *   `Maximize2` button) runs a cursor-to-window expand animation that bridges Electron's window creation latency.
 */
export function WorkbenchTabBar({
  tabs,
  activeTab,
  hasThread,
  webUrl,
  onTab,
  onDetach,
  onFork,
  onClose,
}: {
  tabs: WorkbenchTabDef[];
  activeTab: WorkbenchTab;
  hasThread: boolean;
  webUrl: string | null;
  onTab: (t: WorkbenchTab) => void;
  onDetach?: (tool: PanelTool, url?: string) => void;
  onFork?: () => void;
  onClose: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [launch, setLaunch] = useState<LaunchAnim | null>(null);
  const launchTimers = useRef<number[]>([]);

  const canDetachTab = (id: WorkbenchTab): id is PanelTool =>
    Boolean(onDetach && isPanelTool(id) && (id !== 'tasks' || hasThread));

  useEffect(() => {
    if (!drag) return;
    document.body.classList.add('wb-tab-is-dragging');
    return () => document.body.classList.remove('wb-tab-is-dragging');
  }, [drag]);

  useEffect(() => {
    return () => {
      for (const id of launchTimers.current) window.clearTimeout(id);
    };
  }, []);

  /** Fires a smooth expanding window silhouette from `(x, y)` while Electron spawns the real BrowserWindow. */
  const triggerDetachWithAnim = (tool: PanelTool, icon: React.ReactNode, x: number, y: number) => {
    for (const id of launchTimers.current) window.clearTimeout(id);
    launchTimers.current = [];

    const W = 360;
    const H = 230;
    const left = Math.round(Math.max(16, Math.min(window.innerWidth - W - 16, x - W / 2)));
    const top = Math.round(Math.max(16, Math.min(window.innerHeight - H - 16, y - H / 2)));
    const originX = Math.round(Math.max(0, Math.min(W, x - left)));
    const originY = Math.round(Math.max(0, Math.min(H, y - top)));
    const key = Date.now();
    setLaunch({ key, label: PANEL_TITLES[tool], icon, left, top, originX, originY, stage: 'start' });

    const t1 = window.setTimeout(() => {
      setLaunch((cur) => (cur && cur.key === key ? { ...cur, stage: 'expand' } : cur));
    }, 16);
    const t2 = window.setTimeout(() => {
      setLaunch((cur) => (cur && cur.key === key ? { ...cur, stage: 'fade' } : cur));
    }, 340);
    const t3 = window.setTimeout(() => {
      setLaunch((cur) => (cur && cur.key === key ? null : cur));
    }, 520);
    launchTimers.current = [t1, t2, t3];

    onDetach?.(tool, tool === 'web' ? webUrl ?? undefined : undefined);
  };

  const startTabDrag = (e: React.PointerEvent<HTMLButtonElement>, t: WorkbenchTabDef) => {
    if (e.button !== 0) return;
    const coreId: CoreWbTab | null = isCoreTab(t.id) ? t.id : null;
    const detachable = canDetachTab(t.id);
    if (!coreId && !detachable) return;

    const btnRect = e.currentTarget.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const grabOffsetX = e.clientX - btnRect.left;
    const grabOffsetY = e.clientY - btnRect.top;

    // Snapshot frozen midpoints of all visible core tabs before drag mutates layout (eliminates oscillation/jitter).
    const coreNodes = barRef.current
      ? [...barRef.current.querySelectorAll<HTMLButtonElement>('button[data-wb-core-tab]')]
      : [];
    const visibleCoreIds = coreNodes.map((n) => n.dataset.wbCoreTab as CoreWbTab);
    const origIdx = coreId ? visibleCoreIds.indexOf(coreId) : -1;
    const otherCoreSnap = coreNodes
      .map((n) => {
        const r = n.getBoundingClientRect();
        return { id: n.dataset.wbCoreTab as CoreWbTab, mid: r.left + r.width / 2 };
      })
      .filter((item) => item.id !== coreId);

    let mode: 'idle' | 'reorder' | 'detach' = 'idle';
    let lastInsertIdx = origIdx;
    let lastX = startX;
    let lastY = startY;

    const onMove = (ev: PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (mode === 'idle') {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        mode = 'reorder';
      }

      const barRect = barRef.current?.getBoundingClientRect();
      const pulledOut = Boolean(
        detachable &&
          barRect &&
          (ev.clientY < barRect.top - DETACH_PULL_PX ||
            ev.clientY > barRect.bottom + DETACH_PULL_PX ||
            ev.clientX < barRect.left - DETACH_PULL_PX ||
            ev.clientX > barRect.right + DETACH_PULL_PX),
      );

      if (pulledOut) {
        mode = 'detach';
        setDrag({
          id: t.id,
          label: PANEL_TITLES[t.id as PanelTool] ?? t.label,
          icon: t.icon,
          mode: 'detach',
          x: ev.clientX,
          y: ev.clientY,
          grabOffsetX,
          grabOffsetY,
          width: btnRect.width,
          height: btnRect.height,
          insertIdx: -1,
          origIdx,
        });
        return;
      }

      mode = 'reorder';
      let insertIdx = -1;
      if (coreId) {
        insertIdx = 0;
        for (const item of otherCoreSnap) {
          if (ev.clientX > item.mid) insertIdx++;
        }
        lastInsertIdx = insertIdx;
      }

      setDrag({
        id: t.id,
        label: t.label,
        icon: t.icon,
        mode: 'reorder',
        x: ev.clientX,
        y: ev.clientY,
        grabOffsetX,
        grabOffsetY,
        width: btnRect.width,
        height: btnRect.height,
        insertIdx,
        origIdx,
      });
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };

    const onUp = () => {
      cleanup();
      const finalMode = mode;
      if (finalMode !== 'idle') {
        suppressClickRef.current = true;
        requestAnimationFrame(() => {
          suppressClickRef.current = false;
        });
      }
      setDrag(null);
      if (finalMode === 'reorder' && coreId && lastInsertIdx >= 0) {
        const nextOrder = commitTabReorder(
          getWorkbenchTabOrder(),
          coreId,
          otherCoreSnap.map((s) => s.id),
          lastInsertIdx,
        );
        setWorkbenchTabOrder(nextOrder);
      } else if (finalMode === 'detach' && detachable) {
        triggerDetachWithAnim(t.id as PanelTool, t.icon, lastX, lastY);
      }
    };

    const onCancel = () => {
      cleanup();
      setDrag(null);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        cleanup();
        setDrag(null);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
  };

  const activeTabDef = tabs.find((t) => t.id === activeTab);
  const activeDetachable = canDetachTab(activeTab);

  // Build rendered tab list: during core horizontal reorder, remove the grabbed tab and insert the drop slot + line.
  const isCoreReordering = Boolean(drag && drag.mode === 'reorder' && isCoreTab(drag.id) && drag.insertIdx >= 0);
  const renderedNodes: React.ReactNode[] = [];
  let coreSeen = 0;

  const pushDropSlot = () => {
    if (!drag) return;
    const side = drag.insertIdx > drag.origIdx ? 'right' : 'left';
    renderedNodes.push(
      <span
        key="__wb-drop-slot__"
        className={`wb-drop-slot is-${side}`}
        data-testid="wb-drop-slot"
        data-drop-index={drag.insertIdx}
        style={{ width: Math.max(30, Math.round(drag.width)), height: Math.round(drag.height) }}
        aria-hidden="true"
      >
        <span className="wb-drop-line" data-testid="wb-drop-line" />
        <span className="wb-drop-box" data-testid="wb-drop-box" />
      </span>,
    );
  };

  for (const t of tabs) {
    if (isCoreReordering && drag?.id === t.id) continue;
    const core = isCoreTab(t.id);
    if (isCoreReordering && core && coreSeen === drag!.insertIdx) pushDropSlot();
    if (core) coreSeen++;

    const isDetachingThis = drag?.id === t.id && drag.mode === 'detach';
    renderedNodes.push(
      <button
        key={t.id}
        className={`${activeTab === t.id ? 'active' : ''} ${isDetachingThis ? 'is-dragging is-detach' : ''}`}
        data-testid={`wb-${t.id}`}
        data-wb-core-tab={core ? t.id : undefined}
        title={canDetachTab(t.id) ? `${t.label} — drag to reorder, or pull out to open in a new window` : t.label}
        onPointerDown={(e) => startTabDrag(e, t)}
        onClick={() => {
          if (suppressClickRef.current) return;
          onTab(t.id);
        }}
      >
        {t.icon} <span className="wb-label">{t.label}</span>
      </button>,
    );
  }
  if (isCoreReordering && coreSeen === drag!.insertIdx) pushDropSlot();

  return (
    <div className={`workbench-tabs ${drag ? 'is-dragging-any' : ''}`} ref={barRef} data-testid="workbench-tabs">
      {renderedNodes}
      <div className="spacer" />
      {onFork && hasThread && (
        <button
          className="btn ghost icon wb-sheet-action"
          title="Fork: start a new sub-session from this whole chat"
          aria-label="Fork session"
          data-testid="wb-fork"
          onClick={onFork}
        >
          <Split size={16} className="fork-icon" />
        </button>
      )}
      {activeDetachable && (
        <button
          className="btn ghost icon wb-popout"
          title={`Open ${PANEL_TITLES[activeTab]} in a new window`}
          aria-label={`Open ${PANEL_TITLES[activeTab]} in a new window`}
          data-testid={`wb-detach-${activeTab}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            triggerDetachWithAnim(activeTab, activeTabDef?.icon ?? <Maximize2 size={14} />, r.left + r.width / 2, r.top + r.height / 2);
          }}
        >
          <Maximize2 size={15} />
        </button>
      )}
      <button className="btn ghost icon" title="Close panel" aria-label="Close panel" data-testid="wb-close" onClick={onClose}>
        <X size={18} />
      </button>

      {/* Portal floating drag chip, pull-out ghost, and expanding launch window to document.body so `.workbench-tabs`
          overflow/container rules never clip them. */}
      {typeof document !== 'undefined' &&
        (drag || launch) &&
        createPortal(
          <>
            {drag?.mode === 'reorder' && (
              <div
                className="wb-drag-chip"
                data-testid="wb-drag-chip"
                style={{
                  minWidth: Math.round(drag.width),
                  height: Math.round(drag.height),
                  transform: `translate3d(${Math.round(drag.x - drag.grabOffsetX)}px, ${Math.round(drag.y - drag.grabOffsetY)}px, 0)`,
                }}
                aria-hidden="true"
              >
                {drag.icon}
                <span className="wb-label">{drag.label}</span>
              </div>
            )}

            {drag?.mode === 'detach' && (
              <div
                className="wb-detach-ghost"
                data-testid="wb-detach-ghost"
                style={{ transform: `translate3d(${Math.round(drag.x + 12)}px, ${Math.round(drag.y + 12)}px, 0)` }}
                aria-hidden="true"
              >
                <Maximize2 size={12} />
                <span>Open {drag.label} in new window</span>
              </div>
            )}

            {launch && (
              <div
                key={launch.key}
                className={`wb-launch-window is-${launch.stage}`}
                data-testid="wb-launch-window"
                style={{ left: launch.left, top: launch.top, transformOrigin: `${launch.originX}px ${launch.originY}px` }}
                aria-hidden="true"
              >
                <div className="wb-launch-head">
                  <span className="wb-launch-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="wb-launch-title">
                    {launch.icon}
                    <span>{launch.label}</span>
                  </span>
                </div>
                <div className="wb-launch-body" />
              </div>
            )}
          </>,
          document.body,
        )}
    </div>
  );
}
