"""The standalone HTML page for a coaching report (local and hosted)."""

from __future__ import annotations

import markdown as markdown_lib


def render_report_page(report_markdown: str) -> str:
    body = markdown_lib.markdown(report_markdown, extensions=["tables", "sane_lists"])
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coaching report</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{
    margin: 0; padding: 32px 20px 64px; background: #11130f; color: #f3f4ef;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    line-height: 1.6;
  }}
  main {{ max-width: 880px; margin: 0 auto; }}
  h1, h2, h3 {{ line-height: 1.3; }}
  h1 {{ font-size: 30px; margin: 0 0 20px; }}
  h2 {{ font-size: 20px; margin: 36px 0 12px; padding-top: 16px; border-top: 1px solid #2b3026; }}
  h2:first-of-type {{ border-top: 0; padding-top: 0; }}
  strong {{ color: #d7ff75; }}
  a {{ color: #d7ff75; }}
  p, li {{ color: #f3f4ef; }}
  ul {{ padding-left: 22px; }}
  table {{ border-collapse: collapse; width: 100%; margin: 12px 0 24px; font-size: 14px; }}
  th, td {{ border: 1px solid #2b3026; padding: 8px 10px; text-align: left; }}
  th {{ background: #1a1d17; color: #9da596; font-weight: 600; }}
  tr:nth-child(even) td {{ background: #14170f; }}
</style>
</head>
<body>
<main>
{body}
</main>
</body>
</html>
"""
