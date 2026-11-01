// Tools that an LLM agent may call. Each tool:
//  - declares a JSON-schema for its parameters (sent to the model),
//  - validates every parameter itself (the model is not trusted),
//  - builds yt-dlp / ffmpeg argument ARRAYS from validated values (never a shell string),
//  - delegates the real work to the Electron-free functions in ../core/tools.js.
//
// The download folder, cookie browser and proxy come from the user's settings (the `ctx` object),
// never from the model, so the model cannot write outside the folder the user chose.
//
// The tools themselves are defined by group in ./tools/. This module only assembles and looks them up.
import { infoTools } from './tools/info.js';
import { downloadTools } from './tools/download.js';
import { mediaTools } from './tools/media.js';
import { fileTools } from './tools/files.js';
import { controlTools } from './tools/control.js';

export { TOOL_NAMES } from './tools/names.js';

/** @typedef {import('./tools/common.js').ToolContext} ToolContext */

export const TOOLS = [...infoTools, ...downloadTools, ...mediaTools, ...fileTools, ...controlTools];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name) {
    return TOOL_BY_NAME.get(name);
}

/** Resolve a tool's risk level for the given arguments ('low' | 'high'). */
export function getRisk(tool, args) {
    return typeof tool.risk === 'function' ? tool.risk(args || {}) : tool.risk;
}

/** Tool declarations in the neutral shape that providers translate to their own API format. */
export function getToolDeclarations() {
    return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
