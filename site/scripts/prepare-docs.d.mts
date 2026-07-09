/** Type surface of prepare-docs.mjs (kept by hand — the impl is plain JS + JSDoc). */
export declare class DocsCurationError extends Error {}
export declare class DocsLinkError extends Error {}
export declare function isAllowlisted(relPath: string): boolean;
export declare function routeForDoc(relPath: string): string;
export declare function extractTitle(
  markdown: string,
  sourcePath: string,
): { title: string; body: string };
export declare function rewriteLinks(
  markdown: string,
  sourceRelPath: string,
  isIncluded: (relPath: string) => boolean,
): string;
export declare function curateDoc(
  markdown: string,
  sourceRelPath: string,
  isIncluded: (relPath: string) => boolean,
): string;
export declare function curateDocs(srcDir: string, outDir: string): { files: string[] };
