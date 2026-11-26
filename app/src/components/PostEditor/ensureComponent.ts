/**
 * First insert of our Media component makes sure a real file exists in the
 * user's project (they own it, can restyle it); the import path is relative
 * to the post's own file, never the project root.
 *
 * The instance's ensure-sq-component route copies preview-template's file
 * into src/components/sq/ (and upgrades stale copies with a .bak).
 */
import toast from 'react-hot-toast';
import { t } from '@/i18n';
import { localFetch } from '../../utils/sqLocalBase';
import { projectIdFromPath } from '@/utils/localMode';
import { settleSourceWrites } from '@/services/durableEdits/sourceMaterialization';

export async function ensureSqComponent(projectPath: string | null, name: string): Promise<string | null> {
  if (!projectPath) {
    toast.error(t("Could not add {0} — the project is not open yet.", { 0: name }));
    return null;
  }
  await settleSourceWrites(projectIdFromPath(projectPath)); // an upgrade rewrites the file
  const r = await localFetch('/__sq/local/ensure-sq-component', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath, name }),
  });
  const data = (await r.json().catch(() => null)) as { file?: string; error?: string } | null;
  if (!r.ok || !data?.file) {
    toast.error(data?.error ?? `Could not add ${name} to this project.`);
    return null;
  }
  return data.file;
}

export function componentImportPathFor(postFile: string, componentFile: string): string {
  const up = postFile.split('/').length - 2; // -1 for the filename, -1 for src/
  const target = componentFile.replace(/^src\//, '');
  return '../'.repeat(up) + target;
}
