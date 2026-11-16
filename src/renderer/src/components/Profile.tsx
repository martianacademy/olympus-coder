import { useEffect, useRef, useState } from 'react';
import { Brain, Camera, ChevronUp, Gauge, Lock, Settings as SettingsIcon, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import type { AgentStatus, LearnedNote, RateLimitView, UserProfile } from '@shared/types';
import { LimitBars, LimitsFreshness } from './Usage';
import { api } from '../api';
import { keys } from '../platform';

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

export function Avatar({ profile, size = 28 }: { profile: UserProfile; size?: number }) {
  if (profile.avatar) return <img className="avatar" src={profile.avatar} width={size} height={size} alt="" />;
  return (
    <span className="avatar" style={{ width: size, height: size, background: profile.avatarColor, fontSize: size * 0.4 }}>
      {profile.name ? initials(profile.name) : <UserRound size={size * 0.6} />}
    </span>
  );
}

/** Bottom-left of the sidebar: who is signed in to this app, plus quick links. */
export function ProfileButton(props: {
  profile: UserProfile;
  lockEnabled: boolean;
  onEdit: () => void;
  onSettings: () => void;
  onMemory: () => void;
  onUsage: () => void;
  /** Current agent's plan and limits, shown at the top of the menu. */
  plan?: string;
  limits?: RateLimitView[];
  /** The same agent's status: when its limits were read, with a refresh button. */
  limitsStatus?: AgentStatus;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const p = props.profile;
  const item = (icon: React.ReactNode, label: string, fn: () => void) => (
    <div className="menu-item" onClick={() => (setOpen(false), fn())}>
      {icon}
      {label}
    </div>
  );
  return (
    <div className="profile-wrap" ref={ref}>
      {open && (
        <div className="menu profile-menu">
          {(props.plan || props.limits?.length) && (
            <div className="profile-limits" onClick={() => (setOpen(false), props.onUsage())} style={{ cursor: 'pointer' }}>
              {props.plan && <div className="small" style={{ fontWeight: 600, marginBottom: props.limits?.length ? 8 : 0 }}>{props.plan}</div>}
              <LimitBars limits={props.limits} />
              {props.limits?.length ? <LimitsFreshness status={props.limitsStatus} compact /> : null}
            </div>
          )}
          {item(<UserRound size={15} />, 'Edit profile', props.onEdit)}
          {item(<Gauge size={15} />, 'Usage', props.onUsage)}
          {item(<Brain size={15} />, 'Shared memory', props.onMemory)}
          {item(<SettingsIcon size={15} />, 'Settings', props.onSettings)}
          {props.lockEnabled && item(<Lock size={15} />, `Lock now (${keys('⌘L')})`, () => void api.lockNow())}
        </div>
      )}
      <button className="profile-btn" onClick={() => setOpen((o) => !o)} data-testid="profile-button">
        <Avatar profile={p} />
        <span className="col grow" style={{ gap: 0, minWidth: 0, alignItems: 'flex-start' }}>
          <span className="ellipsis" style={{ fontWeight: 600, maxWidth: '100%' }}>
            {p.name || 'Set up your profile'}
          </span>
          {(p.role || p.email) && <span className="small muted ellipsis" style={{ maxWidth: '100%' }}>{p.role || p.email}</span>}
        </span>
        <ChevronUp size={14} className="muted" />
      </button>
    </div>
  );
}

/** Resize a picked image to a small square data URL, so it can live in settings.json. */
function toAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 160;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d')!;
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

const COLORS = ['#d97757', '#e5484d', '#f5a524', '#30a46c', '#1f7ae0', '#7c4dff', '#d6409f', '#6b6b76'];

export function ProfileModal({ profile, onSave, onClose }: { profile: UserProfile; onSave: (p: UserProfile) => Promise<void>; onClose: () => void }) {
  const [p, setP] = useState<UserProfile>(profile);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<UserProfile>) => setP((x) => ({ ...x, ...patch }));
  const field = (key: keyof UserProfile, label: string, placeholder: string, type = 'text') => (
    <div className="field" style={{ margin: 0 }}>
      <label>{label}</label>
      <input className="input" type={type} placeholder={placeholder} value={p[key] as string} onChange={(e) => set({ [key]: e.target.value })} />
    </div>
  );
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow">
        <div className="modal-head">
          Profile
          <div className="spacer" />
          <button className="btn ghost icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body col" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 16 }}>
            <div className="avatar-edit" onClick={() => fileInput.current?.click()} title="Change photo">
              <Avatar profile={p} size={72} />
              <span className="avatar-cam">
                <Camera size={14} />
              </span>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) set({ avatar: await toAvatar(f) });
                e.target.value = '';
              }}
            />
            <div className="col" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 6 }}>
                {COLORS.map((c) => (
                  <button key={c} className={`color-dot ${p.avatarColor === c && !p.avatar ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ avatarColor: c, avatar: '' })} />
                ))}
              </div>
              {p.avatar && (
                <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set({ avatar: '' })}>
                  <Trash2 size={13} /> Remove photo
                </button>
              )}
            </div>
          </div>
          <div className="grid-2">
            {field('name', 'Name', 'e.g. Suru')}
            {field('email', 'Email', 'you@example.com', 'email')}
            {field('role', 'Role / title', 'e.g. Founder, Full-stack dev')}
            {field('location', 'Location', 'e.g. Jaipur, India')}
            {field('github', 'GitHub username', 'e.g. octocat')}
            {field('website', 'Website', 'https://…')}
          </div>
          {field('languages', 'Language / writing style', 'e.g. Hinglish, short answers')}
          <div className="field" style={{ margin: 0 }}>
            <label>About you</label>
            <textarea className="textarea" rows={4} placeholder="What you build, which tools and stack you prefer, what agents should know…" value={p.about} onChange={(e) => set({ about: e.target.value })} />
          </div>
          <div className="row">
            <button className={`switch ${p.shareWithAgents ? 'on' : ''}`} onClick={() => set({ shareWithAgents: !p.shareWithAgents })} />
            <span>Share these details with every agent (added to the shared context)</span>
          </div>
          <LearnedNotes on={p.learnAboutUser !== false} onToggle={(on) => set({ learnAboutUser: on })} />
          <p className="small muted" style={{ margin: 0 }}>
            Your profile is saved only on this computer. Agents get it only when the switch above is on.
          </p>
          <div className="row">
            <button
              className="btn primary"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                await onSave(p);
                setSaving(false);
                onClose();
              }}
              data-testid="profile-save"
            >
              Save
            </button>
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const NOTE_LABEL: Record<LearnedNote['section'], string> = {
  communication: 'How you communicate',
  thinking: 'How you think',
  problem_solving: 'How you approach problems',
  interests: 'Interests',
  context: 'Context',
  preferences: 'Preferences',
};

/** What agents noted about the user: grouped, each deletable, with a switch to stop it. */
function LearnedNotes({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  const [notes, setNotes] = useState<LearnedNote[] | null>(null);
  useEffect(() => {
    void api.profileNotes().then(setNotes).catch(() => setNotes([]));
  }, []);
  const groups = (Object.keys(NOTE_LABEL) as LearnedNote['section'][]).map((k) => ({ k, list: (notes ?? []).filter((n) => n.section === k) })).filter((g) => g.list.length);
  return (
    <div className="learned">
      <div className="row" style={{ gap: 10 }}>
        <Sparkles size={15} className="learned-icon" />
        <b className="grow">What agents have learned about you</b>
        <button className={`switch ${on ? 'on' : ''}`} title={on ? 'Agents add notes as they get to know you' : 'Agents don\'t add notes'} onClick={() => onToggle(!on)} />
      </div>
      <p className="small muted" style={{ margin: '4px 0 8px' }}>
        {on
          ? 'As you work, agents note how you talk, think and solve problems, and what interests you, so every new session fits you better. Only from what you say or do; never health, religion, politics, money, family or passwords.'
          : 'Learning is off: agents add no new notes, and the ones below are not shared with them.'}
      </p>
      {notes === null ? null : notes.length ? (
        <div className="learned-groups">
          {groups.map((g) => (
            <div key={g.k} className="learned-group">
              <div className="learned-head">{NOTE_LABEL[g.k]}</div>
              {g.list.map((n) => (
                <div key={n.id} className="learned-note">
                  <span className="grow">{n.text}</span>
                  <button className="btn ghost icon learned-del" title="Forget this" onClick={() => void api.deleteProfileNote(n.id).then(setNotes)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ))}
          <button
            className="link-btn small muted"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => confirm('Forget everything agents have learned about you?') && void api.clearProfileNotes().then(setNotes)}
          >
            Forget all
          </button>
        </div>
      ) : (
        <div className="small muted learned-empty">Nothing yet. Notes appear here as agents learn about you.</div>
      )}
    </div>
  );
}
