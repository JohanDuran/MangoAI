import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export interface KpiCardProps {
  label: string;
  value: number;
  suffix?: string;
  x?: number;
  y?: number;
  accentColor?: string;
}

export const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  suffix = '',
  x = 720,
  y = 180,
  accentColor = '#a6e3a1',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 } });
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const count = Math.round(interpolate(enter, [0, 1], [0, value]));

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity,
        background: 'rgba(20, 20, 24, 0.85)',
        borderRadius: 14,
        padding: '20px 28px',
        fontFamily: 'Inter, Helvetica, Arial, sans-serif',
        color: 'white',
        borderLeft: `6px solid ${accentColor}`,
      }}
    >
      <div style={{ fontSize: 42, fontWeight: 700 }}>
        {count}
        {suffix}
      </div>
      <div style={{ fontSize: 18, opacity: 0.75, marginTop: 4 }}>{label}</div>
    </div>
  );
};
