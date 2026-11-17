// Unit tests: model capability tags from the models.dev registry — trimming, first-slash lookup, offline "free" guess.
// File: src/shared/modelTags.ts.
// Run: node tests/modelTags.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
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

const { trimRegistry, tagsForValue, deriveFallbackTags, choiceTags, providerOf, splitModelValue, limitsOf, contextLimit } = await import(`${APP}/src/shared/modelTags.ts`);

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
};

// Registry sample in the models.dev shape (extra fields ignored).
const raw = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode Zen',
    models: {
      'glm-5.3-flash-free': { id: 'glm-5.3-flash-free', cost: { input: 0, output: 0 }, tool_call: true },
      'glm-5.3-flash': { id: 'glm-5.3-flash', cost: { input: 0.15, output: 0.5 }, reasoning: true, limit: { context: 131072 } },
      'vision-pro': { attachment: true, reasoning: true, tool_call: true, cost: { input: 1, output: 2 } },
      plain: { cost: { input: 1, output: 1 } },
      'half-free': { cost: { input: 0, output: 1 } },
      'no-cost': { tool_call: false },
    },
  },
  openrouter: { models: { 'z-ai/glm-5.3-flashx': { attachment: true, cost: { input: 0, output: 0 }, limit: { context: 262144 } } } },
  nolimit: { models: { 'm1': { cost: { input: 0, output: 0 } } } },
  empty: { models: {} },
  broken: null,
  nomodels: { id: 'x' },
};
const tags = trimRegistry(raw);

t('trimRegistry: free only when input AND output cost are 0', () => {
  assert.deepEqual(tags.opencode['glm-5.3-flash-free'], ['free', 'tools']);
  assert.equal(tags.opencode['half-free'], undefined, 'input 0 / output 1 is not free (and has no other tags)');
  assert.deepEqual(tags.opencode['glm-5.3-flash'], ['reasoning'], 'paid model is not free');
});
t('trimRegistry: vision / reasoning / tools, in a fixed order', () => {
  assert.deepEqual(tags.opencode['vision-pro'], ['vision', 'reasoning', 'tools']);
});
t('trimRegistry: models and providers without tags are left out; junk entries ignored', () => {
  assert.equal(tags.opencode.plain, undefined);
  assert.equal(tags.opencode['no-cost'], undefined);
  assert.equal(tags.empty, undefined);
  assert.equal(tags.broken, undefined);
  assert.equal(tags.nomodels, undefined);
  assert.deepEqual(trimRegistry(null), {});
  assert.deepEqual(trimRegistry('nope'), {});
});
t('trimRegistry: keeps nested model ids whole', () => {
  assert.deepEqual(tags.openrouter['z-ai/glm-5.3-flashx'], ['free', 'vision']);
});
t('tagsForValue: splits at the first slash', () => {
  assert.deepEqual(tagsForValue(tags, 'opencode/glm-5.3-flash-free'), ['free', 'tools']);
  assert.deepEqual(splitModelValue('openrouter/z-ai/glm-5.3-flashx'), ['openrouter', 'z-ai/glm-5.3-flashx']);
});
t('tagsForValue: nested id after the provider', () => {
  assert.deepEqual(tagsForValue(tags, 'openrouter/z-ai/glm-5.3-flashx'), ['free', 'vision']);
});
t('tagsForValue: unknown provider / model / malformed values → []', () => {
  assert.deepEqual(tagsForValue(tags, 'nobody/glm-5.3-flash-free'), []);
  assert.deepEqual(tagsForValue(tags, 'opencode/does-not-exist'), []);
  assert.deepEqual(tagsForValue(tags, 'no-slash'), []);
  assert.deepEqual(tagsForValue(tags, '/leading'), []);
  assert.deepEqual(tagsForValue(tags, 'trailing/'), []);
  assert.deepEqual(tagsForValue(undefined, 'opencode/glm-5.3-flash-free'), []);
});
t('deriveFallbackTags: "free" from the value or the name, case-insensitive', () => {
  assert.deepEqual(deriveFallbackTags('lmstudio/qwen-free'), ['free']);
  assert.deepEqual(deriveFallbackTags('x/y', 'Big Model (FREE)'), ['free']);
  assert.deepEqual(deriveFallbackTags('x/y', 'Big Model'), []);
  assert.deepEqual(deriveFallbackTags('x/freeform-7b'), ['free'], 'plain substring match, as specified');
});
t('choiceTags: registry wins; fallback only when the registry has nothing', () => {
  assert.deepEqual(choiceTags(tags, 'opencode/vision-pro', 'Vision Pro'), ['vision', 'reasoning', 'tools']);
  assert.deepEqual(choiceTags(tags, 'unknown/m-free', 'M'), ['free']);
  assert.deepEqual(choiceTags({}, 'unknown/m', 'M'), []);
});
t('providerOf: value prefix', () => {
  assert.equal(providerOf('github-copilot/gpt-5'), 'github-copilot');
  assert.equal(providerOf('plain'), undefined);
});

// ---- context-window limits (Info panel's context estimate) ----
const lim = limitsOf(raw);
t('limitsOf: context tokens per provider/model; junk ignored', () => {
  assert.equal(lim.opencode['glm-5.3-flash'], 131072);
  assert.equal(lim.openrouter['z-ai/glm-5.3-flashx'], 262144);
  assert.deepEqual(lim.nolimit, undefined);
});
t('contextLimit: first-slash lookup, unknown → undefined', () => {
  assert.equal(contextLimit(lim, 'opencode/glm-5.3-flash'), 131072);
  assert.equal(contextLimit(lim, 'opencode/glm-unknown'), undefined);
  assert.equal(contextLimit(undefined, 'opencode/glm-5.3-flash'), undefined);
});

console.log(`\n${n}/${n} passed`);
