/* Interactive controls, live GitHub stars, scroll reveals & spotlight for Olympus Coder */
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

  // Live GitHub star count (cached 10 minutes in sessionStorage to avoid rate limits)
  function renderStars(count) {
    const label = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
    document.querySelectorAll('[data-gh-stars]').forEach((el) => {
      el.textContent = label;
    });
  }

  async function loadGitHubStars() {
    const CACHE_KEY = 'olympus-gh-stars-v1';
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (cached && typeof cached.stars === 'number' && Date.now() - cached.ts < 600_000) {
        renderStars(cached.stars);
        return;
      }
    } catch {}
    try {
      const res = await fetch('https://api.github.com/repos/martianacademy/olympus-coder', {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.stargazers_count === 'number') {
        renderStars(data.stargazers_count);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ stars: data.stargazers_count, ts: Date.now() }));
        } catch {}
      }
    } catch {}
  }
  void loadGitHubStars();

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
    win: {
      code: 'iwr https://github.com/martianacademy/olympus-coder/releases/latest/download/Olympus.Coder.Setup.0.3.9.exe -OutFile OlympusCoderSetup.exe\n.\\OlympusCoderSetup.exe',
      note: 'Windows 10/11 x64 (PowerShell). Not code-signed yet: on the SmartScreen prompt choose "More info" → "Run anyway".',
    },
    linux: {
      code: 'curl -LO https://github.com/martianacademy/olympus-coder/releases/latest/download/olympus-coder_0.3.9_amd64.deb\nsudo apt install ./olympus-coder_0.3.9_amd64.deb',
      note: 'Debian/Ubuntu x64. Other distros: Olympus.Coder-0.3.9.AppImage from Releases (chmod +x; needs libfuse2).',
    },
    dmg: {
      code: 'xattr -dr com.apple.quarantine "/Applications/Olympus Coder.app"',
      note: 'Download Olympus.Coder-0.3.9-arm64.dmg from Releases, drag to Applications, then run once (ad-hoc signed).',
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

  installTabs.forEach((btn) => btn.addEventListener('click', () => selectInstall(btn.dataset.install)));

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

  if (initialTheme === 'light' && shotImg && shotCaption) {
    const lightBtn = galleryTabs.find((b) => b.dataset.src === 'screenshots/light-mode.png');
    if (lightBtn) lightBtn.click();
  }

  // Phone view switcher
  const phoneImg = document.getElementById('phone-shot-img');
  const phoneBtns = [...document.querySelectorAll('[data-phone-src]')];
  phoneBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!phoneImg) return;
      phoneImg.src = btn.dataset.phoneSrc || '';
      phoneBtns.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  // Subtle cursor spotlight on Bento cards
  document.querySelectorAll('.bento-card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      card.style.setProperty('--my', `${e.clientY - rect.top}px`);
    });
  });

  // Scroll-reveal observer (staggered)
  const reveals = [...document.querySelectorAll('.reveal')];
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -30px 0px' },
    );
    reveals.forEach((el, idx) => {
      el.style.transitionDelay = `${Math.min((idx % 4) * 70, 210)}ms`;
      io.observe(el);
    });
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }
})();

// Point the main Download buttons at this visitor's OS (macOS stays the default; Apple Silicon vs Intel is not detectable).
(() => {
  const ua = navigator.userAgent;
  const base = 'https://github.com/martianacademy/olympus-coder/releases/latest/download/';
  const pick = /Windows/i.test(ua)
    ? ['Olympus.Coder.Setup.0.3.9.exe', 'Windows']
    : /Linux/i.test(ua) && !/Android/i.test(ua)
      ? ['olympus-coder_0.3.9_amd64.deb', 'Linux']
      : null;
  if (!pick) return;
  document.querySelectorAll('[data-download]').forEach((a) => {
    a.href = base + pick[0];
    a.textContent = `Download for ${pick[1]} (v0.3.9)`;
  });
})();
