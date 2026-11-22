/* Olympus Coder — Agent brand catalog + marquee & filterable logo card renderer */
(() => {
  const AGENTS = [
    { name: 'Claude Code', logo: 'claudecode', tag: 'built-in', badge: 'ACP Native', cats: ['builtin'], desc: 'Native ACP, parallel sub-sessions, worktree chats & hooks.' },
    { name: 'Google Antigravity', logo: 'antigravity', tag: 'built-in', badge: 'Free Google Quota', cats: ['builtin', 'quota'], desc: 'Personal Google quota across Gemini & frontier models.' },
    { name: 'OpenAI Codex', logo: 'codex', tag: 'built-in', badge: 'ChatGPT Free', cats: ['builtin', 'quota'], desc: 'ChatGPT Free / Plus CLI allowance & device-code login.' },
    { name: 'Olympus CLI (oly)', logo: 'olympus', tag: 'built-in', badge: 'Ollama + OpenRouter', cats: ['builtin', 'local'], desc: 'Unlimited local Ollama, OpenRouter :free & BYO API keys.' },
    { name: 'Qwen Code', logo: 'qwen', tag: 'npx / cli', badge: '2,000 req/day', cats: ['quota'], desc: '2,000 free requests / day (~1.5B tokens/mo coding context).' },
    { name: 'Gemini CLI', logo: 'geminicli', tag: 'npx / cli', badge: '~1,000 req/day', cats: ['quota'], desc: '~1,000 free requests / day on personal Google accounts.' },
    { name: 'iFlow CLI', logo: 'iflow', tag: 'npx / cli', badge: 'Uncapped Free', cats: ['quota'], desc: 'Uncapped free hosted Kimi K2, Qwen3 Coder & DeepSeek-V3.' },
    { name: 'OpenCode', logo: 'opencode', mono: true, tag: 'binary', badge: '12 $0 Models', cats: ['quota', 'local'], desc: '12 zero-key $0 built-in models ready out of the box.' },
    { name: 'GitHub Copilot', logo: 'githubcopilot', mono: true, tag: 'npx / cli', badge: 'Copilot Free', cats: ['quota'], desc: 'Copilot Free monthly agent requests + completions.' },
    { name: 'Kiro CLI', logo: 'kiro', tag: 'binary', badge: 'AWS Builder ID', cats: ['quota'], desc: 'AWS Builder ID Free Tier (50 agentic interactions/mo).' },
    { name: 'Kilo', logo: 'kilocode', mono: true, tag: 'binary / npx', badge: '$0 Community', cats: ['quota'], desc: 'Free signup credits + $0 free community coding models.' },
    { name: 'Cline', logo: 'cline', mono: true, tag: 'npx / cli', badge: 'Free + BYO', cats: ['quota'], desc: 'Free models, starter credits & Keychain BYO keys.' },
    { name: 'Cursor', logo: 'cursor', mono: true, tag: 'binary', badge: 'Hobby Tier', cats: ['quota'], desc: 'Cursor Free / Hobby monthly agent request allowance.' },
    { name: 'Codebuddy', logo: 'codebuddy', tag: 'npx / cli', badge: 'Auto Routing', cats: ['quota'], desc: 'Tencent Cloud free tier with Auto model routing.' },
    { name: 'Qoder CLI', logo: 'qoder', mono: true, tag: 'npx / cli', badge: 'Community Free', cats: ['quota'], desc: 'Community Free Edition + 14-day Pro trial credits.' },
    { name: 'Mistral Vibe', logo: 'mistral', tag: 'binary', badge: 'Experiment Tier', cats: ['quota'], desc: 'Mistral La Plateforme free Experiment API tier.' },
    { name: 'ZCode', logo: 'zai', mono: true, tag: 'npx bridge', badge: 'GLM Free Plan', cats: ['quota'], desc: 'Z.ai zai-start-plan free GLM coding tier.' },
    { name: 'Goose', logo: 'goose', mono: true, tag: 'binary', badge: 'Local + BYO', cats: ['local'], desc: 'Open-source agent ($0 with Ollama or free API keys).' },
    { name: 'OpenHands', logo: 'openhands', tag: 'uvx / cli', badge: 'Open Source', cats: ['local'], desc: 'Open-source agent ($0 with Ollama or free Gemini keys).' },
    { name: 'Local Ollama', logo: 'ollama', mono: true, tag: 'local $0', badge: '100% Offline', cats: ['local'], desc: 'Unlimited local coding models via oly, Goose, or OpenHands.' },
  ];

  const iconHtml = (a, cls = 'agent-ico') =>
    `<img class="${cls}${a.mono ? ' mono' : ''}" src="logos/${a.logo}.svg" alt="${a.name} logo" width="18" height="18" loading="lazy" />`;

  const row1 = document.getElementById('marquee-row-1');
  const row2 = document.getElementById('marquee-row-2');
  if (row1 && row2) {
    const first = AGENTS.slice(0, 10);
    const second = AGENTS.slice(10);
    const pill = (a) => `<span class="m-pill">${iconHtml(a)}<strong>${a.name}</strong><span>${a.badge}</span></span>`;
    row1.innerHTML = [...first, ...first].map(pill).join('');
    row2.innerHTML = [...second, ...second].map(pill).join('');
  }

  const grid = document.getElementById('agent-grid');
  if (grid) {
    grid.innerHTML = AGENTS.map(
      (a) => `
      <div class="agent-card" data-cats="${a.cats.join(' ')}">
        <div class="agent-top">
          <div class="agent-id">
            <span class="logo-tile">${iconHtml(a)}</span>
            <strong>${a.name}</strong>
          </div>
          <span class="agent-tag">${a.tag}</span>
        </div>
        <p>${a.desc}</p>
      </div>`,
    ).join('');
  }

  // Wire filter pills after rendering cards
  const filterBtns = [...document.querySelectorAll('[data-filter]')];
  const agentCards = [...document.querySelectorAll('.agent-card')];
  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.filter || 'all';
      filterBtns.forEach((b) => b.classList.toggle('active', b === btn));
      agentCards.forEach((card) => {
        const cats = (card.dataset.cats || '').split(' ');
        card.classList.toggle('hidden', cat !== 'all' && !cats.includes(cat));
      });
    });
  });
})();
