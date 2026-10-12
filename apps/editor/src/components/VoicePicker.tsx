import React from 'react';
import { VoiceSampleButton } from './VoiceSampleButton';

interface Props {
  voices: string[] | null;
  value: string;
  onChange: (voice: string) => void;
  disabled?: boolean;
  title?: string;
}

const label = (v: string) => v[0].toUpperCase() + v.slice(1);

// A voice dropdown with a button to hear the chosen voice first.
export const VoicePicker: React.FC<Props> = ({ voices, value, onChange, disabled, title }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    <select
      className="field-select"
      style={{ width: 'auto', padding: '5px 8px' }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || !voices}
      aria-label="Voice"
      title={title ?? 'Voice'}
    >
      {(voices ?? [value]).map((v) => (
        <option key={v} value={v}>
          {label(v)}
        </option>
      ))}
    </select>
    <VoiceSampleButton voice={value} disabled={disabled || !voices} />
  </span>
);
