declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const form = document.getElementById('configForm') as HTMLFormElement | null;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement | null;
const testBtn = document.getElementById('testBtn') as HTMLButtonElement | null;
const statusBanner = document.getElementById('statusBanner') as HTMLElement | null;
const defaultTestLabel = testBtn?.textContent ?? 'Test Connection';

function readFormPayload() {
  if (!form) {
    return undefined;
  }
  const data = new FormData(form);
  return {
    displayName: String(data.get('displayName') || ''),
    bastionId: String(data.get('bastionId') || ''),
    baseUrl: String(data.get('baseUrl') || ''),
    orgId: String(data.get('orgId') || ''),
    username: String(data.get('username') || ''),
    password: String(data.get('password') || ''),
    verifyTls: data.get('verifyTls') === 'on'
  };
}

function setBusy(busy: boolean, testing = false): void {
  if (saveBtn) {
    saveBtn.disabled = busy;
  }
  if (testBtn) {
    testBtn.disabled = busy;
    testBtn.textContent = busy && testing
      ? (testBtn.dataset.testingLabel || defaultTestLabel)
      : defaultTestLabel;
  }
}

function showBanner(kind: 'ok' | 'error' | 'hidden', message = ''): void {
  if (!statusBanner) {
    return;
  }
  if (kind === 'hidden') {
    statusBanner.hidden = true;
    statusBanner.textContent = '';
    statusBanner.classList.remove('status-banner--ok', 'status-banner--error');
    return;
  }
  statusBanner.hidden = false;
  statusBanner.textContent = message;
  statusBanner.classList.toggle('status-banner--ok', kind === 'ok');
  statusBanner.classList.toggle('status-banner--error', kind === 'error');
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const payload = readFormPayload();
  if (!payload) {
    return;
  }
  showBanner('hidden');
  setBusy(true, false);
  vscode.postMessage({ type: 'save', payload });
});

testBtn?.addEventListener('click', () => {
  const payload = readFormPayload();
  if (!payload) {
    return;
  }
  showBanner('hidden');
  setBusy(true, true);
  vscode.postMessage({ type: 'test', payload });
});

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; ok?: unknown; message?: unknown };
  if (message?.type === 'testResult' && typeof message.message === 'string') {
    setBusy(false, false);
    showBanner(message.ok === true ? 'ok' : 'error', message.message);
  } else if (message?.type === 'saveError' && typeof message.message === 'string') {
    setBusy(false, false);
    showBanner('error', message.message);
  }
});
