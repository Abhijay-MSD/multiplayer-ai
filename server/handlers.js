// What the browser may call (stop_agent ends a running step; it needs the controller's or the host's token). step_agent and set_status are not on this list:
// they spend budget or change a room's state, so they are MCP-only (and
// controller-only). Every tool below authenticates by token on its own.
import { createSession } from "./tools/create_session.js";
import { joinSession } from "./tools/join_session.js";
import { getSession } from "./tools/get_session.js";
import { sendDirective } from "./tools/send_directive.js";
import { sendComment } from "./tools/send_comment.js";
import { takeControl } from "./tools/take_control.js";
import { heartbeat } from "./tools/heartbeat.js";
import { leaveSession } from "./tools/leave_session.js";
import { stopAgent } from "./tools/stop_agent.js";
import { retryLast } from "./tools/retry_last.js";
import { listRoomFiles, getRoomFile, fileVersions, attachFile } from "./tools/files.js";

export const webHandlers = {
  create_session: createSession,
  join_session: joinSession,
  get_session: getSession,
  send_directive: sendDirective,
  send_comment: sendComment,
  take_control: takeControl,
  heartbeat,
  leave_session: leaveSession,
  stop_agent: stopAgent,
  retry_last: retryLast,
  list_room_files: listRoomFiles,
  get_room_file: getRoomFile,
  file_versions: fileVersions,
  attach_file: attachFile
};
