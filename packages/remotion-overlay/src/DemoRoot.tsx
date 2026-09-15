import React from 'react';
import { AbsoluteFill, Composition, Sequence } from 'remotion';
import { LowerThird } from './primitives/LowerThird';
import { CalloutTextBox } from './primitives/CalloutTextBox';
import { CodeSnippetWindow } from './primitives/CodeSnippetWindow';
import { KpiCard } from './primitives/KpiCard';

const PrimitivesDemo: React.FC = () => (
  <AbsoluteFill style={{ background: 'transparent' }}>
    <Sequence from={0} durationInFrames={90}>
      <LowerThird title="MangoAI" subtitle="Overlay primitives demo" />
    </Sequence>
    <Sequence from={30} durationInFrames={90}>
      <CalloutTextBox text="Callout text box primitive" />
    </Sequence>
    <Sequence from={60} durationInFrames={90}>
      <CodeSnippetWindow code={'SELECT * FROM overlays;'} />
    </Sequence>
    <Sequence from={90} durationInFrames={90}>
      <KpiCard label="Render time saved" value={87} suffix="%" />
    </Sequence>
  </AbsoluteFill>
);

export const DemoRoot: React.FC = () => (
  <Composition
    id="PrimitivesDemo"
    component={PrimitivesDemo}
    durationInFrames={180}
    fps={30}
    width={1920}
    height={1080}
  />
);
