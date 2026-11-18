// The media toolbox's GPU models, from the editor: find or generate sounds, voice a line, transcribe a clip.
// MangoAI edits and renders; the toolbox (Docker) only runs the models. Everything it makes lands in the
// project folder or the shared sound library, and goes on the timeline as ordinary clips (undoable).
import type { Clip, Op, Track, Word } from '@mangoai/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Player } from '../engine/player';
import { studio, useStudio } from '../store';

interface Status {
  up: boolean;
  url: string;
  voices?: string[];
  error?: string;
}
interface Sound {
  file: string;
  path: string;
  prompt?: string;
  seconds?: number;
  status?: string;
  tags?: string[];
}
type Role = 'voice' | 'sfx' | 'music' | 'other';

const KOKORO = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_michael', 'am_adam', 'am_onyx', 'am_eric', 'bf_emma', 'bm_george', 'ef_dora', 'em_alex'];

function remembered(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`mangoai.toolbox.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, v: string) {
  try {
    localStorage.setItem(`mangoai.toolbox.${key}`, v);
  } catch {}
}

/** Put an audio file on the timeline at `t`: on a free track of that role, else a new one. */
async function addAudio(path: string, role: Role, t: number, label?: string): Promise<string | null> {
  const ed = studio.editor;
  if (!ed) return null;
  const src = studio.srcOf(path);
  await studio.probe([src]);
  const dur = studio.opened?.media[src]?.duration ?? 2;
  const res = studio.resolved();
  const free = (tr: Track) =>
    !tr.locked &&
    tr.kind === 'audio' &&
    (tr.role ?? 'other') === role &&
    tr.clips.every((c) => {
      const r = res?.clips.get(c.id);
      return !r || (r.end ?? Infinity) <= t + 1e-3 || r.start >= t + dur - 1e-3;
    });
  const ops: Op[] = [];
  let track = ed.project.tracks.find(free);
  if (!track) {
    track = { id: ed.freshId('A'), kind: 'audio', role, clips: [] };
    ops.push({ op: 'add_track', track, index: ed.project.tracks.length });
  }
  const clip = {
    id: ed.freshId(role === 'voice' ? 'line' : role === 'sfx' ? 'sfx' : 'a'),
    type: 'media',
    src,
    start: Math.round(t * 1e4) / 1e4,
    end: Math.round((t + dur) * 1e4) / 1e4,
    ...(label && { label }),
  } as Clip;
  ops.push({ op: 'add_clip', track: track.id, clip });
  if (!studio.apply(ops, `added ${src.split('/').pop()} at ${t.toFixed(2)} s`)) return null;
  studio.select(clip.id);
  return clip.id;
}

function Play({ path }: { path: string }) {
  const [on, setOn] = useState(false);
  const el = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => el.current?.pause(), []);
  return (
    <button
      className="ghost small"
      title="Listen"
      onClick={() => {
        if (on) {
          el.current?.pause();
          setOn(false);
          return;
        }
        el.current?.pause();
        const a = new Audio(`/api/file?path=${encodeURIComponent(path)}`);
        a.onended = () => setOn(false);
        el.current = a;
        void a.play().then(() => setOn(true)).catch(() => setOn(false));
      }}
    >
      {on ? '■' : '▶'}
    </button>
  );
}

function SoundRow({ s, player, isNew }: { s: Sound; player: Player | null; isNew?: boolean }) {
  return (
    <li
      className="sound"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/mango-path', s.path);
        e.dataTransfer.setData('text/mango-kind', 'audio');
      }}
      title="Drag onto the timeline, or add at the playhead"
    >
      <Play path={s.path} />
      <span className="grow">
        {isNew && <span className="badge">new</span>} {s.prompt ?? s.file}
        <span className="muted small">
          {' '}
          {s.seconds ? `${s.seconds}s` : ''}
          {s.status === 'keep' ? ' · keep' : ''}
          {s.tags?.length ? ` · ${s.tags.join(', ')}` : ''}
        </span>
      </span>
      <button
        className="small"
        onClick={async () => {
          const id = await addAudio(s.path, 'sfx', player?.time() ?? 0, (s.prompt ?? s.file).slice(0, 40));
          if (id) void api.post('/api/toolbox/used', { dir: studio.opened!.dir, file: s.file }).catch(() => {});
        }}
        title="Add the sound to the SFX track at the playhead"
      >
        + at playhead
      </button>
    </li>
  );
}

export function ToolboxPanel({ player }: { player: Player | null }) {
  const s = useStudio();
  const dir = s.opened?.dir ?? '';
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const check = () =>
    void api
      .get<Status>('/api/toolbox/status')
      .then(setSt)
      .catch((e: Error) => setSt({ up: false, url: '', error: e.message }));
  useEffect(check, []);

  const job = async <T,>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    setErr(null);
    try {
      return await fn();
    } catch (e) {
      setErr((e as Error).message);
      check();
      return null;
    } finally {
      setBusy(null);
    }
  };

  // --- sounds
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Sound[] | null>(null);
  const [made, setMade] = useState<Sound[]>([]);
  const [prompt, setPrompt] = useState('');
  const [secs, setSecs] = useState('2');
  const search = async () => {
    const r = await job('Searching the sound library…', () => api.get<{ sounds: Sound[] }>(`/api/toolbox/library?q=${encodeURIComponent(q)}`));
    if (r) setFound(r.sounds.slice(0, 40));
  };
  const generate = async () => {
    const r = await job('Generating sounds (Stable Audio, about 10–40 s)…', () => api.post<{ sounds: Sound[] }>('/api/toolbox/sfx', { prompt, seconds: Number(secs) || 2, variations: 3 }));
    if (r) setMade((m) => [...r.sounds, ...m]);
  };

  // --- voice
  const [text, setText] = useState('');
  const [voice, setVoice] = useState(() => remembered('voice', 'kokoro:af_heart'));
  const [line, setLine] = useState<{ path: string; seconds: number | null } | null>(null);
  const speak = async () => {
    const [engine, name] = voice.split(':') as [string, string];
    const r = await job(engine === 'clone' ? `Voicing in ${name} (Chatterbox)…` : 'Voicing (Kokoro)…', () =>
      api.post<{ path: string; seconds: number | null }>('/api/toolbox/speak', { dir, text, ...(engine === 'clone' ? { clone: name } : { voice: name }) }),
    );
    if (r) setLine(r);
  };

  // --- transcription: sources of media clips that have no transcript yet
  const untranscribed = useMemo(() => {
    const p = s.editor?.project;
    if (!p) return [] as { src: string; clips: string[] }[];
    const by = new Map<string, string[]>();
    for (const tr of p.tracks)
      for (const c of tr.clips)
        // speech lives on video tracks and voice / other audio tracks; sound effects and music have no words
        if (c.type === 'media' && !c.transcript && !c.still && (tr.kind === 'video' || (tr.kind === 'audio' && tr.role !== 'sfx' && tr.role !== 'music')))
          by.set(c.src, [...(by.get(c.src) ?? []), c.id]);
    return [...by].map(([src, clips]) => ({ src, clips })).filter(({ src }) => s.opened?.media[src]?.kind !== 'image');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.editor?.version, s.editor]);
  const transcribe = async (src: string, clips: string[]) => {
    const r = await job(`Transcribing ${src.split('/').pop()} (WhisperX)…`, () => api.post<{ file: string; words: Word[] }>('/api/toolbox/transcribe', { dir, src }));
    if (!r) return;
    const base = (src.split('/').pop() ?? 'rec').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'rec';
    const taken = new Set(Object.keys(s.editor?.project.transcripts ?? {}));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
    if (studio.addTranscript(name, r.file, r.words, clips)) studio.flash(`Transcribed: ${r.words.length} words, linked to ${clips.length} clip(s). Save to keep it.`);
  };

  const down = st && !st.up;
  return (
    <div className="panel side-body toolbox">
      <div className="panel-body">
        <div className={`tb-status small ${st?.up ? 'ok' : down ? 'down' : ''}`}>
          <span className="dot" /> {st === null ? 'Checking the media toolbox…' : st.up ? 'Media toolbox connected' : 'Media toolbox not running: start Docker Desktop.'}
          <button className="link" onClick={check} title="Check again whether the media toolbox is running">
            check again
          </button>
        </div>
        {busy && <div className="tb-busy small">{busy}</div>}
        {err && <div className="tb-err small">{err}</div>}

        <h4>Sounds</h4>
        <div className="row">
          <input placeholder="Search the library: whoosh, pop, coin…" title="Search the shared sound library (Enter)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void search(); }} />
          <button disabled={!!busy || !!down} onClick={() => void search()} title="Search the shared sound library">
            Search
          </button>
        </div>
        {made.length > 0 && <ul className="sounds">{made.map((x) => <SoundRow key={x.path} s={x} player={player} isNew />)}</ul>}
        {found && (found.length ? <ul className="sounds">{found.map((x) => <SoundRow key={x.path} s={x} player={player} />)}</ul> : <div className="muted small">Nothing in the library for that. Generate one below.</div>)}
        <div className="row">
          <input placeholder="Or generate: soft UI pop, short, clean, no music" title="Describe a sound to generate with Stable Audio" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <input className="secs" title="Length of the generated sound, in seconds" value={secs} onChange={(e) => setSecs(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button disabled={!!busy || !!down || !prompt.trim()} onClick={() => void generate()} title="3 variations with Stable Audio, saved to the shared sound library">
            Generate
          </button>
        </div>

        <h4>Voice a line</h4>
        <textarea rows={3} placeholder="Type what to say" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <div className="row">
          <select
            title="Voice: a cloned voice (Chatterbox) or a Kokoro voice"
            value={voice}
            onChange={(e) => {
              setVoice(e.target.value);
              remember('voice', e.target.value);
            }}
          >
            {(st?.voices ?? []).length > 0 && (
              <optgroup label="Cloned voices (Chatterbox)">
                {st!.voices!.map((v) => (
                  <option key={v} value={`clone:${v}`}>
                    {v}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Kokoro">
              {KOKORO.map((v) => (
                <option key={v} value={`kokoro:${v}`}>
                  {v}
                </option>
              ))}
            </optgroup>
          </select>
          <button disabled={!!busy || !!down || !text.trim()} onClick={() => void speak()} title="Make a voice line from the text with the chosen voice">
            Voice it
          </button>
        </div>
        {line && (
          <ul className="sounds">
            <li
              className="sound"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/mango-path', line.path);
                e.dataTransfer.setData('text/mango-kind', 'audio');
              }}
            >
              <Play path={line.path} />
              <span className="grow">
                {line.path.split(/[\\/]/).pop()} <span className="muted small">{line.seconds ? `${line.seconds.toFixed(1)}s` : ''}</span>
              </span>
              <button className="small" onClick={() => void addAudio(line.path, 'voice', player?.time() ?? 0, text.slice(0, 40))} title="Add the line to the voice track at the playhead">
                + at playhead
              </button>
            </li>
          </ul>
        )}

        <h4>Transcribe</h4>
        {untranscribed.length === 0 ? (
          <div className="muted small">Every recording on the timeline has a transcript.</div>
        ) : (
          <ul className="sounds">
            {untranscribed.map(({ src, clips }) => (
              <li key={src} className="sound">
                <span className="grow">
                  {src.split('/').pop()} <span className="muted small">{clips.length} clip(s)</span>
                </span>
                <button className="small" disabled={!!busy || !!down} onClick={() => void transcribe(src, clips)} title="Word timings with WhisperX; then its words follow these clips">
                  Transcribe
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="muted small">Transcripts go in the project's transcripts folder; voice lines in audio/lines; new sounds in the shared sound library.</div>
      </div>
    </div>
  );
}
