// The limits on room files and on the agent's tool loop, read from the environment at the moment they are used.
// A blank, zero, negative or fractional value means the default (validateEnv refuses a bad value at startup, so
// this fallback is for tests and for callers that skipped it). Defaults live in config.js.
import { intSetting } from "../config.js";

/** Every setting this feature adds, for the docs and the tests. */
export const FILE_SETTINGS = [
  "MAX_FILE_KB", "MAX_FILES_PER_ROOM", "MAX_ROOM_FILES_KB",
  "TOOL_CALLS_PER_DIRECTIVE", "MODEL_CALLS_PER_DIRECTIVE", "TOOL_RESULT_KB", "DIRECTIVE_SECONDS", "MODEL_CALLS_PER_ROOM"
];

/** Absurd values are refused at startup: they would let one room use a lot of memory or time. */
export const FILE_CEILINGS = {
  MAX_FILE_KB: 10240,
  MAX_FILES_PER_ROOM: 1000,
  MAX_ROOM_FILES_KB: 102400,
  TOOL_CALLS_PER_DIRECTIVE: 100,
  MODEL_CALLS_PER_DIRECTIVE: 50,
  TOOL_RESULT_KB: 1024,
  DIRECTIVE_SECONDS: 3600,
  MODEL_CALLS_PER_ROOM: 100000
};

/** Newest versions kept of each file. A fixed rule, not a setting. */
export const VERSIONS_KEPT = 10;

const KB = 1024;

export function fileLimits(env = process.env) {
  return {
    maxFileBytes: intSetting("MAX_FILE_KB", env) * KB,
    maxFiles: intSetting("MAX_FILES_PER_ROOM", env),
    maxTotalBytes: intSetting("MAX_ROOM_FILES_KB", env) * KB,
    versionsKept: VERSIONS_KEPT
  };
}

export function loopLimits(env = process.env) {
  return {
    toolCalls: intSetting("TOOL_CALLS_PER_DIRECTIVE", env),
    modelCalls: intSetting("MODEL_CALLS_PER_DIRECTIVE", env),
    resultBytes: intSetting("TOOL_RESULT_KB", env) * KB,
    wallMs: intSetting("DIRECTIVE_SECONDS", env) * 1000,
    roomModelCalls: intSetting("MODEL_CALLS_PER_ROOM", env)
  };
}
