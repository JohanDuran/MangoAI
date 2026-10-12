import { useEffect, useRef, useState } from 'react';
import {
  getIdeaChat,
  sendIdeaChatMessage,
  writeIdeaBrief,
  saveIdeaBrief,
  clearIdeaChat,
  stopWork,
  StoppedError,
  type IdeaChat,
  type IdeaChatSettings,
} from './api/client';

// The idea conversation of the open project (kept on the runner), what is being typed into it, and
// the brief being edited. settings are the idea panel's area and voiceover choices, sent with each turn.
export function useIdeaChat(projectId: string | null, settings: IdeaChatSettings) {
  const [chat, setChat] = useState<IdeaChat | null>(null);
  const [input, setInput] = useState('');
  const [brief, setBrief] = useState('');
  // What Claude is doing: answering a message or writing the brief.
  const [busy, setBusy] = useState<'reply' | 'brief' | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedBriefRef = useRef('');
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // A brief to show once the conversation has loaded (see adoptBrief).
  const adoptRef = useRef<string | null>(null);

  useEffect(() => {
    setChat(null);
    setInput('');
    setBrief('');
    setError(null);
    savedBriefRef.current = '';
    if (!projectId) return;
    let cancelled = false;
    getIdeaChat(projectId)
      .then((loaded) => {
        if (cancelled) return;
        const adopt = adoptRef.current;
        adoptRef.current = null;
        savedBriefRef.current = loaded.brief ?? '';
        if (adopt && !loaded.brief?.trim()) {
          setChat({ ...loaded, brief: adopt });
          setBrief(adopt);
        } else {
          setChat(loaded);
          setBrief(loaded.brief ?? '');
        }
      })
      .catch(() => {
        if (!cancelled) setChat({ messages: [], brief: null, updatedAt: '' });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const hasBrief = chat?.brief !== null && chat?.brief !== undefined;

  // Edits to the brief are saved shortly after they stop.
  useEffect(() => {
    if (!projectId || !hasBrief || brief === savedBriefRef.current) return;
    const timer = setTimeout(() => {
      saveIdeaBrief(projectId, brief)
        .then(() => {
          savedBriefRef.current = brief;
        })
        .catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [brief, hasBrief, projectId]);

  // Claude reads the saved brief, so edits not saved yet are saved first.
  const flushBrief = async () => {
    if (!projectId || !hasBrief || brief === savedBriefRef.current) return;
    await saveIdeaBrief(projectId, brief);
    savedBriefRef.current = brief;
  };

  const run = async (kind: 'reply' | 'brief', request: (id: string) => Promise<IdeaChat>, onFail?: () => void) => {
    if (!projectId || busy) return;
    setBusy(kind);
    setError(null);
    try {
      await flushBrief();
      const next = await request(projectId);
      setChat(next);
      if (kind === 'brief') {
        savedBriefRef.current = next.brief ?? '';
        setBrief(next.brief ?? '');
      }
    } catch (err) {
      onFail?.();
      if (!(err instanceof StoppedError)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setPendingMessage(null);
      setStopping(false);
    }
  };

  // The message shows in the conversation right away; if Claude does not answer, it goes back into the box.
  const send = () => {
    const text = input.trim();
    if (!text) return;
    setPendingMessage(text);
    setInput('');
    return run('reply', (id) => sendIdeaChatMessage(id, text, settingsRef.current), () => setInput(text));
  };

  const writeBrief = () => run('brief', (id) => writeIdeaBrief(id, settingsRef.current));

  const stop = async () => {
    if (!projectId || !busy) return;
    setStopping(true);
    try {
      const { stopped } = await stopWork(projectId, 'chat');
      if (stopped === 0) setStopping(false);
    } catch {
      setStopping(false);
    }
  };

  const startOver = async () => {
    if (!projectId) return;
    try {
      await clearIdeaChat(projectId);
      savedBriefRef.current = '';
      setChat({ messages: [], brief: null, updatedAt: new Date().toISOString() });
      setBrief('');
      setInput('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Shows a brief from elsewhere (an interrupted plan's) unless the conversation already has one.
  const adoptBrief = (text: string) => {
    if (!chat) {
      adoptRef.current = text;
      return;
    }
    if (chat.brief?.trim()) return;
    setChat({ ...chat, brief: text });
    setBrief(text);
  };

  return {
    chat,
    input,
    setInput,
    brief,
    setBrief,
    hasBrief,
    busy,
    pendingMessage,
    stopping,
    error,
    send,
    writeBrief,
    stop,
    startOver,
    flushBrief,
    adoptBrief,
  };
}

export type IdeaChatState = ReturnType<typeof useIdeaChat>;
