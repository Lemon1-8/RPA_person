import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowDefinition } from '../../../packages/contracts/src/index.js';
import { writeJsonAtomic } from '../../../packages/persistence/src/index.js';
import type { RunManager } from '../../runner/src/manager.js';

/** Keep an intentionally empty workspace empty after the first desktop launch. */
export async function seedDesktopWorkspace(manager: RunManager, demo: WorkflowDefinition) {
  const marker = join(manager.store.directory, 'desktop-initialized.json');
  try { await access(marker); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!(await manager.listWorkflows()).length) await manager.saveWorkflow(demo);
  await writeJsonAtomic(marker, { initializedAt: new Date().toISOString() });
}

/** The built-in fixture gets a new local port whenever the desktop restarts. */
export async function refreshDemoUrls(manager: RunManager, demoUrl: string) {
  for (const workflow of await manager.listWorkflows()) {
    if (typeof workflow.variables.demoUrl === 'string' && workflow.variables.demoUrl !== demoUrl) {
      workflow.variables.demoUrl = demoUrl;
      await manager.saveWorkflow(workflow);
    }
  }
}
