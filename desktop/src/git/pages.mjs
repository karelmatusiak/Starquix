// One-click GitHub Pages (D12 + docs/plans/2026-10-14-github-publish-design.md): Pages on → workflow +
// rebase script → version → push. Pages turns on FIRST: a refusal (private repo on the free plan) leaves
// nothing committed, and the first run finds Pages enabled (configure-pages needs it).
// site/base are build FLAGS from configure-pages, never written to the user's astro config: a config
// `base` would move the editor's live canvas (astro dev) and Vercel deploys under /repo/.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { t } from '../i18n.mjs';

/** Ours, never `deploy.yml`: Astro's own Pages guide uses that name, and github.mjs reads THIS workflow's runs. */
export const PAGES_WORKFLOW = 'starquix-pages.yml';
/** The branch Pages shows (docs/plans/2026-10-20-publish-branch-selection-design.md B1): a GitHub repository variable,
 *  unset = the default branch. On GitHub, never local: the workflow reads it, and every computer sees the same choice. */
export const PAGES_BRANCH_VAR = 'STARQUIX_PAGES_BRANCH';
const fail = (code, message, extra) => Object.assign(new Error(t(message)), { code }, extra);
const REBASE_SOURCE = fs.readFileSync(new URL('./pages-rebase.mjs', import.meta.url), 'utf8');

/** Own steps instead of withastro/action: imported projects often have no lockfile, and their
 *  `build` script may run `astro check` (type errors would block a deploy). It runs on every push but
 *  builds only the SITE branch (STARQUIX_PAGES_BRANCH, else the default branch; B2) — the one the github-pages
 *  environment lets deploy (B3) — so no branch name is baked in and every branch carries the same bytes.
 *  configure-pages reports the real origin and base path (empty for
 *  <user>.github.io or a custom domain); the rebase step then points the root URLs Astro leaves in HTML
 *  (`<img src="/assets/…">`, `href="/about"`) at that base. Every action is a Node 24 major (GitHub retired
 *  Node 20 for actions); setup-node's automatic package cache stays off (it wants a lockfile), and
 *  dotfiles (`public/.well-known`) still deploy, as before upload-pages-artifact v4 dropped them. The build runs on
 *  Node 24: Astro 7 needs ≥22.23.4, newer than many hosts' 22.x. */
export function workflowYaml() {
  return `# Written by Webdílna (Publish → GitHub Pages). Builds the branch Publish picked (STARQUIX_PAGES_BRANCH), else the default branch, on every push.
name: Deploy to GitHub Pages
on:
  push:
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  build:
    if: github.ref_name == (vars.${PAGES_BRANCH_VAR} || github.event.repository.default_branch)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          package-manager-cache: false
      - id: pages
        uses: actions/configure-pages@v6
      - run: npm install
      - run: npx astro build --site "$SITE" \${BASE:+--base "$BASE"}
        env:
          SITE: \${{ steps.pages.outputs.origin }}
          BASE: \${{ steps.pages.outputs.base_path }}
      - run: node .github/starquix/rebase.mjs dist "$BASE"
        env:
          BASE: \${{ steps.pages.outputs.base_path }}
      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist
          include-hidden-files: true
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
`;
}

const pagesFiles = () => [[`.github/workflows/${PAGES_WORKFLOW}`, workflowYaml()], ['.github/starquix/rebase.mjs', REBASE_SOURCE]];

/** Writes the workflow + rebase script where they differ; true when anything was written (the editor re-mirrors). */
export async function writePagesFiles(dir) {
  let wrote = false;
  for (const [rel, text] of pagesFiles()) {
    const file = path.join(dir, rel);
    if (await fsp.readFile(file, 'utf8').catch(() => null) === text) continue;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text);
    wrote = true;
  }
  return wrote;
}

/** True when both Pages files on disk are exactly what Publish writes (missing/old = an unpublished change). */
export async function pagesFilesCurrent(dir) {
  for (const [rel, text] of pagesFiles()) {
    if (await fsp.readFile(path.join(dir, rel), 'utf8').catch(() => null) !== text) return false;
  }
  return true;
}

/** A repo's own workflow that deploys Pages (docs/plans/2026-10-18-publish-into-existing-repo-design.md E5), or null.
 *  It stays the deployer: Publish never adds ours beside it (two would race for the same site). */
export const deploysPages = text => /\bactions\/deploy-pages@/.test(text ?? '');
export async function ownPagesWorkflow(dir) {
  const at = path.join(dir, '.github/workflows');
  const names = (await fsp.readdir(at).catch(() => [])).filter(f => /\.ya?ml$/.test(f) && f !== PAGES_WORKFLOW).sort();
  for (const f of names) if (deploysPages(await fsp.readFile(path.join(at, f), 'utf8').catch(() => null))) return f;
  return null;
}

export function createPages({ github }) {
  /** GitHub's side of a site-branch switch (B1/B3, ledger 14–19): reads first and refuses before any write; then only the
   *  writes needed — allow `branch` in github-pages → the variable (unset for the default branch `live`) → drop the exact
   *  entry of the branch it leaves, so exactly the site branch may deploy. */
  async function setSiteBranch({ owner, repo, branch, live }) {
    const [rule, picked] = await Promise.all([github.pagesRule(owner, repo), github.pagesBranch(owner, repo)]);
    if (rule.mode === 'protected' && branch !== live) {
      throw fail('pages-protected', 'GitHub Pages here only publishes protected branches.', { settingsUrl: `https://github.com/${owner}/${repo}/settings/environments` });
    }
    const listed = rule.list?.some(p => p.name === branch);
    if ((rule.mode === 'list' && !listed) || (rule.mode === 'missing' && branch !== live)) await github.allowPages(owner, repo, branch, rule.mode === 'missing');
    const want = branch === live ? null : branch;
    if (picked !== want) await github.setPagesBranch(owner, repo, want);
    const prev = picked ?? live;
    const left = prev !== branch && rule.list?.find(p => p.name === prev);
    if (left) await github.disallowPages(owner, repo, left.id);
  }
  /** The caller (ops.setHost) saves the user's edits first, so they never ride in this version.
   *  `own` = the repo's own Pages workflow deploys: Pages is turned on, nothing is written.
   *  `branch` = the branch you're on: it becomes the site branch (B5) before anything is pushed.
   *  Returns whether files were written. */
  async function enable({ engine, owner, repo, author, own = false, branch, live }) {
    await github.enablePages(owner, repo);
    if (own) return false;
    await setSiteBranch({ owner, repo, branch, live });
    const wrote = await writePagesFiles(engine.dir);
    await engine.save('Enable GitHub Pages', author).catch(e => { if (e.code !== 'nothing') throw e; });
    await engine.push();
    return wrote;
  }
  return { enable, setSiteBranch };
}
