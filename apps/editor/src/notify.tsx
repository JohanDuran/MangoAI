import React, { useCallback, useEffect, useState } from 'react';

export type NoticeKind = 'error' | 'warn' | 'info';
export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
}

const EVENT = 'mango:notice';
let counter = 0;

// Shows a dismissible message from anywhere in the editor, including code that has no component of its own.
export function notify(kind: NoticeKind, text: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id: ++counter, kind, text } satisfies Notice }));
}

export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(message)) return 'Could not reach the MangoAI engine. If the app was just started, wait a moment and try again.';
  // API errors arrive as "<status> {"error":"..."}"; show only the human part.
  const json = /^\d{3} (\{.*\})$/s.exec(message);
  if (json) {
    try {
      const parsed = JSON.parse(json[1]) as { error?: string; log?: string };
      if (parsed.error) return parsed.error;
      if (parsed.log) return parsed.log.slice(0, 300);
    } catch {
      // fall through to the raw message
    }
  }
  return message;
}

export const NoticeStack: React.FC = () => {
  const [notices, setNotices] = useState<Notice[]>([]);
  const dismiss = useCallback((id: number) => setNotices((list) => list.filter((n) => n.id !== id)), []);

  useEffect(() => {
    const onNotice = (event: Event) => {
      const notice = (event as CustomEvent<Notice>).detail;
      setNotices((list) => [...list.filter((n) => n.text !== notice.text), notice].slice(-4));
      // Errors stay until dismissed; passing information goes away by itself.
      if (notice.kind !== 'error') setTimeout(() => dismiss(notice.id), 9000);
    };
    window.addEventListener(EVENT, onNotice);
    return () => window.removeEventListener(EVENT, onNotice);
  }, [dismiss]);

  if (notices.length === 0) return null;
  return (
    <div className="notice-stack" role="status">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.kind}`}>
          <span>{n.text}</span>
          <button type="button" className="notice-close" aria-label="Dismiss" onClick={() => dismiss(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
};
