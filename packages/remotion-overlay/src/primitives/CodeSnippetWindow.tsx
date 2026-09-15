import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export interface CodeSnippetWindowProps {
  code: string;
  language?: string;
  x?: number;
  y?: number;
}

export const CodeSnippetWindow: React.FC<CodeSnippetWindowProps> = ({
  code,
  language = 'sql',
  x = 640,
  y = 260,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 } });
  const translateY = interpolate(enter, [0, 1], [30, 0]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `translateY(${translateY}px)`,
        opacity,
        background: '#1e1e2e',
        borderRadius: 10,
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        minWidth: 480,
      }}
    >
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', background: '#181825' }}>
        <div style={{ width: 12, height: 12, borderRadius: 6, background: '#f38ba8' }} />
        <div style={{ width: 12, height: 12, borderRadius: 6, background: '#f9e2af' }} />
        <div style={{ width: 12, height: 12, borderRadius: 6, background: '#a6e3a1' }} />
        <div style={{ marginLeft: 'auto', color: '#6c7086', fontSize: 13, fontFamily: 'monospace' }}>{language}</div>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '18px 20px',
          color: '#cdd6f4',
          fontFamily: 'Menlo, Consolas, monospace',
          fontSize: 20,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}
      >
        {code}
      </pre>
    </div>
  );
};
