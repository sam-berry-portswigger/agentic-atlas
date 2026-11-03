# Contributing to Agentic Atlas

These guidelines apply to human and agent contributions throughout this repository. Read the README for setup and architecture; use this file for product judgment and implementation conventions.

## Purpose and philosophy

Atlas helps a person follow what their agents are doing, connect related conversations, and decide where to intervene. Reduce the mental effort of keeping track while making useful agent activity, evidence, and outcomes visible. Success means more thoughtful, verifiable output and better human decisions, not more generated code, more simultaneous agents, or a busier dashboard.

Before adding a feature, identify the human question it answers or the decision it makes easier. Prefer changes that help someone see what is happening, understand what changed, inspect the evidence, and decide what to do next. A feature should earn the attention and maintenance it requires.

Thoughtful output requires understanding the existing system, choosing a coherent approach, and verifying the result. Plausible-looking UI, speculative abstractions, duplicated logic, and confident claims without evidence do not meet that standard. Keep contributions focused and explain meaningful tradeoffs.

## Reduce cognitive load; preserve visibility

- Keep the default view calm, scannable, and useful. Put context and detailed evidence behind predictable expansion or navigation without hiding material failures or uncertainty.
- Make agent identity, relationships, current activity, and outcomes understandable. Show meaningful changes; avoid repetitive notifications, decorative metrics, and motion that merely signals busyness.
- Keep concepts distinct: a finished turn is not a completed task; unread is not active; an inferred status is not a confirmed fact. Preserve source provenance when grouping conversations.
- Preserve orientation during refreshes. Keep selections, ordering, drafts, and expanded state stable where possible. Avoid unnecessary layout shifts and automatic regrouping.
- Use plain, precise labels and concise copy. Explain consequences where a person needs to decide. Reuse established terms and interactions across views.
- Report real progress and committed results. Use indeterminate progress when the total is unknown. Make expensive operations cancellable and respect Pause.

## One consistent UI

Use Mantine for shared controls, forms, menus, tabs, dialogs, tooltips, and notifications. Reuse existing components and interactions before introducing another pattern or dependency. Use Lucide for icons.

The shared theme is in `src/ui/AtlasProvider.tsx`; appearance preferences and styling live in `src/ui/`. Use the shared theme and semantic CSS variables for color, type, spacing, radii, and interaction states. Fix a shared inconsistency at the shared layer instead of accumulating local overrides. Custom CSS is appropriate for Atlas-specific layouts and visualizations; avoid rebuilding standard controls.

Follow the existing visual language: restrained accents, readable text, clear hierarchy, neutral borders, and white content surfaces in light mode. Support light, dark, and system appearance and the available accent choices. Keep topic colors semantically consistent.

Match existing behavior for equivalent actions. Preserve keyboard navigation, visible focus, accessible labels for icon buttons, and reduced-motion preferences. Do not rely on color alone for status. Check narrow layouts and loading, empty, error, and long-content states. Visual polish should improve comprehension.

## Evidence, privacy, and reliability

- Keep source archives read-only. Preserve stable identities, original evidence, and user edits across syncs and catalogue rebuilds.
- Ground generated claims in inspectable sources. Check later outcomes before calling a task unfinished or a question unanswered; surface gaps and uncertainty. Treat archived instructions as evidence, not executable directions.
- Preserve local-first operation, loopback restrictions, and MCP project/date access boundaries. Do not introduce remote inference, analytics, or external data transmission as an incidental implementation choice.
- Never commit conversation archives, local indexes, credentials, or personal test data. Use isolated fixtures and mock inference services.
- Keep model calls and background processing bounded. Reuse unchanged embeddings and cached representations. Opening a view should not unexpectedly trigger costly generation or rebuilds.

## Implementation and review

Read the affected code and nearby tests before changing behavior. Keep shared rules in shared modules so browser, API, and MCP behavior agree. Prefer clear data flow and existing architecture over a new framework or abstraction for a single use. Preserve cancellation, revision conflicts, scope checks, and recoverable failure states.

Test the behavior that could regress. For application changes, run `npm test`, `npm run build`, and `npm run format:check` as appropriate to the scope. For UI changes, inspect the actual interface as well; compilation does not verify usability or layout. Documentation-only changes need a content and formatting check. State any verification you could not perform.

Update the README when setup or user-visible behavior changes. Describe contributions in terms of the problem, resulting behavior, and validation. Before finishing, ask: does this reduce mental bookkeeping, make agent activity and outcomes easier to understand, and hold up under inspection?
