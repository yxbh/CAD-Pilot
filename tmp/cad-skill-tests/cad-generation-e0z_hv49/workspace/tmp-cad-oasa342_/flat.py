from pathlib import Path
DISPLAY_NAME = "flat"
CALLS = Path(__file__).with_suffix('.calls')
def _output_path(suffix, output):
    path = Path(__file__).parent / output if output else Path(__file__).with_suffix(suffix)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
def _record(name):
    with CALLS.open('a', encoding='utf-8') as handle:
        handle.write(name + '\n')
class _FakeDxf:
    def saveas(self, output_path):
        Path(output_path).write_text('0\nEOF\n', encoding='utf-8')
def _shape():
    import build123d
    return build123d.Box(1, 1, 1)

def gen_step():
    _record('gen_step')
    return {
        'shape': _shape(),
        'step_output': 'flat.step',
    }
