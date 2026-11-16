# Contributing to Olympus Coder

Thanks for helping. Olympus Coder is open source under the [Apache License 2.0](LICENSE): what you contribute is licensed under the same terms (Apache-2.0, section 5).

## Before you open a pull request

1. **One change per PR.** Keep it focused and describe what it fixes or adds and how you checked it.
2. **Build and test locally** (see [Development](README.md) in the README):
   ```bash
   npm install
   npm run typecheck
   npx electron-vite build
   for t in tests/*.unit.mjs; do node "$t" || exit 1; done
   ```
3. **Match the surrounding code.** Same naming, comment density and formatting as the file you touch. UI text is English, calm and short.
4. **No secrets or personal paths** in code, tests or screenshots.

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Add a sign-off to every commit to confirm you wrote the change (or have the right to submit it) under the project's license:

```bash
git commit -s -m "Fix the update banner on phones"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line.

## Reporting bugs and security issues

- **Bugs and ideas:** open a GitHub issue with steps to reproduce, what you expected and what happened, plus your OS and agent (Claude Code, Codex, Antigravity…).
- **Security issues:** please do not open a public issue. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability**) on this repository.
