import React, { useEffect, useRef, useState } from 'react';
import { VoiceSampleButton } from './VoiceSampleButton';
import { narrationUrl, playableNarration, VOICE_TAIL_SEC, type Marker, type VoiceOptions } from '../api/client';

// A typical voiceover pace, used to estimate how long a line takes before it is generated.
const WORDS_PER_SECOND = 2.5;

export const estimateSpeechSeconds = (text: string) => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words / WORDS_PER_SECOND;
};

interface Props {
  projectId: string;
  marker: Marker;
  voices: VoiceOptions | null;
  // The voice for a marker that has no line yet.
  defaultVoice: string;
  // Saves the line and voice, turns them into speech and lengthens the marker to hold it. An empty
  // line removes the voiceover.
  onGenerate: (markerId: string, text: string, voice: string) => Promise<void>;
  disabled?: boolean;
}

// The voiceover for an existing marker: the line, the voice, and its generated speech.
export const VoiceoverSection: React.FC<Props> = ({ projectId, marker, voices, defaultVoice, onGenerate, disabled }) => {
  const [text, setText] = useState(marker.narration?.text ?? '');
  const [voice, setVoice] = useState(marker.narration?.voice ?? defaultVoice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudio = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  };

  // A different marker starts from its own saved line, not the draft typed for the previous one.
  useEffect(() => {
    setText(marker.narration?.text ?? '');
    setVoice(marker.narration?.voice ?? defaultVoice);
    setError(null);
    stopAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marker.marker_id]);

  useEffect(() => () => audioRef.current?.pause(), []);

  const saved = marker.narration;
  const audio = playableNarration(marker);
  const trimmed = text.trim();
  const changed = trimmed !== (saved?.text ?? '') || (trimmed !== '' && voice !== (saved?.voice ?? defaultVoice));
  // Generated speech exists but no longer matches the saved line or voice.
  const outdated = !!saved?.audio && !audio;
  const markerSeconds = marker.end - marker.start;
  const current = audio && !changed ? audio : null;
  // How long the line runs: measured once generated, estimated before.
  const spoken = current ? current.durationSec : trimmed ? estimateSpeechSeconds(trimmed) : 0;
  // The voice is never sped up or cut; the marker grows to hold it.
  const tooLong = spoken + VOICE_TAIL_SEC > markerSeconds + 0.01;
  const maxChars = voices?.maxChars ?? 4096;

  const run = async (nextText: string, nextVoice = voice) => {
    setBusy(true);
    setError(null);
    stopAudio();
    try {
      await onGenerate(marker.marker_id, nextText, nextVoice);
      if (!nextText.trim()) setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const togglePlay = () => {
    if (playing) return stopAudio();
    if (!audio) return;
    const el = new Audio(narrationUrl(projectId, audio.file));
    el.onended = stopAudio;
    el.onerror = () => {
      stopAudio();
      setError('The voice file could not be played.');
    };
    audioRef.current = el;
    setPlaying(true);
    el.play().catch(stopAudio);
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <label className="field-label">Voiceover</label>
      <textarea
        className="field-textarea"
        rows={3}
        maxLength={maxChars}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Words a voice reads aloud from the start of this marker (optional)"
        disabled={busy || disabled}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <select
          className="field-select"
          style={{ width: 'auto', padding: '5px 8px' }}
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          disabled={busy || disabled || !voices}
          aria-label="Voice"
          title="Voice"
        >
          {(voices?.voices ?? [voice]).map((v) => (
            <option key={v} value={v}>
              {v[0].toUpperCase() + v.slice(1)}
            </option>
          ))}
        </select>
        <VoiceSampleButton voice={voice} disabled={busy || disabled || !voices} />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || disabled || !trimmed || (!changed && !!audio)}
          onClick={() => run(text)}
          title="Turn this line into speech with OpenAI (billed to your OpenAI key)"
        >
          {busy ? 'Generating voice…' : audio || outdated ? 'Regenerate voice' : 'Generate voice'}
        </button>
        {audio && (
          <button type="button" className="btn btn-sm" onClick={togglePlay} disabled={busy}>
            {playing ? 'Stop' : 'Play'}
          </button>
        )}
        {saved && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || disabled} onClick={() => run('')}>
            Remove
          </button>
        )}
      </div>
      {trimmed && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>
          {current ? `Voice: ${current.durationSec.toFixed(1)}s` : `About ${spoken.toFixed(1)}s when spoken`} · marker{' '}
          {markerSeconds.toFixed(1)}s
        </div>
      )}
      {(changed || outdated) && saved && !busy && (
        <div style={{ fontSize: 11.5, color: 'var(--mango)', marginTop: 4 }}>
          {changed ? 'Not saved yet. ' : ''}Generate the voice again to hear this line; until then the preview and export leave it out.
        </div>
      )}
      {tooLong && !current && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>
          The marker will be lengthened to fit the voice, and every later marker moves back by the same amount.
        </div>
      )}
      {tooLong && current && saved && (
        <div className="status-line status-error" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 auto' }}>The voice runs {(spoken + VOICE_TAIL_SEC - markerSeconds).toFixed(1)}s past the end of the marker.</span>
          <button type="button" className="btn btn-sm" disabled={busy || disabled} onClick={() => run(saved.text, saved.voice)}>
            Stretch marker to fit
          </button>
        </div>
      )}
      {audio && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>
          This is an AI-generated voice. OpenAI's terms ask you to tell viewers so, for example in the video or its description.
        </div>
      )}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
};
