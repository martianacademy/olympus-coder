import { createContext, useContext } from 'react';
import type { AttachmentView } from '@shared/types';
import { buildFixErrorPrompt, type FixErrorInput } from '@shared/fixError';
import { api } from './api';
import { addFilesToMessage } from './components/AddToMessage';
import { composeInChat } from './compose';

/** Active project ID context so deep chat/tool components (`ToolRow`) can attach git diff context on 1-click Fix. */
export const ProjectIdContext = createContext<string | undefined>(undefined);
export const useProjectId = () => useContext(ProjectIdContext);

const isDetachedPanel = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('panel');

export interface TriggerFixOptions extends Omit<FixErrorInput, 'gitSummary' | 'hasScreenshot'> {
  projectId?: string;
  /** Optional PNG base64 (without `data:image/png;base64,` prefix) captured from `<webview>.capturePage()`. */
  screenshotBase64?: string;
}

/**
 * Gathers uncommitted project git diff summary (best-effort) + optional screenshot attachment, builds a structured
 * diagnostic prompt, and populates the chat composer (routing to the main window when clicked in a detached panel).
 */
export async function triggerFixError(opts: TriggerFixOptions): Promise<string> {
  let pid = opts.projectId;
  if (!pid && isDetachedPanel() && api.panels.available()) {
    pid = (await api.panels.context().catch(() => null))?.projectId;
  }

  const [gitSummary, savedShot] = await Promise.all([
    pid && pid !== 'general' ? api.git.workingDiff(pid).catch(() => '') : Promise.resolve(''),
    opts.screenshotBase64
      ? api.saveAttachment('web-preview.png', 'image/png', opts.screenshotBase64).catch(() => null)
      : Promise.resolve(null),
  ]);

  const files: AttachmentView[] = savedShot ? [savedShot] : [];
  const prompt = buildFixErrorPrompt({
    ...opts,
    gitSummary,
    hasScreenshot: files.length > 0,
  });

  if (isDetachedPanel() && api.panels.available()) {
    await api.panels.composeInMain(prompt, files).catch(() => {});
    return prompt;
  }

  if (files.length) addFilesToMessage(files);
  composeInChat(prompt);
  return prompt;
}
