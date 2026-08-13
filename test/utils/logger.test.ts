import { afterEach, describe, expect, it } from 'vitest';
import { log, setLogSink, type LogSink } from '../../src/utils/logger';

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`);
  };
  return {
    lines,
    sink: {
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error')
    }
  };
}

afterEach(() => {
  setLogSink(undefined);
});

describe('extension log channel', () => {
  it('drops every line on the floor until a channel is attached', () => {
    expect(() => log.error('nothing is listening yet')).not.toThrow();
  });

  it('forwards each level to the attached channel', () => {
    const { sink, lines } = recordingSink();
    setLogSink(sink);

    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(lines).toEqual(['trace t', 'debug d', 'info i', 'warn w', 'error e']);
  });

  it('stops logging once the channel is detached', () => {
    const { sink, lines } = recordingSink();
    setLogSink(sink);
    setLogSink(undefined);

    log.error('after dispose');

    expect(lines).toEqual([]);
  });

  /**
   * The whole point of routing every line through one facade: an output channel
   * is a file on the user's disk that support engineers get sent.
   */
  it('masks every credential this extension handles before it reaches the channel', () => {
    const { sink, lines } = recordingSink();
    setLogSink(sink);
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU',
      '-----END OPENSSH PRIVATE KEY-----'
    ].join('\n');

    log.error(
      'KoKo handshake failed for wss://koko.example.com/koko/ws/terminal/?disableautohash=false' +
        '&token=jms-connection-token-9f3&_=1699 ' +
        'Cookie: sessionid=jms-session-abc; csrftoken=jms-csrf-def ' +
        'Authorization: Bearer at-series-bridge-token-77 ' +
        'password=hunter2'
    );
    log.warn(`agent key rejected ${privateKey}`);

    const output = lines.join('\n');
    for (const secret of [
      'jms-connection-token-9f3',
      'jms-session-abc',
      'jms-csrf-def',
      'at-series-bridge-token-77',
      'hunter2',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'
    ]) {
      expect(output).not.toContain(secret);
    }
    // Masked, not deleted: the line still has to say what failed and where.
    expect(lines[0]).toContain('wss://koko.example.com/koko/ws/terminal/');
    expect(lines[0]).toContain('token=[REDACTED]');
    expect(lines[0]).toContain('Cookie: [REDACTED]');
    expect(lines[0]).toContain('Authorization: Bearer [REDACTED]');
    expect(lines[0]).toContain('password=[REDACTED]');
    expect(lines[1]).toBe('warn agent key rejected [REDACTED_PRIVATE_KEY]');
  });
});
