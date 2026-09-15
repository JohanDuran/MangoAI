import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export interface ImagePopupProps {
  src: string;
  x?: number;
  y?: number;
  width?: number;
}

export const ImagePopup: React.FC<ImagePopupProps> = ({ src, x = 700, y = 150, width = 420 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 10, stiffness: 150 } });
  const scale = interpolate(enter, [0, 1], [0.6, 1]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `scale(${scale})`,
        opacity,
        width,
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
      }}
    >
      <img src={src} style={{ width: '100%', display: 'block' }} />
    </div>
  );
};
