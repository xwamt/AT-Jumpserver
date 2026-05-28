export function joinRemotePath(parent: string, child: string): string {
  const cleanParent = parent === '/' ? '' : parent.replace(/\/+$/, '');
  const cleanChild = child.replace(/^\/+/, '');
  return `${cleanParent}/${cleanChild}` || '/';
}

export function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

export function remoteBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() || 'remote-file';
}
