import React, { useEffect, useRef } from 'react';
import type { MarkerRegion } from '../api/client';
import { formatRegion } from '../format';
import type { IdeaChatState } from '../useIdeaChat';
import { VoicePicker } from './VoicePicker';

interface Props {
  planning: boolean;
  stopping: boolean;
  error: string | null;
  // The conversation with Claude about the idea and the brief agreed in it (see useIdeaChat).
  chat: IdeaChatState;
  // Shown above the form, e.g. to say an earlier plan was interrupted.
  notice?: string | null;
  // The area every designed marker is confined to; null leaves each marker's area to Claude.
  region: MarkerRegion | null;
  editingRegion: boolean;
  onStartEditRegion: () => void;
  onDoneEditRegion: () => void;
  onResetRegion: () => void;
  // Whether Claude also writes a voiceover line for each marker.
  narration: boolean;
  onNarrationChange: (value: boolean) => void;
  // The voice the lines are read in (the project's voice until another is picked here).
  voices: string[] | null;
  voice: string;
  onVoiceChange: (voice: string) => void;
  onStop: () => void;
  // Designs the markers from the brief.
  onSubmit: (brief: string) => void;
  onCancel: () => void;
}

export const IdeaPlanPanel: React.FC<Props> = ({
  planning,
  stopping,
  error,
  chat,
  notice,
  region,
  editingRegion,
  onStartEditRegion,
  onDoneEditRegion,
  onResetRegion,
  narration,
  onNarrationChange,
  voices,
  voice,
  onVoiceChange,
  onStop,
  onSubmit,
  onCancel,
}) => {
  const messages = chat.chat?.messages ?? [];
  const talking = chat.busy !== null;
  const locked = planning || talking || !chat.chat;
  const canSend = chat.input.trim().length > 0 && !locked;
  const canWriteBrief = messages.length > 0 && !locked;
  const canSubmit = chat.hasBrief && chat.brief.trim().length > 0 && !locked;

  // Keeps the newest message in view.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length, chat.pendingMessage]);

  const startOver = () => {
    if (window.confirm('Start the conversation over? The messages and the brief are removed.')) void chat.startOver();
  };

  return (
    <div className="panel">
      {notice && <div className="panel-hint plan-interrupted">{notice}</div>}
      <div className="panel-hint">
        Talk the idea through with Claude first. When you agree on it, Claude writes a brief you can edit, and the markers
        are designed from that brief.
      </div>
      <div style={{ marginBottom: 12 }}>
        <span className="capture-label" style={{ display: 'block', marginBottom: 6 }}>
          Area for all markers
        </span>
        {editingRegion ? (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
              Drag on the preview above to draw, move, or resize the area every designed marker will be confined to.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={onResetRegion}>
                Full screen
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={onDoneEditRegion}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{formatRegion(region)}</span>
            <button type="button" className="btn btn-sm" onClick={onStartEditRegion} disabled={planning}>
              Edit area
            </button>
            {region && (
              <button type="button" className="btn btn-sm" onClick={onResetRegion} disabled={planning}>
                Full screen
              </button>
            )}
          </div>
        )}
      </div>
      <div className="add-marker-row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={narration} onChange={(e) => onNarrationChange(e.target.checked)} disabled={planning} />
          Write a voiceover: Claude adds a spoken line to each marker, read aloud by an AI voice from OpenAI (tell your viewers it is AI-generated)
        </label>
        {narration && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', marginLeft: 22 }}>
            Read by
            <VoicePicker voices={voices} value={voice} onChange={onVoiceChange} disabled={planning} title="The voice for this plan's voiceover" />
          </label>
        )}
      </div>

      <div className="idea-chat-log" ref={logRef}>
        {!chat.chat ? (
          <div className="idea-chat-empty">Loading the conversation…</div>
        ) : messages.length === 0 && !chat.pendingMessage ? (
          <div className="idea-chat-empty">
            Start with the idea in a sentence or two, e.g. "A ~60s video comparing investing $200/mo from age 20 vs. age 30,
            landing on the final numbers." Claude will ask what it needs to know before anything is designed.
          </div>
        ) : (
          <>
            {messages.map((m, i) => (
              <div key={i} className={`idea-chat-msg idea-chat-${m.role}`}>
                <div className="idea-chat-who">{m.role === 'user' ? 'You' : 'Claude'}</div>
                {m.text}
              </div>
            ))}
            {chat.pendingMessage && (
              <div className="idea-chat-msg idea-chat-user">
                <div className="idea-chat-who">You</div>
                {chat.pendingMessage}
              </div>
            )}
          </>
        )}
        {talking && (
          <div className="idea-chat-thinking">
            {chat.busy === 'brief' ? 'Claude is writing the brief…' : 'Claude is thinking…'}
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void chat.stop()} disabled={chat.stopping}>
              {chat.stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) void chat.send();
        }}
        className="add-marker-row"
      >
        <textarea
          className="field-textarea"
          rows={3}
          placeholder={messages.length === 0 ? 'Describe the idea…' : 'Reply to Claude…'}
          value={chat.input}
          onChange={(e) => chat.setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) void chat.send();
            }
          }}
          disabled={planning}
          title="Enter sends, Shift+Enter starts a new line"
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!canSend}>
            Send
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void chat.writeBrief()}
            disabled={!canWriteBrief}
            title="Claude sums up what you agreed on as a brief the markers are designed from"
          >
            {chat.hasBrief ? 'Rewrite the brief' : 'Write the brief'}
          </button>
          {(messages.length > 0 || chat.hasBrief) && (
            <button type="button" className="btn btn-sm" onClick={startOver} disabled={locked}>
              Start over
            </button>
          )}
        </div>
      </form>
      {chat.error && <div className="field-error">{chat.error}</div>}

      {chat.hasBrief && (
        <div className="add-marker-row" style={{ marginTop: 16 }}>
          <span className="capture-label" style={{ display: 'block' }}>
            Brief
          </span>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            The markers are designed from this, not from the conversation. Edit it freely, or keep talking and rewrite it.
          </div>
          <textarea
            className="field-textarea"
            rows={12}
            value={chat.brief}
            onChange={(e) => chat.setBrief(e.target.value)}
            disabled={planning}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {chat.hasBrief && (
          <button type="button" className="btn btn-primary" onClick={() => onSubmit(chat.brief)} disabled={!canSubmit}>
            {planning ? 'Designing…' : 'Design markers'}
          </button>
        )}
        {planning ? (
          <button type="button" className="btn btn-sm btn-danger" onClick={onStop} disabled={stopping} title="Stop Claude and throw this plan away">
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Close
          </button>
        )}
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
};
