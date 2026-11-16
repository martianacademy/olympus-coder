import type { Dispatch, SetStateAction } from 'react';
import type { AgentDef, AppState, UserProfile } from '@shared/types';
import { api } from '../api';
import type { AgentsInfo } from '../App';
import { isRemoteBrowser } from '../responsive';
import { ErrorBoundary } from './ErrorBoundary';
import { FilePreviewPane, type PreviewTarget } from './FilePreview';
import { HeatToast } from './HeatToast';
import { LoginDialog } from './LoginDialog';
import { MemoryPanel } from './MemoryPanel';
import { ProfileModal } from './Profile';
import { SearchModal } from './SearchModal';
import { SecurityNudge } from './SecurityNudge';
import { SettingsModal, type SettingsTab } from './Settings';
import { UpdateBanner } from './UpdateBanner';

export interface AppOverlaysProps {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState | null>>;
  agents: AgentsInfo;
  agentDefs: Record<string, AgentDef>;
  profile: UserProfile;
  dark: boolean;
  codeWorkbench: boolean;
  preview: PreviewTarget | null;
  onClosePreview: () => void;
  showMemory: boolean;
  memoryProjectId: string;
  memoryThreadItems: number;
  onCloseMemory: () => void;
  settingsTab: SettingsTab | null;
  onSettingsTab: (tab: SettingsTab | null) => void;
  showProfile: boolean;
  onCloseProfile: () => void;
  showSearch: boolean;
  onCloseSearch: () => void;
  loginAgent: string | null;
  onLoginAgent: (id: string | null) => void;
  onLoadAgents: () => Promise<void>;
  onOpenThread: (id: string) => void;
  totalChats: number;
  onUpdateSettings: (patch: Partial<AppState['settings']>) => void;
}

/** Renders Chat-mode side panels, global modal dialogs, and system notification toasts. */
export function AppOverlays(props: AppOverlaysProps) {
  const { state, setState, agents, agentDefs, profile, dark } = props;

  return (
    <>
      {props.preview && !props.codeWorkbench && (
        <aside className="preview-panel">
          <FilePreviewPane target={props.preview} dark={dark} onClose={props.onClosePreview} />
        </aside>
      )}
      {props.showMemory && !props.codeWorkbench && !props.preview && (
        <MemoryPanel projectId={props.memoryProjectId} threadItems={props.memoryThreadItems} onClose={props.onCloseMemory} />
      )}

      {props.settingsTab && (
        <ErrorBoundary label="Settings" onClose={() => props.onSettingsTab(null)}>
          <SettingsModal
            tab={props.settingsTab}
            onTab={props.onSettingsTab}
            state={state}
            agents={agents}
            onState={setState}
            onAgents={props.onLoadAgents}
            onLogin={props.onLoginAgent}
            onClose={() => props.onSettingsTab(null)}
          />
        </ErrorBoundary>
      )}
      {props.showProfile && (
        <ProfileModal
          profile={profile}
          onClose={props.onCloseProfile}
          onSave={async (p) => {
            const s = await api.updateProfile(p);
            setState((st) => (st ? { ...st, settings: s } : st));
          }}
        />
      )}
      {props.showSearch && <SearchModal agentDefs={agentDefs} onOpen={props.onOpenThread} onClose={props.onCloseSearch} />}
      {props.loginAgent && agentDefs[props.loginAgent] && (
        <LoginDialog def={agentDefs[props.loginAgent]} status={agents.statuses[props.loginAgent]} onClose={() => props.onLoginAgent(null)} />
      )}

      <UpdateBanner />
      <HeatToast />
      {!isRemoteBrowser() && (
        <SecurityNudge
          lockEnabled={state.lock.enabled}
          touchId={state.lock.touchIdAvailable}
          chats={props.totalChats}
          settings={state.settings}
          onSettings={props.onUpdateSettings}
          onSetPassword={() => props.onSettingsTab('security')}
        />
      )}
    </>
  );
}
