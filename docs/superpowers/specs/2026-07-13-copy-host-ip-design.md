# Copy Host IP Context Menu Design

## Goal

Add a `Copy Host IP` action to the Assets tree context menu so users can copy an asset's cached host address without opening a terminal.

## User Experience

- Show `Copy Host IP` when right-clicking any asset item in the Assets view: SSH, MySQL, or unsupported asset types.
- Keep the action visible even when the cached `address` is empty.
- When `address` is non-empty, copy its original value to the VS Code clipboard without showing a success notification.
- When `address` is empty, show a warning and leave the clipboard unchanged.
- When the command receives an invalid argument, treat it like a missing address: show a warning and leave the clipboard unchanged.

## Implementation

- Contribute a new command named `jumpserverManager.copyHostIp` with the title `Copy Host IP` and a copy icon.
- Add the command to `view/item/context` for `jumpserverManager.assets`, limited to the existing asset context values (`jumpserverAsset`, `jumpserverMysqlAsset`, and `jumpserverUnsupportedAsset`).
- Place it in a copy-specific context-menu group so it is separate from the inline Connect action.
- Register the command in the extension activation flow. The handler reads `AssetTreeItem.asset.address`, validates that it is a non-empty string, then calls `vscode.env.clipboard.writeText`.
- Reuse the extension's existing VS Code notification and clipboard patterns; do not introduce a new abstraction for this single field.

## Error Handling

An empty address or invalid command argument produces a user-visible warning and no clipboard write. Clipboard API failures follow the extension's existing command error-handling convention.

## Tests

- Manifest test: command contribution exists with the expected title, and the context menu is restricted to asset nodes in the Assets view.
- Extension command test: a valid asset copies its exact address.
- Extension command test: an empty address shows a warning and does not write to the clipboard.
- Extension command test: an invalid argument shows a warning and does not write to the clipboard.

## Out of Scope

- Parsing or validating whether `address` is an IPv4 or IPv6 literal.
- Resolving hostnames to IP addresses.
- Adding the action to SFTP file nodes or group nodes.
- Showing a success notification after copying.
