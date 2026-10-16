import { z } from 'zod';
import { runCode, sandboxesAvailable } from '../../models/sandbox.js';
import { defineTool, type ToolSpec } from './spec.js';

export const codeTools: ToolSpec[] = [
  defineTool({
    name: 'run_python',
    label: 'Running a calculation',
    description:
      'Run Python 3 code in an isolated Tarka sandbox and get stdout/stderr. Use for exact arithmetic, date maths, unit conversions, splitting bills, loan or budget calculations and small data tasks. Print the result. No network access is guaranteed.',
    input: z.object({ code: z.string().min(1).max(20_000) }),
    available: () => sandboxesAvailable(),
    run: async ({ code }, ctx) => {
      const result = await runCode(ctx.user.id, code, 60);
      return result;
    },
  }),
];
