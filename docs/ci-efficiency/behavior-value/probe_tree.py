"""Prepare a private Git checkout so Vitest's tracked-path teardown can run."""
from contextlib import contextmanager
from pathlib import Path
import subprocess
import tempfile


@contextmanager
def source_tree(root, commit, modules):
    with tempfile.TemporaryDirectory(prefix='codec-audit-tree-') as directory:
        tree = Path(directory)
        subprocess.run(['git', 'clone', '--quiet', '--local', '--shared', '--no-checkout',
                        str(root), str(tree)], check=True)
        subprocess.run(['git', 'checkout', '--quiet', '--detach', commit], cwd=tree, check=True)
        (tree / 'node_modules').symlink_to(modules, target_is_directory=True)
        yield tree


def check_teardown(proc):
    output = proc.stderr + proc.stdout
    for marker in [b'error during close', b'Unhandled Error', b'fatal: not a git repository']:
        if marker in output:
            raise ValueError('Invalid global setup or teardown: ' + marker.decode())
