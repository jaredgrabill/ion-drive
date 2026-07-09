/**
 * Sanitized README rendering — `marked` + `dompurify` are lazy-imported only
 * when a panel actually has a README to show (they never ride the island's
 * initial chunk). DOMPurify runs with its defaults (scripts/handlers
 * stripped); links open in a new tab with `rel="noopener noreferrer"` via a
 * post-sanitize hook on the produced fragment.
 */

import { useEffect, useState } from 'react';

export function Readme({ markdown }: { markdown: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([import('marked'), import('dompurify')]).then(([{ marked }, dompurify]) => {
      if (cancelled) return;
      const rendered = marked.parse(markdown, { async: false });
      const purifier = dompurify.default;
      purifier.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' && node.getAttribute('href')?.startsWith('http')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      });
      const clean = purifier.sanitize(rendered);
      purifier.removeAllHooks();
      setHtml(clean);
    });
    return () => {
      cancelled = true;
    };
  }, [markdown]);

  if (html === null) return <output>rendering README…</output>;
  // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify-sanitized above.
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
