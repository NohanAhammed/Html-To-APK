
from pathlib import Path
import sys

def main():
    root = Path.cwd()
    web = root / "web"
    html = web / "index.html"

    if not html.is_file():
        print("ERROR: web/index.html is missing.")
        sys.exit(1)

    output = root / "build-input"
    output.mkdir(exist_ok=True)

    (output / "index.html").write_bytes(html.read_bytes())

    logo = web / "logo.png"
    if logo.is_file():
        (output / "logo.png").write_bytes(logo.read_bytes())

    print("Build input prepared.")
    print(f"HTML size: {html.stat().st_size} bytes")

if __name__ == "__main__":
    main()
