declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const form = document.getElementById('configForm') as HTMLFormElement | null;

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  vscode.postMessage({
    type: 'save',
    payload: {
      displayName: String(data.get('displayName') || ''),
      bastionId: String(data.get('bastionId') || ''),
      baseUrl: String(data.get('baseUrl') || ''),
      orgId: String(data.get('orgId') || ''),
      username: String(data.get('username') || ''),
      password: String(data.get('password') || ''),
      verifyTls: data.get('verifyTls') === 'on'
    }
  });
});
