import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { saveMediaEdit, readMediaInvocation } from '@/core/postmedia/saveMediaEdit';
import { requestPreviewReload } from '@/components/Canvas/reloadPreview';

/**
 * task-207: the read/write half of a system-component panel, extracted from
 * MediaBlock so the generic block reuses the REAL path instead of a lookalike
 * (the repo has a documented month-long scar from the parallel-implementation
 * shape — feedback_parity_reuse_not_parallel).
 *
 * `src` is the invocation's raw source at the stamped body line, or null while
 * loading / with no write target. `save` applies a pure mutate and refreshes
 * `src` from what saveMediaEdit returns — no second fetch.
 */
export function useInvocation(opts: {
  postTarget: { collection: string; slug: string } | null;
  bodyLine: number | undefined;
}) {
  const { postTarget, bodyLine } = opts;
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setSrc(null);
    if (bodyLine === undefined || !postTarget) return;
    readMediaInvocation({ ...postTarget, bodyLine }).then((s) => {
      if (!stale) setSrc(s);
    });
    // The stale guard is load-bearing: selections change faster than the fetch
    // resolves and a late response would paint the previous element's values.
    return () => { stale = true; };
  }, [bodyLine, postTarget?.collection, postTarget?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback((mutate: (s: string) => string | null) => {
    if (bodyLine === undefined || !postTarget) return;
    saveMediaEdit({ ...postTarget, bodyLine, mutate }).then((next) => {
      if (next === null) {
        // B2/B7: the markup is hand-written (an expression or a spread) — we
        // refuse rather than guess at the user's code.
        toast.error(t("Could not edit this media — its markup is hand-written"));
        return;
      }
      requestPreviewReload();
      setSrc(next);
    });
  }, [bodyLine, postTarget?.collection, postTarget?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  return { src, save };
}
