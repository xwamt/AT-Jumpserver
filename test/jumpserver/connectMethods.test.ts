import { describe, expect, it } from 'vitest';
import {
  normalizeConnectMethods,
  selectConnectMethod,
  type ConnectMethod
} from '../../src/jumpserver/connectMethods';

describe('connectMethods', () => {
  it('normalizes dict payload containing protocol lists', () => {
    const rawDict = {
      ssh: [
        { component: 'koko', type: 'web', endpoint_protocol: 'http', value: 'web_cli', label: 'Web CLI' },
        { component: 'koko', type: 'native', endpoint_protocol: 'ssh', value: 'system_ssh', label: 'System SSH' }
      ],
      mysql: [
        { component: 'chen', type: 'web', endpoint_protocol: 'http', value: 'web_gui', label: 'Web GUI' }
      ]
    };

    const normalized = normalizeConnectMethods(rawDict);
    expect(normalized.ssh).toHaveLength(2);
    expect(normalized.ssh[0]).toEqual({
      component: 'koko',
      type: 'web',
      endpoint_protocol: 'http',
      value: 'web_cli',
      label: 'Web CLI'
    });
    expect(normalized.mysql).toHaveLength(1);
  });

  it('normalizes flat list payload without throwing', () => {
    const rawList = [
      { component: 'koko', type: 'web', endpoint_protocol: 'ssh', value: 'web_cli', label: 'Web CLI' },
      { component: 'chen', type: 'web', endpoint_protocol: 'mysql', value: 'web_gui', label: 'Web GUI' },
      { component: 'unknown', type: 'custom', endpoint_protocol: 'custom', value: 'future_v5_custom', label: 'Future' }
    ];

    const normalized = normalizeConnectMethods(rawList);
    expect(normalized).toBeDefined();
    // Unknown values must not throw
    expect(rawList[2].value).toBe('future_v5_custom');
  });

  it('handles empty or malformed payload returning empty dict', () => {
    expect(normalizeConnectMethods(null)).toEqual({});
    expect(normalizeConnectMethods(undefined)).toEqual({});
    expect(normalizeConnectMethods({})).toEqual({});
    expect(normalizeConnectMethods([])).toEqual({});
  });

  it('selects preferred method when matched', () => {
    const methods: ConnectMethod[] = [
      { component: 'koko', type: 'web', endpoint_protocol: 'http', value: 'web_cli', label: 'Web CLI' },
      { component: 'koko', type: 'native', endpoint_protocol: 'ssh', value: 'terminal_custom', label: 'Custom' }
    ];

    const selected = selectConnectMethod(methods, { protocol: 'ssh', preferred: 'terminal_custom' });
    expect(selected?.value).toBe('terminal_custom');
  });

  it('prefers web over native when preferred is not specified', () => {
    const methods: ConnectMethod[] = [
      { component: 'koko', type: 'native', endpoint_protocol: 'ssh', value: 'system_ssh', label: 'System SSH' },
      { component: 'koko', type: 'web', endpoint_protocol: 'http', value: 'web_cli', label: 'Web CLI' }
    ];

    const selected = selectConnectMethod(methods, { protocol: 'ssh' });
    expect(selected?.value).toBe('web_cli');
    expect(selected?.type).toBe('web');
  });

  it('selects from dict structure for specified protocol', () => {
    const dict = {
      ssh: [
        { component: 'koko', type: 'web', endpoint_protocol: 'http', value: 'web_cli', label: 'Web CLI' }
      ],
      mysql: [
        { component: 'chen', type: 'web', endpoint_protocol: 'http', value: 'web_gui', label: 'Web GUI' }
      ]
    };

    const selected = selectConnectMethod(dict, { protocol: 'mysql' });
    expect(selected?.value).toBe('web_gui');
  });

  it('returns undefined if protocol is not found', () => {
    const dict = {
      ssh: [
        { component: 'koko', type: 'web', endpoint_protocol: 'http', value: 'web_cli', label: 'Web CLI' }
      ]
    };

    expect(selectConnectMethod(dict, { protocol: 'redis' })).toBeUndefined();
  });
});
