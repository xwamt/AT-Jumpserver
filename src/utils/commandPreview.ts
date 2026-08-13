export const COMMAND_PREVIEW_MAX_LINES = 20;
export const COMMAND_PREVIEW_MAX_CHARS = 800;

export function truncateCommandPreview(
  command: string,
  maxLines = COMMAND_PREVIEW_MAX_LINES,
  maxChars = COMMAND_PREVIEW_MAX_CHARS
): string {
  const totalChars = command.length;
  const totalLines = command.length === 0 ? 0 : command.split('\n').length;
  let preview = command;
  const lines = command.split('\n');
  if (lines.length > maxLines) {
    preview = lines.slice(0, maxLines).join('\n');
  }
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
  }
  if (preview !== command) {
    return `${preview}\n… (truncated, ${totalChars} chars, ${totalLines} lines)`;
  }
  return command;
}

export function isObviouslyDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
}

export function formatCommandConfirmMessage(options: {
  action: string;
  target: string;
  command: string;
}): string {
  const preview = truncateCommandPreview(options.command);
  // Scans the whole command, not the preview: the point of the warning is the
  // part the dialog had to cut away.
  const warning = isObviouslyDestructive(options.command)
    ? '\n\nWarning: this command appears destructive.'
    : '';
  return `${options.action} on ${options.target}?\n\n${preview}${warning}`;
}
