import type { AuthVarView } from '@shared/acpConfig';

/**
 * Static CLI authentication metadata for built-in and ACP registry coding agents:
 *  - Default API-key environment variable names (`KNOWN_KEY_VARS`, `METHOD_ID_VAR`)
 *  - Interactive CLI sign-in subcommands (`CLI_TERMINAL_LOGINS`)
 *  - Encrypted environment-variable credential fallbacks (`CLI_ENV_FALLBACKS`)
 *  - Pure stdio ACP wrappers that have no standalone interactive TUI (`PURE_ACP_WRAPPERS`)
 */

/** Env var of an API-key method that does not name its own (the agents' documented variables). */
export const KNOWN_KEY_VARS: Record<string, string> = {
  olympus: 'OPENROUTER_API_KEY',
  codex: 'CODEX_API_KEY',
  antigravity: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'qwen-code': 'DASHSCOPE_API_KEY',
  iflow: 'IFLOW_API_KEY',
  'codebuddy-code': 'CODEBUDDY_API_KEY',
  qoder: 'QODER_PERSONAL_ACCESS_TOKEN',
  openhands: 'LLM_API_KEY',
  'mistral-vibe': 'MISTRAL_API_KEY',
  kimi: 'KIMI_API_KEY',
  'kimi-code': 'KIMI_API_KEY',
  'minimax-code': 'MINIMAX_API_KEY',
  'glm-acp-agent': 'ZHIPU_API_KEY',
  zcode: 'ZAI_API_KEY',
  'grok-build': 'XAI_API_KEY',
  kilo: 'KILOCODE_TOKEN',
  opencode: 'ANTHROPIC_API_KEY',
  'opencode-v2': 'ANTHROPIC_API_KEY',
  goose: 'OPENAI_API_KEY',
  cline: 'ANTHROPIC_API_KEY',
  'amp-acp': 'AMP_API_KEY',
  'factory-droid': 'FACTORY_API_KEY',
  auggie: 'AUGMENT_SESSION_AUTH',
  deepagents: 'OPENAI_API_KEY',
  dirac: 'ANTHROPIC_API_KEY',
};

export const METHOD_ID_VAR: [RegExp, string][] = [
  [/^gemini[-_ ]?api[-_ ]?key$/i, 'GEMINI_API_KEY'],
  [/^openai[-_ ]?api[-_ ]?key$/i, 'OPENAI_API_KEY'],
  [/^anthropic[-_ ]?api[-_ ]?key$/i, 'ANTHROPIC_API_KEY'],
  [/^mistral[-_ ]?api[-_ ]?key$/i, 'MISTRAL_API_KEY'],
  [/^openrouter(?:[-_ ]?api[-_ ]?key)?$/i, 'OPENROUTER_API_KEY'],
  [/^ai[-_ ]?gateway(?:[-_ ]?api[-_ ]?key)?$/i, 'AI_GATEWAY_API_KEY'],
  [/^dashscope[-_ ]?api[-_ ]?key$/i, 'DASHSCOPE_API_KEY'],
  [/^iflow[-_ ]?api[-_ ]?key$/i, 'IFLOW_API_KEY'],
  [/^codebuddy[-_ ]?api[-_ ]?key$/i, 'CODEBUDDY_API_KEY'],
  [/^qoder[-_ ]?(?:token|pat|api[-_ ]?key)$/i, 'QODER_PERSONAL_ACCESS_TOKEN'],
  [/^(?:openhands|llm)[-_ ]?api[-_ ]?key$/i, 'LLM_API_KEY'],
  [/^(?:kimi|moonshot)[-_ ]?api[-_ ]?key$/i, 'KIMI_API_KEY'],
  [/^(?:xai|grok)[-_ ]?api[-_ ]?key$/i, 'XAI_API_KEY'],
  [/^(?:zhipu|zai|glm)[-_ ]?api[-_ ]?key$/i, 'ZHIPU_API_KEY'],
  [/^minimax[-_ ]?api[-_ ]?key$/i, 'MINIMAX_API_KEY'],
];

/** Interactive CLI login subcommands for registry agents (run directly against the CLI without `acp` flags). */
export const CLI_TERMINAL_LOGINS: Record<string, { name: string; description: string; args: string[] }> = {
  goose: { name: 'Configure Goose in terminal', description: 'Runs `goose configure` interactively to pick your AI provider and API key.', args: ['configure'] },
  opencode: { name: 'Sign in via OpenCode CLI', description: 'Runs `opencode auth login` interactively to connect free models, GitHub Copilot, Anthropic, OpenAI, or OpenRouter.', args: ['auth', 'login'] },
  'opencode-v2': { name: 'Sign in via OpenCode CLI', description: 'Runs `opencode auth login` interactively to connect free models, GitHub Copilot, Anthropic, OpenAI, or OpenRouter.', args: ['auth', 'login'] },
  kilo: { name: 'Sign in via Kilo CLI', description: 'Runs `kilo auth login` interactively in a terminal.', args: ['auth', 'login'] },
  iflow: { name: 'Sign in via iFlow CLI', description: 'Opens the interactive iFlow CLI to sign in with your free iFlow account or `/auth`.', args: [] },
  'codebuddy-code': { name: 'Sign in via CodeBuddy CLI', description: 'Runs `codebuddy login` interactively to sign in with your CodeBuddy / Tencent Cloud account.', args: ['login'] },
  qoder: { name: 'Sign in via Qoder CLI', description: 'Runs `qodercli login` interactively to sign in with your Qoder account in the browser.', args: ['login'] },
  openhands: { name: 'Sign in via OpenHands CLI', description: 'Runs `openhands login` interactively to connect OpenHands Cloud or configure settings.', args: ['login'] },
  kimi: { name: 'Sign in via Kimi CLI', description: 'Runs `kimi login` interactively in a terminal.', args: ['login'] },
  'kimi-code': { name: 'Sign in via Kimi Code CLI', description: 'Runs `kimi login` interactively in a terminal.', args: ['login'] },
  gemini: { name: 'Sign in via Gemini CLI', description: 'Opens the interactive Gemini CLI to sign in with Google (`/auth`).', args: [] },
  'qwen-code': { name: 'Sign in via Qwen Code CLI', description: 'Opens the interactive Qwen Code CLI to sign in with Qwen OAuth (free daily quota).', args: [] },
  'github-copilot-cli': { name: 'Sign in via GitHub Copilot CLI', description: 'Runs `copilot login` interactively to authenticate with GitHub (supports Copilot Free).', args: ['login'] },
  cursor: { name: 'Sign in via Cursor CLI', description: 'Runs `cursor-agent login` interactively in a terminal.', args: ['login'] },
  cline: { name: 'Sign in via Cline CLI', description: 'Runs `cline auth` interactively to connect your Cline account or API provider.', args: ['auth'] },
  kiro: { name: 'Sign in via Kiro CLI', description: 'Runs `kiro-cli login` interactively to sign in with AWS Builder ID, Google, or GitHub.', args: ['login'] },
  auggie: { name: 'Sign in via Auggie CLI', description: 'Runs `auggie login` interactively in a terminal.', args: ['login'] },
  'factory-droid': { name: 'Sign in via Factory Droid CLI', description: 'Opens `droid` interactively in a terminal to sign in.', args: [] },
  'grok-build': { name: 'Sign in via Grok CLI', description: 'Opens `grok` interactively in a terminal to sign in.', args: [] },
  'amp-acp': { name: 'Sign in via Amp CLI', description: 'Opens `amp` login interactively in a terminal.', args: ['login'] },
  devin: { name: 'Sign in via Devin CLI', description: 'Runs `devin login` interactively in a terminal.', args: ['login'] },
};

/**
 * Additional interactive terminal login methods offered alongside an agent's default sign-in
 * (e.g. GitHub Copilot `--device-code` so users can choose a different GitHub account / browser profile or sign in from a phone).
 */
export const CLI_EXTRA_TERMINAL_LOGINS: Record<string, { id: string; name: string; description: string; args: string[] }[]> = {
  'github-copilot-cli': [
    {
      id: '__olympus_copilot_device_code',
      name: 'Sign in with GitHub device code',
      description: 'Runs `copilot login --device-code` so you can pick any GitHub account, browser profile, or sign in from a phone.',
      args: ['login', '--device-code'],
    },
  ],
};

/** Interactive CLI logout subcommands for agents whose ACP servers do not advertise `agentCapabilities.auth.logout`. */
export const CLI_TERMINAL_LOGOUTS: Record<string, string[]> = {
  opencode: ['auth', 'logout'],
  'opencode-v2': ['auth', 'logout'],
  kilo: ['auth', 'logout'],
};

/** Interactive CLI account-switch subcommands for multi-account agents (`opencode auth switch`). */
export const CLI_TERMINAL_SWITCHES: Record<string, string[]> = {
  opencode: ['auth', 'switch'],
  'opencode-v2': ['auth', 'switch'],
};

/** Environment variable credentials supported by registry CLIs (stored encrypted and injected on start). */
export const CLI_ENV_FALLBACKS: Record<string, { name: string; description?: string; link?: string; vars: AuthVarView[] }> = {
  iflow: {
    name: 'iFlow / OpenAI-compatible API key',
    description: 'Use your free iFlow API key (`IFLOW_API_KEY`) or a custom OpenAI-compatible key.',
    link: 'https://cloud.iflow.cn/',
    vars: [
      { name: 'IFLOW_API_KEY', label: 'iFlow API key', secret: true, optional: true },
      { name: 'OPENAI_API_KEY', label: 'OpenAI-compatible API key (optional)', secret: true, optional: true },
      { name: 'OPENAI_BASE_URL', label: 'OpenAI Base URL (optional)', secret: false, optional: true },
    ],
  },
  'codebuddy-code': {
    name: 'CodeBuddy API key',
    description: 'Use a CodeBuddy API key (`CODEBUDDY_API_KEY`).',
    link: 'https://www.codebuddy.ai/',
    vars: [{ name: 'CODEBUDDY_API_KEY', label: 'CodeBuddy API key', secret: true, optional: false }],
  },
  qoder: {
    name: 'Qoder Personal Access Token',
    description: 'Authenticate headlessly with a Qoder Personal Access Token (`QODER_PERSONAL_ACCESS_TOKEN`).',
    link: 'https://qoder.com',
    vars: [{ name: 'QODER_PERSONAL_ACCESS_TOKEN', label: 'Qoder Personal Access Token', secret: true, optional: false }],
  },
  openhands: {
    name: 'LLM / Provider API key',
    description: 'Pass an OpenHands Cloud or direct model provider key (e.g. free Gemini or OpenRouter key).',
    link: 'https://app.all-hands.dev/settings/api-keys',
    vars: [
      { name: 'LLM_API_KEY', label: 'LLM / OpenHands API key', secret: true, optional: true },
      { name: 'LLM_MODEL', label: 'Model ID (optional, e.g. gemini/gemini-2.5-flash)', secret: false, optional: true },
      { name: 'LLM_BASE_URL', label: 'Custom Base URL (optional)', secret: false, optional: true },
      { name: 'GEMINI_API_KEY', label: 'Google Gemini API key', secret: true, optional: true },
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, optional: true },
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: true },
      { name: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true, optional: true },
    ],
  },
  zcode: {
    name: 'Z.AI / Zhipu API key (optional)',
    description: 'ZCode normally uses your signed-in ZCode desktop app session; you can also provide a Z.AI or Zhipu API key.',
    vars: [
      { name: 'ZAI_API_KEY', label: 'Z.AI API key', secret: true, optional: true },
      { name: 'ZHIPU_API_KEY', label: 'Zhipu API key', secret: true, optional: true },
    ],
  },
  'mistral-vibe': {
    name: 'Mistral API key',
    description: 'Use a Mistral AI Studio / La Plateforme API key (`MISTRAL_API_KEY`, free Experiment tier available).',
    link: 'https://console.mistral.ai/api-keys',
    vars: [{ name: 'MISTRAL_API_KEY', label: 'Mistral API key', secret: true, optional: false }],
  },
  goose: {
    name: 'Provider & API key (environment)',
    description: 'Set Goose’s provider and API key directly without running the interactive wizard.',
    vars: [
      { name: 'GOOSE_PROVIDER', label: 'Provider (e.g. openai, anthropic, google, openrouter, ollama)', secret: false, optional: false },
      { name: 'GOOSE_MODEL', label: 'Model (optional, e.g. gpt-4o, claude-sonnet-4-0, gemini-2.5-pro)', secret: false, optional: true },
      { name: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true, optional: true },
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: true },
      { name: 'GOOGLE_API_KEY', label: 'Google Gemini API key', secret: true, optional: true },
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, optional: true },
    ],
  },
  opencode: {
    name: 'Provider API key',
    description: 'Enter one or more provider API keys for OpenCode (built-in free models work without any key).',
    vars: [
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: true },
      { name: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true, optional: true },
      { name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: true },
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, optional: true },
    ],
  },
  'opencode-v2': {
    name: 'Provider API key',
    description: 'Enter one or more provider API keys for OpenCode (built-in free models work without any key).',
    vars: [
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: true },
      { name: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true, optional: true },
      { name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: true },
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, optional: true },
    ],
  },
  kilo: {
    name: 'Kilo / Provider API key',
    description: 'Sign in with a Kilo token or direct provider API key.',
    vars: [
      { name: 'KILOCODE_TOKEN', label: 'Kilo Code token', secret: true, optional: true },
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, optional: true },
      { name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: true },
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: true },
      { name: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true, optional: true },
    ],
  },
  kimi: {
    name: 'Kimi / Moonshot API key',
    vars: [
      { name: 'KIMI_API_KEY', label: 'Kimi API key', secret: true, optional: true },
      { name: 'MOONSHOT_API_KEY', label: 'Moonshot API key', secret: true, optional: true },
    ],
  },
  'kimi-code': {
    name: 'Kimi / Moonshot API key',
    vars: [
      { name: 'KIMI_API_KEY', label: 'Kimi API key', secret: true, optional: true },
      { name: 'MOONSHOT_API_KEY', label: 'Moonshot API key', secret: true, optional: true },
    ],
  },
  gemini: {
    name: 'Gemini API key',
    link: 'https://aistudio.google.com/apikey',
    vars: [{ name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: false }],
  },
  'qwen-code': {
    name: 'DashScope / OpenAI-compatible API key',
    vars: [
      { name: 'DASHSCOPE_API_KEY', label: 'DashScope API key', secret: true, optional: true },
      { name: 'OPENAI_API_KEY', label: 'OpenAI-compatible API key', secret: true, optional: true },
      { name: 'OPENAI_BASE_URL', label: 'OpenAI Base URL (optional)', secret: false, optional: true },
      { name: 'OPENAI_MODEL', label: 'Model ID (optional)', secret: false, optional: true },
    ],
  },
  'minimax-code': {
    name: 'MiniMax API key',
    vars: [{ name: 'MINIMAX_API_KEY', label: 'MiniMax API key', secret: true, optional: false }],
  },
  'glm-acp-agent': {
    name: 'Zhipu / Z.AI API key',
    vars: [
      { name: 'ZHIPU_API_KEY', label: 'Zhipu API key', secret: true, optional: true },
      { name: 'ZAI_API_KEY', label: 'Z.AI API key', secret: true, optional: true },
    ],
  },
  'grok-build': {
    name: 'xAI API key',
    vars: [{ name: 'XAI_API_KEY', label: 'xAI API key', secret: true, optional: false }],
  },
  'github-copilot-cli': {
    name: 'GitHub Personal Access Token',
    vars: [{ name: 'GITHUB_TOKEN', label: 'GitHub token (Copilot scope)', secret: true, optional: false }],
  },
  cline: {
    name: 'Provider API key',
    vars: [
      { name: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', secret: true, optional: true },
      { name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: true },
      { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: true },
      { name: 'OPENAI_API_KEY', label: 'OpenAI API key', secret: true, optional: true },
    ],
  },
};

export const PURE_ACP_WRAPPERS = new Set([
  'mistral-vibe',
  'amp-acp',
  'claude-acp',
  'codex-acp',
  'antigravity-acp',
  'corust-agent',
  'glm-acp-agent',
  'pi-acp',
  'deepagents',
  'zcode',
]);
