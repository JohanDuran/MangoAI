import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export interface LowerThirdProps {
  title: string;
  subtitle?: string;
  accentColor?: string;
}

export const LowerThird: React.FC<LowerThirdProps> = ({
  title,
  subtitle,
  accentColor = '#ff7a3d',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 } });
  const translateX = interpolate(enter, [0, 1], [-60, 0]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  return (
    <div
      style={{
        position: 'absolute',
        left: 80,
        bottom: 120,
        transform: `translateX(${translateX}px)`,
        opacity,
        fontFamily: 'Inter, Helvetica, Arial, sans-serif',
        color: 'white',
      }}
    >
      <div style={{ width: 6, height: 44, background: accentColor, display: 'inline-block', marginRight: 16, verticalAlign: 'middle' }} />
      <div style={{ display: 'inline-block', verticalAlign: 'middle' }}>
        <div style={{ fontSize: 40, fontWeight: 700, lineHeight: 1.1 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 22, opacity: 0.8, marginTop: 4 }}>{subtitle}</div>}
      </div>
    </div>
  );
};
