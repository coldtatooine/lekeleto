"""
Chamado pelo main via: blender --background --python render_sequence.py -- --sequence PATH --output DIR
Substitua pela lógica real de render no Blender 4.x.
"""
import argparse
import sys


def main() -> None:
    if "--" in sys.argv:
        argv = sys.argv[sys.argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser()
    parser.add_argument("--sequence", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    print(f"[render_sequence] sequence={args.sequence} output={args.output}", flush=True)
    # TODO: bpy.ops / carregar .blend e renderizar sequência


if __name__ == "__main__":
    main()
