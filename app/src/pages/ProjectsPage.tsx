// src/pages/ProjectsPage.tsx
import { isStorageFailure } from '@/services/browserStorage';
import { issueKey, type OperationIssue } from '@/utils/operationIssue';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import type { Project } from '@/api/types';
import { Button, OperationNotice } from '@/components/ui';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { ProjectCard } from '@/components/ProjectCard';
import { CreateProjectCard } from '@/components/CreateProjectCard';
import { ImportProjectModal } from '@/components/ImportProjectModal';
import { DiscordIcon, PlusLargeIcon as PlusIcon } from '@/assets/icons';
import { db, getAssetBlob, renameProject } from '@/db';
import { createScaffoldProject } from '@/services/projectImport/createFilesTruthProject';
import { captureProject, deleteProject, restoreProject, projectUndo, type DeletedProject } from '@/services/projectUndo';
import { getModifierKey, shortcutLabel } from '@/utils/platform';
import { useDesktopUpdate } from '@/hooks/useDesktopUpdate';
import { DISCORD_URL, openExternal } from '@/utils/supportLinks';
import { t } from '@/i18n';

type ProjectFailure = { issue: OperationIssue; storage: boolean };
const storageGuidance = 'Browser storage could not complete this action. Free device storage without clearing this site’s data, then try again.';

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [readFailure, setReadFailure] = useState<ProjectFailure | null>(null);
  const [createFailure, setCreateFailure] = useState<ProjectFailure | null>(null);
  const [deleteFailures, setDeleteFailures] = useState<Record<string, ProjectFailure>>({});
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const owner = useRef({ active: false, visit: 0, read: 0, episode: 0, creating: false, restoring: false,
    deleting: new Set<string>(), retainedDeletes: new Map<string, Project>() });
  const [isImportOpen, setIsImportOpen] = useState(false);
  // Update notifier, notify only (desktop/src/update-check.mjs): main checks the releases repo; this page shows the answer.
  const update = useDesktopUpdate();
  const latest = update?.latest; const page = update?.page;

  const failure = useCallback((operation: 'controls' | 'project-create' | 'project-delete', error: unknown, projectId: string | null = null): ProjectFailure => ({
    storage: isStorageFailure(error),
    issue: {
      code: operation === 'controls' ? 'read-unavailable' : operation === 'project-delete' ? 'outcome-unknown' : 'operation-failed',
      operation, outcome: operation === 'controls' ? 'not-applicable' : operation === 'project-delete' ? 'partial' : 'no-write',
      owner: { projectId, entityKey: projectId ?? 'projects', visit: owner.current.visit },
      episode: ++owner.current.episode, recover: operation === 'controls' ? 'read-again' : 'none', fallbackUsable: false,
    },
  }), []);

  const loadProjects = useCallback(async () => {
    const lifetime = owner.current;
    if (!lifetime.active) return;
    const visit = lifetime.visit;
    const request = ++lifetime.read;
    const current = () => lifetime.active && lifetime.visit === visit && lifetime.read === request;
    setIsLoading(true);
    try {
      const dbProjects = await db.projects.orderBy('updatedAt').reverse().toArray();
      const mapped: Project[] = dbProjects.map((p) => ({
        _id: p.id, name: p.name, pagesTree: p.pagesTree, pages: {},
        createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
      }));
      if (!current()) return;
      // A later successful read cannot hide an unresolved partial deletion.
      for (const [id, project] of lifetime.retainedDeletes) {
        if (!mapped.some(item => item._id === id)) mapped.push(project);
      }
      setProjects(mapped);
      setReadFailure(null);
    } catch (error) {
      if (current()) setReadFailure(failure('controls', error));
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [failure]);

  useEffect(() => {
    const lifetime = owner.current;
    lifetime.active = true;
    ++lifetime.visit;
    void loadProjects();
    return () => { lifetime.active = false; ++lifetime.read; };
  }, [loadProjects]);


  // Cover image loading
  const [coverUrls, setCoverUrls] = useState<Map<string, string>>(new Map());
  const coverUrlsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function loadCovers() {
      try {
        const assets = await db.assets.where('id').startsWith('cover_').toArray();
        if (cancelled) return;

        const newUrls = new Map<string, string>();
        for (const asset of assets) {
          const url = URL.createObjectURL(getAssetBlob(asset));
          newUrls.set(asset.projectId, url);
        }

        // Revoke old URLs
        for (const url of coverUrlsRef.current.values()) {
          URL.revokeObjectURL(url);
        }

        coverUrlsRef.current = newUrls;
        setCoverUrls(newUrls);
      } catch (err) {
        console.error('Failed to load covers:', err);
      }
    }

    loadCovers();

    return () => {
      cancelled = true;
      for (const url of coverUrlsRef.current.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [projects]);

  const generateProjectName = useCallback(() => {
    const baseName = t('New Project');
    const existingNames = new Set(projects.map((p) => p.name));

    if (!existingNames.has(baseName)) {
      return baseName;
    }

    let counter = 1;
    while (existingNames.has(`${baseName} ${counter}`)) {
      counter++;
    }
    return `${baseName} ${counter}`;
  }, [projects]);

  const handleCreateProject = async () => {
    const lifetime = owner.current;
    if (!lifetime.active || lifetime.creating) return;
    const visit = lifetime.visit;
    const current = () => lifetime.active && lifetime.visit === visit;
    const name = generateProjectName();
    lifetime.creating = true;
    setIsCreating(true);
    try {
      await createScaffoldProject(name);
      if (!current()) return;
      setCreateFailure(null);
      toast.success(`Project "${name}" created`);
      await loadProjects();
    } catch (error) {
      if (current()) setCreateFailure(failure('project-create', error));
    } finally {
      lifetime.creating = false;
      if (current()) setIsCreating(false);
    }
  };

  // No question: the delete happens at once and ⌘Z brings the project back (owner 2026-11-10: delete anything AND
  // undo). Its rows are captured first, so even a delete that stops half-way is one ⌘Z from whole again.
  const handleDeleteProject = async (projectId: string, redo = false) => {
    const lifetime = owner.current;
    if (!lifetime.active || lifetime.deleting.has(projectId) || lifetime.restoring) return;
    const visit = lifetime.visit;
    const current = () => lifetime.active && lifetime.visit === visit;
    const project = projects.find(p => p._id === projectId);
    lifetime.deleting.add(projectId);
    setDeleting(new Set(lifetime.deleting));
    let captured: DeletedProject | undefined;
    try {
      captured = await captureProject(projectId);
      await deleteProject(projectId);
      if (!current()) return;
      ++lifetime.read;
      setIsLoading(false);
      lifetime.retainedDeletes.delete(projectId);
      setDeleteFailures(previous => { const next = { ...previous }; delete next[projectId]; return next; });
      setProjects(previous => previous.filter(p => p._id !== projectId));
      toast.success(`Deleted “${captured.project.name}” — ${shortcutLabel('⌘Z')} to undo`);
    } catch (error) {
      if (!current()) return;
      ++lifetime.read;
      setIsLoading(false);
      if (project) {
        lifetime.retainedDeletes.set(projectId, project);
        setProjects(previous => previous.some(p => p._id === projectId) ? previous : [...previous, project]);
      }
      setDeleteFailures(previous => ({ ...previous, [projectId]: failure('project-delete', error, projectId) }));
    } finally {
      if (captured) projectUndo.deleted(captured, redo);
      lifetime.deleting.delete(projectId);
      if (current()) setDeleting(new Set(lifetime.deleting));
    }
  };

  /** ⌘Z: the most recent deletion comes back whole. A failed restore stays on the stack, so ⌘Z tries again. */
  const undoDelete = async () => {
    const lifetime = owner.current;
    const entry = projectUndo.nextUndo();
    if (!entry || !lifetime.active || lifetime.restoring || lifetime.deleting.size) return;
    lifetime.restoring = true;
    try {
      await restoreProject(entry);
      projectUndo.restored(entry);
      lifetime.retainedDeletes.delete(entry.project.id);
      setDeleteFailures(previous => { const next = { ...previous }; delete next[entry.project.id]; return next; });
    } catch (error) {
      // Never the raw error (this page's failures never show one); storage gets the page's own guidance.
      toast.error(isStorageFailure(error) ? storageGuidance : `“${entry.project.name}” could not be restored. ${shortcutLabel('⌘Z')} tries again.`);
      return;
    } finally { lifetime.restoring = false; }
    await loadProjects();
  };

  /** ⇧⌘Z: the last restored project is deleted again. */
  const redoDelete = () => {
    const entry = projectUndo.nextRedo();
    if (!entry || owner.current.restoring || owner.current.deleting.size) return;
    projectUndo.redoing(entry);
    void handleDeleteProject(entry.project.id, true);
  };

  // ⌘Z / ⇧⌘Z (Ctrl off a Mac) — never inside a text field, where they edit the text.
  const historyKeys = useRef({ undoDelete, redoDelete });
  historyKeys.current = { undoDelete, redoDelete };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!getModifierKey(e) || e.altKey || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        || target?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); void historyKeys.current.undoDelete(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); historyKeys.current.redoDelete(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleRenameProject = useCallback(async (projectId: string, newName: string) => {
    const lifetime = owner.current;
    const visit = lifetime.visit;
    // The page owner also fences handlers captured before deletion's render.
    if (!lifetime.active || lifetime.deleting.has(projectId) || lifetime.retainedDeletes.has(projectId)) {
      throw new Error('Project is unavailable for renaming');
    }
    // Rejection reaches the card's draft owner. A failed follow-up read has
    // its own read notice and cannot turn an acknowledged rename into failure.
    await renameProject(projectId, newName);
    if (!lifetime.active || lifetime.visit !== visit) return;
    setProjects(previous => previous.map(project => project._id === projectId ? { ...project, name: newName } : project));
    void loadProjects();
  }, [loadProjects]);

  return (
    <section className="mx-auto p-8 pt-0 bg-bg min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between pt-3 pb-12 gap-8">
        <h1 className="text-3xl tracking-tight font-medium text-text">
          Projects
        </h1>
        <div className="flex items-center gap-3">
          <Button onClick={() => setIsImportOpen(true)} variant="ghost" size="lg" label="Import project" />
          <Button
            onClick={handleCreateProject}
            disabled={isCreating}
            variant="primary"
            size="lg"
          >
            <PlusIcon className="w-6 h-6 mr-2" />
            {isCreating ? 'Creating...' : 'New Project'}
          </Button>
          <Button variant="ghost" iconOnly title="Ask on Discord" aria-label="Ask on Discord" icon={<DiscordIcon className="w-4 h-4" />}
            onClick={() => openExternal(DISCORD_URL)} />
          <ThemeToggle />
        </div>
      </div>

      {/* Above everything else on the page: people on an old build keep hitting bugs a release already fixed. */}
      {latest && page && <div className="mb-4"><OperationNotice title={`Starquix ${latest} is available`}
        detail="Bug fixes. Install it over this app — your projects stay."
        action={{ label: `Update to ${latest}`, onClick: () => openExternal(page) }} /></div>}
      {readFailure && <OperationNotice key={issueKey(readFailure.issue)} title="Projects could not be loaded."
        detail={readFailure.storage ? storageGuidance : projects.length > 0 ? 'Showing the last loaded projects. Retry to update this list.' : 'Retry to load your projects.'}
        action={{ label: 'Retry', onClick: () => { void loadProjects(); }, busy: isLoading }} />}
      {createFailure && <OperationNotice key={issueKey(createFailure.issue)} title="The project could not be created."
        detail={createFailure.storage ? storageGuidance : 'Keep this page open and try New Project again when you are ready.'} />}
      {isLoading && !readFailure && <p role="status" className="my-4 text-sm text-text-muted">Loading projects…</p>}

      {/* Projects grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {projects.length > 0 ? (
          projects.map((project) => (
            <ProjectCard
              key={project._id}
              project={project}
              coverUrl={coverUrls.get(project._id)}
              onDelete={handleDeleteProject}
              onRename={handleRenameProject}
              deleting={deleting.has(project._id)}
              deleteIssue={deleteFailures[project._id]?.issue}
            />
          ))
        ) : !isLoading && !readFailure ? (
          <CreateProjectCard onClick={handleCreateProject} />
        ) : null}
      </div>


      <ImportProjectModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onImported={(projectId) => {
          setIsImportOpen(false);
          toast.success('Project imported');
          navigate(`/editor/${projectId}`);
        }}
      />

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 py-4 text-center">
        <p className="text-xs text-text-muted opacity-50">
          Starquix{update && ` ${update.current}`} © 2026{' '}
          <a href="https://mayhopar.com/" target="_blank" rel="noopener noreferrer" className="hover:text-text hover:opacity-100 transition-all">Oleg Maykhopar</a>
          {', '}
          <a href="https://www.linkedin.com/in/nikita-osadchiy-106242173/" target="_blank" rel="noopener noreferrer" className="hover:text-text hover:opacity-100 transition-all">Nikita Osadchiy</a>
          {' a '}Karel Matusiak{'. '}{t('Licensed under')}{' '}
          <a
            href="https://github.com/Mayhopar/starquix/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text hover:opacity-100 transition-all"
          >
            MIT
          </a>
          {' · '}
          <a
            href="https://github.com/Mayhopar/Starquix"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text hover:opacity-100 transition-all"
          >
            Webdílna vychází z open-source projektu Starquix (MIT).
          </a>
        </p>
      </footer>
    </section>
  );
}
