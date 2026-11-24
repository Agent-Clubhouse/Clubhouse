"""Prepare an isolated renderer test tree from verified local Git objects."""
from contextlib import contextmanager
from pathlib import Path
import subprocess
import tarfile
import tempfile


@contextmanager
def source_tree(root, commit, modules):
    with tempfile.TemporaryDirectory(prefix='codec-audit-tree-') as directory:
        tree = Path(directory)
        with tempfile.TemporaryFile() as archive:
            subprocess.run(['git', 'archive', commit, 'src', 'test', 'scripts', 'vitest.config.ts',
                            'package.json', 'package-lock.json', 'tsconfig.json'], cwd=root,
                           stdout=archive, check=True)
            archive.seek(0)
            with tarfile.open(fileobj=archive) as source:
                for member in source:
                    if member.isfile() or member.isdir():
                        source.extract(member, tree)
        (tree / 'node_modules').symlink_to(modules, target_is_directory=True)
        yield tree
