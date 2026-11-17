// Unit tests: detached Workbench tool windows — one window per tool, re-open returns the live one, closed/destroyed
// windows are forgotten, the ?panel= query round-trips. File: src/shared/panels.ts.
// Run: node tests/panels.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const { PanelRegistry, PANEL_TOOLS, isPanelTool, panelQuery, parsePanelQuery } = await import(`${APP}/src/shared/panels.ts`);

let made = 0;
const mk = (tool) => ({ id: ++made, tool, dead: false });
const reg = () => new PanelRegistry((w) => !w.dead);

// 1. One window per tool: a second open returns the same window and does not create.
{
  const r = reg();
  const a = r.open('terminal', () => mk('terminal'));
  assert.equal(a.created, true);
  const b = r.open('terminal', () => assert.fail('must not create a second terminal window'));
  assert.equal(b.created, false);
  assert.equal(b.win, a.win);
  assert.deepEqual(r.list(), ['terminal']);
}

// 2. Different tools get different windows; list keeps the canonical tool order.
{
  const r = reg();
  r.open('web', () => mk('web'));
  r.open('files', () => mk('files'));
  assert.deepEqual(r.list(), ['files', 'web']);
  assert.equal(r.all().length, 2);
  assert.equal(r.toolOf(r.get('web')), 'web');
  assert.equal(r.toolOf({}), undefined);
}

// 3. closed() forgets the window; the next open creates a new one.
{
  const r = reg();
  const first = r.open('git', () => mk('git')).win;
  r.closed('git', first);
  assert.equal(r.get('git'), undefined);
  const second = r.open('git', () => mk('git'));
  assert.equal(second.created, true);
  assert.notEqual(second.win, first);
}

// 4. A stale 'closed' for an already replaced window does not drop the new one.
{
  const r = reg();
  const first = r.open('info', () => mk('info')).win;
  first.dead = true; // destroyed without our closed() having run yet
  const second = r.open('info', () => mk('info')).win;
  r.closed('info', first);
  assert.equal(r.get('info'), second);
}

// 5. A destroyed window is not listed and not returned.
{
  const r = reg();
  const w = r.open('tasks', () => mk('tasks')).win;
  w.dead = true;
  assert.deepEqual(r.list(), []);
  assert.equal(r.all().length, 0);
}

// 6. Tools and the query.
{
  assert.deepEqual([...PANEL_TOOLS], ['files', 'git', 'terminal', 'tasks', 'info', 'web']);
  assert.equal(isPanelTool('files'), true);
  assert.equal(isPanelTool('preview'), false);
  assert.equal(isPanelTool(undefined), false);
  assert.deepEqual(panelQuery('terminal'), { panel: 'terminal' });
  assert.deepEqual(panelQuery('terminal', 'http://x'), { panel: 'terminal' }, 'only the Web tool carries a url');
  assert.deepEqual(panelQuery('web', 'http://localhost:5173/'), { panel: 'web', url: 'http://localhost:5173/' });
  const qs = '?' + new URLSearchParams(panelQuery('web', 'http://localhost:5173/a?b=1')).toString();
  assert.deepEqual(parsePanelQuery(qs), { tool: 'web', url: 'http://localhost:5173/a?b=1' });
  assert.deepEqual(parsePanelQuery('?panel=git'), { tool: 'git' });
  assert.equal(parsePanelQuery(''), null);
  assert.equal(parsePanelQuery('?panel=preview'), null);
  assert.equal(parsePanelQuery('?panel=__proto__'), null);
}

console.log('panels.unit: all checks passed');
