import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { basename, posix } from 'node:path';

const required = ['JUMPSERVER_BASE_URL', 'JUMPSERVER_USERNAME', 'JUMPSERVER_PASSWORD', 'JUMPSERVER_ASSET_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(', ')}`);
  process.exit(2);
}

const config = {
  baseUrl: process.env.JUMPSERVER_BASE_URL.replace(/\/+$/, ''),
  username: process.env.JUMPSERVER_USERNAME,
  password: process.env.JUMPSERVER_PASSWORD,
  assetId: process.env.JUMPSERVER_ASSET_ID,
  orgId: process.env.JUMPSERVER_ORG_ID || '',
  verifyTls: process.env.JUMPSERVER_VERIFY_TLS !== 'false',
  testPath: process.env.JUMPSERVER_SFTP_TEST_PATH || '',
  uploadFile: process.env.JUMPSERVER_SFTP_UPLOAD_FILE || ''
};

const cookies = new Map();

function origin() {
  const parsed = new URL(config.baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

function cookieHeader() {
  return Array.from(cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function captureCookies(response) {
  const raw = response.headers.get('set-cookie');
  if (!raw) {
    return;
  }
  for (const part of raw.split(/,(?=\s*[^;,]+=)/g)) {
    const [nameValue] = part.split(';');
    const index = nameValue.indexOf('=');
    if (index > 0) {
      cookies.set(nameValue.slice(0, index).trim(), nameValue.slice(index + 1).trim());
    }
  }
}

async function request(pathOrUrl, init = {}, requireOk = true) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${origin()}${pathOrUrl}`;
  const headers = { ...(init.headers || {}) };
  if (cookieHeader() && !Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
    headers.Cookie = cookieHeader();
  }
  const response = await fetch(url, { ...init, headers });
  captureCookies(response);
  if (requireOk && !response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function authToken() {
  const response = await request('/api/v1/authentication/auth/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password })
  });
  const body = await response.json();
  if (!body.token) {
    throw new Error('Authentication response did not include token.');
  }
  return body.token;
}

function restHeaders(token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (config.orgId) {
    headers['X-JMS-ORG'] = config.orgId;
  }
  return headers;
}

function profileId(profile) {
  return String(profile.id || profile.pk || profile.user_id || profile.username || '');
}

function protocolNames(detail) {
  const raw = Array.isArray(detail.permed_protocols)
    ? detail.permed_protocols
    : Array.isArray(detail.protocols)
      ? detail.protocols
      : [];
  return raw.map((item) => String(item?.name || '')).filter(Boolean);
}

function firstAccount(detail) {
  const accounts = Array.isArray(detail.permed_accounts)
    ? detail.permed_accounts
    : Array.isArray(detail.accounts)
      ? detail.accounts
      : [];
  const account = accounts.find((item) => item?.has_secret === true && !String(item?.alias || '').startsWith('@')) || accounts[0];
  if (!account?.id) {
    throw new Error('No usable account returned for asset.');
  }
  return {
    id: String(account.id),
    alias: account.alias ? String(account.alias) : undefined,
    username: String(account.username || account.name || account.alias || '')
  };
}

async function createSftpToken(token, assetId, account) {
  const variants = [
    {
      name: 'sftp-connect-method',
      payload: {
        asset: assetId,
        account: account.id,
        protocol: 'sftp',
        input_username: account.username,
        input_secret: '',
        connect_method: 'sftp',
        connect_options: { token_reusable: false, disableautohash: false }
      }
    },
    {
      name: 'no-connect-method',
      payload: {
        asset: assetId,
        account: account.id,
        protocol: 'sftp',
        input_username: account.username,
        input_secret: '',
        connect_options: { token_reusable: false, disableautohash: false }
      }
    }
  ];
  let lastError;
  for (const variant of variants) {
    const response = await request('/api/v1/authentication/connection-token/', {
      method: 'POST',
      headers: { ...restHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify(variant.payload)
    }, false);
    if (response.ok) {
      const body = await response.json();
      console.log(`SFTP token payload accepted: ${variant.name}`);
      console.log(`Accepted payload shape: ${JSON.stringify({ ...variant.payload, input_secret: '<redacted>' })}`);
      if (!body.id) {
        throw new Error('Connection token response did not include id.');
      }
      return String(body.id);
    }
    lastError = `variant ${variant.name} failed HTTP ${response.status}: ${await response.text()}`;
    console.warn(lastError);
  }
  throw new Error(lastError || 'No SFTP connection-token payload variant succeeded.');
}

async function warmup(tokenId) {
  const loginPath = '/core/auth/login/?next=/koko/connect/';
  const loginPage = await request(loginPath, { headers: { Accept: 'text/html' } }, false);
  const html = await loginPage.text();
  const csrf = html.match(/name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/i)?.[1];
  if (!csrf) {
    throw new Error('Unable to find csrfmiddlewaretoken.');
  }

  const loginSubmit = await request(loginPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Referer: `${origin()}${loginPath}`,
      Origin: origin(),
      Cookie: cookieHeader()
    },
    body: new URLSearchParams({
      csrfmiddlewaretoken: csrf,
      username: config.username,
      password: config.password,
      auto_login: 'on'
    }).toString(),
    redirect: 'manual'
  }, false);

  let location = loginSubmit.headers.get('location');
  for (let index = 0; index < 5 && location; index += 1) {
    const response = await request(location, { redirect: 'manual' }, false);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      break;
    }
    location = response.headers.get('location');
  }

  await request('/api/v1/users/profile/', { headers: { Accept: 'application/json' } }, false);
  const connect = await request(`/koko/connect/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${Date.now()}`, {
    headers: { Accept: 'text/html', Cookie: cookieHeader() },
    redirect: 'manual'
  }, false);
  if ([301, 302, 303, 307, 308].includes(connect.status)) {
    throw new Error('KoKo web session is not authenticated.');
  }
}

async function smartEndpoint(token, tokenId) {
  const response = await request(`/api/v1/terminal/endpoints/smart/?protocol=https&token=${encodeURIComponent(tokenId)}`, {
    headers: restHeaders(token)
  });
  return response.json();
}

function sftpWsUrl(endpoint, tokenId) {
  const parsed = new URL(config.baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80)) ? `${host}:${port}` : host;
  return `${scheme}://${authority}/koko/ws/sftp/?token=${encodeURIComponent(tokenId)}&_=${Date.now()}`;
}

function decodeRaw(raw) {
  if (!raw) {
    return Buffer.alloc(0);
  }
  if (typeof raw === 'string') {
    return Buffer.from(raw, 'base64');
  }
  if (Array.isArray(raw)) {
    return Buffer.from(raw);
  }
  if (raw.type === 'Buffer' && Array.isArray(raw.data)) {
    return Buffer.from(raw.data);
  }
  return Buffer.from(String(raw), 'base64');
}

async function wsCommand(ws, cmd, data, extra = {}) {
  const id = extra.id ? String(extra.id) : `${Date.now()}-${Math.random()}`;
  const { id: _id, ...extraPayload } = extra;
  ws.send(JSON.stringify({ id, type: 'SFTP_DATA', cmd, data: JSON.stringify(data), ...extraPayload }));
  const binaries = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${cmd}`)), 30_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'PING') {
        ws.send(JSON.stringify({ id: message.id || '', type: 'PONG', data: 'pong' }));
        return;
      }
      if (message.id !== id) {
        return;
      }
      if (message.err) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        reject(new Error(message.err));
        return;
      }
      if (message.type === 'SFTP_BINARY') {
        binaries.push(decodeRaw(message.raw));
        return;
      }
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve({ message, binary: Buffer.concat(binaries) });
    };
    ws.on('message', onMessage);
  });
}

async function main() {
  console.log(`API docs: ${config.baseUrl}/api/docs/`);
  const token = await authToken();
  const profile = await (await request('/api/v1/users/profile/', { headers: restHeaders(token) })).json();
  const userId = profileId(profile);
  if (!userId) {
    throw new Error('Profile response did not include a user id.');
  }
  const detail = await (await request(`/api/v1/perms/users/${encodeURIComponent(userId)}/assets/${encodeURIComponent(config.assetId)}/`, {
    headers: restHeaders(token)
  })).json();
  const protocols = protocolNames(detail).map((name) => name.toLowerCase());
  console.log(`Asset: ${detail.name || config.assetId}`);
  console.log(`Protocols: ${protocols.join(', ') || '<none>'}`);
  if (!protocols.includes('sftp')) {
    throw new Error('Asset does not expose sftp.');
  }
  const account = firstAccount(detail);
  console.log(`Account: ${JSON.stringify({ id: account.id, alias: account.alias, username: account.username })}`);
  const tokenId = await createSftpToken(token, config.assetId, account);
  const endpoint = await smartEndpoint(token, tokenId);
  await warmup(tokenId);
  const ws = new WebSocket(sftpWsUrl(endpoint, tokenId), ['JMS-KOKO'], {
    origin: origin(),
    headers: { Cookie: cookieHeader(), 'User-Agent': 'AT JumpServer SFTP Probe' },
    rejectUnauthorized: config.verifyTls
  });
  await new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type !== 'CONNECT') {
        reject(new Error(`Expected CONNECT, got ${raw}`));
        return;
      }
      resolve();
    });
  });
  const listed = await wsCommand(ws, 'list', { path: config.testPath });
  const entries = JSON.parse(listed.message.data || '[]');
  console.log(`List returned ${entries.length} entries`);
  console.log(JSON.stringify(entries.slice(0, 20), null, 2));
  if (config.uploadFile) {
    const bytes = await readFile(config.uploadFile);
    const cleanName = basename(config.uploadFile).replace(/[\\/]/g, '-');
    const remotePath = posix.join(config.testPath || '/', `probe-${Date.now()}-${cleanName}`);
    await wsCommand(ws, 'upload', { path: remotePath, size: bytes.byteLength, offSet: 0, chunk: false }, {
      id: String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
      raw: bytes.toString('base64')
    });
    const downloaded = await wsCommand(ws, 'download', { path: remotePath, is_dir: false });
    if (!downloaded.binary.equals(bytes)) {
      throw new Error(`Downloaded bytes differ for ${remotePath}`);
    }
    await wsCommand(ws, 'rm', { path: remotePath });
    console.log(`Upload/download/delete verified: ${remotePath}`);
  }
  ws.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
