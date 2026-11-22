/* Interactive controls for Olympus Coder GitHub Pages site */
(() => {
  const root = document.documentElement;
  const saved = localStorage.getItem('olympus-site-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = saved || (prefersDark ? 'dark' : 'light');

  const phImg = document.getElementById('ph-badge-img');
  const themeBtn = document.getElementById('theme-toggle');
  const shotImg = document.getElementById('showcase-img');
  const shotCaption = document.getElementById('showcase-caption');

  function applyTheme(theme) {
    root.dataset.theme = theme;
    if (themeBtn) {
      themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
    }
    if (phImg) {
      const base = phImg.dataset.baseSrc;
      phImg.src = `${base}&theme=${theme === 'dark' ? 'dark' : 'light'}`;
    }
  }

  applyTheme(initialTheme);

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('olympus-site-theme', next);
      applyTheme(next);
    });
  }

  // Install command switcher
  const installCommands = {
    brew: {
      code: 'brew trust martianacademy/tap\nbrew install --cask martianacademy/tap/olympus-coder',
      note: 'macOS Apple Silicon · Official Homebrew tap (martianacademy/homebrew-tap).',
    },
    vps: {
      code: 'curl -fsSL https://raw.githubusercontent.com/martianacademy/olympus-coder/main/scripts/install-server.sh | sh\nolympus-server serve --relay --project .',
      note: 'Pure Node.js headless server for Linux VPS & remote Macs — zero Electron or X11 required.',
    },
    dmg: {
      code: 'xattr -dr com.apple.quarantine "/Applications/Olympus Coder.app"',
      note: 'Download Olympus.Coder-0.3.2-arm64.dmg from Releases, drag to Applications, then run once (ad-hoc signed).',
    },
  };

  const installPre = document.getElementById('install-code');
  const installNote = document.getElementById('install-note');
  const copyBtn = document.getElementById('copy-install');
  const installTabs = [...document.querySelectorAll('.install-tab')];

  function selectInstall(key) {
    const item = installCommands[key];
    if (!item || !installPre || !installNote) return;
    installPre.textContent = item.code;
    installNote.textContent = item.note;
    installTabs.forEach((b) => b.classList.toggle('active', b.dataset.install === key));
    if (copyBtn) copyBtn.textContent = 'Copy';
  }

  installTabs.forEach((btn) => {
    btn.addEventListener('click', () => selectInstall(btn.dataset.install));
  });

  if (copyBtn && installPre) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(installPre.textContent || '');
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1600);
      } catch {
        copyBtn.textContent = 'Select & copy';
      }
    });
  }

  // Screenshot gallery switcher
  const galleryTabs = [...document.querySelectorAll('.gallery-tab')];
  galleryTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!shotImg || !shotCaption) return;
      shotImg.src = btn.dataset.src || '';
      shotImg.alt = btn.dataset.alt || '';
      shotCaption.textContent = btn.dataset.caption || '';
      galleryTabs.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  // Match initial hero screenshot to system theme if user lands in light mode
  if (initialTheme === 'light' && shotImg && shotCaption) {
    const lightBtn = galleryTabs.find((b) => b.dataset.src === 'screenshots/light-mode.png');
    if (lightBtn) lightBtn.click();
  }
})();
