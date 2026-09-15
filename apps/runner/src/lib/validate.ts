import * as esbuild from 'esbuild';

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

// Fast structural check — bundles the marker file with esbuild (transpile + resolve
// imports) without full TypeScript type-checking. Catches syntax errors, unresolved
// imports, and broken JSX, which covers the vast majority of self-heal-worthy mistakes.
export async function validateMarkerFile(filePath: string): Promise<ValidationResult> {
  try {
    await esbuild.build({
      entryPoints: [filePath],
      bundle: true,
      write: false,
      jsx: 'automatic',
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
      external: ['react', 'react-dom', 'remotion', '@remotion/*', '@mangoai/*'],
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
