import { cancelCurrentTask } from '../../core/tools.js';
import { TOOL_NAMES } from './names.js';
import { defineTool } from './common.js';

export const controlTools = [
    defineTool({
        name: TOOL_NAMES.cancelTask,
        description: 'Cancel the download or encoding that is currently running.',
        describe: () => 'Cancel the running task',
        async run() {
            return { ok: true, cancelled: cancelCurrentTask() };
        }
    })
];
