import { z } from 'zod';

export const desktopMatchSchema = z.object({ value: z.string().min(1), match: z.enum(['exact', 'wildcard']).default('exact') });
export type DesktopMatch = z.infer<typeof desktopMatchSchema>;
export const desktopWindowSchema = z.object({
  processName: desktopMatchSchema.optional(), title: desktopMatchSchema.optional(), className: desktopMatchSchema.optional(),
}).refine(value => Object.values(value).some(rule => rule !== undefined), '请设置至少一个窗口条件');
export type DesktopWindowLocator = z.infer<typeof desktopWindowSchema>;
export const desktopNodeSchema = z.object({
  axis: z.enum(['child', 'descendant']).default('descendant'),
  properties: z.object({ AutomationId: desktopMatchSchema.optional(), Name: desktopMatchSchema.optional(), ControlType: desktopMatchSchema.optional(), ClassName: desktopMatchSchema.optional() }),
  index: z.number().int().nonnegative().optional(),
}).refine(value => Object.values(value.properties).some(rule => rule !== undefined) || value.index !== undefined, '节点需要属性或明确的序号');
export type DesktopSelectorNode = z.infer<typeof desktopNodeSchema>;
export const desktopElementSchema = z.object({ backend: z.literal('uia'), window: desktopWindowSchema, path: z.array(desktopNodeSchema).max(40) });
export type DesktopElementRef = z.infer<typeof desktopElementSchema>;
export interface DesktopElementSnapshot {
  element: DesktopElementRef;
  attributes: Record<string, string | number | boolean>;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface DesktopElementValidation { count: number; matches: DesktopElementSnapshot[] }
export const desktopAttributeNames = ['AutomationId', 'Name', 'ControlType', 'ClassName', 'FrameworkId', 'ProcessId', 'IsEnabled', 'IsOffscreen', 'IsKeyboardFocusable', 'HasKeyboardFocus'] as const;
