import React from 'react';
import { getRemotionEnvironment } from 'remotion';

interface Props {
  markerId: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

// Wraps one marker's animation. In the editor preview a crashing marker shows a small message inside
// its own area instead of taking the whole overlay (and the editor's timeline view) down with it.
// While rendering an export the error is rethrown: a silently missing animation in the final video
// is worse than a failed export with a clear message.
export class MarkerErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error(`Marker ${this.props.markerId} crashed while rendering:`, error);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (getRemotionEnvironment().isRendering) throw error;
    return (
      <div
        style={{
          position: 'absolute',
          left: 8,
          top: 8,
          maxWidth: '90%',
          padding: '6px 10px',
          borderRadius: 6,
          background: 'rgba(120, 20, 20, 0.85)',
          color: 'white',
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: 14,
          lineHeight: 1.3,
        }}
      >
        Marker {this.props.markerId} has an error: {error.message.slice(0, 160)}
      </div>
    );
  }
}
