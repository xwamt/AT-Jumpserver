import { describe, expect, it } from 'vitest';
import {
  formatCommandConfirmMessage,
  isObviouslyDestructive,
  truncateCommandPreview
} from '../../src/utils/commandPreview';

describe('truncateCommandPreview', () => {
  it('returns short commands unchanged', () => {
    expect(truncateCommandPreview('echo hi')).toBe('echo hi');
  });

  it('truncates by line count first', () => {
    const command = Array.from({ length: 25 }, (_, index) => `line-${index}`).join('\n');
    const result = truncateCommandPreview(command);

    expect(result.startsWith('line-0\n')).toBe(true);
    expect(result).toContain('line-19');
    expect(result).not.toContain('line-20');
    expect(result).toContain(`… (truncated, ${command.length} chars, 25 lines)`);
  });

  it('truncates by character count when under the line limit', () => {
    const command = 'a'.repeat(900);
    const result = truncateCommandPreview(command);

    expect(result.startsWith('a'.repeat(800))).toBe(true);
    expect(result).toContain('… (truncated, 900 chars, 1 lines)');
  });
});

describe('isObviouslyDestructive', () => {
  it('flags a recursive remove', () => {
    expect(isObviouslyDestructive('rm -rf /data')).toBe(true);
  });

  it('flags a destructive tail buried past the preview limit', () => {
    expect(isObviouslyDestructive(`${'echo padding; '.repeat(100)}rm -rf /data`)).toBe(true);
  });

  it('leaves ordinary commands alone', () => {
    expect(isObviouslyDestructive('ls -la /var/log')).toBe(false);
  });
});

describe('formatCommandConfirmMessage', () => {
  it('names the asset and address ahead of the command', () => {
    const message = formatCommandConfirmMessage({
      action: 'Run JumpServer SSH command',
      target: 'prod-db (10.0.0.9)',
      command: 'uptime'
    });

    expect(message).toBe('Run JumpServer SSH command on prod-db (10.0.0.9)?\n\nuptime');
  });

  it('warns about a destructive tail the preview cannot show', () => {
    const command = `${'echo padding; '.repeat(100)}rm -rf /data`;
    const message = formatCommandConfirmMessage({
      action: 'Run JumpServer SSH command',
      target: 'prod-db (10.0.0.9)',
      command
    });

    expect(message).not.toContain('rm -rf /data');
    expect(message).toContain(`… (truncated, ${command.length} chars, 1 lines)`);
    expect(message.endsWith('Warning: this command appears destructive.')).toBe(true);
  });

  it('appends the policy note and dashed risk summaries after the preview', () => {
    const message = formatCommandConfirmMessage({
      action: 'Run JumpServer SSH command',
      target: 'web-1 (10.0.0.5)',
      command: 'tee /etc/x',
      policyNote: 'Policy: review (policy.unknown_semantics)',
      riskSummaries: ['Writes to a file path', 'Touches system configuration']
    });

    expect(message).toBe(
      'Run JumpServer SSH command on web-1 (10.0.0.5)?\n\n' +
      'tee /etc/x\n\n' +
      'Policy: review (policy.unknown_semantics)\n' +
      '- Writes to a file path\n' +
      '- Touches system configuration'
    );
  });

  it('renders risk summaries even without a policy note, and vice versa', () => {
    expect(formatCommandConfirmMessage({
      action: 'Run JumpServer Redis command',
      target: 'cache-1',
      command: 'GET k',
      riskSummaries: ['Reads a key']
    })).toBe('Run JumpServer Redis command on cache-1?\n\nGET k\n\n- Reads a key');

    expect(formatCommandConfirmMessage({
      action: 'Run JumpServer Redis command',
      target: 'cache-1',
      command: 'GET k',
      policyNote: 'Policy: DENY (policy.blocked) — approve only if you are certain.'
    })).toBe(
      'Run JumpServer Redis command on cache-1?\n\nGET k\n\n' +
      'Policy: DENY (policy.blocked) — approve only if you are certain.'
    );
  });

  it('keeps the destructive warning ahead of the policy block', () => {
    const message = formatCommandConfirmMessage({
      action: 'Run JumpServer SSH command',
      target: 'web-1',
      command: 'rm -rf /tmp/x',
      policyNote: 'Policy: review (policy.unknown_semantics)',
      riskSummaries: ['Deletes files recursively']
    });

    expect(message).toBe(
      'Run JumpServer SSH command on web-1?\n\n' +
      'rm -rf /tmp/x\n\n' +
      'Warning: this command appears destructive.\n\n' +
      'Policy: review (policy.unknown_semantics)\n' +
      '- Deletes files recursively'
    );
  });

  it('leaves the message untouched when no policy fields are given', () => {
    expect(formatCommandConfirmMessage({
      action: 'Run JumpServer SSH command',
      target: 'web-1',
      command: 'uptime',
      riskSummaries: []
    })).toBe('Run JumpServer SSH command on web-1?\n\nuptime');
  });
});
