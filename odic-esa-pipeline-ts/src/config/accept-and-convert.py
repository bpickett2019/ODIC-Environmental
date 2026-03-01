#!/usr/bin/env python3
"""
Accept all Track Changes in a Word document and export as PDF via LibreOffice UNO.

Usage: soffice --headless --invisible --norestore \
         "macro:///Standard.Module1.AcceptAndConvert" <input_path> <output_dir>

Or run directly:
  /path/to/soffice --python /path/to/accept-and-convert.py <input_path> <output_dir>

This script:
1. Opens the document in LibreOffice
2. Accepts all tracked changes (redline markup)
3. Exports the clean document as PDF
4. Exits
"""

import sys
import os
import subprocess
import tempfile
import shutil


def accept_and_convert_via_macro(input_path: str, output_dir: str, soffice: str) -> str | None:
    """
    Use LibreOffice macro dispatch to accept track changes and export PDF.
    Falls back to a simpler approach if UNO is not available.
    """
    abs_input = os.path.abspath(input_path)
    abs_output_dir = os.path.abspath(output_dir)
    basename = os.path.splitext(os.path.basename(abs_input))[0]
    output_pdf = os.path.join(abs_output_dir, f"{basename}.pdf")

    # Strategy: Use a temporary copy, open with LibreOffice in a macro that
    # accepts all changes, then convert to PDF.
    #
    # We create a Basic macro script inline via --infilter and environment.

    # Create a temporary directory for the macro profile
    tmp_profile = tempfile.mkdtemp(prefix="lo_profile_")

    try:
        # Write a Basic macro that accepts tracked changes
        macro_dir = os.path.join(tmp_profile, "user", "basic", "Standard")
        os.makedirs(macro_dir, exist_ok=True)

        # Module1.xba — the actual macro
        with open(os.path.join(macro_dir, "Module1.xba"), "w") as f:
            f.write('''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
Sub AcceptAllChanges
    Dim oDoc As Object
    Dim oArgs(0) As New com.sun.star.beans.PropertyValue

    oDoc = ThisComponent
    If Not IsNull(oDoc) Then
        ' Accept all tracked changes
        Dim dispatcher As Object
        dispatcher = createUnoService("com.sun.star.frame.DispatchHelper")
        dispatcher.executeDispatch(oDoc.CurrentController.Frame, ".uno:AcceptAllTrackedChanges", "", 0, Array())

        ' Save the document to apply changes
        oDoc.store()
    End If
End Sub
</script:module>''')

        # dialog.xlc
        with open(os.path.join(macro_dir, "dialog.xlc"), "w") as f:
            f.write('''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">
</library:library>''')

        # script.xlb
        with open(os.path.join(macro_dir, "script.xlb"), "w") as f:
            f.write('''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">
 <library:element library:name="Module1"/>
</library:library>''')

        # Work on a temporary copy to avoid modifying the original
        tmp_doc = os.path.join(tmp_profile, os.path.basename(abs_input))
        shutil.copy2(abs_input, tmp_doc)

        # Run LibreOffice: open the doc, run macro, then convert to PDF
        # Step 1: Open and accept changes via macro
        result = subprocess.run(
            [
                soffice,
                "--headless",
                "--invisible",
                "--norestore",
                f"-env:UserInstallation=file://{tmp_profile}",
                f"macro:///Standard.Module1.AcceptAllChanges",
                tmp_doc,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

        # Step 2: Convert the (now clean) doc to PDF
        result = subprocess.run(
            [
                soffice,
                "--headless",
                "--invisible",
                "--norestore",
                f"-env:UserInstallation=file://{tmp_profile}",
                "--convert-to", "pdf",
                "--outdir", abs_output_dir,
                tmp_doc,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

        # The output PDF will have the temp file's basename
        tmp_pdf = os.path.join(abs_output_dir, f"{os.path.splitext(os.path.basename(tmp_doc))[0]}.pdf")
        if os.path.exists(tmp_pdf):
            # Rename to match original file's basename
            if tmp_pdf != output_pdf:
                shutil.move(tmp_pdf, output_pdf)
            return output_pdf

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
    finally:
        # Clean up temp profile
        shutil.rmtree(tmp_profile, ignore_errors=True)

    return None


def simple_convert(input_path: str, output_dir: str, soffice: str) -> str | None:
    """Simple fallback: just convert to PDF without accepting track changes."""
    try:
        result = subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", output_dir, input_path],
            capture_output=True,
            text=True,
            timeout=60,
        )
        basename = os.path.splitext(os.path.basename(input_path))[0]
        output_pdf = os.path.join(output_dir, f"{basename}.pdf")
        if os.path.exists(output_pdf):
            return output_pdf
    except Exception as e:
        print(f"Simple convert error: {e}", file=sys.stderr)
    return None


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <input_path> <output_dir> [soffice_path]", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_dir = sys.argv[2]
    soffice = sys.argv[3] if len(sys.argv) > 3 else "soffice"

    if not os.path.exists(input_path):
        print(f"Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    # Try macro-based approach first
    result = accept_and_convert_via_macro(input_path, output_dir, soffice)
    if result:
        print(result)
        sys.exit(0)

    # Fall back to simple conversion
    result = simple_convert(input_path, output_dir, soffice)
    if result:
        print(f"WARNING: Converted without accepting track changes: {result}", file=sys.stderr)
        print(result)
        sys.exit(0)

    print("ERROR: All conversion methods failed", file=sys.stderr)
    sys.exit(1)
