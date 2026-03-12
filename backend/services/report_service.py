"""
ReportService — generates audit reports for exported projects.

Outputs:
- JSON: structured report for tooling pipelines
- HTML: human-readable summary
"""

import html
from datetime import datetime

from backend.models.project import ProjectFile


class ReportService:
    def generate_json(self, project: ProjectFile) -> dict:
        """Generate a structured JSON audit report."""
        accepted = [e for e in project.events if e.status == "accepted"]
        rejected = [e for e in project.events if e.status == "rejected"]

        return {
            "report_generated_at": datetime.utcnow().isoformat(),
            "project_id": project.project_id,
            "project_name": project.name,
            "video": {
                "path": project.video.path if project.video else None,
                "duration_ms": project.video.duration_ms if project.video else None,
            },
            "summary": {
                "total_events": len(project.events),
                "accepted": len(accepted),
                "rejected": len(rejected),
                "pending": len(project.events) - len(accepted) - len(rejected),
            },
            "redacted_events": [
                {
                    "event_id": e.event_id,
                    "pii_type": e.pii_type,
                    "confidence": e.confidence,
                    # extracted_text omitted in secure mode
                    "extracted_text": e.extracted_text if not project.scan_settings.secure_mode else None,  # noqa: E501
                    "time_ranges": [
                        {"start_ms": r.start_ms, "end_ms": r.end_ms}
                        for r in e.time_ranges
                    ],
                    "tracking_method": e.tracking_method,
                    "redaction_style": e.redaction_style.type if e.redaction_style else "blur",
                }
                for e in accepted
            ],
        }

    def generate_html(self, project: ProjectFile) -> str:
        """Generate a human-readable HTML audit report."""
        report = self.generate_json(project)
        events_html = ""

        for ev in report["redacted_events"]:
            ranges = ", ".join(
                f"{r['start_ms']}ms–{r['end_ms']}ms" for r in ev["time_ranges"]
            )
            text_display = html.escape(ev.get("extracted_text") or "[redacted]")
            events_html += f"""
            <tr>
                <td>{html.escape(ev['pii_type'])}</td>
                <td>{text_display}</td>
                <td>{ev['confidence']:.0%}</td>
                <td>{html.escape(ranges)}</td>
                <td>{html.escape(ev['tracking_method'] or '')}</td>
            </tr>"""

        return f"""<!DOCTYPE html>
<html>
<head><title>Censor Me Audit Report — {project.name}</title>
<style>
  body {{ font-family: system-ui, sans-serif; max-width: 900px;
         margin: 40px auto; padding: 0 20px; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ text-align: left; padding: 8px 12px; border-bottom: 1px solid #ddd; }}
  th {{ background: #f5f5f5; }}
  .summary {{ display: flex; gap: 24px; margin: 20px 0; }}
  .stat {{ background: #f0f4ff; padding: 16px 24px; border-radius: 8px; }}
  .stat h3 {{ margin: 0; font-size: 2em; }}
  .stat p {{ margin: 4px 0 0; color: #666; }}
</style>
</head>
<body>
<h1>Censor Me — Audit Report</h1>
<p><strong>Project:</strong> {html.escape(project.name)}</p>
<p><strong>Generated:</strong> {html.escape(report['report_generated_at'])}</p>
<p><strong>Video:</strong> {html.escape(str(report['video']['path'] or ''))}</p>

<div class="summary">
  <div class="stat"><h3>{report['summary']['total_events']}</h3><p>Total events found</p></div>
  <div class="stat"><h3>{report['summary']['accepted']}</h3><p>Redacted</p></div>
  <div class="stat"><h3>{report['summary']['rejected']}</h3><p>Rejected</p></div>
</div>

<h2>Redacted Events</h2>
<table>
  <thead>
    <tr>
      <th>PII Type</th><th>Detected Text</th><th>Confidence</th>
      <th>Time Ranges</th><th>Tracking</th>
    </tr>
  </thead>
  <tbody>{events_html}</tbody>
</table>
</body>
</html>"""
