
from pathlib import Path
import sys

def main():
    root = Path.cwd()
    apk = root / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"

    if not apk.is_file():
        print("ERROR: APK was not generated.")
        sys.exit(1)

    print(f"APK generated successfully: {apk}")
    print(f"APK size: {apk.stat().st_size} bytes")

if __name__ == "__main__":
    main()
