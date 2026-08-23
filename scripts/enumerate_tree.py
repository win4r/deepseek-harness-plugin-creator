#!/usr/bin/python3

import json
import os
import stat
import sys


MAX_DEPTH = 64
MAX_DIRECTORY_ENTRIES = 10_000
MAX_TREE_ENTRIES = 100_000
ALWAYS_SKIP = {'.git', 'node_modules'}


def snapshot(value):
    return {
        'dev': str(value.st_dev),
        'ino': str(value.st_ino),
        'mode': str(value.st_mode),
        'nlink': str(value.st_nlink),
        'size': str(value.st_size),
        'mtimeNs': str(value.st_mtime_ns),
        'ctimeNs': str(value.st_ctime_ns),
    }


def safe_name(value):
    if value in {'.', '..'}:
        return False
    return not any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value)


def relative_path(current, name=None):
    parts = [] if current == '.' else current.removeprefix('./').split(os.sep)
    if name is not None:
        parts.append(name)
    return '/'.join(parts)


def fail_walk(error):
    raise error


def enumerate_tree(root, include_dist):
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    root_fd = os.open(root, flags)
    directories = []
    entries = []
    total_entries = 0
    try:
        for current, dirnames, filenames, directory_fd in os.fwalk(
            '.', topdown=True, onerror=fail_walk, follow_symlinks=False, dir_fd=root_fd,
        ):
            relative_current = relative_path(current)
            depth = 0 if not relative_current else relative_current.count('/') + 1
            if depth > MAX_DEPTH:
                raise RuntimeError('depth')
            if len(dirnames) + len(filenames) > MAX_DIRECTORY_ENTRIES:
                raise RuntimeError('directory-size')
            if not all(safe_name(name) for name in dirnames + filenames):
                raise RuntimeError('unsafe-name')

            directories.append({
                'path': relative_current,
                'snapshot': snapshot(os.fstat(directory_fd)),
            })

            traversable = []
            for name in sorted(dirnames):
                total_entries += 1
                if total_entries > MAX_TREE_ENTRIES:
                    raise RuntimeError('tree-size')
                value = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                path = relative_path(current, name)
                if stat.S_ISLNK(value.st_mode):
                    entries.append({'path': path, 'kind': 'symlink', 'snapshot': snapshot(value)})
                elif not stat.S_ISDIR(value.st_mode):
                    entries.append({'path': path, 'kind': 'special', 'snapshot': snapshot(value)})
                elif name in ALWAYS_SKIP or (name == 'dist' and not include_dist):
                    entries.append({'path': path, 'kind': 'skipped-directory', 'snapshot': snapshot(value)})
                elif depth >= MAX_DEPTH:
                    raise RuntimeError('depth')
                else:
                    traversable.append(name)
            dirnames[:] = traversable

            for name in sorted(filenames):
                total_entries += 1
                if total_entries > MAX_TREE_ENTRIES:
                    raise RuntimeError('tree-size')
                value = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                path = relative_path(current, name)
                if stat.S_ISREG(value.st_mode):
                    if value.st_nlink != 1:
                        raise RuntimeError('hardlink')
                    kind = 'file'
                elif stat.S_ISLNK(value.st_mode):
                    kind = 'symlink'
                else:
                    kind = 'special'
                entries.append({'path': path, 'kind': kind, 'snapshot': snapshot(value)})
    finally:
        os.close(root_fd)

    directories.sort(key=lambda item: item['path'])
    entries.sort(key=lambda item: item['path'])
    return {'directories': directories, 'entries': entries}


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in {'0', '1'}:
        raise RuntimeError('arguments')
    result = enumerate_tree(sys.argv[1], sys.argv[2] == '1')
    json.dump(result, sys.stdout, ensure_ascii=True, separators=(',', ':'))


try:
    main()
except Exception:
    sys.exit(1)
