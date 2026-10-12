import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';
import { readMarkers, type MarkerRegion } from './markers.js';
import { readCompositionConfig } from './composition.js';
import { readAssets } from './assets.js';
import { runClaudeHeadlessCapturingText, withProjectLock } from './claude.js';
import { existingMarkerLines, libraryAssetLines, areaInPixels } from './planner.js';
import { lengthIsFixed } from './timeline.js';
import { log } from './log.js';

// The conversation in which the creator and Claude work out a video idea before any marker is
// designed, and the brief they agree on at the end. Designing from an idea plans from that brief
// (planMarkersFromIdea), not from the conversation itself. Kept on disk so it survives a reload,
// and removed only when the creator starts over.
export interface IdeaChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface IdeaChat {
  messages: IdeaChatMessage[];
  // Null until it is first written; the creator may edit it afterwards.
  brief: string | null;
  updatedAt: string;
}

export const MAX_CHAT_MESSAGE_CHARS = 6000;
export const MAX_BRIEF_CHARS = 12000;

// What the panel settings tell Claude: the area every marker goes in, whether there is a voiceover,
// and whether markers may use images generated with AI.
export interface IdeaChatOptions {
  region?: MarkerRegion;
  narration?: boolean;
  images?: boolean;
}

const chatFile = (id: string) => path.join(projectDir(id), '00_input', 'idea-chat.json');

const emptyChat = (): IdeaChat => ({ messages: [], brief: null, updatedAt: new Date().toISOString() });

export function readIdeaChat(id: string): IdeaChat {
  const file = chatFile(id);
  if (!fs.existsSync(file)) return emptyChat();
  try {
    return readJson<IdeaChat>(file);
  } catch {
    return emptyChat();
  }
}

function writeIdeaChat(id: string, chat: Omit<IdeaChat, 'updatedAt'>): IdeaChat {
  const stored = { ...chat, updatedAt: new Date().toISOString() };
  writeJsonAtomic(chatFile(id), stored);
  return stored;
}

export function clearIdeaChat(id: string): void {
  for (const file of [chatFile(id), `${chatFile(id)}.bak`]) fs.rmSync(file, { force: true });
}

export function saveIdeaBrief(id: string, brief: string): IdeaChat {
  return writeIdeaChat(id, { ...readIdeaChat(id), brief: brief.slice(0, MAX_BRIEF_CHARS) });
}

// The project facts both prompts start from, the same ones the idea planner gets.
function projectContext(id: string, opts: IdeaChatOptions): string {
  const { width, height, fps, durationInFrames } = readCompositionConfig(id);
  const durationSeconds = durationInFrames / fps;
  const library = readAssets(id);
  return [
    `The video is ${width}x${height}px and ${durationSeconds.toFixed(1)} seconds long. Its animated overlays are planned as a sequence of timed markers covering 0s to ${durationSeconds.toFixed(1)}s; each marker is one animation built by another agent from a short description.`,
    lengthIsFixed(id)
      ? 'The length is fixed: the overlays go on top of an uploaded video, so the plan has to fit inside it.'
      : 'The overlays are the whole video, on a blank canvas, so the length is only a starting point: if the idea needs more time, the video can be longer.',
    `Markers that already exist (new ones cannot overlap them):\n${existingMarkerLines(readMarkers(id).map((m) => ({ start: m.start, end: m.end, prompt: m.prompt })))}`,
    opts.region
      ? `Every marker is confined to the same area the creator chose: ${areaInPixels(opts.region, width, height)} of the canvas.`
      : 'Each marker can use the full screen or a part of it.',
    opts.narration
      ? 'The video gets an AI voiceover: each marker has a line read aloud from its start, at about 2.5 words per second, and together the lines read as one script.'
      : 'There is no voiceover; the animations carry the message on their own.',
    opts.images
      ? 'AI image generation is allowed: a marker can use an image generated with AI (a photo, a realistic scene, a detailed illustration) where one adds real value; text, numbers, charts and simple shapes are drawn in code instead.'
      : 'No images are generated with AI; markers are drawn in code or use the library images.',
    library.length > 0 ? `Images in the project library that markers can use:\n${libraryAssetLines(library)}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

const conversationText = (messages: IdeaChatMessage[]): string =>
  messages.map((m) => `${m.role === 'user' ? 'Creator' : 'You'}: ${m.text}`).join('\n\n');

function buildReplyPrompt(id: string, chat: IdeaChat, message: string, opts: IdeaChatOptions): string {
  return [
    "You are a creative director talking a video idea through with its creator, before anything is designed or built. This is a back-and-forth conversation; the storyboard comes later, once the creator is happy with the plan.",
    projectContext(id, opts),
    [
      'How to take part:',
      '- Do not jump to a finished storyboard. First understand what the video is for: the message, the audience, the payoff at the end, and the look and tone.',
      '- Ask only the few questions (at most three) whose answers would change the design most, and offer concrete suggestions or options the creator can react to instead of open-ended questions alone.',
      '- Once you know enough, propose a structure: the beats in order with rough timings that fit the length, and refine it with them.',
      "- Say so when something will not fit the length or the area, or would be hard to read on screen, and suggest an alternative.",
      '- Keep replies short and conversational: a few sentences, or a short list using "- " lines. Plain text only: no headings, bold, tables or code.',
      '- When the plan seems settled, say so and suggest they click "Write the brief". Never say that you built or generated anything.',
    ].join('\n'),
    chat.brief?.trim() ? `The brief written so far (the creator may have edited it since):\n${chat.brief.trim()}` : null,
    chat.messages.length > 0 ? `The conversation so far:\n\n${conversationText(chat.messages)}` : null,
    `The creator's new message:\n${message}`,
    'Reply to the creator. Output only your reply.',
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

function buildBriefPrompt(id: string, chat: IdeaChat, opts: IdeaChatOptions): string {
  const { fps, durationInFrames } = readCompositionConfig(id);
  const durationSeconds = (durationInFrames / fps).toFixed(1);
  return [
    'You talked a video idea through with its creator. Now write the design brief you agreed on.',
    projectContext(id, opts),
    `The conversation:\n\n${conversationText(chat.messages)}`,
    chat.brief?.trim() ? `An earlier version of the brief (the creator may have edited it; keep their edits unless the conversation changed them since):\n${chat.brief.trim()}` : null,
    [
      'Another agent turns this brief into the timed markers without seeing the conversation, so put in it everything that was decided: content, numbers, wording, order, style. Use what was said or clearly implied; where something was not settled, make a sensible choice and mark it "(open)".',
      'Write plain text in this shape, without headings, bold or code:',
      'Goal: one or two sentences.',
      'Audience: who it is for.',
      'Look and tone: visual style, colors, mood, pacing.',
      `Beats: a numbered list in order, each with a rough time range in seconds, together covering 0 to ${durationSeconds}s, saying what is on screen${opts.narration ? ' and what the voiceover says' : ''}.`,
      opts.images ? 'AI images: which beats use an image generated with AI and what each shows, or "none".' : null,
      opts.narration
        ? "Voiceover: its tone and any lines agreed word for word. A voice reads about 2.5 words per second, so the words for each beat must fit its length (a 10-second beat gets at most 25 words); shorten any line that does not fit, also one taken from an earlier brief, unless the creator fixed its wording."
        : null,
      'Must include: anything the creator insisted on.',
      'Avoid: anything the creator ruled out.',
      'Output only the brief.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

async function askClaude(id: string, prompt: string, purpose: string, signal?: AbortSignal): Promise<string> {
  const { text, success, failure } = await withProjectLock(id, 'chat', () =>
    runClaudeHeadlessCapturingText({
      cwd: projectDir(id),
      prompt,
      tools: [],
      logContext: { project: id, purpose },
      signal,
      onEvent: () => {},
    })
  );
  if (!success) throw new Error(failure?.message ?? 'Claude did not answer.');
  if (!text.trim()) throw new Error('Claude answered with nothing. Try again.');
  return text.trim();
}

// The creator's message and Claude's reply are saved together once the reply is in, so a stopped or
// failed reply leaves the conversation as it was.
export async function replyInIdeaChat(id: string, message: string, opts: IdeaChatOptions, signal?: AbortSignal): Promise<IdeaChat> {
  const text = message.trim().slice(0, MAX_CHAT_MESSAGE_CHARS);
  if (!text) throw new Error('Write a message first.');
  const reply = await askClaude(id, buildReplyPrompt(id, readIdeaChat(id), text, opts), 'idea-chat', signal);
  const chat = readIdeaChat(id);
  const now = new Date().toISOString();
  log('info', 'idea-chat.reply', { project: id, messages: chat.messages.length + 2 });
  return writeIdeaChat(id, {
    ...chat,
    messages: [...chat.messages, { role: 'user', text, at: now }, { role: 'assistant', text: reply, at: now }],
  });
}

export async function writeBriefFromIdeaChat(id: string, opts: IdeaChatOptions, signal?: AbortSignal): Promise<IdeaChat> {
  const chat = readIdeaChat(id);
  if (chat.messages.length === 0) throw new Error('Talk the idea through with Claude first.');
  const brief = await askClaude(id, buildBriefPrompt(id, chat, opts), 'idea-brief', signal);
  log('info', 'idea-chat.brief', { project: id, chars: brief.length });
  return saveIdeaBrief(id, brief);
}
