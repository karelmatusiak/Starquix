// Git on the project folder (Electron main only). One engine per project dir;
// callers serialize ops through the project's lane (projects.serial).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import { t } from '../i18n.mjs';
// `node_modules` without a slash: projects symlink it to the app's shared runtime deps, and a
// dir-only pattern would not match the symlink. Astro's cache and macOS's .DS_Store rewrite themselves: kept in a
// version they show changes nobody made, which block Restore, branch switch and Pull (#30). An imported site keeps its
// .env (#16); like Astro's starter .gitignore, its secrets never go into a version or to GitHub.
const IGNORE = ['node_modules', '.sq/', 'dist/', '.astro/', '.DS_Store', '.env', '.env.production'];
// A git op never writes these into the project folder: node_modules is a symlink to the shared runtime deps, .sq/ is ours,
// dist/ is build output (docs/plans/2026-10-18-publish-into-existing-repo-design.md: GitHub's tip may carry them).
const RUNTIME = new Set(['node_modules', '.sq', 'dist']);
const projectPath = filepath => !RUNTIME.has(filepath.split('/')[0]);
// Publish into an existing repo: the temp remote name and ref (never a branch: the Versions list never shows it).
const INTO = 'sq-into';
const INTO_REF = 'refs/sq/into';
/** Errors carry a `code` the IPC layer forwards (`<code>: <message>`). */
const fail = (code, message) => Object.assign(new Error(t(message)), { code });
/** A branch name git accepts (Versions' New branch, Publish into's branch) — or `invalid`. */
export function branchName(ref) {
  if (typeof ref !== 'string' || ref.length > 100 || !/^[\w.-]+(\/[\w.-]+)*$/.test(ref) || ref.includes('..') || ref.startsWith('-')
      || ref.split('/').some(p => p.startsWith('.') || p.endsWith('.lock'))) throw fail('invalid', 'Invalid branch name');
  return ref;
}
/** `text` plus the runtime entries it lacks; its own lines are never rewritten. */
export function withIgnores(text) {
  const have = new Set(text.split(/\r?\n/).map(l => l.trim()));
  const missing = IGNORE.filter(l => !have.has(l));
  return missing.length ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n` : text;
}
/** Never rewrites a work-tree file with identical bytes: a touched astro.config.mjs (or any watched
 *  file) restarts/reloads the project's `astro dev`. isomorphic-git's conflict merge rewrites every
 *  file of the merged tree, so ALL engine I/O goes through this wrapper. */
function quietFs(dir) {
  const gitDir = path.join(dir, '.git') + path.sep;
  const writeFile = async (file, data, options) => {
    if (!String(file).startsWith(gitDir)) {
      const old = await fsp.readFile(file).catch(() => null);
      const bytes = typeof data === 'string' ? Buffer.from(data, typeof options === 'string' ? options : options?.encoding ?? 'utf8') : Buffer.from(data);
      if (old && old.equals(bytes)) return;
    }
    return fsp.writeFile(file, data, options);
  };
  return { promises: { ...fsp, writeFile } };
}

export function createEngine(dir, { http, onAuth } = {}) {
  const qfs = quietFs(dir);
  const base = { fs: qfs, dir };
  const writeIfChanged = (file, data) => qfs.promises.writeFile(file, data);
  const initialized = () => fs.existsSync(path.join(dir, '.git'));
  const init = async () => { if (!initialized()) await git.init({ ...base, defaultBranch: 'main' }); };
  // A pull that hit conflicts parks here until finish/abort; survives an app restart.
  const MERGE = path.join(dir, '.git', 'sq-merge.json');
  const mergeState = async () => JSON.parse(await fsp.readFile(MERGE, 'utf8').catch(() => 'null'));
  async function assertNotMerging() { if (await mergeState()) throw fail('merging', 'Finish the merge first'); }
  async function assertClean() { if ((await changedRows()).length) throw fail('unsaved', 'Unsaved changes'); }
  /** Appends the runtime entries an existing (imported) .gitignore lacks; never rewrites its lines. */
  async function ensureIgnore() {
    const file = path.join(dir, '.gitignore');
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const next = withIgnores(text);
    if (next !== text) await fsp.writeFile(file, next);
  }
  // ponytail: init on first status so counts are stable; move into save() if an empty .git on never-saved projects matters
  // Walks every tracked-or-unignored file with its HEAD and work-tree oids. Never uses statusMatrix: its stat cache
  // compares whole seconds, so a same-size edit right after a save looked clean.
  // ponytail: hashes every tracked-or-unignored file per call; fine for site-sized repos.
  async function walkWork(pick) {
    await ensureIgnore();
    await init();
    const hasHead = await git.resolveRef({ ...base, ref: 'HEAD' }).then(() => true, () => false);
    const trees = hasHead ? [git.TREE({ ref: 'HEAD' }), git.WORKDIR()] : [git.WORKDIR()];
    return git.walk({ ...base, trees, map: async (filepath, entries) => {
      if (filepath === '.') return;
      const [h, w] = hasHead ? entries : [null, entries[0]];
      if (!h && await git.isIgnored({ ...base, filepath })) return null; // null = do not descend
      const [ht, wt] = [await h?.type(), await w?.type()];
      if (ht !== 'blob' && wt !== 'blob') return; // dirs (or file↔dir swaps) still descend
      const hOid = ht === 'blob' ? await h.oid() : null;
      const wOid = wt === 'blob' ? (await git.hashBlob({ object: await fsp.readFile(path.join(dir, filepath)) })).oid : null;
      return pick(filepath, hOid, wOid);
    } });
  }
  // Rows [filepath, head 0|1, workdir 0|2] for files whose CONTENT differs from HEAD.
  const changedRows = () => walkWork((f, h, w) => (h !== w ? [f, h ? 1 : 0, w ? 2 : 0] : undefined));
  /** Every file a save keeps: Map(path → oid) of the work tree. */
  const files = async () => new Map(await walkWork((f, _h, w) => (w ? [f, w] : undefined)));
  async function status() {
    const was = initialized();
    const rows = await changedRows();
    return { initialized: was, branch: await git.currentBranch(base) ?? 'main', changed: rows.length,
      files: rows.map(([f]) => f), ...(m => ({ merging: !!m, conflicts: m?.files ?? null }))(await mergeState()) };
  }
  async function save(message, author) {
    await assertNotMerging();
    const rows = await changedRows();
    if (!rows.length) throw fail('nothing', 'Nothing to save');
    for (const [filepath, , workdir] of rows) {
      if (workdir === 0) await git.remove({ ...base, filepath }); else await git.add({ ...base, filepath });
    }
    return git.commit({ ...base, message, author });
  }
  async function history(ref = 'HEAD') {
    if (!initialized()) return [];
    try {
      return (await git.log({ ...base, ref })).map(c => ({ oid: c.oid, message: c.commit.message.trim(),
        at: c.commit.author.timestamp * 1000, author: c.commit.author.name, parents: c.commit.parent }));
    } catch (e) { if (e.code === 'NotFoundError') return []; throw e; }
  }
  // D6: restore never moves HEAD back — it writes the old tree and saves it as a new version.
  async function restore(oid, author) {
    await assertNotMerging(); await assertClean();
    const target = new Set((await git.listFiles({ ...base, ref: oid })).filter(projectPath));
    for (const f of await git.listFiles({ ...base, ref: 'HEAD' })) {
      if (!target.has(f) && projectPath(f)) await fsp.rm(path.join(dir, f), { force: true });
    }
    for (const filepath of target) {
      const { blob } = await git.readBlob({ ...base, oid, filepath });
      await fsp.mkdir(path.dirname(path.join(dir, filepath)), { recursive: true });
      await writeIfChanged(path.join(dir, filepath), blob);
    }
    const { commit } = await git.readCommit({ ...base, oid });
    return save(`Restore: ${commit.message.trim()}`, author);
  }
  // D10: branches. Switching (like restore) needs a clean tree — the user saves or discards first.
  // Before the first version git has no branch ref: the current (unborn) branch still is one.
  const branches = async () => {
    const list = initialized() ? (await git.listBranches(base)).sort() : [];
    return list.length ? list : [await branch()];
  };
  async function createBranch(ref) {
    branchName(ref);
    await assertNotMerging();
    await git.branch({ ...base, ref, checkout: true });
  }
  async function switchBranch(ref) {
    await assertNotMerging(); await assertClean();
    await git.checkout({ ...base, ref, force: true }); // clean by content hash, so force only bypasses the stat cache
  }
  // changedRows prunes ignored paths, so .sq/ and node_modules/ are never touched.
  async function discard() {
    await assertNotMerging();
    for (const [filepath, head] of await changedRows()) {
      if (head === 0) await fsp.rm(path.join(dir, filepath), { force: true });
      else await git.checkout({ ...base, ref: 'HEAD', filepaths: [filepath], force: true });
    }
    await git.checkout({ ...base, ref: await git.currentBranch(base), force: true }); // resets the index
  }
  // Starquix settings of THIS repo (the Publish host): .git/config — never pushed, survives restarts.
  const config = async key => initialized() ? (await git.getConfig({ ...base, path: key })) ?? null : null;
  // git.init skips a dir whose .git/config exists: a config write must never be the repo's first file.
  const setConfig = async (key, value) => { await init(); return git.setConfig({ ...base, path: key, value }); };
  // Cheap ref reads for polling paths — no tree walk, no full log.
  const branch = async () => (initialized() && await git.currentBranch(base)) || 'main';
  const tip = ref => git.resolveRef({ ...base, ref }).catch(() => null);
  // D7: classic remote. Fetch only on Pull/Refresh — counts() reads the last fetched tracking ref.
  const remote = async () => initialized() ? (await git.listRemotes(base)).find(r => r.remote === 'origin')?.url ?? null : null;
  async function setRemote(url) { await git.addRemote({ ...base, remote: 'origin', url, force: true }); }
  // deleteRemote keeps refs/remotes/origin/*: drop them too, or every branch keeps comparing itself with the old repo (R11).
  async function removeRemote() {
    for (const b of await git.listBranches({ ...base, remote: 'origin' })) await git.deleteRef({ ...base, ref: `refs/remotes/origin/${b}` });
    await git.deleteRemote({ ...base, remote: 'origin' });
  }
  async function fetchRemote() {
    const ref = await git.currentBranch(base);
    await git.fetch({ ...base, http, onAuth, remote: 'origin', ref, singleBranch: true, tags: false });
  }
  // ponytail: O(history) per call; switch to a depth-limited walk if repos get large
  async function counts() {
    const ref = await git.currentBranch(base);
    const theirs = await git.resolveRef({ ...base, ref: `refs/remotes/origin/${ref}` }).catch(() => null);
    const ours = await git.resolveRef({ ...base, ref: 'HEAD' }).catch(() => null);
    if (!theirs || !ours) return { ahead: ours ? (await history()).length : 0, behind: 0 };
    const [mb] = await git.findMergeBase({ ...base, oids: [ours, theirs] });
    const count = async tip => (await git.log({ ...base, ref: tip })).findIndex(c => c.oid === mb);
    return { ahead: await count(ours), behind: await count(theirs) };
  }
  async function push() {
    await assertNotMerging();
    const ref = await git.currentBranch(base);
    try { await git.push({ ...base, http, onAuth, remote: 'origin', ref }); }
    catch (e) { if (e.code === 'PushRejectedError') throw fail('behind', 'Pull first'); throw e; }
  }
  // D7/D8: pull = fetch + merge. Conflicts never reach the canvas: each conflicted file gets Mine
  // (isomorphic-git leaves <<<<<<< markers on disk) and the user picks Mine/Theirs per file.
  /** Writes `filepath` as of commit `oid`; returns the blob oid written (null: deleted on that side). */
  async function writeSide(filepath, oid) {
    const target = path.join(dir, filepath);
    try {
      const { oid: written, blob } = await git.readBlob({ ...base, oid, filepath });
      await fsp.mkdir(path.dirname(target), { recursive: true }); await writeIfChanged(target, blob);
      return written;
    } catch (e) { if (e.code !== 'NotFoundError') throw e; await fsp.rm(target, { force: true }); return null; } // deleted on that side
  }
  async function pull(author) {
    await assertNotMerging(); await assertClean();
    await fetchRemote();
    const ref = await git.currentBranch(base);
    const ours = await git.resolveRef({ ...base, ref: 'HEAD' });
    const theirs = await git.resolveRef({ ...base, ref: `refs/remotes/origin/${ref}` });
    // Ledger 44: a root node_modules would be written through the runtime-deps symlink (.sq/ is ours).
    const owned = (await git.readTree({ ...base, oid: theirs })).tree.find(e => e.path === 'node_modules' || e.path === '.sq');
    if (owned) throw fail('runtime-files', `GitHub's version contains ${owned.path}/. Remove it from the repository on GitHub, then get the latest.`);
    try {
      await git.merge({ ...base, ours: ref, theirs, abortOnConflict: false, author, message: t('Merge from GitHub') });
      await git.checkout({ ...base, ref, force: true });
      return { conflicts: [] };
    } catch (e) {
      if (e.code !== 'MergeConflictError') throw e;
      const conflicts = e.data.filepaths;
      // The tree was clean, so every file that differs now is the pull's: `wrote` (path → oid) is all Abort may take back.
      const wrote = Object.fromEntries(await walkWork((f, h, w) => (h !== w ? [f, w] : undefined)));
      for (const f of conflicts) wrote[f] = await writeSide(f, ours);
      await fsp.writeFile(MERGE, JSON.stringify({ ours, theirs, files: Object.fromEntries(conflicts.map(f => [f, 'mine'])), wrote }));
      return { conflicts };
    }
  }
  async function resolve(filepath, side) {
    const m = await mergeState();
    if (!m?.files[filepath]) throw fail('invalid', 'Not a conflicted file');
    m.wrote = { ...m.wrote, [filepath]: await writeSide(filepath, side === 'theirs' ? m.theirs : m.ours) };
    m.files[filepath] = side; await fsp.writeFile(MERGE, JSON.stringify(m));
  }
  async function stage(filepath) {
    if (fs.existsSync(path.join(dir, filepath))) await git.add({ ...base, filepath });
    else await git.remove({ ...base, filepath });
  }
  async function finish(author) {
    const m = await mergeState(); if (!m) throw fail('invalid', 'No merge in progress');
    // Conflicted files resolved to Mine equal HEAD, so changedRows skips them — stage them explicitly
    // to clear their conflict stages.
    for (const f of new Set([...Object.keys(m.files), ...(await changedRows()).map(([f]) => f)])) await stage(f);
    const oid = await git.commit({ ...base, author, message: t('Merge from GitHub'), parent: [m.ours, m.theirs] });
    await fsp.rm(MERGE); return oid;
  }
  // Like `git merge --abort`: only what the pull wrote goes back, and only while it is as the pull left it — pages,
  // images and edits made while the merge waited stay (#1). A merge parked by an older version has no `wrote`: nothing goes back.
  async function abort() {
    const m = await mergeState(); if (!m) return;
    const now = await files();
    for (const f of Object.keys({ ...m.files, ...m.wrote })) {
      if ((now.get(f) ?? null) === m.wrote?.[f]) await writeSide(f, m.ours);
      await git.resetIndex({ ...base, filepath: f }); // drops the merge's conflict stages and merged blobs
    }
    await fsp.rm(MERGE);
  }
  // Publish into an existing repo (docs/plans/2026-10-18-publish-into-existing-repo-design.md E2): GitHub's tip at depth 1,
  // then one version on top of it. Until GitHub accepts the push nothing here changes but objects and the shallow list.
  const SHALLOW = path.join(dir, '.git', 'shallow');
  let shallowBefore; // fetchTip → dropTip within one op
  /** Forgets a fetched tip that never made it into the history (its objects stay; harmless). */
  async function dropTip() {
    if (shallowBefore === undefined) return;
    if (shallowBefore === null) await fsp.rm(SHALLOW, { force: true }); else await fsp.writeFile(SHALLOW, shallowBefore);
  }
  /** GitHub's `branch` tip: { oid, entries: [{ path, mode, type, oid }] }, or null for an empty repo. */
  async function fetchTip(url, branch) {
    await init();
    shallowBefore = await fsp.readFile(SHALLOW).catch(() => null);
    try {
      await git.addRemote({ ...base, remote: INTO, url, force: true }); // fetch needs the remote's refspec in .git/config
      const { fetchHead } = await git.fetch({ ...base, http, onAuth, remote: INTO, ref: branch, singleBranch: true, depth: 1, tags: false });
      if (!fetchHead) return null;
      const entries = await git.walk({ ...base, trees: [git.TREE({ ref: fetchHead })], map: async (filepath, [e]) => {
        const type = filepath === '.' ? 'tree' : await e.type();
        if (type !== 'tree') return { path: filepath, mode: (await e.mode()).toString(8), type, oid: await e.oid() };
      } });
      return { oid: fetchHead, entries };
    } catch (e) { await dropTip(); throw e; }
    finally {
      await git.deleteRemote({ ...base, remote: INTO }).catch(() => {});
      await git.deleteRef({ ...base, ref: `refs/remotes/${INTO}/${branch}` }).catch(() => {});
    }
  }
  /** `treeOid` with `entries` (flat paths) set; subtrees are rewritten, the rest is shared. */
  async function withEntries(treeOid, entries) {
    const byName = new Map((treeOid ? (await git.readTree({ ...base, oid: treeOid })).tree : []).map(e => [e.path, e]));
    const below = new Map();
    for (const e of entries) {
      const [name, ...rest] = e.path.split('/');
      if (!rest.length) byName.set(name, { mode: e.mode, path: name, oid: e.oid, type: 'blob' });
      else below.set(name, [...(below.get(name) ?? []), { ...e, path: rest.join('/') }]);
    }
    for (const [name, list] of below) {
      const sub = byName.get(name);
      byName.set(name, { mode: '040000', path: name, type: 'tree', oid: await withEntries(sub?.type === 'tree' ? sub.oid : null, list) });
    }
    return git.writeTree({ ...base, tree: [...byName.values()] });
  }
  /** The project on top of GitHub's `tip` (parents [HEAD, tip]) + GitHub's `keep` entries, pushed to `branch` as a
   *  fast-forward. Only once GitHub took it does this repo become `branch` of `url`. A tip already in the history (or none:
   *  an empty repo) = a plain push. The caller refuses a `branch` that exists here but isn't current. */
  async function publishInto({ url, branch, tip, keep, author, message }) {
    const head = await git.resolveRef({ ...base, ref: 'HEAD' });
    const current = await git.currentBranch(base);
    let oid = head;
    try {
      if (tip && tip !== head && !(await git.isDescendent({ ...base, oid: head, ancestor: tip, depth: -1 }))) {
        // Ledger 28: GitHub's .gitignore + our runtime entries, so the project is clean right after.
        const entries = await Promise.all(keep.map(async e => (e.path !== '.gitignore' ? e
          : { ...e, oid: await git.writeBlob({ ...base, blob: Buffer.from(withIgnores(await readText(e.oid))) }) })));
        const { commit } = await git.readCommit({ ...base, oid: head });
        oid = await git.commit({ ...base, message, author, tree: await withEntries(commit.tree, entries), parent: [head, tip], noUpdateBranch: true });
      }
      await git.writeRef({ ...base, ref: INTO_REF, value: oid, force: true });
      await git.push({ ...base, http, onAuth, url, remote: INTO, ref: INTO_REF, remoteRef: `refs/heads/${branch}` }).catch(e => {
        if (e.code === 'PushRejectedError') throw fail('moved', 'GitHub changed while publishing'); // ledger 29
        if (e.code === 'GitPushError') { // ledger 30: a protected branch / ruleset — GitHub's own reason
          const reason = Object.values(e.data?.result?.refs ?? {}).find(r => !r.ok)?.error ?? e.message;
          throw Object.assign(fail('push-refused', reason), { branch });
        }
        throw e;
      });
    } catch (e) { await dropTip(); throw e; }
    finally {
      await git.deleteRef({ ...base, ref: INTO_REF }).catch(() => {});
      await git.deleteRef({ ...base, ref: `refs/remotes/${INTO}/${branch}` }).catch(() => {});
    }
    if (current !== branch) await git.renameBranch({ ...base, oldref: current, ref: branch, checkout: true }); // ledger 27
    await git.writeRef({ ...base, ref: `refs/heads/${branch}`, value: oid, force: true });
    await git.writeRef({ ...base, ref: `refs/remotes/origin/${branch}`, value: oid, force: true });
    await setRemote(url);
    if (oid !== head) await git.checkout({ ...base, ref: branch, force: true }); // GitHub's kept files land; the index follows
    return { wrote: oid !== head && keep.length > 0 };
  }
  const readText = async oid => Buffer.from((await git.readBlob({ ...base, oid })).blob).toString('utf8');
  return { dir, status, save, history, restore, branches, createBranch, switchBranch, discard,
    remote, setRemote, removeRemote, fetchRemote, counts, push, pull, resolve, finish, abort, mergeState, config, setConfig, branch, tip,
    files, fetchTip, dropTip, publishInto, readText };
}
