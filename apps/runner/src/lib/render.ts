import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import type { FrameRange } from './ranges.js';

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
}

// Bundles the project once and renders every job with a single shared Chromium, so N segments
// pay the webpack + browser startup cost once instead of N times (as N `remotion render` CLI
// calls would). Jobs run sequentially; onJobDone can abort the remaining jobs by returning false.
export async function renderOverlayJobs(
  entryPoint: string,
  jobs: RenderJob[],
  onJobDone: (index: number, result: RenderResult) => Promise<boolean>
): Promise<void> {
  const bundleStarted = Date.now();
  let serveUrl: string;
  let browser: Awaited<ReturnType<typeof openBrowser>>;
  try {
    serveUrl = await bundle({ entryPoint });
    browser = await openBrowser('chrome');
  } catch (err) {
    const result = { ok: false, log: `Bundling failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, ms: Date.now() - bundleStarted };
    await onJobDone(0, result);
    return;
  }

  try {
    const composition = await selectComposition({ serveUrl, id: 'Overlay', puppeteerInstance: browser });
    for (const [i, job] of jobs.entries()) {
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
          ...(job.frames ? { frameRange: [job.frames.from, job.frames.to] as [number, number] } : {}),
        });
        result = { ok: true, log: `rendered ${job.outputLocation}`, ms: Date.now() - started };
      } catch (err) {
        result = { ok: false, log: err instanceof Error ? err.stack ?? err.message : String(err), ms: Date.now() - started };
      }
      if (!(await onJobDone(i, result)) || !result.ok) return;
    }
  } finally {
    await browser.close({ silent: true }).catch(() => {});
  }
}
