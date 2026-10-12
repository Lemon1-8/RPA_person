import { memo,useState } from 'react';
import type { RunAttempt } from '../../../../packages/contracts/src/index.js';
export const AttemptRecords=memo(function AttemptRecords({attempts}:{attempts:RunAttempt[]}) {
  const [expanded,setExpanded]=useState<string[]>([]);
  return <>{attempts.map(attempt=><details key={attempt.attemptId} onToggle={event=>{const open=event.currentTarget.open;setExpanded(previous=>open?[...new Set([...previous,attempt.attemptId])]:previous.filter(id=>id!==attempt.attemptId));}}><summary>{new Date(attempt.run.startedAt).toLocaleString('zh-CN')} · v{attempt.run.revision} · {attempt.run.status} · {attempt.attemptId.slice(0,8)}</summary>{expanded.includes(attempt.attemptId) && <pre>{JSON.stringify({steps:attempt.workflow.steps,warnings:attempt.run.warnings,variables:attempt.run.variables},null,2)}</pre>}</details>)}</>;
});
