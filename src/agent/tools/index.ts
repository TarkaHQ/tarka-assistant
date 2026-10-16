import type { ToolSpec } from './spec.js';
import { memoryTools } from './memory.js';
import { scheduleTools } from './schedule.js';
import { listTools } from './lists.js';
import { webTools } from './web.js';
import { weatherTools } from './weather.js';
import { settingsTools } from './settings.js';
import { googleTools } from './google.js';
import { codeTools } from './code.js';
import { phoneTools } from './phone.js';

export const allTools: ToolSpec[] = [
  ...memoryTools,
  ...scheduleTools,
  ...listTools,
  ...settingsTools,
  ...webTools,
  ...weatherTools,
  ...googleTools,
  ...phoneTools,
  ...codeTools,
];

const byName = new Map(allTools.map((t) => [t.name, t]));

export function findTool(name: string): ToolSpec | undefined {
  return byName.get(name);
}

export function toolLabel(name: string): string {
  return byName.get(name)?.label ?? name.replace(/_/g, ' ');
}
