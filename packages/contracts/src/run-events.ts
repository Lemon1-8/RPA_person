import type { RunEvent, RunSnapshot } from './index.js';
/** Missing variablesComplete denotes a legacy complete snapshot. */
export function mergeRunEvent(previous: RunSnapshot | undefined, event: RunEvent): RunSnapshot | undefined {
  if (!event.run) return previous;
  if (event.variablesComplete !== false) return event.run;
  const variables = { ...previous?.variables, ...event.variableChanges };
  for (const key of event.deletedVariables ?? []) delete variables[key];
  const warnings=event.warningChanges ? [...previous?.warnings ?? [],...event.warningChanges] : event.run.warnings?.length ? event.run.warnings : previous?.warnings ?? [];
  return { ...event.run, variables,warnings };
}
