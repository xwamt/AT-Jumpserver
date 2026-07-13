# Copy Host IP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an asset-tree context action that copies the selected asset's cached host address and warns when no address is available.

**Architecture:** Extend the existing VS Code command and context-menu contributions. Keep behavior in the extension activation command wiring, using `AssetTreeItem` as the command argument and the existing VS Code clipboard/notification facilities.

**Tech Stack:** TypeScript, VS Code Extension API, Vitest, JSON extension manifest.

---

## File Map

- `test/extension/ExtensionCommands.test.ts`: command registration and clipboard/warning behavior.
- `test/package.manifest.test.ts`: command and asset context-menu contribution contract.
- `src/extension.ts`: `jumpserverManager.copyHostIp` command handler.
- `package.json`: command declaration and Assets tree context-menu entry.

### Task 1: Specify command behavior

**Files:**
- Modify: `test/extension/ExtensionCommands.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Write failing command tests**

Add tests that activate the extension, retrieve `jumpserverManager.copyHostIp`, and assert:

```ts
expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
  'jumpserverManager.copyHostIp',
  expect.any(Function)
);

await copyHostIp({ asset: { address: '10.0.0.11' } });
expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('10.0.0.11');

await copyHostIp({ asset: { address: '' } });
expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Host IP is not available.');
expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();

await copyHostIp(undefined);
expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Host IP is not available.');
expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/extension/ExtensionCommands.test.ts`

Expected: FAIL because `jumpserverManager.copyHostIp` is not registered.

- [ ] **Step 3: Add the minimal command handler**

Register this command beside the existing asset commands in `src/extension.ts`:

```ts
vscode.commands.registerCommand('jumpserverManager.copyHostIp', async (item?: AssetTreeItem) => {
  const address = item?.asset?.address;
  if (!address) {
    await vscode.window.showWarningMessage('Host IP is not available.');
    return;
  }
  await runCommand(async () => {
    await vscode.env.clipboard.writeText(address);
  });
}),
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- test/extension/ExtensionCommands.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the command slice**

```powershell
git add src/extension.ts test/extension/ExtensionCommands.test.ts
git commit -m "feat: add copy host IP command"
```

### Task 2: Contribute the context menu

**Files:**
- Modify: `test/package.manifest.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write a failing manifest test**

Assert the command title and menu scope:

```ts
expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
  expect.objectContaining({
    command: 'jumpserverManager.copyHostIp',
    title: 'Copy Host IP',
    icon: '$(copy)'
  })
]));
const copyHostIpMenu = manifest.contributes.menus['view/item/context'].find(
  (item: { command: string }) => item.command === 'jumpserverManager.copyHostIp'
);
expect(copyHostIpMenu).toMatchObject({ group: '3_copy@1' });
expect(copyHostIpMenu.when).toContain('view == jumpserverManager.assets');
expect(copyHostIpMenu.when).toContain('jumpserverAsset');
expect(copyHostIpMenu.when).toContain('jumpserverMysqlAsset');
expect(copyHostIpMenu.when).toContain('jumpserverUnsupportedAsset');
```

Update the existing exact command-ID and asset-menu-count assertions to include the new command.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/package.manifest.test.ts`

Expected: FAIL because the command and menu are absent.

- [ ] **Step 3: Add manifest contributions**

Add to `contributes.commands`:

```json
{
  "command": "jumpserverManager.copyHostIp",
  "title": "Copy Host IP",
  "icon": "$(copy)"
}
```

Add to `view/item/context`:

```json
{
  "command": "jumpserverManager.copyHostIp",
  "when": "view == jumpserverManager.assets && (viewItem == jumpserverAsset || viewItem == jumpserverMysqlAsset || viewItem == jumpserverUnsupportedAsset)",
  "group": "3_copy@1"
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- test/package.manifest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the manifest slice**

```powershell
git add package.json test/package.manifest.test.ts
git commit -m "feat: expose copy host IP context action"
```

### Task 3: Verify the complete change

**Files:**
- Verify only; no expected modifications.

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all test files and tests pass.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: exit code 0 and extension bundles generated successfully.

- [ ] **Step 4: Inspect scope and whitespace**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only the planned feature files are modified.
