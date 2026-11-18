// The words as heard on the timeline. Click a word to go there; select words (click, shift-click) and cut
// them: every track is cut at those times and the gap closes (Descript-style). Also: find, and one-click
// suggestions for long pauses and filler words, shown before anything is cut.
import { cutRanges, fillers, pauses, type TimelineWord } from '@mangoai/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Player } from '../engine/player';
import { studio, useStudio } from '../store';
import { timecode } from './Transport';

export function Transcript({ player }: { player: Player | null }) {
  const s = useStudio();
  const words = s.resolved()?.words ?? [];
  const fps = s.editor?.project.fps ?? 30;
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [find, setFind] = useState('');
  const [suggest, setSuggest] = useState<{ kind: string; ranges: [number, number][] } | null>(null);
  const [now, setNow] = useState(-1);
  const box = useRef<HTMLDivElement>(null);

  // the word being spoken, followed while playing
  useEffect(() => {
    if (!player) return;
    let last = -1;
    return player.onChange(() => {
      const t = player.time();
      let lo = 0;
      let hi = words.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (words[m]!.e <= t) lo = m + 1;
        else hi = m;
      }
      const i = lo < words.length && words[lo]!.s <= t ? lo : -1;
      if (i !== last) {
        last = i;
        setNow(i);
        if (i >= 0 && player.isPlaying) box.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    });
  }, [player, words]);

  // lines: break at long pauses or every ~14 words
  const lines = useMemo(() => {
    const out: { from: number; to: number }[] = [];
    let start = 0;
    for (let i = 1; i <= words.length; i++) {
      if (i === words.length || words[i]!.s - words[i - 1]!.e > 0.7 || i - start >= 14) {
        out.push({ from: start, to: i });
        start = i;
      }
    }
    return out;
  }, [words]);

  const hits = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (!q) return new Set<number>();
    const parts = q.split(/\s+/);
    const out = new Set<number>();
    for (let i = 0; i + parts.length <= words.length; i++)
      if (parts.every((p, k) => words[i + k]!.w.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, '').includes(p))) for (let k = 0; k < parts.length; k++) out.add(i + k);
    return out;
  }, [find, words]);

  const click = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && sel) setSel([Math.min(sel[0], i), Math.max(sel[1], i)]);
    else {
      setSel([i, i]);
      player?.seek(words[i]!.s);
    }
  };

  const cutSel = () => {
    if (!sel) return;
    const a = words[sel[0]]!;
    const b = words[sel[1]]!;
    // from the start of the first word to the start of the next one, so no gap and no clipped word is left
    const next = words[sel[1] + 1];
    const end = next ? next.s : b.e;
    const text = words.slice(sel[0], sel[1] + 1).map((w) => w.w).join(' ');
    if (studio.run((ed) => cutRanges(ed, [[a.s, end]]), `cut “${text.slice(0, 50)}”`)) setSel(null);
  };

  const apply = () => {
    if (!suggest) return;
    const n = suggest.ranges.length;
    const total = suggest.ranges.reduce((x, [a, b]) => x + b - a, 0);
    if (studio.run((ed) => cutRanges(ed, suggest.ranges), `cut ${n} ${suggest.kind} (${total.toFixed(1)} s)`)) setSuggest(null);
  };

  const inSuggest = (w: TimelineWord) => suggest?.ranges.some(([a, b]) => w.s >= a - 1e-3 && w.e <= b + 1e-3);

  if (!words.length)
    return (
      <div className="panel side-body">
        <div className="panel-body muted">
          No transcript. Transcribe the voice with the media toolbox (or ask Claude), and put the words.tsv path in
          cut.json's <code>transcripts</code>; give the recording's clips <code>"transcript": "&lt;name&gt;"</code>.
        </div>
      </div>
    );

  return (
    <div className="panel side-body">
      <div className="panel-head">
        <input placeholder="Find words…" title="Highlight every match in the transcript" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <span className="muted small">{hits.size ? `${hits.size} words` : `${words.length} words`}</span>
      </div>
      <div className="row tools">
        <button disabled={!sel} onClick={cutSel} title="Cut the selected words out of every track and close the gap">
          ✂ Cut words
        </button>
        <button onClick={() => setSuggest({ kind: 'pauses', ranges: pauses(words, 0.8) })} title="Find silences over 0.8 s">
          Pauses
        </button>
        <button onClick={() => setSuggest({ kind: 'fillers', ranges: fillers(words) })} title="Find um, uh, …">
          Fillers
        </button>
      </div>
      {suggest && (
        <div className="banner small">
          {suggest.ranges.length} {suggest.kind}, {suggest.ranges.reduce((x, [a, b]) => x + b - a, 0).toFixed(1)} s in all.
          <button disabled={!suggest.ranges.length} onClick={apply} title="Cut all of these from every track and close the gaps">Cut them</button>
          <button className="ghost" onClick={() => setSuggest(null)} title="Keep everything">Cancel</button>
        </div>
      )}
      <div className="panel-body transcript" ref={box}>
        {lines.map((l) => (
          <p key={l.from}>
            <button className="ghost tc small" onClick={() => player?.seek(words[l.from]!.s)} title="Go to this line">{timecode(words[l.from]!.s, fps).slice(0, 5)}</button>{' '}
            {words.slice(l.from, l.to).map((w, k) => {
              const i = l.from + k;
              const cls = [
                'w',
                i === now ? 'now' : '',
                sel && i >= sel[0] && i <= sel[1] ? 'sel' : '',
                hits.has(i) ? 'hit' : '',
                inSuggest(w) ? 'cut' : '',
              ].join(' ');
              return (
                <span key={i} data-i={i} className={cls} onClick={(e) => click(i, e)} title={`${timecode(w.s, fps)} · click to jump, Shift-click to select`}>
                  {w.w}{' '}
                </span>
              );
            })}
          </p>
        ))}
      </div>
    </div>
  );
}
