import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';

// How alike the markers planned together are:
//   series  They repeat one format (quiz questions, a countdown, a chart revealed step by step). One
//           shared component is built once and every marker of the format renders it with its own
//           props, so they look the same by construction and a progression continues across them.
//   themed  Different beats with one visual identity. The first marker is built first and the rest
//           get its code as the reference to match.
//   varied  Each marker is designed on its own (only the shared look, if any, ties them).
export type Consistency = 'series' | 'themed' | 'varied';
export const CONSISTENCIES: Consistency[] = ['series', 'themed', 'varied'];
export const isConsistency = (v: unknown): v is Consistency => typeof v === 'string' && (CONSISTENCIES as string[]).includes(v);

// The component a series shares: its name (also its file name) and what it shows and takes.
export interface SeriesComponent {
  name: string;
  spec: string;
}

// The part of a series one marker is: which shared component it renders, and with what.
export interface MarkerSeries {
  component: string;
  props: Record<string, unknown>;
}

export const MAX_SPEC_CHARS = 6000;
export const MAX_PROPS_CHARS = 8000;

const NAME = /^[A-Z][A-Za-z0-9]{0,47}$/;
export const isComponentName = (v: unknown): v is string => typeof v === 'string' && NAME.test(v);

const sharedDir = (id: string) => path.join(projectDir(id), '03_remotion_code', 'shared');
export const sharedComponentFile = (id: string, name: string) => path.join(sharedDir(id), `${name}.tsx`);
// As Claude sees it, from the project folder.
export const sharedComponentPath = (name: string) => `03_remotion_code/shared/${name}.tsx`;

// A PascalCase name for the component that no earlier plan of the project already used, so a new
// plan never overwrites another plan's component that existing markers render.
export function pickComponentName(id: string, wanted: unknown): string {
  const words = typeof wanted === 'string' ? wanted.match(/[A-Za-z0-9]+/g) ?? [] : [];
  const joined = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('').replace(/^[0-9]+/, '');
  let base = (joined.charAt(0).toUpperCase() + joined.slice(1)).slice(0, 40);
  if (!isComponentName(base)) base = 'SeriesCard';
  let name = base;
  for (let n = 2; fs.existsSync(sharedComponentFile(id, name)); n++) name = `${base}${n}`;
  return name;
}

// A marker's props as the planner or the user wrote them: a JSON object, or null for none.
export function parseProps(text: string | undefined): Record<string, unknown> | null {
  if (!text?.trim()) return null;
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The template data must be a JSON object.');
  return value as Record<string, unknown>;
}

// A member of a series needs no design of its own: its file just renders the shared component with
// its props. Written by the runner, so every member is guaranteed to look the same.
export function memberSource(markerId: string, series: MarkerSeries): string {
  const props = JSON.stringify(series.props, null, 2);
  return `// Part of a series: renders the shared ${series.component} component (./shared/${series.component}.tsx)
// with this marker's content. The design lives in the shared component, so every marker of the
// series looks the same; to change this marker, change its props below.
import React from 'react';
import ${series.component} from './shared/${series.component}';

const props = ${props};

export default function Marker_${markerId}({ regionWidth = 1920, regionHeight = 1080 }: { regionWidth?: number; regionHeight?: number }) {
  return <${series.component} {...props} regionWidth={regionWidth} regionHeight={regionHeight} />;
}
`;
}

// Prompt text for the marker that builds the shared component (the series' lead). It sees every
// member's props, so the component fits the longest question or the largest number, not just its own.
export function leadInstructions(markerId: string, component: SeriesComponent, own: Record<string, unknown>, all: Record<string, unknown>[]): string {
  const file = sharedComponentPath(component.name);
  return [
    `This marker is the first of a series: several markers of this video repeat the same format and must look identical apart from their content. Build that format ONCE as a reusable component, then use it here.`,
    `1. Create ${file} with a default-exported React component named ${component.name}. It receives \`regionWidth\` and \`regionHeight\` plus the props below, lays everything out relative to regionWidth/regionHeight, and holds the whole design (layout, palette, fonts, sizes, motion). What it is:\n${component.spec}`,
    `2. Make 03_remotion_code/marker_${markerId}.tsx a thin wrapper: import ${component.name} from './shared/${component.name}' and render it with this marker's props and regionWidth/regionHeight. Keep the default export name.`,
    `This marker's props:\n${JSON.stringify(own, null, 2)}`,
    `Every marker of the series will render the component with one of these props objects, so it must look right with all of them (fit the longest text, the largest number, every case):\n${all.map((p) => JSON.stringify(p)).join('\n')}`,
    'Take the timing from the component itself (useCurrentFrame, useVideoConfig().fps and durationInFrames), since markers of the series can differ in length. When the props describe a progression that continues from one marker to the next (a line growing over time, a running total, a route), draw what earlier markers already revealed fully from the first frame and animate only this marker\'s new part, so the series plays as one continuous animation.',
    `Put the design spec comment at the top of ${file}. You may write exactly these two files.`,
  ].join('\n\n');
}

// Prompt text for a member Claude builds (the runner's wrapper did not work, or the creator gave
// feedback): it keeps rendering the shared component and changes only its own file.
export function memberInstructions(series: MarkerSeries, sharedCode: string): string {
  return [
    `This marker belongs to a series that shares one component, ${sharedComponentPath(series.component)}, so all of its markers look the same. Keep rendering it: import ${series.component} from './shared/${series.component}' and pass regionWidth/regionHeight and this marker's props, which the current code holds (as planned: ${JSON.stringify(series.props)}). Change the props (the content) as the intent or feedback asks; do not rebuild the design in this file and do not edit the shared component, which other markers use.`,
    `The shared component, for reference:\n\`\`\`tsx\n${sharedCode}\n\`\`\``,
  ].join('\n\n');
}

export function readSharedComponent(id: string, name: string): string | null {
  const file = sharedComponentFile(id, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
}
