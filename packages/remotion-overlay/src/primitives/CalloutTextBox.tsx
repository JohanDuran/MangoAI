import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export interface CalloutTextBoxProps {
  text: string;
  x?: number;
  y?: number;
  background?: string;
}

export const CalloutTextBox: React.FC<CalloutTextBoxProps> = ({
  text,
  x = 640,
  y = 200,
  background = 'rgba(20, 20, 24, 0.85)',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 12, stiffness: 180 } });
  const scale = interpolate(enter, [0, 1], [0.7, 1]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `scale(${scale})`,
        opacity,
        background,
        color: 'white',
        padding: '18px 26px',
        borderRadius: 14,
        fontFamily: 'Inter, Helvetica, Arial, sans-serif',
        fontSize: 28,
        fontWeight: 600,
        maxWidth: 560,
      }}
    >
      {text}
    </div>
  );
};
