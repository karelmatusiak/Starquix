// GitHub REST: create/adopt repo, make public, default branch, deploy status, Pages (+ its site branch —
// docs/plans/2026-10-20-publish-branch-selection-design.md), and what Publish into reads (repos, repo, tree, text,
// deployedBy — docs/plans/2026-10-18-publish-into-existing-repo-design.md). No retries.
import { PAGES_BRANCH_VAR, PAGES_WORKFLOW } from './pages.mjs';
import { t } from '../i18n.mjs';

const fail = (code, message, extra) => Object.assign(new Error(t(message)), { code }, extra);

/** owner/repo of a github.com https remote; anything else (a test server) → null. */
export function parseRemote(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url ?? '');
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function createGithub({ fetch = globalThis.fetch, token }) {
  async function api(pathname, init = {}, { allow = [] } = {}) {
    const t = await token();
    if (!t) throw fail('signed-out', 'Sign in to GitHub');
    const r = await fetch(`https://api.github.com${pathname}`, { ...init, headers: { authorization: `Bearer ${t}`,
      accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    if (r.ok || allow.includes(r.status)) return { status: r.status, body: await r.json().catch(() => ({})) };
    if (r.status === 401) throw fail('signed-out', 'Sign in to GitHub again');
    if (r.status === 404 && pathname.startsWith('/repos/')) throw fail('repo-gone', 'The GitHub repository is gone or you lost access');
    throw Object.assign(fail('github', `GitHub answered ${r.status}`), { status: r.status, body: await r.json().catch(() => ({})) });
  }
  const repoOf = b => ({ owner: b.owner.login, repo: b.name, cloneUrl: b.clone_url, htmlUrl: b.html_url });
  async function createRepo({ name, private: isPrivate, owner }) {
    try {
      return repoOf((await api('/user/repos', { method: 'POST', body: JSON.stringify({ name, private: isPrivate, auto_init: false }) })).body);
    } catch (e) {
      if (e.status !== 422) throw e;
      if (!JSON.stringify(e.body).includes('already exists')) throw fail('invalid', e.body?.errors?.[0]?.message ?? e.body?.message ?? 'Invalid repository name');
      // The owner's EMPTY repo of that name is adopted: an interrupted publish, or one made on github.com.
      if (owner && (await api(`/repos/${owner}/${name}/commits?per_page=1`, {}, { allow: [409] })).status === 409) {
        return repoOf((await api(`/repos/${owner}/${name}`)).body);
      }
      throw fail('name-taken', `${name} already exists`, { suggestion: `${name}-2` });
    }
  }
  /** The live branch: GitHub's github-pages environment lets only it deploy; Netlify/Vercel build it as production. */
  const defaultBranch = async (owner, repo) => (await api(`/repos/${owner}/${repo}`)).body.default_branch;
  const makePublic = (owner, repo) => api(`/repos/${owner}/${repo}`, { method: 'PATCH', body: JSON.stringify({ private: false }) }).then(() => {});
  const pagesUrl = async (owner, repo) => (await api(`/repos/${owner}/${repo}/pages`, {}, { allow: [404] })).body.html_url ?? null;
  const RUN_STATE = { success: 'success', skipped: 'none', neutral: 'none' }; // skipped = not the default branch
  // Netlify/Vercel GitHub apps post commit statuses (context) or check runs (app) carrying their name.
  const named = (host, text) => new RegExp(host, 'i').test(text);
  /** Pages = the Pages workflow's run for the sha — ours, or the repo's own one (`workflow`); a project's other CI never
   *  counts. Netlify/Vercel = their reports. */
  async function deployStatus(owner, repo, sha, host, workflow = PAGES_WORKFLOW) {
    if (host === 'pages') {
      const { body } = await api(`/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=1`, {}, { allow: [404] });
      const run = body.workflow_runs?.[0];
      if (!run) return { state: 'none', url: null };
      return { state: run.status !== 'completed' ? 'pending' : RUN_STATE[run.conclusion] ?? 'failure', url: run.html_url };
    }
    if (host !== 'netlify' && host !== 'vercel') return { state: 'none', url: null };
    const base = `/repos/${owner}/${repo}/commits/${sha}`;
    const [{ body: s }, { body: c }] = await Promise.all([api(`${base}/status`), api(`${base}/check-runs`)]);
    const entries = [
      ...(s.statuses ?? []).filter(x => named(host, x.context))
        .map(x => ({ state: x.state === 'success' ? 'success' : x.state === 'pending' ? 'pending' : 'failure', url: x.target_url })),
      ...(c.check_runs ?? []).filter(x => named(host, `${x.app?.slug} ${x.name}`)).map(x => ({ state: x.status !== 'completed' ? 'pending'
        : ['success', 'neutral', 'skipped'].includes(x.conclusion) ? 'success' : 'failure', url: x.html_url })),
    ];
    const state = ['failure', 'pending', 'success'].find(st => entries.some(e => e.state === st)) ?? 'none';
    return { state, url: entries.find(e => e.state === state)?.url ?? null };
  }
  /** Netlify/Vercel put the site address on the GitHub deployment they create per push.
   *  INFERRED — ledger case 28 in docs/plans/2026-10-14-github-publish-design.md tracks the live check. */
  async function deploymentUrl(owner, repo, sha, host) {
    const { body: deployments } = await api(`/repos/${owner}/${repo}/deployments?sha=${sha}&per_page=10`);
    for (const d of deployments ?? []) {
      if (!named(host, `${d.creator?.login} ${d.environment}`)) continue;
      const { body: statuses } = await api(`/repos/${owner}/${repo}/deployments/${d.id}/statuses?per_page=1`);
      if (statuses?.[0]?.environment_url) return statuses[0].environment_url;
    }
    return null;
  }
  async function enablePages(owner, repo) {
    try {
      const on = await api(`/repos/${owner}/${repo}/pages`, { method: 'POST', body: JSON.stringify({ build_type: 'workflow' }) }, { allow: [409] });
      // Already on — maybe built from a branch, which deploy-pages cannot publish to: switch it to the workflow.
      if (on.status === 409) await api(`/repos/${owner}/${repo}/pages`, { method: 'PUT', body: JSON.stringify({ build_type: 'workflow' }) });
    } catch (e) {
      if ([403, 422].includes(e.status)) throw fail('pages-unavailable', 'GitHub Pages is not available for this repository',
        { settingsUrl: `https://github.com/${owner}/${repo}/settings/pages` });
      throw e;
    }
  }
  // Publish into an existing repo (docs/plans/2026-10-18-publish-into-existing-repo-design.md).
  /** Repos the signed-in user can push to, most recently pushed first. ponytail: the first 100; a full owner/name
   *  typed in the picker reaches any other one. */
  async function repos() {
    const { body } = await api('/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100');
    return body.filter(b => b.permissions?.push && !b.archived).map(b => ({ owner: b.owner.login, repo: b.name, private: b.private, pushedAt: b.pushed_at }));
  }
  const repo = async (owner, name) => {
    const { body: b } = await api(`/repos/${owner}/${name}`);
    return { ...repoOf(b), defaultBranch: b.default_branch, private: b.private, archived: b.archived, push: !!b.permissions?.push, size: b.size, hasPages: !!b.has_pages };
  };
  /** The flat tree of `ref` (trees listed too), or null for an empty repo. */
  async function tree(owner, name, ref) {
    const { status, body } = await api(`/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {}, { allow: [409] });
    if (status === 409) return null;
    return { truncated: !!body.truncated, entries: body.tree.map(e => ({ path: e.path, mode: e.mode, type: e.type, oid: e.sha })) };
  }
  /** A file's text at `ref`, or null when it isn't there. ponytail: the contents API stops at 1 MB; fine for configs. */
  async function text(owner, name, filepath, ref) {
    const { status, body } = await api(`/repos/${owner}/${name}/contents/${filepath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, {}, { allow: [404] });
    return status === 404 || typeof body.content !== 'string' ? null : Buffer.from(body.content, 'base64').toString('utf8');
  }
  /** Which of Netlify/Vercel deploys the repo: their GitHub apps create its deployments. */
  async function deployedBy(owner, name) {
    const { body } = await api(`/repos/${owner}/${name}/deployments?per_page=10`);
    return (body ?? []).map(d => /vercel|netlify/i.exec(d.creator?.login ?? '')?.[0].toLowerCase()).find(Boolean) ?? null;
  }
  /** Is `branch` on GitHub (E6: Publish into creates new branches only, besides the default one). */
  const branchExists = async (owner, name, branch) => (await api(`/repos/${owner}/${name}/branches/${branch}`, {}, { allow: [404] })).status !== 404;
  // The site branch (B1/B3): the repository variable the workflow reads + who may deploy to github-pages.
  const vars = (owner, repo) => `/repos/${owner}/${repo}/actions/variables`;
  const env = (owner, repo) => `/repos/${owner}/${repo}/environments/github-pages`;
  /** The branch Publish picked for Pages, or null (= the default branch). */
  const pagesBranch = async (owner, repo) => {
    const { status, body } = await api(`${vars(owner, repo)}/${PAGES_BRANCH_VAR}`, {}, { allow: [404] });
    return status === 404 ? null : body.value ?? null;
  };
  /** null = unset (the default branch again). */
  async function setPagesBranch(owner, repo, branch) {
    const at = `${vars(owner, repo)}/${PAGES_BRANCH_VAR}`;
    if (branch == null) { await api(at, { method: 'DELETE' }, { allow: [404] }); return; }
    const body = JSON.stringify({ name: PAGES_BRANCH_VAR, value: branch });
    if ((await api(at, { method: 'PATCH', body }, { allow: [404] })).status === 404) await api(vars(owner, repo), { method: 'POST', body });
  }
  /** Who may deploy to github-pages: missing (no environment yet) · open (no branch rule) · protected (protected branches
   *  only) · list (its branch entries; tag entries left out). */
  async function pagesRule(owner, repo) {
    const { status, body } = await api(env(owner, repo), {}, { allow: [404] });
    if (status === 404) return { mode: 'missing' };
    const rule = body.deployment_branch_policy;
    if (!rule) return { mode: 'open' };
    if (rule.protected_branches) return { mode: 'protected' };
    const { body: l } = await api(`${env(owner, repo)}/deployment-branch-policies?per_page=100`);
    return { mode: 'list', list: (l.branch_policies ?? []).filter(x => x.type !== 'tag').map(x => ({ id: x.id, name: x.name })) };
  }
  /** Changing github-pages needs a repo admin (design I1): 403/404 → pages-admin (ledger 15), except a rate limit. */
  async function asAdmin(owner, repo, pathname, init) {
    const r = await api(pathname, init, { allow: [403, 404] });
    if (r.status !== 403 && r.status !== 404) return;
    if (/rate limit/i.test(r.body?.message ?? '')) throw Object.assign(fail('github', `GitHub answered ${r.status}`), { status: r.status, body: r.body });
    throw fail('pages-admin', `Only an admin of ${owner}/${repo} can change the GitHub Pages branch.`, { settingsUrl: `https://github.com/${owner}/${repo}/settings/environments` });
  }
  /** Lets `branch` deploy to github-pages (303 = already there); `create` = no environment yet: one with a branch list first (18). */
  async function allowPages(owner, repo, branch, create = false) {
    if (create) await asAdmin(owner, repo, env(owner, repo), { method: 'PUT', body: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }) });
    await asAdmin(owner, repo, `${env(owner, repo)}/deployment-branch-policies`, { method: 'POST', body: JSON.stringify({ name: branch, type: 'branch' }) });
  }
  const disallowPages = (owner, repo, id) => api(`${env(owner, repo)}/deployment-branch-policies/${id}`, { method: 'DELETE' }, { allow: [404] }).then(() => {});
  /** Starts Starquix's Pages workflow on `ref` when nothing new is pushed (12/28). Refused (unknown on the default branch, no
   *  dispatch trigger) → pages-not-started with the workflow page, where "Run workflow" is (22). */
  async function dispatchPages(owner, repo, ref) {
    const { status } = await api(`/repos/${owner}/${repo}/actions/workflows/${PAGES_WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref }) }, { allow: [404, 422] });
    if (status === 404 || status === 422) throw fail('pages-not-started', "GitHub didn't start the build.", { settingsUrl: `https://github.com/${owner}/${repo}/actions/workflows/${PAGES_WORKFLOW}` });
  }
  return { createRepo, defaultBranch, makePublic, pagesUrl, deployStatus, deploymentUrl, enablePages, repos, repo, tree, text, deployedBy, branchExists,
    pagesBranch, setPagesBranch, pagesRule, allowPages, disallowPages, dispatchPages };
}
