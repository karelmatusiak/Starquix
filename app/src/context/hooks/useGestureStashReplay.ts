/**
 * Replays the intents the gesture stash still holds when a project opens (instant-edit P2, decision 17).
 * An entry is the class an element should have, plus the class it had when the pending chain began. Once a scan has
 * registered the key (polls every second, up to 30 s, like the legacy class-write journal did):
 *   committed == entry.classes   it landed after all: drop silently
 *   committed == entry.baseline  nothing else changed: re-issue as ONE normal gesture (one undo step)
 *   anything else                the project moved on: drop with the existing toast — newest wins, never a blind splice
 */
import { useEffect, useRef } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { stashClear, stashEntries } from '@/services/gestureStash';

const POLL_MS = 1000;
const MAX_POLLS = 30;

export function useGestureStashReplay(
  projectId: string | null,
  getCommitted: (key: string) => string,
  setClasses: (key: string, classes: string) => Promise<boolean>,
): void {
  // Once per project: the callbacks change identity with every state change and must not restart (or repeat) the replay.
  const latest = useRef({ getCommitted, setClasses });
  latest.current = { getCommitted, setClasses };
  useEffect(() => {
    if (!projectId) return;
    const pending = new Map(stashEntries(projectId).map(entry => [entry.key, entry]));
    if (!pending.size) return;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const settle = (final: boolean) => {
      for (const [key, entry] of [...pending]) {
        const committed = latest.current.getCommitted(key);
        if (!committed && !final) continue;                       // no scan has registered the key yet
        pending.delete(key);
        if (committed === entry.classes) { stashClear(projectId, key); continue; }
        if (committed === (entry.baseline ?? '')) { void latest.current.setClasses(key, entry.classes); continue; }   // cleared at acceptance
        stashClear(projectId, key);
        toast.error(t("An unsaved style change was discarded: the project changed since."));
      }
    };
    const tick = () => {
      if (cancelled) return;
      settle(++polls >= MAX_POLLS);
      if (pending.size && polls < MAX_POLLS) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [projectId]);
}
