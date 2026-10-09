# Remotion license: notes for the v1 release decision

Read on 2026-10-09 from the Remotion license (github.com/remotion-dev/remotion/blob/main/LICENSE.md) and the
license FAQ (remotion.dev/docs/license/faq). This is a summary to help decide, not legal advice.

## What is clear

- **Free license:** individuals, for-profit organizations with up to 3 employees, non-profits, and anyone evaluating
  it. Contractors and agencies you work with count toward the headcount.
- **Commercial use is allowed** with the free license, as long as Remotion itself is not what is being sold.
- **Automations:** owning code that calls `renderMedia()`, `renderStill()` and similar counts as an "automation".
  MangoAI's runner does this for every export and render check. The FAQ says someone eligible for the free license
  can also run an automation.
- **End users of an AI service:** the FAQ says customers of a service that generates Remotion code with AI do not need
  their own company license, as long as they cannot upload their own Remotion code.
- **Paid tiers, if ever needed:** "Remotion for Creators" at $25/month per person writing Remotion code (including with
  agentic tools), "Remotion for Automators" at $0.01 per render with a $100/month minimum.

## What is not addressed

- A **free desktop app** where each end user renders on their own computer. The FAQ's customer rule is written for a
  hosted service; whether a company with 4+ people that installs MangoAI needs its own license is not stated.
- MangoAI projects contain the generated Remotion code, and a user could edit it by hand. That may count as "their own
  Remotion code".

## Suggested next step

Ask Remotion before sharing beyond a few individual testers. A draft message (to hi@remotion.dev):

> Hi! I'm building MangoAI, a free (no charge) Windows desktop app. Users place markers on a video timeline, Claude
> writes Remotion code for each one, and the app previews it with @remotion/player and renders it locally with
> @remotion/renderer on the user's own machine. I'm an individual developer. Is that covered by the free license, and
> do users at companies with 4+ people need their own Remotion license to use it? Thanks!

Until then, the current wording in `apps/desktop/build/license.txt` and the releases README (free for individuals
and companies of up to three people; larger companies need a Remotion license) is the cautious reading.
