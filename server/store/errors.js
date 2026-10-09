// What a store throws when a rule is broken. Anything else it throws is an
// ordinary Error (the database could not be reached, and so on).
//
//   CONFLICT    a uniqueness rule: the same name twice in a room, the same token hash twice.
//   CONSTRAINT  any other rule: a value not allowed, a row that points at nothing, text too long.
//   NOT_FOUND   the row an operation was meant to change is not there.
//   BUSY        the data file stayed locked by another connection past the busy timeout.
//   FILE_TOO_LARGE, TOO_MANY_FILES, ROOM_FULL
//               a room file broke a size rule: one file's bytes, the number of files, the room's total bytes.
//   UNSUPPORTED the store can't do this at all (room files with Supabase storage).
export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}
