"""
Exportação de frames — placeholder para integração com o pipeline Blender/Lekeleto.
"""
import argparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    print(f"[export_frames] input={args.input} output_dir={args.output_dir}", flush=True)


if __name__ == "__main__":
    main()
