import React, { useEffect, useRef, useState } from 'react';
import { getVoiceSample } from '../api/client';

// Samples already fetched this session, so replaying one needs no request.
const sampleUrls = new Map<string, string>();
// Only one sample plays at a time, whichever button started it.
let current: { audio: HTMLAudioElement; owner: object; stop: () => void } | null = null;

// Plays a short sample of a voice, to hear it before picking it.
export const VoiceSampleButton: React.FC<{ voice: string; disabled?: boolean }> = ({ voice, disabled }) => {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState<string | null>(null);

  const owner = useRef({}).current;

  const stop = () => {
    if (current?.owner === owner) {
      current.audio.pause();
      current = null;
    }
    setState('idle');
  };

  // A different voice, or leaving the panel, stops this button's sample.
  useEffect(() => {
    setError(null);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice]);

  const play = async () => {
    if (state !== 'idle') return stop();
    current?.stop();
    setError(null);
    setState('loading');
    try {
      let url = sampleUrls.get(voice);
      if (!url) {
        url = URL.createObjectURL(await getVoiceSample(voice));
        sampleUrls.set(voice, url);
      }
      const audio = new Audio(url);
      audio.onended = stop;
      current = { audio, owner, stop };
      setState('playing');
      await audio.play();
    } catch (err) {
      stop();
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const name = voice[0].toUpperCase() + voice.slice(1);
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={play}
        disabled={disabled}
        aria-label={state === 'playing' ? 'Stop sample' : `Hear ${name}`}
        title={state === 'playing' ? 'Stop sample' : `Hear a sample of ${name} (the first listen to each voice is a tiny OpenAI request)`}
      >
        {state === 'loading' ? '…' : state === 'playing' ? '■' : '▶'}
      </button>
      {error && (
        <span className="field-error" style={{ flexBasis: '100%', margin: 0 }}>
          {error}
        </span>
      )}
    </>
  );
};
