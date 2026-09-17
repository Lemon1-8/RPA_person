import type { StepDefinition, WorkflowDefinition } from "../../../../packages/contracts/src/index.js";

export interface VariableOption {
  name: string;
  reference: string;
  source: string;
  conditional: boolean;
  depth: number;
}

interface ValueShape {
  properties: Map<string, ValueShape>;
  optional?: boolean;
  item?: ValueShape;
}

interface Binding {
  source: string;
  conditional: boolean;
  shape: ValueShape;
}

type Environment = Map<string, Binding>;
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const unknownShape = (): ValueShape => ({ properties: new Map() });
const usableName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.trim() === name && !/[{}]/.test(name) && !reserved.has(name);
const usableProperty = (name: string) => usableName(name) && !name.includes(".");

function mergeShapes(shapes: ValueShape[]): ValueShape {
  const keys = new Set(shapes.flatMap(shape => [...shape.properties.keys()]));
  const properties = new Map<string, ValueShape>();
  for (const key of keys) {
    const matches = shapes.flatMap(shape => shape.properties.has(key) ? [shape.properties.get(key)!] : []);
    properties.set(key, { ...mergeShapes(matches), optional: matches.length < shapes.length || matches.some(shape => shape.optional) });
  }
  const items = shapes.flatMap(shape => shape.item ? [shape.item] : []);
  return { properties, ...(items.length ? { item: mergeShapes(items) } : {}) };
}

function lookupShape(environment: Environment, name: string): ValueShape {
  const direct = environment.get(name);
  if (direct) return direct.shape;
  const [root, ...parts] = name.split(".");
  let shape = environment.get(root)?.shape;
  for (const part of parts) shape = shape?.properties.get(part);
  return shape ?? unknownShape();
}

function shapeOf(value: unknown, environment: Environment, resolveReferences: boolean, depth = 0): ValueShape {
  if (depth >= 5) return unknownShape();
  if (resolveReferences && typeof value === "string") {
    const reference = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (reference) return lookupShape(environment, reference[1].trim());
  }
  if (Array.isArray(value)) {
    const samples = value.slice(0, 50).map(item => shapeOf(item, environment, resolveReferences, depth + 1));
    // Large lists still expose a useful sample, but never promise a property exists on every item.
    if (value.length > samples.length) samples.push(unknownShape());
    return {
      properties: new Map(samples.slice(0, Math.min(value.length, 20)).map((shape, index) => [String(index), shape])),
      ...(samples.length ? { item: mergeShapes(samples) } : {}),
    };
  }
  if (value && typeof value === "object") {
    return { properties: new Map(Object.entries(value).filter(([key]) => usableProperty(key)).slice(0, 50)
      .map(([key, child]) => [key, shapeOf(child, environment, resolveReferences, depth + 1)])) };
  }
  return unknownShape();
}

function declareLocals(environment: Environment, step: StepDefinition): Environment {
  const scoped = new Map(environment);
  for (const [name, value] of Object.entries(step.variables ?? {})) {
    if (usableName(name)) scoped.set(name, { source: `「${step.name}」的局部变量`, conditional: false, shape: shapeOf(value, scoped, false) });
  }
  return scoped;
}

function restoreNames(environment: Environment, previous: Environment, names: string[]): Environment {
  const restored = new Map(environment);
  for (const name of names) {
    const binding = previous.get(name);
    if (binding) restored.set(name, binding);
    else restored.delete(name);
  }
  return restored;
}

function mergeEnvironments(first: Environment, second: Environment): Environment {
  const merged: Environment = new Map();
  for (const name of new Set([...first.keys(), ...second.keys()])) {
    const left = first.get(name);
    const right = second.get(name);
    if (!left || !right) {
      merged.set(name, { ...(left ?? right)!, conditional: true });
    } else {
      merged.set(name, {
        source: left.source === right.source ? left.source : `${left.source} / ${right.source}`,
        conditional: left.conditional || right.conditional,
        shape: mergeShapes([left.shape, right.shape]),
      });
    }
  }
  return merged;
}

function loopItem(environment: Environment, step: StepDefinition): Environment {
  const scoped = new Map(environment);
  const name = step.params.itemVariable;
  if (usableName(name)) scoped.set(name, {
    source: `「${step.name}」的当前项`, conditional: false,
    shape: shapeOf(step.params.items, environment, true).item ?? unknownShape(),
  });
  return scoped;
}

function completeSteps(environment: Environment, steps: StepDefinition[]): Environment {
  return steps.reduce((current, step) => completeStep(current, step), environment);
}

function completeStep(environment: Environment, step: StepDefinition): Environment {
  let scoped = declareLocals(environment, step);
  let outputShape = unknownShape();
  if (step.actionType === "variables.set") {
    outputShape = shapeOf(step.params.value, scoped, true);
    if (usableName(step.params.name)) scoped.set(step.params.name, {
      source: `「${step.name}」设置的变量`, conditional: false, shape: outputShape,
    });
  } else if (step.actionType === "control.if") {
    scoped = mergeEnvironments(completeSteps(scoped, step.children ?? []), completeSteps(scoped, step.elseSteps ?? []));
    outputShape = shapeOf({ matched: true }, scoped, false);
  } else if (step.actionType === "control.forEach") {
    const body = completeSteps(loopItem(scoped, step), step.children ?? []);
    const restored = restoreNames(body, scoped, usableName(step.params.itemVariable) ? [step.params.itemVariable] : []);
    // The list can be empty, so a body assignment may not have happened.
    scoped = mergeEnvironments(scoped, restored);
    outputShape = shapeOf({ count: 0 }, scoped, false);
  } else if (step.actionType === "core.assert") {
    outputShape = shapeOf({ ok: true }, scoped, false);
  } else if (step.actionType === "core.log") {
    outputShape = shapeOf(step.params.message, scoped, true);
  } else if (step.actionType === "browser.start") {
    outputShape = shapeOf({ pageId: "", browserChannel: "", debugPort: 0 }, scoped, false);
  } else if (step.actionType === "browser.open" || step.actionType === "browser.switchPage") {
    outputShape = shapeOf({ pageId: "", url: "" }, scoped, false);
  } else if (step.actionType === "browser.closePage") {
    outputShape = shapeOf({ ok: true, pageId: "" }, scoped, false);
  } else if (step.actionType === "browser.click") {
    outputShape = shapeOf({ ok: true }, scoped, false);
  }
  scoped = restoreNames(scoped, environment, Object.keys(step.variables ?? {}));
  // The engine publishes outputs after restoring the step's local variables.
  if (usableName(step.output)) scoped.set(step.output, {
    source: `「${step.name}」的输出`, conditional: false, shape: outputShape,
  });
  return scoped;
}

function findPath(steps: StepDefinition[], stepId: string): StepDefinition[] | undefined {
  for (const step of steps) {
    if (step.stepId === stepId) return [step];
    const nested = findPath(step.children ?? [], stepId) ?? findPath(step.elseSteps ?? [], stepId);
    if (nested) return [step, ...nested];
  }
}

/** Variables visible immediately before the selected step resolves its parameters. */
export function getVariableOptions(workflow: WorkflowDefinition, stepId: string): VariableOption[] {
  const path = findPath(workflow.steps, stepId);
  if (!path) return [];
  let environment: Environment = new Map();
  for (const [name, value] of Object.entries(workflow.variables)) {
    if (usableName(name)) environment.set(name, { source: "流程变量", conditional: false, shape: shapeOf(value, environment, false) });
  }
  let siblings = workflow.steps;
  for (const [index, step] of path.entries()) {
    environment = completeSteps(environment, siblings.slice(0, siblings.indexOf(step)));
    environment = declareLocals(environment, step);
    if (index < path.length - 1) {
      if (step.actionType === "control.forEach") environment = loopItem(environment, step);
      siblings = step.children?.includes(path[index + 1]) ? step.children : step.elseSteps ?? [];
    }
  }
  const options = new Map<string, VariableOption>();
  const add = (name: string, binding: Binding, shape: ValueShape, depth: number, conditional: boolean) => {
    options.set(name, { name, reference: `{{${name}}}`, source: binding.source, conditional, depth });
    if (depth >= 4 || options.size >= 500) return;
    for (const [key, child] of shape.properties) {
      const childName = `${name}.${key}`;
      // Exact names take priority over dotted property lookup in the engine.
      if (!environment.has(childName)) add(childName, binding, child, depth + 1, conditional || Boolean(child.optional));
    }
  };
  for (const [name, binding] of environment) {
    // A root containing a dot is readable only by its exact name.
    add(name, binding, name.includes(".") ? unknownShape() : binding.shape, 0, binding.conditional);
  }
  return [...options.values()];
}
