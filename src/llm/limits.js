// Every tunable limit of the AI mode in one place.

// Conversation
export const MAX_AGENT_STEPS = 8;            // model calls per user message
export const MAX_TOOL_RESULT_CHARS = 6000;   // tool output kept in the model's context
export const MAX_HISTORY_MESSAGES = 40;
export const MAX_USER_MESSAGE_CHARS = 4000;

// Settings
export const MAX_API_KEY_CHARS = 500;

// Tools
export const MAX_DELETE_FILES = 20;
export const MAX_LISTED_FILES = 50;

// Waiting for the user
export const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

// Network (milliseconds)
export const MODEL_REQUEST_TIMEOUT_MS = 240000;
export const LOCAL_MODEL_REQUEST_TIMEOUT_MS = 300000; // local models can be slow to load
export const CONNECTION_TEST_TIMEOUT_MS = 15000;
