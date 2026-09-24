import os from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, openBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import type { FrameRange } from './ranges.js';
import { NODE_MODULES_DIR, PACKAGED } from './paths.js';

export interface RenderJob {
  outputLocation: string;
  frames?: FrameRange;
  // vp8 = transparent .webm deliverable; prores = fast intermediate for compositing (alpha kept).
  codec: 'vp8' | 'prores';
}

export interface RenderResult {
  ok: boolean;
  log: string;
  ms: number;
  cancelled?: boolean;
}

export interface RenderOptions {
  // Aborting stops the current frame render and skips the remaining jobs.
  signal?: AbortSignal;
  // Called as frames complete; fraction is 0-1 within the given job.
  onProgress?: (jobIndex: number, fraction: number) => void;
  // Called once the bundle is built and the browser is up, before the first job.
  onPhase?: (phase: 'bundling' | 'rendering') => void;
}

// A render page with too many parallel tabs can exhaust the memory of a small machine, so the
// default is capped by available RAM. MANGO_RENDER_CONCURRENCY overrides it.
function renderConcurrency(): number | null {
  const fromEnv = Number(process.env.MANGO_RENDER_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  const gb = os.totalmem() / 1024 ** 3;
  if (gb <= 8) return 2;
  return null;
}

// Bundles the project once and renders every job with a single shared Chromium, so N segments
// pay the webpack + browser startup cost once instead of N times (as N `remotion render` CLI
// calls would). Jobs run sequentially; onJobDone can abort the remaining jobs by returning false.
export async function renderOverlayJobs(
  entryPoint: string,
  jobs: RenderJob[],
  onJobDone: (index: number, result: RenderResult) => Promise<boolean>,
  options: RenderOptions = {}
): Promise<void> {
  const bundleStarted = Date.now();
  let serveUrl: string;
  let browser: Awaited<ReturnType<typeof openBrowser>>;
  options.onPhase?.('bundling');
  try {
    serveUrl = await bundle({
      entryPoint,
      // Projects live in the user's data folder, far from the installed node_modules, so the bare
      // imports of generated code (react, remotion, @mangoai/remotion-overlay) need this extra lookup path.
      webpackOverride: (config) => ({
        ...config,
        resolve: { ...config.resolve, modules: [...(config.resolve?.modules ?? ['node_modules']), NODE_MODULES_DIR] },
      }),
      ...(PACKAGED ? { rootDir: path.dirname(NODE_MODULES_DIR) } : {}),
    });
    browser = await openBrowser('chrome', process.env.MANGO_CHROME_PATH ? { browserExecutable: process.env.MANGO_CHROME_PATH } : undefined);
  } catch (err) {
    const result = { ok: false, log: `Bundling failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, ms: Date.now() - bundleStarted };
    await onJobDone(0, result);
    return;
  }

  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    options.onPhase?.('rendering');
    const composition = await selectComposition({ serveUrl, id: 'Overlay', puppeteerInstance: browser });
    const concurrency = renderConcurrency();
    for (const [i, job] of jobs.entries()) {
      if (options.signal?.aborted) {
        await onJobDone(i, { ok: false, log: 'Export cancelled.', ms: 0, cancelled: true });
        return;
      }
      const started = Date.now();
      let result: RenderResult;
      try {
        await renderMedia({
          composition,
          serveUrl,
          imageFormat: 'png',
          outputLocation: job.outputLocation,
          ...(job.codec === 'prores'
            ? { codec: 'prores' as const, proResProfile: '4444' as const, pixelFormat: 'yuva444p10le' as const }
            : { codec: 'vp8' as const, pixelFormat: 'yuva420p' as const }),
          puppeteerInstance: browser,
          cancelSignal,
          ...(concurrency ? { concurrency } : {}),
          ...(job.frames ? { frameRange: [job.frames.from, job.frames.to] as [number, number] } : {}),
          onProgress: ({ progress }) => options.onProgress?.(i, progress),
        });
        result = { ok: true, log: `rendered ${job.outputLocation}`, ms: Date.now() - started };
      } catch (err) {
        const cancelled = !!options.signal?.aborted;
        result = {
          ok: false,
          log: cancelled ? 'Export cancelled.' : err instanceof Error ? err.stack ?? err.message : String(err),
          ms: Date.now() - started,
          cancelled,
        };
      }
      if (!(await onJobDone(i, result)) || !result.ok) return;
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await browser.close({ silent: true }).catch(() => {});
  }
}
