// Unit tests: ACP rich content (src/main/acpContent.ts + src/shared/acpContent.ts).
// Run: node tests/acpContent.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

const C = await import(`${APP}/src/main/acpContent.ts`);
const S = await import(`${APP}/src/shared/acpContent.ts`);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'olympus-content-unit-'));
const store = { dir: C.chatMediaDir(root, 'thread-1') };
// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const b64 = (s) => Buffer.from(s).toString('base64');

try {
  await test('chatMediaDir is per chat under attachments/chats and sanitizes the id', () => {
    assert.equal(C.chatMediaDir('/r', 'abc-123'), join('/r', 'attachments', 'chats', 'abc-123'));
    assert.equal(C.chatMediaDir('/r', '../../etc'), join('/r', 'attachments', 'chats', '______etc'));
  });

  await test('text block keeps text; annotations are validated', () => {
    const c = C.toRichContent({ type: 'text', text: 'hi', annotations: { audience: ['assistant', 'bogus', 'assistant'], priority: 7, lastModified: 'nope' } });
    assert.deepEqual(c, { type: 'text', text: 'hi', annotations: { audience: ['assistant'], priority: 1 } });
    assert.equal(S.isForUser(c.annotations), false);
    const d = C.toRichContent({ type: 'text', text: 'x', annotations: { audience: 'user', lastModified: '2026-01-02T03:04:05Z' } });
    assert.deepEqual(d.annotations, { lastModified: '2026-01-02T03:04:05Z' });
  });

  await test('image base64 is saved to the chat folder; the stored view has only a path', () => {
    const c = C.toRichContent({ type: 'image', mimeType: 'image/png', data: PNG }, store);
    assert.equal(c.type, 'image');
    assert.ok(c.path.startsWith(store.dir) && c.path.endsWith('.png'), c.path);
    assert.equal(c.size, Buffer.from(PNG, 'base64').length);
    assert.deepEqual(readFileSync(c.path), Buffer.from(PNG, 'base64'));
    assert.ok(!JSON.stringify(c).includes(PNG.slice(0, 20)), 'no base64 in the stored view');
    assert.ok(JSON.stringify(c).length < 400);
  });

  await test('the same image twice is one file (content hash)', () => {
    const a = C.toRichContent({ type: 'image', mimeType: 'image/png', data: PNG }, store);
    const b = C.toRichContent({ type: 'image', mimeType: 'image/png', data: `data:image/png;base64,${PNG}` }, store);
    assert.equal(a.path, b.path);
    assert.equal(readdirSync(store.dir).filter((f) => f.endsWith('.png')).length, 1);
  });

  await test('image over the limit is rejected before decoding (too-large), nothing written', () => {
    const before = readdirSync(store.dir).length;
    const huge = 'A'.repeat(Math.ceil(((S.MAX_IMAGE_BYTES + 10) * 4) / 3));
    const c = C.toRichContent({ type: 'image', mimeType: 'image/png', data: huge }, store);
    assert.equal(c.omitted, 'too-large');
    assert.equal(c.path, undefined);
    assert.ok(c.size > S.MAX_IMAGE_BYTES);
    assert.equal(readdirSync(store.dir).length, before);
  });

  await test('invalid base64 is marked invalid', () => {
    const c = C.toRichContent({ type: 'image', mimeType: 'image/png', data: 'not base64 !!!' }, store);
    assert.equal(c.omitted, 'invalid');
  });

  await test('web image keeps its uri and is not downloaded; data: uri is used as the payload', () => {
    const w = C.toRichContent({ type: 'image', mimeType: 'image/jpeg', data: '', uri: 'https://example.com/a.jpg' }, store);
    assert.deepEqual(w, { type: 'image', mimeType: 'image/jpeg', uri: 'https://example.com/a.jpg' });
    const d = C.toRichContent({ type: 'image', mimeType: 'image/png', data: '', uri: `data:image/png;base64,${PNG}` }, store);
    assert.ok(d.path && !d.uri);
    assert.equal(C.toRichContent({ type: 'image', mimeType: 'image/png', data: '' }, store), undefined);
  });

  await test('bad MIME types fall back; MIME parameters are dropped', () => {
    assert.equal(C.safeMime('IMAGE/PNG; charset=x'), 'image/png');
    assert.equal(C.safeMime('<script>'), 'application/octet-stream');
    const c = C.toRichContent({ type: 'image', mimeType: '../../x', data: PNG }, store);
    assert.equal(c.mimeType, 'image/png');
  });

  await test('audio is saved with a playable extension', () => {
    const c = C.toRichContent({ type: 'audio', mimeType: 'audio/x-wav', data: b64('RIFF....WAVEfmt ') }, store);
    assert.equal(c.type, 'audio');
    assert.ok(c.path.endsWith('.wav'));
    assert.equal(C.toRichContent({ type: 'audio', mimeType: 'audio/wav' }, store), undefined);
  });

  await test('embedded text resource stays inline when short', () => {
    const c = C.toRichContent({ type: 'resource', resource: { uri: 'file:///p/a.md', mimeType: 'text/markdown', text: '# Hi' }, annotations: { priority: 0.3 } }, store);
    assert.deepEqual(c, { type: 'resource', encoding: 'text', uri: 'file:///p/a.md', mimeType: 'text/markdown', text: '# Hi', annotations: { priority: 0.3 } });
  });

  await test('long embedded text is capped inline and the whole text saved to a file', () => {
    const text = 'x'.repeat(S.MAX_INLINE_RESOURCE_TEXT + 500);
    const c = C.toRichContent({ type: 'resource', resource: { uri: 'file:///p/big.log', mimeType: 'text/plain', text } }, store);
    assert.equal(c.text.length, S.MAX_INLINE_RESOURCE_TEXT);
    assert.equal(c.textOmitted, 500);
    assert.ok(c.path.endsWith('.txt'));
    assert.equal(readFileSync(c.path, 'utf8'), text);
  });

  await test('blob resource is saved as a file (encoding blob)', () => {
    const c = C.toRichContent({ type: 'resource', resource: { uri: 'file:///p/doc.pdf', mimeType: 'application/pdf', blob: b64('%PDF-1.4 test') } }, store);
    assert.equal(c.encoding, 'blob');
    assert.ok(c.path.endsWith('.pdf'));
    assert.equal(readFileSync(c.path, 'utf8'), '%PDF-1.4 test');
    assert.equal(C.toRichContent({ type: 'resource', resource: { uri: 'x' } }, store), undefined);
  });

  await test('resource_link keeps title, description, mime, size; strips control chars; drops bad size', () => {
    const c = C.toRichContent({
      type: 'resource_link',
      uri: 'https://ex.com/r',
      name: 'r\u0000\u202eevil',
      title: 'Report',
      description: 'Quarterly\nnumbers',
      mimeType: 'application/pdf',
      size: 2048,
      annotations: { audience: ['user'] },
    });
    assert.deepEqual(c, {
      type: 'resource_link',
      uri: 'https://ex.com/r',
      name: 'r  evil',
      title: 'Report',
      description: 'Quarterly numbers',
      mimeType: 'application/pdf',
      size: 2048,
      annotations: { audience: ['user'] },
    });
    const d = C.toRichContent({ type: 'resource_link', uri: 'file:///a/b/c.ts', size: -1 });
    assert.equal(d.name, 'c.ts');
    assert.equal(d.size, undefined);
  });

  await test('unknown blocks are ignored; empty text dropped; lists accepted', () => {
    assert.equal(C.toRichContent({ type: 'video', data: 'x' }), undefined);
    assert.equal(C.toRichContent(null), undefined);
    const list = C.toRichContents([{ type: 'text', text: '' }, { type: 'text', text: 'a' }, 5], store);
    assert.deepEqual(list, [{ type: 'text', text: 'a' }]);
    assert.deepEqual(C.toRichContents({ type: 'text', text: 'b' }), [{ type: 'text', text: 'b' }]);
  });

  await test('mapToolContent: diff capped, text plain, media rich + plain fallback, terminal, session dropped', () => {
    const out = C.mapToolContent(
      [
        { type: 'diff', path: '/a.ts', oldText: 'o', newText: 'n'.repeat(C.MAX_DIFF_TEXT + 3) },
        { type: 'content', content: { type: 'text', text: 'done' } },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: PNG } },
        { type: 'content', content: { type: 'text', text: 'secret', annotations: { audience: ['assistant'] } } },
        { type: 'terminal', terminalId: 't1' },
        { type: 'session', sessionId: 's' },
        { type: 'weird', x: 1 },
      ],
      store,
    );
    assert.equal(out.length, 6);
    assert.ok(out[0].newText.includes('truncated: 3 more characters'));
    assert.deepEqual(out[1], { type: 'text', text: 'done' });
    assert.equal(out[2].rich.type, 'image');
    assert.ok(out[2].text.startsWith('[Image: '));
    assert.equal(out[3].rich.annotations.audience[0], 'assistant');
    assert.deepEqual(out[4], { type: 'terminal', terminalId: 't1' });
    assert.equal(out[5].type, 'other');
    assert.deepEqual(C.mapToolContent(undefined), []);
  });

  await test('mapLocations keeps lines, treats 0/bad as none, removes duplicates and junk', () => {
    const locs = C.mapLocations([
      { path: '/a.ts', line: 12 },
      { path: '/a.ts', line: 12 },
      { path: '/a.ts', line: 40 },
      { path: '/b.ts', line: 0 },
      { path: '/c.ts', line: 2.5 },
      { line: 3 },
      'nope',
    ]);
    assert.deepEqual(locs, [{ path: '/a.ts', line: 12 }, { path: '/a.ts', line: 40 }, { path: '/b.ts' }, { path: '/c.ts' }]);
    assert.deepEqual(C.splitLocations(locs), { locations: ['/a.ts', '/b.ts', '/c.ts'], locationRefs: locs });
    assert.deepEqual(C.splitLocations([{ path: '/x' }]), { locations: ['/x'] });
  });

  await test('toolIdentityOf: Claude toolName + parent, MCP split, nothing else from _meta', () => {
    const id = C.toolIdentityOf({
      name: 'mcp__github__create_issue',
      _meta: { claudeCode: { toolName: 'mcp__github__create_issue', parentToolUseId: 'toolu_01', secret: 'x' }, other: { evil: '<b>' } },
    });
    assert.deepEqual(id, {
      name: 'mcp__github__create_issue',
      toolName: 'mcp__github__create_issue',
      parentToolUseId: 'toolu_01',
      isMcp: true,
      mcpServer: 'github',
      mcpTool: 'create_issue',
    });
    assert.equal(S.toolIdentityLabel(id, 'Create issue'), 'MCP · github › create_issue');
  });

  await test('toolIdentityOf: AIR mcp/skill/subagent/commandTitle, Codex is_mcp_tool_call, merge with earlier report', () => {
    const air = C.toolIdentityOf({
      _meta: { claudeCode: { toolName: 'Skill' }, jetbrains: { air: { skill: { name: 'pdf', path: '/x' }, subagent: true, commandTitle: 'List\u0007 files' } } },
    });
    assert.deepEqual(air, { toolName: 'Skill', skill: 'pdf', subagent: true, commandTitle: 'List  files' });
    const codex = C.toolIdentityOf({ name: 'search_docs', _meta: { is_mcp_tool_call: true } });
    assert.deepEqual(codex, { name: 'search_docs', isMcp: true });
    assert.equal(S.toolIdentityLabel(codex, 'Search'), 'MCP · search_docs');
    const merged = C.toolIdentityOf({ _meta: { claudeCode: { parentToolUseId: 'bad id with spaces' } } }, { name: 'Read' });
    assert.deepEqual(merged, { name: 'Read' });
    assert.equal(C.toolIdentityOf({ _meta: 'x' }), undefined);
    assert.equal(S.toolIdentityLabel({ name: 'Read' }, 'Read src/a.ts'), undefined);
  });

  await test('splitMcpName matches Claude Code (server up to the next __)', () => {
    assert.deepEqual(S.splitMcpName('mcp__claude_ai_Gmail__send_message'), { server: 'claude_ai_Gmail', tool: 'send_message' });
    assert.deepEqual(S.splitMcpName('mcp__a__b__c'), { server: 'a', tool: 'b__c' });
    assert.equal(S.splitMcpName('mcp____x'), undefined);
    assert.equal(S.splitMcpName('Read'), undefined);
  });

  await test('appendMessageContent: plain text has no parts; media starts parts in order', () => {
    let m = { text: '' };
    m = S.appendMessageContent(m, [{ type: 'text', text: 'Look ' }]);
    m = S.appendMessageContent(m, [{ type: 'text', text: 'here:' }]);
    assert.deepEqual(m, { text: 'Look here:' });
    m = S.appendMessageContent(m, [{ type: 'image', mimeType: 'image/png', path: '/m/a.png' }]);
    m = S.appendMessageContent(m, [{ type: 'text', text: 'Nice' }, { type: 'text', text: '!' }]);
    assert.deepEqual(m.parts, [
      { type: 'text', text: 'Look here:' },
      { type: 'image', mimeType: 'image/png', path: '/m/a.png' },
      { type: 'text', text: 'Nice!' },
    ]);
    assert.equal(m.text, 'Look here:\n[Image: /m/a.png]\nNice!');
    const hidden = S.appendMessageContent({ text: 'a' }, [{ type: 'text', text: 'b', annotations: { audience: ['assistant'] } }]);
    assert.equal(hidden.parts.length, 2);
  });

  await test('shared helpers: locationRef, normalizeLocations, fileUriPath, fmtBytes', () => {
    assert.equal(S.locationRef({ path: '/a.ts', line: 9 }), '/a.ts#L9');
    assert.equal(S.locationRef({ path: '/a.ts' }), '/a.ts');
    assert.deepEqual(S.normalizeLocations(['/a', { path: '/b', line: 3 }, { path: ' ' }]), [{ path: '/a' }, { path: '/b', line: 3 }]);
    assert.equal(S.fileUriPath('file:///Users/x/My%20File.md'), '/Users/x/My File.md');
    assert.equal(S.fileUriPath('file:///C:/x/y.txt'), 'C:/x/y.txt');
    assert.equal(S.fileUriPath('https://x'), undefined);
    assert.equal(S.fmtBytes(1536), '1.5 KB');
  });

  await test('chat media budget: a full folder refuses new media (quota)', () => {
    const full = { dir: C.chatMediaDir(root, 'full-chat') };
    mkdirSync(full.dir, { recursive: true });
    const fd = openSync(join(full.dir, 'filler.bin'), 'w');
    ftruncateSync(fd, S.MAX_CHAT_MEDIA_BYTES); // sparse: no real disk use
    closeSync(fd);
    const c = C.toRichContent({ type: 'image', mimeType: 'image/png', data: PNG }, full);
    assert.equal(c.omitted, 'quota');
    assert.equal(c.path, undefined);
  });

  await test('removeChatMedia deletes the folder', () => {
    C.removeChatMedia(root, 'thread-1');
    assert.equal(existsSync(store.dir), false);
  });

  await test('promptBlockKind follows the agent capabilities and limits', () => {
    const k = (mime, size, caps) => C.promptBlockKind({ mime, size }, caps);
    const claude = { image: true, embeddedContext: true };
    assert.equal(k('image/png', 1000, claude), 'image');
    assert.equal(k('image/png', C.PROMPT_LIMITS.image + 1, claude), 'link');
    assert.equal(k('image/heic', 1000, claude), 'link');
    assert.equal(k('audio/mpeg', 1000, claude), 'link');
    assert.equal(k('audio/mpeg', 1000, { audio: true }), 'audio');
    assert.equal(k('audio/mpeg', C.PROMPT_LIMITS.audio + 1, { audio: true }), 'link');
    assert.equal(k('text/markdown', 1000, claude), 'resource-text');
    assert.equal(k('application/ld+json', 1000, claude), 'resource-text');
    assert.equal(k('text/plain', 1000, {}), 'inline-text');
    assert.equal(k('application/pdf', 1000, claude), 'resource-blob');
    assert.equal(k('application/pdf', C.PROMPT_LIMITS.blob + 1, claude), 'link');
    assert.equal(k('application/pdf', 1000, { image: true }), 'link');
    assert.equal(k('application/zip', 1000, claude), 'link');
    assert.equal(C.promptAudioMime('audio/x-wav'), 'audio/wav');
    assert.equal(C.promptAudioMime('audio/mp3'), 'audio/mpeg');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
