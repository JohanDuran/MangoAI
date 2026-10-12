import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';
import { isValidRegion, type MarkerRegion } from './markers.js';
import type { PlanMarkersResult } from './planner.js';
import { isConsistency, isComponentName, MAX_PROPS_CHARS, MAX_SPEC_CHARS, type Consistency, type SeriesComponent } from './series.js';

// The marker plan being worked on, kept on disk from the moment planning starts so a crash or
// reload never loses what was asked for, the reviewed edits, or how far applying it got.
//   planning  Claude is (or was, if nothing is running any more) writing the plan.
//   review    The plan is waiting for the user to edit and apply it.
//   applying  Markers are (or were, if nothing is running any more) being generated from it.
// The file is removed once every item has become a marker, or when the user discards the plan.
// An idea plan may carry the area every proposed marker is confined to (absent means Claude decides),
// whether Claude was asked for voiceover lines, and whether it could plan AI-generated images.
export type PlanSource =
  | { kind: 'transcript'; context?: string }
  | { kind: 'idea'; idea: string; region?: MarkerRegion; narration?: boolean; voice?: string; images?: boolean };

export interface PlanItem {
  key: string;
  included: boolean;
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  allowImage: boolean;
  assets: string[];
  // Voiceover line spoken from the marker's start; absent or empty for none.
  narration?: string;
  // In a series plan, this marker's props for the shared component as JSON text; absent or empty
  // when it is not one of the repeated markers.
  props?: string;
  // Set once applying created a marker for this item.
  markerId?: string;
  // Why applying skipped this item, if it did.
  error?: string;
}

export interface StoredPlan {
  state: 'planning' | 'review' | 'applying';
  source: PlanSource;
  createdAt: string;
  updatedAt: string;
  droppedCount: number;
  // How many markers were moved later to play one after another instead of overlapping.
  movedCount?: number;
  // The look every marker of the plan shares (see planner.ts); the user can edit it while reviewing.
  look?: string;
  // How alike the markers are built (see series.ts); absent on plans saved before this existed,
  // which are generated as varied, as they were planned.
  consistency?: Consistency;
  // The component a series plan's markers share.
  component?: SeriesComponent;
  items: PlanItem[];
}

// The plan-wide design choices the user can edit while reviewing.
export interface PlanDesign {
  look?: string;
  consistency?: Consistency;
  component?: SeriesComponent;
}

const planFile = (id: string) => path.join(projectDir(id), '00_input', 'plan.json');

export function readPlan(id: string): StoredPlan | null {
  const file = planFile(id);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson<StoredPlan>(file);
  } catch {
    return null;
  }
}

function writePlan(id: string, plan: Omit<StoredPlan, 'updatedAt'>): StoredPlan {
  const stored = { ...plan, updatedAt: new Date().toISOString() };
  writeJsonAtomic(planFile(id), stored);
  return stored;
}

export function clearPlan(id: string): void {
  for (const file of [planFile(id), `${planFile(id)}.bak`]) fs.rmSync(file, { force: true });
}

export function startPlanning(id: string, source: PlanSource): StoredPlan {
  const now = new Date().toISOString();
  return writePlan(id, { state: 'planning', source, createdAt: now, droppedCount: 0, items: [] });
}

export function savePlanProposals(
  id: string,
  source: PlanSource,
  result: Pick<PlanMarkersResult, 'proposals' | 'droppedCount' | 'movedCount' | 'look' | 'consistency' | 'component'>
): StoredPlan {
  const createdAt = readPlan(id)?.createdAt ?? new Date().toISOString();
  return writePlan(id, {
    state: 'review',
    source,
    createdAt,
    droppedCount: result.droppedCount,
    ...(result.movedCount > 0 && { movedCount: result.movedCount }),
    ...(result.look && { look: result.look }),
    consistency: result.consistency,
    ...(result.component && { component: result.component }),
    items: result.proposals.map((p) => ({
      key: crypto.randomUUID(),
      included: true,
      start: p.start,
      end: p.end,
      prompt: p.prompt,
      region: p.region,
      allowImage: p.generateImage === true,
      assets: p.assets,
      ...(p.narration ? { narration: p.narration } : {}),
      ...(p.props ? { props: p.props } : {}),
    })),
  });
}

const isPlanItem = (v: unknown): v is PlanItem => {
  if (!v || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  return (
    typeof i.key === 'string' &&
    typeof i.included === 'boolean' &&
    typeof i.start === 'number' &&
    typeof i.end === 'number' &&
    typeof i.prompt === 'string' &&
    (i.region === null || isValidRegion(i.region)) &&
    typeof i.allowImage === 'boolean' &&
    Array.isArray(i.assets) &&
    i.assets.every((a) => typeof a === 'string') &&
    (i.narration === undefined || typeof i.narration === 'string') &&
    (i.props === undefined || (typeof i.props === 'string' && i.props.length <= MAX_PROPS_CHARS)) &&
    (i.markerId === undefined || typeof i.markerId === 'string') &&
    (i.error === undefined || typeof i.error === 'string')
  );
};

export const MAX_LOOK_CHARS = 4000;

// The design fields of a request body, checked; a field left out is not changed.
export function parsePlanDesign(body: { look?: unknown; consistency?: unknown; component?: unknown }): PlanDesign {
  const { look, consistency, component } = body;
  if (look !== undefined && typeof look !== 'string') throw new Error('look must be a string');
  if (consistency !== undefined && !isConsistency(consistency)) throw new Error('consistency must be series, themed or varied');
  const c = component as { name?: unknown; spec?: unknown } | undefined;
  if (c !== undefined && (!c || !isComponentName(c.name) || typeof c.spec !== 'string')) throw new Error('component must have a name and a spec');
  return {
    ...(look !== undefined && { look: look.slice(0, MAX_LOOK_CHARS) }),
    ...(consistency !== undefined && { consistency }),
    ...(c && { component: { name: c.name as string, spec: (c.spec as string).slice(0, MAX_SPEC_CHARS) } }),
  };
}

// Saves the user's edits made while reviewing: the items, and the plan-wide design fields given.
// Returns null when there is no plan to save into.
export function savePlanItems(id: string, items: unknown, design: PlanDesign = {}): StoredPlan | null {
  const plan = readPlan(id);
  if (!plan) return null;
  if (!Array.isArray(items) || !items.every(isPlanItem)) throw new Error('items must be a list of plan items');
  // The component's name is its file name, chosen when the plan was made; only its spec is edited.
  const component = design.component && plan.component ? { name: plan.component.name, spec: design.component.spec } : plan.component;
  return writePlan(id, { ...plan, ...design, ...(component && { component }), items });
}

export function setPlanState(id: string, state: StoredPlan['state']): void {
  const plan = readPlan(id);
  if (plan) writePlan(id, { ...plan, state });
}

export function updatePlanItem(id: string, key: string | undefined, patch: Partial<Pick<PlanItem, 'markerId' | 'error'>>): void {
  if (!key) return;
  const plan = readPlan(id);
  const item = plan?.items.find((i) => i.key === key);
  if (!plan || !item) return;
  if ('markerId' in patch) {
    if (patch.markerId) item.markerId = patch.markerId;
    else delete item.markerId;
  }
  if ('error' in patch) {
    if (patch.error) item.error = patch.error;
    else delete item.error;
  }
  writePlan(id, plan);
}
