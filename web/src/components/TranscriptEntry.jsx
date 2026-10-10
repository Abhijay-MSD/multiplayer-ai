import styles from "./Transcript.module.css";
import { formatClock } from "../lib/time";
import { Markdown } from "../lib/markdown";
import { CopyMessage } from "./CopyMessage";
import { ContinueButton } from "./ContinueButton";

function snippet(text, max = 70) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

// PRD 20.8: distinguished by author color and a small role tag, not
// boxes-in-boxes. How an agent reply, a controller message and a comment are
// drawn (panel, bubble, plain text) is the theme's call: the data-kind and
// data-part attributes are the hooks.
export function TranscriptEntry({ event, identityColor, role, replyTarget, onContinue = null }) {
  if (event.kind === "join" || event.kind === "takeover" || event.kind === "status") {
    return (
      <div className={`${styles.entry} ${styles.systemLine}`} data-part="entry" data-kind="system">
        {event.content}
        {onContinue && <ContinueButton onContinue={onContinue} />}
      </div>
    );
  }

  // Room chat: quiet, small, never something the agent acts on.
  if (event.kind === "comment") {
    return (
      <div className={`${styles.entry} ${styles.commentEntry}`} data-part="entry" data-kind="comment">
        <div className={styles.commentMeta} data-part="meta">
          <span className={styles.commentAuthor} style={{ color: identityColor }}>{event.author}</span>
          <span className={styles.commentTag}>comment</span>
          <span className={styles.time} data-part="time">{formatClock(event.created_at)}</span>
          <CopyMessage author={event.author} text={event.content} />
        </div>
        <div className={styles.commentBody} data-part="comment-body">{event.content}</div>
      </div>
    );
  }

  const isAgent = event.kind === "agent_message";
  const roleLabel = isAgent ? "agent" : role;

  return (
    <div
      className={`${styles.entry} ${styles.messageEntry} ${isAgent ? "" : styles.directiveEntry}`}
      data-part="entry"
      data-kind={isAgent ? "agent" : "directive"}
    >
      <div className={styles.meta} data-part="meta">
        <span className={styles.author} style={{ color: isAgent ? "var(--text)" : identityColor }}>
          {event.author}
        </span>
        {roleLabel && <span className={styles.role}>{roleLabel}</span>}
        <span className={styles.time} data-part="time">{formatClock(event.created_at)}</span>
        <CopyMessage author={event.author} text={event.content} />
      </div>
      {isAgent && replyTarget && (
        <div className={styles.replyTo} data-part="reply-to">
          Replying to {replyTarget.author}: &ldquo;{snippet(replyTarget.content)}&rdquo;
        </div>
      )}
      {isAgent ? (
        <div className={styles.agentBody} data-part="agent-body">
          <Markdown text={event.content} eventId={event.id} />
        </div>
      ) : (
        <div className={styles.directiveBody} data-part="directive-body">{event.content}</div>
      )}
    </div>
  );
}
